import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readFile, rm, lstat, readdir } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { createHash } from "node:crypto";
import { performance } from "node:perf_hooks";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
  controllerTransportClock,
  retainControllerUpload,
  retainControllerAttestation,
  retainControllerRoleKey,
  retainControllerJobSettlement,
  nextControllerTransport,
  acknowledgeControllerTransport,
  inspectControllerTransportEvent,
  inspectControllerKeyProcess,
  startControllerKeyClient,
  finishControllerKeyClient,
  normalizeControllerAttestationBundle,
} from "./release-controller-transport.mts";
import { receiveIsolatedRoleKey } from "./release-role-key-channel.mts";
import { signingContextArtifactRoute } from "./release-signing-context-artifact.mts";
import { inspectPublicationResultUpload } from "./release-publication-result-artifact.mts";
import { setTimeout as delay } from "node:timers/promises";
import { productionControllerWorkflow } from "./production-controller-admission.mts";
const sha = (raw: Buffer) => createHash("sha256").update(raw).digest("hex");
const identity = {
  GITHUB_RUN_ID: "123",
  GITHUB_RUN_ATTEMPT: "1",
  GITHUB_SHA: "a".repeat(40),
  GITHUB_REF: "refs/tags/portcove-production-controller-test",
};

// Fresh module mocks exercise the real entrypoint without minting producer custody or contacting GitHub.
async function runUploadIdentityControl() {
  const { mock } = await import("node:test");
  const assert: typeof import("node:assert/strict") = (await import("node:assert/strict")).default;
  const { readFile } = await import("node:fs/promises");
  const path = (await import("node:path")).default;
  const { pathToFileURL } = await import("node:url");
  delete process.env.PORTCOVE_JOB_OPERATION;
  const moduleUrl = (file: string) => pathToFileURL(path.join(process.cwd(), "scripts", file)).href;
  const ownedUrl = moduleUrl("release-publication-result.mts");
  const toolsUrl = moduleUrl("release-controller-tools.mts");
  const githubUrl = moduleUrl("github-api.mts");
  const owned = (await import(ownedUrl)) as typeof import("./release-publication-result.mts");
  const tools = (await import(toolsUrl)) as typeof import("./release-controller-tools.mts");
  const github = (await import(githubUrl)) as typeof import("./github-api.mts");
  const receipt = {};
  const directory = process.argv[1]!;
  const uploaded = { artifact_id: 93, sha256: "f".repeat(64) };
  let reads = 0,
    providerCalls = 0;
  mock.module(ownedUrl, {
    exports: {
      ...owned,
      requireOwnedPublicationResult: async (value: object) => {
        assert.equal(value, receipt);
        return {
          directory,
          report_sha256: "a".repeat(64),
          record: { controller: { run_id: "123", run_attempt: 1 } },
        };
      },
    },
  });
  mock.module(toolsUrl, {
    exports: {
      ...tools,
      readControllerToolFile: async (file: string, maximum: number) => {
        assert.equal(file, path.join(directory, "result-uploaded.json"));
        assert.equal(maximum, 4096);
        reads++;
        return Buffer.from(JSON.stringify(uploaded));
      },
    },
  });
  mock.module(githubUrl, {
    exports: {
      ...github,
      GitHubApiClient: class {
        constructor() {
          providerCalls++;
          throw new Error("controlled provider boundary must not be reached");
        }
      },
    },
  });
  // The custody module also imports this consumer; use a fresh instance after installing mocks.
  const { handoffPublicationResultArtifact } = (await import(
    moduleUrl("release-publication-result-artifact.mts") + "?upload-identity-control"
  )) as typeof import("./release-publication-result-artifact.mts");
  const pending = { checkpoint: "b".repeat(40), operation_id: "c".repeat(64) };
  await assert.rejects(
    handoffPublicationResultArtifact(receipt, pending, performance.now() + 5000),
    /publication result handoff refused/u,
  );
  const refusal: unknown = JSON.parse(
    await readFile(path.join(directory, "result-handoff-refusal.json"), "utf8"),
  );
  assert.deepEqual(refusal, { pending, automatic_retry: false, authority: "none" });
  assert.equal(providerCalls, 0);
  assert.equal(reads, 1);
  console.log(JSON.stringify({ cases: 1, reads, providerCalls, authority: "none" }));
}

