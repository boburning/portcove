import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { isRecord } from "./runtime-values.mts";
import { parseDocument } from "yaml";
import {
  stageAggregateSigningInputs,
  prepareControllerPayloadSigning,
  runPayloadSigningController,
} from "./release-payload-preparation.mts";
import { trustedAssemblyFixture } from "./fixtures/trusted-assembly-fixture.mts";
import { createAuditZip } from "./fixtures/audit-zip-fixture.mts";
import { assembleTrustedRelease } from "./trusted-release-assembly.mts";

const hash = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
void test("positive payload continuation rejects imported tool receipts before identity or key access", async () => {
  await assert.rejects(
    runPayloadSigningController(
      {},
      {
        audience: "portcove-payload-signing",
        subject: "fixed-independent-subject",
        controller_revision: "a".repeat(40),
        controller_ref: "refs/tags/portcove-production-controller-test",
        actor_id: "123",
        run_id: "456",
        run_attempt: 1,
      },
      {},
    ),
    /actual same-process controller tool verification required/u,
  );
});
void test("standalone signer fragment stays held and uses only the connected controller entrypoint without keys", async () => {
  const text = await readFile(
    new URL(
      "../docs/qualification/application-update-production.payload-signing.yml",
      import.meta.url,
    ),
    "utf8",
  );
  const yaml = parseDocument(text, { uniqueKeys: true });
  assert.deepEqual(yaml.errors, []);
  const jobs = yaml.get("jobs", true);
  assert.ok(jobs);
  assert.equal(yaml.getIn(["jobs", "payload_signing", "if"]), "${{ false }}");
  assert.equal(yaml.getIn(["jobs", "payload_signing", "name"]), "Sign admitted updater payloads");
  assert.ok(text.includes("node scripts/release-payload-preparation.mts"));
  assert.equal(text.includes("node scripts/release-payload-signing.mts"), false);
  const parsed: unknown = yaml.toJS();
  assert.ok(isRecord(parsed) && isRecord(parsed.jobs));
  const reader = parsed.jobs.payload_signing;
  const observer = parsed.jobs.payload_protection_observation;
  assert.ok(isRecord(reader) && isRecord(observer));
  assert.doesNotMatch(
    JSON.stringify(reader),
    /secrets\.|CONTROL_APP_TOKEN|permission-administration/,
  );
  assert.equal(observer.if, "${{ false }}");
  assert.match(JSON.stringify(observer), /release-control-ready.mts payload/);
  assert.match(JSON.stringify(observer), /observe-production-payload/);
  assert.ok(
    JSON.stringify(observer).indexOf("release-control-ready.mts") <
      JSON.stringify(observer).indexOf("create-github-app-token"),
  );
  assert.match(JSON.stringify(reader), /trusted-release-control-payload-ready-/);
  assert.match(JSON.stringify(observer), /trusted-release-control-payload-observation-/);
  assert.equal(text.includes("actions/cache@"), false);
});
async function fixture(t: test.TestContext) {
  const f = await trustedAssemblyFixture(t, "initial-beta-win-linux");
  const aggregate = await assembleTrustedRelease(f.root, f.input, f.request);
  const members = await Promise.all(
    aggregate.output_files.map(
      async (file) =>
        [
          file.filename,
          await readFile(path.join(aggregate.assets, file.filename)),
          { descriptor: true },
        ] as const,
    ),
  );
  const archive = createAuditZip(members);
  const binding = {
    aggregate_archive_sha256: hash(archive),
    reservation_checkpoint: "c".repeat(40),
    qualification_inventory_sha256: "d".repeat(64),
    public_key_sha256: "e".repeat(64),
    producer: { run_id: "9988", run_attempt: 1, job_id: "501", artifact_id: "99" },
  };
  return { ...f, members, archive, binding };
}
void test("non-authoritative materialization derives both exact beta requests and opaque bytes from the complete aggregate", async (t) => {
  const f = await fixture(t);
  const destination = path.join(f.root, "signing-inputs");
  const result = await stageAggregateSigningInputs(destination, f.archive, f.request, f.binding);
  assert.equal(result.length, 2);
  assert.deepEqual(
    result.map((request) => request.platform_label),
    ["linux-x86_64", "windows-x86_64"],
  );
  for (const request of result) {
    assert.equal(request.aggregate_archive_sha256, hash(f.archive));
    assert.equal(request.reservation_checkpoint, f.binding.reservation_checkpoint);
    assert.equal(request.qualification_inventory_sha256, f.binding.qualification_inventory_sha256);
    assert.equal(request.producer.job_id, "501");
    assert.equal(request.source_commit, f.request.source_commit);
    assert.equal(hash(await readFile(path.join(destination, request.filename))), request.sha256);
  }
  assert.deepEqual(
    (await readdir(destination)).sort(),
    result.map((request) => request.filename),
  );
  await assert.rejects(
    stageAggregateSigningInputs(destination, f.archive, f.request, f.binding),
    /EEXIST/,
  );
});
void test("wrong ZIP binding, omitted companion, changed package, wrong checkpoint and extra metadata refuse before materialization", async (t) => {
  const f = await fixture(t);
  const destination = path.join(f.root, "never-created");
  await assert.rejects(
    stageAggregateSigningInputs(destination, f.archive, f.request, {
      ...f.binding,
      aggregate_archive_sha256: "0".repeat(64),
    }),
    /binding differs/,
  );
  const omitted = createAuditZip(f.members.filter(([name]) => !name.endsWith(".deb")));
  await assert.rejects(
    stageAggregateSigningInputs(destination, omitted, f.request, {
      ...f.binding,
      aggregate_archive_sha256: hash(omitted),
    }),
  );
  const changed = createAuditZip(
    f.members.map(
      ([name, bytes, options]) =>
        [name, name.endsWith(".exe") ? Buffer.alloc(bytes.length, 1) : bytes, options] as const,
    ),
  );
  await assert.rejects(
    stageAggregateSigningInputs(destination, changed, f.request, {
      ...f.binding,
      aggregate_archive_sha256: hash(changed),
    }),
    /package bytes differ/,
  );
  await assert.rejects(
    stageAggregateSigningInputs(destination, f.archive, f.request, {
      ...f.binding,
      reservation_checkpoint: "main",
    }),
  );
  const extra = { ...f.binding, unrecognized_secret: "must-not-be-retained" };
  await assert.rejects(stageAggregateSigningInputs(destination, f.archive, f.request, extra));
  await assert.rejects(readdir(destination));
});
void test("production preparation refuses incomplete caller configuration without acquisition or output", async () => {
  await assert.rejects(
    prepareControllerPayloadSigning({
      projectRoot: process.cwd(),
      output: "never",
      admission_configuration: {},
      aggregate: {},
      publicKey: "never",
      public_key_sha256: "",
    }),
    /configuration is incomplete/,
  );
});
