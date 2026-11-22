import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseCatalogSource, readCatalogSource, type AuthoredPort } from "./catalog-authoring.mts";
import {
  reconsiderConditions,
  type AcquisitionRestriction,
} from "./catalog-acquisition-restrictions.mts";
import { isRecord } from "./runtime-values.mts";

/**
 * Read-only recheck of authored `reconsider_when` conditions. Core never
 * evaluates them; this report lets a hold flag itself when the condition it
 * names is satisfied, or when the evidence needed to decide is missing.
 *
 * Inputs are the committed catalog source and two optional files: a listing
 * observer report (the shape `catalog-route-fit.mts --observations` accepts)
 * and an evidence file of reviewed facts. The script uses no network, writes
 * nothing except an explicit `--output` file and decides nothing: a satisfied
 * condition is a prompt to review, never a cleared hold. Every rule is generic
 * over the data; no title or id appears here.
 *
 * Condition rules, per hold:
 * - `publisher-checksum`: a complete observation's newest release has assets
 *   and every asset carries a provider digest.
 * - `reviewed-successor-release`: a complete observation names a release whose
 *   version no restriction of the port scopes (by release or artifact). With
 *   no scoped version there is no reviewed baseline, so the result is unknown.
 * - `clean-upstream-package`: the evidence file records a content scan of the
 *   newest observed release with zero findings.
 * - `attributable-grant`: the evidence file records whether a grant covering
 *   the held scope was reviewed.
 * - `upstream-route-change`: the evidence file records whether the upstream
 *   route the hold names changed.
 * - `owned-input-preparation`, `owner-review`: never machine-checkable.
 *
 * Missing or incomplete evidence is `unknown`, never `satisfied`.
 */

export type ReconsiderCondition = (typeof reconsiderConditions)[number];
export type ConditionStatus = "satisfied" | "not-satisfied" | "unknown" | "manual";
export const manualConditions: readonly ReconsiderCondition[] = [
  "owned-input-preparation",
  "owner-review",
];

export interface ObservedRelease {
  version: string;
  published_at: string | null;
  assets: { name: string; sha256: string | null }[];
}
export interface EvidenceSubject {
  port_id: string;
  content_scan?: { version: string; findings: number }[];
  grant?: { recorded: boolean; reference: string };
  route_changed?: { changed: boolean; reference: string };
}
export interface RecheckInputs {
  records: readonly AuthoredPort[];
  observerReport?: unknown;
  evidence?: unknown;
}
export interface ConditionResult {
  condition: ReconsiderCondition;
  status: ConditionStatus;
  detail: string;
}
export interface RecheckRow {
  port_id: string;
  carrier: "listing" | "managed";
  restriction_id: string;
  reason: string;
  flag: ConditionStatus;
  conditions: ConditionResult[];
}
export interface RecheckReport {
  format_version: 1;
  summary: {
    holds: number;
    holds_with_conditions: number;
    holds_without_conditions: number;
    by_flag: Record<ConditionStatus, number>;
    observer_report: "absent" | "applied";
    evidence: "absent" | "applied";
  };
  /** Holds whose conditions are satisfied or unknown, in id order. */
  flagged: RecheckRow[];
  /** Every hold with authored conditions, in id order. */
  rows: RecheckRow[];
}

const statuses: readonly ConditionStatus[] = ["satisfied", "unknown", "not-satisfied", "manual"];

function carriersOf(record: AuthoredPort) {
  const listing = record.listing as Record<string, unknown>;
  const integration = isRecord(record.integration) ? record.integration : undefined;
  const list = (value: unknown) =>
    Array.isArray(value) ? (value as AcquisitionRestriction[]) : [];
  return [
    { carrier: "listing" as const, list: list(listing.restrictions) },
    { carrier: "managed" as const, list: list(integration?.acquisition_restrictions) },
  ];
}

