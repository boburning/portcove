import assert from "node:assert/strict";
import type { ChildProcess } from "node:child_process";
import { runInNewContext } from "node:vm";
import { errorCode, errorMessage } from "./runtime-values.mts";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { mkdtemp, open, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { inspectLinuxSupervisor } from "./run-rust-tests.mts";
import {
  heavyRustTestLockPath,
  readHeavyRustLockOwner,
  readProcessIdentity,
} from "./heavy-rust-test-lock.mts";
import { prepareRustSupportArtifact, rustSupportCompilerIdentity } from "./rust-support-cache.mts";
import { executeFallow } from "./fallow-execution.mts";
import { runResourceCommand } from "./resource-command.mts";
import { frontendOutputResource } from "./resource-capacity.mts";

interface ProcessExit {
  code: number | null;
  signal: NodeJS.Signals | null;
}

void test(
  "analyzer deadline retains live partial streams and proves ordinary descendant exit",
  { timeout: 120000 },
  async (context) => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "portcove-analyzer-deadline-"));
    const ready = path.join(directory, "ready.json");
    const fixture = `
    const {spawn} = require('node:child_process');
    const {writeFileSync} = require('node:fs');
    const child = spawn(process.execPath, ['-e', "process.stdout.write('ready');setInterval(()=>{},1000)"], {stdio:['ignore','pipe','ignore']});
    child.stdout.once('data', () => {
      writeFileSync(${JSON.stringify(ready)}, JSON.stringify({parent:process.pid, child:child.pid}));
      process.stdout.write('ANALYZER_READY\\n'); process.stderr.write('partial analyzer diagnostics\\n');
    });
    setInterval(()=>{},1000);
  `;
    let observedExit = false;
    const pending = executeFallow(
      process.execPath,
      ["-e", fixture],
      {
        cwd: process.cwd(),
        env: process.env,
        encoding: "utf8",
        maxBuffer: 4096,
      },
      {
        directory,
        phase: "analysis",
        timeoutMilliseconds: 5000,
        identity: { fixture: "owned-hanging-analyzer" },
        queueDeadline: performance.now() + 10_000,
      },
    ).finally(() => {
      observedExit = true;
    });
    let complete = false;
    try {
      const capture = path.join(
        directory,
        required((await readdir(directory)).find((name) => name.startsWith("analysis-"))),
      );
      await Promise.race([
        pending.then(() => {
          throw new Error("Analyzer exited before readiness observations");
        }),
        (async () => {
          const deadline = performance.now() + 90000;
          while (
            !existsSync(ready) ||
            !readFileSync(path.join(capture, "stdout.txt"), "utf8").includes("ANALYZER_READY") ||
            !readFileSync(path.join(capture, "stderr.txt"), "utf8").includes(
              "partial analyzer diagnostics",
            )
          ) {
            if (observedExit)
              throw new Error("Analyzer exited before its live streams were observed");
            if (performance.now() > deadline)
              throw new Error("Analyzer readiness was not observed");
            await new Promise((resolve) => setTimeout(resolve, 25));
          }
        })(),
      ]);
      const ids = json(await readFile(ready, "utf8"));
      assert.equal(typeof ids.parent, "number");
      assert.equal(typeof ids.child, "number");
      const parent = Number(ids.parent),
        child = Number(ids.child);
      const parentIdentity = readProcessIdentity(parent),
        childIdentity = readProcessIdentity(child);
      assert.ok(parentIdentity && childIdentity);
      assert.equal(
        json(await readFile(path.join(capture, "running.json"), "utf8")).outcome,
        "running",
      );
      assert.match(await readFile(path.join(capture, "stdout.txt"), "utf8"), /ANALYZER_READY/);
      assert.match(
        await readFile(path.join(capture, "stderr.txt"), "utf8"),
        /partial analyzer diagnostics/,
      );
      const result = await pending;
      assert.equal(result.status, 124);
      assert.equal(errorCode(result.error), "ETIMEDOUT");
      assert.notEqual(readProcessIdentity(parent), parentIdentity);
      assert.notEqual(readProcessIdentity(child), childIdentity);
      const finished = json(await readFile(path.join(capture, "finished.json"), "utf8"));
      assert.equal(finished.outcome, "timed-out");
      assert.equal(finished.quiescent, true);
      complete = true;
    } finally {
      const result = await pending;
      complete = complete && result.status === 124;
      if (complete) await rm(directory, { recursive: true, force: true });
      else context.diagnostic(`Retained incomplete analyzer control: ${directory}`);
    }
  },
);

