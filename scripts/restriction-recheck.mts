import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseCatalogSource, readCatalogSource, type AuthoredPort } from "./catalog-authoring.mts";
import {
  reconsiderConditions,
  type AcquisitionRestriction,
} from "./catalog-acquisition-restrictions.mts";
import {
  observerListingObservations,
  readListingObservation,
  type ListingObservation,
  type ListingObservedRelease,
} from "./listing-observation-reader.mts";
import { isRecord } from "./runtime-values.mts";
import { orderedJsonSha256 } from "./json-values.mts";

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
 * - `reviewed-successor-release`: a complete observation names a release that
 *   no restriction of the port scopes (by release or artifact) and that was
 *   published after the newest scoped release. The baseline is the newest
 *   provider publication time among observed scoped versions; an older or
 *   equally dated unscoped release is not a successor. A missing publication
 *   time, or a scoped version absent from the observation, is unknown. A hold
 *   scoped only by platform names no reviewed version, so this condition stays
 *   unknown for it until a release or artifact scope (or the owner) supplies
 *   the baseline.
 * - `clean-upstream-package`: the evidence file records content scans with
 *   zero findings covering every asset of the newest observed release. A scan
 *   names a version and optionally an `asset_sha256` or a `platform`; without
 *   either it covers the whole version. Any covering finding is not satisfied;
 *   an uncovered asset is unknown.
 * - `attributable-grant`: the evidence file records whether a grant covering
 *   the held scope was reviewed.
 * - `upstream-route-change`: the evidence file records whether the upstream
 *   route the hold names changed.
 * - `owned-input-preparation`, `owner-review`: never machine-checkable.
 *
 * The newest release is judged by provider publication time. When more than
 * one release is observed and any lacks a publication time, it could be the
 * newest, so `publisher-checksum` and `clean-upstream-package` are unknown.
 *
 * Missing or incomplete evidence is `unknown`, never `satisfied`. A row with
 * any manual condition is flagged `manual` (it needs the owner) whatever its
 * other conditions say; its strongest machine result is reported beside it.
 * Every manual, satisfied or unknown row is listed by name, grouped by flag.
 */

export type ReconsiderCondition = (typeof reconsiderConditions)[number];
export type ConditionStatus = "satisfied" | "not-satisfied" | "unknown" | "manual";
export const manualConditions: readonly ReconsiderCondition[] = [
  "owned-input-preparation",
  "owner-review",
];

export type ObservedRelease = ListingObservedRelease & { version: string };
export interface ContentScan {
  version: string;
  findings: number;
  platform?: string;
  asset_sha256?: string;
}
export interface EvidenceSubject {
  port_id: string;
  content_scan?: ContentScan[];
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
  /** `manual` whenever any condition needs a person; otherwise `machine`. */
  flag: ConditionStatus;
  /** Strongest result among machine-checkable conditions; null when none. */
  machine: Exclude<ConditionStatus, "manual"> | null;
  /** Fact digest of the complete observation the row was judged from. */
  observation_facts_sha256: string | null;
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
  /**
   * Holds that need attention, in id order: every `manual` row (the owner
   * decides, whatever its machine result) and every row whose machine result is
   * satisfied or unknown. Only rows whose every condition is machine-checked
   * and not satisfied are left out.
   */
  flagged: RecheckRow[];
  /** Every hold with authored conditions, in id order. */
  rows: RecheckRow[];
}

const statuses: readonly ConditionStatus[] = ["manual", "satisfied", "unknown", "not-satisfied"];
const machineStatuses = ["satisfied", "unknown", "not-satisfied"] as const;

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

interface Observed {
  facts_sha256: string | null;
  releases: ObservedRelease[];
}

function completeReleases(observation: ListingObservation | undefined): Observed | undefined {
  if (observation?.state !== "complete") return undefined;
  return {
    facts_sha256: observation.facts_sha256,
    releases: observation.releases.filter(
      (release): release is ObservedRelease => release.version !== null,
    ),
  };
}

