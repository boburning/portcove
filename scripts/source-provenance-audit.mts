import { requireRepositoryIssueInventory } from "./repository-issue-inventory.mts";
import type { RoadmapIssueItem } from "./roadmap-issue.mts";
import type {
  PortSourceContract,
  SourceIdentityProfile,
  SourceVariant,
  SourceRepresentation,
  PortDefinition,
} from "../apps/desktop/src/transport-types.generated.d.ts";
import type { createGitHubRunner as RunnerFactory } from "./github-api.mts";
import { isRecord, errorMessage } from "./runtime-values.mts";
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { createGitHubRunner } from "./github-api.mts";
import {
  RoadmapClient,
  validateConfig,
  fieldValue,
  validatePortIssueCoverage,
  validatePortStageSemantics,
} from "./roadmap.mts";
import { sourceProvenancePortIdentity, sourceProvenancePortIssues } from "./roadmap-issue.mts";

const scriptPath = fileURLToPath(import.meta.url);
const projectRoot = path.resolve(path.dirname(scriptPath), "..");
const defaultCatalogPath = path.join(
  projectRoot,
  "crates",
  "portcove-core",
  "catalog",
  "catalog.json",
);

// Read-only consumed projections; Core's generated schema remains authoritative.
type AuditContract = Pick<
  PortSourceContract,
  | "id"
  | "port_id"
  | "profile_id"
  | "supported_variant_ids"
  | "validator_contract_id"
  | "evidence_gap"
  | "evidence_ids"
>;
type AuditRepresentation = Pick<SourceRepresentation, "id"> & { kind: unknown };
type AuditVariant = Pick<SourceVariant, "id" | "legacy_projection_only"> & {
  representations: AuditRepresentation[];
};
type AuditProfile = Pick<SourceIdentityProfile, "id"> & { variants: AuditVariant[] };
type AuditPort = Pick<PortDefinition, "id"> & {
  name?: string | null;
  title?: string | null;
  platforms: string[];
  automated_tested_platforms: string[];
  manually_validated_platforms: string[];
};
function object(value: unknown): Record<string, unknown> {
  return isRecord(value) ? value : {};
}
function readJson(text: string): unknown {
  return JSON.parse(text);
}
function diagnosticText(value: unknown): string {
  return String(value);
}
function rawArray(value: unknown, label: string): unknown[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) throw new Error(`${label} must be an array`);
  return value;
}
function text(value: unknown, label: string): string {
  if (typeof value !== "string") throw new Error(`${label} must be a string`);
  return value;
}
function texts(value: unknown, label: string): string[] {
  return rawArray(value, label).map((entry) => text(entry, label));
}
function auditCatalog(value: unknown) {
  if (!isRecord(value)) throw new Error("catalog must be an object");
  const source = object(value.source_catalog);
  const named = (entry: unknown): Record<string, unknown> & { id: string } => {
    const raw = object(entry);
    return { ...raw, id: text(raw.id, "catalog ID") };
  };
  const identities: AuditProfile[] = rawArray(source.identities, "identities").map((entry) => {
    const profile = named(entry);
    return {
      ...profile,
      variants: rawArray(profile.variants, "variants").map((entry) => {
        const variant = named(entry);
        if (
          variant.legacy_projection_only !== undefined &&
          typeof variant.legacy_projection_only !== "boolean"
        )
          throw new Error("legacy projection flag must be boolean");
        return {
          ...variant,
          ...(variant.legacy_projection_only !== undefined
            ? { legacy_projection_only: variant.legacy_projection_only }
            : {}),
          representations: rawArray(variant.representations, "representations").map((entry) => {
            const raw = named(entry);
            return { ...raw, kind: raw.kind };
          }),
        };
      }),
    };
  });
  const contracts: AuditContract[] = rawArray(source.contracts, "contracts").map((entry) => {
    const raw = named(entry);
    return {
      ...raw,
      port_id: text(raw.port_id, "port ID"),
      profile_id: text(raw.profile_id, "profile ID"),
      supported_variant_ids: texts(raw.supported_variant_ids, "supported variant IDs"),
      evidence_ids: texts(raw.evidence_ids, "evidence IDs"),
      validator_contract_id:
        raw.validator_contract_id == null ? null : text(raw.validator_contract_id, "validator ID"),
      evidence_gap: raw.evidence_gap == null ? null : text(raw.evidence_gap, "evidence gap"),
    };
  });
  const ports: AuditPort[] = rawArray(value.ports, "ports").map((entry) => {
    const raw = named(entry);
    return {
      ...raw,
      ...(raw.name == null ? {} : { name: text(raw.name, "port name") }),
      ...(raw.title == null ? {} : { title: text(raw.title, "port title") }),
      platforms: texts(raw.platforms, "platforms"),
      automated_tested_platforms: texts(raw.automated_tested_platforms, "automated platforms"),
      manually_validated_platforms: texts(raw.manually_validated_platforms, "manual platforms"),
    };
  });
  return {
    ...value,
    ports,
    source_catalog: {
      ...source,
      identities,
      contracts,
      evidence: rawArray(source.evidence, "evidence").map((entry) => {
        const raw = named(entry);
        return { ...raw, role: raw.role };
      }),
      validators: rawArray(source.validators, "validators").map(named),
      qualification: rawArray(source.qualification, "qualification"),
    },
  };
}
type AuditCatalog = ReturnType<typeof auditCatalog>;
type AuditSource = AuditCatalog["source_catalog"];
function assertIssue(value: unknown): asserts value is RoadmapIssueItem {
  if (!isRecord(value)) throw new Error("issue inventory entry must be an object");
  for (const key of ["id", "type", "__typename"] as const)
    if (value[key] !== undefined && typeof value[key] !== "string")
      throw new Error(`issue ${key} must be a string`);
  for (const key of ["title", "body", "url", "state"] as const)
    if (value[key] != null && typeof value[key] !== "string")
      throw new Error(`issue ${key} must be a string`);
  if (
    value.number !== undefined &&
    typeof value.number !== "number" &&
    typeof value.number !== "string"
  )
    throw new Error("issue number must be numeric");
  if (value.content != null) assertIssue(value.content);
  if (value.fieldValues !== undefined) {
    if (!Array.isArray(value.fieldValues)) throw new Error("issue fieldValues must be an array");
    const fields: unknown[] = value.fieldValues;
    for (const field of fields) {
      if (!isRecord(field)) throw new Error("issue field value must be an object");
      for (const key of ["field", "option"])
        if (field[key] != null && !isRecord(field[key]))
          throw new Error("issue field metadata must be an object");
    }
  }
  if (value.blockedBy != null) {
    const blockedBy: unknown = value.blockedBy;
    if (Array.isArray(blockedBy)) {
      const dependencies: unknown[] = blockedBy;
      dependencies.forEach(assertIssue);
    } else {
      if (!isRecord(blockedBy)) throw new Error("issue blockedBy must be a connection or array");
      if (blockedBy.totalCount !== undefined && typeof blockedBy.totalCount !== "number")
        throw new Error("issue dependency total must be numeric");
      if (blockedBy.nodes !== undefined) {
        if (!Array.isArray(blockedBy.nodes))
          throw new Error("issue dependency nodes must be an array");
        const dependencies: unknown[] = blockedBy.nodes;
        dependencies.forEach(assertIssue);
      }
    }
  }
}
function readIssue(value: unknown): RoadmapIssueItem {
  assertIssue(value);
  return value;
}
function collection(value: unknown): RoadmapIssueItem[] {
  return rawArray(Array.isArray(value) ? value : object(value).items, "issue collection").map(
    readIssue,
  );
}
type ReadCommand = (args: readonly string[], input?: string) => unknown;
interface AuditInput {
  catalogText: string;
  issues: unknown;
  projectItems?: unknown;
  pullRequests?: readonly RoadmapIssueItem[];
  generatedAt: string;
  baseCommit: string;
  generatorCommit: string;
  repository?: string;
  projectUrl?: string | null;
  expectedCatalogSha256?: string | null;
  projectState?: string;
}

