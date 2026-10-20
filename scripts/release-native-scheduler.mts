/** The fixed local loader joins this observation to protected setup custody.
 * A task description or this readback alone never grants native execution. */
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { lstat, open } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { isRecord } from "./runtime-values.mts";
import { releaseCanonicalDigest as digest } from "./release-canonical.mts";

function exact(value: unknown, keys: string): asserts value is Record<string, unknown> {
  if (!isRecord(value) || Object.keys(value).sort().join(",") !== keys)
    throw new Error("native scheduler exact schema differs");
}
function text(value: unknown, limit = 2048) {
  if (
    typeof value !== "string" ||
    !value ||
    Buffer.byteLength(value) > limit ||
    Array.from(value).some(
      (character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127,
    )
  )
    throw new Error("native scheduler fixed text differs");
  return value;
}
function sha(value: unknown) {
  const result = text(value, 64);
  if (!/^[a-f0-9]{64}$/u.test(result)) throw new Error("native scheduler digest differs");
  return result;
}
function winPath(value: unknown) {
  const result = text(value, 1024);
  if (
    !/^[A-Za-z]:\\/u.test(result) ||
    result.slice(2).includes(":") ||
    result.includes("%") ||
    result.split(/[\\/]/u).some((part) => part === ".." || part === ".")
  )
    throw new Error("native scheduler requires a fixed local path");
  return result;
}
function positive(value: unknown) {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1 || value > 2147483647)
    throw new Error("native scheduler PID differs");
  return value;
}
function processIdentity(value: unknown) {
  exact(value, "command_line,created_filetime,image,owner_sid,parent_pid,pid");
  const created = text(value.created_filetime, 20),
    owner = text(value.owner_sid, 184);
  if (!/^[1-9][0-9]{0,19}$/u.test(created) || !/^S-1-[0-9-]+$/u.test(owner))
    throw new Error("native scheduler process creation/owner differs");
  return {
    pid: positive(value.pid),
    parent_pid: positive(value.parent_pid),
    created_filetime: created,
    image: winPath(value.image),
    command_line: text(value.command_line, 8192),
    owner_sid: owner,
  };
}
function inspectExpected(raw: unknown) {
  exact(
    raw,
    "action,action_sha256,broker_sid,helper_sha256,powershell,protected_paths,task_path,task_security_descriptor_sha256,task_xml_sha256",
  );
  const taskPath = text(raw.task_path, 184),
    broker = text(raw.broker_sid, 184);
  if (
    !/^\\[A-Za-z0-9_\\-]{1,180}$/u.test(taskPath) ||
    !/^S-1-5-21-(?:[0-9]+-){3}[0-9]+$/u.test(broker)
  )
    throw new Error("native scheduler fixed task/broker differs");
  exact(raw.action, "arguments,path,working_directory");
  const action = {
    path: winPath(raw.action.path),
    arguments: text(raw.action.arguments, 8192),
    working_directory: winPath(raw.action.working_directory),
  };
  if (action.arguments.includes("%"))
    throw new Error("native scheduler action expands ambient variables");
  exact(raw.powershell, "path,sha256");
  exact(raw.protected_paths, "authorities,boundary,capture,controller,descriptor,installation");
  const protectedPaths = Object.fromEntries(
    Object.entries(raw.protected_paths).map(([key, value]) => [key, winPath(value)]),
  );
  if (new Set(Object.values(protectedPaths).map((value) => value.toLowerCase())).size !== 6)
    throw new Error("native scheduler custody paths overlap");
  return {
    task_path: taskPath,
    broker_sid: broker,
    task_xml_sha256: sha(raw.task_xml_sha256),
    task_security_descriptor_sha256: sha(raw.task_security_descriptor_sha256),
    helper_sha256: sha(raw.helper_sha256),
    action,
    action_sha256: sha(raw.action_sha256),
    protected_paths: protectedPaths,
    powershell: { path: winPath(raw.powershell.path), sha256: sha(raw.powershell.sha256) },
  };
}