/** Committed listing observations, replaced by observer report entries. */
function observedReleases(inputs: RecheckInputs, known: ReadonlySet<string>) {
  const reported = observerListingObservations(inputs.observerReport, known);
  const result = new Map<string, Observed>();
  for (const record of inputs.records) {
    const id = record.listing.id;
    const observed = completeReleases(
      reported.get(id) ?? readListingObservation(record.listing.upstream_observation),
    );
    if (observed) result.set(id, observed);
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
            Number(scan.findings) >= 0 &&
            (scan.platform === undefined || typeof scan.platform === "string") &&
            (scan.asset_sha256 === undefined ||
              (typeof scan.asset_sha256 === "string" &&
                /^[0-9a-f]{64}$/u.test(scan.asset_sha256))) &&
            !(scan.platform !== undefined && scan.asset_sha256 !== undefined),
        )
      )
    )
      throw new Error(
        `${subject.port_id} content scans need a version, a finding count and at most one of platform or a lowercase asset_sha256.`,
      );
    if (subject.grant !== undefined && !referenced(subject.grant, "recorded"))
      throw new Error(`${subject.port_id} grant evidence needs recorded and a reference.`);
    if (subject.route_changed !== undefined && !referenced(subject.route_changed, "changed"))
      throw new Error(`${subject.port_id} route evidence needs changed and a reference.`);
    result.set(subject.port_id, subject as unknown as EvidenceSubject);
  }
  return result;
}

/** Provider publication time in milliseconds; null when absent or unreadable. */
function publishedAt(release: ObservedRelease) {
  const time = release.published_at === null ? Number.NaN : Date.parse(release.published_at);
  return Number.isFinite(time) ? time : null;
}

/**
 * The newest release by provider publication time. With more than one release,
 * an undated release could be the newest, so the result is the undated
 * versions instead of a guess; a single release is the newest whatever its date.
 */
function newest(
  releases: readonly ObservedRelease[],
): { release: ObservedRelease } | { undated: string[] } | undefined {
  if (releases.length <= 1) return releases[0] && { release: releases[0] };
  const undated = releases.filter((release) => publishedAt(release) === null);
  if (undated.length) return { undated: undated.map((release) => release.version) };
  const release = releases
    .map((release, index) => ({ release, index, time: publishedAt(release)! }))
    .toSorted((left, right) => right.time - left.time || left.index - right.index)[0]!.release;
  return { release };
}

function successor(
  reviewed: ReadonlySet<string>,
  releases: readonly ObservedRelease[],
): [ConditionStatus, string] {
  const scoped = releases.filter((release) => reviewed.has(release.version));
  const missing = [...reviewed].filter((version) => !scoped.some((r) => r.version === version));
  if (missing.length)
    return [
      "unknown",
      `Scoped version(s) not in the observation: ${missing.toSorted().join(", ")}.`,
    ];
  const undatedScoped = scoped.filter((release) => publishedAt(release) === null);
  if (undatedScoped.length)
    return [
      "unknown",
      `Scoped release(s) without a publication time: ${undatedScoped.map((r) => r.version).join(", ")}.`,
    ];
  const baseline = Math.max(...scoped.map((release) => publishedAt(release)!));
  const unscoped = releases.filter((release) => !reviewed.has(release.version));
  const newer = unscoped.filter((release) => (publishedAt(release) ?? -Infinity) > baseline);
  if (newer.length)
    return [
      "satisfied",
      `Published after the newest scoped release: ${newer.map((r) => r.version).join(", ")}.`,
    ];
  const undated = unscoped.filter((release) => publishedAt(release) === null);
  if (undated.length)
    return [
      "unknown",
      `Unscoped release(s) without a publication time: ${undated.map((r) => r.version).join(", ")}.`,
    ];
  return unscoped.length
    ? [
        "not-satisfied",
        `Unscoped releases are not newer than the newest scoped release: ${unscoped.map((r) => r.version).join(", ")}.`,
      ]
    : ["not-satisfied", "Every observed release is already scoped."];
}

