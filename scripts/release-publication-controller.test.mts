import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { createHash } from "node:crypto";
import { performance } from "node:perf_hooks";
import { isRecord } from "./runtime-values.mts";
import {
  runDistinctPublicationEffects,
  inspectPublicationAggregateContext,
  publicationOriginalJobDeadline,
  publicationResultDestination,
  inspectRetainedResultUpload,
} from "./release-publication-controller.mts";
import { inspectCapacityOperation } from "./release-capacity.mts";
import { releaseCanonicalDigest } from "./release-canonical.mts";
import { candidateProgressIdentity } from "./release-candidate-progress-contract.mts";
import { proposeImmutableReleaseTransition } from "./release-immutable-publication.mts";
import {
  inspectPublicationUploadHandoff,
  publicationUploadCommand,
} from "./release-publication-handoff.mts";

void test("the fixed release sequence executes twelve distinct effects and stops on the first refusal or repeated purpose", async () => {
  const seen: number[] = [];
  assert.deepEqual(
    await runDistinctPublicationEffects(async (ordinal) => {
      seen.push(ordinal);
      return { decision: "effect-observed", effect: { destination: `effect:${ordinal}` } };
    }),
    { effects: 12 },
  );
  assert.equal(seen.length, 12);
  let calls = 0;
  assert.deepEqual(
    await runDistinctPublicationEffects(async () => {
      calls++;
      return { decision: "complete" };
    }),
    { effects: 0 },
  );
  assert.equal(calls, 1);
  calls = 0;
  await assert.rejects(
    runDistinctPublicationEffects(async (ordinal) => {
      calls++;
      if (ordinal === 2) throw new Error("lost provider response");
      return { decision: "effect-observed", effect: { destination: "first" } };
    }),
    /lost provider/,
  );
  assert.equal(calls, 2);
  calls = 0;
  await assert.rejects(
    runDistinctPublicationEffects(async () => {
      calls++;
      return { decision: "effect-observed", effect: { destination: "same" } };
    }),
    /repeated/,
  );
  assert.equal(calls, 2);
  calls = 0;
  await assert.rejects(
    runDistinctPublicationEffects(async () => {
      calls++;
      return { decision: "ambiguous" };
    }),
    /ambiguous/,
  );
  assert.equal(calls, 1);
});

