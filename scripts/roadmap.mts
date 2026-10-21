import {
  collectRoadmapInventory,
  requireRoadmapInventory,
  invalidateRoadmapInventory,
} from "./roadmap-inventory.mts";
import type { RoadmapInventory, InventoryCache } from "./roadmap-inventory.mts";
import type { GitHubRunner } from "./github-api.mts";
import type { PortDefinition } from "../apps/desktop/src/transport-types.generated.d.ts";
import { errorMessage, errorCode, isRecord } from "./runtime-values.mts";
import { spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { access, readFile } from "node:fs/promises";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  GitHubApiClient,
  GitHubApiError,
  createGitHubRunner,
  githubOperationEnvelope,
  githubRateLimitMessage,
  sanitizeOperationError,
} from "./github-api.mts";
import { acquireOwnedProcessLock } from "./process-lock.mts";
import { validateGitHubBody } from "./github-body.mts";
import { captureCheckoutContext, checkContextualDoctor } from "./checkout-context.mts";
import { summarizeReport, retainReportSummary } from "./report-summary.mts";
import { decide706, decisionInputs706, validateApproval706 } from "./linux-beta-risk-706.mts";

import { scanDependencies } from "./dependency-security.mts";

const scriptPath = fileURLToPath(import.meta.url);
const projectRoot = path.resolve(path.dirname(scriptPath), "..");
const configPath = path.join(projectRoot, ".github", "roadmap.json");
const catalogPath = path.join(projectRoot, "crates", "portcove-core", "catalog", "catalog.json");

const layouts = new Set(["TABLE_LAYOUT", "BOARD_LAYOUT", "ROADMAP_LAYOUT"]);
const legacyReleaseSequence = ["Alpha 1", "Alpha 2", "Alpha 3", "Beta 1", "Beta 2", "RC", "V1"];
export const releaseSequence = [...legacyReleaseSequence, "Public beta", "1.0"];

export interface RoadmapFieldDefinition {
  name: string;
  options: string[];
}
export interface RoadmapViewDefinition {
  name: string;
  previous_name?: string;
  layout: string;
  filter: string;
  fields: string[];
  manual_group_by: string | null;
  manual_sort_by: string;
}
export interface RoadmapConfig {
  schema_version: 1;
  owner: string;
  repository: string;
  active_release: string;
  outcome_label?: unknown;
  project: {
    number: number;
    title: string;
    description: string;
    readme: string;
    visibility: "PUBLIC";
  };
  fields: RoadmapFieldDefinition[];
  views: RoadmapViewDefinition[];
}

export interface RoadmapFieldTransition {
  from: string | null;
  to: string;
}
export interface SetManySpecification {
  schema_version: 1;
  updates: { target: string; fields: Record<string, RoadmapFieldTransition> }[];
  assignments: number;
}
export interface SetManyAssignment extends RoadmapFieldTransition {
  target: string;
  itemId: string;
  fieldName: string;
  observed: unknown;
}
export interface SetManyPlan<Context = unknown> {
  context: Context;
  pending: SetManyAssignment[];
  alreadyApplied: SetManyAssignment[];
  assignments: number;
}
interface SetManyRate {
  used: number;
  remaining: number;
  resetAt: string;
}
interface SetManyReadback extends SetManyAssignment {
  verified: boolean;
}
interface SetManyChunk {
  index: number;
  assignments: number;
  attempted: number;
  verified: number;
  reconciled_after_error: number;
}
interface SetManyState {
  verified: number;
  verifiedAfterAttempt: number;
  reconciled: number;
  reconciledAfterError: number;
  processed: number;
  chunks: SetManyChunk[];
  rateLimit: SetManyRate | null;
  doctor: "not_run" | "passed" | "failed";
}
export interface SetManyClient<Context = unknown> {
  sampleGraphqlRate(): SetManyRate;
  planSetMany(spec: unknown): SetManyPlan<Context>;
  verifySetMany(plan: SetManyPlan<Context>): SetManyReadback[];
  applySetMany(plan: SetManyPlan<Context>, changes: SetManyAssignment[]): unknown;
}
function diagnosticText(value: unknown): string {
  return String(value);
}

export interface RoadmapFieldValue {
  name?: unknown;
  value?: unknown;
  field?: { name?: unknown } | null;
  option?: { name?: unknown } | null;
}
export interface RoadmapIssueItem {
  id?: string | undefined;
  number?: number | string | undefined;
  type?: string | undefined;
  __typename?: string | undefined;
  title?: string | null | undefined;
  body?: string | null | undefined;
  url?: string | null | undefined;
  state?: string | null | undefined;
  content?: RoadmapIssueItem | null;
  fieldValues?: readonly RoadmapFieldValue[] | undefined;
  blockedBy?:
    | readonly RoadmapIssueItem[]
    | { nodes?: readonly RoadmapIssueItem[]; totalCount?: number }
    | null;
  // The CLI normalizes configurable Project field names onto the item itself.
  // Their values remain untrusted and fieldValue preserves direct-key precedence.
  [fieldName: string]: unknown;
}
function captureText(match: RegExpMatchArray, index: number): string {
  const value = match[index];
  if (value === undefined) throw new Error("Required issue marker capture is missing");
  return value;
}
// Diagnostic projections only. Core still owns catalog admission; unknown
// qualification records are narrowed by the exact-scope checks below.
type QualificationPlatformFields = Pick<
  PortDefinition,
  "platforms" | "automated_tested_platforms" | "manually_validated_platforms"
