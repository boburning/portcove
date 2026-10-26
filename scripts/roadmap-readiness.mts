import { isRecord, recordField as qualificationField } from "./runtime-values.mts";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { RoadmapIssueItem } from "./roadmap-issue.mts";
import type { QualificationCatalogObservation } from "./roadmap-qualification.mts";
import { catalogQualificationSummary } from "./roadmap-qualification.mts";
import { decide706, validateApproval706 } from "./linux-beta-risk-706.mts";
import {
  diagnosticText,
  issueNumber,
  itemTitle,
  itemUrl,
  itemBody,
  fieldValue,
  itemDone,
  repositoryStatusConflict,
  blockingNodes,
} from "./roadmap-issue.mts";

const projectRoot = fileURLToPath(new URL("..", import.meta.url));

const legacyReleaseSequence = ["Alpha 1", "Alpha 2", "Alpha 3", "Beta 1", "Beta 2", "RC", "V1"];
export const releaseSequence = [...legacyReleaseSequence, "Public beta", "1.0"];

function includedReleaseTargets(release: string) {
  if (release === "Public beta") return ["Alpha 1", "Alpha 2", "Public beta"];
  if (release === "1.0") return [...legacyReleaseSequence, "Public beta", "1.0"];
  const index = legacyReleaseSequence.indexOf(release);
  if (index < 0) throw new Error(`unknown target release: ${release}`);
  return legacyReleaseSequence.slice(0, index + 1);
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
  const statusConflicts = uniqueItems([...targeted, ...effectiveRequired]).filter(
    repositoryStatusConflict,
  );
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
  const inconsistencies = matching.filter(repositoryStatusConflict);
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

export function resolveSnapshotOutput(output: string) {
  const outputPath = path.resolve(projectRoot, output);
  const releasesRoot = path.join(projectRoot, "docs", "releases");
  if (outputPath !== releasesRoot && !outputPath.startsWith(`${releasesRoot}${path.sep}`)) {
    throw new Error("snapshot output must be under docs/releases");
  }
  return outputPath;
}

function uniqueItems<T extends RoadmapIssueItem>(items: readonly T[]): T[] {
  return [
    ...new Map(
      items.map((item) => [item?.id ?? `issue:${issueNumber(item) ?? itemTitle(item)}`, item]),
    ).values(),
  ];
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
