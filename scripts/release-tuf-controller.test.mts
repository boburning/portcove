import assert from "node:assert/strict";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { performance } from "node:perf_hooks";
import { test } from "node:test";
import { isRecord } from "./runtime-values.mts";
import {
  tufRoleControllerDeadline,
  runTufRoleController,
  runFixedTufRoleConfiguration,
  requirePreparedTufRoleOutput,
} from "./release-tuf-controller.mts";
import { launchFixedTufController } from "./release-tuf-launch.mts";
import { controllerOidcSubject } from "./assembler-job-identity.mts";
import {
  tufOriginalJobDeadline,
  payloadOriginalJobDeadline,
  classificationOriginalJobDeadline,
  buildingOriginalJobDeadline,
} from "./release-signing-job-budget.mts";
import { releaseControlPhaseProfile } from "./release-control-phases.mts";
const ref = "refs/tags/portcove-production-controller-test",
  identity = {
    audience: "portcove-capacity-executor",
    subject: controllerOidcSubject(ref, "production-tuf-releases"),
    controller_revision: "a".repeat(40),
    controller_ref: ref,
    actor_id: "1234",
    run_id: "12345",
    run_attempt: 1,
  };
void test("fixed role job budget includes setup time and refuses partial, stale, duplicate or cross-role provider jobs", () => {
  const started = Date.parse("2026-10-20T00:00:00Z");
  for (const role of ["releases", "preview", "stable", "snapshot", "timestamp"] as const) {
    const job = {
      id: 501,
      run_id: Number(identity.run_id),
      run_attempt: 1,
      head_sha: identity.controller_revision,
      status: "in_progress",
      started_at: new Date(started).toISOString(),
      name: releaseControlPhaseProfile(`tuf-${role}`).reader_name,
    };
    const inventory = { total_count: 1, jobs: [job] };
    assert.equal(tufOriginalJobDeadline(role, inventory, identity, started + 35000, 1000), 81000);
    for (const bad of [
      { ...inventory, total_count: 2 },
      { total_count: 2, jobs: [job, job] },
      { total_count: 2, jobs: [job, { ...job, id: 502 }] },
      { total_count: 1, jobs: [{ ...job, run_attempt: 2 }] },
      { total_count: 1, jobs: [{ ...job, head_sha: "b".repeat(40) }] },
      { total_count: 1, jobs: [{ ...job, run_id: 777 }] },
      { total_count: 1, jobs: [{ ...job, name: "caller-selected signer" }] },
      { total_count: 1, jobs: [{ ...job, status: "completed" }] },
    ])
      assert.throws(() => tufOriginalJobDeadline(role, bad, identity, started + 35000, 1000));
    for (const time of [started - 1, started + 115000])
      assert.throws(() => tufOriginalJobDeadline(role, inventory, identity, time, 1000), /budget/);
  }
  assert.throws(() => tufOriginalJobDeadline("root", {}, identity), /role/);
});
void test("payload fixed job budget counts earlier tools/setup and keeps the original ten-minute cleanup reserve", () => {
  const started = Date.parse("2026-10-20T00:00:00Z");
  const job = {
    id: 501,
    run_id: Number(identity.run_id),
    run_attempt: 1,
    head_sha: identity.controller_revision,
    status: "in_progress",
    started_at: new Date(started).toISOString(),
    name: releaseControlPhaseProfile("payload").reader_name,
  };
  const inventory = { total_count: 1, jobs: [job] };
  assert.equal(payloadOriginalJobDeadline(inventory, identity, started + 120000, 1000), 451000);
  for (const now of [started - 1, started + 570000])
    assert.throws(() => payloadOriginalJobDeadline(inventory, identity, now, 1000), /budget/);
  assert.throws(
    () =>
      payloadOriginalJobDeadline(
        {
          ...inventory,
          jobs: [{ ...job, name: releaseControlPhaseProfile("tuf-releases").reader_name }],
        },
        identity,
        started + 1000,
        1000,
      ),
    /start/,
  );
});
void test("fixed TUF phase only tightens a live original deadline and keeps selected two-minute cleanup reserve", () => {
  const now = performance.now();
  assert.ok(tufRoleControllerDeadline() < now + 115010);
  const deadline = now + 1000;
  assert.equal(tufRoleControllerDeadline(deadline), deadline);
  assert.ok(tufRoleControllerDeadline(now + 500000) < now + 115010);
  for (const bad of [Infinity, NaN, now - 1])
    assert.throws(() => tufRoleControllerDeadline(bad), /deadline/u);
});
void test("role callable refuses imported tools/output and wrong dependencies before any role key or output", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "tuf-controller-import-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await assert.rejects(
    runTufRoleController("releases", identity, {}, {}, [], root),
    /actual same-process/u,
  );
  await assert.rejects(
    runTufRoleController("snapshot", identity, {}, {}, [], root),
    /dependencies/u,
  );
  await assert.rejects(
    requirePreparedTufRoleOutput({ decision: "role-output-prepared" }),
    /actual TUF/u,
  );
  assert.deepEqual(await readdir(root), []);
});
void test("fixed source entry/launcher reject arbitrary commands, offline roles and expired phases before provider effects", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "tuf-controller-fields-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const input = {
    role: "releases",
    identity,
    tools: { artifact: {}, bundle: {} },
    context: {},
    dependencies: [],
  };
  for (const raw of [
    { ...input, command: "candidate.sh" },
    { ...input, role: "root" },
    { ...input, role: "targets" },
  ]) {
    await assert.rejects(runFixedTufRoleConfiguration(raw, root));
    await assert.rejects(launchFixedTufController(raw, root));
  }
  await assert.rejects(launchFixedTufController(input, root, performance.now() - 1), /deadline/u);
  await assert.rejects(
    runFixedTufRoleConfiguration(input, root, performance.now() - 1),
    /deadline/u,
  );
  assert.deepEqual(await readdir(root), []);
});

