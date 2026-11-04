/** Finite initial Pages rehearsal, isolated below one run's namespace. Unknown
 * previous site ownership refuses; it is never replaced with a partial tree. */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { isRecord } from "./runtime-values.mts";
import {
  rehearsalExecution,
  rehearsalExecutionRef,
  rehearsalOrigin,
  rehearsalPublicBase,
} from "./upstream-release-identity.mts";
import {
  rehearsalApi as api,
  rehearsalEntry,
  inspectRehearsalFeed,
  verifyRehearsalPackage,
} from "./upstream-release-rehearsal.mts";
import { assertRehearsalProtection } from "./upstream-release-runtime.mts";
import { verifyImmutableRehearsal } from "./upstream-release-publication.mts";

const sha256 = (bytes: string | Buffer) => createHash("sha256").update(bytes).digest("hex");
const signedDirectory = "work/upstream-signed";
const publicOrigin = "https://boburning.github.io/portcove/";

export function rehearsalFeedTransition(
  phase: "baseline" | "candidate",
  actual: string | null,
  baseline: string,
  candidate: string,
) {
  if (actual === candidate) return { deploy: false, state: "candidate" as const };
  if (actual === baseline) return { deploy: phase === "candidate", state: phase };
  if (actual === null && phase === "baseline") return { deploy: true, state: "baseline" as const };
  throw new Error("previous usable public feed is missing or differs; no overwrite or rollback");
}

async function publicBytes(url: string): Promise<Buffer | null> {
  if (!url.startsWith(publicOrigin)) throw new Error("public read left the fixed Pages origin");
  const response = await fetch(url, {
    redirect: "error",
    signal: AbortSignal.timeout(10000),
    headers: { "Cache-Control": "no-cache" },
  });
  if (response.status === 404) {
    await response.body?.cancel();
    return null;
  }
  if (
    !response.ok ||
    !response.body ||
    Number(response.headers.get("content-length") ?? "0") > 2 * 1024 ** 2
  )
    throw new Error("bounded public Pages read refused");
  let total = 0;
  const chunks: Buffer[] = [];
  for await (const value of response.body) {
    const chunk: unknown = value;
    assert.ok(chunk instanceof Uint8Array);
    total += chunk.byteLength;
    if (total > 2 * 1024 ** 2) throw new Error("public Pages file exceeded its streaming bound");
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks, total);
}

async function feeds() {
  const origin = rehearsalOrigin();
  for (const name of ["baseline-feed.json", "feed.json"]) {
    if ((await rehearsalEntry(signedDirectory, name)).bytes > 2 * 1024 ** 2)
      throw new Error("public feed transfer exceeds its metadata bound");
  }
  const baseline = inspectRehearsalFeed(
    JSON.parse(await readFile(path.join(signedDirectory, "baseline-feed.json"), "utf8")),
  );
  const candidate = inspectRehearsalFeed(
    JSON.parse(await readFile(path.join(signedDirectory, "feed.json"), "utf8")),
  );
  const root = await rehearsalEntry(signedDirectory, "trusted-root.json");
  for (const files of [baseline, candidate]) {
    const bundledRoot = files.find((file) => file.path === "metadata/1.root.json");
    assert.ok(bundledRoot && sha256(bundledRoot.text) === root.sha256);
  }
  const timestamp = (files: typeof baseline) => {
    const file = files.find((value) => value.path === "metadata/timestamp.json");
    assert.ok(file);
    return sha256(file.text);
  };
  return {
    origin,
    baseline,
    candidate,
    baselineTimestamp: timestamp(baseline),
    candidateTimestamp: timestamp(candidate),
  };
}

async function verifyPublicFiles(state: "baseline" | "candidate") {
  const data = await feeds(),
    base = rehearsalPublicBase(data.origin);
  for (const file of data[state]) {
    const actual = await publicBytes(`${base}${file.path}`);
    assert.ok(
      actual && actual.equals(Buffer.from(file.text)),
      `public rehearsal byte mismatch: ${file.path}`,
    );
  }
}

