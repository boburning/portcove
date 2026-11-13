/**
 * Release-health source for the #4129 maintenance inventory.
 *
 * Consumes the retained report of the latest successful scheduled `main` run of
 * the existing upstream-health monitor, bound by run identity and artifact
 * digest. The monitor keeps its authority; this projection keeps only stable
 * condition facts so routine recurrence stays quiet in changes-only storage.
 */
import { createHash } from "node:crypto";
import { crc32, inflateRawSync } from "node:zlib";
import { inspectBoundedZip } from "./bounded-zip.mts";
import { MaintenanceStoreError } from "./maintenance-store.mts";
import { isRoutineProviderCondition } from "./upstream-health-triage.mts";

const repository = "boburning/portcove";
// The maintained in-memory artifact transfer accepts archives up to 8 MiB.
const reportLimit = 8 * 1024 * 1024;

export interface ReleaseHealthInput {
  revision: string;
  report: unknown;
}

/** Condition fields that describe the condition, not this run's observation of it. */
const stableConditionFields = [
  "key",
  "material_sha256",
  "observation_contract_sha256",
  "classification",
  "accounted_for",
  "port_id",
  "operation",
  "rule",
  "provider",
  "location",
  "release_ref",
  "http_status",
  "first_seen",
  "resume_condition",
] as const;

const isPortList = (value: unknown): value is string[] =>
  Array.isArray(value) &&
  value.every((id) => typeof id === "string" && /^[a-z0-9][a-z0-9-]{0,127}$/u.test(id));

/** Per-port release-health facts and coverage from one monitor report. */
export function releaseHealthFacts(report: unknown) {
  const value = report as {
    format_version?: unknown;
    authority?: unknown;
    inventory?: Record<string, unknown>;
    known_conditions?: unknown;
  };
  const inventory = value.inventory ?? {};
  const lists = {
    complete: inventory.fresh_complete_port_ids,
    partial: inventory.fresh_partial_port_ids,
    stale: inventory.stale_port_ids,
    unmonitored: inventory.unmonitored_port_ids,
  };
  if (
    value.format_version !== 1 ||
    typeof value.authority !== "string" ||
    !value.authority.startsWith("upstream-monitoring-only") ||
    !Object.values(lists).every(isPortList) ||
    !Number.isSafeInteger(inventory.total_ports) ||
    !Array.isArray(value.known_conditions)
  )
    throw new MaintenanceStoreError("Unsupported release-health report");
  // The monitor partitions its ports exactly; anything else is an unsupported report.
  const listed = Object.values(lists).flat() as string[];
  if (new Set(listed).size !== listed.length || listed.length !== inventory.total_ports)
    throw new MaintenanceStoreError(
      "Unsupported release-health report: port lists are not a partition",
    );
  const conditions = new Map<string, Record<string, unknown>[]>();
  for (const condition of value.known_conditions as Record<string, unknown>[]) {
    if (typeof condition.port_id !== "string") continue;
    const stable = Object.fromEntries(
      stableConditionFields.map((field) => [field, condition[field] ?? null]),
    );
    conditions.set(condition.port_id, [...(conditions.get(condition.port_id) ?? []), stable]);
  }
  const complete = lists.complete as string[];
  const facts = new Map(
    complete.map((id) => [
      `port:${id}`,
      {
        freshness: "fresh-complete",
        conditions: (conditions.get(id) ?? []).sort((left, right) =>
          String(left.key) < String(right.key) ? -1 : 1,
        ),
      },
    ]),
  );
  // Partial, stale and unmonitored ports are coverage gaps, never health facts.
  const gaps = (["partial", "stale", "unmonitored"] as const).flatMap((kind) =>
    (lists[kind] as string[]).map((id) => ({
      subject_key: `port:${id}`,
      code: kind === "partial" ? "fresh-partial" : kind,
      message: "The monitor did not freshly and completely assess this port in this report.",
    })),
  );
  return { expected: listed.length, facts, gaps };
}

