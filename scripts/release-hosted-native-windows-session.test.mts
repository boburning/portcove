import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import os from "node:os";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import test from "node:test";
import { readFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import { runInNewContext } from "node:vm";
import { EventEmitter } from "node:events";
import path from "node:path";
import { isRecord } from "./runtime-values.mts";
import {
  windowsOwnerFiletime,
  windowsOwnerEnvironment,
} from "./release-windows-owner-mechanism.mts";

const source = readFileSync(
  new URL("./release-hosted-native-windows-session.mts", import.meta.url),
  "utf8",
);
function body(begin: string, end: string, text = source) {
  const start = text.indexOf(begin),
    stop = text.indexOf(end, start + begin.length);
  assert.ok(start >= 0 && stop > start, "Actual private implementation boundary required");
  return stripTypeScriptTypes(text.slice(start, stop).replace(/^export /gmu, ""));
}
const spawnBody = body(
  "export function captureWindowsOwnerSupervisor(",
  "/** End of shared owner supervisor mechanics. */",
  readFileSync(new URL("./release-windows-owner-mechanism.mts", import.meta.url), "utf8"),
);
const terminalBody = body(
  "async function recheckTerminalSettlement(",
  "export async function prepareActualHostedWindowsPreSignStage",
);
void test("supervisor callback returns its child to cleanup ownership before fallible identity observation", async () => {
  const child = Object.assign(new EventEmitter(), {
    pid: 42,
    stdout: new EventEmitter(),
    stderr: new EventEmitter(),
  });
  let identities = 0,
    spawns = 0,
    retained = 0,
    signals = 0;
  const state: { supervisor?: unknown; error?: unknown; signal: EventEmitter } = {
    signal: new EventEmitter(),
  };
  state.signal.on("SIGTERM", () => {
    signals++;
    child.emit("close", 143);
  });
  const create = runInNewContext(spawnBody + ";captureWindowsOwnerSupervisor", {
    assert,
    spawn: () => {
      spawns++;
      return child;
    },
    writeSync: (_fd: number, bytes: Buffer) => {
      retained += bytes.length;
    },
    readProcessIdentity: () => {
      identities++;
      throw new Error("identity refused");
    },
  }) as (
    state: unknown,
    files: number[],
  ) => (command: string, args: string[], options: unknown) => typeof child;
  const callback = create(state, [10, 11]);
  assert.equal(callback("original-prepared-supervisor", [], {}), child);
  assert.equal(identities, 0);
  assert.ok(isRecord(state.supervisor) && state.supervisor.pid === 42);
  // Existing runRustTests can now own close before any later identity refusal.
  let closed = false,
    released = false;
  const close = new Promise<void>((resolve) =>
    child.once("close", () => {
      closed = true;
      resolve();
    }),
  );
  assert.throws(() => callback("second", [], {}));
  assert.equal(spawns, 1);
  child.stderr.emit("data", Buffer.alloc(65537));
  assert.equal(retained, 65536);
  assert.ok(state.error);
  assert.equal(signals, 1);
  await close;
  released = true;
  assert.ok(closed && released);
});

void test("actual final settlement refuses late role or custody changes after independent account readback", async () => {
  for (const scenario of ["success", "late", "role", "custody", "live-owner", "cloned"]) {
    let clock = 10,
      role = true,
      drift = false,
      recovered = 0,
      readbacks = 0;
    const receipt = {},
      pre = {},
      post = {},
      dependencies = {},
      runtime = {};
    const state = {
      phase: "finished",
      stopped: false,
      status: undefined as number | undefined,
      error: undefined,
      deadline: 1000,
      parent: { recheck: () => assert.ok(role && clock < 1000) },
      prepared: { dependencies, runtime, parent: pre },
      postParent: post,
      owner: { pid: 42, created: "1" },
      root: "C:\\owned-session",
      binding: "a".repeat(64),
      files: [],
      custody: new Map(),
      running: Promise.resolve(0),
    };
    const sessions = new WeakMap<object, typeof state>([[receipt, state]]);
    const parents = new WeakSet([pre, post]);
    const finish = runInNewContext(terminalBody + ";finishActualHostedWindowsSession", {
      assert,
      path,
      Buffer,
      isRecord,
      sessions,
      performance: { now: () => clock },
      assertControllerBootstrapEnvironment: () => assert.ok(role, "Original role revoked"),
      recheckNativeRuntimeCustody: () => assert.ok(!drift, "Original custody changed"),
      requireActualHostedWindowsDependencies: async (value: unknown) =>
        assert.equal(value, dependencies),
      requireHostedNativeRuntime: async (value: unknown, parent: unknown) => {
        assert.equal(value, runtime);
        assert.ok(parents.has(parent as object));
        return { deadline: 1000 };
      },
      requireActualHostedNativeParentSource: async (value: object) => assert.ok(parents.has(value)),
      readProcessIdentity: () => (scenario === "live-owner" ? "original-owner" : null),
      filetime: () => "1",
      recheck: async () => assert.ok(!state.stopped && state.status === undefined),
      writeRequest: () => {
        state.status = 0;
      },
      readControllerToolFile: async () =>
        Buffer.from(
          JSON.stringify({
            binding: state.binding,
            owner_pid: 42,
            owner_created_filetime: "1",
            failure: "",
            cleanup_failures: [],
            credential_disposed: true,
          }),
        ),
      inspectOriginalHostedWindowsAccount: async () => {
        readbacks++;
        if (scenario === "late") clock = 1001;
        if (scenario === "role") role = false;
        if (scenario === "custody") drift = true;
      },
      failSession: async () => {
        recovered++;
        state.stopped = true;
      },
    }) as (receipt: object) => Promise<{ authority: string; deadline: number }>;
    if (scenario === "success") {
      const value = await finish(receipt);
      assert.equal(value.authority, "none");
      assert.equal(value.deadline, state.deadline);
      assert.equal(readbacks, 1);
      assert.equal(recovered, 0);
    } else {
      await assert.rejects(finish(scenario === "cloned" ? { ...receipt } : receipt));
      assert.equal(recovered, scenario === "cloned" ? 0 : 1);
    }
  }
});

void test("shared Windows owner mechanics preserve generation identity and a credential-free environment", () => {
  assert.equal(windowsOwnerFiletime("win32:42:504911232000000123", 42), "123");
  for (const identity of [
    null,
    "win32:43:504911232000000123",
    "win32:42:504911232000000000",
    "linux:42:123",
  ])
    assert.throws(() => windowsOwnerFiletime(identity, 42));
  const source = {
    SystemRoot: "C:\\Windows",
    GITHUB_ACTIONS: "true",
    RUNNER_ENVIRONMENT: "github-hosted",
    GITHUB_REPOSITORY: "boburning/portcove",
    GITHUB_JOB: "native_windows",
    GITHUB_WORKFLOW_REF: "fixed-held-production-route",
    GITHUB_RUN_ID: "123",
    GITHUB_RUN_ATTEMPT: "1",
    GH_TOKEN: "inert-never-copy",
    TAURI_SIGNING_PRIVATE_KEY: "inert-never-copy",
  };
  const actual = windowsOwnerEnvironment("C:\\owned", source);
  assert.equal(actual.SystemDrive, "C:");
  assert.equal(actual.PATH, "C:\\Windows\\System32");
  assert.equal(actual.GH_TOKEN, undefined);
  assert.equal(actual.TAURI_SIGNING_PRIVATE_KEY, undefined);
  assert.equal(actual.USERPROFILE, "C:\\owned");
  assert.equal(actual.GITHUB_WORKFLOW_REF, source.GITHUB_WORKFLOW_REF);
  assert.deepEqual(
    Object.keys(actual).sort(),
    [
      "SystemRoot",
      "WINDIR",
      "SystemDrive",
      "PATH",
      "PATHEXT",
      "USERPROFILE",
      "HOME",
      "TEMP",
      "TMP",
      "GITHUB_ACTIONS",
      "RUNNER_ENVIRONMENT",
      "GITHUB_REPOSITORY",
      "GITHUB_JOB",
      "GITHUB_WORKFLOW_REF",
      "GITHUB_RUN_ID",
      "GITHUB_RUN_ATTEMPT",
    ].sort(),
  );
  assert.throws(() =>
    windowsOwnerEnvironment("C:\\owned", { ...source, GITHUB_RUN_ID: undefined }),
  );
});

void test("shared Windows owner framing preserves byte and original deadline bounds before invoking the OS", () => {
  const mechanism = readFileSync(
    new URL("./release-windows-owner-mechanism.mts", import.meta.url),
    "utf8",
  );
  const frame = body(
    "export function writeWindowsOwnerFrame(",
    "export function captureWindowsOwnerSupervisor(",
    mechanism,
  );
  let effects = 0;
  const calls: unknown[][] = [];
  const write = runInNewContext(frame + ";writeWindowsOwnerFrame", {
    assert,
    Buffer,
    performance: { now: () => 10 },
    execFileSync: (...args: unknown[]) => {
      effects++;
      calls.push(args);
    },
  }) as (file: string, wire: Record<string, unknown>, options: unknown) => void;
  const options = {
    root: "C:\\owned",
    deadline: 100,
    powershell: "fixed-system-powershell",
    environment: { fixed: "closed" },
  };
  assert.throws(() => write("C:\\owned\\request.json", {}, { ...options, deadline: 10 }));
  assert.throws(() => write("C:\\owned\\request.json", { oversized: "x".repeat(16384) }, options));
  assert.equal(effects, 0);
  write("C:\\owned\\request.json", { binding: "a".repeat(64), sequence: 1 }, options);
  assert.equal(effects, 1);
  const call = calls[0];
  assert.ok(call && Array.isArray(call[1]) && isRecord(call[2]));
  assert.equal(call[0], "fixed-system-powershell");
  assert.equal(call[2].timeout, 90);
  assert.equal(call[2].maxBuffer, 16384);
  const script = Buffer.from(String(call[1].at(-1)), "base64").toString("utf16le");
  assert.match(script, /FileMode\]::CreateNew/u);
  assert.match(script, /FileShare\]::None/u);
  assert.match(script, /Flush\(\$true\)/u);
});

