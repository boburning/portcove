import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { access, readFile } from "node:fs/promises";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { performance } from "node:perf_hooks";
import {
  GitHubApiClient,
  createGitHubRunner,
  githubOperationEnvelope,
  githubRateLimitMessage,
  sanitizeOperationError,
} from "./github-api.mjs";
import { acquireOwnedProcessLock } from "./process-lock.mjs";

const scriptPath = fileURLToPath(import.meta.url);
const projectRoot = path.resolve(path.dirname(scriptPath), "..");
const configPath = path.join(projectRoot, ".github", "roadmap.json");
const catalogPath = path.join(projectRoot, "crates", "portcove-core", "catalog", "catalog.json");

const layouts = new Set(["TABLE_LAYOUT", "BOARD_LAYOUT", "ROADMAP_LAYOUT"]);
const legacyReleaseSequence = ["Alpha 1", "Alpha 2", "Alpha 3", "Beta 1", "Beta 2", "RC", "V1"];
export const releaseSequence = [...legacyReleaseSequence, "Public beta", "1.0"];

function includedReleaseTargets(release) {
  if (release === "Public beta") return ["Alpha 1", "Alpha 2", "Public beta"];
  if (release === "1.0") return [...legacyReleaseSequence, "Public beta", "1.0"];
  const index = legacyReleaseSequence.indexOf(release);
  if (index < 0) throw new Error(`unknown target release: ${release}`);
  return legacyReleaseSequence.slice(0, index + 1);
}
const durableIssueHeadings = [
  "User outcome",
  "Current behavior and evidence",
  "Scope",
  "Non-goals",
  "Acceptance criteria",
  "Required tests",
  "Documentation impact",
  "Dependencies and blockers",
  "Completion evidence",
];
const portMarker = "<!-- portcove-port -->";
const portTitlePrefix = /^\s*\[port\]\s*/i;
const canonicalPortTitlePrefix = /^\[Port\]\s+\S/;
const portFormLabels = Object.freeze({
  upstream: "Direct upstream URL",
  portKey: "Durable game or target key",
});
const neutralPortFields = Object.freeze({
  Status: "Inbox",
  Priority: "None",
  Horizon: "Someday",
  "Target release": "Unscheduled",
  "Work type": "Port",
  Workstream: "Port catalog",
  Platform: "Unknown",
  "Port stage": "Watchlist",
  Effort: "Unknown",
});
const catalogedPortStages = new Set([
  "Cataloged",
  "Automated qualification",
  "Manual qualification",
  "Supported",
]);
const automatedPortStages = new Set([
  "Automated qualification",
  "Manual qualification",
  "Supported",
]);
const uxAuditNamespaces = {
  SYS: 14,
  UI: 47,
  DLG: 7,
  CLI: 24,
  ERR: 20,
  CAT: 19,
  DOC: 29,
  OPS: 18,
};
export const uxAuditOriginIds = Object.freeze(
  Object.entries(uxAuditNamespaces).flatMap(([namespace, count]) =>
    Array.from(
      { length: count },
      (_, index) => namespace + "-" + String(index + 1).padStart(2, "0"),
    ),
  ),
);
const uxAuditOriginSet = new Set(uxAuditOriginIds);
const supportedSourcePlanOrigin = "PCV-PLAN-SUPPORTED-SOURCE-PROVENANCE-2026-09-04";
const volatileKeys = new Set([
  "items",
  "item",
  "issues",
  "drafts",
  "status_value",
  "priority_value",
  "horizon_value",
  "target_release_value",
  "position",
  "positions",
]);
const setFlags = new Map([
  ["--status", "Status"],
  ["--priority", "Priority"],
  ["--horizon", "Horizon"],
  ["--release", "Target release"],
  ["--commitment", "Release commitment"],
  ["--type", "Work type"],
  ["--workstream", "Workstream"],
  ["--platform", "Platform"],
  ["--port-stage", "Port stage"],
  ["--effort", "Effort"],
]);
const maximumBatchAssignments = 100;
export const maximumMutationChunkAssignments = 25;

function requireExactKeys(value, expected, label) {
  const actual = Object.keys(value ?? {}).sort();
  const wanted = [...expected].sort();
  if (JSON.stringify(actual) !== JSON.stringify(wanted))
    throw new Error(`${label} must contain exactly: ${wanted.join(", ")}`);
}

export function validateSetManySpec(config, spec) {
  requireExactKeys(spec, ["schema_version", "updates"], "set-many specification");
  if (spec.schema_version !== 1) throw new Error("set-many schema_version must be 1");
  if (!Array.isArray(spec.updates) || !spec.updates.length)
    throw new Error("set-many updates must be a non-empty array");
  const targets = new Set();
  let assignments = 0;
  const updates = spec.updates.map((update, updateIndex) => {
    requireExactKeys(update, ["fields", "target"], `set-many update ${updateIndex + 1}`);
    ensureString(update.target, `set-many update ${updateIndex + 1} target`);
    if (targets.has(update.target)) throw new Error(`duplicate set-many target: ${update.target}`);
    targets.add(update.target);
    if (
      !update.fields ||
      typeof update.fields !== "object" ||
      Array.isArray(update.fields) ||
      !Object.keys(update.fields).length
    ) {
      throw new Error(`set-many update ${update.target} fields must be a non-empty object`);
    }
    const fields = {};
    for (const [fieldName, transition] of Object.entries(update.fields)) {
      const definition = config.fields.find((field) => field.name === fieldName);
      if (!definition) throw new Error(`Project field not found: ${fieldName}`);
      requireExactKeys(transition, ["from", "to"], `${update.target} ${fieldName} transition`);
      if (transition.from !== null && !definition.options.includes(transition.from))
        throw new Error(`${transition.from} is not a valid ${fieldName} source option`);
      if (!definition.options.includes(transition.to))
        throw new Error(`${transition.to} is not a valid ${fieldName} target option`);
      if (transition.from === transition.to)
        throw new Error(`${update.target} ${fieldName} transition does not change the value`);
      fields[fieldName] = { from: transition.from, to: transition.to };
      assignments += 1;
    }
    return { target: update.target, fields };
  });
  if (assignments > maximumBatchAssignments)
    throw new Error(`set-many supports at most ${maximumBatchAssignments} field assignments`);
  return { schema_version: 1, updates, assignments };
}

export function setManyRequiredReserve(preflightCost, pendingAssignments) {
  if (
    !Number.isSafeInteger(preflightCost) ||
    preflightCost < 0 ||
    !Number.isSafeInteger(pendingAssignments) ||
    pendingAssignments < 0 ||
    pendingAssignments > maximumBatchAssignments
  ) {
    throw new Error("set-many quota inputs are invalid");
  }
  return 2 * preflightCost + Math.min(pendingAssignments, maximumMutationChunkAssignments) + 100;
}

function setManyOutcomeError(status, message, evidence, cause = null) {
  const error = new Error(message, cause ? { cause } : undefined);
  error.code = `set_many_${status}`;
  error.operationStatus = status;
  error.operationEvidence = evidence;
  return error;
}

function setManyEvidence(plan, state) {
  return {
    assignments: plan.assignments,
    pending_at_start: plan.pending.length,
    already_applied_at_start: plan.alreadyApplied.length,
    verified: state.verified,
    verified_after_attempt: state.verifiedAfterAttempt,
    reconciled: state.reconciled,
    reconciled_after_error: state.reconciledAfterError,
    remaining: Math.max(0, plan.pending.length - state.processed),
    chunks: state.chunks,
    rate_limit: state.rateLimit
      ? { remaining: state.rateLimit.remaining, reset_at: state.rateLimit.resetAt }
      : null,
    doctor: state.doctor,
  };
}

export async function executeSetMany({
  client,
  config,
  spec,
  apply = false,
  doctor = runDoctor,
  onPlan = () => {},
}) {
  const before = client.sampleGraphqlRate();
  const plan = client.planSetMany(spec);
  const after = client.sampleGraphqlRate();
  if (after.used < before.used)
    throw new Error("GitHub GraphQL rate-limit window changed during set-many preflight; retry");
  const preflightCost = after.used - before.used;
  const state = {
    verified: plan.alreadyApplied.length,
    verifiedAfterAttempt: 0,
    reconciled: plan.alreadyApplied.length,
    reconciledAfterError: 0,
    processed: 0,
    chunks: [],
    rateLimit: after,
    doctor: "not_run",
  };
  const requiredReserve = setManyRequiredReserve(preflightCost, plan.pending.length);
  const planSummary =
    `${plan.pending.length} pending, ${plan.alreadyApplied.length} already applied, ` +
    `${preflightCost} GraphQL points observed during preflight, ${after.remaining} remain, ` +
    `${requiredReserve} required before the next mutation.`;
  if (!apply) {
    return {
      status: "planned",
      summary: `Set-many plan: ${planSummary}`,
      evidence: setManyEvidence(plan, state),
    };
  }
  onPlan(`Set-many plan: ${planSummary}`);

  for (let offset = 0; offset < plan.pending.length; offset += maximumMutationChunkAssignments) {
    const chunk = plan.pending.slice(offset, offset + maximumMutationChunkAssignments);
    const chunkPlan = { ...plan, pending: chunk, alreadyApplied: [] };
    let beforeMutation;
    try {
      beforeMutation = client.verifySetMany(chunkPlan);
    } catch (error) {
      throw setManyOutcomeError(
        "unknown",
        `set-many could not establish the pre-mutation state for chunk ${state.chunks.length + 1}: ${error.message}`,
        setManyEvidence(plan, state),
        error,
      );
    }
    const unexpected = beforeMutation.filter(
      (result) => result.observed !== result.from && result.observed !== result.to,
    );
    if (unexpected.length) {
      throw setManyOutcomeError(
        "partial",
        `set-many stopped before mutation because ${unexpected
          .map(
            (result) =>
              `${result.target} ${result.fieldName}=${JSON.stringify(result.observed)} expected ${JSON.stringify(result.from)} or ${JSON.stringify(result.to)}`,
          )
          .join("; ")}`,
        setManyEvidence(plan, state),
      );
    }
    const pending = beforeMutation.filter((result) => result.observed === result.from);
    const alreadyDesired = beforeMutation.length - pending.length;
    state.reconciled += alreadyDesired;
    state.verified += alreadyDesired;
    state.processed += alreadyDesired;

    let mutationError = null;
    if (pending.length) {
      const rate = client.sampleGraphqlRate();
      state.rateLimit = rate;
      const chunkReserve = setManyRequiredReserve(preflightCost, pending.length);
      if (rate.remaining < chunkReserve) {
        throw setManyOutcomeError(
          "partial",
          `${githubRateLimitMessage(rate, "set-many stopped before mutation")}; ${chunkReserve} points are required to preserve the recovery reserve`,
          setManyEvidence(plan, state),
        );
      }
      try {
        client.applySetMany(plan, pending);
      } catch (error) {
        mutationError = error;
      }
    }

    let afterMutation;
    try {
      afterMutation = client.verifySetMany(chunkPlan);
    } catch (error) {
      throw setManyOutcomeError(
        mutationError ? "unknown" : "partial",
        `set-many could not establish the post-mutation state for chunk ${state.chunks.length + 1}: ${error.message}`,
        setManyEvidence(plan, state),
        error,
      );
    }
    const verified = afterMutation.filter((result) => result.verified);
    const mismatches = afterMutation.filter((result) => !result.verified);
    const newlyVerified = verified.length - alreadyDesired;
    state.verifiedAfterAttempt += newlyVerified;
    state.verified += newlyVerified;
    state.processed += newlyVerified;
    if (mutationError && newlyVerified > 0) state.reconciledAfterError += newlyVerified;
    state.chunks.push({
      index: state.chunks.length + 1,
      assignments: chunk.length,
      attempted: pending.length,
      verified: verified.length,
      reconciled_after_error: mutationError ? newlyVerified : 0,
    });
    if (mismatches.length) {
      throw setManyOutcomeError(
        "partial",
        `set-many stopped after readback mismatches: ${mismatches
          .map(
            (result) =>
              `${result.target} ${result.fieldName}=${JSON.stringify(result.observed)} expected ${JSON.stringify(result.to)}`,
          )
          .join("; ")}`,
        setManyEvidence(plan, state),
        mutationError,
      );
    }
  }

  let finalVerification;
  try {
    finalVerification = client.verifySetMany(plan);
  } catch (error) {
    throw setManyOutcomeError(
      "unknown",
      `set-many final readback failed: ${error.message}`,
      setManyEvidence(plan, state),
      error,
    );
  }
  const finalMismatches = finalVerification.filter((result) => !result.verified);
  if (finalMismatches.length) {
    throw setManyOutcomeError(
      "partial",
      `set-many final readback found ${finalMismatches.length} mismatched assignments`,
      setManyEvidence(plan, state),
    );
  }
  state.verified = finalVerification.length;
  try {
    await doctor(config, client, { quiet: true });
    state.doctor = "passed";
  } catch (error) {
    state.doctor = "failed";
    throw setManyOutcomeError(
      "partial",
      `set-many verified every assignment but the final doctor failed: ${error.message}`,
      setManyEvidence(plan, state),
      error,
    );
  }
  return {
    status: "succeeded",
    summary: `Set-many verified ${finalVerification.length} field assignments and completed the final doctor.`,
    evidence: setManyEvidence(plan, state),
  };
}

function normalizedKey(value) {
  return String(value ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "");
}

function ensureString(value, label) {
  if (typeof value !== "string" || !value.trim())
    throw new Error(`${label} must be a non-empty string`);
}

function findVolatileKey(value, prefix = "config") {
  if (!value || typeof value !== "object") return null;
  for (const [key, child] of Object.entries(value)) {
    const location = `${prefix}.${key}`;
    if (volatileKeys.has(key)) return location;
    const nested = findVolatileKey(child, location);
    if (nested) return nested;
  }
  return null;
}

export function validateConfig(config, { requireProjectNumber = false } = {}) {
  deliveryMode(config);
  if (config?.schema_version !== 1) throw new Error("roadmap schema_version must be 1");
  ensureString(config.owner, "roadmap owner");
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(config.repository ?? "")) {
    throw new Error("roadmap repository must be owner/name");
  }
  ensureString(config.project?.title, "project title");
  ensureString(config.project?.description, "project description");
  ensureString(config.project?.readme, "project readme");
  if (!releaseSequence.includes(config.active_release)) {
    throw new Error(`active_release must be one of ${releaseSequence.join(", ")}`);
  }
  if (config.project?.visibility !== "PUBLIC") throw new Error("roadmap project must be PUBLIC");
  if (!Number.isInteger(config.project?.number) || config.project.number < 0) {
    throw new Error("project number must be a non-negative integer");
  }
  if (requireProjectNumber && config.project.number < 1) {
    throw new Error(
      "project number is not recorded; run bootstrap and update .github/roadmap.json",
    );
  }
  const fieldNames = new Set();
  for (const field of config.fields ?? []) {
    ensureString(field.name, "field name");
    if (fieldNames.has(field.name)) throw new Error(`duplicate field: ${field.name}`);
    fieldNames.add(field.name);
    if (!Array.isArray(field.options) || field.options.length === 0) {
      throw new Error(`field ${field.name} must define options`);
    }
    const options = new Set();
    for (const option of field.options) {
      ensureString(option, `${field.name} option`);
      if (options.has(option)) throw new Error(`duplicate ${field.name} option: ${option}`);
      options.add(option);
    }
  }
  for (const required of [
    "Status",
    "Priority",
    "Horizon",
    "Target release",
    "Release commitment",
    "Work type",
    "Workstream",
    "Platform",
    "Port stage",
    "Effort",
  ]) {
    if (!fieldNames.has(required)) throw new Error(`missing required roadmap field: ${required}`);
  }
  const viewNames = new Set();
  const viewAliases = new Set();
  for (const view of config.views ?? []) {
    ensureString(view.name, "view name");
    if (viewNames.has(view.name)) throw new Error(`duplicate view: ${view.name}`);
    viewNames.add(view.name);
    if (view.previous_name !== undefined) {
      ensureString(view.previous_name, "previous view name");
      if (viewAliases.has(view.previous_name))
        throw new Error(`duplicate previous view name: ${view.previous_name}`);
      viewAliases.add(view.previous_name);
    }
    if (!layouts.has(view.layout)) throw new Error(`view ${view.name} has invalid layout`);
    if (
      typeof view.filter !== "string" ||
      !Array.isArray(view.fields) ||
      view.fields.length === 0
    ) {
      throw new Error(`view ${view.name} must define a filter and visible fields`);
    }
    if ("group_by" in view || "sort_by" in view) {
      throw new Error(
        `view ${view.name} must use manual_group_by/manual_sort_by for UI-only requirements`,
      );
    }
    if (
      !(view.manual_group_by === null || typeof view.manual_group_by === "string") ||
      typeof view.manual_sort_by !== "string"
    ) {
      throw new Error(`view ${view.name} must define manual grouping and sorting requirements`);
    }
  }
  for (const alias of viewAliases) {
    if (viewNames.has(alias)) throw new Error(`previous view name is still active: ${alias}`);
  }
  const volatile = findVolatileKey(config);
  if (volatile)
    throw new Error(`roadmap configuration contains volatile planning data at ${volatile}`);
  return config;
}

export function materializeViews(config) {
  return config.views.map((view) => ({
    ...view,
    filter: view.filter.replaceAll("${active_release}", config.active_release),
  }));
}

