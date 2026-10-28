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

void test("actual production and diagnostic owner wrappers remain held before context, storage or OS effects", () => {
  for (const [name, message] of [
    [
      "release-hosted-native-windows-owner.ps1",
      "Hosted persistent session awaits separate owner authority",
    ],
    [
      "release-hosted-native-windows-diagnostic-owner.ps1",
      "Connected Windows diagnostic awaits exact",
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
          ? "Connected diagnostic original-session recovery"
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
  await writeFile(
    wrapper,
    actual.replace(
      "$hostedDiagnosticExecutionAuthorized=$false",
      "$hostedDiagnosticExecutionAuthorized=$true",
    ),
  );
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
      { encoding: "utf8", timeout: 15000, maxBuffer: 16384 },
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
  assert.equal(readHostedWindowsDiagnosticWorkerAbi().execution_authorized, false);
  assert.equal(readHostedWindowsDiagnosticWorkerAbi().authority, "none");
  await assert.rejects(
    runHostedWindowsWorkerStage("unreadable-untrusted-path", "invalid"),
    /held hosted worker execution awaits separate authority/u,
  );
  await assert.rejects(
    runHostedWindowsDiagnosticWorkerStage("unreadable-untrusted-path", "invalid"),
    /Connected diagnostic worker awaits exact separate authority/u,
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
  assert.equal(observation.execution_authorized, false);
  const refused = spawnSync(
    process.execPath,
    [entry, "--hosted-windows-diagnostic-stage", "unreadable-untrusted-path", "a".repeat(64)],
    { encoding: "utf8", timeout: 15000, maxBuffer: 16384 },
  );
  assert.notEqual(refused.status, 0);
  assert.match(refused.stderr, /Connected diagnostic worker awaits exact separate authority/u);
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
    "export async function readOriginalHostedWindowsDiagnosticInputs()",
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
          PORTCOVE_HOSTED_OBSERVATION_ONLY: scenario === "observer-only" ? "true" : "false",
          GITHUB_EVENT_NAME: "workflow_dispatch",
          GITHUB_JOB: "installed-prerequisite",
          GITHUB_RUN_ATTEMPT: "1",
          GITHUB_RUN_ID: "123",
          GITHUB_WORKFLOW_REF:
            "boburning/portcove/.github/workflows/hosted-native-continuity.yml@refs/heads/feature/534-fixed-diagnostic",
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