function issueContent(value: RoadmapIssueItem | null | undefined) {
  return value?.content?.type === "Issue" || value?.content?.__typename === "Issue"
    ? value.content
    : (value ?? {});
}

function issueNumber(value: RoadmapIssueItem | null | undefined) {
  const number = Number(issueContent(value)?.number);
  return Number.isInteger(number) && number > 0 ? number : null;
}

function repositoryProjectIssueNumber(item: RoadmapIssueItem, repository: string) {
  const content = item.content ?? item;
  if (
    !content ||
    [content.type, content.__typename].some((type) => type !== undefined && type !== "Issue")
  )
    return null;
  const number = Number(content.number);
  if (!Number.isSafeInteger(number) || number <= 0) return null;
  try {
    const url = new URL(text(content.url, "issue URL"));
    const match = url.pathname.match(/^\/([^/]+\/[^/]+)\/issues\/([1-9]\d*)\/?$/u);
    return url.protocol === "https:" &&
      url.hostname === "github.com" &&
      !url.port &&
      !url.username &&
      !url.password &&
      !url.search &&
      !url.hash &&
      match &&
      (match[1] ?? "").toLowerCase() === repository.toLowerCase() &&
      Number(match[2]) === number
      ? number
      : null;
  } catch {
    return null;
  }
}

function duplicates(values: readonly string[]) {
  const counts = new Map<string, number>();
  for (const value of values.filter(Boolean)) counts.set(value, (counts.get(value) ?? 0) + 1);
  return [...counts]
    .filter(([, count]) => count > 1)
    .map(([value]) => value)
    .sort();
}

function evidenceReferences(value: unknown, found: unknown[] = []) {
  if (Array.isArray(value)) {
    for (const child of value) evidenceReferences(child, found);
  } else if (value && typeof value === "object") {
    for (const [key, child] of Object.entries(value)) {
      if (key === "evidence_ids" && Array.isArray(child))
        found.push(...rawArray(child, "evidence references"));
      else evidenceReferences(child, found);
    }
  }
  return found;
}

function projectContext(item: RoadmapIssueItem | null | undefined) {
  if (!item) return "Unavailable";
  const values = [
    ["Status", fieldValue(item, "Status")],
    ["Priority", fieldValue(item, "Priority")],
    ["Horizon", fieldValue(item, "Horizon")],
    ["Target", fieldValue(item, "Target release")],
    ["Stage", fieldValue(item, "Port stage")],
  ].filter(([, value]) => value);
  return values.length
    ? values.map(([name, value]) => `${diagnosticText(name)}: ${diagnosticText(value)}`).join("; ")
    : "No fields recorded";
}

