import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import test from "node:test";
import { nativeQualificationFixture } from "./fixtures/native-qualification-fixture.mts";
import {
  collectNativeReleaseQualification,
  prepareNativeQualificationCheck,
  verifiedNativeReleaseQualification,
} from "./release-native-acceptance.mts";
import type { GitHubRestReader } from "./github-api.mts";
import {
  nativePrepublicationProfile,
  nativePrepublicationPending,
  nativePrepublicationScenarios,
  nativeInitialPackageScenarios,
  nativeEmptyRecordsSha256,
} from "./release-native-qualification-contract.mts";

function fixture(
  stage: "payload-signing" | "release-publication" = "payload-signing",
  temporal = false,
  initial = false,
) {
  const harnessBytes = Buffer.from("inert native fixture source\n"),
    input = nativeQualificationFixture(stage);
  input.producer.harness.sha256 = createHash("sha256").update(harnessBytes).digest("hex");
  const prepared = prepareNativeQualificationCheck(
    temporal
      ? {
          ...input,
          schema_version: 2,
          native_prepublication_profile: nativePrepublicationProfile,
          pending_obligations: [...nativePrepublicationPending],
          ...(initial
            ? {
                journey: {
                  kind: "initial-empty-feed",
                  metadata_bootstrap_sha256: "5".repeat(64),
                  setup_plan_sha256: "6".repeat(64),
                  initial_site_preimage_sha256: "7".repeat(64),
                  empty_records_sha256: nativeEmptyRecordsSha256,
                  signed_context_sha256: "8".repeat(64),
                  signatures_sha256: "9".repeat(64),
                },
              }
            : {}),
          scenarios: (initial ? nativeInitialPackageScenarios : nativePrepublicationScenarios).map(
            (name, index) => ({
              ...input.scenarios[index],
              name,
            }),
          ),
        }
      : input,
  );
  const report = prepared.report;
  const { started_at: _started, ...producer } = report.producer;
  const expected = {
    schema_version: report.schema_version,
    ...(temporal ? { native_prepublication_profile: nativePrepublicationProfile } : {}),
    check_id: 987,
    native_app_id: 111,
    semantic_app_id: 112,
    classification_app_id: 113,
    stage,
    platform_label: report.platform_label,
    candidate: report.candidate,
    producer,
    host: {
      machine_id_sha256: report.host.machine_id_sha256,
      qualification_profile: report.host.qualification_profile,
      minimum_platform: report.host.minimum_platform,
      account: report.host.account,
      engine: { name: "WebView2", minimum_version: "145.0.0.0" },
    },
    compatibility: report.compatibility,
    journey: report.journey,
  };
  const check = { ...prepared.body, id: 987, app: { id: 111 }, check_suite: { id: 456 } };
  const suite = {
    id: 456,
    app: { id: 111 },
    head_sha: report.candidate.source_commit,
    repository: { id: 1354613114, full_name: "boburning/portcove" },
  };
  const calls: string[] = [];
  const api: GitHubRestReader = {
    request(method, endpoint) {
      assert.equal(method, "GET");
      calls.push(endpoint);
      return {
        status: 200,
        headers: new Map(),
        body: endpoint.includes("check-runs/")
          ? check
          : endpoint.includes("check-suites/")
            ? suite
            : endpoint.includes("/contents/")
              ? {
                  type: "file",
                  path: report.producer.harness.path,
                  encoding: "base64",
                  size: harnessBytes.length,
                  content: harnessBytes.toString("base64"),
                  sha: createHash("sha1")
                    .update(Buffer.from(`blob ${harnessBytes.length}\0`))
                    .update(harnessBytes)
                    .digest("hex"),
                }
              : endpoint.endsWith(report.producer.source_commit)
                ? { sha: report.producer.source_commit, tree: { sha: report.producer.source_tree } }
                : {
                    sha: report.candidate.source_commit,
                    tree: { sha: report.candidate.source_tree },
                  },
      };
    },
  };
  return { expected, check, suite, calls, api, prepared, harnessBytes };
}
void test("injected native Check traversal binds exact distinct stage/producer/package and never mints acceptance", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "native-consumer-inert-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  for (const stage of ["payload-signing", "release-publication"] as const) {
    const f = fixture(stage),
      receipt = await collectNativeReleaseQualification(root, f.expected, { api: f.api });
    assert.equal(receipt.evidence_scope, "injected-provider");
    assert.equal(receipt.stage, stage);
    assert.equal(f.calls.length, 7);
    assert.notEqual(
      f.prepared.report.candidate.source_commit,
      f.prepared.report.producer.source_commit,
    );
    assert.equal((await readdir(receipt.directory)).length, 11);
    const report: unknown = JSON.parse(
      await readFile(path.join(receipt.directory, "report.json"), "utf8"),
    );
    assert.deepEqual(report, f.prepared.report);
    await assert.rejects(verifiedNativeReleaseQualification(receipt), /actual provider/u);
    await assert.rejects(
      verifiedNativeReleaseQualification(JSON.parse(JSON.stringify(receipt)) as object),
      /actual provider/u,
    );
  }
});
void test("schema2 native Check consumer requires independently selected exact temporal profile and never upgrades legacy expectations", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "native-temporal-inert-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const f = fixture("release-publication", true);
  assert.match(f.check.external_id, /^portcove-native-qualification-v2:/u);
  const receipt = await collectNativeReleaseQualification(root, f.expected, { api: f.api });
  assert.equal(receipt.evidence_scope, "injected-provider");
  await assert.rejects(verifiedNativeReleaseQualification(receipt), /actual provider/u);
  const { native_prepublication_profile: _profile, ...base } = f.expected;
  await assert.rejects(
    collectNativeReleaseQualification(root, { ...base, schema_version: 1 }, { api: f.api }),
    /native qualification refused/u,
  );
  for (const changed of [
    { ...f.expected, native_prepublication_profile: "caller-profile" },
    { ...f.expected, stage: "payload-signing", journey: null },
    { ...f.expected, journey: { ...f.expected.journey, signed_context_sha256: "0".repeat(64) } },
  ])
    await assert.rejects(collectNativeReleaseQualification(root, changed, { api: f.api }));
});
void test("initial native Check binds fixed caller bootstrap expectation and cannot satisfy ordinary predecessor expectation", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "native-initial-inert-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const f = fixture("release-publication", true, true);
  const receipt = await collectNativeReleaseQualification(root, f.expected, { api: f.api });
  assert.equal(receipt.evidence_scope, "injected-provider");
  await assert.rejects(verifiedNativeReleaseQualification(receipt), /actual provider/u);
  const ordinary = fixture("release-publication", true);
  await assert.rejects(
    collectNativeReleaseQualification(
      root,
      { ...f.expected, journey: ordinary.expected.journey },
      { api: f.api },
    ),
  );
  if (!f.expected.journey || !("kind" in f.expected.journey))
    throw new Error("fixture initial journey missing");
  await assert.rejects(
    collectNativeReleaseQualification(
      root,
      {
        ...f.expected,
        journey: { ...f.expected.journey, metadata_bootstrap_sha256: "0".repeat(64) },
      },
      { api: f.api },
    ),
  );
});
void test("native Check accepts provider timestamp normalization but refuses wrong issuer, inputs and incomplete capture", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "native-consumer-refusals-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const normalized = fixture();
  normalized.check.started_at = normalized.check.started_at.replace(".000Z", "Z");
  normalized.check.completed_at = normalized.check.completed_at.replace(".000Z", "Z");
  assert.equal(
    (await collectNativeReleaseQualification(root, normalized.expected, { api: normalized.api }))
      .evidence_scope,
    "injected-provider",
  );
  const changes: ((f: ReturnType<typeof fixture>) => void)[] = [
    (f) => {
      f.check.app.id = 112;
    },
    (f) => {
      f.check.conclusion = "failure";
    },
    (f) => {
      f.check.head_sha = "0".repeat(40);
    },
    (f) => {
      f.check.external_id += "changed";
    },
    (f) => {
      f.suite.app.id = 112;
    },
    (f) => {
      f.suite.repository.id = 1;
    },
    (f) => {
      f.expected.candidate.package.sha256 = "0".repeat(64);
    },
    (f) => {
      f.expected.producer.invocation_id = "0".repeat(64);
    },
    (f) => {
      f.expected.host.account.qualification = "S-1-5-21-1002";
    },
    (f) => {
      f.expected.host.engine.minimum_version = "146.0.0.0";
    },
    (f) => {
      const report = nativeQualificationFixture();
      report.runtime.teardown.tree_empty = false;
      f.check.output.summary = JSON.stringify({
        schema_version: 1,
        report_sha256: "a".repeat(64),
        report,
      });
    },
  ];
  for (const change of changes) {
    const f = fixture();
    change(f);
    await assert.rejects(
      collectNativeReleaseQualification(root, f.expected, { api: f.api }),
      /retain/u,
    );
  }
});
void test("native consumer freezes inputs, refuses provider drift and preserves sanitized partial proof", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "native-consumer-drift-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const frozen = fixture();
  const api: GitHubRestReader = {
    request(method, endpoint) {
      const result = frozen.api.request(method, endpoint);
      if (frozen.calls.length === 1) frozen.expected.check_id = 123;
      return result;
    },
  };
  assert.equal(
    (await collectNativeReleaseQualification(root, frozen.expected, { api })).check_id,
    987,
  );
  const drift = fixture();
  const changed: GitHubRestReader = {
    request(method, endpoint) {
      if (drift.calls.length === 5) drift.check.conclusion = "cancelled";
      return drift.api.request(method, endpoint);
    },
  };
  await assert.rejects(
    collectNativeReleaseQualification(root, drift.expected, { api: changed }),
    /retain/u,
  );
  const secret = "sentinel-secret-must-not-be-retained";
  const failing: GitHubRestReader = {
    request() {
      throw new Error(secret);
    },
  };
  let directory = "";
  try {
    await collectNativeReleaseQualification(root, fixture().expected, { api: failing });
  } catch (error) {
    assert.ok(error instanceof Error);
    directory = error.message.split("retain ")[1]!;
  }
  assert.ok(path.isAbsolute(directory));
  const evidence = await readFile(path.join(directory, "failure.json"), "utf8");
  assert.equal(evidence.includes(secret), false);
  assert.equal((await readdir(directory)).includes("expected.json"), true);
});
void test("native expectation rejects extra metadata and conflated issuers before any API or owned output", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "native-consumer-schema-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  for (const mutate of [
    (f: ReturnType<typeof fixture>) => {
      Object.assign(f.expected, { secret: "extra" });
    },
    (f: ReturnType<typeof fixture>) => {
      f.expected.native_app_id = f.expected.semantic_app_id;
    },
    (f: ReturnType<typeof fixture>) => {
      Object.assign(f.expected.producer, { accepted: true });
    },
  ]) {
    const f = fixture();
    mutate(f);
    await assert.rejects(collectNativeReleaseQualification(root, f.expected, { api: f.api }));
    assert.equal(f.calls.length, 0);
    assert.deepEqual(await readdir(root), []);
  }
});
void test("actual default REST branch pins github.com and bounded scrubbed transport under ambient host/config", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "native-consumer-transport-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const f = fixture(),
    previous = process.env.GH_HOST;
  process.env.GH_HOST = "ambient.invalid";
  t.after(() => {
    if (previous === undefined) delete process.env.GH_HOST;
    else process.env.GH_HOST = previous;
  });
  let calls = 0;
  const receipt = await collectNativeReleaseQualification(root, f.expected, {
    spawn: (_command, args, settings) => {
      calls++;
      assert.equal(args[0], "api");
      assert.equal(args[args.indexOf("--hostname") + 1], "github.com");
      assert.equal(args[args.indexOf("--method") + 1], "GET");
      assert.equal(settings.maxBuffer, 512 * 1024);
      assert.equal(settings.timeout, 15000);
      assert.equal(settings.env?.GH_HOST, "github.com");
      assert.equal(settings.env?.NODE_OPTIONS, undefined);
      assert.equal(settings.env?.HTTPS_PROXY, undefined);
      assert.ok(String(settings.env?.HOME).startsWith(root));
      const endpoint = args.find((part) => part.startsWith("repos/boburning/portcove/"));
      assert.ok(endpoint);
      const body = f.api.request("GET", endpoint).body;
      return {
        status: 0,
        stdout: `HTTP/2.0 200 OK\r\nContent-Type: application/json\r\n\r\n${JSON.stringify(body)}`,
        stderr: "",
      };
    },
  });
  assert.equal(calls, 7);
  assert.equal(receipt.evidence_scope, "injected-provider");
  await assert.rejects(verifiedNativeReleaseQualification(receipt), /actual provider/u);
});
void test("Checks wire uses documented whole seconds without changing fractional native capture or digest", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "native-consumer-seconds-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const report = nativeQualificationFixture();
  report.producer.started_at = "2026-10-20T11:59:59.123Z";
  report.runtime.teardown.completed_at = "2026-10-20T12:00:06.321Z";
  const prepared = prepareNativeQualificationCheck(report);
  assert.equal(prepared.body.started_at, "2026-10-20T11:59:59Z");
  assert.equal(prepared.body.completed_at, "2026-10-20T12:00:06Z");
  assert.equal(prepared.report.producer.started_at, report.producer.started_at);
  assert.equal(prepared.report.runtime.teardown.completed_at, report.runtime.teardown.completed_at);
  const f = fixture();
  report.producer.harness.sha256 = f.prepared.report.producer.harness.sha256;
  const boundPrepared = prepareNativeQualificationCheck(report);
  Object.assign(f.check, boundPrepared.body);
  const receipt = await collectNativeReleaseQualification(root, f.expected, { api: f.api });
  assert.equal(receipt.evidence_scope, "injected-provider");
  assert.equal(receipt.report_sha256, boundPrepared.body.external_id.split(":")[1]);
  f.check.completed_at = "2026-10-20T12:00:07Z";
  await assert.rejects(
    collectNativeReleaseQualification(root, f.expected, { api: f.api }),
    /retain/u,
  );
});
void test("native source closure refuses changed or incomplete exact harness bytes and partial provider reads", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "native-consumer-source-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  for (const patch of [
    { content: Buffer.from("changed harness\n").toString("base64") },
    { content: "@@malformed@@" },
    { sha: "0".repeat(40) },
    { path: "scripts/other.ps1" },
    { size: 256 * 1024 + 1 },
  ]) {
    const f = fixture();
    const api: GitHubRestReader = {
      request(method, endpoint) {
        const response = f.api.request(method, endpoint);
        if (endpoint.includes("/contents/")) Object.assign(response.body as object, patch);
        return response;
      },
    };
    await assert.rejects(collectNativeReleaseQualification(root, f.expected, { api }), /retain/u);
  }
  const f = fixture();
  await assert.rejects(
    collectNativeReleaseQualification(root, f.expected, {
      api: {
        request() {
          return { status: 404, headers: new Map(), body: null };
        },
      },
    }),
    /retain/u,
  );
  await assert.rejects(
    collectNativeReleaseQualification(root, f.expected, {
      spawn: () => ({
        status: null,
        stdout: "",
        stderr: "never-retain-token",
        error: Object.assign(new Error("overflow"), { code: "ENOBUFS" }),
      }),
    }),
    /retain/u,
  );
});
void test("native collector preserves a caller phase deadline before and after actual default transport", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "native-consumer-deadline-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const f = fixture();
  let calls = 0;
  const spawn: NonNullable<Parameters<typeof collectNativeReleaseQualification>[2]>["spawn"] = (
    _command,
    args,
    settings,
  ) => {
    calls++;
    assert.ok(
      typeof settings.timeout === "number" && settings.timeout > 0 && settings.timeout <= 50,
    );
    const endpoint = args.find((part) => part.startsWith("repos/boburning/portcove/"));
    assert.ok(endpoint);
    const body = f.api.request("GET", endpoint).body;
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 65);
    return { status: 0, stderr: "", stdout: `HTTP/2.0 200 OK\r\n\r\n${JSON.stringify(body)}` };
  };
  await assert.rejects(
    collectNativeReleaseQualification(root, f.expected, { deadline: performance.now() - 1, spawn }),
    /deadline/u,
  );
  assert.equal(calls, 0);
  assert.deepEqual(await readdir(root), []);
  await assert.rejects(
    collectNativeReleaseQualification(root, f.expected, {
      deadline: performance.now() + 50,
      spawn,
    }),
    /retain/u,
  );
  assert.equal(calls, 1);
});
