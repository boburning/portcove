import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createAuditZip } from "./fixtures/audit-zip-fixture.mts";
import {
  controlHandshakeArtifactName,
  requireObservedControlArtifact,
  waitForControlArtifact,
  inspectControlRound,
} from "./release-control-handshake.mts";
import {
  liveControlRuntimeFixture,
  protectionFixture,
} from "./fixtures/release-live-control-fixture.mts";
import { authenticateReleaseControlSource } from "./release-live-control-admission.mts";
import { releaseControlPhaseProfile } from "./release-control-phases.mts";
import type { ReleaseControlPhase } from "./release-control-phases.mts";
import { isRecord } from "./runtime-values.mts";

async function fixture(
  t: test.TestContext,
  role: "ready" | "observation" = "ready",
  phase: ReleaseControlPhase = "admission",
  round?: { index: number; nonce: string },
) {
  const root = await mkdtemp(path.join(os.tmpdir(), "control-handshake-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const runtime = liveControlRuntimeFixture(protectionFixture("b".repeat(40)), undefined, phase);
  const baseBody =
    role === "observation"
      ? structuredClone(runtime.handoff)
      : {
          schema_version: 1,
          phase,
          producer: { ...runtime.handoff.producer, job_id: 601, check_run_id: "889" },
          facts_sha256: "f".repeat(64),
        };
  const body = { ...baseBody, ...(round ? { round } : {}) };
  const input = {
    phase,
    controller_revision: body.producer.controller_revision,
    controller_ref: body.producer.controller_ref,
    run_id: body.producer.run_id,
    run_attempt: body.producer.run_attempt,
    ...(round ? { round } : {}),
  };
  let zip: Buffer = createAuditZip([[`${role}-${phase}.json`, JSON.stringify(body)]]);
  const artifact = {
    id: 900,
    name: controlHandshakeArtifactName(role, input),
    expired: false,
    size_in_bytes: zip.length,
    digest: `sha256:${createHash("sha256").update(zip).digest("hex")}`,
    workflow_run: {
      id: Number(input.run_id),
      repository_id: 1354613114,
      head_repository_id: 1354613114,
      head_sha: input.controller_revision,
    },
  };
  const job = {
    ...runtime.observerJob,
    id: body.producer.job_id,
    check_run_url: `https://api.github.com/repos/boburning/portcove/check-runs/${body.producer.check_run_id}`,
    name:
      role === "ready" ? releaseControlPhaseProfile(phase).reader_name : runtime.observerJob.name,
    status: "in_progress",
    conclusion: null,
    run_attempt: 1,
  };
  let clock = 0,
    missing = 0,
    artifactReads = 0;
  const calls: string[] = [];
  const options = {
    api: {
      request(method: string, endpoint: string) {
        assert.equal(method, "GET");
        calls.push(endpoint);
        let value: unknown;
        if (endpoint.includes("/artifacts?")) {
          artifactReads++;
          const artifacts = artifactReads <= missing ? [] : [structuredClone(artifact)];
          value = { total_count: artifacts.length, artifacts };
        } else if (endpoint.includes("/jobs?"))
          value = { total_count: 1, jobs: [structuredClone(job)] };
        else if (endpoint.endsWith(`/jobs/${job.id}`)) value = structuredClone(job);
        else throw new Error(`unexpected GET ${endpoint}`);
        return { status: 200, headers: new Map<string, string>(), body: value };
      },
    },
    download: () => zip,
    now: () => clock,
    sleep: async (ms: number) => {
      clock += ms;
    },
  };
  return {
    root,
    input,
    body,
    artifact,
    job,
    options,
    runtime,
    calls,
    missing: (n: number) => {
      missing = n;
    },
    zip: (bytes: Buffer) => {
      zip = bytes;
      artifact.size_in_bytes = bytes.length;
      artifact.digest = `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
    },
    collect: () => waitForControlArtifact(root, role, input, options),
  };
}

void test("bounded rounds use distinct immutable names and reject missing, invalid or excess round identities", () => {
  for (const value of [
    { index: 0, nonce: "a".repeat(64) },
    { index: 13, nonce: "a".repeat(64) },
    { index: 1 },
    { index: 1, nonce: "short" },
    { index: 1, nonce: "a".repeat(64), accepted: true },
  ])
    assert.throws(() => inspectControlRound(value));
  assert.deepEqual(inspectControlRound({ index: 12 }, false), { index: 12 });
});
void test("a later operation consumes only its exact round and private nonce while the observer remains live", async (t) => {
  const round = { index: 2, nonce: "a".repeat(64) };
  const f = await fixture(t, "observation", "payload", round);
  assert.match(f.artifact.name, /-r2$/);
  const proof = await f.collect();
  f.runtime.observerJob.status = "in_progress";
  f.runtime.observerJob.conclusion = null;
  const source = await authenticateReleaseControlSource(f.runtime.environment, f.runtime.workflow, {
    ...f.runtime.options,
    phase: "payload",
    round,
    observedArtifact: proof,
  });
  assert.equal(source.evidence_scope, "injected-provider");
  await assert.rejects(
    authenticateReleaseControlSource(f.runtime.environment, f.runtime.workflow, {
      ...f.runtime.options,
      phase: "payload",
      round: { ...round, nonce: "b".repeat(64) },
      observedArtifact: proof,
    }),
    /round differs/,
  );
  await assert.rejects(
    authenticateReleaseControlSource(f.runtime.environment, f.runtime.workflow, {
      ...f.runtime.options,
      phase: "payload",
      round,
    }),
    /actual collected/,
  );
});
void test("wrong nonce or ordinal in a provider-authenticated round archive refuses before establishing controls", async (t) => {
  for (const round of [
    { index: 2, nonce: "b".repeat(64) },
    { index: 3, nonce: "a".repeat(64) },
  ]) {
    const f = await fixture(t, "observation", "payload", { index: 2, nonce: "a".repeat(64) });
    f.zip(createAuditZip([["observation-payload.json", JSON.stringify({ ...f.body, round })]]));
    await assert.rejects(f.collect(), /retain exact attempt/);
  }
});
void test("observer discovers the nonce only from the exact immutable ready round", async (t) => {
  const f = await fixture(t, "ready", "payload", { index: 2, nonce: "c".repeat(64) });
  const proof = await waitForControlArtifact(
    f.root,
    "ready",
    { ...f.input, round: { index: 2 } },
    f.options,
  );
  assert.deepEqual(proof.body.round, { index: 2, nonce: "c".repeat(64) });
});
void test("site and release publication observation members traverse the actual bounded ZIP collector", async (t) => {
  for (const phase of ["site-publication", "release-publication"] as const) {
    const f = await fixture(t, "observation", phase, { index: 1, nonce: "d".repeat(64) });
    const proof = await f.collect();
    assert.equal(proof.phase, phase);
    assert.equal(proof.body.producer.job_id, f.job.id);
  }
});

void test("same active job ready artifact becomes readable before job completion with bounded GET polling", async (t) => {
  const f = await fixture(t);
  f.missing(2);
  f.job.status = "queued";
  const sleep = f.options.sleep;
  f.options.sleep = async (ms) => {
    await sleep(ms);
    f.job.status = "in_progress";
  };
  const proof = await f.collect();
  requireObservedControlArtifact(proof, "ready");
  assert.equal(proof.artifact.id, 900);
  assert.equal(proof.evidence_scope, "injected-provider");
  assert.match(proof.association, /fixed-reviewed-workflow/u);
  assert.equal(proof.authority, "none");
  assert.ok(f.calls.every((call) => call.startsWith("repos/boburning/portcove/actions/")));
  const retained: unknown = JSON.parse(
    await readFile(path.join(f.root, "control-ready-readback.json"), "utf8"),
  );
  assert.ok(isRecord(retained) && isRecord(retained.body));
  assert.equal(retained.body.facts_sha256, "f".repeat(64));
  assert.throws(
    () => requireObservedControlArtifact(JSON.parse(JSON.stringify(proof)), "ready"),
    /runtime provider/u,
  );
  assert.throws(() => requireObservedControlArtifact(proof, "observation"));
  assert.throws(() => {
    proof.body.facts_sha256 = "e".repeat(64);
  }, TypeError);
});

void test("actual immutable report permits live observer consumption without awaiting its queue or completion", async (t) => {
  const f = await fixture(t, "observation");
  const proof = await f.collect();
  f.runtime.observerJob.status = "in_progress";
  f.runtime.observerJob.conclusion = null;
  const source = await authenticateReleaseControlSource(f.runtime.environment, f.runtime.workflow, {
    ...f.runtime.options,
    observedArtifact: proof,
  });
  assert.equal(source.evidence_scope, "injected-provider");
  await assert.rejects(
    authenticateReleaseControlSource(f.runtime.environment, f.runtime.workflow, {
      ...f.runtime.options,
      observedArtifact: { ...proof },
    }),
  );
});

void test("missing ready artifact exhausts a finite wait and retains refusal without retry or mutation", async (t) => {
  const f = await fixture(t);
  f.missing(1000);
  await assert.rejects(f.collect(), /retain exact attempt/u);
  const failure: unknown = JSON.parse(
    await readFile(path.join(f.root, "control-ready-refusal.json"), "utf8"),
  );
  assert.ok(isRecord(failure));
  assert.equal(failure.automatic_retry, false);
  assert.ok(Number(failure.polls) <= 81);
  assert.equal(failure.elapsed_ms, 240000);
});

void test("wrong source, foreign repository, stale attempt, expired archive and failed producer independently refuse", async (t) => {
  for (const change of [
    (f: Awaited<ReturnType<typeof fixture>>) => {
      f.artifact.workflow_run.head_sha = "e".repeat(40);
    },
    (f: Awaited<ReturnType<typeof fixture>>) => {
      f.artifact.workflow_run.repository_id = 123;
    },
    (f: Awaited<ReturnType<typeof fixture>>) => {
      f.job.run_attempt = 2;
    },
    (f: Awaited<ReturnType<typeof fixture>>) => {
      f.artifact.expired = true;
    },
    (f: Awaited<ReturnType<typeof fixture>>) => {
      f.job.status = "completed";
    },
  ]) {
    const f = await fixture(t);
    change(f);
    await assert.rejects(f.collect());
  }
});

void test("provider digest changes, incomplete content and wrong payload issuer/job cannot be imported", async (t) => {
  for (const kind of ["digest", "extra", "wrong-job", "bytes"] as const) {
    const f = await fixture(t);
    if (kind === "digest") f.artifact.digest = `sha256:${"e".repeat(64)}`;
    else if (kind === "extra")
      f.zip(
        createAuditZip([
          ["ready.json", JSON.stringify(f.body)],
          ["unexpected", "inert"],
        ]),
      );
    else if (kind === "bytes") f.zip(Buffer.from("invalid archive"));
    else {
      f.body.producer.job_id = 777;
      f.zip(createAuditZip([["ready.json", JSON.stringify(f.body)]]));
    }
    await assert.rejects(f.collect());
  }
});

void test("duplicate immutable names and provider job changes after download refuse without a second download", async (t) => {
  for (const kind of ["duplicate", "job-change", "artifact-change"] as const) {
    const f = await fixture(t);
    const request = f.options.api.request;
    let downloaded = 0,
      reads = 0;
    f.options.download = () => {
      downloaded++;
      return createAuditZip([["ready.json", JSON.stringify(f.body)]]);
    };
    f.options.api.request = (method, endpoint) => {
      const result = request(method, endpoint);
      if (endpoint.includes("/artifacts?") && isRecord(result.body)) {
        reads++;
        if (kind === "duplicate")
          result.body = { total_count: 2, artifacts: [f.artifact, { ...f.artifact, id: 901 }] };
        if (kind === "artifact-change" && reads > 1)
          result.body = { total_count: 1, artifacts: [{ ...f.artifact, expired: true }] };
      }
      if (kind === "job-change" && endpoint.endsWith(`/jobs/${f.job.id}`))
        result.body = { ...f.job, head_sha: "e".repeat(40) };
      return result;
    };
    await assert.rejects(f.collect());
    assert.ok(downloaded <= 1);
  }
});

void test("default artifact REST path explicitly pins github.com despite ambient GH_HOST", async (t) => {
  const f = await fixture(t);
  const previous = process.env.GH_HOST;
  process.env.GH_HOST = "ambient.invalid";
  t.after(() => {
    if (previous === undefined) delete process.env.GH_HOST;
    else process.env.GH_HOST = previous;
  });
  const { api, ...options } = f.options;
  let requests = 0;
  const proof = await waitForControlArtifact(f.root, "ready", f.input, {
    ...options,
    transport: {
      spawn(command, args) {
        requests++;
        assert.equal(command, "gh");
        assert.equal(process.env.GH_HOST, "ambient.invalid");
        assert.deepEqual(args.slice(-2), ["--hostname", "github.com"]);
        assert.equal(args[0], "api");
        assert.equal(args[args.indexOf("--method") + 1], "GET");
        const endpoint = args.find((arg) => arg.startsWith("repos/boburning/portcove/"));
        assert.ok(endpoint);
        const response = api.request("GET", endpoint);
        return {
          status: 0,
          stdout: `HTTP/2.0 200 OK\r\ncontent-type: application/json\r\n\r\n${JSON.stringify(response.body)}`,
          stderr: "",
        };
      },
    },
  });
  assert.ok(requests >= 4);
  assert.equal(proof.evidence_scope, "injected-provider");
});

void test("fixed phase names bind fresh payload readiness and observation; admission proof cannot cross phases", async (t) => {
  const ready = await fixture(t, "ready", "payload");
  assert.equal(ready.artifact.name, "trusted-release-control-payload-ready-9988-1");
  const readyProof = await ready.collect();
  requireObservedControlArtifact(readyProof, "ready", "payload");
  assert.throws(() => requireObservedControlArtifact(readyProof, "ready"));
  const observation = await fixture(t, "observation", "payload");
  const proof = await observation.collect();
  requireObservedControlArtifact(proof, "observation", "payload");
  const source = await authenticateReleaseControlSource(
    observation.runtime.environment,
    observation.runtime.workflow,
    { ...observation.runtime.options, observedArtifact: proof },
  );
  assert.equal(source.phase, "payload");
  await assert.rejects(
    authenticateReleaseControlSource(
      observation.runtime.environment,
      observation.runtime.workflow,
      { ...observation.runtime.options, phase: "admission", observedArtifact: proof },
    ),
  );
  assert.throws(() =>
    controlHandshakeArtifactName("ready", { ...ready.input, phase: "other" as "payload" }),
  );
  assert.throws(() => {
    (releaseControlPhaseProfile("payload") as { reader_job: string }).reader_job = "attacker";
  });
});