void test("production owner remains held and scoped diagnostic wrappers refuse before context, storage or OS effects", () => {
  for (const [name, message] of [
    [
      "release-hosted-native-windows-owner.ps1",
      "Hosted persistent session awaits separate owner authority",
    ],
    [
      "release-hosted-native-windows-diagnostic-owner.ps1",
      "Fixed hosted Windows diagnostic owner context required",
    ],
  ] as const) {
    const result = spawnSync(
      "pwsh",
      [
        "-NoProfile",
        "-NonInteractive",
        "-File",
        fileURLToPath(new URL(name, import.meta.url)),
        "-ContextBase64",
        "deliberately invalid",
      ],
      { encoding: "utf8", timeout: 15000, maxBuffer: 16384 },
    );
    assert.notEqual(result.status, 0);
    assert.ok(result.stderr.includes(String(message)), result.stderr);
  }
  for (const diagnostic of [false, true]) {
    const recovery = spawnSync(
      "pwsh",
      [
        "-NoProfile",
        "-NonInteractive",
        "-File",
        fileURLToPath(new URL("./release-hosted-native-windows-recovery.ps1", import.meta.url)),
        "-Context",
        "unreadable-untrusted-path",
        "-ExpectedSha256",
        "a".repeat(64),
        ...(diagnostic ? ["-Diagnostic"] : []),
      ],
      { encoding: "utf8", timeout: 15000, maxBuffer: 16384 },
    );
    assert.notEqual(recovery.status, 0);
    assert.ok(
      recovery.stderr.includes(
        diagnostic
          ? "Fixed hosted Windows diagnostic recovery context required"
          : "Hosted original-session recovery awaits",
      ),
      recovery.stderr,
    );
  }
  const direct = spawnSync(
    "pwsh",
    [
      "-NoProfile",
      "-NonInteractive",
      "-File",
      fileURLToPath(
        new URL("./release-hosted-native-windows-owner-mechanism.ps1", import.meta.url),
      ),
      "-ContextBase64",
      "invalid",
      "-OwnerProfile",
      "Diagnostic",
      "-OwnerScriptsRoot",
      "unused",
    ],
    { encoding: "utf8", timeout: 15000, maxBuffer: 16384 },
  );
  assert.notEqual(direct.status, 0);
  assert.match(direct.stderr, /Source-gated owner wrapper required/u);
});

void test("owner wrapper authenticates bounded original mechanism bytes before evaluating its inert body", async (context) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "pc-owner-mechanism-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const scripts = path.join(root, "scripts");
  await mkdir(scripts);
  const wrapper = path.join(scripts, "owner.ps1"),
    mechanism = path.join(scripts, "release-hosted-native-windows-owner-mechanism.ps1");
  const actual = await readFile(
    new URL("./release-hosted-native-windows-diagnostic-owner.ps1", import.meta.url),
    "utf8",
  );
  await writeFile(wrapper, actual.replace("-not $IsWindows", "-not $true"));
  const body =
    "param([string]$ContextBase64,[string]$OwnerProfile,[string]$OwnerScriptsRoot)\n@{marker='inert-mechanism-only';profile=$OwnerProfile;root=$OwnerScriptsRoot}|ConvertTo-Json -Compress\n";
  await writeFile(mechanism, body);
  await writeFile(
    path.join(root, "manifest.json"),
    JSON.stringify({
      files: [
        {
          path: "scripts/release-hosted-native-windows-owner-mechanism.ps1",
          bytes: Buffer.byteLength(body),
          sha256: createHash("sha256").update(body).digest("hex"),
        },
      ],
    }),
  );
  const encoded = Buffer.from(JSON.stringify({ tools_root: root })).toString("base64");
  const invoke = () =>
    spawnSync(
      "pwsh",
      ["-NoProfile", "-NonInteractive", "-File", wrapper, "-ContextBase64", encoded],
      {
        encoding: "utf8",
        timeout: 15000,
        maxBuffer: 16384,
        env: {
          ...process.env,
          GITHUB_ACTIONS: "true",
          RUNNER_ENVIRONMENT: "github-hosted",
          GITHUB_REPOSITORY: "boburning/portcove",
          GITHUB_JOB: "installed-prerequisite",
          GITHUB_EVENT_NAME: "workflow_dispatch",
          GITHUB_RUN_ATTEMPT: "1",
          GITHUB_SHA: "a".repeat(40),
          GITHUB_RUN_ID: "123",
          GITHUB_WORKFLOW_REF:
            "boburning/portcove/.github/workflows/hosted-native-continuity.yml@refs/heads/feature/534-connected-native-node-canary-20261028",
        },
      },
    );
  const valid = invoke();
  assert.equal(valid.status, 0, valid.stderr);
  const evaluated: unknown = JSON.parse(valid.stdout);
  assert.ok(isRecord(evaluated));
  assert.equal(evaluated.marker, "inert-mechanism-only");
  assert.equal(evaluated.profile, "Diagnostic");
  await writeFile(mechanism, body.replace("inert-mechanism-only", "other-mechanism-only"));
  const changed = invoke();
  assert.notEqual(changed.status, 0);
  assert.match(changed.stderr, /Original owner mechanism source differs/u);
  assert.ok(!changed.stdout.includes("mechanism-only"));
  await writeFile(mechanism, "x".repeat(131073));
  const oversized = invoke();
  assert.notEqual(oversized.status, 0);
  assert.match(oversized.stderr, /Owner wrapper input exceeds bound/u);
});

