import assert from "node:assert/strict";
import { inspectRetainedRecoveryHistory } from "./upstream-release-recovery.mts";
import test from "node:test";
import { readFileSync } from "node:fs";
import { parse } from "yaml";
import {
  inspectRehearsalDraftReadback,
  inspectRehearsalFeed,
  inspectRehearsalManifest,
  inspectRehearsalReleaseReadback,
  rehearsalVersions,
  rehearsalPackageConfiguration,
} from "./upstream-release-rehearsal.mts";
import {
  rehearsalConcurrency,
  rehearsalExecution,
  rehearsalExecutionRef,
  rehearsalOrigin,
  rehearsalPublicBase,
  retainedRehearsal,
  retainedRecovery,
  retainedDiagnostic,
} from "./upstream-release-identity.mts";
import {
  recoveryJobMinutes,
  inspectRehearsalBudget,
  inspectRehearsalProtection,
} from "./upstream-release-runtime.mts";
import { inspectRehearsalArtifact, rehearsalTransferFiles } from "./upstream-release-transfer.mts";
import { inspectRehearsalAcceptance } from "./upstream-release-acceptance.mts";
import {
  rehearsalFeedTransition,
  hasPriorRehearsalInterruption,
} from "./upstream-release-pages.mts";

const expected = { source: "a".repeat(40), run_id: "12345", run_attempt: 2 };

