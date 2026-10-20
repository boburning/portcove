import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import type { TestContext } from "node:test";
import { createAuditZip } from "./fixtures/audit-zip-fixture.mts";
import { productionControllerWorkflow } from "./production-controller-admission.mts";
import { readSigningOutputArtifact } from "./release-signing-handoff.mts";
import { handoffSigningOutput } from "./release-signing-handoff.mts";
import { performance } from "node:perf_hooks";
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
    api: {
      request(method: string, endpoint: string) {
        assert.equal(method, "GET");
        calls.push(endpoint);
        return {
          status: 200,
          headers: new Map<string, string>(),
          body: structuredClone(
            endpoint.endsWith("/900") ? artifact : endpoint.endsWith("/501") ? job : run,
          ),
        };
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
  assert.equal(f.calls.length, 6);
  assert.equal(f.downloads(), 1);
  assert.equal(result.evidence_scope, "injected-provider");
  assert.equal(result.authority, "none");
  assert.equal(result.producer.job_id, 501);
  assert.equal(result.producer.check_run_id, "777");
  assert.ok((await readFile(path.join(f.directory, "signing-output.zip"))).equals(f.archive));
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