void test("classification original job clocks keep their own names, first attempt and two-minute reserve", () => {
  const started = Date.parse("2026-10-20T00:00:00Z");
  for (const [role, name] of [
    ["writer", "Persist independently reviewed classification"],
    ["observer", "Observe release input protections"],
  ] as const) {
    const job = {
      id: 501,
      run_id: Number(identity.run_id),
      run_attempt: 1,
      head_sha: identity.controller_revision,
      status: "in_progress",
      started_at: new Date(started).toISOString(),
      name,
    };
    const inventory = { total_count: 1, jobs: [job] };
    assert.equal(
      classificationOriginalJobDeadline(role, inventory, identity, started + 35000, 1000),
      81000,
    );
    for (const changed of [
      { name: "caller job" },
      { run_attempt: 2 },
      { head_sha: "b".repeat(40) },
      { started_at: new Date(started + 36000).toISOString() },
    ])
      assert.throws(() =>
        classificationOriginalJobDeadline(
          role,
          { ...inventory, jobs: [{ ...job, ...changed }] },
          identity,
          started + 35000,
          1000,
        ),
      );
    assert.throws(() =>
      classificationOriginalJobDeadline(role, inventory, identity, started + 115000, 1000),
    );
    assert.throws(() =>
      classificationOriginalJobDeadline(
        role,
        { ...inventory, total_count: 2 },
        identity,
        started + 35000,
        1000,
      ),
    );
    assert.throws(() => tufOriginalJobDeadline(`classification-${role}`, inventory, identity));
  }
});

void test("building admission original clock includes tools/acquisition and reserves cleanup inside the proposed nine minutes", () => {
  const started = Date.parse("2026-10-20T00:00:00Z");
  const job = {
    id: 501,
    run_id: Number(identity.run_id),
    run_attempt: 1,
    head_sha: identity.controller_revision,
    status: "in_progress",
    started_at: new Date(started).toISOString(),
    name: "Authenticate release control inputs",
  };
  assert.equal(
    buildingOriginalJobDeadline({ total_count: 1, jobs: [job] }, identity, started + 100000, 1000),
    426000,
  );
  for (const bad of [
    { ...job, name: "Sign admitted updater payloads" },
    { ...job, run_attempt: 2 },
    { ...job, head_sha: "b".repeat(40) },
  ])
    assert.throws(() =>
      buildingOriginalJobDeadline(
        { total_count: 1, jobs: [bad] },
        identity,
        started + 100000,
        1000,
      ),
    );
  assert.throws(() =>
    buildingOriginalJobDeadline({ total_count: 1, jobs: [job] }, identity, started + 525000, 1000),
  );
  assert.throws(() =>
    tufOriginalJobDeadline("candidate-building", { total_count: 1, jobs: [job] }, identity),
  );
});

