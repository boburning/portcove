import { createHash, randomUUID } from "node:crypto";
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { RoadmapClient, validateConfig } from "./roadmap.mts";
import type { RoadmapIssueItem } from "./roadmap-issue.mts";
import { captureCheckoutContext } from "./checkout-context.mts";
import { sanitizeOperationError } from "./github-api.mts";
import { isRecord } from "./runtime-values.mts";
import {
  collectRepositoryIssueInventory,
  InventoryError,
  readCompleteConnection,
} from "./repository-issue-inventory.mts";
import type {
  InventoryPageEvidence,
  RepositoryInventoryEvidence,
} from "./repository-issue-inventory.mts";

export function parseInventoryItems(value: string): string[] {
  if (value.length > 1400) throw new Error("Project item selection exceeds the bounded input size");
  const items = value.trim().split(/\s+/u);
  if (
    items.length > 10 ||
    new Set(items).size !== items.length ||
    items.some((item) => !/^PVTI_[A-Za-z0-9_-]{1,128}$/u.test(item))
  )
    throw new Error("Supply 1–10 distinct exact Project item IDs (PVTI_...), separated by spaces");
  return items;
}

export class MembershipReadbackClient extends RoadmapClient {
  readonly connections: { query_sha256: string; pages: InventoryPageEvidence[] }[] = [];
  override readInventory(
    query: string,
    variables: Readonly<Record<string, unknown>>,
    select: (data: unknown) => unknown,
    identity: (node: unknown) => unknown,
  ): unknown[] {
    const pages: InventoryPageEvidence[] = [];
    this.connections.push({
      query_sha256: createHash("sha256").update(query).digest("hex"),
      pages,
    });
    return readCompleteConnection(this, query, variables, select, identity, pages);
  }
}

interface MembershipIdentity {
  item_id: string;
  content_id: string;
  content_type: string;
  number: number | null;
  url: string | null;
  archived: boolean;
}
interface MembershipReport {
  [key: string]: unknown;
  verdict: "UNKNOWN" | "INCONSISTENT" | "CONSISTENT";
  requested_items: string[];
  forward: MembershipIdentity[];
  reverse: MembershipIdentity[];
  direct: MembershipIdentity[];
  discrepancies: string[];
  reverse_evidence: RepositoryInventoryEvidence[];
}
function emptyReport(): MembershipReport {
  return {
    schema_version: 1,
    verdict: "UNKNOWN",
    planning_evaluation: "not_run",
    started_at: new Date().toISOString(),
    requested_items: [],
    forward_archive_scope: ["ARCHIVED", "NOT_ARCHIVED"],
    comparison_scope: "active repository issue memberships in the configured Project",
    forward: [],
    reverse: [],
    direct: [],
    discrepancies: [],
    reverse_evidence: [],
  };
}
function identity(item: RoadmapIssueItem): MembershipIdentity {
  const content = item.content;
  if (
    !item.id ||
    typeof item.isArchived !== "boolean" ||
    !content?.id ||
    !["Issue", "PullRequest", "DraftIssue"].includes(String(content.__typename ?? content.type))
  )
    throw new InventoryError(
      "inventory_identity",
      "Project item identity or archive state is unavailable",
    );
  return {
    item_id: item.id,
    content_id: content.id,
    content_type: String(content.__typename ?? content.type),
    number: typeof content.number === "number" ? content.number : null,
    url: content.url ?? null,
    archived: item.isArchived,
  };
}
function marker(value: unknown, projectId: string) {
  if (
    !isRecord(value) ||
    value.id !== projectId ||
    typeof value.updatedAt !== "string" ||
    !Number.isFinite(Date.parse(value.updatedAt)) ||
    !isRecord(value.items) ||
    typeof value.items.totalCount !== "number" ||
    !Number.isSafeInteger(value.items.totalCount) ||
    value.items.totalCount < 0
  )
    throw new InventoryError(
      "inventory_incomplete",
      "Project identity, revision or active count is unavailable",
    );
  return { id: value.id, revision: value.updatedAt, active_count: value.items.totalCount };
}
function retainFailure(report: MembershipReport, error: unknown) {
  report.verdict = "UNKNOWN";
  report.error = sanitizeOperationError(error);
  if (isRecord(error) && error.connectionEvidence)
    report.failed_connection = error.connectionEvidence;
}