void test("native retry copies are charged once only with matching prior execution and attempt context", () => {
  const at = (minutes: number) =>
    new Date(Date.parse("2026-11-04T00:00:00Z") + minutes * 60000).toISOString();
  const job = (
    name: string,
    start: number,
    duration: number,
    runner: number,
    conclusion = "success",
  ) => ({
    id: runner,
    run_id: 555,
    run_attempt: 1,
    name,
    head_sha: expected.source,
    head_branch: "fixture",
    status: "completed",
    conclusion,
    runner_id: runner,
    runner_name: `fixture ${runner}`,
    runner_group_id: 0,
    labels: ["fixture"],
    workflow_name: "fixture /1",
    started_at: at(start),
    completed_at: at(start + duration),
    steps: [
      {
        number: 1,
        name: "fixture work",
        status: "completed",
        conclusion,
        started_at: at(start),
        completed_at: at(start + duration),
      },
    ],
  });
  const original = [job("package", 0, 30, 11), job("installed", 31, 35, 12)];
  // Actual GitHub retry shape: new IDs/attempt/display metadata, same execution.
  const copies = original.map((value) => ({
    ...structuredClone(value),
    id: value.id + 100,
    run_attempt: 2,
    workflow_name: "fixture /2",
    runner_group_id: null,
  }));
  const first = { total_count: 3, jobs: [...original, job("feed", 67, 1, 13, "failure")] };
  const second = {
    total_count: 3,
    jobs: [...copies, { ...job("feed", 80, 0.25, 14, "failure"), run_attempt: 2 }],
  };
  const contexts = [1, 2].map((attempt) => ({
    id: 555,
    run_attempt: attempt,
    head_sha: expected.source,
    run_started_at: at(attempt === 1 ? 0 : 80),
    path: ".github/workflows/upstream-release-rehearsal.yml",
    event: "workflow_dispatch",
  }));
  const result = inspectRehearsalBudget("feed", [first, second], contexts);
  assert.equal(result.observed_milliseconds, 66.25 * 60000);
  assert.equal(result.remaining_declared_minutes, 25);
  assert.throws(() => inspectRehearsalBudget("feed", [first, second]), /application140/u);
  for (const changed of [
    copies.map((value) => ({ ...value, runner_id: value.runner_id + 200 })),
    copies.map((value) => ({ ...value, steps: [{ ...value.steps[0]!, name: "different work" }] })),
    original.map((value, index) => ({
      ...job(value.name, 80 + index * 31, index ? 35 : 30, value.runner_id),
      run_attempt: 2,
    })),
    copies.map((value) => ({ ...value, conclusion: "cancelled" })),
  ])
    assert.throws(() =>
      inspectRehearsalBudget(
        "feed",
        [first, { ...second, jobs: [...changed, second.jobs[2]!] }],
        contexts,
      ),
    );
  assert.throws(() => inspectRehearsalBudget("feed", [first, second], [contexts[0]!]));
});
function fixture() {
  return {
    ...expected,
    scope: "disposable-nonproduction",
    version: rehearsalVersions(expected).candidate,
    files: [
      `Portcove_${rehearsalVersions(expected).candidate}_x64-setup.exe`,
      "fixture.patch",
      "windows-compatibility.json",
      `portcove-cli-${rehearsalVersions(expected).candidate}-windows-x86_64.zip`,
    ].map((name) => ({ name, bytes: 10, sha256: "b".repeat(64) })),
  };
}
void test("transferred manifest refuses source/attempt/scope drift and ambiguous asset sets", () => {
  assert.equal(inspectRehearsalManifest(fixture(), expected).files.length, 4);
  for (const delta of [
    { source: "c".repeat(40) },
    { run_id: "12346" },
    { run_attempt: 1 },
    { scope: "production" },
    { version: "0.2.0" },
    { unexpected: true },
    { files: [] },
    { files: [...fixture().files, ...fixture().files, ...fixture().files] },
    { files: [{ ...fixture().files[0], name: "../payload.exe" }] },
    { files: [{ ...fixture().files[0], bytes: 257 * 1024 ** 2 }] },
    { files: [{ ...fixture().files[0], sha256: "x".repeat(64) }] },
  ])
    assert.throws(() => inspectRehearsalManifest({ ...fixture(), ...delta }, expected));
});
void test("native workflow preserves credential separation, exact producer identities and cumulative bounds", () => {
  const text = readFileSync(
    new URL("../.github/workflows/upstream-release-rehearsal.yml", import.meta.url),
    "utf8",
  );
  type Step = { uses?: string; run?: string; with?: Record<string, unknown> };
  type Job = {
    "runs-on": string;
    "timeout-minutes": number;
    "continue-on-error"?: boolean;
    permissions?: Record<string, string>;
    needs?: string[];
    env?: Record<string, string>;
    steps: Step[];
  };
  const workflow = parse(text) as {
    on: Record<string, unknown>;
    permissions: Record<string, string>;
    concurrency: { group: string; "cancel-in-progress": boolean };
    jobs: Record<string, Job>;
  };
  assert.deepEqual(Object.keys(workflow.on), ["workflow_dispatch"]);
  assert.equal(workflow.permissions.contents, "read");
  assert.equal(workflow.concurrency.group, rehearsalConcurrency);
  assert.equal(workflow.concurrency["cancel-in-progress"], false);
  assert.deepEqual(Object.keys(workflow.jobs), Object.keys(recoveryJobMinutes));
  for (const [name, job] of Object.entries(workflow.jobs)) {
    assert.equal(
      job["timeout-minutes"],
      recoveryJobMinutes[name as keyof typeof recoveryJobMinutes],
    );
    assert.ok(["windows-2025", "ubuntu-22.04"].includes(job["runs-on"]));
    assert.equal(job["continue-on-error"], undefined);
    assert.notEqual(job.permissions?.contents, "write");
    assert.notEqual(job.permissions?.pages, "write");
    if (name !== "readback") {
      assert.notEqual(job.permissions?.["id-token"], "write");
      assert.notEqual(job.permissions?.attestations, "write");
    }
    for (const step of job.steps) {
      assert.doesNotMatch(step.uses ?? "", /cache/u);
      if (step.uses?.includes("/checkout@")) {
        assert.equal(step.with!.ref, "${{ github.sha }}");
        assert.equal(step.with!["persist-credentials"], false);
      }
      if (step.uses?.includes("/setup-node@"))
        assert.equal(step.with!["package-manager-cache"], false);
    }
  }
  assert.equal(
    Object.values(recoveryJobMinutes).reduce((sum, minutes) => sum + minutes, 0),
    23,
  );
  assert.ok(text.includes(rehearsalExecutionRef));
  assert.doesNotMatch(
    text,
    /secrets\.|self-hosted|--clobber|continue-on-error|tauri build|prepare-candidate|prepare-predecessor|prepare-public-predecessor|publication.mts publish|Inject controlled/u,
  );
  assert.deepEqual(workflow.jobs.public_installed!.needs, ["recovery"]);
  assert.deepEqual(workflow.jobs.readback!.needs, ["recovery", "public_installed"]);
  assert.equal(workflow.jobs.feed, undefined);
  const diagnostics = workflow.jobs.public_installed!.steps.find(
    (step) =>
      typeof step.with?.name === "string" &&
      step.with.name.startsWith("upstream-public-installed-proof-"),
  );
  assert.ok(diagnostics && diagnostics.with);
  for (const extension of ["json", "png", "log", "html"])
    assert.ok(
      String(diagnostics.with.path).includes(
        `work/upstream-public-installed-evidence/lifecycle/run-*/renderer-qualification/evidence/*.${extension}`,
      ),
    );
  for (const id of [
    retainedRehearsal.signed_artifact,
    retainedRehearsal.acceptance_artifact,
    retainedRehearsal.candidate_artifact,
    retainedRehearsal.predecessor_artifact,
  ])
    assert.ok(text.includes(String(id)));
  assert.ok(
    workflow.jobs.recovery!.steps.every(
      (step) => !/cargo |pnpm install|\.exe\s/u.test(step.run ?? ""),
    ),
  );

  assert.deepEqual(rehearsalPackageConfiguration(), {
    bundle: { createUpdaterArtifacts: false, windows: { nsis: { installMode: "currentUser" } } },
  });
});

