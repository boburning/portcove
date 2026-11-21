import type { PortDefinition } from "../apps/desktop/src/transport-types.generated.d.ts";
import type { RoadmapIssueItem } from "./roadmap-issue.mts";
import { orderedJsonSha256 as observationHash } from "./json-values.mts";
import { isRecord, recordField as qualificationField } from "./runtime-values.mts";
import {
  diagnosticText,
  portMarker,
  portTitlePrefix,
  portCatalogMarkers,
  portUpstreamMarkers,
  portKeyMarkers,
  normalizePortKey,
  normalizedPortTitle,
  issueNumber,
  discoveredPortIssues,
  portIdentity,
  isNonCatalogResearchBody,
  itemTitle,
  itemUrl,
  itemBody,
  fieldValue,
} from "./roadmap-issue.mts";

// Diagnostic projections only. Core still owns catalog admission; unknown
// qualification records are narrowed by the exact-scope checks below.
type QualificationPlatformFields = Pick<
  PortDefinition,
  "platforms" | "automated_tested_platforms" | "manually_validated_platforms"
>;
export type QualificationPortObservation = Pick<PortDefinition, "id"> & {
  [K in keyof QualificationPlatformFields]?: readonly string[];
} & { support_tier?: unknown; project_url?: unknown };
export interface QualificationCatalogObservation {
  ports?: readonly QualificationPortObservation[] | null;
  source_catalog?: { qualification?: readonly unknown[] | null } | null;
}
const catalogedPortStages = new Set<unknown>([
  "Cataloged",
  "Automated qualification",
  "Manual qualification",
  "Supported",
]);
const automatedPortStages = new Set<unknown>([
  "Automated qualification",
  "Manual qualification",
  "Supported",
]);
function qualificationScopeDetails(
  port: QualificationPortObservation | null | undefined,
  scope: unknown,
): { key: string; platform: string } | null {
  if (!isRecord(scope)) return null;
  const variant = isRecord(scope.variant) ? scope.variant : undefined;
  const identity = isRecord(variant?.identity) ? variant.identity : undefined;
  if (
    !port ||
    scope.port_id !== port.id ||
    typeof scope.platform !== "string" ||
    !(port.platforms ?? []).includes(scope.platform) ||
    typeof scope.artifact_sha256 !== "string" ||
    !/^[a-f0-9]{64}$/iu.test(scope.artifact_sha256) ||
    variant?.state !== "exact" ||
    !identity ||
    ![
      scope.upstream_ref,
      scope.contract_id,
      scope.check_version,
      identity.game_id,
      identity.variant_id,
      identity.representation_id,
    ].every((value) => typeof value === "string" && value.length > 0)
  )
    return null;
  return {
    key: JSON.stringify([
      scope.port_id,
      scope.platform,
      scope.artifact_sha256,
      scope.upstream_ref,
      scope.contract_id,
      identity.game_id,
      identity.variant_id,
      identity.representation_id,
      scope.check_version,
    ]),
    platform: scope.platform,
  };
}
function qualificationScopeKey(
  port: QualificationPortObservation | null | undefined,
  scope: unknown,
): string | null {
  return qualificationScopeDetails(port, scope)?.key ?? null;
}
function exactQualificationKeys(
  port: QualificationPortObservation | null | undefined,
  qualificationRecords: readonly unknown[] | null | undefined,
  kind: string,
): Set<string> {
  return new Set(
    (qualificationRecords ?? [])
      .filter(
        (record) =>
          qualificationField(record, "kind") === kind &&
          qualificationField(record, "outcome") === "passed",
      )
      .map((record) => qualificationScopeKey(port, qualificationField(record, "scope")))
      .filter((key) => key !== null),
  );
}
function exactQualificationPlatforms(
  port: QualificationPortObservation | null | undefined,
  qualificationRecords: readonly unknown[] | null | undefined,
  kind: string,
): Set<string> {
  const declared = new Set(port?.platforms ?? []);
  return new Set(
    (qualificationRecords ?? []).flatMap((record) => {
      const exact = qualificationScopeDetails(port, qualificationField(record, "scope"));
      return exact &&
        qualificationField(record, "kind") === kind &&
        qualificationField(record, "outcome") === "passed" &&
        declared.has(exact.platform)
        ? [exact.platform]
        : [];
    }),
  );
}
export function qualifiedPlatforms(
  port: QualificationPortObservation | null | undefined,
  qualificationRecords: readonly unknown[] | null = [],
): string[] {
  const automated = exactQualificationKeys(port, qualificationRecords, "automated_lifecycle");
  const exact = new Set(
    (qualificationRecords ?? []).flatMap((record) => {
      if (
        qualificationField(record, "kind") !== "hands_on" ||
        qualificationField(record, "outcome") !== "passed"
      )
        return [];
      const scope = qualificationScopeDetails(port, qualificationField(record, "scope"));
      return scope && automated.has(scope.key) ? [scope.platform] : [];
    }),
  );
  const legacyAutomated = new Set(port?.automated_tested_platforms ?? []);
  const legacyManual = new Set(port?.manually_validated_platforms ?? []);
  return (port?.platforms ?? []).filter(
    (platform) =>
      exact.has(platform) || (legacyAutomated.has(platform) && legacyManual.has(platform)),
  );
}
function automatedPlatforms(
  port: QualificationPortObservation | null | undefined,
  qualificationRecords: readonly unknown[] | null = [],
): string[] {
  const automated = new Set(port?.automated_tested_platforms ?? []);
  for (const platform of exactQualificationPlatforms(
    port,
    qualificationRecords,
    "automated_lifecycle",
  ))
    automated.add(platform);
  return (port?.platforms ?? []).filter((platform) => automated.has(platform));
}

