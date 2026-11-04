import { readFileSync } from "node:fs";
import { RoadmapClient, validateConfig } from "./roadmap.mts";
import type { RoadmapConfig } from "./roadmap.mts";
import { validateDurableIssueBody } from "./roadmap-issue.mts";
import type { RoadmapIssueItem } from "./roadmap-issue.mts";
import { qualificationCatalogObservation } from "./roadmap-qualification.mts";
import type { QualificationCatalogObservation } from "./roadmap-qualification.mts";
import { evaluateScopedRoadmap, scopedIssueWithBlockers } from "./roadmap-scoped.mts";

export function isRoadmapSpecification(issue: RoadmapIssueItem) {
  return /<!--\s*portcove-|^## User outcome\s*$|^\[Port\]/mu.test(
    `${issue.title ?? ""}\n${issue.body ?? ""}`,
  );
}

function canonicalMarkers(body: string) {
  return [
    ...body.matchAll(
      /<!--\s*portcove-(?:port|upstream|catalog-id|port-key|ux-audit-origins|plan-origins|origins|discovery-intake)\b[^>]*-->/gu,
    ),
  ]
    .map((match) => match[0].replace(/\s+/gu, " ").trim())
    .sort();
}

/** The same selected-record planning rules as doctor; never claims global uniqueness. */
export function validateRoadmapReplacement(
  config: RoadmapConfig,
  catalog: QualificationCatalogObservation,
  item: RoadmapIssueItem,
  previousBody: string,
  body: string,
) {
  if ((item.content?.body ?? item.body ?? "") !== previousBody)
    throw new Error("Roadmap body changed; refresh the issue and Project preimage");
  const before = canonicalMarkers(previousBody);
  const after = canonicalMarkers(body);
  if (JSON.stringify(before) !== JSON.stringify(after))
    throw new Error(
      "Replacement changed or removed canonical identity markers; use the explicit normalization route for identity changes",
    );
  validateDurableIssueBody(body);
  const proposed = {
    ...item,
    body,
    ...(item.content ? { content: { ...item.content, body } } : {}),
  };
  evaluateScopedRoadmap(config, catalog, [proposed]);
}

export async function validateLiveRoadmapReplacement(
  number: number,
  previousBody: string,
  body: string,
  sharedClient?: RoadmapClient,
) {
  const config = validateConfig(
    JSON.parse(readFileSync(new URL("../.github/roadmap.json", import.meta.url), "utf8")),
  );
  let client = sharedClient;
  if (!client) {
    const { localDeveloperCredential } = await import("./github-cli.mts");
    const deadline = performance.now() + 120_000;
    client = await RoadmapClient.connect(config, {
      credential: localDeveloperCredential({ deadline, command: process.env.PORTCOVE_ROADMAP_GH }),
      deadline,
      failedReads: new Map(),
      deferral: { primary: new Map(), secondary: 0 },
    });
  }
  if (JSON.stringify(client.config) !== JSON.stringify(config))
    throw new Error("Roadmap replacement client configuration differs");
  const observed = await client.executionIssue(number);
  const item = scopedIssueWithBlockers(observed.item, observed.relationships.blockedBy);
  const catalog = qualificationCatalogObservation(
    JSON.parse(
      readFileSync(
        new URL("../crates/portcove-core/catalog/catalog.json", import.meta.url),
        "utf8",
      ),
    ),
  );
  validateRoadmapReplacement(config, catalog, item, previousBody, body);
}