/** Integrity only; no imported observation can enter the actual readback map. */
export function inspectNativeSchedulerObservation(
  rawExpected: unknown,
  raw: unknown,
  parentPid: number,
) {
  const expected = inspectExpected(structuredClone(rawExpected));
  exact(raw, "chain,current_sid,custody,elevated,observed_at,reader,schema_version,task");
  if (raw.schema_version !== 1 || raw.current_sid !== expected.broker_sid || raw.elevated !== false)
    throw new Error("native scheduler reader identity/elevation differs");
  exact(raw.custody, "authorities,boundary,capture,controller,descriptor,installation");
  for (const [key, pathname] of Object.entries(expected.protected_paths)) {
    const observed = raw.custody[key];
    exact(observed, "directory,owner_sid,path,protected");
    const directory = key === "capture" || key === "controller";
    if (
      observed.path !== pathname ||
      observed.owner_sid !== expected.broker_sid ||
      observed.directory !== directory ||
      typeof observed.protected !== "boolean" ||
      (directory && !observed.protected)
    )
      throw new Error("native scheduler actual protected path custody differs");
  }
  exact(
    raw.task,
    "action,enabled,instance,path,principal,security_descriptor_sha256,security_owner_sid,settings,state,xml_sha256",
  );
  const task = raw.task;
  if (
    task.path !== expected.task_path ||
    task.xml_sha256 !== expected.task_xml_sha256 ||
    task.security_descriptor_sha256 !== expected.task_security_descriptor_sha256 ||
    task.security_owner_sid !== expected.broker_sid ||
    task.enabled !== true ||
    task.state !== 4 ||
    digest(task.action) !== digest(expected.action)
  )
    throw new Error("native scheduler task/action/XML differs");
  exact(task.principal, "logon_type,run_level,user_id");
  // InteractiveToken runs in the selected broker's existing ordinary session.
  if (
    task.principal.user_id !== expected.broker_sid ||
    task.principal.logon_type !== 3 ||
    task.principal.run_level !== 0
  )
    throw new Error("native scheduler principal is not the fixed ordinary broker");
  exact(task.settings, "execution_time_limit,multiple_instances");
  if (task.settings.multiple_instances !== 2 || task.settings.execution_time_limit !== "PT35M")
    throw new Error("native scheduler concurrency/deadline differs");
  exact(task.instance, "current_action,engine_pid,guid,state");
  const instance = task.instance;
  if (
    typeof instance.guid !== "string" ||
    !/^\{[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}\}$/iu.test(instance.guid) ||
    instance.state !== 4 ||
    typeof instance.current_action !== "string" ||
    instance.current_action.length > 1024
  )
    throw new Error("native scheduler running instance differs");
  const engine = positive(instance.engine_pid),
    reader = processIdentity(raw.reader);
  if (
    reader.parent_pid !== parentPid ||
    reader.owner_sid !== expected.broker_sid ||
    reader.image.toLowerCase() !== expected.powershell.path.toLowerCase()
  )
    throw new Error("native scheduler helper is not the actual ordinary parent's child");
  if (!Array.isArray(raw.chain) || raw.chain.length < 2 || raw.chain.length > 16)
    throw new Error("native scheduler ancestry is unavailable or exceeds bound");
  const chain = raw.chain.map(processIdentity);
  const first = chain[0]!;
  const commandMatches =
    first.command_line === `"${expected.action.path}" ${expected.action.arguments}` ||
    (!expected.action.path.includes(" ") &&
      first.command_line === `${expected.action.path} ${expected.action.arguments}`);
  if (
    first.pid !== parentPid ||
    first.owner_sid !== expected.broker_sid ||
    first.image.toLowerCase() !== expected.action.path.toLowerCase() ||
    !commandMatches ||
    chain.at(-1)!.pid !== engine
  )
    throw new Error("native scheduler actual parent/action/engine does not match");
  const seen = new Set<number>();
  for (let index = 0; index < chain.length; index++) {
    const current = chain[index]!;
    if (seen.has(current.pid)) throw new Error("native scheduler ancestry repeats");
    seen.add(current.pid);
    const ancestor = chain[index + 1];
    if (
      ancestor &&
      (current.parent_pid !== ancestor.pid ||
        BigInt(ancestor.created_filetime) > BigInt(current.created_filetime))
    )
      throw new Error("native scheduler ancestry was replaced or disconnected");
    if (index < chain.length - 1 && current.owner_sid !== expected.broker_sid)
      throw new Error("native scheduler intermediate process has another owner");
  }
  const observed = text(raw.observed_at, 40);
  if (
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{7}(?:Z|\+00:00)$/u.test(observed) ||
    !Number.isFinite(Date.parse(observed))
  )
    throw new Error("native scheduler observation time differs");
  return {
    schema_version: 1 as const,
    task: structuredClone(task),
    reader,
    chain,
    custody: structuredClone(raw.custody),
    current_sid: expected.broker_sid,
    elevated: false as const,
    observed_at: observed,
    scope: "scheduler-observation-only" as const,
    authority: "none" as const,
  };
}

export const nativeSchedulerNodeMaximumBytes = 128 * 1024 * 1024;

