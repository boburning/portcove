import type { HeavyProcessRecord } from "./heavy-rust-test-lock.mts";
function diagnosticText(value: unknown): string {
  return String(value);
}
import { errorMessage, errorCode, isRecord } from "./runtime-values.mts";
import { observeCapacity } from "./resource-capacity.mts";
import { lstat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  heavyRustTestLockPath,
  readHeavyRustLockOwner,
  readProcessIdentity,
} from "./heavy-rust-test-lock.mts";
import { nativeSessionLockPath } from "./native-session-lock.mts";
import { readProcessLockOwner, isProcessAlive } from "./process-lock.mts";
import { renderBoundedSummary } from "./report-summary.mts";
import { resourceConfiguration } from "./resource-paths.mts";
import { sampleHostObservations } from "./resource-observations.mts";

function inspectRecord(
  role: "wrapper" | "child",
  record: HeavyProcessRecord | null,
  inspectIdentity: typeof readProcessIdentity,
): Extract<
  NonNullable<ResourceObservation["processes"]>[number],
  { expectedIdentity: string }
> | null {
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

interface ResourceObservation {
  resource: "heavy-rust" | "native-desktop";
  observedAt?: string;
  verification: string;
  observation: string;
  reason?: string;
  workspace?: unknown;
  command?: string | null;
  limits?: string;
  recordedAt?: string;
  processes?: (
    | {
        role: "wrapper" | "child";
        pid: number;
        expectedIdentity: string;
        observedIdentity: string | null;
        verification: "verified-live" | "recorded-process-absent" | "identity-mismatch";
      }
    | {
        role: "wrapper";
        pid: number;
        observedPresent: boolean;
        verification: "pid-only" | "creation-identity";
      }
  )[];
}

async function observe<T extends { created_at: string; workspace?: unknown; command?: unknown }>(
  resource: ResourceObservation["resource"],
  lockPath: string,
  readOwner: (file: string) => Promise<T>,
  inspect: (owner: T) => Partial<ResourceObservation>,
): Promise<ResourceObservation> {
  const base = { resource, observedAt: new Date().toISOString(), verification: "unknown" };
  try {
    try {
      await lstat(lockPath);
    } catch (error) {
      if (errorCode(error) !== "ENOENT") throw error;
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
    return { ...base, observation: "unavailable", reason: errorMessage(error).slice(0, 512) };
  }
}

interface ResourceStatusOptions {
  sampleSeconds?: number;
  paths?: { heavy: string; native: string };
  capacityRoot?: string;
  inspectIdentity?: typeof readProcessIdentity;
  isProcessAlive?: (pid: number) => boolean;
}
export async function collectResourceStatus(options: ResourceStatusOptions = {}) {
  if (
    options.sampleSeconds !== undefined &&
    (!Number.isInteger(options.sampleSeconds) ||
      options.sampleSeconds < 0 ||
      options.sampleSeconds > 60)
  )
    throw new Error("Sample duration must be an integer from 0 to 60 seconds");
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
    ].filter((entry) => entry !== null);
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
      verification: owner.process_identity
        ? inspectIdentity(owner.pid) === owner.process_identity
          ? "verified-live"
          : "recorded-process-absent-or-changed"
        : "unknown",
      processes: [
        {
          role: "wrapper",
          pid: owner.pid,
          observedPresent: alive(owner.pid),
          verification: owner.process_identity ? "creation-identity" : "pid-only",
        },
      ],
      limits: owner.process_identity
        ? "Creation identity observed; guard still owns exclusivity and recovery"
        : "This legacy record does not bind an exact process creation identity",
    }),
  );
  type CapacityObservation = Omit<ResourceObservation, "resource" | "observation"> & {
    resource: "host-capacity";
  } & (
      | ({ observation: "recorded" } & Awaited<ReturnType<typeof observeCapacity>>)
      | { observation: "unavailable"; reason: string }
    );
  let capacity: CapacityObservation | undefined;
  if (!options.paths || options.capacityRoot) {
    try {
      capacity = {
        resource: "host-capacity",
        observation: "recorded",
        verification: "observational-only",
        ...(await observeCapacity(options.capacityRoot ? { root: options.capacityRoot } : {})),
      };
    } catch (error) {
      capacity = {
        resource: "host-capacity",
        observation: "unavailable",
        verification: "unknown",
        reason: errorMessage(error),
      };
    }
  }
  let windowsHost: unknown;
  if (!options.paths) {
    try {
      const config = await resourceConfiguration(options.capacityRoot);
      if (config.hostBridge) {
        const { observeBridgedCapacity } = await import("./resource-host-bridge.mts");
        windowsHost = {
          observation: "recorded",
          ...((await observeBridgedCapacity(config.hostBridge)) as object),
        };
      }
    } catch (error) {
      windowsHost = {
        observation: "unavailable",
        verification: "unknown",
        reason: errorMessage(error).slice(0, 512),
      };
    }
  }
  const host =
    !options.paths || options.sampleSeconds !== undefined
      ? await sampleHostObservations(options.sampleSeconds)
      : undefined;
  return {
    format_version: 1,
    resources: [heavy, native, ...(capacity ? [capacity] : [])],
    ...(host ? { host } : {}),
    ...(windowsHost ? { windows_host: windowsHost } : {}),
    limits:
      "Read-only recorded-process observations; unregistered runners are unobserved. This is not admission or permission to reclaim a resource.",
  };
}

if (path.resolve(process.argv[1] ?? "") === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  let sampleSeconds = 0,
    asJson = false;
  for (let index = 0; index < args.length; index++) {
    if (args[index] === "--json" && !asJson) asJson = true;
    else if (args[index] === "--sample-seconds" && /^\d+$/u.test(args[index + 1] ?? ""))
      sampleSeconds = Number(args[++index]);
    else throw new Error("usage: resource-status.mts [--json] [--sample-seconds 0..60]");
  }
  const report = await collectResourceStatus({ sampleSeconds });
  const host = report.host?.samples.at(-1);
  const hostLines = host
    ? [
        "Host I/O: " +
          host.observation +
          "; " +
          report.host!.samples.length +
          " sample(s) across " +
          report.host!.elapsed_ms +
          "ms",
        ...("io_pressure" in host ? ["I/O pressure: " + JSON.stringify(host.io_pressure)] : []),
        ...("reason" in host ? ["Host observation: " + host.reason] : []),
      ]
    : [];
  if (isRecord(report.windows_host)) {
    const capacity = report.windows_host.capacity;
    hostLines.push(
      "Windows host: " +
        diagnosticText(report.windows_host.observation) +
        (isRecord(capacity) && Array.isArray(capacity.running) && Array.isArray(capacity.queued)
          ? "; " +
            capacity.running.length +
            " recorded running, " +
            capacity.queued.length +
            " queued"
          : "; capacity unknown"),
    );
  }
  console.log(
    asJson
      ? JSON.stringify(report, null, 2)
      : renderBoundedSummary(report.limits, [
          ...report.resources.map(
            (entry) =>
              `${entry.resource}: ${entry.observation}; ${entry.verification}; workspace ${diagnosticText(entry.workspace ?? "unknown")}; command ${entry.command ?? "unknown"}; ${entry.reason ?? entry.limits ?? ""}`,
          ),
          ...hostLines,
        ]).text,
  );
}