void test("public feed transfer refuses traversal, links-by-shape, duplicates and excessive data before writes", () => {
  const valid = [
    { path: "metadata/1.root.json", text: "{}" },
    { path: "targets/abc.releases/0.0.0/record.json", text: "{}" },
  ];
  assert.deepEqual(inspectRehearsalFeed(valid), valid);
  for (const value of [
    [],
    [...valid, valid[0]],
    [{ path: "metadata/../key", text: "{}" }],
    [{ path: "/metadata/root.json", text: "{}" }],
    [{ path: "private/key", text: "{}" }],
    [{ path: "metadata/root.json", text: "x".repeat(2 * 1024 ** 2 + 1) }],
    [{ path: "metadata/root.json", text: "{}", link: "../private" }],
  ])
    assert.throws(() => inspectRehearsalFeed(value));
});

void test("final draft proof observes publication/tag/asset drift instead of asserting draft status", () => {
  const files = fixture().files;
  const tag = `v${fixture().version}`;
  const expectedDraft = { id: 42, tag, source: expected.source, files };
  const release = {
    id: 42,
    tag_name: tag,
    target_commitish: expected.source,
    draft: true,
    immutable: false,
    published_at: null,
    prerelease: true,
  };
  const ref = { ref: `refs/tags/${tag}`, object: { type: "commit", sha: expected.source } };
  const assets = files.map((f) => ({ name: f.name, size: f.bytes, digest: `sha256:${f.sha256}` }));
  assert.equal(inspectRehearsalDraftReadback(release, ref, assets, expectedDraft).draft, true);
  for (const delta of [
    { draft: false },
    { prerelease: false },
    { id: 43 },
    { tag_name: "wrong" },
    { target_commitish: "c".repeat(40) },
  ])
    assert.throws(() =>
      inspectRehearsalDraftReadback({ ...release, ...delta }, ref, assets, expectedDraft),
    );
  assert.throws(() =>
    inspectRehearsalDraftReadback(
      release,
      { ...ref, object: { type: "commit", sha: "c".repeat(40) } },
      assets,
      expectedDraft,
    ),
  );
  for (const changed of [
    assets.slice(1),
    [...assets, assets[0]],
    assets.map((a) => ({ ...a, digest: "sha256:" + "c".repeat(64) })),
  ])
    assert.throws(() => inspectRehearsalDraftReadback(release, ref, changed, expectedDraft));
});

function signedFixture() {
  return {
    ...expected,
    signer_attempt: expected.run_attempt,
    scope: "disposable-nonproduction",
    version: rehearsalVersions(expected).candidate,
    files: rehearsalTransferFiles("signed", expected)
      .filter((name) => name !== "rehearsal.json")
      .map((name) => ({ name, bytes: 1, sha256: "b".repeat(64) })),
  };
}
void test("manifest applies the actual2GiB aggregate without allocating payloads", () => {
  const value = signedFixture();
  const identity = { ...expected, signer_attempt: expected.run_attempt };
  for (let index = 0; index < 8; index++) value.files[index]!.bytes = 256 * 1024 ** 2;
  value.files[7]!.bytes -= 2;
  assert.equal(
    inspectRehearsalManifest(value, identity).files.reduce((sum, file) => sum + file.bytes, 0),
    2 * 1024 ** 3,
  );
  value.files[7]!.bytes++;
  assert.throws(() => inspectRehearsalManifest(value, identity), /aggregate/u);
  assert.throws(
    () => inspectRehearsalManifest(signedFixture(), { ...identity, signer_attempt: 3 }),
    /signing producer/u,
  );
  const reordered = signedFixture();
  [reordered.files[0], reordered.files[1]] = [reordered.files[1]!, reordered.files[0]!];
  assert.throws(() => inspectRehearsalManifest(reordered, identity), /first exact asset/u);
});

