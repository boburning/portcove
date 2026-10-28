/** Bounded Windows owner OS mechanics only. Callers retain original admission,
 * sequence, custody and deadline ownership; these helpers create no authority. */
import assert from "node:assert/strict";
import path from "node:path";
import { spawn, execFileSync } from "node:child_process";
import { writeSync, constants } from "node:fs";
import { open, lstat } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import { createHash } from "node:crypto";
import { readControllerToolFile } from "./release-controller-tools.mts";
import { isRecord, errorCode } from "./runtime-values.mts";
import type { EventEmitter } from "node:events";
import { performance } from "node:perf_hooks";
import type { RustRunDependencies } from "./run-rust-tests.mts";
import { readProcessIdentity } from "./heavy-rust-test-lock.mts";
import { NativeAccountClient } from "./native-qualification-account-client.mts";
import { hostedWindowsOwnerDeadline } from "./release-hosted-native-windows-worker-contract.mts";

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
const hash = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");

export async function readWindowsOwnerRecord(
  state: { root: string; binding: string; active: () => void },
  name: string,
) {
  assert.ok(/^[a-z][a-z0-9-]{0,95}\.json$/u.test(name));
  const file = path.join(state.root, name);
  while (true) {
    state.active();
    try {
      const bytes = await readControllerToolFile(file, 16384),
        value: unknown = JSON.parse(bytes.toString("utf8"));
      assert.ok(isRecord(value) && value.binding === state.binding);
      state.active();
      return { value, bytes, file };
    } catch (error) {
      if (!["ENOENT", "EBUSY", "EACCES"].includes(errorCode(error) ?? "")) throw error;
    }
    await delay(50);
  }
}

export async function readWindowsOwnerWorkerRecord(
  state: { active: () => void },
  directory: string,
  name: "worker-ready" | "worker-result",
) {
  const marker = path.join(directory, name + ".complete"),
    file = path.join(directory, name + ".json");
  while (true) {
    state.active();
    try {
      const failure = await readControllerToolFile(
        path.join(directory, "worker-failure.json"),
        16384,
      );
      const observed: unknown = JSON.parse(failure.toString("utf8"));
      assert.ok(
        isRecord(observed) && observed.schema_version === 1 && observed.authority === "none",
      );
      throw new Error(
        "Original B worker refused; retain bounded worker-failure streams and exit evidence",
      );
    } catch (error) {
      if (!["ENOENT", "EBUSY", "EACCES"].includes(errorCode(error) ?? "")) throw error;
    }
    try {
      const info = await lstat(marker);
      assert.ok(info.isFile() && !info.isSymbolicLink() && info.nlink === 1 && info.size <= 64);
      // A fixed-size commit marker is pending until its complete 64-byte write.
      if (info.size === 64) {
        const expected = (await readControllerToolFile(marker, 64)).toString("ascii");
        assert.match(expected, /^[a-f0-9]{64}$/u);
        const bytes = await readControllerToolFile(file, 16384);
        assert.equal(hash(bytes), expected);
        const value: unknown = JSON.parse(bytes.toString("utf8"));
        assert.ok(isRecord(value) && value.schema_version === 1);
        state.active();
        return { value, files: [marker, file] };
      }
    } catch (error) {
      if (!["ENOENT", "EBUSY", "EACCES"].includes(errorCode(error) ?? "")) throw error;
    }
    await delay(25);
  }
}

export async function copyWindowsOwnerStageFile(
  state: { active: () => void },
  source: string,
  destination: string,
  maximum: number,
  expected: string,
) {
  state.active();
  const bytes = await readControllerToolFile(source, maximum);
  assert.equal(hash(bytes), expected);
  const handle = await open(
    destination,
    constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_SYNC,
    0o600,
  );
  try {
    await handle.writeFile(bytes);
    await handle.sync();
  } finally {
    await handle.close();
  }
  assert.ok((await readControllerToolFile(destination, maximum)).equals(bytes));
  state.active();
  return destination;
}

/** Original account handshake only. Admission and every custody bracket remain
 * with the calling production or separately held diagnostic wrapper. No receipt
 * or authority is constructed by this OS-protocol mechanism. */
