import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { performance } from "node:perf_hooks";
import { isRecord } from "./runtime-values.mts";
import { classifyChanges } from "./ordinary-validation.mts";
import {
  inspectNativePreSignReadiness,
  waitForNativePreSignReadiness,
  waitForOriginalPayloadNativeProof,
} from "./release-native-presign-readiness.mts";
import { hostedNativeJobProfile } from "./assembler-job-identity.mts";
import { hostedNativeArtifactName } from "./release-hosted-native-artifact.mts";

void test("the pre-sign scheduling source retains its direct ordinary contract", () => {
  const file = "scripts/release-native-presign-readiness.mts";
  for (const change of [
    { status: "M", path: file },
    { status: "A", path: file },
    { status: "D", path: file },
    { status: "R100", previousPath: file, path: "docs/moved.md" },
    { status: "R100", previousPath: "docs/moved.md", path: file },
  ]) {
    const selected = classifyChanges([change], { fileExists: () => false });
    assert.ok(selected.nodeTests.has("scripts/release-native-presign-readiness.test.mts"));
  }
});
const run = "123",
  revision = "a".repeat(40);
function parseRecord(raw: string) {
  const value: unknown = JSON.parse(raw);
  assert.ok(isRecord(value));
  return value;
}
void test("legacy payload and unrelated fixed-job phases skip hosted waiting after source recheck", async () => {
  let checks = 0;
  for (const route of [
    { phase: "payload", credential_transport: "legacy-app" },
    { phase: "coordinator", credential_transport: "fixed-job" },
  ]) {
    await waitForOriginalPayloadNativeProof({
      route,
      recheck() {
        checks++;
      },
    } as unknown as Parameters<typeof waitForOriginalPayloadNativeProof>[0]);
  }
  assert.equal(checks, 2);
  await assert.rejects(
    waitForOriginalPayloadNativeProof({
      recheck() {
        throw Error("source refused");
      },
    } as unknown as Parameters<typeof waitForOriginalPayloadNativeProof>[0]),
    /source refused/u,
  );
});
function fixture() {
  const jobs = (["windows-x86_64", "linux-x86_64"] as const).map((platform, index) => ({
    id: index + 1,
    name: hostedNativeJobProfile(platform).job,
    run_id: 123,
    run_attempt: 1,
    head_sha: revision,
    status: "in_progress",
    conclusion: null as string | null,
  }));
  const artifacts = (["windows-x86_64", "linux-x86_64"] as const).map((platform, index) => ({
    id: index + 3,
    name: hostedNativeArtifactName({
      controller_revision: revision,
      run_id: run,
      run_attempt: 1,
      platform_label: platform,
      stage: "payload-signing",
    }),
    expired: false,
    digest: `sha256:${"b".repeat(64)}`,
    size_in_bytes: 1000,
    workflow_run: {
      id: 123,
      head_sha: revision,
      repository_id: 1354613114,
      head_repository_id: 1354613114,
    },
  }));
  return { jobs: { total_count: 2, jobs }, artifacts: { total_count: 2, artifacts } };
}

void test("both fixed original producers and bounded provider artifacts are scheduling prerequisites only", () => {
  const f = fixture();
  assert.ok(
    inspectNativePreSignReadiness(f.jobs, f.artifacts, run, revision).every((row) => row.ready),
  );
  f.artifacts.artifacts.pop();
  f.artifacts.total_count--;
  assert.deepEqual(
    inspectNativePreSignReadiness(f.jobs, f.artifacts, run, revision).map((row) => row.ready),
    [true, false],
  );
  assert.deepEqual(
    inspectNativePreSignReadiness(
      { total_count: 0, jobs: [] },
      { total_count: 0, artifacts: [] },
      run,
      revision,
    ).map((row) => row.ready),
    [false, false],
  );
});

void test("incomplete, duplicate, wrong-source/attempt and refused native producer inventories fail closed", () => {
  const faults: ((f: ReturnType<typeof fixture>) => void)[] = [
    (f) => {
      f.jobs.total_count++;
    },
    (f) => {
      f.jobs.jobs[1]!.id = 1;
    },
    (f) => {
      f.jobs.jobs[1]!.name = f.jobs.jobs[0]!.name;
    },
    (f) => {
      f.jobs.jobs[0]!.head_sha = "c".repeat(40);
    },
    (f) => {
      f.jobs.jobs[0]!.run_id = 456;
    },
    (f) => {
      f.jobs.jobs[0]!.run_attempt = 2;
    },
    (f) => {
      f.jobs.jobs[0]!.status = "completed";
      f.jobs.jobs[0]!.conclusion = "failure";
    },
    (f) => {
      f.jobs.jobs[0]!.status = "queued";
    },
    (f) => {
      (f.jobs.jobs[0] as unknown as Record<string, unknown>).status = ["in_progress"];
    },
  ];
  for (const fault of faults) {
    const f = fixture();
    fault(f);
    assert.throws(() => inspectNativePreSignReadiness(f.jobs, f.artifacts, run, revision));
  }
});

