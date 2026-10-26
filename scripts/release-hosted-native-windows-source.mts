/** Held source preparation only. Public observations cannot mint an original
 * parent, runtime or source receipt; no account or native candidate is executed. */
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
} from "./release-native-runtime-custody.mts";
import { runResourceCommand } from "./resource-command.mts";
import { runRustTests } from "./run-rust-tests.mts";
import { readNativeCapturedStream } from "./release-native-capture-files.mts";
import { assertControllerBootstrapEnvironment } from "./release-controller-job-bootstrap.mts";
import { isRecord } from "./runtime-values.mts";

const git = "C:\\Program Files\\Git\\cmd\\git.exe";
const powershell = "C:\\Program Files\\PowerShell\\7\\pwsh.exe";
const harness = "apps/desktop/scripts/desktop-test.mts";
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
  const inventory = () => {
    active();
    if (!inventoryEnabled) return;
    let count = 0,
      bytes = 0;
    const pending = [plan.root];
    while (pending.length) {
      active();
      for (const item of readdirSync(pending.pop()!, { withFileTypes: true })) {
        const filename = path.join(item.parentPath, item.name),
          stat = lstatSync(filename);
        assert.ok(++count <= 32768 && !stat.isSymbolicLink());
        bytes += stat.size;
        assert.ok(
          bytes <= 512 * 1024 ** 2 && (stat.isDirectory() || (stat.isFile() && stat.nlink === 1)),
        );
        if (stat.isDirectory()) pending.push(filename);
      }
    }
  };
  const command = async (
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
        cwd: path.dirname(plan.root),
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
          inventory();
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
  }
>();

export async function requireActualHostedWindowsSource(receipt: object) {
  assertControllerBootstrapEnvironment();
  const source = sources.get(receipt);
  assert.ok(source, "original Windows source receipt required");
  try {
    const parent = await requireActualHostedNativeParentSource(source.parent);
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
      assert.ok(
        sources.get(receipt) === source && performance.now() < parent.deadline,
        "original Windows source stopped or expired",
      );
    };
    verifyWindowsNativeSourceFiles(source.root, source.entries, source.harness, active);
    active();
    return Object.freeze({
      root: source.root,
      parent: source.parent,
      runtime: source.runtime,
      tools: source.tools,
      deadline: parent.deadline,
    });
  } catch (error) {
    sources.delete(receipt);
    throw error;
  }
}

export async function prepareActualHostedWindowsSource(
  parentReceipt: object,
  toolsReceipt: object,
  runtimeReceipt: object,
) {
  assert.ok(process.platform === "win32" && process.arch === "x64");
  assertControllerBootstrapEnvironment();
  const parent = await requireActualHostedNativeParentSource(parentReceipt);
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
  assert.ok(!attempts.has(parentReceipt), "one Windows source attempt; retain and recover");
  attempts.add(parentReceipt);
  const deadline = Math.min(performance.now() + 90000, parent.deadline - 210000);
  const active = () => {
    assertControllerBootstrapEnvironment();
    parent.recheck();
    assert.ok(performance.now() < deadline, "original Windows source allowance exhausted");
  };
  active();
  const root = path.join(parent.directory, "windows-source"),
    entry = path.join(tools.root, "scripts/release-hosted-native-windows-source.bundle.mjs"),
    setup = path.join(tools.root, "scripts/release-hosted-native-windows-setup.cs.txt");
  const selected = parent.configuration.hosted_native["windows-x86_64"].producer;
  assert.equal(selected.harness.path, harness);
  const plan: Plan = {
    schema_version: 1,
    binding: hash(Buffer.from(JSON.stringify({ producer: parent.producer, selected }))),
    source_commit: selected.source_commit,
    source_tree: selected.source_tree,
    harness_sha256: selected.harness.sha256,
    root,
    setup,
    expires_at: Date.now() + Math.floor(deadline - performance.now()),
  };
  const planFile = path.join(parent.directory, "windows-source-intent.json");
  await writeFile(planFile, JSON.stringify(plan), { flag: "wx", mode: 0o600, flush: true });
  const files = [planFile, git, powershell, setup, entry, tools.node],
    custody = inspectNativeRuntimeCustody(files);
  const observedGit = hash(await readControllerToolFile(git));
  const support = await hostedNativeSupportDependencies(
    runtimeReceipt,
    parentReceipt,
    parent.directory,
  );
  active();
  const stdout = openSync(path.join(parent.directory, "windows-source.stdout.bin"), "wx", 0o600);
  let stderr: number;
  try {
    stderr = openSync(path.join(parent.directory, "windows-source.stderr.bin"), "wx", 0o600);
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
      [entry, "acquire-source", planFile],
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
    assert.equal(status, 0, "Windows source refused; retain state, no automatic retry");
  } finally {
    clearTimeout(timer);
    closeSync(stdout);
    closeSync(stderr);
  }
  const report: unknown = JSON.parse(
    (await readNativeCapturedStream(parent.directory, "windows-source.stdout.bin")).toString(
      "utf8",
    ),
  );
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
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  assert.equal(process.argv.length, 4);
  assert.equal(process.argv[2], "acquire-source");
  acquireSource(process.argv[3]!)
    .then((result) => process.stdout.write(JSON.stringify(result) + "\n"))
    .catch((error: unknown) => {
      writeSync(
        1,
        JSON.stringify({
          stage: "Windows source acquisition",
          failure: (error instanceof Error ? error.message : String(error)).slice(0, 2048),
          diagnostic: error instanceof Error && "diagnostic" in error ? error.diagnostic : null,
          automatic_retry: false,
          authority: "none",
        }) + "\n",
      );
      writeSync(
        2,
        "Windows source acquisition refused; retain stdout failure record and partial state\n",
      );
      process.exit(1);
    });
}
