import { errorMessage, errorCode, isRecord } from "./runtime-values.mts";
import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { link, lstat, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { performance } from "node:perf_hooks";

import { toolCachePaths } from "./tool-cache.mts";

export interface IdentityProbeResult {
  status: number | null;
  stdout: string | Buffer | null;
  stderr: string | Buffer | null;
  error?: NodeJS.ErrnoException;
}
export type IdentityProbeRunner = (
  command: string,
  args: readonly string[],
  options: { encoding: "utf8"; timeout: number; windowsHide: boolean },
) => IdentityProbeResult;
export interface ProcessIdentityOptions {
  platform?: string;
  spawnSync?: IdentityProbeRunner;
  readFileSync?: (file: string, encoding: "utf8") => string;
  processToken?: string | undefined;
}
export interface HeavyProcessRecord {
  pid: number;
  identity: string;
  process_token?: string | undefined;
  containment?: "windows-job" | "unix-watchdog" | undefined;
  cleanup_receipt?: string | undefined;
  tree_platform?: unknown;
}
export interface HeavyRustOwner {
  format_version: 1;
  token: string;
  process: HeavyProcessRecord;
  child: HeavyProcessRecord | null;
  created_at: string;
  workspace?: unknown;
  command?: unknown;
  capacity_aware?: unknown;
  external?: unknown;
}
export interface ChildRegistration {
  containment?: HeavyProcessRecord["containment"];
  cleanupReceipt?: string | undefined;
}
export interface HeavyRustMetadata {
  workspace?: string | null | undefined;
  command?: string | null | undefined;
  capacity_aware?: boolean;
}
export interface HeavyRustActivityOptions {
  inspectProcessIdentity?: typeof readProcessIdentity;
  inspectProcessTree?: (record: HeavyProcessRecord) => readonly unknown[];
  readCleanupReceipt?: (file: string, encoding: "utf8") => string;
}
export interface HeavyRustLockOptions extends HeavyRustActivityOptions {
  lockPath?: string;
  waitMilliseconds?: number | string;
  pollMilliseconds?: number;
  reportIntervalMilliseconds?: number;
  reportWait?: (message: string) => void;
  now?: () => number;
  sleep?: (milliseconds: number) => Promise<unknown>;
  inheritedToken?: string;
  processToken?: string;
  manageProcessTitle?: boolean;
  signal?: AbortSignal | undefined;
}
export interface HeavyRustLock {
  lockPath: string;
  owner: HeavyRustOwner;
  inherited: boolean;
  childEnvironment: NodeJS.ProcessEnv;
  registerChild: (
    child: { pid?: number | undefined },
    registration?: ChildRegistration,
  ) => Promise<HeavyProcessRecord | null | undefined>;
  release: () => Promise<void>;
}
interface ActiveRecord {
  kind: string;
  record: HeavyProcessRecord;
}
function causeCode(value: unknown) {
  return isRecord(value) ? errorCode(value.cause) : undefined;
}
function diagnosticText(value: unknown) {
  return String(value);
}

const waitEnvironmentName = "PORTCOVE_HEAVY_RUST_WAIT_MS";
const inheritedTokenEnvironmentName = "PORTCOVE_HEAVY_RUST_LOCK_TOKEN";
const processTokenEnvironmentName = "PORTCOVE_HEAVY_RUST_PROCESS_TOKEN";
const processTitleMarkerPrefix = "portcove-rust:";
const identityProbeTimeoutMilliseconds = 5_000;
const defaultWaitMilliseconds = 3_600_000;
const maximumWaitMilliseconds = 3_600_000;
const defaultPollMilliseconds = 5_000;
const defaultReportIntervalMilliseconds = 30_000;

export function heavyRustTestLockPath() {
  return path.join(toolCachePaths().sharedRoot, "locks", "heavy-rust-tests");
}

function parseWaitMilliseconds(value: unknown) {
  if (value === undefined || value === "") return defaultWaitMilliseconds;
  if (!/^\d+$/u.test(diagnosticText(value)))
    throw new Error(
      `${waitEnvironmentName} must be an integer from 0 through ${maximumWaitMilliseconds}`,
    );
  const milliseconds = Number(value);
  if (!Number.isSafeInteger(milliseconds) || milliseconds > maximumWaitMilliseconds)
    throw new Error(
      `${waitEnvironmentName} must be an integer from 0 through ${maximumWaitMilliseconds}`,
    );
  return milliseconds;
}

function runIdentityProbe(
  run: IdentityProbeRunner,
  command: string,
  args: readonly string[],
  pid: number,
  platform: string,
  timeoutMilliseconds = identityProbeTimeoutMilliseconds,
) {
  const inspected = run(command, args, {
    encoding: "utf8",
    timeout: timeoutMilliseconds,
    windowsHide: true,
  });
  if (inspected.error) {
    const timedOut = errorCode(inspected.error) === "ETIMEDOUT" ? " timed out" : " failed";
    throw Object.assign(
      new Error(`Could not inspect ${platform} process ${pid}: identity probe${timedOut}`, {
        cause: inspected.error,
      }),
      { code: "PORTCOVE_PROCESS_IDENTITY_UNAVAILABLE" },
    );
  }
  return inspected;
}

export function readProcessIdentity(
  pid: number,
  options: ProcessIdentityOptions = {},
): string | null {
  if (!Number.isInteger(pid) || pid < 1) return null;
  const platform = options.platform ?? process.platform;
  const run = options.spawnSync ?? spawnSync;
  const read = options.readFileSync ?? readFileSync;
  if (platform === "linux") {
    try {
      const stat = read(`/proc/${pid}/stat`, "utf8");
      const closing = stat.lastIndexOf(")");
      if (closing < 0) throw new Error("missing process name terminator");
      const fields = stat
        .slice(closing + 2)
        .trim()
        .split(/\s+/u);
      const startTicks = fields[19];
      const bootId = read("/proc/sys/kernel/random/boot_id", "utf8").trim();
      if (!startTicks || !bootId) throw new Error("missing process start or boot identity");
      return `linux:${bootId}:${pid}:${startTicks}`;
    } catch (error) {
      if (errorCode(error) === "ENOENT") return null;
      throw new Error(`Could not inspect Linux process ${pid}: ${errorMessage(error)}`, {
        cause: error,
      });
    }
  }
  if (platform === "win32") {
    const inspected = runIdentityProbe(
      run,
      "pwsh.exe",
      [
        "-NoLogo",
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        `$p=Get-CimInstance Win32_Process -Filter 'ProcessId = ${pid}'; if ($null -ne $p) { $p.CreationDate.ToUniversalTime().Ticks }`,
      ],
      pid,
      "Windows",
      15_000,
    );
    if (inspected.status !== 0)
      throw Object.assign(
        new Error(`Could not inspect Windows process ${pid}: ${String(inspected.stderr).trim()}`),
        { code: "PORTCOVE_PROCESS_IDENTITY_UNAVAILABLE" },
      );
    const started = String(inspected.stdout).trim();
    return started ? `win32:${pid}:${started}` : null;
  }
  if (platform === "darwin") {
    const processToken = options.processToken;
    if (!processToken) {
      const inspected = runIdentityProbe(
        run,
        "ps",
        ["-o", "lstart=", "-p", String(pid)],
        pid,
        "legacy Darwin",
      );
      if (inspected.status !== 0) return null;
      const started = String(inspected.stdout).trim().replace(/\s+/gu, " ");
      return started ? `darwin:${pid}:${started}` : null;
    }
    const inspected = runIdentityProbe(
      run,
      "ps",
      ["eww", "-o", "command=", "-p", String(pid)],
      pid,
      "Darwin",
    );
    if (inspected.status !== 0) return null;
    const command = String(inspected.stdout);
    const environmentMarker = `${processTokenEnvironmentName}=${processToken}`;
    const titleMarker = `${processTitleMarkerPrefix}${processToken}`;
    return command.includes(environmentMarker) || command.includes(titleMarker)
      ? `darwin:${pid}:${processToken}`
      : null;
  }
  throw new Error(`unsupported process-identity platform: ${platform}`);
}

function validProcess(record: unknown): record is HeavyProcessRecord {
  return (
    isRecord(record) &&
    typeof record.pid === "number" &&
    Number.isInteger(record.pid) &&
    record.pid > 0 &&
    typeof record.identity === "string" &&
    record.identity.length > 0 &&
    (record.process_token === undefined ||
      (typeof record.process_token === "string" && record.process_token.length > 0)) &&
    (record.containment === undefined ||
      record.containment === "windows-job" ||
      record.containment === "unix-watchdog") &&
    (record.cleanup_receipt === undefined ||
      (typeof record.cleanup_receipt === "string" && record.cleanup_receipt.length > 0)) &&
    (record.containment !== "unix-watchdog" ||
      (typeof record.cleanup_receipt === "string" && record.cleanup_receipt.length > 0))
  );
}

export function processTreeMembers(
  record: Pick<HeavyProcessRecord, "tree_platform"> & { pid?: number },
  options: { platform?: string } = {},
): never {
  const platform = options.platform ?? record.tree_platform ?? process.platform;
  throw new Error(
    `Legacy ${diagnosticText(platform)} descendant records cannot be reclaimed automatically; ` +
      "verify and remove the stale lock before retrying",
  );
}

async function ownerStoragePath(lockPath: string) {
  try {
    return (await lstat(lockPath)).isDirectory() ? path.join(lockPath, "owner.json") : lockPath;
  } catch (error) {
    if (errorCode(error) === "ENOENT") return lockPath;
    throw error;
  }
}

async function readOwner(lockPath: string): Promise<HeavyRustOwner> {
  const ownerPath = await ownerStoragePath(lockPath);
  let owner: unknown;
  try {
    owner = JSON.parse(await readFile(ownerPath, "utf8"));
  } catch (error) {
    throw new Error(`Heavy Rust test lock exists but its owner is unreadable: ${ownerPath}`, {
      cause: error,
    });
  }
  if (
    !isRecord(owner) ||
    owner.format_version !== 1 ||
    typeof owner.token !== "string" ||
    !owner.token ||
    !validProcess(owner.process) ||
    (owner.child !== null && !validProcess(owner.child)) ||
    typeof owner.created_at !== "string" ||
    Number.isNaN(Date.parse(owner.created_at))
  )
    throw new Error(`Heavy Rust test lock has invalid owner metadata: ${ownerPath}`);
  const checked: HeavyRustOwner = {
    ...owner,
    format_version: 1,
    token: owner.token,
    process: owner.process,
    child: owner.child,
    created_at: owner.created_at,
  };
  const childPath = `${lockPath}.child-${checked.token}`;
  try {
    const childRecord: unknown = JSON.parse(await readFile(childPath, "utf8"));
    if (
      !isRecord(childRecord) ||
      childRecord.format_version !== 1 ||
      childRecord.token !== owner.token ||
      !validProcess(childRecord.child)
    )
      throw new Error(`Heavy Rust test child metadata is invalid: ${childPath}`);
    checked.child = childRecord.child;
  } catch (error) {
    if (errorCode(error) !== "ENOENT") throw error;
  }
  try {
    checked.external = JSON.parse(await readFile(`${lockPath}.external-${owner.token}`, "utf8"));
  } catch (error) {
    if (errorCode(error) !== "ENOENT") throw error;
  }
  return checked;
}

// Passive observation only; admission and stale-record handling stay with the guard.
export const readHeavyRustLockOwner = readOwner;

function inspectRecord(
  record: HeavyProcessRecord,
  inspectProcessIdentity: typeof readProcessIdentity,
) {
  return inspectProcessIdentity(record.pid, { processToken: record.process_token });
}

function cleanupReceiptOutcome(
  record: HeavyProcessRecord,
  readReceipt: NonNullable<HeavyRustActivityOptions["readCleanupReceipt"]>,
) {
  try {
    if (!record.cleanup_receipt) return "invalid receipt";
    const value: unknown = JSON.parse(readReceipt(record.cleanup_receipt, "utf8"));
    const outcome = isRecord(value) ? value.outcome : undefined;
    return outcome === "quiescent" ? null : (outcome ?? "invalid receipt");
  } catch (error) {
    if (errorCode(error) === "ENOENT") return "pending";
    return `invalid: ${errorMessage(error)}`;
  }
}

function activeRecord(
  owner: HeavyRustOwner,
  inspectProcessIdentity: typeof readProcessIdentity,
  inspectProcessTree: NonNullable<HeavyRustActivityOptions["inspectProcessTree"]>,
  readReceipt: NonNullable<HeavyRustActivityOptions["readCleanupReceipt"]>,
): ActiveRecord | null {
  if (owner.external)
    return { kind: "external work awaiting quiescence proof", record: owner.process };
  for (const [kind, record] of [
    ["owner", owner.process],
    ["child", owner.child],
  ] as const) {
    if (!record) continue;
    const current = inspectRecord(record, inspectProcessIdentity);
    if (current === record.identity) return { kind, record };
    if (kind === "child" && record.tree_platform && inspectProcessTree(record).length > 0)
      return { kind: "child tree", record };
    if (kind === "child" && record.containment === "unix-watchdog") {
      const cleanup = cleanupReceiptOutcome(record, readReceipt);
      if (cleanup) return { kind: `Unix cleanup ${diagnosticText(cleanup)}`, record };
    }
    if (kind === "child" && record.containment === undefined && record.tree_platform === undefined)
      return { kind: "legacy child", record };
  }
  return null;
}

export function heavyRustOwnerActivity(
  owner: HeavyRustOwner,
  options: HeavyRustActivityOptions = {},
) {
  return activeRecord(
    owner,
    options.inspectProcessIdentity ?? readProcessIdentity,
    options.inspectProcessTree ?? processTreeMembers,
    options.readCleanupReceipt ?? readFileSync,
  );
}

function activeMessage(owner: HeavyRustOwner, active: ActiveRecord, waitMilliseconds: number) {
  const waited = waitMilliseconds > 0 ? ` after waiting ${waitMilliseconds}ms` : "";
  return (
    `Heavy Rust tests are already running${waited}: ${active.kind} PID ${active.record.pid}, ` +
    `workspace ${diagnosticText(owner.workspace ?? "unknown")}, command ${diagnosticText(owner.command ?? "unknown")}, ` +
    `since ${owner.created_at}. Retry after that supported Rust test command finishes.`
  );
}

function waitingMessage(
  owner: HeavyRustOwner,
  active: ActiveRecord,
  elapsedMilliseconds: number,
  waitMilliseconds: number,
) {
  return (
    `Waiting for the Heavy Rust validation slot: ${active.kind} PID ${active.record.pid}, ` +
    `workspace ${diagnosticText(owner.workspace ?? "unknown")}, command ${diagnosticText(owner.command ?? "unknown")}, ` +
    `since ${owner.created_at}; queued ${elapsedMilliseconds}ms of ${waitMilliseconds}ms.`
  );
}

async function publishChild(lockPath: string, token: string, child: HeavyProcessRecord) {
  const childPath = `${lockPath}.child-${token}`;
  const pending = `${childPath}.candidate-${randomUUID()}`;
  try {
    await writeFile(pending, `${JSON.stringify({ format_version: 1, token, child }, null, 2)}\n`, {
      flag: "wx",
    });
    await link(pending, childPath);
  } finally {
    await rm(pending, { force: true }).catch(() => {});
  }
}

async function publishOwner(lockPath: string, owner: HeavyRustOwner) {
  const pending = `${lockPath}.candidate-${owner.token}`;
  try {
    await writeFile(pending, `${JSON.stringify(owner, null, 2)}\n`, { flag: "wx" });
    await link(pending, lockPath);
  } finally {
    await rm(pending, { force: true }).catch(() => {});
  }
}

export async function releaseHeavyRustLock(lockPath: string, token: string) {
  let owner;
  try {
    owner = await readOwner(lockPath);
  } catch (error) {
    if (causeCode(error) === "ENOENT") return;
    throw error;
  }
  if (owner.token !== token)
    throw new Error("Heavy Rust test lock ownership changed before release; refusing removal");
  const released = `${lockPath}.released-${token}`;
  await rename(lockPath, released);
  await rm(released, { recursive: true, force: true });
  await rm(`${lockPath}.child-${token}`, { force: true });
}

async function updateOwnedChild(
  lockPath: string,
  token: string,
  child: { pid?: number | undefined },
  inspectProcessIdentity: typeof readProcessIdentity,
  processToken: string,
  registration: ChildRegistration,
) {
  const owner = await readOwner(lockPath);
  if (owner.token !== token)
    throw new Error("Heavy Rust test lock ownership changed before child registration");
  if (child.pid === undefined) return null;
  const identity = inspectProcessIdentity(child.pid, { processToken });
  if (!identity) return null;
  owner.child = {
    pid: child.pid,
    identity,
    process_token: processToken,
    containment: registration.containment,
    cleanup_receipt: registration.cleanupReceipt,
  };
  await publishChild(lockPath, token, owner.child);
  return owner.child;
}

export async function acquireHeavyRustTestLock(
  metadata: HeavyRustMetadata = {},
  options: HeavyRustLockOptions = {},
): Promise<HeavyRustLock> {
  const lockPath = path.resolve(options.lockPath ?? heavyRustTestLockPath());
  const inspectProcessIdentity = options.inspectProcessIdentity ?? readProcessIdentity;
  const inspectProcessTree = options.inspectProcessTree ?? ((record) => processTreeMembers(record));
  const readCleanupReceipt = options.readCleanupReceipt ?? readFileSync;
  const waitMilliseconds = parseWaitMilliseconds(
    options.waitMilliseconds ?? process.env[waitEnvironmentName],
  );
  const pollMilliseconds = options.pollMilliseconds ?? defaultPollMilliseconds;
  const reportIntervalMilliseconds =
    options.reportIntervalMilliseconds ?? defaultReportIntervalMilliseconds;
  const reportWait = options.reportWait ?? ((message) => console.error(message));
  const now = options.now ?? (() => performance.now());
  const sleep =
    options.sleep ??
    ((milliseconds) => new Promise<void>((resolve) => setTimeout(resolve, milliseconds)));
  const inheritedToken = options.inheritedToken ?? process.env[inheritedTokenEnvironmentName];
  if (inheritedToken) {
    const owner = await readOwner(lockPath);
    if (owner.token !== inheritedToken)
      throw new Error("Inherited Heavy Rust test lock token does not match the active owner");
    if (!activeRecord(owner, inspectProcessIdentity, inspectProcessTree, readCleanupReceipt))
      throw new Error("Inherited Heavy Rust test lock no longer has a matching live owner");
    return {
      lockPath,
      owner,
      inherited: true,
      childEnvironment: {
        [inheritedTokenEnvironmentName]: owner.token,
        [processTokenEnvironmentName]: owner.process.process_token,
      },
      registerChild: async () => undefined,
      release: async () => {},
    };
  }

  await mkdir(path.dirname(lockPath), { recursive: true });
  const started = now();
  const deadline = started + waitMilliseconds;
  let nextReport = started;
  let reportedOwnerToken: string | null = null;
  const processToken = options.processToken ?? randomUUID().replaceAll("-", "").slice(0, 16);
  const originalProcessTitle = process.title;
  process.env[processTokenEnvironmentName] = processToken;
  if (process.platform === "darwin" && options.manageProcessTitle !== false)
    process.title = `${processTitleMarkerPrefix}${processToken} ${originalProcessTitle}`;
  try {
    for (;;) {
      options.signal?.throwIfAborted();
      const token = randomUUID();
      const processIdentity = inspectProcessIdentity(process.pid, { processToken });
      if (!processIdentity)
        throw new Error(`Could not establish the current process identity for PID ${process.pid}`);
      const owner: HeavyRustOwner = {
        format_version: 1,
        token,
        process: { pid: process.pid, identity: processIdentity, process_token: processToken },
        child: null,
        created_at: new Date().toISOString(),
        workspace: metadata.workspace ?? null,
        command: metadata.command ?? null,
        capacity_aware: metadata.capacity_aware === true,
      };
      try {
        await publishOwner(lockPath, owner);
        if (reportedOwnerToken) {
          reportWait(
            `Acquired the Heavy Rust validation slot after ${Math.max(
              0,
              Math.round(now() - started),
            )}ms; starting ${metadata.command ?? "the requested command"}.`,
          );
        }
        return {
          lockPath,
          owner,
          inherited: false,
          childEnvironment: {
            [inheritedTokenEnvironmentName]: owner.token,
            [processTokenEnvironmentName]: processToken,
          },
          registerChild: (child, registration = {}) =>
            updateOwnedChild(
              lockPath,
              token,
              child,
              inspectProcessIdentity,
              processToken,
              registration,
            ),
          release: async () => {
            try {
              await releaseHeavyRustLock(lockPath, token);
            } finally {
              if (process.platform === "darwin" && options.manageProcessTitle !== false)
                process.title = originalProcessTitle;
            }
          },
        };
      } catch (error) {
        if (errorCode(error) !== "EEXIST") throw error;
        let existing;
        try {
          existing = await readOwner(lockPath);
        } catch (readError) {
          if (causeCode(readError) === "ENOENT" && now() < deadline) {
            await sleep(Math.min(pollMilliseconds, Math.max(1, deadline - now())));
            continue;
          }
          throw readError;
        }
        const active = activeRecord(
          existing,
          inspectProcessIdentity,
          inspectProcessTree,
          readCleanupReceipt,
        );
        if (active) {
          const observedAt = now();
          if (observedAt >= deadline)
            throw Object.assign(new Error(activeMessage(existing, active, waitMilliseconds)), {
              code: "PORTCOVE_RESOURCE_BUSY",
              owner: existing,
            });
          if (
            waitMilliseconds > 0 &&
            (existing.token !== reportedOwnerToken || observedAt >= nextReport)
          ) {
            reportWait(
              waitingMessage(
                existing,
                active,
                Math.max(0, Math.round(observedAt - started)),
                waitMilliseconds,
              ),
            );
            reportedOwnerToken = existing.token;
            nextReport = observedAt + reportIntervalMilliseconds;
          }
          await sleep(Math.min(pollMilliseconds, Math.max(1, deadline - observedAt)));
          continue;
        }
        const reclaim = `${lockPath}.reclaim-${existing.token}`;
        try {
          await mkdir(reclaim);
        } catch (error) {
          if (errorCode(error) !== "EEXIST") throw error;
          if (now() >= deadline)
            throw new Error(
              "Resource recovery is already owned; retain records and retry after recovery completes",
            );
          await sleep(Math.min(pollMilliseconds, Math.max(1, deadline - now())));
          continue;
        }
        // A delayed observer must never rename a successor's live reservation.
        const confirmed = await readOwner(lockPath).catch((error) => {
          if (causeCode(error) === "ENOENT") return null;
          throw error;
        });
        if (!confirmed || confirmed.token !== existing.token) continue;
        const stalePath = `${lockPath}.stale-${randomUUID()}`;
        try {
          await rename(lockPath, stalePath);
        } catch (renameError) {
          if (["ENOENT", "EEXIST"].some((code) => code === errorCode(renameError))) continue;
          throw renameError;
        }
        await rm(stalePath, { recursive: true, force: true });
        await rm(`${lockPath}.child-${existing.token}`, { force: true });
      }
    }
  } catch (error) {
    if (process.platform === "darwin" && options.manageProcessTitle !== false)
      process.title = originalProcessTitle;
    throw error;
  }
}

export const heavyRustLockTiming = Object.freeze({
  defaultWaitMilliseconds,
  maximumWaitMilliseconds,
  defaultPollMilliseconds,
  defaultReportIntervalMilliseconds,
});