void test("expired, ambiguous, oversized, foreign and mismatched artifact metadata cannot release readiness", () => {
  const faults: ((f: ReturnType<typeof fixture>) => void)[] = [
    (f) => {
      f.artifacts.total_count++;
    },
    (f) => {
      f.artifacts.artifacts[1]!.id = 3;
    },
    (f) => {
      f.artifacts.artifacts[1]!.name = f.artifacts.artifacts[0]!.name;
    },
    (f) => {
      f.artifacts.artifacts[0]!.expired = true;
    },
    (f) => {
      f.artifacts.artifacts[0]!.size_in_bytes = 1024 ** 2;
    },
    (f) => {
      f.artifacts.artifacts[0]!.digest = "unobserved";
    },
    (f) => {
      f.artifacts.artifacts[0]!.workflow_run.id = 456;
    },
    (f) => {
      f.artifacts.artifacts[0]!.workflow_run.head_sha = "c".repeat(40);
    },
    (f) => {
      f.artifacts.artifacts[0]!.workflow_run.repository_id = 1;
    },
    (f) => {
      f.artifacts.artifacts[0]!.workflow_run.head_repository_id = 1;
    },
  ];
  for (const fault of faults) {
    const f = fixture();
    fault(f);
    assert.throws(() => inspectNativePreSignReadiness(f.jobs, f.artifacts, run, revision));
  }
});

void test("only valid pending GETs repeat, bounded by original fences and finite observation count", async () => {
  let reads = 0,
    pauses = 0,
    retained = 0;
  const result = await waitForNativePreSignReadiness({
    run,
    revision,
    active() {},
    read() {
      reads++;
      return reads === 1
        ? { jobs: { total_count: 0, jobs: [] }, artifacts: { total_count: 0, artifacts: [] } }
        : fixture();
    },
    async retain() {
      retained++;
    },
    async pause() {
      pauses++;
    },
  });
  assert.deepEqual(result, { prerequisites_observed: true, authority: "none" });
  assert.deepEqual([reads, pauses, retained], [2, 1, 2]);
  reads = 0;
  await assert.rejects(
    waitForNativePreSignReadiness({
      run,
      revision,
      active() {},
      read() {
        reads++;
        throw Error("ambiguous GET");
      },
      async retain() {},
      async pause() {
        assert.fail("ambiguous GET must not repeat");
      },
    }),
    /ambiguous GET/u,
  );
  assert.equal(reads, 1);
  let expired = false;
  await assert.rejects(
    waitForNativePreSignReadiness({
      run,
      revision,
      active() {
        assert.ok(!expired, "original source expired");
      },
      read: fixture,
      async retain() {
        expired = true;
      },
      async pause() {
        assert.fail();
      },
    }),
    /original source expired/u,
  );
  reads = 0;
  await assert.rejects(
    waitForNativePreSignReadiness({
      run,
      revision,
      active() {},
      read() {
        reads++;
        return { jobs: { total_count: 0, jobs: [] }, artifacts: { total_count: 0, artifacts: [] } };
      },
      async retain() {},
      async pause() {},
    }),
    /observation bound/u,
  );
  assert.equal(reads, 120);
});

void test("the actual credential-routing entry waits before output and preserves refusal without output", async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "portcove-presign-routing-"));
  const previous = process.env.GITHUB_OUTPUT;
  const order: string[] = [];
  let refused = false;
  t.mock.module("./release-authority-configuration.mts", {
    namedExports: {
      requireControllerJobCredentialRoute: async () => ({
        route: { credential_transport: "fixed-job" },
        recheck() {
          order.push("source");
        },
      }),
    },
  });
  t.mock.module("./release-native-presign-readiness.mts", {
    namedExports: {
      async waitForOriginalPayloadNativeProof() {
        order.push("wait");
        if (refused) throw Error("native producer refused");
      },
    },
  });
  try {
    process.env.GITHUB_OUTPUT = path.join(directory, "output");
    const route = (await import(
      `./release-controller-job-credential-route.mts?fixture=${Date.now()}`
    )) as typeof import("./release-controller-job-credential-route.mts");
    await route.writeControllerJobCredentialRoute("payload");
    assert.deepEqual(order, ["wait", "source", "source"]);
    assert.equal(
      await readFile(process.env.GITHUB_OUTPUT, "utf8"),
      "credential_transport=fixed-job\n",
    );
    process.env.GITHUB_OUTPUT = path.join(directory, "refused");
    refused = true;
    await assert.rejects(
      route.writeControllerJobCredentialRoute("payload"),
      /native producer refused/u,
    );
    await assert.rejects(readFile(process.env.GITHUB_OUTPUT), { code: "ENOENT" });
  } finally {
    if (previous === undefined) delete process.env.GITHUB_OUTPUT;
    else process.env.GITHUB_OUTPUT = previous;
    t.mock.reset();
    await rm(directory, { recursive: true, force: true });
  }
});

