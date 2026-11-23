import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";
import {
  type LedgerEntry,
  bodyPath,
  ledgerExtends,
  listingFloorLedgerPath,
  parseLedger,
  planBodyWindow,
  policyListings,
  retainBodies,
} from "./catalog-body-window.mts";
import { overlayCatalogPages } from "./catalog-pages-overlay.mts";
import {
  parsePublicationPins,
  publicationPinsFile,
  readPublicationPins,
  verifyPublicationPin,
} from "./catalog-publication-pins.mts";
import { copyPriorRepository, retentionPlan, treeDigest } from "./catalog-publish.mts";

const legacy = "policy/official/catalog.listings.json";
const compact = "policy/official/catalog.listings.compact.json";
const sha = (bytes: string | Buffer) => createHash("sha256").update(bytes).digest("hex");
const root = fileURLToPath(new URL("../", import.meta.url));

function temp(t: TestContext) {
  const directory = mkdtempSync(path.join(os.tmpdir(), "catalog-body-window-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  return directory;
}

function put(base: string, name: string, value: string | object) {
  const file = path.join(base, name);
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, typeof value === "string" ? value : JSON.stringify(value));
}

const body = (revision: number) => `{"revision":${revision},"body":"${"x".repeat(revision)}"}`;

function entry(version: number, revision: number, target = legacy): LedgerEntry {
  const bytes = body(revision);
  return {
    policy_version: version,
    target,
    sha256: sha(bytes),
    length: Buffer.byteLength(bytes),
    revision,
    decoded_sha256: sha(bytes),
    withdrawn_ids_count: 0,
    withdrawn_ids_sha256: sha("[]"),
  };
}

const ledgerBytes = (entries: LedgerEntry[]) =>
  `${JSON.stringify({ entries, kind: "catalog-listing-floor-ledger", ledger_schema: 1 }, null, 2)}\n`;

function policy(revision: number) {
  const bytes = body(revision);
  return {
    signed: {
      targets: {
        [legacy]: { length: Buffer.byteLength(bytes), hashes: { sha256: sha(bytes) } },
        "policy/official/other.json": { length: 2, hashes: { sha256: sha("{}") } },
      },
    },
  };
}

/** Policy versions 1..n each name the body of the same revision. */
function policies(n: number) {
  return new Map(
    Array.from({ length: n }, (_, index) => [index + 1, policyListings(policy(index + 1))]),
  );
}

function served(revisions: number[]) {
  return new Map(
    revisions.map((revision) => {
      const bytes = body(revision);
      return [
        bodyPath(legacy, sha(bytes)),
        { sha256: sha(bytes), bytes: Buffer.byteLength(bytes) },
      ];
    }),
  );
}

const pin = (name: string, version: number) => ({
  name,
  pages_commit: sha(name).slice(0, 40),
  policy_version: version,
  reason: "test",
});

void test("retention is off unless a mode is named, and only known modes are accepted", () => {
  assert.equal(retainBodies(undefined), "all");
  assert.equal(retainBodies("window"), "window");
  assert.throws(() => retainBodies("prune"), /one of all, ledger, window/u);
});

void test("the window keeps current, previous, newest and pinned bodies and prunes the rest", () => {
  const ledger = [1, 2, 3, 4, 5].map((v) => entry(v, v));
  const plan = planBodyWindow({
    policies: policies(6),
    previous: 5,
    pins: [pin("last-good", 2)],
    publishedLedger: ledger.slice(0, 4),
    nextLedger: ledger,
    served: served([1, 2, 3, 4, 5]),
    historyMode: false,
  });
  assert.equal(plan.refused, null);
  assert.deepEqual(
    plan.prune.map(({ path: name }) => name).sort(),
    [1, 3, 4].map((r) => bodyPath(legacy, sha(body(r)))).sort(),
  );
  assert.deepEqual(plan.keep.get(bodyPath(legacy, sha(body(6)))), [
    "current publication",
    "current body",
    "latest named",
  ]);
  assert.deepEqual(plan.keep.get(bodyPath(legacy, sha(body(5)))), [
    "previous publication",
    "previous body",
    "newest revision",
  ]);
  assert.deepEqual(plan.keep.get(bodyPath(legacy, sha(body(2)))), ["pin last-good"]);
  // Only listing bodies are ever candidates.
  assert.ok(![...plan.keep.keys()].some((name) => name.includes("other.json")));
});

void test("the window fails closed: no published ledger, no extension, history, missing pins or entries", () => {
  const ledger = [1, 2, 3].map((v) => entry(v, v));
  const base = {
    policies: policies(4),
    previous: 3,
    pins: [],
    publishedLedger: ledger,
    nextLedger: ledger,
    served: served([1, 2, 3]),
    historyMode: false,
  };
  assert.equal(planBodyWindow(base).prune.length, 2);
  for (const [change, refusal] of [
    [{ publishedLedger: null }, /no listing-floor ledger was published/u],
    [{ nextLedger: ledger.slice(1) }, /does not extend/u],
    [{ historyMode: true }, /checkpointed history/u],
    [{ pins: [pin("gone", 99)] }, /unretained policy version/u],
    [{ previous: 99 }, /previous publication's policy/u],
  ] as const) {
    const plan = planBodyWindow({ ...base, ...change });
    assert.match(plan.refused ?? "", refusal);
  }
  // A body without an exact published entry is held, never pruned.
  const missing = planBodyWindow({ ...base, publishedLedger: [] });
  assert.deepEqual(missing.prune, []);
  assert.deepEqual(
    missing.held.map(({ reason }) => reason),
    ["no published ledger entry", "no published ledger entry"],
  );
  const changed = [{ ...ledger[0]!, length: 1 }, ...ledger.slice(1)];
  const different = planBodyWindow({ ...base, publishedLedger: changed, nextLedger: changed });
  assert.deepEqual(
    different.prune.map(({ path: name }) => name),
    [bodyPath(legacy, sha(body(2)))],
  );
  assert.deepEqual(different.held, [
    { path: bodyPath(legacy, sha(body(1))), reason: "served bytes differ from the ledger entry" },
  ]);
});

void test("the newest revision of each listing target is kept even when no longer current", () => {
  // After a carrier stops being named (the compact cutover), its last body
  // sets that carrier's floor and stays served.
  const policiesWithCompact = new Map([
    [1, new Map([[legacy, { sha256: sha(body(1)), length: body(1).length }]])],
    [2, new Map([[legacy, { sha256: sha(body(2)), length: body(2).length }]])],
    [3, new Map([[compact, { sha256: sha(body(3)), length: body(3).length }]])],
    [4, new Map([[compact, { sha256: sha(body(4)), length: body(4).length }]])],
    [5, new Map([[compact, { sha256: sha(body(5)), length: body(5).length }]])],
  ]);
  const ledger = [entry(1, 1), entry(2, 2), entry(3, 3, compact), entry(4, 4, compact)];
  const plan = planBodyWindow({
    policies: policiesWithCompact,
    previous: 4,
    pins: [],
    publishedLedger: ledger,
    nextLedger: ledger,
    served: new Map([
      ...served([1, 2]),
      [bodyPath(compact, sha(body(3))), { sha256: sha(body(3)), bytes: body(3).length }],
    ]),
    historyMode: false,
  });
  assert.deepEqual(plan.keep.get(bodyPath(legacy, sha(body(2)))), [
    "latest named",
    "newest revision",
  ]);
  assert.deepEqual(plan.keep.get(bodyPath(compact, sha(body(4)))), [
    "previous publication",
    "previous body",
    "newest revision",
  ]);
  assert.deepEqual(
    plan.prune.map(({ path: name }) => name).sort(),
    [bodyPath(legacy, sha(body(1))), bodyPath(compact, sha(body(3)))].sort(),
  );
});

void test("the body the latest signed policy names is kept whatever the ledger's revisions say", () => {
  // The ledger's revisions are unsigned. A ledger whose stale-carrier entries
  // disagree with signed order must not move the window off the body that the
  // latest signed policy version names, which the verifier requires.
  const policiesWithCompact = new Map([
    [1, new Map([[legacy, { sha256: sha(body(1)), length: body(1).length }]])],
    [2, new Map([[legacy, { sha256: sha(body(2)), length: body(2).length }]])],
    [3, new Map([[legacy, { sha256: sha(body(3)), length: body(3).length }]])],
    [4, new Map([[compact, { sha256: sha(body(4)), length: body(4).length }]])],
    [5, new Map([[compact, { sha256: sha(body(5)), length: body(5).length }]])],
  ]);
  const ledger = [{ ...entry(1, 1), revision: 9 }, entry(2, 2), entry(3, 3), entry(4, 4, compact)];
  const plan = planBodyWindow({
    policies: policiesWithCompact,
    previous: 4,
    pins: [],
    publishedLedger: ledger,
    nextLedger: ledger,
    served: served([1, 2, 3]),
    historyMode: false,
  });
  assert.equal(plan.refused, null);
  assert.deepEqual(plan.keep.get(bodyPath(legacy, sha(body(3)))), ["latest named"]);
  assert.deepEqual(plan.keep.get(bodyPath(legacy, sha(body(1)))), ["newest revision"]);
  assert.deepEqual(
    plan.prune.map(({ path: name }) => name),
    [bodyPath(legacy, sha(body(2)))],
  );
});

void test("ledger shape checks refuse malformed or repeated entries", () => {
  const good = [entry(1, 1), entry(2, 2)];
  assert.deepEqual(parseLedger(Buffer.from(ledgerBytes(good))), good);
  assert.ok(ledgerExtends(good, good.slice(0, 1)));
  assert.ok(!ledgerExtends(good.slice(0, 1), good));
  assert.ok(!ledgerExtends([entry(1, 3), entry(2, 2)], good.slice(0, 1)));
  for (const bad of [
    [{ ...entry(1, 1), extra: true }],
    [{ ...entry(1, 1), target: "policy/official/other.json" }],
    [{ ...entry(1, 1), revision: 0 }],
    [entry(1, 1), entry(2, 1)],
  ])
    assert.throws(() => parseLedger(Buffer.from(ledgerBytes(bad as LedgerEntry[]))));
  assert.throws(() => parseLedger(Buffer.from("{}")), /schema differs/u);
});

void test("the committed pin store is well formed and pins are bounded and unique", () => {
  const pins = readPublicationPins(path.join(root, publicationPinsFile));
  assert.ok(pins.length >= 1 && pins.length <= 8);
  const document = (value: unknown[]) => JSON.stringify({ schema_version: 1, pins: value });
  assert.throws(() =>
    parsePublicationPins(document(Array.from({ length: 9 }, (_, i) => pin(`p${i}`, i + 1)))),
  );
  assert.throws(() => parsePublicationPins(document([pin("a", 1), pin("a", 2)])));
  assert.throws(() => parsePublicationPins(document([{ ...pin("a", 1), pages_commit: "abc" }])));
  assert.throws(() => parsePublicationPins(document([{ ...pin("a", 1), policy_version: 0 }])));
  assert.throws(() => parsePublicationPins(JSON.stringify({ schema_version: 2, pins: [] })));
});

function git(cwd: string, ...args: string[]) {
  return execFileSync("git", ["-C", cwd, ...args], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "github-actions[bot]",
      GIT_AUTHOR_EMAIL: "bot@example.invalid",
      GIT_COMMITTER_NAME: "github-actions[bot]",
      GIT_COMMITTER_EMAIL: "bot@example.invalid",
    },
  }).trim();
}