void test("fixed control continuation retains the original product identity and refuses a new retry", () => {
  const environment = {
    GITHUB_REPOSITORY: "boburning/portcove",
    GITHUB_REPOSITORY_ID: "1354613114",
    GITHUB_SHA: expected.source,
    GITHUB_REF: rehearsalExecutionRef,
    GITHUB_REF_PROTECTED: "true",
    GITHUB_EVENT_NAME: "workflow_dispatch",
    GITHUB_RUN_ID: "66666",
    GITHUB_RUN_ATTEMPT: "1",
    PORTCOVE_REHEARSAL_ORIGIN_ATTEMPT: "1",
  };
  assert.equal(rehearsalExecution(environment).source, expected.source);
  assert.deepEqual(rehearsalOrigin(environment), {
    source: retainedRehearsal.source,
    run_id: retainedRehearsal.run_id,
    run_attempt: 1,
  });
  assert.equal(
    rehearsalVersions(rehearsalOrigin(environment)).candidate,
    "0.0.0-rehearsal.41788540335.1",
  );
  for (const delta of [
    { GITHUB_REF_PROTECTED: "false" },
    { GITHUB_REF: "refs/heads/main" },
    { GITHUB_REF: retainedRehearsal.ref },
    { GITHUB_RUN_ATTEMPT: "2" },
    { GITHUB_SHA: retainedRehearsal.source },
    { GITHUB_RUN_ID: retainedRehearsal.run_id },
    { PORTCOVE_REHEARSAL_ORIGIN_ATTEMPT: "2" },
    { PORTCOVE_REHEARSAL_ORIGIN_ATTEMPT: "" },
  ])
    assert.throws(() => rehearsalOrigin({ ...environment, ...delta }));
});

void test("opaque artifact admission binds run/source/producer and transport bounds", () => {
  const input = {
    id: 17,
    kind: "signed" as const,
    source: expected.source,
    run_id: expected.run_id,
    producer_attempt: 3,
  };
  const raw = {
    id: 17,
    name: "upstream-signed-12345-3",
    expired: false,
    size_in_bytes: 256,
    digest: "sha256:" + "c".repeat(64),
    workflow_run: { id: 12345, head_sha: expected.source, repository_id: 1354613114 },
  };
  assert.equal(inspectRehearsalArtifact(raw, input).archive_bytes, 256);
  for (const delta of [
    { id: 18 },
    { name: "upstream-signed-12345-2" },
    { expired: true },
    { digest: null },
    { size_in_bytes: 512 * 1024 ** 2 + 1 },
    { workflow_run: { ...raw.workflow_run, head_sha: "d".repeat(40) } },
  ])
    assert.throws(() => inspectRehearsalArtifact({ ...raw, ...delta }, input));
});

void test("budget retains actual prior time, refuses unsafe retry and never rebuilds a successful package", () => {
  const prior = (minutes: number) => ({
    total_count: 1,
    jobs: [
      {
        name: "package",
        status: "completed",
        conclusion: "success",
        started_at: "2026-11-04T00:00:00Z",
        completed_at: new Date(Date.parse("2026-11-04T00:00:00Z") + minutes * 60000).toISOString(),
      },
    ],
  });
  const admitted = inspectRehearsalBudget("feed", [prior(50)]);
  assert.equal(admitted.observed_milliseconds, 50 * 60000);
  assert.equal(admitted.remaining_declared_minutes, 25);
  assert.equal(admitted.reservation, false);
  const skipped = {
    name: "public_installed",
    status: "completed",
    conclusion: "skipped",
    started_at: "2026-11-04T04:31:26Z",
    completed_at: "2026-11-04T04:31:25Z",
    steps: [],
  };
  // Retain the actual provider's reversed timestamp shape: skipped jobs ran
  // no steps, whereas cancelled/executed jobs still need valid measured time.
  const withSkipped = { total_count: 2, jobs: [...prior(50).jobs, skipped] };
  assert.equal(inspectRehearsalBudget("feed", [withSkipped]).observed_milliseconds, 50 * 60000);
  assert.throws(() =>
    inspectRehearsalBudget("feed", [
      { total_count: 1, jobs: [{ ...skipped, steps: [{ conclusion: "success" }] }] },
    ]),
  );
  assert.throws(() =>
    inspectRehearsalBudget("feed", [
      { total_count: 1, jobs: [{ ...skipped, conclusion: "cancelled" }] },
    ]),
  );
  assert.throws(() => inspectRehearsalBudget("feed", [prior(116)]), /application140/u);
  assert.throws(() => inspectRehearsalBudget("package", [prior(1)]), /original package/u);
  assert.throws(() => inspectRehearsalBudget("readback", [{ ...prior(1), total_count: 2 }]));
});

