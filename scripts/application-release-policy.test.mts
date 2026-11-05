import assert from "node:assert/strict";
import test from "node:test";
import {
  applicationReleaseJobMinutes,
  applicationReleaseBudgetMinutes,
  applicationReleaseTrust,
  applicationReleaseWorkflow,
  inspectApplicationPublicationPause,
  inspectApplicationReleaseExecution,
  inspectApplicationPackageExecution,
  verifyApplicationReleaseTrust,
  inspectApplicationSpendingAppointment,
} from "./application-release-policy.mts";

function controlFixture(): NodeJS.ProcessEnv {
  const source = "a".repeat(40);
  const ref = "refs/tags/portcove-production-controller-windows-upstream-v1";
  return {
    PORTCOVE_APPLICATION_RELEASE_REVISION: source,
    PORTCOVE_APPLICATION_RELEASE_REF: ref,
    GITHUB_REPOSITORY: "boburning/portcove",
    GITHUB_REPOSITORY_ID: "1354613114",
    GITHUB_EVENT_NAME: "workflow_dispatch",
    GITHUB_REF: ref,
    GITHUB_REF_PROTECTED: "true",
    GITHUB_SHA: source,
    GITHUB_WORKFLOW_SHA: source,
    GITHUB_WORKFLOW_REF: `boburning/portcove/${applicationReleaseWorkflow}@${ref}`,
    GITHUB_RUN_ID: "41800000000",
    GITHUB_RUN_ATTEMPT: "1",
  };
}

void test("source and private jobs require the same owner-appointed zero-dollar spending boundary", () => {
  const hash = "f".repeat(64);
  const spending = {
    budget_id: "4a6859d9-fdb7-4da2-afd3-acbdc9848eec",
    scope: "account",
    amount_usd: 0,
    stop_usage: true,
    operator_id: 43177418,
    application_minutes: 140,
    catalog_minutes: 40,
    workflow_sha256: hash,
  };
  const inspect = (record: unknown) =>
    inspectApplicationSpendingAppointment({
      PORTCOVE_APPLICATION_RELEASE_SPENDING: JSON.stringify(record),
      PORTCOVE_APPLICATION_RELEASE_WORKFLOW_SHA256: hash,
    });
  assert.deepEqual(inspect(spending), {
    budget_id: spending.budget_id,
    headroom: "unknown",
    reservation: false,
    paid_fallback: false,
  });
  for (const change of [
    { budget_id: "another" },
    { scope: "repository" },
    { amount_usd: 1 },
    { stop_usage: false },
    { operator_id: 1 },
    { application_minutes: 141 },
    { catalog_minutes: 41 },
    { workflow_sha256: "a".repeat(64) },
  ])
    assert.throws(() => inspect({ ...spending, ...change }));
  assert.throws(() => inspect(null));
});

void test("main qualification can attest public packages but cannot enter the private release guard", () => {
  const fixture = {
    ...controlFixture(),
    PORTCOVE_APPLICATION_PACKAGE_MODE: "qualification",
    GITHUB_REF: "refs/heads/main",
    GITHUB_WORKFLOW_REF: "boburning/portcove/.github/workflows/release.yml@refs/heads/main",
  };
  assert.equal(inspectApplicationPackageExecution(fixture).ref, "refs/heads/main");
  assert.throws(() => inspectApplicationReleaseExecution(fixture));
  for (const change of [
    { GITHUB_EVENT_NAME: "pull_request" },
    { GITHUB_REF: "refs/heads/feature/arbitrary" },
    { GITHUB_REPOSITORY_ID: "1" },
    { GITHUB_WORKFLOW_SHA: "b".repeat(40) },
    { GITHUB_RUN_ATTEMPT: "4" },
    { GITHUB_WORKFLOW_REF: "boburning/portcove/.github/workflows/ci.yml@refs/heads/main" },
  ])
    assert.throws(() => inspectApplicationPackageExecution({ ...fixture, ...change }));
});

