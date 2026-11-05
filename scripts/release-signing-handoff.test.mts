import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import type { TestContext } from "node:test";
import { createAuditZip } from "./fixtures/audit-zip-fixture.mts";
import { productionControllerWorkflow } from "./production-controller-admission.mts";
import {
  readSigningOutputArtifact,
  inspectSigningOutputArchive,
} from "./release-signing-handoff.mts";
import { handoffSigningOutput } from "./release-signing-handoff.mts";
import { performance } from "node:perf_hooks";
import { setTimeout as delay } from "node:timers/promises";
import { isRecord } from "./runtime-values.mts";

const hash = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
async function fixture(t: TestContext) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "signing-handoff-test-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await mkdir(path.join(directory, "output"));
  const contents = new Map([
    ["windows.sig", Buffer.from("inert windows signature")],
    ["linux.sig", Buffer.from("inert linux signature")],
  ]);
  for (const [filename, bytes] of contents)
    await writeFile(path.join(directory, "output", filename), bytes);
  const archive = createAuditZip([...contents]);
  const producer = {
    controller_revision: "a".repeat(40),
    execution_ref: "refs/tags/portcove-production-controller-test",
    workflow: productionControllerWorkflow,
    run_id: "12345",
    run_attempt: 1,
    job_id: 501,
    check_run_id: "777",
    actor_id: "43177418",
    role: "payload-signing",
  };
  const expected = {
    producer,
    artifact_id: 900,
    archive_sha256: hash(archive),
    name: "trusted-payload-signing-output-12345-1",
    files: [...contents].map(([filename, bytes]) => ({
      filename,
      bytes: bytes.length,
      sha256: hash(bytes),
    })),
  };
  const run = {
    id: 12345,
    run_attempt: 1,
    head_sha: producer.controller_revision,
    path: productionControllerWorkflow,
    event: "workflow_dispatch",
    status: "in_progress",
    conclusion: null,
    repository: { id: 1354613114, full_name: "boburning/portcove" },
    head_repository: { id: 1354613114 },
  };
  const job = {
    id: 501,
    run_id: 12345,
    run_attempt: 1,
    head_sha: producer.controller_revision,
    check_run_url: "https://api.github.com/repos/boburning/portcove/check-runs/777",
    status: "in_progress",
    conclusion: null,
  };
  const artifact = {
    id: 900,
    name: expected.name,
    expired: false,
    digest: `sha256:${expected.archive_sha256}`,
    size_in_bytes: archive.length,
    workflow_run: {
      id: 12345,
      repository_id: 1354613114,
      head_repository_id: 1354613114,
      head_sha: producer.controller_revision,
    },
  };
  const calls: string[] = [];
  let downloads = 0;
  const options = {
    deadline: performance.now() + 30000,
    metadata: {
      async attempt(runId: string, attempt: number) {
        assert.equal(runId, "12345");
        assert.equal(attempt, 1);
        calls.push("attempt");
        return structuredClone(run);
      },
      async job(id: number) {
        assert.equal(id, 501);
        calls.push("job");
        return structuredClone(job);
      },
      async artifact(id: number) {
        assert.equal(id, 900);
        calls.push("artifact");
        return structuredClone(artifact);
      },
    },
    download: (endpoint: string) => {
      assert.equal(endpoint, "repos/boburning/portcove/actions/artifacts/900/zip");
      downloads++;
      return Buffer.from(archive);
    },
  };
  return {
    directory,
    expected,
    options,
    calls,
    archive,
    run,
    job,
    artifact,
    downloads: () => downloads,
  };
}
void test("exact immutable signing output brackets numeric producer identity and all retained bytes without claiming attestation", async (t) => {
  const f = await fixture(t);
  const result = await readSigningOutputArtifact(f.directory, f.expected, f.options);
  assert.deepEqual(f.calls, ["attempt", "job", "artifact", "attempt", "job", "artifact"]);
  assert.equal(f.downloads(), 1);
  assert.equal(result.evidence_scope, "injected-provider");
  assert.equal(result.authority, "none");
  assert.equal(result.producer.job_id, 501);
  assert.equal(result.producer.check_run_id, "777");
  assert.ok((await readFile(path.join(f.directory, "signing-output.zip"))).equals(f.archive));
});
void test("downstream completed producer custody retains successful numeric job even when later workflow failed", async (t) => {
  const f = await fixture(t);
  Object.assign(f.job, { status: "completed", conclusion: "success" });
  Object.assign(f.run, { status: "completed", conclusion: "failure" });
  const result = await readSigningOutputArtifact(f.directory, f.expected, {
    ...f.options,
    producerState: "completed",
  });
  assert.equal(result.authority, "none");
  assert.equal(result.evidence_scope, "injected-provider");
  assert.equal(result.producer.job_id, 501);
  assert.equal(f.calls.length, 6);
  for (const change of [
    (value: typeof f) => Object.assign(value.job, { status: "in_progress", conclusion: null }),
    (value: typeof f) => Object.assign(value.job, { status: "completed", conclusion: "failure" }),
    (value: typeof f) => {
      value.job.check_run_url += "0";
    },
    (value: typeof f) => {
      value.job.run_attempt++;
    },
    (value: typeof f) => Object.assign(value.run, { status: "completed", conclusion: null }),
  ]) {
    const failed = await fixture(t);
    Object.assign(failed.job, { status: "completed", conclusion: "success" });
    change(failed);
    await assert.rejects(
      readSigningOutputArtifact(failed.directory, failed.expected, {
        ...failed.options,
        producerState: "completed",
      }),
    );
    assert.equal(failed.downloads(), 0);
  }
});
void test("shared signing ZIP parser detaches exact complete bounded bytes and provides no trust result", () => {
  const content = Buffer.from("inert public role envelope"),
    archive = createAuditZip([["releases.json", content]]);
  const files = [{ filename: "releases.json", bytes: content.length, sha256: hash(content) }];
  const parsed = inspectSigningOutputArchive(archive, files);
  archive.fill(0);
  content.fill(0);
  files[0]!.sha256 = "0".repeat(64);
  assert.equal(parsed.get("releases.json")?.toString(), "inert public role envelope");
  assert.equal(Object.hasOwn(parsed, "authority"), false);
  assert.throws(() => inspectSigningOutputArchive(Buffer.alloc(2 * 1024 * 1024 + 1), []));
  assert.throws(() =>
    inspectSigningOutputArchive(createAuditZip([["releases.json", Buffer.from("changed")]]), [
      { filename: "releases.json", bytes: 7, sha256: "a".repeat(64) },
    ]),
  );
});
void test("changed attempt, job association, source, artifact or terminal producer refuses before download", async (t) => {
  for (const change of [
    (f: Awaited<ReturnType<typeof fixture>>) => {
      f.run.run_attempt++;
    },
    (f: Awaited<ReturnType<typeof fixture>>) => {
      f.job.check_run_url = f.job.check_run_url.replace("777", "501");
    },
    (f: Awaited<ReturnType<typeof fixture>>) => {
      f.job.head_sha = "b".repeat(40);
    },
    (f: Awaited<ReturnType<typeof fixture>>) => {
      f.job.status = "completed";
    },
    (f: Awaited<ReturnType<typeof fixture>>) => {
      f.artifact.name += "-other";
    },
    (f: Awaited<ReturnType<typeof fixture>>) => {
      f.artifact.workflow_run.head_repository_id = 1;
    },
  ]) {
    const f = await fixture(t);
    change(f);
    await assert.rejects(
      readSigningOutputArtifact(f.directory, f.expected, f.options),
      /retain owned directory/u,
    );
    assert.equal(f.downloads(), 0);
    const failure: unknown = JSON.parse(
      await readFile(path.join(f.directory, "signing-output-failure.json"), "utf8"),
    );
    assert.ok(isRecord(failure));
    assert.equal(failure.phase, "provider-before");
  }
});
void test("complete ZIP inventory, changed local signatures and provider drift remain refused with raw input retained", async (t) => {
  for (const mode of ["missing", "extra", "local-change", "drift", "changed-opaque"] as const) {
    const f = await fixture(t);
    let archive = f.archive;
    if (mode === "missing")
      archive = createAuditZip([["windows.sig", Buffer.from("inert windows signature")]]);
    if (mode === "extra")
      archive = createAuditZip([
        ["windows.sig", Buffer.from("inert windows signature")],
        ["linux.sig", Buffer.from("inert linux signature")],
        ["extra.txt", Buffer.from("extra")],
      ]);
    if (mode === "local-change")
      await writeFile(path.join(f.directory, "output", "linux.sig"), "changed");
    if (mode !== "changed-opaque") {
      f.expected.archive_sha256 = hash(archive);
      f.artifact.digest = `sha256:${hash(archive)}`;
      f.artifact.size_in_bytes = archive.length;
    }
    const changed = {
      ...f.options,
      download: () => {
        if (mode === "drift") f.job.status = "completed";
        return mode === "changed-opaque" ? Buffer.from("changed") : archive;
      },
    };
    await assert.rejects(
      readSigningOutputArtifact(f.directory, f.expected, changed),
      /retain owned directory/u,
    );
    if (mode !== "changed-opaque")
      assert.ok((await readFile(path.join(f.directory, "signing-output.zip"))).equals(archive));
  }
});
void test("non-signing roles, unsupported request fields and unbounded inventory refuse before API", async (t) => {
  const f = await fixture(t);
  for (const raw of [
    { ...f.expected, producer: { ...f.expected.producer, role: "release-publication" } },
    { ...f.expected, arbitrary: "not persisted" },
    { ...f.expected, files: [...f.expected.files, f.expected.files[0]!] },
    { ...f.expected, files: [{ filename: "../escape", bytes: 1, sha256: "a".repeat(64) }] },
  ])
    await assert.rejects(readSigningOutputArtifact(f.directory, raw, f.options));
  assert.equal(f.calls.length, 0);
  assert.equal(f.downloads(), 0);
});
void test("missing fixed upload output has a finite deadline and retains only public partial output", async (t) => {
  const f = await fixture(t),
    directory = path.join(f.directory, "handoff");
  await assert.rejects(
    handoffSigningOutput(
      directory,
      {
        producer: f.expected.producer,
        pending: { checkpoint: "a".repeat(40), operation_id: "b".repeat(64) },
        input_binding_sha256: "c".repeat(64),
        files: f.expected.files.map((file) => ({
          ...file,
          path: path.join(f.directory, "output", file.filename),
        })),
      },
      performance.now() + 250,
    ),
    /retain owned directory/u,
  );
  const failure: unknown = JSON.parse(
    await readFile(path.join(directory, "handoff-failure.json"), "utf8"),
  );
  assert.ok(isRecord(failure));
  assert.equal(failure.phase, "await-fixed-upload-action");
  assert.equal(f.calls.length, 0);
  assert.ok(
    (await readFile(path.join(directory, "output", "windows.sig"))).equals(
      Buffer.from("inert windows signature"),
    ),
  );
});
void test("locked SDK brackets bounded archive readback with exact credentials, routes, and headers", async (t) => {
  const f = await fixture(t);
  const previousHost = process.env.GH_HOST,
    previousToken = process.env.GH_TOKEN;
  process.env.GH_HOST = "ambient.invalid";
  process.env.GH_TOKEN = "ghs_SYNTHETIC_OUTPUT";
  t.after(() => {
    if (previousHost === undefined) delete process.env.GH_HOST;
    else process.env.GH_HOST = previousHost;
    if (previousToken === undefined) delete process.env.GH_TOKEN;
    else process.env.GH_TOKEN = previousToken;
  });
  const deadline = performance.now() + 2000;
  const result = await readSigningOutputArtifact(f.directory, f.expected, {
    deadline,
    fetch: async (input, settings) => {
      const request = new Request(input, settings);
      const url = new URL(request.url);
      assert.equal(url.origin, "https://api.github.com");
      assert.equal(request.method, "GET");
      assert.equal(request.headers.get("authorization"), "token ghs_SYNTHETIC_OUTPUT");
      assert.equal(request.headers.get("x-github-api-version"), "2022-11-28");
      assert.equal(request.headers.get("accept"), "application/vnd.github+json");
      const route = url.pathname;
      const prefix = "/repos/boburning/portcove/actions";
      assert.ok(
        [
          `${prefix}/artifacts/900`,
          `${prefix}/jobs/501`,
          `${prefix}/runs/12345/attempts/1`,
        ].includes(route),
      );
      const body =
        route === `${prefix}/artifacts/900`
          ? await f.options.metadata.artifact(900)
          : route === `${prefix}/jobs/501`
            ? await f.options.metadata.job(501)
            : await f.options.metadata.attempt("12345", 1);
      return Response.json(body);
    },
    archiveSpawn: (command, args, settings) => {
      assert.equal(command, "gh");
      assert.equal(args[args.indexOf("--hostname") + 1], "github.com");
      assert.equal(settings.env?.GH_HOST, "github.com");
      assert.equal(settings.env?.NODE_OPTIONS, undefined);
      assert.ok(
        typeof settings.timeout === "number" && settings.timeout > 0 && settings.timeout <= 2000,
      );
      assert.deepEqual(f.calls, ["attempt", "job", "artifact"]);
      assert.equal(settings.maxBuffer, f.archive.length);
      return { status: 0, stdout: Buffer.from(f.archive) };
    },
  });
  assert.equal(result.evidence_scope, "injected-provider");
  assert.deepEqual(f.calls, ["attempt", "job", "artifact", "attempt", "job", "artifact"]);
});
void test("exhausted readback budget refuses before any transport and expiration during a read cannot continue", async (t) => {
  const f = await fixture(t);
  await assert.rejects(
    readSigningOutputArtifact(f.directory, f.expected, {
      ...f.options,
      deadline: performance.now() - 1,
    }),
    /deadline/u,
  );
  assert.equal(f.calls.length, 0);
  assert.equal(f.downloads(), 0);
  let calls = 0;
  const previousToken = process.env.GH_TOKEN;
  process.env.GH_TOKEN = "ghs_SYNTHETIC_OUTPUT";
  t.after(() => {
    if (previousToken === undefined) delete process.env.GH_TOKEN;
    else process.env.GH_TOKEN = previousToken;
  });
  await assert.rejects(
    readSigningOutputArtifact(f.directory, f.expected, {
      deadline: performance.now() + 250,
      download: f.options.download,
      fetch: async (input, settings) => {
        calls++;
        await delay(500, undefined, { signal: new Request(input, settings).signal });
        return Response.json(f.run);
      },
    }),
    /retain owned directory/u,
  );
  assert.equal(calls, 1);
  assert.equal(f.downloads(), 0);
});

