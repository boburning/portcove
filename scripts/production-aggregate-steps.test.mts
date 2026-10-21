import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, readdir, mkdir, copyFile, writeFile } from "node:fs/promises";
import { execFileSync, spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { parseDocument } from "yaml";
import { isRecord } from "./runtime-values.mts";
import { trustedAssemblyFixture } from "./fixtures/trusted-assembly-fixture.mts";
import { releasePublicBuildProvenanceFixture } from "./fixtures/release-public-build-provenance-fixture.mts";
import {
  inspectAggregateDescriptor,
  requireReservedAggregate,
  inspectReservedPublicationReadback,
  requestAssemblerToken,
  retainAggregateStepReceipt,
} from "./production-aggregate-steps.mts";
import { candidateProgressIdentity } from "./release-candidate-progress-contract.mts";
import { releaseCanonicalDigest as digest } from "./release-canonical.mts";

void test("promoting GET-only association requires exact source/run and retained publishing/promoting locators without admitting an aggregate", async (t) => {
  const { request } = await trustedAssemblyFixture(t);
  const checkpoint = "c".repeat(40),
    descriptor = JSON.stringify({
      schema_version: 1,
      checkpoint,
      coordinator: { schema_version: 1, namespace: "portcove-fixture" },
      assembly: request,
      archives: [],
      evidence: {},
    });
  const candidate = {
    source_commit: "1".repeat(40),
    source_tree: "2".repeat(40),
    intent_sha256: "3".repeat(64),
    prepared_commit: request.source_commit,
    prepared_tree: request.source_tree,
    version: request.version,
    phase: "promoting",
    transient_retries: 0,
    substantive_repairs: 0,
    release_run: { run_id: 12345, attempt: 1, revision: request.source_commit },
  };
  const proof = {
    schema_version: 1,
    candidate_sha256: candidateProgressIdentity(candidate),
    controller_revision: "4".repeat(40),
    locators: [{ kind: "native-check", id: "501", sha256: "5".repeat(64) }],
  };
  const attempt = {
    previous_checkpoint: "6".repeat(40),
    evidence_sha256: digest(proof),
    proof,
    release_run: candidate.release_run,
    transient_retries: 0,
    substantive_repairs: 0,
  };
  const active = {
    ...candidate,
    stage_evidence: [
      { phase: "publishing", attempts: [attempt] },
      { phase: "promoting", attempts: [attempt] },
    ],
  };
  const state = { checkpoint, input: { active_candidate: active } };
  assert.equal(
    (await inspectReservedPublicationReadback(descriptor, state)).accepted.run_id,
    "12345",
  );
  await assert.rejects(requireReservedAggregate(descriptor, state), /existing prepared candidate/);
  for (const patch of [
    { phase: "publishing" },
    { prepared_commit: "0".repeat(40) },
    { release_run: { ...active.release_run, attempt: 2 } },
    { stage_evidence: undefined },
    { stage_evidence: active.stage_evidence.slice(0, 1) },
    { stage_evidence: active.stage_evidence.slice(1) },
  ])
    await assert.rejects(
      inspectReservedPublicationReadback(descriptor, {
        ...state,
        input: { active_candidate: { ...active, ...patch } },
      }),
    );
  await assert.rejects(
    inspectReservedPublicationReadback(descriptor, { ...state, checkpoint: "0".repeat(40) }),
    /checkpoint/,
  );
});

void test("trusted assembler imports from a clean fixed source with no installed packages", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "portcove-clean-assembler-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const directory = path.join(root, "scripts");
  await mkdir(directory);
  for (const entry of await readdir(new URL(".", import.meta.url), { withFileTypes: true })) {
    if (entry.isFile() && entry.name.endsWith(".mts"))
      await copyFile(new URL(entry.name, import.meta.url), path.join(directory, entry.name));
  }
  execFileSync(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      `try { import.meta.resolve('semver'); throw Error('unexpected package visibility'); } catch(error) { if(error.code!=='ERR_MODULE_NOT_FOUND') throw error; } await import(process.argv[1]);`,
      pathToFileURL(path.join(directory, "production-aggregate-steps.mts")).href,
    ],
    { cwd: root, timeout: 15000, encoding: "utf8", windowsHide: true, stdio: "pipe" },
  );
});