void test("diagnostic worker selection cannot enable production or read an arbitrary input before its fresh gate", async () => {
  const {
    readHostedWindowsWorkerAbi,
    readHostedWindowsDiagnosticWorkerAbi,
    runHostedWindowsWorkerStage,
    runHostedWindowsDiagnosticWorkerStage,
  } = await import("./release-hosted-native-windows-worker.mts");
  assert.equal(readHostedWindowsWorkerAbi().execution_authorized, false);
  assert.equal(readHostedWindowsDiagnosticWorkerAbi().execution_authorized, true);
  assert.equal(readHostedWindowsDiagnosticWorkerAbi().authority, "none");
  await assert.rejects(
    runHostedWindowsWorkerStage("unreadable-untrusted-path", "invalid"),
    /held hosted worker execution awaits separate authority/u,
  );
  await assert.rejects(
    runHostedWindowsDiagnosticWorkerStage("unreadable-untrusted-path", "invalid", "wrong-ref"),
    /Fixed diagnostic worker workflow ref required/u,
  );
  const entry = fileURLToPath(new URL("./release-native-worker.mts", import.meta.url));
  const abi = spawnSync(process.execPath, [entry, "--hosted-windows-diagnostic-abi"], {
    encoding: "utf8",
    timeout: 15000,
    maxBuffer: 16384,
  });
  assert.equal(abi.status, 0, abi.stderr);
  const observation: unknown = JSON.parse(abi.stdout);
  assert.ok(isRecord(observation));
  assert.equal(observation.execution_authorized, true);
  const refused = spawnSync(
    process.execPath,
    [entry, "--hosted-windows-diagnostic-stage", "unreadable-untrusted-path", "a".repeat(64)],
    { encoding: "utf8", timeout: 15000, maxBuffer: 16384 },
  );
  assert.notEqual(refused.status, 0);
  assert.match(refused.stderr, /fixed hosted stage requires bounded input/u);
});

void test("diagnostic provider budget uses one bounded public current-job read and refuses stale or foreign authority data", async () => {
  const { readOrdinaryHostedWindowsDiagnosticDeadline } =
    await import("./release-hosted-native-windows-diagnostic-source.mts");
  const source = "a".repeat(40),
    context = { source, run_id: "123", attempt: "1" };
  const job = () => ({
    id: 17,
    name: "installed-prerequisite",
    head_sha: source,
    run_id: 123,
    run_attempt: 1,
    status: "in_progress",
    conclusion: null,
    started_at: new Date(Date.now() - 60000).toISOString(),
    labels: ["windows-2022"],
  });
  let calls = 0;
  const valid: typeof fetch = async (input, options) => {
    calls++;
    assert.equal(
      typeof input === "string" ? input : input instanceof URL ? input.href : input.url,
      "https://api.github.com/repos/boburning/portcove/actions/runs/123/attempts/1/jobs?per_page=1&page=1",
    );
    assert.equal(options?.redirect, "error");
    const headers = new Headers(options?.headers);
    assert.equal(headers.get("authorization"), null);
    return new Response(JSON.stringify({ total_count: 1, jobs: [job()] }), {
      status: 200,
      headers: { date: new Date().toUTCString() },
    });
  };
  const budget = await readOrdinaryHostedWindowsDiagnosticDeadline(context, valid);
  assert.equal(calls, 1);
  assert.equal(budget.authority, "none");
  assert.equal(budget.maximum_owner_milliseconds, 570000);
  assert.equal(budget.cleanup_reserve_milliseconds, 30000);
  assert.equal(budget.provider_finalizer_margin_milliseconds, 60000);
  for (const scenario of [
    "refused",
    "foreign-source",
    "partial-jobs",
    "completed",
    "wrong-attempt",
    "wrong-runner",
    "future-date",
    "stale-cache",
    "insufficient",
    "declared-size",
    "actual-size",
    "interrupted",
  ]) {
    const transport: typeof fetch = async () => {
      if (scenario === "interrupted") throw new Error("controlled provider interruption");
      const row = job();
      if (scenario === "foreign-source") row.head_sha = "b".repeat(40);
      if (scenario === "completed") row.status = "completed";
      if (scenario === "wrong-attempt") row.run_attempt = 2;
      if (scenario === "wrong-runner") row.labels = ["larger-paid-runner"];
      if (scenario === "insufficient")
        row.started_at = new Date(Date.now() - 89 * 60000).toISOString();
      const headers = new Headers({
        date: new Date(Date.now() + (scenario === "future-date" ? 120000 : 0)).toUTCString(),
      });
      if (scenario === "stale-cache") headers.set("age", "31");
      if (scenario === "declared-size") headers.set("content-length", "65537");
      const body =
        scenario === "actual-size"
          ? "x".repeat(65537)
          : JSON.stringify({ total_count: scenario === "partial-jobs" ? 2 : 1, jobs: [row] });
      return new Response(body, { status: scenario === "refused" ? 403 : 200, headers });
    };
    await assert.rejects(readOrdinaryHostedWindowsDiagnosticDeadline(context, transport), scenario);
  }
});