void test("all publication modes retain the original provider job budget rather than restarting it", () => {
  const identity = { run_id: "100", controller_revision: "a".repeat(40) },
    now = Date.parse("2026-10-20T00:05:00Z");
  const job = {
    id: 42,
    name: "Publish immutable application release",
    run_id: 100,
    run_attempt: 1,
    head_sha: identity.controller_revision,
    status: "in_progress",
    started_at: "2026-10-20T00:00:00Z",
  };
  assert.equal(
    publicationOriginalJobDeadline({ total_count: 1, jobs: [job] }, identity, now, 1000),
    51000,
  );
  for (const input of [
    { total_count: 2, jobs: [job] },
    { total_count: 2, jobs: [job, job] },
    { total_count: 1, jobs: [{ ...job, status: "completed" }] },
    { total_count: 1, jobs: [{ ...job, head_sha: "b".repeat(40) }] },
    { total_count: 1, jobs: [{ ...job, run_attempt: 2 }] },
    { total_count: 1, jobs: [{ ...job, started_at: "2026-10-20T00:06:00Z" }] },
  ])
    assert.throws(() => publicationOriginalJobDeadline(input, identity, now, 1000));
  assert.throws(
    () =>
      publicationOriginalJobDeadline({ total_count: 1, jobs: [job] }, identity, now + 50000, 1000),
    /exhausted/,
  );
});
void test("a retained report-repair promotion never recreates a missing Release or uploads partial assets", async () => {
  const candidate = {
    source_commit: "a".repeat(40),
    source_tree: "b".repeat(40),
    prepared_commit: "c".repeat(40),
    prepared_tree: "d".repeat(40),
    intent_sha256: "e".repeat(64),
    version: "0.19.0-preview.1",
    phase: "building",
    transient_retries: 1,
    substantive_repairs: 0,
    release_run: { run_id: 100, attempt: 1, revision: "c".repeat(40) },
  };
  const proof = {
    schema_version: 1,
    candidate_sha256: candidateProgressIdentity(candidate),
    controller_revision: "f".repeat(40),
    locators: [{ kind: "operation", id: "1".repeat(64), sha256: "2".repeat(64) }],
  };
  const retained = {
    ...candidate,
    stage_evidence: [
      {
        phase: "promoting",
        attempts: [
          {
            previous_checkpoint: "3".repeat(40),
            evidence_sha256: releaseCanonicalDigest(proof),
            proof,
            release_run: candidate.release_run,
            transient_retries: 0,
            substantive_repairs: 0,
          },
        ],
      },
    ],
  };
  const identity = {
    version: candidate.version,
    source_commit: candidate.prepared_commit,
    assets: [{ filename: "package.zip", bytes: 1, sha256: "4".repeat(64) }],
  };
  const partial = {
    id: 700,
    tag_name: `v${candidate.version}`,
    target_commitish: candidate.prepared_commit,
    prerelease: true,
    draft: true,
    immutable: false,
    url: "https://api.github.com/repos/boburning/portcove/releases/700",
    html_url: "https://github.com/boburning/portcove/releases/tag/untagged-fixture",
    upload_url:
      "https://uploads.github.com/repos/boburning/portcove/releases/700/assets{?name,label}",
  };
  for (const release of [null, partial]) {
    let mutations = 0;
    assert.deepEqual(
      await runDistinctPublicationEffects(async () => {
        mutations++;
        return { decision: "effect-observed", effect: { destination: "would-repeat-release" } };
      }, retained),
      { effects: 0 },
    );
    assert.throws(() => {
      if (proposeImmutableReleaseTransition(identity, release, []).decision !== "complete")
        throw new Error("complete immutable readback required");
    }, /complete immutable/);
    assert.equal(mutations, 0);
  }
});
void test("completed result upload returns only its retained locator and a repair destination consumes actual counters", () => {
  const candidate = {
    source_commit: "b".repeat(40),
    prepared_commit: "c".repeat(40),
    version: "0.19.0-preview.1",
    transient_retries: 0,
    substantive_repairs: 0,
  };
  const executor = {
    controller_revision: "d".repeat(40),
    execution_ref: "refs/tags/portcove-production-controller-fixture",
    workflow: ".github/workflows/application-update-production.yml",
    run_id: "100",
    run_attempt: 1,
    job_id: 500,
    check_run_id: "501",
    actor_id: "123",
    role: "release-publication",
  };
  const identity = {
    before_checkpoint: "a".repeat(40),
    candidate,
    executor_nonce: "e".repeat(64),
    executor_identity: executor,
    receipt_limit: 1,
    destination: publicationResultDestination(candidate),
    kind: "upload",
    sequence: 1,
    policy_sha256: "f".repeat(64),
    ratification_sha256: "1".repeat(64),
  };
  const raw = {
    ...identity,
    id: releaseCanonicalDigest(identity),
    outcome: "recovered",
    completed_effects: [
      {
        remote_identity: "github-actions:boburning/portcove:artifact:777",
        evidence_sha256: "2".repeat(64),
      },
    ],
    failure_evidence: null,
    recovery: {
      checkpoint: "3".repeat(40),
      resolution: "effect-completed",
      evidence_sha256: "2".repeat(64),
    },
  };
  const operation = inspectCapacityOperation(raw)!;
  assert.equal(inspectRetainedResultUpload(operation, candidate)?.artifact_id, 777);
  assert.equal(
    inspectRetainedResultUpload(operation, { ...candidate, transient_retries: 1 }),
    null,
  );
  assert.match(
    publicationResultDestination({ ...candidate, transient_retries: 1 }),
    /:recovery-1-0$/,
  );
  assert.throws(() => publicationResultDestination({ ...candidate, transient_retries: 3 }));
  assert.throws(
    () =>
      inspectRetainedResultUpload(
        { ...operation, outcome: "pending", completed_effects: [], recovery: null },
        candidate,
      ),
    /unresolved/,
  );
  assert.throws(
    () =>
      inspectRetainedResultUpload(
        {
          ...operation,
          completed_effects: [
            {
              remote_identity: "github-actions:foreign/repo:artifact:777",
              evidence_sha256: "2".repeat(64),
            },
          ],
        },
        candidate,
      ),
    /identity/,
  );
});

