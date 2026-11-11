import { windowsApplicationQualificationFixture } from "./fixtures/application-qualification-fixture.mts";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { createWakeProvider } from "./release-wake-provider.mts";
import { selectWindowsApplicationQualificationRun } from "./application-release-qualification.mts";
import test from "node:test";
import { digestValidationPlan } from "./validation-plan.mts";
import { createAuditZip } from "./fixtures/audit-zip-fixture.mts";
import {
  inspectWindowsApplicationQualification,
  readApplicationQualificationPlan,
  readWindowsApplicationQualification,
} from "./application-release-qualification.mts";

const source = "a".repeat(40);
const fixture = () => windowsApplicationQualificationFixture(source);

void test("automatic qualification selection rejects stale success, foreign identity and incomplete run inventory", () => {
  const source = "a".repeat(40);
  const run = {
    id: 21,
    run_attempt: 1,
    head_sha: source,
    head_branch: "main",
    path: ".github/workflows/application-release.yml",
    event: "workflow_dispatch",
    head_repository: { id: 1354613114 },
    repository: { id: 1354613114 },
    created_at: "2026-11-05T00:00:00Z",
    display_title: `Windows qualification ${source}`,
    status: "completed",
    conclusion: "success",
  };
  const inventory = (...workflow_runs: unknown[]) => ({
    total_count: workflow_runs.length,
    workflow_runs,
  });
  assert.deepEqual(selectWindowsApplicationQualificationRun(inventory(run), source), {
    decision: "candidate",
    run_id: 21,
    run_attempt: 1,
    authority: "none",
  });
  const later = { ...run, id: 22, created_at: "2026-11-05T00:02:00Z" };
  assert.deepEqual(
    selectWindowsApplicationQualificationRun(
      inventory(run, {
        ...later,
        status: "in_progress",
        conclusion: null,
      }),
      source,
    ),
    { decision: "held", run_id: 22, run_attempt: 1, authority: "none" },
  );
  assert.equal(
    selectWindowsApplicationQualificationRun(
      inventory({
        ...run,
        display_title: `Application ${source}`,
      }),
      source,
    ).decision,
    "absent",
  );
  assert.throws(() => selectWindowsApplicationQualificationRun(inventory(run, run), source));
  assert.throws(() =>
    selectWindowsApplicationQualificationRun({ ...inventory(run), total_count: 2 }, source),
  );
  assert.throws(() =>
    selectWindowsApplicationQualificationRun(
      inventory({
        ...run,
        head_repository: { id: 1 },
      }),
      source,
    ),
  );
});

void test("qualification binds actual maintained Windows/shared producer names and the complete plan", () => {
  const { run, jobs, plan } = fixture();
  const result = inspectWindowsApplicationQualification(run, jobs, plan, source);
  assert.equal(result.authority, "none");
  assert.equal(result.workflow_commit, source);
  assert.equal(result.plan_digest, plan.digest);
  assert.equal(result.required_jobs.length, jobs.total_count);
  // Forced qualification records checkout directly; it retains a null diff head.
  assert.equal(plan.identities.head, null);
});

void test("canonical Windows qualification requires its exact profile and all packaging producers", () => {
  const { run, jobs, plan } = fixture();
  const canonical = {
    ...run,
    path: ".github/workflows/application-release.yml",
    event: "workflow_dispatch",
    display_title: `Windows qualification ${source}`,
  };
  const names = [
    "selection",
    "dependency-review",
    "package_qualification / package",
    "package_qualification / provenance",
  ];
  assert.throws(() => inspectWindowsApplicationQualification(canonical, jobs, plan, source));
  jobs.jobs.push(...names.map((name, index) => ({ ...jobs.jobs[0]!, id: 999 + index, name })));
  jobs.total_count += names.length;
  const result = inspectWindowsApplicationQualification(canonical, jobs, plan, source);
  assert.deepEqual(result.required_jobs.slice(-names.length), names);
  for (const name of names) {
    const changed = structuredClone(jobs);
    changed.jobs.find((job) => job.name === name)!.conclusion = "skipped";
    assert.throws(() => inspectWindowsApplicationQualification(canonical, changed, plan, source));
  }
  const duplicate = structuredClone(jobs);
  duplicate.jobs[1]!.id = duplicate.jobs[0]!.id;
  assert.throws(() => inspectWindowsApplicationQualification(canonical, duplicate, plan, source));
  for (const change of [{ conclusion: "failure" }, { display_title: `Application ${source}` }]) {
    assert.throws(() =>
      inspectWindowsApplicationQualification({ ...canonical, ...change }, jobs, plan, source),
    );
  }
  const otherProfile = { ...plan };
  delete otherProfile.release_profile;
  otherProfile.digest = digestValidationPlan(otherProfile);
  assert.throws(() =>
    inspectWindowsApplicationQualification(canonical, jobs, otherProfile, source),
  );
});