for (const mode of ["format-timeout", "native-124", "output-limit", "finalization-error"] as const)
  void test(
    `bounded analyzer distinguishes ${mode} with retained custody`,
    { timeout: 120000 },
    async (context) => {
      const directory = await mkdtemp(path.join(os.tmpdir(), "portcove-analyzer-control-"));
      let verified = false;
      let result: Awaited<ReturnType<typeof executeFallow>> | undefined;
      try {
        result = await executeFallow(
          process.execPath,
          [
            "-e",
            mode === "native-124"
              ? "process.exit(124)"
              : mode === "output-limit"
                ? "process.stdout.write('x'.repeat(8192));setInterval(()=>{},1000)"
                : mode === "finalization-error"
                  ? `const fs=require('node:fs'),p=require('node:path'),d=${JSON.stringify(directory)};fs.writeFileSync(p.join(d,fs.readdirSync(d).find(n=>n.startsWith('analysis-')),'finished.json'),'reserved marker',{flag:'wx'});process.stdout.write('original stdout');process.stderr.write('original exit7');process.exit(7)`
                  : "process.stderr.write('formatter partial');setInterval(()=>{},1000)",
          ],
          {
            cwd: process.cwd(),
            env: process.env,
            encoding: "utf8",
            maxBuffer: 1024,
          },
          {
            directory,
            phase: mode === "format-timeout" ? "format" : "analysis",
            timeoutMilliseconds: mode === "format-timeout" ? 1500 : 5000,
            identity: { fixture: mode },
            queueDeadline: performance.now() + 10_000,
          },
        );
        if (mode === "native-124") {
          assert.equal(result.status, 124);
          assert.equal(result.error, undefined);
        } else if (mode === "output-limit") {
          assert.equal(errorCode(result.error), "ENOBUFS");
          assert.equal(Buffer.byteLength(result.stdout ?? ""), 1024);
        } else if (mode === "finalization-error") {
          assert.equal(result.status, 7);
          assert.equal(result.stdout, "original stdout");
          assert.equal(result.stderr, "original exit7");
          assert.match(result.evidenceFailure ?? "", /EEXIST/);
        } else {
          assert.equal(errorCode(result.error), "ETIMEDOUT");
          assert.match(result.stderr ?? "", /formatter partial/);
        }
        const capture = path.join(
          directory,
          required(
            (await readdir(directory)).find((name) =>
              name.startsWith(mode === "format-timeout" ? "format-" : "analysis-"),
            ),
          ),
        );
        if (mode === "finalization-error")
          assert.equal(
            await readFile(path.join(capture, "finished.json"), "utf8"),
            "reserved marker",
          );
        else
          assert.equal(
            json(await readFile(path.join(capture, "finished.json"), "utf8")).quiescent,
            true,
          );
        verified = true;
      } finally {
        if (verified) await rm(directory, { recursive: true, force: true });
        else {
          context.diagnostic(`Retained failed analyzer control: ${directory}`);
          context.diagnostic(
            JSON.stringify({
              mode,
              result: result
                ? {
                    status: result.status,
                    code: errorCode(result.error),
                    error: result.error ? errorMessage(result.error).slice(0, 2048) : null,
                    stdout: result.stdout,
                    stderr: result.stderr,
                    evidenceFailure: result.evidenceFailure,
                  }
                : null,
              retained: await analyzerControlEvidence(directory),
            }),
          );
        }
      }
    },
  );

async function boundedControlText(file: string) {
  try {
    const handle = await open(file, "r");
    try {
      const bytes = Buffer.alloc(4096);
      const { bytesRead } = await handle.read(bytes, 0, bytes.length, 0);
      return bytes.subarray(0, bytesRead).toString("utf8");
    } finally {
      await handle.close();
    }
  } catch (error) {
    return { error: errorCode(error) ?? errorMessage(error).slice(0, 512) };
  }
}

async function analyzerControlEvidence(directory: string) {
  try {
    const capture = (await readdir(directory)).find((name) => /^(analysis|format)-/u.test(name));
    if (!capture) return { capture: null };
    const retained = path.join(directory, capture);
    const files = await Promise.all(
      ["running.json", "native-exit.json", "finished.json"].map(async (name) => [
        name,
        await boundedControlText(path.join(retained, name)),
      ]),
    );
    try {
      const owner = await readHeavyRustLockOwner(heavyRustTestLockPath());
      if (
        owner.process.pid === process.pid &&
        typeof owner.command === "string" &&
        owner.command.includes(path.join(retained, "invocation.json"))
      )
        return {
          files,
          owned: true,
          owner: {
            pid: owner.process.pid,
            child: owner.child,
            created_at: owner.created_at,
            command: owner.command.slice(0, 2048),
          },
          cleanup: owner.child?.cleanup_receipt
            ? await boundedControlText(owner.child.cleanup_receipt)
            : null,
        };
      return { files, owned: false };
    } catch (error) {
      return { files, owner_error: errorCode(error) ?? errorMessage(error).slice(0, 512) };
    }
  } catch (error) {
    return { observation_error: errorCode(error) ?? errorMessage(error).slice(0, 512) };
  }
}