void test("protection observer preserves unknown bypass visibility without granting production admission", () => {
  const value = {
    id: 12,
    target: "tag",
    source_type: "Repository",
    source: "boburning/portcove",
    enforcement: "active",
    bypass_actors: [],
    conditions: { ref_name: { exclude: [], include: [rehearsalExecutionRef] } },
    rules: ["creation", "update", "deletion"].map((type) => ({ type })),
  };
  assert.equal(inspectRehearsalProtection(value).no_bypass, true);
  const { bypass_actors: _omitted, ...hidden } = value;
  const unknown = inspectRehearsalProtection(hidden);
  assert.equal(unknown.no_bypass, null);
  assert.equal(unknown.production_admission, false);
  assert.throws(() => inspectRehearsalProtection({ ...value, bypass_actors: [{ actor_id: 1 }] }));
  assert.throws(() => inspectRehearsalProtection({ ...value, rules: [{ type: "update" }] }));
  assert.throws(() =>
    inspectRehearsalProtection({
      ...value,
      conditions: { ref_name: { exclude: [], include: ["refs/heads/main"] } },
    }),
  );
});

void test("feed transition requires the usable baseline and never rolls a completed feed back", () => {
  assert.deepEqual(rehearsalFeedTransition("baseline", null, "base", "next"), {
    deploy: true,
    state: "baseline",
  });
  assert.deepEqual(rehearsalFeedTransition("baseline", "next", "base", "next"), {
    deploy: false,
    state: "candidate",
  });
  assert.deepEqual(rehearsalFeedTransition("candidate", "base", "base", "next"), {
    deploy: true,
    state: "candidate",
  });
  assert.deepEqual(rehearsalFeedTransition("candidate", "next", "base", "next"), {
    deploy: false,
    state: "candidate",
  });
  assert.throws(() => rehearsalFeedTransition("candidate", null, "base", "next"));
  assert.throws(() => rehearsalFeedTransition("candidate", "foreign", "base", "next"));
});

void test("native prior-attempt step result controls the single deliberate interruption without a proof adapter", () => {
  const feed = {
    name: "feed",
    status: "completed",
    conclusion: "failure",
    steps: [{ name: "Inject controlled post-publication interruption", conclusion: "failure" }],
  };
  assert.equal(hasPriorRehearsalInterruption([{ total_count: 1, jobs: [feed] }]), true);
  assert.equal(
    hasPriorRehearsalInterruption([
      {
        total_count: 1,
        jobs: [{ ...feed, steps: [{ name: "unrelated failure", conclusion: "failure" }] }],
      },
    ]),
    false,
  );
  assert.equal(hasPriorRehearsalInterruption([{ total_count: 0, jobs: [] }]), false);
  assert.throws(() => hasPriorRehearsalInterruption([{ total_count: 2, jobs: [feed] }]));
  assert.throws(() => hasPriorRehearsalInterruption([{ total_count: 2, jobs: [feed, feed] }]));
});