async function assertExclusiveInitialSite() {
  const execution = rehearsalExecution(),
    origin = rehearsalOrigin();
  // Reuse the already appointed initial setup preimage. Current404s alone do
  // not establish historical or unlisted-route absence, nor a publication grant.
  const historical = await readFile(
    "release/bootstrap-public-inputs/historical-initial-site-preimage.json",
  );
  assert.equal(historical.length, 1134);
  assert.equal(
    sha256(historical),
    "82c2fdde9c53051f265a702c3e92b1c2e93a1fd0b973b23022da6750e9846767",
  );
  const settings = api("pages");
  assert.ok(
    isRecord(settings) &&
      settings.build_type === "workflow" &&
      settings.https_enforced === true &&
      settings.html_url === publicOrigin,
  );
  const policies = api("environments/github-pages/deployment-branch-policies?per_page=100");
  assert.ok(
    isRecord(policies) &&
      Array.isArray(policies.branch_policies) &&
      policies.total_count === policies.branch_policies.length &&
      policies.branch_policies.length === 2,
  );
  const allowed = [
    "portcove-production-controller-catalog-20261028r2",
    rehearsalExecutionRef.slice("refs/tags/".length),
  ].sort();
  assert.deepEqual(
    policies.branch_policies
      .map((value) => {
        assert.ok(isRecord(value) && value.type === "tag" && typeof value.name === "string");
        return value.name;
      })
      .sort((a, b) => a.localeCompare(b)),
    allowed,
  );
  const deployments = api("deployments?environment=github-pages&per_page=100");
  assert.ok(Array.isArray(deployments) && deployments.length < 100);
  for (const deployment of deployments) {
    assert.ok(
      isRecord(deployment) &&
        deployment.environment === "github-pages" &&
        typeof deployment.id === "number" &&
        Number.isSafeInteger(deployment.id) &&
        deployment.sha === execution.source &&
        [rehearsalExecutionRef, rehearsalExecutionRef.slice("refs/tags/".length)].includes(
          String(deployment.ref),
        ),
    );
    const statuses = api(`deployments/${deployment.id}/statuses?per_page=100`);
    assert.ok(
      Array.isArray(statuses) &&
        statuses.length > 0 &&
        statuses.length < 100 &&
        isRecord(statuses[0]),
    );
    const log = statuses[0].log_url;
    const prefix = `https://github.com/boburning/portcove/actions/runs/${execution.run_id}`;
    assert.ok(
      typeof log === "string" && (log === prefix || log.startsWith(`${prefix}/`)),
      "foreign or unknown Pages generation; preserve the entire site",
    );
  }
  const artifacts = api(`actions/runs/${origin.run_id}/artifacts?per_page=100`);
  assert.ok(
    isRecord(artifacts) &&
      Array.isArray(artifacts.artifacts) &&
      artifacts.total_count === artifacts.artifacts.length &&
      artifacts.artifacts.length < 100,
  );
  for (const artifact of artifacts.artifacts) {
    assert.ok(isRecord(artifact));
    const producer = String(artifact.name).match(
      new RegExp(`^upstream-signed-${origin.run_id}-([1-9][0-9]*)$`, "u"),
    );
    if (producer && Number(producer[1]) !== origin.run_attempt)
      throw new Error(
        "all-jobs rerun created another origin; prior site must be reconciled, never discarded",
      );
  }
  // Production components remain absent/held, never filled with disposable data.
  for (const relative of [
    "publication.json",
    "application/metadata/timestamp.json",
    "catalog/metadata/timestamp.json",
  ])
    assert.equal(
      await publicBytes(`${publicOrigin}${relative}`),
      null,
      "existing production component requires whole-site preservation before a rehearsal",
    );
}

export function hasPriorRehearsalInterruption(collections: unknown[]) {
  assert.ok(collections.length <= 2);
  let observed = false;
  for (const collection of collections) {
    assert.ok(
      isRecord(collection) &&
        Array.isArray(collection.jobs) &&
        collection.jobs.length < 100 &&
        collection.total_count === collection.jobs.length,
    );
    const feeds = collection.jobs.filter((value) => isRecord(value) && value.name === "feed");
    assert.ok(feeds.length <= 1);
    const feed: unknown = feeds[0];
    if (!isRecord(feed) || feed.status !== "completed" || feed.conclusion !== "failure") continue;
    assert.ok(Array.isArray(feed.steps));
    if (
      feed.steps.some(
        (value) =>
          isRecord(value) &&
          value.name === "Inject controlled post-publication interruption" &&
          value.conclusion === "failure",
      )
    )
      observed = true;
  }
  return observed;
}

async function priorInterruption() {
  const execution = rehearsalExecution();
  const collections: unknown[] = [];
  for (let attempt = 1; attempt < execution.run_attempt; attempt++) {
    const run = api(`actions/runs/${execution.run_id}/attempts/${attempt}`);
    assert.ok(
      isRecord(run) &&
        run.id === Number(execution.run_id) &&
        run.run_attempt === attempt &&
        run.head_sha === execution.source &&
        run.path === ".github/workflows/upstream-release-rehearsal.yml",
    );
    collections.push(api(`actions/runs/${execution.run_id}/attempts/${attempt}/jobs?per_page=100`));
  }
  return hasPriorRehearsalInterruption(collections);
}

