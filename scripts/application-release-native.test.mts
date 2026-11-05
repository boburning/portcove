import assert from "node:assert/strict";
import test from "node:test";
import { parse } from "yaml";
import { readFile, mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { sha256 } from "./application-release-io.mts";
import { isRecord } from "./runtime-values.mts";
import { collectApplicationNativeReport } from "./release-native-pre-sign-report.mts";
import { createReleaseCustodyProvider } from "./release-custody-provider.mts";
import {
  inspectApplicationNativeExecutionEnvironment,
  readPublicInstalledOwnerDeadline,
} from "./application-release-native-execution.mts";
import { nativePreSignReportFixture } from "./fixtures/native-linux-report-fixture.mts";
import { releaseCanonicalDigest as digest } from "./release-canonical.mts";
import { serializeApplicationPreSignCapture } from "./release-native-stage-capture.mts";
import { reconstructHostedNativeWindowsPreSignReport } from "./release-native-pre-sign-report.mts";
import { inspectNativeReleaseQualification } from "./release-native-qualification-contract.mts";
import {
  applicationNativeHarness,
  applicationNativeRequest,
  inspectApplicationNativeHost,
  inspectApplicationNativeAcceptance,
  inspectApplicationNativeProducerJob,
  inspectApplicationPublicInstalledProducer,
  inspectApplicationPublicInstalledProof,
  applicationNativeJobName,
  applicationNativeExecutionMinutes,
  inspectApplicationNativeAttempts,
} from "./application-release-native.mts";
import type { ApplicationNativeBinding } from "./application-release-native.mts";
import {
  applicationReleaseJobMinutes,
  applicationReleaseTrust,
} from "./application-release-policy.mts";
import {
  composeApplicationRecordContext,
  prepareApplicationReleaseContext,
  assertApplicationContextCurrentRecords,
} from "./application-release-context.mts";
import {
  applicationPackageNames,
  createApplicationUpdaterInventory,
} from "./application-release-artifacts.mts";
import { loadPackagePolicy } from "./release-package-policy.mts";
import { reconstructApplicationUpdateRecords } from "./reconstruct-application-update-records.mts";

async function fixture(server = false) {
  const original = await nativePreSignReportFixture();
  const prior = original.prepared.request;
  const evidence = structuredClone(original.evidence);
  const minimum = server ? "windows-server-2022-x64-continuity" : "windows-11-26h2-x64";
  const version = server ? "10.0.20348.4000" : "10.0.26200.1000";
  const host = inspectApplicationNativeHost(
    {
      machine_id_sha256: prior.expected.host.machine_id_sha256,
      nonce: "a".repeat(64),
      account_binding_sha256: evidence.binding_sha256,
      qualification_profile: "fixed-hosted-native-v1",
      qualification_is_administrator: false,
      qualification_is_elevated: false,
      execution_context: server
        ? "native-windows-server-2022-hosted-isolated-account"
        : "native-windows-11-26h2-hosted-isolated-account",
      account: prior.expected.host.account,
      os: {
        caption: server ? "Microsoft Windows Server 2022 Datacenter" : "Microsoft Windows 11 Pro",
        version,
        build_number: server ? "20348" : "26200",
        display_version: server ? "21H2" : "26H2",
        product_type: server ? 3 : 1,
      },
    },
    minimum,
  );
  const expected: ApplicationNativeBinding = {
    control_commit: prior.expected.producer.source_commit,
    control_tree: prior.expected.producer.source_tree,
    control_ref: "refs/tags/portcove-production-controller-windows-fixture",
    harness_sha256: prior.expected.producer.harness.sha256,
    run_id: prior.candidate.run_id,
    native_attempt: 2,
    package_attempt: prior.candidate.run_attempt,
    unsigned_artifact: prior.candidate.artifact_id,
    source_commit: prior.candidate.source_commit,
    source_tree: prior.candidate.source_tree,
    package: prior.candidate.package,
    package_manifest_sha256: "a".repeat(64),
    minimum_webview2_version: "155.0.4283.62",
    minimum_platform: minimum,
    host,
    native_invocation_id: prior.invocation_id,
    setup_plan_sha256: prior.setup_descriptor_sha256,
    source_declarations: original.source,
  };
  const request = applicationNativeRequest(expected);
  const prepared = {
    request,
    request_sha256: digest(request),
    scope: "integrity-only" as const,
    authority: "none" as const,
  };
  evidence.driver.host_observation.os_version = version;
  evidence.runtime.operating_system = version;
  evidence.driver.host_observation.engine_images[0]!.version = expected.minimum_webview2_version;
  evidence.runtime.browser.version = expected.minimum_webview2_version;
  const root = evidence.capture.roots[0]!;
  const stream = (id: string, name: string) => ({
    path: `${id}.${name}.bin`,
    bytes: 0,
    sha256: "a".repeat(64),
  });
  const start = root.started_at,
    end = evidence.capture.group.observed_at;
  const captured = serializeApplicationPreSignCapture(
    {
      schema_version: 1,
      request_sha256: prepared.request_sha256,
      outcome: "completed",
      started_at: start,
      completed_at: end,
      harness: {
        path: applicationNativeHarness,
        sha256: expected.harness_sha256,
        exit_code: 0,
        stdout: stream("harness", "stdout"),
        stderr: stream("harness", "stderr"),
      },
      roots: [
        {
          ...root,
          stdout: stream(root.id, "stdout"),
          stderr: stream(root.id, "stderr"),
          teardown: {
            ...root.teardown,
            root_pid: root.image.pid,
            root_creation: root.creation,
            exit_code: 0,
            observed_at: end,
          },
        },
      ],
      group: evidence.capture.group,
      scenarios: request.required_scenarios.map((name) => ({
        name,
        outcome: "passed",
        started_at: start,
        completed_at: end,
        capture_sha256: evidence.evidence_sha256,
      })),
      failure: null,
    },
    { request_sha256: prepared.request_sha256, harness: request.expected.producer.harness },
  );
  // Complete retained data, not a raw success flag, goes through both existing
  // reconstructions. The fixture has no actual execution/authentication claim.
  const rawEvidence = { ...evidence, capture: structuredClone(captured.capture) };
  const report = reconstructHostedNativeWindowsPreSignReport(
    prepared,
    rawEvidence,
    original.source,
    {
      schema_version: 1,
      nonce: host.nonce,
      architecture: "x86_64",
      machine_id_sha256: host.machine_id_sha256,
      broker_sid: host.account.broker,
      os: host.os,
    },
    host.nonce,
  ).report;
  const job = {
    id: 100,
    runner_id: 200,
    name: applicationNativeJobName,
    run_id: Number(expected.run_id),
    run_attempt: 2,
    head_sha: expected.control_commit,
    status: "completed",
    conclusion: "success",
    started_at: "2026-10-20T11:59:58.000Z",
    completed_at: "2026-10-20T12:00:07.000Z",
  };
  return {
    report,
    capture: structuredClone(captured.capture),
    evidence: rawEvidence,
    expected,
    job,
  };
}

void test("pre-key gate reuses full installer/runtime/source reconstruction and a real maintained harness path", async () => {
  const f = await fixture();
  assert.ok(
    (await readFile(new URL(`../${applicationNativeHarness}`, import.meta.url))).length > 0,
  );
  const accepted = inspectApplicationNativeAcceptance(f.report, f.capture, f.evidence, f.expected);
  assert.equal(accepted.authority, "none");
  assert.equal(accepted.report.stage, "payload-signing");
  for (const change of [
    { control_commit: "f".repeat(40) },
    { source_tree: "f".repeat(40) },
    { native_attempt: 3 },
    { package_manifest_sha256: "f".repeat(64) },
    { unsigned_artifact: 999 },
  ])
    assert.throws(() =>
      inspectApplicationNativeAcceptance(f.report, f.capture, f.evidence, {
        ...f.expected,
        ...change,
      }),
    );
});
void test("partial teardown, unknown scenarios, wrong installer and failed lifecycle/runtime evidence all hold", async () => {
  const changes: ((f: Awaited<ReturnType<typeof fixture>>) => void)[] = [
    (f) => {
      f.capture.scenarios.pop();
    },
    (f) => {
      f.capture.roots[0]!.teardown!.job_empty = false;
    },
    (f) => {
      f.capture.roots[0]!.teardown!.exit_code = 1;
    },
    (f) => {
      f.capture.harness.exit_code = 1;
    },
    (f) => {
      f.report.runtime.capture_sha256 = "f".repeat(64);
    },
    (f) => {
      f.capture.roots[0]!.image.sha256 = "f".repeat(64);
    },
    (f) => {
      f.evidence.installer.details.persistent_data_preserved = false;
    },
    (f) => {
      f.evidence.runtime.core.schema_version += 1;
    },
  ];
  for (const change of changes) {
    const f = await fixture();
    change(f);
    assert.throws(() =>
      inspectApplicationNativeAcceptance(f.report, f.capture, f.evidence, f.expected),
    );
  }
});
void test("report cannot select a privileged/fixture actor or arbitrary protocol/schema/capability facts", async () => {
  const changes: ((f: Awaited<ReturnType<typeof fixture>>) => void)[] = [
    (f) => {
      f.report.host.account.qualification = "S-1-5-18";
    },
    (f) => {
      f.report.host.qualification_profile = "native-inert-fixture";
    },
    (f) => {
      f.report.host.execution_context = "fixture";
    },
    (f) => {
      f.report.compatibility.cli_protocol.min += 1;
    },
    (f) => {
      f.report.compatibility.catalog_formats = [99];
    },
    (f) => {
      f.report.compatibility.library.write_schema += 1;
    },
    (f) => {
      f.report.compatibility.required_capabilities = [];
    },
    (f) => {
      f.report.compatibility.minimum_os_version = "0.0";
    },
  ];
  for (const change of changes) {
    const f = await fixture();
    change(f);
    assert.throws(() =>
      inspectApplicationNativeAcceptance(f.report, f.capture, f.evidence, f.expected),
    );
  }
  const f = await fixture();
  for (const account of ["S-1-5-18", "S-1-5-21-1-2-3-500"])
    assert.throws(() =>
      inspectApplicationNativeHost(
        { ...f.expected.host, account: { ...f.expected.host.account, qualification: account } },
        f.expected.minimum_platform,
      ),
    );
  assert.throws(() =>
    inspectApplicationNativeHost(
      { ...f.expected.host, qualification_is_administrator: true },
      f.expected.minimum_platform,
    ),
  );
});
void test("appointed Server continuity stays separate from the supported client and selected WebView floor", async () => {
  const f = await fixture(true);
  assert.equal(
    inspectApplicationNativeAcceptance(f.report, f.capture, f.evidence, f.expected)
      .minimum_platform,
    "windows-server-2022-x64-continuity",
  );
  assert.throws(() =>
    inspectApplicationNativeAcceptance(f.report, f.capture, f.evidence, {
      ...f.expected,
      minimum_platform: "windows-11-26h2-x64",
    }),
  );
  const client = await fixture();
  client.report.host.loaded_engine.version = "145.0.1.2";
  assert.throws(() =>
    inspectApplicationNativeAcceptance(
      client.report,
      client.capture,
      client.evidence,
      client.expected,
    ),
  );
});
void test("attested observations must fit their successful original native producer job", async () => {
  const f = await fixture();
  assert.equal(
    inspectApplicationNativeProducerJob({ total_count: 1, jobs: [f.job] }, f.report, f.expected)
      .job_id,
    100,
  );
  for (const change of [
    { conclusion: "failure" },
    { head_sha: "f".repeat(40) },
    { run_attempt: 1 },
    { completed_at: "2026-10-20T12:00:01.000Z" },
  ])
    assert.throws(() =>
      inspectApplicationNativeProducerJob(
        { total_count: 1, jobs: [{ ...f.job, ...change }] },
        f.report,
        f.expected,
      ),
    );
  assert.throws(() =>
    inspectApplicationNativeProducerJob(
      { total_count: 2, jobs: [f.job] },
      inspectNativeReleaseQualification(f.report),
      f.expected,
    ),
  );
});

void test("fresh attestation preserves original native report, actor and producer attempt", async () => {
  const f = await fixture();
  const original = digest(f.report);
  for (const attestation of [2, 3]) {
    const attempts = inspectApplicationNativeAttempts(2, attestation, 3);
    assert.equal(attempts.native_attempt, 2);
    assert.equal(attempts.attestation_attempt, attestation);
    inspectApplicationNativeAcceptance(f.report, f.capture, f.evidence, f.expected);
    assert.equal(
      inspectApplicationNativeProducerJob({ total_count: 1, jobs: [f.job] }, f.report, f.expected)
        .producer_attempt,
      2,
    );
    assert.equal(digest(f.report), original);
  }
  for (const attempts of [
    [2, 1, 3],
    [2, 4, 3],
    [0, 1, 1],
    [1, 1, 4],
    [1.5, 2, 3],
    [1, 1.5, 3],
    [1, 1, NaN],
  ])
    assert.throws(() => inspectApplicationNativeAttempts(attempts[0]!, attempts[1]!, attempts[2]!));
});

void test("fresh native attester has no candidate execution, operational key or publication permission", async () => {
  const text = await readFile(
    new URL("../.github/workflows/application-release-native.yml", import.meta.url),
    "utf8",
  );
  const workflow = parse(text) as {
    on: Record<string, unknown>;
    permissions: Record<string, string>;
    jobs: {
      attest: {
        "timeout-minutes": number;
        steps: { run?: string; uses?: string; with?: Record<string, unknown> }[];
      };
    };
  };
  assert.deepEqual(Object.keys(workflow.on), ["workflow_call"]);
  assert.deepEqual(workflow.permissions, {
    contents: "read",
    actions: "read",
    checks: "read",
    "id-token": "write",
    attestations: "write",
  });
  assert.equal(
    workflow.jobs.attest["timeout-minutes"],
    applicationReleaseJobMinutes["native / attest"],
  );
  assert.equal(applicationNativeExecutionMinutes, applicationReleaseJobMinutes["native / execute"]);
  assert.equal(applicationNativeExecutionMinutes + workflow.jobs.attest["timeout-minutes"], 35);
  const steps = workflow.jobs.attest.steps;
  assert.equal(steps[0]?.with?.ref, "${{ github.sha }}");
  assert.equal(steps[0]?.with?.["persist-credentials"], false);
  const verify = steps.findIndex(
    (step) => step.run === "node scripts/application-release-private.bundle.mjs native-attest",
  );
  const attest = steps.findIndex((step) => step.uses?.startsWith("actions/attest@"));
  const upload = steps.findIndex((step) => step.uses?.startsWith("actions/upload-artifact@"));
  assert.ok(verify > 0 && attest > verify && upload > attest);
  assert.equal(steps[attest]?.with?.["subject-path"], "work/application-native-attested/*");
  assert.equal(
    steps[upload]?.with?.name,
    "application-native-${{ github.run_id }}-${{ github.run_attempt }}",
  );
  assert.equal(steps[upload]?.with?.overwrite, false);
  assert.ok(
    !/secrets\.|cargo |tauri build|pnpm install|download-artifact@|rust-cache/u.test(
      JSON.stringify(workflow.jobs.attest),
    ),
  );
});

void test("native execution requires the fixed protected hosted Windows caller and no private issuer", () => {
  const revision = "a".repeat(40),
    ref = "refs/tags/portcove-production-controller-windows-fixture";
  const env = {
    PORTCOVE_APPLICATION_RELEASE_REVISION: revision,
    PORTCOVE_APPLICATION_RELEASE_REF: ref,
    GITHUB_REPOSITORY: "boburning/portcove",
    GITHUB_REPOSITORY_ID: "1354613114",
    GITHUB_EVENT_NAME: "workflow_dispatch",
    GITHUB_REF: ref,
    GITHUB_REF_PROTECTED: "true",
    GITHUB_SHA: revision,
    GITHUB_WORKFLOW_SHA: revision,
    GITHUB_WORKFLOW_REF: `boburning/portcove/.github/workflows/application-release.yml@${ref}`,
    GITHUB_RUN_ID: "41800000000",
    GITHUB_RUN_ATTEMPT: "2",
    RUNNER_OS: "Windows",
    RUNNER_ARCH: "X64",
    RUNNER_ENVIRONMENT: "github-hosted",
    GITHUB_JOB: "execute",
  };
  assert.equal(inspectApplicationNativeExecutionEnvironment(env).run_attempt, 2);
  for (const change of [
    { RUNNER_OS: "Linux" },
    { RUNNER_ARCH: "ARM64" },
    { RUNNER_ENVIRONMENT: "self-hosted" },
    { GITHUB_JOB: "attest" },
    { GITHUB_SHA: "b".repeat(40) },
    { PORTCOVE_SIGNING_KEY: "inert" },
    { PORTCOVE_OBSERVER_TOKEN: "inert" },
    { ACTIONS_ID_TOKEN_REQUEST_TOKEN: "inert" },
  ])
    assert.throws(() => inspectApplicationNativeExecutionEnvironment({ ...env, ...change }));
});

void test("native public owner clock uses the exact original SDK job inventory", async () => {
  const current = {
    source: "a".repeat(40),
    ref: "refs/tags/portcove-production-controller-windows-fixture",
    run_id: "41800000000",
    run_attempt: 2,
  };
  const job = {
    name: "public_installed",
    status: "in_progress",
    run_id: Number(current.run_id),
    run_attempt: current.run_attempt,
    head_sha: current.source,
    started_at: new Date(Date.now() - 120000).toISOString(),
  };
  const start = performance.now();
  let next = false;
  let reads = 0;
  const provider = await createReleaseCustodyProvider({
    token: "synthetic-reader",
    deadline: start + 15000,
    fetch: async (input, init) => {
      reads++;
      assert.ok(typeof input === "string");
      const url = new URL(input);
      assert.equal(url.origin, "https://api.github.com");
      assert.equal(
        url.pathname,
        "/repos/boburning/portcove/actions/runs/41800000000/attempts/2/jobs",
      );
      assert.equal(url.searchParams.get("page"), "1");
      assert.equal(url.searchParams.get("per_page"), "100");
      assert.equal(new Headers(init?.headers).get("authorization"), "token synthetic-reader");
      return Response.json(
        { total_count: 1, jobs: [job] },
        {
          headers: next ? { link: '<https://api.github.com/next>; rel="next"' } : {},
        },
      );
    },
  });
  const deadline = await readPublicInstalledOwnerDeadline(current, provider);
  assert.ok(deadline >= start + 718000 && deadline <= start + 722000);
  next = true;
  await assert.rejects(
    readPublicInstalledOwnerDeadline(current, provider),
    /inventory is incomplete/u,
  );
  assert.equal(reads, 2);
});

void test("native SDK reads nested source configuration and immutable blobs at the selected identity", async () => {
  const revision = "a".repeat(40);
  const blob = "b".repeat(40);
  const filename = "apps/desktop/src-tauri/tauri.conf.json";
  const responses = [
    { sha: revision, tree: { sha: "c".repeat(40) } },
    { path: filename, sha: blob, encoding: "none", content: "" },
    { sha: blob, encoding: "base64", content: "e30=" },
  ];
  const seen: string[] = [];
  const provider = await createReleaseCustodyProvider({
    token: "synthetic-reader",
    deadline: performance.now() + 15000,
    fetch: async (input) => {
      assert.ok(typeof input === "string");
      seen.push(input);
      return Response.json(responses[seen.length - 1]);
    },
  });
  assert.deepEqual(await provider.commit(revision), responses[0]);
  assert.deepEqual(await provider.file(filename, revision), responses[1]);
  assert.deepEqual(await provider.blob(blob), responses[2]);
  const repository = "https://api.github.com/repos/boburning/portcove";
  assert.deepEqual(seen, [
    `${repository}/git/commits/${revision}`,
    `${repository}/contents/${encodeURIComponent(filename)}?ref=${revision}`,
    `${repository}/git/blobs/${blob}`,
  ]);
});

void test("native capture collector reuses actual retained fragments and cannot accept changed runtime bytes", async () => {
  const f = await fixture();
  const directory = await mkdtemp(path.join(tmpdir(), "application-native-capture-"));
  try {
    await mkdir(path.join(directory, "isolated-account-desktop"));
    await mkdir(path.join(directory, "control/scripts"), { recursive: true });
    const harness = Buffer.from("inert trusted installer harness fixture; never executed");
    await writeFile(path.join(directory, "control/scripts/test-windows-installer.ps1"), harness);
    const put = (name: string, data: unknown) =>
      writeFile(path.join(directory, name), JSON.stringify(data));
    const bindingBytes = Buffer.from(JSON.stringify(f.evidence.binding));
    const expected = {
      ...f.expected,
      host: { ...f.expected.host, account_binding_sha256: sha256(bindingBytes) },
    };
    const request = applicationNativeRequest(expected);
    const prepared = {
      request,
      request_sha256: digest(request),
      authority: "none" as const,
      scope: "integrity-only" as const,
    };
    const runtime = {
      ...f.evidence.runtime,
      account_binding_sha256: sha256(bindingBytes),
      process_snapshot: path.join(
        directory,
        "isolated-account-desktop/native-runtime-processes.json",
      ),
    };
    const driver = {
      ...f.evidence.driver,
      completed_at: f.capture.completed_at,
      request_sha256: prepared.request_sha256,
      host_observation: {
        ...f.evidence.driver.host_observation,
        runtime_sha256: sha256(Buffer.from(JSON.stringify(runtime))),
      },
    };
    assert.ok(f.capture.group);
    const bridge = {
      ...f.evidence.bridge,
      group_remaining_pids: [],
      observed_at: f.capture.group.observed_at,
      roots: f.capture.roots.map((root) => ({
        id: root.id,
        pid: root.image.pid,
        path: root.image.path,
        sha256: root.image.sha256,
        created_filetime: root.creation.value,
        started_at: root.started_at,
        teardown: { ...root.teardown, root_created_filetime: root.teardown!.root_creation.value },
      })),
    };
    const installer = {
      ...f.evidence.installer,
      observation_identity: {
        ...f.evidence.installer.observation_identity,
        harness_sha256: sha256(harness),
      },
    };
    await put("bridge-state.json", bridge);
    await put("driver-result.json", driver);
    await writeFile(path.join(directory, "account-binding.json"), bindingBytes);
    await put("installer.json", installer);
    await put("isolated-account-desktop/native-runtime-capabilities.json", runtime);
    await put(
      "isolated-account-desktop/native-runtime-processes.json",
      f.evidence.process_snapshot,
    );
    await put("isolated-account-desktop/evidence.json", f.evidence.native);
    for (const id of [...bridge.roots.map((root) => root.id), "harness"])
      for (const stream of ["stdout", "stderr"])
        await writeFile(path.join(directory, `${id}.${stream}.bin`), "");
    const input = {
      status: 0,
      result: driver,
      capture_directory: directory,
      directory,
      request: prepared,
      version: f.evidence.version,
      predecessor: null,
      payload_cryptography: null,
      parent: { controller_root: path.join(directory, "control") },
      hosted: {
        host: {
          schema_version: 1,
          nonce: expected.host.nonce,
          architecture: "x86_64",
          machine_id_sha256: expected.host.machine_id_sha256,
          broker_sid: expected.host.account.broker,
          os: expected.host.os,
        },
        nonce: expected.host.nonce,
      },
      readSource: async () => ({ declaration: expected.source_declarations }),
      serialize: (_raw: unknown, capture: unknown) =>
        serializeApplicationPreSignCapture(capture, {
          request_sha256: prepared.request_sha256,
          harness: request.expected.producer.harness,
        }),
      recheck: async () => {},
    };
    const result = await collectApplicationNativeReport(input);
    assert.equal(result.authority, "none");
    inspectApplicationNativeAcceptance(result.report, result.capture, result.evidence, expected);
    await put("isolated-account-desktop/native-runtime-capabilities.json", {
      ...runtime,
      architecture: "x86",
    });
    await assert.rejects(
      collectApplicationNativeReport(input),
      /native runtime retained bytes changed/u,
    );
    await assert.rejects(
      collectApplicationNativeReport({ ...input, status: 1 }),
      /actual native driver failed/u,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

void test("canonical native producer and signing DAG keeps candidate execution before fresh protection and key use", async () => {
  type Job = {
    needs?: string | string[];
    permissions?: Record<string, string>;
    uses?: string;
    with?: Record<string, unknown>;
    outputs?: Record<string, unknown>;
    steps?: { run?: string; with?: Record<string, unknown> }[];
  };
  const workflow = parse(
    await readFile(
      new URL("../.github/workflows/application-release-native.yml", import.meta.url),
      "utf8",
    ),
  ) as { on: { workflow_call: { inputs: Record<string, unknown> } }; jobs: Record<string, Job> };
  const execute = workflow.jobs.execute!,
    attest = workflow.jobs.attest!;
  assert.deepEqual(execute.permissions, { contents: "read", actions: "read", checks: "read" });
  assert.equal(attest.needs, "execute");
  assert.ok(
    execute.steps?.some(
      (step) => step.run === "node scripts/application-release-native-execution.mts",
    ),
  );
  const raw = execute.steps?.find(
    (step) =>
      step.with?.name ===
      "application-native-capture-${{ github.run_id }}-${{ github.run_attempt }}",
  );
  assert.ok(raw);
  assert.deepEqual(
    String(raw.with?.path).trim().split("\n"),
    ["native-qualification.json", "native-capture.json", "native-evidence.json"].map(
      (name) => `work/application-native-produced/${name}`,
    ),
  );
  for (const external of ["native_artifact", "native_host", "native_attempt", "native_invocation"])
    assert.ok(
      !Object.hasOwn(workflow.on.workflow_call.inputs, external),
      "raw producer facts must come from the fixed execution job",
    );
  const release = parse(
    await readFile(
      new URL("../.github/workflows/application-release.yml", import.meta.url),
      "utf8",
    ),
  ) as { jobs: Record<string, Job> };
  assert.equal(release.jobs.native?.uses, "./.github/workflows/application-release-native.yml");
  const protectionNeeds = release.jobs.protection_payload?.needs;
  const payloadNeeds = release.jobs.payload?.needs;
  assert.ok(Array.isArray(protectionNeeds) && protectionNeeds.includes("native"));
  assert.ok(
    Array.isArray(payloadNeeds) &&
      payloadNeeds.includes("native") &&
      payloadNeeds.includes("protection_payload"),
  );
  assert.equal(release.jobs.payload?.with?.native_host, "${{ needs.native.outputs.host }}");
  assert.equal(
    release.jobs.payload?.with?.native_attempt,
    "${{ needs.native.outputs.native_attempt }}",
  );
  assert.equal(
    release.jobs.payload?.with?.native_attestation_attempt,
    "${{ needs.native.outputs.attestation_attempt }}",
  );
  assert.deepEqual(release.jobs.payload?.permissions, {
    contents: "read",
    actions: "read",
    checks: "read",
  });
});

void test("signed payload inventory joins exact native installer and the complete Windows package policy into maintained records", async () => {
  const f = await fixture();
  const version = f.evidence.version;
  const policy = await loadPackagePolicy();
  const manifest = {
    schema_version: 1,
    repository: "boburning/portcove",
    profile: "initial-beta-windows-x86_64-v1",
    source_commit: f.expected.source_commit,
    source_tree: f.expected.source_tree,
    version,
    control_commit: f.expected.control_commit,
    control_ref: f.expected.control_ref,
    run_id: f.expected.run_id,
    package_attempt: f.expected.package_attempt,
    files: applicationPackageNames(version).map((filename) =>
      filename === f.expected.package.filename
        ? { ...f.expected.package }
        : { filename, bytes: 12, sha256: "f".repeat(64) },
    ),
  };
  const signature = Buffer.from("inert signature data; no cryptographic acceptance claimed\n");
  const key = "a".repeat(64);
  const inventory = createApplicationUpdaterInventory(
    manifest,
    f.report,
    f.expected.unsigned_artifact,
    signature,
    key,
    policy,
  );
  assert.equal(inventory.packages.length, 2);
  assert.equal(inventory.updater.target, "windows-x86_64");
  assert.equal(inventory.updater.format, "nsis");
  assert.equal(inventory.updater.signature.sha256, sha256(signature));
  assert.equal(inventory.updater.public_key_sha256, key);
  const records = await reconstructApplicationUpdateRecords(
    [
      {
        inventoryBytes: Buffer.from(JSON.stringify(inventory)),
        signatureBytes: signature,
        source_tree: manifest.source_tree,
        qualified_run: {
          workflow: ".github/workflows/application-release.yml",
          workflow_commit: manifest.control_commit,
          run_id: Number(manifest.run_id),
          attempt: 2,
        },
        execution_context: f.report.host.execution_context,
        compatibility: f.report.compatibility,
        evidence_ids: [
          `native-report:${sha256(Buffer.from(JSON.stringify(f.report)))}`,
          `native-capture:${sha256(Buffer.from(JSON.stringify(f.capture)))}`,
        ],
      },
    ],
    {
      [`v${version}`]: {
        version,
        preview_eligible: true,
        production_eligible: false,
        targets: ["windows-x86_64"],
      },
    },
    { policy },
  );
  assert.equal(records.manifest.records.length, 2);
  assert.deepEqual(records.manifest.records.map((record) => record.kind).sort(), [
    "promotion",
    "release",
  ]);
  assert.ok(records.manifest.records.every((record) => record.target === "windows-x86_64"));
  for (const change of [
    { control_commit: "f".repeat(40) },
    { source_tree: "f".repeat(40) },
    { source_commit: "f".repeat(40) },
    { run_id: "41800000999" },
    { package_attempt: 3 },
    { files: manifest.files.filter((file) => !file.filename.startsWith("portcove-cli-")) },
    { files: [...manifest.files, manifest.files[0]!] },
    { profile: "fixture-profile" },
  ])
    assert.throws(() =>
      createApplicationUpdaterInventory(
        { ...manifest, ...change },
        f.report,
        f.expected.unsigned_artifact,
        signature,
        key,
        policy,
      ),
    );
  assert.throws(() =>
    createApplicationUpdaterInventory(
      manifest,
      f.report,
      f.expected.unsigned_artifact + 1,
      signature,
      key,
      policy,
    ),
  );
  assert.throws(() =>
    createApplicationUpdaterInventory(
      manifest,
      f.report,
      f.expected.unsigned_artifact,
      Buffer.alloc(0),
      key,
      policy,
    ),
  );
});

async function recordContextFixture() {
  const f = await fixture();
  const policy = await loadPackagePolicy();
  const originalVersion = f.evidence.version;
  const registry = JSON.parse(await readFile(applicationReleaseTrust.payload.path, "utf8")) as {
    keys: { id: string }[];
  };
  const manifest = {
    schema_version: 1,
    repository: "boburning/portcove",
    profile: "initial-beta-windows-x86_64-v1",
    source_commit: f.expected.source_commit,
    source_tree: f.expected.source_tree,
    version: originalVersion,
    control_commit: f.expected.control_commit,
    control_ref: f.expected.control_ref,
    run_id: f.expected.run_id,
    package_attempt: f.expected.package_attempt,
    files: applicationPackageNames(originalVersion).map((filename) =>
      filename === f.expected.package.filename
        ? { ...f.expected.package }
        : { filename, bytes: 12, sha256: "f".repeat(64) },
    ),
  };
  const signature = Buffer.from("inert data signature; never admitted cryptographically\n");
  const oldInventory = createApplicationUpdaterInventory(
    manifest,
    f.report,
    f.expected.unsigned_artifact,
    signature,
    registry.keys[0]!.id,
    policy,
  );
  const qualification = {
    workflow: ".github/workflows/qualification.yml",
    workflow_commit: "d".repeat(40),
    run_id: 1000,
    attempt: 4,
  };
  const old = await reconstructApplicationUpdateRecords(
    [
      {
        inventoryBytes: Buffer.from(JSON.stringify(oldInventory)),
        signatureBytes: signature,
        source_tree: manifest.source_tree,
        qualified_run: qualification,
        execution_context: f.report.host.execution_context,
        compatibility: f.report.compatibility,
        evidence_ids: ["fixture-native-report:" + sha256(Buffer.from(JSON.stringify(f.report)))],
      },
    ],
    {
      [`v${originalVersion}`]: {
        version: originalVersion,
        preview_eligible: true,
        production_eligible: false,
        targets: ["windows-x86_64"],
      },
    },
    { policy },
  );
  const prior = new Map<string, Buffer>();
  for (const [from, to] of [
    [applicationReleaseTrust.root.path, "trusted-root.json"],
    [applicationReleaseTrust.targets.path, "offline-targets.json"],
    [applicationReleaseTrust.payload.path, "payload.json"],
  ])
    prior.set(to!, await readFile(from!));
  for (const [name, bytes] of old.files) prior.set(`records/${name}`, Buffer.from(bytes));
  prior.set(
    "prior/metadata/timestamp.json",
    Buffer.from("inert authenticated-prior fixture representation; data join only"),
  );
  prior.set(
    "prior/metadata/1.stable.json",
    Buffer.from("prior Stable metadata bytes must remain unchanged"),
  );
  prior.set("context.json", Buffer.from("{}"));
  const generated = Math.floor(Date.now() / 1000) * 1000;
  const time = (days: number) =>
    new Date(generated + days * 86400000).toISOString().replace(".000Z", "Z");
  const targets = JSON.parse(prior.get("offline-targets.json")!.toString("utf8")) as {
    signed: { expires: string };
  };
  const roles = ["targets", "releases", "preview", "stable", "snapshot", "timestamp"];
  const oldFiles = [...old.files].filter(([name]) => name !== "reconstruction-manifest.json");
  const descriptor = {
    schema_version: 1,
    kind: "application-tuf-metadata-renewal",
    generated_at: time(0),
    root_sha256: applicationReleaseTrust.root.sha256,
    offline_targets_sha256: applicationReleaseTrust.targets.sha256,
    prior_repository_sha256: "a".repeat(64),
    prior_timestamp_sha256: "b".repeat(64),
    prior_snapshot_sha256: "c".repeat(64),
    unchanged_records_sha256: digest(
      oldFiles
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([name, bytes]) => ({ path: name, bytes: bytes.length, sha256: sha256(bytes) })),
    ),
    current_versions: Object.fromEntries(roles.map((role) => [role, "1"])),
    next_versions: Object.fromEntries(roles.map((role) => [role, role === "targets" ? "1" : "2"])),
    current_expires: Object.fromEntries(
      roles.map((role) => [role, role === "targets" ? targets.signed.expires : time(-1)]),
    ),
    next_expires: Object.fromEntries(
      roles.map((role) => [
        role,
        role === "targets"
          ? targets.signed.expires
          : time(role === "timestamp" ? 1 : role === "releases" ? 60 : 6),
      ]),
    ),
  };
  prior.set("renewal.json", Buffer.from(JSON.stringify(descriptor)));
  const version = "0.1.0-beta.2";
  const nextManifest = {
    ...manifest,
    version,
    source_commit: "e".repeat(40),
    source_tree: "f".repeat(40),
    files: applicationPackageNames(version).map((filename) => ({
      filename,
      bytes: 12,
      sha256: "f".repeat(64),
    })),
  };
  const native = structuredClone(f.report);
  native.candidate = {
    ...native.candidate,
    source_commit: nextManifest.source_commit,
    source_tree: nextManifest.source_tree,
    package: { filename: `Portcove_${version}_x64-setup.exe`, bytes: 12, sha256: "f".repeat(64) },
  };
  const inventory = createApplicationUpdaterInventory(
    nextManifest,
    native,
    f.expected.unsigned_artifact,
    signature,
    registry.keys[0]!.id,
    policy,
  );
  const input = {
    manifest: nextManifest,
    unsigned_artifact: f.expected.unsigned_artifact,
    native_report: native,
    inventory: Buffer.from(JSON.stringify(inventory)),
    signature,
    classification: {
      source_commit: qualification.workflow_commit,
      reviewed_commit: qualification.workflow_commit,
      base_version: originalVersion,
      change: "prerelease",
      compatibility: "compatible",
    },
    qualification,
    evidence_ids: ["fixture-native-report:" + sha256(Buffer.from(JSON.stringify(native)))],
  };
  return { prior, descriptor, input, old };
}

void test("application context data join preserves retained prior records and emits forward Preview data without renewal claims", async () => {
  const f = await recordContextFixture();
  const result = await composeApplicationRecordContext(f.prior, f.descriptor, f.input);
  await assertApplicationContextCurrentRecords(result.files, f.input);
  const current = [...result.files].find(
    ([name]) => name.startsWith("records/releases/") && !f.prior.has(name),
  );
  assert.ok(current);
  const substituted = new Map(result.files);
  substituted.set(current[0], Buffer.from("{}"));
  await assert.rejects(
    assertApplicationContextCurrentRecords(substituted, f.input),
    /differs from actual/u,
  );
  assert.equal(result.authority, "none");
  assert.equal(result.added_records, 2);
  assert.equal(result.withdrawals, 0);
  assert.ok(!result.files.has("renewal.json") && !result.files.has("initial-bootstrap.json"));
  for (const [name, bytes] of f.prior)
    if (
      name.startsWith("prior/") ||
      (name.startsWith("records/") && name !== "records/reconstruction-manifest.json")
    )
      assert.ok(result.files.get(name)?.equals(bytes));
  const manifest = JSON.parse(
    result.files.get("records/reconstruction-manifest.json")!.toString("utf8"),
  ) as { records: { path: string; channel?: string }[] };
  assert.equal(manifest.records.length, 4);
  assert.ok(!manifest.records.some((record) => record.channel === "stable"));
  const context = JSON.parse(result.files.get("context.json")!.toString("utf8")) as {
    previous_repository: string;
    versions: { timestamp: number; targets: number };
  };
  assert.equal(context.previous_repository, "prior");
  assert.equal(context.versions.timestamp, 2);
  assert.equal(context.versions.targets, 1);
});

void test("public installed readback requires the exact successful Windows attempt and positive teardown", async () => {
  const { expected: base } = await fixture(true);
  const identity = { source: base.control_commit, run_id: base.run_id, run_attempt: 2 };
  const job = {
    id: 23,
    runner_id: 5,
    name: "public_installed",
    labels: ["windows-2022"],
    status: "completed",
    conclusion: "success",
    run_id: Number(base.run_id),
    run_attempt: 2,
    head_sha: base.control_commit,
    started_at: "2026-11-05T01:00:00Z",
    completed_at: "2026-11-05T01:09:00Z",
  };
  const producer = inspectApplicationPublicInstalledProducer(
    { total_count: 1, jobs: [job] },
    identity,
  );
  assert.throws(() =>
    inspectApplicationPublicInstalledProducer(
      {
        total_count: 1,
        jobs: [{ ...job, run_attempt: 3 }],
      },
      identity,
    ),
  );
  assert.throws(() =>
    inspectApplicationPublicInstalledProducer(
      {
        total_count: 1,
        jobs: [{ ...job, conclusion: "failure" }],
      },
      identity,
    ),
  );
  const invocation = "d".repeat(64);
  const inputs = {
    schema_version: 1,
    kind: "ordinary-public-windows-update-inputs",
    prior_version: "0.1.0-beta.1",
    candidate_version: "0.1.0-beta.2",
    prior_installer_sha256: "1".repeat(64),
    candidate_installer_sha256: "2".repeat(64),
    prior_executable_sha256: "3".repeat(64),
    candidate_executable_sha256: "4".repeat(64),
  };
  const preserved = { library: [{ path: "portcove.sqlite3" }] };
  const profile = {
    library_root: "D:\\fixture\\desktop-ordinary-public-update\\library",
    preferences_path: "D:\\fixture\\desktop-ordinary-public-update\\preferences.json",
  };
  const journeyManifest = {
    library: [{ path: "portcove.sqlite3", type: "file", bytes: 4096, sha256: "c".repeat(64) }],
    preferences: { present: true, bytes: 128, sha256: "d".repeat(64) },
  };

  const installer = {
    phase: "complete",
    details: {
      uninstall_exit_code: 0,
      managed_files_removed: true,
      registration_removed: true,
      persistent_data_preserved: true,
      preservation_manifest_before_uninstall: preserved,
      preservation_manifest_after_uninstall: preserved,
      journey_profile_preservation: { ...profile, before: journeyManifest, after: journeyManifest },
      isolated_account_boundary: {
        native_invocation_id: invocation,
        installed_executable_sha256: inputs.candidate_executable_sha256,
      },
    },
  };
  const harnessSha = "5".repeat(64);
  const journey = {
    schema_version: 1,
    authority: "none",
    native_acceptance: "not-established",
    harness: { sha256: harnessSha },
    recovery_cases: ["apply", "schedule", "staging"].map((area) => ({ area })),
    phase: "initial-v0-v1",
    outcome: "observed",
    profile,
    user_state: {
      before: { application_version: inputs.prior_version, library_root: profile.library_root },
      after: { application_version: inputs.candidate_version, library_root: profile.library_root },
    },
    automatic_relaunch: {
      title: "Portcove",
      executable: { sha256: inputs.candidate_executable_sha256 },
    },
  };
  const expected = {
    ...identity,
    ref: base.control_ref,
    producer,
    candidate: { release_id: 9 },
    inputs,
    inputs_sha256: "6".repeat(64),
    harness_sha256: harnessSha,
    minimum: base.minimum_platform,
  };
  const proof = {
    schema_version: 1,
    kind: "application-public-installed-observation",
    authority: "none",
    control_commit: identity.source,
    control_ref: expected.ref,
    run_id: identity.run_id,
    run_attempt: 2,
    host: base.host,
    invocation,
    candidate: expected.candidate,
    inputs,
    inputs_sha256: expected.inputs_sha256,
    installer_sha256: digest(installer),
    journey_sha256: digest(journey),
    started_at: job.started_at,
    completed_at: job.completed_at,
    owner_teardown: {
      authority: "none",
      binding: base.host.nonce,
      failure: "",
      cleanup_failures: [],
      credential_disposed: true,
      owner_pid: 31,
    },
    stage_settlement: {
      authority: "none",
      stage: "ordinary-public-initial",
      binding: base.host.nonce,
      account_sid: base.host.account.qualification,
      disabled: true,
      station_restored: true,
      group_empty: true,
      harness_exit_code: 0,
      harness_drained: true,
      broker_job_remaining_pids: [31],
    },
  };
  assert.equal(
    inspectApplicationPublicInstalledProof(proof, installer, journey, expected).job_id,
    job.id,
  );
  for (const preservation of [
    null,
    {
      ...profile,
      library_root: "D:\\fixture\\installer\\library",
      before: journeyManifest,
      after: journeyManifest,
    },
    {
      ...profile,
      before: journeyManifest,
      after: {
        ...journeyManifest,
        preferences: { ...journeyManifest.preferences, sha256: "e".repeat(64) },
      },
    },
  ]) {
    const changed = {
      ...installer,
      details: { ...installer.details, journey_profile_preservation: preservation },
    };
    assert.throws(() =>
      inspectApplicationPublicInstalledProof(
        { ...proof, installer_sha256: digest(changed) },
        changed,
        journey,
        expected,
      ),
    );
  }
  for (const invalid of [
    { ...proof, completed_at: "2026-11-05T01:11:00Z" },
    { ...proof, stage_settlement: { ...proof.stage_settlement, disabled: false } },
    {
      ...proof,
      stage_settlement: { ...proof.stage_settlement, broker_job_remaining_pids: [31, 32] },
    },
    { ...proof, owner_teardown: { ...proof.owner_teardown, cleanup_failures: ["profile busy"] } },
    { ...proof, candidate: { release_id: 12 } },
  ])
    assert.throws(() =>
      inspectApplicationPublicInstalledProof(invalid, installer, journey, expected),
    );
  assert.throws(() =>
    inspectApplicationPublicInstalledProof(
      proof,
      installer,
      { ...journey, outcome: "parked" },
      expected,
    ),
  );
});

void test("post-feed Windows proof uses the read-only ordinary account path only for an admitted predecessor", async () => {
  const raw: unknown = parse(await readFile(".github/workflows/application-release.yml", "utf8"));
  assert.ok(isRecord(raw) && isRecord(raw.jobs));
  const job = raw.jobs.public_installed;
  assert.ok(isRecord(job) && isRecord(job.env));
  assert.equal(job["timeout-minutes"], 15);
  assert.deepEqual(job.permissions, { contents: "read", actions: "read", checks: "read" });
  assert.deepEqual(job.needs, ["source", "readback"]);
  assert.ok(typeof job.if === "string" && job.if.includes("windows_has_predecessor == 'true'"));
  assert.equal(job.env.PORTCOVE_WINDOWS_CANDIDATE_ATTEMPT, "${{ needs.readback.outputs.attempt }}");
  assert.ok(
    !Object.hasOwn(job.env, "PORTCOVE_SIGNING_KEY") &&
      !Object.hasOwn(job.env, "PORTCOVE_OBSERVER_TOKEN"),
  );
  const final = raw.jobs.public_installed_readback;
  assert.ok(isRecord(final) && isRecord(final.env) && isRecord(raw.jobs.readback));
  assert.deepEqual(final.needs, ["source", "tools", "readback", "public_installed"]);
  assert.deepEqual(final.permissions, job.permissions);
  assert.equal(final["timeout-minutes"], 2);
  assert.equal(
    raw.jobs.readback["timeout-minutes"],
    "${{ (inputs.mode == 'prepare' || inputs.mode == 'recover') && 3 || 5 }}",
  );
  assert.equal(
    final.env.PORTCOVE_WINDOWS_PROOF_ARTIFACT,
    "${{ needs.public_installed.outputs.artifact }}",
  );
  assert.equal(
    final.env.PORTCOVE_WINDOWS_PROOF_ATTEMPT,
    "${{ needs.public_installed.outputs.attempt }}",
  );
  assert.ok(
    typeof final.if === "string" && final.if.includes("needs.public_installed.result == 'success'"),
  );
});

void test("ordinary publication prepares actual inputs before a separate fresh observer and keeps signing credentials out of byte preparation", async () => {
  const raw: unknown = parse(await readFile(".github/workflows/application-release.yml", "utf8"));
  assert.ok(isRecord(raw) && isRecord(raw.jobs));
  const prep = raw.jobs.publication_prepare,
    observer = raw.jobs.protection_publication,
    publish = raw.jobs.publication;
  assert.ok(isRecord(prep) && isRecord(observer) && isRecord(publish));
  assert.equal(prep["timeout-minutes"], 3);
  assert.deepEqual(prep.permissions, {
    contents: "write",
    actions: "read",
    checks: "read",
    "id-token": "write",
    attestations: "write",
  });
  assert.ok(Array.isArray(prep.needs));
  for (const name of ["source", "tools", "assemble", "context", "package", "native", "payload"])
    assert.ok(prep.needs.includes(name));
  assert.ok(
    isRecord(prep.env) &&
      !Object.hasOwn(prep.env, "PORTCOVE_SIGNING_KEY") &&
      !Object.hasOwn(prep.env, "PORTCOVE_OBSERVER_TOKEN"),
  );
  const recoveryObserver = raw.jobs.protection_draft_recovery;
  assert.ok(isRecord(recoveryObserver) && isRecord(recoveryObserver.with));
  assert.equal(recoveryObserver.with.phase, "draft-recovery");
  assert.equal(recoveryObserver.with.timeout_minutes, 1);
  assert.ok(prep.needs.includes("protection_draft_recovery"));
  assert.ok(
    typeof prep.if === "string" &&
      prep.if.includes("needs.protection_draft_recovery.result == 'success'"),
  );
  assert.equal(prep.env.PORTCOVE_PROTECTION_PHASE, "draft-recovery");
  assert.ok(Array.isArray(observer.needs) && observer.needs.includes("publication_prepare"));
  assert.ok(
    Array.isArray(publish.needs) &&
      publish.needs.includes("publication_prepare") &&
      publish.needs.includes("protection_publication"),
  );
  assert.equal(publish["timeout-minutes"], "${{ inputs.mode == 'prepare' && 2 || 5 }}");
  assert.ok(Array.isArray(prep.steps));
  const steps = prep.steps.filter(isRecord);
  assert.ok(
    steps.some((step) => typeof step.run === "string" && step.run.endsWith(" publication-prepare")),
  );
  assert.ok(
    steps.some(
      (step) =>
        typeof step.uses === "string" &&
        step.uses.startsWith("actions/attest@") &&
        isRecord(step.with) &&
        step.with["subject-path"] === "work/application-draft-prepared/*.json",
    ),
  );
  assert.ok(
    !steps.some(
      (step) => typeof step.uses === "string" && step.uses.includes("create-github-app-token"),
    ),
  );
  const feedPrep = raw.jobs.feed_prepare,
    feedObserver = raw.jobs.protection_feed,
    feed = raw.jobs.feed;
  assert.ok(isRecord(feedPrep) && isRecord(feedObserver) && isRecord(feed));
  assert.equal(feedPrep["timeout-minutes"], 3);
  assert.ok(Array.isArray(feedPrep.needs) && feedPrep.needs.includes("publication"));
  assert.ok(Array.isArray(feedObserver.needs) && feedObserver.needs.includes("feed_prepare"));
  assert.ok(Array.isArray(feed.needs) && feed.needs.includes("protection_feed"));
  assert.ok(isRecord(feedPrep.permissions));
  assert.equal(feedPrep.permissions.contents, "read");
  assert.equal(feedPrep.permissions.pages, undefined);
  assert.equal(feedPrep.permissions["id-token"], undefined);
  assert.ok(Array.isArray(feedPrep.steps));
  const feedSteps = feedPrep.steps.filter(isRecord);
  const prepareIndex = feedSteps.findIndex(
    (step) => typeof step.run === "string" && step.run.endsWith(" prepare-feed"),
  );
  const uploadIndex = feedSteps.findIndex(
    (step) =>
      typeof step.uses === "string" && step.uses.startsWith("actions/upload-pages-artifact@"),
  );
  const captureIndex = feedSteps.findIndex(
    (step) => typeof step.run === "string" && step.run.endsWith(" capture-pages"),
  );
  const preflightIndex = feedSteps.findIndex(
    (step) => typeof step.run === "string" && step.run.endsWith(" site-preflight"),
  );
  assert.ok(
    prepareIndex >= 0 &&
      prepareIndex < uploadIndex &&
      uploadIndex < captureIndex &&
      captureIndex < preflightIndex,
  );
  assert.ok(
    !feedSteps.some(
      (step) => typeof step.uses === "string" && step.uses.includes("create-github-app-token"),
    ),
  );
  const sourceJob = raw.jobs.source,
    toolsJob = raw.jobs.tools,
    nativeJob = raw.jobs.native;
  assert.ok(isRecord(sourceJob) && isRecord(toolsJob) && isRecord(nativeJob));
  assert.ok(typeof sourceJob.if === "string" && sourceJob.if.includes("inputs.mode == 'recover'"));
  assert.ok(typeof toolsJob.if === "string" && toolsJob.if.includes("inputs.mode == 'recover'"));
  assert.ok(typeof nativeJob.if === "string" && !nativeJob.if.includes("recover"));
  assert.ok(
    typeof feedPrep.if === "string" &&
      feedPrep.if.includes("always()") &&
      feedPrep.if.includes("inputs.mode == 'recover'"),
  );
  assert.ok(typeof feedObserver.if === "string" && feedObserver.if.includes("always()"));
  assert.ok(typeof feed.if === "string" && feed.if.includes("always()"));
  assert.ok(isRecord(feedPrep.env) && !Object.hasOwn(feedPrep.env, "PORTCOVE_DRAFT_ARTIFACT"));
  for (const name of [
    "package",
    "payload",
    "context",
    "releases",
    "preview",
    "stable",
    "snapshot",
    "timestamp",
    "assemble",
    "publication_prepare",
    "publication",
  ]) {
    const job: unknown = raw.jobs[name];
    assert.ok(
      isRecord(job) && typeof job.if === "string" && !job.if.includes("inputs.mode == 'recover'"),
      name,
    );
  }
});

void test("metadata renewal traverses existing protected metadata jobs while excluding payload work and retaining its bounded publisher", async () => {
  const workflow: unknown = parse(
    await readFile(".github/workflows/application-release.yml", "utf8"),
  );
  assert.ok(isRecord(workflow) && isRecord(workflow.jobs));
  for (const name of [
    "source",
    "tools",
    "context",
    "protection_metadata",
    "releases",
    "preview",
    "stable",
    "protection_snapshot",
    "snapshot",
    "protection_timestamp",
    "timestamp",
    "assemble",
    "protection_publication",
    "publication",
    "feed_prepare",
    "protection_feed",
    "feed",
    "readback",
  ]) {
    const job: unknown = workflow.jobs[name];
    assert.ok(
      isRecord(job) && typeof job.if === "string" && job.if.includes("inputs.mode == 'renew'"),
      name,
    );
  }
  for (const name of [
    "package",
    "native",
    "protection_payload",
    "payload",
    "publication_prepare",
  ]) {
    const job: unknown = workflow.jobs[name];
    assert.ok(
      isRecord(job) && typeof job.if === "string" && !job.if.includes("inputs.mode == 'renew'"),
      name,
    );
  }
  const context = workflow.jobs.context,
    publisher = workflow.jobs.publication,
    source = workflow.jobs.source;
  assert.ok(
    isRecord(context) &&
      typeof context.if === "string" &&
      context.if.includes("always()") &&
      context.if.includes("needs.source.result == 'success'") &&
      context.if.includes("needs.tools.result == 'success'"),
  );
  assert.ok(
    isRecord(publisher) &&
      Array.isArray(publisher.needs) &&
      publisher.needs.includes("protection_publication"),
  );
  assert.equal(publisher["timeout-minutes"], "${{ inputs.mode == 'prepare' && 2 || 5 }}");
  assert.ok(
    Array.isArray(publisher.steps) &&
      publisher.steps
        .filter(isRecord)
        .some((step) => step.id === "feed" && step.if === "inputs.mode == 'bootstrap'"),
  );
  assert.ok(
    isRecord(source) &&
      Array.isArray(source.steps) &&
      source.steps
        .filter(isRecord)
        .some(
          (step) =>
            typeof step.if === "string" &&
            step.if.includes("inputs.mode == 'renew-unserved'") &&
            step.if.includes("inputs.mode == 'recover-metadata'") &&
            typeof step.run === "string" &&
            step.run.includes("bb766f710eef8ede859c18578c72c327597cd4c8a85b06001b1f3843c6019386"),
        ),
  );
});

void test("metadata recovery reaches only current feed staging and guarded deployment with no publisher-artifact dependency", async () => {
  const workflow: unknown = parse(
    await readFile(".github/workflows/application-release.yml", "utf8"),
  );
  assert.ok(isRecord(workflow) && isRecord(workflow.jobs));
  for (const name of ["source", "tools", "feed_prepare", "protection_feed", "feed", "readback"]) {
    const job: unknown = workflow.jobs[name];
    assert.ok(
      isRecord(job) &&
        typeof job.if === "string" &&
        job.if.includes("inputs.mode == 'recover-metadata'"),
      name,
    );
  }
  for (const name of [
    "package",
    "native",
    "payload",
    "context",
    "releases",
    "preview",
    "stable",
    "snapshot",
    "timestamp",
    "assemble",
    "publication_prepare",
    "publication",
  ]) {
    const job: unknown = workflow.jobs[name];
    assert.ok(
      isRecord(job) &&
        typeof job.if === "string" &&
        !job.if.includes("inputs.mode == 'recover-metadata'"),
      name,
    );
  }
  const prep = workflow.jobs.feed_prepare;
  assert.ok(
    isRecord(prep) &&
      typeof prep.if === "string" &&
      prep.if.includes("always()") &&
      prep.if.includes("needs.source.result == 'success'") &&
      prep.if.includes("needs.tools.result == 'success'") &&
      Array.isArray(prep.steps),
  );
  const stages = prep.steps.filter(isRecord);
  for (const id of ["ordinary_feed", "ordinary_pages"])
    assert.ok(
      stages.some(
        (step) =>
          step.id === id &&
          typeof step.if === "string" &&
          step.if.includes("inputs.mode == 'renew'") &&
          step.if.includes("inputs.mode == 'recover-metadata'"),
      ),
      id,
    );
  const preflight = stages.find((step) => step.id === "worker");
  assert.ok(preflight && isRecord(preflight.env));
  assert.equal(
    preflight.env.PORTCOVE_PAGES_ARTIFACT,
    "${{ (inputs.mode == 'prepare' || (inputs.mode == 'renew' || inputs.mode == 'renew-unserved') || (inputs.mode == 'recover' || inputs.mode == 'recover-metadata')) && steps.ordinary_pages.outputs.artifact_id || needs.publication.outputs.pages_artifact }}",
  );
});

void test("expired-unserved renewal uses existing metadata roles and source admission, never payload jobs", async () => {
  const workflow: unknown = parse(
    await readFile(".github/workflows/application-release.yml", "utf8"),
  );
  assert.ok(isRecord(workflow) && isRecord(workflow.jobs));
  for (const name of [
    "source",
    "tools",
    "context",
    "releases",
    "preview",
    "stable",
    "snapshot",
    "timestamp",
    "assemble",
    "protection_publication",
    "publication",
    "feed_prepare",
    "protection_feed",
    "feed",
    "readback",
  ]) {
    const job: unknown = workflow.jobs[name];
    assert.ok(
      isRecord(job) &&
        typeof job.if === "string" &&
        job.if.includes("inputs.mode == 'renew-unserved'"),
      name,
    );
  }
  for (const name of ["package", "native", "payload", "publication_prepare"]) {
    const job: unknown = workflow.jobs[name];
    assert.ok(
      isRecord(job) &&
        typeof job.if === "string" &&
        !job.if.includes("inputs.mode == 'renew-unserved'"),
      name,
    );
  }
  const source = workflow.jobs.source;
  assert.ok(isRecord(source) && Array.isArray(source.steps));
  const selection = source.steps.filter(isRecord).find((step) => step.id === "prepare");
  assert.ok(selection && isRecord(selection.env));
  assert.equal(
    selection.env.PORTCOVE_APPLICATION_PENDING_OPPORTUNITY,
    "${{ inputs.pending_opportunity }}",
  );
  assert.ok(
    typeof selection.env.PORTCOVE_SOURCE_OPERATION === "string" &&
      selection.env.PORTCOVE_SOURCE_OPERATION.includes(
        "inputs.mode == 'renew-unserved' && 'renew-unserved'",
      ),
  );
});

void test("reviewed Preview withdrawal keeps the exact release and Stable bytes and refuses wrong preimages or source classification", async () => {
  const f = await recordContextFixture();
  const promotion = f.old.manifest.records.find((record) => record.kind === "promotion")!;
  const release = f.old.manifest.records.find((record) => record.kind === "release")!;
  const request = {
    promotion_path: promotion.path,
    promotion_sha256: promotion.sha256,
    release_path: release.path,
    release_sha256: release.sha256,
    reason: "Controlled forward repair",
  };
  const classification = { ...f.input.classification, preview_withdrawals: [request] };
  const result = await composeApplicationRecordContext(f.prior, f.descriptor, {
    ...f.input,
    classification,
  });
  assert.equal(result.withdrawals, 1);
  assert.ok(result.files.get(`records/${release.path}`)?.equals(f.old.files.get(release.path)!));
  assert.ok(
    result.files
      .get("prior/metadata/1.stable.json")
      ?.equals(f.prior.get("prior/metadata/1.stable.json")!),
  );
  const withdrawn = JSON.parse(result.files.get(`records/${promotion.path}`)!.toString("utf8")) as {
    eligible: boolean;
    withdrawn: boolean;
  };
  assert.equal(withdrawn.eligible, false);
  assert.equal(withdrawn.withdrawn, true);
  await assert.rejects(
    composeApplicationRecordContext(f.prior, f.descriptor, {
      ...f.input,
      classification: {
        ...classification,
        preview_withdrawals: [{ ...request, promotion_sha256: "0".repeat(64) }],
      },
    }),
    /prior record bytes differ/u,
  );
  await assert.rejects(
    composeApplicationRecordContext(f.prior, f.descriptor, {
      ...f.input,
      qualification: { ...f.input.qualification, workflow_commit: "0".repeat(40) },
    }),
  );
  const bad = new Map(f.prior);
  bad.set("payload.json", Buffer.from("{}"));
  await assert.rejects(composeApplicationRecordContext(bad, f.descriptor, f.input));
});

void test("JSON receipt cannot appoint an authenticated prior or create an application context", async () => {
  const f = await recordContextFixture();
  const root = await mkdtemp(path.join(tmpdir(), "application-prior-refusal-"));
  const output = path.join(root, "context");
  try {
    await assert.rejects(
      prepareApplicationReleaseContext(
        output,
        {
          kind: "authenticated-metadata-renewal-preparation",
          descriptor_sha256: "a".repeat(64),
          input_manifest_sha256: "b".repeat(64),
        },
        f.input,
      ),
      /not prepared/u,
    );
    await assert.rejects(readFile(path.join(output, "context.json")), { code: "ENOENT" });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

void test("context reservations keep write credentials in the key-free job and preserve native cost identity", async () => {
  const raw: unknown = parse(await readFile(".github/workflows/application-release.yml", "utf8"));
  assert.ok(isRecord(raw) && isRecord(raw.jobs) && isRecord(raw.jobs.context));
  const context = raw.jobs.context;
  assert.equal(context.name, "context / execute");
  assert.equal(context["timeout-minutes"], 2);
  assert.equal(context.environment, "production-release-admission");
  assert.deepEqual(context.permissions, { contents: "write", actions: "read", checks: "read" });
  assert.equal(context.uses, undefined);
  assert.ok(
    isRecord(context.env) &&
      !Object.hasOwn(context.env, "PORTCOVE_SIGNING_KEY") &&
      !Object.hasOwn(context.env, "PORTCOVE_OBSERVER_TOKEN"),
  );
  assert.ok(Array.isArray(context.steps));
  const steps = context.steps.filter(isRecord);
  const prepare = steps.findIndex(
    (step) => step.run === "node scripts/application-release-private.bundle.mjs context",
  );
  const upload = steps.findIndex((step) => step.id === "context_upload");
  assert.ok(prepare >= 0 && upload > prepare);
  assert.ok(steps.every((step) => !JSON.stringify(step).includes("secrets.")));
  const privateRaw: unknown = parse(
    await readFile(".github/workflows/application-release-private.yml", "utf8"),
  );
  assert.ok(isRecord(privateRaw) && isRecord(privateRaw.permissions));
  assert.equal(privateRaw.permissions.contents, "read");
  for (const name of ["releases", "preview", "stable", "snapshot", "timestamp", "payload"]) {
    const job: unknown = raw.jobs[name];
    assert.ok(isRecord(job) && isRecord(job.permissions));
    assert.equal(job.permissions.contents, "read", name);
  }
});