void test("analyzer admission deadline refuses before payload launch and retains incomplete custody evidence", async (context) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "portcove-analyzer-admission-"));
  const sentinel = path.join(directory, "must-not-launch");
  let verified = false;
  try {
    const result = await executeFallow(
      process.execPath,
      ["-e", `require('node:fs').writeFileSync(${JSON.stringify(sentinel)}, 'unexpected payload')`],
      { cwd: process.cwd(), env: process.env, encoding: "utf8", maxBuffer: 1024 },
      {
        directory,
        phase: "analysis",
        timeoutMilliseconds: 5000,
        identity: { fixture: "expired admission" },
        queueDeadline: performance.now() - 1,
      },
    );
    assert.equal(result.status, null);
    assert.equal(errorCode(result.error), "PORTCOVE_RESOURCE_QUEUE_TIMEOUT");
    assert.equal(existsSync(sentinel), false);
    const capture = required(
      (await readdir(directory)).find((name) => name.startsWith("analysis-")),
    );
    const finished = json(await readFile(path.join(directory, capture, "finished.json"), "utf8"));
    assert.equal(finished.outcome, "failed");
    assert.equal(finished.quiescent, false);
    verified = true;
  } finally {
    if (verified) await rm(directory, { recursive: true, force: true });
    else context.diagnostic(`Retained analyzer admission control: ${directory}`);
  }
});
void test(
  "inherited analyzer deadline establishes inner custody before releasing its outer owner",
  {
    timeout: 120000,
    skip:
      process.platform !== "win32" && process.platform !== "linux"
        ? "Inherited bounded custody is supported on Windows/Linux; standalone Unix watchdog is covered separately."
        : false,
  },
  async (context) => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "portcove-analyzer-inherited-"));
    const driver = path.join(directory, "driver.mjs");
    const observed = path.join(directory, "observed.json");
    await writeFile(
      driver,
      `
    import {writeFileSync} from 'node:fs';
    import {resourceEntrypoint} from ${JSON.stringify(new URL("./resource-command.mts", import.meta.url).href)};
    import {executeFallow} from ${JSON.stringify(new URL("./fallow-execution.mts", import.meta.url).href)};
    process.exitCode = await resourceEntrypoint('analysis', async () => {
      const result = await executeFallow(process.execPath, ['-e', "process.stderr.write('inner ready');setInterval(()=>{},1000)"],
        {cwd:process.cwd(), env:process.env, encoding:'utf8', maxBuffer:1024},
        {directory:${JSON.stringify(directory)}, phase:'analysis', timeoutMilliseconds:1500, identity:{fixture:'verified inherited'}});
      writeFileSync(${JSON.stringify(observed)}, JSON.stringify({status:result.status, code:result.error?.code, stderr:result.stderr}));
      return result.status ?? 1;
    });
  `,
    );
    let verified = false;
    let outerTimedOut = false;
    try {
      const status = await runResourceCommand("analysis", process.execPath, [driver], {
        exclusive: [frontendOutputResource(process.cwd())],
        executionTimeoutMilliseconds: 25000,
        onExecutionTimeout: () => {
          outerTimedOut = true;
        },
      });
      assert.equal(status, 124);
      assert.equal(outerTimedOut, false);
      const result = json(await readFile(observed, "utf8"));
      assert.equal(result.status, 124);
      assert.equal(result.code, "ETIMEDOUT");
      assert.match(String(result.stderr), /inner ready/);
      const capture = path.join(
        directory,
        required((await readdir(directory)).find((name) => name.startsWith("analysis-"))),
      );
      assert.equal(
        json(await readFile(path.join(capture, "finished.json"), "utf8")).quiescent,
        true,
      );
      verified = true;
    } finally {
      if (verified) await rm(directory, { recursive: true, force: true });
      else context.diagnostic(`Retained inherited analyzer control: ${directory}`);
    }
  },
);

interface LinuxCapture {
  pid: number;
  state: string;
  parent: number;
  group: number;
  start: string;
  identity: string;
}
type LinuxMode =
  | "legacy-sibling-red"
  | "natural"
  | "gate-refusal"
  | "cancel-pipe"
  | "supervisor-loss"
  | "wrapper-loss"
  | "reaper-loss"
  | "root-complete-reaper-loss"
  | "escaped-closure"
  | "ignored-sigchld"
  | "init-refusal"
  | "parent-refusal"
  | "pipe-refusal"
  | "receipt-refusal";
function required<Value>(value: Value | null | undefined): Value {
  assert.ok(value !== null && value !== undefined);
  return value;
}
function json(text: string): Record<string, unknown> {
  const value: unknown = JSON.parse(text);
  assert.ok(value !== null && typeof value === "object" && !Array.isArray(value));
  return value as Record<string, unknown>;
}
function capturedJson(text: string): LinuxCapture[] {
  const value: unknown = JSON.parse(text);
  assert.ok(Array.isArray(value));
  const entries: unknown[] = value;
  return entries.map((item) => {
    assert.ok(item !== null && typeof item === "object" && !Array.isArray(item));
    const record = item as Record<string, unknown>;
    assert.ok(typeof record.pid === "number" && Number.isSafeInteger(record.pid) && record.pid > 0);
    assert.ok(
      typeof record.parent === "number" && Number.isSafeInteger(record.parent) && record.parent > 0,
    );
    assert.ok(
      typeof record.group === "number" && Number.isSafeInteger(record.group) && record.group > 0,
    );
    assert.ok(
      typeof record.state === "string" &&
        typeof record.start === "string" &&
        typeof record.identity === "string",
    );
    return {
      ...record,
      pid: record.pid,
      parent: record.parent,
      group: record.group,
      state: record.state,
      start: record.start,
      identity: record.identity,
    };
  });
}
function assertCapturedProcessesAbsent(
  captured: readonly Pick<LinuxCapture, "pid" | "identity">[],
  readIdentity: (pid: number) => string | null = readProcessIdentity,
) {
  for (const capturedProcess of captured)
    assert.notEqual(
      readIdentity(capturedProcess.pid),
      capturedProcess.identity,
      `fixture identity ${capturedProcess.identity} was not reaped`,
    );
}
async function waitUntil(predicate: () => boolean, milliseconds: number) {
  const deadline = Date.now() + milliseconds;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  assert.fail("condition did not become true before its deadline");
}

