import { parseDocument } from "yaml";
import assert from "node:assert/strict";

import { isRecord, errorCode } from "./runtime-values.mts";
import type {
  SpawnOptions,
  SpawnSyncOptions,
  SpawnSyncOptionsWithStringEncoding,
} from "node:child_process";
import { readFile, mkdtemp, rm, writeFile } from "node:fs/promises";
import test from "node:test";

import { spawn, spawnSync } from "node:child_process";
import { EventEmitter } from "node:events";
import os from "node:os";
import path from "node:path";

import { requiredFixture } from "./ci-workflow-fixture.mts";

// Observe only the first reader; asynchronous scheduling is diagnostic, not a repair.
// Keep the same command, environment, SIGTERM deadline and wait-for-close cleanup.
interface ReaderStream {
  setEncoding(encoding: "utf8"): void;
  on(event: "data", handler: (chunk: string) => void): unknown;
}
interface ReaderChild {
  pid?: number | undefined;
  stdin: { end(): void };
  stdout: ReaderStream;
  stderr: ReaderStream;
  kill(signal: NodeJS.Signals): boolean;
  once(event: "spawn", handler: () => void): unknown;
  once(event: "error", handler: (cause: Error) => void): unknown;
  once(
    event: "close",
    handler: (status: number | null, signal: NodeJS.Signals | null) => void,
  ): unknown;
}
interface ReaderObservation {
  representation: string;
  pid: number | null;
  spawned_ms: number | null;
  first_stderr_ms: number | null;
  closed_ms: number | null;
  deadline_reached: boolean;
  samples: ({ elapsed_ms: number; status: string[] } | { elapsed_ms: number; error: unknown })[];
  sample_scope: string;
}
interface ReaderResult {
  status: number | null;
  signal: NodeJS.Signals | null;
  error: NodeJS.ErrnoException | null;
  stdout: string;
  stderr: string;
  observation: ReaderObservation;
}
interface ReaderHooks {
  spawn?: (executable: string, args: string[], options: SpawnOptions) => ReaderChild;
  readStatus?: (file: string, encoding: "utf8") => Promise<string>;
}
async function observeFirstReader(
  executable: string,
  args: string[],
  options: SpawnOptions & Pick<SpawnSyncOptions, "encoding">,
  hooks: ReaderHooks = {},
): Promise<ReaderResult> {
  const started = performance.now();
  const observation: ReaderObservation = {
    representation: "instrumented asynchronous first invocation; not original-cause proof",
    pid: null,
    spawned_ms: null,
    first_stderr_ms: null,
    closed_ms: null,
    deadline_reached: false,
    samples: [],
    sample_scope: "PID-addressed Linux State/RSS/Threads; not start identity, CPU or process tree",
  };
  return await new Promise<ReaderResult>((resolve) => {
    const { timeout, ...spawnOptions } = options;
    const child: ReaderChild = hooks.spawn
      ? hooks.spawn(executable, args, { ...spawnOptions, stdio: ["pipe", "pipe", "pipe"] })
      : spawn(executable, args, { ...spawnOptions, stdio: ["pipe", "pipe", "pipe"] });
    let error: NodeJS.ErrnoException | null = null;
    let stdout = "";
    let stderr = "";
    let sampling = false;
    let closed = false;
    const elapsed = () => performance.now() - started;
    const deadline = setTimeout(() => {
      observation.deadline_reached = true;
      error ??= Object.assign(new Error(`spawn ${executable} ETIMEDOUT`), {
        code: "ETIMEDOUT",
      });
      child.kill("SIGTERM");
    }, timeout);
    const sample = async () => {
      if (closed || sampling || observation.samples.length >= 4 || !child.pid) return;
      sampling = true;
      try {
        const body = await (hooks.readStatus ?? readFile)(`/proc/${child.pid}/status`, "utf8");
        if (closed) return;
        observation.samples.push({
          elapsed_ms: elapsed(),
          status: body.split("\n").filter((line) => /^(?:State|VmRSS|Threads):/u.test(line)),
        });
      } catch (cause) {
        if (!closed)
          observation.samples.push({
            elapsed_ms: elapsed(),
            error: isRecord(cause) ? (cause.code ?? cause.name) : undefined,
          });
      } finally {
        sampling = false;
      }
    };
    const sampler =
      process.platform === "linux"
        ? setInterval(() => {
            void sample();
          }, 250)
        : null;
    child.once("spawn", () => {
      observation.pid = child.pid ?? null;
      observation.spawned_ms = elapsed();
      if (process.platform === "linux") void sample();
    });
    // Preserve spawnSync's default 1 MiB output bound, instead of hiding overflow.
    const collect = (name: "stdout" | "stderr", chunk: string) => {
      if (name === "stderr" && observation.first_stderr_ms === null)
        observation.first_stderr_ms = elapsed();
      if (isRecord(error) && error.code === "ENOBUFS") return;
      const retained = name === "stdout" ? stdout : stderr;
      if (Buffer.byteLength(retained) + Buffer.byteLength(chunk) > 1024 * 1024) {
        error ??= Object.assign(new Error(`spawn ${executable} ENOBUFS`), { code: "ENOBUFS" });
        child.kill("SIGTERM");
        return;
      }
      if (name === "stdout") stdout += chunk;
      else stderr += chunk;
    };
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => collect("stdout", chunk));
    child.stderr.on("data", (chunk) => collect("stderr", chunk));
    child.once("error", (cause) => {
      error ??= cause;
    });
    child.once("close", (status, signal) => {
      closed = true;
      clearTimeout(deadline);
      if (sampler) clearInterval(sampler);
      observation.closed_ms = elapsed();
      resolve({ status: error ? null : status, signal, error, stdout, stderr, observation });
    });
    // spawnSync sends EOF when there is no input; keep that contract here.
    child.stdin.end();
  });
}