void test("actual publication handoff rejects malformed upload locators before the provider boundary", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "result-upload-contract-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const result = execFileSync(
    process.execPath,
    [
      "--experimental-test-module-mocks",
      "--input-type=module",
      "-e",
      "(" + runUploadIdentityControl.toString() + ")()",
      root,
    ],
    {
      cwd: fileURLToPath(new URL("../", import.meta.url)),
      encoding: "utf8",
      timeout: 15000,
      maxBuffer: 128 * 1024,
      windowsHide: true,
    },
  );
  assert.deepEqual(JSON.parse(result), { cases: 1, reads: 1, providerCalls: 0, authority: "none" });
});
void test("concurrent marker readers see complete published bytes and duplicate publication cannot replace them", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "pump-marker-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const directory = path.join(root, "key");
  await mkdir(directory);
  const marker = path.join(root, "controller-transport-payload-role-key.json");
  let publicationFailure: Error | undefined;
  const publishing = retainControllerRoleKey(root, "payload", directory).catch((error: unknown) => {
    publicationFailure =
      error instanceof Error ? error : new Error("marker publication refused", { cause: error });
  });
  const deadline = performance.now() + 5000;
  let observed: Buffer | undefined;
  while (!observed) {
    if (publicationFailure) throw publicationFailure;
    if (performance.now() >= deadline) throw new Error("marker fixture publication timed out");
    try {
      observed = await readFile(marker);
      assert.ok(observed.length > 0);
      assert.equal((JSON.parse(observed.toString("utf8")) as { kind: string }).kind, "role-key");
    } catch (error) {
      if (!(error instanceof Error) || !("code" in error) || error.code !== "ENOENT") throw error;
      await delay(1);
    }
  }
  await publishing;
  const before = await lstat(marker);
  assert.equal(before.nlink, 2);
  const aliases = (await readdir(root)).filter((name) => name.includes(".retained-"));
  assert.equal(aliases.length, 1);
  assert.ok((await readFile(path.join(root, aliases[0]!))).equals(observed));
  await assert.rejects(retainControllerRoleKey(root, "payload", directory), { code: "EEXIST" });
  assert.ok((await readFile(marker)).equals(observed));
  const after = await lstat(marker);
  assert.equal(after.ino, before.ino);
  assert.equal(after.ctimeMs, before.ctimeMs);
  await retainControllerJobSettlement(root, "payload", 0, true);
  assert.deepEqual(
    JSON.parse(await readFile(path.join(root, "controller-job-settlement-payload.json"), "utf8")),
    { exit_code: 0, requires_attestation: true },
  );
  assert.deepEqual(
    JSON.parse(
      await readFile(path.join(root, "release-control-payload-process-ended.json"), "utf8"),
    ),
    { exit_code: 0 },
  );
});
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
void test("owned key client kernel identity handles spaces/parentheses and distinguishes exited state", () => {
  const fields = ["Z", ...Array.from({ length: 18 }, () => "0"), "12345", "0"];
  assert.deepEqual(inspectControllerKeyProcess(`42 (fixed (key) client) ${fields.join(" ")}`), {
    state: "Z",
    start_ticks: "12345",
  });
  assert.throws(() => inspectControllerKeyProcess("42 (bad) S 0"), /identity/);
});
void test(
  "concurrent fixed key client permits a control round during the actual socket consume callback",
  { skip: process.platform !== "linux" },
  async (t) => {
    const root = await mkdtemp(path.join(os.tmpdir(), "pump-key-"));
    t.after(() => rm(root, { recursive: true, force: true }));
    const previous = { ...process.env };
    Object.assign(process.env, identity, {
      RUNNER_TEMP: root,
      PORTCOVE_JOB_OPERATION: "payload",
      PORTCOVE_ROLE_KEY: "inert-key",
      PORTCOVE_ROLE_PASSWORD: "inert-password",
    });
    t.after(() => {
      for (const key of [
        ...Object.keys(identity),
        "RUNNER_TEMP",
        "PORTCOVE_JOB_OPERATION",
        "PORTCOVE_ROLE_KEY",
        "PORTCOVE_ROLE_PASSWORD",
      ]) {
        if (previous[key] === undefined) delete process.env[key];
        else process.env[key] = previous[key];
      }
    });
    const now = Date.now(),
      deadline = performance.now() + 10000;
    const clock = {
      controller_revision: identity.GITHUB_SHA,
      execution_ref: identity.GITHUB_REF,
      job_id: 4,
      job_name: "Sign admitted updater payloads",
      phase: "payload",
      profile_ms: 570000,
      run_attempt: 1,
      run_id: "123",
      started_at: new Date(now).toISOString(),
      monotonic_deadline_ns: (process.hrtime.bigint() + 10_000_000_000n).toString(),
    };
    await writeFile(
      path.join(root, "controller-transport-payload-clock.json"),
      JSON.stringify({ clock, sha256: sha(Buffer.from(JSON.stringify(clock))) }),
    );
    let entered = false;
    const server = receiveIsolatedRoleKey(
      path.join(root, "key"),
      "payload",
      now + 10000,
      async (key, password) => {
        assert.equal(key, "inert-key");
        assert.equal(password, "inert-password");
        entered = true;
        for (;;) {
          try {
            await readFile(path.join(root, "controller-transport-payload-control-0-ack.json"));
            break;
          } catch {
            if (performance.now() >= deadline) throw new Error("fixture control wait exhausted");
            await delay(10);
          }
        }
        return "consumed-after-control";
      },
    );
    for (;;) {
      try {
        await readFile(path.join(root, "controller-transport-payload-role-key.json"));
        break;
      } catch {
        if (performance.now() >= deadline) throw new Error("fixture key route wait exhausted");
        await delay(10);
      }
    }
    assert.equal((await nextControllerTransport(root, "payload", 1, deadline)).kind, "role-key");
    await startControllerKeyClient(root, "payload", 1, deadline);
    await acknowledgeControllerTransport(root, "payload", 1);
    while (!entered) {
      if (performance.now() >= deadline) throw new Error("fixture client did not enter");
      await delay(10);
    }
    const folder = path.join(root, "round0");
    await mkdir(folder);
    const file = path.join(folder, "ready-payload.json");
    const bytes = Buffer.from(
      JSON.stringify({
        schema_version: 1,
        phase: "payload",
        facts_sha256: "b".repeat(64),
        producer: {
          workflow: productionControllerWorkflow,
          controller_revision: identity.GITHUB_SHA,
          controller_ref: identity.GITHUB_REF,
          run_id: "123",
          run_attempt: 1,
          job_id: 4,
          check_run_id: 5,
        },
      }),
    );
    await writeFile(file, bytes);
    await writeFile(
      path.join(root, "control-step-ready-payload-r0.json"),
      JSON.stringify({ path: file, sha256: sha(bytes) }),
    );
    assert.equal((await nextControllerTransport(root, "payload", 2, deadline)).kind, "control");
    await acknowledgeControllerTransport(root, "payload", 2);
    assert.equal(await server, "consumed-after-control");
    await finishControllerKeyClient(root, "payload", deadline);
    assert.deepEqual(
      JSON.parse(
        await readFile(
          path.join(root, "controller-transport-payload-key-client-settled.json"),
          "utf8",
        ),
      ),
      { exit_code: 0, slot: 1 },
    );
  },
);
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
  const prefix = signingContextArtifactRoute("metadata-signing-context").prefix;
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
  await assert.rejects(acknowledgeControllerTransport(root, "coordinator", 4), /Action output/);
  const bundleSource = path.join(root, "completed-pinned-action-bundle.json");
  const bundleBytes = Buffer.from("public synthetic bundle bytes, no verification claim");
  await assert.rejects(
    normalizeControllerAttestationBundle(root, "coordinator", 4, bundleSource, deadline),
    /ENOENT/,
  );
  await writeFile(bundleSource, Buffer.alloc(512 * 1024 + 1, 1));
  await assert.rejects(
    normalizeControllerAttestationBundle(root, "coordinator", 4, bundleSource, deadline),
    /bound/,
  );
  await writeFile(bundleSource, "");
  await assert.rejects(
    normalizeControllerAttestationBundle(root, "coordinator", 4, bundleSource, deadline),
    /bound/,
  );
  await assert.rejects(
    readFile(path.join(root, "controller-transport-coordinator-bundle-ready.json")),
    /ENOENT/,
  );
  await writeFile(bundleSource, bundleBytes);
  const normalized = await normalizeControllerAttestationBundle(
    root,
    "coordinator",
    4,
    bundleSource,
    deadline,
  );
  assert.equal(normalized.name, "trusted-coordinator-signing-context-attestation-123-1");
  assert.equal(path.basename(normalized.path), "signing-context-attestation.json");
  assert.deepEqual(await readFile(normalized.path), bundleBytes);
  await assert.rejects(
    normalizeControllerAttestationBundle(root, "coordinator", 4, bundleSource, deadline),
    /EEXIST/,
  );
  await acknowledgeControllerTransport(root, "coordinator", 4, {
    artifact_id: 88,
    sha256: "e".repeat(64),
  });
  assert.deepEqual(
    JSON.parse(
      await readFile(
        path.join(root, "controller-transport-coordinator-attestation-uploaded.json"),
        "utf8",
      ),
    ),
    { artifact_id: 88, sha256: "e".repeat(64) },
  );
  assert.equal((await nextControllerTransport(root, "coordinator", 5, deadline)).kind, "done");
  await assert.rejects(
    acknowledgeControllerTransport(root, "coordinator", 4, {
      artifact_id: 88,
      sha256: "e".repeat(64),
    }),
    /EEXIST/,
  );
  await assert.rejects(nextControllerTransport(root, "coordinator", 41, deadline), /forty/);
});
void test("result acknowledgement passes the maintained producer's exact consumer schema", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "fixed-result-ack-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const previous = { ...process.env };
  Object.assign(process.env, identity);
  t.after(() => {
    for (const key of Object.keys(identity)) {
      if (previous[key] === undefined) delete process.env[key];
      else process.env[key] = previous[key];
    }
  });
  const directory = path.join(root, "result"),
    upload = path.join(directory, "upload");
  await mkdir(upload, { recursive: true });
  await writeFile(path.join(upload, "immutable-release-result.json"), "retained public report");
  await writeFile(
    path.join(directory, "result-ready.json"),
    JSON.stringify({
      name: "trusted-immutable-release-result-123-1",
      files: ["immutable-release-result.json"],
    }),
  );
  await retainControllerUpload(root, "release-publication", "result", directory);
  assert.equal(
    (await nextControllerTransport(root, "release-publication", 1, performance.now() + 5000)).kind,
    "result",
  );
  await acknowledgeControllerTransport(root, "release-publication", 1, {
    artifact_id: 93,
    sha256: "f".repeat(64),
  });
  const uploaded: unknown = JSON.parse(
    await readFile(path.join(directory, "result-uploaded.json"), "utf8"),
  );
  assert.deepEqual(inspectPublicationResultUpload(uploaded), { id: 93, sha256: "f".repeat(64) });
  for (const invalid of [
    { artifact_id: 93, sha256: "f".repeat(64) },
    { id: 0, sha256: "f".repeat(64) },
    { id: 1.5, sha256: "f".repeat(64) },
    { id: 93, sha256: "invalid" },
    { id: 93, sha256: "f".repeat(64), authority: "publisher" },
  ])
    assert.throws(() => inspectPublicationResultUpload(invalid));
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
    80,
  );
  assert.equal(
    (source.match(/actions\/attest@1e69f48acb82d1966a394da916b4c1698aa569d6/gu) ?? []).length,
    40,
  );
  assert.equal((source.match(/PORTCOVE_ROLE_KEY:/gu) ?? []).length, 40);
  assert.equal((source.match(/retention-days: 7/gu) ?? []).length, 80);
  assert(!source.includes("overwrite: true"));
  assert(!source.includes("GH_TOKEN"));
});