void test("same-job handoff routes only the exact pending report and retains exclusive uploaded locator", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "publication-handoff-")),
    directory = path.join(root, "producer"),
    old = {
      run: process.env.GITHUB_RUN_ID,
      attempt: process.env.GITHUB_RUN_ATTEMPT,
      output: process.env.GITHUB_OUTPUT,
    };
  try {
    process.env.GITHUB_RUN_ID = "100";
    process.env.GITHUB_RUN_ATTEMPT = "1";
    process.env.GITHUB_OUTPUT = path.join(root, "outputs");
    await mkdir(path.join(directory, "upload"), { recursive: true });
    const bytes = Buffer.from('{"fixture":true}'),
      sha = createHash("sha256").update(bytes).digest("hex");
    await writeFile(path.join(directory, "upload/immutable-release-result.json"), bytes);
    await writeFile(
      path.join(root, "publication-controller-output.json"),
      JSON.stringify({ directory, report_sha256: sha }),
    );
    await writeFile(
      path.join(directory, "result-ready.json"),
      JSON.stringify({
        name: "trusted-immutable-release-result-100-1",
        pending: { checkpoint: "a".repeat(40), operation_id: "b".repeat(64) },
        report_sha256: sha,
        files: ["immutable-release-result.json"],
        authority: "none",
      }),
    );
    assert.equal((await inspectPublicationUploadHandoff(root)).report_sha256, sha);
    await publicationUploadCommand("--ready", root, performance.now() + 1000);
    assert.match(
      await readFile(process.env.GITHUB_OUTPUT, "utf8"),
      /name=trusted-immutable-release-result-100-1/,
    );
    const artifact = { id: 99, sha256: "c".repeat(64) };
    await publicationUploadCommand("--uploaded", root, performance.now() + 1000, artifact);
    assert.deepEqual(
      JSON.parse(await readFile(path.join(directory, "result-uploaded.json"), "utf8")),
      artifact,
    );
    await assert.rejects(
      publicationUploadCommand("--uploaded", root, performance.now() + 1000, artifact),
      /EEXIST/,
    );
    await writeFile(path.join(directory, "upload/immutable-release-result.json"), "changed");
    await assert.rejects(inspectPublicationUploadHandoff(root), /report changed/);
    await writeFile(
      path.join(root, "publication-controller-process-ended.json"),
      JSON.stringify({ exit_code: 1 }),
    );
    await assert.rejects(
      publicationUploadCommand("--predicate", root, performance.now() + 1000),
      /producer refused/,
    );
  } finally {
    for (const [name, value] of [
      ["GITHUB_RUN_ID", old.run],
      ["GITHUB_RUN_ATTEMPT", old.attempt],
      ["GITHUB_OUTPUT", old.output],
    ] as const)
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    await rm(root, { recursive: true, force: true });
  }
});

void test("publication preserves old signed context while an actual recovery custodian reattests the same aggregate", () => {
  const revision = "a".repeat(40),
    ref = "refs/tags/portcove-production-controller-fixture";
  const original = {
    controller_revision: revision,
    controller_ref: ref,
    run_id: "91",
    run_attempt: 1,
  };
  const current = { ...original, run_id: "92" };
  const aggregate = {
    ...original,
    artifact_id: 11,
    sha256: "b".repeat(64),
    bundle_artifact_id: 12,
    bundle_sha256: "c".repeat(64),
  };
  const binding = { aggregate_sha256: aggregate.sha256 };
  assert.equal(
    inspectPublicationAggregateContext(aggregate, original, binding, current).authority,
    "none",
  );
  const originalUpload = {
    actor_id: "93",
    before_checkpoint: "d".repeat(40),
    check_run_id: "94",
    controller_revision: revision,
    execution_ref: ref,
    expectation_sha256: "e".repeat(64),
    job_id: 95,
    operation_id: "f".repeat(64),
    run_attempt: 1,
    run_id: "91",
    workflow: ".github/workflows/application-update-production.yml",
  };
  const recovered = {
    ...aggregate,
    run_id: current.run_id,
    bundle_artifact_id: 13,
    original_upload: originalUpload,
  };
  assert.equal(
    inspectPublicationAggregateContext(recovered, original, binding, current).authority,
    "none",
  );
  for (const changed of [
    { ...recovered, original_upload: undefined },
    { ...recovered, run_id: "99" },
    { ...recovered, controller_revision: "0".repeat(40) },
    { ...recovered, controller_ref: "refs/tags/portcove-production-controller-other" },
    { ...recovered, sha256: "0".repeat(64) },
    { ...recovered, original_upload: { ...originalUpload, operation_id: "invalid" } },
  ])
    assert.throws(() => inspectPublicationAggregateContext(changed, original, binding, current));
  // Parsed routing never manufactures the actual admitted aggregate or signer.
  assert.throws(() =>
    inspectPublicationAggregateContext(
      recovered,
      original,
      { aggregate_sha256: "0".repeat(64) },
      current,
    ),
  );
});