void test("closed fixed DAG serialization cannot substitute arbitrary tool, context, role or publication producers", async () => {
  const { prepareFixedControllerConfiguration } =
    await import("./release-controller-configuration.mts");
  const fixed = {
    controller_revision: "a".repeat(40),
    source_tree: "b".repeat(40),
    controller_ref: ref,
    actor_id: "1234",
    run_id: "12345",
    run_attempt: 1,
  };
  const { actor_id: _actor, ...producer } = fixed;
  const artifact = (id: number) => ({ id, sha256: "c".repeat(64) });
  const context = {
    ...producer,
    artifact: artifact(3),
    bundle: artifact(4),
    manifest_sha256: "d".repeat(64),
    binding_sha256: "e".repeat(64),
    facts_sha256: "f".repeat(64),
  };
  const out = (outputs: Record<string, unknown>) => ({ result: "success", outputs });
  const roles = ["releases", "preview", "stable", "snapshot", "timestamp"];
  const needs: Record<string, { result: string; outputs: Record<string, unknown> }> = {
    tool_bootstrap: out({
      artifact_id: "1",
      artifact_sha256: "c".repeat(64),
      source_tree: fixed.source_tree,
    }),
    tool_attest: out({ bundle_artifact_id: "2", bundle_artifact_sha256: "c".repeat(64) }),
    coordinator: out({ mode: "metadata", context_locator: JSON.stringify(context) }),
    ...Object.fromEntries(
      roles.map((role, index) => [
        `tuf_${role}`,
        out({
          role_locator: JSON.stringify({
            role,
            controller: producer,
            artifact: artifact(5 + index * 2),
            bundle: artifact(6 + index * 2),
            context_manifest_sha256: context.manifest_sha256,
            context_binding_sha256: context.binding_sha256,
            context_facts_sha256: context.facts_sha256,
          }),
        }),
      ]),
    ),
  };
  const input = {
    operation: "tuf-snapshot",
    fixed,
    needs,
    admission_configuration: { schema_version: 3, namespace: "portcove-production" },
  };
  const selected = prepareFixedControllerConfiguration(input);
  assert.equal("role" in selected && selected.role, "snapshot");
  assert.equal("dependencies" in selected && selected.dependencies.length, 3);
  assert.equal("context_kind" in selected && selected.context_kind, "metadata-signing-context");
  for (const changed of [
    { ...input, operation: "root" },
    { ...input, fixed: { ...fixed, run_attempt: 2 } },
    {
      ...input,
      needs: {
        ...needs,
        tool_bootstrap: out({ ...needs.tool_bootstrap!.outputs, source_tree: "0".repeat(40) }),
      },
    },
    { ...input, needs: { ...needs, tool_attest: { ...needs.tool_attest!, result: "failure" } } },
    {
      ...input,
      needs: {
        ...needs,
        coordinator: out({
          mode: "metadata",
          context_locator: JSON.stringify({ ...context, controller_revision: "0".repeat(40) }),
        }),
      },
    },
    {
      ...input,
      needs: {
        ...needs,
        tuf_stable: out({ role_locator: needs.tuf_preview!.outputs.role_locator }),
      },
    },
    { ...input, operation: "release-publication" },
  ])
    assert.throws(() => prepareFixedControllerConfiguration(changed));
  const coordinator = prepareFixedControllerConfiguration({ ...input, operation: "coordinator" });
  assert.equal(
    "remote_configuration" in coordinator && coordinator.remote_configuration.namespace,
    "portcove-production",
  );
  assert.equal("identity" in coordinator, false);
  const { projectFixedControllerJobOutputs } = await import("./release-controller-job-output.mts");
  const oldContext = { ...context, run_id: "12344" };
  const retainedRoles = roles.map((role, index) => ({
    role,
    controller: { ...producer, run_id: "12344" },
    artifact: artifact(5 + index * 2),
    bundle: artifact(6 + index * 2),
    context_manifest_sha256: context.manifest_sha256,
    context_binding_sha256: context.binding_sha256,
    context_facts_sha256: context.facts_sha256,
  }));
  const reused = projectFixedControllerJobOutputs("coordinator", {
    decision: "candidate-signing-custody-reused",
    candidate_phase: "publishing",
    context_locator: oldContext,
    role_locators: retainedRoles,
  });
  const resumedInput = {
    ...input,
    native_locators: null,
    operation: "release-publication",
    needs: {
      ...needs,
      coordinator: out(reused),
      independent_admission: out({ artifact_id: "21", artifact_sha256: "a".repeat(64) }),
      attest: out({ bundle_artifact_id: "22", bundle_artifact_sha256: "b".repeat(64) }),
      payload_signing: { result: "skipped", outputs: {} },
      ...Object.fromEntries(
        roles.map((role) => [`tuf_${role}`, { result: "skipped", outputs: {} }]),
      ),
    },
  };
  const resumed = prepareFixedControllerConfiguration(resumedInput);
  assert.ok(
    "context" in resumed &&
      "roles" in resumed &&
      "configuration" in resumed &&
      isRecord(resumed.configuration) &&
      isRecord(resumed.configuration.aggregate),
  );
  assert.equal(resumed.context.run_id, "12344");
  assert.deepEqual(
    resumed.roles.map((role) => role.controller.run_id),
    roles.map(() => "12344"),
  );
  assert.equal(resumed.configuration.aggregate.run_id, fixed.run_id);
  const repairOutputs = projectFixedControllerJobOutputs("coordinator", {
    decision: "candidate-signing-custody-reused",
    candidate_phase: "qualifying",
    report_only_repair: true,
    report_repair_sha256: "9".repeat(64),
    context_locator: oldContext,
    role_locators: retainedRoles,
  });
  const repairInput = {
    ...resumedInput,
    needs: { ...resumedInput.needs, coordinator: out(repairOutputs) },
  };
  const repair = prepareFixedControllerConfiguration(repairInput);
  assert.ok("context" in repair && "roles" in repair);
  assert.equal(repair.context.run_id, "12344");
  assert.deepEqual(repair.roles, resumed.roles);
  const originalPublication = {
    controller_revision: fixed.controller_revision,
    source_tree: fixed.source_tree,
    controller_ref: fixed.controller_ref,
    run_id: "12343",
    run_attempt: 1,
    artifact: artifact(30),
    bundle: artifact(31),
    report_sha256: "8".repeat(64),
  };
  const publishedOutputs = projectFixedControllerJobOutputs("coordinator", {
    decision: "candidate-signing-custody-reused",
    candidate_phase: "promoting",
    context_locator: oldContext,
    role_locators: retainedRoles,
    publication_result_locator: originalPublication,
  });
  const publishedInput = {
    ...resumedInput,
    operation: "site-publication",
    needs: {
      ...resumedInput.needs,
      coordinator: out(publishedOutputs),
      release_publication: { result: "skipped", outputs: {} },
    },
  };
  const site = prepareFixedControllerConfiguration(publishedInput);
  assert.ok("publication_result" in site);
  assert.deepEqual(site.publication_result, originalPublication);
  for (const operation of ["building", "payload", "tuf-releases", "release-publication"])
    assert.throws(() => prepareFixedControllerConfiguration({ ...publishedInput, operation }));
  for (const operation of ["payload", "tuf-releases", "tuf-timestamp"])
    assert.throws(() => prepareFixedControllerConfiguration({ ...repairInput, operation }));
  assert.deepEqual(
    projectFixedControllerJobOutputs("coordinator", {
      decision: "report-repair-dispatched",
      report_only_repair: true,
      report_repair_sha256: "9".repeat(64),
      dispatch_run: { run_id: 1111, attempt: 1, revision: "a".repeat(40) },
      release_run: { run_id: 999, attempt: 1, revision: "a".repeat(40) },
    }),
    { mode: "held", stage: "held" },
  );
  for (const operation of ["payload", "tuf-releases", "tuf-timestamp"])
    assert.throws(() => prepareFixedControllerConfiguration({ ...resumedInput, operation }));
  for (const changed of [
    { ...reused, stage: "building" },
    { ...reused, role_locators: JSON.stringify(retainedRoles.slice(1)) },
    {
      ...reused,
      role_locators: JSON.stringify(
        retainedRoles.map((role, index) =>
          index === 0 ? { ...role, context_binding_sha256: "0".repeat(64) } : role,
        ),
      ),
    },
    {
      ...reused,
      context_locator: JSON.stringify({ ...oldContext, controller_revision: "0".repeat(40) }),
    },
  ])
    assert.throws(() =>
      prepareFixedControllerConfiguration({
        ...resumedInput,
        needs: { ...resumedInput.needs, coordinator: out(changed) },
      }),
    );
});