void test("step receipts preserve refusal association without secrets and reject a repeated operation before effects", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "portcove-step-receipt-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const filename = path.join(root, "receipt.jsonl");
  const association = {
    checkpoint: "c".repeat(40),
    descriptor_sha256: "d".repeat(64),
    operation: "fixture",
  };
  await assert.rejects(
    retainAggregateStepReceipt(filename, association, async (stage) => {
      association.checkpoint = "e".repeat(40);
      stage("bind-new-upload");
      throw Error("DISPOSABLE-SECRET-MUST-NOT-ENTER-RECEIPT");
    }),
  );
  const raw = await readFile(filename, "utf8");
  assert.doesNotMatch(raw, /DISPOSABLE-SECRET/u);
  const entries = raw
    .trim()
    .split("\n")
    .map((line): unknown => JSON.parse(line));
  assert.equal(entries.length, 2);
  assert.ok(isRecord(entries[0]));
  assert.ok(isRecord(entries[1]));
  assert.equal(entries[0].status, "started");
  assert.equal(entries[1].status, "refused");
  assert.equal(entries[1].phase, "bind-new-upload");
  assert.equal(entries[1].checkpoint, "c".repeat(40));
  let effects = 0;
  await assert.rejects(
    retainAggregateStepReceipt(filename, association, async () => {
      effects++;
    }),
    { code: "EEXIST" },
  );
  assert.equal(effects, 0);
  assert.equal(await readFile(filename, "utf8"), raw);
  const success = path.join(root, "success.jsonl");
  await retainAggregateStepReceipt(success, association, async (stage) => {
    stage("assemble-accepted-archives");
  });
  const terminal: unknown = JSON.parse((await readFile(success, "utf8")).trim().split("\n")[1]!);
  assert.ok(isRecord(terminal));
  assert.equal(terminal.status, "succeeded");
});

void test("existing reservation must bind prepared source, tree, version and the frozen Release attempt", async (t) => {
  const { request } = await trustedAssemblyFixture(t);
  const descriptor = JSON.stringify({
    schema_version: 1,
    checkpoint: "c".repeat(40),
    coordinator: { schema_version: 1, namespace: "portcove-fixture" },
    assembly: request,
    archives: [],
    evidence: {},
  });
  const active = {
    prepared_commit: "a".repeat(40),
    prepared_tree: "b".repeat(40),
    version: "0.1.0-alpha.3",
    phase: "building",
    release_run: { run_id: 12345, attempt: 1, revision: "a".repeat(40) },
  };
  const state = { checkpoint: "c".repeat(40), input: { active_candidate: active } };
  assert.equal((await requireReservedAggregate(descriptor, state)).accepted.run_id, "12345");
  for (const patch of [
    { prepared_commit: "d".repeat(40) },
    { prepared_tree: "d".repeat(40) },
    { version: "0.1.0-alpha.4" },
    { phase: "failed" },
    { release_run: null },
    { release_run: { ...active.release_run, run_id: 12346 } },
    { release_run: { ...active.release_run, attempt: 2 } },
    { release_run: { ...active.release_run, revision: "d".repeat(40) } },
  ]) {
    await assert.rejects(
      requireReservedAggregate(descriptor, {
        ...state,
        input: { active_candidate: { ...active, ...patch } },
      }),
      /existing prepared candidate/u,
    );
  }
  await assert.rejects(
    requireReservedAggregate(descriptor, { ...state, checkpoint: "d".repeat(40) }),
    /checkpoint/u,
  );
  await assert.rejects(
    requireReservedAggregate(descriptor, { ...state, input: { active_candidate: null } }),
    /existing prepared candidate/u,
  );
});

void test("descriptor transport refuses absent oversized unknown or unratified destination forms", () => {
  for (const raw of [
    undefined,
    "",
    " ".repeat(65537),
    "{}",
    JSON.stringify({ schema_version: 1, candidate_self_approved: true }),
  ])
    assert.throws(() => inspectAggregateDescriptor(raw));
});