void test("fixed diagnostic acquisition reuses signature verification and refuses changed source, private keys or substituted bytes", async () => {
  const implementation = readFileSync(
    new URL("./release-hosted-native-windows-diagnostic-source.mts", import.meta.url),
    "utf8",
  );
  const code = body(
    "export function requireOriginalHostedWindowsDiagnosticContext()",
    "export const hostedWindowsDiagnosticOwnerMilliseconds",
    implementation,
  );
  for (const scenario of [
    "success",
    "foreign-source",
    "dirty-source",
    "private-key",
    "wrong-version",
    "signature",
    "changed-bytes",
    "changed-receipt",
    "foreign-file",
    "wrong-repository",
    "local-runner",
    "observer-only",
  ]) {
    const project = path.resolve("/fixed-diagnostic-source"),
      source = "a".repeat(40),
      tree = "b".repeat(40),
      versions = ["1.0.0-rc.2", "1.0.0"];
    const result = {
      source_commit: source,
      platform: "windows-x86_64",
      status: "passed",
      transition_profile: "preview-final",
      production_signing: false,
      fixture_versions: versions,
    };
    if (scenario === "foreign-source") result.source_commit = "c".repeat(40);
    if (scenario === "wrong-version") result.fixture_versions = ["1.0.0-rc.1", "1.0.0"];
    const bytes = (file: string) =>
      Buffer.from(
        JSON.stringify(
          file.endsWith("rehearsal-result.json")
            ? result
            : file.endsWith("-native.json")
              ? {
                  source_commit: source,
                  platform: "windows-x86_64",
                  version: versions.find((v) => file.endsWith(`${v}-native.json`)),
                  signing: "disposable test key",
                  process_architecture: "X64",
                }
              : { inert: file },
        ),
      );
    let inputReads = 0;
    let verifications = 0,
      mutated = false;
    const read = async (filename: string) => {
      inputReads++;
      return scenario === "changed-receipt" && mutated && filename.endsWith("windows-runtime.json")
        ? Buffer.from("changed")
        : bytes(filename);
    };
    const identities = new Map<string, number>();
    const acquire = runInNewContext(code + ";readOriginalHostedWindowsDiagnosticInputs", {
      assert,
      Buffer,
      JSON,
      Map,
      path,
      project,
      diagnosticVersions: versions,
      hostedWindowsDiagnosticWorkflowRef:
        "boburning/portcove/.github/workflows/hosted-native-continuity.yml@refs/heads/feature/534-connected-native-node-canary-20261028",
      isRecord,
      performance,
      digest: (b: Buffer) => createHash("sha256").update(b).digest("hex"),
      process: {
        platform: "win32",
        arch: "x64",
        env: {
          GITHUB_SHA: source,
          GITHUB_ACTIONS: "true",
          RUNNER_ENVIRONMENT: scenario === "local-runner" ? "self-hosted" : "github-hosted",
          GITHUB_REPOSITORY:
            scenario === "wrong-repository" ? "other/portcove" : "boburning/portcove",
          PORTCOVE_HOSTED_PLATFORM: "windows-x86_64",
          PORTCOVE_HOSTED_CONNECTED_DIAGNOSTIC: "true",
          PORTCOVE_HOSTED_OBSERVATION_ONLY: scenario === "observer-only" ? "true" : "false",
          GITHUB_EVENT_NAME: "workflow_dispatch",
          GITHUB_JOB: "installed-prerequisite",
          GITHUB_RUN_ATTEMPT: "1",
          GITHUB_RUN_ID: "123",
          GITHUB_WORKFLOW_REF:
            "boburning/portcove/.github/workflows/hosted-native-continuity.yml@refs/heads/feature/534-connected-native-node-canary-20261028",
        },
      },
      windowsSourceSystemExecutables: { git: "fixed-git" },
      execFileSync: (exe: string, args: string[]) => {
        assert.equal(exe, "fixed-git");
        if (args[0] === "diff") {
          if (scenario === "dirty-source") throw Error("dirty");
          return "";
        }
        return args.includes("--show-toplevel")
          ? project
          : args.includes("HEAD^{tree}")
            ? tree
            : source;
      },
      lstat: async () => {
        if (scenario === "private-key") return {};
        throw Object.assign(Error("absent"), { code: "ENOENT" });
      },
      readControllerToolFile: read,
      readdir: async () => [scenario === "foreign-file" ? "../candidate.exe" : "candidate.exe"],
      hashNativeCapturedFile: async (_root: string, name: string) => {
        const n = (identities.get(name) ?? 0) + 1;
        identities.set(name, n);
        const b = bytes(path.join(project, name));
        return {
          path: name,
          bytes: b.length,
          sha256:
            scenario === "changed-bytes" && n > 1 && name.endsWith("candidate.exe")
              ? "f".repeat(64)
              : createHash("sha256").update(b).digest("hex"),
        };
      },
      inspectSupportedHostedWindowsRuntimeInput: () => ({ observed: "156.0.4314.50" }),
      fixtureMetadata: [
        "Cargo.toml",
        "Cargo.lock",
        "apps/desktop/package.json",
        "apps/desktop/src-tauri/tauri.conf.json",
      ],
      inspectDiagnosticFixtureDerivation: () => ({ authority: "none" }),
      readOriginalDiagnosticDrivers: async (version: string) => {
        assert.equal(version, "156.0.4314.50");
        return { files: [], custody: new Map() };
      },
      inspectNativeRuntimeCustody: () => new Map(),
      recheckNativeRuntimeCustody: () => {},
      verifyUpdaterInventory: async (options: {
        input: string;
        version: string;
        publicKey: string;
        revision: string;
        verifier: string;
        verifySignature?: unknown;
      }) => {
        verifications++;
        assert.equal(options.verifySignature, undefined);
        assert.equal(options.revision, source);
        assert.equal(
          options.publicKey,
          path.join(project, "work/updater-rehearsal/disposable.key.pub"),
        );
        assert.equal(
          options.input,
          path.join(project, `work/updater-rehearsal/${options.version}-windows-x86_64`),
        );
        assert.equal(
          options.verifier,
          path.join(
            project,
            `target/updater-rehearsal-cli-${options.version}/release/portcove-release-tools.exe`,
          ),
        );
        if (scenario === "signature") throw Error("actual verifier refused");
        mutated = true;
        return { updater: { filename: "candidate.exe" } };
      },
    }) as () => Promise<{ authority: string; stages: unknown[] }>;
    if (scenario === "success") {
      const value = await acquire();
      assert.equal(value.authority, "none");
      assert.equal(value.stages.length, 2);
      assert.equal(verifications, 2);
    } else await assert.rejects(acquire(), scenario);
    if (["wrong-repository", "local-runner", "observer-only"].includes(scenario)) {
      assert.equal(inputReads, 0);
      assert.equal(verifications, 0);
    }
    if (
      ["foreign-source", "dirty-source", "private-key", "wrong-version", "foreign-file"].includes(
        scenario,
      )
    )
      assert.equal(verifications, 0);
  }
});