export async function establishWindowsOwnerAccount(
  state: WindowsOwnerMechanismState,
  options: {
    toolsRoot: string;
    powershell: string;
    read: (name: string) => ReturnType<typeof readWindowsOwnerRecord>;
    remember: (files: string[]) => Promise<void>;
    write: (name: string, value: Record<string, unknown>) => void;
    inspectLineage: (pid: number, created: string, parent: number, image: string) => Promise<void>;
    inspectAccount: (enabled: boolean) => Promise<void>;
    recheck: () => Promise<void>;
  },
) {
  const ready = await options.read("owner-ready.json"),
    received = performance.now(),
    value = ready.value;
  assert.ok(
    Number.isSafeInteger(value.owner_pid) &&
      Number(value.owner_pid) > 0 &&
      typeof value.owner_created_filetime === "string" &&
      typeof value.broker_sid === "string" &&
      typeof value.sample_ticks === "string" &&
      typeof value.frequency === "number" &&
      value.bridge_root === path.join(state.root, "bridge"),
  );
  const pid = Number(value.owner_pid);
  assert.equal(windowsOwnerFiletime(readProcessIdentity(pid), pid), value.owner_created_filetime);
  assert.ok(state.supervisor && state.supervisor.pid);
  const supervisorIdentity = readProcessIdentity(state.supervisor.pid);
  assert.ok(supervisorIdentity);
  state.supervisor.identity = supervisorIdentity;
  await options.inspectLineage(
    pid,
    value.owner_created_filetime,
    state.supervisor.pid,
    options.powershell,
  );
  state.owner = {
    pid,
    created: value.owner_created_filetime,
    broker: value.broker_sid,
    bridge: String(value.bridge_root),
  };
  state.frequency = value.frequency;
  state.clockSample = value.sample_ticks;
  state.clockReceived = received;
  state.fullTicks = hostedWindowsOwnerDeadline(
    value.sample_ticks,
    value.frequency,
    state.deadline,
    received,
  );
  state.activeTicks = (BigInt(state.fullTicks) - 30n * BigInt(value.frequency)).toString();
  const bridgeFiles = [
    "native-qualification-account.cs.txt",
    "native-qualification-account-bridge.ps1",
  ].map((name) => path.join(state.owner.bridge, "scripts", name));
  for (const file of bridgeFiles)
    assert.ok(
      (await readControllerToolFile(file, 131072)).equals(
        await readControllerToolFile(
          path.join(options.toolsRoot, "scripts", path.basename(file)),
          131072,
        ),
      ),
    );
  await options.remember([ready.file, ...bridgeFiles]);
  options.write("owner-start.json", {
    active_deadline_ticks: state.activeTicks,
    full_deadline_ticks: state.fullTicks,
  });
  const account = await options.read("account-created.json");
  assert.ok(
    typeof account.value.sid === "string" &&
      /^S-1-5-21-[0-9-]+$/u.test(account.value.sid) &&
      account.value.name === "PortcoveNativeQual" &&
      account.value.description === `Portcove hosted native ${state.binding}` &&
      account.value.enabled === false &&
      account.value.owner_pid === pid &&
      account.value.owner_created_filetime === state.owner.created,
  );
  state.account = {
    sid: account.value.sid,
    description: String(account.value.description),
    profile: "",
  };
  await options.remember([account.file]);
  // Independent OS SID/disabled readback is required before this acknowledgment.
  await options.inspectAccount(false);
  options.write("account-ack.json", { account_sid: state.account.sid });
  const established = await options.read("account-ready.json");
  assert.equal(established.value.sid, state.account.sid);
  assert.ok(typeof established.value.profile_root === "string");
  state.account.profile = established.value.profile_root;
  await options.remember([established.file]);
  await options.recheck();
}
/** End of shared original account handshake. */

export type WindowsOwnerMechanismState = WindowsOwnerSupervisorState & {
  root: string;
  binding: string;
  deadline: number;
  owner: { pid: number; created: string; broker: string; bridge: string };
  frequency: number;
  clockSample: string;
  clockReceived: number;
  fullTicks: string;
  activeTicks: string;
  account: { sid: string; description: string; profile: string } | null;
};

