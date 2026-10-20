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
} from "./release-control-handshake.mts";
import {
  liveControlRuntimeFixture,
  protectionFixture,
} from "./fixtures/release-live-control-fixture.mts";
import { authenticateReleaseControlSource } from "./release-live-control-admission.mts";
import { isRecord } from "./runtime-values.mts";

async function fixture(t: test.TestContext, role: "ready" | "observation" = "ready") {
  const root = await mkdtemp(path.join(os.tmpdir(), "control-handshake-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const runtime = liveControlRuntimeFixture(protectionFixture("b".repeat(40)));
  const body =
    role === "observation"
      ? structuredClone(runtime.handoff)
      : {
          schema_version: 1,
          producer: { ...runtime.handoff.producer, job_id: 601, check_run_id: "889" },
          facts_sha256: "f".repeat(64),
        };
  const input = {
    controller_revision: body.producer.controller_revision,
    controller_ref: body.producer.controller_ref,
    run_id: body.producer.run_id,
    run_attempt: body.producer.run_attempt,
  };
  let zip: Buffer = createAuditZip([
    [role === "ready" ? "ready.json" : "observation.json", JSON.stringify(body)],
  ]);
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
    name: role === "ready" ? "Authenticate release control inputs" : runtime.observerJob.name,
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