void test("fixed job adapter and source bootstrap refuse unknown operations without output", async (t) => {
  const { configureFixedControllerJob, runFixedControllerJob } =
    await import("./release-controller-job.mts");
  const { launchFixedControllerJob } = await import("./release-controller-job-bootstrap.mts");
  const root = await mkdtemp(path.join(os.tmpdir(), "fixed-controller-entry-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await assert.rejects(
    configureFixedControllerJob("arbitrary-entry"),
    /fixed complete-controller job/,
  );
  await assert.rejects(runFixedControllerJob("root"), /fixed complete-controller job/);
  for (const value of ["root", {}, { entry: "candidate.mjs" }])
    await assert.rejects(launchFixedControllerJob(value), /fixed complete controller operation/);
  assert.deepEqual(await readdir(root), []);
});

void test("same-job aggregate outputs carry exact original custody to the maintained payload locator", async () => {
  const { projectFixedControllerJobOutputs } = await import("./release-controller-job-output.mts");
  const { prepareFixedControllerConfiguration } =
    await import("./release-controller-configuration.mts");
  const fixed = {
    controller_revision: identity.controller_revision,
    controller_ref: ref,
    source_tree: "b".repeat(40),
    run_id: identity.run_id,
    run_attempt: 1,
    actor_id: identity.actor_id,
  };
  const out = (outputs: Record<string, string>) => ({ result: "success", outputs });
  const artifact = { id: 77, sha256: "c".repeat(64) };
  const original = {
    actor_id: identity.actor_id,
    before_checkpoint: "d".repeat(40),
    check_run_id: "78",
    controller_revision: identity.controller_revision,
    execution_ref: ref,
    expectation_sha256: "e".repeat(64),
    job_id: 79,
    operation_id: "f".repeat(64),
    run_attempt: 1,
    run_id: "12344",
    workflow: ".github/workflows/application-update-production.yml",
  };
  for (const [resumed, hosted] of [
    [false, false],
    [true, false],
    [false, true],
    [true, true],
  ]) {
    const nativeCustody = {
      checkpoint: original.before_checkpoint,
      native_bundle_sha256: "9".repeat(64),
      native_bundle_bytes: 12345,
    };
    const name = `trusted-release-final-${resumed ? original.run_id : fixed.run_id}-1`;
    const predicate = {
      role: "package-aggregate-assembler",
      evidence_scope: "github.com",
      artifact: { ...artifact, name },
      producer_profile: resumed ? "admitted-aggregate-recovery-v1" : "admitted-aggregate-v1",
      ...(resumed ? { original_upload: original } : {}),
      ...(hosted ? { native_custody: nativeCustody } : {}),
    };
    const result = {
      decision: resumed
        ? "candidate-aggregate-readback-prepared"
        : "candidate-building-and-aggregate-prepared",
      stage: resumed ? "publishing" : "building",
      descriptor: { checkpoint: "d".repeat(40) },
      artifact,
      subject_name: name,
      subject_digest: `sha256:${artifact.sha256}`,
      predicate_type: "https://portcove.dev/attestations/package-aggregate/v1",
      ...(resumed ? { original_upload: original } : {}),
      ...(hosted ? { native_custody: nativeCustody } : {}),
    };
    const outputs = projectFixedControllerJobOutputs(
      "building",
      result,
      undefined,
      Buffer.from(JSON.stringify(predicate)),
    );
    const selected = prepareFixedControllerConfiguration({
      operation: "payload",
      fixed,
      admission_configuration: { namespace: "portcove-production" },
      native_locators: null,
      payload_public_key_sha256: "1".repeat(64),
      needs: {
        tool_bootstrap: out({
          artifact_id: "1",
          artifact_sha256: "2".repeat(64),
          source_tree: fixed.source_tree,
        }),
        tool_attest: out({ bundle_artifact_id: "2", bundle_artifact_sha256: "3".repeat(64) }),
        coordinator: out({ mode: "release", stage: "building" }),
        independent_admission: out(outputs),
        attest: out({ bundle_artifact_id: "88", bundle_artifact_sha256: "4".repeat(64) }),
      },
    });
    assert.ok(
      "configuration" in selected &&
        isRecord(selected.configuration) &&
        isRecord(selected.configuration.aggregate),
    );
    assert.equal(selected.configuration.aggregate.artifact_id, artifact.id);
    assert.deepEqual(
      selected.configuration.aggregate.original_upload,
      resumed ? original : undefined,
    );
    assert.equal(outputs.stage, result.stage);
    assert.deepEqual(
      selected.configuration.aggregate.native_custody,
      hosted ? nativeCustody : undefined,
    );
    assert.equal(outputs.native_custody, hosted ? JSON.stringify(nativeCustody) : undefined);
    for (const changed of [
      { ...predicate, evidence_scope: "injected-provider" },
      { ...predicate, artifact: { ...artifact, id: 99, name } },
      { ...predicate, producer_profile: "legacy" },
      {
        ...predicate,
        native_custody: hosted ? { ...nativeCustody, checkpoint: "8".repeat(40) } : nativeCustody,
      },
    ])
      assert.throws(() =>
        projectFixedControllerJobOutputs(
          "building",
          result,
          undefined,
          Buffer.from(JSON.stringify(changed)),
        ),
      );
    assert.throws(() => projectFixedControllerJobOutputs("building", result));
  }
});

void test("complete job bootstrap refuses inherited cross-role credentials before tool acquisition", async () => {
  const { assertControllerBootstrapEnvironment } =
    await import("./release-controller-job-bootstrap.mts");
  assert.doesNotThrow(() =>
    assertControllerBootstrapEnvironment({ GH_TOKEN: "ordinary-fixed-job-token" }),
  );
  for (const key of [
    "NODE_OPTIONS",
    "NODE_PATH",
    "PORTCOVE_CONTROL_APP_TOKEN",
    "PORTCOVE_ROLE_KEY",
    "PORTCOVE_ROLE_PASSWORD",
    "TAURI_SIGNING_PRIVATE_KEY",
    "TAURI_SIGNING_PRIVATE_KEY_PASSWORD",
    "PORTCOVE_TUF_RELEASES_KEY",
    "PORTCOVE_PROTECTION_APP_KEY",
    "PORTCOVE_DISPATCH_APP_PRIVATE_KEY",
  ])
    assert.throws(
      () => assertControllerBootstrapEnvironment({ [key]: "inert-fixture" }),
      /forbids inherited/,
    );
});

void test("actual result routing keeps context, role and immutable-result attestation paths distinct", async () => {
  const { fixedControllerResultAttestation } = await import("./release-controller-job.mts");
  const directory = path.resolve(os.tmpdir(), "fixed-result-routing"),
    context = "https://portcove.dev/attestations/release-signing-context/v1";
  assert.equal(fixedControllerResultAttestation("coordinator", { decision: "held" }), null);
  assert.equal(
    fixedControllerResultAttestation("coordinator", {
      decision: "metadata-context-prepared",
      attestation_required: false,
    }),
    null,
  );
  assert.equal(
    fixedControllerResultAttestation("building", { decision: "candidate-building-admitted" }),
    null,
  );
  const payload = fixedControllerResultAttestation("payload", {
    context_upload: { directory, attestation: "pending" },
  });
  assert.equal(payload?.predicate_type, context);
  assert.equal(payload?.subject_path, path.join(directory, "signing-context-manifest.json"));
  const publication = fixedControllerResultAttestation("release-publication", {
    artifact: { directory, attestation: "pending" },
  });
  assert.equal(
    publication?.subject_path,
    path.join(directory, "upload", "immutable-release-result.json"),
  );
  assert.equal(
    publication?.predicate_type,
    "https://portcove.dev/attestations/immutable-release-result/v1",
  );
  assert.throws(
    () =>
      fixedControllerResultAttestation("coordinator", {
        decision: "metadata-context-prepared",
        subject_path: "copied-report",
      }),
    /paths unavailable/,
  );
  assert.throws(
    () =>
      fixedControllerResultAttestation("tuf-releases", {
        decision: "role-output-prepared",
        subject_path: "copied-report",
        predicate_path: "copied-predicate",
        predicate_type: context,
      }),
    /paths unavailable/,
  );
});

void test("final role output projects the retained producer result into the maintained next-role consumer", async () => {
  const { projectFixedControllerJobOutputs } = await import("./release-controller-job-output.mts"),
    { inspectTufRoleArtifactExpected } = await import("./release-tuf-role-artifact.mts"),
    { createHash } = await import("node:crypto");
  const controller = {
      controller_revision: identity.controller_revision,
      source_tree: "b".repeat(40),
      controller_ref: ref,
      run_id: identity.run_id,
      run_attempt: 1,
    },
    subject = Buffer.from("retained signing-output manifest bytes"),
    sha = createHash("sha256").update(subject).digest("hex"),
    result = {
      decision: "role-output-prepared",
      subject_digest: sha,
      artifact: { id: 11, bytes: 100, sha256: "c".repeat(64), name: "provider-owned-output" },
    },
    custody = {
      subject,
      predicate: Buffer.from(
        JSON.stringify({
          role: "tuf-releases",
          controller,
          context_manifest_sha256: "d".repeat(64),
          context_binding_sha256: "e".repeat(64),
          context_facts_sha256: "f".repeat(64),
        }),
      ),
      bundle: { artifact_id: 12, sha256: "a".repeat(64) },
    };
  const outputs = projectFixedControllerJobOutputs("tuf-releases", result, custody),
    received = inspectTufRoleArtifactExpected(JSON.parse(outputs.role_locator!));
  assert.equal(received.role, "releases");
  assert.deepEqual(received.artifact, { id: 11, sha256: "c".repeat(64) });
  assert.deepEqual(received.bundle, { id: 12, sha256: "a".repeat(64) });
  assert.deepEqual(received.controller, controller);
  assert.throws(
    () => projectFixedControllerJobOutputs("tuf-releases", result),
    /custody unavailable/,
  );
  assert.throws(
    () =>
      projectFixedControllerJobOutputs("tuf-releases", result, {
        ...custody,
        subject: Buffer.from("changed"),
      }),
    /subject differs/,
  );
  assert.throws(
    () => projectFixedControllerJobOutputs("tuf-preview", result, custody),
    /subject differs/,
  );
  assert.deepEqual(
    projectFixedControllerJobOutputs("coordinator", { decision: "held", holds: ["unrelated"] }),
    { mode: "held", stage: "held" },
  );
  assert.deepEqual(
    projectFixedControllerJobOutputs("coordinator", {
      decision: "resume-existing",
      active_candidate: { phase: "building" },
    }),
    { mode: "release", stage: "building" },
  );
});

void test("actual TUF pre-key guard checks controls last after slow reservation read", async () => {
  const { readFile } = await import("node:fs/promises");
  const { stripTypeScriptTypes } = await import("node:module");
  const { runInNewContext } = await import("node:vm");
  const source = await readFile(new URL("./release-tuf-controller.mts", import.meta.url), "utf8");
  const start = source.indexOf("const guard = async () => {"),
    end = source.indexOf("\n    await guard();", start);
  assert(start > 0 && end > start);
  let clock = 59000,
    keys = 0;
  const controls: number[] = [];
  const guard = runInNewContext(stripTypeScriptTypes(source.slice(start, end)) + "\nguard", {
    active: () => {
      if (clock >= 115000) throw new Error("original job exhausted");
    },
    verifiedControllerToolPaths: async () => {},
    requireRetainedSigningContext: async () => {},
    requireRetainedTufRoleArtifact: async () => {},
    toolsReceipt: {},
    contextReceipt: {},
    capturedDependencies: [],
    directory: "inert",
    coordinator: {},
    deadline: 115000,
    readRemoteCoordinatorSnapshot: async () => {
      clock = 61000;
      return {};
    },
    reservation: async () => {},
    fresh: async () => {
      controls.push(clock);
      if (clock >= 60000) throw new Error("original controls expired");
    },
  }) as () => Promise<void>;
  await assert.rejects(
    (async () => {
      await guard();
      keys++;
    })(),
    /original controls expired/,
  );
  assert.deepEqual(controls, [61000]);
  assert.equal(keys, 0);
});