void test("always-retained diagnostics select bounded public markers and preserve original failure state", async (t) => {
  const { retainControllerDiagnostics } = await import("./release-controller-diagnostics.mts");
  const root = await mkdtemp(path.join(os.tmpdir(), "controller-diagnostics-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const marker = "controller-job-settlement-payload.json";
  const sourceMarker = "controller-payload-source.json";
  await writeFile(
    path.join(root, sourceMarker),
    JSON.stringify({
      schema_version: 1,
      operation: "payload",
      configuration_sha256: "a".repeat(64),
      source: { authority_configuration_sha256: "b".repeat(64), purpose: "application" },
    }),
  );
  await writeFile(
    path.join(root, marker),
    JSON.stringify({ exit_code: 1, requires_attestation: false }),
  );
  await writeFile(
    path.join(root, "controller-transport-payload-slot-40.json"),
    JSON.stringify({ kind: "done" }),
  );
  await writeFile(path.join(root, "controller-transport-payload-clock.json"), "x".repeat(65537));
  await writeFile(path.join(root, "private.key"), "inert-secret-not-for-artifacts");
  await writeFile(path.join(root, "controller-payload.log"), "inert-unfiltered-log");
  const output = await retainControllerDiagnostics(root, "payload");
  const manifest = JSON.parse(await readFile(path.join(output, "manifest.json"), "utf8")) as {
    scope: string;
    authority: string;
    files: { path: string }[];
    unavailable: { path: string; reason: string }[];
  };
  assert.equal(manifest.scope, "public-routing-diagnostics-only");
  assert.equal(manifest.authority, "none");
  assert.deepEqual(
    manifest.files.map((file: { path: string }) => file.path).sort(),
    [marker, sourceMarker, "controller-transport-payload-slot-40.json"].sort(),
  );
  assert.deepEqual(
    await readFile(path.join(output, sourceMarker)),
    await readFile(path.join(root, sourceMarker)),
  );
  assert.equal(
    manifest.unavailable.find((file: { path: string }) => file.path.endsWith("-clock.json"))
      ?.reason,
    "unreadable-or-invalid",
  );
  assert.equal((await readdir(output)).includes("private.key"), false);
  assert.equal((await readdir(output)).includes("controller-payload.log"), false);
  assert.deepEqual(JSON.parse(await readFile(path.join(output, marker), "utf8")), {
    exit_code: 1,
    requires_attestation: false,
  });
  await assert.rejects(retainControllerDiagnostics(root, "payload"), { code: "EEXIST" });
  assert.equal(
    await readFile(path.join(root, "private.key"), "utf8"),
    "inert-secret-not-for-artifacts",
  );
});
