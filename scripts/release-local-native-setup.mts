import path from "node:path";
import { createHash } from "node:crypto";
import { lstat, realpath, readFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { isRecord } from "./runtime-values.mts";
import { readBoundedPublicBuildInputFile } from "./release-public-build-inputs.mts";
import { inspectReleaseAuthorityConfiguration } from "./release-authority-configuration.mts";
import { capacityDigest } from "./release-capacity.mts";
import { inspectCoordinatorRemoteNamespace } from "./release-coordinator-remote.mts";

const checkout = fileURLToPath(new URL("..", import.meta.url));
const sha = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
function exact(raw: unknown, keys: string): asserts raw is Record<string, unknown> {
  if (!isRecord(raw) || Object.keys(raw).sort().join(",") !== keys)
    throw new Error("fixed local native setup schema differs");
}
function digest(raw: unknown) {
  if (typeof raw !== "string" || !/^[a-f0-9]{64}$/u.test(raw))
    throw new Error("fixed local native setup digest unavailable");
  return raw;
}
function canonical(raw: unknown, windows: boolean) {
  const parser = windows ? path.win32 : path.posix;
  if (
    typeof raw !== "string" ||
    !parser.isAbsolute(raw) ||
    parser.normalize(raw) !== raw ||
    /[\r\n\0]/u.test(raw) ||
    (windows && !/^[A-Za-z]:\\/u.test(raw))
  )
    throw new Error("fixed native setup requires canonical local absolute paths");
  return raw;
}

/** Data-only installed setup contract. A supplied descriptor never grants a
 * native run: the fixed task/unit and actual parent boundary must authenticate
 * its pinned bytes, installation and current invocation separately. */
export function inspectLocalNativeSetup(raw: unknown) {
  const value: unknown = structuredClone(raw);
  exact(
    value,
    "authority_configuration,capture_root,controller_revision,kind,namespace,native_boundary_configuration,platform_label,scheduler_identity,schema_version,setup_grant_sha256",
  );
  if (
    value.schema_version !== 1 ||
    value.kind !== "fixed-native-parent" ||
    typeof value.controller_revision !== "string" ||
    !/^[a-f0-9]{40}$/u.test(value.controller_revision) ||
    !["windows-x86_64", "linux-x86_64"].includes(String(value.platform_label))
  )
    throw new Error("fixed native setup identity differs");
  const windows = value.platform_label === "windows-x86_64";
  const reference = (input: unknown) => {
    exact(input, "path,sha256");
    return { path: canonical(input.path, windows), sha256: digest(input.sha256) };
  };
  exact(value.scheduler_identity, "kind,name");
  if (
    value.scheduler_identity.kind !== (windows ? "windows-task" : "systemd-user-unit") ||
    value.scheduler_identity.name !==
      (windows ? "\\Portcove\\NativeQualification" : "portcove-native-worker.service")
  )
    throw new Error("native setup scheduler differs from fixed local route");
  return {
    schema_version: 1 as const,
    kind: "fixed-native-parent" as const,
    controller_revision: value.controller_revision,
    setup_grant_sha256: digest(value.setup_grant_sha256),
    namespace: inspectCoordinatorRemoteNamespace({ schema_version: 1, namespace: value.namespace }),
    platform_label: value.platform_label as "windows-x86_64" | "linux-x86_64",
    authority_configuration: reference(value.authority_configuration),
    native_boundary_configuration: reference(value.native_boundary_configuration),
    scheduler_identity: {
      kind: value.scheduler_identity.kind,
      name: value.scheduler_identity.name,
    },
    capture_root: canonical(value.capture_root, windows),
  };
}

/** Initial installation data only. Tokens and keys are never configuration
 * values, incoming requests or candidate inputs. Native issuer IDs come from
 * the independently pinned global role configuration. */
export function inspectLocalNativeTransport(
  raw: unknown,
  platform: "windows-x86_64" | "linux-x86_64",
) {
  exact(raw, "github_cli,native_issuer,schema_version,source_read_token");
  if (raw.schema_version !== 1) throw new Error("native transport schema differs");
  exact(raw.native_issuer, "private_key,public_key_sha256");
  exact(raw.github_cli, "path,sha256");
  const windows = platform === "windows-x86_64";
  const source = canonical(raw.source_read_token, windows),
    key = canonical(raw.native_issuer.private_key, windows);
  if ((windows ? source.toLowerCase() : source) === (windows ? key.toLowerCase() : key))
    throw new Error("native source reader and issuer custody are conflated");
  return {
    schema_version: 1 as const,
    source_read_token: source,
    github_cli: {
      path: canonical(raw.github_cli.path, windows),
      sha256: digest(raw.github_cli.sha256),
    },
    native_issuer: {
      private_key: key,
      public_key_sha256: digest(raw.native_issuer.public_key_sha256),
    },
  };
}

async function linuxOwnerPath(filename: string, directory = false) {
  const uid = process.getuid?.();
  if (!uid || process.platform !== "linux" || process.env.GITHUB_ACTIONS === "true")
    throw new Error("ordinary local Linux parent required");
  for (let current = filename; ; current = path.dirname(current)) {
    const info = await lstat(current);
    if (
      info.isSymbolicLink() ||
      ![0, uid].includes(info.uid) ||
      (info.mode & 0o022) !== 0 ||
      (current === filename &&
        (info.uid !== uid ||
          (info.mode & 0o077) !== 0 ||
          (directory ? !info.isDirectory() : !info.isFile() || info.nlink !== 1)))
    )
      throw new Error("local native setup ownership or ancestry differs");
    if (path.dirname(current) === current) break;
  }
  if ((await realpath(filename)) !== filename)
    throw new Error("local native setup path is aliased");
}

/** Bounded byte custody only. The scheduler collector joins these pins to the
 * actual protected installation and process before minting a private parent
 * execution receipt. This function itself supplies no native acceptance brand. */
async function readPinnedLocalNativeSetupBytes(configurationPath: string, expectedSha256: string) {
  digest(expectedSha256);
  const read = async (file: string, expected: string) => {
    const bytes = await readBoundedPublicBuildInputFile(
      path.dirname(file),
      path.basename(file),
      32 * 1024,
    );
    if (sha(bytes) !== expected) throw new Error("pinned local native setup bytes changed");
    return bytes;
  };
  if (!path.isAbsolute(configurationPath)) throw new Error("fixed setup path required");
  if (process.platform === "linux") await linuxOwnerPath(configurationPath);
  const descriptor = inspectLocalNativeSetup(
    JSON.parse((await read(configurationPath, expectedSha256)).toString("utf8")),
  );
  const installationPath = path.join(path.dirname(configurationPath), "installation.json");
  if (process.platform === "linux") await linuxOwnerPath(installationPath);
  const installationBytes = await readBoundedPublicBuildInputFile(
    path.dirname(installationPath),
    "installation.json",
    32 * 1024,
  );
  const installation: unknown = JSON.parse(installationBytes.toString("utf8"));
  exact(
    installation,
    "controller_revision,descriptor_sha256,kind,scheduler,schema_version,setup_grant_sha256,transport",
  );
  if (
    installation.schema_version !== 1 ||
    installation.kind !== "local-native-parent-installation" ||
    installation.descriptor_sha256 !== expectedSha256 ||
    installation.setup_grant_sha256 !== descriptor.setup_grant_sha256 ||
    installation.controller_revision !== descriptor.controller_revision ||
    !isRecord(installation.scheduler)
  )
    throw new Error("actual local installation does not bind this setup descriptor");
  if (process.platform !== (descriptor.platform_label === "windows-x86_64" ? "win32" : "linux"))
    throw new Error("local native setup platform differs");
  const transport = inspectLocalNativeTransport(installation.transport, descriptor.platform_label);
  if (process.platform === "linux") {
    // Source hashes do not prevent a separate account from replacing a later
    // imported helper. The installed controller is private owner staging too.
    await linuxOwnerPath(checkout, true);
    for (const file of [
      descriptor.authority_configuration.path,
      descriptor.native_boundary_configuration.path,
    ])
      await linuxOwnerPath(file);
    await linuxOwnerPath(descriptor.capture_root, true);
    await linuxOwnerPath(transport.source_read_token);
    await linuxOwnerPath(transport.native_issuer.private_key);
  }
  const authority = inspectReleaseAuthorityConfiguration(
    JSON.parse(
      (
        await read(
          descriptor.authority_configuration.path,
          descriptor.authority_configuration.sha256,
        )
      ).toString("utf8"),
    ),
  );
  const boundary: unknown = JSON.parse(
    (
      await read(
        descriptor.native_boundary_configuration.path,
        descriptor.native_boundary_configuration.sha256,
      )
    ).toString("utf8"),
  );
  const credentials = [transport.source_read_token, transport.native_issuer.private_key];
  const publicFiles = [
    configurationPath,
    installationPath,
    descriptor.authority_configuration.path,
    descriptor.native_boundary_configuration.path,
  ];
  const parser = process.platform === "win32" ? path.win32 : path.posix;
  const normalize = (value: string) =>
    process.platform === "win32" ? parser.resolve(value).toLowerCase() : parser.resolve(value);
  const candidateRoots = [
    checkout,
    descriptor.capture_root,
    ...(isRecord(boundary)
      ? [boundary.work_root, boundary.profile_root].filter(
          (value): value is string => typeof value === "string",
        )
      : []),
  ];
  for (const file of credentials) {
    if (
      publicFiles.some((value) => normalize(file) === normalize(value)) ||
      candidateRoots.some((root) => {
        const relative = parser.relative(normalize(root), normalize(file));
        return relative === "" || (!relative.startsWith("..") && !parser.isAbsolute(relative));
      })
    )
      throw new Error("native credentials overlap public input, candidate work or capture custody");
  }
  if (authority.namespace !== descriptor.namespace)
    throw new Error("local native setup namespace differs from global configuration");
  const git = (args: string[]) =>
    execFileSync(
      "git",
      [
        "--no-optional-locks",
        "--no-replace-objects",
        "-C",
        checkout,
        "-c",
        "core.fsmonitor=false",
        "-c",
        "core.hooksPath=",
        ...args,
      ],
      {
        encoding: "utf8",
        timeout: 15000,
        maxBuffer: 64 * 1024,
        windowsHide: true,
        env: {
          PATH: process.env.PATH,
          SystemRoot: process.env.SystemRoot,
          HOME: process.env.HOME,
          GIT_CONFIG_NOSYSTEM: "1",
          GIT_CONFIG_GLOBAL: process.platform === "win32" ? "NUL" : "/dev/null",
          GIT_NO_LAZY_FETCH: "1",
          GIT_TERMINAL_PROMPT: "0",
        },
      },
    ).trim();
  if (
    git(["rev-parse", "HEAD"]) !== descriptor.controller_revision ||
    git(["status", "--porcelain", "--untracked-files=no"]) !== ""
  )
    throw new Error("fixed native parent controller source changed");
  const ownSource = "scripts/release-local-native-setup.mts";
  if (git(["rev-parse", `HEAD:${ownSource}`]) !== git(["hash-object", ownSource]))
    throw new Error("local native setup reader is not the tracked frozen source");
  return {
    descriptor,
    descriptor_sha256: expectedSha256,
    authority_configuration: authority,
    authority_configuration_sha256: capacityDigest(authority),
    boundary_configuration: boundary,
    configuration_path: configurationPath,
    installation_path: installationPath,
    installation_sha256: sha(installationBytes),
    installation_record: installation,
    transport_configuration: transport,
    controller_root: checkout,
    controller_tree: git(["rev-parse", "HEAD^{tree}"]),
    authority: "none",
    scope: "pinned setup byte custody; actual scheduler and parent boundary still required",
  };
}

const custody = new WeakMap<object, { path: string; sha256: string; value: string }>();
export async function readPinnedLocalNativeSetup(
  configurationPath: string,
  expectedSha256: string,
) {
  const actual = await readPinnedLocalNativeSetupBytes(configurationPath, expectedSha256);
  const receipt = Object.freeze({
    kind: "local-native-setup-byte-custody",
    descriptor_sha256: expectedSha256,
    authority: "none",
    scope: actual.scope,
  });
  custody.set(receipt, {
    path: configurationPath,
    sha256: expectedSha256,
    value: capacityDigest(actual),
  });
  return receipt;
}

/** Private byte-custody getter, not a scheduler or execution grant. Windows ACL
 * ownership must come from the fixed actual scheduler collector before use. */
export async function requirePinnedLocalNativeSetup(receipt: object) {
  const actual = custody.get(receipt);
  if (!actual) throw new Error("actual pinned local setup byte custody required");
  const read = async () => {
    const value = await readPinnedLocalNativeSetupBytes(actual.path, actual.sha256);
    if (capacityDigest(value) !== actual.value)
      throw new Error("local native setup custody changed");
    return value;
  };
  return {
    ...(await read()),
    recheck: async () => {
      await read();
    },
  };
}

export function renderLinuxNativeWorkerUnit(
  node: string,
  controller: string,
  descriptor: string,
  descriptorSha256: string,
) {
  const paths = [node, controller, descriptor].map((value) => canonical(value, false));
  if (!paths.every((value) => /^\/[A-Za-z0-9_./-]+$/u.test(value)))
    throw new Error("literal Linux native unit paths required");
  digest(descriptorSha256);
  return `[Unit]\nDescription=Portcove bounded native qualification parent\nAfter=network-online.target\n\n[Service]\nType=oneshot\nWorkingDirectory=${controller}\nExecStart=${node} ${controller}/scripts/release-native-worker.mts ${descriptor} ${descriptorSha256}\nUMask=0077\nTimeoutStartSec=2100\nTimeoutStopSec=30\nKillMode=control-group\nRestart=no\n`;
}

const linuxSchedulers = new WeakMap<object, { setup: object; identity: string }>();
async function readLinuxNativeScheduler(setupReceipt: object) {
  const setup = await requirePinnedLocalNativeSetup(setupReceipt);
  const uid = process.getuid?.();
  if (
    process.platform !== "linux" ||
    !uid ||
    setup.descriptor.platform_label !== "linux-x86_64" ||
    process.env.GITHUB_ACTIONS === "true" ||
    process.execArgv.length !== 0 ||
    ["NODE_OPTIONS", "NODE_PATH", "LD_PRELOAD", "LD_LIBRARY_PATH"].some((name) => process.env[name])
  )
    throw new Error("fixed ordinary native Linux worker required");
  const host = setup.authority_configuration.native["linux-x86_64"].host;
  if (!isRecord(host.account) || host.account.broker !== String(uid))
    throw new Error("native worker UID differs from configured broker");
  const scheduler = setup.installation_record.scheduler;
  exact(scheduler, "node,systemctl_sha256,unit_sha256");
  exact(scheduler.node, "path,sha256");
  const node = canonical(scheduler.node.path, false);
  const nodeSha = digest(scheduler.node.sha256);
  const systemctlSha = digest(scheduler.systemctl_sha256);
  const unitSha = digest(scheduler.unit_sha256);
  const script = path.join(setup.controller_root, "scripts/release-native-worker.mts");
  if (
    process.execPath !== node ||
    JSON.stringify(process.argv) !==
      JSON.stringify([node, script, setup.configuration_path, setup.descriptor_sha256])
  )
    throw new Error("native worker actual command differs from installed action");
  const identity = async () => {
    const stat = await readFile("/proc/self/stat", "utf8");
    const end = stat.lastIndexOf(") ");
    const started = stat.slice(end + 2).split(" ")[19];
    if (end < 1 || !started || !/^[1-9][0-9]*$/u.test(started))
      throw new Error("actual native worker process creation unavailable");
    const cgroup = await readFile("/proc/self/cgroup", "utf8");
    const match = /^0::(\/[^\n]+)\n$/u.exec(cgroup);
    if (!match || !match[1]!.endsWith("/portcove-native-worker.service"))
      throw new Error("native worker is outside the fixed user unit cgroup");
    return { pid: process.pid, uid, started, cgroup: match[1]! };
  };
  const before = await identity();
  const read = async () => {
    const binary = "/usr/bin/systemctl";
    const info = await lstat(binary);
    if (
      !info.isFile() ||
      info.isSymbolicLink() ||
      info.uid !== 0 ||
      (info.mode & 0o6022) !== 0 ||
      sha(await readBoundedPublicBuildInputFile("/usr/bin", "systemctl", 16 * 1024 * 1024)) !==
        systemctlSha
    )
      throw new Error("fixed systemctl executable custody differs");
    const raw = execFileSync(
      binary,
      [
        "--user",
        "show",
        "portcove-native-worker.service",
        "--property=LoadState,ActiveState,MainPID,ControlGroup,FragmentPath,DropInPaths",
      ],
      {
        encoding: "utf8",
        timeout: 10000,
        maxBuffer: 8192,
        env: {
          PATH: "/usr/bin:/bin",
          LANG: "C.UTF-8",
          HOME: process.env.HOME,
          XDG_RUNTIME_DIR: `/run/user/${uid}`,
        },
      },
    );
    const values: Record<string, string> = {};
    for (const line of raw.trim().split("\n")) {
      const match =
        /^(LoadState|ActiveState|MainPID|ControlGroup|FragmentPath|DropInPaths)=(.*)$/u.exec(line);
      if (!match || Object.hasOwn(values, match[1]!))
        throw new Error("ambiguous actual native unit properties");
      values[match[1]!] = match[2]!;
    }
    if (
      values.LoadState !== "loaded" ||
      !["activating", "active"].includes(values.ActiveState ?? "") ||
      values.MainPID !== String(process.pid) ||
      values.ControlGroup !== before.cgroup ||
      values.DropInPaths !== "" ||
      !values.FragmentPath
    )
      throw new Error("native unit does not own this exact process");
    await linuxOwnerPath(values.FragmentPath);
    const unit = await readBoundedPublicBuildInputFile(
      path.dirname(values.FragmentPath),
      path.basename(values.FragmentPath),
      16384,
    );
    if (
      sha(unit) !== unitSha ||
      unit.toString("utf8") !==
        renderLinuxNativeWorkerUnit(
          node,
          setup.controller_root,
          setup.configuration_path,
          setup.descriptor_sha256,
        ) ||
      sha(
        await readBoundedPublicBuildInputFile(
          path.dirname(node),
          path.basename(node),
          256 * 1024 * 1024,
        ),
      ) !== nodeSha
    )
      throw new Error("actual native unit/action/runtime differs from installed fixed bytes");
    return values;
  };
  const first = await read();
  await setup.recheck();
  const last = await read();
  if (
    capacityDigest(first) !== capacityDigest(last) ||
    capacityDigest(before) !== capacityDigest(await identity())
  )
    throw new Error("native scheduler changed during observation");
  return {
    process: before,
    unit_sha256: unitSha,
    node_sha256: nodeSha,
    systemctl_sha256: systemctlSha,
    descriptor_sha256: setup.descriptor_sha256,
    setup_grant_sha256: setup.descriptor.setup_grant_sha256,
    authority: "none",
    scope:
      "actual fixed Linux scheduler/process and pinned setup custody; native result still required",
  };
}

export async function observeActualLinuxNativeScheduler(setupReceipt: object) {
  const actual = await readLinuxNativeScheduler(setupReceipt);
  const receipt = Object.freeze({ kind: "actual-linux-native-scheduler", authority: "none" });
  linuxSchedulers.set(receipt, { setup: setupReceipt, identity: capacityDigest(actual) });
  return receipt;
}
export async function requireActualLinuxNativeScheduler(receipt: object) {
  const actual = linuxSchedulers.get(receipt);
  if (!actual) throw new Error("actual Linux native scheduler observation required");
  const value = await readLinuxNativeScheduler(actual.setup);
  if (capacityDigest(value) !== actual.identity)
    throw new Error("native scheduler observation changed");
  return value;
}