void test("execution identity binds reviewed control separately from the product input", () => {
  const environment: NodeJS.ProcessEnv = {
    ...controlFixture(),
    PORTCOVE_PRODUCT_SOURCE: "b".repeat(40),
  };
  assert.deepEqual(inspectApplicationReleaseExecution(environment), {
    source: "a".repeat(40),
    ref: environment.PORTCOVE_APPLICATION_RELEASE_REF,
    run_id: environment.GITHUB_RUN_ID,
    run_attempt: 1,
  });
});

void test("a candidate, mutable ref or foreign execution cannot masquerade as trusted control", () => {
  for (const change of [
    { GITHUB_REPOSITORY: "another/portcove" },
    { GITHUB_REPOSITORY_ID: "1354613115" },
    { GITHUB_EVENT_NAME: "pull_request" },
    { GITHUB_REF_PROTECTED: "false" },
    { GITHUB_REF: "refs/heads/main" },
    { PORTCOVE_APPLICATION_RELEASE_REF: "refs/heads/main" },
    { GITHUB_SHA: "b".repeat(40) },
    { GITHUB_WORKFLOW_SHA: "b".repeat(40) },
    { GITHUB_WORKFLOW_REF: "boburning/portcove/.github/workflows/release.yml@refs/heads/main" },
    { PORTCOVE_APPLICATION_RELEASE_REVISION: "" },
    { GITHUB_RUN_ID: "0" },
    { GITHUB_RUN_ID: "9007199254740992" },
    { GITHUB_RUN_ATTEMPT: "0" },
    { GITHUB_RUN_ATTEMPT: "4" },
    { GITHUB_RUN_ATTEMPT: "unknown" },
  ])
    assert.throws(() => inspectApplicationReleaseExecution({ ...controlFixture(), ...change }));
});

void test("observing an unpaused flag grants no publication authority", () => {
  for (const paused of [false, true])
    assert.deepEqual(
      inspectApplicationPublicationPause({ schema_version: 1, publication_paused: paused }),
      {
        paused,
        authority: "none",
      },
    );
  for (const invalid of [
    null,
    [],
    {},
    { publication_paused: false },
    { schema_version: 2, publication_paused: false },
    { schema_version: 1, publication_paused: "false" },
    { publication_paused: 0 },
    { publication_paused: false, production_authority: true },
  ])
    assert.throws(() => inspectApplicationPublicationPause(invalid));
});

void test("production uses the existing public application anchors and origins", async () => {
  assert.equal(await verifyApplicationReleaseTrust(), applicationReleaseTrust);
  assert.equal(
    applicationReleaseTrust.root.sha256,
    "17de1676cd26c4bd2867d3a7941793147b94670d027e7846557d813bc9f43f92",
  );
  assert.equal(
    applicationReleaseTrust.metadata,
    "https://boburning.github.io/portcove/application/metadata/",
  );
  assert.equal(
    applicationReleaseTrust.content,
    "https://boburning.github.io/portcove/application/targets/",
  );
});

void test("declared first-pass job ceilings fit the existing application resource appointment", () => {
  const ceilings = Object.values(applicationReleaseJobMinutes);
  assert.ok(ceilings.length > 0);
  assert.ok(ceilings.every((minutes) => Number.isSafeInteger(minutes) && minutes > 0));
  for (const purpose of ["application-release", "metadata-bootstrap", "metadata-renewal"]) {
    assert.ok(
      Object.values(applicationReleaseBudgetMinutes(purpose)).reduce(
        (sum, minutes) => sum + minutes,
        0,
      ) <= 140,
    );
  }
  const application = applicationReleaseBudgetMinutes("application-release");
  const bootstrap = applicationReleaseBudgetMinutes("metadata-bootstrap");
  assert.ok(
    typeof application.publication_prepare === "number" &&
      typeof application.publication === "number",
  );
  assert.equal(application.readback, 3);
  assert.equal(application.public_installed_readback, 2);
  assert.equal(bootstrap.readback, 5);
  assert.equal(Object.hasOwn(bootstrap, "public_installed_readback"), false);
  assert.equal(application.publication_prepare + application.publication, bootstrap.publication);
  assert.equal(Object.hasOwn(bootstrap, "publication_prepare"), false);
  assert.throws(() => applicationReleaseBudgetMinutes("unknown"));
  // This is a first-pass bound, not capacity or a reservation; retry accounting
  // must additionally charge the actual earlier executions.
});
