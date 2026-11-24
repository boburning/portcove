// The facts batch job's observations (#1422): every listing observation the
// upstream observer has accumulated, not one run's handoff.
//
// The observer is a rotating, bounded batch: each run attempts a slice of
// the catalog's sources, and its `catalog-upstream-observations-*` handoff
// holds only that slice. Its durable record of every source is its catalog
// checkpoint, retained as the `upstream-observer-checkpoint-*` snapshot and
// already read by the maintenance inventory and the listing delivery
// (`readUpstreamObservations`, `completedListingCandidates`). The job reads
// the same snapshot, so a source observed in any earlier observer run reaches
// the facts worker; nothing here keeps a second copy of observer state.
//
//   node scripts/listing-facts-observations.mts --output FILE
//     Reads the newest retained observer checkpoint snapshot (GITHUB_TOKEN,
//     `actions: read`) and writes the worker report `{ listings }`.
import { execFileSync } from "node:child_process";
import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import {
  catalogObservationSources,
  partialProgressRules,
  validateCatalogObserverCheckpoint,
} from "./catalog-upstream-observer.mts";
import { completedListingCandidates } from "./listing-observation-delivery.mts";
import { readUpstreamObservations, type UpstreamInput } from "./maintenance-upstream.mts";
import { isRecord } from "./runtime-values.mts";

/**
 * The listing observations the observer has accumulated, as the facts
 * worker's report `{ listings }`: for every source that has ever completed,
 * its last complete listing observation, still bound to the current
 * canonical listing and catalog (`completedListingCandidates`, the listing
 * delivery's own rule). A source whose latest attempt ended for an upstream
 * reason (the checkpoint's stated `coverage`: failed, unavailable or a
 * provider-truncated partial) carries that status, so the worker keeps its
 * last-good facts within its retention bound instead of reconfirming them.
 * The observer's own partial progress (budget, cancellation, quota:
 * `partialProgressRules`) is not a statement about upstream and keeps the
 * complete observation. `gaps` names sources with no applicable completed
 * observation; their listings stay unobserved, as before.
 */
export function accumulatedObservations(
  input: UpstreamInput,
  current: unknown,
  canonical: unknown,
  now = Date.now(),
) {
  const gaps: string[] = [];
  const candidates = completedListingCandidates(input, current, canonical, now, gaps);
  const checkpoint = validateCatalogObserverCheckpoint(input.checkpoint, now);
  const stated = new Map<string, string>();
  for (const source of catalogObservationSources(input.catalog).sources) {
    const coverage = checkpoint.sources[source.key]?.coverage;
    if (!coverage || partialProgressRules.includes(coverage.rule)) continue;
    for (const port of source.ports) if (!stated.has(port.id)) stated.set(port.id, coverage.kind);
  }
  const listings: { id: string; upstream_observation: Record<string, unknown> }[] = [];
  const seen = new Set<string>();
  for (const candidate of candidates) {
    const id = candidate.id;
    if (typeof id !== "string" || seen.has(id) || !isRecord(candidate.upstream_observation))
      continue;
    seen.add(id);
    const status = stated.get(id);
    listings.push({
      id,
      upstream_observation: status
        ? { ...candidate.upstream_observation, status }
        : candidate.upstream_observation,
    });
  }
  listings.sort((left, right) => (left.id < right.id ? -1 : left.id > right.id ? 1 : 0));
  return { listings, gaps };
}

async function main(argv: string[]) {
  const { values } = parseArgs({ args: argv, options: { output: { type: "string" } } });
  if (!values.output) throw new Error("Usage: listing-facts-observations.mts --output FILE");
  const root = fileURLToPath(new URL("../", import.meta.url));
  const catalogDirectory = path.join(root, "crates/portcove-core/catalog");
  const input = await readUpstreamObservations((revision, file) =>
    execFileSync("git", ["show", `${revision}:${file}`], {
      cwd: root,
      maxBuffer: 64 * 1024 * 1024,
      timeout: 15_000,
    }),
  );
  const read = (name: string): unknown =>
    JSON.parse(readFileSync(path.join(catalogDirectory, name), "utf8"));
  const { listings, gaps } = accumulatedObservations(
    input,
    read("catalog.json"),
    read("listings.json"),
  );
  writeFileSync(values.output, `${JSON.stringify({ listings })}\n`);
  if (process.env.GITHUB_OUTPUT)
    appendFileSync(
      process.env.GITHUB_OUTPUT,
      `observer_revision=${input.revision}\nobserved=${listings.length}\n`,
    );
  if (process.env.GITHUB_STEP_SUMMARY)
    appendFileSync(
      process.env.GITHUB_STEP_SUMMARY,
      `Observer checkpoint \`${input.revision}\`: ${listings.length} accumulated listing observations; ${gaps.length} sources without an applicable completed observation.\n`,
    );
  return `${JSON.stringify({ observer_revision: input.revision, observed: listings.length, gaps: gaps.length })}\n`;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).then(
    (text) => process.stdout.write(text),
    (error: unknown) => {
      process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
      process.exitCode = 1;
    },
  );
}
