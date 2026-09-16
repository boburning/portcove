import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";

import { toolCachePaths } from "./tool-cache.mjs";

const waitEnvironmentName = "PORTCOVE_HEAVY_RUST_WAIT_MS";
const inheritedTokenEnvironmentName = "PORTCOVE_HEAVY_RUST_LOCK_TOKEN";

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
      throw new Error(`Could not inspect Linux process ${pid}: ${error.message}`, { cause: error });
    }
  }
  if (platform === "win32") {
    const inspected = run(
      "powershell.exe",
      [
        "-NoLogo",
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        `$p=Get-CimInstance Win32_Process -Filter 'ProcessId = ${pid}'; if ($null -ne $p) { $p.CreationDate.ToUniversalTime().Ticks }`,
      ],
      { encoding: "utf8", windowsHide: true },
    );
    if (inspected.error) throw inspected.error;
    if (inspected.status !== 0)
      throw new Error(
        `Could not inspect Windows process ${pid}: ${String(inspected.stderr).trim()}`,
      );
    const started = String(inspected.stdout).trim();
    return started ? `win32:${pid}:${started}` : null;
  }
  if (platform === "darwin") {
    const inspected = run("ps", ["-o", "lstart=", "-p", String(pid)], {
      encoding: "utf8",
      windowsHide: true,
    });
    if (inspected.error) throw inspected.error;
    if (inspected.status !== 0) return null;
    const started = String(inspected.stdout).trim().replace(/\s+/gu, " ");
    return started ? `darwin:${pid}:${started}` : null;
  }
  throw new Error(`unsupported process-identity platform: ${platform}`);
}

function validProcess(record) {
  return (
    record &&
    Number.isInteger(record.pid) &&
    record.pid > 0 &&
    typeof record.identity === "string" &&
    record.identity.length > 0
  );
}

async function readOwner(lockPath) {
  const ownerPath = path.join(lockPath, "owner.json");
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
  return owner;
}

function activeRecord(owner, inspectProcessIdentity) {
  for (const [kind, record] of [
    ["owner", owner.process],
    ["child", owner.child],
  ]) {
    if (!record) continue;
    const current = inspectProcessIdentity(record.pid);
    if (current === record.identity) return { kind, record };
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
  await rm(released, { recursive: true });
}

async function updateOwnedChild(lockPath, token, child, inspectProcessIdentity) {
  const owner = await readOwner(lockPath);
  if (owner.token !== token)
    throw new Error("Heavy Rust test lock ownership changed before child registration");
  const identity = inspectProcessIdentity(child.pid);
  if (!identity)
    throw new Error(`Heavy Rust test child PID ${child.pid} exited before it could be registered`);
  owner.child = { pid: child.pid, identity };
  await writeFile(path.join(lockPath, "owner.json"), `${JSON.stringify(owner, null, 2)}\n`);
  return owner.child;
}

export async function acquireHeavyRustTestLock(metadata = {}, options = {}) {
  const lockPath = path.resolve(options.lockPath ?? heavyRustTestLockPath());
  const inspectProcessIdentity = options.inspectProcessIdentity ?? readProcessIdentity;
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
    if (!activeRecord(owner, inspectProcessIdentity))
      throw new Error("Inherited Heavy Rust test lock no longer has a matching live owner");
    return {
      lockPath,
      owner,
      inherited: true,
      childEnvironment: { [inheritedTokenEnvironmentName]: owner.token },
      registerChild: async () => {},
      release: async () => {},
    };
  }

  await mkdir(path.dirname(lockPath), { recursive: true });
  const deadline = now() + waitMilliseconds;
  for (;;) {
    const token = randomUUID();
    const processIdentity = inspectProcessIdentity(process.pid);
    if (!processIdentity)
      throw new Error(`Could not establish the current process identity for PID ${process.pid}`);
    const owner = {
      format_version: 1,
      token,
      process: { pid: process.pid, identity: processIdentity },
      child: null,
      created_at: new Date().toISOString(),
      workspace: metadata.workspace ?? null,
      command: metadata.command ?? null,
    };
    try {
      await mkdir(lockPath);
      try {
        await writeFile(path.join(lockPath, "owner.json"), `${JSON.stringify(owner, null, 2)}\n`, {
          flag: "wx",
        });
      } catch (error) {
        await rm(lockPath, { recursive: true }).catch(() => {});
        throw error;
      }
      return {
        lockPath,
        owner,
        inherited: false,
        childEnvironment: { [inheritedTokenEnvironmentName]: owner.token },
        registerChild: (child) => updateOwnedChild(lockPath, token, child, inspectProcessIdentity),
        release: () => releaseOwnedLock(lockPath, token),
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
      const active = activeRecord(existing, inspectProcessIdentity);
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
      await rm(stalePath, { recursive: true });
    }
  }
}

export const heavyRustLockEnvironment = Object.freeze({
  inheritedToken: inheritedTokenEnvironmentName,
  waitMilliseconds: waitEnvironmentName,
});