type FixtureBoundary = {
  url: string;
  exports: { name: string; callable: boolean; value?: unknown }[];
};

async function publicationConfigurationBehavior(
  entry: string,
  root: string,
  boundaries: FixtureBoundary[],
) {
  const { mock } = await import("node:test");
  const childProcess = await import("node:child_process");
  function forbidden(): never {
    throw new Error("Unowned process or publication effect is forbidden in this fixture");
  }
  const processes = Object.fromEntries(
    Object.entries(childProcess)
      .filter(([name]) => name !== "default")
      .map(([name, value]) => [name, typeof value === "function" ? forbidden : value]),
  );
  mock.module("node:child_process", { namedExports: processes, defaultExport: processes });
  process.kill = forbidden;
  const identity = {
    audience: "portcove-release-publication-reader-v1",
    subject: "fixed-inert-subject",
    controller_revision: "a".repeat(40),
    controller_ref: "refs/tags/portcove-production-controller-fixture",
    actor_id: "1234",
    run_id: "12345",
    run_attempt: 1,
  };
  Object.assign(process.env, {
    GITHUB_RUN_ID: identity.run_id,
    GITHUB_RUN_ATTEMPT: "1",
    GITHUB_SHA: identity.controller_revision,
    GITHUB_REF: identity.controller_ref,
    RUNNER_TEMP: root,
  });
  const roles = ["releases", "preview", "stable", "snapshot", "timestamp"].map((role) => ({
    role,
    marker: "original",
  }));
  const input = {
    identity,
    tools: { artifact: { marker: "original-artifact" }, bundle: { marker: "original-bundle" } },
    context: { marker: "original-context" },
    roles,
    configuration: {
      admission_configuration: { namespace: "inert" },
      aggregate: { marker: "original-configuration" },
      native_locators: [],
    },
  };
  const reached = Promise.withResolvers<void>(),
    release = Promise.withResolvers<void>();
  const observed: unknown[] = [];
  const toolsReceipt = Object.freeze({ kind: "inert-tools" });
  const contextReceipt = Object.freeze({ kind: "inert-context" });
  const receivedRoles: object[] = [];
  const boundary = new Error(
    "Controlled read-only aggregate boundary; no admission or publication",
  );
  const replacements: Record<string, Record<string, unknown>> = {
    [new URL("release-controller-tool-admission.mts", entry).href]: {
      receiveControllerTools: async (_root: string, artifact: unknown, bundle: unknown) => {
        observed.push(structuredClone({ artifact, bundle }));
        reached.resolve();
        await release.promise;
        return toolsReceipt;
      },
      verifiedControllerToolPaths: async (receipt: object) => {
        assert.equal(receipt, toolsReceipt);
        return {};
      },
    },
    [new URL("release-signing-context-artifact.mts", entry).href]: {
      receiveSigningContextArtifact: async (_root: string, context: unknown) => {
        observed.push(context);
        return contextReceipt;
      },
      requireReceivedSigningContext: async (receipt: object) => {
        assert.equal(receipt, contextReceipt);
        return {};
      },
    },
    [new URL("release-tuf-role-artifact.mts", entry).href]: {
      receiveTufRoleArtifact: async (_context: unknown, _root: string, role: unknown) => {
        assert.equal(_context, contextReceipt);
        observed.push(role);
        const receipt = Object.freeze({ role });
        receivedRoles.push(receipt);
        return receipt;
      },
    },
    [new URL("release-tuf-publication.mts", entry).href]: {
      prepareActualTufPublication: async (context: object, tools: object, roles: object[]) => {
        assert.equal(context, contextReceipt);
        assert.equal(tools, toolsReceipt);
        assert.equal(roles.length, 5);
        assert.equal(receivedRoles.length, 5);
        for (const [index, receipt] of roles.entries()) assert.equal(receipt, receivedRoles[index]);
        return {};
      },
    },
    [new URL("release-payload-preparation.mts", entry).href]: {
      inspectControllerAggregateLocator: (aggregate: unknown) => {
        observed.push(aggregate);
        throw boundary;
      },
    },
    [new URL("github-api.mts", entry).href]: {
      createGitHubRunner: () => forbidden,
      GitHubApiClient: class {
        request(method: string, endpoint: string) {
          assert.equal(method, "GET");
          assert.equal(
            endpoint,
            `repos/boburning/portcove/actions/runs/${identity.run_id}/attempts/1/jobs?per_page=100`,
          );
          return {
            status: 200,
            body: {
              total_count: 1,
              jobs: [
                {
                  id: 42,
                  name: "Publish immutable application release",
                  run_id: Number(identity.run_id),
                  run_attempt: 1,
                  head_sha: identity.controller_revision,
                  status: "in_progress",
                  started_at: new Date().toISOString(),
                },
              ],
            },
          };
        }
      },
    },
  };
  for (const module of boundaries)
    mock.module(module.url, {
      namedExports: Object.fromEntries(
        module.exports.map((item) => [
          item.name,
          replacements[module.url]?.[item.name] ?? (item.callable ? forbidden : item.value),
        ]),
      ),
    });
  const actual: unknown = await import(entry);
  assert.ok(actual !== null && typeof actual === "object");
  const invoke: unknown = Reflect.get(actual, "runFixedPublicationConfiguration");
  assert.equal(typeof invoke, "function");
  const pending = Promise.resolve(
    Reflect.apply(invoke as (...args: unknown[]) => unknown, undefined, [
      input,
      performance.now() + 10000,
    ]),
  );
  // A replaced entry/receiver must fail rather than leave the handshake pending.
  await Promise.race([
    reached.promise,
    pending.then(() => assert.fail("Publication entry skipped its first receiver")),
  ]);
  input.context.marker = "changed-context";
  input.configuration.aggregate.marker = "changed-configuration";
  input.tools.artifact.marker = "changed-artifact";
  input.roles.splice(0, 5, ...roles.map((role) => ({ ...role, marker: "changed-role" })));
  release.resolve();
  await assert.rejects(pending, (error) => error === boundary);
  assert.deepEqual(observed, [
    { artifact: { marker: "original-artifact" }, bundle: { marker: "original-bundle" } },
    { marker: "original-context" },
    ...["releases", "preview", "stable", "snapshot", "timestamp"].map((role) => ({
      role,
      marker: "original",
    })),
    { marker: "original-configuration" },
  ]);
}