function nativeFixture() {
  const inputs = {
    source: expected.source,
    source_tree: "b".repeat(40),
    harness_sha256: "c".repeat(64),
    run_id: expected.run_id,
    origin_attempt: 2,
    producer_attempt: 3,
    version: rehearsalVersions(expected).candidate,
    manifest_sha256: "d".repeat(64),
    installer_sha256: "e".repeat(64),
  };
  const roles = [
    ["predecessor_installer", 0],
    ["predecessor_smoke", 0],
    ["installed_update_truncated_stage", 1],
    ["installed_update_tampered_stage", 1],
    ["installed_update_recovery_status", 1],
    ["installed_update_recovery_repair", 0],
    ["installed_update_recovery_verified", 0],
    ["candidate_smoke", 0],
    ["candidate_uninstaller", 0],
  ] as const;
  const preservation = {
    preferences: { present: true, bytes: 92, sha256: "f".repeat(64) },
    library: [{ path: "portcove.sqlite3" }, { path: "user/installer-qualification/preserve.txt" }],
  };
  const installed = {
    phase: "complete",
    failure: null,
    observation_identity: {
      schema_version: 1,
      source_commit: inputs.source,
      source_tree: inputs.source_tree,
      harness: "scripts/test-windows-installer.ps1",
      harness_sha256: inputs.harness_sha256,
    },
    unverified_child_observations: [],
    unverified_child_capture_failed: false,
    process_runs: roles.map(([role, exit_code], index) => ({
      role,
      pid: index + 100,
      status: "exit_observed",
      exit_code,
      exit_observation: "Observed through the retained launch handle",
      executable_sha256: "a".repeat(64),
    })),
    private_signing_inputs_absent: {
      payload_private_key: true,
      tuf_private_root: true,
      signing_private_key_environment: true,
      signing_private_key_path_environment: true,
      signing_password_environment: true,
    },
    details: {
      registered_version: inputs.version,
      installer_sha256: inputs.installer_sha256,
      application_responding: true,
      application_exit_code: 0,
      uninstall_exit_code: 0,
      managed_files_removed: true,
      registration_removed: true,
      persistent_data_preserved: true,
      preservation_manifest_before_uninstall: preservation,
      preservation_manifest_after_uninstall: structuredClone(preservation),
      installed_executable_sha256: "1".repeat(64),
      expected_executable: { raw_sha256: "2".repeat(64), bundled_sha256: "1".repeat(64) },
    },
    installed_truncated_stage: {
      exit_code: 1,
      staging_empty: true,
      predecessor_preserved: true,
      sentinel_preserved: true,
    },
    installed_tampered_stage: {
      exit_code: 1,
      staging_empty: true,
      predecessor_preserved: true,
      sentinel_preserved: true,
    },
    installed_recovery: {
      status_exit_code: 1,
      repair_exit_code: 0,
      healthy_status_exit_code: 0,
      staging_empty: true,
    },
  };
  const renderer = {
    phase: "complete",
    failure: null,
    source_commit: inputs.source,
    candidate_version: inputs.version,
    candidate_installer_sha256: inputs.installer_sha256,
    candidate_executable_sha256: "1".repeat(64),
    helper_result: { exit_code: 0, process_id: 17 },
    helper_process_marker: { process_id: 17, executable: "C:\\worker.exe" },
    relaunch_process_marker: { process_id: 18 },
    helper_os_exit: {
      kind: "observation",
      observation: {
        status: "exit-observed",
        exit_code: 0,
        observation: "retained-process-handle",
        pid: 17,
        path: "C:\\worker.exe",
        started_filetime: "134382341341082253",
      },
    },
    natural_process_exit: {
      helper: { capture: { status: "exited", pid: 17 }, exit: { status: "exited", pid: 17 } },
      candidate: { capture: { status: "exited", pid: 18 }, exit: { status: "exited", pid: 18 } },
    },
    embedded_cleanup: { forced: false, exit_code: 0 },
    updater_process_cleanup: {
      candidate: "exited naturally before cleanup",
      helper: "exited naturally before cleanup",
    },
  };
  const base = rehearsalPublicBase(expected);
  const summary = {
    scope: "disposable-installed-fixture",
    source: inputs.source,
    run_id: inputs.run_id,
    attempt: 3,
    original_attempt: 2,
    candidate_version: inputs.version,
    signed_manifest_sha256: inputs.manifest_sha256,
    private_authority_transferred: false,
    metadata_transport: "local-public-fixture",
    production: false,
    empty_https_feed: {
      scope: "controlled-empty-https-feed",
      state: "no-candidate",
      authenticated_metadata: true,
      production: false,
      metadata_url: `${base}metadata/`,
      targets_url: `${base}targets/`,
    },
  };
  return { installed, renderer, summary, inputs };
}