/** One named JSON file from a bounded, CRC-checked ZIP archive. */
export function zipJsonEntry(archive: Buffer, name: string): unknown {
  const parsed = inspectBoundedZip(archive, {
    compressedBytes: reportLimit,
    expandedBytes: 4 * reportLimit,
    files: 8,
    nameBytes: 128,
    allowedPaths: new Set([name, "summary.md"]),
  });
  const entry = parsed.entries.find((candidate) => candidate.name === name);
  if (!entry) throw new MaintenanceStoreError(`Artifact has no ${name}`);
  const compressed = archive.subarray(entry.data, entry.dataEnd);
  const bytes =
    entry.method === 0
      ? compressed
      : inflateRawSync(compressed, { maxOutputLength: Math.max(1, entry.bytes) });
  if (bytes.length !== entry.bytes || crc32(bytes) !== entry.crc)
    throw new MaintenanceStoreError(`Artifact entry ${name} failed its integrity check`);
  try {
    return JSON.parse(bytes.toString("utf8"));
  } catch {
    throw new MaintenanceStoreError(`Artifact entry ${name} is not valid JSON`);
  }
}

/** The latest successful scheduled main monitor report, read-only. */
export async function readReleaseHealth(): Promise<ReleaseHealthInput> {
  const { createGitHubClient } = await import("./github-client.mts");
  const { localDeveloperCredential } = await import("./github-cli.mts");
  const { downloadGitHubArtifactArchive } = await import("./github-artifact-download.mts");
  const deadline = performance.now() + 120_000;
  const credential = localDeveloperCredential({
    deadline,
    command: process.env.PORTCOVE_ROADMAP_GH,
  });
  const prefix = `/repos/${repository}`;
  let requests = 0;
  const sdk = await createGitHubClient({
    credential,
    deadline,
    maxBytes: 2 * 1024 * 1024,
    headers: { accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28" },
    allowRequest: (method, url) =>
      method === "GET" &&
      url.pathname.startsWith(`${prefix}/actions/`) &&
      !url.pathname.endsWith("/zip"),
    reserve() {
      if (++requests > 8)
        throw new MaintenanceStoreError("Release-health lookup exceeded its request budget");
      return { consumeBytes() {}, settle() {} };
    },
  });
  const get = async (endpoint: string) =>
    (await sdk.request({ method: "GET", url: `https://api.github.com${prefix}/${endpoint}` }))
      .data as Record<string, unknown>;
  const runs = (
    await get(
      "actions/workflows/upstream-health.yml/runs?event=schedule&branch=main&status=success&per_page=5",
    )
  ).workflow_runs as {
    id: number;
    run_attempt: number;
    head_sha: string;
    head_branch: string;
    event: string;
  }[];
  const run = runs.find(
    (candidate) => candidate.head_branch === "main" && candidate.event === "schedule",
  );
  if (!run)
    throw new MaintenanceStoreError("No successful scheduled main release-health run was found");
  const artifacts = (await get(`actions/runs/${run.id}/artifacts?per_page=10`)).artifacts as {
    id: number;
    name: string;
    expired: boolean;
    size_in_bytes: number;
    digest?: string;
  }[];
  const artifact = artifacts.find(
    (candidate) =>
      candidate.name === `upstream-health-${run.id}-${run.run_attempt}` && !candidate.expired,
  );
  if (!artifact?.digest?.startsWith("sha256:") || artifact.size_in_bytes > reportLimit)
    throw new MaintenanceStoreError("The release-health report artifact is unavailable or unbound");
  const archive = await downloadGitHubArtifactArchive(
    `repos/${repository}/actions/artifacts/${artifact.id}/zip`,
    {
      credential,
      deadline: performance.now() + 110_000,
      maxBytes: Math.max(22, artifact.size_in_bytes),
    },
  );
  const digest = createHash("sha256").update(archive).digest("hex");
  if (`sha256:${digest}` !== artifact.digest)
    throw new MaintenanceStoreError(
      "The release-health artifact does not match its recorded digest",
    );
  return {
    revision: `upstream-health-run:${run.id}-${run.run_attempt}@${run.head_sha}#sha256:${digest}`,
    report: zipJsonEntry(archive, "report.json"),
  };
}

/**
 * Conditions the maintained monitor triage keeps visible. Stored facts belong to
 * fresh, complete assessments and are unchanged once stored, so only the
 * monitor's routine accounted provider conditions are hidden.
 */
export function attentionConditions(payload: unknown) {
  const conditions = ((payload as { conditions?: unknown } | null)?.conditions ?? []) as Record<
    string,
    unknown
  >[];
  return conditions.filter(
    (condition) =>
      !isRoutineProviderCondition({
        ...condition,
        freshness: "fresh",
        latest_collection_status: "complete",
        changed_in_this_run: false,
      } as Parameters<typeof isRoutineProviderCondition>[0]),
  );
}
