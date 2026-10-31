import { selectedHostedNativePlatform } from "./release-authority-configuration-contract.mts";
/** Held source preparation only. Public observations cannot mint an original
 * parent, runtime or source receipt; no account or native candidate is executed. */
import { nativeQualificationWorkerPath } from "./release-native-qualification-contract.mts";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import {
  constants,
  closeSync,
  fstatSync,
  lstatSync,
  openSync,
  readSync,
  readdirSync,
  realpathSync,
  writeSync,
} from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { performance } from "node:perf_hooks";
import { requireActualHostedNativeParentSource } from "./release-hosted-native-parent.mts";
import { verifiedControllerToolPaths } from "./release-controller-tool-admission.mts";
import { readControllerToolFile } from "./release-controller-tools.mts";
import {
  requireHostedNativeRuntime,
  hostedNativeSupportDependencies,
} from "./release-hosted-native-runtime.mts";
import {
  inspectNativeRuntimeCustody,
  recheckNativeRuntimeCustody,
  inspectWindowsSourceSystemCustody,
  recheckWindowsSourceSystemCustody,
  windowsSourceSystemExecutables,
} from "./release-native-runtime-custody.mts";
import { runResourceCommand } from "./resource-command.mts";
import { runRustTests } from "./run-rust-tests.mts";
import { readNativeCapturedStream } from "./release-native-capture-files.mts";
import { assertControllerBootstrapEnvironment } from "./release-controller-job-bootstrap.mts";
import { isRecord } from "./runtime-values.mts";
import {
  checkCoordinatorDeadline,
  coordinatorCommandTimeout,
  withCoordinatorDeadline,
} from "./release-coordinator-deadline.mts";
import { nativePnpmVersion } from "./release-pnpm-runtime.mts";
import {
  inspectWindowsNativeDependencyInputs,
  snapshotWindowsNativeDependencies,
} from "./release-hosted-native-windows-dependency-files.mts";

export const hostedWindowsDependencyPreparationMilliseconds = 180000;
const { git, powershell } = windowsSourceSystemExecutables;
const harness = nativeQualificationWorkerPath;
const hash = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
type Entry = Readonly<{ path: string; bytes: number; object: string }>;

/** Closed checkout representation, including case-insensitive directory aliases.
 * Unsupported Windows names refuse before checkout; this is not a catalog rule. */
