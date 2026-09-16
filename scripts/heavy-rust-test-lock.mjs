import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { link, lstat, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";

import { toolCachePaths } from "./tool-cache.mjs";

const waitEnvironmentName = "PORTCOVE_HEAVY_RUST_WAIT_MS";
const inheritedTokenEnvironmentName = "PORTCOVE_HEAVY_RUST_LOCK_TOKEN";
const processTokenEnvironmentName = "PORTCOVE_HEAVY_RUST_PROCESS_TOKEN";
const processTitleMarkerPrefix = "portcove-rust:";
const identityProbeTimeoutMilliseconds = 5_000;

export function heavyRustTestLockPath() {
  return path.join(toolCachePaths().sharedRoot, "locks", "heavy-rust-tests");
}

function parseWaitMilliseconds(value) {
  if (value === undefined || value === "") return 5_000;
  if (!/^\d+$/u.test(String(value)))
    throw new Error(`${waitEnvironmentName} must be an integer from 0 through 60000`);
  const milliseconds = Number(value);
  if (!Number.isSafeInteger(milliseconds) || milliseconds > 60_000)
    throw new Error(`${waitEnvironmentName} must be an integer from 0 through 60000`);
  return milliseconds;
}

function runIdentityProbe(run, command, args, pid, platform) {
  const inspected = run(command, args, {
    encoding: "utf8",
    timeout: identityProbeTimeoutMilliseconds,
    windowsHide: true,
  });
  if (inspected.error) {
    const timedOut = inspected.error.code === "ETIMEDOUT" ? " timed out" : " failed";
    throw new Error(`Could not inspect ${platform} process ${pid}: identity probe${timedOut}`, {
      cause: inspected.error,
    });
  }
  return inspected;
}

export function readProcessIdentity(pid, options = {}) {
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
      if (error.code === "ENOENT") return null;
      throw new Error(`Could not inspect Linux process ${pid}: ${error.message}`, {
        cause: error,
      });
    }
  }
  if (platform === "win32") {
    const inspected = runIdentityProbe(
      run,
      "powershell.exe",
      [
        "-NoLogo",
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        `$p=Get-CimInstance Win32_Process -Filter 'ProcessId = ${pid}'; if ($null -ne $p) { $p.CreationDate.ToUniversalTime().Ticks }`,
      ],
      pid,
      "Windows",
    );
    if (inspected.status !== 0)
      throw new Error(
        `Could not inspect Windows process ${pid}: ${String(inspected.stderr).trim()}`,
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

function validProcess(record) {
  return (
    record &&
    Number.isInteger(record.pid) &&
    record.pid > 0 &&
    typeof record.identity === "string" &&
    record.identity.length > 0 &&
    (record.process_token === undefined ||
      (typeof record.process_token === "string" && record.process_token.length > 0))
  );
}

export function processTreeMembers(record, options = {}) {
  const platform = options.platform ?? record.tree_platform ?? process.platform;
  throw new Error(
    `Legacy ${platform} descendant records cannot be reclaimed automatically; ` +
      "verify and remove the stale lock before retrying",
  );
}

async function ownerStoragePath(lockPath) {
  try {
    return (await lstat(lockPath)).isDirectory() ? path.join(lockPath, "owner.json") : lockPath;
  } catch (error) {
    if (error.code === "ENOENT") return lockPath;
    throw error;
  }
}

async function readOwner(lockPath) {
  const ownerPath = await ownerStoragePath(lockPath);
  let owner;
  try {
    owner = JSON.parse(await readFile(ownerPath, "utf8"));
  } catch (error) {
    throw new Error(`Heavy Rust test lock exists but its owner is unreadable: ${ownerPath}`, {
      cause: error,
    });
  }
  if (
    owner?.format_version !== 1 ||
    typeof owner.token !== "string" ||
    !owner.token ||
    !validProcess(owner.process) ||
    (owner.child !== null && !validProcess(owner.child)) ||
    Number.isNaN(Date.parse(owner.created_at))
  )
    throw new Error(`Heavy Rust test lock has invalid owner metadata: ${ownerPath}`);
  const childPath = `${lockPath}.child-${owner.token}`;
  try {
    const childRecord = JSON.parse(await readFile(childPath, "utf8"));
    if (
      childRecord?.format_version !== 1 ||
      childRecord.token !== owner.token ||
      !validProcess(childRecord.child)
    )
      throw new Error(`Heavy Rust test child metadata is invalid: ${childPath}`);
    owner.child = childRecord.child;
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  return owner;
}

function inspectRecord(record, inspectProcessIdentity) {
  return inspectProcessIdentity(record.pid, { processToken: record.process_token });
}

function activeRecord(owner, inspectProcessIdentity, inspectProcessTree) {
  for (const [kind, record] of [
    ["owner", owner.process],
    ["child", owner.child],
  ]) {
    if (!record) continue;
    const current = inspectRecord(record, inspectProcessIdentity);
    if (current === record.identity) return { kind, record };
    if (kind === "child" && record.tree_platform && inspectProcessTree(record).length > 0)
      return { kind: "child tree", record };
  }
  return null;
}

function activeMessage(owner, active, waitMilliseconds) {
  const waited = waitMilliseconds > 0 ? ` after waiting ${waitMilliseconds}ms` : "";
  return (
    `Heavy Rust tests are already running${waited}: ${active.kind} PID ${active.record.pid}, ` +
    `workspace ${owner.workspace ?? "unknown"}, command ${owner.command ?? "unknown"}, ` +
    `since ${owner.created_at}. Retry after that supported Rust test command finishes.`
  );
}

async function publishChild(lockPath, token, child) {
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

async function publishOwner(lockPath, owner) {
  const pending = `${lockPath}.candidate-${owner.token}`;
  try {
    await writeFile(pending, `${JSON.stringify(owner, null, 2)}\n`, { flag: "wx" });
    await link(pending, lockPath);
  } finally {
    await rm(pending, { force: true }).catch(() => {});
  }
}

async function releaseOwnedLock(lockPath, token) {
  let owner;
  try {
    owner = await readOwner(lockPath);
  } catch (error) {
    if (error.cause?.code === "ENOENT") return;
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
  lockPath,
  token,
  child,
  inspectProcessIdentity,
  processToken,
  treePlatform,
) {
  const owner = await readOwner(lockPath);
  if (owner.token !== token)
    throw new Error("Heavy Rust test lock ownership changed before child registration");
  const identity = inspectProcessIdentity(child.pid, { processToken });
  if (!identity) return null;
  owner.child = {
    pid: child.pid,
    identity,
    process_token: processToken,
    tree_platform: treePlatform,
  };
  await publishChild(lockPath, token, owner.child);
  return owner.child;
}

export async function acquireHeavyRustTestLock(metadata = {}, options = {}) {
  const lockPath = path.resolve(options.lockPath ?? heavyRustTestLockPath());
  const inspectProcessIdentity = options.inspectProcessIdentity ?? readProcessIdentity;
  const inspectProcessTree = options.inspectProcessTree ?? ((record) => processTreeMembers(record));
  const waitMilliseconds = parseWaitMilliseconds(
    options.waitMilliseconds ?? process.env[waitEnvironmentName],
  );
  const pollMilliseconds = options.pollMilliseconds ?? 250;
  const now = options.now ?? Date.now;
  const sleep =
    options.sleep ??
    ((milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)));
  const inheritedToken = options.inheritedToken ?? process.env[inheritedTokenEnvironmentName];
  if (inheritedToken) {
    const owner = await readOwner(lockPath);
    if (owner.token !== inheritedToken)
      throw new Error("Inherited Heavy Rust test lock token does not match the active owner");
    if (!activeRecord(owner, inspectProcessIdentity, inspectProcessTree))
      throw new Error("Inherited Heavy Rust test lock no longer has a matching live owner");
    return {
      lockPath,
      owner,
      inherited: true,
      childEnvironment: {
        [inheritedTokenEnvironmentName]: owner.token,
        [processTokenEnvironmentName]: owner.process.process_token,
      },
      registerChild: async () => {},
      release: async () => {},
    };
  }

  await mkdir(path.dirname(lockPath), { recursive: true });
  const deadline = now() + waitMilliseconds;
  const processToken = randomUUID().replaceAll("-", "").slice(0, 16);
  const originalProcessTitle = process.title;
  process.env[processTokenEnvironmentName] = processToken;
  if (process.platform === "darwin")
    process.title = `${processTitleMarkerPrefix}${processToken} ${originalProcessTitle}`;
  try {
    for (;;) {
      const token = randomUUID();
      const processIdentity = inspectProcessIdentity(process.pid, { processToken });
      if (!processIdentity)
        throw new Error(`Could not establish the current process identity for PID ${process.pid}`);
      const owner = {
        format_version: 1,
        token,
        process: { pid: process.pid, identity: processIdentity, process_token: processToken },
        child: null,
        created_at: new Date().toISOString(),
        workspace: metadata.workspace ?? null,
        command: metadata.command ?? null,
      };
      try {
        await publishOwner(lockPath, owner);
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
              registration.platform === null
                ? undefined
                : (registration.platform ?? process.platform),
            ),
          release: async () => {
            try {
              await releaseOwnedLock(lockPath, token);
            } finally {
              if (process.platform === "darwin") process.title = originalProcessTitle;
            }
          },
        };
      } catch (error) {
        if (error.code !== "EEXIST") throw error;
        let existing;
        try {
          existing = await readOwner(lockPath);
        } catch (readError) {
          if (readError.cause?.code === "ENOENT" && now() < deadline) {
            await sleep(Math.min(pollMilliseconds, Math.max(1, deadline - now())));
            continue;
          }
          throw readError;
        }
        const active = activeRecord(existing, inspectProcessIdentity, inspectProcessTree);
        if (active) {
          if (now() >= deadline) throw new Error(activeMessage(existing, active, waitMilliseconds));
          await sleep(Math.min(pollMilliseconds, Math.max(1, deadline - now())));
          continue;
        }
        const stalePath = `${lockPath}.stale-${randomUUID()}`;
        try {
          await rename(lockPath, stalePath);
        } catch (renameError) {
          if (["ENOENT", "EEXIST"].includes(renameError.code)) continue;
          throw renameError;
        }
        await rm(stalePath, { recursive: true, force: true });
        await rm(`${lockPath}.child-${existing.token}`, { force: true });
      }
    }
  } catch (error) {
    if (process.platform === "darwin") process.title = originalProcessTitle;
    throw error;
  }
}

export const heavyRustLockEnvironment = Object.freeze({
  inheritedToken: inheritedTokenEnvironmentName,
  processToken: processTokenEnvironmentName,
  waitMilliseconds: waitEnvironmentName,
});
