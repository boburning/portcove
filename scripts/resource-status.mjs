import { lstat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  heavyRustTestLockPath,
  readHeavyRustLockOwner,
  readProcessIdentity,
} from "./heavy-rust-test-lock.mjs";
import { nativeSessionLockPath } from "./native-session-lock.mjs";
import { readProcessLockOwner, isProcessAlive } from "./process-lock.mjs";
import { renderBoundedSummary } from "./report-summary.mjs";

function inspectRecord(role, record, inspectIdentity) {
  if (!record) return null;
  const observedIdentity = inspectIdentity(record.pid, { processToken: record.process_token });
  return {
    role,
    pid: record.pid,
    expectedIdentity: record.identity,
    observedIdentity,
    verification:
      observedIdentity === record.identity
        ? "verified-live"
        : observedIdentity === null
          ? "recorded-process-absent"
          : "identity-mismatch",
  };
}

async function observe(resource, lockPath, readOwner, inspect) {
  const base = { resource, observedAt: new Date().toISOString(), verification: "unknown" };
  try {
    try {
      await lstat(lockPath);
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
      return {
        ...base,
        observation: "missing",
        reason: "No record observed; this does not establish resource availability",
      };
    }
    const owner = await readOwner(lockPath);
    const observation = inspect(owner);
    const after = await readOwner(lockPath);
    if (JSON.stringify(owner) !== JSON.stringify(after))
      return { ...base, observation: "changed", reason: "Record changed during observation" };
    return {
      ...base,
      observation: "present",
      workspace: owner.workspace ?? null,
      command: typeof owner.command === "string" ? owner.command.slice(0, 512) : null,
      recordedAt: owner.created_at,
      ...observation,
    };
  } catch (error) {
    return { ...base, observation: "unavailable", reason: error.message.slice(0, 512) };
  }
}

export async function collectResourceStatus(options = {}) {
  const paths = options.paths ?? {
    heavy: heavyRustTestLockPath(),
    native: nativeSessionLockPath(),
  };
  const inspectIdentity = options.inspectIdentity ?? readProcessIdentity;
  const alive = options.isProcessAlive ?? isProcessAlive;
  const heavy = await observe("heavy-rust", paths.heavy, readHeavyRustLockOwner, (owner) => {
    const processes = [
      inspectRecord("wrapper", owner.process, inspectIdentity),
      inspectRecord("child", owner.child, inspectIdentity),
    ].filter(Boolean);
    const verification = processes.some((entry) => entry.verification === "verified-live")
      ? "verified-live"
      : processes.some((entry) => entry.verification === "identity-mismatch")
        ? "identity-mismatch"
        : "recorded-process-absent";
    return {
      processes,
      verification,
      limits: "Containment cleanup/admission remains the existing guard's responsibility",
    };
  });
  const native = await observe(
    "native-desktop",
    paths.native,
    (lockPath) => readProcessLockOwner(lockPath, "Native desktop verification"),
    (owner) => ({
      verification: "unknown",
      processes: [
        {
          role: "wrapper",
          pid: owner.pid,
          observedPresent: alive(owner.pid),
          verification: "pid-only",
        },
      ],
      limits: "This legacy record does not bind an exact process creation identity",
    }),
  );
  return {
    format_version: 1,
    resources: [heavy, native],
    limits:
      "Read-only recorded-process observations; unregistered runners are unobserved. This is not admission or permission to reclaim a resource.",
  };
}

if (path.resolve(process.argv[1] ?? "") === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  if (args.length && (args.length !== 1 || args[0] !== "--json"))
    throw new Error("usage: resource-status.mjs [--json]");
  const report = await collectResourceStatus();
  console.log(
    args[0] === "--json"
      ? JSON.stringify(report, null, 2)
      : renderBoundedSummary(
          report.limits,
          report.resources.map(
            (entry) =>
              `${entry.resource}: ${entry.observation}; ${entry.verification}; workspace ${entry.workspace ?? "unknown"}; command ${entry.command ?? "unknown"}; ${entry.reason ?? entry.limits ?? ""}`,
          ),
        ).text,
  );
}
