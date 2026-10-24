import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import filesystem from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import test from "node:test";
import oracle from "./fixtures/release-job-authorities-prechange.json" with { type: "json" };
import {
  admitProductionInputReader,
  admitProductionCatalogInputReader,
} from "./production-controller-admission.mts";
import {
  requireControllerJobAuthorityConfiguration,
  requireCoordinatorAuthorityConfiguration,
  requireControllerApplicationJobAuthorities,
  requireControllerApplicationJobPublicationAuthorities,
  requireControllerCatalogJobAuthorities,
  requireControllerJobSourceConfiguration,
} from "./release-authority-configuration.mts";
import {
  inspectControllerExecutionPurpose,
  inspectControllerPurposePhase,
  releaseControlPhaseProfile,
} from "./release-control-phases.mts";
import { releaseCanonicalDigest as digest } from "./release-canonical.mts";

const phases = [
  "admission",
  "payload",
  "coordinator",
  "site-publication",
  "release-publication",
  "tuf-releases",
  "tuf-preview",
  "tuf-stable",
  "tuf-snapshot",
  "tuf-timestamp",
  "catalog-definitions",
  "catalog-policy",
  "catalog-snapshot",
  "catalog-timestamp",
] as const;
const workflow = Buffer.from(oracle.workflow_base64, "base64");
void test("coordinator extraction preserves the captured pre-change selected and strict legacy views", () => {
  assert.equal(oracle.revision, "ca49fcf868075e7ff963284853a0903c020aa0be");
  for (const row of oracle.cases) {
    const purpose = inspectControllerExecutionPurpose(row.purpose);
    const source = (
      purpose === "application" ? admitProductionInputReader : admitProductionCatalogInputReader
    )(JSON.stringify(row.policy), oracle.environment, workflow, "coordinator");
    assert.equal(
      digest(requireCoordinatorAuthorityConfiguration(row.configuration, source, purpose)),
      row.output_sha256,
      row.name,
    );
    assert.equal(
      digest(
        requireControllerJobAuthorityConfiguration(
          row.configuration,
          source,
          "coordinator",
          purpose,
        ),
      ),
      row.output_sha256,
    );
    assert.throws(
      () => requireCoordinatorAuthorityConfiguration(row.configuration, { ...source }, purpose),
      { message: row.refusals["copied-source"] },
    );
  }
});
void test("both named job getters refuse the other purpose before any shared-phase workflow or provider read", async (t) => {
  const before = process.env.PORTCOVE_EXECUTION_PURPOSE;
  let reads = 0;
  t.mock.method(filesystem, "readFile", async () => {
    reads++;
    throw new Error("unexpected workflow read");
  });
  t.mock.method(globalThis, "fetch", async () => {
    reads++;
    throw new Error("unexpected OIDC read");
  });
  syncBuiltinESMExports();
  t.after(() => {
    t.mock.restoreAll();
    syncBuiltinESMExports();
    if (before === undefined) delete process.env.PORTCOVE_EXECUTION_PURPOSE;
    else process.env.PORTCOVE_EXECUTION_PURPOSE = before;
  });
  for (const phase of ["coordinator", "site-publication"]) {
    process.env.PORTCOVE_EXECUTION_PURPOSE = "catalog-publication";
    await assert.rejects(
      requireControllerApplicationJobAuthorities(phase),
      /application job source/,
    );
    await assert.rejects(
      requireControllerApplicationJobPublicationAuthorities(phase),
      /application job source/,
    );
    process.env.PORTCOVE_EXECUTION_PURPOSE = "application";
    await assert.rejects(requireControllerCatalogJobAuthorities(phase), /catalog job source/);
  }
  assert.equal(reads, 0);
});
void test("full selected and legacy views require their exact phase, purpose, scope and original source", () => {
  for (const row of oracle.cases) {
    const purpose = inspectControllerExecutionPurpose(row.purpose);
    for (const phase of phases) {
      const allowed =
        purpose === "application"
          ? !phase.startsWith("catalog-")
          : phase === "coordinator" || phase === "site-publication" || phase.startsWith("catalog-");
      if (!allowed) {
        assert.throws(() => inspectControllerPurposePhase(phase, purpose), /phase differs/);
        assert.throws(
          () =>
            requireControllerJobAuthorityConfiguration(
              row.configuration,
              undefined,
              phase,
              purpose,
            ),
          /phase differs/,
        );
        continue;
      }
      const runtime = {
        ...oracle.environment,
        GITHUB_JOB: releaseControlPhaseProfile(phase).reader_job,
      };
      const admit =
        purpose === "application" ? admitProductionInputReader : admitProductionCatalogInputReader;
      const source = admit(JSON.stringify(row.policy), runtime, workflow, phase);
      const view = requireControllerJobAuthorityConfiguration(
        row.configuration,
        source,
        phase,
        purpose,
      );
      assert.equal(view.configuration_sha256, row.policy.authority_configuration_sha256);
      assert.equal(view.dispatch_actor_id, runtime.GITHUB_ACTOR_ID);
      assert.equal(view.purpose, purpose);
      assert.equal(view.semantic_producer.schema_version, row.name.startsWith("selected") ? 2 : 1);
      assert.throws(
        () =>
          requireControllerJobAuthorityConfiguration(
            row.configuration,
            { ...source },
            phase,
            purpose,
          ),
        /original unchanged/,
      );
      assert.throws(() =>
        requireControllerJobAuthorityConfiguration(
          { ...row.configuration, namespace: "changed" },
          source,
          phase,
          purpose,
        ),
      );
      assert.throws(() =>
        requireControllerJobAuthorityConfiguration(
          row.configuration,
          source,
          phase,
          purpose === "application" ? "catalog-publication" : "application",
        ),
      );
      const other = phase === "coordinator" ? "site-publication" : "coordinator";
      assert.throws(() =>
        requireControllerJobAuthorityConfiguration(row.configuration, source, other, purpose),
      );
      const changedGrant = admit(
        JSON.stringify({ ...row.policy, grant_sha256: "e".repeat(64) }),
        runtime,
        workflow,
        phase,
      );
      const changed = requireControllerJobAuthorityConfiguration(
        row.configuration,
        changedGrant,
        phase,
        purpose,
      );
      assert.equal(changed.configuration_sha256, view.configuration_sha256);
      assert.notEqual(digest(changed.source), digest(view.source));
      if ("journal" in row.configuration)
        assert.throws(() =>
          requireControllerJobAuthorityConfiguration(
            row.configuration.journal,
            source,
            phase,
            purpose,
          ),
        );
    }
  }
});
void test("actual application fixed-job getters retain full input and refuse cross-purpose phases before provider reads", async (t) => {
  const row = oracle.cases.find((row) => row.name === "selected-app")!;
  const actualWorkflow = await readFile(
    new URL("../.github/workflows/application-update-production.yml", import.meta.url),
  );
  const runtime = {
    ...oracle.environment,
    PORTCOVE_EXECUTION_PURPOSE: "application",
    PORTCOVE_RELEASE_AUTHORITIES: JSON.stringify(row.configuration),
    PORTCOVE_CONTROLLER_ADMISSION: JSON.stringify({
      ...row.policy,
      workflow_sha256: createHash("sha256").update(actualWorkflow).digest("hex"),
    }),
  };
  const before = { ...process.env };
  t.after(() => {
    for (const key of Object.keys(process.env)) if (!(key in before)) delete process.env[key];
    Object.assign(process.env, before);
  });
  Object.assign(process.env, runtime);
  t.mock.method(globalThis, "fetch", () => {
    throw new Error("unexpected provider read");
  });
  for (const phase of phases.filter((phase) => !phase.startsWith("catalog-"))) {
    process.env.GITHUB_JOB = releaseControlPhaseProfile(phase).reader_job;
    const view = await requireControllerApplicationJobPublicationAuthorities(phase);
    assert.equal(view.configuration_sha256, row.policy.authority_configuration_sha256);
    assert.deepEqual(
      view.publication,
      "publication" in row.configuration ? row.configuration.publication : undefined,
    );
    assert.deepEqual((await requireControllerApplicationJobAuthorities(phase)).source, view.source);
    await assert.rejects(requireControllerCatalogJobAuthorities(phase), /catalog job source/);
    const admitted = await requireControllerJobSourceConfiguration(phase);
    process.env.PORTCOVE_CONTROLLER_REVISION = "b".repeat(40);
    assert.throws(admitted.recheck, /environment changed/);
    process.env.PORTCOVE_CONTROLLER_REVISION = runtime.PORTCOVE_CONTROLLER_REVISION;
  }
  for (const phase of phases.filter((phase) => phase.startsWith("catalog-")))
    await assert.rejects(requireControllerApplicationJobAuthorities(phase), /phase differs/);
  process.env.PORTCOVE_EXECUTION_PURPOSE = "catalog-publication";
  // No catalog configuration, workflow/OIDC read or token is required to refuse.
  for (const phase of ["admission", "payload", "release-publication", "tuf-releases"])
    await assert.rejects(requireControllerCatalogJobAuthorities(phase), /phase differs/);
});
