import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import {
  analyzeReleaseReadiness,
  executionSnapshot,
  dependencyCycles,
  fieldValue,
  repositoryStatusConflict,
  validatePortIssueCoverage,
  validatePortStageSemantics,
} from "./roadmap.mts";
import type {
  RoadmapClient,
  RoadmapConfig,
  RoadmapIssueItem,
  QualificationCatalogObservation,
} from "./roadmap.mts";
import { requireRoadmapInventory } from "./roadmap-inventory.mts";
import type { RoadmapInventory } from "./roadmap-inventory.mts";
import {
  InventoryError,
  inventoryFailureKind,
  inventoryFailureSource,
} from "./repository-issue-inventory.mts";
import { GitHubApiError, sanitizeOperationError } from "./github-api.mts";
import { isRecord } from "./runtime-values.mts";

export function roadmapCheckScope(
  changes: readonly { target: string; fieldName: string; itemId?: string }[],
) {
  return new Set(changes.map((change) => change.itemId ?? change.target)).size > 10 ||
    changes.some((change) => ["Target release", "Release commitment"].includes(change.fieldName))
    ? "global"
    : "issues";
}

export function doctorFailureDiagnostics(error: unknown) {
  const source = inventoryFailureSource(error);
  const kind = inventoryFailureKind(error);
  const recovery: Record<string, string> = {
    checkout_context:
      "Use the intended verified checkout and HEAD with stable catalog/configuration inputs. GitHub planning drift was not assessed.",
    provider_inconsistent:
      "GitHub must restore agreement between the existing Project items and issue memberships. Preserve item identities; do not recreate memberships or change planning fields to repair the index.",
    inventory_changed:
      "The observed records changed during collection. Retry one fresh read only when the existing quota and deadline admission permits it.",
    inventory_incomplete:
      "Restore complete pagination and identity coverage before evaluating absence or global planning findings.",
    inventory_malformed:
      "Inspect the retained failing query and response shape; restore the required API fields before retrying.",
    inventory_identity:
      "Resolve the repository, Project or item identity mismatch before any mutation.",
    authentication:
      "Restore the configured repository and Project access, then rerun the same scoped check.",
    rate_limit:
      "Wait for the provider reset or Retry-After boundary; do not repeat mutations or increase the caller budget.",
    budget:
      "Resume within the existing caller budget after capacity is available; preserve completed writes and evidence.",
    transport:
      "Restore the GitHub transport; use the existing bounded read retry and reconcile any ambiguous mutation by exact readback.",
    planning_findings:
      "Review the named records and their owning requirements. Apply only authorized changes, then repeat the affected check.",
  };
  return {
    kind,
    coverage: kind === "planning_findings" ? "complete" : "inconclusive",
    recovery_condition: recovery[kind],
    error: sanitizeOperationError(error),
    ...(source !== error ? { cause: sanitizeOperationError(source) } : {}),
    ...(source instanceof GitHubApiError
      ? {
          provider: {
            status: source.status,
            rate: source.rateLimit,
            retry_after: source.retryAfter,
          },
        }
      : {}),
    ...(isRecord(source) && isRecord(source.membershipMismatch)
      ? { membership_mismatch: source.membershipMismatch }
      : {}),
  };
}

const numberOf = (item: RoadmapIssueItem) => Number(item.content?.number ?? item.number);
const bodyOf = (item: RoadmapIssueItem) => String(item.content?.body ?? item.body ?? "");
const isIssueList = (value: RoadmapIssueItem["blockedBy"]): value is readonly RoadmapIssueItem[] =>
  Array.isArray(value);

export function scopedIssueWithBlockers(
  item: RoadmapIssueItem,
  blockers: readonly RoadmapIssueItem[],
) {
  return { ...item, blockedBy: { totalCount: blockers.length, nodes: blockers } };
}

/** Checks only observed records. Global origin coverage and uniqueness remain unevaluated. */
export function evaluateScopedRoadmap(
  config: RoadmapConfig,
  catalog: QualificationCatalogObservation,
  items: readonly RoadmapIssueItem[],
) {
  const ids = new Set(
    items.flatMap((item) =>
      [...bodyOf(item).matchAll(/<!--\s*portcove-catalog-id:\s*([^\s>]+)\s*-->/gu)].map(
        (match) => match[1],
      ),
    ),
  );
  const selectedCatalog = {
    ...catalog,
    ports: (catalog.ports ?? []).filter((port) => ids.has(port.id)),
  };
  const stage = validatePortStageSemantics(selectedCatalog, items);
  const errors = [
    ...validatePortIssueCoverage(
      selectedCatalog,
      items,
      config.repository,
      items.map((item) => item.content ?? item),
    ),
    ...stage.errors,
  ];
  for (const item of items) {
    for (const field of config.fields) {
      const value = fieldValue(item, field.name);
      if (
        value != null &&
        value !== "" &&
        (typeof value !== "string" || !field.options.includes(value))
      )
        errors.push(`#${numberOf(item)} has an unknown ${field.name} value`);
    }
  }
  const readiness = analyzeReleaseReadiness(items, config.active_release);
  errors.push(
    ...readiness.migrationConflicts.map(
      (item) => `#${numberOf(item)} retains an unmigrated active target`,
    ),
    ...items
      .filter(repositoryStatusConflict)
      .map((item) => `#${numberOf(item)} has inconsistent repository/Project status`),
    ...readiness.unassignedRequired.map(
      (item) => `#${numberOf(item)} is Required without a target`,
    ),
    ...readiness.relevantUnclassified.map(
      (item) => `#${numberOf(item)} has an unclassified active-release commitment`,
    ),
    ...readiness.safetyConflicts.map(
      (item) => `#${numberOf(item)} has an inconsistent safety commitment`,
    ),
    ...dependencyCycles(items).map(
      (cycle) => `Observed blocking dependency cycle: ${cycle.join(" -> ")}`,
    ),
  );
  for (const item of items) {
    const connection = item.blockedBy ?? item.content?.blockedBy;
    if (connection == null) continue;
    if (
      !isRecord(connection) ||
      !Array.isArray(connection.nodes) ||
      connection.totalCount !== connection.nodes.length
    )
      throw new InventoryError(
        "inventory_incomplete",
        `#${numberOf(item)} has incomplete direct relationships`,
      );
    for (const node of connection.nodes) {
      if (
        !isRecord(node) ||
        !(node.projectItemId === null || typeof node.projectItemId === "string")
      )
        throw new InventoryError(
          "inventory_incomplete",
          `#${numberOf(item)} direct dependency membership is unverified`,
        );
      if (node.projectItemId === null)
        errors.push(
          `#${numberOf(item)} has a direct dependency outside the configured active Project`,
        );
    }
  }
  if (errors.length) throw Object.assign(new Error(errors.join("\n")), { doctorErrors: errors });
  return { warnings: stage.warnings, diagnostics: stage.diagnostics };
}