void test("a broader failed result is retained while every required Windows/shared producer must pass", () => {
  const { run, jobs, plan } = fixture();
  run.conclusion = "failure";
  const other = {
    ...jobs.jobs[0]!,
    id: 999,
    name: "qualify / native-rust (linux-x86_64, hash:1/1)",
    conclusion: "failure",
  };
  jobs.jobs.push(other);
  jobs.total_count++;
  const result = inspectWindowsApplicationQualification(run, jobs, plan, source);
  assert.equal(result.original_run_conclusion, "failure");
  assert.equal(result.scope, "Windows x86-64 and shared qualification producers only");
  for (const value of jobs.jobs.filter((job) => job.id !== 999)) {
    for (const conclusion of ["failure", "cancelled", "skipped", "neutral"]) {
      const changed = structuredClone(jobs);
      changed.jobs.find((job) => job.id === value.id)!.conclusion = conclusion;
      assert.throws(() => inspectWindowsApplicationQualification(run, changed, plan, source));
    }
  }
});

void test("foreign, cancelled, partial, duplicate or stale qualification cannot pass", () => {
  const { run, jobs, plan } = fixture();
  for (const change of [
    { head_sha: "b".repeat(40) },
    { head_branch: "feature/foreign" },
    { path: ".github/workflows/ci.yml" },
    { status: "in_progress" },
    { conclusion: "cancelled" },
    { event: "pull_request" },
    { repository: { ...run.repository, id: 1 } },
  ])
    assert.throws(() =>
      inspectWindowsApplicationQualification({ ...run, ...change }, jobs, plan, source),
    );
  const missing = { total_count: jobs.total_count - 1, jobs: jobs.jobs.slice(1) };
  assert.throws(() => inspectWindowsApplicationQualification(run, missing, plan, source));
  assert.throws(() =>
    inspectWindowsApplicationQualification(
      run,
      { ...jobs, total_count: jobs.total_count + 1 },
      plan,
      source,
    ),
  );
  assert.throws(() =>
    inspectWindowsApplicationQualification(
      run,
      { total_count: jobs.total_count + 1, jobs: [...jobs.jobs, jobs.jobs[0]] },
      plan,
      source,
    ),
  );
  const stale = { ...plan, identities: { ...plan.identities, checkout: "b".repeat(40) } };
  stale.digest = digestValidationPlan(stale);
  assert.throws(() => inspectWindowsApplicationQualification(run, jobs, stale, source));
});

void test("retained qualification plan archive is bounded before JSON decoding", () => {
  const { plan } = fixture();
  const archive = createAuditZip([["validation-plan.json", JSON.stringify(plan)]]);
  assert.deepEqual(readApplicationQualificationPlan(archive), plan);
  for (const invalid of [
    createAuditZip([["../validation-plan.json", JSON.stringify(plan)]]),
    createAuditZip([
      ["validation-plan.json", JSON.stringify(plan)],
      ["extra.json", "{}"],
    ]),
    createAuditZip([["validation-plan.json", "{}"]]),
  ])
    assert.throws(() => readApplicationQualificationPlan(invalid));
});