/** Versions a port's restrictions already name, by release or exact artifact. */
function scopedVersions(record: AuthoredPort) {
  const versions = new Set<string>();
  for (const { list } of carriersOf(record))
    for (const restriction of list) {
      for (const release of restriction.scope?.releases ?? []) versions.add(release);
      for (const artifact of restriction.scope?.artifacts ?? []) versions.add(artifact.version);
    }
  return versions;
}

function readReleases(observation: unknown): ObservedRelease[] | undefined {
  if (!isRecord(observation)) return undefined;
  // `complete` is the producer's success; an absent status is a legacy success.
  if (observation.status !== undefined && observation.status !== "complete") return undefined;
  if (!Array.isArray(observation.releases)) return undefined;
  return observation.releases.flatMap((release: unknown) => {
    if (!isRecord(release) || typeof release.version !== "string" || !release.version) return [];
    const assets = Array.isArray(release.assets) ? release.assets : [];
    return [
      {
        version: release.version,
        published_at: typeof release.published_at === "string" ? release.published_at : null,
        assets: assets.flatMap((asset: unknown) =>
          isRecord(asset) && typeof asset.name === "string"
            ? [{ name: asset.name, sha256: typeof asset.sha256 === "string" ? asset.sha256 : null }]
            : [],
        ),
      },
    ];
  });
}

/** Committed listing observations, replaced by observer report entries. */
function observedReleases(inputs: RecheckInputs, known: ReadonlySet<string>) {
  const result = new Map<string, ObservedRelease[]>();
  for (const record of inputs.records) {
    const releases = readReleases(record.listing.upstream_observation);
    if (releases) result.set(record.listing.id, releases);
  }
  if (inputs.observerReport === undefined) return result;
  const report = inputs.observerReport;
  const entries: unknown =
    isRecord(report) && Array.isArray(report.listings) ? report.listings : report;
  if (!Array.isArray(entries))
    throw new Error("Observer report needs a listings array of listing updates.");
  for (const raw of entries) {
    const entry: unknown = isRecord(raw) && isRecord(raw.listing_update) ? raw.listing_update : raw;
    if (!isRecord(entry) || typeof entry.id !== "string")
      throw new Error("Observer report contains a listing without an id.");
    if (!known.has(entry.id))
      throw new Error(`Observer report names ${entry.id}, which is not a catalog identity.`);
    const releases = readReleases(entry.upstream_observation);
    if (releases) result.set(entry.id, releases);
    else result.delete(entry.id);
  }
  return result;
}

const referenced = (value: unknown, flag: string) =>
  isRecord(value) &&
  typeof value[flag] === "boolean" &&
  typeof value.reference === "string" &&
  value.reference.length > 0;

function evidenceSubjects(evidence: unknown, known: ReadonlySet<string>) {
  const result = new Map<string, EvidenceSubject>();
  if (evidence === undefined) return result;
  if (!isRecord(evidence) || evidence.format_version !== 1 || !Array.isArray(evidence.subjects))
    throw new Error("Evidence needs format_version 1 and a subjects array.");
  for (const subject of evidence.subjects) {
    if (!isRecord(subject) || typeof subject.port_id !== "string")
      throw new Error("Evidence subjects need a port_id.");
    if (!known.has(subject.port_id))
      throw new Error(`Evidence names ${subject.port_id}, which is not a catalog identity.`);
    if (result.has(subject.port_id))
      throw new Error(`Evidence repeats ${subject.port_id}; give one subject per identity.`);
    if (
      subject.content_scan !== undefined &&
      !(
        Array.isArray(subject.content_scan) &&
        subject.content_scan.every(
          (scan: unknown) =>
            isRecord(scan) &&
            typeof scan.version === "string" &&
            Number.isSafeInteger(scan.findings) &&
            Number(scan.findings) >= 0,
        )
      )
    )
      throw new Error(`${subject.port_id} content scans need a version and a finding count.`);
    if (subject.grant !== undefined && !referenced(subject.grant, "recorded"))
      throw new Error(`${subject.port_id} grant evidence needs recorded and a reference.`);
    if (subject.route_changed !== undefined && !referenced(subject.route_changed, "changed"))
      throw new Error(`${subject.port_id} route evidence needs changed and a reference.`);
    result.set(subject.port_id, subject as unknown as EvidenceSubject);
  }
  return result;
}