void test("protected beta reservation requires the independently bound public build inputs", async (t) => {
  const f = await releasePublicBuildProvenanceFixture(t);
  const descriptor = {
    schema_version: 1,
    checkpoint: "c".repeat(40),
    coordinator: { schema_version: 1, namespace: "portcove-fixture" },
    assembly: f.request,
    archives: f.archives,
    evidence: f.expected,
  };
  const state = {
    checkpoint: descriptor.checkpoint,
    input: {
      active_candidate: {
        prepared_commit: f.request.source_commit,
        prepared_tree: f.request.source_tree,
        version: f.request.version,
        phase: "building",
        release_run: { run_id: 12345, attempt: 1, revision: f.request.source_commit },
      },
    },
  };
  assert.ok(
    (await requireReservedAggregate(JSON.stringify(descriptor), state)).accepted
      .public_build_inputs,
  );
  const { public_build_inputs: _binding, ...legacy } = f.request;
  await assert.rejects(
    requireReservedAggregate(
      JSON.stringify({ ...descriptor, assembly: { ...legacy, schema_version: 2 } }),
      state,
    ),
    /independently bound public build inputs/,
  );
});

void test("fresh own-job token request is bounded, nonredirecting and never emitted", async () => {
  const environment = {
    ACTIONS_ID_TOKEN_REQUEST_URL:
      "https://pipelines.actions.githubusercontent.com/fixture?api-version=1",
    ACTIONS_ID_TOKEN_REQUEST_TOKEN: "DISPOSABLE-FIXTURE",
  };
  let calls = 0;
  const fetcher: typeof fetch = async (url, options) => {
    calls++;
    assert.ok(url instanceof URL);
    assert.ok(options);
    assert.equal(url.searchParams.get("audience"), "fixture-audience");
    assert.equal(options.redirect, "error");
    assert.equal(
      (options.headers as Record<string, string>).Authorization,
      "Bearer DISPOSABLE-FIXTURE",
    );
    assert.ok(options?.signal);
    return new Response(JSON.stringify({ value: "DISPOSABLE-FIXTURE-JWT" }));
  };
  assert.equal(
    await requestAssemblerToken("fixture-audience", environment, fetcher),
    "DISPOSABLE-FIXTURE-JWT",
  );
  assert.equal(calls, 1);
  for (const endpoint of [
    "https://example.invalid/",
    "http://pipelines.actions.githubusercontent.com/",
    "https://pipelines.actions.githubusercontent.com.example.invalid/",
    "https://user@pipelines.actions.githubusercontent.com/",
  ]) {
    await assert.rejects(
      requestAssemblerToken(
        "fixture-audience",
        { ...environment, ACTIONS_ID_TOKEN_REQUEST_URL: endpoint },
        fetcher,
      ),
    );
  }
  assert.equal(calls, 1);
  await assert.rejects(
    requestAssemblerToken(
      "fixture-audience",
      environment,
      async () => new Response("x".repeat(32769)),
    ),
    /bound/u,
  );
  await assert.rejects(
    requestAssemblerToken(
      "fixture-audience",
      environment,
      async () => new Response(JSON.stringify({ value: "x".repeat(16385) })),
    ),
    /invalid/u,
  );
  await assert.rejects(
    requestAssemblerToken(
      "fixture-audience",
      environment,
      async () => new Response("", { status: 403 }),
    ),
    /refused/u,
  );
});