const manualStages = ["Watchlist", "Researching", "Blocked", "Rejected"] as const;
const derivedStages = ["Cataloged", "Automated qualification", "Supported"] as const;
const historicalStages = [
  "Source contract known",
  "Release integrity qualified",
  "Manual qualification",
] as const;
type DerivedPortStage = (typeof derivedStages)[number];

function catalogStage(port: QualificationPortObservation, records: readonly unknown[]) {
  const automated = automatedPlatforms(port, records);
  const qualified = qualifiedPlatforms(port, records);
  const stage: DerivedPortStage = qualified.length
    ? "Supported"
    : automated.length
      ? "Automated qualification"
      : "Cataloged";
  return {
    catalog_id: port.id,
    stage,
    automated_platforms: automated,
    supported_platforms: qualified,
  };
}

/** Inspect the current planning value independently of the catalog's evidence-backed value. */
export function inspectRoadmapPortStages(
  catalog: QualificationCatalogObservation | null | undefined,
  items: readonly RoadmapIssueItem[],
  repository?: string,
  repositoryIssues?: readonly RoadmapIssueItem[],
) {
  const records = catalog?.source_catalog?.qualification ?? [];
  const ports = new Map(
    (catalog?.ports ?? []).map((port) => [port.id, catalogStage(port, records)]),
  );
  const markerClaims = new Map<string, Set<string>>();
  for (const issue of discoveredPortIssues(repositoryIssues ?? items)) {
    const identity = issue.id ?? itemUrl(issue);
    if (!identity) continue;
    for (const id of portCatalogMarkers(itemBody(issue))) {
      const claims = markerClaims.get(id) ?? new Set<string>();
      claims.add(identity);
      markerClaims.set(id, claims);
    }
  }
  const permittedUrl = repository
    ? "https://github.com/" + repository.toLowerCase() + "/issues/"
    : null;
  const rows = items.flatMap((item) => {
    const body = itemBody(item);
    const current = fieldValue(item, "Port stage");
    const workType = fieldValue(item, "Work type");
    if (
      (current == null || current === "") &&
      workType !== "Port" &&
      !body.includes(portMarker) &&
      !portTitlePrefix.test(itemTitle(item))
    )
      return [];
    const claims = portCatalogMarkers(body);
    const url = itemUrl(item) ?? null;
    const canonical =
      body.includes(portMarker) &&
      (!permittedUrl || url?.toLowerCase() === permittedUrl + String(issueNumber(item)));
    const port = claims.length === 1 ? ports.get(claims[0]!) : undefined;
    const ambiguous = claims.some((id) => (markerClaims.get(id)?.size ?? 0) > 1);
    const derived = canonical && port && !ambiguous ? port : null;
    const stage = typeof current === "string" && current !== "" ? current : null;
    const storedRank = derivedStages.findIndex((value) => stage === value);
    const classification = manualStages.some((value) => stage === value)
      ? "preserve_manual"
      : historicalStages.some((value) => stage === value)
        ? "review_historical"
        : storedRank >= 0 && derived
          ? stage === derived.stage
            ? "aligned"
            : "derived_drift"
          : "unresolved";
    const drift = classification === "derived_drift" ? derived : null;
    return [
      {
        item_id: item.id ?? null,
        archived: typeof item.isArchived === "boolean" ? item.isArchived : null,
        content_id: item.content?.id ?? null,
        issue_url: url,
        title: itemTitle(item),
        observed_content_revision: item.content?.updatedAt ?? null,
        observed_body_sha256: observationHash(body),
        work_type: typeof workType === "string" ? workType : null,
        current_stage: stage,
        classification,
        catalog_claims: claims,
        catalog_evidence: derived,
        drift_direction: drift
          ? storedRank > derivedStages.indexOf(drift.stage)
            ? "overstates_catalog"
            : "understates_catalog"
          : undefined,
        proposed_action: drift
          ? { kind: "review_project_assignment", target_stage: drift.stage }
          : storedRank >= 0 && !derived
            ? { kind: "verify_catalog_binding", target_stage: null }
            : undefined,
        unresolved_reason: !canonical
          ? "canonical_issue_required"
          : ambiguous
            ? "competing_catalog_claims"
            : claims.length !== 1
              ? claims.length
                ? "multiple_catalog_markers"
                : "no_catalog_marker"
              : !port
                ? "unrecognized_catalog_id"
                : classification === "unresolved"
                  ? "unset_or_unrecognized_project_stage"
                  : null,
      } as const,
    ];
  });
  return { rows, ports };
}

