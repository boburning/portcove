import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
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
  assert.equal(
    newestGreen(
      history,
      new Map([
        ["b", "success"],
        ["a", "success"],
      ]),
    ),
    "b",
  );
  assert.equal(
    newestGreen(
      history,
      new Map([
        ["c", "failure"],
        ["a", "success"],
      ]),
    ),
    "a",
  );
  assert.equal(newestGreen(history, new Map([["c", "cancelled"]])), null);
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
  environment?: string;
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
  assert.deepEqual(publish.jobs["sign-snapshot"]!.needs, [
    "prepare",
    "sign-definitions",
    "sign-policy",
  ]);
  assert.deepEqual(publish.jobs["sign-timestamp"]!.needs, ["prepare", "sign-snapshot"]);
  // Only the publish job writes, and it holds no catalog key.
  assert.deepEqual(publish.jobs.publish!.permissions, { contents: "write" });
  assert.doesNotMatch(JSON.stringify(publish), /\bsecrets\./u);

  assert.deepEqual(Object.keys(sign.on), ["workflow_call"]);
  const job = sign.jobs.sign!;
  // The environment follows the role and can only be one of the four catalog environments.
  assert.equal(
    job.environment,
    "${{ inputs.role == 'official-definitions' && 'production-catalog-definitions' || inputs.role == 'official-policy' && 'production-catalog-policy' || inputs.role == 'snapshot' && 'production-catalog-snapshot' || 'production-catalog-timestamp' }}",
  );
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