function publication(site: string, version: number) {
  const catalog = path.join(site, "catalog");
  put(catalog, "metadata/timestamp.json", { signed: { meta: { "snapshot.json": { version } } } });
  put(catalog, `metadata/${version}.snapshot.json`, {
    signed: { meta: { "official-policy.json": { version } } },
  });
  put(catalog, `metadata/${version}.official-policy.json`, policy(version));
  put(catalog, bodyPath(legacy, sha(body(version))), body(version));
}

void test("a pin verifies only against the publication commit that served its policy", (t) => {
  const site = temp(t);
  git(site, "init", "--quiet");
  publication(site, 1);
  git(site, "add", "-A");
  git(site, "commit", "--quiet", "-m", `Publish the official catalog from ${"a".repeat(40)}`);
  const first = git(site, "rev-parse", "HEAD");
  publication(site, 2);
  git(site, "add", "-A");
  git(site, "commit", "--quiet", "-m", `Publish the official catalog from ${"b".repeat(40)}`);
  const evidence = verifyPublicationPin(site, { ...pin("first", 1), pages_commit: first });
  assert.deepEqual(evidence.bodies, [
    { path: bodyPath(legacy, sha(body(1))), sha256: sha(body(1)), bytes: body(1).length },
  ]);
  assert.throws(
    () => verifyPublicationPin(site, { ...pin("first", 2), pages_commit: first }),
    /serves policy 1, not 2/u,
  );
  writeFileSync(path.join(site, "README.md"), "app");
  git(site, "add", "-A");
  git(site, "commit", "--quiet", "-m", "Publish Portcove to: preview");
  assert.throws(
    () =>
      verifyPublicationPin(site, {
        ...pin("app", 2),
        pages_commit: git(site, "rev-parse", "HEAD"),
      }),
    /not an ordinary catalog publication/u,
  );
});

