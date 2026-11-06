import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
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
import { withCoordinatorDeadline } from "./release-coordinator-deadline.mts";
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
  fixedWorker = false,
) {
  const harnessBytes = Buffer.from("inert native fixture source\n"),
    input = nativeQualificationFixture(stage);
  if (fixedWorker) input.producer.harness.path = "scripts/release-native-worker.mts";
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
  const read = async (route: string) => {
    const endpoint = `repos/boburning/portcove/${route}`;
    calls.push(endpoint);
    return endpoint.includes("check-runs/")
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
              };
  };
  return { expected, check, suite, calls, read, prepared, harnessBytes };
}
void test("fixed maintained Node worker report traverses the exact harness source route without widening script selection", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "native-worker-consumer-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const f = fixture("payload-signing", false, false, true);
  const receipt = await collectNativeReleaseQualification(root, f.expected, { read: f.read });
  assert.equal(receipt.evidence_scope, "injected-provider");
  assert.ok(
    f.calls.includes(
      `repos/boburning/portcove/contents/scripts/release-native-worker.mts?ref=${f.expected.producer.source_commit}`,
    ),
  );
  for (const path of [
    "scripts/other-worker.mts",
    "scripts/release-native-worker.mjs",
    "scripts/sub/release-native-worker.mts",
    "scripts/../release-native-worker.mts",
  ])
    assert.throws(
      () =>
        prepareNativeQualificationCheck({
          ...f.prepared.report,
          producer: {
            ...f.prepared.report.producer,
            harness: { ...f.prepared.report.producer.harness, path },
          },
        }),
      /harness path/,
    );
});
void test("injected native Check traversal binds exact distinct stage/producer/package and never mints acceptance", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "native-consumer-inert-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  for (const stage of ["payload-signing", "release-publication"] as const) {
    const f = fixture(stage),
      receipt = await collectNativeReleaseQualification(root, f.expected, { read: f.read });
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
  const receipt = await collectNativeReleaseQualification(root, f.expected, { read: f.read });
  assert.equal(receipt.evidence_scope, "injected-provider");
  await assert.rejects(verifiedNativeReleaseQualification(receipt), /actual provider/u);
  const { native_prepublication_profile: _profile, ...base } = f.expected;
  await assert.rejects(
    collectNativeReleaseQualification(root, { ...base, schema_version: 1 }, { read: f.read }),
    /native qualification refused/u,
  );
  for (const changed of [
    { ...f.expected, native_prepublication_profile: "caller-profile" },
    { ...f.expected, stage: "payload-signing", journey: null },
    { ...f.expected, journey: { ...f.expected.journey, signed_context_sha256: "0".repeat(64) } },
  ])
    await assert.rejects(collectNativeReleaseQualification(root, changed, { read: f.read }));
});
void test("initial native Check binds fixed caller bootstrap expectation and cannot satisfy ordinary predecessor expectation", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "native-initial-inert-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const f = fixture("release-publication", true, true);
  const receipt = await collectNativeReleaseQualification(root, f.expected, { read: f.read });
  assert.equal(receipt.evidence_scope, "injected-provider");
  await assert.rejects(verifiedNativeReleaseQualification(receipt), /actual provider/u);
  const ordinary = fixture("release-publication", true);
  await assert.rejects(
    collectNativeReleaseQualification(
      root,
      { ...f.expected, journey: ordinary.expected.journey },
      { read: f.read },
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
      { read: f.read },
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
    (await collectNativeReleaseQualification(root, normalized.expected, { read: normalized.read }))
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
      collectNativeReleaseQualification(root, f.expected, { read: f.read }),
      /retain/u,
    );
  }
});
void test("native consumer freezes inputs, refuses provider drift and preserves sanitized partial proof", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "native-consumer-drift-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const frozen = fixture();
  const read = async (route: string) => {
    const result = await frozen.read(route);
    if (frozen.calls.length === 1) frozen.expected.check_id = 123;
    return result;
  };
  assert.equal(
    (await collectNativeReleaseQualification(root, frozen.expected, { read })).check_id,
    987,
  );
  const drift = fixture();
  const changed = async (route: string) => {
    if (drift.calls.length === 5) drift.check.conclusion = "cancelled";
    return drift.read(route);
  };
  await assert.rejects(
    collectNativeReleaseQualification(root, drift.expected, { read: changed }),
    /retain/u,
  );
  const secret = "sentinel-secret-must-not-be-retained";
  const failing = async () => {
    throw new Error(secret);
  };
  let directory = "";
  try {
    await collectNativeReleaseQualification(root, fixture().expected, { read: failing });
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
    await assert.rejects(collectNativeReleaseQualification(root, f.expected, { read: f.read }));
    assert.equal(f.calls.length, 0);
    assert.deepEqual(await readdir(root), []);
  }
});
function nativeReaderEnvironment(t: test.TestContext) {
  const previous = { ...process.env };
  process.env.GH_HOST = "ambient.invalid";
  process.env.GH_TOKEN = "fixed-native-check-reader";
  t.after(() => {
    for (const key of ["GH_HOST", "GH_TOKEN"])
      if (previous[key] === undefined) delete process.env[key];
      else process.env[key] = previous[key];
  });
}
void test("actual locked SDK default binds exact Check, suite and immutable sources then awaits retained readback", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "native-consumer-transport-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  nativeReaderEnvironment(t);
  const f = fixture();
  let tamper: string | undefined;
  const fetcher: typeof globalThis.fetch = async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : input);
    assert.equal(url.origin, "https://api.github.com");
    assert.equal(init?.method, "GET");
    assert.equal(init.redirect, "manual");
    assert.equal(new Headers(init.headers).get("authorization"), "token fixed-native-check-reader");
    assert.ok(url.pathname.startsWith("/repos/boburning/portcove/"));
    if (tamper && url.pathname.endsWith("/check-suites/456")) await writeFile(tamper, "{}");
    process.env.GH_TOKEN = "unrelated-rotated-token";
    return Response.json(
      await f.read(url.pathname.slice("/repos/boburning/portcove/".length) + url.search),
    );
  };
  t.mock.method(globalThis, "fetch", fetcher);
  const receipt = await collectNativeReleaseQualification(root, f.expected);
  assert.equal(receipt.evidence_scope, "github.com");
  assert.equal(f.calls.length, 7);
  const result = await verifiedNativeReleaseQualification(receipt);
  assert.equal(result.check?.id, f.expected.check_id);
  assert.deepEqual(
    f.calls.map((endpoint) => endpoint.replace("repos/boburning/portcove/", "")),
    [
      "check-runs/987",
      "check-suites/456",
      `git/commits/${f.expected.producer.source_commit}`,
      `git/commits/${f.expected.candidate.source_commit}`,
      `contents/${f.expected.producer.harness.path}?ref=${f.expected.producer.source_commit}`,
      "check-runs/987",
      "check-suites/456",
      "check-runs/987",
      "check-suites/456",
    ],
  );
  const [directory] = await readdir(root);
  const retained = path.join(root, directory!, "expected.json");
  const original = await readFile(retained);
  tamper = retained;
  await assert.rejects(
    verifiedNativeReleaseQualification(receipt),
    /native retained proof changed/u,
  );
  tamper = undefined;
  await writeFile(retained, original);
  f.check.conclusion = "cancelled";
  await assert.rejects(verifiedNativeReleaseQualification(receipt));
  await assert.rejects(
    verifiedNativeReleaseQualification(structuredClone(receipt)),
    /actual provider/u,
  );
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
  const receipt = await collectNativeReleaseQualification(root, f.expected, { read: f.read });
  assert.equal(receipt.evidence_scope, "injected-provider");
  assert.equal(receipt.report_sha256, boundPrepared.body.external_id.split(":")[1]);
  f.check.completed_at = "2026-10-20T12:00:07Z";
  await assert.rejects(
    collectNativeReleaseQualification(root, f.expected, { read: f.read }),
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
    const read = async (route: string) => {
      const body = await f.read(route);
      if (route.startsWith("contents/")) Object.assign(body, patch);
      return body;
    };
    await assert.rejects(collectNativeReleaseQualification(root, f.expected, { read }), /retain/u);
  }
});
void test("locked native provider refuses HTTP failures, metadata overflow and an inherited deadline through a stalled body", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "native-consumer-deadline-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  nativeReaderEnvironment(t);
  const keepAlive = setInterval(() => {}, 1000);
  t.after(() => clearInterval(keepAlive));
  const f = fixture();
  await assert.rejects(
    collectNativeReleaseQualification(root, f.expected, { deadline: performance.now() - 1 }),
    /deadline/u,
  );
  await assert.rejects(
    withCoordinatorDeadline(performance.now() + 5000, () =>
      collectNativeReleaseQualification(root, f.expected, { deadline: Infinity }),
    ),
    /deadline/u,
  );
  assert.deepEqual(await readdir(root), []);
  for (const fault of ["http", "limit", "stall"] as const) {
    let calls = 0;
    let cancelled = false;
    const mock = t.mock.method(globalThis, "fetch", async () => {
      calls++;
      if (fault === "http") return Response.json(null, { status: 404 });
      if (fault === "limit") return Response.json("x".repeat(512 * 1024));
      return new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(new Uint8Array([123]));
          },
          cancel() {
            cancelled = true;
          },
        }),
        { headers: { "content-type": "application/json" } },
      );
    });
    try {
      await assert.rejects(
        withCoordinatorDeadline(performance.now() + (fault === "stall" ? 350 : 5000), () =>
          collectNativeReleaseQualification(root, f.expected, {
            deadline: performance.now() + 10000,
          }),
        ),
        /retain/u,
      );
      assert.equal(calls, 1);
      if (fault === "stall") assert.ok(cancelled);
    } finally {
      mock.mock.restore();
    }
  }
});
