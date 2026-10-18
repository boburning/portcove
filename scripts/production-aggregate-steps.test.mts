import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { parseDocument } from "yaml";
import { trustedAssemblyFixture } from "./fixtures/trusted-assembly-fixture.mts";
import {
  inspectAggregateDescriptor,
  requireReservedAggregate,
  requestAssemblerToken,
} from "./production-aggregate-steps.mts";

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
  for (const job of ["independent_admission", "aggregate", "attest"])
    assert.match(
      template,
      new RegExp(`  ${job}:\\n(?:    #[^\\n]*\\n)*    if: \\$\\{\\{ false \\}\\}`),
    );
  assert.match(template, /UNKNOWN: independent accepted file matrix/u);
  assert.match(template, /name: Trusted package assembly/u);
  assert.match(template, /overwrite: false/u);
  assert.match(template, /PORTCOVE_NEW_ARTIFACT_ID: \$\{\{ steps.upload.outputs.artifact-id \}\}/u);
  assert.match(
    template,
    /PORTCOVE_NEW_ARTIFACT_SHA256: \$\{\{ steps.upload.outputs.artifact-digest \}\}/u,
  );
  const attester = template.split("  attest:")[1]!;
  assert.match(attester, /attestations: write/u);
  assert.doesNotMatch(
    attester,
    /checkout|download-artifact|PORTCOVE_ACCEPTED_AGGREGATE|contents: write/u,
  );
  assert.doesNotMatch(
    template,
    /^\s*(?:secrets|cache|workflow_call|pull_request_target):|pnpm |npm |contents: write/mu,
  );
});