void test("shared original owner handshake retains lineage, helper bytes and independent disabled-account readback before acknowledgment", async () => {
  const text = readFileSync(
    new URL("./release-windows-owner-mechanism.mts", import.meta.url),
    "utf8",
  );
  const code = body(
    "export async function establishWindowsOwnerAccount(",
    "/** End of shared original account handshake. */",
    text,
  );
  for (const scenario of [
    "success",
    "owner-generation",
    "lineage",
    "helper-drift",
    "foreign-account",
    "account-readback",
  ]) {
    const root = path.resolve("/original-owner"),
      writes: string[] = [],
      retained: string[] = [];
    let accountObserved = false,
      rechecked = false;
    const state = {
      root,
      binding: "a".repeat(64),
      deadline: 10000,
      supervisor: { pid: 42 },
      error: undefined,
      signal: new EventEmitter(),
      owner: { pid: 0, created: "", broker: "", bridge: "" },
      frequency: 0,
      clockSample: "",
      clockReceived: 0,
      fullTicks: "",
      activeTicks: "",
      account: null as { sid: string; description: string; profile: string } | null,
    };
    const handshake = runInNewContext(code + ";establishWindowsOwnerAccount", {
      assert,
      Buffer,
      path,
      performance,
      readProcessIdentity: (pid: number) => `generation:${pid}`,
      windowsOwnerFiletime: () => (scenario === "owner-generation" ? "101" : "100"),
      hostedWindowsOwnerDeadline: () => "9000000",
      readControllerToolFile: async (filename: string) =>
        Buffer.from(
          scenario === "helper-drift" && filename.startsWith(root) ? "drift" : "original-helper",
        ),
    }) as (state: unknown, options: unknown) => Promise<void>;
    const options = {
      toolsRoot: path.resolve("/original-tools"),
      powershell: "fixed-powershell",
      read: async (name: string) => ({
        file: path.join(root, name),
        value:
          name === "owner-ready.json"
            ? {
                owner_pid: 10,
                owner_created_filetime: "100",
                broker_sid: "S-1-5-21-7",
                sample_ticks: "1000",
                frequency: 1000,
                bridge_root: path.join(root, "bridge"),
              }
            : name === "account-created.json"
              ? {
                  sid: "S-1-5-21-8",
                  name: scenario === "foreign-account" ? "OtherUser" : "PortcoveNativeQual",
                  description: `Portcove hosted native ${state.binding}`,
                  enabled: false,
                  owner_pid: 10,
                  owner_created_filetime: "100",
                }
              : { sid: "S-1-5-21-8", profile_root: "fixed-ephemeral-profile" },
      }),
      remember: async (files: string[]) => {
        retained.push(...files);
      },
      write: (name: string) => {
        if (name === "account-ack.json") assert.equal(accountObserved, true);
        writes.push(name);
      },
      inspectLineage: async (pid: number, created: string, parent: number, image: string) => {
        assert.equal(pid, 10);
        assert.equal(created, "100");
        assert.equal(parent, 42);
        assert.equal(image, "fixed-powershell");
        if (scenario === "lineage") throw Error("original ancestry refused");
      },
      inspectAccount: async (enabled: boolean) => {
        assert.equal(enabled, false);
        if (scenario === "account-readback") throw Error("account OS changed");
        accountObserved = true;
      },
      recheck: async () => {
        rechecked = true;
      },
    };
    if (scenario === "success") {
      await handshake(state, options);
      assert.deepEqual(writes, ["owner-start.json", "account-ack.json"]);
      assert.equal(rechecked, true);
      assert.equal(state.account?.profile, "fixed-ephemeral-profile");
      assert.equal(retained.length, 5);
      assert.equal(state.activeTicks, "8970000");
    } else {
      await assert.rejects(handshake(state, options), scenario);
      assert.equal(writes.includes("account-ack.json"), false);
      if (["owner-generation", "lineage", "helper-drift"].includes(scenario))
        assert.equal(writes.length, 0);
    }
  }
});

void test("diagnostic cached driver join uses fixed cache paths and actual shared Microsoft signature/runtime policy", async () => {
  const text = readFileSync(
    new URL("./release-hosted-native-windows-diagnostic-source.mts", import.meta.url),
    "utf8",
  );
  const code = body(
    "async function readOriginalDiagnosticDrivers(",
    "/** Read observations from the one maintained rehearsal",
    text,
  );
  for (const scenario of [
    "success",
    "foreign-path",
    "wrong-version",
    "changed-binary",
    "invalid-signature",
    "wrong-observed-runtime",
    "changed-cache",
  ]) {
    const project = path.resolve("/diagnostic-source"),
      shared = path.resolve("/shared-tools"),
      version = "156.0.4314.50",
      tauriVersion = "2.0.6";
    const native = path.join(shared, "desktop/msedgedriver", version, "x64/msedgedriver.exe"),
      tauri = path.join(shared, "cargo/tauri-driver", tauriVersion, "bin/tauri-driver.exe");
    const state = {
      pin_fingerprint: "pinned",
      shared_root: shared,
      desktop: {
        native_driver: scenario === "foreign-path" ? "foreign.exe" : native,
        native_driver_version: scenario === "wrong-version" ? "155.0.0.0" : version,
        webview2_version: version,
        tauri_driver: tauri,
        tauri_driver_version: tauriVersion,
        native_driver_sha256: "A".repeat(64),
        tauri_driver_sha256: "A".repeat(64),
      },
    };
    let reads = 0,
      executed = 0,
      rechecks = 0;
    const run = runInNewContext(code + ";readOriginalDiagnosticDrivers", {
      assert,
      Buffer,
      JSON,
      path,
      project,
      isRecord,
      performance,
      toolCachePaths: () => ({
        statePath: path.join(project, "work/tool-bin/tool-state.json"),
        sharedRoot: shared,
        cargoRoot: path.join(shared, "cargo"),
        pins: { fingerprint: "pinned", bootstrap: { desktop: { tauri_driver: tauriVersion } } },
      }),
      readControllerToolFile: async () =>
        Buffer.from(
          JSON.stringify(scenario === "changed-cache" && ++reads > 1 ? { changed: true } : state),
        ),
      inspectNativeRuntimeCustody: () => new Map(),
      recheckNativeRuntimeCustody: () => {
        rechecks++;
      },
      hashNativeCapturedFile: async (root: string, name: string, maximum: number) => {
        assert.equal(root, shared);
        assert.ok(!name.startsWith(".."));
        assert.equal(maximum, 128 * 1024 ** 2);
        return {
          path: name,
          bytes: 10,
          sha256: (scenario === "changed-binary" ? "b" : "a").repeat(64),
        };
      },
      windowsSourceSystemExecutables: { powershell: "fixed-powershell" },
      windowsOwnerEnvironment: () => ({ SystemRoot: "fixed-system" }),
      execFileSync: (
        file: string,
        args: string[],
        options: { env: Record<string, string>; timeout: number },
      ) => {
        executed++;
        assert.equal(file, "fixed-powershell");
        assert.deepEqual(options.env, { SystemRoot: "fixed-system" });
        assert.ok(options.timeout > 0 && options.timeout <= 15000);
        const script = Buffer.from(args.at(-1)!, "base64").toString("utf16le");
        assert.match(script, /Test-VerifiedEdgeDriver/u);
        assert.match(script, /Get-WebViewRuntimeVersion/u);
        assert.match(script, /Get-AuthenticodeSignature/u);
        return JSON.stringify({
          version: scenario === "wrong-observed-runtime" ? "157.0.0.0" : version,
          status: scenario === "invalid-signature" ? "NotSigned" : "Valid",
          subject: "CN=Microsoft Corporation",
          thumbprint: "A".repeat(40),
        });
      },
    }) as (
      version: string,
      deadline: number,
    ) => Promise<{ native: { path: string }; tauri: { publisher_authentication: string } }>;
    if (scenario === "success") {
      const value = await run(version, performance.now() + 10000);
      assert.equal(value.native.path, native);
      assert.equal(value.tauri.publisher_authentication, "not-established");
      assert.equal(executed, 1);
      assert.equal(rechecks, 1);
    } else {
      await assert.rejects(run(version, performance.now() + 10000), scenario);
      if (["foreign-path", "wrong-version", "changed-binary"].includes(scenario))
        assert.equal(executed, 0);
    }
  }
});