function overlayFixture(t: TestContext, publishedLedger: LedgerEntry[] | null) {
  const directory = temp(t);
  const prior = path.join(directory, "prior");
  const repository = path.join(directory, "repository");
  const files: Record<string, string> = {};
  const both = (name: string, value: string | object) => {
    const bytes = typeof value === "string" ? value : JSON.stringify(value);
    put(prior, name, bytes);
    put(repository, name, bytes);
    files[name] = bytes;
  };
  for (let version = 1; version <= 4; version += 1) {
    both(`metadata/${version}.official-policy.json`, policy(version));
    both(bodyPath(legacy, sha(body(version))), body(version));
  }
  both("metadata/4.snapshot.json", {
    signed: { meta: { "official-policy.json": { version: 4 } } },
  });
  put(prior, "metadata/timestamp.json", {
    signed: { meta: { "snapshot.json": { version: 4 } } },
  });
  put(prior, "browse/index.html", "old browse");
  if (publishedLedger) put(prior, listingFloorLedgerPath, ledgerBytes(publishedLedger));
  // This run: policy 5 names a new body.
  const timestamp = JSON.stringify({ signed: { meta: { "snapshot.json": { version: 5 } } } });
  for (const [name, value] of [
    ["metadata/5.official-policy.json", JSON.stringify(policy(5))],
    [
      "metadata/5.snapshot.json",
      JSON.stringify({ signed: { meta: { "official-policy.json": { version: 5 } } } }),
    ],
    [bodyPath(legacy, sha(body(5))), body(5)],
    ["metadata/timestamp.json", timestamp],
  ] as const) {
    put(repository, name, value);
    files[name] = value;
  }
  put(repository, "browse/index.html", "browse");
  const ledger = ledgerBytes([1, 2, 3, 4].map((v) => entry(v, v)));
  const ledgerFile = path.join(directory, "listing-floors.json");
  writeFileSync(ledgerFile, ledger);
  const identities = Object.entries(files)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([target, bytes]) => ({ target, bytes: Buffer.byteLength(bytes), sha256: sha(bytes) }));
  const report = {
    schema_version: 1,
    authority: "none",
    files: identities,
    repository_sha256: sha(JSON.stringify(identities)),
    timestamp_sha256: sha(timestamp),
    listing_floor_ledger: { sha256: sha(ledger), bytes: Buffer.byteLength(ledger) },
  };
  return { prior, repository, report, ledgerFile, ledger };
}