/** Newest first by provider publication time; undated releases keep their order last. */
function newest(releases: readonly ObservedRelease[]) {
  return releases
    .map((release, index) => ({ release, index }))
    .toSorted(
      (left, right) =>
        (right.release.published_at ?? "").localeCompare(left.release.published_at ?? "") ||
        left.index - right.index,
    )[0]?.release;
}

function evaluate(
  condition: ReconsiderCondition,
  record: AuthoredPort,
  releases: readonly ObservedRelease[] | undefined,
  subject: EvidenceSubject | undefined,
): ConditionResult {
  const result = (status: ConditionStatus, detail: string) => ({ condition, status, detail });
  if (manualConditions.includes(condition))
    return result("manual", "Needs a person's review; no fact decides it.");
  const latest = releases && newest(releases);
  switch (condition) {
    case "publisher-checksum": {
      if (!latest) return result("unknown", "No complete release observation.");
      if (!latest.assets.length)
        return result("unknown", `Release ${latest.version} lists no assets.`);
      const missing = latest.assets.filter((asset) => !asset.sha256).length;
      return missing
        ? result(
            "not-satisfied",
            `${missing} of ${latest.assets.length} assets in ${latest.version} lack a provider digest.`,
          )
        : result("satisfied", `Every asset in ${latest.version} carries a provider digest.`);
    }
    case "reviewed-successor-release": {
      const reviewed = scopedVersions(record);
      if (!reviewed.size)
        return result("unknown", "No restriction scopes a release or artifact version.");
      if (!releases) return result("unknown", "No complete release observation.");
      const fresh = releases.map((release) => release.version).filter((v) => !reviewed.has(v));
      return fresh.length
        ? result(
            "satisfied",
            `Observed releases outside every scoped version: ${fresh.join(", ")}.`,
          )
        : result("not-satisfied", "Every observed release is already scoped.");
    }
    case "clean-upstream-package": {
      if (!latest) return result("unknown", "No complete release observation.");
      const scan = subject?.content_scan?.find((entry) => entry.version === latest.version);
      if (!scan) return result("unknown", `No content scan recorded for ${latest.version}.`);
      return scan.findings
        ? result("not-satisfied", `${scan.findings} finding(s) in ${latest.version}.`)
        : result("satisfied", `The content scan of ${latest.version} recorded no findings.`);
    }
    case "attributable-grant":
      if (!subject?.grant) return result("unknown", "No reviewed grant evidence.");
      return result(
        subject.grant.recorded ? "satisfied" : "not-satisfied",
        `Grant review: ${subject.grant.reference}.`,
      );
    case "upstream-route-change":
      if (!subject?.route_changed) return result("unknown", "No route evidence.");
      return result(
        subject.route_changed.changed ? "satisfied" : "not-satisfied",
        `Route review: ${subject.route_changed.reference}.`,
      );
  }
  return result("unknown", "Unrecognized condition.");
}

/** A row flags the strongest result among its conditions. */
function flagOf(conditions: readonly ConditionResult[]): ConditionStatus {
  return statuses.find((status) => conditions.some((entry) => entry.status === status))!;
}

const byKey = (left: RecheckRow, right: RecheckRow) =>
  `${left.port_id}\u0000${left.carrier}\u0000${left.restriction_id}` <
  `${right.port_id}\u0000${right.carrier}\u0000${right.restriction_id}`
    ? -1
    : 1;