void test("same-job derivation binds the maintained producer, actual commands and every restored or staged byte identity", () => {
  const text = readFileSync(
      new URL("./release-hosted-native-windows-diagnostic-source.mts", import.meta.url),
      "utf8",
    ),
    code = body(
      "export function inspectDiagnosticFixtureDerivation(",
      "async function readOriginalDiagnosticDrivers(",
      text,
    );
  const project = path.resolve("/fixture-source"),
    metadata = [
      "Cargo.toml",
      "Cargo.lock",
      "apps/desktop/package.json",
      "apps/desktop/src-tauri/tauri.conf.json",
    ],
    versions = ["1.0.0-rc.2", "1.0.0"];
  const context = {
    source: "a".repeat(40),
    tree: "b".repeat(40),
    run_id: "123",
    workflow:
      "boburning/portcove/.github/workflows/hosted-native-continuity.yml@refs/heads/feature/534-fixture",
  };
  const expected = new Map<string, { path: string; bytes: number; sha256: string }>();
  const identity = (name: string) => {
    const row = { path: name, bytes: 10, sha256: "c".repeat(64) };
    expected.set(name, row);
    return row;
  };
  const state = () => ({
    source: context.source,
    tree: context.tree,
    tracked_changes: [],
    metadata: metadata.map(identity),
  });
  const value = {
    schema_version: 1,
    ...context,
    attempt: "1",
    platform: "windows-x86_64",
    transition_profile: "preview-final",
    private_inputs_absent: true,
    native_rehearsal_passed: true,
    authority: "none",
    scope:
      "observed same-job maintained fixture producer; not reproducible-build attestation or publisher authentication",
    producer: identity("scripts/rehearse-updater-artifacts.ps1"),
    restored: state(),
    stages: versions.map((version) => ({
      version,
      generator: "Set-FixtureVersion",
      before: state(),
      after: state(),
      commands_successful: true,
      commands: [
        {
          program: "cargo",
          arguments: [
            "build",
            "--release",
            "-p",
            "portcove-cli",
            "-p",
            "portcove-release-tools",
            "--target-dir",
            path.join(project, `target/updater-rehearsal-cli-${version}`),
          ],
          success: true,
        },
        {
          program: "pnpm",
          arguments: [
            "--dir",
            "apps/desktop",
            "tauri",
            "build",
            "--bundles",
            "nsis",
            "--config",
            path.join(project, "work/updater-rehearsal/rehearsal-config.json"),
            "--ci",
            "--features",
            "application-update-qualification",
          ],
          success: true,
        },
        { program: "node", operation: "updater-inventory-stage", success: true },
        { program: "node", operation: "updater-inventory-verify", success: true },
      ],
      inventory: identity(
        `work/updater-rehearsal/${version}-windows-x86_64/updater-inventory.json`,
      ),
      patch: identity(`work/updater-rehearsal/${version}-fixture.patch`),
      public_key: identity("work/updater-rehearsal/disposable.key.pub"),
      verifier: identity(
        `target/updater-rehearsal-cli-${version}/release/portcove-release-tools.exe`,
      ),
      artifacts: [identity(`work/updater-rehearsal/${version}-windows-x86_64/candidate.exe`)],
    })),
  };
  const inspect = runInNewContext(code + ";inspectDiagnosticFixtureDerivation", {
    // Inert JSON fixtures cross the VM realm; compare their data without realm prototypes.
    assert: {
      ...assert,
      deepEqual: (actual: unknown, expected: unknown, message?: string) =>
        assert.deepEqual(
          JSON.parse(JSON.stringify(actual)) as unknown,
          JSON.parse(JSON.stringify(expected)) as unknown,
          message,
        ),
    },
    JSON,
    Map,
    Set,
    Object,
    path,
    project,
    fixtureMetadata: metadata,
    diagnosticVersions: versions,
    isRecord,
  }) as (value: unknown, context: unknown, expected: unknown) => { authority: string };
  assert.equal(inspect(value, context, expected).authority, "none");
  for (const scenario of [
    "other-run",
    "other-source",
    "private-remains",
    "native-failure",
    "extra-tracked",
    "wrong-generator",
    "command-failed",
    "foreign-command",
    "inventory-changed",
    "patch-changed",
    "metadata-not-restored",
    "wrong-producer",
    "missing-artifact",
    "forged-brand",
  ]) {
    const clone = structuredClone(value);
    switch (scenario) {
      case "other-run":
        clone.run_id = "456";
        break;
      case "other-source":
        clone.source = "d".repeat(40);
        break;
      case "private-remains":
        clone.private_inputs_absent = false;
        break;
      case "native-failure":
        clone.native_rehearsal_passed = false;
        break;
      case "extra-tracked":
        (clone.stages[0]!.before.tracked_changes as string[]).push(
          "scripts/release-native-worker.mts",
        );
        break;
      case "wrong-generator":
        clone.stages[0]!.generator = "alternate-transformer";
        break;
      case "command-failed":
        clone.stages[0]!.commands[0]!.success = false;
        break;
      case "foreign-command":
        clone.stages[0]!.commands[0]!.arguments?.push("--arbitrary");
        break;
      case "inventory-changed":
        clone.stages[0]!.inventory.sha256 = "e".repeat(64);
        break;
      case "patch-changed":
        clone.stages[0]!.patch.sha256 = "e".repeat(64);
        break;
      case "metadata-not-restored":
        clone.restored.metadata[0]!.sha256 = "e".repeat(64);
        break;
      case "wrong-producer":
        clone.producer.sha256 = "e".repeat(64);
        break;
      case "missing-artifact":
        clone.stages[0]!.artifacts = [];
        break;
      case "forged-brand":
        Object.assign(clone, { production_verified: true });
        break;
    }
    assert.throws(() => inspect(clone, context, expected), scenario);
  }
});