void test("overlay retention all leaves the served tree exactly as before, even beside a ledger", async (t) => {
  const { prior, repository, report } = overlayFixture(t, null);
  put(prior, listingFloorLedgerPath, "not a ledger");
  const result = await overlayCatalogPages(prior, treeDigest(prior), repository, report);
  assert.deepEqual(result.removed, []);
  assert.equal(result.retention.mode, "all");
  assert.equal(readFileSync(path.join(prior, listingFloorLedgerPath), "utf8"), "not a ledger");
  assert.ok(existsSync(path.join(prior, bodyPath(legacy, sha(body(1))))));
});

void test("overlay retention ledger serves the verified ledger and prunes nothing", async (t) => {
  const { prior, repository, report, ledgerFile, ledger } = overlayFixture(t, null);
  const result = await overlayCatalogPages(prior, treeDigest(prior), repository, report, {
    mode: "ledger",
    ledger: ledgerFile,
  });
  assert.ok(result.changed.includes(listingFloorLedgerPath));
  assert.deepEqual(result.removed, []);
  assert.equal(readFileSync(path.join(prior, listingFloorLedgerPath), "utf8"), ledger);
  await assert.rejects(
    overlayCatalogPages(prior, treeDigest(prior), repository, report, {
      mode: "ledger",
      ledger: path.join(prior, "metadata/1.official-policy.json"),
    }),
    /differs from its verified receipt/u,
  );
});