void test("missing explicit reader token and truncated SDK metadata refuse before any archive read", async (t) => {
  const missing = await fixture(t),
    truncated = await fixture(t);
  const previousToken = process.env.GH_TOKEN,
    previousFallback = process.env.GITHUB_TOKEN;
  delete process.env.GH_TOKEN;
  process.env.GITHUB_TOKEN = "ghs_SYNTHETIC_WRONG_ROLE";
  t.after(() => {
    if (previousToken === undefined) delete process.env.GH_TOKEN;
    else process.env.GH_TOKEN = previousToken;
    if (previousFallback === undefined) delete process.env.GITHUB_TOKEN;
    else process.env.GITHUB_TOKEN = previousFallback;
  });
  let calls = 0;
  const controlledFetch = async () => {
    calls++;
    return new Response(
      new ReadableStream({
        start(controller) {
          controller.error(new Error("truncated metadata"));
        },
      }),
      { headers: { "content-type": "application/json" } },
    );
  };
  await assert.rejects(
    readSigningOutputArtifact(missing.directory, missing.expected, {
      fetch: controlledFetch,
      download: missing.options.download,
      deadline: performance.now() + 5000,
    }),
    /retain owned directory/u,
  );
  assert.equal(calls, 0);
  assert.equal(missing.downloads(), 0);
  process.env.GH_TOKEN = "ghs_SYNTHETIC_OUTPUT";
  await assert.rejects(
    readSigningOutputArtifact(truncated.directory, truncated.expected, {
      fetch: controlledFetch,
      download: truncated.options.download,
      deadline: performance.now() + 5000,
    }),
    /retain owned directory/u,
  );
  assert.equal(calls, 1);
  assert.equal(truncated.downloads(), 0);
});
