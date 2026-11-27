import {
  record as fixtureRecord,
  records as fixtureRecords,
  requiredFixture,
} from "./fixtures/catalog-generator-fixtures.mts";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { gzipSync } from "node:zlib";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { overlayCatalogPages } from "./catalog-pages-overlay.mts";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";
import { observePinnedCatalog } from "./catalog-publication-continuation.mts";
import {
  assemblyConfig,
  bundleTargets,
  contextConfig,
  copyPriorRepository,
  inspectionReport,
  newestGreen,
  planPublication,
  priorVersions,
  publishedTargets,
  renewalDue,
  sameTargets,
  signConfig,
  treeDigest,
  limitSignerHistory,
  stageHistoryObjects,
} from "./catalog-publish.mts";
import {
  describeCatalogPublication,
  LateReadbackFailure,
  verifyCatalogPublicationLive,
} from "./catalog-publication-receipt.mts";

const overlaySha256 = (bytes: string) => createHash("sha256").update(bytes).digest("hex");
const overlayTimestamp = "metadata/timestamp.json";
const priorMetadata = "metadata/1.official-definitions.json";
const addedMetadata = "metadata/2.official-definitions.json";
const priorTarget = `targets/${overlaySha256("historic")}.policy/official/catalog.listings.json`;

function overlayFile(root: string, target: string, bytes: string) {
  const destination = path.join(root, target);
  mkdirSync(path.dirname(destination), { recursive: true });
  writeFileSync(destination, bytes);
}

function overlayReport(entries: Record<string, string>) {
  const timestamp = entries[overlayTimestamp];
  assert.ok(timestamp);
  const files = Object.entries(entries).map(([target, bytes]) => ({
    target,
    bytes: Buffer.byteLength(bytes),
    sha256: overlaySha256(bytes),
  }));
  return {
    schema_version: 1,
    authority: "none",
    files,
    repository_sha256: overlaySha256(JSON.stringify(files)),
    timestamp_sha256: overlaySha256(timestamp),
  };
}