void test("overlay window prunes only bodies the published ledger already records", async (t) => {
  // The first window run publishes the ledger and prunes nothing.
  const first = overlayFixture(t, null);
  const backfill = await overlayCatalogPages(
    first.prior,
    treeDigest(first.prior),
    first.repository,
    first.report,
    { mode: "window", ledger: first.ledgerFile, pins: [] },
  );
  assert.deepEqual(backfill.removed, []);
  assert.match(backfill.retention.refused ?? "", /no listing-floor ledger was published/u);

  const { prior, repository, report, ledgerFile } = overlayFixture(
    t,
    [1, 2, 3].map((v) => entry(v, v)),
  );
  const result = await overlayCatalogPages(prior, treeDigest(prior), repository, report, {
    mode: "window",
    ledger: ledgerFile,
    pins: [pin("last-good", 1)],
  });
  // Current (5), previous publication and newest ledger revision (4) and the
  // pin (1) stay; 2 and 3 leave the served tree and are staged as deletions.
  assert.deepEqual(result.removed.sort(), [2, 3].map((r) => bodyPath(legacy, sha(body(r)))).sort());
  for (const revision of [1, 4, 5])
    assert.ok(existsSync(path.join(prior, bodyPath(legacy, sha(body(revision))))), `${revision}`);
  for (const revision of [2, 3])
    assert.ok(!existsSync(path.join(prior, bodyPath(legacy, sha(body(revision))))), `${revision}`);
  assert.equal(result.retention.pruned.bodies, 2);
  assert.equal(result.retention.kept.bodies, 3);
  assert.ok(existsSync(path.join(prior, "metadata/1.official-policy.json")));

  // History mode keeps every body and publication continues.
  const history = overlayFixture(
    t,
    [1, 2, 3].map((v) => entry(v, v)),
  );
  const kept = await overlayCatalogPages(
    history.prior,
    treeDigest(history.prior),
    history.repository,
    history.report,
    { mode: "window", ledger: history.ledgerFile, pins: [], historyMode: true },
  );
  assert.deepEqual(kept.removed, []);
  assert.match(kept.retention.refused ?? "", /checkpointed history/u);
});

void test("signers never see the ledger, and retention stays off beside history", (t) => {
  const site = temp(t);
  put(site, "metadata/timestamp.json", "{}");
  put(site, "browse/index.html", "visitor");
  put(site, listingFloorLedgerPath, ledgerBytes([]));
  const tuf = path.join(temp(t), "tuf");
  copyPriorRepository(site, tuf);
  assert.ok(!existsSync(path.join(tuf, "history-ledger")));
  assert.ok(existsSync(path.join(tuf, "metadata/timestamp.json")));
  assert.deepEqual(retentionPlan(site, "all", undefined), {});
  assert.deepEqual(retentionPlan(null, "window", undefined), {});
  assert.deepEqual(retentionPlan(site, "window", undefined), {
    retain_bodies: "window",
    listing_ledger: "extend",
  });
  rmSync(path.join(site, "history-ledger"), { recursive: true });
  assert.deepEqual(retentionPlan(site, "ledger", undefined), {
    retain_bodies: "ledger",
    listing_ledger: "backfill",
  });
  assert.match(retentionPlan(site, "window", "segmented").notice ?? "", /stays off/u);
});

void test("the workflow ships retention off and reads gh-pages without its history", () => {
  const workflow = parse(
    readFileSync(path.join(root, ".github/workflows/catalog-publish.yml"), "utf8"),
  ) as { env?: Record<string, string>; jobs: Record<string, { steps?: { run?: string }[] }> };
  assert.deepEqual(workflow.env, { CATALOG_RETAIN_BODIES: "all" });
  const prepare = workflow.jobs.prepare!.steps!.map((step) => step.run ?? "").join("\n");
  assert.match(
    prepare,
    /git fetch --quiet --depth=1 origin refs\/heads\/gh-pages:refs\/remotes\/origin\/gh-pages/u,
  );
  assert.match(prepare, /--retain-bodies "\$CATALOG_RETAIN_BODIES"/u);
  const publish = workflow.jobs.publish!.steps!.map((step) => step.run ?? "").join("\n");
  assert.match(
    publish,
    /git fetch --quiet --depth=1 origin refs\/heads\/gh-pages:refs\/remotes\/origin\/gh-pages/u,
  );
  assert.match(publish, /--retain-bodies "\$RETAIN_BODIES" --ledger /u);
  assert.match(
    publish,
    /--pins release\/catalog-publication-pins\.json --history-mode "\$HISTORY_MODE"/u,
  );
});