export function planPortStageMigration(
  catalog: QualificationCatalogObservation,
  items: readonly RoadmapIssueItem[],
  repository: string,
  repositoryIssues: readonly RoadmapIssueItem[],
  issueFreeIds: ReadonlySet<string>,
) {
  const { rows, ports } = inspectRoadmapPortStages(catalog, items, repository, repositoryIssues);
  const count = (classification: (typeof rows)[number]["classification"]) =>
    rows.filter((row) => row.classification === classification).length;
  return {
    proposed_stage_set: { manual: manualStages, derived: derivedStages, retire: historicalStages },
    counts: {
      project_items: items.length,
      active_items: items.filter((item) => item.isArchived === false).length,
      archived_items: items.filter((item) => item.isArchived === true).length,
      port_stage_records: rows.length,
      other_items: items.length - rows.length,
      preserve_manual: count("preserve_manual"),
      review_historical: count("review_historical"),
      aligned: count("aligned"),
      derived_drift: count("derived_drift"),
      unresolved: count("unresolved"),
      issue_free_catalog_ports: issueFreeIds.size,
    },
    rows,
    issue_free_catalog_ports: [...issueFreeIds].sort().map((id) => {
      const evidence = ports.get(id);
      if (!evidence) throw new Error("Issue-free diagnostic lacks matching catalog identity");
      return evidence;
    }),
  };
}

function issueSection(body: unknown, heading: string) {
  const escaped = heading.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return (
    diagnosticText(body ?? "")
      .match(new RegExp(`^##\\s+${escaped}\\s*$([\\s\\S]*?)(?=^##\\s|(?![\\s\\S]))`, "im"))?.[1]
      ?.trim() ?? ""
  );
}