>;
export type QualificationPortObservation = Pick<PortDefinition, "id"> & {
  [K in keyof QualificationPlatformFields]?: readonly string[];
} & { support_tier?: unknown };
export interface QualificationCatalogObservation {
  ports?: readonly QualificationPortObservation[] | null;
  source_catalog?: { qualification?: readonly unknown[] | null } | null;
}
function qualificationField(value: unknown, name: string): unknown {
  return isRecord(value) ? value[name] : undefined;
}
function includedReleaseTargets(release: string) {
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

function requireExactKeys(
  value: unknown,
  expected: readonly string[],
  label: string,
): asserts value is Record<string, unknown> {
  const actual = Object.keys(value ?? {}).sort();
  const wanted = [...expected].sort();
  if (!isRecord(value) || JSON.stringify(actual) !== JSON.stringify(wanted))
    throw new Error(`${label} must contain exactly: ${wanted.join(", ")}`);
}

export function validateSetManySpec(config: RoadmapConfig, spec: unknown): SetManySpecification {
  requireExactKeys(spec, ["schema_version", "updates"], "set-many specification");
  if (spec.schema_version !== 1) throw new Error("set-many schema_version must be 1");
  if (!Array.isArray(spec.updates) || !spec.updates.length)
    throw new Error("set-many updates must be a non-empty array");
  const targets = new Set();
  let assignments = 0;
  const suppliedUpdates: unknown[] = spec.updates;
  const updates = suppliedUpdates.map((update, updateIndex) => {
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
    const fields: Record<string, RoadmapFieldTransition> = {};
    for (const [fieldName, transition] of Object.entries(update.fields)) {
      const definition = config.fields.find((field) => field.name === fieldName);
      if (!definition) throw new Error(`Project field not found: ${fieldName}`);
      requireExactKeys(transition, ["from", "to"], `${update.target} ${fieldName} transition`);
      if (
        transition.from !== null &&
        (typeof transition.from !== "string" || !definition.options.includes(transition.from))
      )
        throw new Error(
          `${diagnosticText(transition.from)} is not a valid ${fieldName} source option`,
        );
      if (typeof transition.to !== "string" || !definition.options.includes(transition.to))
        throw new Error(
          `${diagnosticText(transition.to)} is not a valid ${fieldName} target option`,
        );
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

export function setManyRequiredReserve(preflightCost: unknown, pendingAssignments: unknown) {
  if (
    typeof preflightCost !== "number" ||
    !Number.isSafeInteger(preflightCost) ||
    preflightCost < 0 ||
    typeof pendingAssignments !== "number" ||
    !Number.isSafeInteger(pendingAssignments) ||
    pendingAssignments < 0 ||
    pendingAssignments > maximumBatchAssignments
  ) {
    throw new Error("set-many quota inputs are invalid");
  }
  return 2 * preflightCost + Math.min(pendingAssignments, maximumMutationChunkAssignments) + 100;
}

function setManyOutcomeError(
  status: "unknown" | "partial",
  message: string,
  evidence: ReturnType<typeof setManyEvidence>,
  cause: unknown = null,
) {
  return Object.assign(new Error(message, cause ? { cause } : undefined), {
    code: `set_many_${status}`,
    operationStatus: status,
    operationEvidence: evidence,
  });
}

function setManyEvidence(plan: SetManyPlan, state: SetManyState) {
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

export async function executeSetMany<Context>({
  client,
  config,
  spec,
  apply = false,
  doctor = runDoctor,
  onPlan = () => {},
}: {
  client: SetManyClient<Context>;
  config: RoadmapConfig;
  spec: unknown;
  apply?: boolean;
  doctor?: (
    config: RoadmapConfig,
    client: SetManyClient<Context>,
    options: { quiet: boolean },
  ) => unknown;
  onPlan?: (summary: string) => void;
}) {
  const before = client.sampleGraphqlRate();
  const plan = client.planSetMany(spec);
  const after = client.sampleGraphqlRate();
  if (after.used < before.used)
    throw new Error("GitHub GraphQL rate-limit window changed during set-many preflight; retry");
  const preflightCost = after.used - before.used;
  const state: SetManyState = {
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
        `set-many could not establish the pre-mutation state for chunk ${state.chunks.length + 1}: ${errorMessage(error)}`,
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

    let mutationError: unknown = null;
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
        `set-many could not establish the post-mutation state for chunk ${state.chunks.length + 1}: ${errorMessage(error)}`,
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
      `set-many final readback failed: ${errorMessage(error)}`,
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
      `set-many verified every assignment but the final doctor failed: ${errorMessage(error)}`,
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

function normalizedKey(value: unknown) {
  return diagnosticText(value ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "");
}

function ensureString(value: unknown, label: string): asserts value is string {
  if (typeof value !== "string" || !value.trim())
    throw new Error(`${label} must be a non-empty string`);
}

function findVolatileKey(value: unknown, prefix = "config"): string | null {
  if (!value || typeof value !== "object") return null;
  for (const [key, child] of Object.entries(value)) {
    const location = `${prefix}.${key}`;
    if (volatileKeys.has(key)) return location;
    const nested = findVolatileKey(child, location);
    if (nested) return nested;
  }
  return null;
}

function assertRoadmapConfig(
  config: unknown,
  { requireProjectNumber = false } = {},
): asserts config is RoadmapConfig {
  if (!isRecord(config) || config.schema_version !== 1)
    throw new Error("roadmap schema_version must be 1");
  ensureString(config.owner, "roadmap owner");
  if (
    typeof config.repository !== "string" ||
    !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(config.repository)
  ) {
    throw new Error("roadmap repository must be owner/name");
  }
  if (!isRecord(config.project)) throw new Error("roadmap project is required");
  ensureString(config.project.title, "project title");
  ensureString(config.project?.description, "project description");
  ensureString(config.project?.readme, "project readme");
  if (
    typeof config.active_release !== "string" ||
    !releaseSequence.includes(config.active_release)
  ) {
    throw new Error(`active_release must be one of ${releaseSequence.join(", ")}`);
  }
  if (config.project?.visibility !== "PUBLIC") throw new Error("roadmap project must be PUBLIC");
  if (
    typeof config.project.number !== "number" ||
    !Number.isInteger(config.project.number) ||
    config.project.number < 0
  ) {
    throw new Error("project number must be a non-negative integer");
  }
  if (requireProjectNumber && config.project.number < 1) {
    throw new Error(
      "project number is not recorded; run bootstrap and update .github/roadmap.json",
    );
  }
  const fieldNames = new Set<string>();
  if (!Array.isArray(config.fields)) throw new Error("roadmap fields must be an array");
  const inputFields: readonly unknown[] = config.fields;
  for (const field of inputFields) {
    if (!isRecord(field)) throw new Error("roadmap field must be an object");
    ensureString(field.name, "field name");
    if (fieldNames.has(field.name)) throw new Error(`duplicate field: ${field.name}`);
    fieldNames.add(field.name);
    if (!Array.isArray(field.options) || field.options.length === 0) {
      throw new Error(`field ${field.name} must define options`);
    }
    const options = new Set<string>();
    const inputOptions: readonly unknown[] = field.options;
    for (const option of inputOptions) {
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
  const viewNames = new Set<string>();
  const viewAliases = new Set<string>();
  if (!Array.isArray(config.views)) throw new Error("roadmap views must be an array");
  const inputViews: readonly unknown[] = config.views;
  for (const view of inputViews) {
    if (!isRecord(view)) throw new Error("roadmap view must be an object");
    ensureString(view.name, "view name");
    if (viewNames.has(view.name)) throw new Error(`duplicate view: ${view.name}`);
    viewNames.add(view.name);
    if (view.previous_name !== undefined) {
      ensureString(view.previous_name, "previous view name");
      if (viewAliases.has(view.previous_name))
        throw new Error(`duplicate previous view name: ${view.previous_name}`);
      viewAliases.add(view.previous_name);
    }
    if (typeof view.layout !== "string" || !layouts.has(view.layout))
      throw new Error(`view ${view.name} has invalid layout`);
    if (
      typeof view.filter !== "string" ||
      !Array.isArray(view.fields) ||
      view.fields.length === 0 ||
      view.fields.some((field: unknown) => typeof field !== "string")
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
}

export function validateConfig(
  config: unknown,
  options: { requireProjectNumber?: boolean } = {},
): RoadmapConfig {
  assertRoadmapConfig(config, options);
  return config;
}

export function materializeViews(config: Pick<RoadmapConfig, "views" | "active_release">) {
  return config.views.map((view) => ({
    ...view,
    filter: view.filter.replaceAll("${active_release}", config.active_release),
  }));
}

export function validateDurableIssueBody(body: unknown) {
  ensureString(body, "durable issue body");
  validateGitHubBody(body);
  const missing = durableIssueHeadings.filter((heading: string) => {
    const match = body.match(
      new RegExp(`^## ${heading.replace(/[.*+?^${}()|[\\]\\]/g, "\\$&")}\\s*$`, "im"),
    );
    if (!match) return true;
    const start = (match.index ?? 0) + match[0].length;
    const next = body.slice(start).search(/^##\s/m);
    const content = body.slice(start, next < 0 ? undefined : start + next).trim();
    return !content || /^(?:pending|tbd|todo)[.!]?$/i.test(content.replace(/^[-*]\s*/, ""));
  });
  if (missing.length)
    throw new Error(`durable issue specification is incomplete: ${missing.join(", ")}`);
  return body;
}

function portCatalogMarkers(body: unknown) {
  return [
    ...diagnosticText(body ?? "").matchAll(/<!--\s*portcove-catalog-id:\s*([^\s>]+)\s*-->/gi),
  ].map((match) => captureText(match, 1));
}

function portUpstreamMarkers(body: unknown) {
  return [
    ...diagnosticText(body ?? "").matchAll(/<!--\s*portcove-upstream:\s*([^\s>]+)\s*-->/gi),
  ].map((match) => captureText(match, 1));
}

function portKeyMarkers(body: unknown) {
  return [
    ...diagnosticText(body ?? "").matchAll(/<!--\s*portcove-port-key:\s*([^\s>]+)\s*-->/gi),
  ].map((match) => captureText(match, 1));
}

export function normalizePortKey(value: unknown) {
  return diagnosticText(value ?? "")
    .normalize("NFKD")
    .replace(/\p{Mark}/gu, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function normalizedPortTitle(value: unknown) {
  return normalizePortKey(diagnosticText(value ?? "").replace(portTitlePrefix, ""));
}

function normalizedUpstream(value: unknown) {
  try {
    const parsed = new URL(diagnosticText(value));
    const pathname = parsed.pathname.replace(/\/+$/g, "").replace(/\.git$/i, "");
    return `${parsed.protocol.toLowerCase()}//${parsed.host.toLowerCase()}${pathname.toLowerCase()}`;
  } catch {
    return diagnosticText(value ?? "")
      .trim()
      .replace(/\/+$/g, "")
      .replace(/\.git$/i, "")
      .toLowerCase();
  }
}

function issueNumber(item: RoadmapIssueItem | null | undefined) {
  const direct = Number(item?.content?.number ?? item?.number);
  if (Number.isInteger(direct) && direct > 0) return direct;
  const match = String(itemUrl(item) ?? "").match(/\/issues\/(\d+)(?:$|[?#])/i);
  return match ? Number(match[1]) : null;
}

function repositoryIssueContent(item: RoadmapIssueItem): RoadmapIssueItem {
  return item?.content?.type === "Issue" || item?.content?.__typename === "Issue"
    ? item.content
    : item;
}

function isOpenPortTitleIssue(issue: RoadmapIssueItem) {
  return repositoryState(issue) === "open" && portTitlePrefix.test(itemTitle(issue));
}

function discoveredPortIssues(issues: readonly RoadmapIssueItem[] | null | undefined) {
  return (issues ?? [])
    .map(repositoryIssueContent)
    .filter((issue) => itemBody(issue).includes(portMarker) || isOpenPortTitleIssue(issue));
}

function issueFormSection(body: unknown, label: string) {
  const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = diagnosticText(body ?? "").match(
    new RegExp(`^###\\s+${escaped}\\s*$([\\s\\S]*?)(?=^###\\s|(?![\\s\\S]))`, "im"),
  );
  if (!match) return null;
  const value = captureText(match, 1).trim();
  return !value || /^_?No response_?$/i.test(value) ? null : value;
}

export function parsePortIssueForm(body: unknown) {
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

function portIdentity(issue: RoadmapIssueItem) {
  const body = itemBody(issue);
  let form: ReturnType<typeof parsePortIssueForm> | null = null;
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

export function sourceProvenancePortIdentity(issue: RoadmapIssueItem) {
  const identity = portIdentity(repositoryIssueContent(issue));
  return {
    catalogIds: [...identity.ids],
    portKeys: [...identity.keys],
    upstreams: [...identity.upstreams],
    title: identity.title,
  };
}

export function sourceProvenancePortIssues(issues: readonly RoadmapIssueItem[] | null | undefined) {
  return discoveredPortIssues(issues);
}

export function findPortIssueDuplicates(
  issues: readonly RoadmapIssueItem[] | null | undefined,
  {
    title,
    upstream,
    catalogId,
    portKey,
  }: {
    title: string;
    upstream: string;
    catalogId?: string | null | undefined;
    portKey?: string | null | undefined;
  },
) {
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

export function reconcilePortIssueMarkers(
  body: unknown,
  {
    upstream,
    catalogId,
    portKey,
  }: {
    upstream: string;
    catalogId?: string | null | undefined;
    portKey?: string | null | undefined;
  },
) {
  const retained = diagnosticText(body ?? "")
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

export function portFieldInitialization(item: RoadmapIssueItem | null) {
  const updates: Record<string, string> = {};
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

export function uxAuditOrigins(body: unknown) {
  const markers = [
    ...diagnosticText(body ?? "").matchAll(/<!--\s*portcove-ux-audit-origins:\s*([\s\S]*?)-->/gi),
  ];
  return markers.flatMap((match) =>
    captureText(match, 1)
      .trim()
      .split(/[\s,]+/)
      .filter(Boolean),
  );
}

export function validateUxAuditOriginCoverage(
  items: readonly RoadmapIssueItem[] | null | undefined,
) {
  const errors = [];
  const owners = new Map<string, string[]>();
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

export function validatePlanOriginCoverage(items: readonly RoadmapIssueItem[] | null | undefined) {
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
}: {
  title: string;
  upstream: string;
  catalogId?: string | null | undefined;
  portKey?: string | null | undefined;
  currentEvidence?: string;
  blocker?: string;
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

function issueSection(body: unknown, heading: string) {
  const escaped = heading.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return (
    diagnosticText(body ?? "")
      .match(new RegExp(`^##\\s+${escaped}\\s*$([\\s\\S]*?)(?=^##\\s|(?![\\s\\S]))`, "im"))?.[1]
      ?.trim() ?? ""
  );
}

function hasBlockedEvidence(body: unknown) {
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

export function validatePortStageSemantics(
  catalog: QualificationCatalogObservation | null | undefined,
  items: readonly RoadmapIssueItem[] | null | undefined,
) {
  const errors = [];
  const warnings = [];
  const diagnostics = [];
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
  return { errors, warnings, diagnostics };
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

export function validatePortIssueCoverage(
  catalog: QualificationCatalogObservation | null | undefined,
  items: readonly RoadmapIssueItem[] | null | undefined,
  repository: string,
  repositoryIssues: readonly RoadmapIssueItem[] | null = null,
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

export function parseArguments(argv: readonly string[]) {
  const command = argv[0];
  if (!command) throw new Error("missing command; use --help for available commands");
  const options: Record<string, string | boolean> = {};
  const positionals: string[] = [];
  for (let index = 1; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === undefined) throw new Error("argument index is unavailable");
    if (!token.startsWith("--")) {
      positionals.push(token);
      continue;
    }
    const [name, inline] = token.split("=", 2);
    if (name === undefined) throw new Error("argument name is unavailable");
    if (
      ["--apply", "--json", "--summary", "--help", "--linux-beta-706"].includes(name) &&
      inline === undefined
    ) {
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
  node scripts/roadmap.mts check
  node scripts/roadmap.mts doctor [--expected-head <sha>] [--json]
  node scripts/roadmap.mts capture-port --title <title> --url <https-url> (--port-key <key> | --catalog-id <id>)
  node scripts/roadmap.mts normalize-port --issue <number>
  node scripts/roadmap.mts capture-feature --title <title> [planning field options]
  node scripts/roadmap.mts promote <draft-item-id> [--spec-file <path>]
  node scripts/roadmap.mts set <item-or-issue> [field options]
  node scripts/roadmap.mts set-many --spec-file <path> [--apply] [--json]
  node scripts/roadmap.mts move <item> --before <item>
  node scripts/roadmap.mts next [--json]
  node scripts/roadmap.mts context --issue <number> --runner <identity> [--coordination-pr <number>] [--consumed-file <path> | --consumed-comment <url>] [--reservation-comment <url>] [--json]
  node scripts/roadmap.mts history --issue <number> [--coordination-pr <number>] [--json]
  node scripts/roadmap.mts rename-commitment [--apply]
  node scripts/roadmap.mts readiness --release <release> [--linux-beta-706]
  node scripts/roadmap.mts candidate-scope --issues <issue,issue,...>
  node scripts/roadmap.mts snapshot --release <release> --output <docs/releases/path>

Use capture-port for direct maintainer intake. Use normalize-port for a public
New Port form submission; it preserves form content, reconciles canonical
markers, Project membership and neutral unset fields. Parent relationships are preserved.`;

export function fieldValue(item: RoadmapIssueItem | null | undefined, fieldName: string): unknown {
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

function itemTitle(item: RoadmapIssueItem | null | undefined) {
  return item?.title ?? item?.content?.title ?? "Untitled";
}

function itemUrl(item: RoadmapIssueItem | null | undefined) {
  return item?.content?.url ?? item?.url;
}

function itemBody(item: RoadmapIssueItem | null | undefined) {
  return item?.content?.body ?? item?.body ?? "";
}

function itemDone(item: RoadmapIssueItem | null | undefined) {
  const status = diagnosticText(fieldValue(item, "Status") ?? "").toLowerCase();
  return status === "done";
}

function repositoryState(item: RoadmapIssueItem | null | undefined) {
  return diagnosticText(item?.content?.state ?? item?.state ?? "").toLowerCase();
}

export function selectNextItems<T extends RoadmapIssueItem>(items: readonly T[]): T[] {
  const priority = new Map<unknown, number>([
    ["Urgent", 0],
    ["High", 1],
    ["Medium", 2],
    ["Low", 3],
    ["None", 4],
  ]);
  const horizon = new Map<unknown, number>([
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
      const leftHorizon = horizon.get(fieldValue(left.item, "Horizon"));
      const rightHorizon = horizon.get(fieldValue(right.item, "Horizon"));
      const horizonOrder =
        leftHorizon === undefined || rightHorizon === undefined ? NaN : leftHorizon - rightHorizon;
      if (horizonOrder) return horizonOrder;
      const priorityOrder =
        (priority.get(fieldValue(left.item, "Priority")) ?? 5) -
        (priority.get(fieldValue(right.item, "Priority")) ?? 5);
      return priorityOrder || left.index - right.index;
    })
    .map(({ item }) => item);
}

function blockingNodes(item: RoadmapIssueItem | null | undefined): readonly RoadmapIssueItem[] {
  const value = item?.content?.blockedBy ?? item?.blockedBy;
  function isList(value: RoadmapIssueItem["blockedBy"]): value is readonly RoadmapIssueItem[] {
    return Array.isArray(value);
  }
  return isList(value) ? value : (value?.nodes ?? []);
}

export function renderExecutionQueue(items: readonly RoadmapIssueItem[]) {
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
        const dependencyCount =
          dependencyRecord && !Array.isArray(dependencyRecord) && "totalCount" in dependencyRecord
            ? dependencyRecord.totalCount
            : 0;
        const incomplete = Number(dependencyCount ?? 0) > blockingNodes(item).length;
        const blockers = blockingNodes(item)
          .filter((node) => {
            const owner = items.find((candidate) => issueNumber(candidate) === issueNumber(node));
            return !owner || !itemDone(owner);
          })
          .map((node) => `#${issueNumber(node)}`)
          .join(", ");
        return `${index + 1}. ${itemTitle(item)} | ${diagnosticText(fieldValue(item, "Priority") ?? "None")} | ${diagnosticText(fieldValue(item, "Horizon"))} | ${diagnosticText(fieldValue(item, "Status") ?? "Unassigned")} | ${diagnosticText(commitment === "Opportunistic" ? "Planned" : (commitment ?? "Unclassified"))} | after: ${predecessor}${blockers ? ` | prerequisites: ${blockers}` : ""}${incomplete ? " | prerequisite coverage incomplete; collect remaining relationships before selection" : ""}${itemUrl(item) ? ` | ${itemUrl(item)}` : ""}`;
      })
      .join("\n") +
    "\nQueue position is scheduling, not a blocking edge or accepted reservation. Select either Required or Planned; record concrete pass-over reasons on the owning issue/PR."
  );
}

// Exact historical consumption references still support context comparisons.
const legacyCoordinationIssue = 793;

export function coordinationTarget(
  config: Pick<RoadmapConfig, "repository">,
  issue: unknown,
  pullRequest: unknown = null,
): {
  repository: string;
  work_issue: number;
  kind: "issue" | "pull_request";
  number: number;
  url: string;
} {
  const positive = (value: unknown): value is number =>
    typeof value === "number" && Number.isSafeInteger(value) && value > 0;
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

function sameCoordinationTarget(target: unknown, expected: unknown) {
  return (
    isRecord(target) &&
    isRecord(expected) &&
    Object.keys(target).length === Object.keys(expected).length &&
    Object.entries(expected).every(([key, value]) => target[key] === value)
  );
}

function validateCoordinationTarget(
  target: unknown,
  snapshot: { repository: string; issue: { number: number } },
) {
  const expected = coordinationTarget(
    { repository: snapshot.repository },
    snapshot.issue.number,
    isRecord(target) && target.kind === "pull_request" ? target.number : null,
  );
  if (!sameCoordinationTarget(target, expected))
    throw new Error("coordination target does not match this repository and work issue");
  return target as Record<string, unknown> & ReturnType<typeof coordinationTarget>;
}

interface RoadmapComment {
  id?: number | string;
  body?: unknown;
  html_url?: string;
  url?: string;
  author?: { login?: string | null } | null | undefined;
}
function matchingConsumption(
  comment: RoadmapComment,
  snapshot: { repository: string; issue: { id: string; number: number } },
  runner: unknown,
  target: ReturnType<typeof coordinationTarget>,
) {
  const url = comment.html_url ?? comment.url;
  if (
    !url?.startsWith(`${target.url}#issuecomment-`) ||
    !/^[1-9]\d*$/.test(url.slice(`${target.url}#issuecomment-`.length))
  )
    return null;
  const record = parseConsumptionRecord(comment.body);
  return record !== null &&
    record.runner === runner &&
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
] as const;
type ExecutionField = (typeof executionFields)[number];
interface ExecutionReference {
  id: string;
  number: number;
  url: string;
}
interface ExecutionSnapshot {
  schema_version: 1;
  repository: string;
  issue: ExecutionReference & { state: "OPEN" | "CLOSED" };
  scope_revision: string;
  planning: Record<ExecutionField, string | null>;
  prerequisites: (ExecutionReference & {
    state: "OPEN" | "CLOSED";
    scope_revision: string;
    status: string | null;
  })[];
  dependents: ExecutionReference[];
  organization: { parent: ExecutionReference | null; children: ExecutionReference[] };
  revision: string;
}
interface ExecutionRelationshipNode extends RoadmapIssueItem {
  id: string;
  number: number;
  url: string;
  title?: string | null;
  body?: string | null;
  state: "OPEN" | "CLOSED";
  projectStatus?: string | null;
}
interface CanonicalProjectIssue extends RoadmapIssueItem {
  content: ExecutionRelationshipNode;
}
interface ExecutionRelationships {
  blockedBy: ExecutionRelationshipNode[];
  blocking: ExecutionRelationshipNode[];
  parent: ExecutionRelationshipNode | null;
  subIssues: ExecutionRelationshipNode[];
}
const digest = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");

// A comparison aid, never a semantic decision or authority to execute. Keep the
// complete specification in context output; unknown sections remain significant.
export function normalizeRequirements(body: unknown) {
  const evidenceHeadings = new Set([
    "delivered evidence",
    "delivered components",
    "completion evidence",
    "current behavior and evidence",
    "progress",
    "delivery evidence",
  ]);
  let excludedLevel: number | null = null;
  let fence: string | null = null;
  let indented = false;
  return diagnosticText(body ?? "")
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .flatMap((line: string) => {
      const marker = /^ {0,3}(`{3,}|~{3,})/.exec(line);
      if (fence) {
        const closing = /^ {0,3}(`{3,}|~{3,})[ \t]*$/.exec(line);
        if (
          closing &&
          captureText(closing, 1)[0] === fence[0] &&
          captureText(closing, 1).length >= fence.length
        )
          fence = null;
        return [line];
      }
      if (marker) {
        fence = captureText(marker, 1);
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
        if (excludedLevel !== null && captureText(heading, 1).length <= excludedLevel)
          excludedLevel = null;
        if (
          excludedLevel === null &&
          evidenceHeadings.has(captureText(heading, 2).trim().toLowerCase())
        )
          excludedLevel = captureText(heading, 1).length;
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

export function executionSnapshot(
  config: Pick<RoadmapConfig, "repository">,
  item: RoadmapIssueItem,
  relationships: ExecutionRelationships,
) {
  if (
    !item?.content?.id ||
    typeof item.content.number !== "number" ||
    !Number.isSafeInteger(item.content.number)
  )
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

function projectFieldValues(node: unknown): RoadmapFieldValue[] {
  const fields = qualificationField(node, "fieldValues");
  if (
    !isRecord(fields) ||
    typeof fields.totalCount !== "number" ||
    !Number.isSafeInteger(fields.totalCount) ||
    fields.totalCount < 0 ||
    !Array.isArray(fields.nodes) ||
    fields.nodes.length !== fields.totalCount ||
    qualificationField(fields.pageInfo, "hasNextPage") !== false
  )
    throw new Error(
      `incomplete GitHub inventory: Project item ${diagnosticText(qualificationField(node, "id"))} fields are truncated`,
    );
  const values: unknown[] = fields.nodes;
  return values
    .map((value) => ({
      name: qualificationField(value, "name"),
      field: { name: qualificationField(qualificationField(value, "field"), "name") },
    }))
    .filter((value) => value.name && value.field.name);
}

function executionReference(node: unknown): node is ExecutionReference {
  return (
    isRecord(node) &&
    typeof node.id === "string" &&
    node.id.length > 0 &&
    typeof node.number === "number" &&
    Number.isSafeInteger(node.number) &&
    node.number > 0 &&
    typeof node.url === "string" &&
    /^https:\/\/github\.com\/[^/]+\/[^/]+\/issues\/\d+$/.test(node.url)
  );
}
function executionHash(value: unknown): value is string {
  return typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
}
function uniqueExecutionReferences(nodes: readonly unknown[]): boolean {
  // Shape validation follows; this keeps the original uniqueness-before-shape order.
  return new Set(nodes.map((node) => qualificationField(node, "id"))).size === nodes.length;
}
export function validateExecutionSnapshot(snapshot: unknown): ExecutionSnapshot {
  if (
    !isRecord(snapshot) ||
    snapshot.schema_version !== 1 ||
    !executionReference(snapshot.issue) ||
    typeof snapshot.repository !== "string" ||
    !/^[^/\s]+\/[^/\s]+$/.test(snapshot.repository) ||
    snapshot.issue.url !==
      `https://github.com/${snapshot.repository}/issues/${snapshot.issue.number}` ||
    !isRecord(snapshot.issue) ||
    !["OPEN", "CLOSED"].some((state) => state === qualificationField(snapshot.issue, "state")) ||
    !executionHash(snapshot.scope_revision) ||
    !isRecord(snapshot.planning) ||
    executionFields.some(
      (name) =>
        !isRecord(snapshot.planning) ||
        !(name in snapshot.planning) ||
        (snapshot.planning[name] !== null && typeof snapshot.planning[name] !== "string"),
    ) ||
    !Array.isArray(snapshot.prerequisites) ||
    !uniqueExecutionReferences(snapshot.prerequisites) ||
    !isRecord(snapshot.organization) ||
    !Array.isArray(snapshot.dependents) ||
    !uniqueExecutionReferences(snapshot.dependents) ||
    !Array.isArray(snapshot.organization.children) ||
    !uniqueExecutionReferences(snapshot.organization.children)
  )
    throw new Error("invalid consumed requirements snapshot");
  const prerequisites: unknown[] = snapshot.prerequisites;
  const dependents: unknown[] = snapshot.dependents;
  const children: unknown[] = snapshot.organization.children;
  if (
    prerequisites.some(
      (node) =>
        !executionReference(node) ||
        !isRecord(node) ||
        !executionHash(node.scope_revision) ||
        !["OPEN", "CLOSED"].some((state) => state === node.state) ||
        (node.status !== null && typeof node.status !== "string"),
    ) ||
    dependents.some((node) => !executionReference(node)) ||
    children.some((node) => !executionReference(node)) ||
    (snapshot.organization.parent !== null && !executionReference(snapshot.organization.parent))
  )
    throw new Error("invalid consumed requirements snapshot");
  const { revision, ...inputs } = snapshot;
  if (revision !== digest(inputs)) throw new Error("consumed snapshot identity is invalid");
  // Complete field and nested reference validation above precedes this boundary projection.
  return snapshot as Record<string, unknown> & ExecutionSnapshot;
}

export function compareExecutionSnapshots(currentInput: unknown, consumedInput: unknown = null) {
  const current = validateExecutionSnapshot(currentInput);
  if (!consumedInput)
    return {
      state: "unknown",
      changes: [],
      action: "Read current requirements; no consumed revision was established.",
    };
  const consumed = validateExecutionSnapshot(consumedInput);
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

function hasConsumptionRecord<T extends { record: ConsumptionRecord | null }>(
  entry: T,
): entry is T & { record: ConsumptionRecord } {
  return entry.record !== null;
}
interface ConsumptionRecord {
  schema_version: 1;
  kind: "consumed-requirements";
  runner: string;
  action: string;
  evidence: string;
  observation_revision: string;
  snapshot: ExecutionSnapshot;
  coordination_target?: unknown;
}
export function parseConsumptionRecord(body: unknown): ConsumptionRecord | null {
  if (!String(body).startsWith(consumptionMarker)) return null;
  const lines = String(body).replace(/\r\n/g, "\n").split("\n");
  if (lines[0] !== consumptionMarker || lines[1] !== "```json" || lines[3] !== "```")
    throw new Error("incomplete roadmap consumption record");
  const json = lines[2];
  if (json === undefined) throw new Error("incomplete roadmap consumption record");
  const record: unknown = JSON.parse(json);
  if (
    !isRecord(record) ||
    record.schema_version !== 1 ||
    record.kind !== "consumed-requirements" ||
    !executionHash(record.observation_revision) ||
    [record.runner, record.action, record.evidence].some(
      (value) => typeof value !== "string" || !value.trim(),
    )
  )
    throw new Error("invalid roadmap consumption record");
  const snapshot = validateExecutionSnapshot(record.snapshot);
  if (record.coordination_target) validateCoordinationTarget(record.coordination_target, snapshot);
  return record as Record<string, unknown> & ConsumptionRecord;
}

export function deriveExecutionContext(
  config: RoadmapConfig,
  item: CanonicalProjectIssue,
  relationships: ExecutionRelationships,
  {
    runner,
    comments,
    coverage,
    consumed = null,
    reservation = null,
    target = null,
  }: {
    runner: unknown;
    comments: readonly RoadmapComment[];
    coverage: unknown;
    consumed?: unknown;
    reservation?: object | null;
    target?: ReturnType<typeof coordinationTarget> | null;
  },
) {
  const snapshot = executionSnapshot(config, item, relationships);
  target ??= coordinationTarget(config, snapshot.issue.number);
  validateCoordinationTarget(target, snapshot);
  const observation_revision = executionObservation(item, relationships);
  const latest = comments
    .map((comment) => ({ comment, record: matchingConsumption(comment, snapshot, runner, target) }))
    .filter(hasConsumptionRecord)
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
            "reference only; verify actual writer activity, source-owner release and current scope",
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

function executionObservation(item: CanonicalProjectIssue, relationships: ExecutionRelationships) {
  return digest({
    scope: [item.content.title, item.content.body],
    prerequisites: relationships.blockedBy
      .map((node) => ({ id: node.id, title: node.title, body: node.body }))
      .sort((a, b) => a.id.localeCompare(b.id)),
  });
}

export function consumedReference(
  comment: RoadmapComment,
  {
    repository,
    runner,
    issue,
    target = null,
  }: {
    repository: string;
    runner: unknown;
    issue: number;
    target?: ReturnType<typeof coordinationTarget> | null;
  },
) {
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

function executionOptions(parsed: ReturnType<typeof parseArguments>, allowed: readonly string[]) {
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

export function executionQueueData(items: readonly RoadmapIssueItem[]) {
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
        Number(qualificationField(item.content?.blockedBy, "totalCount") ?? 0) ===
        blockingNodes(item).length
          ? "complete"
          : "incomplete",
      prerequisites: blockingNodes(item).map((node) => node.number),
      reservation: "unknown",
      execution_capability: "not assessed",
    })),
  };
}

export function executeCommitmentRename({
  client,
  config,
  apply = false,
}: {
  client: {
    fieldList(number: number): ProjectCollection<ProjectField>;
    itemList(number: number): RoadmapIssueItem[];
    sampleGraphqlRate(): Pick<SetManyRate, "remaining"> & { resetAt?: string };
    updateField(id: string, options: ProjectFieldOption[]): unknown;
  };
  config: RoadmapConfig;
  apply?: boolean;
}) {
  const number = config.project.number;
  const desired = config.fields.find((field) => field.name === "Release commitment");
  if (!desired?.options.includes("Planned") || desired.options.includes("Opportunistic"))
    throw new Error("active configuration must use Required / Planned");
  const fields = unwrapCollection(client.fieldList(number), "fields");
  const step = planFieldReconciliation([desired], fields)[0];
  if (!step) throw new Error("commitment field plan is unavailable");
  if (step.action === "error") throw new Error(step.reason);
  if (step.action !== "keep" && step.action !== "update")
    throw new Error("existing commitment field is required");
  const fieldId = step.actual.id;
  if (!fieldId) throw new Error("existing commitment field identity is required");
  if (!apply)
    return {
      status: "planned",
      field: fieldId,
      action: step.action,
      options: "options" in step ? step.options : step.actual.options,
    };
  const before = client.itemList(number);
  const assignment = (item: RoadmapIssueItem) =>
    item.fieldValues?.find((value) => value.field?.name === desired.name);
  const historical = step.actual.options?.find((option) => option.name === "Opportunistic");
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
      client.updateField(fieldId, step.options);
    } catch (error) {
      mutationError = error;
    }
  }
  const afterFields = unwrapCollection(client.fieldList(number), "fields");
  const afterField = afterFields.find((field) => field.id === step.actual.id);
  if (
    !afterField ||
    planFieldReconciliation([desired], afterFields)[0]?.action !== "keep" ||
    (step.actual.options ?? []).some(
      (option) =>
        !(afterField.options ?? []).some(
          (candidate) =>
            candidate.id === option.id &&
            candidate.name === (option.name === "Opportunistic" ? "Planned" : option.name),
        ),
    )
  )
    throw new Error(
      `commitment rename readback failed${mutationError ? `: ${errorMessage(mutationError)}` : ""}`,
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
    option: historical?.id ?? afterField.options?.find((option) => option.name === "Planned")?.id,
    assignmentsVerified: after.length,
    alreadyApplied: step.action === "keep",
    reconciledAfterError: Boolean(mutationError),
  };
}

function uniqueItems<T extends RoadmapIssueItem>(items: readonly T[]): T[] {
  return [
    ...new Map(
      items.map((item) => [item?.id ?? `issue:${issueNumber(item) ?? itemTitle(item)}`, item]),
    ).values(),
  ];
}

export function dependencyCycles(items: readonly RoadmapIssueItem[]) {
  const byNumber = new Map(
    items
      .map((item) => [issueNumber(item), item] as const)
      .filter(([number]) => Number.isInteger(number)),
  );
  const cycles: number[][] = [];
  const completed = new Set<number>();
  const visiting: number[] = [];
  const visit = (item: RoadmapIssueItem) => {
    const number = issueNumber(item);
    if (number === null || !Number.isInteger(number) || completed.has(number)) return;
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

export function analyzeReleaseReadiness(
  items: readonly RoadmapIssueItem[],
  release: string,
  {
    candidateIssues = null,
    risk706Approval = JSON.parse(
      readFileSync(path.join(projectRoot, ".github/linux-beta-risk-706.json"), "utf8"),
    ),
    risk706Evidence = null,
    now = new Date().toISOString(),
  }: {
    candidateIssues?: readonly number[] | null;
    risk706Approval?: unknown;
    risk706Evidence?: unknown;
    now?: string;
  } = {},
) {
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
          !itemDone(item) &&
          legacyReleaseSequence.some((target) => target === fieldValue(item, "Target release")),
      )
    : [];
  let unassignedRequired = items.filter(
    (item) =>
      fieldValue(item, "Release commitment") === "Required" &&
      ![...releaseSequence, "Post-V1", "Post-1.0"].some(
        (target) => target === fieldValue(item, "Target release"),
      ),
  );
  const targeted = items.filter((item) =>
    candidateIssues
      ? candidateIssues.some((number) => number === issueNumber(item))
      : includedReleases.some((target) => target === fieldValue(item, "Target release")),
  );
  const requiredRoots = candidateIssues
    ? targeted
    : targeted.filter((item) => fieldValue(item, "Release commitment") === "Required");
  const relevantUnclassified = targeted.filter((item) => !fieldValue(item, "Release commitment"));
  let approvedPlanning706 = false;
  try {
    // Planning identity is stable after expiry; only the actual release evaluator checks time.
    validateApproval706(risk706Approval, qualificationField(risk706Approval, "approvedAt"));
    approvedPlanning706 = release === "Public beta" && !candidateIssues;
  } catch {
    /* Missing or altered canonical record retains the ordinary safety rules. */
  }
  const scopedRemediation706 = targeted.filter(
    (item) =>
      approvedPlanning706 &&
      [49, 706].some((number) => number === issueNumber(item)) &&
      itemUrl(item) === `https://github.com/boburning/portcove/issues/${issueNumber(item)}` &&
      fieldValue(item, "Target release") === "Public beta" &&
      fieldValue(item, "Platform") === "Linux" &&
      fieldValue(item, "Status") === "Blocked" &&
      fieldValue(item, "Work type") === "Security" &&
      fieldValue(item, "Release commitment") === "Planned" &&
      !itemDone(item),
  );
  // Planning is not candidate eligibility. Only the existing complete release evaluator
  // may satisfy these two still-open remediation nodes for this ordinary Linux candidate.
  let candidateDisposition706: ReturnType<typeof decide706> | null = null;
  if (risk706Evidence) {
    if (!approvedPlanning706 || !isRecord(risk706Evidence) || risk706Evidence.purpose !== "release")
      throw new Error(
        "#706 candidate disposition applies only to ordinary Public beta release readiness",
      );
    candidateDisposition706 = decide706({
      ...risk706Evidence,
      candidate: risk706Evidence.candidate,
      scan: risk706Evidence.scan,
      releases: risk706Evidence.releases,
      purpose: "release",
      approval: risk706Approval,
      now,
    });
  }
  const pendingRiskDispositions = candidateDisposition706 ? [] : scopedRemediation706;
  const safetyConflicts = targeted.filter(
    (item) =>
      !itemDone(item) &&
      fieldValue(item, "Status") === "Blocked" &&
      fieldValue(item, "Work type") === "Security" &&
      fieldValue(item, "Release commitment") !== "Required" &&
      !scopedRemediation706.includes(item),
  );
  const planned = targeted.filter((item) =>
    ["Planned", "Opportunistic"].some(
      (commitment) => commitment === fieldValue(item, "Release commitment"),
    ),
  );
  const byNumber = new Map(
    items
      .map((item) => [issueNumber(item), item] as const)
      .filter(([number]) => Number.isInteger(number)),
  );
  const effective = new Map<string, RoadmapIssueItem>();
  const dependencyConflicts: {
    item: RoadmapIssueItem;
    dependency: RoadmapIssueItem;
    commitment: unknown;
    target: unknown;
  }[] = [];
  const missingProjectDependencies: { item: RoadmapIssueItem; dependency: RoadmapIssueItem }[] = [];
  const truncatedDependencies: RoadmapIssueItem[] = [];
  const visit = (item: RoadmapIssueItem) => {
    const key = item?.id ?? `issue:${issueNumber(item) ?? itemTitle(item)}`;
    if (effective.has(key)) return;
    effective.set(key, item);
    const blockedBy = item?.content?.blockedBy ?? item?.blockedBy;
    if (Number(qualificationField(blockedBy, "totalCount") ?? 0) > blockingNodes(item).length) {
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
          : commitment !== "Required" || !includedReleases.some((release) => release === target)
      ) {
        if (
          !(
            scopedRemediation706.includes(item) &&
            scopedRemediation706.includes(projectItem) &&
            issueNumber(item) === 49 &&
            number === 706
          )
        )
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
  for (const item of uniqueItems([...requiredRoots, ...safetyConflicts, ...scopedRemediation706]))
    visit(item);
  const effectiveRequired = [...effective.values()];
  if (candidateIssues)
    unassignedRequired = unassignedRequired.filter((item) => effectiveRequired.includes(item));
  const cycles = dependencyCycles(effectiveRequired.filter((item) => !item.missingProject));
  const unfinishedRequired = effectiveRequired.filter(
    (item) => !itemDone(item) && !(candidateDisposition706 && scopedRemediation706.includes(item)),
  );
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
    scopedRemediation706,
    pendingRiskDispositions,
    candidateDisposition706,
    dependencyConflicts,
    missingProjectDependencies,
    truncatedDependencies,
    cycles,
    migrationConflicts,
    unassignedRequired,
    statusConflicts,
    ready:
      pendingRiskDispositions.length === 0 &&
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

export function renderReadinessSummary(analysis: ReturnType<typeof analyzeReleaseReadiness>) {
  const section = (values: readonly RoadmapIssueItem[]) =>
    values.length ? values.map(itemLine).join("\n") : "- None recorded.";
  const dependencyConflicts = analysis.dependencyConflicts.map(
    ({ item, dependency, commitment, target }) =>
      `- ${markdownLink(item)} depends on ${markdownLink(dependency)}, classified ${diagnosticText(commitment ?? "Unclassified")} / ${diagnosticText(target ?? "Unscheduled")}.`,
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
  return `# ${analysis.release} readiness\n\n- Result: ${analysis.ready ? "READY" : "NOT READY"}\n- Required outcomes including blocking dependencies: ${analysis.effectiveRequired.length}\n- Unfinished required outcomes: ${analysis.unfinishedRequired.length}\n\n## Unfinished required outcomes\n\n${section(analysis.unfinishedRequired)}\n\n## Relevant unclassified work\n\n${section(analysis.relevantUnclassified)}\n\n## Scoped Linux beta disposition\n\n${section(analysis.scopedRemediation706)}\n\n${analysis.candidateDisposition706 ? `Exact candidate ${analysis.candidateDisposition706.candidate}: accepted risk under ${analysis.candidateDisposition706.approvalUrl}; raw scan remains failed.` : analysis.pendingRiskDispositions.length ? 'Pending: run readiness --release "Public beta" --linux-beta-706 against the actual candidate with its reviewed GITHUB_REF_NAME. Planned remediation alone does not establish eligibility.' : "No scoped disposition recorded."}\n\n## Safety commitment conflicts\n\n${section(analysis.safetyConflicts)}\n\n## Dependency classification conflicts\n\n${[...dependencyConflicts, ...missing, ...truncated].join("\n") || "- None recorded."}\n\n## Dependency cycles\n\n${cycles.join("\n") || "- None recorded."}\n\n## Planned work through this release\n\n${section(analysis.planned)}\n`;
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

function markdownLink(item: RoadmapIssueItem) {
  const url = itemUrl(item);
  const title = itemTitle(item).replaceAll("[", "\\[").replaceAll("]", "\\]");
  return url ? `[${title}](${url})` : title;
}

function itemLine(item: RoadmapIssueItem) {
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
    .map((name) =>
      fieldValue(item, name) ? `${name}: ${diagnosticText(fieldValue(item, name))}` : null,
    )
    .filter(Boolean)
    .join("; ");
  return `- ${markdownLink(item)}${details ? ` — ${details}` : ""}`;
}

export function completionEvidenceLinks(items: readonly RoadmapIssueItem[]) {
  const urls = new Set<string>();
  for (const item of items) {
    const body = itemBody(item);
    const heading = body.match(/^## Completion evidence\s*$/im);
    const start = heading ? (heading.index ?? 0) + heading[0].length : -1;
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

export function renderSnapshot({
  release,
  generatedAt,
  commit,
  projectUrl,
  items,
  catalog,
}: {
  release: string;
  generatedAt: string;
  commit: string;
  projectUrl: string;
  items: readonly RoadmapIssueItem[];
  catalog: QualificationCatalogObservation;
}) {
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
      ["Post-V1", "Post-1.0"].some((target) => target === fieldValue(item, "Target release")),
  );
  const summary = catalogQualificationSummary(catalog);
  const tiers =
    Object.entries(summary.byTier)
      .sort((left, right) => {
        const a = `${left[0]},${left[1]}`;
        const b = `${right[0]},${right[1]}`;
        return a < b ? -1 : a > b ? 1 : 0;
      })
      .map(([name, count]) => `  - ${name}: ${count}`)
      .join("\n") || "  - none";
  const section = (values: readonly RoadmapIssueItem[]) =>
    values.length ? values.map(itemLine).join("\n") : "- None recorded.";
  const links = completionEvidenceLinks(matching);
  const conflictLines = readiness.dependencyConflicts.map(
    ({ item, dependency, commitment, target }) =>
      `- ${markdownLink(item)} depends on ${markdownLink(dependency)}, classified ${diagnosticText(commitment ?? "Unclassified")} / ${diagnosticText(target ?? "Unscheduled")}.`,
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
  return `# ${release} release readiness\n\n> Immutable snapshot generated from the live Portcove Roadmap and catalog. Project fields and genuine blocking dependencies define readiness after ${generatedAt}.\n\n- Generated: ${generatedAt}\n- Commit: \`${commit}\`\n- Project: ${projectUrl}\n- Target release: ${release}\n- Cumulative required stages: ${includedReleases.join(", ")}\n- Derived readiness: ${readiness.ready ? "READY" : "NOT READY"}\n\n## Open blockers\n\n${section(blockers)}\n\n## Completed required items\n\n${section(complete)}\n\n## Unfinished required items\n\n${section(unfinished)}\n\n## Relevant unclassified work\n\n${section(readiness.relevantUnclassified)}\n\n## Scoped Linux beta disposition\n\n${section(readiness.scopedRemediation706)}\n\nCandidate decision remains separate; Planned remediation alone does not establish eligibility.\n\n## Commitment and dependency conflicts\n\n${[...readiness.safetyConflicts.map(itemLine), ...conflictLines].join("\n") || "- None recorded."}\n\n## Planned work through this release\n\n${section(readiness.planned)}\n\n## Repository closure and Project Status inconsistencies\n\n${section(inconsistencies)}\n\nA closed or not-planned repository issue is not complete unless Project Status is Done. Resolve every inconsistency before release.\n\n## Consciously deferred or postponed\n\n${section(deferred)}\n\n## Catalog qualification summary\n\n- Catalog entries: ${summary.ports}\n- Declared port/platform pairs: ${summary.declaredPlatformPairs}\n- Automated port/platform pairs: ${summary.automatedPlatformPairs}\n- Manually validated port/platform pairs: ${summary.manuallyValidatedPlatformPairs}\n- Support tiers:\n${tiers}\n\n## Completion evidence links\n\n${links.length ? links.map((url) => `- ${url}`).join("\n") : "- No explicit completion evidence links were recorded on matching Project items."}\n\n## Test, CI, rehearsal, signing, and human validation\n\n- Record reviewed test commands and results here.\n- Record required CI runs here.\n- Record release rehearsal evidence here.\n- Record signing/notarization evidence or the explicit unsigned limitation here.\n- Record required human and physical-platform evidence here.\n\n## Explicit limitations\n\n- Review every unfinished, unclassified, conflicting, and deferred item above before publication.\n- This snapshot does not grant qualification or replace catalog evidence.\n- Project fields may change after generation; regenerate rather than editing this snapshot in place.\n`;
}

interface ProjectFieldOption {
  id?: string;
  name: string;
  color?: string | null;
  description?: string | null;
}
interface ProjectField {
  id?: string;
  name: string;
  dataType?: string;
  type?: string;
  __typename?: string;
  options?: ProjectFieldOption[];
}
type ProjectCollection<T> =
  | readonly T[]
  | { fields?: readonly T[]; nodes?: readonly T[]; projects?: readonly T[] }
  | null
  | undefined;
function unwrapCollection<T>(
  value: ProjectCollection<T>,
  key: "fields" | "nodes" | "projects",
): readonly T[];
function unwrapCollection(value: unknown, key: string): readonly unknown[];
function unwrapCollection(value: unknown, key: string): readonly unknown[] {
  if (Array.isArray(value)) return value;
  const selected = qualificationField(value, key);
  if (Array.isArray(selected)) return selected;
  const nodes = qualificationField(value, "nodes");
  return Array.isArray(nodes) ? nodes : [];
}

type FieldReconciliation =
  | { action: "create"; desired: RoadmapFieldDefinition }
  | { action: "error"; desired: RoadmapFieldDefinition; actual: ProjectField; reason: string }
  | { action: "keep"; desired: RoadmapFieldDefinition; actual: ProjectField }
  | {
      action: "update";
      desired: RoadmapFieldDefinition;
      actual: ProjectField;
      options: ProjectFieldOption[];
    };

export function planFieldReconciliation(
  desiredFields: readonly RoadmapFieldDefinition[],
  actualResult: ProjectCollection<ProjectField>,
  { freshProject = false }: { freshProject?: boolean } = {},
): FieldReconciliation[] {
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

interface ProjectView {
  id?: string;
  number?: number;
  name: string;
  layout?: string;
  filter?: unknown;
  fields?: ProjectCollection<{ id?: string; name?: string }>;
  groupByFields?: { nodes: { name: string }[] };
  verticalGroupByFields?: { nodes: { name: string }[] };
  sortByFields?: { nodes: { field: { name: string }; direction: string }[] };
}
type ViewReconciliation =
  | { action: "create"; desired: RoadmapViewDefinition; actual: null | undefined }
  | {
      action: "update" | "keep";
      desired: RoadmapViewDefinition;
      actual: ProjectView;
      drift: string[];
    };
export function planViewReconciliation(
  desiredViews: readonly RoadmapViewDefinition[],
  actualViews: readonly ProjectView[],
): ViewReconciliation[] {
  const byName = new Map(actualViews.map((view) => [view.name, view]));
  if (byName.size !== actualViews.length) throw new Error("duplicate actual view names");
  const used = new Set<string>();
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

function visibleFieldNames(view: ProjectView | null | undefined) {
  return unwrapCollection(view?.fields, "fields")
    .map((field) => field.name)
    .filter((name): name is string => Boolean(name));
}

export function viewMachineDrift(
  desired: RoadmapViewDefinition,
  actual: ProjectView | null | undefined,
) {
  const drift = [];
  if (actual?.name !== desired.name) drift.push(`name ${actual?.name} != ${desired.name}`);
  if (actual?.layout !== desired.layout)
    drift.push(`layout ${actual?.layout ?? "missing"} != ${desired.layout}`);
  if (diagnosticText(actual?.filter ?? "") !== desired.filter)
    drift.push(
      `filter ${JSON.stringify(actual?.filter ?? "")} != ${JSON.stringify(desired.filter)}`,
    );
  const expectedFields = [...desired.fields].sort();
  const actualFields = visibleFieldNames(actual).sort();
  if (JSON.stringify(actualFields) !== JSON.stringify(expectedFields)) {
    drift.push(`visible fields ${actualFields.join(", ")} != ${expectedFields.join(", ")}`);
  }
  if (actual?.groupByFields && actual?.verticalGroupByFields && actual?.sortByFields) {
    const groups = (
      desired.layout === "BOARD_LAYOUT" ? actual.verticalGroupByFields : actual.groupByFields
    ).nodes.map((field) => field.name);
    const expectedGroups = desired.manual_group_by ? [desired.manual_group_by] : [];
    if (JSON.stringify(groups) !== JSON.stringify(expectedGroups))
      drift.push(
        `grouping ${groups.join(", ") || "nothing"} != ${expectedGroups.join(", ") || "nothing"} (UI change required)`,
      );
    const otherGroups = (
      desired.layout === "BOARD_LAYOUT" ? actual.groupByFields : actual.verticalGroupByFields
    ).nodes;
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

interface LinkedProjectRepository {
  owner: string | { login?: string };
  name: string;
}
interface ProjectDetails {
  title?: unknown;
  number?: unknown;
  public?: unknown;
  visibility?: unknown;
  url?: string;
  id?: string;
  closed?: unknown;
}
function projectDetailsObservation(value: unknown): ProjectDetails {
  if (
    !isRecord(value) ||
    (value.id !== undefined && typeof value.id !== "string") ||
    (value.url !== undefined && typeof value.url !== "string")
  )
    throw new Error("GitHub Project metadata is malformed");
  return value;
}
export function projectMachineDrift(
  config: RoadmapConfig,
  {
    details,
    fields,
    views,
    repositories,
  }: {
    details: ProjectDetails | null;
    fields: readonly ProjectField[];
    views: readonly ProjectView[];
    repositories?: readonly LinkedProjectRepository[] | null;
  },
) {
  const drift = [];
  if (details?.title !== config.project.title)
    drift.push(`project title is ${JSON.stringify(details?.title)}`);
  if (Number(details?.number) !== config.project.number)
    drift.push(`project number is ${diagnosticText(details?.number)}`);
  const isPublic = details?.public ?? details?.visibility === "PUBLIC";
  if (!isPublic) drift.push("project visibility is not PUBLIC");
  const linked = (repositories ?? []).some(
    (repository) =>
      `${diagnosticText(typeof repository.owner === "string" ? repository.owner : (repository.owner.login ?? repository.owner))}/${repository.name}`.toLowerCase() ===
      config.repository.toLowerCase(),
  );
  if (!linked) drift.push(`repository ${config.repository} is not linked`);
  for (const step of planFieldReconciliation(config.fields, { fields })) {
    if (step.action !== "keep")
      drift.push(`field ${step.desired.name}: ${"reason" in step ? step.reason : step.action}`);
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
        `view ${step.desired.name}: ${step.action}${"drift" in step && step.drift.length ? ` (${step.drift.join("; ")})` : ""}`,
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

interface ProjectContext {
  number: number;
  details: ProjectDetails;
  fields: readonly ProjectField[];
}
function projectFieldObservation(value: unknown): ProjectField {
  if (!isRecord(value) || typeof value.name !== "string")
    throw new Error("incomplete GitHub inventory: malformed Project field");
  for (const key of ["id", "dataType", "type", "__typename"] as const)
    if (value[key] !== undefined && typeof value[key] !== "string")
      throw new Error(`incomplete GitHub inventory: malformed Project field ${key}`);
  if (value.options !== undefined) {
    if (!Array.isArray(value.options))
      throw new Error("incomplete GitHub inventory: malformed Project options");
    const options: unknown[] = value.options;
    for (const option of options) {
      if (
        !isRecord(option) ||
        typeof option.name !== "string" ||
        (option.id !== undefined && typeof option.id !== "string") ||
        (option.color != null && typeof option.color !== "string") ||
        (option.description != null && typeof option.description !== "string")
      )
        throw new Error("incomplete GitHub inventory: malformed Project option");
    }
  }
  return value as Record<string, unknown> & ProjectField;
}
function nestedGitHubField(value: unknown, ...keys: string[]): unknown {
  return keys.reduce<unknown>((current, key) => qualificationField(current, key), value);
}
function issueObservation(value: unknown): RoadmapIssueItem {
  if (!isRecord(value)) throw new Error("incomplete GitHub inventory: malformed issue observation");
  for (const name of ["id", "type", "__typename"] as const) {
    if (value[name] !== undefined && typeof value[name] !== "string")
      throw new Error(`incomplete GitHub inventory: malformed issue ${name}`);
  }
  for (const name of ["title", "body", "url", "state"] as const) {
    if (value[name] != null && typeof value[name] !== "string")
      throw new Error(`incomplete GitHub inventory: malformed issue ${name}`);
  }
  if (
    value.number !== undefined &&
    typeof value.number !== "number" &&
    typeof value.number !== "string"
  )
    throw new Error("incomplete GitHub inventory: malformed issue number");
  if (value.content != null) issueObservation(value.content);
  if (value.blockedBy != null) {
    const blockers = value.blockedBy;
    if (!Array.isArray(blockers) && !isRecord(blockers))
      throw new Error("incomplete GitHub inventory: malformed issue dependencies");
    const nodes: unknown = Array.isArray(blockers)
      ? blockers
      : qualificationField(blockers, "nodes");
    if (nodes !== undefined) {
      if (!Array.isArray(nodes))
        throw new Error("incomplete GitHub inventory: malformed issue dependency nodes");
      const entries: unknown[] = nodes;
      for (const node of entries) issueObservation(node);
    }
    const count = qualificationField(blockers, "totalCount");
    if (count !== undefined && typeof count !== "number")
      throw new Error("incomplete GitHub inventory: malformed issue dependency count");
  }
  if (value.fieldValues !== undefined && !Array.isArray(value.fieldValues))
    throw new Error("incomplete GitHub inventory: malformed normalized issue fields");
  const fields: unknown[] = Array.isArray(value.fieldValues) ? value.fieldValues : [];
  for (const field of fields) {
    if (
      !isRecord(field) ||
      (field.field != null && !isRecord(field.field)) ||
      (field.option != null && !isRecord(field.option))
    )
      throw new Error("incomplete GitHub inventory: malformed normalized issue field");
  }
  // All known fields above have been narrowed; configurable field-name values remain unknown.
  return value;
}
function executionRelationship(value: unknown): ExecutionRelationshipNode {
  if (
    !executionReference(value) ||
    !isRecord(value) ||
    (value.state !== "OPEN" && value.state !== "CLOSED")
  )
    throw new Error("incomplete selected issue identity or state");
  issueObservation(value);
  return value as Record<string, unknown> & ExecutionRelationshipNode;
}
function identifiedProjectItem(value: unknown) {
  const item = issueObservation(value);
  if (!item.id) throw new Error("incomplete GitHub inventory: missing Project item identity");
  return { ...item, id: item.id };
}
interface RepositoryIssueObservation {
  node_id: string;
  number: number;
  html_url: string;
  title?: string | null | undefined;
  body?: string | null | undefined;
  state?: unknown;
  pull_request?: unknown;
}
function repositoryIssueObservation(value: unknown): RepositoryIssueObservation {
  if (
    !isRecord(value) ||
    typeof value.node_id !== "string" ||
    !value.node_id ||
    typeof value.number !== "number" ||
    !Number.isSafeInteger(value.number) ||
    value.number < 1 ||
    typeof value.html_url !== "string" ||
    !value.html_url ||
    (value.title != null && typeof value.title !== "string") ||
    (value.body != null && typeof value.body !== "string")
  )
    throw new Error("incomplete GitHub inventory: malformed repository issue");
  return value as Record<string, unknown> & RepositoryIssueObservation;
}
export class RoadmapClient {
  readonly config: RoadmapConfig;
  readonly api: GitHubApiClient;
  graphqlRate: unknown = null;
  _executionProject: ProjectDetails | null | undefined;
  _projectContext: ProjectContext | undefined;
  _completeProjectContext: ProjectContext | undefined;
  _ownerType: "User" | "Organization" | undefined;
  constructor(
    config: RoadmapConfig,
    api: GitHubApiClient | GitHubRunner = new GitHubApiClient(
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

  gh(args: readonly string[], input?: string) {
    return this.api.command(args, input);
  }

  json(args: readonly string[], input?: string): unknown {
    const output = this.gh(args, input);
    return output ? JSON.parse(output) : null;
  }

  graphql(query: string, variables: Readonly<Record<string, unknown>> = {}): unknown {
    try {
      const result = this.api.graphql(query, variables);
      if (result.rateLimit.remaining !== null || result.rateLimit.used !== null)
        this.graphqlRate = result.rateLimit;
      return result.data;
    } catch (error) {
      if (isRecord(error) && error.rateLimit) this.graphqlRate = error.rateLimit;
      throw error;
    }
  }

  sampleGraphqlRate() {
    const rate = qualificationField(
      this.graphql("query { rateLimit { cost limit remaining resetAt used } }"),
      "rateLimit",
    );
    if (
      !isRecord(rate) ||
      typeof rate.remaining !== "number" ||
      !Number.isSafeInteger(rate.remaining) ||
      typeof rate.used !== "number" ||
      !Number.isSafeInteger(rate.used) ||
      typeof rate.resetAt !== "string"
    ) {
      throw new Error("GitHub GraphQL rate-limit metadata is unavailable");
    }
    const observed = {
      resource: "graphql",
      ...rate,
      remaining: rate.remaining,
      used: rate.used,
      resetAt: rate.resetAt,
    };
    this.graphqlRate = observed;
    return observed;
  }

  readInventory(
    query: string,
    variables: Readonly<Record<string, unknown>>,
    connection: (data: unknown) => unknown,
    identity: (node: unknown) => unknown,
  ): unknown[] {
    const nodes: unknown[] = [];
    const identities = new Set<unknown>();
    const cursors = new Set<string>();
    let after: string | null = null;
    let totalCount: number | undefined;
    for (;;) {
      const page = connection(this.graphql(query, { ...variables, after }));
      if (
        !isRecord(page) ||
        !Array.isArray(page.nodes) ||
        typeof page.totalCount !== "number" ||
        !Number.isSafeInteger(page.totalCount) ||
        page.totalCount < 0 ||
        !isRecord(page.pageInfo) ||
        typeof page.pageInfo.hasNextPage !== "boolean" ||
        !(page.pageInfo.endCursor === null || typeof page.pageInfo.endCursor === "string")
      ) {
        throw new Error("incomplete GitHub inventory: malformed connection or pagination");
      }
      totalCount ??= page.totalCount;
      if (totalCount !== page.totalCount)
        throw new GitHubApiError(
          "inventory_changed",
          `GitHub inventory changed during pagination; discard the read (connection ${typeof variables.id === "string" ? variables.id : "unknown"}, page ${cursors.size + 1}, cursor ${after ?? "initial"}, total ${totalCount} -> ${page.totalCount})`,
          { operation: "readInventory" },
        );
      const pageNodes: unknown[] = page.nodes;
      for (const node of pageNodes) {
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
    ).map(projectDetailsObservation);
  }

  resolveProject({ create = false } = {}) {
    const matches = this.listProjects().filter(
      (project) => project.title === this.config.project.title && project.closed !== true,
    );
    if (matches.length > 1)
      throw new Error(`multiple open projects named ${this.config.project.title}`);
    if (matches.length === 1 && matches[0]) return { project: matches[0], created: false };
    if (!create) throw new Error(`${this.config.project.title} does not exist; run bootstrap`);
    const project = projectDetailsObservation(
      this.json([
        "project",
        "create",
        "--owner",
        this.config.owner,
        "--title",
        this.config.project.title,
        "--format",
        "json",
      ]),
    );
    return { project, created: true };
  }

  projectNumber(project: ProjectDetails | null | undefined) {
    const number = Number(project?.number ?? this.config.project.number);
    if (!Number.isInteger(number) || number < 1)
      throw new Error("could not determine Project number");
    return number;
  }

  projectDetails(number: number) {
    return projectDetailsObservation(
      this.json([
        "project",
        "view",
        String(number),
        "--owner",
        this.config.owner,
        "--format",
        "json",
      ]),
    );
  }

  fieldList(number: number): ProjectCollection<ProjectField> {
    const result = this.json([
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
    if (result !== null && !Array.isArray(result) && !isRecord(result))
      throw new Error("incomplete GitHub inventory: malformed Project field collection");
    if (isRecord(result)) {
      for (const key of ["fields", "nodes", "projects"] as const) {
        const entries = result[key];
        if (entries === undefined) continue;
        if (!Array.isArray(entries))
          throw new Error("incomplete GitHub inventory: malformed Project field collection");
        const rawFields: unknown[] = entries;
        for (const field of rawFields) projectFieldObservation(field);
      }
    } else if (Array.isArray(result)) {
      const rawFields: unknown[] = result;
      for (const field of rawFields) projectFieldObservation(field);
    }
    return result as ProjectCollection<ProjectField>;
  }

  itemList(
    number: number,
    {
      includeDependencies = false,
      includeBodies = true,
      includeArchived = false,
      pageSize = 50,
      details: suppliedDetails = null,
    }: {
      includeDependencies?: boolean;
      includeBodies?: boolean;
      includeArchived?: boolean;
      pageSize?: 50 | 100;
      details?: ProjectDetails | null;
    } = {},
  ) {
    const details = suppliedDetails ?? this.projectDetails(number);
    if (!details?.id)
      throw new Error("incomplete GitHub inventory: Project identity is unavailable");
    const dependencies = includeDependencies
      ? "blockedBy(first: 10) { totalCount nodes { id number title url state } }"
      : "";
    const body = includeBodies ? "body" : "";
    const archive = includeArchived ? "archivedStates: [ARCHIVED, NOT_ARCHIVED]," : "";
    const query = `query($id: ID!, $after: String) { node(id: $id) { ... on ProjectV2 { items(first: ${pageSize}, ${archive} after: $after) { totalCount nodes { id isArchived content { __typename ... on DraftIssue { id updatedAt title ${body} } ... on Issue { id number updatedAt title ${body} url state ${dependencies} } ... on PullRequest { id number updatedAt title ${body} url state merged } } fieldValues(first: 25) { totalCount nodes { ... on ProjectV2ItemFieldSingleSelectValue { name field { ... on ProjectV2SingleSelectField { name } } } } pageInfo { hasNextPage endCursor } } } pageInfo { hasNextPage endCursor } } } } }`;
    return this.readInventory(
      query,
      { id: details.id },
      (data) => nestedGitHubField(data, "node", "items"),
      (node) => qualificationField(node, "id"),
    ).map((node) => {
      if (!isRecord(node) || typeof node.id !== "string")
        throw new Error("incomplete GitHub inventory: malformed Project item identity");
      const sourceContent = node.content ? issueObservation(node.content) : null;
      const content = sourceContent
        ? {
            ...sourceContent,
            ...(sourceContent.__typename === undefined ? {} : { type: sourceContent.__typename }),
          }
        : null;
      return issueObservation({
        ...node,
        title: content?.title,
        type: content?.type,
        content,
        fieldValues: projectFieldValues(node),
      });
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
      if (response.body.length === 0) return 0;
      const number: unknown = qualificationField(response.body[0], "number");
      if (
        response.body.length !== 1 ||
        typeof number !== "number" ||
        !Number.isSafeInteger(number) ||
        number < 1
      )
        throw new Error("incomplete GitHub inventory: invalid repository issue marker");
      return number;
    };
    const highWater = marker();
    const records = this.api
      .paginateRest(
        `repos/${this.config.repository}/issues?state=all&sort=created&direction=asc&per_page=100`,
        {
          identity: (record) =>
            isRecord(record) && typeof record.node_id === "string" && record.node_id
              ? record.node_id
              : null,
          label: "repository issue inventory",
        },
      )
      .map(repositoryIssueObservation);
    const numbers = new Set<number>();
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
        state: diagnosticText(issue.state ?? "").toUpperCase(),
        type: "Issue",
      }));
  }

  repositoryIssue(number: number) {
    const issue = repositoryIssueObservation(
      this.api.request("GET", `repos/${this.config.repository}/issues/${number}`).body,
    );
    if (!issue?.node_id || !issue?.html_url || issue.pull_request) {
      throw new Error(`repository issue #${number} was not found`);
    }
    return issue;
  }

  executionIssue(number: number): {
    item: CanonicalProjectIssue;
    relationships: ExecutionRelationships;
  } {
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
    const rawIssue = nestedGitHubField(
      this.graphql(query, { owner, name, number }),
      "repository",
      "issue",
    );
    if (!isRecord(rawIssue))
      throw new Error("selected issue identity is unavailable or mismatched");
    const issue = executionRelationship(rawIssue);
    if (
      !issue?.id ||
      issue.number !== number ||
      issue.url !== `https://github.com/${this.config.repository}/issues/${number}`
    )
      throw new Error("selected issue identity is unavailable or mismatched");
    const connection = (
      initial: unknown,
      field: string,
      selection: string,
      source: ExecutionRelationshipNode = issue,
    ): Record<string, unknown>[] => {
      if (
        !isRecord(initial) ||
        typeof initial.totalCount !== "number" ||
        !Number.isSafeInteger(initial.totalCount) ||
        initial.totalCount < 0 ||
        !Array.isArray(initial.nodes) ||
        !isRecord(initial.pageInfo) ||
        typeof initial.pageInfo.hasNextPage !== "boolean"
      )
        throw new Error(`incomplete selected ${field} connection`);
      const identityNode = (node: unknown): Record<string, unknown> => {
        if (!isRecord(node) || typeof node.id !== "string" || !node.id)
          throw new Error(`incomplete selected ${field} connection`);
        return node;
      };
      const rawNodes: unknown[] = initial.nodes;
      const firstNodes = rawNodes.map(identityNode);
      if (
        initial.pageInfo.hasNextPage === false &&
        firstNodes.length === initial.totalCount &&
        new Set(firstNodes.map((node) => node.id)).size === initial.totalCount
      )
        return firstNodes;
      const nodes = this.readInventory(
        `query($id:ID!,$after:String){node(id:$id){...on Issue{${field}(first:100,after:$after){totalCount nodes{${selection}} pageInfo{hasNextPage endCursor}}}}}`,
        { id: source.id },
        (data) => nestedGitHubField(data, "node", field),
        (node) => qualificationField(node, "id"),
      ).map(identityNode);
      if (nodes.length !== initial.totalCount)
        throw new Error("selected relationships changed during collection");
      return nodes;
    };

    const projectItem = (source: ExecutionRelationshipNode) => {
      const records = connection(
        source.projectItems,
        "projectItems",
        `${fields} project{id}`,
        source,
      );
      const matches = records.filter(
        (node) => qualificationField(node.project, "id") === project.id,
      );
      if (matches.length > 1) throw new Error("multiple selected-Project items for one issue");
      return matches[0]
        ? issueObservation({ ...matches[0], fieldValues: projectFieldValues(matches[0]) })
        : null;
    };
    const selected = projectItem(issue);
    if (!selected) throw new Error("selected issue is not in the configured active Project");
    const blockedBy = connection(issue.blockedBy, "blockedBy", `${identity} body ${projectItems}`)
      .map(executionRelationship)
      .map((node) => {
        const status = fieldValue(projectItem(node), "Status") ?? null;
        if (status !== null && typeof status !== "string")
          throw new Error("incomplete selected Project status");
        return { ...node, projectStatus: status };
      });
    return {
      item: { ...selected, title: issue.title, content: { ...issue, type: "Issue" } },
      relationships: {
        blockedBy,
        blocking: connection(issue.blocking, "blocking", identity).map(executionRelationship),
        parent: issue.parent == null ? null : executionRelationship(issue.parent),
        subIssues: connection(issue.subIssues, "subIssues", identity).map(executionRelationship),
      },
    };
  }

  coordinationBinding(target: ReturnType<typeof coordinationTarget>) {
    validateCoordinationTarget(target, {
      repository: this.config.repository,
      issue: { number: target.work_issue },
    });
    const node = this.api.request(
      "GET",
      `repos/${this.config.repository}/issues/${target.number}`,
    ).body;
    if (
      !isRecord(node) ||
      node.number !== target.number ||
      node.html_url !== target.url ||
      Boolean(node.pull_request) !== (target.kind === "pull_request") ||
      typeof node.comments !== "number" ||
      !Number.isSafeInteger(node.comments) ||
      node.comments < 0
    )
      throw new Error("coordination issue/PR identity is unavailable or mismatched");
    if (target.kind === "pull_request") {
      const linked = [...diagnosticText(node.body ?? "").matchAll(/(?:^|[\s(,])#(\d+)\b/g)].some(
        (match) => Number(match[1]) === target.work_issue,
      );
      const link = `https://github.com/${this.config.repository}/issues/${target.work_issue}`;
      const linkedUrl = diagnosticText(node.body ?? "")
        .split(link)
        .slice(1)
        .some((suffix) => suffix === "" || /^[\s)\]>"'`#?]/.test(suffix));
      if (!linked && !linkedUrl)
        throw new Error("explicit coordination PR does not reference the selected work issue");
    }
    return { ...node, number: node.number, comments: node.comments };
  }

  coordinationRecords(target: ReturnType<typeof coordinationTarget>) {
    const before = this.coordinationBinding(target).comments;
    const [owner, name] = this.config.repository.split("/");
    const field = target.kind === "pull_request" ? "pullRequest" : "issue";
    const observed = nestedGitHubField(
      this.graphql(
        `query($owner:String!,$name:String!,$number:Int!){repository(owner:$owner,name:$name){${field}(number:$number){url comments(last:50){totalCount nodes{id url body createdAt updatedAt author{login}} pageInfo{hasPreviousPage startCursor}}}}}`,
        { owner, name, number: target.number },
      ),
      "repository",
      field,
    );
    const result = qualificationField(observed, "comments");
    if (
      qualificationField(observed, "url") !== target.url ||
      !isRecord(result) ||
      !Array.isArray(result.nodes) ||
      typeof result.totalCount !== "number" ||
      !Number.isSafeInteger(result.totalCount) ||
      result.totalCount < 0 ||
      result.nodes.length !== Math.min(50, result.totalCount) ||
      !isRecord(result.pageInfo)
    )
      throw new Error("coordination read is unavailable or incomplete");
    const rawNodes: unknown[] = result.nodes;
    const nodes = rawNodes.map((node) => {
      if (
        !isRecord(node) ||
        typeof node.id !== "string" ||
        !node.id ||
        typeof node.body !== "string" ||
        typeof node.url !== "string" ||
        !node.url.startsWith(`${target.url}#issuecomment-`) ||
        !/^[1-9]\d*$/.test(node.url.slice(`${target.url}#issuecomment-`.length)) ||
        typeof node.createdAt !== "string" ||
        !Number.isFinite(Date.parse(node.createdAt)) ||
        typeof node.updatedAt !== "string" ||
        !Number.isFinite(Date.parse(node.updatedAt)) ||
        (node.author != null &&
          (!isRecord(node.author) ||
            (node.author.login != null && typeof node.author.login !== "string")))
      )
        throw new Error("coordination read is unavailable or incomplete");
      return node as Record<string, unknown> &
        RoadmapComment & {
          id: string;
          url: string;
          body: string;
          createdAt: string;
          updatedAt: string;
        };
    });
    if (
      new Set(nodes.map((node) => node.id)).size !== nodes.length ||
      new Set(nodes.map((node) => node.url)).size !== nodes.length ||
      nodes.some((node, index) => {
        const previous = nodes[index - 1];
        return (
          previous !== undefined && Date.parse(node.createdAt) < Date.parse(previous.createdAt)
        );
      }) ||
      result.pageInfo.hasPreviousPage !== result.totalCount > 50 ||
      result.totalCount !== before ||
      this.coordinationBinding(target).comments !== before
    )
      throw new Error("coordination read is unavailable or incomplete");

    return {
      nodes,
      coverage: {
        complete: !result.pageInfo.hasPreviousPage,
        count: result.nodes.length,
        total: result.totalCount,
        meaning: "Bounded recent window; absence remains unknown when older records exist.",
      },
    };
  }

  coordinationComment(url: string, target: ReturnType<typeof coordinationTarget>) {
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
      !isRecord(comment) ||
      comment.html_url !== url ||
      comment.issue_url !==
        `https://api.github.com/repos/${this.config.repository}/issues/${match[3]}`
    )
      throw new Error("coordination comment identity is mismatched");
    if (
      comment.id !== undefined &&
      typeof comment.id !== "string" &&
      typeof comment.id !== "number"
    )
      throw new Error("coordination comment identity is malformed");
    const author = comment.user;
    if (
      author != null &&
      (!isRecord(author) ||
        (author.login !== undefined && author.login !== null && typeof author.login !== "string"))
    )
      throw new Error("coordination comment author is malformed");
    return {
      ...comment,
      url: comment.html_url,
      author: author as { login?: string | null } | null | undefined,
    } as RoadmapComment & { url: string };
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
    if (!isRecord(owner) || (owner.type !== "User" && owner.type !== "Organization"))
      throw new Error(`GitHub owner type is unavailable for ${this.config.owner}`);
    this._ownerType = owner.type;
    return this._ownerType;
  }

  completeProjectContext(number = this.config.project.number) {
    if (this._completeProjectContext?.number === number) return this._completeProjectContext;
    const root = this.ownerType() === "Organization" ? "organization" : "user";
    const query = `query($login: String!, $number: Int!, $after: String) { ${root}(login: $login) { projectV2(number: $number) { id number title url public closed shortDescription readme fields(first: 100, after: $after) { totalCount nodes { __typename ... on ProjectV2Field { id name dataType } ... on ProjectV2SingleSelectField { id name dataType options { id name color description } } ... on ProjectV2IterationField { id name dataType } } pageInfo { hasNextPage endCursor } } } } }`;
    const fields: ProjectField[] = [];
    const identities = new Set<string>();
    const cursors = new Set<string>();
    let after: string | null = null;
    let totalCount: number | null = null;
    let details: ProjectDetails | null = null;
    for (;;) {
      const project = nestedGitHubField(
        this.graphql(query, {
          login: this.config.owner,
          number,
          after,
        }),
        root,
        "projectV2",
      );
      if (!isRecord(project) || typeof project.id !== "string" || !project.id)
        throw new Error(`Project #${number} was not found for ${this.config.owner}`);
      details ??= projectDetailsObservation({
        id: project.id,
        number: project.number,
        title: project.title,
        url: project.url,
        public: project.public,
        closed: project.closed,
        shortDescription: project.shortDescription,
        readme: project.readme,
      });
      const connection = project.fields;
      if (
        !isRecord(connection) ||
        !Array.isArray(connection.nodes) ||
        typeof connection.totalCount !== "number" ||
        !Number.isSafeInteger(connection.totalCount) ||
        connection.totalCount < 0 ||
        !isRecord(connection.pageInfo) ||
        typeof connection.pageInfo.hasNextPage !== "boolean" ||
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
      const rawFields: unknown[] = connection.nodes;
      for (const rawField of rawFields) {
        const field = projectFieldObservation(rawField);
        if (!field.id || identities.has(field.id))
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
    if (!details) throw new Error("incomplete GitHub inventory: Project details are unavailable");
    this._completeProjectContext = { number, details, fields };
    return this._completeProjectContext;
  }

  ensureIssueItem(contentId: string) {
    const { details } = this.projectContext();
    const find = () => {
      const query = `query($id: ID!, $after: String) { node(id: $id) { ... on Issue { projectItems(first: 100, after: $after) { totalCount nodes { id project { id } } pageInfo { hasNextPage endCursor } } } } }`;
      const records = this.readInventory(
        query,
        { id: contentId },
        (data) => nestedGitHubField(data, "node", "projectItems"),
        (item) => qualificationField(item, "id"),
      );
      const memberships = records.map((record) => {
        const item = identifiedProjectItem(record);
        const project = qualificationField(item, "project");
        if (!isRecord(project) || typeof project.id !== "string" || !project.id)
          throw new Error(
            "incomplete GitHub inventory: Project membership identity is unavailable",
          );
        return { item, projectId: project.id };
      });
      const matches = memberships.filter((entry) => entry.projectId === details.id);
      if (matches.length > 1)
        throw new Error("incomplete GitHub inventory: duplicate selected Project membership");
      return matches[0]?.item ?? null;
    };

    const existing = find();
    if (existing) return existing;
    const mutation = `mutation($input: AddProjectV2ItemByIdInput!) { addProjectV2ItemById(input: $input) { item { id } } }`;
    try {
      return identifiedProjectItem(
        nestedGitHubField(
          this.graphql(mutation, {
            input: { projectId: details.id, contentId },
          }),
          "addProjectV2ItemById",
          "item",
        ),
      );
    } catch (error) {
      if (!/already|exists/i.test(errorMessage(error))) throw error;
      const raced = find();
      if (raced) return raced;
      throw error;
    }
  }

  viewList(projectId: string): ProjectView[] {
    const fields = `totalCount nodes { ... on ProjectV2Field { id name } ... on ProjectV2SingleSelectField { id name } ... on ProjectV2IterationField { id name } ... on ProjectV2MultiSelectField { id name } } pageInfo { hasNextPage endCursor }`;
    const query = `query($id: ID!, $after: String) { node(id: $id) { ... on ProjectV2 { id views(first: 100, after: $after) { totalCount nodes { id name number layout filter fields(first: 100) { ${fields} } groupByFields(first: 100) { ${fields} } verticalGroupByFields(first: 100) { ${fields} } sortByFields(first: 100) { totalCount nodes { direction field { ... on ProjectV2Field { id name } ... on ProjectV2SingleSelectField { id name } ... on ProjectV2IterationField { id name } } } pageInfo { hasNextPage endCursor } } } pageInfo { hasNextPage endCursor } } } } }`;
    const views = this.readInventory(
      query,
      { id: projectId },
      (data) => {
        if (nestedGitHubField(data, "node", "id") !== projectId)
          throw new Error("incomplete GitHub inventory: wrong Project view identity");
        return nestedGitHubField(data, "node", "views");
      },
      (view) => qualificationField(view, "id"),
    );
    return views.map((view) => {
      if (
        !isRecord(view) ||
        typeof view.id !== "string" ||
        typeof view.name !== "string" ||
        (view.number !== undefined && typeof view.number !== "number") ||
        (view.layout !== undefined && typeof view.layout !== "string")
      )
        throw new Error("incomplete GitHub inventory: malformed Project view");
      for (const name of [
        "fields",
        "groupByFields",
        "verticalGroupByFields",
        "sortByFields",
      ] as const) {
        const connection = view[name];
        if (
          !isRecord(connection) ||
          typeof connection.totalCount !== "number" ||
          !Number.isSafeInteger(connection.totalCount) ||
          connection.totalCount < 0 ||
          !Array.isArray(connection.nodes) ||
          connection.nodes.length !== connection.totalCount ||
          qualificationField(connection.pageInfo, "hasNextPage") !== false
        ) {
          throw new Error(`incomplete GitHub inventory: view ${view.name} ${name}`);
        }
        const entries: unknown[] = connection.nodes;
        const ids = entries.map((field) =>
          name === "sortByFields"
            ? nestedGitHubField(field, "field", "id")
            : qualificationField(field, "id"),
        );
        if (ids.some((id) => typeof id !== "string" || !id) || new Set(ids).size !== ids.length)
          throw new Error(`incomplete GitHub inventory: view ${view.name} ${name} identities`);
        for (const entry of entries) {
          const selected = name === "sortByFields" ? qualificationField(entry, "field") : entry;
          if (
            !isRecord(selected) ||
            typeof selected.name !== "string" ||
            (name === "sortByFields" && typeof qualificationField(entry, "direction") !== "string")
          )
            throw new Error(`incomplete GitHub inventory: view ${view.name} ${name} fields`);
        }
      }
      return view as Record<string, unknown> & ProjectView;
    });
  }

  projectAudit(projectId: string) {
    const query = `query($id: ID!) { node(id: $id) { ... on ProjectV2 { id number title public repositories(first: 100) { nodes { name owner { login } } } } } }`;
    return qualificationField(this.graphql(query, { id: projectId }), "node");
  }

  editProject(number: number) {
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

  updateField(fieldId: string, options: readonly ProjectFieldOption[]) {
    const query = `mutation($input: UpdateProjectV2FieldInput!) { updateProjectV2Field(input: $input) { projectV2Field { ... on ProjectV2SingleSelectField { id name options { id name } } } } }`;
    const singleSelectOptions = options.map((option) => ({
      ...(option.id ? { id: option.id } : {}),
      name: option.name,
      color: option.color ?? "GRAY",
      description: option.description ?? "",
    }));
    this.graphql(query, { input: { fieldId, singleSelectOptions } });
  }

  reconcileFields(number: number, { freshProject = false }: { freshProject?: boolean } = {}) {
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
        if (!step.actual.id) throw new Error("existing Project field identity is unavailable");
        this.updateField(step.actual.id, step.options);
      }
    }
    return plan;
  }

  reconcileViews(projectId: string, fieldResult: ProjectCollection<ProjectField>) {
    const fields = unwrapCollection(fieldResult, "fields");
    const fieldIds = new Map(fields.map((field) => [field.name, field.id]));
    const plan = planViewReconciliation(materializeViews(this.config), this.viewList(projectId));
    for (const step of plan) {
      if ("drift" in step && step.drift.some((value) => value.includes("UI change required")))
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
        `view readback did not match configuration: ${failed.map((step) => `${step.desired.name}: ${"drift" in step ? step.drift.join("; ") : step.action}`).join(", ")}`,
      );
    }
    for (const step of plan.filter(
      (candidate): candidate is Extract<ViewReconciliation, { actual: ProjectView }> =>
        candidate.actual != null,
    )) {
      if (saved.find((view) => view.name === step.desired.name)?.id !== step.actual.id)
        throw new Error(`view readback changed identity: ${step.desired.name}`);
    }
    return plan;
  }

  removeFreshDefaultView(projectId: string, created: boolean) {
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
      if (!/already|exists|linked/i.test(errorMessage(error))) throw error;
    }
    const fieldPlan = this.reconcileFields(number, { freshProject: created });
    const details = this.projectDetails(number);
    const fields = this.fieldList(number);
    const projectId = details.id ?? project.id;
    if (!projectId) throw new Error("Project identity is unavailable after bootstrap");
    const viewPlan = this.reconcileViews(projectId, fields);
    const removedDefaultView = this.removeFreshDefaultView(projectId, created);
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

  setFields(reference: string, values: Readonly<Record<string, string>>) {
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

  resolveItemReference(
    items: readonly RoadmapIssueItem[],
    reference: string,
  ): RoadmapIssueItem & { id: string } {
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
    const selected = matches[0];
    if (!selected || typeof selected.id !== "string" || !selected.id)
      throw new Error(`Project item identity is unavailable: ${reference}`);
    return { ...selected, id: selected.id };
  }

  setItemFields(itemId: string, values: Readonly<Record<string, string>>) {
    const context = this.projectContext();
    const inputs = [];
    for (const [fieldName, value] of Object.entries(values)) {
      inputs.push(this.fieldMutationInput(context, itemId, fieldName, value));
    }
    this.mutateFieldInputs(inputs);
  }

  fieldMutationInput(
    { details, fields }: ProjectContext,
    itemId: string,
    fieldName: string,
    value: unknown,
  ) {
    const field = fields.find((candidate) => candidate.name === fieldName);
    if (!field) throw new Error(`Project field not found: ${fieldName}`);
    const option = field.options?.find((candidate) => candidate.name === value);
    if (!option) throw new Error(`Project option not found: ${fieldName}=${diagnosticText(value)}`);
    if (!details.id || !field.id || !option.id)
      throw new Error(`Project field identity is unavailable: ${fieldName}`);
    return {
      projectId: details.id,
      itemId,
      fieldId: field.id,
      value: { singleSelectOptionId: option.id },
    };
  }

  mutateFieldInputs(inputs: readonly ReturnType<RoadmapClient["fieldMutationInput"]>[]) {
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

  planSetMany(spec: unknown): SetManyPlan<ProjectContext> {
    const validated = validateSetManySpec(this.config, spec);
    const context = this.completeProjectContext();
    const items = this.itemList(context.number, {
      includeDependencies: true,
      details: context.details,
    });
    const pending: SetManyAssignment[] = [];
    const alreadyApplied: SetManyAssignment[] = [];
    const itemFields = new Set<string>();
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

  applySetMany(
    plan: SetManyPlan<ProjectContext>,
    changes: readonly SetManyAssignment[] = plan.pending,
  ) {
    const inputs = changes.map((change) =>
      this.fieldMutationInput(plan.context, change.itemId, change.fieldName, change.to),
    );
    this.mutateFieldInputs(inputs);
  }

  readSetManyItems(plan: {
    pending: readonly { itemId: string }[];
    alreadyApplied: readonly { itemId: string }[];
  }): Map<string, RoadmapFieldValue[]> {
    const ids = [
      ...new Set([...plan.pending, ...plan.alreadyApplied].map((change) => change.itemId)),
    ];
    if (!ids.length) return new Map();
    const query = `query($ids: [ID!]!) { nodes(ids: $ids) { ... on ProjectV2Item { id fieldValues(first: 100) { totalCount nodes { ... on ProjectV2ItemFieldSingleSelectValue { name field { ... on ProjectV2SingleSelectField { name } } } } pageInfo { hasNextPage endCursor } } } } }`;
    const nodes = qualificationField(this.graphql(query, { ids }), "nodes");
    if (!Array.isArray(nodes) || nodes.length !== ids.length)
      throw new Error("incomplete GitHub inventory: set-many readback item count differs");
    const results = new Map<string, RoadmapFieldValue[]>();
    const rawNodes: unknown[] = nodes;
    for (const node of rawNodes) {
      if (
        !isRecord(node) ||
        typeof node.id !== "string" ||
        !node.id ||
        results.has(node.id) ||
        !isRecord(node.fieldValues) ||
        typeof node.fieldValues.totalCount !== "number" ||
        !Number.isSafeInteger(node.fieldValues.totalCount) ||
        node.fieldValues.totalCount < 0 ||
        !Array.isArray(node.fieldValues.nodes) ||
        node.fieldValues.nodes.length !== node.fieldValues.totalCount ||
        qualificationField(node.fieldValues.pageInfo, "hasNextPage") !== false
      ) {
        throw new Error("incomplete GitHub inventory: malformed or truncated set-many readback");
      }
      const fieldValues = projectFieldValues(node);
      results.set(node.id, fieldValues);
    }
    for (const id of ids) {
      if (!results.has(id))
        throw new Error(`incomplete GitHub inventory: set-many readback omitted ${id}`);
    }
    return results;
  }

  verifySetMany<Change extends Pick<SetManyAssignment, "itemId" | "fieldName" | "to">>(plan: {
    pending: readonly Change[];
    alreadyApplied: readonly Change[];
    context?: unknown;
  }) {
    const items = this.readSetManyItems(plan);
    return [...plan.pending, ...plan.alreadyApplied].map((change) => {
      const observed =
        fieldValue({ fieldValues: items.get(change.itemId) }, change.fieldName) ?? null;
      return { ...change, observed, verified: observed === change.to };
    });
  }

  capture({
    title,
    body,
    fields,
  }: {
    title: string;
    body: string;
    fields: Readonly<Record<string, string>>;
  }) {
    validateGitHubBody(body);
    const number = this.config.project.number;
    const item = identifiedProjectItem(
      this.json([
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
      ]),
    );
    this.setFields(item.id, fields);
    return item;
  }

  createPortIssue({
    title,
    upstream,
    catalogId,
    portKey,
    onIssueCreated = () => {},
    inventory,
    body: suppliedBody,
  }: {
    title: string;
    upstream: string;
    catalogId?: string | null | undefined;
    portKey?: string | null | undefined;
    onIssueCreated?: (issue: RepositoryIssueObservation) => void;
    inventory?: RoadmapInventory;
    body?: string;
  }) {
    const issueTitle = `[Port] ${title}`;
    const issues = inventory
      ? requireRoadmapInventory(inventory, this.config.repository, this).issues
      : this.repositoryIssues();
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
    const body = suppliedBody ?? renderPortIssueBody({ title, upstream, catalogId, portKey });
    validateDurableIssueBody(body);
    if (reconcilePortIssueMarkers(body, { upstream, catalogId, portKey }) !== body)
      throw new Error("Intake body differs from reviewed canonical markers");
    if (inventory) invalidateRoadmapInventory(inventory);
    const issue = repositoryIssueObservation(
      this.api.request("POST", `repos/${this.config.repository}/issues`, {
        title: issueTitle,
        body,
      }).body,
    );
    if (!issue?.node_id || !issue?.html_url)
      throw new Error("GitHub did not return the created issue identity");
    // Retain canonical identity before a separately fallible Project mutation.
    onIssueCreated(issue);
    const item = this.ensureIssueItem(issue.node_id);
    this.setItemFields(item.id, {
      ...neutralPortFields,
    });
    return { ...issue, itemId: item.id };
  }

  normalizePortIssue({
    number,
    catalog,
    inventory,
  }: {
    number: number;
    catalog: QualificationCatalogObservation;
    inventory?: RoadmapInventory;
  }) {
    const issue = this.repositoryIssue(number);
    const issueBody = issue.body ?? "";
    const issueTitle = issue.title ?? "";
    if (!canonicalPortTitlePrefix.test(issueTitle)) {
      throw new Error(`issue #${number} title must begin with the canonical [Port] prefix`);
    }
    const ids = portCatalogMarkers(issueBody);
    if (ids.length > 1) throw new Error(`issue #${number} claims multiple catalog IDs`);
    const catalogId = ids[0] ?? null;
    let form: { upstream: string; portKey: string | null };
    if (/^###\s+(?:Direct upstream URL|Durable game or target key)\s*$/imu.test(issueBody)) {
      form = parsePortIssueForm(issueBody);
    } else {
      // Direct capture emits reviewed canonical markers rather than public-form sections.
      const upstreams = portUpstreamMarkers(issueBody);
      const keys = portKeyMarkers(issueBody);
      if (
        !/<!--\s*portcove-port\s*-->/u.test(issueBody) ||
        upstreams.length !== 1 ||
        keys.length > 1 ||
        (!keys.length && !catalogId)
      )
        throw new Error("captured port recovery requires one canonical upstream and port identity");
      form = parsePortIssueForm(
        `### Direct upstream URL\n\n${upstreams[0]}\n\n### Durable game or target key\n\n${keys[0] ?? catalogId}`,
      );
      if (!keys.length) form.portKey = null;
    }
    if (catalogId && !(catalog?.ports ?? []).some((port) => port.id === catalogId)) {
      throw new Error(`issue #${number} claims unknown catalog ID ${catalogId}`);
    }
    const repositoryIssues = inventory
      ? requireRoadmapInventory(inventory, this.config.repository, this).issues
      : this.repositoryIssues();
    const duplicates = findPortIssueDuplicates(
      repositoryIssues.filter((candidate) => issueNumber(candidate) !== number),
      {
        title: issueTitle.replace(portTitlePrefix, ""),
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

    const existingItems = (
      inventory
        ? [...inventory.items, ...inventory.archivedItems]
        : this.itemList(this.config.project.number)
    ).filter(
      (item) =>
        issueNumber(item) === number &&
        String(itemUrl(item) ?? "").toLowerCase() === String(issue.html_url).toLowerCase(),
    );
    if (existingItems.length > 1) {
      throw new Error(
        `issue #${number} has multiple Project items; remove the duplicate before normalization`,
      );
    }
    const body = reconcilePortIssueMarkers(issueBody, {
      upstream: form.upstream,
      catalogId,
      portKey: form.portKey,
    });
    const bodyChanged = body !== issue.body;
    const existingItem = existingItems[0] ?? null;
    const fieldUpdates = portFieldInitialization(existingItem);

    if (inventory) invalidateRoadmapInventory(inventory);
    if (bodyChanged) {
      this.api.request("PATCH", `repos/${this.config.repository}/issues/${number}`, { body });
    }
    const item = existingItem ?? this.ensureIssueItem(issue.node_id);
    if (!item.id) throw new Error("normalized Project item identity is unavailable");
    if (Object.keys(fieldUpdates).length) this.setItemFields(item.id, fieldUpdates);
    return {
      issue: issue.html_url,
      bodyChanged,
      projectItemAdded: !existingItem,
      fieldsChanged: Object.keys(fieldUpdates),
      itemId: item.id,
    };
  }

  promote(itemId: string, durableBody: string) {
    validateDurableIssueBody(durableBody);
    const repository = qualificationField(
      this.graphql(
        `query($owner: String!, $name: String!) { repository(owner: $owner, name: $name) { id } }`,
        {
          owner: this.config.repository.split("/")[0],
          name: this.config.repository.split("/")[1],
        },
      ),
      "repository",
    );
    if (!isRecord(repository) || typeof repository.id !== "string" || !repository.id)
      throw new Error("repository was not found");
    const query = `mutation($input: ConvertProjectV2DraftIssueItemToIssueInput!) { convertProjectV2DraftIssueItemToIssue(input: $input) { item { id content { ... on Issue { number title url } } } } }`;
    const item = identifiedProjectItem(
      nestedGitHubField(
        this.graphql(query, {
          input: { itemId, repositoryId: repository.id },
        }),
        "convertProjectV2DraftIssueItemToIssue",
        "item",
      ),
    );
    if (!item?.content?.url) throw new Error("draft conversion did not return an issue URL");
    this.gh(["issue", "edit", item.content.url, "--body-file", "-"], durableBody);
    return item;
  }

  moveBefore(itemReference: string, beforeReference: string) {
    const details = this.projectDetails(this.config.project.number);
    const items = this.itemList(this.config.project.number);
    const matches = (item: RoadmapIssueItem, reference: string) =>
      item.id === reference ||
      itemUrl(item) === reference ||
      itemTitle(item) === reference ||
      String(item?.content?.number ?? "") === reference.replace(/^#/, "");
    const resolve = (reference: string) => {
      const found = items.filter((item) => matches(item, reference));
      if (found.length > 1) throw new Error(`move reference is ambiguous: ${reference}`);
      return found[0];
    };
    const moving = resolve(itemReference);
    const before = resolve(beforeReference);
    if (!moving || !before) throw new Error("move could not resolve both items");
    const remaining = items.filter((item) => item.id !== moving.id);
    const beforeIndex = remaining.findIndex((item) => item.id === before.id);
    const afterId = beforeIndex <= 0 ? null : remaining[beforeIndex - 1]?.id;
    const query = `mutation($input: UpdateProjectV2ItemPositionInput!) { updateProjectV2ItemPosition(input: $input) { items(first: 1) { totalCount } } }`;
    this.graphql(query, {
      input: { projectId: details.id, itemId: moving.id, afterId },
    });
  }
}

async function loadConfig({ requireProjectNumber = false } = {}) {
  const config: unknown = JSON.parse(await readFile(configPath, "utf8"));
  return validateConfig(config, { requireProjectNumber });
}

async function offlineCheck() {
  const config = await loadConfig({ requireProjectNumber: true });
  const forbiddenLedger = path.join(projectRoot, "docs", "project", "ledger.json");
  try {
    await access(forbiddenLedger);
    throw new Error("docs/project/ledger.json must not exist");
  } catch (error) {
    if (errorCode(error) !== "ENOENT") throw error;
  }
  const archives: readonly (readonly [string, RegExp])[] = [
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
    ].map(
      async (relative: string) =>
        [relative, await readFile(path.join(projectRoot, relative), "utf8")] as const,
    ),
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

export function manualUiChecklist(config: RoadmapConfig) {
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

function configuredValue(
  config: RoadmapConfig,
  fieldName: string,
  value: unknown,
  flag: string,
): string {
  const field = config.fields.find((candidate) => candidate.name === fieldName);
  if (typeof value !== "string" || !field?.options.includes(value))
    throw new Error(`${diagnosticText(value)} is not a valid ${fieldName} option for ${flag}`);
  return value;
}

export function featureIntakeFields(
  config: RoadmapConfig,
  options: Readonly<Record<string, unknown>> = {},
) {
  const fields: Record<string, string> = {
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

export function resolveSnapshotOutput(output: string) {
  const outputPath = path.resolve(projectRoot, output);
  const releasesRoot = path.join(projectRoot, "docs", "releases");
  if (outputPath !== releasesRoot && !outputPath.startsWith(`${releasesRoot}${path.sep}`)) {
    throw new Error("snapshot output must be under docs/releases");
  }
  return outputPath;
}

function requiredOption(options: Readonly<Record<string, unknown>>, name: string): string {
  const value = options[name];
  if (typeof value !== "string" || !value) throw new Error(`${name} is required`);
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

type DoctorClient = Pick<
  RoadmapClient,
  "gh" | "completeProjectContext" | "viewList" | "projectAudit" | "itemList" | "repositoryIssues"
>;
function isDoctorClient(client: unknown): client is DoctorClient {
  return (
    isRecord(client) &&
    [
      "gh",
      "completeProjectContext",
      "viewList",
      "projectAudit",
      "itemList",
      "repositoryIssues",
    ].every((name) => typeof client[name] === "function")
  );
}
type LoadedQualificationCatalog = QualificationCatalogObservation & {
  ports: QualificationPortObservation[];
};
function qualificationCatalogObservation(value: unknown): LoadedQualificationCatalog {
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
function linkedRepositoryObservation(value: unknown): LinkedProjectRepository {
  if (
    !isRecord(value) ||
    typeof value.name !== "string" ||
    !(
      typeof value.owner === "string" ||
      (isRecord(value.owner) &&
        (value.owner.login === undefined || typeof value.owner.login === "string"))
    )
  )
    throw new Error("Project linked repository identity is malformed");
  return value as Record<string, unknown> & LinkedProjectRepository;
}
export function evaluateRoadmapDoctor({
  config,
  catalog,
  items,
  repositoryIssues,
  drift,
  risk706Approval,
  now,
}: {
  config: RoadmapConfig;
  catalog: QualificationCatalogObservation;
  items: readonly RoadmapIssueItem[];
  repositoryIssues: readonly RoadmapIssueItem[];
  drift: readonly string[];
  risk706Approval: unknown;
  now: string;
}) {
  const stage = validatePortStageSemantics(catalog, items);
  const readiness = analyzeReleaseReadiness(items, config.active_release, { risk706Approval, now });
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
    const error = new Error(
      `Project drift:\n${[...drift, ...roadmapErrors].map((value) => `- ${value}`).join("\n")}`,
    );
    throw Object.assign(error, { doctorErrors: [...drift, ...roadmapErrors] });
  }
  return { warnings: stage.warnings, diagnostics: stage.diagnostics, readiness };
}

export async function runDoctor(
  config: RoadmapConfig,
  clientInput: unknown,
  {
    quiet = false,
    cache,
    inventory: suppliedInventory,
  }: { quiet?: boolean; cache?: InventoryCache; inventory?: RoadmapInventory } = {},
) {
  if (!isDoctorClient(clientInput))
    throw new Error("Roadmap doctor client capabilities are unavailable");
  const client = clientInput;
  const log = quiet ? () => {} : console.log;
  client.gh(["auth", "status"]);
  const number = config.project.number;
  const inventory = suppliedInventory
    ? requireRoadmapInventory(suppliedInventory, config.repository, clientInput)
    : cache && clientInput instanceof RoadmapClient
      ? collectRoadmapInventory(clientInput, cache)
      : undefined;
  const context = client.completeProjectContext(number);
  const { details, fields } = context;
  const projectId = details.id;
  if (!projectId) throw new Error("Roadmap doctor Project identity is unavailable");
  if (inventory && inventory.projectId !== projectId)
    throw new Error("Doctor inventory belongs to a different Project");
  const views = client.viewList(projectId);
  const rawAudit = client.projectAudit(projectId);
  const audit = projectDetailsObservation(rawAudit);
  const rawRepositories = nestedGitHubField(rawAudit, "repositories", "nodes");
  if (rawRepositories != null && !Array.isArray(rawRepositories))
    throw new Error("Project linked repository inventory is malformed");
  const repositoryEntries: unknown[] = Array.isArray(rawRepositories) ? rawRepositories : [];
  const drift = projectMachineDrift(config, {
    details: audit,
    fields,
    views,
    repositories: repositoryEntries.map(linkedRepositoryObservation),
  });
  const catalog = qualificationCatalogObservation(JSON.parse(await readFile(catalogPath, "utf8")));
  const items = inventory?.items ?? client.itemList(number, { includeDependencies: true, details });
  const repositoryIssues = inventory?.issues ?? client.repositoryIssues();
  const stage = evaluateRoadmapDoctor({
    config,
    catalog,
    items,
    repositoryIssues,
    drift,
    risk706Approval: JSON.parse(
      await readFile(path.join(projectRoot, ".github/linux-beta-risk-706.json"), "utf8"),
    ),
    now: new Date().toISOString(),
  });
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
    `${config.active_release} readiness has ${stage.readiness.unfinishedRequired.length} unfinished required outcomes and ${stage.readiness.planned.length} planned outcomes.`,
  );
  log(
    `Grouping and sorting were read back; UI changes are required if they drift. Confirm built-in auto-add and completion workflows separately:\n${manualUiChecklist(config).slice(-2).join("\n")}`,
  );
  return {
    number,
    details,
    fields,
    views,
    repositoryIssues,
    items,
    warnings: stage.warnings,
    diagnostics: stage.diagnostics,
    inventory,
  };
}

export function roadmapCommandHelp(command: string, config: RoadmapConfig) {
  if (!/^[a-z-]+$/u.test(command)) throw new Error("unknown Roadmap command: " + command);
  const line = roadmapHelp
    .split("\n")
    .find(
      (line: string) =>
        line.trim().startsWith("node scripts/roadmap.mts " + command + " ") ||
        line.trim() === "node scripts/roadmap.mts " + command,
    );
  if (!line) throw new Error("unknown Roadmap command: " + command);
  const fields =
    command === "set"
      ? [...setFlags]
      : command === "capture-feature"
        ? [...setFlags].filter(([flag]) =>
            [
              "--priority",
              "--horizon",
              "--release",
              "--commitment",
              "--workstream",
              "--platform",
            ].includes(flag),
          )
        : [];
  return [
    line.trim(),
    ...fields.map(
      ([flag, field]) =>
        flag +
        ": " +
        (config.fields.find((entry) => entry.name === field)?.options.join(" | ") ??
          (() => {
            throw new Error(`missing configured field ${field}`);
          })()),
    ),
    command === "context" || command === "doctor"
      ? "--summary: retain raw evidence and display a bounded projection; mutually exclusive with --json"
      : "",
  ]
    .filter(Boolean)
    .join("\n");
}

async function main(argv: readonly string[]) {
  const parsed = parseArguments(argv);
  if (parsed.options["--help"]) {
    console.log(roadmapCommandHelp(parsed.command, await loadConfig()));
    return;
  }
  if (parsed.options["--summary"] && parsed.options["--json"])
    throw new Error("--summary and --json are mutually exclusive");
  if (["--help", "help"].includes(parsed.command)) {
    console.log(roadmapHelp);
    return;
  }
  if (parsed.command === "check") {
    await offlineCheck();
    return;
  }
  const config =
    parsed.command === "doctor"
      ? null
      : await loadConfig({
          requireProjectNumber: parsed.command !== "bootstrap",
        });
  const client = config ? new RoadmapClient(config) : null;
  const lock = await acquireOwnedProcessLock(
    roadmapLockPath(),
    { workspace: projectRoot, command: parsed.command },
    { label: "Portcove Roadmap operation" },
  );
  try {
    if (parsed.command === "rename-commitment") {
      if (!client || !config) throw new Error("Roadmap operation configuration is unavailable");
      if (
        parsed.positionals.length ||
        Object.keys(parsed.options).some((key) => key !== "--apply") ||
        ("--apply" in parsed.options && parsed.options["--apply"] !== true)
      )
        throw new Error("usage: roadmap.mts rename-commitment [--apply]");
      console.log(
        JSON.stringify(
          executeCommitmentRename({ client, config, apply: parsed.options["--apply"] === true }),
        ),
      );
      return;
    }
    if (parsed.command === "doctor") {
      if (
        parsed.positionals.length ||
        Object.keys(parsed.options).some(
          (key) => !["--expected-head", "--json", "--summary"].includes(key),
        )
      )
        throw new Error("usage: roadmap.mts doctor [--expected-head SHA] [--json]");
      let context;
      let report;
      try {
        const checked = await checkContextualDoctor({
          capture: () => captureCheckoutContext(projectRoot),
          ...(parsed.options["--expected-head"] === undefined
            ? {}
            : { expectedHead: requiredOption(parsed.options, "--expected-head") }),
          report: (observed) => {
            context = observed;
            if (!parsed.options["--json"] && !parsed.options["--summary"])
              console.log(
                `Roadmap checkout: ${observed.root}; HEAD: ${observed.head}; branch: ${observed.branch}; catalog SHA-256: ${observed.catalog_sha256}; modified inputs: ${observed.input_dirty}`,
              );
          },
          check: async () => {
            const doctorConfig = await loadConfig({ requireProjectNumber: true });
            return runDoctor(doctorConfig, new RoadmapClient(doctorConfig), { quiet: true });
          },
        });
        report = {
          format: 1,
          kind: "roadmap-doctor",
          status: "passed",
          context: checked.context,
          counts: {
            fields: checked.result.fields.length,
            views: checked.result.views.length,
            issues: checked.result.repositoryIssues.length,
            items: checked.result.items.length,
          },
          warnings: checked.result.warnings,
          diagnostics: checked.result.diagnostics,
        };
      } catch (error) {
        report = {
          format: 1,
          kind: "roadmap-doctor",
          status: "failed",
          context,
          errors: (() => {
            const errors = qualificationField(error, "doctorErrors");
            return Array.isArray(errors) &&
              errors.every((entry: unknown) => typeof entry === "string")
              ? errors
              : [sanitizeOperationError(error).message];
          })(),
        };
        process.exitCode = 1;
      }
      const directory = path.join(projectRoot, "work/roadmap-doctor");
      let reference;
      try {
        mkdirSync(directory, { recursive: true });
        reference = path.join(directory, `${randomUUID()}.json`);
        writeFileSync(reference, JSON.stringify(report), { flag: "wx" });
      } catch {
        reference = "retention unavailable";
      }
      if (parsed.options["--summary"]) {
        if (reference === "retention unavailable")
          throw new Error("Roadmap summary raw retention failed");
        if (!context) throw new Error((report.errors ?? []).join("; "));
        console.log(summarizeReport("doctor", report, reference).text);
      } else if (parsed.options["--json"])
        console.log(JSON.stringify({ ...report, evidence: reference }));
      else if (context) console.log(summarizeReport("doctor", report, reference).text);
      else console.error((report.errors ?? []).join("\n"));
      return;
    }
    if (!client || !config) throw new Error("Roadmap operation configuration is unavailable");
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
        catalogId:
          parsed.options["--catalog-id"] === undefined
            ? undefined
            : requiredOption(parsed.options, "--catalog-id"),
        portKey:
          parsed.options["--port-key"] === undefined
            ? undefined
            : requiredOption(parsed.options, "--port-key"),
        onIssueCreated: (issue) => {
          const directory = path.join(projectRoot, "work", "roadmap-intake");
          mkdirSync(directory, { recursive: true });
          const receipt = path.join(directory, `${issue.number}-${randomUUID()}.json`);
          writeFileSync(
            receipt,
            JSON.stringify({
              issue: issue.html_url,
              number: issue.number,
              node_id: issue.node_id,
              created_at: new Date().toISOString(),
              phase: "issue-created-project-unconfirmed",
              resume: `normalize-port --issue ${issue.number}`,
            }),
            { flag: "wx" },
          );
          console.log(`Canonical issue created: ${issue.html_url}; recovery receipt: ${receipt}`);
        },
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
      const catalog = qualificationCatalogObservation(
        JSON.parse(await readFile(catalogPath, "utf8")),
      );
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
      if (parsed.positionals.length !== 1 || parsed.positionals[0] === undefined)
        throw new Error("usage: roadmap.mts promote <draft-item-id>");
      const draft = client
        .itemList(config.project.number)
        .find((item) => item.id === parsed.positionals[0]);
      if (!draft) throw new Error(`draft item was not found: ${parsed.positionals[0]}`);
      const durableBody = parsed.options["--spec-file"]
        ? await readFile(
            path.resolve(projectRoot, requiredOption(parsed.options, "--spec-file")),
            "utf8",
          )
        : itemBody(draft);
      validateDurableIssueBody(durableBody);
      const item = client.promote(parsed.positionals[0], durableBody);
      console.log(`Promoted draft to ${item?.content?.url ?? item?.id}.`);
      return;
    }
    if (parsed.command === "set") {
      if (parsed.positionals.length !== 1 || parsed.positionals[0] === undefined)
        throw new Error("usage: roadmap.mts set <item-or-issue> [field options]");
      const values: Record<string, string> = {};
      for (const [flag, value] of Object.entries(parsed.options)) {
        const field = setFlags.get(flag);
        if (!field) throw new Error(`unsupported set option: ${flag}; use set --help`);
        const definition = config.fields.find((candidate) => candidate.name === field);
        if (!definition) throw new Error(`missing configured Project field ${field}`);
        if (typeof value !== "string" || !definition.options.includes(value))
          throw new Error(
            `${value} is not a valid ${field} option; allowed: ${definition.options.join(" | ")}`,
          );
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
        throw new Error("usage: roadmap.mts set-many --spec-file <path> [--apply] [--json]");
      if ("--apply" in parsed.options && parsed.options["--apply"] !== true)
        throw new Error("--apply does not accept a value");
      if ("--json" in parsed.options && parsed.options["--json"] !== true)
        throw new Error("--json does not accept a value");
      for (const option of Object.keys(parsed.options)) {
        if (!["--apply", "--json", "--spec-file"].includes(option))
          throw new Error(`unsupported set-many option: ${option}`);
      }
      const specPath = path.resolve(projectRoot, requiredOption(parsed.options, "--spec-file"));
      const spec: unknown = JSON.parse(await readFile(specPath, "utf8"));
      const result = await executeSetMany({
        client,
        config,
        spec,
        apply: parsed.options["--apply"] === true,
        ...(parsed.options["--json"] ? {} : { onPlan: (summary: string) => console.log(summary) }),
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
      if (parsed.positionals.length !== 1 || parsed.positionals[0] === undefined)
        throw new Error("usage: roadmap.mts move <item> --before <item>");
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
        "--summary",
      ]);
      const value = requiredOption(parsed.options, "--issue");
      if (!/^\d+$/.test(value) || !Number.isSafeInteger(Number(value)) || Number(value) < 1)
        throw new Error("--issue must be a positive repository issue number");
      const runner = requiredOption(parsed.options, "--runner");
      if (!/^[^\s]{1,200}$/u.test(runner))
        throw new Error("pickup requires a reported runner identity");
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
      let consumed: ExecutionSnapshot | null = null;
      let consumedContext: Record<string, unknown> | null = null;
      let reference: unknown = null;
      if (parsed.options["--consumed-file"]) {
        const checkpoint: unknown = JSON.parse(
          await readFile(
            path.resolve(projectRoot, requiredOption(parsed.options, "--consumed-file")),
            "utf8",
          ),
        );
        consumed = validateExecutionSnapshot(
          qualificationField(checkpoint, "snapshot") ?? checkpoint,
        );
        consumedContext = isRecord(checkpoint) ? checkpoint : null;
        reference = { kind: "disposable checkpoint", latest_consumption: "not established" };
      }
      if (parsed.options["--consumed-comment"]) {
        const comment = client.coordinationComment(
          requiredOption(parsed.options, "--consumed-comment"),
          target,
        );
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
        ? client.coordinationComment(
            requiredOption(parsed.options, "--reservation-comment"),
            target,
          )
        : null;
      const live = client.executionIssue(Number(value));
      const context = deriveExecutionContext(config, live.item, live.relationships, {
        runner,
        comments: [],
        coverage: {
          complete: false,
          kind: "live task requirements; historical consumption absence remains unknown",
        },
        consumed,
        reservation,
        target,
      });
      Object.assign(context, { consumed_reference: reference });
      if (
        consumedContext?.observation_revision === context.observation_revision &&
        nestedGitHubField(consumedContext, "snapshot", "revision") === context.snapshot.revision
      ) {
        context.current_specification = null;
        Object.assign(context, {
          specification_disposition:
            "unchanged from the validated consumed baseline; complete task specification remains bound to its raw observation",
        });
      }
      if (parsed.options["--summary"]) {
        console.log(
          retainReportSummary("roadmap", context, path.join(projectRoot, "work/report-summary"))
            .text,
        );
        return;
      }
      console.log(
        parsed.options["--json"]
          ? JSON.stringify(context)
          : `#${context.canonical_issue.number} ${context.canonical_issue.title}\n${context.canonical_issue.url}\nRevision: ${context.snapshot.revision}\nComparison: ${context.comparison.state}; ${context.comparison.action}\nPickup: ${context.pickup.current_requirements}; invoked/active/assigned unknown.\nReservation: ${context.reservation.assessment}\nUse --json for the full current specification, planning, typed relationships and coverage.`,
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
      executionOptions(parsed, ["--release", "--linux-beta-706"]);
      if ("--linux-beta-706" in parsed.options && parsed.options["--linux-beta-706"] !== true)
        throw new Error("--linux-beta-706 does not accept a value");
      const release = requiredOption(parsed.options, "--release");
      let risk706Evidence = null;
      let risk706Output = null;
      if (parsed.options["--linux-beta-706"]) {
        if (release !== "Public beta")
          throw new Error("#706 covers only ordinary Linux Public beta");
        const { scan, output } = scanDependencies(projectRoot);
        risk706Output = output;
        risk706Evidence = await decisionInputs706(projectRoot, scan, undefined, "release");
      }
      const analysis = analyzeReleaseReadiness(
        client.itemList(config.project.number, { includeDependencies: true }),
        release,
        { risk706Evidence },
      );
      if (analysis.candidateDisposition706)
        writeFileSync(
          `${risk706Output}.decision.json`,
          `${JSON.stringify(analysis.candidateDisposition706, null, 2)}\n`,
          { flag: "wx" },
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
      if (
        !config.fields.find((field) => field.name === "Target release")?.options.includes(release)
      )
        throw new Error(`unknown target release: ${release}`);
      const outputPath = resolveSnapshotOutput(output);
      const { writeFile } = await import("node:fs/promises");
      try {
        await access(outputPath);
        throw new Error(`snapshot output already exists: ${output}`);
      } catch (error) {
        if (errorCode(error) !== "ENOENT") throw error;
      }
      const [catalog, commit] = await Promise.all([
        readFile(catalogPath, "utf8").then((text) =>
          qualificationCatalogObservation(JSON.parse(text)),
        ),
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
      ["set-many", "context", "next"].includes(process.argv[2] ?? "") &&
      process.argv.slice(3).includes("--json");
    const safeError = sanitizeOperationError(error);
    if (json) {
      console.log(
        JSON.stringify(
          githubOperationEnvelope({
            operation: `roadmap.${process.argv[2]}`,
            status: qualificationField(error, "operationStatus") ?? "failed",
            summary: safeError.message,
            evidence: qualificationField(error, "operationEvidence") ?? {},
            error,
          }),
        ),
      );
    }
    console.error(`roadmap: ${safeError.message}`);
    process.exitCode = 1;
  }
}