void test("Pages overlay reuses retained immutable files and writes only the generation delta", async (t) => {
  const root = mkdtempSync(path.join(os.tmpdir(), "catalog-pages-overlay-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const prior = path.join(root, "prior");
  const next = path.join(root, "repository");
  overlayFile(prior, priorMetadata, "retained metadata");
  overlayFile(prior, priorTarget, "historic");
  overlayFile(prior, overlayTimestamp, "old");
  overlayFile(prior, "browse/retired.html", "retired browse page");
  overlayFile(next, addedMetadata, "new role");
  overlayFile(next, overlayTimestamp, "successor");
  overlayFile(next, "browse/index.html", "browse");
  // Retained bodies need no second read from the assembled copy.
  const result = await overlayCatalogPages(
    prior,
    treeDigest(prior),
    next,
    overlayReport({
      [priorMetadata]: "retained metadata",
      [priorTarget]: "historic",
      [addedMetadata]: "new role",
      [overlayTimestamp]: "successor",
    }),
  );
  const { retention, ...staged } = result;
  assert.deepEqual(staged, {
    changed: [addedMetadata, overlayTimestamp],
    removed: [],
    retainedBytes: 25,
    writtenBytes: 17,
  });
  // Body retention is off by default: nothing is pruned and no ledger is served.
  assert.equal(retention.mode, "all");
  assert.equal(retention.ledger, null);
  assert.deepEqual(retention.pruned, { bodies: 0, bytes: 0 });
  assert.equal(readFileSync(path.join(prior, priorTarget), "utf8"), "historic");
  assert.equal(readFileSync(path.join(prior, overlayTimestamp), "utf8"), "successor");
  assert.equal(readFileSync(path.join(prior, "browse/index.html"), "utf8"), "browse");
  assert.equal(existsSync(path.join(prior, "browse/retired.html")), false);
});

void test("Pages overlay refuses stale input, missing history, immutable replacement and changed assembly", async (t) => {
  const root = mkdtempSync(path.join(os.tmpdir(), "catalog-pages-overlay-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const prior = path.join(root, "prior");
  const next = path.join(root, "repository");
  overlayFile(prior, priorTarget, "historic");
  overlayFile(prior, overlayTimestamp, "old");
  overlayFile(next, overlayTimestamp, "corrupted");
  overlayFile(next, "browse/index.html", "browse");
  overlayFile(prior, priorMetadata, "retained metadata");
  const baseline = treeDigest(prior);
  const expected = overlayReport({
    [priorMetadata]: "retained metadata",
    [priorTarget]: "historic",
    [overlayTimestamp]: "successor",
  });
  await assert.rejects(
    overlayCatalogPages(prior, "0".repeat(64), next, expected),
    /changed since/u,
  );
  await assert.rejects(
    overlayCatalogPages(prior, baseline, next, overlayReport({ [overlayTimestamp]: "successor" })),
    /omits retained file/u,
  );
  await assert.rejects(
    overlayCatalogPages(
      prior,
      baseline,
      next,
      overlayReport({
        [priorMetadata]: "replacement metadata",
        [priorTarget]: "historic",
        [overlayTimestamp]: "successor",
      }),
    ),
    /replaces an immutable file/u,
  );
  await assert.rejects(
    overlayCatalogPages(prior, baseline, next, expected),
    /differs from receipt/u,
  );
  assert.equal(treeDigest(prior), baseline);
});

void test("signer inputs contain only live TUF files and two addressed history objects", (t) => {
  const work = mkdtempSync(path.join(os.tmpdir(), "catalog-thin-inputs-"));
  t.after(() => rmSync(work, { recursive: true, force: true }));
  const prior = path.join(work, "prior");
  const history = path.join(work, "history");
  const object = (body: string) => ({
    bytes: Buffer.byteLength(body),
    sha256: overlaySha256(body),
  });
  const tip = JSON.stringify({ files: [] });
  const active = JSON.stringify({ tip: object(tip) });
  const pointer = JSON.stringify({ active: object(active) });
  const logical = "policy/official/catalog.history-checkpoint.json";
  const pointerSha = overlaySha256(pointer);
  overlayFile(work, "plan.json", JSON.stringify({ schema_version: 1, history: "segmented" }));
  overlayFile(work, "root.json", JSON.stringify({ signed: { version: 1 } }));
  overlayFile(
    prior,
    "metadata/timestamp.json",
    JSON.stringify({
      signed: { version: 2, meta: { "snapshot.json": { version: 2 } } },
    }),
  );
  overlayFile(
    prior,
    "metadata/2.snapshot.json",
    JSON.stringify({
      signed: {
        meta: {
          "targets.json": { version: 1 },
          "official-definitions.json": { version: 2 },
          "official-policy.json": { version: 2 },
        },
      },
    }),
  );
  overlayFile(prior, "metadata/1.root.json", "root");
  overlayFile(prior, "metadata/1.targets.json", "targets");
  overlayFile(
    prior,
    "metadata/2.official-definitions.json",
    JSON.stringify({ signed: { targets: {} } }),
  );
  overlayFile(
    prior,
    "metadata/2.official-policy.json",
    JSON.stringify({
      signed: { targets: { [logical]: { hashes: { sha256: pointerSha } } } },
    }),
  );
  overlayFile(prior, `targets/${pointerSha}.${logical}`, pointer);
  overlayFile(prior, "metadata/1.snapshot.json", "earlier snapshot");
  for (const bytes of [tip, active, "earlier history object"]) {
    overlayFile(history, `sha256/${overlaySha256(bytes)}.json`, bytes);
  }
  limitSignerHistory(work);
  assert.equal(existsSync(path.join(prior, "metadata/1.snapshot.json")), false);
  assert.equal(readFileSync(path.join(prior, `targets/${pointerSha}.${logical}`), "utf8"), pointer);
  assert.equal(
    existsSync(path.join(history, `sha256/${overlaySha256("earlier history object")}.json`)),
    false,
  );
  assert.equal(readFileSync(path.join(history, `sha256/${overlaySha256(tip)}.json`), "utf8"), tip);
});

void test("history staging is append-only and refuses stale publish custody", (t) => {
  const work = mkdtempSync(path.join(os.tmpdir(), "catalog-history-stage-"));
  t.after(() => rmSync(work, { recursive: true, force: true }));
  const source = path.join(work, "next");
  const destination = path.join(work, "prior");
  const old = `sha256/${overlaySha256("earlier")}.json`;
  const next = `sha256/${overlaySha256("successor")}.json`;
  overlayFile(destination, old, "earlier");
  overlayFile(source, next, "successor");
  const guard = treeDigest(destination);
  assert.deepEqual(stageHistoryObjects(source, destination, guard), [next]);
  assert.equal(readFileSync(path.join(destination, old), "utf8"), "earlier");
  assert.throws(() => stageHistoryObjects(source, destination, guard), /changed since/u);
  assert.deepEqual(stageHistoryObjects(source, destination, treeDigest(destination)), []);
  overlayFile(source, next, "different");
  assert.throws(
    () => stageHistoryObjects(source, destination, treeDigest(destination)),
    /immutable bounds/u,
  );
});

void test("public browsing stays inside whole-tree concurrency identity but outside signer prior repository", (t) => {
  const root = temp(t),
    prior = path.join(root, "prior"),
    tuf = path.join(root, "tuf");
  site(prior, {});
  put(prior, "targets/data.json", "immutable target");
  put(prior, "browse/index.html", "<h1>Development catalog</h1>");
  const before = treeDigest(prior);
  copyPriorRepository(prior, tuf);
  assert.equal(existsSync(path.join(tuf, "browse")), false);
  assert.equal(readFileSync(path.join(tuf, "targets/data.json"), "utf8"), "immutable target");
  assert.equal(
    readFileSync(path.join(tuf, "metadata/timestamp.json"), "utf8"),
    readFileSync(path.join(prior, "metadata/timestamp.json"), "utf8"),
  );
  put(prior, "browse/index.html", "<h1>Changed visitor pages</h1>");
  assert.notEqual(treeDigest(prior), before);
});

const root = fileURLToPath(new URL("../", import.meta.url));
const workflows = path.join(root, ".github", "workflows");

function temp(t: test.TestContext) {
  const dir = mkdtempSync(path.join(os.tmpdir(), "catalog-publish-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}
function put(dir: string, name: string, value: unknown) {
  mkdirSync(path.dirname(path.join(dir, name)), { recursive: true });
  writeFileSync(path.join(dir, name), typeof value === "string" ? value : JSON.stringify(value));
}
function site(dir: string, targets: Record<string, string>) {
  put(dir, "metadata/timestamp.json", {
    signed: { version: 9, meta: { "snapshot.json": { version: 7 } } },
  });
  put(dir, "metadata/7.snapshot.json", {
    signed: {
      version: 7,
      meta: {
        "targets.json": { version: 1 },
        "official-definitions.json": { version: 5 },
        "official-policy.json": { version: 4 },
      },
    },
  });
  const entries = (prefix: boolean) =>
    Object.fromEntries(
      Object.entries(targets)
        .filter(([name]) => name.startsWith("policy/") === prefix)
        .map(([name, sha]) => [name, { length: 1, hashes: { sha256: sha } }]),
    );
  put(dir, "metadata/5.official-definitions.json", { signed: { targets: entries(false) } });
  put(dir, "metadata/4.official-policy.json", { signed: { targets: entries(true) } });
}

function receiptSite(
  dir: string,
  rows: { id: string; revision: number }[],
  policyRevision: number,
  listing: string,
) {
  const targets: Record<string, string> = {};
  const digest = (text: string) => createHash("sha256").update(text).digest("hex");
  const payload = (target: string, value: unknown) => {
    const body = JSON.stringify(value);
    const sha = digest(body);
    if (!target) target = `sha256/${sha}.json`;
    targets[target] = sha;
    put(dir, `targets/${sha}.${target}`, body);
    return { target, sha };
  };
  const contents = payload("", { catalog: "unchanged projection" });
  const entries = rows.map(({ id, revision }) => ({
    id,
    revision,
    ...payload("", {
      namespace: "official",
      stable_id: id,
      revision,
      source_contracts: [contents.target],
      execution_contract: contents.target,
      persistence_contract: contents.target,
      artifact_bindings: [],
      evidence_references: [],
    }),
  }));
  const index = payload("definitions/index.json", {
    index_schema: 1,
    definitions: entries.map(({ id, revision, target }) => ({
      namespace: "official",
      stable_id: id,
      revision,
      target,
    })),
  });
  for (const { id, revision, sha } of entries) {
    const policy = payload(`policy/official/${id}.json`, {
      policy_revision: policyRevision,
      grant_id: `reviewed-${id}`,
      decision: { definition_revision: revision, definition_sha256: sha, index_sha256: index.sha },
    });
    payload(`policy/official/${id}.launch.json`, {
      revision: policyRevision,
      policy_sha256: policy.sha,
      assessments: [],
    });
  }
  payload("policy/official/catalog.listings.json", { listing });
  site(dir, targets);
}

void test("catalog publication readback distinguishes initial, revised, retained rebind and descriptive change", async (t) => {
  const dir = temp(t);
  const prior = path.join(dir, "prior");
  const next = path.join(dir, "next");
  const descriptive = path.join(dir, "descriptive");
  receiptSite(
    prior,
    [
      { id: "chameleon", revision: 1 },
      { id: "revised", revision: 1 },
    ],
    1,
    "old",
  );
  const nextRows = [
    { id: "chameleon", revision: 1 },
    { id: "new-entry", revision: 1 },
    { id: "revised", revision: 2 },
  ];
  receiptSite(next, nextRows, 2, "new");
  receiptSite(descriptive, nextRows, 2, "descriptive refresh");
  const change = await describeCatalogPublication(prior, next);
  assert.deepEqual(
    change.changes.map(({ id, kind }) => [id, kind]),
    [
      ["chameleon", "retained-index-rebind"],
      ["new-entry", "initial"],
      ["revised", "revised"],
    ],
  );
  assert.equal(change.listingChanged, true);
  assert.deepEqual(change.changes[0]?.prior?.entry, change.changes[0]?.published?.entry);
  assert.notDeepEqual(change.changes[0]?.prior?.policy, change.changes[0]?.published?.policy);
  const refresh = await describeCatalogPublication(next, descriptive);
  assert.deepEqual(refresh.changes, []);
  assert.deepEqual(
    refresh.targets.map(({ target }) => target),
    ["definitions/index.json", "policy/official/catalog.listings.json"],
  );
});

void test("catalog success readback requires every affected immutable target and a final timestamp match", async (t) => {
  const dir = temp(t);
  receiptSite(dir, [{ id: "chameleon", revision: 1 }], 1, "descriptive");
  const description = await describeCatalogPublication(null, dir);
  const requests: string[] = [];
  const localFetch =
    (fail?: string): typeof fetch =>
    (input) => {
      const url = new URL(input instanceof Request ? input.url : input);
      const suffix = url.pathname.split("/portcove/catalog/")[1]!;
      requests.push(`${suffix}${url.search}`);
      return Promise.resolve(
        new Response(
          fail && (suffix.includes(fail) || url.search.endsWith(fail))
            ? "different"
            : readFileSync(path.join(dir, suffix)),
        ),
      );
    };
  assert.ok((await verifyCatalogPublicationLive(description, "fixture", localFetch())) > 0);
  assert.equal(requests.length, description.targets.length + 2);
  assert.match(requests[0]!, /^metadata\/timestamp\.json\?/u);
  assert.match(requests.at(-1)!, /receipt=fixture-end$/u);
  await assert.rejects(
    verifyCatalogPublicationLive(description, "fixture", localFetch(".launch.json")),
    /readback bytes differ/u,
  );
  await assert.rejects(
    verifyCatalogPublicationLive(description, "fixture", localFetch("-end")),
    /readback bytes differ/u,
  );
});

void test("cover approval receipt brackets exact snapshot and policy bytes with the public timestamp", async (t) => {
  const dir = temp(t);
  receiptSite(dir, [{ id: "chameleon", revision: 1 }], 1, "descriptive");
  const compact = "policy/official/catalog.listings.compact.json";
  const cover = "policy/official/catalog.cover-checkpoint.json";
  const targets = publishedTargets(dir);
  for (const name of [compact, cover]) {
    targets[name] = overlaySha256(name);
    put(dir, "targets/" + targets[name] + "." + name, name);
  }
  site(dir, targets);
  const pathToPolicy = "metadata/4.official-policy.json";
  const pathToSnapshot = "metadata/7.snapshot.json";
  const policy = JSON.parse(readFileSync(path.join(dir, pathToPolicy), "utf8")) as {
    signed: { targets: Record<string, Record<string, unknown>> };
  };
  const source = {
    game_id: 1,
    game_slug: "original",
    cover_id: 1,
    image_id: "originalimage",
    image_sha256: "a".repeat(64),
    match_kind: "underlying-game",
  };
  const packet = "c".repeat(64);
  const journal = {
    format_version: 1,
    approvals: [
      {
        id: "chameleon",
        scope: "f".repeat(64),
        authored: source,
        prior: source,
        candidate: {
          ...source,
          cover_id: 2,
          image_id: "replacementimage",
          image_sha256: "b".repeat(64),
        },
        role: "cover",
        bytes: 20,
        packet,
        source: "d".repeat(40),
        run: "5",
      },
    ],
    consumed_packets: [packet],
  };
  policy.signed.targets[compact]!.custom = { portcove_cover_approvals_v1: journal };
  const policyBytes = JSON.stringify(policy);
  put(dir, pathToPolicy, policyBytes);
  const role = (version: number, bytes: string) => ({
    version,
    length: Buffer.byteLength(bytes),
    hashes: { sha256: overlaySha256(bytes) },
  });
  const snapshot = JSON.stringify({
    signed: {
      version: 7,
      meta: {
        "targets.json": { version: 1 },
        "official-definitions.json": { version: 5 },
        "official-policy.json": role(4, policyBytes),
      },
    },
  });
  put(dir, pathToSnapshot, snapshot);
  put(dir, "metadata/timestamp.json", {
    signed: { version: 9, meta: { "snapshot.json": role(7, snapshot) } },
  });
  const description = await describeCatalogPublication(null, dir);
  assert.deepEqual(description.coverApprovalReadback?.journal.consumed_packets, [packet]);
  assert.deepEqual(
    description.coverApprovalReadback?.metadata.map(({ path: file }) => file),
    [pathToSnapshot, pathToPolicy],
  );
  const requests: string[] = [];
  const localFetch =
    (stale?: string): typeof fetch =>
    (input) => {
      const url = new URL(input instanceof Request ? input.url : input);
      const file = url.pathname.split("/portcove/catalog/")[1]!;
      requests.push(file + url.search);
      return Promise.resolve(
        new Response(file === stale ? "stale role" : readFileSync(path.join(dir, file))),
      );
    };
  await verifyCatalogPublicationLive(description, "approval", localFetch());
  assert.deepEqual(requests.slice(0, 3), [
    "metadata/timestamp.json?receipt=approval",
    pathToSnapshot,
    pathToPolicy,
  ]);
  assert.equal(requests.at(-1), "metadata/timestamp.json?receipt=approval-end");
  for (const stale of [pathToSnapshot, pathToPolicy])
    await assert.rejects(verifyCatalogPublicationLive(description, "approval", localFetch(stale)));
  put(dir, pathToPolicy, policyBytes + " ");
  await assert.rejects(describeCatalogPublication(null, dir), /timestamp chain/u);
});

void test("scheduled catalog readback observes the exact retained publication across an app-only Pages deploy", async (t) => {
  const dir = temp(t);
  const git = (...args: string[]) =>
    execFileSync("git", args, { cwd: dir, encoding: "utf8" }).trim();
  git("init", "-q");
  git("config", "user.name", "github-actions[bot]");
  git("config", "user.email", "41898282+github-actions[bot]@users.noreply.github.com");
  const commit = (message: string) => {
    git("add", "--all");
    git("commit", "-qm", message);
    return git("rev-parse", "HEAD");
  };
  put(dir, "index.html", "application one");
  const root = { signed: { version: 1 } };
  put(dir, "crates/portcove-core/catalog/official-definition-root.json", root);
  const source = commit("Reviewed source");
  git("update-ref", "refs/remotes/origin/main", source);
  const catalog = path.join(dir, "catalog");
  const publisher = `Publish the official catalog from ${source}`;
  const publish = (revision: number, breakBinding?: "policy" | "active" | "tip") => {
    const digest = (bytes: string | Buffer) => createHash("sha256").update(bytes).digest("hex");
    const predecessor =
      revision === 2 ? digest(readFileSync(path.join(catalog, "metadata/timestamp.json"))) : null;
    receiptSite(catalog, [{ id: "chameleon", revision }], revision, `listing-${revision}`);
    put(catalog, "metadata/timestamp.json", {
      signed: { version: revision, meta: { "snapshot.json": { version: 7 } } },
    });
    put(catalog, "browse/index.html", `directory-${revision}`);
    put(catalog, "browse/inputs.json", { revision });
    put(catalog, "browse/search-index.json", [
      { url: "games/chameleon/index.html", reviewed_game: true, projects: ["a", "b"] },
    ]);
    put(catalog, "browse/games/chameleon/index.html", `page-${revision}`);
    if (revision === 2) {
      const object = (data: unknown) => {
        const body = JSON.stringify(data);
        const sha256 = digest(body);
        put(dir, `catalog-history/sha256/${sha256}.json`, body);
        return { bytes: Buffer.byteLength(body), sha256 };
      };
      const tip = object({
        checkpoint_schema: 1,
        files: [],
        through_timestamp_version: breakBinding === "tip" ? 2 : 1,
        through_timestamp_sha256: predecessor,
      });
      const active = object({
        checkpoint_schema: 1,
        tip,
        covered_timestamp_version: 1,
        covered_timestamp_sha256: breakBinding === "active" ? "0".repeat(64) : predecessor,
      });
      object({ checkpoint_schema: 1, files: ["additional sealed segment"] });
      const roles = "metadata/4.official-policy.json";
      const policy = fixtureRecord(JSON.parse(readFileSync(path.join(catalog, roles), "utf8")));
      const policyTargets = fixtureRecord(fixtureRecord(policy.signed).targets);
      const target = (name: string, data: unknown) => {
        const body = JSON.stringify(data);
        const sha256 = digest(body);
        put(catalog, `targets/${sha256}.${name}`, body);
        policyTargets[name] = { length: Buffer.byteLength(body), hashes: { sha256 } };
      };
      target("policy/official/catalog.history-checkpoint.json", {
        checkpoint_schema: 1,
        policy_revision: breakBinding === "policy" ? 2 : 4,
        active,
      });
      const decoded = Buffer.from(
        JSON.stringify({ revision: 2, fixture_summary: "x".repeat(70_000) }),
      );
      target("policy/official/catalog.listings.compact.json", {
        carrier: "gzip-base64-json-v1",
        gzip_base64: gzipSync(decoded, { level: 0 }).toString("base64"),
        decoded_bytes: decoded.length,
        decoded_sha256: digest(decoded),
      });
      put(catalog, roles, policy);
    }
    const writeRole = (file: string, version: number, body: Record<string, unknown>) => {
      const raw = JSON.stringify({ signed: { ...body, version } });
      put(catalog, `metadata/${file}`, raw);
      return { version, length: Buffer.byteLength(raw), hashes: { sha256: digest(raw) } };
    };
    const meta: Record<string, unknown> = {};
    for (const [role, version] of [
      ["targets", 1],
      ["official-definitions", 5],
      ["official-policy", 4],
    ] as const) {
      const file = `${version}.${role}.json`;
      const body =
        role === "targets"
          ? {}
          : fixtureRecord(
              fixtureRecord(JSON.parse(readFileSync(path.join(catalog, "metadata", file), "utf8")))
                .signed,
            );
      meta[`${role}.json`] = writeRole(file, version, body);
    }
    const snapshot = writeRole("7.snapshot.json", 7, { meta });
    writeRole("timestamp.json", revision, { meta: { "snapshot.json": snapshot } });
    put(catalog, "metadata/1.root.json", root);
    return commit(publisher);
  };
  const first = publish(1);
  const firstTimestamp = readFileSync(path.join(catalog, "metadata/timestamp.json"));
  const latest = publish(2);
  put(dir, "index.html", "application two");
  const tip = commit("Publish application");
  const observer = { run: "42", attempt: "2" };
  const localFetch =
    (replace?: (url: URL, suffix: string) => string | Buffer | undefined): typeof fetch =>
    (input) => {
      const url = new URL(input instanceof Request ? input.url : input);
      assert.equal(url.origin, "https://boburning.github.io");
      const sitePath = url.pathname.slice("/portcove/".length);
      const suffix = sitePath.startsWith("catalog/") ? sitePath.slice("catalog/".length) : sitePath;
      return Promise.resolve(
        new Response(replace?.(url, suffix) ?? readFileSync(path.join(dir, sitePath))),
      );
    };

  const result = await observePinnedCatalog(dir, observer, localFetch());
  assert.equal(result?.source_commit, source);
  assert.equal(result?.pages_commit, latest);
  assert.equal(result?.pages_parent_commit, first);
  assert.equal(result?.pinned_pages_tip, tip);
  assert.equal(result?.catalog_tree, git("rev-parse", `${latest}:catalog`));
  assert.equal(result?.observing_run, "42");
  assert.equal(result?.observing_attempt, "2");
  assert.equal(result?.published.versions?.timestamp, 2);
  assert.equal(result?.prior.versions?.timestamp, 1);
  assert.deepEqual(
    result?.changes.map(({ kind }) => kind),
    ["revised"],
  );
  assert.equal(result?.readback.timestamp_rechecked, true);
  assert.equal(result?.published.listings?.target, "policy/official/catalog.listings.compact.json");
  assert.ok(
    result?.readback.immutable_targets.some(
      ({ target }) => target === result.published.listings?.target,
    ),
  );
  assert.equal(result?.readback.history_objects.length, 4);
  assert.equal(result?.readback.role_metadata.length, 5);
  assert.ok((result?.readback.immutable_target_bytes ?? 0) > 65_536);
  assert.deepEqual(
    result?.browse.map(({ path }) => path),
    ["browse/index.html", "browse/inputs.json", "browse/games/chameleon/index.html"],
  );
  await assert.rejects(
    observePinnedCatalog(
      dir,
      observer,
      localFetch((_url, suffix) =>
        suffix === "metadata/timestamp.json" ? firstTimestamp : undefined,
      ),
    ),
    (error) => error instanceof LateReadbackFailure && error.outcome === "awaiting-deployment",
  );
  await assert.rejects(
    observePinnedCatalog(
      dir,
      observer,
      localFetch((url) =>
        url.search.endsWith("-end")
          ? JSON.stringify({
              signed: {
                version: 3,
                meta: {
                  "snapshot.json": { version: 8, length: 1, hashes: { sha256: "a".repeat(64) } },
                },
              },
            })
          : undefined,
      ),
    ),
    (error) =>
      error instanceof LateReadbackFailure &&
      error.outcome === "timestamp-changed-during-observation",
  );
  await assert.rejects(
    observePinnedCatalog(
      dir,
      observer,
      localFetch((_url, suffix) =>
        suffix === "metadata/timestamp.json" ? "unknown timestamp" : undefined,
      ),
    ),
    (error) => error instanceof LateReadbackFailure && error.outcome === "incomplete",
  );
  for (const unavailable of [
    "browse/inputs.json",
    "metadata/7.snapshot.json",
    "metadata/4.official-policy.json",
    "catalog-history/",
  ]) {
    await assert.rejects(
      observePinnedCatalog(
        dir,
        observer,
        localFetch((_url, suffix) => (suffix.startsWith(unavailable) ? "different" : undefined)),
      ),
      /readback bytes differ/u,
    );
  }

  put(catalog, "browse/index.html", "modified by a non-catalog Pages commit");
  commit("Publish application again");
  await assert.rejects(
    observePinnedCatalog(dir, observer, localFetch()),
    /changed outside the timestamp publication/u,
  );
  for (const [corruption, failure] of [
    ["policy", /published policy revision/u],
    ["active", /active history does not bind/u],
    ["tip", /history tip does not bind/u],
  ] as const) {
    git("checkout", "--quiet", "--detach", first);
    publish(2, corruption);
    await assert.rejects(observePinnedCatalog(dir, observer, localFetch()), failure);
  }
});

void test("a first publication starts every role at one; later runs advance every role", (t) => {
  const now = new Date("2026-11-15T12:00:00.000Z");
  const first = planPublication(null, now);
  assert.deepEqual(first.versions, { definitions: 1, policy: 1, snapshot: 1, timestamp: 1 });
  assert.equal(first.prior, false);
  // Lifetimes stay under the release tool's 7-day and 1-day ceilings.
  assert.equal(first.expires.definitions, "2026-11-22T11:50:00.000Z");
  assert.equal(first.expires.snapshot, "2026-11-22T11:50:00.000Z");
  assert.equal(first.expires.timestamp, "2026-11-16T11:50:00.000Z");

  const dir = temp(t);
  assert.equal(priorVersions(dir), null);
  assert.equal(priorVersions(null), null);
  site(dir, {});
  const prior = priorVersions(dir);
  assert.deepEqual(prior, { definitions: 5, policy: 4, snapshot: 7, timestamp: 9 });
  assert.deepEqual(planPublication(prior, now).versions, {
    definitions: 6,
    policy: 5,
    snapshot: 8,
    timestamp: 10,
  });
  put(dir, "metadata/7.snapshot.json", {
    signed: { meta: { "official-policy.json": { version: 0 } } },
  });
  assert.throws(() => priorVersions(dir), /official-definitions|positive/u);
});

void test("a CI-triggered run publishes only when the bundle differs from the published targets", (t) => {
  const dir = temp(t);
  const bundle = path.join(dir, "bundle");
  put(bundle, "definitions/index.json", "{}");
  put(bundle, "policy/official/x.json", "{}");
  const targets = bundleTargets(bundle);
  assert.deepEqual(Object.keys(targets), ["definitions/index.json", "policy/official/x.json"]);
  const published = path.join(dir, "site");
  site(published, targets);
  assert.deepEqual(publishedTargets(published), targets);
  assert.ok(sameTargets(targets, publishedTargets(published)));
  put(bundle, "policy/official/x.json", '{"changed":true}');
  assert.ok(!sameTargets(bundleTargets(bundle), publishedTargets(published)));
  put(bundle, "sha256/new.json", "{}");
  assert.ok(!sameTargets(bundleTargets(bundle), targets));
  assert.deepEqual(publishedTargets(path.join(dir, "none")), {});
});

void test("configs bind one plan, a fresh generation time and only the role's own key", (t) => {
  const work = temp(t);
  for (const name of ["root.json", "offline-targets.json", "inspection.json"])
    put(work, name, name);
  put(
    work,
    "plan.json",
    planPublication({ definitions: 1, policy: 1, snapshot: 1, timestamp: 1 }, new Date()),
  );
  const now = new Date("2026-11-15T12:34:56.000Z");
  const context = contextConfig(work, now);
  assert.equal(context.generated_at, "2026-11-15T12:34:56.000Z");
  assert.equal(context.previous_repository, "prior");
  assert.equal(context.initial_root_profile, "single-owner-one-of-one-v1");
  assert.equal(context.prepared_bundle, "bundle");
  assert.match(context.trusted_root_sha256, /^[0-9a-f]{64}$/u);
  assert.deepEqual(context.versions, { definitions: 2, policy: 2, snapshot: 2, timestamp: 2 });
  assert.deepEqual(signConfig("official-definitions", "/k/private.pk8"), {
    schema_version: 1,
    context: "context.json",
    signing_key: "/k/private.pk8",
    output: "roles/official-definitions.json",
  });
  // Only snapshot and timestamp read earlier roles.
  assert.equal(signConfig("official-policy", "/k").signed_roles, undefined);
  assert.equal(signConfig("snapshot", "/k").signed_roles, "roles");
  assert.equal(signConfig("timestamp", "/k").signed_roles, "roles");
  assert.deepEqual(assemblyConfig, {
    schema_version: 1,
    context: "context.json",
    signed_roles: "roles",
    output: "repository",
  });
});

void test("a CI-triggered run also renews a timestamp that expires within the window", (t) => {
  const dir = temp(t);
  const now = new Date("2026-11-15T12:00:00.000Z");
  assert.equal(renewalDue(null, now, 12), true);
  assert.equal(renewalDue(path.join(dir, "absent"), now, 12), true);
  put(dir, "metadata/timestamp.json", { signed: { expires: "2026-11-16T00:30:00Z" } });
  assert.equal(renewalDue(dir, now, 12), false);
  put(dir, "metadata/timestamp.json", { signed: { expires: "2026-11-15T23:30:00Z" } });
  assert.equal(renewalDue(dir, now, 12), true);
  put(dir, "metadata/timestamp.json", { signed: { expires: "2026-11-14T00:00:00Z" } });
  assert.equal(renewalDue(dir, now, 12), true);
  put(dir, "metadata/timestamp.json", { signed: {} });
  assert.throws(() => renewalDue(dir, now, 12), /expiry is malformed/u);
});

function preparePublication(
  t: test.TestContext,
  options: { event: string; bootstrap?: boolean; history?: boolean; pointer?: boolean },
) {
  const dir = temp(t);
  const prior = path.join(dir, "site", "catalog");
  site(
    prior,
    options.pointer
      ? { "policy/official/catalog.history-checkpoint.json": "c".repeat(64) }
      : { "policy/official/catalog.listings.json": "a".repeat(64) },
  );
  if (options.history) put(dir, "site/catalog-history/sha256/x.json", "{}");
  put(dir, "root.json", "root");
  put(dir, "offline-targets.json", "offline");
  put(dir, "bundle/policy/official/catalog.listings.json", "listing");
  put(
    dir,
    "inspection.stdout",
    JSON.stringify({
      ok: true,
      error: null,
      command: "catalog.inspect-definition-publication",
      data: { publication_schema: 1 },
    }),
  );
  const work = path.join(dir, "work");
  const stdout = execFileSync(
    process.execPath,
    [
      path.join(root, "scripts", "catalog-publish.mts"),
      "prepare",
      "--work",
      work,
      "--root",
      path.join(dir, "root.json"),
      "--offline-targets",
      path.join(dir, "offline-targets.json"),
      "--bundle",
      path.join(dir, "bundle"),
      "--inspection-stdout",
      path.join(dir, "inspection.stdout"),
      "--prior",
      prior,
      ...(options.bootstrap ? ["--bootstrap-history"] : []),
    ],
    {
      encoding: "utf8",
      env: { ...process.env, GITHUB_EVENT_NAME: options.event },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  const json = (name: string) =>
    JSON.parse(readFileSync(path.join(work, name), "utf8")) as Record<string, unknown>;
  return { work, stdout, plan: json("plan.json"), context: json("context.json") };
}

void test("push and scheduled runs plan the pre-history publication for a pointerless prior", (t) => {
  for (const event of ["workflow_run", "schedule", "workflow_dispatch"]) {
    const { work, stdout, plan, context } = preparePublication(t, { event });
    // Exactly the outputs, plan and signing context publication had before history.
    assert.match(stdout, /^prior_digest=[a-f0-9]{64}\n$/u, event);
    assert.deepEqual(
      plan,
      planPublication(
        { definitions: 5, policy: 4, snapshot: 7, timestamp: 9 },
        new Date(String(plan.planned_at)),
      ),
      event,
    );
    assert.deepEqual(
      Object.keys(context),
      [
        "schema_version",
        "initial_root_profile",
        "generated_at",
        "trusted_root",
        "trusted_root_sha256",
        "offline_targets",
        "offline_targets_sha256",
        "prepared_bundle",
        "inspection",
        "inspection_sha256",
        "previous_repository",
        "versions",
        "expires",
      ],
      event,
    );
    assert.ok(!existsSync(path.join(work, "history")), event);
    // Downstream history commands stay inert without a requested or published history.
    limitSignerHistory(work);
    assert.ok(!existsSync(path.join(work, "thin-prior")), event);
    execFileSync(process.execPath, [
      path.join(root, "scripts", "catalog-publish.mts"),
      "assembly-config",
      "--work",
      work,
    ]);
    assert.deepEqual(
      JSON.parse(readFileSync(path.join(work, "assembly.json"), "utf8")),
      assemblyConfig,
    );
  }
});

void test("only an explicit manual owner request bootstraps catalog history", (t) => {
  const manual = preparePublication(t, { event: "workflow_dispatch", bootstrap: true });
  assert.equal(manual.plan.history, "bootstrap");
  assert.equal(manual.context.bootstrap_history, true);
  assert.match(manual.stdout, /^history_mode=bootstrap$/mu);
  for (const event of ["workflow_run", "schedule", "push"])
    assert.throws(
      () => preparePublication(t, { event, bootstrap: true }),
      /owner action from a manual run only/u,
      event,
    );
  assert.throws(
    () => preparePublication(t, { event: "workflow_dispatch", bootstrap: true, history: true }),
    /objects without an authenticated pointer/u,
  );
  // A published pointer continues its archive on every trigger; it is not a new activation.
  const continued = preparePublication(t, { event: "schedule", pointer: true, history: true });
  assert.equal(continued.plan.history, "segmented");
  assert.equal(continued.context.history_store, "history");
});

void test("the history bootstrap flag is reachable only from the manual dispatch input", () => {
  const workflow = read("catalog-publish.yml");
  const source = readFileSync(path.join(workflows, "catalog-publish.yml"), "utf8");
  assert.deepEqual(workflow.on.workflow_dispatch, {
    inputs: {
      bootstrap_history: {
        description: "Owner activation only - create the first signed catalog history checkpoint",
        type: "boolean",
        default: false,
      },
      activate_cover_checkpoint: {
        description:
          "Owner activation only - admit the first cover checkpoint after signed history and released reader support",
        type: "boolean",
        default: false,
      },
      cover_replacement_packet: {
        description: "Exact independently reviewed cover replacement packet JSON",
        type: "string",
      },
      cover_replacement_sha256: {
        description: "SHA-256 of the exact review packet bytes",
        type: "string",
      },
      cover_replacement_preimages: {
        description: "JSON mapping of all reviewed port IDs to their signed current cover digests",
        type: "string",
      },
    },
  });
  assert.equal(source.match(/--bootstrap-history/gu)?.length, 1);
  assert.equal(source.match(/inputs\.bootstrap_history/gu)?.length, 1);
  assert.equal(source.match(/--activate-cover-checkpoint/gu)?.length, 1);
  assert.equal(source.match(/inputs\.activate_cover_checkpoint/gu)?.length, 1);
  const steps = workflow.jobs.prepare!.steps!;
  const prepare = steps.find(({ id }) => id === "prepare")!;
  const gate =
    "${{ github.event_name == 'workflow_dispatch' && inputs.bootstrap_history == true }}";
  const requests = steps.filter((step) => step.env?.BOOTSTRAP_HISTORY !== undefined);
  assert.equal(requests.length, 1);
  const request = requests[0]!;
  assert.deepEqual(request.env, { BOOTSTRAP_HISTORY: gate });
  assert.match(
    request.run!,
    /if \[ "\$GITHUB_EVENT_NAME" = workflow_dispatch \] && \[ "\$BOOTSTRAP_HISTORY" = true \]; then\n\s*echo "HISTORY_BOOTSTRAP=requested" >> "\$GITHUB_ENV"\n\s*fi/u,
  );
  assert.ok(steps.indexOf(request) < steps.indexOf(prepare));
  assert.equal(prepare.env, undefined);
  assert.match(
    prepare.run!,
    /history_request=\(\)\n\s*if \[ "\$GITHUB_EVENT_NAME" = workflow_dispatch \] && \[ "\$\{HISTORY_BOOTSTRAP:-\}" = requested \]; then\n\s*history_request=\(--bootstrap-history\)\n\s*fi/u,
  );
  assert.match(prepare.run!, /--prior "\$PRIOR" "\$\{history_request\[@\]\}"/u);
  // Without a history mode no history step runs.
  assert.match(
    prepare.run!,
    /if \[ -n "\$history_mode" \]; then\n[^]*?limit-signer-history[^]*?\n\s*fi/u,
  );
  assert.equal(source.match(/HISTORY_BOOTSTRAP=requested/gu)?.length, 1);
  const publish = workflow.jobs.publish!.steps!.map((step) => step.run ?? "").join("\n");
  assert.match(
    publish,
    /if \[ -n "\$HISTORY_MODE" \]; then\n\s*node scripts\/catalog-publish\.mts stage-history/u,
  );
  assert.match(
    publish,
    /if \[ -n "\$HISTORY_MODE" \]; then\n\s*history_readback=\$\(node scripts\/catalog-publish\.mts history-readback/u,
  );
  assert.match(publish, /if \[ "\$HISTORY_MODE" = segmented \]; then\n\s*\[\[/u);
});

void test("signing recreates roles/, which artifact uploads drop when empty", (t) => {
  const work = temp(t);
  for (const name of ["root.json", "offline-targets.json", "inspection.json"])
    put(work, name, name);
  put(work, "plan.json", planPublication(null, new Date()));
  assert.ok(!existsSync(path.join(work, "roles")));
  execFileSync(process.execPath, [
    path.join(root, "scripts", "catalog-publish.mts"),
    "sign-config",
    "--work",
    work,
    "--role",
    "official-definitions",
    "--key",
    path.join(work, "..", "key.pk8"),
  ]);
  assert.ok(existsSync(path.join(work, "roles")));
  const readRecord = (name: string) =>
    JSON.parse(readFileSync(path.join(work, name), "utf8")) as Record<string, unknown>;
  assert.equal(
    readRecord("sign-official-definitions.json").output,
    "roles/official-definitions.json",
  );
  assert.equal(readRecord("context.json").previous_repository, null);
});

void test("inspection keeps only a successful Core report", () => {
  const data = { publication_schema: 1, authority: "none" };
  assert.equal(
    inspectionReport(
      JSON.stringify({
        schema_version: 93,
        ok: true,
        error: null,
        command: "catalog.inspect-definition-publication",
        data,
      }),
    ),
    `${JSON.stringify(data)}\n`,
  );
  for (const envelope of [
    { ok: false, error: { code: "x" }, command: "catalog.inspect-definition-publication", data },
    { ok: true, error: null, command: "catalog.list", data },
    { ok: true, error: null, command: "catalog.inspect-definition-publication", data: null },
  ])
    assert.throws(() => inspectionReport(JSON.stringify(envelope)), /did not succeed/u);
});

void test("renewals pick the newest CI-green first-parent main commit", () => {
  const history = ["c", "b", "a"];
  const lookup = (known: Record<string, string>) => (sha: string) => known[sha] ?? "";
  assert.equal(newestGreen(history, lookup({ b: "success", a: "success" })), "b");
  assert.equal(newestGreen(history, lookup({ c: "failure", a: "success" })), "a");
  assert.equal(newestGreen(history, lookup({ c: "cancelled" })), null);
  function disputed(sha: string) {
    if (sha === "b") throw new Error("unresolved main CI attempt");
    return "success";
  }
  assert.equal(newestGreen(history, disputed), "c");
  assert.throws(() => newestGreen(history.slice(1), disputed), /unresolved main CI attempt/);
});

void test("tree digests change with any catalog file and match for absent trees", (t) => {
  const dir = temp(t);
  const empty = treeDigest(path.join(dir, "absent"));
  assert.equal(treeDigest(path.join(dir, "also-absent")), empty);
  put(dir, "catalog/metadata/timestamp.json", "1");
  const one = treeDigest(path.join(dir, "catalog"));
  assert.notEqual(one, empty);
  put(dir, "catalog/metadata/timestamp.json", "2");
  assert.notEqual(treeDigest(path.join(dir, "catalog")), one);
});

type Step = {
  id?: string;
  name?: string;
  "continue-on-error"?: boolean;
  uses?: string;
  run?: string;
  if?: string;
  env?: Record<string, string>;
  with?: Record<string, unknown>;
};
type Job = {
  if?: string;
  uses?: string;
  secrets?: string;
  environment?: string | { name?: string; deployment?: boolean };
  needs?: string | string[];
  permissions?: Record<string, string>;
  steps?: Step[];
  with?: Record<string, string>;
};
type Workflow = {
  on: Record<string, unknown>;
  permissions?: Record<string, string>;
  concurrency?: unknown;
  jobs: Record<string, Job>;
};
const read = (name: string) => parse(readFileSync(path.join(workflows, name), "utf8")) as Workflow;

void test("the existing Pages readback emits the receipt only after matching live evidence", () => {
  const steps = read("catalog-publish.yml").jobs.publish!.steps!;
  const index = steps.findIndex(({ id }) => id === "readback");
  const readback = steps[index]!.run!;
  assert.match(
    readback,
    /\[ "\$actual" = "\$expected" \][^\n]+\[ "\$sample_actual" = "\$sample_expected" \] && \[ "\$history_verified" = true \]; then\s+echo [^\n]+\s+if node scripts\/catalog-publication-receipt\.mts/u,
  );
  assert.equal(readback.match(/receipt=true/gu)?.length, 1);
  assert.match(readback, /report\.cover_approvals \? "true" : "false"/u);
  assert.match(
    readback,
    /if \[ "\$require_approval_receipt" = true \]; then\n\s+echo "::error::Pages did not serve the exact signed cover approval receipt[^]*?\n\s+exit 1/u,
  );
  assert.match(
    readback,
    /receipt=true[^\n]+\n\s+exit 0\n\s+fi\n\s+echo "::warning::Catalog publication succeeded/u,
  );
  const upload = steps[index + 1]!;
  assert.equal(upload.if, "steps.readback.outputs.receipt == 'true'");
  assert.equal(upload.with?.["retention-days"], 7);
});

void test("compact listing activation selects the released reader and rechecks it before each push", () => {
  const workflow = read("catalog-publish.yml");
  const source = readFileSync(path.join(workflows, "catalog-publish.yml"), "utf8");
  // Only automatic selection decides activation; no route forces or reverses it.
  assert.equal(source.match(/--official-released-reader/gu)?.length, 1);
  assert.doesNotMatch(source, /--compact\b|--return-to-legacy|--released-reader\b/u);
  const prepare = workflow.jobs.prepare!;
  const steps = prepare.steps!;
  const observe = steps.find(({ id }) => id === "observe")!;
  assert.equal(observe.if, "steps.decide.outputs.publish == 'true'");
  assert.match(
    prepare.if!,
    /!inputs\.cover_replacement_packet && !inputs\.cover_replacement_sha256 && !inputs\.cover_replacement_preimages[^]*github\.event_name == 'workflow_dispatch' && github\.actor_id == '43177418' &&[^]*github\.triggering_actor == github\.repository_owner/u,
  );
  assert.match(
    steps.find(({ id }) => id === "prepare")!.run!,
    /--cover-approval-report "\$RUNNER_TEMP\/observation-bundle\/report\.json"/u,
  );
  assert.deepEqual(observe.env, {
    ACTIVATE_COVER_CHECKPOINT:
      "${{ github.event_name == 'workflow_dispatch' && github.actor_id == '43177418' && github.triggering_actor == github.repository_owner && inputs.activate_cover_checkpoint == true }}",
    PORTCOVE_COVER_REVIEW_PACKET:
      "${{ github.event_name == 'workflow_dispatch' && inputs.cover_replacement_packet || '' }}",
    PORTCOVE_COVER_REVIEW_SHA256:
      "${{ github.event_name == 'workflow_dispatch' && inputs.cover_replacement_sha256 || '' }}",
    PORTCOVE_COVER_REVIEW_PREIMAGES:
      "${{ github.event_name == 'workflow_dispatch' && inputs.cover_replacement_preimages || '' }}",
    PORTCOVE_TRIGGERING_ACTOR: "${{ github.triggering_actor }}",
  });
  assert.match(
    observe.run!,
    /node scripts\/listing-observation-delivery\.mts [^]*--official-released-reader\n/u,
  );
  assert.match(observe.run!, /report\.released_reader_activation/u);
  assert.match(observe.run!, /echo "reader_activation=\$activation" >> "\$GITHUB_OUTPUT"/u);
  assert.doesNotMatch(observe.run!, /\$\{\{/u);
  assert.ok(steps.indexOf(observe) < steps.findIndex(({ id }) => id === "prepare"));
  const outputs = (prepare as Job & { outputs?: Record<string, string> }).outputs!;
  assert.equal(outputs.reader_activation, "${{ steps.observe.outputs.reader_activation }}");
  // The prepare job reads anonymously; activation adds no permission.
  assert.deepEqual(prepare.permissions, { contents: "read", actions: "read" });

  const publish = workflow.jobs.publish! as Job & { env?: Record<string, string> };
  assert.equal(
    publish.env?.CATALOG_READER_ACTIVATION,
    "${{ needs.prepare.outputs.reader_activation }}",
  );
  assert.deepEqual(publish.permissions, { contents: "write" });
  const push = publish.steps!.find((step) => step.run?.includes("for attempt in"))!;
  // Each fresh Pages base is rechecked after the worktree is recreated and
  // before anything is staged or pushed.
  const loop = push.run!;
  const worktree = loop.indexOf("git worktree add --quiet --force site");
  const recheck = loop.indexOf("node scripts/catalog-released-reader.mts site");
  assert.ok(loop.indexOf("for attempt in") < worktree && worktree < recheck);
  assert.ok(recheck < loop.indexOf("catalog-pages-overlay.mts"));
  assert.ok(recheck < loop.indexOf("git -C site push"));
  assert.match(
    loop,
    /if \[ -n "\$CATALOG_READER_ACTIVATION" \]; then\n\s*node scripts\/catalog-released-reader\.mts site\n\s*fi/u,
  );
  assert.equal(source.match(/catalog-released-reader\.mts/gu)?.length, 1);
});

void test("a stopped listing publication, pending activation or capacity guard failure fails the run only after publish and readback", () => {
  const workflow = read("catalog-publish.yml");
  const observe = workflow.jobs.prepare!.steps!.find(({ id }) => id === "observe")!;
  assert.match(
    observe.run!,
    /--withdrawals crates\/portcove-core\/catalog\/listing-withdrawals\.json \\\n/u,
  );
  const steps = workflow.jobs.publish!.steps!;
  const stop = steps.findIndex(
    ({ name }) =>
      name ===
      "Fail the run when listing publication stopped or is pending, or the capacity guard failed",
  );
  const push = steps.findIndex(({ run }) => run?.includes("git -C site push"));
  const readback = steps.findIndex(({ id }) => id === "readback");
  // Last: freshness, definitions and policy are pushed and read back first.
  assert.equal(stop, steps.length - 1);
  assert.ok(push < readback && readback < stop);
  assert.equal(steps[stop]!.if, undefined);
  assert.equal(steps[stop]!["continue-on-error"], undefined);
  // The prepare job measures the staged compact target, after the catalog
  // work exists and before it is uploaded, and never stops preparation itself.
  const prepare = workflow.jobs.prepare!.steps!;
  const measure = prepare.findIndex(
    ({ name }) => name === "Measure the staged compact listing target against the capacity guard",
  );
  assert.ok(prepare.findIndex(({ id }) => id === "prepare") < measure);
  assert.ok(measure < prepare.findIndex((step) => step.with?.name === "catalog-work"));
  assert.match(prepare[measure]!.run!, /catalog-capacity\.mts --check "\$\{observed\[@\]\}"/u);
  assert.match(prepare[measure]!.run!, /--observed-target "\$target"/u);
  assert.match(prepare[measure]!.run!, /\|\| status=\$\?/u);
  assert.match(prepare[measure]!.run!, /catalog-work\/capacity-guard\.json/u);
  const scratch = mkdtempSync(path.join(os.tmpdir(), "portcove-listing-stop-"));
  try {
    const work = path.join(scratch, "catalog-work");
    mkdirSync(work);
    const run = (report: unknown) => {
      writeFileSync(path.join(work, "observation-projection.json"), JSON.stringify(report));
      const summary = path.join(scratch, "summary.md");
      rmSync(summary, { force: true });
      try {
        const stdout = execFileSync("bash", ["-c", steps[stop]!.run!], {
          env: { ...process.env, RUNNER_TEMP: scratch, GITHUB_STEP_SUMMARY: summary },
          encoding: "utf8",
        });
        return { status: 0, stdout, summary: existsSync(summary) };
      } catch (error) {
        const failure = error as { status: number; stdout: string };
        return { status: failure.status, stdout: failure.stdout, summary: existsSync(summary) };
      }
    };
    assert.deepEqual(run({ carrier: "compact" }), { status: 0, stdout: "", summary: false });
    const stopped = run({
      listing_publication_stopped: {
        code: "decoded_bound",
        reason: "Complete compact listing exceeds its decoded byte bound",
        figures: { decoded_bytes: 33554433, decoded_limit: 33554432 },
      },
    });
    assert.equal(stopped.status, 1);
    assert.equal(stopped.summary, true);
    assert.match(
      stopped.stdout,
      /^::error title=Listing publication stopped::Listing publication stopped \(decoded_bound\): Complete compact listing exceeds its decoded byte bound; prior listing targets renewed\. Figures: \{"decoded_bytes":33554433,"decoded_limit":33554432\}$/mu,
    );
    // A released-reader refusal defers a pending cutover: the run fails.
    const pending = run({
      carrier: "legacy-renewal",
      released_reader_unavailable: "Public Portcove API attestations unavailable (403)",
      listing_activation_pending: {
        prior_carrier: "legacy",
        prior_format: 11,
        candidate_format: 15,
        reason: "Public Portcove API attestations unavailable (403)",
      },
    });
    assert.equal(pending.status, 1);
    assert.equal(pending.summary, true);
    assert.match(
      pending.stdout,
      /^::error title=Compact listing activation pending::Compact listing activation pending \(legacy format 11 -> compact format 15\): Public Portcove API attestations unavailable \(403\); prior listing targets renewed\.$/mu,
    );
    // After cutover, a renewal without a pending activation stays green.
    assert.equal(run({ carrier: "compact", changed: false }).status, 0);
    // An unverifiable prior after cutover renews the compact target exactly
    // with no activation pending; listing changes are unpublished, so it fails.
    const unverified = run({
      carrier: "compact",
      changed: false,
      listing_prior_unverified: { prior_carrier: "compact", reason: "timestamp expired" },
    });
    assert.equal(unverified.status, 1);
    assert.equal(unverified.summary, true);
    assert.match(
      unverified.stdout,
      /^::error title=Prior catalog unverified::The prior signed catalog could not be verified \(compact carrier\): timestamp expired; prior listing targets renewed and listing changes not published\.$/mu,
    );
    // The capacity guard measured on the staged target fails the run after
    // readback; a passing guard does not.
    const capacity = path.join(work, "capacity-guard.json");
    writeFileSync(capacity, JSON.stringify({ status: 0, observed_target: true, output: "ok\n" }));
    assert.equal(run({ carrier: "compact" }).status, 0);
    writeFileSync(
      capacity,
      JSON.stringify({
        status: 1,
        observed_target: true,
        output: "FAIL compact listing carrier bytes (modeled): 7000000 of 6410976\n",
      }),
    );
    const short = run({ carrier: "compact" });
    assert.equal(short.status, 1);
    assert.equal(short.summary, true);
    assert.match(
      short.stdout,
      /^::error title=Listing capacity guard failed::The capacity guard failed with the staged compact target's observations; this publication was not blocked\..*%0AFAIL compact listing carrier bytes/mu,
    );
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
});

void test("late catalog readback stays in the existing read-only scheduled prepare lane", () => {
  const workflow = read("catalog-publish.yml");
  const { permissions, steps } = workflow.jobs.prepare!;
  const index = steps!.findIndex(({ id }) => id === "late-readback");
  const continuation = steps![index]!;
  assert.deepEqual(permissions, { contents: "read", actions: "read" });
  assert.equal(continuation.if, "github.event_name == 'schedule'");
  assert.match(continuation.run!, /catalog-publication-continuation\.mts --site site --output/u);
  assert.equal(steps![index + 1]!.if, "steps.late-readback.outputs.observation == 'true'");
  assert.match(String(steps![index + 1]!.with!.name), /^catalog-publication-late-observation-/u);
  assert.ok(index < steps!.findIndex(({ id }) => id === "commit"));
  assert.ok(index < steps!.findIndex(({ id }) => id === "decide"));
});

void test("catalog keys reach only one signing step per role, from main", async () => {
  const publish = read("catalog-publish.yml");
  const sign = read("catalog-sign-role.yml");
  assert.deepEqual(Object.keys(publish.on).sort(), [
    "schedule",
    "workflow_dispatch",
    "workflow_run",
  ]);
  assert.deepEqual(publish.on.workflow_run, {
    workflows: ["CI"],
    types: ["completed"],
    branches: ["main"],
  });
  assert.deepEqual(publish.permissions, { contents: "read" });
  assert.deepEqual(publish.concurrency, { group: "catalog-publish", "cancel-in-progress": false });
  assert.match(publish.jobs.prepare!.if!, /^github\.ref == 'refs\/heads\/main' && /u);
  assert.match(publish.jobs.prepare!.if!, /workflow_run\.conclusion == 'success'/u);
  assert.match(publish.jobs.prepare!.if!, /workflow_run\.event == 'push'/u);
  const prepareSteps = publish.jobs.prepare!.steps!;
  const preflight = prepareSteps.findIndex((step) =>
    step.run?.includes("check-definition-publication-context"),
  );
  assert.ok(preflight >= 0);
  assert.match(prepareSteps[preflight]!.run!, /catalog-work\/context\.json/u);
  assert.equal(prepareSteps[preflight]!.env, undefined);
  assert.ok(preflight < prepareSteps.findIndex((step) => step.with?.name === "catalog-work"));

  const roles = {
    "sign-definitions": "official-definitions",
    "sign-policy": "official-policy",
    "sign-snapshot": "snapshot",
    "sign-timestamp": "timestamp",
  } as const;
  for (const [id, role] of Object.entries(roles)) {
    const job = publish.jobs[id]!;
    assert.equal(job.uses, "./.github/workflows/catalog-sign-role.yml");
    // A called workflow sees its environment's secrets only when the caller passes them.
    assert.equal(job.secrets, "inherit");
    assert.deepEqual(job.with, { role, commit: "${{ needs.prepare.outputs.commit }}" });
  }
  assert.equal(publish.jobs["sign-definitions"]!.needs, "prepare");
  assert.equal(publish.jobs["sign-policy"]!.needs, "prepare");
  assert.deepEqual(publish.jobs["sign-snapshot"]!.needs, [
    "prepare",
    "sign-definitions",
    "sign-policy",
  ]);
  assert.deepEqual(publish.jobs["sign-timestamp"]!.needs, ["prepare", "sign-snapshot"]);
  // Only the publish job writes, and it holds no catalog key.
  assert.deepEqual(publish.jobs.publish!.permissions, { contents: "write" });
  assert.doesNotMatch(JSON.stringify(publish), /\bsecrets\./u);
  const currentSource = readFileSync(path.join(workflows, "catalog-publish.yml"), "utf8");
  assert.match(currentSource, /browse_unchanged=\$\(node scripts\/public-catalog.mts unchanged/u);
  assert.match(currentSource, /\[ "\$browse_unchanged" = true \]/u);
  assert.ok(
    currentSource.indexOf("assemble-definition-repository") <
      currentSource.indexOf("Generate public development catalog pages"),
  );
  assert.match(currentSource, /--revision "\$COMMIT"/u);
  assert.match(currentSource, /--prior "\$RUNNER_TEMP\/catalog-work\/prior-browse"/u);
  assert.match(currentSource, /repository\/browse"/u);
  assert.match(currentSource, /browse_expected=.*repository\/browse\/index.html/u);
  assert.match(currentSource, /inputs_actual=.*catalog\/browse\/inputs.json/u);
  assert.match(currentSource, /deadline=\$\(\(SECONDS \+ 900\)\)/u);
  assert.match(
    currentSource,
    /--connect-timeout "\$connect_seconds" --max-time "\$request_seconds"/u,
  );
  assert.match(currentSource, /--max-filesize "\$2"/u);
  assert.doesNotMatch(currentSource, /curl -fsSL "/u);

  assert.deepEqual(Object.keys(sign.on), ["workflow_call"]);
  const job = sign.jobs.sign!;
  // The environment follows the role and can only be one of the four catalog environments.
  assert.deepEqual(job.environment, {
    name: "${{ inputs.role == 'official-definitions' && 'production-catalog-definitions' || inputs.role == 'official-policy' && 'production-catalog-policy' || inputs.role == 'snapshot' && 'production-catalog-snapshot' || 'production-catalog-timestamp' }}",
    deployment: false,
  });
  assert.deepEqual(job.permissions, { contents: "read" });
  const steps = job.steps!;
  const signing = steps.filter(
    (step) => step.env && Object.keys(step.env).some((k) => k.endsWith("_KEY")),
  );
  assert.equal(signing.length, 1);
  // Each key is selected only when the role matches; no other step or job sees secrets.
  for (const [name, value] of Object.entries(signing[0]!.env!))
    assert.match(
      value,
      new RegExp(
        `^\\$\\{\\{ inputs\\.role == '[a-z-]+' && secrets\\.${name} \\|\\| '' \\}\\}$`,
        "u",
      ),
    );
  const withoutSigning = structuredClone(sign);
  for (const step of withoutSigning.jobs.sign!.steps!) if (step.env) delete step.env;
  assert.doesNotMatch(JSON.stringify(withoutSigning), /\bsecrets\b/u);
  // The signing job restores no cache another workflow could write, and keeps no credentials.
  for (const step of steps) {
    if (step.uses?.startsWith("actions/setup-node@"))
      assert.equal(step.with?.["package-manager-cache"], false);
    if (step.uses?.startsWith("actions/checkout@"))
      assert.equal(step.with?.["persist-credentials"], false);
  }
  assert.match(signing[0]!.run!, /trap 'rm -rf "\$RUNNER_TEMP\/role-key"' EXIT/u);
  // The signer refuses a commit that is not on main before any key is read.
  const ancestry = steps.findIndex((step) => step.run?.includes("git merge-base --is-ancestor"));
  assert.ok(ancestry >= 0 && ancestry < steps.indexOf(signing[0]!));
  assert.equal(
    steps.find((step) => step.uses?.startsWith("actions/checkout@"))!.with?.["fetch-depth"],
    0,
  );
  // Every trigger publishes the newest CI-green main commit, never the triggering run's commit.
  assert.doesNotMatch(
    readFileSync(path.join(workflows, "catalog-publish.yml"), "utf8"),
    /workflow_run\.head_sha/u,
  );

  // No other workflow may name a catalog signing environment, except the retired
  // controller workflow, which admits only its controller tag until it is removed.
  const { readdirSync } = await import("node:fs");
  for (const name of readdirSync(workflows).filter((file) => file.endsWith(".yml"))) {
    const exempt = ["catalog-sign-role.yml", "application-update-production.yml"];
    if (exempt.includes(name)) continue;
    assert.doesNotMatch(
      readFileSync(path.join(workflows, name), "utf8"),
      /production-catalog-/u,
      name,
    );
  }
});

void test("exact provider cross-links enrich the signed listing without changing package authority", async () => {
  const { fixtureListing, fixturePolicy } =
    await import("./fixtures/listing-observation-delivery-fixture.mts");
  const {
    stageModPortalProjection,
    CoreInspectionRefusal,
    ListingPublicationStop,
    projectListingDelivery,
  } = await import("./listing-observation-delivery.mts");
  const { listingModPortalDefaults } = await import("./listing-mod-portal-projection.mts");
  const { observationHash } = await import("./upstream-observer.mts");
  const { thunderstoreRegistryUrl } = await import("./upstream-mod-provider-registry.mts");
  const now = Date.parse("2026-11-26T00:00:00Z");
  const community = {
    community: "current-community",
    game_uuid: "12345678-1111-2222-3333-123456789abc",
    listed: true,
    gamebanana_game: 12345,
  };
  const registry = (
    communities: (Omit<typeof community, "listed"> & { listed: boolean | null })[] = [community],
  ) => ({
    exception: null,
    next_due_at: "2026-11-26T12:00:00Z",
    last_complete: {
      format: 1,
      schema: "0.3.0",
      source: thunderstoreRegistryUrl,
      observed_at: "2026-11-25T00:00:00Z",
      expires_at: "2026-11-27T00:00:00Z",
      response_sha256: "a".repeat(64),
      communities_sha256: observationHash(communities),
      communities,
    },
  });
  const catalog = {
    ports: [
      {
        id: fixtureListing.id,
        mod_provider_bindings: [{ provider: "gamebanana", game_id: 12345 }],
      },
    ],
  };
  const port = { ...fixtureListing };
  const unrelated = {
    ...port,
    id: "other-implementation",
    project_url: "https://github.com/fixture/other",
  };
  const canonical = { format_version: 16, listings: [port, unrelated] };
  const observation = fixturePolicy().listing_update.upstream_observation;
  const packageCandidate = { ...port, upstream_observation: observation };
  const rows = (bytes: Buffer) =>
    fixtureRecords(fixtureRecord(fixtureRecord(JSON.parse(bytes.toString())).directory).listings);
  const row = (bytes: Buffer) => requiredFixture(rows(bytes).find(({ id }) => id === port.id));
  const packageOnly = projectListingDelivery(canonical, [packageCandidate], null);
  const first = projectListingDelivery(canonical, [packageCandidate], null, {
    modPortalDefaults: listingModPortalDefaults(catalog, registry(), new Set(), now),
  });
  assert.equal(first.generated_mod_portals, 1);
  assert.match(
    JSON.stringify(row(first.bytes).mod_portals),
    /thunderstore\.io\/c\/current-community/u,
  );
  assert.deepEqual(
    row(first.bytes).upstream_observation,
    row(packageOnly.bytes).upstream_observation,
  );
  assert.equal(rows(first.bytes).find(({ id }) => id === unrelated.id)?.mod_portals, undefined);

  const outage = projectListingDelivery(canonical, [], first.bytes, {
    modPortalDefaults: listingModPortalDefaults(
      catalog,
      { ...registry(), exception: "unavailable" },
      new Set(),
      now,
    ),
  });
  assert.equal(outage.changed, false);
  assert.equal(outage.retained, 1);
  const ambiguousRegistry = registry([
    {
      ...community,
      community: "another-community",
      game_uuid: "22345678-1111-2222-3333-123456789abc",
    },
    community,
  ]);
  const ambiguous = listingModPortalDefaults(catalog, ambiguousRegistry, new Set(), now);
  assert.equal(ambiguous(port, undefined), undefined);
  assert.ok(ambiguous(port, row(first.bytes)), "provider still confirms the published association");
  const unknownVisibility = listingModPortalDefaults(
    catalog,
    registry([{ ...community, listed: null }]),
    new Set(),
    now,
  );
  assert.equal(unknownVisibility(port, undefined), undefined);
  assert.ok(unknownVisibility(port, row(first.bytes)));
  const conflicting = (identity_conflicts: string[]) =>
    listingModPortalDefaults(
      catalog,
      { ...ambiguousRegistry, exception: "identity-changed", identity_conflicts },
      new Set(),
      now,
    );
  assert.equal(conflicting(["current-community"])(port, row(first.bytes)), undefined);
  assert.ok(conflicting(["another-community"])(port, row(first.bytes)));
  const defaults = listingModPortalDefaults(catalog, registry(), new Set(), now);
  const reviewedGameBanana = {
    id: "verified-mod-community",
    site: "community_site",
    url: "https://gamebanana.com/games/12345",
    name: "GameBanana",
    instructions: "Check the upstream community's setup instructions.",
  };
  const listingOnly = { ...unrelated, mod_portals: [reviewedGameBanana] };
  const listingOnlyDirectory = { format_version: 16, listings: [port, listingOnly] };
  const listingOnlyUpdate = projectListingDelivery(listingOnlyDirectory, [], first.bytes, {
    modPortalDefaults: defaults,
  });
  const publishedListingOnly = requiredFixture(
    rows(listingOnlyUpdate.bytes).find(({ id }) => id === listingOnly.id),
  );
  assert.deepEqual(publishedListingOnly.mod_portals, [
    reviewedGameBanana,
    {
      id: `obs-ts-12345-${community.game_uuid}`,
      site: "community_site",
      url: "https://thunderstore.io/c/current-community/",
      name: "Thunderstore",
      instructions: "Open the community to browse its mods.",
    },
  ]);
  assert.equal(listingOnlyUpdate.generated_mod_portals, 2);
  assert.equal(
    defaults(
      {
        ...port,
        mod_portals: [{ ...reviewedGameBanana, url: "https://gamebanana.com/games/12346" }],
      },
      row(first.bytes),
    ),
    undefined,
    "conflicting maintained identities cannot inherit the previous generated source",
  );
  assert.equal(
    defaults(
      {
        ...listingOnly,
        mod_portals: [{ ...reviewedGameBanana, url: "https://gamebanana.com/mods/12345" }],
      },
      undefined,
    ),
    undefined,
    "a package URL is not a reviewed game identity",
  );
  assert.ok(
    listingModPortalDefaults(catalog, undefined, new Set(), now)(listingOnly, publishedListingOnly),
    "an unavailable registry keeps the last accepted exact association",
  );
  assert.equal(
    listingModPortalDefaults(
      catalog,
      registry(),
      new Set([listingOnly.id]),
      now,
    )(listingOnly, publishedListingOnly),
    undefined,
    "a maintained exclusion also takes precedence for listing-only entries",
  );
  assert.equal(
    defaults(
      { ...port, mod_portals: [{ url: "https://THUNDERSTORE.IO/c/reviewed/" }] },
      row(first.bytes),
    ),
    undefined,
    "an authored provider link takes precedence",
  );
  const bound = { ...listingOnly, id: "github-123" };
  const boundBefore = projectListingDelivery({ format_version: 17, listings: [bound] }, [], null, {
    modPortalDefaults: defaults,
  });
  const renamed = {
    ...bound,
    project_url: "https://github.com/new-owner/renamed-game",
    release_url: "https://github.com/new-owner/renamed-game/releases",
  };
  const withoutRegistry = listingModPortalDefaults(catalog, undefined, new Set(), now);
  const boundAfter = projectListingDelivery(
    { format_version: 17, listings: [renamed] },
    [],
    boundBefore.bytes,
    { modPortalDefaults: withoutRegistry },
  );
  assert.equal(boundAfter.generated_mod_portals, 1);
  assert.equal(rows(boundAfter.bytes)[0]?.project_url, renamed.project_url);
  const retained = requiredFixture(rows(boundBefore.bytes)[0]);
  assert.deepEqual(rows(boundAfter.bytes)[0]?.mod_portals, retained.mod_portals);
  assert.equal(withoutRegistry({ ...renamed, id: "github-456" }, retained), undefined);
  assert.equal(
    withoutRegistry({ ...renamed, original_game: { id: "different-game" } }, retained),
    undefined,
  );
  assert.equal(
    withoutRegistry({ ...listingOnly, project_url: renamed.project_url }, publishedListingOnly),
    undefined,
  );
  const withdrawn = projectListingDelivery(canonical, [], first.bytes, {
    modPortalDefaults: listingModPortalDefaults(
      catalog,
      registry([{ ...community, listed: false }]),
      new Set(),
      now,
    ),
  });
  assert.equal(row(withdrawn.bytes).mod_portals, undefined);
  assert.deepEqual(
    row(withdrawn.bytes).upstream_observation,
    row(packageOnly.bytes).upstream_observation,
  );
  const excluded = listingModPortalDefaults(catalog, registry(), new Set([port.id]), now);
  assert.equal(excluded(port, row(first.bytes)), undefined);

  const capped = projectListingDelivery(canonical, [packageCandidate], null, {
    byteLimit: packageOnly.bytes.length,
    modPortalDefaults: listingModPortalDefaults(catalog, registry(), new Set(), now),
  });
  assert.equal(capped.deferred_mod_portals, 1);
  assert.deepEqual(capped.bytes, packageOnly.bytes);
  const reasons: string[] = [];
  for (const error of [
    new ListingPublicationStop("transport_bound", "encoded candidate too large", {}),
    new CoreInspectionRefusal("Core refused the optional mod website"),
    new ListingPublicationStop(
      "cover_reader_unavailable",
      "Released reader refused the candidate",
      {},
    ),
    new Error("Optional inspection timed out"),
  ]) {
    const accepted = await stageModPortalProjection(
      packageOnly,
      () => first,
      (candidate) => (candidate === first ? Promise.reject(error) : Promise.resolve("base stage")),
      (reason) => reasons.push(reason),
    );
    assert.deepEqual(accepted, { projection: packageOnly, staged: "base stage" });
  }
  assert.deepEqual(reasons, [
    "encoded candidate too large",
    "Core refused the optional mod website",
    "Released reader refused the candidate",
    "Optional inspection timed out",
  ]);
});

void test("signed projection keeps release observations through authored artwork changes", async () => {
  const { fixtureListing, fixturePolicy } =
    await import("./fixtures/listing-observation-delivery-fixture.mts");
  const { projectListingDelivery } = await import("./listing-observation-delivery.mts");
  const artwork = {
    game_id: 70,
    cover_id: 71,
    image_id: "fixturecover",
    image_sha256: "a".repeat(64),
    game_slug: "fixture-game",
    match_kind: "underlying-game",
  };
  const priorListing = { ...fixtureListing, artwork };
  const candidate = fixturePolicy(priorListing).listing_update;
  const directory = (listing: Record<string, unknown>) => ({
    format_version: 15,
    listings: [listing],
  });
  const now = Date.parse("2026-11-10T00:01:00Z");
  const initial = projectListingDelivery(directory(priorListing), [candidate], null, { now });
  const view = (bytes: Buffer) =>
    requiredFixture(
      fixtureRecords(
        fixtureRecord(fixtureRecord(JSON.parse(bytes.toString())).directory).listings,
      )[0],
    );
  const initialObservation = requiredFixture(view(initial.bytes).upstream_observation);
  const steps = [
    { ...fixtureListing, artwork: { ...artwork, cover_id: 72, image_id: "replacement" } },
    { ...fixtureListing, collection_covers: [artwork] },
    { ...fixtureListing, media: [{ id: "new-scene", role: "screenshot" }] },
  ];
  let previous = initial.bytes;
  for (const listing of steps) {
    const next = projectListingDelivery(directory(listing), [], previous, { now });
    assert.equal(next.changed, true);
    assert.deepEqual(view(next.bytes), { ...listing, upstream_observation: initialObservation });
    previous = next.bytes;
  }

  const current = steps[steps.length - 1]!;
  const pending = projectListingDelivery(directory(current), [candidate], null, { now });
  assert.deepEqual(view(pending.bytes), { ...current, upstream_observation: initialObservation });

  const releaseChanges = [
    { ...current, project_url: "https://github.com/owner/different-game" },
    { ...current, release_url: "https://github.com/owner/other-release-feed/releases" },
    { ...current, download_block_reason: "An upstream package is restricted." },
    { ...current, download_asset_hints: { "linux-x86-64": ["linux", "64"] } },
  ];
  for (const listing of releaseChanges) {
    const next = projectListingDelivery(directory(listing), [candidate], previous, { now });
    assert.deepEqual(view(next.bytes), listing);
  }
});

void test("signed projection recomputes shared covers without changing the release observation", async () => {
  const { fixtureListing, fixturePolicy } =
    await import("./fixtures/listing-observation-delivery-fixture.mts");
  const { projectListingDelivery } = await import("./listing-observation-delivery.mts");
  const { checkedAuthoredPort } = await import("./catalog-authoring.mts");
  const { indexSharedCoverRows, projectExactSharedCovers, retainSharedCoverDefaults } =
    await import("./shared-cover-projection.mts");
  const game = {
    format_version: 1,
    id: "shared-game",
    evidence_urls: ["https://example.org/shared-game"],
    source_editions: [
      {
        id: "edition-one",
        system: "pc",
        title: "Shared game",
        evidence_urls: ["https://example.org/shared-edition"],
      },
    ],
  };
  const artwork = {
    game_id: 70,
    cover_id: 71,
    image_id: "sharedcover",
    image_sha256: "a".repeat(64),
    game_slug: "shared-game",
    match_kind: "underlying-game",
  };
  const recipient = { ...fixtureListing, original_game: game };
  const donor = {
    ...fixtureListing,
    id: "artwork-donor",
    name: "Shared cover donor",
    project_url: "https://github.com/fixture/artwork-donor",
    original_game: game,
    artwork,
  };
  const canonical = { format_version: 15, listings: [recipient, donor] };
  const candidate = {
    ...recipient,
    upstream_observation: fixturePolicy().listing_update.upstream_observation,
  };
  const authored = [recipient, donor].map((listing) =>
    checkedAuthoredPort({ format_version: 1, listing }),
  );
  const initial = projectListingDelivery(canonical, [candidate], null);
  const rows = (bytes: Buffer) =>
    fixtureRecords(fixtureRecord(fixtureRecord(JSON.parse(bytes.toString())).directory).listings);
  const row = (bytes: Buffer) => requiredFixture(rows(bytes).find(({ id }) => id === recipient.id));
  const project = (
    previous: Buffer,
    gone = new Set<string>(),
    records = authored,
    holdNewForImages = new Set<string>(),
  ) =>
    projectListingDelivery(canonical, [], previous, {
      sharedCoverDefaults: projectExactSharedCovers({
        live: indexSharedCoverRows(rows(previous)),
        authored: records,
        excludedPortIds: new Set(),
        gone,
        checked: new Map(),
        deriveDefaultsForPublishedRecipients: true,
        holdNewForImages,
      }),
    });
  const admitted = project(initial.bytes);
  assert.deepEqual(row(admitted.bytes).artwork, artwork);
  assert.deepEqual(
    row(admitted.bytes).upstream_observation,
    row(initial.bytes).upstream_observation,
  );
  assert.deepEqual(
    { ...row(admitted.bytes), artwork: undefined },
    { ...row(initial.bytes), artwork: undefined },
  );
  assert.equal(project(admitted.bytes).changed, false);
  const held = new Set([artwork.image_id]);
  assert.equal(row(project(initial.bytes, new Set(), authored, held).bytes).artwork, undefined);
  assert.equal(project(admitted.bytes, new Set(), authored, held).changed, false);

  const retain = (previous: Buffer, gone = new Set<string>()) =>
    projectListingDelivery(canonical, [], previous, {
      sharedCoverDefaults: retainSharedCoverDefaults(
        indexSharedCoverRows(rows(previous)),
        canonical.listings,
        gone,
      ),
    });
  assert.equal(retain(admitted.bytes).changed, false);
  assert.equal(retain(initial.bytes).changed, false);
  for (const prevented of [
    project(admitted.bytes, held),
    retain(admitted.bytes, held),
    ...[recipient.id, donor.id].map((excluded) =>
      project(
        admitted.bytes,
        new Set(),
        authored.map((record) =>
          checkedAuthoredPort({
            ...record,
            ...(record.listing.id === excluded ? { igdb_no_shared_cover: true } : {}),
          }),
        ),
      ),
    ),
  ]) {
    assert.equal(row(prevented.bytes).artwork, undefined);
    assert.deepEqual(
      row(prevented.bytes).upstream_observation,
      row(initial.bytes).upstream_observation,
    );
  }
  assert.throws(
    () =>
      checkedAuthoredPort({
        format_version: 1,
        listing: recipient,
        igdb_no_shared_cover: false,
      }),
    /shared cover exclusion must be true/u,
  );
});

void test("observer output is delivered as bounded compatible descriptive data with quiet replay and last-good retention", async () => {
  const { fixtureListing, fixturePolicy, fixtureDelivery } =
    await import("./fixtures/listing-observation-delivery-fixture.mts");
  const { projectListingDelivery } = await import("./listing-observation-delivery.mts");
  const policy = fixturePolicy();
  const canonical = { format_version: 11, listings: [fixtureListing] };
  const first = projectListingDelivery(canonical, [policy.listing_update], null);
  assert.deepEqual(first.bytes, fixtureDelivery());
  const generated = readFileSync(
    new URL(
      "../crates/portcove-core/src/testdata/listing-observation-delivery.generated.json",
      import.meta.url,
    ),
  );
  assert.deepEqual(
    first.bytes,
    generated,
    "Core's signed-consumer fixture must be actual maintained producer output",
  );
  const document = fixtureRecord(JSON.parse(first.bytes.toString()));
  const directory = fixtureRecord(document.directory);
  const firstListing = requiredFixture(fixtureRecords(directory.listings)[0]);
  assert.equal(directory.format_version, 11);
  assert.equal(firstListing.implementation, undefined);
  assert.deepEqual(firstListing.download_asset_hints, fixtureListing.download_asset_hints);
  const expectedObservation = fixtureRecord(
    structuredClone(policy.listing_update.upstream_observation),
  );
  const expectedRelease = requiredFixture(fixtureRecords(expectedObservation.releases)[0]);
  const expectedAsset = requiredFixture(fixtureRecords(expectedRelease.assets)[0]);
  assert.equal(expectedAsset.sha256, null);
  delete expectedAsset.sha256;
  assert.deepEqual(firstListing.upstream_observation, expectedObservation);
  const before = structuredClone(canonical);
  for (const candidates of [
    [],
    [policy.listing_update],
    [
      {
        ...policy.listing_update,
        upstream_observation: {
          ...policy.listing_update.upstream_observation,
          status: "incomplete",
          releases: [],
        },
      },
    ],
  ]) {
    const replay = projectListingDelivery(canonical, candidates, first.bytes);
    assert.equal(replay.changed, false);
    assert.equal(replay.revision, first.revision);
    assert.deepEqual(replay.bytes, first.bytes);
  }
  assert.deepEqual(canonical, before);
  const current = {
    ...fixtureListing,
    download_block_reason: "Resolve current original-file requirements",
  };
  const corrected = projectListingDelivery(
    { format_version: 11, listings: [current] },
    [policy.listing_update],
    first.bytes,
  );
  const correctedDocument = fixtureRecord(JSON.parse(corrected.bytes.toString()));
  const row = requiredFixture(
    fixtureRecords(fixtureRecord(correctedDocument.directory).listings)[0],
  );
  assert.equal(row.download_block_reason, current.download_block_reason);
  assert.equal(
    row.upstream_observation,
    undefined,
    "a changed canonical declaration cannot reuse earlier observations",
  );
  assert.equal(corrected.revision, first.revision + 1);
});

void test("compact activation requires both capabilities from the reviewed released reader", async () => {
  const { requireCompactListingReader } = await import("./listing-observation-delivery.mts");
  const { compactListingCarrier } = await import("./listing-directory-carrier.mts");
  const capabilities = (listing_formats: number[], listing_delivery_carriers: string[]) => ({
    ok: true,
    command: "capabilities",
    data: {
      product: "Portcove",
      product_version: "fixture",
      listing_formats,
      listing_delivery_carriers,
    },
  });
  assert.throws(
    () => requireCompactListingReader(capabilities([11, 12, 13], ["json-v1"]), 13),
    /gzip-base64-json-v1 and listing format 13/u,
  );
  assert.throws(
    () => requireCompactListingReader(capabilities([11, 12], [compactListingCarrier]), 13),
    /gzip-base64-json-v1 and listing format 13/u,
  );
  assert.equal(
    requireCompactListingReader(capabilities([11, 12, 13], [compactListingCarrier]), 13),
    "fixture",
  );
});

void test("format 14 edition bindings require both released capabilities and stay out of older projections", async () => {
  const { fixtureListing, fixtureDelivery } =
    await import("./fixtures/listing-observation-delivery-fixture.mts");
  const { projectListingDelivery, requireCompactListingReader } =
    await import("./listing-observation-delivery.mts");
  const { compactListingCarrier, encodeCompactListing, decodeRetainedCompactListing } =
    await import("./listing-directory-carrier.mts");
  const release = (listing_formats: number[], listing_delivery_carriers: string[]) => ({
    ok: true,
    command: "capabilities",
    data: {
      product: "Portcove",
      product_version: "fixture",
      listing_formats,
      listing_delivery_carriers,
    },
  });
  assert.equal(
    requireCompactListingReader(release([12, 13], [compactListingCarrier]), 13),
    "fixture",
  );
  for (const reader of [release([12, 13], [compactListingCarrier]), release([14], ["json-v1"])])
    assert.throws(
      () => requireCompactListingReader(reader, 14),
      /gzip-base64-json-v1 and listing format 14/u,
    );
  assert.equal(
    requireCompactListingReader(release([12, 13, 14], [compactListingCarrier]), 14),
    "fixture",
  );

  const edition = { id: "disc", title: "Original", system: "PlayStation", evidence_urls: [] };
  const original = {
    format_version: 1,
    id: "original",
    source_editions: [edition],
    evidence_urls: [],
  };
  const binding = { game_id: "original", variant_id: "disc", representation_id: "disc-bin" };
  const scene = { id: "scene", role: "screenshot", igdb: { kind: "screenshot" } };
  const legacy = { ...fixtureListing, original_game: original };
  const format13 = { ...legacy, media: [scene] };
  const current = {
    ...format13,
    original_game: {
      ...original,
      source_editions: [{ ...edition, verified_sources: [binding] }],
    },
  };
  const canonical = { format_version: 14, listings: [current] };
  const old = decodedListingDelivery(fixtureDelivery());
  const prior13 = Buffer.from(
    JSON.stringify({
      ...old,
      directory: { format_version: 13, listings: [format13] },
    }),
  );
  const completeSnapshot = (source: unknown, projection: unknown, previous: Buffer) =>
    projectListingDelivery(source, [], previous, { compatible: projection, now: 0 });
  const projected = completeSnapshot(canonical, canonical, prior13);
  const decoded = decodedListingDelivery(
    decodeRetainedCompactListing(encodeCompactListing(projected.bytes)),
  );
  assert.equal(decoded.directory.format_version, 14);
  assert.equal(projected.delivered_records, 1);
  assert.deepEqual(decoded.directory.listings[0]!.original_game, current.original_game);
  assert.deepEqual(decoded.directory.listings[0]!.media, [scene]);
  assert.equal(decoded.revision, old.revision + 1);

  assert.throws(
    () => completeSnapshot(canonical, { format_version: 13, listings: [format13] }, prior13),
    /changed canonical identities or format/u,
  );
  const removed = completeSnapshot(
    { format_version: 13, listings: [format13] },
    { format_version: 14, listings: [format13] },
    projected.bytes,
  );
  const withdrawn = decodedListingDelivery(removed.bytes).directory;
  assert.equal(withdrawn.format_version, 14);
  assert.deepEqual(withdrawn.listings[0]!.original_game, original);
});

void test("format 15 restrictions require the released reader and never reach older readers weaker", async () => {
  const { fixtureListing, fixtureDelivery } =
    await import("./fixtures/listing-observation-delivery-fixture.mts");
  const { projectListingDelivery, requireCompactListingReader } =
    await import("./listing-observation-delivery.mts");
  const { compactListingCarrier, encodeCompactListing, decodeRetainedCompactListing } =
    await import("./listing-directory-carrier.mts");
  const release = (listing_formats: number[]) => ({
    ok: true,
    command: "capabilities",
    data: {
      product: "Portcove",
      product_version: "fixture",
      listing_formats,
      listing_delivery_carriers: [compactListingCarrier],
    },
  });
  assert.throws(
    () => requireCompactListingReader(release([12, 13, 14]), 15),
    /gzip-base64-json-v1 and listing format 15/u,
  );
  assert.equal(requireCompactListingReader(release([13, 14, 15]), 15), "fixture");

  const reason = "Fresh acquisition remains held for the documented permissions.";
  const restrictions = [
    {
      id: "download",
      effect: "hold",
      operations: ["download"],
      reason: "bundled-game-data",
      explanation: reason,
      tracking_issue: 1,
    },
  ];
  // Core exports the legacy string before its typed source; earlier formats
  // keep only the string (catalog/listings.rs export_format).
  const legacy = { ...fixtureListing, download_block_reason: reason };
  const current = { ...legacy, restrictions };
  const canonical = { format_version: 15, listings: [current] };
  const old = decodedListingDelivery(fixtureDelivery());
  const prior14 = Buffer.from(
    JSON.stringify({ ...old, directory: { format_version: 14, listings: [fixtureListing] } }),
  );
  const projected = projectListingDelivery(canonical, [], prior14, {
    compatible: canonical,
    now: 0,
  });
  const decoded = decodedListingDelivery(
    decodeRetainedCompactListing(encodeCompactListing(projected.bytes)),
  );
  assert.equal(decoded.directory.format_version, 15);
  assert.equal(decoded.directory.listings[0]!.download_block_reason, reason);
  assert.deepEqual(decoded.directory.listings[0]!.restrictions, restrictions);

  assert.throws(
    () => projectListingDelivery({ format_version: 18, listings: [current] }, [], null, { now: 0 }),
    /supported bounded canonical directory/u,
  );
});

void test("format-16 mod website changes preserve an independent signed release observation", async () => {
  const { fixtureListing, fixtureDelivery } =
    await import("./fixtures/listing-observation-delivery-fixture.mts");
  const { projectListingDelivery } = await import("./listing-observation-delivery.mts");
  const prior = fixtureDelivery();
  const observation = decodedListingDelivery(prior).directory.listings[0]!.upstream_observation;
  assert.ok(observation);
  const modPortal = {
    id: "community",
    site: "community_site",
    name: "Game mods",
    url: "https://mods.example.com/",
    instructions: "Read the community requirements.",
  };
  const added = { format_version: 16, listings: [{ ...fixtureListing, mod_portals: [modPortal] }] };
  const first = projectListingDelivery(added, [], prior, { compatible: added, now: 0 });
  assert.equal(first.retained, 1);
  const selected = decodedListingDelivery(first.bytes).directory.listings[0]!;
  assert.deepEqual(selected.upstream_observation, observation);
  assert.deepEqual(selected.mod_portals, [modPortal]);

  const removed = { format_version: 16, listings: [fixtureListing] };
  const second = projectListingDelivery(removed, [], first.bytes, { compatible: removed, now: 0 });
  const withdrawn = decodedListingDelivery(second.bytes).directory.listings[0]!;
  assert.deepEqual(withdrawn.upstream_observation, observation);
  assert.equal(withdrawn.mod_portals, undefined);
});

void test("format 17 projects a new repository-bound listing and preserves earlier release facts", async () => {
  const { fixtureListing, fixtureDelivery, fixturePolicy } =
    await import("./fixtures/listing-observation-delivery-fixture.mts");
  const { projectListingDelivery, requireCompactListingReader } =
    await import("./listing-observation-delivery.mts");
  const { compactListingCarrier, encodeCompactListing, decodeRetainedCompactListing } =
    await import("./listing-directory-carrier.mts");
  const reader = {
    ok: true,
    command: "capabilities",
    data: {
      product: "Portcove",
      product_version: "fixture",
      listing_formats: [15, 16],
      listing_delivery_carriers: [compactListingCarrier],
    },
  };
  assert.throws(() => requireCompactListingReader(reader, 17), /listing format 17/u);
  reader.data.listing_formats.push(17);
  assert.equal(requireCompactListingReader(reader, 17), "fixture");

  const prior = fixtureDelivery();
  const priorRow = decodedListingDelivery(prior).directory.listings[0]!;
  const admitted = {
    ...fixtureListing,
    id: "github-890",
    project_url: "https://github.com/owner/new-port",
  };
  const canonical = { format_version: 17, listings: [fixtureListing, admitted] };
  const candidate = fixturePolicy(admitted, { id: 890, name: "owner/new-port" }).listing_update;
  const reusedPath = fixturePolicy(admitted, { id: 891, name: "owner/new-port" }).listing_update;
  const projected = projectListingDelivery(canonical, [reusedPath, candidate], prior, {
    compatible: canonical,
    now: 0,
  });
  const decoded = decodedListingDelivery(
    decodeRetainedCompactListing(encodeCompactListing(projected.bytes)),
  );
  assert.equal(decoded.directory.format_version, 17);
  assert.deepEqual(
    decoded.directory.listings.find((row) => row.id === priorRow.id),
    priorRow,
  );
  const newRow = decoded.directory.listings.find((row) => row.id === admitted.id);
  assert.ok(newRow);
  assert.partialDeepStrictEqual(newRow.upstream_observation, {
    repository_id: 890,
    status: "complete",
    releases: [
      { assets: [{ url: `${admitted.project_url}/releases/download/v1.0/game-windows-x64.zip` }] },
    ],
  });
  assert.equal(newRow.artwork, undefined);
  assert.equal(newRow.mod_portals, undefined);
  const replay = projectListingDelivery(canonical, [reusedPath], projected.bytes, {
    compatible: canonical,
    now: 0,
  });
  assert.deepEqual(replay.bytes, projected.bytes);

  const badPrior = structuredClone(decoded);
  badPrior.directory.listings.find((row) => row.id === admitted.id)!.upstream_observation =
    reusedPath.upstream_observation;
  const repaired = projectListingDelivery(
    canonical,
    [reusedPath],
    Buffer.from(JSON.stringify(badPrior)),
    {
      compatible: canonical,
      now: 0,
    },
  );
  assert.equal(repaired.delivered_records, 2);
  assert.deepEqual(
    decodedListingDelivery(repaired.bytes).directory.listings.find((row) => row.id === admitted.id),
    admitted,
  );
});

void test("complete format-13 compact snapshots keep authored scenes and format-12 explanations", async () => {
  const { fixtureListing, fixtureDelivery } =
    await import("./fixtures/listing-observation-delivery-fixture.mts");
  const { projectListingDelivery } = await import("./listing-observation-delivery.mts");
  const { encodeCompactListing, decodeRetainedCompactListing } =
    await import("./listing-directory-carrier.mts");
  const implementation = { kind: "native_port" };
  const scene = { id: "scene", role: "screenshot", igdb: { kind: "screenshot" } };
  const authored = { ...fixtureListing, implementation, media: [scene] };
  const canonical = { format_version: 13, listings: [authored] };
  const prior = fixtureDelivery();
  const compact = projectListingDelivery(canonical, [], prior, { compatible: canonical, now: 0 });
  assert.equal(compact.delivered_records, 1);
  const decoded = decodedListingDelivery(
    decodeRetainedCompactListing(encodeCompactListing(compact.bytes)),
  );
  assert.equal(decoded.directory.format_version, 13);
  assert.deepEqual(decoded.directory.listings[0]!.media, [scene]);
  assert.deepEqual(decoded.directory.listings[0]!.implementation, implementation);
  const old = decodedListingDelivery(prior);
  assert.deepEqual(
    decoded.directory.listings[0]!.upstream_observation,
    old.directory.listings[0]!.upstream_observation,
  );
  assert.equal(compact.retained, 1);
  assert.equal(decoded.revision, old.revision + 1);
  const changedSource = {
    format_version: 13,
    listings: [{ ...authored, project_url: "https://github.com/other/game" }],
  };
  const changed = projectListingDelivery(changedSource, [], prior, {
    compatible: changedSource,
    now: 0,
  });
  assert.equal(
    decodedListingDelivery(changed.bytes).directory.listings[0]!.upstream_observation,
    undefined,
  );
  const withdrawnScene = {
    format_version: 12,
    listings: [{ ...fixtureListing, implementation }],
  };
  const next = projectListingDelivery(withdrawnScene, [], compact.bytes, {
    compatible: { ...withdrawnScene, format_version: 13 },
    now: 0,
  });
  const nextDirectory = decodedListingDelivery(next.bytes).directory;
  assert.equal(nextDirectory.format_version, 13);
  assert.equal(nextDirectory.listings[0]!.media, undefined);
});

void test("an absent observed digest frees signed capacity without counting a retained observation as new", async () => {
  const { fixtureListing, fixturePolicy } =
    await import("./fixtures/listing-observation-delivery-fixture.mts");
  const { projectListingDelivery } = await import("./listing-observation-delivery.mts");
  const existing = fixturePolicy().listing_update;
  const previous = Buffer.from(
    JSON.stringify({
      listing_delivery_schema: 1,
      revision: 7,
      withdrawn_ids: [],
      directory: { format_version: 11, listings: [existing] },
    }),
  );
  const canonical = { format_version: 11, listings: [fixtureListing] };
  const compact = projectListingDelivery(canonical, [], previous);
  assert.equal(compact.revision, 8);
  assert.equal(compact.updated, 0);
  assert.equal(compact.retained, 1);
  assert.equal(previous.length - compact.bytes.length, Buffer.byteLength(',"sha256":null'));

  const newListing = { ...fixtureListing, id: "another-project" };
  const incoming = fixturePolicy(newListing).listing_update;
  const incomingObservation = fixtureRecord(incoming.upstream_observation);
  const incomingRelease = requiredFixture(fixtureRecords(incomingObservation.releases)[0]);
  const incomingAsset = requiredFixture(fixtureRecords(incomingRelease.assets)[0]);
  incomingAsset.sha256 = "a".repeat(64);
  const directory = { format_version: 11, listings: [fixtureListing, newListing] };
  const bounded = projectListingDelivery(directory, [incoming, existing], previous);
  assert.equal(bounded.delivered_records, 2);
  assert.equal(bounded.updated, 1);
  const delivered = fixtureRecord(fixtureRecord(JSON.parse(bounded.bytes.toString())).directory);
  const newRow = requiredFixture(
    fixtureRecords(delivered.listings).find((row) => row.id === newListing.id),
  );
  assert.deepEqual(newRow.upstream_observation, incomingObservation);
  const oldObservation = fixtureRecord(existing.upstream_observation);
  const oldRelease = requiredFixture(fixtureRecords(oldObservation.releases)[0]);
  assert.equal(requiredFixture(fixtureRecords(oldRelease.assets)[0]).sha256, null);
  const replay = projectListingDelivery(directory, [existing, incoming], bounded.bytes);
  assert.equal(replay.changed, false);
  assert.equal(replay.revision, bounded.revision);
  assert.equal(replay.updated, 0);
  assert.deepEqual(replay.bytes, bounded.bytes);
});

void test("descriptive delivery encodes an exact GitHub slash tag from a retained observation", async () => {
  const { fixtureListing, fixturePolicy } =
    await import("./fixtures/listing-observation-delivery-fixture.mts");
  const { projectListingDelivery } = await import("./listing-observation-delivery.mts");
  const candidate = fixturePolicy().listing_update;
  const observation = fixtureRecord(candidate.upstream_observation);
  const release = requiredFixture(fixtureRecords(observation.releases)[0]);
  const asset = requiredFixture(fixtureRecords(release.assets)[0]);
  const tag = "preview-builds/1.2.0-preview1";
  const root = "https://github.com/owner/game/releases";
  const name = "game-windows-x64.zip";
  const raw = `${root}/download/${tag}/${name}`;
  const encoded = `${root}/download/${encodeURIComponent(tag)}/${name}`;
  const listing = { format_version: 11, listings: [fixtureListing] };
  const deliver = (url: string) =>
    projectListingDelivery(
      listing,
      [
        {
          ...candidate,
          upstream_observation: {
            ...observation,
            releases: [
              {
                ...release,
                version: tag,
                release_url: `${root}/tag/${encodeURIComponent(tag)}`,
                assets: [{ ...asset, url }],
              },
            ],
          },
        },
      ],
      null,
    );
  const result = deliver(raw);
  assert.deepEqual(result.bytes, deliver(encoded).bytes);
  const directory = fixtureRecord(fixtureRecord(JSON.parse(result.bytes.toString())).directory);
  const published = requiredFixture(fixtureRecords(directory.listings)[0]);
  const publishedObservation = fixtureRecord(published.upstream_observation);
  const publishedRelease = requiredFixture(fixtureRecords(publishedObservation.releases)[0]);
  const expected: Record<string, unknown> = { ...asset, url: encoded };
  delete expected.sha256;
  assert.deepEqual(publishedRelease.assets, [expected]);
  assert.equal(publishedObservation.facts_sha256, observation.facts_sha256);
  assert.equal(publishedObservation.observed_at, observation.observed_at);
  assert.equal(asset.url, `${root}/download/v1.0/${name}`);
  for (const invalid of [
    raw.replace("owner/game", "other/game"),
    raw.replace(tag, "preview-builds/1.2.0-preview2"),
    raw.replace(name, "other.zip"),
    `${raw}?unexpected=1`,
  ]) {
    assert.ok(deliver(invalid).bytes.toString().includes(invalid));
  }
});

void test("only the dynamic listing target is excluded from fixed input comparison", async () => {
  const { sameStaticPublicationTargets } = await import("./catalog-publish.mts");
  const fixed = { "definitions/index.json": "a".repeat(64) };
  assert.equal(
    sameStaticPublicationTargets(fixed, {
      ...fixed,
      "policy/official/catalog.listings.json": "b".repeat(64),
    }),
    true,
  );
  assert.equal(
    sameStaticPublicationTargets(fixed, {
      ...fixed,
      "policy/official/unexpected.json": "b".repeat(64),
    }),
    false,
  );
  assert.equal(
    sameStaticPublicationTargets(
      { ...fixed, "policy/official/catalog.listings.json": "c".repeat(64) },
      { ...fixed, "policy/official/catalog.listings.json": "b".repeat(64) },
    ),
    false,
  );
});

void test("last-good data must be referenced in the verified role and exact physical inventory", async (t) => {
  const { fixtureDelivery } = await import("./fixtures/listing-observation-delivery-fixture.mts");
  const { verifiedPriorListing, priorListingForRenewal, listingDeliveryTarget } =
    await import("./listing-observation-delivery.mts");
  const { createHash } = await import("node:crypto");
  const prior = temp(t),
    bytes = fixtureDelivery(),
    sha = createHash("sha256").update(bytes).digest("hex");
  const target = `targets/${sha}.${listingDeliveryTarget}`;
  site(prior, { [listingDeliveryTarget]: sha });
  put(prior, target, bytes.toString());
  const report = {
    schema_version: 1,
    authority: "none",
    files: [{ target, sha256: sha, bytes: bytes.length }],
  };
  assert.deepEqual(await verifiedPriorListing(prior, report), bytes);
  const renewal = await priorListingForRenewal(prior, 1);
  assert.deepEqual(renewal.bytes, bytes);
  assert.equal(renewal.changed, false);
  assert.equal(renewal.updated, 0);
  await assert.rejects(verifiedPriorListing(prior, { ...report, files: [] }), /not referenced/u);
  put(prior, target, bytes.toString() + " ");
  await assert.rejects(verifiedPriorListing(prior, report), /bytes differ/u);
  await assert.rejects(priorListingForRenewal(prior, 1), /target digest differs/u);
  site(prior, {});
  assert.equal(
    await verifiedPriorListing(prior, report),
    null,
    "an unreferenced historical target blob is never selected",
  );
});

void test("completed source observations stay bound to current canonical provider, hints and route facts", async () => {
  const { fixtureListing, fixturePolicy } =
    await import("./fixtures/listing-observation-delivery-fixture.mts");
  const { completedListingCandidates } = await import("./listing-observation-delivery.mts");
  const { checkpoint, progress, keyOf } =
    await import("./fixtures/upstream-checkpoint-fixture.mts");
  const policy = fixturePolicy(),
    canonical = { format_version: 11, listings: [fixtureListing] };
  const state = checkpoint({
    [keyOf("owner/game")]: progress("owner/game", [], {
      repository_id: 42,
      last_complete_facts_sha256: policy.facts_sha256,
      last_complete_policies: [policy],
    }),
  });
  const input = {
    revision: "existing-observer-run-fixture",
    config_sha256: "a".repeat(64),
    checkpoint: state,
    catalog: { ports: [], listings: [fixtureListing] },
  };
  assert.equal(completedListingCandidates(input, { ports: [] }, canonical).length, 1);
  const moved = { ...fixtureListing, project_url: "https://github.com/new/game" };
  assert.equal(
    completedListingCandidates(input, { ports: [] }, { format_version: 12, listings: [moved] })
      .length,
    0,
  );
  const hinted = { ...fixtureListing, download_asset_hints: { "windows-x86-64": ["changed"] } };
  assert.equal(
    completedListingCandidates(input, { ports: [] }, { format_version: 12, listings: [hinted] })
      .length,
    0,
  );
  assert.equal(
    completedListingCandidates(
      input,
      { ports: [{ id: fixtureListing.id, release: { repository: "owner/game" } }] },
      canonical,
    ).length,
    0,
    "an observation of a listing cannot acquire a new managed-route binding",
  );

  const managed = {
    id: fixtureListing.id,
    channels: ["stable"],
    release: { repository: "owner/game" },
  };
  const managedInput = { ...input, catalog: { ...input.catalog, ports: [managed] } };
  const artwork = {
    game_id: 70,
    cover_id: 71,
    image_id: "fixturecover",
    image_sha256: "a".repeat(64),
    game_slug: "fixture-game",
    match_kind: "underlying-game",
  };
  const illustrated = { ...fixtureListing, artwork };
  const illustratedDirectory = { ...canonical, listings: [illustrated] };
  const illustratedPort = { ...managed, presentation: { artwork } };
  assert.deepEqual(
    completedListingCandidates(managedInput, { ports: [illustratedPort] }, illustratedDirectory),
    [policy.listing_update],
  );
  assert.deepEqual(
    completedListingCandidates(
      {
        ...managedInput,
        catalog: { ...input.catalog, ports: [illustratedPort], listings: [illustrated] },
      },
      { ports: [managed] },
      canonical,
    ),
    [policy.listing_update],
  );
  const changedRelease = { ...illustratedPort, release: { repository: "owner/other-game" } };
  assert.deepEqual(
    completedListingCandidates(managedInput, { ports: [changedRelease] }, illustratedDirectory),
    [],
  );

  const reusedPath = { ...fixtureListing, id: "github-891" };
  const correctIdentity = { ...fixtureListing, id: "github-42" };
  const matching = fixturePolicy(correctIdentity);
  const mismatch = fixturePolicy(reusedPath);
  const listings = [reusedPath, correctIdentity];
  const gaps: string[] = [];
  const reusedPathInput = {
    ...input,
    catalog: { ports: [], listings },
    checkpoint: checkpoint({
      [keyOf("owner/game")]: progress("owner/game", [], {
        repository_id: 42,
        last_complete_facts_sha256: matching.facts_sha256,
        last_complete_policies: [mismatch, matching],
      }),
    }),
  };
  assert.deepEqual(
    completedListingCandidates(
      reusedPathInput,
      { ports: [] },
      { format_version: 17, listings },
      Date.now(),
      gaps,
    ),
    [matching.listing_update],
  );
  assert.deepEqual(gaps, ["github-891: observer result names a different GitHub repository ID"]);
});

void test("compact publication rebinds the exact decoded directory to its separate retained physical identity", async (t) => {
  const { createHash } = await import("node:crypto");
  const { fixtureDelivery } = await import("./fixtures/listing-observation-delivery-fixture.mts");
  const { verifiedPriorListing, priorListingForRenewal } =
    await import("./listing-observation-delivery.mts");
  const { compactListingDeliveryTarget, encodeCompactListing, decodeRetainedCompactListing } =
    await import("./listing-directory-carrier.mts");
  const prior = temp(t);
  const decoded = fixtureDelivery();
  const raw = encodeCompactListing(decoded);
  const sha = createHash("sha256").update(raw).digest("hex");
  const target = `targets/${sha}.${compactListingDeliveryTarget}`;
  assert.deepEqual(encodeCompactListing(decoded), raw);
  assert.deepEqual(decodeRetainedCompactListing(raw), decoded);
  assert.deepEqual(
    raw,
    readFileSync(
      new URL(
        "../crates/portcove-core/src/testdata/compact-listing-delivery.generated.json",
        import.meta.url,
      ),
    ),
  );
  site(prior, { [compactListingDeliveryTarget]: sha });
  put(prior, target, raw.toString());
  const report = {
    schema_version: 1,
    authority: "none",
    files: [{ target, sha256: sha, bytes: raw.length }],
  };
  assert.deepEqual(await verifiedPriorListing(prior, report, compactListingDeliveryTarget), raw);
  const renewal = await priorListingForRenewal(prior, 1, compactListingDeliveryTarget);
  assert.deepEqual(renewal.bytes, decoded);
  assert.deepEqual(renewal.wire, raw);
  await assert.rejects(
    verifiedPriorListing(
      prior,
      { ...report, files: [{ target, sha256: "c".repeat(64), bytes: raw.length }] },
      compactListingDeliveryTarget,
    ),
    /not referenced/u,
  );
});

void test("a reviewed compact withdrawal keeps the other delivered listings", async () => {
  const { fixtureDelivery } = await import("./fixtures/listing-observation-delivery-fixture.mts");
  const { projectListingDelivery } = await import("./listing-observation-delivery.mts");
  const before = decodedListingDelivery(fixtureDelivery());
  const released = before.directory.listings[0]!;
  const wire = (value: unknown) => Buffer.from(JSON.stringify(value));
  const compactOnly = { ...released, id: "compact-only" };
  const newerDirectory = {
    ...before.directory,
    listings: [...before.directory.listings, compactOnly],
  };
  const active = wire({ ...before, directory: newerDirectory, revision: 3 });
  const refreshed = projectListingDelivery(newerDirectory, [], active, {
    revisionFloor: 4,
    compatible: newerDirectory,
    withdrawals: [released.id],
  });
  const actual = decodedListingDelivery(refreshed.bytes);
  assert.equal(actual.revision, 5);
  assert.deepEqual(actual.withdrawn_ids, [released.id]);
  assert.deepEqual(
    actual.directory.listings.map((listing: { id: string }) => listing.id),
    ["compact-only"],
  );
});

void test("compact listing includes the complete canonical snapshot or fails at its true bound", async () => {
  const { projectListingDelivery } = await import("./listing-observation-delivery.mts");
  const { compactListingDecodedMaximum, decodeRetainedCompactListing, encodeCompactListing } =
    await import("./listing-directory-carrier.mts");
  const listings = [
    { id: "unobserved-listing", name: "Descriptive listing" },
    { id: "operational-listing", name: "Operational listing" },
    { id: "withdrawn-listing", name: "Withdrawn listing" },
  ];
  const canonical = { format_version: 11, listings };
  const project = (byteLimit: number) =>
    projectListingDelivery(canonical, [], null, {
      byteLimit,
      now: 0,
      withdrawals: ["withdrawn-listing"],
    });
  const complete = project(compactListingDecodedMaximum);
  assert.equal(complete.delivered_records, 2);
  assert.deepEqual(decodedListingDelivery(complete.bytes).directory.listings, [
    listings[1],
    listings[0],
  ]);
  const wire = encodeCompactListing(complete.bytes);
  assert.deepEqual(decodeRetainedCompactListing(wire), complete.bytes);
  assert.deepEqual(project(complete.bytes.length).bytes, complete.bytes);
  assert.throws(() => project(complete.bytes.length - 1), /retaining last-good publication/u);
  assert.throws(() => project(compactListingDecodedMaximum + 1), /compact decoded maximum/u);
});

void test("signed directory retains equivalent completed evidence until its recorded midpoint", async () => {
  const { fixtureListing, fixturePolicy } =
    await import("./fixtures/listing-observation-delivery-fixture.mts");
  const { projectListingDelivery } = await import("./listing-observation-delivery.mts");
  const canonical = { format_version: 11, listings: [fixtureListing] };
  const old = fixturePolicy().listing_update;
  const first = projectListingDelivery(canonical, [old], null);
  const observation = {
    ...old.upstream_observation,
    attempted_at: "2026-11-10T03:00:01Z",
    observed_at: "2026-11-10T03:00:00Z",
    fresh_until: "2026-11-10T15:00:00Z",
  };
  const candidate = { ...old, upstream_observation: observation };
  const advance = (hours: number, proposed = candidate) =>
    projectListingDelivery(canonical, [proposed], first.bytes, {
      now: Date.parse(`2026-11-10T0${hours}:00:02Z`),
    });
  assert.deepEqual(advance(3).bytes, first.bytes);
  const renewal = advance(6);
  assert.equal(renewal.revision, first.revision + 1);
  const directory = fixtureRecord(fixtureRecord(JSON.parse(renewal.bytes.toString())).directory);
  const priorDirectory = fixtureRecord(fixtureRecord(JSON.parse(first.bytes.toString())).directory);
  const priorObservation = fixtureRecord(
    fixtureRecords(priorDirectory.listings)[0]?.upstream_observation,
  );
  assert.deepEqual(fixtureRecords(directory.listings)[0]?.upstream_observation, {
    ...priorObservation,
    attempted_at: observation.attempted_at,
    observed_at: observation.observed_at,
    fresh_until: observation.fresh_until,
  });
  for (const changed of [
    { ...observation, facts_sha256: "b".repeat(64) },
    { ...observation, fresh_until: "2026-11-10T14:00:00Z" },
  ]) {
    assert.equal(advance(3, { ...candidate, upstream_observation: changed }).changed, true);
  }
});

function decodedListingDelivery(bytes: Buffer) {
  return JSON.parse(bytes.toString()) as {
    revision: number;
    withdrawn_ids: string[];
    directory: { format_version: number; listings: ({ id: string } & Record<string, unknown>)[] };
  };
}

void test("signed listing projection accepts only bound first-party websites and handles correction and withdrawal", async () => {
  const { fixtureListing } = await import("./fixtures/listing-observation-delivery-fixture.mts");
  const { firstPartyListingModDefaults } = await import("./listing-mod-portal-projection.mts");
  const { launcherModSubjects, recordLauncherModAttempt } =
    await import("./upstream-launcher-mod-progress.mts");
  const { catalogObservationSources } = await import("./catalog-upstream-observer.mts");
  const { projectListingDelivery } = await import("./listing-observation-delivery.mts");
  const port = { ...fixtureListing, mod_portals: undefined };
  const now = Date.parse("2026-11-26T12:00:00Z");
  const catalog = { ports: [] };
  const canonical = { format_version: 17, listings: [port] };
  const [source] = catalogObservationSources({ ...catalog, listings: canonical.listings }).sources;
  const ids = { [source!.key]: { repository_id: 567 } };
  const [subject] = launcherModSubjects([source!], ids);
  const binding = requiredFixture(subject).binding;
  const row = recordLauncherModAttempt(
    binding,
    undefined,
    {
      state: "observed",
      repository_id: 567,
      commit: "a".repeat(40),
      tree: "b".repeat(40),
      blob: "c".repeat(40),
      manifest_sha256: "d".repeat(64),
      mod_portals: [
        {
          id: "upstream-thunderstore",
          name: "Thunderstore",
          site: "community_site",
          instructions: "The upstream project lists this community. Follow its setup instructions.",
          url: "https://thunderstore.io/c/fixture-community/",
        },
      ],
    },
    now,
    3600000,
  );
  const checkpoint = (value: typeof row) => ({
    sources: ids,
    launcher_mod_sources: { [port.id]: value },
  });
  const project = (state: unknown, previous: Buffer | null, excluded = new Set<string>()) =>
    projectListingDelivery(canonical, [], previous, {
      now,
      firstPartyModDefaults: firstPartyListingModDefaults(catalog, [port], state, excluded, now),
    });
  const read = (bytes: Buffer) =>
    fixtureRecords(
      fixtureRecord(fixtureRecord(JSON.parse(bytes.toString())).directory).listings,
    )[0];
  const current = project(checkpoint(row), null);
  assert.equal(current.generated_mod_portals, 1);
  assert.deepEqual(read(current.bytes)?.mod_portals, [
    {
      id: "obs-gh-thunderstore-567",
      name: "Thunderstore",
      site: "community_site",
      instructions: "The upstream project lists this community. Follow its setup instructions.",
      url: "https://thunderstore.io/c/fixture-community/",
    },
  ]);
  const outage = recordLauncherModAttempt(
    binding,
    row,
    {
      state: "unavailable",
      reason: "provider-outage",
    },
    now,
    3600000,
  );
  assert.deepEqual(project(checkpoint(outage), current.bytes).bytes, current.bytes);
  assert.deepEqual(project(undefined, current.bytes).bytes, current.bytes);
  const missingHistory = recordLauncherModAttempt(
    binding,
    undefined,
    { state: "unavailable", reason: "provider-outage" },
    now,
    3600000,
  );
  assert.deepEqual(project(checkpoint(missingHistory), current.bytes).bytes, current.bytes);
  const ambiguous = firstPartyListingModDefaults(
    catalog,
    [port, { ...port, id: "second-implementation" }],
    undefined,
    new Set(),
    now,
  );
  assert.deepEqual(ambiguous(port, read(current.bytes)), []);
  assert.equal(
    read(project(checkpoint(row), current.bytes, new Set([port.id])).bytes)?.mod_portals,
    undefined,
  );
  assert.equal(
    read(project(checkpoint({ ...row, binding: "e".repeat(64) }), current.bytes).bytes)
      ?.mod_portals,
    undefined,
  );
  const absent = recordLauncherModAttempt(
    binding,
    row,
    {
      state: "absent",
      repository_id: 567,
      commit: "f".repeat(40),
      tree: "b".repeat(40),
    },
    now,
    3600000,
  );
  assert.equal(read(project(checkpoint(absent), current.bytes).bytes)?.mod_portals, undefined);
});

void test("admission mod defaults keep one source ID and cannot revive after withdrawal", async () => {
  const { fixtureListing } = await import("./fixtures/listing-observation-delivery-fixture.mts");
  const { firstPartyListingModDefaults } = await import("./listing-mod-portal-projection.mts");
  const { launcherModSubjects, recordLauncherModAttempt } =
    await import("./upstream-launcher-mod-progress.mts");
  const { catalogObservationSources } = await import("./catalog-upstream-observer.mts");
  const { projectListingDelivery } = await import("./listing-observation-delivery.mts");
  const seed = {
    id: "obs-gh-gamebanana-12345",
    site: "community_site",
    name: "GameBanana",
    instructions: "The upstream project lists this community. Follow its setup instructions.",
    url: "https://gamebanana.com/games/456",
  };
  const port = { ...fixtureListing, id: "github-12345", mod_portals: [seed] };
  const catalog = { ports: [] };
  const canonical = { format_version: 17, listings: [port] };
  const now = Date.parse("2026-11-26T12:00:00Z");
  const sources = catalogObservationSources({ ...catalog, listings: [port] }).sources;
  const ids = { [requiredFixture(sources[0]).key]: { repository_id: 12345 } };
  const binding = requiredFixture(launcherModSubjects(sources, ids)[0]).binding;
  const project = (state: unknown, previous: Buffer | null, excluded = new Set<string>()) =>
    projectListingDelivery(canonical, [], previous, {
      now,
      firstPartyModDefaults: firstPartyListingModDefaults(catalog, [port], state, excluded, now),
    });
  const links = (bytes: Buffer) =>
    fixtureRecords(fixtureRecord(fixtureRecord(JSON.parse(bytes.toString())).directory).listings)[0]
      ?.mod_portals;
  const first = project(undefined, null);
  assert.deepEqual(links(first.bytes), [seed]);
  const changed = recordLauncherModAttempt(
    binding,
    undefined,
    {
      state: "observed",
      repository_id: 12345,
      commit: "a".repeat(40),
      tree: "b".repeat(40),
      blob: "c".repeat(40),
      manifest_sha256: "d".repeat(64),
      mod_portals: [
        {
          ...seed,
          id: "upstream-gamebanana",
          site: "community_site",
          url: "https://gamebanana.com/games/789",
        },
      ],
    },
    now,
    3600000,
  );
  const state = (value: typeof changed) => ({
    sources: ids,
    launcher_mod_sources: { [port.id]: value },
  });
  const second = project(state(changed), first.bytes);
  assert.deepEqual(links(second.bytes), [{ ...seed, url: "https://gamebanana.com/games/789" }]);
  assert.deepEqual(project(undefined, second.bytes).bytes, second.bytes);
  const absent = recordLauncherModAttempt(
    binding,
    changed,
    {
      state: "absent",
      repository_id: 12345,
      commit: "e".repeat(40),
      tree: "f".repeat(40),
    },
    now,
    3600000,
  );
  const withdrawn = project(state(absent), second.bytes);
  assert.equal(links(withdrawn.bytes), undefined);
  assert.deepEqual(project(undefined, withdrawn.bytes).bytes, withdrawn.bytes);
  assert.equal(links(project(undefined, null, new Set([port.id])).bytes), undefined);
});