void test("native acceptance requires actual source/harness, settled children, retained-handle exits and preservation", () => {
  const valid = nativeFixture();
  assert.equal(
    inspectRehearsalAcceptance(valid.installed, valid.renderer, valid.summary, valid.inputs)
      .authority,
    "none",
  );
  const executor = { source: "9".repeat(40), run_id: "66666", run_attempt: 1 };
  const publicInstalled = {
    ...valid.installed,
    observation_identity: {
      ...valid.installed.observation_identity,
      source_commit: executor.source,
    },
    controlled_public_transport:
      "compiled HTTPS metadata and normal GitHub payload transport; no local repository or payload substitute",
  };
  const publicRenderer = { ...valid.renderer, source_commit: executor.source };
  const publicSummary = {
    ...valid.summary,
    scope: "disposable-public-installed-fixture",
    metadata_transport: "compiled-https-and-normal-github-payload",
    attempt: 1,
    executor,
  };
  const publicExpected = { ...valid.inputs, producer_attempt: 1, public_transport: true, executor };
  assert.equal(
    inspectRehearsalAcceptance(publicInstalled, publicRenderer, publicSummary, publicExpected)
      .authority,
    "none",
  );
  assert.throws(() =>
    inspectRehearsalAcceptance(valid.installed, publicRenderer, publicSummary, publicExpected),
  );
  assert.throws(() =>
    inspectRehearsalAcceptance(publicInstalled, valid.renderer, publicSummary, publicExpected),
  );
  assert.throws(() =>
    inspectRehearsalAcceptance(
      publicInstalled,
      publicRenderer,
      { ...publicSummary, executor: { ...executor, source: valid.inputs.source } },
      publicExpected,
    ),
  );
  for (const mutate of [
    (f: ReturnType<typeof nativeFixture>) =>
      Object.assign(f.installed, { observation_identity: undefined }),
    (f: ReturnType<typeof nativeFixture>) => {
      f.installed.observation_identity.source_commit = "f".repeat(40);
    },
    (f: ReturnType<typeof nativeFixture>) => {
      f.installed.observation_identity.source_tree = "f".repeat(40);
    },
    (f: ReturnType<typeof nativeFixture>) => {
      f.installed.observation_identity.harness_sha256 = "f".repeat(64);
    },
    (f: ReturnType<typeof nativeFixture>) =>
      Object.assign(f.installed, { unverified_child_observations: [{}] }),
    (f: ReturnType<typeof nativeFixture>) => {
      f.installed.unverified_child_capture_failed = true;
    },
    (f: ReturnType<typeof nativeFixture>) => {
      f.installed.process_runs[0]!.status = "timed_out";
    },
    (f: ReturnType<typeof nativeFixture>) => {
      f.renderer.helper_os_exit.observation.pid = 99;
    },
    (f: ReturnType<typeof nativeFixture>) => {
      f.renderer.helper_os_exit.observation.started_filetime = "12";
    },
    (f: ReturnType<typeof nativeFixture>) => {
      f.renderer.natural_process_exit.candidate.exit.status = "still-running";
    },
    (f: ReturnType<typeof nativeFixture>) => {
      f.installed.details.preservation_manifest_after_uninstall.preferences.sha256 = "a".repeat(64);
    },
    (f: ReturnType<typeof nativeFixture>) => {
      f.summary.metadata_transport = "claimed-production";
    },
  ]) {
    const value = nativeFixture();
    mutate(value);
    assert.throws(() =>
      inspectRehearsalAcceptance(value.installed, value.renderer, value.summary, value.inputs),
    );
  }
});

void test("immutable observation refuses missing immutability even with complete matching assets", () => {
  const files = fixture().files,
    tag = `v${fixture().version}`;
  const ref = { ref: `refs/tags/${tag}`, object: { type: "commit", sha: expected.source } };
  const assets = files.map((file) => ({
    name: file.name,
    size: file.bytes,
    digest: `sha256:${file.sha256}`,
  }));
  const release = {
    id: 42,
    tag_name: tag,
    target_commitish: expected.source,
    draft: false,
    immutable: true,
    prerelease: true,
    published_at: "2026-11-04T00:00:00Z",
  };
  const identity = { id: 42, tag, source: expected.source, files };
  assert.equal(
    inspectRehearsalReleaseReadback(release, ref, assets, identity, "immutable").immutable,
    true,
  );
  for (const delta of [
    { immutable: false },
    { draft: true },
    { published_at: null },
    { target_commitish: "f".repeat(40) },
  ])
    assert.throws(() =>
      inspectRehearsalReleaseReadback({ ...release, ...delta }, ref, assets, identity, "immutable"),
    );
});