void test(
  "non-Linux Unix supervisor gates launch and kills a surviving grandchild after wrapper loss",
  { skip: process.platform === "win32" || process.platform === "linux", timeout: 15_000 },
  async (context) => {
    const root = await mkdtemp(path.join(os.tmpdir(), "portcove-unix-supervisor-"));
    const gatePath = path.join(root, "registered.gate");
    const statusPath = path.join(root, "status.json");
    const cleanupReceiptPath = path.join(root, "cleanup.json");
    const startedPath = path.join(root, "started.txt");
    const descendantPath = path.join(root, "descendant.txt");
    const rootScript = [
      'const { spawn } = require("node:child_process")',
      'const { writeFileSync } = require("node:fs")',
      `writeFileSync(${JSON.stringify(startedPath)}, "started")`,
      'const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" })',
      `writeFileSync(${JSON.stringify(descendantPath)}, String(child.pid))`,
      "child.unref()",
      "setInterval(() => {}, 1000)",
    ].join(";");
    const supervisor = spawn(
      process.execPath,
      [
        path.resolve("scripts/rust-test-tree-supervisor.mts"),
        gatePath,
        statusPath,
        cleanupReceiptPath,
        process.execPath,
        "-e",
        rootScript,
      ],
      { detached: true, stdio: "ignore" },
    );
    const exited = new Promise<ProcessExit>((resolve, reject) => {
      supervisor.once("error", reject);
      supervisor.once("close", (code, signal) => resolve({ code, signal }));
    });
    let descendantPid: number | undefined;
    let verified = false;
    try {
      await new Promise((resolve) => setTimeout(resolve, 200));
      assert.equal(existsSync(startedPath), false, "managed command started before registration");
      await writeFile(gatePath, "registered\n");
      await waitUntil(() => existsSync(descendantPath), 5_000);
      assert.equal(existsSync(statusPath), false, "managed root exited before supervisor loss");
      descendantPid = Number(await readFile(descendantPath, "utf8"));
      assert.equal(supervisor.kill("SIGKILL"), true);
      const outcome = await exited;
      assert.notEqual(outcome.code, 0, JSON.stringify(outcome));
      await waitUntil(() => existsSync(cleanupReceiptPath), 5_000);
      assert.deepEqual(json(await readFile(cleanupReceiptPath, "utf8")), {
        outcome: "quiescent",
      });
      await waitUntil(() => {
        try {
          process.kill(required(descendantPid), 0);
          return false;
        } catch (error) {
          if (errorCode(error) === "ESRCH") return true;
          throw error;
        }
      }, 5_000);
      verified = true;
    } catch (error) {
      context.diagnostic(
        JSON.stringify({
          scope: "owned non-Linux watchdog control",
          root,
          code: errorCode(error),
          error: errorMessage(error).slice(0, 2048),
          supervisor: {
            pid: supervisor.pid,
            exitCode: supervisor.exitCode,
            signalCode: supervisor.signalCode,
          },
          descendantPid,
          gate: await boundedControlText(gatePath),
          status: await boundedControlText(statusPath),
          cleanup: await boundedControlText(cleanupReceiptPath),
        }),
      );
      throw error;
    } finally {
      if (supervisor.exitCode === null && supervisor.signalCode === null) {
        try {
          process.kill(-required(supervisor.pid), "SIGKILL");
        } catch {}
      }
      if (descendantPid) {
        try {
          process.kill(descendantPid, "SIGKILL");
        } catch {}
      }
      if (verified) await rm(root, { recursive: true, force: true });
      else context.diagnostic(`Retained incomplete Unix watchdog control: ${root}`);
    }
  },
);