async function prepare(phase: "baseline" | "candidate") {
  const immutable =
    phase === "candidate" ? await verifyImmutableRehearsal(signedDirectory, "feed") : null;
  if (!immutable) await verifyRehearsalPackage(signedDirectory, "baseline");
  await assertRehearsalProtection(phase);
  await assertExclusiveInitialSite();
  const data = await feeds();
  const manifest = await rehearsalEntry(signedDirectory, "rehearsal.json");
  const timestamp = await publicBytes(`${rehearsalPublicBase(data.origin)}metadata/timestamp.json`);
  const transition = rehearsalFeedTransition(
    phase,
    timestamp ? sha256(timestamp) : null,
    data.baselineTimestamp,
    data.candidateTimestamp,
  );
  if (timestamp)
    await verifyPublicFiles(
      sha256(timestamp) === data.candidateTimestamp ? "candidate" : "baseline",
    );
  else assert.equal(await publicBytes(publicOrigin), null, "initial site preimage is not absent");
  let interrupt = false;
  if (phase === "candidate") {
    assert.ok(immutable);
    const publication = {
      id: immutable.observed.release_id,
      tag: immutable.observed.tag,
      source: immutable.m.source,
      files: [...immutable.files].sort((a, b) => a.name.localeCompare(b.name)),
    };
    const expected = {
      origin: data.origin,
      release_id: immutable.observed.release_id,
      publication_sha256: sha256(JSON.stringify(publication)),
      before_timestamp_sha256: data.baselineTimestamp,
      manifest_sha256: manifest.sha256,
    };
    const recovered = await priorInterruption();
    if (!recovered) {
      assert.ok(
        timestamp && sha256(timestamp) === data.baselineTimestamp,
        "interruption requires the previously deployed usable baseline",
      );
      interrupt = true;
      await writeFile(
        "work/upstream-interruption.json",
        `${JSON.stringify({ scope: "controlled-post-publication-interruption", ...expected, executor_attempt: rehearsalExecution().run_attempt, production: false })}\n`,
        { flag: "wx" },
      );
    }
  }
  const site = "work/upstream-site";
  await mkdir(site);
  await writeFile(path.join(site, ".nojekyll"), "", { flag: "wx" });
  const prefix = `rehearsal/${data.origin.run_id}-${data.origin.run_attempt}`;
  for (const file of data[transition.state]) {
    const destination = path.join(site, prefix, "application", file.path);
    await mkdir(path.dirname(destination), { recursive: true });
    await writeFile(destination, file.text, { flag: "wx" });
  }
  await writeFile(
    "work/upstream-site-preparation.json",
    `${JSON.stringify({ scope: "finite-initial-pages-rehearsal", origin: data.origin, desired: phase, before_timestamp_sha256: timestamp ? sha256(timestamp) : null, after_timestamp_sha256: transition.state === "baseline" ? data.baselineTimestamp : data.candidateTimestamp, deploy: transition.deploy, interrupt, production: false })}\n`,
    { flag: "wx" },
  );
  if (process.env.GITHUB_OUTPUT)
    await writeFile(
      process.env.GITHUB_OUTPUT,
      `deploy=${transition.deploy}\ninterrupt=${interrupt}\n`,
      { flag: "a" },
    );
}

async function observe(phase: "baseline" | "candidate") {
  const data = await feeds(),
    manifest = await rehearsalEntry(signedDirectory, "rehearsal.json");
  const initial = await publicBytes(`${rehearsalPublicBase(data.origin)}metadata/timestamp.json`);
  const state =
    phase === "baseline" && initial && sha256(initial) === data.candidateTimestamp
      ? "candidate"
      : phase;
  const wanted = state === "baseline" ? data.baselineTimestamp : data.candidateTimestamp;
  let actual: Buffer | null = null;
  for (let attempt = 0; attempt < 10; attempt++) {
    actual = await publicBytes(`${rehearsalPublicBase(data.origin)}metadata/timestamp.json`);
    if (actual && sha256(actual) === wanted) break;
    await new Promise((resolve) => setTimeout(resolve, 3000));
  }
  assert.ok(
    actual && sha256(actual) === wanted,
    "public deployment did not reach its exact intended feed",
  );
  await verifyPublicFiles(state);
  await writeFile(
    "work/upstream-site-result.json",
    `${JSON.stringify({ scope: "actual-public-disposable-feed-byte-readback", origin: data.origin, requested_phase: phase, phase: state, timestamp_sha256: wanted, manifest_sha256: manifest.sha256, production: false })}\n`,
    { flag: "wx" },
  );
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [operation, phase] = process.argv.slice(2);
  if (phase !== "baseline" && phase !== "candidate")
    throw new Error("fixed baseline|candidate phase required");
  if (operation === "prepare") await prepare(phase);
  else if (operation === "observe") await observe(phase);
  else throw new Error("expected prepare|observe baseline|candidate");
}