void test("diagnostic continuation retains all four failed exposures and counts actual execution", () => {
  const at = (minute: number) =>
    new Date(Date.parse("2026-11-04T00:00:00Z") + minute * 60000).toISOString();
  const make = (name: string, index: number, attempt: number, conclusion: string) => ({
    id: index + 100 * attempt,
    run_id: Number(retainedRehearsal.run_id),
    run_attempt: attempt,
    head_sha: retainedRehearsal.source,
    head_branch: retainedRehearsal.ref.slice(10),
    name,
    status: "completed",
    conclusion,
    runner_id: index + 1000,
    runner_name: `fixture ${index}`,
    labels: ["fixture"],
    started_at: at(index),
    completed_at: at(index + 1),
    steps:
      conclusion === "skipped"
        ? []
        : [
            {
              name: "fixture work",
              conclusion,
              status: "completed",
              started_at: at(index),
              completed_at: at(index + 1),
            },
          ],
  });
  const successes = [
    "package",
    "provenance",
    "sign",
    "baseline",
    "installed",
    "acceptance",
    "draft",
  ].map((name, i) => make(name, i, 1, "success"));
  const failed = (attempt: number, step: string) => ({
    ...make("feed", 7, attempt, "failure"),
    runner_id: 2000 + attempt,
    started_at: at(10 * attempt),
    completed_at: at(10 * attempt + 1),
    steps: [
      {
        name: step,
        conclusion: "failure",
        status: "completed",
        started_at: at(10 * attempt),
        completed_at: at(10 * attempt + 1),
      },
    ],
  });
  const first = {
    total_count: 10,
    jobs: [
      ...successes,
      failed(1, "Inject controlled post-publication interruption"),
      make("public_installed", 8, 1, "skipped"),
      make("readback", 9, 1, "skipped"),
    ],
  };
  const second = {
    total_count: 10,
    jobs: [
      ...successes.map((j) => ({ ...structuredClone(j), id: j.id + 100, run_attempt: 2 })),
      failed(2, "Bound actual cumulative runtime and remaining native jobs"),
      make("public_installed", 8, 2, "skipped"),
      make("readback", 9, 2, "skipped"),
    ],
  };
  const contexts = [1, 2].map((attempt) => ({
    id: Number(retainedRehearsal.run_id),
    run_attempt: attempt,
    head_sha: retainedRehearsal.source,
    head_branch: retainedRehearsal.ref.slice(10),
    run_started_at: at((attempt - 1) * 15),
    status: "completed",
    conclusion: "failure",
    event: "workflow_dispatch",
    path: ".github/workflows/upstream-release-rehearsal.yml",
  }));
  const previous = {
    ...contexts[0]!,
    id: Number(retainedRecovery.run_id),
    head_sha: retainedRecovery.source,
    head_branch: retainedRecovery.ref.slice(10),
    run_started_at: at(30),
  };
  const third = {
    total_count: 4,
    jobs: ["recovery", "feed", "public_installed", "readback"].map((name, index) => {
      const conclusion = index < 2 ? "success" : index === 2 ? "failure" : "skipped";
      const row = make(name, 31 + index, 1, conclusion);
      return {
        ...row,
        run_id: previous.id,
        head_sha: previous.head_sha,
        head_branch: previous.head_branch,
        steps: row.steps.map((step) => ({
          ...step,
          name:
            index === 2
              ? "Exercise compiled HTTPS metadata and actual GitHub payload through installed UI"
              : step.name,
        })),
      };
    }),
  };
  const current = { ...contexts[0]!, id: 66666, head_sha: expected.source, run_started_at: at(40) };
  const fourthContext = {
    ...previous,
    id: Number(retainedDiagnostic.run_id),
    head_sha: retainedDiagnostic.source,
    head_branch: retainedDiagnostic.ref.slice(10),
    run_started_at: at(40),
  };
  const fourth = {
    total_count: 3,
    jobs: third.jobs
      .filter((row) => row.name !== "feed")
      .map((row) => ({
        ...row,
        run_id: fourthContext.id,
        head_sha: fourthContext.head_sha,
        head_branch: fourthContext.head_branch,
        started_at: at(41),
        completed_at: at(42),
      })),
  };
  const fifth = { total_count: 0, jobs: [] };
  const attempts = [first, second, third, fourth, fifth];
  const allContexts = [...contexts, previous, fourthContext, current];
  const admitted = inspectRetainedRecoveryHistory(attempts, allContexts);
  assert.equal(admitted.observed_milliseconds, 14 * 60000);
  assert.equal(admitted.copied_successful_observations, 7);
  assert.equal(admitted.remaining_declared_minutes, 23);
  assert.throws(() =>
    inspectRetainedRecoveryHistory([first, second, fourth], [...contexts, current]),
  );
  assert.throws(() =>
    inspectRetainedRecoveryHistory(attempts, [
      { ...contexts[0], head_sha: expected.source },
      contexts[1],
      previous,
      current,
    ]),
  );
  const wrong = structuredClone(second);
  wrong.jobs[7]!.steps[0]!.name = "unrelated failure";
  assert.throws(() =>
    inspectRetainedRecoveryHistory([first, wrong, third, fourth, fifth], allContexts),
  );
  const changedPrevious = structuredClone(third);
  changedPrevious.jobs[2]!.steps[0]!.name = "unrelated failure";
  assert.throws(() =>
    inspectRetainedRecoveryHistory([first, second, changedPrevious, fourth, fifth], allContexts),
  );
  assert.throws(() => inspectRehearsalBudget("recovery", [...attempts, fourth]));
});