// Every adversarial inner job runs under a first-party adopting envelope. This
// keeps deliberate old-topology/reaper-loss fixtures from orphaning test children
// to the host's PID1. The envelope's real receipt and every captured disappearance
// are checked after the scenario exits; neither is inferred from an exit status.
async function linuxInnerCase({
  mode,
  directory,
  reaper,
  supervisor,
}: {
  mode: LinuxMode;
  directory: string;
  reaper: string;
  supervisor: string;
}) {
  const assert: typeof import("node:assert/strict") = (await import("node:assert/strict")).default;
  const { spawn } = await import("node:child_process");
  const { existsSync, readFileSync, writeFileSync } = await import("node:fs");
  const path = (await import("node:path")).default;
  // This function is serialized into an isolated Node process. Keep runtime
  // helpers and imports inside it; outer type aliases are erased.
  function required<Value>(value: Value | null | undefined): Value {
    assert.ok(value !== null && value !== undefined);
    return value;
  }
  function positive(value: unknown): number {
    assert.ok(typeof value === "number" && Number.isSafeInteger(value) && value > 0);
    return value;
  }
  function json(text: string): Record<string, unknown> {
    const value: unknown = JSON.parse(text);
    assert.ok(value !== null && typeof value === "object" && !Array.isArray(value));
    return value as Record<string, unknown>;
  }
  function absent(error: unknown): boolean {
    return (
      error !== null && typeof error === "object" && "code" in error && error.code === "ENOENT"
    );
  }
  const identity = (pid: number): LinuxCapture => {
    const value = readFileSync(`/proc/${pid}/stat`, "utf8");
    const fields = value
      .slice(value.lastIndexOf(")") + 2)
      .trim()
      .split(/\s+/u);
    const boot = readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim();
    assert.ok(fields[0] && fields[19], "Kernel process identity fields are missing");
    return {
      pid,
      state: fields[0],
      parent: Number(fields[1]),
      group: Number(fields[2]),
      start: fields[19],
      identity: `linux:${boot}:${pid}:${fields[19]}`,
    };
  };
  const wait = async (predicate: () => boolean, milliseconds = 5_000) => {
    const deadline = Date.now() + milliseconds;
    while (Date.now() < deadline) {
      if (predicate()) return;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    throw new Error(`Linux ${mode} fixture did not reach its bounded condition`);
  };
  const gate = path.join(directory, "inner.gate");
  const status = path.join(directory, "inner.status");
  const receipt = path.join(directory, "inner.receipt");
  const registration = path.join(directory, "inner.registration");
  const started = path.join(directory, "inner.started");
  const descendant = path.join(directory, "inner.descendant");
  const helperPid = path.join(directory, "inner.helper");
  const finish = path.join(directory, "inner.finish");
  const payload = [
    'const {spawn}=require("node:child_process")',
    'const {writeFileSync,existsSync}=require("node:fs")',
    `writeFileSync(${JSON.stringify(started)},"started")`,
    `const child=spawn(process.execPath,["-e","setInterval(()=>{},1000)"],{detached:${mode === "escaped-closure"},stdio:"ignore"})`,
    `writeFileSync(${JSON.stringify(descendant)},String(child.pid))`,
    "child.unref()",
    ...(mode === "natural" ||
    mode === "ignored-sigchld" ||
    mode === "receipt-refusal" ||
    mode === "root-complete-reaper-loss"
      ? [`setInterval(()=>{if(existsSync(${JSON.stringify(finish)}))process.exit(0)},10)`]
      : ["setInterval(()=>{},1000)"]),
  ].join(";");
  const args = [
    gate,
    status,
    receipt,
    registration,
    mode === "parent-refusal"
      ? `${identity(process.pid).identity}0`
      : identity(process.pid).identity,
    process.execPath,
    supervisor,
    process.execPath,
    "-e",
    payload,
  ];
  const captured: LinuxCapture[] = [];
  writeFileSync(path.join(directory, "captured.json"), JSON.stringify(captured));
  const capture = (pid: number, beforePersistence?: (value: LinuxCapture) => void) => {
    const value = identity(pid);
    beforePersistence?.(value);
    captured.push(value);
    writeFileSync(path.join(directory, "captured.json"), JSON.stringify(captured));
    return value;
  };
  const closed = (child: ChildProcess) =>
    new Promise<ProcessExit>((resolve, reject) => {
      child.once("error", reject);
      child.once("close", (code, signal) => resolve({ code, signal }));
    });
  let managed: ChildProcess | undefined;
  let wrapper: ChildProcess | undefined;
  let helper: number | undefined;
  let completion: Promise<ProcessExit> | undefined;
  let escaped: LinuxCapture | undefined;
  let sibling: ChildProcess | undefined;
  let siblingIdentity: LinuxCapture | undefined;
  let siblingCompletion: Promise<ProcessExit> | undefined;
  let primaryFailure: { error: unknown } | undefined;
  async function closeOwnedFixtures() {
    if (sibling && siblingIdentity) {
      assert.equal(identity(siblingIdentity.pid).identity, siblingIdentity.identity);
      sibling.kill("SIGKILL");
      await required(siblingCompletion);
    }
    if (managed?.stdin && !managed.stdin.destroyed) required(managed?.stdin).end();
    const ownedEscaped = escaped;
    if (ownedEscaped) {
      let current;
      try {
        current = identity(ownedEscaped.pid);
      } catch (error) {
        if (!absent(error)) throw error;
      }
      if (current) {
        assert.equal(
          current.identity,
          ownedEscaped.identity,
          "escaped fixture identity changed; no signal admitted",
        );
        if (current.state !== "Z") process.kill(ownedEscaped.pid, "SIGKILL");
        await wait(() => {
          try {
            const value = identity(ownedEscaped.pid);
            return value.identity !== ownedEscaped.identity || value.state === "Z";
          } catch (error) {
            if (absent(error)) return true;
            throw error;
          }
        });
      }
      writeFileSync(
        path.join(directory, "escaped-coverage.json"),
        JSON.stringify({ state: "signal-complete", identity: ownedEscaped.identity }),
      );
    }
  }
  try {
    if (mode === "ignored-sigchld") {
      sibling = spawn(process.execPath, ["-e", "setInterval(()=>{},1000)"], { stdio: "ignore" });
      siblingCompletion = closed(sibling);
      siblingIdentity = identity(positive(sibling.pid));
    }
    if (mode === "legacy-sibling-red") {
      managed = spawn(
        process.execPath,
        [supervisor, gate, status, receipt, process.execPath, "-e", payload],
        {
          detached: true,
          stdio: "inherit",
        },
      );
      completion = closed(managed);
      helper = positive(managed.pid);
      capture(helper);
    } else if (mode === "root-complete-reaper-loss") {
      managed = spawn(
        process.execPath,
        [supervisor, "--linux-managed", gate, status, receipt, process.execPath, "-e", payload],
        { detached: true, stdio: ["pipe", "inherit", "inherit"] },
      );
      completion = closed(managed);
      helper = positive(managed.pid);
      capture(helper);
    } else if (mode === "wrapper-loss") {
      const wrapperScript = [
        'const {spawn}=require("node:child_process")',
        'const {writeFileSync,readFileSync}=require("node:fs")',
        `const args=${JSON.stringify(args)}`,
        'const stat=readFileSync(`/proc/${process.pid}/stat`,"utf8");const fields=stat.slice(stat.lastIndexOf(")")+2).trim().split(/\\s+/u)',
        'args[4]=`linux:${readFileSync("/proc/sys/kernel/random/boot_id","utf8").trim()}:${process.pid}:${fields[19]}`',
        `const child=spawn(${JSON.stringify(reaper)},args,{stdio:["pipe","inherit","inherit"]})`,
        `writeFileSync(${JSON.stringify(helperPid)},String(child.pid))`,
        "setInterval(()=>{},1000)",
      ].join(";");
      wrapper = spawn(process.execPath, ["-e", wrapperScript], { stdio: "inherit" });
      completion = closed(wrapper);
      capture(positive(wrapper.pid));
      await wait(() => existsSync(helperPid));
      helper = Number(readFileSync(helperPid, "utf8"));
      capture(helper);
    } else {
      managed = spawn(
        mode === "ignored-sigchld" ? "python3" : reaper,
        mode === "ignored-sigchld"
          ? [
              "-c",
              "import os,signal,sys; signal.signal(signal.SIGCHLD,signal.SIG_IGN); os.execv(sys.argv[1],sys.argv[1:])",
              reaper,
              ...args,
            ]
          : args,
        {
          stdio: mode === "init-refusal" ? "ignore" : ["pipe", "inherit", "inherit"],
        },
      );
      completion = closed(managed);
      helper = positive(managed.pid);
      if (mode !== "init-refusal" && mode !== "parent-refusal") capture(helper);
    }
    if (mode === "init-refusal" || mode === "parent-refusal") {
      assert.equal((await required(completion)).code, 1);
      assert.equal(json(readFileSync(receipt, "utf8")).outcome, "failed:linux-reaper");
      assert.equal(existsSync(registration), false);
      assert.equal(existsSync(started), false);
    } else {
      let node;
      if (mode === "legacy-sibling-red" || mode === "root-complete-reaper-loss")
        node = required(captured[0]);
      else {
        await wait(() => existsSync(registration));
        node = capture(positive(json(readFileSync(registration, "utf8")).pid));
        assert.equal(node.parent, helper);
        assert.equal(node.group, node.pid);
        assert.notEqual(
          identity(required(helper)).group,
          node.group,
          "adopter shared the killed group",
        );
      }
      assert.equal(existsSync(started), false, "payload ran before the registration gate");
      assert.equal(existsSync(receipt), false, "cleanup succeeded before group absence");
      if (mode === "gate-refusal") required(managed?.stdin).end();
      else {
        if (mode === "receipt-refusal")
          writeFileSync(receipt, '{"outcome":"failed:original"}\n', { flag: "wx" });
        if (mode === "escaped-closure")
          writeFileSync(
            path.join(directory, "escaped-coverage.json"),
            JSON.stringify({ state: "unknown", reason: "descendant discovery pending" }),
            { flag: "wx" },
          );
        writeFileSync(gate, "registered\n", { flag: "wx" });
        await wait(() => existsSync(descendant));
        const child = capture(Number(readFileSync(descendant, "utf8")), (value) => {
          if (mode === "escaped-closure") escaped = value;
        });
        if (
          mode === "natural" ||
          mode === "ignored-sigchld" ||
          mode === "receipt-refusal" ||
          mode === "root-complete-reaper-loss"
        )
          writeFileSync(finish, "finish\n");
        if (mode === "root-complete-reaper-loss") {
          await wait(() => existsSync(status));
          assert.notEqual(
            identity(node.pid).state,
            "Z",
            "completion abandoned the live control guard",
          );
          required(managed?.stdin).end();
        }
        if (mode === "cancel-pipe") required(managed?.stdin).end();
        if (mode === "supervisor-loss" || mode === "legacy-sibling-red") {
          assert.equal(identity(node.pid).start, node.start);
          assert.equal(identity(node.pid).group, node.pid);
          process.kill(-node.pid, "SIGKILL");
        }
        if (mode === "wrapper-loss") required(wrapper).kill("SIGKILL");
        if (mode === "reaper-loss") required(managed).kill("SIGKILL");
        if (mode === "pipe-refusal") required(managed?.stdin).write("unexpected control input");
        if (mode === "escaped-closure") required(managed?.stdin).end();
        if (mode === "reaper-loss" || mode === "root-complete-reaper-loss") {
          await completion;
          await wait(
            () =>
              (mode === "root-complete-reaper-loss"
                ? !existsSync(`/proc/${node.pid}`)
                : identity(node.pid).state === "Z") && identity(child.pid).state === "Z",
          );
          assert.equal(existsSync(receipt), false, "lost reaper manufactured a receipt");
        }
      }
      if (mode !== "reaper-loss" && mode !== "root-complete-reaper-loss") {
        // The old sibling cleaner retains its existing 5s
        // cleanup deadline; the enclosing Node test retains its unchanged 30s guard.
        await wait(() => existsSync(receipt), mode === "legacy-sibling-red" ? 6_000 : 5_000);
        const outcome = json(readFileSync(receipt, "utf8")).outcome;
        if (mode === "legacy-sibling-red") {
          assert.equal(
            outcome,
            "failed:timeout",
            "old sibling topology did not reproduce its orphan defect",
          );
          assert.equal(identity(Number(readFileSync(descendant, "utf8"))).state, "Z");
          await completion;
        } else if (mode === "receipt-refusal") {
          assert.equal((await required(completion)).code, 1);
          assert.equal(readFileSync(receipt, "utf8"), '{"outcome":"failed:original"}\n');
        } else if (mode === "pipe-refusal") {
          assert.equal(outcome, "failed:linux-reaper");
          assert.equal((await required(completion)).code, 1);
        } else {
          assert.equal(outcome, "quiescent");
          if (mode === "wrapper-loss") await completion;
          else assert.equal((await required(completion)).code, 0);
          assert.equal(
            existsSync(`/proc/${node.pid}`),
            false,
            "Node group was not actually reaped",
          );
          if (mode === "gate-refusal") assert.equal(existsSync(started), false);
          else
            assert.equal(
              existsSync(`/proc/${required(captured.at(-1)).pid}`),
              false,
              "descendant was not actually reaped",
            );
          if (siblingIdentity) {
            const observedSibling = identity(siblingIdentity.pid);
            assert.equal(observedSibling.identity, siblingIdentity.identity);
            assert.notEqual(
              observedSibling.state,
              "Z",
              "unrelated sibling was killed by owned cleanup",
            );
          }
        }
      }
    }
  } catch (error) {
    primaryFailure = { error };
  }
  let cleanupFailure: { error: unknown } | undefined;
  try {
    await closeOwnedFixtures();
  } catch (error) {
    cleanupFailure = { error };
  }
  if (primaryFailure && cleanupFailure) {
    throw new AggregateError(
      [primaryFailure.error, cleanupFailure.error],
      "scenario and owned fixture cleanup failed",
    );
  }
  if (primaryFailure) throw primaryFailure.error;
  if (cleanupFailure) throw cleanupFailure.error;
}

let linuxEvidenceHeld = false;
for (const mode of [
  "legacy-sibling-red",
  "natural",
  "gate-refusal",
  "cancel-pipe",
  "supervisor-loss",
  "wrapper-loss",
  "reaper-loss",
  "root-complete-reaper-loss",
  "escaped-closure",
  "ignored-sigchld",
  "init-refusal",
  "parent-refusal",
  "pipe-refusal",
  "receipt-refusal",
] as const) {
  void test(
    `Linux adopting containment proves ${mode}`,
    { skip: process.platform !== "linux", timeout: 30_000 },
    async () => {
      assert.equal(
        linuxEvidenceHeld,
        false,
        "previous owned fixture lacks containment closure; no new process fixture admitted",
      );
      const directory = await mkdtemp(path.join(os.tmpdir(), "portcove-linux-reaper-proof-"));
      const root = path.resolve(".");
      const reaper = path.join(directory, "reaper");
      const compiler = rustSupportCompilerIdentity({
        runSync: spawnSync,
        environment: process.env,
      });
      const prepared = prepareRustSupportArtifact({
        root,
        output: reaper,
        compiler,
        runSync: spawnSync,
        environment: process.env,
        platform: "linux",
        architecture: process.arch,
        product: "linux-process-tree-reaper",
        source: "scripts/fixtures/linux-process-tree-reaper.rs.txt",
        rustcArgs: ["--edition=2024", "--crate-name", "portcove_linux_process_tree_reaper"],
      });
      assert.equal(prepared.output.sha256.length, 64);
      const supervisor = path.resolve("scripts/rust-test-tree-supervisor.mts");
      const gate = path.join(directory, "outer.gate");
      const status = path.join(directory, "outer.status");
      const receipt = path.join(directory, "outer.receipt");
      const registration = path.join(directory, "outer.registration");
      const scenario = `(${linuxInnerCase.toString()})(${JSON.stringify({ mode, directory, reaper, supervisor })}).catch(error=>{console.error(error);process.exitCode=1})`;
      const parentIdentity = readProcessIdentity(process.pid);
      assert.ok(parentIdentity, "Parent process identity required before envelope launch");
      const outer = spawn(
        reaper,
        [
          gate,
          status,
          receipt,
          registration,
          parentIdentity,
          process.execPath,
          supervisor,
          process.execPath,
          "--input-type=module",
          "-e",
          scenario,
        ],
        { stdio: ["pipe", "inherit", "inherit"] },
      );
      linuxEvidenceHeld = true;
      const exited = new Promise<number | null>((resolve, reject) => {
        outer.once("error", reject);
        outer.once("close", (code) => resolve(code));
      });
      const boundedExit = async (milliseconds: number) => {
        let timer: ReturnType<typeof setTimeout> | undefined;
        try {
          return await Promise.race([
            exited,
            new Promise<never>((_, reject) => {
              timer = setTimeout(
                () =>
                  reject(new Error("owned envelope did not close before its evidence deadline")),
                milliseconds,
              );
            }),
          ]);
        } finally {
          clearTimeout(timer);
        }
      };
      let completed = false;
      try {
        await waitUntil(() => existsSync(registration), 5_000);
        inspectLinuxSupervisor(json(readFileSync(registration, "utf8")), outer.pid);
        await writeFile(gate, "registered\n", { flag: "wx" });
        const exitCode = await boundedExit(15_000);
        assert.equal(exitCode, 0);
        assert.equal(json(await readFile(receipt, "utf8")).outcome, "quiescent");
        assert.equal(json(await readFile(status, "utf8")).exit_code, 0);
        const captured = capturedJson(
          await readFile(path.join(directory, "captured.json"), "utf8"),
        );
        assertCapturedProcessesAbsent(captured);
        if (mode === "escaped-closure")
          assert.equal(
            json(await readFile(path.join(directory, "escaped-coverage.json"), "utf8")).state,
            "signal-complete",
          );
        completed = true;
        linuxEvidenceHeld = false;
      } finally {
        outer.stdin.end(); // Request only the owned envelope's ordinary bounded closure.
        if (completed) await rm(directory, { recursive: true, force: true });
        else {
          try {
            const code = await boundedExit(5_000);
            const cleanup = json(await readFile(receipt, "utf8"));
            const captured = capturedJson(
              await readFile(path.join(directory, "captured.json"), "utf8"),
            );
            const remaining = captured.filter(
              (value) => readProcessIdentity(value.pid) === value.identity,
            );
            await writeFile(
              path.join(directory, "failure-closure.json"),
              JSON.stringify({
                code,
                cleanup,
                remaining,
                escapedCoverage:
                  mode === "escaped-closure"
                    ? json(await readFile(path.join(directory, "escaped-coverage.json"), "utf8"))
                    : null,
              }),
            );
          } catch (error) {
            await writeFile(path.join(directory, "failure-closure-error.txt"), String(error));
          }
          console.error(`Retained failed Linux containment evidence: ${directory}`);
        }
      }
    },
  );
}

void test("serialized Linux containment fixture is executable native Node JavaScript", () => {
  const result = spawnSync(process.execPath, ["--input-type=module", "--check"], {
    input: `(${linuxInnerCase.toString()})`,
    encoding: "utf8",
    timeout: 5000,
    windowsHide: true,
  });
  assert.equal(result.status, 0, result.stderr);
});

void test("Linux fixture failure tail preserves primary and cleanup rejection identities", async () => {
  const source = linuxInnerCase.toString();
  const from = source.indexOf("} catch (error) {\n    primaryFailure =");
  assert.ok(from >= 0);
  const tail = source.slice(from);
  const failures = [undefined, null, false, 0, "", new Error("owned fixture error")];
  for (const primaryPresent of [false, true])
    for (const cleanupPresent of [false, true]) {
      for (const primary of failures)
        for (const cleanup of failures) {
          let cleanupCalls = 0;
          const result: unknown = runInNewContext(
            `(async function() { let primaryFailure; try { await operation(); ${tail})()`,
            {
              AggregateError,
              operation: () => (primaryPresent ? Promise.reject(primary) : Promise.resolve()),
              closeOwnedFixtures: () => {
                cleanupCalls += 1;
                return cleanupPresent ? Promise.reject(cleanup) : Promise.resolve();
              },
            },
          );
          if (primaryPresent || cleanupPresent)
            await assert.rejects(
              async () => {
                await result;
              },
              (error: unknown) => {
                if (primaryPresent && cleanupPresent)
                  return (
                    error instanceof AggregateError &&
                    Object.is(error.errors[0], primary) &&
                    Object.is(error.errors[1], cleanup)
                  );
                return Object.is(error, primaryPresent ? primary : cleanup);
              },
            );
          else await result;
          assert.equal(cleanupCalls, 1);
        }
    }
});

void test("captured disappearance checks reject a matching live identity at the captured PID", () => {
  const actual = readProcessIdentity(process.pid);
  assert.ok(actual, "Test process identity must be observable");
  assert.throws(
    () => assertCapturedProcessesAbsent([{ pid: process.pid, identity: actual }]),
    /was not reaped/u,
  );
  const calls: number[] = [];
  assert.throws(
    () =>
      assertCapturedProcessesAbsent([{ pid: 42, identity: "owned-child-start" }], (pid) => {
        calls.push(pid);
        return "owned-child-start";
      }),
    /was not reaped/u,
  );
  assert.deepEqual(calls, [42]);
  assertCapturedProcessesAbsent([{ pid: 42, identity: "owned-child-start" }], () => null);
  assertCapturedProcessesAbsent(
    [{ pid: 42, identity: "owned-child-start" }],
    () => "replacement-start",
  );
});