type WindowsOwnerStageMechanism = {
  kind: "payload-signing" | "release-publication";
  directory: string;
  binding: Record<string, unknown>;
  workerRequestSha: string;
  bindingSha: string;
  station: { before: Buffer; proposed: Buffer } | null;
  worker?: { pid: number; created: string };
};
type WindowsOwnerStageMechanismOptions = {
  invocationId: string;
  active: () => void;
  recheck: () => Promise<void>;
  recheckStage: () => void;
  write: (name: string, value: Record<string, unknown>) => void;
  read: (name: string) => ReturnType<typeof readWindowsOwnerRecord>;
  workerRecord: (
    name: "worker-ready" | "worker-result",
  ) => ReturnType<typeof readWindowsOwnerWorkerRecord>;
  remember: (files: string[]) => Promise<void>;
  inspectAccount: (enabled: boolean) => Promise<void>;
  inspectLineage: (pid: number, created: string, parent: number, image: string) => Promise<void>;
  frame: (file: string, value: Record<string, unknown>) => void;
};
/** Shared original A/B start protocol only; callers retain receipts and custody. */
export async function startWindowsOwnerStageMechanism(
  state: WindowsOwnerMechanismState & { tools: { node: string } },
  stage: WindowsOwnerStageMechanism,
  options: WindowsOwnerStageMechanismOptions,
) {
  assert.ok(state.account);
  await options.recheck();
  options.recheckStage();
  options.write(stage.kind + "-start.json", {
    configuration_sha256: stage.binding.configuration_sha256,
    invocation_id: options.invocationId,
    worker_request_sha256: stage.workerRequestSha,
  });
  const record = await options.read(stage.kind + "-station.json");
  assert.equal(record.value.account_sid, state.account.sid);
  assert.equal(record.value.enabled, false);
  const before = await readControllerToolFile(
      path.join(stage.directory, "station-dacl-before.bin"),
      16384,
    ),
    proposed = await readControllerToolFile(
      path.join(stage.directory, "station-dacl-proposed.bin"),
      16384,
    );
  stage.station = { before, proposed };
  await options.remember([
    record.file,
    path.join(stage.directory, "station-dacl-before.bin"),
    path.join(stage.directory, "station-dacl-proposed.bin"),
  ]);
  await options.inspectAccount(false);
  options.write(stage.kind + "-enable.json", { account_sid: state.account.sid });
  const bridge = path.join(stage.directory, "bridge-state.json");
  while (true) {
    options.active();
    try {
      const raw: unknown = JSON.parse(
        (await readControllerToolFile(bridge, 65536)).toString("utf8"),
      );
      assert.ok(
        isRecord(raw) &&
          raw.invocation_id === options.invocationId &&
          raw.broker_pid === state.owner.pid &&
          raw.broker_created_filetime === state.owner.created &&
          raw.configuration_sha256 === stage.binding.configuration_sha256 &&
          raw.phase === "prepared",
      );
      break;
    } catch (error) {
      if (!["ENOENT", "EBUSY", "EACCES"].includes(errorCode(error) ?? "")) throw error;
    }
    await delay(50);
  }
  const launched = await options.read(stage.kind + "-worker.json");
  assert.ok(
    Number.isSafeInteger(launched.value.pid) &&
      Number(launched.value.pid) > 0 &&
      typeof launched.value.created_filetime === "string",
  );
  assert.equal(launched.value.owner_pid, state.owner.pid);
  assert.equal(launched.value.owner_created_filetime, state.owner.created);
  assert.equal(launched.value.image, state.tools.node);
  assert.equal(launched.value.request_sha256, stage.workerRequestSha);
  assert.ok(
    Array.isArray(launched.value.supervisor_job_pids) &&
      launched.value.supervisor_job_pids.includes(state.owner.pid) &&
      launched.value.supervisor_job_pids.includes(launched.value.pid),
  );
  const ready = await options.workerRecord("worker-ready");
  const pid = Number(launched.value.pid),
    created = launched.value.created_filetime;
  assert.equal(ready.value.pid, pid);
  assert.equal(ready.value.created_filetime, created);
  assert.equal(ready.value.owner_pid, state.owner.pid);
  assert.equal(ready.value.owner_created_filetime, state.owner.created);
  assert.equal(ready.value.invocation_id, options.invocationId);
  assert.equal(ready.value.stage, stage.kind);
  assert.equal(ready.value.request_sha256, stage.workerRequestSha);
  assert.equal(ready.value.binding_sha256, stage.bindingSha);
  await options.inspectLineage(pid, created, state.owner.pid, state.tools.node);
  await options.recheck();
  await options.inspectAccount(true);
  options.frame(path.join(stage.directory, "worker-start.json"), {
    schema_version: 1,
    pid,
    created_filetime: created,
    request_sha256: stage.workerRequestSha,
    binding_sha256: stage.bindingSha,
  });
  assert.equal(windowsOwnerFiletime(readProcessIdentity(pid), pid), created);
  stage.worker = { pid, created };
  await options.remember([launched.file, ...ready.files]);
  await options.inspectAccount(true);
  await options.recheck();
}
/** Shared original worker/bridge/account/station settlement; no native brand. */
export async function settleWindowsOwnerStageMechanism(
  state: WindowsOwnerMechanismState,
  stage: WindowsOwnerStageMechanism,
  options: WindowsOwnerStageMechanismOptions & { station: (before: Buffer) => Promise<void> },
) {
  assert.ok(state.account);
  options.active();
  assert.ok(stage.worker);
  const result = await options.workerRecord("worker-result");
  assert.equal(result.value.pid, stage.worker.pid);
  assert.equal(result.value.created_filetime, stage.worker.created);
  assert.equal(result.value.request_sha256, stage.workerRequestSha);
  assert.equal(result.value.invocation_id, options.invocationId);
  assert.equal(result.value.status, 0);
  assert.equal(result.value.authority, "none");
  while (true) {
    options.active();
    const identity = readProcessIdentity(stage.worker.pid);
    if (identity === null) break;
    assert.equal(windowsOwnerFiletime(identity, stage.worker.pid), stage.worker.created);
    await delay(25);
  }
  await options.remember(result.files);
  const client = new NativeAccountClient(
    stage.binding as unknown as ConstructorParameters<typeof NativeAccountClient>[0],
  );
  client.invoke("finish", "stage-finish");
  const settled = await options.read(stage.kind + "-settled.json");
  assert.equal(settled.value.account_sid, state.account.sid);
  assert.equal(settled.value.disabled, true);
  assert.equal(settled.value.station_restored, true);
  assert.equal(settled.value.group_empty, true);
  assert.equal(settled.value.harness_exit_code, 0);
  assert.equal(settled.value.harness_drained, true);
  assert.deepEqual(settled.value.broker_job_remaining_pids, [state.owner.pid]);
  await options.inspectAccount(false);
  assert.ok(stage.station);
  await options.station(stage.station.before);
  await options.recheck();
  await options.remember([settled.file]);
}
/** End of shared original A/B stage mechanisms. */
