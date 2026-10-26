import { createHash } from "node:crypto";
import { isRecord, recordField as qualificationField } from "./runtime-values.mts";
import type { RoadmapConfig } from "./roadmap.mts";
import type { RoadmapIssueItem } from "./roadmap-issue.mts";
import {
  diagnosticText,
  captureText,
  issueNumber,
  itemTitle,
  itemUrl,
  repositoryState,
  fieldValue,
  itemDone,
  blockingNodes,
} from "./roadmap-issue.mts";

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
export const legacyCoordinationIssue = 793;

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

export function validateCoordinationTarget(
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

export interface RoadmapComment {
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
export interface ExecutionSnapshot {
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
export interface ExecutionRelationshipNode extends RoadmapIssueItem {
  id: string;
  number: number;
  url: string;
  title?: string | null;
  body?: string | null;
  state: "OPEN" | "CLOSED";
  projectStatus?: string | null;
}
export interface CanonicalProjectIssue extends RoadmapIssueItem {
  content: ExecutionRelationshipNode;
}
export interface ExecutionRelationships {
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

export function executionReference(node: unknown): node is ExecutionReference {
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
