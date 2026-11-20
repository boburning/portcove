import {
  record as fixtureRecord,
  records as fixtureRecords,
  requiredFixture,
} from "./fixtures/catalog-generator-fixtures.mts";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";
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
} from "./catalog-publish.mts";
import {
  describeCatalogPublication,
  verifyCatalogPublicationLive,
} from "./catalog-publication-receipt.mts";

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
    /\[ "\$actual" = "\$expected" \][^\n]+\[ "\$sample_actual" = "\$sample_expected" \]; then\s+echo [^\n]+\s+if node scripts\/catalog-publication-receipt\.mts/u,
  );
  assert.equal(readback.match(/receipt=true/gu)?.length, 1);
  assert.match(
    readback,
    /receipt=true[^\n]+\n\s+else\s+echo "::warning::Catalog publication succeeded/u,
  );
  const upload = steps[index + 1]!;
  assert.equal(upload.if, "steps.readback.outputs.receipt == 'true'");
  assert.equal(upload.with?.["retention-days"], 7);
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

void test("observation publication retains applicable earlier rows before admitting fresh rows into the fixed byte budget", async () => {
  const { fixtureListing, fixturePolicy } =
    await import("./fixtures/listing-observation-delivery-fixture.mts");
  const { projectListingDelivery } = await import("./listing-observation-delivery.mts");
  const old = fixturePolicy().listing_update;
  const first = projectListingDelivery(
    { format_version: 11, listings: [fixtureListing] },
    [old],
    null,
  );
  const nextListing = { ...fixtureListing, id: "another-project", summary: "x".repeat(20000) };
  const next = { ...fixturePolicy(nextListing).listing_update };
  const capped = projectListingDelivery(
    { format_version: 11, listings: [fixtureListing, nextListing] },
    [next, old],
    first.bytes,
    0,
    first.bytes.length + 100,
  );
  assert.deepEqual(capped.bytes, first.bytes);
  assert.equal(capped.changed, false);
  assert.deepEqual(
    capped.omitted.map((value) => value.id),
    ["another-project"],
  );
  assert.equal(capped.delivered_records, 1);
  assert.equal(capped.canonical_records, 2);
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
  const all = projectListingDelivery(directory, [incoming, existing], previous);
  const exactLimit = all.bytes.length;
  const bounded = projectListingDelivery(directory, [incoming, existing], previous, 0, exactLimit);
  assert.deepEqual(bounded.bytes, all.bytes);
  assert.equal(bounded.delivered_records, 2);
  assert.equal(bounded.updated, 1);
  const belowLimit = projectListingDelivery(
    directory,
    [incoming, existing],
    previous,
    0,
    exactLimit - 1,
  );
  assert.deepEqual(belowLimit.omitted, [
    { id: newListing.id, reason: "existing-target-byte-budget" },
  ]);
  const delivered = fixtureRecord(fixtureRecord(JSON.parse(bounded.bytes.toString())).directory);
  const newRow = requiredFixture(
    fixtureRecords(delivered.listings).find((row) => row.id === newListing.id),
  );
  assert.deepEqual(newRow.upstream_observation, incomingObservation);
  const oldObservation = fixtureRecord(existing.upstream_observation);
  const oldRelease = requiredFixture(fixtureRecords(oldObservation.releases)[0]);
  assert.equal(requiredFixture(fixtureRecords(oldRelease.assets)[0]).sha256, null);
  const replay = projectListingDelivery(
    directory,
    [existing, incoming],
    bounded.bytes,
    0,
    exactLimit,
  );
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
  const { verifiedPriorListing, listingDeliveryTarget } =
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
  await assert.rejects(verifiedPriorListing(prior, { ...report, files: [] }), /not referenced/u);
  put(prior, target, bytes.toString() + " ");
  await assert.rejects(verifiedPriorListing(prior, report), /bytes differ/u);
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
});