void test("locked SDK reads exact qualification recipes and rechecks the run after the bounded artifact", async () => {
  const { run, jobs, plan } = fixture();
  const archive = createAuditZip([["validation-plan.json", JSON.stringify(plan)]]);
  const sha = createHash("sha256").update(archive).digest("hex");
  const artifact = {
    id: 91,
    name: `validation-plan-qualification-${run.id}-${run.run_attempt}`,
    expired: false,
    size_in_bytes: archive.length,
    digest: `sha256:${sha}`,
    workflow_run: { id: run.id, head_sha: source, repository_id: 1354613114 },
  };
  const runRoute = `/repos/boburning/portcove/actions/runs/${run.id}`;
  const root = "/repos/boburning/portcove";
  const seen: string[] = [];
  const deadline = performance.now() + 15000;
  const provider = await createWakeProvider({
    credential: { kind: "explicit", token: "synthetic-qualification-reader" },
    deadline,
    remainingDeadline: () => deadline,
    maxBytes: 2 * 1024 ** 2,
    maxRequests: 7,
    apiVersion: "2022-11-28",
    fetch: async (input, init) => {
      const url = new URL(input instanceof Request ? input.url : input);
      const signed =
        "https://productionresultssa1.blob.core.windows.net/actions-results/qualification?sig=fixture";
      assert.equal(init?.method, "GET");
      assert.equal(init.redirect, "manual");
      if (url.href === signed) {
        assert.equal(init.credentials, "omit");
        assert.equal(new Headers(init.headers).has("authorization"), false);
        seen.push("signed qualification body");
        return new Response(archive);
      }
      assert.equal(url.origin, "https://api.github.com");
      assert.equal(
        new Headers(init?.headers).get("authorization"),
        "token synthetic-qualification-reader",
      );
      seen.push(url.pathname + url.search);
      if (url.pathname === `${root}/actions/artifacts/91/zip`)
        return new Response(null, { status: 302, headers: { location: signed } });
      if (url.pathname === runRoute) return Response.json(run);
      if (url.pathname === `${runRoute}/attempts/${run.run_attempt}/jobs`)
        return Response.json(jobs);
      if (url.pathname === `${runRoute}/artifacts`)
        return Response.json({ total_count: 1, artifacts: [artifact] });
      const workflow = decodeURIComponent(url.pathname.slice(`${root}/contents/`.length));
      assert.ok(
        workflow === ".github/workflows/ci.yml" ||
          workflow === ".github/workflows/qualification.yml",
      );
      const content = await readFile(new URL(`../${workflow}`, import.meta.url));
      return Response.json({
        type: "file",
        encoding: "base64",
        size: content.length,
        content: content.toString("base64"),
      });
    },
  });
  const result = await readWindowsApplicationQualification(provider, run.id, source, { deadline });
  await assert.rejects(provider.artifact(91), /request budget exhausted/u);
  assert.equal(result.plan_artifact_sha256, sha);
  assert.deepEqual(seen, [
    runRoute,
    `${root}/contents/${encodeURIComponent(".github/workflows/ci.yml")}?ref=${source}`,
    `${root}/contents/${encodeURIComponent(".github/workflows/qualification.yml")}?ref=${source}`,
    `${runRoute}/attempts/${run.run_attempt}/jobs?per_page=100`,
    `${runRoute}/artifacts?per_page=100`,
    `${root}/actions/artifacts/91/zip`,
    "signed qualification body",
    runRoute,
  ]);
});

for (const historical of [
  {
    id: 42407004590,
    run_attempt: 1,
    head_sha: "fd4b1a1c5bf3a4253ee06a357df04bb1f203cb2f",
    path: ".github/workflows/application-release.yml",
  },
  {
    id: 42656355737,
    run_attempt: 2,
    head_sha: "29f33f577dd08888daa308f6534e1ba2e0d10eaf",
    path: ".github/workflows/application-release.yml",
  },
]) {
  void test(`historical Windows qualification ${historical.id} requires exact source, attempt and recipes`, async () => {
    const content = Buffer.from("different workflow bytes");
    for (const fault of [
      "source",
      "provider-source",
      "attempt",
      "workflow",
      "digest",
      "ordinary-drift",
    ]) {
      const run = { ...historical };
      const selected = fault === "source" ? source : historical.head_sha;
      if (fault === "provider-source") run.head_sha = source;
      if (fault === "attempt") run.run_attempt = historical.run_attempt === 1 ? 2 : 1;
      if (fault === "workflow") run.path = ".github/workflows/qualification.yml";
      if (fault === "ordinary-drift") run.id = 999;
      let recipeReads = 0;
      const forbidden = async () => {
        throw new Error("downstream evidence accessed after refusal");
      };
      const reader = {
        run: async () => run,
        file: async () => {
          recipeReads++;
          return {
            type: "file",
            encoding: "base64",
            size: content.length,
            content: content.toString("base64"),
          };
        },
        jobs: forbidden,
        artifacts: forbidden,
        intentArchive: forbidden,
      };
      await assert.rejects(
        readWindowsApplicationQualification(reader, run.id, selected),
        fault === "digest"
          ? /historical Windows qualification recipe digest differs/u
          : fault === "ordinary-drift"
            ? /qualification recipe changed/u
            : /historical Windows qualification source or attempt differs/u,
      );
      assert.equal(recipeReads, fault === "digest" || fault === "ordinary-drift" ? 1 : 0);
    }
  });
}