/** Scans of `latest` that cover `asset`: same version, then exact digest, platform or whole version. */
function covering(
  scans: readonly ContentScan[],
  version: string,
  asset?: ObservedRelease["assets"][number],
) {
  return scans.filter(
    (scan) =>
      scan.version === version &&
      (scan.asset_sha256 !== undefined
        ? asset?.sha256?.toLowerCase() === scan.asset_sha256
        : scan.platform !== undefined
          ? (asset?.platform_hints.includes(scan.platform) ?? false)
          : true),
  );
}

function contentScan(
  latest: ObservedRelease,
  scans: readonly ContentScan[],
): [ConditionStatus, string] {
  const groups = latest.assets.length
    ? latest.assets.map((asset) => ({
        label: asset.name ?? "an unnamed asset",
        found: covering(scans, latest.version, asset),
      }))
    : [{ label: latest.version, found: covering(scans, latest.version) }];
  const findings = groups.reduce(
    (sum, group) => sum + group.found.reduce((total, scan) => total + scan.findings, 0),
    0,
  );
  if (findings)
    return ["not-satisfied", `${findings} finding(s) in scans covering ${latest.version}.`];
  const uncovered = groups.filter((group) => !group.found.length).map((group) => group.label);
  if (uncovered.length)
    return ["unknown", `No content scan covers ${uncovered.join(", ")} in ${latest.version}.`];
  return ["satisfied", `Content scans cover every asset of ${latest.version} with no findings.`];
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
  const candidate = releases && newest(releases);
  const undated =
    candidate && "undated" in candidate
      ? result(
          "unknown",
          `Release(s) without a publication time could be the newest: ${candidate.undated.join(", ")}.`,
        )
      : undefined;
  const latest = candidate && "release" in candidate ? candidate.release : undefined;
  switch (condition) {
    case "publisher-checksum": {
      if (undated) return undated;
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
        return result(
          "unknown",
          "No restriction scopes a release or artifact version, so there is no reviewed baseline.",
        );
      if (!releases) return result("unknown", "No complete release observation.");
      return result(...successor(reviewed, releases));
    }
    case "clean-upstream-package": {
      if (undated) return undated;
      if (!latest) return result("unknown", "No complete release observation.");
      return result(...contentScan(latest, subject?.content_scan ?? []));
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

/** Strongest machine result: satisfied, then unknown, then not satisfied. */
function machineOf(conditions: readonly ConditionResult[]) {
  return (
    machineStatuses.find((status) => conditions.some((entry) => entry.status === status)) ?? null
  );
}

/** Any manual condition puts the row with the owner, whatever else it says. */
function flagOf(conditions: readonly ConditionResult[]): ConditionStatus {
  return conditions.some((entry) => entry.status === "manual") ? "manual" : machineOf(conditions)!;
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
        const observation = observed.get(record.listing.id);
        const conditions = authored.map((condition) =>
          evaluate(
            condition as ReconsiderCondition,
            record,
            observation?.releases,
            subjects.get(record.listing.id),
          ),
        );
        rows.push({
          port_id: record.listing.id,
          carrier,
          restriction_id: restriction.id,
          reason: restriction.reason ?? "unclassified",
          flag: flagOf(conditions),
          machine: machineOf(conditions),
          observation_facts_sha256: observation?.facts_sha256 ?? null,
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
    flagged: rows.filter((row) => row.flag !== "not-satisfied"),
    rows,
  };
}

type ReleaseObservation = Record<string, unknown>;
const sha256 = /^[0-9a-f]{64}$/u;
const observationOf = (listing: unknown): ReleaseObservation | undefined =>
  isRecord(listing) && isRecord(listing.upstream_observation)
    ? listing.upstream_observation
    : undefined;

function repoIdentity(observation: ReleaseObservation) {
  const provider = observation.provider ?? "github";
  const id = observation.repository_id;
  return (provider === "github" || provider === "gitlab") &&
    typeof id === "number" &&
    Number.isSafeInteger(id) &&
    id > 0
    ? `${provider}:${id}`
    : null;
}

function managedRouteMatches(route: unknown, observation: ReleaseObservation) {
  if (!isRecord(route) || !isRecord(route.release)) return false;
  const provider = route.release.provider ?? "github";
  if ((observation.provider ?? "github") !== provider) return false;
  if (typeof route.release.repository_id === "number")
    return route.release.repository_id === observation.repository_id;
  return (
    typeof route.release.repository === "string" &&
    typeof observation.repository === "string" &&
    route.release.repository.toLowerCase() === observation.repository.toLowerCase()
  );
}

function packageWindow(observation: ReleaseObservation) {
  if (!Array.isArray(observation.releases)) return null;
  const releases = new Map<string, string>();
  for (const release of observation.releases) {
    if (
      !isRecord(release) ||
      typeof release.version !== "string" ||
      releases.has(release.version) ||
      release.assets_complete !== true ||
      !Array.isArray(release.assets)
    )
      return null;
    const gitlab = observation.provider === "gitlab";
    if (
      gitlab
        ? !isRecord(release.id) ||
          release.id.provider !== "gitlab" ||
          release.id.project_id !== observation.repository_id ||
          release.id.tag !== release.version
        : typeof release.id !== "number" || !Number.isSafeInteger(release.id) || release.id < 1
    )
      return null;
    const assets = new Map<number, unknown[]>();
    for (const asset of release.assets) {
      if (
        !isRecord(asset) ||
        typeof asset.id !== "number" ||
        !Number.isSafeInteger(asset.id) ||
        asset.id < 1 ||
        assets.has(asset.id) ||
        typeof asset.name !== "string" ||
        !Number.isSafeInteger(asset.size) ||
        (gitlab && typeof asset.url !== "string") ||
        (asset.sha256 != null && (typeof asset.sha256 !== "string" || !sha256.test(asset.sha256)))
      )
        return null;
      assets.set(asset.id, [
        asset.name,
        asset.size,
        asset.sha256 ?? null,
        ...(gitlab ? [asset.url] : []),
      ]);
    }
    releases.set(
      release.version,
      orderedJsonSha256({
        id: release.id,
        assets: [...assets].sort(([a], [b]) => a - b),
      }),
    );
  }
  return releases;
}

/** Read-only prompts for maintainers of holds in the current reviewed catalog. */
export function heldPackageWindowReview(input: {
  canonicalListings: readonly unknown[];
  canonicalPorts: readonly unknown[];
  previous: readonly unknown[];
  proposed: readonly unknown[];
  now: number;
}) {
  const holds = (value: unknown) =>
    Array.isArray(value) && value.some((row) => isRecord(row) && row.effect === "hold");
  const listingHolds = new Set<string>();
  const managedHolds = new Map<string, Record<string, unknown>>();
  for (const row of input.canonicalListings) {
    if (
      isRecord(row) &&
      typeof row.id === "string" &&
      (typeof row.download_block_reason === "string" || holds(row.restrictions))
    )
      listingHolds.add(row.id);
  }
  for (const row of input.canonicalPorts) {
    if (
      isRecord(row) &&
      typeof row.id === "string" &&
      (isRecord(row.managed_acquisition_hold) || holds(row.acquisition_restrictions))
    )
      managedHolds.set(row.id, row);
  }
  const held = new Set([...listingHolds, ...managedHolds.keys()]);
  const byId = (rows: readonly unknown[]) =>
    new Map(
      rows.flatMap((row) =>
        isRecord(row) && typeof row.id === "string" && held.has(row.id)
          ? [[row.id, observationOf(row)]]
          : [],
      ),
    );
  const before = byId(input.previous);
  const after = byId(input.proposed);
  const counts = {
    no_complete_baseline: 0,
    no_complete_proposal: 0,
    unbound_or_changed_identity: 0,
    outside_held_route: 0,
    not_newer_or_stale: 0,
    incomplete_release_assets: 0,
    unchanged: 0,
    review_due: 0,
  };
  const changes = [];
  const epoch = (value: unknown) => (typeof value === "string" ? Date.parse(value) : NaN);
  const complete = (
    observation: ReleaseObservation | undefined,
  ): observation is ReleaseObservation =>
    !!observation &&
    (observation.status ?? "complete") === "complete" &&
    typeof observation.facts_sha256 === "string" &&
    sha256.test(observation.facts_sha256);
  for (const port of [...held].sort()) {
    const prior = before.get(port);
    const proposed = after.get(port);
    if (!complete(prior)) {
      counts.no_complete_baseline++;
      continue;
    }
    if (!complete(proposed)) {
      counts.no_complete_proposal++;
      continue;
    }
    const id = repoIdentity(prior);
    if (!id || id !== repoIdentity(proposed)) {
      counts.unbound_or_changed_identity++;
      continue;
    }
    const carriers = [
      ...(listingHolds.has(port) ? ["listing"] : []),
      ...(managedRouteMatches(managedHolds.get(port), proposed) ? ["managed"] : []),
    ];
    if (!carriers.length) {
      counts.outside_held_route++;
      continue;
    }
    const observed = epoch(proposed.observed_at);
    if (
      !(
        observed > epoch(prior.observed_at) &&
        observed <= input.now &&
        epoch(proposed.fresh_until) > input.now
      )
    ) {
      counts.not_newer_or_stale++;
      continue;
    }
    const old = packageWindow(prior);
    const next = packageWindow(proposed);
    if (!old || !next) {
      counts.incomplete_release_assets++;
      continue;
    }
    const newReleases = [...next.keys()].filter((version) => !old.has(version)).sort();
    const removedReleases = [...old.keys()].filter((version) => !next.has(version)).sort();
    const changedReleases = [...next.keys()]
      .filter((version) => old.has(version) && old.get(version) !== next.get(version))
      .sort();
    if (!(newReleases.length || removedReleases.length || changedReleases.length)) {
      counts.unchanged++;
      continue;
    }
    counts.review_due++;
    changes.push({
      port_id: port,
      carriers,
      source: id,
      facts_sha256: proposed.facts_sha256,
      new_releases: newReleases,
      out_of_window: removedReleases,
      changed_releases: changedReleases,
    });
  }
  return { subjects: held.size, counts, changes };
}

const flaggedGroups = [
  { flag: "manual", heading: "Needs the owner (manual)" },
  { flag: "satisfied", heading: "Condition satisfied, review the hold" },
  { flag: "unknown", heading: "Unknown, evidence missing" },
] as const;

export function renderRestrictionRecheck(report: RecheckReport): string {
  const { summary } = report;
  const lines = [
    `Restriction recheck: ${summary.holds} holds, ${summary.holds_with_conditions} with reconsideration conditions, ${summary.holds_without_conditions} without`,
    ...statuses.map(
      (status) => `  ${status.padEnd(16)} ${String(summary.by_flag[status]).padStart(5)}`,
    ),
    `Observer report: ${summary.observer_report}; evidence: ${summary.evidence}`,
    ...flaggedGroups.flatMap(({ flag, heading }) => {
      const group = report.flagged.filter((row) => row.flag === flag);
      return group.length
        ? [
            `${heading} (${group.length}):`,
            ...group.map(
              (row) =>
                `  ${row.port_id} ${row.carrier}/${row.restriction_id} (${row.reason})${row.flag === "manual" ? ` [machine ${row.machine ?? "none"}]` : ""}: ${row.conditions
                  .map((entry) => `${entry.condition} ${entry.status}`)
                  .join(", ")}`,
            ),
          ]
        : [];
    }),
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