/** Pure analysis; equal inputs always produce byte-identical serialized output. */
export function restrictionRecheckReport(inputs: RecheckInputs): RecheckReport {
  const known = new Set(inputs.records.map((record) => record.listing.id));
  if (known.size !== inputs.records.length) throw new Error("Catalog identities must be unique.");
  const observed = observedReleases(inputs, known);
  const subjects = evidenceSubjects(inputs.evidence, known);
  let holds = 0;
  const rows: RecheckRow[] = [];
  for (const record of inputs.records)
    for (const { carrier, list } of carriersOf(record))
      for (const restriction of list) {
        if (restriction.effect !== "hold") continue;
        holds++;
        const authored = restriction.reconsider_when ?? [];
        if (!authored.length) continue;
        const conditions = authored.map((condition) =>
          evaluate(
            condition as ReconsiderCondition,
            record,
            observed.get(record.listing.id),
            subjects.get(record.listing.id),
          ),
        );
        rows.push({
          port_id: record.listing.id,
          carrier,
          restriction_id: restriction.id,
          reason: restriction.reason ?? "unclassified",
          flag: flagOf(conditions),
          conditions,
        });
      }
  rows.sort(byKey);
  const byFlag = Object.fromEntries(statuses.map((status) => [status, 0])) as Record<
    ConditionStatus,
    number
  >;
  for (const row of rows) byFlag[row.flag]++;
  return {
    format_version: 1,
    summary: {
      holds,
      holds_with_conditions: rows.length,
      holds_without_conditions: holds - rows.length,
      by_flag: byFlag,
      observer_report: inputs.observerReport === undefined ? "absent" : "applied",
      evidence: inputs.evidence === undefined ? "absent" : "applied",
    },
    flagged: rows.filter((row) => row.flag === "satisfied" || row.flag === "unknown"),
    rows,
  };
}

export function renderRestrictionRecheck(report: RecheckReport): string {
  const { summary } = report;
  const lines = [
    `Restriction recheck: ${summary.holds} holds, ${summary.holds_with_conditions} with reconsideration conditions, ${summary.holds_without_conditions} without`,
    ...statuses.map(
      (status) => `  ${status.padEnd(16)} ${String(summary.by_flag[status]).padStart(5)}`,
    ),
    `Observer report: ${summary.observer_report}; evidence: ${summary.evidence}`,
    ...report.flagged.map(
      (row) =>
        `${row.flag}: ${row.port_id} ${row.carrier}/${row.restriction_id} (${row.reason}): ${row.conditions
          .map((entry) => `${entry.condition} ${entry.status}`)
          .join(", ")}`,
    ),
  ];
  return `${lines.join("\n")}\n`;
}

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const usage =
  "Usage: node scripts/restriction-recheck.mts [--json] [--output FILE] [--observations OBSERVER_REPORT.json] [--evidence EVIDENCE.json]";

export function main(argv: readonly string[], repositoryRoot = root): string {
  const options: { json: boolean; output?: string; observations?: string; evidence?: string } = {
    json: false,
  };
  for (let index = 0; index < argv.length; index++) {
    const argument = argv[index];
    if (argument === "--json") options.json = true;
    else if (["--output", "--observations", "--evidence"].includes(argument ?? "")) {
      const value = argv[++index];
      if (!value || value.startsWith("--")) throw new Error(usage);
      options[argument!.slice(2) as "output" | "observations" | "evidence"] = resolve(value);
    } else throw new Error(usage);
  }
  const read = (file: string): unknown => parseCatalogSource(readFileSync(file, "utf8"));
  const { records } = readCatalogSource(join(repositoryRoot, "crates/portcove-core/catalog"));
  const report = restrictionRecheckReport({
    records,
    ...(options.observations === undefined ? {} : { observerReport: read(options.observations) }),
    ...(options.evidence === undefined ? {} : { evidence: read(options.evidence) }),
  });
  const serialized = `${JSON.stringify(report, null, 2)}\n`;
  if (options.output) writeFileSync(options.output, serialized);
  return options.json ? serialized : renderRestrictionRecheck(report);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    process.stdout.write(main(process.argv.slice(2)));
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