void test("shared original A/B stage mechanics reject altered worker generations and incomplete cleanup before accepting settlement", async () => {
  const text = readFileSync(
      new URL("./release-windows-owner-mechanism.mts", import.meta.url),
      "utf8",
    ),
    code = body(
      "export async function startWindowsOwnerStageMechanism(",
      "/** End of shared original A/B stage mechanisms. */",
      text,
    );
  for (const scenario of [
    "success",
    "worker-request",
    "lineage",
    "worker-failed",
    "undrained",
    "remaining-child",
  ]) {
    const directory = path.resolve("/original-stage/capture"),
      workerSha = "a".repeat(64),
      bindingSha = "b".repeat(64),
      invocation = "c".repeat(64);
    const trace: string[] = [];
    const state = {
      account: { sid: "S-1-5-21-9" },
      owner: { pid: 10, created: "100" },
      tools: { node: "fixed-node.exe" },
    };
    const stage: {
      kind: string;
      directory: string;
      binding: Record<string, unknown>;
      workerRequestSha: string;
      bindingSha: string;
      station: { before: Buffer; proposed: Buffer } | null;
      worker?: { pid: number; created: string };
    } = {
      kind: "payload-signing",
      directory,
      binding: { configuration_sha256: "config" },
      workerRequestSha: workerSha,
      bindingSha,
      station: null,
    };
    const vmAssert = {
      ...assert,
      deepEqual: (actual: unknown, expected: unknown, message?: string) =>
        assert.deepEqual(
          JSON.parse(JSON.stringify(actual)) as unknown,
          JSON.parse(JSON.stringify(expected)) as unknown,
          message,
        ),
    };
    const common = runInNewContext(
      code + ";({start:startWindowsOwnerStageMechanism,settle:settleWindowsOwnerStageMechanism})",
      {
        assert: vmAssert,
        Buffer,
        JSON,
        path,
        isRecord,
        errorCode: (error: unknown) => (isRecord(error) ? error.code : undefined),
        delay: async () => {},
        readProcessIdentity: () => null,
        windowsOwnerFiletime: () => "200",
        readControllerToolFile: async (file: string) =>
          file.endsWith("bridge-state.json")
            ? Buffer.from(
                JSON.stringify({
                  invocation_id: invocation,
                  broker_pid: 10,
                  broker_created_filetime: "100",
                  configuration_sha256: "config",
                  phase: "prepared",
                }),
              )
            : Buffer.from(file.endsWith("station-dacl-before.bin") ? "before" : "proposed"),
        NativeAccountClient: class {
          constructor(binding: unknown) {
            assert.equal(binding, stage.binding);
          }
          invoke(operation: string, phase: string) {
            assert.equal(operation, "finish");
            assert.equal(phase, "stage-finish");
            trace.push("finish");
          }
        },
      },
    ) as {
      start: (state: unknown, stage: unknown, options: unknown) => Promise<void>;
      settle: (state: unknown, stage: unknown, options: unknown) => Promise<void>;
    };
    const options = {
      invocationId: invocation,
      active: () => {},
      recheck: async () => {
        trace.push("recheck");
      },
      recheckStage: () => {
        trace.push("custody");
      },
      write: (name: string) => {
        trace.push(name);
      },
      frame: () => {
        trace.push("worker-start");
      },
      remember: async () => {},
      inspectAccount: async (enabled: boolean) => {
        trace.push(enabled ? "enabled" : "disabled");
      },
      inspectLineage: async () => {
        if (scenario === "lineage") throw Error("foreign worker parent");
        trace.push("lineage");
      },
      station: async (before: Buffer) => {
        assert.equal(before.toString(), "before");
        trace.push("station-restored");
      },
      read: async (name: string) => ({
        file: path.join(directory, name),
        value: name.endsWith("-station.json")
          ? { account_sid: state.account.sid, enabled: false }
          : name.endsWith("-worker.json")
            ? {
                pid: 20,
                created_filetime: "200",
                owner_pid: 10,
                owner_created_filetime: "100",
                image: "fixed-node.exe",
                request_sha256: workerSha,
                supervisor_job_pids: [10, 20],
              }
            : {
                account_sid: state.account.sid,
                disabled: true,
                station_restored: true,
                group_empty: true,
                harness_exit_code: 0,
                harness_drained: scenario !== "undrained",
                broker_job_remaining_pids: scenario === "remaining-child" ? [10, 30] : [10],
              },
      }),
      workerRecord: async (name: string) => ({
        files: [name + ".json", name + ".complete"],
        value:
          name === "worker-ready"
            ? {
                pid: 20,
                created_filetime: "200",
                owner_pid: 10,
                owner_created_filetime: "100",
                invocation_id: invocation,
                stage: "payload-signing",
                request_sha256: scenario === "worker-request" ? "d".repeat(64) : workerSha,
                binding_sha256: bindingSha,
              }
            : {
                pid: 20,
                created_filetime: "200",
                request_sha256: workerSha,
                invocation_id: invocation,
                status: scenario === "worker-failed" ? 1 : 0,
                authority: "none",
              },
      }),
    };
    if (["worker-request", "lineage"].includes(scenario)) {
      await assert.rejects(common.start(state, stage, options), scenario);
      assert.equal(trace.includes("worker-start"), false);
      continue;
    }
    await common.start(state, stage, options);
    assert.ok(trace.indexOf("lineage") < trace.indexOf("worker-start"));
    assert.equal(stage.worker?.pid, 20);
    if (scenario === "success") {
      await common.settle(state, stage, options);
      assert.ok(trace.includes("finish") && trace.includes("station-restored"));
    } else {
      await assert.rejects(common.settle(state, stage, options), scenario);
      assert.equal(trace.includes("station-restored"), false);
      if (scenario === "worker-failed") assert.equal(trace.includes("finish"), false);
    }
  }
});

