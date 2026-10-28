/** Bounded Windows owner OS mechanics only. Callers retain original admission,
 * sequence, custody and deadline ownership; these helpers create no authority. */
import assert from "node:assert/strict";
import path from "node:path";
import { spawn, execFileSync } from "node:child_process";
import { writeSync } from "node:fs";
import type { EventEmitter } from "node:events";
import { performance } from "node:perf_hooks";
import type { RustRunDependencies } from "./run-rust-tests.mts";

export type WindowsOwnerSupervisorState = {
  supervisor?: { pid: number | undefined; identity?: string };
  error: unknown;
  signal: EventEmitter;
};

export function windowsOwnerFiletime(identity: string | null, pid: number) {
  assert.ok(typeof identity === "string");
  const match = /^win32:([1-9][0-9]*):([1-9][0-9]*)$/u.exec(identity);
  assert.ok(match && Number(match[1]) === pid);
  const ticks = BigInt(match[2]!) - 504911232000000000n;
  assert.ok(ticks > 0n);
  return ticks.toString();
}
export function windowsOwnerEnvironment(
  directory: string,
  source: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  const system = source.SystemRoot;
  assert.ok(system && /^[A-Za-z]:\\/u.test(system));
  const environment: NodeJS.ProcessEnv = {
    SystemRoot: system,
    WINDIR: system,
    SystemDrive: path.win32.parse(system).root.slice(0, 2),
    PATH: path.win32.join(system, "System32"),
    PATHEXT: ".EXE",
    USERPROFILE: directory,
    HOME: directory,
    TEMP: directory,
    TMP: directory,
  };
  for (const name of [
    "GITHUB_ACTIONS",
    "RUNNER_ENVIRONMENT",
    "GITHUB_REPOSITORY",
    "GITHUB_JOB",
    "GITHUB_WORKFLOW_REF",
    "GITHUB_RUN_ID",
    "GITHUB_RUN_ATTEMPT",
  ]) {
    assert.ok(source[name]);
    environment[name] = source[name];
  }
  return environment;
}
/** The caller must bracket this write with its original custody/admission checks. */
export function writeWindowsOwnerFrame(
  file: string,
  wire: Record<string, unknown>,
  options: { root: string; deadline: number; powershell: string; environment: NodeJS.ProcessEnv },
) {
  assert.ok(
    Number.isFinite(options.deadline) && performance.now() < options.deadline,
    "Original owner frame deadline exhausted",
  );
  const bytes = Buffer.from(JSON.stringify({ file, value: wire }));
  assert.ok(bytes.length <= 16384);
  // FileShare.None makes the complete flushed request visible, never a partial JSON frame.
  const script = `$ErrorActionPreference='Stop';$v=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${bytes.toString("base64")}'))|ConvertFrom-Json;$b=[Text.UTF8Encoding]::new($false).GetBytes(($v.value|ConvertTo-Json -Depth 12 -Compress));$f=[IO.FileStream]::new($v.file,[IO.FileMode]::CreateNew,[IO.FileAccess]::Write,[IO.FileShare]::None);try{$f.Write($b);$f.Flush($true)}finally{$f.Dispose()}`;
  execFileSync(
    options.powershell,
    [
      "-NoLogo",
      "-NoProfile",
      "-NonInteractive",
      "-EncodedCommand",
      Buffer.from(script, "utf16le").toString("base64"),
    ],
    {
      env: options.environment,
      cwd: options.root,
      timeout: Math.max(1, Math.min(15000, Math.floor(options.deadline - performance.now()))),
      maxBuffer: 16384,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
}

export function captureWindowsOwnerSupervisor(
  state: WindowsOwnerSupervisorState,
  ownerOutput: readonly number[],
): NonNullable<RustRunDependencies["spawn"]> {
  return (command, childArgs, childOptions) => {
    assert.ok(!state.supervisor, "Exactly one original supervisor spawn required");
    const child = spawn(command, [...childArgs], {
      ...childOptions,
      stdio: ["pipe", "pipe", "pipe"],
    });
    // Return the child to runRustTests before any fallible identity lookup.
    state.supervisor = { pid: child.pid };
    for (const [stream, index] of [
      [child.stdout, 0],
      [child.stderr, 1],
    ] as const) {
      let retained = 0;
      stream.on("data", (bytes: Buffer) => {
        try {
          const count = Math.min(bytes.length, Math.max(0, 65536 - retained));
          if (count) writeSync(ownerOutput[index]!, bytes.subarray(0, count));
          retained += bytes.length;
          assert.ok(retained <= 65536);
        } catch (error) {
          state.error ??= error;
          state.signal.emit("SIGTERM");
        }
      });
      stream.on("error", (error) => {
        state.error ??= error;
        state.signal.emit("SIGTERM");
      });
    }
    return child;
  };
}
/** End of shared owner supervisor mechanics. */