const blockerFieldPattern =
  /^(?:[-*][ \t]*)?(?:\*\*)?(Blocker|Resume condition|Reconsideration condition)(?:\*\*)?:[ \t]*(.*?)(?=\r?$)/gimu;

const blockerFieldText = (value: string) => value.replace(/[*_`]/gu, "").trim();

function usableBlockerField(value: string) {
  const text = blockerFieldText(value);
  return (
    text.length >= 12 &&
    !/^(?:pending|tbd|todo|none|unknown|n\/?a|not (?:yet )?(?:known|specified|established))(?:\b|[.!])/iu.test(
      text,
    ) &&
    !/^(?:\.{3}|…|<[^>]+>)$/u.test(text)
  );
}

function blockerSection(body: unknown) {
  return (
    issueSection(body, "Dependencies and blockers") ||
    issueSection(body, "Known dependencies and blockers")
  );
}

/**
 * The explicit `Blocker:` and `Resume condition:` fields of an issue's
 * dependencies section, when they are present and substantive. Legacy prose
 * and placeholders return null; this never guesses a condition from prose.
 */
export function explicitBlockerFields(
  body: unknown,
): { blocker: string | null; resume_condition: string } | null {
  const section = blockerSection(body);
  if (!section) return null;
  const fields = [...section.matchAll(blockerFieldPattern)];
  const blocker = fields.filter((match) => match[1]?.toLowerCase() === "blocker");
  const resume = fields.filter((match) => match[1]?.toLowerCase() !== "blocker");
  if (
    blocker.length > 1 ||
    resume.length !== 1 ||
    !usableBlockerField(resume[0]?.[2] ?? "") ||
    (blocker.length === 1 && !usableBlockerField(blocker[0]?.[2] ?? ""))
  )
    return null;
  return {
    blocker:
      blocker.length === 1
        ? Array.from(blockerFieldText(blocker[0]?.[2] ?? ""))
            .slice(0, 500)
            .join("")
        : null,
    // Truncated by code point, so a cut never leaves a lone surrogate.
    resume_condition: Array.from(blockerFieldText(resume[0]?.[2] ?? ""))
      .slice(0, 500)
      .join(""),
  };
}

function hasBlockedEvidence(body: unknown) {
  const section = blockerSection(body);
  if (
    !section ||
    /^(?:pending|tbd|todo|none)[.!]?$/i.test(section) ||
    /no current blocker (?:has been )?established/i.test(section)
  )
    return false;
  const fields = [...section.matchAll(blockerFieldPattern)];
  if (fields.length) {
    const blocker = fields.filter((match) => match[1]?.toLowerCase() === "blocker");
    const resume = fields.filter((match) => match[1]?.toLowerCase() !== "blocker");
    // The migration spelling is a field, not evidence of a particular verb.
    const remainder = section
      .replace(
        /^(?:[-*]\s*)?(?:\*\*)?(?:Resume condition|Reconsideration condition)(?:\*\*)?:[^\n]*$/gimu,
        "",
      )
      .trim();
    return (
      blocker.length <= 1 &&
      resume.length === 1 &&
      usableBlockerField(resume[0]?.[2] ?? "") &&
      (blocker.length === 1
        ? usableBlockerField(blocker[0]?.[2] ?? "")
        : usableBlockerField(remainder))
    );
  }
  // Existing prose remains readable during migration; new explicit fields never
  // fall back to incidental words when a required value is absent/placeholder.
  return (
    /\b(?:resume|until|when|needs?|required missing|after)\b/i.test(section) &&
    usableBlockerField(section)
  );
}

export function validatePortStageSemantics(
  catalog: QualificationCatalogObservation | null | undefined,
  items: readonly RoadmapIssueItem[] | null | undefined,
  repository?: string,
  repositoryIssues?: readonly RoadmapIssueItem[],
) {
  const errors = [];
  const warnings = [];
  const diagnostics = [];
  const derivedStageDrift = inspectRoadmapPortStages(
    catalog,
    items ?? [],
    repository,
    repositoryIssues,
  ).rows.filter((row) => row.classification === "derived_drift");
  for (const row of derivedStageDrift)
    warnings.push(
      "Derived Port-stage drift at " +
        (row.issue_url ?? row.title) +
        ": Project has " +
        row.current_stage +
        "; catalog evidence derives " +
        row.catalog_evidence?.stage,
    );
  const portsById = new Map((catalog?.ports ?? []).map((port) => [port.id, port] as const));
  const qualificationRecords = catalog?.source_catalog?.qualification ?? [];

  for (const port of portsById.values()) {
    const automated = exactQualificationKeys(port, qualificationRecords, "automated_lifecycle");
    const manualEvidence = [
      ...(port.manually_validated_platforms ?? []).map((platform) => ({
        platform,
        matching: (port.automated_tested_platforms ?? []).includes(platform),
      })),
      ...qualificationRecords
        .filter(
          (record) =>
            qualificationField(qualificationField(record, "scope"), "port_id") === port.id &&
            qualificationField(record, "kind") === "hands_on" &&
            qualificationField(record, "outcome") === "passed",
        )
        .map((record) => ({
          platform: qualificationField(qualificationField(record, "scope"), "platform"),
          matching: (() => {
            const key = qualificationScopeKey(port, qualificationField(record, "scope"));
            return key !== null && automated.has(key);
          })(),
        })),
    ];
    for (const { platform, matching } of manualEvidence) {
      if (typeof platform !== "string" || !(port.platforms ?? []).includes(platform) || !matching) {
        errors.push(
          `Catalog port ${port.id} has manual evidence without matching declared automated qualification for ${diagnosticText(platform)}`,
        );
      }
    }
  }

  for (const item of items ?? []) {
    const body = itemBody(item);
    if (!body.includes(portMarker) && !portTitlePrefix.test(itemTitle(item))) continue;
    const stage = fieldValue(item, "Port stage");
    if (!stage) continue;
    const url = itemUrl(item) ?? itemTitle(item);
    const ids = portCatalogMarkers(body);
    const id = ids.length === 1 ? ids[0] : null;
    const port = id ? portsById.get(id) : null;
    const automated = automatedPlatforms(port, qualificationRecords);
    const qualified = qualifiedPlatforms(port, qualificationRecords);

    if (catalogedPortStages.has(stage) && (!id || !port || ids.length !== 1)) {
      errors.push(`${diagnosticText(stage)} port must have exactly one valid catalog ID: ${url}`);
    }
    if (automatedPortStages.has(stage) && port && automated.length === 0) {
      errors.push(
        `${diagnosticText(stage)} port has no automated evidence for a declared platform: ${url}`,
      );
    }
    if (stage === "Supported") {
      if (id && !port) errors.push(`Supported port claims unknown catalog ID ${id}: ${url}`);
      if (port && qualified.length === 0) {
        errors.push(
          `Supported port has no platform with matching automated and hands-on evidence: ${url}`,
        );
      }
      if (port && qualified.length) {
        diagnostics.push(`Supported ${url}: qualified platforms = ${qualified.join(", ")}`);
      }
    }
    if (stage === "Blocked" && !hasBlockedEvidence(body)) {
      errors.push(`Blocked port lacks a usable blocker and exact resume condition: ${url}`);
    }
    if (stage === "Rejected" && port) {
      errors.push(`Rejected port is still represented as catalog-supported by ${id}: ${url}`);
    }
    const understatesQualification =
      (qualified.length > 0 && stage !== "Supported") ||
      (automated.length > 0 && !automatedPortStages.has(stage));
    if (
      port &&
      !["Blocked", "Rejected"].some((value) => value === stage) &&
      understatesQualification
    ) {
      warnings.push(
        `${url} may conservatively understate catalog qualification at Port stage ${diagnosticText(stage)}; no automatic promotion was made`,
      );
    }
  }
  return { errors, warnings, diagnostics, derivedStageDrift };
}

export function planPortStageReconciliation(
  catalog: QualificationCatalogObservation | null | undefined,
  items: readonly RoadmapIssueItem[] | null | undefined,
) {
  const portsById = new Map((catalog?.ports ?? []).map((port) => [port.id, port] as const));
  const qualificationRecords = catalog?.source_catalog?.qualification ?? [];
  const changes = [];
  for (const item of items ?? []) {
    if (fieldValue(item, "Port stage") !== "Supported") continue;
    const ids = portCatalogMarkers(itemBody(item));
    const port = ids.length === 1 ? portsById.get(ids[0] ?? "") : null;
    if (qualifiedPlatforms(port, qualificationRecords).length) continue;
    const next = !port
      ? "Watchlist"
      : automatedPlatforms(port, qualificationRecords).length
        ? "Automated qualification"
        : "Cataloged";
    changes.push({
      itemId: item.id,
      issueNumber: issueNumber(item),
      title: itemTitle(item),
      from: "Supported",
      to: next,
    });
  }
  return changes;
}

/** Use the generated listing that describes the exact operational port identity.
 * Older catalogs or unmatched listings keep the ordinary canonical issue requirement. */
export function issueFreeCatalogIds(catalog: QualificationCatalogObservation, directory: unknown) {
  if (!isRecord(directory) || !Array.isArray(directory.listings))
    throw new Error("Catalog diagnostic input requires a listing array");
  const listings = new Map<string, Record<string, unknown>>();
  for (const listing of directory.listings as unknown[]) {
    if (!isRecord(listing) || typeof listing.id !== "string" || listings.has(listing.id))
      throw new Error("Catalog listing diagnostic identity is missing or repeated");
    listings.set(listing.id, listing);
  }
  return new Set(
    (catalog.ports ?? [])
      .filter((port) => {
        const listing = listings.get(port.id);
        return (
          listing &&
          typeof port.project_url === "string" &&
          listing.project_url === port.project_url &&
          !("issue_number" in listing) &&
          isRecord(listing.original_game) &&
          listing.original_game.format_version === 1 &&
          typeof listing.original_game.id === "string" &&
          listing.original_game.id.length > 0 &&
          Array.isArray(listing.original_game.evidence_urls) &&
          listing.original_game.evidence_urls.length > 0
        );
      })
      .map((port) => port.id),
  );
}

export function validatePortIssueCoverage(
  catalog: QualificationCatalogObservation | null | undefined,
  items: readonly RoadmapIssueItem[] | null | undefined,
  repository: string,
  repositoryIssues: readonly RoadmapIssueItem[] | null = null,
  issueFreeIds: ReadonlySet<string> = new Set(),
) {
  const errors = [];
  const catalogIds = new Set((catalog?.ports ?? []).map((port) => port.id));
  const issuesByCatalogId = new Map<string, string[]>();
  const issuesByPortKey = new Map<string, string[]>();
  const issuesByTitle = new Map<string, string[]>();
  const issuesByUpstreamAndIdentity = new Map<string, string[]>();
  const projectItemsByNumber = new Map<number, RoadmapIssueItem[]>();
  const repositoryIssuePrefix = repository
    ? `https://github.com/${repository.toLowerCase()}/issues/`
    : null;
  for (const item of items ?? []) {
    const number = issueNumber(item);
    const itemUrlValue = String(itemUrl(item) ?? "").toLowerCase();
    if (number && (!repositoryIssuePrefix || itemUrlValue.startsWith(repositoryIssuePrefix))) {
      const matches = projectItemsByNumber.get(number) ?? [];
      matches.push(item);
      projectItemsByNumber.set(number, matches);
    }
    if (fieldValue(item, "Work type") !== "Port") continue;
    const content = item?.content;
    const type = String(content?.type ?? content?.__typename ?? item?.type ?? "").toLowerCase();
    const url = itemUrl(item) ?? itemTitle(item);
    if (
      type.includes("draft") ||
      !/^https:\/\/github\.com\/[^/]+\/[^/]+\/issues\/\d+/.test(itemUrl(item) ?? "")
    ) {
      errors.push(`Port Project item is not backed by a repository issue: ${url}`);
      continue;
    }
    if (
      repositoryIssuePrefix &&
      !String(itemUrl(item)).toLowerCase().startsWith(repositoryIssuePrefix)
    ) {
      errors.push(`Port issue is outside ${repository}: ${url}`);
    }
    const body = itemBody(item);
    if (!body.includes(portMarker))
      errors.push(`Port issue lacks the canonical port marker: ${url}`);
  }

  const repositoryPorts = discoveredPortIssues(repositoryIssues ?? items);
  for (const issue of repositoryPorts) {
    const url = itemUrl(issue) ?? itemTitle(issue);
    const number = issueNumber(issue);
    if (repositoryIssuePrefix && !String(url).toLowerCase().startsWith(repositoryIssuePrefix)) {
      errors.push(`Canonical port issue is outside ${repository}: ${url}`);
    }
    const projectMatches = number ? (projectItemsByNumber.get(number) ?? []) : [];
    if (projectMatches.length === 0) {
      errors.push(`Canonical repository port issue is not in the Project: ${url}`);
    } else if (projectMatches.length > 1) {
      errors.push(
        `Canonical repository port issue has multiple Project items: ${url} (${projectMatches.length})`,
      );
    } else if (fieldValue(projectMatches[0], "Work type") !== "Port") {
      errors.push(`Canonical repository port issue is not classified as Work type = Port: ${url}`);
    }
    const body = itemBody(issue);
    if (!body.includes(portMarker)) {
      errors.push(
        `Open [Port] issue lacks the canonical port marker: ${url}. Run node scripts/roadmap.mts normalize-port --issue ${number}`,
      );
    }
    const upstreams = portUpstreamMarkers(body);
    if (upstreams.length !== 1) {
      errors.push(
        "Port issue must claim exactly one direct upstream: " + url + " (" + upstreams.length + ")",
      );
    }
    const ids = portCatalogMarkers(body);
    const keys = portKeyMarkers(body);
    const identity = portIdentity(issue);
    if (ids.length > 1)
      errors.push(`One issue claims multiple catalog ports: ${url} (${ids.join(", ")})`);
    if (keys.length > 1)
      errors.push(`One issue claims multiple durable port keys: ${url} (${keys.join(", ")})`);
    if (ids.length === 1) {
      const id = ids[0];
      if (id === undefined) throw new Error("Required catalog marker is missing");
      if (!catalogIds.has(id)) errors.push(`Port issue claims unknown catalog ID ${id}: ${url}`);
      const matches = issuesByCatalogId.get(id) ?? [];
      matches.push(url);
      issuesByCatalogId.set(id, matches);
    } else {
      if (!isNonCatalogResearchBody(body)) {
        errors.push(
          "Non-catalog port issue must identify research/watchlist status and disclaim support: " +
            url,
        );
      }
      if (keys.length !== 1) {
        errors.push(
          `Non-catalog port issue must claim exactly one durable port key: ${url} (${keys.length})`,
        );
      } else {
        const key = keys[0];
        if (key === undefined) throw new Error("Required port key marker is missing");
        const normalized = normalizePortKey(key);
        if (!normalized || normalized !== key) {
          errors.push(`Non-catalog port issue has a non-canonical port key ${key}: ${url}`);
        }
        const matches = issuesByPortKey.get(normalized) ?? [];
        matches.push(url);
        issuesByPortKey.set(normalized, matches);
      }
    }
    if (ids.length === 0 && keys.length === 0 && identity.keys.length === 1) {
      const normalized = identity.keys[0];
      if (normalized === undefined) throw new Error("Required port identity is missing");
      const matches = issuesByPortKey.get(normalized) ?? [];
      matches.push(url);
      issuesByPortKey.set(normalized, matches);
    }
    const title = normalizedPortTitle(itemTitle(issue));
    if (title) {
      const matches = issuesByTitle.get(title) ?? [];
      matches.push(url);
      issuesByTitle.set(title, matches);
    }
    if (identity.upstreams.length === 1) {
      const targetIdentity = ids[0] ?? identity.keys[0] ?? title;
      const combined = `${identity.upstreams[0]}|${targetIdentity}`;
      const matches = issuesByUpstreamAndIdentity.get(combined) ?? [];
      matches.push(url);
      issuesByUpstreamAndIdentity.set(combined, matches);
    }
  }
  for (const id of catalogIds) {
    const matches = issuesByCatalogId.get(id) ?? [];
    if (matches.length === 0 && !issueFreeIds.has(id))
      errors.push(`Catalog port lacks a canonical Project issue: ${id}`);
    if (matches.length > 1)
      errors.push(`Two live issues represent catalog ID ${id}: ${matches.join(", ")}`);
  }
  for (const [key, matches] of issuesByPortKey) {
    if (matches.length > 1)
      errors.push(`Two live issues represent non-catalog port key ${key}: ${matches.join(", ")}`);
  }
  for (const [title, matches] of issuesByTitle) {
    if (matches.length > 1)
      errors.push(
        `Two live port issues have the same normalized title identity ${title}: ${matches.join(", ")}`,
      );
  }
  for (const [identity, matches] of issuesByUpstreamAndIdentity) {
    if (matches.length > 1)
      errors.push(
        `Two live port issues share direct upstream and game/target identity ${identity}: ${matches.join(", ")}`,
      );
  }
  return errors;
}

type LoadedQualificationCatalog = QualificationCatalogObservation & {
  ports: QualificationPortObservation[];
};
export function qualificationCatalogObservation(value: unknown): LoadedQualificationCatalog {
  if (!isRecord(value) || !Array.isArray(value.ports))
    throw new Error("catalog diagnostic input requires a port array");
  const ports: unknown[] = value.ports;
  for (const port of ports) {
    if (!isRecord(port) || typeof port.id !== "string")
      throw new Error("catalog diagnostic port identity is malformed");
    for (const field of [
      "platforms",
      "automated_tested_platforms",
      "manually_validated_platforms",
    ] as const) {
      const entries = port[field];
      if (
        entries !== undefined &&
        (!Array.isArray(entries) || !entries.every((entry: unknown) => typeof entry === "string"))
      )
        throw new Error(`catalog diagnostic ${field} is malformed`);
    }
  }
  if (
    value.source_catalog != null &&
    (!isRecord(value.source_catalog) ||
      (value.source_catalog.qualification != null &&
        !Array.isArray(value.source_catalog.qualification)))
  )
    throw new Error("catalog diagnostic qualification collection is malformed");
  // Only consumed diagnostic fields are projected; Core retains catalog admission authority.
  return value as Record<string, unknown> & LoadedQualificationCatalog;
}
export function catalogQualificationSummary(
  catalog: QualificationCatalogObservation | null | undefined,
) {
  const ports: readonly QualificationPortObservation[] = Array.isArray(catalog?.ports)
    ? catalog.ports
    : [];
  const byTier: Record<string, number> = {};
  const declared = new Set();
  const automated = new Set();
  const manual = new Set();
  for (const port of ports) {
    byTier[diagnosticText(port.support_tier ?? "unspecified")] =
      (byTier[diagnosticText(port.support_tier ?? "unspecified")] ?? 0) + 1;
    for (const platform of port.platforms ?? []) declared.add(`${port.id}:${platform}`);
    for (const platform of port.automated_tested_platforms ?? [])
      automated.add(`${port.id}:${platform}`);
    for (const platform of port.manually_validated_platforms ?? [])
      manual.add(`${port.id}:${platform}`);
  }
  return {
    ports: ports.length,
    byTier,
    declaredPlatformPairs: declared.size,
    automatedPlatformPairs: automated.size,
    manuallyValidatedPlatformPairs: manual.size,
  };
}
