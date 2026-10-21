import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { createHash } from "node:crypto";
import { performance } from "node:perf_hooks";
import { stripTypeScriptTypes } from "node:module";
import { runInNewContext } from "node:vm";
import {
  controllerTransportClock,
  retainControllerUpload,
  retainControllerAttestation,
  nextControllerTransport,
  acknowledgeControllerTransport,
  inspectControllerTransportEvent,
} from "./release-controller-transport.mts";
import { productionControllerWorkflow } from "./production-controller-admission.mts";
const sha = (raw: Buffer) => createHash("sha256").update(raw).digest("hex");
const identity = {
  GITHUB_RUN_ID: "123",
  GITHUB_RUN_ATTEMPT: "1",
  GITHUB_SHA: "a".repeat(40),
  GITHUB_REF: "refs/tags/portcove-production-controller-test",
};
void test("transport clock preserves provider-start budget across subprocesses and wall-clock rollback", () => {
  const clock = {
    controller_revision: identity.GITHUB_SHA,
    execution_ref: identity.GITHUB_REF,
    job_id: 4,
    job_name: "Coordinate application release",
    phase: "coordinator",
    profile_ms: 170000,
    run_attempt: 1,
    run_id: "123",
    started_at: "2026-10-20T00:00:00Z",
    monotonic_deadline_ns: "200000000000",
  };
  const raw = { clock, sha256: sha(Buffer.from(JSON.stringify(clock))) };
  const epoch = Date.parse(clock.started_at);
  assert.equal(
    controllerTransportClock(raw, "coordinator", identity, epoch + 10000, 500, 40000000000n),
    160500,
  );
  assert.equal(
    controllerTransportClock(raw, "coordinator", identity, epoch, 600, 50000000000n),
    150600,
  );
  assert.throws(
    () => controllerTransportClock(raw, "coordinator", identity, epoch, 600, 200000000000n),
    /exhausted/,
  );
  for (const changed of [
    { ...raw, clock: { ...clock, profile_ms: 570000 } },
    { ...raw, sha256: "0".repeat(64) },
  ])
    assert.throws(
      () => controllerTransportClock(changed, "coordinator", identity, epoch, 500, 40000000000n),
      /changed|identity/,
    );
});
void test("actual local routing interleaves control and pending upload before the next control round", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "fixed-pump-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const previous = { ...process.env };
  Object.assign(process.env, identity);
  t.after(() => {
    for (const key of Object.keys(identity)) {
      if (previous[key] === undefined) delete process.env[key];
      else process.env[key] = previous[key];
    }
  });
  const control = async (index: number) => {
    const dir = path.join(root, `round${index}`);
    await mkdir(dir);
    const file = path.join(dir, "ready-coordinator.json"),
      producer = {
        workflow: productionControllerWorkflow,
        controller_revision: identity.GITHUB_SHA,
        controller_ref: identity.GITHUB_REF,
        run_id: "123",
        run_attempt: 1,
        job_id: 4,
        check_run_id: 5,
      };
    const bytes = Buffer.from(
      JSON.stringify({
        schema_version: 1,
        phase: "coordinator",
        producer,
        facts_sha256: "b".repeat(64),
        ...(index ? { round: { index, nonce: "c".repeat(64) } } : {}),
      }),
    );
    await writeFile(file, bytes);
    await writeFile(
      path.join(root, `control-step-ready-coordinator-r${index}.json`),
      JSON.stringify({ path: file, sha256: sha(bytes) }),
    );
  };
  await control(0);
  const deadline = performance.now() + 10000;
  assert.equal((await nextControllerTransport(root, "coordinator", 1, deadline)).kind, "control");
  await assert.rejects(
    nextControllerTransport(root, "coordinator", 2, deadline),
    /not acknowledged/,
  );
  await acknowledgeControllerTransport(root, "coordinator", 1);
  const directory = path.join(root, "context");
  await mkdir(directory);
  // Execute the maintained producer's pure naming route, not another naming
  // fixture. No producer admission or private receipt is constructed here.
  const producerSource = await readFile(
    new URL("./release-signing-context-artifact.mts", import.meta.url),
    "utf8",
  );
  const start = producerSource.indexOf("const contextRoute ="),
    end = producerSource.indexOf("const compare =", start);
  assert(start >= 0 && end > start);
  const prefix: unknown = runInNewContext(
    `${stripTypeScriptTypes(producerSource.slice(start, end))};contextRoute("metadata-signing-context").prefix`,
    Object.create(null),
    { timeout: 1000, contextCodeGeneration: { strings: false, wasm: false } },
  );
  assert.equal(typeof prefix, "string");
  const files = ["signing-context-manifest.json", "signing-context-bytes.bin"];
  for (const file of files)
    await writeFile(path.join(directory, file), "actual owned public bytes");
  await writeFile(
    path.join(directory, "context-ready.json"),
    JSON.stringify({
      name: `${String(prefix)}-123-1`,
      files,
    }),
  );
  await retainControllerUpload(root, "coordinator", "context", directory);
  assert.equal((await nextControllerTransport(root, "coordinator", 2, deadline)).kind, "context");
  await acknowledgeControllerTransport(root, "coordinator", 2, {
    artifact_id: 77,
    sha256: "d".repeat(64),
  });
  assert.deepEqual(
    JSON.parse(await readFile(path.join(directory, "context-uploaded.json"), "utf8")),
    { artifact_id: 77, sha256: "d".repeat(64) },
  );
  await control(1);
  assert.equal((await nextControllerTransport(root, "coordinator", 3, deadline)).kind, "control");
  await acknowledgeControllerTransport(root, "coordinator", 3);
  const predicate = path.join(directory, "signing-context-predicate.json");
  await writeFile(predicate, "public predicate");
  await retainControllerAttestation(root, "coordinator", {
    subject_path: path.join(directory, files[0]!),
    predicate_path: predicate,
    predicate_type: "https://portcove.dev/attestations/release-signing-context/v1",
  });
  await writeFile(
    path.join(root, "controller-job-settlement-coordinator.json"),
    JSON.stringify({ exit_code: 0, requires_attestation: true }),
  );
  assert.equal((await nextControllerTransport(root, "coordinator", 4, deadline)).kind, "attest");
  await acknowledgeControllerTransport(root, "coordinator", 4);
  assert.equal((await nextControllerTransport(root, "coordinator", 5, deadline)).kind, "done");
  await assert.rejects(acknowledgeControllerTransport(root, "coordinator", 4), /EEXIST/);
  await assert.rejects(nextControllerTransport(root, "coordinator", 41, deadline), /forty/);
});
void test("fixed routing rejects cross-role keys, escaped files and changed public upload bytes", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "fixed-pump-refuse-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const event = {
    schema_version: 1,
    phase: "coordinator",
    kind: "role-key",
    directory: path.join(root, "key"),
    name: "releases",
    files: [],
    ack: null,
    predicate: null,
    predicate_type: null,
    predicate_sha256: null,
  };
  assert.throws(() => inspectControllerTransportEvent(event, root, "coordinator"), /phase/);
  assert.throws(
    () =>
      inspectControllerTransportEvent(
        { ...event, phase: "tuf-releases", directory: path.dirname(root) },
        root,
        "tuf-releases",
      ),
    /escaped/,
  );
  const dir = path.join(root, "context");
  await mkdir(dir);
  const file = path.join(dir, "signing-context-manifest.json");
  await writeFile(file, "one");
  const other = path.join(dir, "signing-context-bytes.bin");
  await writeFile(other, "one");
  const raw = {
    schema_version: 1,
    phase: "coordinator",
    kind: "context",
    directory: dir,
    name: "fixed-name",
    files: [
      { path: file, bytes: 3, sha256: sha(Buffer.from("one")) },
      { path: other, bytes: 3, sha256: sha(Buffer.from("one")) },
    ],
    ack: path.join(dir, "context-uploaded.json"),
    predicate: null,
    predicate_type: null,
    predicate_sha256: null,
  };
  await writeFile(
    path.join(root, "controller-transport-coordinator-context.json"),
    JSON.stringify(raw),
  );
  await writeFile(file, "two");
  await assert.rejects(
    nextControllerTransport(root, "coordinator", 1, performance.now() + 10000),
    /changed/,
  );
  await assert.rejects(
    nextControllerTransport(root, "coordinator", 1, performance.now() - 1),
    /deadline/,
  );
});
void test("producer exit alone cannot complete a required attestation and failed producers refuse", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "fixed-pump-ended-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const ended = path.join(root, "controller-job-settlement-coordinator.json");
  await writeFile(ended, JSON.stringify({ exit_code: 0, requires_attestation: true }));
  await assert.rejects(
    nextControllerTransport(root, "coordinator", 1, performance.now() + 25),
    /deadline/,
  );
  await writeFile(ended, JSON.stringify({ exit_code: 1, requires_attestation: false }));
  await assert.rejects(
    nextControllerTransport(root, "coordinator", 1, performance.now() + 1000),
    /producer refused/,
  );
  await writeFile(ended, JSON.stringify({ exit_code: 0, requires_attestation: false }));
  assert.deepEqual(
    await nextControllerTransport(root, "coordinator", 1, performance.now() + 1000),
    { kind: "done" },
  );
});
void test("composite contains forty fixed slots with isolated key env and unchanged pinned actions", async () => {
  const source = await readFile(
    new URL("../.github/actions/release-controller-transport/action.yml", import.meta.url),
    "utf8",
  );
  assert.equal((source.match(/- id: route\d+/gu) ?? []).length, 40);
  assert.equal(
    (source.match(/actions\/upload-artifact@cf430e030ddbb5b0abf93d22962f4752f3646cd9/gu) ?? [])
      .length,
    40,
  );
  assert.equal(
    (source.match(/actions\/attest@1e69f48acb82d1966a394da916b4c1698aa569d6/gu) ?? []).length,
    40,
  );
  assert.equal((source.match(/PORTCOVE_ROLE_KEY:/gu) ?? []).length, 40);
  assert.equal((source.match(/retention-days: 7/gu) ?? []).length, 40);
  assert(!source.includes("overwrite: true"));
  assert(!source.includes("GH_TOKEN"));
});
