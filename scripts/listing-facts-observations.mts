// The facts batch job's observations (#1422): every listing observation the
// upstream observer has accumulated, not one run's handoff.
//
// The observer is a rotating, bounded batch: each run attempts a slice of
// the catalog's sources, and its `catalog-upstream-observations-*` handoff
// holds only that slice. Its durable record of every source is its catalog
// checkpoint, retained as the `upstream-observer-checkpoint-*` snapshot and
// already read by the maintenance inventory and the listing delivery
// (`readUpstreamObservations`). The job reads
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
  partialProgressRules,
  validateCatalogObserverCheckpoint,
} from "./catalog-upstream-observer.mts";
import {
  listingProviderIdentity,
  releaseTextOverflow,
  withReleaseText,
} from "./listing-upstream-observation.mts";
import { readUpstreamObservations, type UpstreamInput } from "./maintenance-upstream.mts";
import { isRecord } from "./runtime-values.mts";

/**
 * Stated coverage that is the observer's own progress, not a statement about
 * upstream: its budget, cancellation and quota stops (`partialProgressRules`)
 * and a collection that changed under it (`concurrent-change`).
 */
const observerSideRules: readonly string[] = [...partialProgressRules, "concurrent-change"];

/**
 * The listing observations the observer has accumulated, as the facts
 * worker's report `{ listings }`: for every source that has ever completed,
 * the last complete listing observation of each port it serves, kept while
 * the current listing still names the repository that was observed. The binding is
 * the repository, not the listing's whole declaration: the facts worker
 * reads only the observed repository's releases and assets, and a landed
 * batch rewrites the generated parts of the declarations it enrolls, which
 * must not hide them from the next run (`observer-coverage-dropped`).
 * A source whose latest attempt ended for an upstream reason (the
 * checkpoint's stated `coverage`, other than `observerSideRules`) carries
 * that status, so the worker keeps its last-good facts within its retention
 * bound instead of reconfirming them. `gaps` names sources that never
 * completed; their listings stay unobserved.
 */
export function accumulatedObservations(
  input: UpstreamInput,
  canonical: unknown,
  now = Date.now(),
) {
  const checkpoint = validateCatalogObserverCheckpoint(input.checkpoint, now);
  const listed = new Map<string, string>();
  for (const listing of isRecord(canonical) && Array.isArray(canonical.listings)
    ? canonical.listings
    : []) {
    if (!isRecord(listing) || typeof listing.id !== "string") continue;
    const identity = listingProviderIdentity(listing);
    if (identity?.provider === "github") listed.set(listing.id, identity.repository.toLowerCase());
  }
  const gaps: string[] = [];
  const found = new Map<string, Record<string, unknown>>();
  for (const key of Object.keys(checkpoint.sources).toSorted()) {
    const progress = checkpoint.sources[key]!;
    if (!progress.completed_scope_sha256) {
      gaps.push(`${progress.repository}: no completed observer scope`);
      continue;
    }
    const coverage = progress.coverage;
    const status =
      coverage && !observerSideRules.includes(coverage.rule) ? coverage.kind : undefined;
    const byPort = new Map<string, Record<string, unknown>[]>();
    for (const policy of progress.last_complete_policies)
      if (typeof policy.port_id === "string")
        byPort.set(policy.port_id, [...(byPort.get(policy.port_id) ?? []), policy]);
    for (const [id, policies] of byPort) {
      if (policies.length !== 1) {
        gaps.push(`${progress.repository}: ${id} has ${policies.length} completed projections`);
        continue;
      }
      const update = policies[0]!.listing_update;
      // The release text travels beside the observation, bound to its facts
      // digest; a projection retained before the observer kept text has
      // none, and its releases read as text unobserved.
      const observation = isRecord(update)
        ? withReleaseText(update.upstream_observation, policies[0]!.listing_release_text)
        : undefined;
      const overflow = releaseTextOverflow(policies[0]!.listing_release_text);
      if (overflow !== null)
        gaps.push(
          `${progress.repository}: ${id} release text over its budget (${overflow} bytes); read as unobserved`,
        );
      // The repository the observer was asked to observe: the listing it
      // observed, not the provider's resolved name, so a rename GitHub
      // redirects keeps its observation (the worker binds the repository id).
      const asked = isRecord(update) ? listingProviderIdentity(update) : null;
      if (
        found.has(id) ||
        !isRecord(observation) ||
        observation.provider !== "github" ||
        asked?.provider !== "github" ||
        listed.get(id) !== asked.repository.toLowerCase()
      )
        continue;
      found.set(id, status ? { ...observation, status } : observation);
    }
  }
  const listings = [...found]
    .toSorted(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
    .map(([id, upstream_observation]) => ({ id, upstream_observation }));
  return { listings, gaps };
}

async function main(argv: string[]) {
  const { values } = parseArgs({ args: argv, options: { output: { type: "string" } } });
  if (!values.output) throw new Error("Usage: listing-facts-observations.mts --output FILE");
  const root = fileURLToPath(new URL("../", import.meta.url));
  const catalogDirectory = path.join(root, "crates/portcove-core/catalog");
  // The snapshot is read against the catalog at the observer run's own
  // commit, an earlier (or, after a push since checkout, later) main commit:
  // fetch it on demand into the shallow checkout.
  const git = (args: string[]) =>
    execFileSync("git", args, { cwd: root, maxBuffer: 64 * 1024 * 1024, timeout: 60_000 });
  const input = await readUpstreamObservations((revision, file) => {
    if (!/^[0-9a-f]{40}$/u.test(revision)) throw new Error(`Not a commit id: ${revision}`);
    try {
      git(["cat-file", "-e", `${revision}^{commit}`]);
    } catch {
      git(["fetch", "--quiet", "--no-tags", "--depth=1", "origin", revision]);
    }
    return git(["show", `${revision}:${file}`]);
  });
  const { listings, gaps } = accumulatedObservations(
    input,
    JSON.parse(readFileSync(path.join(catalogDirectory, "listings.json"), "utf8")),
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
