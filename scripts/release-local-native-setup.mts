import path from "node:path";
import { createHash } from "node:crypto";
import { lstat, realpath } from "node:fs/promises";
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
    "controller_revision,descriptor_sha256,kind,scheduler,schema_version,setup_grant_sha256",
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
  if (process.platform === "linux") {
    for (const file of [
      descriptor.authority_configuration.path,
      descriptor.native_boundary_configuration.path,
    ])
      await linuxOwnerPath(file);
    await linuxOwnerPath(descriptor.capture_root, true);
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
    controller_root: checkout,
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