class ReaderControlStream extends EventEmitter implements ReaderStream {
  setEncoding(_encoding: "utf8"): void {}
}
class ReaderControlChild extends EventEmitter implements ReaderChild {
  pid = 123;
  stdinEnded = false;
  killedWith: NodeJS.Signals | undefined;
  stdin = {
    end: () => {
      this.stdinEnded = true;
    },
  };
  stdout = new ReaderControlStream();
  stderr = new ReaderControlStream();
  kill(signal: NodeJS.Signals) {
    this.killedWith = signal;
    queueMicrotask(() => this.emit("close", null, signal));
    return true;
  }
}
function readerControlChild() {
  return new ReaderControlChild();
}

for (const outcome of ["success", "failure", "spawn-error", "timeout", "overflow"]) {
  void test(`first reader observation control: ${outcome}`, async () => {
    const child = readerControlChild();
    const spawnError = Object.assign(new Error("missing owned control"), { code: "ENOENT" });
    const result = await observeFirstReader(
      "owned-control",
      ["unchanged-command"],
      { timeout: 20 },
      {
        spawn: () => {
          queueMicrotask(() => {
            if (outcome === "spawn-error") child.emit("error", spawnError);
            else child.emit("spawn");
            if (outcome === "timeout") return;
            if (outcome === "overflow") child.stdout.emit("data", "x".repeat(1024 * 1024 + 1));
            else if (outcome !== "spawn-error") {
              child.stdout.emit("data", "original-output");
              child.stderr.emit("data", "first-marker");
            }
            if (outcome !== "overflow") child.emit("close", outcome === "failure" ? 7 : 0, null);
          });
          return child;
        },
        readStatus: async () => "State:\tR (running)\nVmRSS:\t100 kB\nThreads:\t1\n",
      },
    );
    assert.ok(result.observation.closed_ms !== null);
    assert.equal(child.stdinEnded, true);
    if (outcome === "timeout" || outcome === "overflow") {
      assert.equal(child.killedWith, "SIGTERM");
      assert.ok(result.error);
      assert.equal(result.error.code, outcome === "timeout" ? "ETIMEDOUT" : "ENOBUFS");
      assert.equal(result.status, null);
      assert.equal(result.signal, "SIGTERM");
      assert.equal(result.observation.deadline_reached, outcome === "timeout");
    } else if (outcome === "spawn-error") {
      assert.equal(result.error, spawnError);
      assert.equal(result.observation.spawned_ms, null);
    } else {
      assert.equal(result.error, null);
      assert.equal(result.status, outcome === "failure" ? 7 : 0);
      assert.equal(result.stdout, "original-output");
      assert.equal(result.stderr, "first-marker");
      assert.ok(result.observation.first_stderr_ms !== null);
    }
  });
}