export function inspectWindowsNativeSourceTree(bytes: Buffer) {
  assert.ok(bytes.length > 0 && bytes.length <= 4 * 1024 ** 2 && bytes.at(-1) === 0);
  const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  const entries: Entry[] = [];
  const names = new Map<string, { spelling: string; directory: boolean }>();
  let total = 0;
  for (const record of text.slice(0, -1).split("\0")) {
    assert.ok(entries.length < 32768, "source inventory exceeds bound");
    const match = /^(100644|100755) blob ([a-f0-9]{40}) +([0-9]+)\t(.+)$/u.exec(record);
    assert.ok(match, "source links, submodules and unsupported modes refused");
    const name = match[4]!,
      size = Number(match[3]);
    assert.ok(Number.isSafeInteger(size) && size <= 128 * 1024 ** 2);
    total += size;
    assert.ok(total <= 256 * 1024 ** 2, "source bytes exceed bound");
    assert.ok(name.length <= 512 && /^[\x20-\x7e]+$/u.test(name) && !/[<>:"\\|?*~]/u.test(name));
    const parts = name.split("/");
    assert.ok(parts.length <= 64);
    for (let index = 0; index < parts.length; index++) {
      const part = parts[index]!;
      assert.ok(part.length > 0 && part.length <= 255 && !/[ .]$/u.test(part));
      assert.ok(![".", "..", ".git"].includes(part.toLowerCase()));
      assert.ok(
        !/^(?:con|prn|aux|nul|com[1-9]|lpt[1-9]|conin\$|conout\$|clock\$)(?:\.|$)/iu.test(part),
      );
      const spelling = parts.slice(0, index + 1).join("/"),
        key = spelling.toLowerCase();
      const directory = index < parts.length - 1,
        prior = names.get(key);
      assert.ok(
        !prior || (directory && prior.directory && prior.spelling === spelling),
        "source path alias or prefix collision",
      );
      names.set(key, { spelling, directory });
      assert.ok(names.size <= 32768, "source directory/file inventory exceeds bound");
    }
    entries.push(Object.freeze({ path: name, bytes: size, object: match[2]! }));
  }
  assert.ok(
    entries.some((entry) => entry.path === harness),
    "fixed harness absent",
  );
  return Object.freeze(entries);
}

/** Full blob readback catches checkout filters, encoding/EOL conversion and
 * changed bytes; clean Git status alone does not establish this observation. */
export function verifyWindowsNativeSourceFiles(
  root: string,
  entries: readonly Entry[],
  expectedHarness: string,
  active: () => void,
) {
  assert.match(expectedHarness, /^[a-f0-9]{64}$/u);
  assert.equal(realpathSync(root), root);
  for (const entry of entries) {
    active();
    const filename = path.join(root, ...entry.path.split("/"));
    assert.equal(
      realpathSync(path.dirname(filename)),
      path.dirname(filename),
      "source ancestry changed",
    );
    const before = lstatSync(filename);
    assert.ok(
      before.isFile() &&
        !before.isSymbolicLink() &&
        before.nlink === 1 &&
        before.size === entry.bytes,
    );
    const fd = openSync(
      filename,
      constants.O_RDONLY | (process.platform === "win32" ? 0 : constants.O_NOFOLLOW),
    );
    const same = (actual: typeof before) => {
      for (const key of ["dev", "ino", "size", "mtimeMs", "ctimeMs", "nlink"] as const)
        assert.equal(actual[key], before[key], "source file changed during readback");
    };
    try {
      same(fstatSync(fd));
      const blob = createHash("sha1").update(`blob ${before.size}\0`),
        content = createHash("sha256"),
        buffer = Buffer.alloc(65536);
      let count = 0;
      while (true) {
        active();
        const length = readSync(
          fd,
          buffer,
          0,
          Math.min(buffer.length, before.size - count + 1),
          null,
        );
        if (!length) break;
        count += length;
        assert.ok(count <= before.size);
        blob.update(buffer.subarray(0, length));
        if (entry.path === harness) content.update(buffer.subarray(0, length));
      }
      assert.equal(count, before.size);
      assert.equal(blob.digest("hex"), entry.object, "checked out Git blob differs");
      if (entry.path === harness) assert.equal(content.digest("hex"), expectedHarness);
      same(fstatSync(fd));
      same(lstatSync(filename));
    } finally {
      closeSync(fd);
    }
  }
  active();
}

type Plan = {
  schema_version: 1;
  binding: string;
  source_commit: string;
  source_tree: string;
  harness_sha256: string;
  root: string;
  setup: string;
  expires_at: number;
};
function inspectPlan(raw: unknown): Plan {
  assert.ok(
    isRecord(raw) &&
      Object.keys(raw).sort().join(",") ===
        "binding,expires_at,harness_sha256,root,schema_version,setup,source_commit,source_tree",
  );
  assert.equal(raw.schema_version, 1);
  for (const key of ["binding", "harness_sha256"] as const)
    assert.ok(typeof raw[key] === "string" && /^[a-f0-9]{64}$/u.test(raw[key]));
  for (const key of ["source_commit", "source_tree"] as const)
    assert.ok(typeof raw[key] === "string" && /^[a-f0-9]{40}$/u.test(raw[key]));
  for (const key of ["root", "setup"] as const)
    assert.ok(typeof raw[key] === "string" && path.isAbsolute(raw[key]));
  assert.ok(
    typeof raw.expires_at === "number" &&
      Number.isSafeInteger(raw.expires_at) &&
      raw.expires_at > Date.now() &&
      raw.expires_at - Date.now() <= 90000,
  );
  assert.equal(path.basename(raw.root as string), "windows-source");
  assert.equal(path.basename(raw.setup as string), "release-hosted-native-windows-setup.cs.txt");
  return raw as Plan;
}

/** Live producer observations are bounded samples, never settled custody proof. */
export function windowsPreparationEntryDisappeared(
  error: unknown,
  filename: string,
  requiredRoot: string,
  live: boolean,
) {
  if (!live || filename === requiredRoot || !isRecord(error)) return false;
  if (error.code === "ENOENT") return true;
  if (error.code !== "EBUSY") return false;
  // Windows can report a sharing error while pnpm removes a staging directory.
  // A still-present busy path, permissions failure or any other error refuses.
  try {
    lstatSync(filename);
    return false;
  } catch (after) {
    return isRecord(after) && after.code === "ENOENT";
  }
}

/** Only a live directory enumeration may defer a Windows sharing violation.
 * This is not inventory coverage: settled scans and the final graph stay strict.
 */
export function windowsPreparationDirectoryEnumerationDeferred(
  error: unknown,
  filename: string,
  requiredRoot: string,
  live: boolean,
) {
  if (!live || filename === requiredRoot || !isRecord(error) || error.code !== "EBUSY")
    return false;
  // Recheck type after the enumeration failure. Never defer lstat failures,
  // links, files, denied access or a required root.
  const info = lstatSync(filename);
  return info.isDirectory() && !info.isSymbolicLink();
}

export function inspectWindowsSourcePreparationInventory(
  root: string,
  active: () => void,
  live = false,
) {
  let count = 0,
    bytes = 0;
  const pending = [root];
  while (pending.length) {
    active();
    const current = pending.pop()!;
    let entries;
    try {
      entries = readdirSync(current);
    } catch (error) {
      if (windowsPreparationEntryDisappeared(error, current, root, live)) continue;
      throw error;
    }
    for (const name of entries) {
      active();
      const filename = path.join(current, name);
      assert.ok(++count <= 32768);
      let info;
      try {
        info = lstatSync(filename);
      } catch (error) {
        if (windowsPreparationEntryDisappeared(error, filename, root, live)) continue;
        throw error;
      }
      assert.ok(!info.isSymbolicLink());
      bytes += info.size;
      assert.ok(
        bytes <= 512 * 1024 ** 2 && (info.isDirectory() || (info.isFile() && info.nlink === 1)),
      );
      if (info.isDirectory()) pending.push(filename);
    }
  }
  return { entries: count, bytes };
}

function preparationCommand(
  environment: Record<string, string>,
  cwd: string,
  inventory: (live?: boolean) => void,
) {
  return async (
    executable: string,
    args: string[],
    maximum = 8192,
    extra: Record<string, string> = {},
  ) => {
    inventory();
    let retained = 0,
      errors = 0,
      retainedErrors = 0;
    const output: Buffer[] = [],
      errorBytes: Buffer[] = [];
    await new Promise<void>((resolve, reject) => {
      const child = spawn(executable, args, {
        cwd,
        env: { ...environment, ...extra },
        windowsHide: true,
        stdio: ["ignore", "pipe", "pipe"],
      });
      const fail = (reason: unknown, exit: number | null = null, signal: string | null = null) => {
        const stderr = Buffer.concat(errorBytes),
          stdout = Buffer.concat(output).subarray(0, 2048);
        const diagnostic = {
          executable: path.basename(executable),
          stage:
            executable === powershell
              ? "private-directory"
              : path.basename(executable).toLowerCase() === "pnpm.exe"
                ? "dependencies"
                : args.find((arg) =>
                    ["init", "fetch", "rev-parse", "ls-tree", "checkout"].includes(arg),
                  ),
          exit,
          signal,
          reason: String(reason).slice(0, 512),
          stderr: {
            observed_bytes: errors,
            retained_bytes: stderr.length,
            truncated: errors > stderr.length,
            sha256: hash(stderr),
            base64: stderr.toString("base64"),
          },
          stdout_prefix: { bytes: stdout.length, base64: stdout.toString("base64") },
        };
        child.kill();
        reject(
          Object.assign(new Error("fixed source command failed; retain diagnostics"), {
            diagnostic,
          }),
        );
      };
      const timer = setInterval(() => {
        try {
          inventory(true);
        } catch (error) {
          fail(error);
        }
      }, 250);
      child.once("error", fail);
      child.stdout.on("data", (data: Buffer) => {
        const available = Math.min(data.length, Math.max(0, maximum - retained));
        if (available) output.push(data.subarray(0, available));
        retained += data.length;
        if (retained > maximum) fail(new Error("source command output exceeds bound"));
      });
      child.stderr.on("data", (data: Buffer) => {
        errors += data.length;
        const available = Math.min(data.length, Math.max(0, 8192 - retainedErrors));
        if (available) {
          errorBytes.push(data.subarray(0, available));
          retainedErrors += available;
        }
        if (errors > 8192) fail(new Error("source command stderr exceeds bound"));
      });
      child.once("close", (status, exitSignal) => {
        clearInterval(timer);
        if (status === 0) resolve();
        else fail("fixed source command failed; retain partial state", status, exitSignal);
      });
    });
    inventory();
    return Buffer.concat(output);
  };
}

/** Prepared supervisor child. It emits observations, never original receipts. */
async function acquireSource(planFile: string) {
  assert.ok(process.platform === "win32" && process.arch === "x64");
  assertControllerBootstrapEnvironment();
  const plan = inspectPlan(
    JSON.parse((await readControllerToolFile(planFile, 8192)).toString("utf8")),
  );
  const active = () => assert.ok(Date.now() < plan.expires_at, "source preparation expired");
  const environment = {
    HOME: path.dirname(plan.root),
    USERPROFILE: path.dirname(plan.root),
    XDG_CONFIG_HOME: path.dirname(plan.root),
    SystemRoot: "C:\\Windows",
    PATH: path.dirname(process.execPath) + ";C:\\Windows\\System32",
    TEMP: path.dirname(plan.root),
    TMP: path.dirname(plan.root),
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: "NUL",
    GIT_CONFIG_SYSTEM: "NUL",
    GIT_ATTR_NOSYSTEM: "1",
    GIT_NO_LAZY_FETCH: "1",
    GIT_NO_REPLACE_OBJECTS: "1",
    GIT_TERMINAL_PROMPT: "0",
    GCM_INTERACTIVE: "never",
  };
  // Detection can lag writes; this is deliberately not a hard filesystem quota.
  let inventoryEnabled = false;
  const inventory = (live = false) => {
    active();
    if (!inventoryEnabled) return;
    inspectWindowsSourcePreparationInventory(plan.root, active, live);
  };
  const command = preparationCommand(environment, path.dirname(plan.root), inventory);
  const script =
    "$ErrorActionPreference='Stop';Set-StrictMode -Version Latest;$p=[IO.File]::ReadAllText($env:PORTCOVE_SOURCE_PLAN)|ConvertFrom-Json;Add-Type -TypeDefinition ([IO.File]::ReadAllText($p.setup));[Portcove.HostedNative.Setup]::Directory($p.root,[Security.Principal.WindowsIdentity]::GetCurrent().User.Value,$null,$false)";
  await command(
    powershell,
    ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", script],
    8192,
    { PORTCOVE_SOURCE_PLAN: planFile },
  );
  inventoryEnabled = true;
  const source = path.join(plan.root, "source"),
    hooks = path.join(plan.root, "hooks");
  await mkdir(hooks);
  const options = [
    "-c",
    `core.hooksPath=${hooks}`,
    "-c",
    "core.fsmonitor=false",
    "-c",
    "core.attributesFile=NUL",
    "-c",
    "core.protectNTFS=true",
    "-c",
    "core.autocrlf=false",
    "-c",
    "core.longpaths=true",
    "-c",
    "protocol.allow=never",
    "-c",
    "protocol.https.allow=always",
    "-c",
    "credential.helper=",
    "-c",
    "http.followRedirects=false",
    "-c",
    "http.sslVerify=true",
    "-c",
    "http.lowSpeedLimit=1024",
    "-c",
    "http.lowSpeedTime=15",
    "-c",
    "fetch.recurseSubmodules=false",
    "-c",
    "fetch.unpackLimit=1",
    "-c",
    "gc.auto=0",
  ];
  const gitCommand = (args: string[], maximum?: number) =>
    command(git, [...options, ...args], maximum);
  await gitCommand(["init", "--quiet", "--template=", source]);
  await gitCommand([
    "-C",
    source,
    "fetch",
    "--quiet",
    "--depth=1",
    "--no-tags",
    "--no-recurse-submodules",
    "https://github.com/boburning/portcove.git",
    plan.source_commit,
  ]);
  assert.equal(
    (await gitCommand(["-C", source, "rev-parse", "FETCH_HEAD"])).toString().trim(),
    plan.source_commit,
  );
  assert.equal(
    (await gitCommand(["-C", source, "rev-parse", "FETCH_HEAD^{tree}"])).toString().trim(),
    plan.source_tree,
  );
  const tree = await gitCommand(
    ["-C", source, "ls-tree", "-r", "-l", "-z", "FETCH_HEAD"],
    4 * 1024 ** 2,
  );
  await writeFile(path.join(plan.root, "tree.bin"), tree, { flag: "wx", flush: true });
  const entries = inspectWindowsNativeSourceTree(tree);
  await gitCommand(["-C", source, "checkout", "--quiet", "--detach", plan.source_commit]);
  verifyWindowsNativeSourceFiles(source, entries, plan.harness_sha256, active);
  inventory();
  active();
  return {
    schema_version: 1,
    binding: plan.binding,
    source_commit: plan.source_commit,
    source_tree: plan.source_tree,
    tree_inventory_sha256: hash(tree),
    acquired: true,
    dependencies_prepared: false,
    native_acceptance: "not-established",
    authority: "none",
  };
}

type DependencyPlan = Pick<Plan, "schema_version" | "binding" | "root" | "setup" | "expires_at"> & {
  source: string;
  pnpm: string;
  inputs: Awaited<ReturnType<typeof inspectWindowsNativeDependencyInputs>>;
};

let dependencyProgress: { phase: string; elapsed_milliseconds: number }[] = [];
async function acquireDependencies(planFile: string) {
  const started = performance.now();
  const phase = (name: string) => {
    assert.ok(dependencyProgress.length < 16);
    dependencyProgress.push({
      phase: name,
      elapsed_milliseconds: Math.round(performance.now() - started),
    });
  };
  dependencyProgress = [];
  phase("preflight");
  assert.ok(process.platform === "win32" && process.arch === "x64");
  assertControllerBootstrapEnvironment();
  const raw: unknown = JSON.parse((await readControllerToolFile(planFile, 8192)).toString("utf8"));
  assert.ok(
    isRecord(raw) &&
      Object.keys(raw).sort().join(",") ===
        "binding,expires_at,inputs,pnpm,root,schema_version,setup,source",
  );
  assert.equal(raw.schema_version, 1);
  assert.ok(typeof raw.binding === "string" && /^[a-f0-9]{64}$/u.test(raw.binding));
  for (const key of ["root", "setup", "source", "pnpm"] as const)
    assert.ok(typeof raw[key] === "string" && path.isAbsolute(raw[key]));
  assert.ok(
    typeof raw.expires_at === "number" &&
      Number.isSafeInteger(raw.expires_at) &&
      raw.expires_at > Date.now() &&
      raw.expires_at - Date.now() <= hostedWindowsDependencyPreparationMilliseconds,
    "Windows dependency plan expiry exceeds internal preparation allocation",
  );
  const plan = raw as DependencyPlan;
  assert.equal(path.basename(plan.root), "windows-dependencies");
  assert.equal(plan.source, path.join(path.dirname(plan.root), "windows-source", "source"));
  assert.equal(path.basename(plan.setup), "release-hosted-native-windows-setup.cs.txt");
  assert.equal(plan.pnpm, path.join(path.dirname(path.dirname(plan.setup)), "bin/pnpm.exe"));
  const deadline = performance.now() + plan.expires_at - Date.now();
  const active = () => {
    assertControllerBootstrapEnvironment();
    assert.ok(
      Date.now() < plan.expires_at && performance.now() < deadline,
      "original dependency preparation expired",
    );
  };
  assert.deepEqual(
    await inspectWindowsNativeDependencyInputs(plan.source, deadline, active),
    plan.inputs,
  );
  for (const name of ["node_modules", "apps/desktop/node_modules"])
    assert.equal(
      lstatSync(path.join(plan.source, name), { throwIfNoEntry: false }),
      undefined,
      "retained dependencies require explicit recovery",
    );
  phase("validated-inputs");
  let created = false;
  // Detection can lag writes; the original supervisor owns process-tree teardown.
  const inventory = (live = false) => {
    active();
    if (!created) return;
    const pending = [
      plan.root,
      ...["node_modules", "apps/desktop/node_modules"].map((name) => path.join(plan.source, name)),
    ];
    let count = 0,
      bytes = 0;
    while (pending.length) {
      active();
      const current = pending.pop()!,
        info = lstatSync(current, { throwIfNoEntry: false });
      assert.ok(++count <= 100000);
      if (!info) {
        assert.notEqual(current, plan.root, "required dependency preparation root disappeared");
        continue; // pnpm removes/renames live staging leaves; the final graph is strict.
      }
      bytes += info.size;
      assert.ok(
        bytes <= 2 * 1024 ** 3 &&
          (info.isSymbolicLink() || info.isDirectory() || (info.isFile() && info.nlink === 1)),
        "dependency preparation inventory exceeded",
      );
      if (info.isDirectory() && !info.isSymbolicLink()) {
        let entries;
        try {
          entries = readdirSync(current);
        } catch (error) {
          if (windowsPreparationEntryDisappeared(error, current, plan.root, live)) continue;
          if (windowsPreparationDirectoryEnumerationDeferred(error, current, plan.root, live))
            continue;
          throw error;
        }
        assert.ok(count + pending.length + entries.length <= 100000);
        pending.push(...entries.map((name) => path.join(current, name)));
      }
    }
  };
  const environment = {
    SystemRoot: "C:\\Windows",
    PATH: path.dirname(process.execPath) + ";C:\\Windows\\System32",
    HOME: plan.root,
    USERPROFILE: plan.root,
    XDG_CONFIG_HOME: plan.root,
    XDG_CACHE_HOME: plan.root,
    XDG_DATA_HOME: plan.root,
    TEMP: plan.root,
    TMP: plan.root,
    CI: "true",
    COREPACK_ENABLE_NETWORK: "0",
    npm_config_userconfig: "NUL",
    npm_config_globalconfig: "NUL",
  };
  const command = preparationCommand(environment, path.dirname(plan.root), inventory);
  await command(
    powershell,
    [
      "-NoLogo",
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      "$ErrorActionPreference='Stop';Set-StrictMode -Version Latest;$p=[IO.File]::ReadAllText($env:PORTCOVE_SOURCE_PLAN)|ConvertFrom-Json;Add-Type -TypeDefinition ([IO.File]::ReadAllText($p.setup));[Portcove.HostedNative.Setup]::Directory($p.root,[Security.Principal.WindowsIdentity]::GetCurrent().User.Value,$null,$false)",
    ],
    8192,
    {
      PORTCOVE_SOURCE_PLAN: planFile,
      TEMP: path.dirname(plan.root),
      TMP: path.dirname(plan.root),
      HOME: path.dirname(plan.root),
      USERPROFILE: path.dirname(plan.root),
      XDG_CONFIG_HOME: path.dirname(plan.root),
      XDG_CACHE_HOME: path.dirname(plan.root),
      XDG_DATA_HOME: path.dirname(plan.root),
    },
  );
  created = true;
  phase("private-directory");
  const pnpmBefore = hash(await readControllerToolFile(plan.pnpm));
  assert.equal((await command(plan.pnpm, ["--version"])).toString().trim(), nativePnpmVersion);
  phase("package-manager-version");
  await command(plan.pnpm, [
    "--dir",
    plan.source,
    "install",
    "--frozen-lockfile",
    "--ignore-scripts",
    "--ignore-pnpmfile",
    "--pm-on-fail=error",
    "--runtime-on-fail=error",
    "--package-import-method=copy",
    "--store-dir",
    path.join(plan.root, "store"),
    "--registry=https://registry.npmjs.org/",
    "--config.modules-dir=node_modules",
    "--config.virtual-store-dir=" + path.join(plan.source, "node_modules/.pnpm"),
    "--config.enable-global-virtual-store=false",
    "--config.node-linker=isolated",
    "--config.fetch-retries=0",
    "--config.fetch-timeout=15000",
    "--reporter=silent",
  ]);
  phase("frozen-install-complete");
  assert.equal(hash(await readControllerToolFile(plan.pnpm)), pnpmBefore);
  assert.deepEqual(
    await inspectWindowsNativeDependencyInputs(plan.source, deadline, active),
    plan.inputs,
  );
  phase("dependency-snapshot");
  const graph = await snapshotWindowsNativeDependencies(plan.source, deadline, active);
  phase("dependency-snapshot-complete");
  inventory();
  return {
    schema_version: 1,
    binding: plan.binding,
    inputs: plan.inputs,
    dependencies_prepared: true,
    entries: graph.entries,
    bytes: graph.bytes,
    graph_sha256: graph.sha256,
    progress: dependencyProgress,
    native_acceptance: "not-established",
    authority: "none",
  };
}

const attempts = new WeakSet<object>();
const sources = new WeakMap<
  object,
  {
    parent: object;
    tools: object;
    runtime: object;
    root: string;
    entries: readonly Entry[];
    harness: string;
    files: string[];
    custody: ReturnType<typeof inspectNativeRuntimeCustody>;
    system_custody: ReturnType<typeof inspectWindowsSourceSystemCustody>;
  }
>();

export async function requireActualHostedWindowsSource(receipt: object) {
  assertControllerBootstrapEnvironment();
  const source = sources.get(receipt);
  assert.ok(source, "original Windows source receipt required");
  try {
    const parent = await requireActualHostedNativeParentSource(source.parent);
    recheckWindowsSourceSystemCustody(source.system_custody);
    await verifiedControllerToolPaths(source.tools);
    assert.equal(
      (await requireHostedNativeRuntime(source.runtime, source.parent)).tools,
      source.tools,
      "source/runtime tools differ",
    );
    recheckNativeRuntimeCustody(source.files, source.custody);
    const active = () => {
      assertControllerBootstrapEnvironment();
      parent.recheck();
      checkCoordinatorDeadline();
      assert.ok(
        sources.get(receipt) === source && performance.now() < parent.deadline,
        "original Windows source stopped or expired",
      );
    };
    verifyWindowsNativeSourceFiles(source.root, source.entries, source.harness, active);
    active();
    recheckWindowsSourceSystemCustody(source.system_custody);
    active();
    return Object.freeze({
      root: source.root,
      parent: source.parent,
      runtime: source.runtime,
      tools: source.tools,
      deadline: parent.deadline,
      system_custody: new Map(source.system_custody),
    });
  } catch (error) {
    sources.delete(receipt);
    throw error;
  }
}

const dependencyAttempts = new WeakSet<object>();
const dependencies = new WeakMap<
  object,
  {
    source: object;
    parent: object;
    tools: object;
    runtime: object;
    sha256: string;
    inputs: Awaited<ReturnType<typeof inspectWindowsNativeDependencyInputs>>;
    files: string[];
    custody: ReturnType<typeof inspectNativeRuntimeCustody>;
  }
>();
/** Minimal original clock/parent read before a preparation phase hashes its graph. */
export async function requireActualHostedWindowsDependencyParent(receipt: object) {
  assertControllerBootstrapEnvironment();
  const retained = dependencies.get(receipt);
  assert.ok(retained, "original Windows dependencies required");
  const parent = await requireActualHostedNativeParentSource(retained.parent);
  assertControllerBootstrapEnvironment();
  parent.recheck();
  assert.equal(dependencies.get(receipt), retained, "original Windows dependencies stopped");
  return Object.freeze({ parent: retained.parent, deadline: parent.deadline });
}

export async function requireActualHostedWindowsDependencies(receipt: object) {
  assertControllerBootstrapEnvironment();
  const retained = dependencies.get(receipt);
  assert.ok(retained, "original Windows dependencies required");
  try {
    const source = await requireActualHostedWindowsSource(retained.source);
    assert.equal(source.parent, retained.parent);
    assert.equal(source.tools, retained.tools);
    assert.equal(source.runtime, retained.runtime);
    const parent = await requireActualHostedNativeParentSource(retained.parent);
    const deadline = Math.min(
      parent.deadline,
      performance.now() +
        coordinatorCommandTimeout(Math.max(1, Math.floor(parent.deadline - performance.now()))),
    );
    const active = () => {
      assertControllerBootstrapEnvironment();
      parent.recheck();
      checkCoordinatorDeadline();
      assert.ok(
        dependencies.get(receipt) === retained && performance.now() < parent.deadline,
        "original Windows dependencies stopped or expired",
      );
    };
    recheckNativeRuntimeCustody(retained.files, retained.custody);
    assert.deepEqual(
      await inspectWindowsNativeDependencyInputs(source.root, deadline, active),
      retained.inputs,
    );
    assert.equal(
      (await snapshotWindowsNativeDependencies(source.root, deadline, active)).sha256,
      retained.sha256,
      "Windows dependency graph changed",
    );
    recheckNativeRuntimeCustody(retained.files, retained.custody);
    await requireActualHostedWindowsSource(retained.source);
    active();
    return Object.freeze({ ...source, source: retained.source });
  } catch (error) {
    dependencies.delete(receipt);
    throw error;
  }
}
export function prepareActualHostedWindowsSource(parent: object, tools: object, runtime: object) {
  return prepareWindowsOperation(parent, tools, runtime);
}
export function prepareActualHostedWindowsDependencies(
  parent: object,
  tools: object,
  runtime: object,
  source: object,
) {
  assert.ok(source && typeof source === "object");
  return prepareWindowsOperation(parent, tools, runtime, source);
}

async function prepareWindowsOperation(
  parentReceipt: object,
  toolsReceipt: object,
  runtimeReceipt: object,
  sourceReceipt?: object,
) {
  const started = performance.now();
  assert.ok(process.platform === "win32" && process.arch === "x64");
  assertControllerBootstrapEnvironment();
  const parent = await requireActualHostedNativeParentSource(parentReceipt);
  const allowance = sourceReceipt ? hostedWindowsDependencyPreparationMilliseconds : 90000;
  const deadline = Math.min(
    started + allowance,
    parent.deadline - 210000,
    performance.now() + coordinatorCommandTimeout(allowance),
  );
  return withCoordinatorDeadline(deadline, async () => {
    const tools = await verifiedControllerToolPaths(toolsReceipt);
    assert.equal(parent.platform_label, "windows-x86_64");
    assert.equal(parent.configuration.purpose, "application");
    assert.equal(tools.platform, parent.platform_label);
    assert.equal(parent.stage, "payload-signing");
    for (const key of ["controller_revision", "controller_ref", "run_id", "run_attempt"] as const)
      assert.equal(tools.identity[key], parent.producer[key]);
    assert.equal(
      (await requireHostedNativeRuntime(runtimeReceipt, parentReceipt)).tools,
      toolsReceipt,
      "source/runtime tools differ",
    );
    const preparedSource = sourceReceipt
      ? await requireActualHostedWindowsSource(sourceReceipt)
      : undefined;
    if (preparedSource) {
      assert.equal(preparedSource.parent, parentReceipt);
      assert.equal(preparedSource.tools, toolsReceipt);
      assert.equal(preparedSource.runtime, runtimeReceipt);
    }
    const operation = preparedSource ? "dependencies" : "source",
      used = preparedSource ? dependencyAttempts : attempts;
    assert.ok(!used.has(parentReceipt), `one Windows ${operation} attempt; retain and recover`);
    used.add(parentReceipt);
    const active = () => {
      assertControllerBootstrapEnvironment();
      parent.recheck();
      assert.ok(performance.now() < deadline, `original Windows ${operation} allowance exhausted`);
    };
    active();
    const root = path.join(parent.directory, `windows-${operation}`),
      entry = path.join(tools.root, "scripts/release-hosted-native-windows-source.bundle.mjs"),
      setup = path.join(tools.root, "scripts/release-hosted-native-windows-setup.cs.txt");
    const selected = selectedHostedNativePlatform(parent.configuration, "windows-x86_64").producer;
    assert.equal(selected.harness.path, harness);
    const sourcePlan: Plan = {
      schema_version: 1,
      binding: hash(Buffer.from(JSON.stringify({ producer: parent.producer, selected }))),
      source_commit: selected.source_commit,
      source_tree: selected.source_tree,
      harness_sha256: selected.harness.sha256,
      root,
      setup,
      expires_at: Date.now() + Math.floor(deadline - performance.now()),
    };
    const plan: Plan | DependencyPlan = preparedSource
      ? {
          schema_version: 1,
          binding: sourcePlan.binding,
          root,
          setup,
          expires_at: sourcePlan.expires_at,
          source: preparedSource.root,
          pnpm: tools.pnpm,
          inputs: await inspectWindowsNativeDependencyInputs(preparedSource.root, deadline, active),
        }
      : sourcePlan;
    const planFile = path.join(parent.directory, `windows-${operation}-intent.json`);
    await writeFile(planFile, JSON.stringify(plan), { flag: "wx", mode: 0o600, flush: true });
    const files = [planFile, setup, entry, tools.node, ...(preparedSource ? [tools.pnpm] : [])],
      custody = inspectNativeRuntimeCustody(files);
    const systemCustody = inspectWindowsSourceSystemCustody();
    const observedGit = hash(await readControllerToolFile(git));
    const support = await hostedNativeSupportDependencies(
      runtimeReceipt,
      parentReceipt,
      parent.directory,
    );
    active();
    const stdout = openSync(
      path.join(parent.directory, `windows-${operation}.stdout.bin`),
      "wx",
      0o600,
    );
    let stderr: number;
    try {
      stderr = openSync(
        path.join(parent.directory, `windows-${operation}.stderr.bin`),
        "wx",
        0o600,
      );
    } catch (error) {
      closeSync(stdout);
      throw error;
    }
    const signal = new EventEmitter(),
      timer = setTimeout(() => signal.emit("SIGTERM"), Math.max(1, deadline - performance.now()));
    let failure: unknown;
    try {
      const status = await runResourceCommand(
        "analysis",
        tools.node,
        [entry, `acquire-${operation}`, planFile],
        {
          cwd: parent.directory,
          environment: {
            SystemRoot: "C:\\Windows",
            PATH: path.dirname(tools.node) + ";C:\\Windows\\System32",
            TEMP: parent.directory,
            TMP: parent.directory,
          },
          queueDeadline: deadline,
          executionTimeoutMilliseconds: Math.floor(deadline - performance.now()),
          output: { stdout, stderr },
          supervise: (args, options) =>
            runRustTests(args, {
              ...options,
              ...support,
              tempRoot: parent.directory,
              signalTarget: signal,
              spawn: (command, childArgs, childOptions) => {
                active();
                recheckNativeRuntimeCustody(files, custody);
                recheckWindowsSourceSystemCustody(systemCustody);
                active();
                const child = spawn(command, [...childArgs], {
                  ...childOptions,
                  stdio: ["pipe", "pipe", "pipe"],
                });
                for (const [stream, descriptor, maximum] of [
                  [child.stdout, stdout, 65536],
                  [child.stderr, stderr, 8192],
                ] as const) {
                  let retained = 0;
                  stream.on("data", (bytes: Buffer) => {
                    try {
                      const available = Math.max(0, maximum - retained);
                      if (available) writeSync(descriptor, bytes.subarray(0, available));
                      retained += bytes.length;
                      assert.ok(retained <= maximum);
                    } catch (error) {
                      failure ??= error;
                      signal.emit("SIGTERM");
                    }
                  });
                }
                return child;
              },
            }),
        },
      );
      active();
      assert.equal(failure, undefined);
      assert.equal(status, 0, `Windows ${operation} refused; retain state, no automatic retry`);
    } finally {
      clearTimeout(timer);
      closeSync(stdout);
      closeSync(stderr);
    }
    const report: unknown = JSON.parse(
      (
        await readNativeCapturedStream(parent.directory, `windows-${operation}.stdout.bin`)
      ).toString("utf8"),
    );
    if (preparedSource && sourceReceipt && "inputs" in plan) {
      assert.ok(
        isRecord(report) &&
          report.binding === plan.binding &&
          report.dependencies_prepared === true &&
          report.authority === "none" &&
          report.native_acceptance === "not-established",
      );
      assert.deepEqual(report.inputs, plan.inputs);
      const graph = await snapshotWindowsNativeDependencies(preparedSource.root, deadline, active);
      assert.equal(graph.sha256, report.graph_sha256);
      assert.equal(graph.entries, report.entries);
      assert.equal(graph.bytes, report.bytes);
      recheckNativeRuntimeCustody(files, custody);
      recheckWindowsSourceSystemCustody(systemCustody);
      await requireActualHostedWindowsSource(sourceReceipt);
      active();
      const receipt = Object.freeze({
        kind: "original-hosted-windows-dependencies",
        authority: "none",
      });
      dependencies.set(receipt, {
        source: sourceReceipt,
        parent: parentReceipt,
        tools: toolsReceipt,
        runtime: runtimeReceipt,
        sha256: graph.sha256,
        inputs: plan.inputs,
        files,
        custody,
      });
      return receipt;
    }
    assert.ok(!preparedSource && "source_commit" in plan);
    assert.ok(
      isRecord(report) &&
        report.binding === plan.binding &&
        report.source_commit === plan.source_commit &&
        report.source_tree === plan.source_tree &&
        report.acquired === true &&
        report.dependencies_prepared === false &&
        report.authority === "none" &&
        report.native_acceptance === "not-established",
    );
    const tree = await readControllerToolFile(path.join(root, "tree.bin"), 4 * 1024 ** 2);
    assert.equal(hash(tree), report.tree_inventory_sha256);
    const entries = inspectWindowsNativeSourceTree(tree),
      sourceRoot = path.join(root, "source");
    verifyWindowsNativeSourceFiles(sourceRoot, entries, plan.harness_sha256, active);
    recheckNativeRuntimeCustody(files, custody);
    recheckWindowsSourceSystemCustody(systemCustody);
    assert.equal(hash(await readControllerToolFile(git)), observedGit);
    await requireHostedNativeRuntime(runtimeReceipt, parentReceipt);
    await requireActualHostedNativeParentSource(parentReceipt);
    active();
    const sourceFiles = [
        planFile,
        path.join(root, "tree.bin"),
        path.join(sourceRoot, ...harness.split("/")),
      ],
      sourceCustody = inspectNativeRuntimeCustody(sourceFiles);
    active();
    const receipt = Object.freeze({ kind: "original-hosted-windows-source", authority: "none" });
    sources.set(receipt, {
      system_custody: systemCustody,
      parent: parentReceipt,
      tools: toolsReceipt,
      runtime: runtimeReceipt,
      root: sourceRoot,
      entries,
      harness: plan.harness_sha256,
      files: sourceFiles,
      custody: sourceCustody,
    });
    return receipt;
  });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  assert.equal(process.argv.length, 4);
  assert.ok(["acquire-source", "acquire-dependencies"].includes(process.argv[2]!));
  const acquire = process.argv[2] === "acquire-source" ? acquireSource : acquireDependencies;
  acquire(process.argv[3]!)
    .then((result) => process.stdout.write(JSON.stringify(result) + "\n"))
    .catch((error: unknown) => {
      writeSync(
        1,
        JSON.stringify({
          stage:
            process.argv[2] === "acquire-source"
              ? "Windows source acquisition"
              : "Windows dependency preparation",
          failure: (error instanceof Error ? error.message : String(error)).slice(0, 2048),
          diagnostic: error instanceof Error && "diagnostic" in error ? error.diagnostic : null,
          progress: dependencyProgress,
          automatic_retry: false,
          authority: "none",
        }) + "\n",
      );
      writeSync(2, "Windows preparation refused; retain stdout failure record and partial state\n");
      process.exit(1);
    });
}