export async function runScopedDoctor(
  config: RoadmapConfig,
  client: Pick<RoadmapClient, "config" | "executionIssue">,
  {
    issues,
    inventory,
    catalog: suppliedCatalog,
  }: {
    issues: readonly number[];
    inventory?: RoadmapInventory | undefined;
    catalog?: QualificationCatalogObservation;
  },
) {
  const requested = [...new Set(issues)];
  if (
    !requested.length ||
    requested.length > 100 ||
    requested.some((number) => !Number.isSafeInteger(number) || number < 1)
  )
    throw new Error("Scoped doctor requires 1 to 100 positive issue numbers");
  const catalog =
    suppliedCatalog ??
    (JSON.parse(
      await readFile(
        new URL("../crates/portcove-core/catalog/catalog.json", import.meta.url),
        "utf8",
      ),
    ) as QualificationCatalogObservation);
  const items: RoadmapIssueItem[] = [];
  const revisions = new Map<number, string>();
  const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
  const revisionOf = (observed: ReturnType<RoadmapClient["executionIssue"]>) =>
    hash([
      observed.item.id,
      executionSnapshot(config, observed.item, observed.relationships),
      observed.item.content.body,
      observed.item.content.title,
      observed.relationships.blockedBy
        .map((node) => ({
          id: node.id,
          body: node.body,
          title: node.title,
          projectItemId: node.projectItemId,
        }))
        .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)),
    ]);
  if (inventory) {
    requireRoadmapInventory(inventory, config.repository, client);
    for (const number of requested) {
      const matches = inventory.items.filter(
        (item) =>
          numberOf(item) === number &&
          item.content?.url === `https://github.com/${config.repository}/issues/${number}`,
      );
      if (matches.length !== 1)
        throw new InventoryError(
          "inventory_incomplete",
          `Scoped issue #${number} requires one verified active Project item`,
        );
      const selected = matches[0]!;
      const blockers = selected.content?.blockedBy ?? selected.blockedBy;
      const nodes = isIssueList(blockers) ? blockers : (blockers?.nodes ?? []);
      if (
        !isIssueList(blockers) &&
        blockers?.totalCount !== undefined &&
        blockers.totalCount !== nodes.length
      )
        throw new InventoryError(
          "inventory_incomplete",
          `#${number} has incomplete direct relationships`,
        );
      items.push({
        ...selected,
        blockedBy: {
          totalCount: nodes.length,
          nodes: nodes.map((node) => ({
            ...node,
            projectItemId: inventory.items.find((item) => item.content?.id === node.id)?.id ?? null,
          })),
        },
      });
    }
  } else {
    const selected = new Set(requested);
    const observations = new Map<number, ReturnType<RoadmapClient["executionIssue"]>>();
    for (const number of requested) {
      const observed = client.executionIssue(number);
      observations.set(number, observed);
      for (const node of [observed.relationships.parent, ...observed.relationships.blocking])
        if (node && node.url === `https://github.com/${config.repository}/issues/${node.number}`)
          selected.add(node.number);
    }
    if (selected.size > 100)
      throw new InventoryError(
        "inventory_incomplete",
        "Scoped related records exceed 100 issues; request an explicit full doctor",
      );
    for (const number of selected) {
      const observed = observations.get(number) ?? client.executionIssue(number);
      revisions.set(number, revisionOf(observed));
      items.push(scopedIssueWithBlockers(observed.item, observed.relationships.blockedBy));
    }
    // A consistent direct read is still an observation, never an atomic GitHub snapshot.
    for (const [number, revision] of revisions) {
      const after = client.executionIssue(number);
      if (revisionOf(after) !== revision)
        throw new InventoryError(
          "inventory_changed",
          `Scoped issue #${number} changed during validation; discard the read`,
        );
    }
  }
  const scope = { kind: "issues" as const, issues: requested, checked_issues: items.map(numberOf) };
  let result;
  try {
    result = evaluateScopedRoadmap(config, catalog, items);
  } catch (error) {
    // Only a completed evaluation has a checked set. Failed provider reads must
    // not acquire a complete-coverage claim from the requested issue numbers.
    if (isRecord(error) && Array.isArray(error.doctorErrors)) error.doctorScope = scope;
    throw error;
  }
  if (inventory) requireRoadmapInventory(inventory, config.repository, client);
  return {
    scope,
    coverage: "complete" as const,
    global_health: "not_evaluated" as const,
    checks: [
      "selected membership and fields",
      "selected port identity and stage",
      "direct relationships and state consistency",
    ],
    ...result,
  };
}