void test("first reader observation ignores a sample finishing after close", async () => {
  const child = readerControlChild();
  let finishSample: ((value: string) => void) | undefined;
  const result = await observeFirstReader(
    "owned-control",
    [],
    { timeout: 20 },
    {
      spawn: () => {
        queueMicrotask(() => {
          child.emit("spawn");
          child.emit("close", 0, null);
        });
        return child;
      },
      readStatus: () =>
        new Promise((resolve) => {
          finishSample = resolve;
        }),
    },
  );
  const closed = structuredClone(result.observation);
  if (process.platform === "linux") {
    assert.ok(finishSample);
    finishSample("State:\tR (running)\n");
    await Promise.resolve();
    assert.deepEqual(result.observation, closed);
  }
  assert.equal(child.killedWith, undefined);
});

// Hosted first-reader evidence in PR #2038 reached stderr at 7.2s, then waited
// in Get-Content at the old 10s deadline. CI 40753522914/a1 reached stderr at
// 15.257s and read-config before its 20s cutoff. Give only that first cold
// invocation 60s; the other six retain 20s. Their 180s envelope plus 60s parent
// headroom preserves diagnostics and cleanup. No retries or product deadlines
// change. Retain the original failures; this is not a causal contention repair.

void test(
  "repository toolchain reader exports the declared components before installation",
  { timeout: 240_000 },
  async (context) => {
    const readerTimeoutMs = 20_000;
    const coldReaderTimeoutMs = 60_000;
    const setup = await readFile(
      new URL("../.github/actions/setup-rust/action.yml", import.meta.url),
      "utf8",
    );
    const config: unknown = parseDocument(setup, { uniqueKeys: true }).toJS();
    assert.ok(isRecord(config) && isRecord(config.runs) && Array.isArray(config.runs.steps));
    const steps: unknown[] = config.runs.steps;
    const readerIndex = steps.findIndex(
      (step) => isRecord(step) && step.name === "Read repository toolchain",
    );
    const installerIndex = steps.findIndex(
      (step) =>
        isRecord(step) &&
        typeof step.uses === "string" &&
        step.uses.startsWith("dtolnay/rust-toolchain@"),
    );
    assert.ok(readerIndex >= 0 && installerIndex > readerIndex);
    const reader = steps[readerIndex];
    assert.ok(isRecord(reader) && typeof reader.run === "string");
    const script = reader.run;
    assert.doesNotMatch(script, /\$portcoveReaderClock\b/);
    const phaseDiagnostic = (phase: string) =>
      `[Console]::Error.WriteLine("portcove-reader-phase:${phase};elapsed_ms=$($portcoveReaderClock.ElapsedMilliseconds)")`;
    let tracedScript = script;
    for (const [line, phase] of [
      ["$config = Get-Content rust-toolchain.toml -Raw", "read-config"],
      ["$channel = $Matches[1]", "channel-parsed"],
      ["$components = ConvertFrom-Json $Matches[1] -NoEnumerate", "parse-components"],
      ['"channel=$channel" >> $env:GITHUB_OUTPUT', "write-output"],
    ] as const) {
      assert.equal(
        script.split(line).length,
        2,
        `Reader phase must have one source anchor: ${phase}`,
      );
      tracedScript = tracedScript.replace(
        line,
        `${phaseDiagnostic(phase)}\n${line}${phase === "read-config" ? `\n${phaseDiagnostic("config-read")}` : ""}`,
      );
    }
    tracedScript =
      "$portcoveReaderClock = [System.Diagnostics.Stopwatch]::StartNew()\n" +
      `[Console]::Error.WriteLine("portcove-reader-phase:started;pwsh=$($PSVersionTable.PSVersion);elapsed_ms=$($portcoveReaderClock.ElapsedMilliseconds);utc=$([DateTime]::UtcNow.ToString('o'))")\n` +
      tracedScript +
      `\n${phaseDiagnostic("completed")}\n`;
    const directory = await mkdtemp(path.join(os.tmpdir(), "portcove-toolchain-reader-"));
    const output = path.join(directory, "github-output");
    async function runReader(fixture: string, command = tracedScript) {
      const startedAt = new Date().toISOString();
      const started = performance.now();
      const timeoutMs = fixture === "valid-1" ? coldReaderTimeoutMs : readerTimeoutMs;
      const args = ["-NoProfile", "-NonInteractive", "-Command", command];
      const options: SpawnSyncOptionsWithStringEncoding = {
        cwd: directory,
        env: { ...process.env, GITHUB_OUTPUT: output },
        encoding: "utf8",
        windowsHide: true,
        timeout: timeoutMs,
      };
      const result =
        fixture === "valid-1"
          ? await observeFirstReader("pwsh", args, options)
          : spawnSync("pwsh", args, options);
      const stream = (value: string | null | undefined) => ({
        text: (value ?? "").slice(0, 8_192),
        bytes: Buffer.byteLength(value ?? "", "utf8"),
        truncated: (value ?? "").length > 8_192,
      });
      context.diagnostic(
        JSON.stringify({
          reader_fixture: fixture,
          first_invocation_observation: "observation" in result ? result.observation : null,
          observation_order: "reader-then-startup; startup is diagnostic-only",
          node: process.version,
          platform: process.platform,
          architecture: process.arch,
          os_release: os.release(),
          runner_image: process.env.ImageOS ?? null,
          runner_image_version: process.env.ImageVersion ?? null,
          started_at: startedAt,
          elapsed_ms: performance.now() - started,
          timeout_ms: timeoutMs,
          status: result.status,
          signal: result.signal,
          error: result.error
            ? {
                code: errorCode(result.error),
                errno: isRecord(result.error) ? result.error.errno : undefined,
                message: result.error.message,
              }
            : null,
          stdout: stream(result.stdout),
          stderr: stream(result.stderr),
        }),
      );
      return result;
    }
    try {
      for (const [index, components] of [
        ["clippy", "rustfmt", "rust-analyzer"],
        ["rust-src", "rust-analyzer", "clippy", "rustfmt"],
      ].entries()) {
        await writeFile(
          path.join(directory, "rust-toolchain.toml"),
          `[toolchain]\nchannel = "1.98.1"\ncomponents = ${JSON.stringify(components)}\n`,
        );
        await writeFile(output, "");
        const result = await runReader(`valid-${index + 1}`);
        assert.ifError(result.error);
        assert.equal(result.status, 0, result.stdout + result.stderr);
        const phases = [
          ...result.stderr.matchAll(
            /portcove-reader-phase:([a-z-]+);(?:pwsh=[^;\r\n]+;)?elapsed_ms=(\d+)/g,
          ),
        ];
        assert.deepEqual(
          phases.map((phase) => phase[1]),
          [
            "started",
            "read-config",
            "config-read",
            "channel-parsed",
            "parse-components",
            "write-output",
            "completed",
          ],
        );
        assert.ok(
          phases.every(
            (phase, index) =>
              index === 0 || Number(phase[2]) >= Number(requiredFixture(phases[index - 1])[2]),
          ),
        );
        assert.match(result.stderr, /;utc=\d{4}-\d{2}-\d{2}T[^\r\n]+Z/);
        assert.deepEqual((await readFile(output, "utf8")).trim().split(/\r?\n/), [
          "channel=1.98.1",
          `components=${components.join(",")}`,
        ]);
      }
      for (const [index, declaration] of [
        "",
        'components = "clippy"',
        'components = ["clippy", 7]',
        'components = ["clippy", "rustfmt\\nextra=value"]',
      ].entries()) {
        await writeFile(
          path.join(directory, "rust-toolchain.toml"),
          `[toolchain]\nchannel = "1.98.1"\n${declaration}\n`,
        );
        await writeFile(output, "");
        const result = await runReader(`invalid-${index + 1}`);
        assert.ifError(result.error);
        assert.notEqual(result.status, 0, declaration);
        assert.equal(await readFile(output, "utf8"), "");
      }
    } finally {
      try {
        // Observe startup after the reader without warming its first invocation.
        // This result cannot replace the reader verdict or explain an earlier timeout.
        await runReader(
          "startup-after-reader-diagnostic-only",
          '[Console]::Error.WriteLine("portcove-startup-discriminator:entered"); ' +
            "[PSCustomObject]@{version=$PSVersionTable.PSVersion.ToString();executable=[Environment]::ProcessPath} | ConvertTo-Json -Compress",
        );
      } catch {
        // Best-effort diagnostics must preserve the original reader failure.
      } finally {
        await rm(directory, { recursive: true, force: true });
      }
    }
  },
);