void test("held full workflow preserves privilege separation and refuses unavailable candidate admission", async () => {
  const template = await readFile(
    new URL("../docs/qualification/application-update-production.aggregate.yml", import.meta.url),
    "utf8",
  );
  const live = await readFile(
    new URL("../.github/workflows/application-update-production.yml", import.meta.url),
    "utf8",
  );
  assert.deepEqual(parseDocument(template, { uniqueKeys: true }).errors, []);
  assert.doesNotMatch(live, /: write|production-aggregate-steps/u);
  for (const job of ["independent_admission", "aggregate", "attest", "verify"])
    assert.match(
      template,
      new RegExp(`  ${job}:\\n(?:    #[^\\n]*\\n)*    if: \\$\\{\\{ false \\}\\}`),
    );
  assert.match(template, /node scripts\/acquire-release-admission.mts --handshake/u);
  assert.match(template, /name: Trusted package assembly/u);
  assert.match(template, /overwrite: false/u);
  assert.match(template, /if: \$\{\{ always\(\) \}\}/u);
  assert.match(template, /portcove-aggregate-\*-receipt.jsonl/u);
  assert.match(template, /steps.attest.outputs.bundle-path/u);
  assert.match(template, /PORTCOVE_NEW_ARTIFACT_ID: \$\{\{ steps.upload.outputs.artifact-id \}\}/u);
  assert.match(
    template,
    /PORTCOVE_NEW_ARTIFACT_SHA256: \$\{\{ steps.upload.outputs.artifact-digest \}\}/u,
  );
  const attester = template.split("  attest:")[1]!.split("  verify:")[0]!;
  assert.match(attester, /attestations: write/u);
  assert.doesNotMatch(
    attester,
    /checkout|download-artifact|PORTCOVE_ACCEPTED_AGGREGATE|contents: write/u,
  );
  assert.doesNotMatch(
    template,
    /^\s*(?:secrets|cache|workflow_call|pull_request_target):|contents: write/mu,
  );
  const assembler = template.split("  aggregate:")[1]!.split("  attest:")[0]!;
  assert.doesNotMatch(assembler, /pnpm |npm |action-setup/u);
  const verifier = template.split("  verify:")[1]!;
  assert.match(verifier, /production-aggregate-steps.mts verify/u);
  assert.match(verifier, /actions: read/u);
  assert.doesNotMatch(verifier, /: write|download-artifact|pnpm |npm |action-setup/u);
  assert.match(
    template,
    /pnpm install --frozen-lockfile --ignore-scripts --ignore-pnpmfile --store-dir/u,
  );
});

void test("the actual held attester normalizes only a bounded completed bundle and refuses repeat, oversized or absent input", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "portcove-bundle-copy-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const template: unknown = parseDocument(
    await readFile(
      new URL("../docs/qualification/application-update-production.aggregate.yml", import.meta.url),
      "utf8",
    ),
  ).toJS();
  assert.ok(isRecord(template) && isRecord(template.jobs) && isRecord(template.jobs.attest));
  assert.ok(Array.isArray(template.jobs.attest.steps));
  const step: unknown = template.jobs.attest.steps.find(
    (step: unknown) =>
      isRecord(step) && step.name === "Normalize only the completed bounded public bundle",
  );
  assert.ok(isRecord(step) && typeof step.run === "string");
  const script = step.run.match(/^node --input-type=module <<'NODE'\n([\s\S]*)\nNODE\n?$/u)?.[1];
  assert.ok(script);
  const source = path.join(root, "source.json");
  await writeFile(source, "public synthetic bundle");
  const run = () =>
    spawnSync(process.execPath, ["--input-type=module"], {
      input: script,
      encoding: "utf8",
      env: { ...process.env, RUNNER_TEMP: root, PORTCOVE_ATTESTATION_BUNDLE_PATH: source },
      timeout: 15000,
      windowsHide: true,
    });
  assert.equal(run().status, 0);
  assert.equal(
    await readFile(path.join(root, "aggregate-attestation.json"), "utf8"),
    "public synthetic bundle",
  );
  assert.notEqual(run().status, 0);
  assert.equal(
    await readFile(path.join(root, "aggregate-attestation.json"), "utf8"),
    "public synthetic bundle",
  );
  await rm(path.join(root, "aggregate-attestation.json"));
  await writeFile(source, Buffer.alloc(512 * 1024 + 1, 1));
  assert.notEqual(run().status, 0);
  assert.ok(!(await readdir(root)).includes("aggregate-attestation.json"));
  await writeFile(source, "");
  assert.notEqual(run().status, 0);
  assert.ok(!(await readdir(root)).includes("aggregate-attestation.json"));
  await rm(source);
  assert.notEqual(run().status, 0);
  await t.test(
    "actual POSIX FIFO source refuses without waiting for a writer",
    { skip: process.platform === "win32" },
    () => {
      execFileSync("mkfifo", [source]);
      const refused = run();
      assert.equal(refused.error, undefined);
      assert.equal(refused.signal, null);
      assert.notEqual(refused.status, 0);
    },
  );
});