void test("the actual payload wrapper uses the captured binding, GET-only bounded transport, and exclusive retained intent", async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "portcove-presign-provider-"));
  const previous = process.env.RUNNER_TEMP;
  const requests: string[] = [];
  const providerLog: string[] = [];
  t.mock.method(console, "error", (value: unknown) => {
    assert.equal(typeof value, "string");
    providerLog.push(String(value));
  });
  let ambiguous = false,
    pending = false,
    clockReads = 0;
  t.mock.module("node:timers/promises", { namedExports: { setTimeout: async () => {} } });
  t.mock.module("./release-signing-job-budget.mts", {
    namedExports: {
      currentPayloadJobDeadline(identity: unknown) {
        clockReads++;
        assert.deepEqual(identity, {
          controller_revision: revision,
          controller_ref: "refs/tags/portcove-production-controller-fixture",
          run_id: run,
          run_attempt: 1,
        });
        return performance.now() + 60000;
      },
    },
  });
  t.mock.module("./github-api.mts", {
    namedExports: {
      GitHubApiClient: class {
        runner: (args: string[]) => unknown;
        constructor(runner: (args: string[]) => unknown) {
          this.runner = runner;
        }
        request(method: string, endpoint: string) {
          return this.runner([method, endpoint]);
        }
      },
      createGitHubRunner(options: { timeoutMs: number; maxBuffer: number }) {
        assert.ok(options.timeoutMs > 0 && options.timeoutMs <= 15000);
        assert.equal(options.maxBuffer, 2 * 1024 ** 2);
        return (args: string[]) => {
          assert.equal(args[0], "GET");
          assert.deepEqual(args.slice(2), ["--hostname", "github.com"]);
          requests.push(args[1]!);
          if (ambiguous) throw Error("ambiguous provider response");
          const f = pending
            ? { jobs: { total_count: 0, jobs: [] }, artifacts: { total_count: 0, artifacts: [] } }
            : fixture();
          return {
            status: 200,
            headers: new Map(),
            body: args[1]!.includes("/jobs?") ? f.jobs : f.artifacts,
          };
        };
      },
    },
  });
  const captured = {
    route: {
      phase: "payload",
      credential_transport: "fixed-job",
      source: {
        controller_revision: revision,
        controller_ref: "refs/tags/portcove-production-controller-fixture",
        run_id: 123,
        run_attempt: 1,
      },
    },
    recheck() {},
  } as unknown as Parameters<
    typeof import("./release-native-presign-readiness.mts").waitForOriginalPayloadNativeProof
  >[0];
  try {
    process.env.RUNNER_TEMP = directory;
    const api = (await import(
      `./release-native-presign-readiness.mts?provider=${Date.now()}`
    )) as typeof import("./release-native-presign-readiness.mts");
    await api.waitForOriginalPayloadNativeProof(captured);
    assert.deepEqual(requests, [
      "repos/boburning/portcove/actions/runs/123/attempts/1/jobs?per_page=100",
      "repos/boburning/portcove/actions/runs/123/artifacts?per_page=100&page=1",
    ]);
    const record = await readFile(
      path.join(directory, "native-pre-sign-prerequisites.jsonl"),
      "utf8",
    );
    assert.ok(Buffer.byteLength(record) < 65536);
    assert.equal(parseRecord(record).authority, "none");
    await assert.rejects(api.waitForOriginalPayloadNativeProof(captured), { code: "EEXIST" });
    assert.equal(requests.length, 2);
    process.env.RUNNER_TEMP = await mkdtemp(path.join(directory, "refusal-"));
    ambiguous = true;
    await assert.rejects(
      api.waitForOriginalPayloadNativeProof(captured),
      /ambiguous provider response/u,
    );
    assert.equal(requests.length, 3);
    const refusal = parseRecord(
      await readFile(
        path.join(process.env.RUNNER_TEMP, "native-pre-sign-prerequisites.jsonl"),
        "utf8",
      ),
    );
    assert.equal(refusal.recovery_required, true);
    assert.equal(refusal.requests, 2);
    assert.equal(clockReads, 3);
    process.env.RUNNER_TEMP = await mkdtemp(path.join(directory, "exhausted-"));
    ambiguous = false;
    pending = true;
    const before = requests.length;
    await assert.rejects(
      api.waitForOriginalPayloadNativeProof(captured),
      /GET allowance exhausted/u,
    );
    assert.equal(requests.length - before, 119); // Plus the original clock GET.
    const lines = (
      await readFile(
        path.join(process.env.RUNNER_TEMP, "native-pre-sign-prerequisites.jsonl"),
        "utf8",
      )
    )
      .trim()
      .split("\n");
    assert.equal(parseRecord(lines.at(-1)!).requests, 120);
    assert.ok(providerLog.some((line) => parseRecord(line).outcome === "refused-or-ambiguous"));
  } finally {
    if (previous === undefined) delete process.env.RUNNER_TEMP;
    else process.env.RUNNER_TEMP = previous;
    t.mock.reset();
    await rm(directory, { recursive: true, force: true });
  }
});