void test("failed first diagnostic stage retains bounded public cleanup and recovery facts without private stream content", async (t) => {
  const {
    collectHostedWindowsDiagnosticPublicSettlement: collect,
    projectHostedWindowsDiagnosticSettlementRecord: project,
  } = await import("./release-hosted-native-windows-diagnostic.mts");
  const root = await mkdtemp(path.join(os.tmpdir(), "diagnostic-public-settlement-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(path.join(root, "payload-signing/capture"), { recursive: true });
  await mkdir(path.join(root, "recovery"));
  const secret = "fixture-private-password-never-upload";
  const files = {
    "owner-final.json": JSON.stringify({
      owner_pid: 123,
      owner_created_filetime: "123456",
      failure: secret,
      cleanup_failures: [secret],
      credential_disposed: true,
      password: secret,
    }),
    "recovery/recovery-result.json": JSON.stringify({
      account_sid: "S-1-5-21-1-2-3-4",
      disabled: true,
      station_restored: true,
      private: secret,
    }),
    "payload-signing/capture/worker-failure.json": JSON.stringify({
      pid: 456,
      created_filetime: "654321",
      exited: true,
      exit_code: 1,
      reason: "nonzero",
      private: secret,
    }),
    "payload-signing/capture/worker-failure.stdout.bin": secret,
    "payload-signing/capture/worker-failure.stderr.bin": "",
    "payload-signing/capture/installer.json": JSON.stringify({
      phase: "failed",
      failure: secret,
      details: { persistent_data_preserved: true, password: secret },
    }),
  };
  for (const [name, bytes] of Object.entries(files)) await writeFile(path.join(root, name), bytes);
  const rows = await collect(root, performance.now() + 5000),
    text = JSON.stringify(rows);
  assert.ok(!text.includes(secret));
  const owner = rows.find((row) => row.path === "owner-final.json");
  assert.ok(owner && "selected" in owner);
  assert.equal(owner.selected?.failure_present, true);
  assert.equal(owner.selected?.cleanup_failure_count, 1);
  assert.equal(owner.selected?.credential_disposed, true);
  const recovery = rows.find((row) => row.path === "recovery/recovery-result.json");
  assert.ok(recovery && "selected" in recovery);
  assert.equal(recovery.selected?.disabled, true);
  assert.equal(recovery.selected?.station_restored, true);
  assert.equal(
    rows.find((row) => row.path === "release-publication/capture/worker-result.json")?.status,
    "missing",
  );
  const stream = rows.find(
    (row) => row.path === "payload-signing/capture/worker-failure.stdout.bin",
  );
  assert.ok(stream && "sha256" in stream);
  assert.equal(stream.sha256, createHash("sha256").update(secret).digest("hex"));
  await writeFile(path.join(root, "payload-signing/capture/worker-failure.json"), "malformed");
  await writeFile(path.join(root, "owner.stdout.bin"), Buffer.alloc(65537));
  const partial = await collect(root, performance.now() + 5000);
  assert.equal(
    partial.find((row) => row.path === "owner.stdout.bin")?.status,
    "Unknown; bounded identity unavailable",
  );
  const malformed = partial.find(
    (row) => row.path === "payload-signing/capture/worker-failure.json",
  );
  assert.ok(malformed && "selected" in malformed);
  assert.equal(
    malformed.selected?.projection,
    "Unknown; malformed, changed or unavailable bounded record",
  );
  assert.equal(
    project("recovery/recovery-result.json", { disabled: true, station_restored: null })
      .station_restored,
    "Unknown",
  );
  assert.equal(
    project("payload-signing/capture/worker-failure.json", { reason: secret }).reason,
    "Unknown",
  );
});

void test("actual diagnostic first-stage failure preserves recovery success or Unknown in its public finalizer", async () => {
  const source = await readFile(
      new URL("./release-hosted-native-windows-diagnostic.mts", import.meta.url),
      "utf8",
    ),
    start = source.indexOf('  let publicOutcome: "succeeded" | "failed"'),
    end = source.indexOf("\nfunction controlRoot()", start);
  assert.ok(start > 0 && end > start);
  const body = source.slice(start, end).trimEnd();
  assert.ok(body.endsWith("}"));
  const program = stripTypeScriptTypes("(async () => {\n" + body.slice(0, -1) + "\n})()", {
    mode: "transform",
  });
  for (const recoveryFails of [false, true]) {
    const nativeFailure = new Error("controlled first-stage failure"),
      retained: unknown[] = [];
    let recoveryCalls = 0;
    const result: unknown = runInNewContext(program, {
      state: {},
      built: { tools: "unused" },
      inputs: { source: "a".repeat(40), run_id: "123" },
      binding: "b".repeat(64),
      diagnosticRoot: "fixed",
      path,
      windowsSourceSystemExecutables: { powershell: "unused" },
      establishWindowsOwnerAccount: async () => {
        throw nativeFailure;
      },
      retain: async (_path: string, value: unknown) => {
        retained.push(value);
      },
      recover: async () => {
        recoveryCalls++;
        if (recoveryFails) throw Error("controlled recovery refusal");
        return { account_disabled: true, station_restored: true, authority: "none" };
      },
      retainDiagnosticPublicSettlement: async (
        _state: unknown,
        recovery: unknown,
        outcome: unknown,
      ) => {
        retained.push({ recovery, outcome });
      },
      Error,
    });
    await assert.rejects(result as Promise<unknown>, (error: unknown) => error === nativeFailure);
    assert.equal(recoveryCalls, 1);
    const final = retained.at(-1) as {
      outcome: string;
      recovery: { status: string; account_disabled: unknown };
    };
    assert.equal(final.outcome, "failed");
    assert.equal(
      final.recovery.status,
      recoveryFails ? "Unknown; original recovery refused or unavailable" : "verified",
    );
    assert.equal(final.recovery.account_disabled, recoveryFails ? "Unknown" : true);
  }
});

void test("temporary diagnostic scope accepts only the literal branch and original hosted Windows context", () => {
  const implementation = readFileSync(
      new URL("./release-hosted-native-windows-diagnostic-source.mts", import.meta.url),
      "utf8",
    ),
    code = body(
      "export function requireOriginalHostedWindowsDiagnosticContext()",
      "export async function readOriginalHostedWindowsDiagnosticInputs()",
      implementation,
    ),
    ref =
      "boburning/portcove/.github/workflows/hosted-native-continuity.yml@refs/heads/feature/534-connected-native-node-canary-20261028";
  const environment = {
    GITHUB_ACTIONS: "true",
    RUNNER_ENVIRONMENT: "github-hosted",
    GITHUB_REPOSITORY: "boburning/portcove",
    GITHUB_EVENT_NAME: "workflow_dispatch",
    GITHUB_JOB: "installed-prerequisite",
    GITHUB_RUN_ATTEMPT: "1",
    GITHUB_RUN_ID: "123",
    GITHUB_SHA: "a".repeat(40),
    GITHUB_WORKFLOW_REF: ref,
    PORTCOVE_HOSTED_PLATFORM: "windows-x86_64",
    PORTCOVE_HOSTED_OBSERVATION_ONLY: "false",
    PORTCOVE_HOSTED_CONNECTED_DIAGNOSTIC: "true",
  };
  const context = { platform: "win32", arch: "x64", env: environment };
  const check = (process: unknown): unknown =>
    runInNewContext(code + "\nrequireOriginalHostedWindowsDiagnosticContext()", {
      assert,
      process,
      hostedWindowsDiagnosticWorkflowRef: ref,
    });
  const value: unknown = check(context);
  assert.ok(isRecord(value));
  assert.equal(value.workflow, ref);
  for (const changed of [
    {
      GITHUB_WORKFLOW_REF: ref.replace("feature/534-connected-native-node-canary-20261028", "main"),
    },
    { GITHUB_WORKFLOW_REF: ref.replace("connected-native-s2-20261028", "other") },
    {
      GITHUB_WORKFLOW_REF: ref.replace(
        "refs/heads/feature/534-connected-native-node-canary-20261028",
        "refs/tags/portcove-production-controller",
      ),
    },
    { GITHUB_RUN_ATTEMPT: "2" },
    { GITHUB_EVENT_NAME: "pull_request" },
    { GITHUB_JOB: "native_windows" },
    { RUNNER_ENVIRONMENT: "self-hosted" },
    { GITHUB_REPOSITORY: "other/portcove" },
    { GITHUB_ACTIONS: "false" },
    { PORTCOVE_HOSTED_OBSERVATION_ONLY: "true" },
    { PORTCOVE_HOSTED_CONNECTED_DIAGNOSTIC: "false" },
    { GITHUB_RUN_ID: "" },
    { GITHUB_SHA: "" },
  ])
    assert.throws(() => check({ ...context, env: { ...environment, ...changed } }));
  assert.throws(() => check({ ...context, platform: "linux" }));
  assert.throws(() => check({ ...context, arch: "arm64" }));
});

void test("diagnostic worker ref literal is inert data and cannot widen production or import an arbitrary input", async () => {
  const { runHostedWindowsDiagnosticWorkerStage, runHostedWindowsWorkerStage } =
      await import("./release-hosted-native-windows-worker.mts"),
    { hostedWindowsDiagnosticWorkflowRef: ref } =
      await import("./release-hosted-native-windows-worker-contract.mts");
  for (const wrong of [
    "",
    ref.replace("feature/534-connected-native-node-canary-20261028", "main"),
    ref + "-other",
  ])
    await assert.rejects(
      runHostedWindowsDiagnosticWorkerStage("unreadable", "a".repeat(64), wrong),
      /Fixed diagnostic worker workflow ref required/u,
    );
  await assert.rejects(
    runHostedWindowsDiagnosticWorkerStage("unreadable", "a".repeat(64), ref),
    /Fixed same-job diagnostic worker input required/u,
  );
  await assert.rejects(
    runHostedWindowsWorkerStage("unreadable", "a".repeat(64)),
    /held hosted worker execution awaits separate authority/u,
  );
  const entry = fileURLToPath(new URL("./release-native-worker.mts", import.meta.url));
  for (const args of [
    ["--hosted-windows-diagnostic-stage", "unreadable", "a".repeat(64)],
    ["--hosted-windows-diagnostic-stage", "unreadable", "a".repeat(64), "wrong"],
    ["--hosted-windows-stage", "unreadable", "a".repeat(64), ref],
  ]) {
    const result = spawnSync(process.execPath, [entry, ...args], {
      encoding: "utf8",
      timeout: 15000,
      maxBuffer: 16384,
    });
    assert.notEqual(result.status, 0);
    assert.equal(result.stdout, "");
  }
});