/** Bounded byte identity only; this helper grants no tool or scheduler authority. */
export async function readNativeSchedulerToolDigest(filename: string, limit: number) {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 256 * 1024 * 1024)
    throw new Error("native scheduler tool read bound differs");
  const before = await lstat(filename);
  if (!before.isFile() || before.isSymbolicLink() || before.size < 1 || before.size > limit)
    throw new Error("native scheduler fixed reader/runtime file differs");
  const handle = await open(filename, "r");
  try {
    const hash = createHash("sha256"),
      block = Buffer.alloc(65536);
    let total = 0;
    for (;;) {
      const read = await handle.read(block, 0, Math.min(block.length, limit + 1 - total), null);
      if (!read.bytesRead) break;
      total += read.bytesRead;
      if (total > limit) throw new Error("native scheduler tool exceeds bound");
      hash.update(block.subarray(0, read.bytesRead));
    }
    const after = await handle.stat(),
      current = await lstat(filename);
    if (
      before.dev !== after.dev ||
      before.ino !== after.ino ||
      before.size !== after.size ||
      before.mtimeMs !== after.mtimeMs ||
      current.dev !== after.dev ||
      current.ino !== after.ino ||
      current.isSymbolicLink()
    )
      throw new Error("native scheduler reader/runtime changed during hashing");
    return hash.digest("hex");
  } finally {
    await handle.close();
  }
}
const actual = new WeakMap<
  object,
  {
    expected: ReturnType<typeof inspectExpected>;
    observation: ReturnType<typeof inspectNativeSchedulerObservation>;
  }
>();

/** Actual fixed helper only, credential-free and read-only. The installed task
 * and protected descriptor still require their separate initial setup grant. */
export async function observeActualNativeScheduler(rawExpected: unknown) {
  if (process.platform !== "win32" || process.env.GITHUB_ACTIONS === "true")
    throw new Error("native scheduler requires its installed ordinary Windows parent");
  const expected = inspectExpected(structuredClone(rawExpected));
  const systemRoot = process.env.SystemRoot;
  if (
    !systemRoot ||
    expected.powershell.path.toLowerCase() !==
      path.win32.join(systemRoot, "System32/WindowsPowerShell/v1.0/powershell.exe").toLowerCase()
  )
    throw new Error("native scheduler reader requires the fixed inbox Windows PowerShell route");
  const helper = fileURLToPath(new URL("./read-native-scheduler.ps1", import.meta.url));
  if (
    path
      .resolve(expected.protected_paths.controller!, "scripts/read-native-scheduler.ps1")
      .toLowerCase() !== helper.toLowerCase()
  )
    throw new Error("native scheduler reader is outside the configured protected controller");
  const guard = async () => {
    if (
      (await readNativeSchedulerToolDigest(helper, 128 * 1024)) !== expected.helper_sha256 ||
      (await readNativeSchedulerToolDigest(expected.powershell.path, 64 * 1024 * 1024)) !==
        expected.powershell.sha256 ||
      (await readNativeSchedulerToolDigest(process.execPath, nativeSchedulerNodeMaximumBytes)) !==
        expected.action_sha256 ||
      (await readNativeSchedulerToolDigest(
        expected.action.path,
        nativeSchedulerNodeMaximumBytes,
      )) !== expected.action_sha256
    )
      throw new Error("native scheduler helper/runtime identity changed");
  };
  await guard();
  const result = spawnSync(
    expected.powershell.path,
    [
      "-NoProfile",
      "-NonInteractive",
      "-File",
      helper,
      "-TaskPath",
      expected.task_path,
      "-ParentProcessId",
      String(process.pid),
      "-ProtectedPathsBase64",
      Buffer.from(JSON.stringify(expected.protected_paths)).toString("base64"),
    ],
    {
      encoding: "utf8",
      windowsHide: true,
      timeout: 15000,
      maxBuffer: 128 * 1024,
      env: { SystemRoot: process.env.SystemRoot, PATH: path.dirname(expected.powershell.path) },
    },
  );
  if (result.error || result.status !== 0 || result.signal || result.stderr.trim())
    throw new Error("native scheduler readback failed; no authority established");
  const observation = inspectNativeSchedulerObservation(
    expected,
    JSON.parse(result.stdout),
    process.pid,
  );
  await guard();
  const receipt = Object.freeze({
    schema_version: 1,
    observation_sha256: digest(observation),
    scope: "scheduler-observation-only",
    authority: "none",
  });
  actual.set(receipt, { expected, observation: structuredClone(observation) });
  return receipt;
}
export function requireActualNativeSchedulerObservation(receipt: object) {
  const retained = actual.get(receipt);
  if (!retained) throw new Error("actual native scheduler readback provenance unavailable");
  return structuredClone(retained.observation);
}