export function validateDurableIssueBody(body) {
  ensureString(body, "durable issue body");
  const missing = durableIssueHeadings.filter((heading) => {
    const match = body.match(
      new RegExp(`^## ${heading.replace(/[.*+?^${}()|[\\]\\]/g, "\\$&")}\\s*$`, "im"),
    );
    if (!match) return true;
    const start = match.index + match[0].length;
    const next = body.slice(start).search(/^##\s/m);
    const content = body.slice(start, next < 0 ? undefined : start + next).trim();
    return !content || /^(?:pending|tbd|todo)[.!]?$/i.test(content.replace(/^[-*]\s*/, ""));
  });
  if (missing.length)
    throw new Error(`durable issue specification is incomplete: ${missing.join(", ")}`);
  return body;
}

function portCatalogMarkers(body) {
  return [...String(body ?? "").matchAll(/<!--\s*portcove-catalog-id:\s*([^\s>]+)\s*-->/gi)].map(
    (match) => match[1],
  );
}

function portUpstreamMarkers(body) {
  return [...String(body ?? "").matchAll(/<!--\s*portcove-upstream:\s*([^\s>]+)\s*-->/gi)].map(
    (match) => match[1],
  );
}

function portKeyMarkers(body) {
  return [...String(body ?? "").matchAll(/<!--\s*portcove-port-key:\s*([^\s>]+)\s*-->/gi)].map(
    (match) => match[1],
  );
}

export function normalizePortKey(value) {
  return String(value ?? "")
    .normalize("NFKD")
    .replace(/\p{Mark}/gu, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function normalizedPortTitle(value) {
  return normalizePortKey(String(value ?? "").replace(portTitlePrefix, ""));
}

function normalizedUpstream(value) {
  try {
    const parsed = new URL(String(value));
    const pathname = parsed.pathname.replace(/\/+$/g, "").replace(/\.git$/i, "");
    return `${parsed.protocol.toLowerCase()}//${parsed.host.toLowerCase()}${pathname.toLowerCase()}`;
  } catch {
    return String(value ?? "")
      .trim()
      .replace(/\/+$/g, "")
      .replace(/\.git$/i, "")
      .toLowerCase();
  }
}

function issueNumber(item) {
  const direct = Number(item?.content?.number ?? item?.number);
  if (Number.isInteger(direct) && direct > 0) return direct;
  const match = String(itemUrl(item) ?? "").match(/\/issues\/(\d+)(?:$|[?#])/i);
  return match ? Number(match[1]) : null;
}

function repositoryIssueContent(item) {
  return item?.content?.type === "Issue" || item?.content?.__typename === "Issue"
    ? item.content
    : item;
}

function isOpenPortTitleIssue(issue) {
  return repositoryState(issue) === "open" && portTitlePrefix.test(itemTitle(issue));
}

function discoveredPortIssues(issues) {
  return (issues ?? [])
    .map(repositoryIssueContent)
    .filter((issue) => itemBody(issue).includes(portMarker) || isOpenPortTitleIssue(issue));
}

function issueFormSection(body, label) {
  const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = String(body ?? "").match(
    new RegExp(`^###\\s+${escaped}\\s*$([\\s\\S]*?)(?=^###\\s|(?![\\s\\S]))`, "im"),
  );
  if (!match) return null;
  const value = match[1].trim();
  return !value || /^_?No response_?$/i.test(value) ? null : value;
}

export function parsePortIssueForm(body) {
  const upstream = issueFormSection(body, portFormLabels.upstream);
  if (!upstream) throw new Error(`issue form is missing ${portFormLabels.upstream}`);
  let parsedUrl;
  try {
    parsedUrl = new URL(upstream);
  } catch {
    throw new Error(`${portFormLabels.upstream} must be a valid https URL`);
  }
  if (parsedUrl.protocol !== "https:") {
    throw new Error(`${portFormLabels.upstream} must be a valid https URL`);
  }
  const portKey = issueFormSection(body, portFormLabels.portKey);
  if (!portKey) throw new Error(`issue form is missing ${portFormLabels.portKey}`);
  const canonical = normalizePortKey(portKey);
  if (!canonical || canonical !== portKey) {
    throw new Error(
      `durable port key must use canonical lowercase kebab-case: ${canonical || "a-non-empty-key"}`,
    );
  }
  return { upstream, portKey };
}

function portIdentity(issue) {
  const body = itemBody(issue);
  let form = null;
  if (portTitlePrefix.test(itemTitle(issue))) {
    try {
      form = parsePortIssueForm(body);
    } catch {
      // Invalid form submissions remain discoverable; doctor reports their exact contract errors.
    }
  }
  const ids = portCatalogMarkers(body);
  const keys = portKeyMarkers(body).map(normalizePortKey);
  const upstreams = portUpstreamMarkers(body).map(normalizedUpstream);
  return {
    ids,
    keys: keys.length ? keys : form?.portKey ? [normalizePortKey(form.portKey)] : [],
    upstreams: upstreams.length
      ? upstreams
      : form?.upstream
        ? [normalizedUpstream(form.upstream)]
        : [],
    title: normalizedPortTitle(itemTitle(issue)),
  };
}

export function sourceProvenancePortIdentity(issue) {
  const identity = portIdentity(repositoryIssueContent(issue));
  return {
    catalogIds: [...identity.ids],
    portKeys: [...identity.keys],
    upstreams: [...identity.upstreams],
    title: identity.title,
  };
}

export function sourceProvenancePortIssues(issues) {
  return discoveredPortIssues(issues);
}

export function findPortIssueDuplicates(issues, { title, upstream, catalogId, portKey }) {
  const candidateTitle = normalizedPortTitle(title);
  const candidateUpstream = normalizedUpstream(upstream);
  const candidateKey = portKey ? normalizePortKey(portKey) : null;
  const candidateIdentity = catalogId ?? candidateKey ?? candidateTitle;
  const matches = [];
  for (const issue of discoveredPortIssues(issues)) {
    const reasons = [];
    const { ids, keys, upstreams, title: titleIdentity } = portIdentity(issue);
    const issueIdentity = ids[0] ?? keys[0] ?? titleIdentity;
    if (catalogId && ids.includes(catalogId)) reasons.push(`catalog ID ${catalogId}`);
    if (candidateKey && keys.includes(candidateKey)) reasons.push(`port key ${candidateKey}`);
    if (candidateTitle && titleIdentity === candidateTitle)
      reasons.push(`normalized title ${candidateTitle}`);
    if (
      candidateUpstream &&
      upstreams.includes(candidateUpstream) &&
      issueIdentity === candidateIdentity
    ) {
      reasons.push("direct upstream plus game/target identity");
    }
    if (reasons.length) matches.push({ issue, reasons: [...new Set(reasons)] });
  }
  return matches;
}

export function reconcilePortIssueMarkers(body, { upstream, catalogId, portKey }) {
  const retained = String(body ?? "")
    .replace(/^\s*<!--\s*portcove-port\s*-->\s*$/gim, "")
    .replace(/^\s*<!--\s*portcove-upstream:\s*[^>]*-->\s*$/gim, "")
    .replace(/^\s*<!--\s*portcove-catalog-id:\s*[^>]*-->\s*$/gim, "")
    .replace(/^\s*<!--\s*portcove-port-key:\s*[^>]*-->\s*$/gim, "")
    .trimEnd();
  const identityMarker = catalogId
    ? `<!-- portcove-catalog-id: ${catalogId} -->`
    : `<!-- portcove-port-key: ${portKey} -->`;
  return `${retained}\n\n${portMarker}\n<!-- portcove-upstream: ${upstream} -->\n${identityMarker}`;
}

export function portFieldInitialization(item) {
  const updates = {};
  for (const [field, value] of Object.entries(neutralPortFields)) {
    const current = fieldValue(item, field);
    if (
      field === "Work type"
        ? current !== "Port"
        : current === undefined || current === null || current === ""
    ) {
      updates[field] = value;
    }
  }
  return updates;
}

export function uxAuditOrigins(body) {
  const markers = [
    ...String(body ?? "").matchAll(/<!--\s*portcove-ux-audit-origins:\s*([\s\S]*?)-->/gi),
  ];
  return markers.flatMap((match) =>
    match[1]
      .trim()
      .split(/[\s,]+/)
      .filter(Boolean),
  );
}

export function validateUxAuditOriginCoverage(items) {
  const errors = [];
  const owners = new Map();
  for (const item of items ?? []) {
    const body = itemBody(item);
    const url = itemUrl(item) ?? itemTitle(item);
    if (
      /portcove-wording-audit-origins/i.test(body) ||
      /earlier\s+Portcove\s+wording\s+audit\s+(?:is|as)\s+(?:the\s+)?current\s+authority/i.test(
        body,
      )
    ) {
      errors.push("Superseded wording audit is referenced as current authority: " + url);
    }
    for (const origin of uxAuditOrigins(body)) {
      if (/(?:\.\.|–|—|\bthrough\b)/i.test(origin)) {
        errors.push("UX audit origin range must enumerate every ID: " + origin + " (" + url + ")");
        continue;
      }
      if (!/^[A-Z]+-\d{2}$/.test(origin)) {
        errors.push("Malformed UX audit origin " + origin + ": " + url);
        continue;
      }
      if (!uxAuditOriginSet.has(origin)) {
        errors.push("Unknown UX audit origin " + origin + ": " + url);
        continue;
      }
      const matches = owners.get(origin) ?? [];
      matches.push(url);
      owners.set(origin, matches);
    }
  }
  for (const origin of uxAuditOriginIds) {
    const matches = owners.get(origin) ?? [];
    if (matches.length === 0) errors.push("UX audit origin lacks a canonical issue: " + origin);
    if (matches.length > 1)
      errors.push(
        "UX audit origin has duplicate owners: " + origin + " (" + matches.join(", ") + ")",
      );
  }
  return errors;
}

export function validatePlanOriginCoverage(items) {
  const owners = (items ?? []).filter((item) => itemBody(item).includes(supportedSourcePlanOrigin));
  if (owners.length !== 1) {
    return [
      "Supported-source plan origin must have exactly one canonical issue owner; found " +
        owners.length,
    ];
  }
  const owner = owners[0];
  if (issueNumber(owner) !== 36) {
    return [
      `Supported-source plan origin must be owned by issue #36; found ${itemUrl(owner) ?? itemTitle(owner)}`,
    ];
  }
  return [];
}

export function renderPortIssueBody({
  title,
  upstream,
  catalogId,
  portKey,
  currentEvidence = "Initial intake; evidence pending triage.",
  blocker = "No current blocker has been established. Exact resume condition pending triage.",
}) {
  const normalizedPortKey = portKey ? normalizePortKey(portKey) : null;
  if (!catalogId && !normalizedPortKey) {
    throw new Error("a non-catalog port requires a durable --port-key");
  }
  if (portKey && normalizedPortKey !== portKey) {
    throw new Error(`port key must use canonical lowercase slug form: ${normalizedPortKey}`);
  }
  const catalogLine = catalogId ?? "Not assigned (researched candidate)";
  const catalogMarker = catalogId ? `\n<!-- portcove-catalog-id: ${catalogId} -->` : "";
  const portKeyLine = normalizedPortKey ?? "Catalog ID is the durable identity";
  const portKeyMarker = normalizedPortKey
    ? `\n<!-- portcove-port-key: ${normalizedPortKey} -->`
    : "";
  return `## User outcome\n\n${title} can be researched, prioritized, qualified, advanced, blocked, and closed independently.\n\n## Current behavior and evidence\n\n${currentEvidence}\n\n## Scope\n\n- Direct upstream: ${upstream}\n- Game/title identity: ${title}\n- Catalog ID: ${catalogLine}\n- Durable port key: ${portKeyLine}\n- Supported and candidate platforms: Unknown until evidenced\n- Release assets and integrity: Pending\n- Source requirements and accepted revisions: Pending\n- Executable/setup boundary: Pending\n- Persistence and user-data boundary: Pending\n- Adapter fit and dependencies: Pending\n- Initial Port stage: Watchlist. The live Port stage is maintained in the Portcove Roadmap.\n- Current blocker and exact resume condition: ${blocker}\n- Automated qualification: Not yet recorded\n- Manual qualification: Not yet recorded\n\n## Non-goals\n\nThis issue does not grant support, expand V1 scope, weaken source or artifact validation, or replace shared engineering dependencies.\n\n## Acceptance criteria\n\n- [ ] Every promised operation and owned port fact has explicit evidence or an honest Unknown/Not run limitation.\n- [ ] The catalog and Project agree with the independently closable port state.\n- [ ] Completion evidence links the implementation and exact qualification results.\n\n## Required tests\n\nValidate applicable admission, source, artifact, archive, executable and lifecycle checks for each promised operation/platform. Record absent optional gameplay evidence as Unknown, not failure. Integration completion does not require personal playtesting; explicit hands-on support claims still require actual observations. Unsupported management operations remain unavailable with reasons.\n\n## Documentation impact\n\nUpdate catalog.json only when actual support or qualification changes; keep mutable priority and stage in the Project.\n\n## Dependencies and blockers\n\n${blocker}\n\n## Completion evidence\n\nNo completion evidence yet.\n\n${portMarker}\n<!-- portcove-upstream: ${upstream} -->${catalogMarker}${portKeyMarker}`;
}

function qualificationScopeKey(port, scope) {
  const identity = scope?.variant?.identity;
  if (
    !port ||
    scope?.port_id !== port.id ||
    !(port.platforms ?? []).includes(scope.platform) ||
    typeof scope.artifact_sha256 !== "string" ||
    !/^[a-f0-9]{64}$/iu.test(scope.artifact_sha256 ?? "") ||
    scope.variant?.state !== "exact" ||
    ![
      scope.upstream_ref,
      scope.contract_id,
      scope.check_version,
      identity?.game_id,
      identity?.variant_id,
      identity?.representation_id,
    ].every((value) => typeof value === "string" && value.length > 0)
  )
    return null;
  return JSON.stringify([
    scope.port_id,
    scope.platform,
    scope.artifact_sha256,
    scope.upstream_ref,
    scope.contract_id,
    identity.game_id,
    identity.variant_id,
    identity.representation_id,
    scope.check_version,
  ]);
}

function exactQualificationKeys(port, qualificationRecords, kind) {
  return new Set(
    (qualificationRecords ?? [])
      .filter((record) => record?.kind === kind && record?.outcome === "passed")
      .map((record) => qualificationScopeKey(port, record.scope))
      .filter((key) => key !== null),
  );
}

function exactQualificationPlatforms(port, qualificationRecords, kind) {
  const declared = new Set(port?.platforms ?? []);
  return new Set(
    (qualificationRecords ?? [])
      .filter(
        (record) =>
          qualificationScopeKey(port, record?.scope) !== null &&
          record?.kind === kind &&
          record?.outcome === "passed" &&
          declared.has(record?.scope?.platform),
      )
      .map((record) => record.scope.platform),
  );
}

export function qualifiedPlatforms(port, qualificationRecords = []) {
  const automated = exactQualificationKeys(port, qualificationRecords, "automated_lifecycle");
  const exact = new Set(
    (qualificationRecords ?? [])
      .filter((record) => record?.kind === "hands_on" && record?.outcome === "passed")
      .filter((record) => automated.has(qualificationScopeKey(port, record.scope)))
      .map((record) => record.scope.platform),
  );
  const legacyAutomated = new Set(port?.automated_tested_platforms ?? []);
  const legacyManual = new Set(port?.manually_validated_platforms ?? []);
  return (port?.platforms ?? []).filter(
    (platform) =>
      exact.has(platform) || (legacyAutomated.has(platform) && legacyManual.has(platform)),
  );
}

function automatedPlatforms(port, qualificationRecords = []) {
  const automated = new Set(port?.automated_tested_platforms ?? []);
  for (const platform of exactQualificationPlatforms(
    port,
    qualificationRecords,
    "automated_lifecycle",
  )) {
    automated.add(platform);
  }
  return (port?.platforms ?? []).filter((platform) => automated.has(platform));
}

function issueSection(body, heading) {
  const escaped = heading.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return (
    String(body ?? "")
      .match(new RegExp(`^##\\s+${escaped}\\s*$([\\s\\S]*?)(?=^##\\s|(?![\\s\\S]))`, "im"))?.[1]
      ?.trim() ?? ""
  );
}

function hasBlockedEvidence(body) {
  const section =
    issueSection(body, "Dependencies and blockers") ||
    issueSection(body, "Known dependencies and blockers");
  if (
    !section ||
    /^(?:pending|tbd|todo|none)[.!]?$/i.test(section) ||
    /no current blocker (?:has been )?established/i.test(section)
  )
    return false;
  return /\b(?:resume|until|when|needs?|required missing|after)\b/i.test(section);
}

export function validatePortStageSemantics(catalog, items) {
  const errors = [];
  const warnings = [];
  const diagnostics = [];
  const portsById = new Map((catalog?.ports ?? []).map((port) => [port.id, port]));
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
            record?.scope?.port_id === port.id &&
            record?.kind === "hands_on" &&
            record?.outcome === "passed",
        )
        .map((record) => ({
          platform: record.scope.platform,
          matching: automated.has(qualificationScopeKey(port, record.scope)),
        })),
    ];
    for (const { platform, matching } of manualEvidence) {
      if (!(port.platforms ?? []).includes(platform) || !matching) {
        errors.push(
          `Catalog port ${port.id} has manual evidence without matching declared automated qualification for ${platform}`,
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
      errors.push(`${stage} port must have exactly one valid catalog ID: ${url}`);
    }
    if (automatedPortStages.has(stage) && port && automated.length === 0) {
      errors.push(`${stage} port has no automated evidence for a declared platform: ${url}`);
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
    if (port && !["Blocked", "Rejected"].includes(stage) && understatesQualification) {
      warnings.push(
        `${url} may conservatively understate catalog qualification at Port stage ${stage}; no automatic promotion was made`,
      );
    }
  }
  return { errors, warnings, diagnostics };
}

export function planPortStageReconciliation(catalog, items) {
  const portsById = new Map((catalog?.ports ?? []).map((port) => [port.id, port]));
  const qualificationRecords = catalog?.source_catalog?.qualification ?? [];
  const changes = [];
  for (const item of items ?? []) {
    if (fieldValue(item, "Port stage") !== "Supported") continue;
    const ids = portCatalogMarkers(itemBody(item));
    const port = ids.length === 1 ? portsById.get(ids[0]) : null;
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

export function validatePortIssueCoverage(catalog, items, repository, repositoryIssues = null) {
  const errors = [];
  const catalogIds = new Set((catalog?.ports ?? []).map((port) => port.id));
  const issuesByCatalogId = new Map();
  const issuesByPortKey = new Map();
  const issuesByTitle = new Map();
  const issuesByUpstreamAndIdentity = new Map();
  const projectItemsByNumber = new Map();
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
        `Open [Port] issue lacks the canonical port marker: ${url}. Run node scripts/roadmap.mjs normalize-port --issue ${number}`,
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
      if (!catalogIds.has(id)) errors.push(`Port issue claims unknown catalog ID ${id}: ${url}`);
      const matches = issuesByCatalogId.get(id) ?? [];
      matches.push(url);
      issuesByCatalogId.set(id, matches);
    } else {
      if (
        !/Catalog ID:\s*Not assigned \(researched candidate\)/i.test(body) ||
        !/(?:does not grant support|not supported merely|does not change catalog\.json)/i.test(body)
      ) {
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
    if (matches.length === 0) errors.push(`Catalog port lacks a canonical Project issue: ${id}`);
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

export function parseArguments(argv) {
  const command = argv[0];
  if (!command) throw new Error("missing command; use --help for available commands");
  const options = {};
  const positionals = [];
  for (let index = 1; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith("--")) {
      positionals.push(token);
      continue;
    }
    const [name, inline] = token.split("=", 2);
    if (["--apply", "--json"].includes(name) && inline === undefined) {
      options[name] = true;
      continue;
    }
    const value = inline ?? argv[index + 1];
    if (!value || value.startsWith("--")) throw new Error(`${name} requires a value`);
    options[name] = value;
    if (inline === undefined) index += 1;
  }
  return { command, options, positionals };
}

export const roadmapHelp = `Portcove Roadmap maintainer tool

usage:
  node scripts/roadmap.mjs check
  node scripts/roadmap.mjs doctor
  node scripts/roadmap.mjs capture-port --title <title> --url <https-url> (--port-key <key> | --catalog-id <id>)
  node scripts/roadmap.mjs normalize-port --issue <number>
  node scripts/roadmap.mjs capture-feature --title <title> [planning field options]
  node scripts/roadmap.mjs promote <draft-item-id> [--spec-file <path>]
  node scripts/roadmap.mjs set <item-or-issue> [field options]
  node scripts/roadmap.mjs set-many --spec-file <path> [--apply] [--json]
  node scripts/roadmap.mjs move <item> --before <item>
  node scripts/roadmap.mjs next [--json]
  node scripts/roadmap.mjs context --issue <number> --runner <identity> [--coordination-pr <number>] [--consumed-file <path> | --consumed-comment <url>] [--reservation-comment <url>] [--json]
  node scripts/roadmap.mjs acknowledge --context-file <path> --runner <actual-instance> --action <actual-action> --evidence <reference> [--json]
  node scripts/roadmap.mjs handoff-offer --spec-file <path> [--json]
  node scripts/roadmap.mjs handoff-return --offer-file <path> --runner <actual-instance> --disposition <accepted|declined|pending> --evidence <exact-reference> [--json]
  node scripts/roadmap.mjs history --issue <number> [--coordination-pr <number>] [--json]
  node scripts/roadmap.mjs rename-commitment [--apply]
  node scripts/roadmap.mjs readiness --release <release>
  node scripts/roadmap.mjs candidate-scope --issues <issue,issue,...>
  node scripts/roadmap.mjs snapshot --release <release> --output <docs/releases/path>

Use capture-port for direct maintainer intake. Use normalize-port for a public
New Port form submission; it preserves form content, reconciles canonical
markers, Project membership and neutral unset fields. Parent relationships are preserved.`;

export function fieldValue(item, fieldName) {
  const wanted = normalizedKey(fieldName);
  for (const [key, value] of Object.entries(item ?? {})) {
    if (normalizedKey(key) === wanted) return value;
  }
  for (const value of item?.fieldValues ?? []) {
    if (normalizedKey(value?.field?.name ?? value?.name) === wanted) {
      return value?.name ?? value?.value ?? value?.option?.name;
    }
  }
  return undefined;
}

function itemTitle(item) {
  return item?.title ?? item?.content?.title ?? "Untitled";
}

function itemUrl(item) {
  return item?.content?.url ?? item?.url;
}

function itemBody(item) {
  return item?.content?.body ?? item?.body ?? "";
}

function itemDone(item) {
  const status = String(fieldValue(item, "Status") ?? "").toLowerCase();
  return status === "done";
}

function repositoryState(item) {
  return String(item?.content?.state ?? item?.state ?? "").toLowerCase();
}

export function selectNextItems(items) {
  const priority = new Map([
    ["Urgent", 0],
    ["High", 1],
    ["Medium", 2],
    ["Low", 3],
    ["None", 4],
  ]);
  const horizon = new Map([
    ["Now", 0],
    ["Next", 1],
  ]);
  return items
    .map((item, index) => ({ item, index }))
    .filter(
      ({ item }) =>
        !itemDone(item) &&
        fieldValue(item, "Status") !== "Deferred" &&
        !["closed", "merged"].includes(repositoryState(item)) &&
        horizon.has(fieldValue(item, "Horizon")) &&
        fieldValue(item, "Work type") !== "Workstream",
    )
    .sort((left, right) => {
      const horizonOrder =
        horizon.get(fieldValue(left.item, "Horizon")) -
        horizon.get(fieldValue(right.item, "Horizon"));
      if (horizonOrder) return horizonOrder;
      const priorityOrder =
        (priority.get(fieldValue(left.item, "Priority")) ?? 5) -
        (priority.get(fieldValue(right.item, "Priority")) ?? 5);
      return priorityOrder || left.index - right.index;
    })
    .map(({ item }) => item);
}

function blockingNodes(item) {
  const value = item?.content?.blockedBy ?? item?.blockedBy;
  return Array.isArray(value) ? value : (value?.nodes ?? []);
}

export function renderExecutionQueue(items) {
  const queue = selectNextItems(items);
  if (!queue.length) return "No unfinished non-deferred non-workstream items are in Now or Next.";
  return (
    queue
      .map((item, index) => {
        const commitment = fieldValue(item, "Release commitment");
        const predecessor = index
          ? (itemUrl(queue[index - 1]) ?? itemTitle(queue[index - 1]))
          : "queue head";
        const dependencyRecord = item?.content?.blockedBy ?? item?.blockedBy;
        const incomplete = Number(dependencyRecord?.totalCount ?? 0) > blockingNodes(item).length;
        const blockers = blockingNodes(item)
          .filter((node) => {
            const owner = items.find((candidate) => issueNumber(candidate) === issueNumber(node));
            return !owner || !itemDone(owner);
          })
          .map((node) => `#${issueNumber(node)}`)
          .join(", ");
        return `${index + 1}. ${itemTitle(item)} | ${fieldValue(item, "Priority") ?? "None"} | ${fieldValue(item, "Horizon")} | ${fieldValue(item, "Status") ?? "Unassigned"} | ${commitment === "Opportunistic" ? "Planned" : (commitment ?? "Unclassified")} | after: ${predecessor}${blockers ? ` | prerequisites: ${blockers}` : ""}${incomplete ? " | prerequisite coverage incomplete; collect remaining relationships before selection" : ""}${itemUrl(item) ? ` | ${itemUrl(item)}` : ""}`;
      })
      .join("\n") +
    "\nQueue position is scheduling, not a blocking edge or accepted reservation. Select either Required or Planned; record concrete pass-over reasons in coordination."
  );
}

const legacyCoordinationIssue = 793;
const runnerLanes = ["cloud-a", "cloud-b", "local"];
export const coordinationReadLimits = Object.freeze({
  calls: 4,
  requestMs: 15_000,
  totalMs: 60_000,
  responseBytes: 65_536,
  boardBytes: 8_192,
  checkpointBytes: 4_096,
  targetBytes: 6_000,
  modelBytes: 12_000,
});

function operationalObject(body, marker, maximumBytes) {
  if (typeof body !== "string" || Buffer.byteLength(body, "utf8") > maximumBytes)
    throw new Error("operational state is missing or oversized; retain its exact source pointer");
  const normalized = body.replace(/\r\n/g, "\n");
  const prefix = `<!-- ${marker}:v1 -->\n\`\`\`json\n`;
  if (!normalized.startsWith(prefix) || !/\n```\s*$/.test(normalized))
    throw new Error("operational state is malformed; expected the versioned readable JSON record");
  const value = JSON.parse(normalized.slice(prefix.length).replace(/\n```\s*$/, ""));
  if (!value || Array.isArray(value) || typeof value !== "object")
    throw new Error("operational state must be an object");
  return value;
}

function publicIdentity(value) {
  return typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9._:-]{1,127}$/.test(value);
}

function operationalKeys(value, allowed, label) {
  if (Object.keys(value).some((key) => !allowed.includes(key)))
    throw new Error(
      `${label} contains unsupported fields; private notes/logs cannot enter operational state`,
    );
}

function operationalReference(value, repository) {
  if (typeof value !== "string") return false;
  const escaped = repository.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return (
    new RegExp(
      `^https://github\\.com/${escaped}/(?:issues|pull)/[1-9][0-9]*(?:#issuecomment-[1-9][0-9]*)?$`,
    ).test(value) ||
    new RegExp(`^https://github\\.com/${escaped}/pull/[1-9][0-9]*#body-sha256-[a-f0-9]{64}$`).test(
      value,
    ) ||
    /^(?:PR|issue)[1-9][0-9]*#issuecomment-[1-9][0-9]*$/.test(value)
  );
}

function operationalRequest(request, repository) {
  if (!request || typeof request !== "object" || Array.isArray(request)) return false;
  operationalKeys(
    request,
    [
      "request_id",
      "recipient_instance_or_coordinator",
      "acknowledgment_state",
      "disposition_reference",
    ],
    "request",
  );
  return (
    publicIdentity(request.request_id) &&
    publicIdentity(request.recipient_instance_or_coordinator) &&
    ["pending", "acknowledged", "unknown", "not_admitted"].includes(request.acknowledgment_state) &&
    (request.disposition_reference === null ||
      operationalReference(request.disposition_reference, repository)) &&
    (request.acknowledgment_state !== "acknowledged" || request.disposition_reference !== null)
  );
}

function latestOperationalConsumption(requests) {
  let latest = null;
  const sequences = new Set();
  for (const request of requests.filter((entry) => entry.request_id.startsWith("CONSUME-"))) {
    const match = /^CONSUME-[a-f0-9]{64}-([1-9][0-9]*)$/.exec(request.request_id);
    const sequence = match ? Number(match[1]) : NaN;
    if (!Number.isSafeInteger(sequence) || sequences.has(sequence))
      throw new Error(
        "consumption sequence is malformed, unsafe or duplicated; preserve the current anchor",
      );
    sequences.add(sequence);
    if (!latest || sequence > latest.sequence) latest = { request, sequence };
  }
  return latest;
}

export function deliveryMode(config) {
  const mode = config?.delivery_mode ?? "coordinated";
  if (!["coordinated", "single-local-runner"].includes(mode))
    throw new Error("delivery_mode must be coordinated or single-local-runner");
  return mode;
}

function requireCoordinatedDelivery(config) {
  if (deliveryMode(config) === "single-local-runner")
    throw new Error(
      "coordination is retired; preserve history and use the owning issue/PR for delivery evidence",
    );
}

export function validateOperationalConfig(config) {
  const board = config.runner_coordination;
  const positive = (value) => Number.isSafeInteger(value) && value > 0;
  if (
    !board ||
    board.schema_version !== 1 ||
    !positive(board.board_issue) ||
    board.board_issue === legacyCoordinationIssue ||
    !publicIdentity(board.coordinator_github_login) ||
    !Number.isSafeInteger(board.coordinator_github_id) ||
    board.coordinator_github_id < 1 ||
    !publicIdentity(board.coordinator_instance_id) ||
    board.durable_writer_mode !== "coordinator-only" ||
    !board.checkpoint_comment_ids ||
    Object.keys(board.checkpoint_comment_ids).length !== runnerLanes.length ||
    runnerLanes.some((lane) => !positive(board.checkpoint_comment_ids[lane])) ||
    new Set(Object.values(board.checkpoint_comment_ids)).size !== runnerLanes.length
  )
    throw new Error(
      "operational board configuration is unavailable; no history or write fallback is permitted",
    );
  return board;
}

function validOperationalReleaseReference(reference, repository, issue) {
  if (typeof reference !== "string") return false;
  const issuePrefixes = [
    `issue${issue}#issuecomment-`,
    `https://github.com/${repository}/issues/${issue}#issuecomment-`,
  ];
  if (
    issuePrefixes.some(
      (prefix) =>
        reference.startsWith(prefix) && /^[1-9][0-9]*$/.test(reference.slice(prefix.length)),
    )
  )
    return true;
  const prefix = `https://github.com/${repository}/pull/`;
  return (
    reference.startsWith(prefix) &&
    /^[1-9][0-9]*#body-sha256-[a-f0-9]{64}$/.test(reference.slice(prefix.length))
  );
}

export function parseOperationalBoard(body, config) {
  const configured = validateOperationalConfig(config);
  const board = operationalObject(body, "portcove-runner-board", coordinationReadLimits.boardBytes);
  operationalKeys(
    board,
    [
      "repository",
      "protocol_revision",
      "cutover_state",
      "coordinator_instance_id",
      "assignment_generation",
      "assignments",
      "pending_transfers",
      "checkpoint_pointers",
    ],
    "board",
  );
  if (
    board.repository !== config.repository ||
    board.protocol_revision !== 1 ||
    !["staged", "active"].includes(board.cutover_state) ||
    board.coordinator_instance_id !== configured.coordinator_instance_id ||
    !Number.isSafeInteger(board.assignment_generation) ||
    board.assignment_generation < 1 ||
    !Array.isArray(board.assignments) ||
    !Array.isArray(board.pending_transfers) ||
    !sameCoordinationTarget(board.checkpoint_pointers, configured.checkpoint_comment_ids)
  )
    throw new Error("operational board identity or assignment structure is malformed");
  const identifiers = new Set();
  const active = new Set();
  const completed = new Set();
  const instances = new Map();
  for (const assignment of board.assignments) {
    if (!assignment || typeof assignment !== "object" || Array.isArray(assignment))
      throw new Error("operational assignment is malformed");
    operationalKeys(
      assignment,
      [
        "lane",
        "runner_instance_id",
        "assignment_id",
        "generation",
        "accepted_ack",
        "owning_issue",
        "pr_and_source",
        "reserved_scope",
        "intentional_pause",
        "execution_slot",
        "released_reference",
      ],
      "assignment",
    );
    if (
      !runnerLanes.includes(assignment.lane) ||
      !publicIdentity(assignment.runner_instance_id) ||
      !publicIdentity(assignment.assignment_id) ||
      !Number.isSafeInteger(assignment.generation) ||
      assignment.generation < 1 ||
      !["active", "reviewed_waiting", "completed"].includes(assignment.execution_slot) ||
      !assignment.accepted_ack ||
      !publicIdentity(assignment.accepted_ack.request_id) ||
      typeof assignment.accepted_ack.observed_ack_reference !== "string" ||
      !operationalReference(assignment.accepted_ack.observed_ack_reference, config.repository) ||
      !Number.isSafeInteger(assignment.owning_issue) ||
      assignment.owning_issue < 1 ||
      typeof assignment.pr_and_source !== "string" ||
      !assignment.pr_and_source.trim() ||
      (assignment.execution_slot === "completed"
        ? assignment.reserved_scope !== null ||
          assignment.intentional_pause !== false ||
          !validOperationalReleaseReference(
            assignment.released_reference,
            config.repository,
            assignment.owning_issue,
          )
        : typeof assignment.reserved_scope !== "string" ||
          !assignment.reserved_scope.trim() ||
          assignment.released_reference != null) ||
      !(
        typeof assignment.intentional_pause === "boolean" ||
        (typeof assignment.intentional_pause === "string" && assignment.intentional_pause.trim())
      ) ||
      (instances.has(assignment.lane) &&
        instances.get(assignment.lane) !== assignment.runner_instance_id) ||
      identifiers.has(assignment.assignment_id) ||
      (assignment.execution_slot === "active" &&
        (active.has(assignment.lane) || completed.has(assignment.lane))) ||
      (assignment.execution_slot === "completed" &&
        (active.has(assignment.lane) || completed.has(assignment.lane)))
    )
      throw new Error(
        "operational assignment is unavailable or conflicting; preserve existing grants",
      );
    identifiers.add(assignment.assignment_id);
    operationalKeys(
      assignment.accepted_ack,
      ["request_id", "observed_ack_reference"],
      "accepted ACK",
    );
    instances.set(assignment.lane, assignment.runner_instance_id);
    if (assignment.execution_slot === "active") active.add(assignment.lane);
    if (assignment.execution_slot === "completed") completed.add(assignment.lane);
  }
  const transferIds = new Set();
  for (const transfer of board.pending_transfers) {
    if (!operationalRequest(transfer, config.repository) || transferIds.has(transfer.request_id))
      throw new Error(
        "pending transfer identity is malformed or ambiguous; absence cannot be inferred",
      );
    transferIds.add(transfer.request_id);
  }
  return board;
}

export function parseRunnerCheckpoint(body, lane, board) {
  const checkpoint = operationalObject(
    body,
    "portcove-runner-checkpoint",
    coordinationReadLimits.checkpointBytes,
  );
  operationalKeys(
    checkpoint,
    [
      "lane",
      "runner_instance_id",
      "assignment_id",
      "assignment_generation",
      "owning_task",
      "pr_and_source",
      "execution_phase",
      "last_meaningful_progress",
      "next_action",
      "outstanding_requests",
      "necessary_evidence_pointers",
    ],
    "checkpoint",
  );
  const assignment =
    board.assignments.find((entry) => entry.lane === lane && entry.execution_slot === "active") ??
    board.assignments.find((entry) => entry.lane === lane && entry.execution_slot === "completed");
  if (
    !assignment ||
    checkpoint.lane !== lane ||
    checkpoint.runner_instance_id !== assignment.runner_instance_id ||
    checkpoint.assignment_id !== assignment.assignment_id ||
    checkpoint.assignment_generation !== assignment.generation ||
    checkpoint.owning_task !== assignment.owning_issue ||
    typeof checkpoint.pr_and_source !== "string" ||
    !checkpoint.pr_and_source.trim() ||
    typeof checkpoint.execution_phase !== "string" ||
    !checkpoint.execution_phase.trim() ||
    !checkpoint.last_meaningful_progress ||
    typeof checkpoint.next_action !== "string" ||
    !checkpoint.next_action.trim() ||
    !Array.isArray(checkpoint.outstanding_requests) ||
    !Array.isArray(checkpoint.necessary_evidence_pointers)
  )
    throw new Error(
      `checkpoint ${lane} is missing, stale or conflicts with its accepted assignment`,
    );
  if (assignment.execution_slot === "completed") {
    const fullReference = (reference) =>
      reference.startsWith("issue")
        ? `https://github.com/${board.repository}/issues/${reference.slice(5)}`
        : reference;
    if (
      !["completed", "delivered"].includes(checkpoint.execution_phase) ||
      !checkpoint.necessary_evidence_pointers.some(
        (reference) =>
          typeof reference === "string" &&
          fullReference(reference) === fullReference(assignment.released_reference),
      )
    )
      throw new Error(
        `checkpoint ${lane} must retain its delivered phase and verified release evidence`,
      );
  }
  const requestIds = new Set();
  for (const request of checkpoint.outstanding_requests) {
    if (!operationalRequest(request, board.repository) || requestIds.has(request.request_id))
      throw new Error(`checkpoint ${lane} has malformed or ambiguous outstanding requests`);
    requestIds.add(request.request_id);
  }
  if (
    checkpoint.necessary_evidence_pointers.some(
      (reference) => !operationalReference(reference, board.repository),
    )
  )
    throw new Error(`checkpoint ${lane} has an unbound evidence reference`);
  latestOperationalConsumption(checkpoint.outstanding_requests);
  return checkpoint;
}

export function coordinationSnapshotMetrics(snapshot) {
  const bytes = Buffer.byteLength(JSON.stringify(snapshot), "utf8");
  return {
    model_facing_bytes: bytes,
    estimated_tokens: Math.ceil(bytes / 4),
    estimate_method: "UTF-8 bytes / 4; estimate, not billed tokens or delivery savings",
    over_design_target: bytes > coordinationReadLimits.targetBytes,
  };
}

export function readOperationalBoard(config, api, { now = () => performance.now() } = {}) {
  if (deliveryMode(config) === "single-local-runner")
    return {
      status: "retired",
      delivery_mode: "single-local-runner",
      active_writer_overlap: "not assessed",
      authority_limit:
        "Owner-authorized local delivery needs no coordinator grant. Verify actual writers before overlapping work; retirement does not prove release or inactivity.",
    };
  const started = now();
  const sourcePointers = [];
  let originalDirectory = null;
  const originals = [];
  const preserve = (endpoint, response) => {
    originalDirectory ??= mkdtempSync(path.join(tmpdir(), "portcove-board-originals-"));
    const bytes = JSON.stringify(response);
    const file = path.join(
      originalDirectory,
      `${String(originals.length + 1).padStart(2, "0")}.json`,
    );
    writeFileSync(file, bytes, { encoding: "utf8", flag: "wx" });
    originals.push({
      endpoint,
      file,
      bytes: Buffer.byteLength(bytes, "utf8"),
      sha256: createHash("sha256").update(bytes).digest("hex"),
    });
    writeFileSync(
      path.join(originalDirectory, "inventory.json"),
      JSON.stringify(originals, null, 2),
    );
  };
  let calls = 0;
  const get = (endpoint) => {
    const remainingMs = Math.floor(coordinationReadLimits.totalMs - (now() - started));
    if (++calls > coordinationReadLimits.calls || remainingMs <= 0)
      throw new Error("bounded operational snapshot collection expired");
    const response = api.request("GET", endpoint, null, {
      timeoutMs: Math.min(coordinationReadLimits.requestMs, remainingMs),
    }).body;
    preserve(endpoint, response);
    if (
      now() - started > coordinationReadLimits.totalMs ||
      Buffer.byteLength(JSON.stringify(response), "utf8") > coordinationReadLimits.responseBytes
    )
      throw new Error("operational response expired or exceeded its byte limit");
    return response;
  };
  try {
    const configured = validateOperationalConfig(config);
    const issueUrl = `https://github.com/${config.repository}/issues/${configured.board_issue}`;
    sourcePointers.push(issueUrl);
    const issue = get(`repos/${config.repository}/issues/${configured.board_issue}`);
    if (
      issue?.number !== configured.board_issue ||
      issue.html_url !== issueUrl ||
      issue.pull_request ||
      !Number.isFinite(Date.parse(issue.updated_at)) ||
      issue.comments !== runnerLanes.length ||
      issue.user?.login !== configured.coordinator_github_login ||
      issue.user?.id !== configured.coordinator_github_id
    )
      throw new Error(
        "operational issue identity/writer or fixed-three-comment count is mismatched",
      );
    const board = parseOperationalBoard(issue.body, config);
    const checkpoints = {};
    const observations = [
      { url: issueUrl, raw_revision: digest(issue.body), edited_at: issue.updated_at },
    ];
    for (const lane of runnerLanes) {
      const id = configured.checkpoint_comment_ids[lane];
      const url = `${issueUrl}#issuecomment-${id}`;
      sourcePointers.push(url);
      const comment = get(`repos/${config.repository}/issues/comments/${id}`);
      if (
        comment?.id !== id ||
        comment.html_url !== url ||
        !Number.isFinite(Date.parse(comment.updated_at)) ||
        comment.issue_url !==
          `https://api.github.com/repos/${config.repository}/issues/${configured.board_issue}` ||
        comment.user?.login !== configured.coordinator_github_login ||
        comment.user?.id !== configured.coordinator_github_id
      )
        throw new Error(`checkpoint ${lane} identity or authorized writer is mismatched`);
      checkpoints[lane] = parseRunnerCheckpoint(comment.body, lane, board);
      observations.push({ url, raw_revision: digest(comment.body), edited_at: comment.updated_at });
    }
    const snapshot = {
      status: board.cutover_state === "active" ? "observed" : "staged",
      board,
      checkpoints,
      observations,
      authority_limit:
        "Declared snapshot and edit permission are not proof of native worker ACK, activity or an atomic grant. Preserve verified coordinator assignments.",
    };
    if (now() - started >= coordinationReadLimits.totalMs)
      throw new Error("bounded operational snapshot collection expired");
    return {
      ...snapshot,
      original_evidence_manifest: path.join(originalDirectory, "inventory.json"),
    };
  } catch (error) {
    return {
      status: "unknown",
      state: null,
      source_pointers: sourcePointers,
      original_evidence_manifest: originalDirectory
        ? path.join(originalDirectory, "inventory.json")
        : null,
      reason: sanitizeOperationError(error).message,
      authority_limit:
        "Unavailable state is not unowned or no blocker; stop conflicting new grants and preserve healthy accepted work.",
    };
  }
}

export function operationalBaseline(current) {
  if (!["observed", "staged"].includes(current.status)) return null;
  return {
    schema_version: 1,
    status: current.status,
    repository: current.board.repository,
    coordinator_instance_id: current.board.coordinator_instance_id,
    assignment_generation: current.board.assignment_generation,
    assignment_binding_revision: digest(
      current.board.assignments.map(
        ({
          lane,
          runner_instance_id,
          assignment_id,
          generation,
          execution_slot,
          released_reference,
        }) => ({
          lane,
          runner_instance_id,
          assignment_id,
          generation,
          execution_slot,
          released_reference,
        }),
      ),
    ),
    observations: current.observations,
  };
}

export function validOperationalBaseline(baseline, current) {
  const expected = operationalBaseline(current);
  if (
    !baseline ||
    baseline.schema_version !== 1 ||
    !["observed", "staged"].includes(baseline.status) ||
    baseline.repository !== expected.repository ||
    baseline.coordinator_instance_id !== expected.coordinator_instance_id ||
    baseline.assignment_generation !== expected.assignment_generation ||
    baseline.assignment_binding_revision !== expected.assignment_binding_revision ||
    !Array.isArray(baseline.observations) ||
    baseline.observations.length !== 4
  )
    return false;
  return baseline.observations.every(
    (entry, index) =>
      entry &&
      Object.keys(entry).length === 3 &&
      entry.url === expected.observations[index].url &&
      typeof entry.raw_revision === "string" &&
      /^[a-f0-9]{64}$/.test(entry.raw_revision) &&
      typeof entry.edited_at === "string" &&
      Number.isFinite(Date.parse(entry.edited_at)),
  );
}

export function operationalChanges(current, baseline = null) {
  if (current.status === "unknown") return { state: "unknown", snapshot: current };
  if (!baseline) return { state: "fresh", snapshot: current };
  if (!validOperationalBaseline(baseline, current))
    return { state: "baseline_unavailable", snapshot: current };
  const changed = current.observations.filter(
    (entry, index) =>
      entry.raw_revision !== baseline.observations[index].raw_revision ||
      entry.edited_at !== baseline.observations[index].edited_at,
  );
  if (!changed.length)
    return {
      state: "unchanged",
      changed_records: [],
      original_evidence_manifest: current.original_evidence_manifest,
      authority_limit: current.authority_limit,
    };
  return {
    state: "changed",
    changed_records: changed,
    original_evidence_manifest: current.original_evidence_manifest,
    board: changed.some((entry) => entry.url === current.observations[0].url)
      ? current.board
      : null,
    checkpoints: Object.fromEntries(
      runnerLanes
        .filter((lane, index) =>
          changed.some((entry) => entry.url === current.observations[index + 1].url),
        )
        .map((lane) => [lane, current.checkpoints[lane]]),
    ),
    authority_limit: current.authority_limit,
  };
}

function renderOperationalState(delta) {
  if (delta.state === "unknown" || delta.state === "unchanged") return delta;
  const state = delta.snapshot ?? delta;
  const lines = [];
  if (state.board) {
    const board = state.board;
    lines.push(
      `${board.repository}; protocol${board.protocol_revision}; ${board.cutover_state}; coordinator ${board.coordinator_instance_id}; assignment generation${board.assignment_generation}.`,
    );
    lines.push(
      `Fixed checkpoint IDs: ${runnerLanes.map((lane) => `${lane}=${board.checkpoint_pointers[lane]}`).join(", ")}.`,
    );
    for (const assignment of board.assignments) {
      lines.push(
        `${assignment.lane}: ${assignment.runner_instance_id}; ${assignment.assignment_id} generation${assignment.generation}; ${assignment.execution_slot}; owning issue#${assignment.owning_issue}; ${assignment.pr_and_source}. Scope: ${assignment.execution_slot === "completed" ? "none; assignment released" : assignment.reserved_scope}. Pause: ${JSON.stringify(assignment.intentional_pause)}. Accepted ACK: ${assignment.accepted_ack.request_id} at ${assignment.accepted_ack.observed_ack_reference}.${assignment.execution_slot === "completed" ? ` Release: ${assignment.released_reference}.` : ""}`,
      );
    }
    lines.push(
      `Pending transfers: ${board.pending_transfers.length ? JSON.stringify(board.pending_transfers) : "none declared"}.`,
    );
  }
  for (const [lane, checkpoint] of Object.entries(state.checkpoints ?? {})) {
    lines.push(
      `${lane} checkpoint: ${checkpoint.runner_instance_id}; ${checkpoint.assignment_id} generation${checkpoint.assignment_generation}; owning issue#${checkpoint.owning_task}; ${checkpoint.pr_and_source}. Phase: ${checkpoint.execution_phase}. Last meaningful progress: ${typeof checkpoint.last_meaningful_progress === "string" ? checkpoint.last_meaningful_progress : JSON.stringify(checkpoint.last_meaningful_progress)}. Next: ${checkpoint.next_action}.`,
    );
    for (const request of checkpoint.outstanding_requests)
      lines.push(
        `Request ${request.request_id} to ${request.recipient_instance_or_coordinator}: ${request.acknowledgment_state}; disposition ${request.disposition_reference ?? "unknown"}.`,
      );
    if (!checkpoint.outstanding_requests.length) lines.push("Outstanding requests: none declared.");
    lines.push(
      `Evidence: ${checkpoint.necessary_evidence_pointers.join(", ") || "none declared"}.`,
    );
  }
  return {
    state: delta.state,
    details: lines.join("\n"),
    ...(delta.changed_records ? { changed_records: delta.changed_records } : {}),
    original_evidence_manifest: state.original_evidence_manifest ?? null,
    authority_limit: state.authority_limit,
  };
}

export function operationalEnvelope(current, baseline = null, binding = null) {
  if (current.status === "retired")
    return { operational_snapshot: current, operational_baseline: null };
  const envelope = {
    operational_snapshot: renderOperationalState(operationalChanges(current, baseline)),
    operational_baseline: operationalBaseline(current),
  };
  if (binding)
    envelope.operational_binding = Object.fromEntries(
      [
        "lane",
        "runner_instance_id",
        "assignment_id",
        "generation",
        "owning_issue",
        "execution_slot",
      ].map((key) => [key, binding[key]]),
    );
  if (binding?.execution_slot === "completed")
    envelope.operational_binding.released_reference = binding.released_reference;
  // Include measurement metadata itself in the measured emitted envelope.
  const measure = () => ({
    ...coordinationSnapshotMetrics(envelope),
    // Numeric 0/1 keeps the metadata width fixed across the design threshold.
    over_design_target: Number(
      Buffer.byteLength(JSON.stringify(envelope), "utf8") > coordinationReadLimits.targetBytes,
    ),
  });
  envelope.operational_metrics = measure();
  let stable = false;
  for (let pass = 0; pass < 8; pass++) {
    const metrics = measure();
    stable = JSON.stringify(metrics) === JSON.stringify(envelope.operational_metrics);
    envelope.operational_metrics = metrics;
    if (stable) break;
  }
  if (!stable)
    throw new Error("operational envelope measurement did not converge within its bounded passes");
  if (envelope.operational_metrics.model_facing_bytes > coordinationReadLimits.modelBytes)
    throw new Error(
      "emitted operational envelope is oversized; required requests were not truncated",
    );
  return envelope;
}

export function bindOperationalAssignment(snapshot, runner, issue) {
  if (snapshot.status === "retired") {
    if (!publicIdentity(runner) || !Number.isSafeInteger(issue) || issue < 1)
      throw new Error("pickup requires a reported runner identity and positive owning issue");
    return null;
  }
  if (!["observed", "staged"].includes(snapshot.status))
    throw new Error("assignment snapshot is unavailable; preserve existing ownership");
  const matching = snapshot.board.assignments.filter(
    (assignment) => assignment.runner_instance_id === runner && assignment.owning_issue === issue,
  );
  if (matching.length !== 1)
    throw new Error(
      "visible runner instance and owning task do not bind exactly one accepted assignment",
    );
  const assignment = matching[0];
  return {
    lane: assignment.lane,
    runner_instance_id: runner,
    assignment_id: assignment.assignment_id,
    generation: assignment.generation,
    owning_issue: assignment.owning_issue,
    execution_slot: assignment.execution_slot,
    reserved_scope: assignment.reserved_scope,
    intentional_pause: assignment.intentional_pause,
    ...(assignment.execution_slot === "completed"
      ? { released_reference: assignment.released_reference }
      : {}),
    accepted_ack: assignment.accepted_ack,
    authority_limit:
      "Matches the declared accepted assignment; caller identity is reported, not verified native invocation or current activity.",
  };
}

export function preserveOperationalRequests(previous, next, resolutions = [], repository = null) {
  const current = new Map(next.map((request) => [request.request_id, request]));
  const resolved = new Map();
  const previousAnchor = latestOperationalConsumption(previous);
  const nextAnchor = latestOperationalConsumption(next);
  if (
    previousAnchor &&
    !current.has(previousAnchor.request.request_id) &&
    (!nextAnchor || nextAnchor.sequence <= previousAnchor.sequence)
  )
    throw new Error(
      "retain the latest consumption anchor until a strictly newer current anchor preserves its high-water sequence",
    );
  for (const resolution of resolutions) {
    if (
      !resolution ||
      !publicIdentity(resolution.request_id) ||
      !["resolved", "cancelled"].includes(resolution.disposition) ||
      !operationalReference(resolution.observed_response_reference, repository) ||
      resolved.has(resolution.request_id) ||
      !previous.some(
        (request) =>
          request.request_id === resolution.request_id &&
          request.recipient_instance_or_coordinator ===
            resolution.recipient_instance_or_coordinator,
      )
    )
      throw new Error(
        "request removal requires a unique explicit recipient-bound resolution/cancellation reference",
      );
    resolved.set(resolution.request_id, resolution);
  }
  for (const request of previous) {
    const replacement = current.get(request.request_id);
    if (!replacement && resolved.has(request.request_id)) continue;
    if (
      !replacement ||
      replacement.recipient_instance_or_coordinator !== request.recipient_instance_or_coordinator ||
      (request.acknowledgment_state !== "acknowledged" &&
        replacement.acknowledgment_state === "acknowledged" &&
        (!replacement.disposition_reference ||
          replacement.disposition_reference === request.disposition_reference))
    )
      throw new Error(
        "unresolved request cannot disappear, change recipient or gain an ACK without new observed disposition evidence",
      );
  }
}

export function prepareOperationalCheckpoint(
  config,
  snapshot,
  lane,
  replacement,
  expectedObservation,
  resolutions = [],
) {
  requireCoordinatedDelivery(config);
  validateOperationalConfig(config);
  if (!["observed", "staged"].includes(snapshot.status) || !runnerLanes.includes(lane))
    throw new Error("fixed checkpoint state is unavailable");
  const index = runnerLanes.indexOf(lane) + 1;
  if (!sameCoordinationTarget(snapshot.observations[index], expectedObservation))
    throw new Error("fixed checkpoint preimage changed; preserve the unapplied intent");
  const body = `<!-- portcove-runner-checkpoint:v1 -->\n\`\`\`json\n${JSON.stringify(replacement, null, 2)}\n\`\`\``;
  const validated = parseRunnerCheckpoint(body, lane, snapshot.board);
  preserveOperationalRequests(
    snapshot.checkpoints[lane].outstanding_requests,
    validated.outstanding_requests,
    resolutions,
    config.repository,
  );
  return {
    status: "planned",
    writer_mode: "coordinator-only",
    coordinator_instance_id: snapshot.board.coordinator_instance_id,
    target_url: snapshot.observations[index].url,
    expected_observation: expectedObservation,
    assignment_generation: snapshot.board.assignment_generation,
    body,
    resolution_intents: resolutions,
    authority_limit:
      "Only the verified primary coordinator may apply this intent; a preimage check or GitHub edit is not a cross-machine lock.",
  };
}

export function prepareOperationalConsumption({
  client,
  config,
  context,
  runner,
  action,
  evidence,
  apply = false,
}) {
  requireCoordinatedDelivery(config);
  if (apply)
    throw new Error(
      "durable operational writes are coordinator-only; send the planned pointer-bound request to the verified primary coordinator",
    );
  const consumed = validateExecutionSnapshot(context.snapshot);
  if (
    typeof action !== "string" ||
    !action.trim() ||
    !operationalReference(evidence, config.repository)
  )
    throw new Error(
      "material consumption requires an actual action and repository-bound evidence reference",
    );
  const snapshot = client.operationalSnapshot();
  const binding = bindOperationalAssignment(snapshot, runner, consumed.issue.number);
  if (binding.execution_slot === "completed")
    throw new Error(
      "completed assignment has no active reservation; it cannot authorize a new consumption or implementation request",
    );
  if (
    context.pickup?.reported_runner !== runner ||
    [
      "lane",
      "runner_instance_id",
      "assignment_id",
      "generation",
      "owning_issue",
      "execution_slot",
    ].some((key) => context.operational_binding?.[key] !== binding[key])
  )
    throw new Error(
      "consumed context does not bind this reported runner, task and assignment generation",
    );
  if (
    !validOperationalBaseline(context.operational_baseline, snapshot) ||
    operationalChanges(snapshot, context.operational_baseline).state !== "unchanged"
  )
    throw new Error(
      "operational assignment or checkpoint changed; refresh before sending a consumption request",
    );
  const live = client.executionIssue(consumed.issue.number);
  const current = executionSnapshot(config, live.item, live.relationships);
  if (
    current.revision !== consumed.revision ||
    executionObservation(live.item, live.relationships) !== context.observation_revision
  )
    throw new Error(
      "task requirements or raw observation changed; consume the fresh specification first",
    );
  const requestPrefix = `CONSUME-${digest([binding.assignment_id, binding.generation, consumed.revision, context.observation_revision])}-`;
  const checkpoint = snapshot.checkpoints[binding.lane];
  const latest = latestOperationalConsumption(checkpoint.outstanding_requests);
  const previous = latest?.request;
  if (previous?.request_id.startsWith(requestPrefix))
    return {
      status: "quiet",
      request_id: previous.request_id,
      request: previous,
      authority_limit:
        "Existing request is preserved; its record alone does not prove a native ACK or worker activity.",
    };
  const sequence = 1 + (latest?.sequence ?? 0);
  if (!Number.isSafeInteger(sequence))
    throw new Error("consumption request sequence is unavailable");
  const requestId = `${requestPrefix}${sequence}`;
  const request = {
    request_id: requestId,
    recipient_instance_or_coordinator: snapshot.board.coordinator_instance_id,
    acknowledgment_state: "pending",
    disposition_reference: evidence,
  };
  const replacement = {
    ...checkpoint,
    outstanding_requests: [...checkpoint.outstanding_requests, request],
  };
  const plan = prepareOperationalCheckpoint(
    config,
    snapshot,
    binding.lane,
    replacement,
    snapshot.observations[runnerLanes.indexOf(binding.lane) + 1],
  );
  return {
    ...plan,
    request,
    consumption: {
      runner_instance_id: runner,
      assignment_id: binding.assignment_id,
      assignment_generation: binding.generation,
      issue: consumed.issue.number,
      revision: consumed.revision,
      observation_revision: context.observation_revision,
      action,
      evidence,
    },
    authority_limit:
      "Send this actual worker response through the connected native route. Dot alone verifies it and edits the fixed checkpoint; no owning-task or archive comment fallback.",
  };
}

// Offer/return packets are bounded claims, never grants or invocation authentication.
function operationalOfferBinding(snapshot, runner, assignmentId = null) {
  if (!["observed", "staged"].includes(snapshot.status))
    throw new Error("offer state is unavailable; preserve accepted ownership");
  const matches = snapshot.board.assignments.filter(
    (entry) =>
      entry.runner_instance_id === runner &&
      (!assignmentId || entry.assignment_id === assignmentId),
  );
  if (matches.length !== 1) throw new Error("offer identity does not bind one current assignment");
  const current = matches[0];
  return {
    ...bindOperationalAssignment(snapshot, runner, current.owning_issue),
    pr_and_source: current.pr_and_source,
  };
}

function operationalOfferPacket(config, snapshot, spec) {
  validateOperationalConfig(config);
  if (
    !spec ||
    !publicIdentity(spec.request_id) ||
    !publicIdentity(spec.runner_instance_id) ||
    !publicIdentity(spec.assignment_id) ||
    !Number.isSafeInteger(spec.generation) ||
    !Number.isSafeInteger(spec.owning_issue) ||
    spec.owning_issue < 1 ||
    !/^[a-f0-9]{40}$/u.test(spec.source ?? "") ||
    ![spec.scope, spec.outcome].every(
      (value) => typeof value === "string" && value.trim() && value.length <= 8192,
    ) ||
    !operationalReference(spec.evidence, config.repository)
  )
    throw new Error("bounded offer request, source, outcome, scope or evidence is malformed");
  const current = operationalOfferBinding(
    snapshot,
    spec.runner_instance_id,
    spec.current_assignment_id,
  );
  if (
    spec.generation < current.generation ||
    (spec.generation === current.generation &&
      (spec.assignment_id !== current.assignment_id ||
        spec.owning_issue !== current.owning_issue ||
        spec.scope !== current.reserved_scope))
  )
    throw new Error("offer generation or scope conflicts with the accepted assignment");
  const index = runnerLanes.indexOf(current.lane) + 1;
  const packet = {
    board_url: snapshot.observations[0].url,
    checkpoint_url: snapshot.observations[index].url,
    coordinator_instance_id: snapshot.board.coordinator_instance_id,
    current,
    proposed: Object.fromEntries(
      [
        "request_id",
        "runner_instance_id",
        "assignment_id",
        "generation",
        "owning_issue",
        "source",
        "scope",
        "outcome",
        "evidence",
      ].map((key) => [key, spec[key]]),
    ),
  };
  if (Buffer.byteLength(JSON.stringify(packet), "utf8") > coordinationReadLimits.modelBytes)
    throw new Error("offer packet is oversized; preserve its original scope without truncation");
  return { ...packet, offer_digest: digest(packet) };
}

function operationalToken(value) {
  return Buffer.from(digest(value), "hex").toString("base64url");
}

function operationalOfferRequest(offer) {
  return `OFFER-${operationalToken(offer.proposed.request_id)}-${operationalToken(offer.offer_digest)}`;
}

function verifyCurrentOperationalOffer(config, snapshot, offer) {
  const rebuilt = operationalOfferPacket(config, snapshot, {
    ...offer?.proposed,
    current_assignment_id: offer?.current?.assignment_id,
  });
  if (digest(rebuilt) !== digest(offer))
    throw new Error(
      "offer source, scope or generation is superseded; preserve the unapplied return",
    );
  const request = snapshot.checkpoints[offer.current.lane].outstanding_requests.find(
    (entry) => entry.request_id === operationalOfferRequest(offer),
  );
  if (!request || request.recipient_instance_or_coordinator !== offer.proposed.runner_instance_id)
    throw new Error(
      "offer is not preserved in the current fixed checkpoint; return remains pending",
    );
  if (
    request.acknowledgment_state === "not_admitted" ||
    (request.acknowledgment_state !== "acknowledged" &&
      request.disposition_reference !== offer.proposed.evidence)
  )
    throw new Error(
      "offer evidence changed or request is not admitted; preserve pending ownership",
    );
  if (request.acknowledgment_state === "acknowledged") {
    const anchors = snapshot.checkpoints[offer.current.lane].outstanding_requests.filter((entry) =>
      entry.request_id.startsWith(`RETURN-${operationalToken(offer.offer_digest)}-`),
    );
    if (
      anchors.length !== 1 ||
      anchors[0].acknowledgment_state !== "acknowledged" ||
      anchors[0].disposition_reference !== request.disposition_reference
    )
      throw new Error("acknowledged offer evidence conflicts with its preserved return anchor");
  }
  return request;
}

export function prepareOperationalOffer({ config, snapshot, spec, apply = false }) {
  requireCoordinatedDelivery(config);
  if (apply) throw new Error("offer writes are coordinator-only");
  const offer = operationalOfferPacket(config, snapshot, spec);
  const lane = offer.current.lane;
  const checkpoint = snapshot.checkpoints[lane];
  const prefix = `OFFER-${operationalToken(spec.request_id)}-`;
  const previous = checkpoint.outstanding_requests.filter((entry) =>
    entry.request_id.startsWith(prefix),
  );
  if (
    previous.length > 1 ||
    (previous[0] && previous[0].request_id !== operationalOfferRequest(offer))
  )
    throw new Error(
      "offer changed under the same request; retain or explicitly resolve the original",
    );
  if (previous.length)
    return {
      status: "quiet",
      offer,
      authority_limit: "Existing offer remains a proposal, not assignment admission or invocation.",
    };
  const request = {
    request_id: operationalOfferRequest(offer),
    recipient_instance_or_coordinator: spec.runner_instance_id,
    acknowledgment_state: "pending",
    disposition_reference: spec.evidence,
  };
  return {
    ...prepareOperationalCheckpoint(
      config,
      snapshot,
      lane,
      { ...checkpoint, outstanding_requests: [...checkpoint.outstanding_requests, request] },
      snapshot.observations[runnerLanes.indexOf(lane) + 1],
    ),
    offer,
    authority_limit:
      "Dot alone issues and preserves this offer. It grants no execution scope, replaces no accepted assignment and cannot wake an idle session.",
  };
}

function operationalReturnEvidenceReference(reference, repository, issue) {
  const short = /^(PR|issue)([1-9][0-9]*)#issuecomment-([1-9][0-9]*)$/u.exec(reference ?? "");
  const url = short
    ? `https://github.com/${repository}/${short[1] === "PR" ? "pull" : "issues"}/${short[2]}#issuecomment-${short[3]}`
    : reference;
  const prefix = `https://github.com/${repository}/`;
  if (typeof url !== "string" || !url.startsWith(prefix)) return null;
  const match =
    /^(issues|pull)\/([1-9][0-9]*)(?:#issuecomment-([1-9][0-9]*)|#body-sha256-([a-f0-9]{64}))$/u.exec(
      url.slice(prefix.length),
    );
  return match && (match[1] === "pull" || (Number(match[2]) === issue && match[3])) ? url : null;
}

function operationalReturnRecord(offer, disposition, evidence, evidenceObservation = null) {
  if (!["accepted", "declined", "pending"].includes(disposition))
    throw new Error("return disposition is unavailable");
  if (evidenceObservation !== null && !validOperationalEvidenceObservation(evidenceObservation))
    throw new Error("return evidence observation has unsupported fields or invalid metadata");
  const record = {
    offer_digest: offer.offer_digest,
    ...offer.proposed,
    disposition,
    evidence,
    evidence_observation: evidenceObservation,
  };
  if (Buffer.byteLength(JSON.stringify(record), "utf8") > coordinationReadLimits.modelBytes - 84)
    throw new Error(
      "return receipt is oversized; preserve its original evidence without truncation",
    );
  return { ...record, receipt_digest: digest(record) };
}

export function prepareOperationalReturn({
  config,
  snapshot,
  offer,
  runner,
  source,
  disposition,
  evidence,
  evidenceObservation = null,
  apply = false,
}) {
  requireCoordinatedDelivery(config);
  if (apply) throw new Error("return writes are coordinator-only");
  verifyCurrentOperationalOffer(config, snapshot, offer);
  if (runner !== offer.proposed.runner_instance_id)
    throw new Error("return identity differs from the offered instance");
  if (source !== offer.proposed.source) throw new Error("return source differs from the offer");
  if (!operationalReturnEvidenceReference(evidence, config.repository, offer.proposed.owning_issue))
    throw new Error("return requires exact owning repository evidence");
  const receipt = operationalReturnRecord(offer, disposition, evidence, evidenceObservation);
  return {
    status: "pending",
    receipt,
    authority_limit:
      "Reported worker response only. Return via an available native route or one exact owning-evidence reference at a genuine safe checkpoint; origin must be independently established. No grant, ACK, durable write or autonomous wake is implied.",
  };
}

export function prepareOperationalReturnAcceptance({
  config,
  snapshot,
  offer,
  receipt,
  verifyDelivery,
  readEvidence,
  apply = false,
}) {
  requireCoordinatedDelivery(config);
  if (apply) throw new Error("return acceptance writes are coordinator-only");
  const request = verifyCurrentOperationalOffer(config, snapshot, offer);
  const expected = operationalReturnRecord(
    offer,
    receipt?.disposition,
    receipt?.evidence,
    receipt?.evidence_observation ?? null,
  );
  if (
    !operationalReturnEvidenceReference(
      receipt?.evidence,
      config.repository,
      offer.proposed.owning_issue,
    ) ||
    Object.keys(expected).some((key) => receipt[key] !== expected[key])
  )
    throw new Error(
      "return identity, generation, scope, source or evidence conflicts with the offer",
    );
  const lane = offer.current.lane;
  const checkpoint = snapshot.checkpoints[lane];
  const prefix = `RETURN-${operationalToken(offer.offer_digest)}-`;
  const anchorId = `${prefix}${operationalToken(expected.receipt_digest)}`;
  const previous = checkpoint.outstanding_requests.filter((entry) =>
    entry.request_id.startsWith(prefix),
  );
  if (previous.length > 1 || (previous[0] && previous[0].request_id !== anchorId))
    throw new Error("return evidence changed under the same offer; preserve the original receipt");
  const observed = typeof readEvidence === "function" ? readEvidence(expected.evidence) : null;
  if (!observed || !expected.evidence_observation)
    return {
      status: "unknown",
      acknowledged: false,
      receipt: expected,
      reason: "exact evidence readback unavailable; preserve pending offer",
    };
  if (
    !validOperationalEvidenceObservation(observed) ||
    !validOperationalEvidenceObservation(expected.evidence_observation) ||
    operationalReturnEvidenceReference(
      observed.url,
      config.repository,
      offer.proposed.owning_issue,
    ) !==
      operationalReturnEvidenceReference(
        expected.evidence,
        config.repository,
        offer.proposed.owning_issue,
      ) ||
    digest(observed) !== digest(expected.evidence_observation)
  )
    throw new Error(
      "return evidence changed at its exact reference; preserve the original response",
    );
  // A trusted coordinator integration verifies the actual delivery independently.
  // JSON/caller fields (including `verified`) are deliberately never consulted.
  const delivery =
    typeof verifyDelivery === "function" ? verifyDelivery({ offer, receipt: expected }) : null;
  if (!delivery || delivery.status !== "established")
    return {
      status: "unknown",
      acknowledged: false,
      receipt: expected,
      reason:
        "independent delivery/invocation unavailable; preserve pending offer and original evidence",
    };
  if (
    delivery.runner_instance_id !== offer.proposed.runner_instance_id ||
    delivery.request_id !== offer.proposed.request_id ||
    delivery.receipt_digest !== expected.receipt_digest ||
    delivery.observed_response_reference !== expected.evidence ||
    typeof delivery.invocation_reference !== "string" ||
    !delivery.invocation_reference.trim()
  )
    throw new Error("independent delivery identity or exact receipt does not match the offer");
  if (expected.disposition === "pending" || offer.current.intentional_pause)
    return {
      status: "unknown",
      acknowledged: false,
      receipt: expected,
      reason: "pending response or intentional pause remains preserved; no assignment takeover",
    };
  if (previous.length)
    return {
      status: "quiet",
      acknowledged: true,
      receipt: expected,
      authority_limit:
        "Previously preserved response only; no new invocation, progress or scope admission.",
    };
  const updated = checkpoint.outstanding_requests.map((entry) =>
    entry.request_id === request.request_id
      ? { ...entry, acknowledgment_state: "acknowledged", disposition_reference: expected.evidence }
      : entry,
  );
  updated.push({
    request_id: anchorId,
    recipient_instance_or_coordinator: offer.proposed.runner_instance_id,
    acknowledgment_state: "acknowledged",
    disposition_reference: expected.evidence,
  });
  return {
    ...prepareOperationalCheckpoint(
      config,
      snapshot,
      lane,
      { ...checkpoint, outstanding_requests: updated },
      snapshot.observations[runnerLanes.indexOf(lane) + 1],
    ),
    acknowledged: true,
    receipt: expected,
    established_delivery: delivery,
    authority_limit:
      "Dot-only intent after independently established delivery. This preserves the current assignment and release; a successor still requires serialized grant and actual scope ACK. No repository code authenticates native transport or provides a global lock.",
  };
}

function validOperationalEvidenceObservation(value) {
  return (
    value &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    Object.keys(value).length === 3 &&
    Object.keys(value).every((key) => ["url", "body_sha256", "edited_at"].includes(key)) &&
    typeof value.url === "string" &&
    value.url.length <= 1024 &&
    typeof value.edited_at === "string" &&
    /^[a-f0-9]{64}$/u.test(value.body_sha256 ?? "") &&
    Number.isFinite(Date.parse(value.edited_at))
  );
}

export function readOperationalReturnEvidence(
  config,
  api,
  reference,
  issue,
  source,
  { now = Date.now } = {},
) {
  const short = /^(PR|issue)([1-9][0-9]*)#issuecomment-([1-9][0-9]*)$/u.exec(reference);
  const url = short
    ? `https://github.com/${config.repository}/${short[1] === "PR" ? "pull" : "issues"}/${short[2]}#issuecomment-${short[3]}`
    : reference;
  const match =
    /^https:\/\/github\.com\/([^/]+\/[^/]+)\/(issues|pull)\/([1-9][0-9]*)(?:#issuecomment-([1-9][0-9]*)|#body-sha256-([a-f0-9]{64}))$/u.exec(
      url ?? "",
    );
  if (
    !match ||
    match[1] !== config.repository ||
    (match[2] === "issues" && (Number(match[3]) !== issue || !match[4]))
  )
    throw new Error("return evidence must be an exact owning-issue comment or bound PR evidence");
  const started = now();
  let calls = 0;
  const get = (endpoint) => {
    if (++calls > 2 || now() - started >= 30_000)
      throw new Error("exact evidence collection expired");
    const response = api.request("GET", endpoint, null, {
      timeoutMs: Math.min(coordinationReadLimits.requestMs, 30_000 - (now() - started)),
    }).body;
    if (
      now() - started >= 30_000 ||
      Buffer.byteLength(JSON.stringify(response), "utf8") > coordinationReadLimits.responseBytes
    )
      throw new Error("exact evidence response expired or exceeded its byte limit");
    return response;
  };
  let record;
  if (match[2] === "pull") {
    const pr = get(`repos/${config.repository}/pulls/${match[3]}`);
    if (pr?.number !== Number(match[3]))
      throw new Error("exact PR evidence identity is mismatched");
    operationalPullRequestEvidence(config, issue, source, pr);
    if (match[5] && createHash("sha256").update(pr.body).digest("hex") !== match[5])
      throw new Error("PR body evidence hash changed; preserve its exact original pointer");
    record = pr;
  }
  if (match[4]) {
    record = get(`repos/${config.repository}/issues/comments/${match[4]}`);
    if (
      record?.html_url !== url ||
      record.id !== Number(match[4]) ||
      record.issue_url !== `https://api.github.com/repos/${config.repository}/issues/${match[3]}`
    )
      throw new Error("exact evidence comment identity is mismatched");
  }
  if (typeof record?.body !== "string" || !Number.isFinite(Date.parse(record.updated_at)))
    throw new Error("exact evidence body or timestamp is unavailable");
  return {
    url,
    body_sha256: createHash("sha256").update(record.body).digest("hex"),
    edited_at: record.updated_at,
  };
}

function operationalPullRequestEvidence(config, issue, source, pr) {
  if (
    !pr ||
    !Number.isSafeInteger(pr.number) ||
    pr.number < 1 ||
    pr.html_url !== `https://github.com/${config.repository}/pull/${pr.number}` ||
    !/^[a-f0-9]{40}$/u.test(source ?? "") ||
    pr.head?.sha !== source ||
    typeof pr.body !== "string" ||
    Buffer.byteLength(pr.body, "utf8") > coordinationReadLimits.responseBytes ||
    typeof pr.merged !== "boolean" ||
    !Number.isFinite(Date.parse(pr.updated_at)) ||
    (pr.merged && !/^[a-f0-9]{40}$/u.test(pr.merge_commit_sha ?? ""))
  )
    throw new Error(
      "exact repository PR source, merge state or bounded release evidence is unavailable",
    );
  const headings = [...pr.body.matchAll(/^## Linked issue[ \t]*\r?$/gmu)];
  if (headings.length !== 1)
    throw new Error("PR evidence requires one unambiguous owning linked-issue section");
  const heading = headings[0];
  const linked = pr.body.slice(heading.index + heading[0].length).split(/^## /mu)[0];
  if (
    !linked ||
    !new RegExp(`(?:Refs|Closes|Fixes|Resolves|Related to) #${issue}(?![0-9])`).test(linked)
  )
    throw new Error("PR evidence does not bind the owning task in its linked-issue section");
}

export function prepareOperationalReleaseEvidence({
  config,
  snapshot,
  runner,
  source,
  pullRequest,
  verifyDelivery,
  expectedReference,
  apply = false,
}) {
  requireCoordinatedDelivery(config);
  if (apply) throw new Error("release writes are coordinator-only");
  const binding = operationalOfferBinding(snapshot, runner);
  const pr = pullRequest;
  operationalPullRequestEvidence(config, binding.owning_issue, source, pr);
  const bodyHash = createHash("sha256").update(pr.body).digest("hex");
  const reference = `${pr.html_url}#body-sha256-${bodyHash}`;
  if (expectedReference !== undefined && expectedReference !== reference)
    throw new Error("PR body evidence changed; preserve the original hash-pinned release");
  const record = {
    runner_instance_id: runner,
    assignment_id: binding.assignment_id,
    generation: binding.generation,
    owning_issue: binding.owning_issue,
    source,
    reference,
    edited_at: pr.updated_at,
    merged: pr.merged,
    merge_commit_sha: pr.merge_commit_sha,
    body_sha256: bodyHash,
  };
  const receipt = { ...record, receipt_digest: digest(record) };
  const delivery = typeof verifyDelivery === "function" ? verifyDelivery({ receipt }) : null;
  if (!delivery || delivery.status !== "established")
    return {
      status: "unknown",
      receipt,
      reason:
        "independent source-owner release delivery unavailable; PR authorship/body cannot release scope",
    };
  if (
    delivery.role !== "source-owner-release" ||
    delivery.runner_instance_id !== runner ||
    delivery.assignment_id !== binding.assignment_id ||
    delivery.generation !== binding.generation ||
    delivery.receipt_digest !== receipt.receipt_digest ||
    typeof delivery.invocation_reference !== "string" ||
    !delivery.invocation_reference.trim()
  )
    throw new Error(
      "independent release delivery does not bind the actual owner and exact evidence",
    );
  return {
    status: "planned",
    writer_mode: "coordinator-only",
    reference,
    receipt,
    established_delivery: delivery,
    authority_limit:
      "Only Dot may reconcile a verified owner release. A pinned PR body is evidence, not authentication or permission. Open-PR handoff retains every remaining gate; source, merge-state or body edits invalidate this receipt.",
  };
}

export function coordinationTarget(config, issue, pullRequest = null) {
  const positive = (value) => Number.isSafeInteger(value) && value > 0;
  if (!positive(issue) || (pullRequest !== null && !positive(pullRequest)))
    throw new Error("coordination requires a positive work issue and optional PR number");
  const number = pullRequest ?? issue;
  if (number === legacyCoordinationIssue)
    throw new Error("#793 is read-only; select the owning issue or explicitly bound PR");
  return {
    repository: config.repository,
    work_issue: issue,
    kind: pullRequest === null ? "issue" : "pull_request",
    number,
    url: `https://github.com/${config.repository}/${pullRequest === null ? "issues" : "pull"}/${number}`,
  };
}

function sameCoordinationTarget(target, expected) {
  return (
    Boolean(target) &&
    Object.keys(target).length === Object.keys(expected).length &&
    Object.entries(expected).every(([key, value]) => target[key] === value)
  );
}

function validateCoordinationTarget(target, snapshot) {
  const expected = coordinationTarget(
    { repository: snapshot.repository },
    snapshot.issue.number,
    target?.kind === "pull_request" ? target.number : null,
  );
  if (!sameCoordinationTarget(target, expected))
    throw new Error("coordination target does not match this repository and work issue");
  return target;
}

function matchingConsumption(comment, snapshot, runner, target) {
  const url = comment.html_url ?? comment.url;
  if (
    !url?.startsWith(`${target.url}#issuecomment-`) ||
    !/^[1-9]\d*$/.test(url.slice(`${target.url}#issuecomment-`.length))
  )
    return null;
  const record = parseConsumptionRecord(comment.body);
  return record?.runner === runner &&
    record.snapshot.repository === snapshot.repository &&
    record.snapshot.issue.id === snapshot.issue.id &&
    sameCoordinationTarget(record.coordination_target, target)
    ? record
    : null;
}
const consumptionMarker = "<!-- portcove-roadmap-consumed:v1 -->";
const executionFields = [
  "Status",
  "Priority",
  "Horizon",
  "Target release",
  "Release commitment",
  "Work type",
  "Workstream",
  "Platform",
  "Port stage",
  "Effort",
];
const digest = (value) => createHash("sha256").update(JSON.stringify(value)).digest("hex");

// A comparison aid, never a semantic decision or authority to execute. Keep the
// complete specification in context output; unknown sections remain significant.
export function normalizeRequirements(body) {
  const evidenceHeadings = new Set([
    "delivered evidence",
    "delivered components",
    "completion evidence",
    "current behavior and evidence",
    "progress",
    "delivery evidence",
  ]);
  let excludedLevel = null;
  let fence = null;
  let indented = false;
  return String(body ?? "")
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .flatMap((line) => {
      const marker = /^ {0,3}(`{3,}|~{3,})/.exec(line);
      if (fence) {
        const closing = /^ {0,3}(`{3,}|~{3,})[ \t]*$/.exec(line);
        if (closing && closing[1][0] === fence[0] && closing[1].length >= fence.length)
          fence = null;
        return [line];
      }
      if (marker) {
        fence = marker[1];
        return [line];
      }
      if (/^(?: {4}|\t)/.test(line)) {
        indented = true;
        return [line];
      }
      if (!line.trim()) return indented ? [line] : [];
      indented = false;
      const heading = /^(#{1,6})\s+(.+?)\s*#*$/.exec(line.trim());
      if (heading) {
        if (excludedLevel !== null && heading[1].length <= excludedLevel) excludedLevel = null;
        if (excludedLevel === null && evidenceHeadings.has(heading[2].trim().toLowerCase()))
          excludedLevel = heading[1].length;
      }
      // Only omit bare evidence links/progress counters, not commands, paths,
      // negations or prose that could contain a changed obligation.
      if (
        excludedLevel !== null &&
        (/^\s*(?:[-*+]\s*)?\[[^\]]+\]\(https:\/\/[^)]+\)\s*$/.test(line) ||
          /^\s*(?:[-*+]\s*)?(?:Passed|Completed):\s*\d+(?:\s*\/\s*\d+)?\s*$/i.test(line))
      )
        return [];
      return [
        line
          .replace(/^\s*([-*+]\s+)\[[ xX]\]\s*/, "$1[] ")
          .replace(/^\s*#{1,6}\s+/, "")
          .trim(),
      ];
    })
    .join("\n");
}

export function executionSnapshot(config, item, relationships) {
  if (!item?.content?.id || !Number.isSafeInteger(item.content.number))
    throw new Error("execution context requires a canonical repository issue");
  const planning = Object.fromEntries(
    executionFields.map((name) => [name, fieldValue(item, name) ?? null]),
  );
  const snapshot = {
    schema_version: 1,
    repository: config.repository,
    issue: {
      id: item.content.id,
      number: item.content.number,
      url: item.content.url,
      state: item.content.state,
    },
    scope_revision: digest([
      normalizeRequirements(item.content.title),
      normalizeRequirements(item.content.body),
    ]),
    planning,
    prerequisites: relationships.blockedBy
      .map((node) => ({
        id: node.id,
        number: node.number,
        url: node.url,
        state: node.state,
        scope_revision: digest([
          normalizeRequirements(node.title),
          normalizeRequirements(node.body),
        ]),
        status: node.projectStatus ?? null,
      }))
      .sort((a, b) => a.number - b.number || a.id.localeCompare(b.id)),
    dependents: relationships.blocking
      .map((node) => ({ id: node.id, number: node.number, url: node.url }))
      .sort((a, b) => a.number - b.number || a.id.localeCompare(b.id)),
    organization: {
      parent: relationships.parent
        ? {
            id: relationships.parent.id,
            number: relationships.parent.number,
            url: relationships.parent.url,
          }
        : null,
      children: relationships.subIssues
        .map((node) => ({ id: node.id, number: node.number, url: node.url }))
        .sort((a, b) => a.number - b.number || a.id.localeCompare(b.id)),
    },
  };
  return { ...snapshot, revision: digest(snapshot) };
}

function projectFieldValues(node) {
  if (
    !Number.isSafeInteger(node.fieldValues?.totalCount) ||
    node.fieldValues.totalCount < 0 ||
    !Array.isArray(node.fieldValues.nodes) ||
    node.fieldValues.nodes.length !== node.fieldValues.totalCount ||
    node.fieldValues.pageInfo?.hasNextPage !== false
  )
    throw new Error(`incomplete GitHub inventory: Project item ${node.id} fields are truncated`);
  return node.fieldValues.nodes
    .map((value) => ({ name: value.name, field: { name: value.field?.name } }))
    .filter((value) => value.name && value.field.name);
}

export function validateExecutionSnapshot(snapshot) {
  const reference = (node) =>
    typeof node?.id === "string" &&
    node.id.length > 0 &&
    Number.isSafeInteger(node.number) &&
    node.number > 0 &&
    /^https:\/\/github\.com\/[^/]+\/[^/]+\/issues\/\d+$/.test(node.url ?? "");
  const hash = (value) => /^[a-f0-9]{64}$/.test(value ?? "");
  const unique = (nodes) => new Set(nodes.map((node) => node.id)).size === nodes.length;
  if (
    snapshot?.schema_version !== 1 ||
    !reference(snapshot.issue) ||
    !/^[^/\s]+\/[^/\s]+$/.test(snapshot.repository ?? "") ||
    snapshot.issue.url !==
      `https://github.com/${snapshot.repository}/issues/${snapshot.issue.number}` ||
    !["OPEN", "CLOSED"].includes(snapshot.issue.state) ||
    !hash(snapshot.scope_revision) ||
    !snapshot.planning ||
    executionFields.some(
      (name) =>
        !(name in snapshot.planning) ||
        (snapshot.planning[name] !== null && typeof snapshot.planning[name] !== "string"),
    ) ||
    !Array.isArray(snapshot.prerequisites) ||
    !unique(snapshot.prerequisites) ||
    snapshot.prerequisites.some(
      (node) =>
        !reference(node) ||
        !hash(node.scope_revision) ||
        !["OPEN", "CLOSED"].includes(node.state) ||
        (node.status !== null && typeof node.status !== "string"),
    ) ||
    !snapshot.organization ||
    !Array.isArray(snapshot.dependents) ||
    !unique(snapshot.dependents) ||
    snapshot.dependents.some((node) => !reference(node)) ||
    !Array.isArray(snapshot.organization.children) ||
    !unique(snapshot.organization.children) ||
    snapshot.organization.children.some((node) => !reference(node)) ||
    (snapshot.organization.parent !== null && !reference(snapshot.organization.parent))
  )
    throw new Error("invalid consumed requirements snapshot");
  const { revision, ...inputs } = snapshot;
  if (revision !== digest(inputs)) throw new Error("consumed snapshot identity is invalid");
  return snapshot;
}

export function compareExecutionSnapshots(current, consumed = null) {
  validateExecutionSnapshot(current);
  if (!consumed)
    return {
      state: "unknown",
      changes: [],
      action: "Read current requirements; no consumed revision was established.",
    };
  validateExecutionSnapshot(consumed);
  if (current.repository !== consumed.repository || current.issue.id !== consumed.issue.id)
    throw new Error("consumed revision belongs to another repository or issue");
  const fields = executionFields.filter(
    (name) => current.planning[name] !== consumed.planning[name],
  );
  const changes = [];
  if (current.issue.state !== consumed.issue.state) changes.push("issue_state_changed");
  if (current.scope_revision !== consumed.scope_revision) changes.push("scope_comparison_required");
  if (fields.length) changes.push("planning_changed");
  if (digest(current.prerequisites) !== digest(consumed.prerequisites))
    changes.push("prerequisites_changed");
  if (digest(current.organization) !== digest(consumed.organization))
    changes.push("organization_changed");
  if (digest(current.dependents) !== digest(consumed.dependents)) changes.push("consumers_changed");
  return {
    state: changes.length ? "comparison_required" : "unchanged",
    changes,
    planning_fields: fields,
    action: changes.length
      ? "Assess the actual delta: sequence at a safe handoff; reconcile affected obligations only. A fingerprint is not a scope decision, grant, safety stop or acceptance verdict."
      : "Continue valid work. Still check applicable owner instructions, full current acceptance and the exact source candidate before final acceptance.",
  };
}

export function parseConsumptionRecord(body) {
  if (!String(body).startsWith(consumptionMarker)) return null;
  const lines = String(body).replace(/\r\n/g, "\n").split("\n");
  if (lines[0] !== consumptionMarker || lines[1] !== "```json" || lines[3] !== "```")
    throw new Error("incomplete roadmap consumption record");
  const record = JSON.parse(lines[2]);
  if (
    record.schema_version !== 1 ||
    record.kind !== "consumed-requirements" ||
    !/^[a-f0-9]{64}$/.test(record.observation_revision ?? "") ||
    [record.runner, record.action, record.evidence].some(
      (value) => typeof value !== "string" || !value.trim(),
    )
  )
    throw new Error("invalid roadmap consumption record");
  validateExecutionSnapshot(record.snapshot);
  if (record.coordination_target)
    validateCoordinationTarget(record.coordination_target, record.snapshot);
  return record;
}

export function prepareConsumption(context, { runner, action, evidence }, comments) {
  if (!runner?.trim() || !action?.trim() || !evidence?.trim())
    throw new Error("acknowledgment requires actual runner, action and evidence");
  validateExecutionSnapshot(context.snapshot);
  const target = validateCoordinationTarget(context.coordination_target, context.snapshot);
  if (!/^[a-f0-9]{64}$/.test(context.observation_revision ?? ""))
    throw new Error("context requires the full raw observation identity");
  const prior = comments
    .map((comment) => ({
      comment,
      record: matchingConsumption(comment, context.snapshot, runner, target),
    }))
    .filter(({ record }) => record)
    .at(-1);
  if (
    prior?.record.snapshot.revision === context.snapshot.revision &&
    prior.record.observation_revision === context.observation_revision
  )
    return {
      needed: false,
      url: prior.comment.url,
      reason: "This runner already recorded this consumed revision; no comment or dispatch.",
    };
  const record = {
    schema_version: 1,
    kind: "consumed-requirements",
    runner,
    snapshot: context.snapshot,
    observation_revision: context.observation_revision,
    coordination_target: target,
    action,
    evidence,
  };
  const body = `${consumptionMarker}\n\`\`\`json\n${JSON.stringify(record)}\n\`\`\`\nObserved #${context.snapshot.issue.number}; ${runner} consumed revision ${context.snapshot.revision.slice(0, 12)}.\nAction: ${action}\nEvidence: ${evidence}\n\nThis records consumption, not a grant, current process activity or merge approval.`;
  return { needed: true, record, body };
}

export function deriveExecutionContext(
  config,
  item,
  relationships,
  { runner, comments, coverage, consumed = null, reservation = null, target = null },
) {
  const snapshot = executionSnapshot(config, item, relationships);
  target ??= coordinationTarget(config, snapshot.issue.number);
  validateCoordinationTarget(target, snapshot);
  const observation_revision = executionObservation(item, relationships);
  const latest = comments
    .map((comment) => ({ comment, record: matchingConsumption(comment, snapshot, runner, target) }))
    .filter(({ record }) => record)
    .at(-1);
  const previous = consumed ?? latest?.record.snapshot ?? null;
  const comparison = compareExecutionSnapshots(snapshot, previous);
  const prerequisites = relationships.blockedBy.map((node) => ({
    number: node.number,
    title: node.title,
    url: node.url,
    project_status: node.projectStatus,
    disposition:
      node.projectStatus === "Done"
        ? "recorded complete"
        : node.projectStatus
          ? "unfinished"
          : "unknown",
  }));
  return {
    schema_version: 1,
    observed_at: new Date().toISOString(),
    snapshot,
    observation_revision,
    coordination_target: target,
    canonical_issue: {
      number: item.content.number,
      url: item.content.url,
      title: item.content.title,
      state: item.content.state,
    },
    current_specification: item.content.body,
    planning: snapshot.planning,
    genuine_prerequisites: prerequisites,
    affected_dependents: relationships.blocking.map((node) => ({
      number: node.number,
      title: node.title,
      url: node.url,
      state: node.state,
    })),
    completion_organization: snapshot.organization,
    recommendation: {
      reason:
        "Explicitly requested task; inspect actual scope, accepted authority and capable route before selecting it.",
      queue_position: "not observed; use the common next queue",
      prerequisite_disposition: prerequisites.some((node) => node.disposition === "unknown")
        ? "unknown"
        : prerequisites.some((node) => node.disposition === "unfinished")
          ? "unfinished"
          : "recorded complete",
      execution_capability:
        "not assessed; prepare the smallest capable implementation/validation route from current acceptance and local-check --plan",
      authority:
        "Not established by this output, Ready, parentage or an acknowledgment. Use the owner's instructions and standing workflow.",
    },
    reservation: reservation
      ? {
          assessment:
            deliveryMode(config) === "single-local-runner"
              ? "reference only; verify actual writer activity, source-owner release and current scope"
              : "reference only; verify accepted grant and current scope with coordinator",
          ...reservation,
        }
      : {
          assessment: "unknown",
          coordination_url: target.url,
        },
    comparison,
    pickup: {
      reported_runner: runner,
      current_requirements: latest
        ? latest.record.snapshot.revision === snapshot.revision
          ? latest.record.observation_revision === observation_revision
            ? "recorded consumed"
            : "raw observation changed; may be editorial, compare before claiming current consumption"
          : "pending comparison"
        : "unknown",
      last_record: latest
        ? {
            url: latest.comment.url,
            recorder: latest.comment.author?.login ?? null,
            reported_action: latest.record.action,
            revision: latest.record.snapshot.revision,
          }
        : null,
      history_coverage: coverage,
      invoked: "unknown",
      active: "unknown",
      assigned: "unknown",
      limit:
        "Reported consumption is separate from verified worker activity, invocation and accepted reservation. An absent recent record does not prove no pickup.",
    },
  };
}

function executionObservation(item, relationships) {
  return digest({
    scope: [item.content.title, item.content.body],
    prerequisites: relationships.blockedBy
      .map((node) => ({ id: node.id, title: node.title, body: node.body }))
      .sort((a, b) => a.id.localeCompare(b.id)),
  });
}

export function consumedReference(comment, { repository, runner, issue, target = null }) {
  const record = parseConsumptionRecord(comment.body);
  if (
    !record ||
    record.runner !== runner ||
    record.snapshot.repository !== repository ||
    record.snapshot.issue.number !== issue
  )
    throw new Error("consumed comment does not match this repository, runner and task");
  const url = comment.html_url ?? comment.url;
  const legacyPrefix = `https://github.com/${repository}/issues/${legacyCoordinationIssue}#issuecomment-`;
  const legacy = url?.startsWith(legacyPrefix) && /^[1-9]\d*$/.test(url.slice(legacyPrefix.length));
  if (
    !legacy &&
    !matchingConsumption(
      comment,
      record.snapshot,
      runner,
      target ?? coordinationTarget({ repository }, issue),
    )
  )
    throw new Error("consumed comment does not match its bound issue/PR target");
  return record.snapshot;
}

function executionOptions(parsed, allowed) {
  if (
    parsed.positionals.length ||
    Object.keys(parsed.options).some((flag) => !allowed.includes(flag))
  )
    throw new Error(`unsupported ${parsed.command} arguments; see --help`);
  for (const flag of ["--apply", "--json"]) {
    if (flag in parsed.options && parsed.options[flag] !== true)
      throw new Error(`${flag} does not accept a value`);
  }
}

export function executeConsumption({
  client,
  config,
  context,
  runner,
  action,
  evidence,
  apply = false,
}) {
  validateExecutionSnapshot(context?.snapshot);
  if (!/^[a-f0-9]{64}$/.test(context.observation_revision ?? ""))
    throw new Error("context requires the full raw observation identity");
  if (context.snapshot.repository !== config.repository)
    throw new Error("context belongs to another repository");
  if (context.pickup?.reported_runner !== runner)
    throw new Error(
      "context runner differs from the reported consumer; read that runner's current context",
    );
  const target = validateCoordinationTarget(context.coordination_target, context.snapshot);
  const comments = client.coordinationRecords(target);
  const live = client.executionIssue(context.snapshot.issue.number);
  const current = executionSnapshot(config, live.item, live.relationships);
  if (
    current.revision !== context.snapshot.revision ||
    executionObservation(live.item, live.relationships) !== context.observation_revision
  )
    throw new Error(
      "Consumed snapshot is stale. Read context, compare the actual delta and record current consumption; this is not a rejection of the source candidate.",
    );
  const planned = prepareConsumption(context, { runner, action, evidence }, comments.nodes);
  if (!planned.needed || !apply) return { status: apply ? "succeeded" : "planned", ...planned };
  const knownLatest = comments.nodes.some((comment) =>
    matchingConsumption(comment, context.snapshot, runner, target),
  );
  if (!comments.coverage.complete && !knownLatest)
    throw new Error(
      "Consumption history is bounded; absence/latest is unknown. Retain the planned body; use an exact current-window reference or the owning issue with complete bounded coverage.",
    );
  // A stable count does not exclude edited/replaced comments. Recheck the
  // bounded raw window immediately before writing, without scanning archives.
  const refreshed = client.coordinationRecords(target);
  if (digest(refreshed) !== digest(comments))
    throw new Error(
      "Coordination history changed before acknowledgment; refresh context before writing",
    );
  const fresh = client.executionIssue(context.snapshot.issue.number);
  if (
    executionSnapshot(config, fresh.item, fresh.relationships).revision !== current.revision ||
    executionObservation(fresh.item, fresh.relationships) !== context.observation_revision
  )
    throw new Error("Consumed snapshot is stale before acknowledgment");
  const endpoint = `repos/${config.repository}/issues/${target.number}/comments`;
  let transportError = null;
  let written;
  try {
    written = client.api.request("POST", endpoint, { body: planned.body }).body;
  } catch (error) {
    transportError = error;
  }
  let saved;
  try {
    saved = written?.id
      ? [client.coordinationComment(`${target.url}#issuecomment-${written.id}`, target)]
      : client
          .coordinationRecords(target)
          .nodes.filter((comment) => !comments.nodes.some((prior) => prior.id === comment.id));
  } catch (error) {
    transportError ??= error;
    saved = [];
  }
  const matching = saved.filter(
    (comment) =>
      comment.body === planned.body &&
      (comment.html_url ?? comment.url)?.startsWith(`${target.url}#issuecomment-`),
  );
  if (matching.length !== 1) {
    const error = new Error(
      "Acknowledgment write is unconfirmed; retain the exact pending body and read back before retrying.",
    );
    error.operationStatus = "unknown";
    error.operationEvidence = {
      pending_body: planned.body,
      issue: context.snapshot.issue.number,
      transport_error: transportError?.message ?? null,
    };
    throw error;
  }
  return {
    status: "succeeded",
    needed: true,
    url: matching[0].html_url ?? matching[0].url,
    readback: "exact",
    transport: transportError ? "ambiguous response reconciled; no retry" : "success",
  };
}

export function executionQueueData(items) {
  return {
    schema_version: 1,
    meaning: "Recommendations only; neither runnable, assigned nor active is established.",
    candidates: selectNextItems(items).map((item, index, queue) => ({
      number: item.content?.number ?? null,
      url: itemUrl(item),
      title: itemTitle(item),
      position: index + 1,
      after: index ? itemUrl(queue[index - 1]) : null,
      planning: Object.fromEntries(
        executionFields.map((name) => [name, fieldValue(item, name) ?? null]),
      ),
      prerequisite_coverage:
        Number(item.content?.blockedBy?.totalCount ?? 0) === blockingNodes(item).length
          ? "complete"
          : "incomplete",
      prerequisites: blockingNodes(item).map((node) => node.number),
      reservation: "unknown",
      execution_capability: "not assessed",
    })),
  };
}

export function consumptionEnvelope(result) {
  return githubOperationEnvelope({
    operation: "roadmap.acknowledge",
    status: result.status,
    summary: result.needed
      ? "Material consumption acknowledgment prepared or recorded."
      : result.reason,
    evidence: result,
  });
}

export function executeCommitmentRename({ client, config, apply = false }) {
  const number = config.project.number;
  const desired = config.fields.find((field) => field.name === "Release commitment");
  if (!desired?.options.includes("Planned") || desired.options.includes("Opportunistic"))
    throw new Error("active configuration must use Required / Planned");
  const fields = unwrapCollection(client.fieldList(number), "fields");
  const step = planFieldReconciliation([desired], fields)[0];
  if (step.action === "error") throw new Error(step.reason);
  if (!["keep", "update"].includes(step.action))
    throw new Error("existing commitment field is required");
  if (!apply)
    return {
      status: "planned",
      field: step.actual.id,
      action: step.action,
      options: step.options ?? step.actual.options,
    };
  const before = client.itemList(number);
  const assignment = (item) =>
    item.fieldValues?.find((value) => value.field?.name === desired.name);
  const historical = step.actual.options.find((option) => option.name === "Opportunistic");
  const rate = client.sampleGraphqlRate();
  if (rate.remaining < 500)
    throw new Error(`commitment rename requires recovery reserve; reset ${rate.resetAt}`);
  const fresh = unwrapCollection(client.fieldList(number), "fields").find(
    (field) => field.id === step.actual.id,
  );
  if (JSON.stringify(fresh) !== JSON.stringify(step.actual))
    throw new Error("commitment field changed before rename");
  let mutationError;
  if (step.action === "update") {
    try {
      client.updateField(step.actual.id, step.options);
    } catch (error) {
      mutationError = error;
    }
  }
  const afterFields = unwrapCollection(client.fieldList(number), "fields");
  const afterField = afterFields.find((field) => field.id === step.actual.id);
  if (
    !afterField ||
    planFieldReconciliation([desired], afterFields)[0].action !== "keep" ||
    step.actual.options.some(
      (option) =>
        !afterField.options.some(
          (candidate) =>
            candidate.id === option.id &&
            candidate.name === (option.name === "Opportunistic" ? "Planned" : option.name),
        ),
    )
  )
    throw new Error(
      `commitment rename readback failed${mutationError ? `: ${mutationError.message}` : ""}`,
    );
  const after = client.itemList(number);
  if (before.length !== after.length)
    throw new Error(
      "Project membership changed during rename; reconcile before reporting completion",
    );
  for (const item of before) {
    const observed = after.find((candidate) => candidate.id === item.id);
    const original = assignment(item)?.name;
    if (
      !observed ||
      assignment(observed)?.name !== (original === "Opportunistic" ? "Planned" : original)
    )
      throw new Error(`commitment assignment changed during rename: ${item.id}`);
  }
  return {
    status: "succeeded",
    field: afterField.id,
    option: historical?.id ?? afterField.options.find((option) => option.name === "Planned")?.id,
    assignmentsVerified: after.length,
    alreadyApplied: step.action === "keep",
    reconciledAfterError: Boolean(mutationError),
  };
}

function uniqueItems(items) {
  return [
    ...new Map(
      items.map((item) => [item?.id ?? `issue:${issueNumber(item) ?? itemTitle(item)}`, item]),
    ).values(),
  ];
}

export function dependencyCycles(items) {
  const byNumber = new Map(
    items.map((item) => [issueNumber(item), item]).filter(([number]) => Number.isInteger(number)),
  );
  const cycles = [];
  const completed = new Set();
  const visiting = [];
  const visit = (item) => {
    const number = issueNumber(item);
    if (!Number.isInteger(number) || completed.has(number)) return;
    const activeIndex = visiting.indexOf(number);
    if (activeIndex >= 0) {
      cycles.push([...visiting.slice(activeIndex), number]);
      return;
    }
    visiting.push(number);
    for (const dependency of blockingNodes(item)) {
      const dependencyItem = byNumber.get(issueNumber(dependency));
      if (dependencyItem) visit(dependencyItem);
    }
    visiting.pop();
    completed.add(number);
  };
  for (const item of byNumber.values()) visit(item);
  return cycles;
}

export function analyzeReleaseReadiness(items, release, { candidateIssues = null } = {}) {
  if (
    candidateIssues !== null &&
    (!Array.isArray(candidateIssues) ||
      !candidateIssues.length ||
      candidateIssues.some((number) => !Number.isSafeInteger(number) || number < 1))
  ) {
    throw new Error("candidate scope requires explicit positive issue numbers");
  }
  if (candidateIssues?.some((number) => !items.some((item) => issueNumber(item) === number))) {
    throw new Error("candidate scope includes an issue missing from the Project");
  }
  const includedReleases = includedReleaseTargets(release);
  const milestone = !candidateIssues && ["Public beta", "1.0"].includes(release);
  const migrationConflicts = milestone
    ? items.filter(
        (item) =>
          !itemDone(item) && legacyReleaseSequence.includes(fieldValue(item, "Target release")),
      )
    : [];
  let unassignedRequired = items.filter(
    (item) =>
      fieldValue(item, "Release commitment") === "Required" &&
      ![...releaseSequence, "Post-V1", "Post-1.0"].includes(fieldValue(item, "Target release")),
  );
  const targeted = items.filter((item) =>
    candidateIssues
      ? candidateIssues.includes(issueNumber(item))
      : includedReleases.includes(fieldValue(item, "Target release")),
  );
  const requiredRoots = candidateIssues
    ? targeted
    : targeted.filter((item) => fieldValue(item, "Release commitment") === "Required");
  const relevantUnclassified = targeted.filter((item) => !fieldValue(item, "Release commitment"));
  const safetyConflicts = targeted.filter(
    (item) =>
      !itemDone(item) &&
      fieldValue(item, "Status") === "Blocked" &&
      fieldValue(item, "Work type") === "Security" &&
      fieldValue(item, "Release commitment") !== "Required",
  );
  const planned = targeted.filter((item) =>
    ["Planned", "Opportunistic"].includes(fieldValue(item, "Release commitment")),
  );
  const byNumber = new Map(
    items.map((item) => [issueNumber(item), item]).filter(([number]) => Number.isInteger(number)),
  );
  const effective = new Map();
  const dependencyConflicts = [];
  const missingProjectDependencies = [];
  const truncatedDependencies = [];
  const visit = (item) => {
    const key = item?.id ?? `issue:${issueNumber(item) ?? itemTitle(item)}`;
    if (effective.has(key)) return;
    effective.set(key, item);
    const blockedBy = item?.content?.blockedBy ?? item?.blockedBy;
    if (Number(blockedBy?.totalCount ?? 0) > blockingNodes(item).length) {
      truncatedDependencies.push(item);
    }
    for (const dependency of blockingNodes(item)) {
      const number = issueNumber(dependency);
      const projectItem = byNumber.get(number);
      if (!projectItem) {
        const synthetic = {
          id: `missing-project:${number}`,
          title: dependency.title,
          content: { ...dependency, type: "Issue" },
          missingProject: true,
        };
        effective.set(synthetic.id, synthetic);
        missingProjectDependencies.push({ item, dependency: synthetic });
        continue;
      }
      const commitment = fieldValue(projectItem, "Release commitment");
      const target = fieldValue(projectItem, "Target release");
      if (
        candidateIssues
          ? !commitment
          : commitment !== "Required" || !includedReleases.includes(target)
      ) {
        dependencyConflicts.push({
          item,
          dependency: projectItem,
          commitment,
          target,
        });
      }
      visit(projectItem);
    }
  };
  for (const item of uniqueItems([...requiredRoots, ...safetyConflicts])) visit(item);
  const effectiveRequired = [...effective.values()];
  if (candidateIssues)
    unassignedRequired = unassignedRequired.filter((item) => effectiveRequired.includes(item));
  const cycles = dependencyCycles(effectiveRequired.filter((item) => !item.missingProject));
  const unfinishedRequired = effectiveRequired.filter((item) => !itemDone(item));
  const statusConflicts = uniqueItems([...targeted, ...effectiveRequired]).filter((item) => {
    const state = repositoryState(item);
    return (
      (state === "open" && itemDone(item)) ||
      (["closed", "merged"].includes(state) && !itemDone(item))
    );
  });
  return {
    release: candidateIssues
      ? "Candidate implementation scope (not publication approval)"
      : release,
    includedReleases,
    targeted,
    requiredRoots,
    effectiveRequired,
    unfinishedRequired,
    relevantUnclassified,
    planned,
    opportunistic: planned, // Historical consumer compatibility; active reports use Planned.
    safetyConflicts,
    dependencyConflicts,
    missingProjectDependencies,
    truncatedDependencies,
    cycles,
    migrationConflicts,
    unassignedRequired,
    statusConflicts,
    ready:
      unfinishedRequired.length === 0 &&
      relevantUnclassified.length === 0 &&
      safetyConflicts.length === 0 &&
      dependencyConflicts.length === 0 &&
      missingProjectDependencies.length === 0 &&
      truncatedDependencies.length === 0 &&
      cycles.length === 0 &&
      migrationConflicts.length === 0 &&
      unassignedRequired.length === 0 &&
      statusConflicts.length === 0,
  };
}

export function renderReadinessSummary(analysis) {
  const section = (values) =>
    values.length ? values.map(itemLine).join("\n") : "- None recorded.";
  const dependencyConflicts = analysis.dependencyConflicts.map(
    ({ item, dependency, commitment, target }) =>
      `- ${markdownLink(item)} depends on ${markdownLink(dependency)}, classified ${commitment ?? "Unclassified"} / ${target ?? "Unscheduled"}.`,
  );
  const missing = analysis.missingProjectDependencies.map(
    ({ item, dependency }) =>
      `- ${markdownLink(item)} depends on ${markdownLink(dependency)}, which has no Project item.`,
  );
  const cycles = analysis.cycles.map(
    (cycle) => `- ${cycle.map((number) => `#${number}`).join(" -> ")}`,
  );
  const truncated = analysis.truncatedDependencies.map(
    (item) =>
      `- ${markdownLink(item)} has more blocking dependencies than the bounded query returned.`,
  );
  dependencyConflicts.push(
    ...analysis.migrationConflicts.map((item) => `- Unmigrated active target: ${itemLine(item)}`),
    ...analysis.unassignedRequired.map(
      (item) => `- Required work has no target: ${itemLine(item)}`,
    ),
    ...analysis.statusConflicts.map(
      (item) => `- Repository/Project status mismatch: ${itemLine(item)}`,
    ),
  );
  return `# ${analysis.release} readiness\n\n- Result: ${analysis.ready ? "READY" : "NOT READY"}\n- Required outcomes including blocking dependencies: ${analysis.effectiveRequired.length}\n- Unfinished required outcomes: ${analysis.unfinishedRequired.length}\n\n## Unfinished required outcomes\n\n${section(analysis.unfinishedRequired)}\n\n## Relevant unclassified work\n\n${section(analysis.relevantUnclassified)}\n\n## Safety commitment conflicts\n\n${section(analysis.safetyConflicts)}\n\n## Dependency classification conflicts\n\n${[...dependencyConflicts, ...missing, ...truncated].join("\n") || "- None recorded."}\n\n## Dependency cycles\n\n${cycles.join("\n") || "- None recorded."}\n\n## Planned work through this release\n\n${section(analysis.planned)}\n`;
}

export function catalogQualificationSummary(catalog) {
  const ports = Array.isArray(catalog?.ports) ? catalog.ports : [];
  const byTier = {};
  const declared = new Set();
  const automated = new Set();
  const manual = new Set();
  for (const port of ports) {
    byTier[port.support_tier ?? "unspecified"] =
      (byTier[port.support_tier ?? "unspecified"] ?? 0) + 1;
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

function markdownLink(item) {
  const url = itemUrl(item);
  const title = itemTitle(item).replaceAll("[", "\\[").replaceAll("]", "\\]");
  return url ? `[${title}](${url})` : title;
}

function itemLine(item) {
  const details = [
    "Status",
    "Priority",
    "Horizon",
    "Target release",
    "Release commitment",
    "Work type",
    "Workstream",
    "Platform",
  ]
    .map((name) => (fieldValue(item, name) ? `${name}: ${fieldValue(item, name)}` : null))
    .filter(Boolean)
    .join("; ");
  return `- ${markdownLink(item)}${details ? ` — ${details}` : ""}`;
}

export function completionEvidenceLinks(items) {
  const urls = new Set();
  for (const item of items) {
    const body = itemBody(item);
    const heading = body.match(/^## Completion evidence\s*$/im);
    const start = heading ? heading.index + heading[0].length : -1;
    const following = start >= 0 ? body.slice(start) : "";
    const nextHeading = following.search(/^##\s/m);
    const section = start < 0 ? "" : following.slice(0, nextHeading < 0 ? undefined : nextHeading);
    for (const match of section.matchAll(/https:\/\/[^\s)>]+/g)) urls.add(match[0]);
    for (const match of body.matchAll(/https:\/\/[^\s)>]+/g)) {
      const url = match[0].replace(/[.,;:]$/, "");
      if (
        /\/pull\/\d+(?:[#?].*)?$/i.test(url) ||
        /\/(?:actions\/runs|checks?\/|qualification|rehearsal)(?:\/|\?|#|$)/i.test(url)
      ) {
        urls.add(url);
      }
    }
  }
  return [...urls].sort();
}

export function renderSnapshot({ release, generatedAt, commit, projectUrl, items, catalog }) {
  const readiness = analyzeReleaseReadiness(items, release);
  const { includedReleases } = readiness;
  const matching = uniqueItems([...readiness.effectiveRequired, ...readiness.relevantUnclassified]);
  const complete = readiness.effectiveRequired.filter(itemDone);
  const unfinished = readiness.unfinishedRequired;
  const blockers = unfinished.filter((item) => fieldValue(item, "Status") === "Blocked");
  const inconsistencies = matching.filter((item) => {
    const state = repositoryState(item);
    return (
      ((state === "closed" || state === "merged") && !itemDone(item)) ||
      (state === "open" && itemDone(item))
    );
  });
  const deferred = items.filter(
    (item) =>
      fieldValue(item, "Status") === "Deferred" ||
      ["Post-V1", "Post-1.0"].includes(fieldValue(item, "Target release")),
  );
  const summary = catalogQualificationSummary(catalog);
  const tiers =
    Object.entries(summary.byTier)
      .sort()
      .map(([name, count]) => `  - ${name}: ${count}`)
      .join("\n") || "  - none";
  const section = (values) =>
    values.length ? values.map(itemLine).join("\n") : "- None recorded.";
  const links = completionEvidenceLinks(matching);
  const conflictLines = readiness.dependencyConflicts.map(
    ({ item, dependency, commitment, target }) =>
      `- ${markdownLink(item)} depends on ${markdownLink(dependency)}, classified ${commitment ?? "Unclassified"} / ${target ?? "Unscheduled"}.`,
  );
  conflictLines.push(
    ...readiness.migrationConflicts.map((item) => `- Unmigrated active target: ${itemLine(item)}`),
    ...readiness.unassignedRequired.map(
      (item) => `- Required work has no target: ${itemLine(item)}`,
    ),
    ...readiness.statusConflicts.map(
      (item) => `- Repository/Project status mismatch: ${itemLine(item)}`,
    ),
  );
  conflictLines.push(
    ...readiness.missingProjectDependencies.map(
      ({ item, dependency }) =>
        `- ${markdownLink(item)} depends on ${markdownLink(dependency)}, which has no Project item.`,
    ),
  );
  conflictLines.push(
    ...readiness.truncatedDependencies.map(
      (item) =>
        `- ${markdownLink(item)} has more blocking dependencies than the bounded query returned.`,
    ),
  );
  conflictLines.push(
    ...readiness.cycles.map(
      (cycle) => `- Dependency cycle: ${cycle.map((number) => `#${number}`).join(" -> ")}`,
    ),
  );
  return `# ${release} release readiness\n\n> Immutable snapshot generated from the live Portcove Roadmap and catalog. Project fields and genuine blocking dependencies define readiness after ${generatedAt}.\n\n- Generated: ${generatedAt}\n- Commit: \`${commit}\`\n- Project: ${projectUrl}\n- Target release: ${release}\n- Cumulative required stages: ${includedReleases.join(", ")}\n- Derived readiness: ${readiness.ready ? "READY" : "NOT READY"}\n\n## Open blockers\n\n${section(blockers)}\n\n## Completed required items\n\n${section(complete)}\n\n## Unfinished required items\n\n${section(unfinished)}\n\n## Relevant unclassified work\n\n${section(readiness.relevantUnclassified)}\n\n## Commitment and dependency conflicts\n\n${[...readiness.safetyConflicts.map(itemLine), ...conflictLines].join("\n") || "- None recorded."}\n\n## Planned work through this release\n\n${section(readiness.planned)}\n\n## Repository closure and Project Status inconsistencies\n\n${section(inconsistencies)}\n\nA closed or not-planned repository issue is not complete unless Project Status is Done. Resolve every inconsistency before release.\n\n## Consciously deferred or postponed\n\n${section(deferred)}\n\n## Catalog qualification summary\n\n- Catalog entries: ${summary.ports}\n- Declared port/platform pairs: ${summary.declaredPlatformPairs}\n- Automated port/platform pairs: ${summary.automatedPlatformPairs}\n- Manually validated port/platform pairs: ${summary.manuallyValidatedPlatformPairs}\n- Support tiers:\n${tiers}\n\n## Completion evidence links\n\n${links.length ? links.map((url) => `- ${url}`).join("\n") : "- No explicit completion evidence links were recorded on matching Project items."}\n\n## Test, CI, rehearsal, signing, and human validation\n\n- Record reviewed test commands and results here.\n- Record required CI runs here.\n- Record release rehearsal evidence here.\n- Record signing/notarization evidence or the explicit unsigned limitation here.\n- Record required human and physical-platform evidence here.\n\n## Explicit limitations\n\n- Review every unfinished, unclassified, conflicting, and deferred item above before publication.\n- This snapshot does not grant qualification or replace catalog evidence.\n- Project fields may change after generation; regenerate rather than editing this snapshot in place.\n`;
}

function unwrapCollection(value, key) {
  if (Array.isArray(value)) return value;
  if (Array.isArray(value?.[key])) return value[key];
  if (Array.isArray(value?.nodes)) return value.nodes;
  return [];
}

export function planFieldReconciliation(
  desiredFields,
  actualResult,
  { freshProject = false } = {},
) {
  const actualFields = unwrapCollection(actualResult, "fields");
  return desiredFields.map((desired) => {
    const actual = actualFields.find((field) => field.name === desired.name);
    if (!actual) return { action: "create", desired };
    const type = String(actual.dataType ?? actual.type ?? actual.__typename ?? "").toUpperCase();
    if (!type.includes("SINGLE") && !type.includes("SELECT")) {
      return {
        action: "error",
        desired,
        actual,
        reason: `${desired.name} is not a single-select field`,
      };
    }
    let actualOptions = actual.options ?? [];
    const rename = desired.name === "Release commitment" && desired.options.includes("Planned");
    const historical = actualOptions.find((option) => option.name === "Opportunistic");
    if (rename && historical && actualOptions.some((option) => option.name === "Planned")) {
      return {
        action: "error",
        desired,
        actual,
        reason:
          "Release commitment has both historical and active options; reconcile assignments explicitly",
      };
    }
    if (rename && historical) {
      actualOptions = actualOptions.map((option) =>
        option === historical ? { ...option, name: "Planned" } : option,
      );
    }
    const byName = new Map(actualOptions.map((option) => [option.name, option]));
    const missing = desired.options.filter((option) => !byName.has(option));
    const extra = actualOptions.filter((option) => !desired.options.includes(option.name));
    if (!(rename && historical) && !missing.length && (!freshProject || !extra.length))
      return { action: "keep", desired, actual };
    const ordered = freshProject
      ? desired.options.map((name) => byName.get(name) ?? { name, color: "GRAY", description: "" })
      : [...actualOptions, ...missing.map((name) => ({ name, color: "GRAY", description: "" }))];
    return { action: "update", desired, actual, options: ordered };
  });
}

export function planViewReconciliation(desiredViews, actualViews) {
  const byName = new Map(actualViews.map((view) => [view.name, view]));
  if (byName.size !== actualViews.length) throw new Error("duplicate actual view names");
  const used = new Set();
  return desiredViews.map((view) => {
    const current = byName.get(view.name);
    const previous = view.previous_name ? byName.get(view.previous_name) : null;
    if (current && previous) throw new Error(`ambiguous view rename: ${view.name}`);
    const actual = current ?? previous;
    if (!actual) return { action: "create", desired: view, actual };
    if (!actual.id || used.has(actual.id)) throw new Error(`duplicate view identity: ${view.name}`);
    used.add(actual.id);
    const drift = viewMachineDrift(view, actual);
    return {
      action: drift.length ? "update" : "keep",
      desired: view,
      actual,
      drift,
    };
  });
}

function visibleFieldNames(view) {
  return unwrapCollection(view?.fields, "fields")
    .map((field) => field.name)
    .filter(Boolean);
}

export function viewMachineDrift(desired, actual) {
  const drift = [];
  if (actual?.name !== desired.name) drift.push(`name ${actual?.name} != ${desired.name}`);
  if (actual?.layout !== desired.layout)
    drift.push(`layout ${actual?.layout ?? "missing"} != ${desired.layout}`);
  if (String(actual?.filter ?? "") !== desired.filter)
    drift.push(
      `filter ${JSON.stringify(actual?.filter ?? "")} != ${JSON.stringify(desired.filter)}`,
    );
  const expectedFields = [...desired.fields].sort();
  const actualFields = visibleFieldNames(actual).sort();
  if (JSON.stringify(actualFields) !== JSON.stringify(expectedFields)) {
    drift.push(`visible fields ${actualFields.join(", ")} != ${expectedFields.join(", ")}`);
  }
  if (actual?.groupByFields && actual?.verticalGroupByFields && actual?.sortByFields) {
    const groups = actual[
      desired.layout === "BOARD_LAYOUT" ? "verticalGroupByFields" : "groupByFields"
    ].nodes.map((field) => field.name);
    const expectedGroups = desired.manual_group_by ? [desired.manual_group_by] : [];
    if (JSON.stringify(groups) !== JSON.stringify(expectedGroups))
      drift.push(
        `grouping ${groups.join(", ") || "nothing"} != ${expectedGroups.join(", ") || "nothing"} (UI change required)`,
      );
    const otherGroups =
      actual[desired.layout === "BOARD_LAYOUT" ? "groupByFields" : "verticalGroupByFields"].nodes;
    if (otherGroups.length)
      drift.push(
        `unexpected secondary grouping ${otherGroups.map((field) => field.name).join(", ")} (UI change required)`,
      );
    const sorts = actual.sortByFields.nodes.map((sort) => `${sort.field.name}:${sort.direction}`);
    const expectedSorts = desired.manual_sort_by
      .split(",")
      .filter((name) => name !== "manual")
      .map((name) => `${name}:ASC`);
    if (JSON.stringify(sorts) !== JSON.stringify(expectedSorts))
      drift.push(
        `sorting ${sorts.join(", ") || "manual"} != ${expectedSorts.join(", ") || "manual"} (UI change required)`,
      );
  }
  return drift;
}

export function projectMachineDrift(config, { details, fields, views, repositories }) {
  const drift = [];
  if (details?.title !== config.project.title)
    drift.push(`project title is ${JSON.stringify(details?.title)}`);
  if (Number(details?.number) !== config.project.number)
    drift.push(`project number is ${details?.number}`);
  const isPublic = details?.public ?? details?.visibility === "PUBLIC";
  if (!isPublic) drift.push("project visibility is not PUBLIC");
  const linked = (repositories ?? []).some(
    (repository) =>
      `${repository.owner?.login ?? repository.owner}/${repository.name}`.toLowerCase() ===
      config.repository.toLowerCase(),
  );
  if (!linked) drift.push(`repository ${config.repository} is not linked`);
  for (const step of planFieldReconciliation(config.fields, { fields })) {
    if (step.action !== "keep")
      drift.push(`field ${step.desired.name}: ${step.reason ?? step.action}`);
  }
  for (const desired of config.fields) {
    const actual = fields.find((field) => field.name === desired.name);
    const extras = (actual?.options ?? [])
      .map((option) => option.name)
      .filter((name) => !desired.options.includes(name));
    if (extras.length) drift.push(`field ${desired.name}: unexpected options ${extras.join(", ")}`);
  }
  for (const step of planViewReconciliation(materializeViews(config), views)) {
    if (step.action !== "keep")
      drift.push(
        `view ${step.desired.name}: ${step.action}${step.drift?.length ? ` (${step.drift.join("; ")})` : ""}`,
      );
  }
  const desiredViewNames = new Set(config.views.map((view) => view.name));
  for (const view of views.filter((candidate) => !desiredViewNames.has(candidate.name))) {
    drift.push(`unexpected view ${view.name}`);
  }
  return drift;
}

function gitHead() {
  const result = spawnSync("git", ["rev-parse", "HEAD"], {
    cwd: projectRoot,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(result.stderr.trim() || "git rev-parse HEAD failed");
  return result.stdout.trim();
}

export class RoadmapClient {
  constructor(
    config,
    api = new GitHubApiClient(
      createGitHubRunner({
        cwd: projectRoot,
        command: process.env.PORTCOVE_ROADMAP_GH || "gh",
      }),
    ),
  ) {
    this.config = config;
    this.api = typeof api === "function" ? new GitHubApiClient(api) : api;
    this.graphqlRate = null;
  }

  operationalSnapshot({ now, runnerFactory = createGitHubRunner } = {}) {
    const api = {
      request(method, endpoint, body, { timeoutMs }) {
        const client = new GitHubApiClient(
          runnerFactory({
            cwd: projectRoot,
            command: process.env.PORTCOVE_ROADMAP_GH || "gh",
            maxBuffer: coordinationReadLimits.responseBytes,
            timeoutMs,
          }),
        );
        return client.request(method, endpoint, body);
      },
    };
    return readOperationalBoard(this.config, api, { now });
  }

  gh(args, input) {
    return this.api.command(args, input);
  }

  json(args, input) {
    const output = this.gh(args, input);
    return output ? JSON.parse(output) : null;
  }

  graphql(query, variables = {}) {
    try {
      const result = this.api.graphql(query, variables);
      if (result.rateLimit.remaining !== null || result.rateLimit.used !== null)
        this.graphqlRate = result.rateLimit;
      return result.data;
    } catch (error) {
      if (error?.rateLimit) this.graphqlRate = error.rateLimit;
      throw error;
    }
  }

  sampleGraphqlRate() {
    const rate = this.graphql(
      "query { rateLimit { cost limit remaining resetAt used } }",
    )?.rateLimit;
    if (
      !Number.isSafeInteger(rate?.remaining) ||
      !Number.isSafeInteger(rate?.used) ||
      typeof rate?.resetAt !== "string"
    ) {
      throw new Error("GitHub GraphQL rate-limit metadata is unavailable");
    }
    this.graphqlRate = { resource: "graphql", ...rate };
    return this.graphqlRate;
  }

  readInventory(query, variables, connection, identity) {
    const nodes = [];
    const identities = new Set();
    const cursors = new Set();
    let after = null;
    let totalCount;
    for (;;) {
      const page = connection(this.graphql(query, { ...variables, after }));
      if (
        !Array.isArray(page?.nodes) ||
        !Number.isSafeInteger(page.totalCount) ||
        page.totalCount < 0 ||
        typeof page.pageInfo?.hasNextPage !== "boolean" ||
        !(page.pageInfo.endCursor === null || typeof page.pageInfo.endCursor === "string")
      ) {
        throw new Error("incomplete GitHub inventory: malformed connection or pagination");
      }
      totalCount ??= page.totalCount;
      if (totalCount !== page.totalCount)
        throw new Error("GitHub inventory changed during pagination; retry the read");
      for (const node of page.nodes) {
        const key = node && identity(node);
        if (!key || identities.has(key))
          throw new Error("incomplete GitHub inventory: missing or duplicate record identity");
        identities.add(key);
        nodes.push(node);
      }
      if (nodes.length > totalCount)
        throw new Error("incomplete GitHub inventory: record count exceeds total");
      if (!page.pageInfo.hasNextPage) break;
      after = page.pageInfo.endCursor;
      if (!page.nodes.length || !after || cursors.has(after) || nodes.length >= totalCount) {
        throw new Error("incomplete GitHub inventory: pagination did not advance");
      }
      cursors.add(after);
    }
    if (nodes.length !== totalCount)
      throw new Error("incomplete GitHub inventory: record count does not match total");
    return nodes;
  }

  listProjects() {
    return unwrapCollection(
      this.json([
        "project",
        "list",
        "--owner",
        this.config.owner,
        "--format",
        "json",
        "--limit",
        "100",
      ]),
      "projects",
    );
  }

  resolveProject({ create = false } = {}) {
    const matches = this.listProjects().filter(
      (project) => project.title === this.config.project.title && project.closed !== true,
    );
    if (matches.length > 1)
      throw new Error(`multiple open projects named ${this.config.project.title}`);
    if (matches.length === 1) return { project: matches[0], created: false };
    if (!create) throw new Error(`${this.config.project.title} does not exist; run bootstrap`);
    const project = this.json([
      "project",
      "create",
      "--owner",
      this.config.owner,
      "--title",
      this.config.project.title,
      "--format",
      "json",
    ]);
    return { project, created: true };
  }

  projectNumber(project) {
    const number = Number(project?.number ?? this.config.project.number);
    if (!Number.isInteger(number) || number < 1)
      throw new Error("could not determine Project number");
    return number;
  }

  projectDetails(number) {
    return this.json([
      "project",
      "view",
      String(number),
      "--owner",
      this.config.owner,
      "--format",
      "json",
    ]);
  }

  fieldList(number) {
    return this.json([
      "project",
      "field-list",
      String(number),
      "--owner",
      this.config.owner,
      "--format",
      "json",
      "--limit",
      "100",
    ]);
  }

  itemList(
    number,
    { includeDependencies = false, includeBodies = true, details: suppliedDetails = null } = {},
  ) {
    const details = suppliedDetails ?? this.projectDetails(number);
    if (!details?.id)
      throw new Error("incomplete GitHub inventory: Project identity is unavailable");
    const dependencies = includeDependencies
      ? "blockedBy(first: 10) { totalCount nodes { id number title url state } }"
      : "";
    const body = includeBodies ? "body" : "";
    const query = `query($id: ID!, $after: String) { node(id: $id) { ... on ProjectV2 { items(first: 50, after: $after) { totalCount nodes { id content { __typename ... on DraftIssue { title ${body} } ... on Issue { id number title ${body} url state ${dependencies} } ... on PullRequest { number title ${body} url state merged } } fieldValues(first: 25) { totalCount nodes { ... on ProjectV2ItemFieldSingleSelectValue { name field { ... on ProjectV2SingleSelectField { name } } } } pageInfo { hasNextPage endCursor } } } pageInfo { hasNextPage endCursor } } } } }`;
    return this.readInventory(
      query,
      { id: details.id },
      (data) => data?.node?.items,
      (node) => node.id,
    ).map((node) => {
      const content = node.content ? { ...node.content, type: node.content.__typename } : null;
      return {
        ...node,
        title: content?.title,
        type: content?.type,
        content,
        fieldValues: projectFieldValues(node),
      };
    });
  }

  repositoryIssues() {
    const marker = () => {
      const response = this.api.request(
        "GET",
        `repos/${this.config.repository}/issues?state=all&sort=created&direction=desc&per_page=1`,
      );
      if (!Array.isArray(response.body))
        throw new Error("incomplete GitHub inventory: malformed repository issue marker");
      const number = response.body[0]?.number ?? 0;
      if (!Number.isSafeInteger(number) || number < 0)
        throw new Error("incomplete GitHub inventory: invalid repository issue marker");
      return number;
    };
    const highWater = marker();
    const records = this.api.paginateRest(
      `repos/${this.config.repository}/issues?state=all&sort=created&direction=asc&per_page=100`,
      {
        identity: (record) =>
          typeof record?.node_id === "string" && record.node_id ? record.node_id : null,
        label: "repository issue inventory",
      },
    );
    const numbers = new Set();
    for (const record of records) {
      if (!Number.isSafeInteger(record.number) || record.number < 1 || numbers.has(record.number)) {
        throw new Error("incomplete GitHub inventory: missing or duplicate record identity");
      }
      numbers.add(record.number);
    }
    if (marker() !== highWater)
      throw new Error("GitHub inventory changed during pagination; retry the read");
    if (highWater > 0 && !numbers.has(highWater))
      throw new Error("incomplete GitHub inventory: high-water record is missing");
    return records
      .filter((issue) => !issue.pull_request)
      .map((issue) => ({
        ...issue,
        title: issue.title,
        body: issue.body ?? "",
        url: issue.html_url,
        state: String(issue.state ?? "").toUpperCase(),
        type: "Issue",
      }));
  }

  repositoryIssue(number) {
    const issue = this.api.request("GET", `repos/${this.config.repository}/issues/${number}`).body;
    if (!issue?.node_id || !issue?.html_url || issue.pull_request) {
      throw new Error(`repository issue #${number} was not found`);
    }
    return issue;
  }

  executionIssue(number) {
    if (!Number.isSafeInteger(number) || number < 1)
      throw new Error("--issue must be a positive issue number");
    const [owner, name] = this.config.repository.split("/");
    const project = (this._executionProject ??= this.projectDetails(this.config.project.number));
    if (!project?.id) throw new Error("selected Project identity is unavailable");
    const fields =
      "id fieldValues(first:25){totalCount nodes{...on ProjectV2ItemFieldSingleSelectValue{name field{...on ProjectV2SingleSelectField{name}}}} pageInfo{hasNextPage endCursor}}";
    const projectItems = `projectItems(first:100){totalCount nodes{${fields} project{id}} pageInfo{hasNextPage endCursor}}`;
    const identity = "id number title url state";
    const query = `query($owner:String!,$name:String!,$number:Int!){repository(owner:$owner,name:$name){issue(number:$number){${identity} body ${projectItems} parent{${identity}} blockedBy(first:100){totalCount nodes{${identity} body ${projectItems}} pageInfo{hasNextPage endCursor}} blocking(first:100){totalCount nodes{${identity}} pageInfo{hasNextPage endCursor}} subIssues(first:100){totalCount nodes{${identity}} pageInfo{hasNextPage endCursor}}}}}`;
    const issue = this.graphql(query, { owner, name, number })?.repository?.issue;
    if (
      !issue?.id ||
      issue.number !== number ||
      issue.url !== `https://github.com/${this.config.repository}/issues/${number}`
    )
      throw new Error("selected issue identity is unavailable or mismatched");
    const connection = (initial, field, selection, source = issue) => {
      if (
        !Number.isSafeInteger(initial?.totalCount) ||
        initial.totalCount < 0 ||
        !Array.isArray(initial.nodes) ||
        typeof initial.pageInfo?.hasNextPage !== "boolean" ||
        initial.nodes.some((node) => !node?.id)
      )
        throw new Error(`incomplete selected ${field} connection`);
      if (
        initial?.pageInfo?.hasNextPage === false &&
        Array.isArray(initial.nodes) &&
        initial.nodes.length === initial.totalCount &&
        new Set(initial.nodes.map((node) => node.id)).size === initial.totalCount
      )
        return initial.nodes;
      const nodes = this.readInventory(
        `query($id:ID!,$after:String){node(id:$id){...on Issue{${field}(first:100,after:$after){totalCount nodes{${selection}} pageInfo{hasNextPage endCursor}}}}}`,
        { id: source.id },
        (data) => data?.node?.[field],
        (node) => node.id,
      );
      if (nodes.length !== initial?.totalCount)
        throw new Error("selected relationships changed during collection");
      return nodes;
    };
    const projectItem = (source) => {
      const records = connection(
        source.projectItems,
        "projectItems",
        `${fields} project{id}`,
        source,
      );
      const matches = records.filter((node) => node.project?.id === project.id);
      if (matches.length > 1) throw new Error("multiple selected-Project items for one issue");
      return matches[0] ? { ...matches[0], fieldValues: projectFieldValues(matches[0]) } : null;
    };
    const selected = projectItem(issue);
    if (!selected) throw new Error("selected issue is not in the configured active Project");
    const blockedBy = connection(
      issue.blockedBy,
      "blockedBy",
      `${identity} body ${projectItems}`,
    ).map((node) => ({ ...node, projectStatus: fieldValue(projectItem(node), "Status") ?? null }));
    return {
      item: { ...selected, title: issue.title, content: { ...issue, type: "Issue" } },
      relationships: {
        blockedBy,
        blocking: connection(issue.blocking, "blocking", identity),
        parent: issue.parent,
        subIssues: connection(issue.subIssues, "subIssues", identity),
      },
    };
  }

  coordinationBinding(target) {
    validateCoordinationTarget(target, {
      repository: this.config.repository,
      issue: { number: target.work_issue },
    });
    const node = this.api.request(
      "GET",
      `repos/${this.config.repository}/issues/${target.number}`,
    ).body;
    if (
      node?.number !== target.number ||
      node.html_url !== target.url ||
      Boolean(node.pull_request) !== (target.kind === "pull_request") ||
      !Number.isSafeInteger(node.comments) ||
      node.comments < 0
    )
      throw new Error("coordination issue/PR identity is unavailable or mismatched");
    if (target.kind === "pull_request") {
      const linked = [...String(node.body ?? "").matchAll(/(?:^|[\s(,])#(\d+)\b/g)].some(
        (match) => Number(match[1]) === target.work_issue,
      );
      const link = `https://github.com/${this.config.repository}/issues/${target.work_issue}`;
      const linkedUrl = String(node.body ?? "")
        .split(link)
        .slice(1)
        .some((suffix) => suffix === "" || /^[\s)\]>"'`#?]/.test(suffix));
      if (!linked && !linkedUrl)
        throw new Error("explicit coordination PR does not reference the selected work issue");
    }
    return node;
  }

  coordinationRecords(target) {
    const before = this.coordinationBinding(target).comments;
    const [owner, name] = this.config.repository.split("/");
    const field = target.kind === "pull_request" ? "pullRequest" : "issue";
    const observed = this.graphql(
      `query($owner:String!,$name:String!,$number:Int!){repository(owner:$owner,name:$name){${field}(number:$number){url comments(last:50){totalCount nodes{id url body createdAt updatedAt author{login}} pageInfo{hasPreviousPage startCursor}}}}}`,
      { owner, name, number: target.number },
    )?.repository?.[field];
    const result = observed?.comments;
    if (
      observed?.url !== target.url ||
      !Array.isArray(result?.nodes) ||
      !Number.isSafeInteger(result.totalCount) ||
      result.totalCount < 0 ||
      result.nodes.length !== Math.min(50, result.totalCount) ||
      result.nodes.some(
        (node) =>
          !node?.id ||
          typeof node.body !== "string" ||
          !node.url?.startsWith(`${target.url}#issuecomment-`) ||
          !/^[1-9]\d*$/.test(node.url.slice(`${target.url}#issuecomment-`.length)) ||
          !Number.isFinite(Date.parse(node.createdAt)) ||
          !Number.isFinite(Date.parse(node.updatedAt)),
      ) ||
      new Set(result.nodes.map((node) => node.id)).size !== result.nodes.length ||
      new Set(result.nodes.map((node) => node.url)).size !== result.nodes.length ||
      result.nodes.some(
        (node, index) =>
          index > 0 && Date.parse(node.createdAt) < Date.parse(result.nodes[index - 1].createdAt),
      ) ||
      result.pageInfo?.hasPreviousPage !== result.totalCount > 50 ||
      result.totalCount !== before ||
      this.coordinationBinding(target).comments !== before
    )
      throw new Error("coordination read is unavailable or incomplete");
    return {
      nodes: result.nodes,
      coverage: {
        complete: !result.pageInfo.hasPreviousPage,
        count: result.nodes.length,
        total: result.totalCount,
        meaning: "Bounded recent window; absence remains unknown when older records exist.",
      },
    };
  }

  operationalReturnEvidence(reference, issue, source, { runnerFactory = createGitHubRunner } = {}) {
    const api = {
      request(method, endpoint, body, { timeoutMs }) {
        return new GitHubApiClient(
          runnerFactory({
            cwd: projectRoot,
            command: process.env.PORTCOVE_ROADMAP_GH || "gh",
            timeoutMs,
            maxBuffer: coordinationReadLimits.responseBytes,
          }),
        ).request(method, endpoint, body);
      },
    };
    return readOperationalReturnEvidence(this.config, api, reference, issue, source);
  }

  coordinationComment(url, target) {
    const match =
      /^https:\/\/github\.com\/([^/]+\/[^/]+)\/(issues|pull)\/(\d+)#issuecomment-(\d+)$/.exec(url);
    if (
      !match ||
      match[1] !== this.config.repository ||
      !(
        (match[2] === "issues" && Number(match[3]) === legacyCoordinationIssue) ||
        url.startsWith(`${target?.url}#issuecomment-`)
      )
    )
      throw new Error(
        "coordination reference must belong to this repository's selected issue/PR or legacy #793",
      );
    const comment = this.api.request(
      "GET",
      `repos/${this.config.repository}/issues/comments/${match[4]}`,
    ).body;
    if (
      comment?.html_url !== url ||
      comment.issue_url !==
        `https://api.github.com/repos/${this.config.repository}/issues/${match[3]}`
    )
      throw new Error("coordination comment identity is mismatched");
    return { ...comment, url: comment.html_url, author: comment.user };
  }

  projectContext(number = this.config.project.number) {
    if (this._projectContext?.number === number) return this._projectContext;
    const details = this.projectDetails(number);
    const fields = unwrapCollection(this.fieldList(number), "fields");
    this._projectContext = { number, details, fields };
    return this._projectContext;
  }

  ownerType() {
    if (this._ownerType) return this._ownerType;
    const owner = this.api.request("GET", `users/${this.config.owner}`).body;
    if (!["User", "Organization"].includes(owner?.type))
      throw new Error(`GitHub owner type is unavailable for ${this.config.owner}`);
    this._ownerType = owner.type;
    return this._ownerType;
  }

  completeProjectContext(number = this.config.project.number) {
    if (this._completeProjectContext?.number === number) return this._completeProjectContext;
    const root = this.ownerType() === "Organization" ? "organization" : "user";
    const query = `query($login: String!, $number: Int!, $after: String) { ${root}(login: $login) { projectV2(number: $number) { id number title url public closed shortDescription readme fields(first: 100, after: $after) { totalCount nodes { __typename ... on ProjectV2Field { id name dataType } ... on ProjectV2SingleSelectField { id name dataType options { id name color description } } ... on ProjectV2IterationField { id name dataType } } pageInfo { hasNextPage endCursor } } } } }`;
    const fields = [];
    const identities = new Set();
    const cursors = new Set();
    let after = null;
    let totalCount = null;
    let details = null;
    for (;;) {
      const project = this.graphql(query, {
        login: this.config.owner,
        number,
        after,
      })?.[root]?.projectV2;
      if (!project?.id)
        throw new Error(`Project #${number} was not found for ${this.config.owner}`);
      details ??= {
        id: project.id,
        number: project.number,
        title: project.title,
        url: project.url,
        public: project.public,
        closed: project.closed,
        shortDescription: project.shortDescription,
        readme: project.readme,
      };
      const connection = project.fields;
      if (
        !Array.isArray(connection?.nodes) ||
        !Number.isSafeInteger(connection.totalCount) ||
        connection.totalCount < 0 ||
        typeof connection.pageInfo?.hasNextPage !== "boolean" ||
        !(
          connection.pageInfo.endCursor === null ||
          typeof connection.pageInfo.endCursor === "string"
        )
      ) {
        throw new Error("incomplete GitHub inventory: malformed Project field connection");
      }
      totalCount ??= connection.totalCount;
      if (connection.totalCount !== totalCount)
        throw new Error("GitHub Project fields changed during pagination; retry the read");
      for (const field of connection.nodes) {
        if (!field?.id || identities.has(field.id))
          throw new Error("incomplete GitHub inventory: missing or duplicate Project field");
        identities.add(field.id);
        fields.push(field);
      }
      if (!connection.pageInfo.hasNextPage) break;
      after = connection.pageInfo.endCursor;
      if (!connection.nodes.length || !after || cursors.has(after) || fields.length >= totalCount)
        throw new Error("incomplete GitHub inventory: Project field pagination did not advance");
      cursors.add(after);
    }
    if (fields.length !== totalCount)
      throw new Error("incomplete GitHub inventory: Project field count does not match total");
    this._completeProjectContext = { number, details, fields };
    return this._completeProjectContext;
  }

  ensureIssueItem(contentId) {
    const { details } = this.projectContext();
    const find = () => {
      let after = null;
      do {
        const query = `query($id: ID!, $after: String) { node(id: $id) { ... on Issue { projectItems(first: 100, after: $after) { nodes { id project { id } } pageInfo { hasNextPage endCursor } } } } }`;
        const page = this.graphql(query, { id: contentId, after })?.node?.projectItems;
        const match = page?.nodes?.find((item) => item.project?.id === details.id);
        if (match) return match;
        after = page?.pageInfo?.hasNextPage ? page.pageInfo.endCursor : null;
      } while (after);
      return null;
    };
    const existing = find();
    if (existing) return existing;
    const mutation = `mutation($input: AddProjectV2ItemByIdInput!) { addProjectV2ItemById(input: $input) { item { id } } }`;
    try {
      return this.graphql(mutation, {
        input: { projectId: details.id, contentId },
      })?.addProjectV2ItemById?.item;
    } catch (error) {
      if (!/already|exists/i.test(error.message)) throw error;
      const raced = find();
      if (raced) return raced;
      throw error;
    }
  }

  viewList(projectId) {
    const fields = `totalCount nodes { ... on ProjectV2Field { id name } ... on ProjectV2SingleSelectField { id name } ... on ProjectV2IterationField { id name } ... on ProjectV2MultiSelectField { id name } } pageInfo { hasNextPage endCursor }`;
    const query = `query($id: ID!, $after: String) { node(id: $id) { ... on ProjectV2 { id views(first: 100, after: $after) { totalCount nodes { id name number layout filter fields(first: 100) { ${fields} } groupByFields(first: 100) { ${fields} } verticalGroupByFields(first: 100) { ${fields} } sortByFields(first: 100) { totalCount nodes { direction field { ... on ProjectV2Field { id name } ... on ProjectV2SingleSelectField { id name } ... on ProjectV2IterationField { id name } } } pageInfo { hasNextPage endCursor } } } pageInfo { hasNextPage endCursor } } } } }`;
    const views = this.readInventory(
      query,
      { id: projectId },
      (data) => {
        if (data?.node?.id !== projectId)
          throw new Error("incomplete GitHub inventory: wrong Project view identity");
        return data.node.views;
      },
      (view) => view.id,
    );
    for (const view of views) {
      for (const name of ["fields", "groupByFields", "verticalGroupByFields", "sortByFields"]) {
        const connection = view[name];
        if (
          !Number.isSafeInteger(connection?.totalCount) ||
          connection.totalCount < 0 ||
          !Array.isArray(connection.nodes) ||
          connection.nodes.length !== connection.totalCount ||
          connection.pageInfo?.hasNextPage !== false
        ) {
          throw new Error(`incomplete GitHub inventory: view ${view.name} ${name}`);
        }
        const ids = connection.nodes.map((field) =>
          name === "sortByFields" ? field.field?.id : field.id,
        );
        if (ids.some((id) => !id) || new Set(ids).size !== ids.length)
          throw new Error(`incomplete GitHub inventory: view ${view.name} ${name} identities`);
      }
    }
    return views;
  }

  projectAudit(projectId) {
    const query = `query($id: ID!) { node(id: $id) { ... on ProjectV2 { id number title public repositories(first: 100) { nodes { name owner { login } } } } } }`;
    return this.graphql(query, { id: projectId })?.node;
  }

  editProject(number) {
    this.gh([
      "project",
      "edit",
      String(number),
      "--owner",
      this.config.owner,
      "--title",
      this.config.project.title,
      "--description",
      this.config.project.description,
      "--readme",
      this.config.project.readme,
      "--visibility",
      this.config.project.visibility,
    ]);
  }

  updateField(fieldId, options) {
    const query = `mutation($input: UpdateProjectV2FieldInput!) { updateProjectV2Field(input: $input) { projectV2Field { ... on ProjectV2SingleSelectField { id name options { id name } } } } }`;
    const singleSelectOptions = options.map((option) => ({
      ...(option.id ? { id: option.id } : {}),
      name: option.name,
      color: option.color ?? "GRAY",
      description: option.description ?? "",
    }));
    this.graphql(query, { input: { fieldId, singleSelectOptions } });
  }

  reconcileFields(number, { freshProject = false } = {}) {
    const plan = planFieldReconciliation(this.config.fields, this.fieldList(number), {
      freshProject,
    });
    for (const step of plan) {
      if (step.action === "error") throw new Error(step.reason);
      if (step.action === "create") {
        this.gh([
          "project",
          "field-create",
          String(number),
          "--owner",
          this.config.owner,
          "--name",
          step.desired.name,
          "--data-type",
          "SINGLE_SELECT",
          "--single-select-options",
          step.desired.options.join(","),
        ]);
      } else if (step.action === "update") {
        this.updateField(step.actual.id, step.options);
      }
    }
    return plan;
  }

  reconcileViews(projectId, fieldResult) {
    const fields = unwrapCollection(fieldResult, "fields");
    const fieldIds = new Map(fields.map((field) => [field.name, field.id]));
    const plan = planViewReconciliation(materializeViews(this.config), this.viewList(projectId));
    for (const step of plan) {
      if (step.drift?.some((value) => value.includes("UI change required")))
        throw new Error(
          `view ${step.desired.name} needs a grouping/sorting change through the owner UI`,
        );
      for (const name of step.desired.fields) {
        if (!fieldIds.has(name))
          throw new Error(`view ${step.desired.name} references missing field ${name}`);
      }
    }
    for (const step of plan) {
      const visibleFieldIds = step.desired.fields.map((name) => {
        const id = fieldIds.get(name);
        if (!id) throw new Error(`view ${step.desired.name} references missing field ${name}`);
        return id;
      });
      if (step.action === "keep") {
        continue;
      } else if (step.action === "create") {
        const query = `mutation($input: CreateProjectV2ViewInput!) { createProjectV2View(input: $input) { projectV2View { id name } } }`;
        this.graphql(query, {
          input: {
            projectId,
            name: step.desired.name,
            layout: step.desired.layout,
            configuration: { visibleFieldIds },
          },
        });
        const created = this.viewList(projectId).find((view) => view.name === step.desired.name);
        if (!created) throw new Error(`view ${step.desired.name} was not created`);
        const update = `mutation($input: UpdateProjectV2ViewInput!) { updateProjectV2View(input: $input) { projectV2View { id name filter } } }`;
        this.graphql(update, {
          input: { viewId: created.id, filter: step.desired.filter },
        });
      } else {
        if (step.drift.some((value) => value.includes("UI change required")))
          throw new Error(
            `view ${step.desired.name} needs a grouping/sorting change through the owner UI`,
          );
        const query = `mutation($input: UpdateProjectV2ViewInput!) { updateProjectV2View(input: $input) { projectV2View { id name filter } } }`;
        this.graphql(query, {
          input: {
            viewId: step.actual.id,
            name: step.desired.name,
            layout: step.desired.layout,
            filter: step.desired.filter,
            configuration: { visibleFieldIds },
          },
        });
      }
    }
    const saved = this.viewList(projectId);
    const remaining = planViewReconciliation(materializeViews(this.config), saved);
    const failed = remaining.filter((step) => step.action !== "keep");
    if (failed.length) {
      throw new Error(
        `view readback did not match configuration: ${failed.map((step) => `${step.desired.name}: ${step.drift?.join("; ") ?? step.action}`).join(", ")}`,
      );
    }
    for (const step of plan.filter((candidate) => candidate.actual)) {
      if (saved.find((view) => view.name === step.desired.name)?.id !== step.actual.id)
        throw new Error(`view readback changed identity: ${step.desired.name}`);
    }
    return plan;
  }

  removeFreshDefaultView(projectId, created) {
    if (!created) return false;
    const desiredNames = new Set(this.config.views.map((view) => view.name));
    const defaultView = this.viewList(projectId).find(
      (view) =>
        view.number === 1 && view.name === "View 1" && !view.filter && !desiredNames.has(view.name),
    );
    if (!defaultView) return false;
    const query = `mutation($input: DeleteProjectV2ViewInput!) { deleteProjectV2View(input: $input) { projectV2View { id } } }`;
    this.graphql(query, { input: { viewId: defaultView.id } });
    return true;
  }

  bootstrap() {
    const { project, created } = this.resolveProject({ create: true });
    const number = this.projectNumber(project);
    this.editProject(number);
    try {
      this.gh([
        "project",
        "link",
        String(number),
        "--owner",
        this.config.owner,
        "--repo",
        this.config.repository,
      ]);
    } catch (error) {
      if (!/already|exists|linked/i.test(error.message)) throw error;
    }
    const fieldPlan = this.reconcileFields(number, { freshProject: created });
    const details = this.projectDetails(number);
    const fields = this.fieldList(number);
    const viewPlan = this.reconcileViews(details.id ?? project.id, fields);
    const removedDefaultView = this.removeFreshDefaultView(details.id ?? project.id, created);
    return {
      number,
      url:
        details.url ??
        project.url ??
        `https://github.com/users/${this.config.owner}/projects/${number}`,
      created,
      fieldPlan,
      viewPlan,
      removedDefaultView,
    };
  }

  setFields(reference, values) {
    const number = this.config.project.number;
    if (number < 1) throw new Error("project number is not recorded in .github/roadmap.json");
    const repositoryUrl = `https://github.com/${this.config.repository}/issues/`;
    if (!/^#?\d+$/u.test(reference) && !reference.startsWith(repositoryUrl)) {
      this.setItemFields(reference, values);
      return;
    }
    const context = this.completeProjectContext(number);
    const items = this.itemList(number, { details: context.details });
    const item = this.resolveItemReference(items, reference);
    const changes = Object.entries(values).map(([fieldName, to]) => ({
      target: reference,
      itemId: item.id,
      fieldName,
      to,
      from: fieldValue(item, fieldName) ?? null,
    }));
    this.mutateFieldInputs(
      changes.map((change) =>
        this.fieldMutationInput(context, item.id, change.fieldName, change.to),
      ),
    );
    const verification = this.verifySetMany({
      context,
      pending: changes,
      alreadyApplied: [],
    });
    const mismatches = verification.filter((result) => !result.verified);
    if (mismatches.length)
      throw new Error(
        `set readback mismatch: ${mismatches
          .map((result) => `${result.fieldName}=${JSON.stringify(result.observed)}`)
          .join(", ")}`,
      );
  }

  resolveItemReference(items, reference) {
    const repositoryUrl = `https://github.com/${this.config.repository}/issues/`;
    const numeric = /^#?(\d+)$/u.exec(reference);
    const urlMatch = reference.startsWith(repositoryUrl)
      ? /^(\d+)$/u.exec(reference.slice(repositoryUrl.length))
      : null;
    const issueNumber = Number(numeric?.[1] ?? urlMatch?.[1]);
    const matches = items.filter((item) =>
      Number.isSafeInteger(issueNumber) && issueNumber > 0
        ? item.content?.number === issueNumber
        : item.id === reference,
    );
    if (matches.length !== 1)
      throw new Error(
        matches.length
          ? `Project item reference is ambiguous: ${reference}`
          : `Project item was not found: ${reference}`,
      );
    return matches[0];
  }

  setItemFields(itemId, values) {
    const context = this.projectContext();
    const inputs = [];
    for (const [fieldName, value] of Object.entries(values)) {
      inputs.push(this.fieldMutationInput(context, itemId, fieldName, value));
    }
    this.mutateFieldInputs(inputs);
  }

  fieldMutationInput({ details, fields }, itemId, fieldName, value) {
    const field = fields.find((candidate) => candidate.name === fieldName);
    if (!field) throw new Error(`Project field not found: ${fieldName}`);
    const option = field.options?.find((candidate) => candidate.name === value);
    if (!option) throw new Error(`Project option not found: ${fieldName}=${value}`);
    return {
      projectId: details.id,
      itemId,
      fieldId: field.id,
      value: { singleSelectOptionId: option.id },
    };
  }

  mutateFieldInputs(inputs) {
    if (!inputs.length) return;
    const variables = Object.fromEntries(inputs.map((input, index) => [`input${index}`, input]));
    const declarations = inputs
      .map((_, index) => `$input${index}: UpdateProjectV2ItemFieldValueInput!`)
      .join(", ");
    const selections = inputs
      .map(
        (_, index) =>
          `f${index}: updateProjectV2ItemFieldValue(input: $input${index}) { projectV2Item { id } }`,
      )
      .join(" ");
    this.graphql(`mutation(${declarations}) { ${selections} }`, variables);
  }

  planSetMany(spec) {
    const validated = validateSetManySpec(this.config, spec);
    const context = this.completeProjectContext();
    const items = this.itemList(context.number, {
      includeDependencies: true,
      details: context.details,
    });
    const pending = [];
    const alreadyApplied = [];
    const itemFields = new Set();
    for (const update of validated.updates) {
      const item = this.resolveItemReference(items, update.target);
      for (const [fieldName, transition] of Object.entries(update.fields)) {
        const key = `${item.id}\0${fieldName}`;
        if (itemFields.has(key))
          throw new Error(`duplicate set-many item field: ${update.target} ${fieldName}`);
        itemFields.add(key);
        const observed = fieldValue(item, fieldName) ?? null;
        const planned = {
          target: update.target,
          itemId: item.id,
          fieldName,
          observed,
          ...transition,
        };
        if (observed === transition.to) alreadyApplied.push(planned);
        else if (observed === transition.from) pending.push(planned);
        else {
          throw new Error(
            `${update.target} ${fieldName} is ${JSON.stringify(observed)}, expected ` +
              `${JSON.stringify(transition.from)} or already-applied ${JSON.stringify(transition.to)}`,
          );
        }
      }
    }
    return { context, pending, alreadyApplied, assignments: validated.assignments };
  }

  applySetMany(plan, changes = plan.pending) {
    const inputs = changes.map((change) =>
      this.fieldMutationInput(plan.context, change.itemId, change.fieldName, change.to),
    );
    this.mutateFieldInputs(inputs);
  }

  readSetManyItems(plan) {
    const ids = [
      ...new Set([...plan.pending, ...plan.alreadyApplied].map((change) => change.itemId)),
    ];
    if (!ids.length) return new Map();
    const query = `query($ids: [ID!]!) { nodes(ids: $ids) { ... on ProjectV2Item { id fieldValues(first: 100) { totalCount nodes { ... on ProjectV2ItemFieldSingleSelectValue { name field { ... on ProjectV2SingleSelectField { name } } } } pageInfo { hasNextPage endCursor } } } } }`;
    const nodes = this.graphql(query, { ids })?.nodes;
    if (!Array.isArray(nodes) || nodes.length !== ids.length)
      throw new Error("incomplete GitHub inventory: set-many readback item count differs");
    const results = new Map();
    for (const node of nodes) {
      if (
        !node?.id ||
        results.has(node.id) ||
        !Number.isSafeInteger(node.fieldValues?.totalCount) ||
        node.fieldValues.totalCount < 0 ||
        !Array.isArray(node.fieldValues.nodes) ||
        node.fieldValues.nodes.length !== node.fieldValues.totalCount ||
        node.fieldValues.pageInfo?.hasNextPage !== false
      ) {
        throw new Error("incomplete GitHub inventory: malformed or truncated set-many readback");
      }
      const fieldValues = node.fieldValues.nodes
        .map((value) => ({ name: value.name, field: { name: value.field?.name } }))
        .filter((value) => value.name && value.field.name);
      results.set(node.id, fieldValues);
    }
    for (const id of ids) {
      if (!results.has(id))
        throw new Error(`incomplete GitHub inventory: set-many readback omitted ${id}`);
    }
    return results;
  }

  verifySetMany(plan) {
    const items = this.readSetManyItems(plan);
    return [...plan.pending, ...plan.alreadyApplied].map((change) => {
      const observed =
        fieldValue({ fieldValues: items.get(change.itemId) }, change.fieldName) ?? null;
      return { ...change, observed, verified: observed === change.to };
    });
  }

  capture({ title, body, fields }) {
    const number = this.config.project.number;
    const item = this.json([
      "project",
      "item-create",
      String(number),
      "--owner",
      this.config.owner,
      "--title",
      title,
      "--body",
      body,
      "--format",
      "json",
    ]);
    this.setFields(item.id, fields);
    return item;
  }

  createPortIssue({ title, upstream, catalogId, portKey }) {
    const issueTitle = `[Port] ${title}`;
    const issues = this.repositoryIssues();
    const duplicates = findPortIssueDuplicates(issues, {
      title,
      upstream,
      catalogId,
      portKey,
    });
    if (duplicates.length) {
      throw new Error(
        `port already has a durable issue: ${duplicates
          .map((match) => `${itemUrl(match.issue)} (${match.reasons.join(", ")})`)
          .join("; ")}`,
      );
    }
    const body = renderPortIssueBody({ title, upstream, catalogId, portKey });
    const issue = this.api.request("POST", `repos/${this.config.repository}/issues`, {
      title: issueTitle,
      body,
    }).body;
    if (!issue?.node_id || !issue?.html_url)
      throw new Error("GitHub did not return the created issue identity");
    const item = this.ensureIssueItem(issue.node_id);
    this.setItemFields(item.id, {
      ...neutralPortFields,
    });
    return { ...issue, itemId: item.id };
  }

  normalizePortIssue({ number, catalog }) {
    const issue = this.repositoryIssue(number);
    if (!canonicalPortTitlePrefix.test(issue.title ?? "")) {
      throw new Error(`issue #${number} title must begin with the canonical [Port] prefix`);
    }
    const form = parsePortIssueForm(issue.body);
    const ids = portCatalogMarkers(issue.body);
    if (ids.length > 1) throw new Error(`issue #${number} claims multiple catalog IDs`);
    const catalogId = ids[0] ?? null;
    if (catalogId && !(catalog?.ports ?? []).some((port) => port.id === catalogId)) {
      throw new Error(`issue #${number} claims unknown catalog ID ${catalogId}`);
    }
    const repositoryIssues = this.repositoryIssues();
    const duplicates = findPortIssueDuplicates(
      repositoryIssues.filter((candidate) => issueNumber(candidate) !== number),
      {
        title: issue.title.replace(portTitlePrefix, ""),
        upstream: form.upstream,
        catalogId,
        portKey: form.portKey,
      },
    );
    if (duplicates.length) {
      throw new Error(
        `port already has a durable issue: ${duplicates
          .map((match) => `${itemUrl(match.issue)} (${match.reasons.join(", ")})`)
          .join("; ")}`,
      );
    }

    const existingItems = this.itemList(this.config.project.number).filter(
      (item) =>
        issueNumber(item) === number &&
        String(itemUrl(item) ?? "").toLowerCase() === String(issue.html_url).toLowerCase(),
    );
    if (existingItems.length > 1) {
      throw new Error(
        `issue #${number} has multiple Project items; remove the duplicate before normalization`,
      );
    }
    const body = reconcilePortIssueMarkers(issue.body, {
      upstream: form.upstream,
      catalogId,
      portKey: form.portKey,
    });
    const bodyChanged = body !== issue.body;
    const existingItem = existingItems[0] ?? null;
    const fieldUpdates = portFieldInitialization(existingItem);

    if (bodyChanged) {
      this.api.request("PATCH", `repos/${this.config.repository}/issues/${number}`, { body });
    }
    const item = existingItem ?? this.ensureIssueItem(issue.node_id);
    if (Object.keys(fieldUpdates).length) this.setItemFields(item.id, fieldUpdates);
    return {
      issue: issue.html_url,
      bodyChanged,
      projectItemAdded: !existingItem,
      fieldsChanged: Object.keys(fieldUpdates),
      itemId: item.id,
    };
  }

  promote(itemId, durableBody) {
    validateDurableIssueBody(durableBody);
    const repository = this.graphql(
      `query($owner: String!, $name: String!) { repository(owner: $owner, name: $name) { id } }`,
      {
        owner: this.config.repository.split("/")[0],
        name: this.config.repository.split("/")[1],
      },
    )?.repository;
    if (!repository?.id) throw new Error("repository was not found");
    const query = `mutation($input: ConvertProjectV2DraftIssueItemToIssueInput!) { convertProjectV2DraftIssueItemToIssue(input: $input) { item { id content { ... on Issue { number title url } } } } }`;
    const item = this.graphql(query, {
      input: { itemId, repositoryId: repository.id },
    })?.convertProjectV2DraftIssueItemToIssue?.item;
    if (!item?.content?.url) throw new Error("draft conversion did not return an issue URL");
    this.gh(["issue", "edit", item.content.url, "--body-file", "-"], durableBody);
    return item;
  }

  moveBefore(itemReference, beforeReference) {
    const details = this.projectDetails(this.config.project.number);
    const items = this.itemList(this.config.project.number);
    const matches = (item, reference) =>
      item.id === reference ||
      itemUrl(item) === reference ||
      itemTitle(item) === reference ||
      String(item?.content?.number ?? "") === reference.replace(/^#/, "");
    const resolve = (reference) => {
      const found = items.filter((item) => matches(item, reference));
      if (found.length > 1) throw new Error(`move reference is ambiguous: ${reference}`);
      return found[0];
    };
    const moving = resolve(itemReference);
    const before = resolve(beforeReference);
    if (!moving || !before) throw new Error("move could not resolve both items");
    const remaining = items.filter((item) => item.id !== moving.id);
    const beforeIndex = remaining.findIndex((item) => item.id === before.id);
    const afterId = beforeIndex <= 0 ? null : remaining[beforeIndex - 1].id;
    const query = `mutation($input: UpdateProjectV2ItemPositionInput!) { updateProjectV2ItemPosition(input: $input) { items(first: 1) { totalCount } } }`;
    this.graphql(query, {
      input: { projectId: details.id, itemId: moving.id, afterId },
    });
  }
}

async function loadConfig({ requireProjectNumber = false } = {}) {
  const config = JSON.parse(await readFile(configPath, "utf8"));
  return validateConfig(config, { requireProjectNumber });
}

async function offlineCheck() {
  const config = await loadConfig({ requireProjectNumber: true });
  const forbiddenLedger = path.join(projectRoot, "docs", "project", "ledger.json");
  try {
    await access(forbiddenLedger);
    throw new Error("docs/project/ledger.json must not exist");
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  const archives = [
    [
      "docs/archive/2026-09-04-supported-source-provenance-implementation-plan.md",
      /Appendix A supersedes Workstream 1/i,
    ],
    [
      "docs/archive/2026-09-04-ux-copy-content-interaction-audit.md",
      /supersedes the earlier Portcove wording audit/i,
    ],
    [
      "docs/archive/2026-09-03-prelaunch-feature-implementation-plan.md",
      /Appendix A supersedes (?:its |the )?Workstream 1/i,
    ],
  ];
  for (const [relative, requiredText] of archives) {
    const archiveText = await readFile(path.join(projectRoot, relative), "utf8");
    if (
      !/historical (?:implementation-planning|audit|planning) evidence/i.test(archiveText) ||
      !/not (?:a |the )?(?:live )?(?:roadmap|priority|status) authority/i.test(archiveText) ||
      !requiredText.test(archiveText)
    ) {
      throw new Error(relative + " lacks its required historical/supersession banner");
    }
  }
  const currentDocs = await Promise.all(
    [
      "README.md",
      "AGENTS.md",
      "CONTRIBUTING.md",
      "docs/CATALOG.md",
      "docs/ROADMAP.md",
      "docs/PROJECT-GOVERNANCE.md",
      "docs/RELEASING.md",
    ].map(async (relative) => [relative, await readFile(path.join(projectRoot, relative), "utf8")]),
  );
  for (const [relative, text] of currentDocs) {
    if (/\b(?:current|all)\s+\d+-port\b/i.test(text) || /\bcurrent\s+\d+\s+ports\b/i.test(text)) {
      throw new Error(`${relative} hardcodes a live catalog count`);
    }
  }
  console.log(
    `Roadmap configuration is valid for ${config.owner}/${config.project.number}; no volatile item data is stored.`,
  );
}

export function manualUiChecklist(config) {
  const lines = materializeViews(config).map(
    (view, index) =>
      `${index + 1}. ${view.name}: group by ${view.manual_group_by ?? "nothing"}; sort by ${view.manual_sort_by}.`,
  );
  lines.push(
    `${lines.length + 1}. Confirm the repository auto-add workflow targets ${config.repository}.`,
  );
  lines.push(
    `${lines.length + 1}. Confirm item-closed and pull-request-merged completion workflows are enabled with the intended Status behavior.`,
  );
  return lines;
}

function configuredValue(config, fieldName, value, flag) {
  const field = config.fields.find((candidate) => candidate.name === fieldName);
  if (!field?.options.includes(value))
    throw new Error(`${value} is not a valid ${fieldName} option for ${flag}`);
  return value;
}

export function featureIntakeFields(config, options = {}) {
  const fields = {
    Status: "Inbox",
    Priority: configuredValue(config, "Priority", options["--priority"] ?? "None", "--priority"),
    Horizon: configuredValue(config, "Horizon", options["--horizon"] ?? "Someday", "--horizon"),
    "Target release": configuredValue(
      config,
      "Target release",
      options["--release"] ?? "Unscheduled",
      "--release",
    ),
    "Work type": "Product feature",
    Effort: "Unknown",
  };
  if (options["--commitment"]) {
    fields["Release commitment"] = configuredValue(
      config,
      "Release commitment",
      options["--commitment"],
      "--commitment",
    );
  }
  if (options["--workstream"])
    fields.Workstream = configuredValue(
      config,
      "Workstream",
      options["--workstream"],
      "--workstream",
    );
  if (options["--platform"])
    fields.Platform = configuredValue(config, "Platform", options["--platform"], "--platform");
  return fields;
}

export function resolveSnapshotOutput(output) {
  const outputPath = path.resolve(projectRoot, output);
  const releasesRoot = path.join(projectRoot, "docs", "releases");
  if (outputPath !== releasesRoot && !outputPath.startsWith(`${releasesRoot}${path.sep}`)) {
    throw new Error("snapshot output must be under docs/releases");
  }
  return outputPath;
}

function requiredOption(options, name) {
  const value = options[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function roadmapLockPath() {
  const result = spawnSync("git", ["rev-parse", "--path-format=absolute", "--git-common-dir"], {
    cwd: projectRoot,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  if (result.error) throw result.error;
  if (result.status !== 0)
    throw new Error(result.stderr.trim() || "git common directory is unavailable");
  return path.join(result.stdout.trim(), "portcove-locks", "roadmap");
}

async function runDoctor(config, client, { quiet = false } = {}) {
  const log = quiet ? () => {} : console.log;
  client.gh(["auth", "status"]);
  const number = config.project.number;
  const context = client.completeProjectContext(number);
  const { details, fields } = context;
  const projectId = details.id;
  const views = client.viewList(projectId);
  const audit = client.projectAudit(projectId);
  const drift = projectMachineDrift(config, {
    details: audit,
    fields,
    views,
    repositories: audit?.repositories?.nodes ?? [],
  });
  const catalog = JSON.parse(await readFile(catalogPath, "utf8"));
  const items = client.itemList(number, { includeDependencies: true, details });
  const repositoryIssues = client.repositoryIssues();
  const stage = validatePortStageSemantics(catalog, items);
  const readiness = analyzeReleaseReadiness(items, config.active_release);
  const roadmapErrors = [
    ...readiness.migrationConflicts.map(
      (item) => `${itemUrl(item)} retains an unmigrated active target`,
    ),
    ...readiness.unassignedRequired.map((item) => `${itemUrl(item)} is Required without a target`),
    ...readiness.statusConflicts.map(
      (item) => `${itemUrl(item)} has inconsistent repository/Project status`,
    ),
    ...validatePortIssueCoverage(catalog, items, config.repository, repositoryIssues),
    ...stage.errors,
    ...validateUxAuditOriginCoverage(repositoryIssues),
    ...validatePlanOriginCoverage(repositoryIssues),
    ...readiness.relevantUnclassified.map(
      (item) =>
        `${config.active_release} work is unclassified: ${itemUrl(item) ?? itemTitle(item)}`,
    ),
    ...readiness.safetyConflicts.map(
      (item) =>
        `${config.active_release} safety work is not Required: ${itemUrl(item) ?? itemTitle(item)}`,
    ),
    ...readiness.dependencyConflicts.map(
      ({ item, dependency }) =>
        `${itemUrl(item) ?? itemTitle(item)} has a conflicting blocking dependency ${itemUrl(dependency) ?? itemTitle(dependency)}`,
    ),
    ...readiness.missingProjectDependencies.map(
      ({ item, dependency }) =>
        `${itemUrl(item) ?? itemTitle(item)} has a blocking dependency outside the Project: ${itemUrl(dependency) ?? itemTitle(dependency)}`,
    ),
    ...readiness.truncatedDependencies.map(
      (item) =>
        `${itemUrl(item) ?? itemTitle(item)} has more than 10 blocking dependencies; readiness query is incomplete`,
    ),
    ...readiness.cycles.map(
      (cycle) => `blocking dependency cycle: ${cycle.map((value) => `#${value}`).join(" -> ")}`,
    ),
  ];
  if (drift.length || roadmapErrors.length) {
    throw new Error(
      `Project drift:\n${[...drift, ...roadmapErrors].map((value) => `- ${value}`).join("\n")}`,
    );
  }
  log(`Portcove Roadmap #${number} is reachable at ${details.url}.`);
  log(
    `Verified identity, PUBLIC visibility, repository linkage, ${fields.length} fields, and ${views.length} view layouts/filters/visible-field sets.`,
  );
  log(
    `Verified ${repositoryIssues.filter((issue) => itemBody(issue).includes(portMarker)).length} repository port issues, ${catalog.ports.length} canonical catalog issues, one supported-source plan owner, and all ${uxAuditOriginIds.length} final UX audit origins.`,
  );
  if (stage.diagnostics.length)
    log(`Supported platform scope:\n${stage.diagnostics.map((value) => `- ${value}`).join("\n")}`);
  if (stage.warnings.length)
    log(
      `Conservative Port-stage warnings:\n${stage.warnings.map((value) => `- ${value}`).join("\n")}`,
    );
  log(
    `${config.active_release} readiness has ${readiness.unfinishedRequired.length} unfinished required outcomes and ${readiness.planned.length} planned outcomes.`,
  );
  log(
    `Grouping and sorting were read back; UI changes are required if they drift. Confirm built-in auto-add and completion workflows separately:\n${manualUiChecklist(config).slice(-2).join("\n")}`,
  );
  return { number, details, fields, views, repositoryIssues, items };
}

async function main(argv) {
  const parsed = parseArguments(argv);
  if (["--help", "help"].includes(parsed.command)) {
    console.log(roadmapHelp);
    return;
  }
  if (parsed.command === "check") {
    await offlineCheck();
    return;
  }
  const config = await loadConfig({
    requireProjectNumber: parsed.command !== "bootstrap",
  });
  const client = new RoadmapClient(config);
  const lock = await acquireOwnedProcessLock(
    roadmapLockPath(),
    { workspace: projectRoot, command: parsed.command },
    { label: "Portcove Roadmap operation" },
  );
  try {
    if (parsed.command === "rename-commitment") {
      if (
        parsed.positionals.length ||
        Object.keys(parsed.options).some((key) => key !== "--apply") ||
        ("--apply" in parsed.options && parsed.options["--apply"] !== true)
      )
        throw new Error("usage: roadmap.mjs rename-commitment [--apply]");
      console.log(
        JSON.stringify(
          executeCommitmentRename({ client, config, apply: parsed.options["--apply"] === true }),
        ),
      );
      return;
    }
    if (parsed.command === "doctor") {
      await runDoctor(config, client);
      return;
    }
    if (parsed.command === "bootstrap") {
      const result = client.bootstrap();
      console.log(
        `${result.created ? "Created" : "Reconciled"} Portcove Roadmap #${result.number}: ${result.url}`,
      );
      if (config.project.number !== result.number) {
        console.log(
          `Record project.number=${result.number} in .github/roadmap.json before using item commands.`,
        );
      }
      console.log(
        `Machine-readable view layouts, filters, and visible columns are reconciled. Manual UI confirmation required:\n${manualUiChecklist(config).join("\n")}`,
      );
      return;
    }
    if (parsed.command === "capture-port") {
      const title = requiredOption(parsed.options, "--title");
      const url = requiredOption(parsed.options, "--url");
      if (!/^https:\/\//.test(url)) throw new Error("--url must be an https URL");
      const item = client.createPortIssue({
        title,
        upstream: url,
        catalogId: parsed.options["--catalog-id"],
        portKey: parsed.options["--port-key"],
      });
      console.log(
        `Created durable port issue ${item.html_url} and added it to the Portcove Roadmap (${item.itemId}).`,
      );
      return;
    }
    if (parsed.command === "normalize-port") {
      const value = requiredOption(parsed.options, "--issue");
      if (!/^\d+$/.test(value) || Number(value) < 1)
        throw new Error("--issue must be a positive repository issue number");
      const catalog = JSON.parse(await readFile(catalogPath, "utf8"));
      const result = client.normalizePortIssue({
        number: Number(value),
        catalog,
      });
      console.log(
        `Normalized ${result.issue}: body ${result.bodyChanged ? "updated" : "unchanged"}; Project item ${result.projectItemAdded ? "added" : "reused"}; fields ${result.fieldsChanged.length ? `set ${result.fieldsChanged.join(", ")}` : "unchanged"}; parent relationships preserved.`,
      );
      return;
    }
    if (parsed.command === "capture-feature") {
      const title = requiredOption(parsed.options, "--title");
      const fields = featureIntakeFields(config, parsed.options);
      const item = client.capture({
        title,
        body: "User outcome:\n- Pending triage.\n\nCurrent behavior/evidence:\n- Pending.\n\nScope:\n- Pending.\n\nNon-goals:\n- Pending.",
        fields,
      });
      console.log(`Captured draft feature ${itemTitle(item)} (${item.id}).`);
      return;
    }
    if (parsed.command === "promote") {
      if (parsed.positionals.length !== 1)
        throw new Error("usage: roadmap.mjs promote <draft-item-id>");
      const draft = client
        .itemList(config.project.number)
        .find((item) => item.id === parsed.positionals[0]);
      if (!draft) throw new Error(`draft item was not found: ${parsed.positionals[0]}`);
      const durableBody = parsed.options["--spec-file"]
        ? await readFile(path.resolve(projectRoot, parsed.options["--spec-file"]), "utf8")
        : itemBody(draft);
      validateDurableIssueBody(durableBody);
      const item = client.promote(parsed.positionals[0], durableBody);
      console.log(`Promoted draft to ${item?.content?.url ?? item?.id}.`);
      return;
    }
    if (parsed.command === "set") {
      if (parsed.positionals.length !== 1)
        throw new Error("usage: roadmap.mjs set <item-or-issue> [field options]");
      const values = {};
      for (const [flag, value] of Object.entries(parsed.options)) {
        const field = setFlags.get(flag);
        if (!field) throw new Error(`unsupported set option: ${flag}`);
        const definition = config.fields.find((candidate) => candidate.name === field);
        if (!definition.options.includes(value))
          throw new Error(`${value} is not a valid ${field} option`);
        values[field] = value;
      }
      if (!Object.keys(values).length) throw new Error("set requires at least one field option");
      client.setFields(parsed.positionals[0], values);
      console.log(
        `Updated ${parsed.positionals[0]}: ${Object.entries(values)
          .map(([key, value]) => `${key}=${value}`)
          .join(", ")}.`,
      );
      return;
    }
    if (parsed.command === "set-many") {
      if (parsed.positionals.length)
        throw new Error("usage: roadmap.mjs set-many --spec-file <path> [--apply] [--json]");
      if ("--apply" in parsed.options && parsed.options["--apply"] !== true)
        throw new Error("--apply does not accept a value");
      if ("--json" in parsed.options && parsed.options["--json"] !== true)
        throw new Error("--json does not accept a value");
      for (const option of Object.keys(parsed.options)) {
        if (!["--apply", "--json", "--spec-file"].includes(option))
          throw new Error(`unsupported set-many option: ${option}`);
      }
      const specPath = path.resolve(projectRoot, requiredOption(parsed.options, "--spec-file"));
      const spec = JSON.parse(await readFile(specPath, "utf8"));
      const result = await executeSetMany({
        client,
        config,
        spec,
        apply: parsed.options["--apply"] === true,
        onPlan: parsed.options["--json"] ? undefined : (summary) => console.log(summary),
      });
      if (parsed.options["--json"]) {
        console.log(
          JSON.stringify(githubOperationEnvelope({ operation: "roadmap.set-many", ...result })),
        );
      } else {
        console.log(result.summary);
      }
      return;
    }
    if (parsed.command === "move") {
      if (parsed.positionals.length !== 1)
        throw new Error("usage: roadmap.mjs move <item> --before <item>");
      client.moveBefore(parsed.positionals[0], requiredOption(parsed.options, "--before"));
      console.log(`Moved ${parsed.positionals[0]} before ${parsed.options["--before"]}.`);
      return;
    }
    if (parsed.command === "next") {
      executionOptions(parsed, ["--json"]);
      const items = client.itemList(config.project.number, {
        includeDependencies: true,
        includeBodies: false,
      });
      console.log(
        parsed.options["--json"]
          ? JSON.stringify(executionQueueData(items))
          : renderExecutionQueue(items),
      );
      return;
    }
    if (parsed.command === "context") {
      executionOptions(parsed, [
        "--issue",
        "--coordination-pr",
        "--runner",
        "--consumed-file",
        "--consumed-comment",
        "--reservation-comment",
        "--json",
      ]);
      const value = requiredOption(parsed.options, "--issue");
      if (!/^\d+$/.test(value) || !Number.isSafeInteger(Number(value)) || Number(value) < 1)
        throw new Error("--issue must be a positive repository issue number");
      const runner = requiredOption(parsed.options, "--runner");
      const operational = client.operationalSnapshot();
      if (operational.status === "unknown") {
        const error = new Error(operational.reason);
        error.operationStatus = "unknown";
        error.operationEvidence = { operational_snapshot: operational };
        throw error;
      }
      const binding = bindOperationalAssignment(operational, runner, Number(value));
      const pr = parsed.options["--coordination-pr"];
      if (pr !== undefined && (typeof pr !== "string" || !/^\d+$/.test(pr)))
        throw new Error("--coordination-pr must be a positive repository PR number");
      const target = coordinationTarget(
        config,
        Number(value),
        pr === undefined ? null : Number(pr),
      );
      if (parsed.options["--consumed-file"] && parsed.options["--consumed-comment"])
        throw new Error("choose one consumed file or comment");
      let consumed = null;
      let consumedContext = null;
      let reference = null;
      if (parsed.options["--consumed-file"]) {
        const checkpoint = JSON.parse(
          await readFile(path.resolve(projectRoot, parsed.options["--consumed-file"]), "utf8"),
        );
        consumed = validateExecutionSnapshot(checkpoint.snapshot ?? checkpoint);
        consumedContext = checkpoint;
        reference = { kind: "disposable checkpoint", latest_consumption: "not established" };
      }
      if (parsed.options["--consumed-comment"]) {
        const comment = client.coordinationComment(parsed.options["--consumed-comment"], target);
        consumed = consumedReference(comment, {
          repository: config.repository,
          runner,
          issue: Number(value),
          target,
        });
        reference = {
          url: comment.url,
          recorder: comment.author?.login ?? null,
          latest_consumption: "not established outside the observed window",
        };
      }
      const reservation = parsed.options["--reservation-comment"]
        ? client.coordinationComment(parsed.options["--reservation-comment"], target)
        : null;
      const live = client.executionIssue(Number(value));
      const context = deriveExecutionContext(config, live.item, live.relationships, {
        runner,
        comments: [],
        coverage: {
          complete: false,
          kind:
            deliveryMode(config) === "single-local-runner"
              ? "live task requirements; historical consumption absence remains unknown"
              : "fixed operational snapshot; historical consumption absence remains unknown",
        },
        consumed,
        reservation,
        target,
      });
      context.consumed_reference = reference;
      Object.assign(
        context,
        operationalEnvelope(operational, consumedContext?.operational_baseline, binding),
      );
      if (
        consumedContext?.observation_revision === context.observation_revision &&
        consumedContext?.snapshot?.revision === context.snapshot.revision
      ) {
        context.current_specification = null;
        context.specification_disposition =
          "unchanged from the validated consumed baseline; complete task specification remains bound to its raw observation";
      }
      console.log(
        parsed.options["--json"]
          ? JSON.stringify(context)
          : `#${context.canonical_issue.number} ${context.canonical_issue.title}\n${context.canonical_issue.url}\nRevision: ${context.snapshot.revision}\nComparison: ${context.comparison.state}; ${context.comparison.action}\nPickup: ${context.pickup.current_requirements}; invoked/active/assigned unknown.\nReservation: ${context.reservation.assessment}\nUse --json for the full current specification, planning, typed relationships and coverage.`,
      );
      return;
    }
    if (parsed.command === "handoff-offer") {
      executionOptions(parsed, ["--spec-file", "--apply", "--json"]);
      const spec = JSON.parse(
        await readFile(
          path.resolve(projectRoot, requiredOption(parsed.options, "--spec-file")),
          "utf8",
        ),
      );
      const result = prepareOperationalOffer({
        config,
        snapshot: client.operationalSnapshot(),
        spec,
        apply: parsed.options["--apply"] === true,
      });
      console.log(JSON.stringify(result));
      return;
    }
    if (parsed.command === "handoff-return") {
      executionOptions(parsed, [
        "--offer-file",
        "--runner",
        "--disposition",
        "--evidence",
        "--apply",
        "--json",
      ]);
      const packet = JSON.parse(
        await readFile(
          path.resolve(projectRoot, requiredOption(parsed.options, "--offer-file")),
          "utf8",
        ),
      );
      const offer = packet.offer ?? packet;
      const evidence = requiredOption(parsed.options, "--evidence");
      const evidenceObservation = client.operationalReturnEvidence(
        evidence,
        offer.proposed.owning_issue,
        offer.proposed.source,
      );
      const result = prepareOperationalReturn({
        config,
        snapshot: client.operationalSnapshot(),
        offer,
        runner: requiredOption(parsed.options, "--runner"),
        source: gitHead(),
        disposition: requiredOption(parsed.options, "--disposition"),
        evidence,
        evidenceObservation,
        apply: parsed.options["--apply"] === true,
      });
      console.log(JSON.stringify(result));
      return;
    }
    if (parsed.command === "acknowledge") {
      executionOptions(parsed, [
        "--context-file",
        "--runner",
        "--action",
        "--evidence",
        "--apply",
        "--json",
      ]);
      const context = JSON.parse(
        await readFile(
          path.resolve(projectRoot, requiredOption(parsed.options, "--context-file")),
          "utf8",
        ),
      );
      const result = prepareOperationalConsumption({
        client,
        config,
        context,
        runner: requiredOption(parsed.options, "--runner"),
        action: requiredOption(parsed.options, "--action"),
        evidence: requiredOption(parsed.options, "--evidence"),
        apply: parsed.options["--apply"] === true,
      });
      console.log(
        parsed.options["--json"]
          ? JSON.stringify(result)
          : `${result.status}: ${result.url ?? result.body ?? result.reason}`,
      );
      return;
    }
    if (parsed.command === "history") {
      executionOptions(parsed, ["--issue", "--coordination-pr", "--json"]);
      const issue = Number(requiredOption(parsed.options, "--issue"));
      const pr = parsed.options["--coordination-pr"];
      const target = coordinationTarget(config, issue, pr === undefined ? null : Number(pr));
      const history = client.coordinationRecords(target);
      console.log(
        parsed.options["--json"]
          ? JSON.stringify({ target, ...history })
          : `Explicit bounded task history: ${target.url}; coverage ${history.coverage?.complete === true ? "complete" : "incomplete/unknown"}. Use --json for original records. No archive scan or authority inference.`,
      );
      return;
    }
    if (parsed.command === "readiness") {
      const release = requiredOption(parsed.options, "--release");
      const analysis = analyzeReleaseReadiness(
        client.itemList(config.project.number, { includeDependencies: true }),
        release,
      );
      console.log(renderReadinessSummary(analysis));
      if (!analysis.ready) process.exitCode = 1;
      return;
    }
    if (parsed.command === "candidate-scope") {
      const value = requiredOption(parsed.options, "--issues");
      if (!/^\d+(,\d+)*$/.test(value))
        throw new Error("--issues must be comma-separated positive issue numbers");
      const items = client.itemList(config.project.number, {
        includeDependencies: true,
      });
      const analysis = analyzeReleaseReadiness(items, "Public beta", {
        candidateIssues: value.split(",").map(Number),
      });
      console.log(renderReadinessSummary(analysis));
      console.log(
        "This checks only the explicit candidate implementation scope and its genuine blockers. Required CI/review, exact package/signature/feed checks and current publication authority remain separate. It does not declare Public beta or 1.0 readiness.",
      );
      if (!analysis.ready) process.exitCode = 1;
      return;
    }
    if (parsed.command === "snapshot") {
      const release = requiredOption(parsed.options, "--release");
      const output = requiredOption(parsed.options, "--output");
      if (!config.fields.find((field) => field.name === "Target release").options.includes(release))
        throw new Error(`unknown target release: ${release}`);
      const outputPath = resolveSnapshotOutput(output);
      const { writeFile } = await import("node:fs/promises");
      try {
        await access(outputPath);
        throw new Error(`snapshot output already exists: ${output}`);
      } catch (error) {
        if (error.code !== "ENOENT") throw error;
      }
      const [catalog, commit] = await Promise.all([
        readFile(catalogPath, "utf8").then(JSON.parse),
        Promise.resolve(gitHead()),
      ]);
      const document = renderSnapshot({
        release,
        generatedAt: new Date().toISOString(),
        commit,
        projectUrl: `https://github.com/users/${config.owner}/projects/${config.project.number}`,
        items: client.itemList(config.project.number, {
          includeDependencies: true,
        }),
        catalog,
      });
      await writeFile(outputPath, document, { encoding: "utf8", flag: "wx" });
      console.log(`Wrote immutable readiness snapshot ${path.relative(projectRoot, outputPath)}.`);
      return;
    }
    throw new Error(`unknown command: ${parsed.command}`);
  } finally {
    await lock.release();
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === scriptPath) {
  try {
    await main(process.argv.slice(2));
  } catch (error) {
    const json =
      ["set-many", "context", "acknowledge", "next"].includes(process.argv[2]) &&
      process.argv.slice(3).includes("--json");
    const safeError = sanitizeOperationError(error);
    if (json) {
      console.log(
        JSON.stringify(
          githubOperationEnvelope({
            operation: `roadmap.${process.argv[2]}`,
            status: error.operationStatus ?? "failed",
            summary: safeError.message,
            evidence: error.operationEvidence ?? {},
            error,
          }),
        ),
      );
    }
    console.error(`roadmap: ${safeError.message}`);
    process.exitCode = 1;
  }
}