// A collapsed section is still current unless its own summary explicitly supersedes it.
function withoutSupersededHistory(body: unknown) {
  const text = diagnosticText(body ?? "");
  const stack: { start: number; content: number }[] = [];
  const ignored: { start: number; end: number }[] = [];
  let fence: string | undefined;
  const tokens =
    /^ {0,3}(?:`{3,}|~{3,})[^\n]*(?:\n|$)|(`+)[\s\S]*?\1|<!--[\s\S]*?(?:-->|$)|<\/?details\b[^>]*>/gimu;
  for (const match of text.matchAll(tokens)) {
    const token = match[0];
    const marker = token.match(/^ {0,3}(`{3,}|~{3,})(.*)/u);
    if (marker) {
      if (!fence) fence = marker[1];
      else if (
        (marker[1] ?? "")[0] === fence[0] &&
        (marker[1] ?? "").length >= fence.length &&
        !(marker[2] ?? "").trim()
      )
        fence = undefined;
      continue;
    }
    if (fence || token.startsWith("<!--") || token.startsWith("`")) continue;
    if (!token.startsWith("</")) {
      stack.push({ start: match.index, content: match.index + token.length });
      continue;
    }
    const opening = stack.pop();
    if (!opening) continue;
    const end = match.index + token.length;
    const content = text.slice(opening.content, match.index);
    const summary = content.match(
      /^\s*<summary\b[^>]*>((?:(?!<\/?(?:details|summary)\b)[\s\S])*?)<\/summary\s*>/iu,
    )?.[1];
    // Accept complete supersession titles, not arbitrary sentences whose leading
    // word could introduce a question, negation, or an uncertain decision.
    const label = summary?.replace(/<!--([\s\S]*?)-->|<[^>]*>/gu, "").trim();
    if (/^superseded(?:\s+(?:historical\s+scope|history|scope))?$/iu.test(label ?? ""))
      ignored.push({ start: opening.start, end });
  }
  // Do not infer a boundary through malformed/unclosed parent details.
  const unclosed = stack[0]?.start ?? text.length;
  const ranges = ignored.filter(({ start }) => start < unclosed).sort((a, b) => a.start - b.start);
  let result = "";
  let cursor = 0;
  for (const { start, end } of ranges) {
    if (start < cursor) continue;
    result += `${text.slice(cursor, start)}\n`;
    cursor = end;
  }
  return result + text.slice(cursor);
}

function explicitGap(body: unknown) {
  const text = withoutSupersededHistory(body);
  const scoped = text.match(/^\s*- Current blocker and exact resume condition:\s*(.+)$/im)?.[1];
  if (scoped) return scoped.trim();
  const section = text.match(
    /^## Dependencies and blockers\s*$([\s\S]*?)(?=^##\s|(?![\s\S]))/im,
  )?.[1];
  if (!section) return "No explicit gap recorded";
  return (
    section
      .replace(/<\/?(?:details|summary)\b[^>]*>/giu, "")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 500) || "No explicit gap recorded"
  );
}

// PR facts are advisory evidence, never authority to resolve an issue or its
// remaining acceptance. Project membership is not a repository-wide PR inventory.
function sameRepositoryPrNumber(reference: string, repository: string) {
  const value = reference.replace(/[.,;:]+$/u, "");
  const scoped = value.match(/^([\w.-]+\/[\w.-]+)#([1-9]\d*)$/u);
  if (scoped)
    return (scoped[1] ?? "").toLowerCase() === repository.toLowerCase() ? Number(scoped[2]) : null;
  const bare = value.match(/^PR\s*#([1-9]\d*)$/iu);
  if (bare) return Number(bare[1]);
  try {
    const url = new URL(value);
    const path = url.pathname.match(/^\/([^/]+\/[^/]+)\/pull\/([1-9]\d*)\/?$/u);
    return url.protocol === "https:" &&
      url.hostname === "github.com" &&
      !url.port &&
      !url.username &&
      !url.password &&
      !url.search &&
      path &&
      (path[1] ?? "").toLowerCase() === repository.toLowerCase()
      ? Number(path[2])
      : null;
  } catch {
    return null;
  }
}

function knownMergedPrs(items: readonly RoadmapIssueItem[], repository: string) {
  const facts = new Map<number, boolean[]>();
  for (const item of items) {
    const pr = item.content ?? item;
    if (![pr.type, pr.__typename].includes("PullRequest")) continue;
    const url = diagnosticText(pr.url ?? "");
    if (!/^https:\/\/github\.com\/[^/]+\/[^/]+\/pull\/[1-9]\d*\/?$/u.test(url)) continue;
    const number = sameRepositoryPrNumber(url, repository);
    if (number === null || !Number.isSafeInteger(number) || number !== pr.number) continue;
    const records = facts.get(number) ?? [];
    records.push(pr.state === "MERGED" && pr.merged === true);
    facts.set(number, records);
  }
  return new Set(
    [...facts].filter(([, records]) => records.every(Boolean)).map(([number]) => number),
  );
}

function blockerOutsideExamples(body: unknown) {
  const text = withoutSupersededHistory(body).replace(/<!--[\s\S]*?(?:-->|$)/gu, "");
  let fence: string | undefined;
  const lines = [];
  for (const line of text.split("\n")) {
    const marker = line.match(/^ {0,3}(`{3,}|~{3,})(.*)$/u);
    if (marker) {
      if (!fence) fence = marker[1];
      else if (
        (marker[1] ?? "")[0] === fence[0] &&
        (marker[1] ?? "").length >= fence.length &&
        !(marker[2] ?? "").trim()
      )
        fence = undefined;
      lines.push("");
    } else lines.push(fence ? "" : line);
  }
  return explicitGap(lines.join("\n").replace(/(`+)[\s\S]*?\1/gu, ""));
}

function activeBlockerPrNumbers(body: unknown, repository: string) {
  const referenced = new Set<number>();
  for (const clause of blockerOutsideExamples(body).split(/(?<=[.!?])\s+|[;\n]/u)) {
    if (
      /[?]/u.test(clause) ||
      /\b(?:not|never|no longer|maybe|might|whether|unless|\w+n['’]t)\b/iu.test(clause)
    )
      continue;
    const waiting = clause.match(/\b(?:waiting|await(?:ing)?|blocked|pending|until)\b/iu);
    if (!waiting) continue;
    const references = /https?:\/\/[^\s<>()]+|[\w.-]+\/[\w.-]+#[1-9]\d*|\bPR\s*#[1-9]\d*\b/giu;
    for (const match of clause.matchAll(references)) {
      if (match.index < (waiting.index ?? 0)) continue;
      if (
        /^\s+(?:(?:has|is|was|already|been)\s+)*merged\b/iu.test(
          clause.slice(match.index + match[0].length),
        )
      )
        continue;
      const number = sameRepositoryPrNumber(match[0], repository);
      if (number !== null && Number.isSafeInteger(number)) referenced.add(number);
    }
  }
  return referenced;
}

function mergedBlockerObservations(
  issues: readonly RoadmapIssueItem[],
  items: readonly RoadmapIssueItem[],
  repository: string,
  projectState: string,
  suppliedItems: unknown,
) {
  if (!["available", "fixture"].includes(projectState)) return [];
  // Live pagination already fails closed before building a snapshot. Keep an
  // explicitly partial offline collection from presenting a PR-state conclusion.
  const supplied = object(suppliedItems);
  if (
    !Array.isArray(suppliedItems) &&
    ((supplied.pageInfo && object(supplied.pageInfo).hasNextPage !== false) ||
      (supplied.totalCount !== undefined &&
        supplied.totalCount !==
          (Array.isArray(supplied.items) ? supplied.items.length : undefined)))
  )
    return [];
  const merged = knownMergedPrs(items, repository);
  const observations: string[] = [];
  for (const issue of issues) {
    if (diagnosticText(issue.state).toUpperCase() !== "OPEN") continue;
    const referenced = activeBlockerPrNumbers(issue.body, repository);
    for (const number of referenced)
      if (merged.has(number))
        observations.push(
          `Active blocker references merged PR #${number}: ${issue.url}. Review remaining acceptance; merge alone does not resolve the blocker.`,
        );
  }
  return observations;
}

function releaseIntegrityState(body: unknown) {
  const text = withoutSupersededHistory(body);
  if (/release integrity:[^\n]*(?:pending|unknown|blocked)/i.test(text)) return "Gap recorded";
  if (
    /(?:checksum-qualified|release integrity:[^\n]*(?:verified|complete)|artifact[^\n]*sha-256)/i.test(
      text,
    )
  ) {
    return "Evidence mentioned in issue";
  }
  return "Not structurally recorded";
}

function sourceEvidenceState(body: unknown) {
  const value = withoutSupersededHistory(body)
    .match(/^\s*- Source requirements and accepted revisions:\s*(.+)$/im)?.[1]
    ?.trim();
  if (!value) return "Not structurally recorded";
  if (/^(?:pending|unknown|not (?:yet )?(?:known|recorded|available)|none)\b/i.test(value)) {
    return "Gap recorded";
  }
  return "Evidence mentioned in issue";
}

function profileForContract(sourceCatalog: AuditSource, contract: AuditContract) {
  return sourceCatalog.identities.find((profile) => profile.id === contract.profile_id);
}

function contractIdentityState(sourceCatalog: AuditSource, contract: AuditContract) {
  const profile = profileForContract(sourceCatalog, contract);
  if (!profile) return { complete: false, gap: `missing profile ${contract.profile_id}` };
  const missing = [];
  for (const variantId of contract.supported_variant_ids ?? []) {
    const variant = profile.variants?.find(
      (candidate) => candidate.id === variantId && !candidate.legacy_projection_only,
    );
    if (!variant) {
      missing.push(`${variantId}: missing active variant`);
      continue;
    }
    const representations = variant.representations ?? [];
    if (
      !representations.length ||
      representations.every((item) => item.kind === "informational-extension")
    ) {
      missing.push(`${variantId}: no deterministic representation`);
    }
  }
  if (!(contract.supported_variant_ids ?? []).length && !contract.validator_contract_id) {
    missing.push(contract.evidence_gap || "no deterministic variant or validator");
  }
  return { complete: missing.length === 0, gap: missing.join("; ") };
}

function qualificationSummary(records: readonly unknown[]) {
  if (!records.length) return "No exact records";
  const counts = new Map<string, number>();
  for (const raw of records) {
    const record = object(raw);
    const key = `${diagnosticText(record.kind)}:${diagnosticText(record.outcome)}`;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return [...counts]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, count]) => `${key}=${count}`)
    .join(", ");
}

function catalogDuplicateObservations(catalog: AuditCatalog) {
  const source = catalog.source_catalog ?? {};
  const observations: string[] = [];
  const add = (label: string, values: readonly string[]) => {
    for (const value of duplicates(values)) observations.push(`Duplicate ${label}: ${value}`);
  };
  add(
    "catalog port ID",
    (catalog.ports ?? []).map((item) => item.id),
  );
  add(
    "source profile ID",
    (source.identities ?? []).map((item) => item.id),
  );
  add(
    "source contract ID",
    (source.contracts ?? []).map((item) => item.id),
  );
  add(
    "source evidence ID",
    (source.evidence ?? []).map((item) => item.id),
  );
  add(
    "source validator ID",
    (source.validators ?? []).map((item) => item.id),
  );
  for (const profile of source.identities ?? []) {
    add(
      `variant ID in ${profile.id}`,
      (profile.variants ?? []).map((item) => item.id),
    );
    for (const variant of profile.variants ?? []) {
      add(
        `representation ID in ${profile.id}/${variant.id}`,
        (variant.representations ?? []).map((item) => item.id),
      );
    }
  }
  return observations;
}

export function buildSourceProvenanceAudit({
  catalogText,
  issues,
  projectItems = [],
  pullRequests = [],
  generatedAt,
  baseCommit,
  generatorCommit,
  repository = "boburning/portcove",
  projectUrl = null,
  expectedCatalogSha256 = null,
  projectState = "available",
}: AuditInput) {
  if (!generatedAt || Number.isNaN(Date.parse(generatedAt))) {
    throw new Error("generatedAt must be an explicit ISO-8601 timestamp");
  }
  if (!/^[0-9a-f]{40}$/i.test(baseCommit ?? "") || !/^[0-9a-f]{40}$/i.test(generatorCommit ?? "")) {
    throw new Error("baseCommit and generatorCommit must be full Git commit IDs");
  }
  const catalog = auditCatalog(JSON.parse(catalogText));
  const source = catalog.source_catalog ?? {
    evidence: [],
    identities: [],
    contracts: [],
    validators: [],
    qualification: [],
  };
  const catalogSha256 = createHash("sha256").update(catalogText).digest("hex");
  const allIssues = collection(issues);
  const allProjectItems = collection(projectItems);
  // Project membership is cross-repository and includes non-Issue content.
  // Keep the complete inventory for evidence, but join only scoped Issue identities.
  const repositoryProjectIssues = allProjectItems.filter(
    (item) => repositoryProjectIssueNumber(item, repository) !== null,
  );
  const portIssues = sourceProvenancePortIssues(allIssues)
    .map(issueContent)
    .sort((a, b) => (issueNumber(a) ?? 0) - (issueNumber(b) ?? 0));
  const projectByIssue = new Map(
    repositoryProjectIssues.map((item) => [repositoryProjectIssueNumber(item, repository), item]),
  );
  const issueByCatalogId = new Map<string, RoadmapIssueItem[]>();
  const research = [];
  for (const issue of portIssues) {
    const identity = sourceProvenancePortIdentity(issue);
    for (const id of identity.catalogIds) {
      const list = issueByCatalogId.get(id) ?? [];
      list.push(issue);
      issueByCatalogId.set(id, list);
    }
    if (!identity.catalogIds.length) {
      const projectItem = projectByIssue.get(issueNumber(issue));
      research.push({
        issue: issueNumber(issue),
        title: issue.title,
        url: issue.url,
        portKey: identity.portKeys[0] ?? "Missing",
        upstream: identity.upstreams[0] ?? "Missing",
        sourceEvidence: sourceEvidenceState(issue.body),
        releaseIntegrity: releaseIntegrityState(issue.body),
        projectContext: projectContext(projectItem),
        gap: explicitGap(issue.body),
      });
    }
  }

  const evidenceIds = new Set<unknown>((source.evidence ?? []).map((item) => item.id));
  const missingEvidence = [
    ...new Set(evidenceReferences(source).filter((id) => !evidenceIds.has(id))),
  ].sort((a, b) =>
    diagnosticText(a) < diagnosticText(b) ? -1 : diagnosticText(a) > diagnosticText(b) ? 1 : 0,
  );
  const qualification = source.qualification ?? [];
  const cataloged = (catalog.ports ?? [])
    .map((port) => {
      const contracts = (source.contracts ?? []).filter((contract) => contract.port_id === port.id);
      const contractStates = contracts.map((contract) => contractIdentityState(source, contract));
      const records = qualification.filter(
        (record) => object(object(record).scope).port_id === port.id,
      );
      const matches = issueByCatalogId.get(port.id) ?? [];
      const issue = matches[0];
      const projectItem = issue ? projectByIssue.get(issueNumber(issue)) : null;
      const contractEvidence = new Set(
        contracts.flatMap((contract) => contract.evidence_ids ?? []),
      );
      const unresolvedEvidence = [...contractEvidence].filter((id) => !evidenceIds.has(id));
      return {
        id: port.id,
        title: port.name ?? port.title ?? port.id,
        issue: issueNumber(issue),
        issueUrl: issue?.url ?? null,
        contracts: contracts.map((contract) => contract.id).sort(),
        deterministicIdentity:
          contractStates.length > 0 && contractStates.every((state) => state.complete),
        sourceEvidence: unresolvedEvidence.length
          ? `Missing: ${unresolvedEvidence.sort().join(", ")}`
          : contractEvidence.size
            ? `${contractEvidence.size} reviewed reference(s)`
            : "No contract evidence",
        qualification: `${qualificationSummary(records)}; legacy automated=${(port.automated_tested_platforms ?? []).length}, hands-on=${(port.manually_validated_platforms ?? []).length}`,
        legacyAutomatedPlatforms: [...(port.automated_tested_platforms ?? [])].sort(),
        legacyHandsOnPlatforms: [...(port.manually_validated_platforms ?? [])].sort(),
        projectContext: projectContext(projectItem),
        gap:
          [...contractStates.map((state) => state.gap).filter(Boolean)].join("; ") ||
          "No structural source gap",
      };
    })
    .sort((a, b) => a.id.localeCompare(b.id));

  const observations = [
    ...mergedBlockerObservations(
      portIssues,
      [...allProjectItems, ...pullRequests],
      repository,
      projectState,
      projectItems,
    ),
    ...catalogDuplicateObservations(catalog),
    ...validatePortIssueCoverage(catalog, repositoryProjectIssues, repository, allIssues),
    ...validatePortStageSemantics(catalog, repositoryProjectIssues).errors,
    ...missingEvidence.map((id) => `Missing source evidence reference: ${diagnosticText(id)}`),
  ];
  if (expectedCatalogSha256 && expectedCatalogSha256 !== catalogSha256) {
    observations.push(
      `Stale catalog hash: expected ${expectedCatalogSha256}, observed ${catalogSha256}`,
    );
  }

  return {
    schemaVersion: 1,
    generatedAt,
    repository,
    baseCommit,
    generatorCommit,
    catalogSha256,
    project: {
      state: projectState,
      url: projectUrl,
      itemCount: allProjectItems.length,
      fingerprint:
        projectState === "available"
          ? createHash("sha256").update(JSON.stringify(allProjectItems)).digest("hex")
          : null,
    },
    counts: {
      catalogPorts: (catalog.ports ?? []).length,
      sourceProfiles: (source.identities ?? []).length,
      sourceVariants: (source.identities ?? []).reduce(
        (sum, item) => sum + (item.variants ?? []).length,
        0,
      ),
      sourceRepresentations: (source.identities ?? []).reduce(
        (sum, item) =>
          sum +
          (item.variants ?? []).reduce(
            (variantSum, variant) => variantSum + (variant.representations ?? []).length,
            0,
          ),
        0,
      ),
      sourceContracts: (source.contracts ?? []).length,
      sourceEvidence: (source.evidence ?? []).length,
      preservationCrosswalkEvidence: (source.evidence ?? []).filter(
        (item) => item.role === "preservation_crosswalk",
      ).length,
      qualificationRecords: qualification.length,
      portIssues: portIssues.length,
      catalogedIssues: portIssues.filter(
        (issue) => sourceProvenancePortIdentity(issue).catalogIds.length > 0,
      ).length,
      researchIssues: research.length,
    },
    cataloged,
    research: research.sort(
      (a, b) => a.portKey.localeCompare(b.portKey) || (a.issue ?? 0) - (b.issue ?? 0),
    ),
    observations: [...new Set(observations)].sort(),
  };
}

function tableCell(value: unknown) {
  if (Array.isArray(value)) value = value.length ? value.join(", ") : "None";
  return diagnosticText(value ?? "None")
    .replaceAll("|", "\\|")
    .replace(/\s+/g, " ")
    .trim();
}

function issueLink(entry: { issueUrl: string | null; issue: number | null }) {
  return entry.issueUrl ? `[#${entry.issue}](${entry.issueUrl})` : "Missing";
}

export function renderSourceProvenanceAudit(audit: ReturnType<typeof buildSourceProvenanceAudit>) {
  const observations = audit.observations.length
    ? audit.observations.map((value) => `- ${value}`).join("\n")
    : "- No catalog/ticket/Project drift detected by this generator.";
  const catalogedRows = audit.cataloged
    .map(
      (entry) =>
        `| ${tableCell(entry.id)} | ${issueLink(entry)} | ${tableCell(entry.contracts)} | ${tableCell(entry.deterministicIdentity ? "Complete" : "Gap")} | ${tableCell(entry.sourceEvidence)} | ${tableCell(entry.qualification)} | ${tableCell(entry.projectContext)} | ${tableCell(entry.gap)} |`,
    )
    .join("\n");
  const researchRows = audit.research
    .map(
      (entry) =>
        `| [#${entry.issue}](${entry.url}) ${tableCell(entry.title)} | ${tableCell(entry.portKey)} | ${tableCell(entry.upstream)} | ${tableCell(entry.sourceEvidence)} | ${tableCell(entry.releaseIntegrity)} | ${tableCell(entry.projectContext)} | ${tableCell(entry.gap)} |`,
    )
    .join("\n");
  const projectFingerprint = audit.project.fingerprint
    ? `\`${audit.project.fingerprint}\``
    : "Unavailable";
  return `# Supported-source provenance and Port-ticket audit\n\n> Dated read-only evidence. This document is not a roadmap, priority authority, live Project mirror, catalog, or support grant. Regenerate it from the current catalog and live read-only GitHub state instead of editing status rows.\n\n- Generated: ${audit.generatedAt}\n- Repository: ${audit.repository}\n- Repository base: \`${audit.baseCommit}\`\n- Generator revision: \`${audit.generatorCommit}\`\n- Snapshot revision: assigned by the commit containing this file\n- Catalog SHA-256: \`${audit.catalogSha256}\`\n- Project state: ${audit.project.state}${audit.project.url ? ` (${audit.project.url})` : ""}\n- Project item count: ${audit.project.itemCount}\n- Project-state fingerprint: ${projectFingerprint}\n\n## Discovered inventory\n\n- Catalog ports: ${audit.counts.catalogPorts}\n- Source profiles: ${audit.counts.sourceProfiles}\n- Source variants: ${audit.counts.sourceVariants}\n- Source representations: ${audit.counts.sourceRepresentations}\n- Source contracts: ${audit.counts.sourceContracts}\n- Source evidence records: ${audit.counts.sourceEvidence}\n- Preservation crosswalk evidence records: ${audit.counts.preservationCrosswalkEvidence}\n- Exact qualification records: ${audit.counts.qualificationRecords}\n- Durable Port issues: ${audit.counts.portIssues}\n- Cataloged Port issues: ${audit.counts.catalogedIssues}\n- Research Port issues: ${audit.counts.researchIssues}\n\n## Drift and explicit gaps\n\n${observations}\n\n## Cataloged support inventory\n\nOnly these catalog entries are player-visible. Exact qualification remains separate from historical platform arrays.\n\n| Catalog ID | Port ticket | Source contracts | Deterministic identity | Upstream evidence | Exact qualification | Project context at generation | Structural gap |\n|---|---|---|---|---|---|---|---|\n${catalogedRows || "| None | None | None | None | None | None | None | None |"}\n\n## Research inventory\n\nThese durable tickets are research/watchlist evidence and are not player-visible catalog support. Their Project values are timestamped context only.\n\n| Port ticket | Durable key | Direct upstream | Source evidence | Release integrity | Project context at generation | Exact gap or resume condition |\n|---|---|---|---|---|---|---|\n${researchRows || "| None | None | None | None | None | None | None |"}\n\n## Interpretation limits\n\n- Deterministic identity completeness means each supported contract variant has an active non-informational representation, or the contract uses a pinned validator. It is not gameplay or ownership evidence.\n- Upstream evidence counts catalog references and reports broken references; it does not re-fetch or reinterpret upstream sources.\n- Exact qualification counts only artifact/source-variant-scoped records. Historical platform arrays stay visible as legacy catalog data and are not promoted into exact claims.\n- Issue prose is reported as issue evidence or a gap. A mention of a checksum is not independently re-certified by this snapshot.\n- Project fields can change after generation and never replace catalog facts or issue acceptance.\n- Merged-reference observations use only explicit same-repository PR facts supplied offline or read directly for active blocker references. Unlisted, closed, partial or unavailable PR facts are not assumed merged; a finding never resolves remaining issue acceptance.\n`;
}

export function runReadOnlyGitHubCommand(
  args: readonly string[],
  input?: string,
  spawn: NonNullable<Parameters<typeof RunnerFactory>[0]>["spawn"] = spawnSync,
): unknown {
  const run = createGitHubRunner({
    cwd: projectRoot,
    spawn,
    maxBuffer: 32 * 1024 * 1024,
  });
  try {
    const output = run(args, input);
    return args.includes("--include") ? output : JSON.parse(output);
  } catch {
    throw new Error(`read-only GitHub command failed: gh ${args.slice(0, 3).join(" ")}`);
  }
}

export function readLiveSourceProvenance({
  repository,
  owner,
  projectNumber,
  run = runReadOnlyGitHubCommand,
}: {
  repository: string;
  owner: string;
  projectNumber: number;
  run?: ReadCommand;
}) {
  let phase = "initializing GitHub collection";
  try {
    const configured = validateConfig(
      JSON.parse(readFileSync(path.join(projectRoot, ".github/roadmap.json"), "utf8")),
    );
    const client = new RoadmapClient(
      {
        ...configured,
        repository,
        owner,
        project: { ...configured.project, number: projectNumber },
      },
      (args, input) => {
        const result = run(args, input);
        return typeof result === "string" ? result : JSON.stringify(result);
      },
    );
    phase = "reading the issue inventory";
    const issues = requireRepositoryIssueInventory(client.repositoryIssues(), client).issues;
    phase = "reading the Project inventory";
    const projectItems = client.itemList(projectNumber);
    phase = "discovering active PR references";
    const references = [
      ...new Set(
        sourceProvenancePortIssues(issues)
          .map(issueContent)
          .filter((issue) => diagnosticText(issue.state).toUpperCase() === "OPEN")
          .flatMap((issue) => [...activeBlockerPrNumbers(issue.body, repository)]),
      ),
    ].sort((a, b) => a - b);
    // Resolve single objects rather than crawling a PR connection. Bound work
    // before the first PR request; an incomplete read never writes a snapshot.
    if (references.length > 100) throw new Error("active PR reference bound exceeded");
    const [repositoryOwner, name] = repository.split("/");
    phase = "resolving referenced PRs";
    const pullRequests = references
      .map((number) => {
        const data = client.graphql(
          `query($owner: String!, $name: String!, $number: Int!) { repository(owner: $owner, name: $name) { pullRequest(number: $number) { __typename number url state merged } } }`,
          { owner: repositoryOwner, name, number },
        );
        const raw = object(object(data).repository).pullRequest;
        const pr = raw === null ? null : object(raw);
        // A null PR is an unknown reference, not proof of a merge. Missing fields
        // indicate a malformed/partial response and invalidate this snapshot.
        if (pr === null) return null;
        if (
          !pr ||
          pr.__typename !== "PullRequest" ||
          pr.number !== number ||
          !/^https:\/\/github\.com\/[^/]+\/[^/]+\/pull\/[1-9]\d*\/?$/u.test(
            diagnosticText(pr.url ?? ""),
          ) ||
          sameRepositoryPrNumber(text(pr.url, "PR URL"), repository) !== number ||
          typeof pr.state !== "string" ||
          !["OPEN", "CLOSED", "MERGED"].includes(pr.state) ||
          typeof pr.merged !== "boolean" ||
          (pr.state === "MERGED") !== pr.merged
        )
          throw new Error("invalid referenced PR response");
        return readIssue(pr);
      })
      .filter((pr) => pr !== null);
    return { issues, projectItems, pullRequests, projectState: "available" };
  } catch {
    throw new Error(`read-only GitHub enrichment failed while ${phase}; no snapshot was written`);
  }
}

function parseOptions(argv: readonly string[]) {
  const options: { live?: boolean; [name: string]: string | boolean | undefined } = {};
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === undefined) throw new Error("missing argument");
    if (value === "--live") options.live = true;
    else if (value.startsWith("--")) {
      if (index + 1 >= argv.length) throw new Error(`${value} requires a value`);
      options[value.slice(2)] = argv[++index];
    } else throw new Error(`unexpected argument: ${value}`);
  }
  const values: Record<string, string | undefined> = Object.fromEntries(
    Object.entries(options).filter(
      (entry): entry is [string, string] => typeof entry[1] === "string",
    ),
  );
  return { live: options.live === true, values };
}

function requireCompleteOfflineCollection(value: unknown, label: string) {
  if (Array.isArray(value)) return;
  if (!isRecord(value) || !Array.isArray(value.items))
    throw new Error(`incomplete offline ${label} collection: expected an items array`);
  if (
    !Number.isSafeInteger(value.totalCount) ||
    value.totalCount !== value.items.length ||
    object(value.pageInfo).hasNextPage !== false
  )
    throw new Error(
      `incomplete offline ${label} collection: pagination is unfinished or inconsistent`,
    );
}

export async function runSourceProvenanceAudit(
  argv: readonly string[],
  { run = runReadOnlyGitHubCommand }: { run?: ReadCommand } = {},
) {
  const parsed = parseOptions(argv);
  const options = parsed.values;
  if (
    !options["generated-at"] ||
    !options["base-commit"] ||
    !options["generator-commit"] ||
    !options.output
  ) {
    throw new Error("--generated-at, --base-commit, --generator-commit, and --output are required");
  }
  const repository = options.repository ?? "boburning/portcove";
  const [owner = ""] = repository.split("/");
  let input;
  if (parsed.live) {
    input = readLiveSourceProvenance({
      repository,
      owner: options.owner ?? owner,
      projectNumber: Number(options.project ?? 1),
      run,
    });
  } else {
    if (!options.issues) throw new Error("--issues is required unless --live is selected");
    input = {
      issues: readJson(await readFile(path.resolve(options.issues), "utf8")),
      projectItems: options["project-items"]
        ? readJson(await readFile(path.resolve(options["project-items"]), "utf8"))
        : [],
      projectState: options["project-items"] ? "fixture" : "unavailable",
    };
    requireCompleteOfflineCollection(input.issues, "issues");
    requireCompleteOfflineCollection(input.projectItems, "Project items");
  }
  const catalogPath = path.resolve(options.catalog ?? defaultCatalogPath);
  const catalogText = await readFile(catalogPath, "utf8");
  const audit = buildSourceProvenanceAudit({
    catalogText,
    ...input,
    generatedAt: options["generated-at"],
    baseCommit: options["base-commit"],
    generatorCommit: options["generator-commit"],
    expectedCatalogSha256: options["expected-catalog-sha256"] ?? null,
    repository,
    projectUrl: options["project-url"] ?? null,
  });
  const output = path.resolve(options.output);
  const archiveRoot = path.join(projectRoot, "docs", "archive");
  if (output !== archiveRoot && !output.startsWith(`${archiveRoot}${path.sep}`)) {
    throw new Error("audit output must be under docs/archive");
  }
  await writeFile(output, renderSourceProvenanceAudit(audit), "utf8");
  console.log(`Wrote read-only provenance evidence to ${path.relative(projectRoot, output)}.`);
  if (audit.observations.length) {
    console.log(
      `Recorded ${audit.observations.length} drift or gap observation(s); inspect the snapshot.`,
    );
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === scriptPath) {
  runSourceProvenanceAudit(process.argv.slice(2)).catch((error) => {
    console.error(errorMessage(error));
    process.exitCode = 1;
  });
}