/** One independent read pass. Complete mismatches are evidence; incomplete reads remain UNKNOWN. */
export function readbackMemberships(
  client: MembershipReadbackClient,
  requested: string,
  credentialAvailable = true,
): MembershipReport {
  const report = emptyReport();
  report.forward_connections = client.connections;
  report.api_observations = client.api.observations;
  try {
    report.requested_items = parseInventoryItems(requested);
    if (!credentialAvailable)
      throw new Error(
        "Dedicated PORTCOVE_ROADMAP_TOKEN is unavailable; no comparison was performed",
      );
    const details = client.projectDetails(client.config.project.number);
    if (!details.id)
      throw new InventoryError("inventory_identity", "Project identity is unavailable");
    report.project = {
      id: details.id,
      number: client.config.project.number,
      repository: client.config.repository,
    };
    report.before = client.projectAudit(details.id);
    const before = marker(report.before, details.id);
    for (const item of client.itemList(client.config.project.number, {
      details,
      includeArchived: true,
      includeBodies: false,
      includeDependencies: false,
      pageSize: 100,
    }))
      report.forward.push(identity(item));
    const inventory = collectRepositoryIssueInventory(client, {
      bodies: false,
      projectMemberships: true,
      evidence: report.reverse_evidence,
    });
    report.repository_issue_count = inventory.issues.length;
    if (!inventory.project_memberships)
      throw new InventoryError(
        "inventory_incomplete",
        "Issue-side Project memberships are unavailable",
      );
    const issues = new Map(inventory.issues.map((issue) => [issue.id, issue]));
    for (const link of inventory.project_memberships) {
      if (link.project_id !== details.id) continue;
      const issue = issues.get(link.issue_id);
      if (!issue)
        throw new InventoryError("inventory_identity", "Membership issue identity is unavailable");
      report.reverse.push({
        item_id: link.id,
        content_id: issue.id,
        content_type: "Issue",
        number: issue.number,
        url: issue.url,
        archived: link.isArchived,
      });
    }
    for (const itemId of report.requested_items) {
      const item = client.directProjectItem(itemId);
      if (!isRecord(item.project) || item.project.id !== details.id)
        throw new InventoryError("inventory_identity", "Direct item Project binding changed");
      report.direct.push(identity(item));
    }
    report.after = client.projectAudit(details.id);
    const after = marker(report.after, details.id);
    if (JSON.stringify(before) !== JSON.stringify(after))
      throw new InventoryError(
        "inventory_changed",
        "Project changed during comparison; no stable verdict",
      );
    const localIssue = (row: MembershipIdentity) =>
      row.content_type === "Issue" &&
      row.url?.toLowerCase() ===
        `https://github.com/${client.config.repository}/issues/${row.number}`.toLowerCase();
    const active = report.forward.filter((row) => !row.archived);
    const forward = new Map(active.filter(localIssue).map((row) => [row.item_id, row]));
    const reverse = new Map(
      report.reverse.filter((row) => !row.archived).map((row) => [row.item_id, row]),
    );
    report.counts = {
      forward_all: report.forward.length,
      forward_active: active.length,
      forward_archived: report.forward.length - active.length,
      active_repository_forward: forward.size,
      active_repository_reverse: reverse.size,
      active_other_content: active.length - forward.size,
      independently_reported_active: before.active_count,
    };
    if (active.length !== before.active_count)
      report.discrepancies.push(
        `Forward active count ${active.length} differs from Project count ${before.active_count}`,
      );
    const same = (a: MembershipIdentity | undefined, b: MembershipIdentity | undefined) =>
      a !== undefined && b !== undefined && JSON.stringify(a) === JSON.stringify(b);
    for (const id of new Set([...forward.keys(), ...reverse.keys()])) {
      if (!forward.has(id)) report.discrepancies.push(`${id}: reverse-only active membership`);
      else if (!reverse.has(id)) report.discrepancies.push(`${id}: forward-only active membership`);
      else if (!same(forward.get(id), reverse.get(id)))
        report.discrepancies.push(`${id}: forward/reverse identity mismatch`);
    }
    for (const direct of report.direct) {
      if (direct.archived || !localIssue(direct))
        throw new InventoryError(
          "inventory_identity",
          "Requested item is not an active repository issue",
        );
      if (!same(direct, forward.get(direct.item_id)) || !same(direct, reverse.get(direct.item_id)))
        report.discrepancies.push(
          `${direct.item_id}: direct identity differs from forward or reverse membership`,
        );
    }
    report.verdict = report.discrepancies.length ? "INCONSISTENT" : "CONSISTENT";
  } catch (error) {
    retainFailure(report, error);
  }
  report.finished_at = new Date().toISOString();
  return report;
}

function main() {
  if (process.argv.includes("--help")) {
    console.log(
      "Usage: node scripts/roadmap-membership-readback.mts PVTI_ID [PVTI_ID...]\nRead-only comparison of complete forward/reverse inventories and 1–10 direct issue items.\nHosted input: ROADMAP_INVENTORY_ITEMS. Requires the dedicated GH_TOKEN; writes diagnostic evidence only.",
    );
    return;
  }
  const root = fileURLToPath(new URL("..", import.meta.url));
  const directory = path.join(root, "work/roadmap-diagnostics", `membership-${randomUUID()}`);
  mkdirSync(directory, { recursive: true });
  let report = emptyReport();
  let checkout: unknown;
  try {
    checkout = captureCheckoutContext(root);
    const config = validateConfig(
      JSON.parse(readFileSync(path.join(root, ".github/roadmap.json"), "utf8")),
      { requireProjectNumber: true },
    );
    const requested = process.env.ROADMAP_INVENTORY_ITEMS ?? process.argv.slice(2).join(" ");
    report = readbackMemberships(
      new MembershipReadbackClient(config),
      requested,
      Boolean(process.env.GH_TOKEN),
    );
  } catch (error) {
    retainFailure(report, error);
  }
  report.checkout = checkout ?? null;
  report.script_sha256 = createHash("sha256")
    .update(readFileSync(fileURLToPath(import.meta.url)))
    .digest("hex");
  report.finished_at = new Date().toISOString();
  report.run_url =
    process.env.GITHUB_RUN_ID && process.env.GITHUB_RUN_ATTEMPT
      ? `${process.env.GITHUB_SERVER_URL}/${process.env.GITHUB_REPOSITORY}/actions/runs/${process.env.GITHUB_RUN_ID}/attempts/${process.env.GITHUB_RUN_ATTEMPT}`
      : null;
  const receipt = path.join(directory, "report.json");
  writeFileSync(receipt, `${JSON.stringify(report, null, 2)}\n`);
  const summary = `Roadmap membership readback: **${report.verdict}**. Planning evaluation: not run. Evidence: ${path.relative(root, receipt)}.\n`;
  console.log(summary.trim());
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, summary);
  process.exitCode =
    report.verdict === "CONSISTENT" ? 0 : report.verdict === "INCONSISTENT" ? 1 : 2;
}

if (path.resolve(process.argv[1] ?? "") === fileURLToPath(import.meta.url)) main();