void test("fixed publication source function freezes caller locators before the controlled receiver await", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "fixed-publication-alias-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const entry = new URL("./release-publication-controller.mts", import.meta.url);
  const boundaries: FixtureBoundary[] = [];
  for (const name of [
    "release-controller-tool-admission.mts",
    "release-signing-context-artifact.mts",
    "release-tuf-role-artifact.mts",
    "release-tuf-publication.mts",
    "release-payload-preparation.mts",
    "github-api.mts",
  ]) {
    const url = new URL(name, entry).href;
    const namespace: unknown = await import(url);
    assert.ok(isRecord(namespace));
    boundaries.push({
      url,
      exports: Object.entries(namespace).map(([name, value]) => ({
        name,
        callable: typeof value === "function",
        ...(typeof value === "function" ? {} : { value }),
      })),
    });
  }
  const { spawnSync } = await import("node:child_process");
  const environment = { ...process.env };
  delete environment.NODE_TEST_CONTEXT;
  const result = spawnSync(
    process.execPath,
    [
      "--experimental-test-module-mocks",
      "--input-type=module",
      "--eval",
      `import assert from 'node:assert/strict';await (${publicationConfigurationBehavior.toString()})(${JSON.stringify(entry.href)},${JSON.stringify(root)},${JSON.stringify(boundaries)});`,
    ],
    { env: environment, encoding: "utf8", timeout: 15000, maxBuffer: 65536 },
  );
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stderr || result.stdout);
});
