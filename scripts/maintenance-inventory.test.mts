import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import vm from "node:vm";
import { parse } from "yaml";
import { postgresFixture, postgresServer } from "./fixtures/postgres-cluster.mts";
import {
  deferralChanges,
  deliveryFacts,
  reassessmentTriggers,
  subjectReassessment,
  sourceFreshness,
  subjectFilterSource,
  qualificationSummary,
  publicationEntries,
  publicationFacts,
  acquireCollection,
  readTargetRoutes,
  targetSummary,
  assessmentSubject,
  hostPlatform,
  acknowledgeDigest,
  buildDigest,
  renderDigestMarkdown,
  buildReport,
  canonicalJson,
  capabilityResult,
  collect,
  main,
  readSample,
  renderHtml,
  takeIssueCredential,
  writeReport,
  type DefinitionDeliveryInspection,
  type SubjectReassessment,
  type InventoryReport,
} from "./maintenance-inventory.mts";
import type { UpstreamInput } from "./maintenance-upstream.mts";
import { issueReconsiderations, targetReconsiderations } from "./maintenance-reconsiderations.mts";
import { explicitBlockerFields } from "./roadmap-qualification.mts";
import type { HostedRequestStatus, HostedStatusAll } from "./hosted-discovery-intake.mts";
import { GitHubApiError } from "./github-operation.mts";
import { migrate, migrationTransaction, readMigrations, runSql } from "./maintenance-store.mts";
import {
  handoffOperationId,
  handoffPolicyVersion,
  handoffSubject,
  readOpenHandoffs,
  recordHandoffOperations,
} from "./maintenance-handoffs.mts";
import {
  catalog as catalogFixture,
  checkpoint,
  exception,
  keyOf,
  progress,
  scope,
} from "./fixtures/upstream-checkpoint-fixture.mts";

const report = (setup: string) => ({
  format_version: 1,
  port_id: "x",
  routes: [
    {
      route: "managed",
      install_id: null,
      features: [
        {
          feature: "setup",
          mode: setup,
          explanation: "e",
          next_step: "n",
          action: null,
          listing_action: null,
        },
      ],
    },
  ],
  observations: [],
  detail_problems: [],
});

void test("inventory facts hash canonically and Core reports are projected without reinterpretation", () => {
  assert.equal(
    canonicalJson({ b: 1, a: [{ d: 2, c: 3 }] }),
    canonicalJson({ a: [{ c: 3, d: 2 }], b: 1 }),
  );
  assert.equal(
    canonicalJson({ a: undefined, b: [undefined, 1] }),
    JSON.stringify({ b: [null, 1] }),
  );
  assert.deepEqual(capabilityResult({ ok: true, report: report("automatic") }), {
    state: "managed-setup.automatic",
    explanation: {
      report_format: 1,
      routes: [
        {
          route: "managed",
          features: [{ feature: "setup", mode: "automatic", explanation: "e", next_step: "n" }],
        },
      ],
      detail_problems: [],
    },
  });
  assert.equal(
    capabilityResult({ ok: false, error: { code: "not_found", message: "unknown port id" } }).state,
    "unassessed.not_found",
  );
  assert.equal(readSample().format_version, 1);
});

void test("the issue collector reads only its own named credential and removes it from the environment", async () => {
  const environment: NodeJS.ProcessEnv = {
    GH_TOKEN: "workflow-token",
    PORTCOVE_ROADMAP_GH_TOKEN: " project-token\n",
  };
  assert.deepEqual(takeIssueCredential("PORTCOVE_ROADMAP_GH_TOKEN", environment), {
    kind: "explicit",
    token: "project-token",
  });
  assert.deepEqual(environment, { GH_TOKEN: "workflow-token" }, "no child process inherits it");
  // An explicit credential never falls back to the other sources' credential.
  assert.throws(
    () => takeIssueCredential("PORTCOVE_ROADMAP_GH_TOKEN", environment),
    /Set PORTCOVE_ROADMAP_GH_TOKEN to the issue and Project read credential/u,
  );
  const empty: NodeJS.ProcessEnv = { GH_TOKEN: "workflow-token", PORTCOVE_ROADMAP_GH_TOKEN: "" };
  assert.throws(() => takeIssueCredential("PORTCOVE_ROADMAP_GH_TOKEN", empty), /Set PORTCOVE/u);
  assert.equal(Object.hasOwn(empty, "PORTCOVE_ROADMAP_GH_TOKEN"), false);
  assert.throws(() => takeIssueCredential("lower-case", {}), /must name an environment variable/u);

  const database = "PORTCOVE_MAINTENANCE_TEST_ISSUE_OPTION_URL";
  try {
    for (const argv of [
      ["collect", "--cli", "portcove", "--all", "--issues-token-env", "PROJECT_TOKEN"],
      ["report", "--output", "out", "--issues", "--issues-token-env", "PROJECT_TOKEN"],
    ]) {
      process.env[database] = "postgresql://collector@127.0.0.1:9/unused";
      await assert.rejects(
        main([argv[0]!, "--database-env", database, ...argv.slice(1)]),
        /--issues-token-env applies only to collect --issues/u,
      );
      // main consumes the URL so no child process can inherit it.
      assert.equal(Object.hasOwn(process.env, database), false);
    }
  } finally {
    delete process.env[database];
  }
});

void test("the hosted workflow runs daily on main with least privilege and a read-only Project credential", () => {
  const source = readFileSync(
    new URL("../.github/workflows/maintenance-inventory.yml", import.meta.url),
    "utf8",
  );
  type Step = {
    name?: string;
    run?: string;
    uses?: string;
    env?: Record<string, string>;
    with?: Record<string, unknown>;
  };
  type Job = {
    if?: string;
    permissions?: unknown;
    "timeout-minutes"?: number;
    steps: Step[];
  };
  const workflow = parse(source) as {
    on: { schedule: { cron: string }[]; workflow_dispatch: unknown };
    permissions: unknown;
    concurrency: { "cancel-in-progress": boolean };
    jobs: Record<string, Job>;
  };
  assert.deepEqual(workflow.on.schedule, [{ cron: "47 4 * * *" }]);
  assert.equal(workflow.on.workflow_dispatch, null, "dispatch takes no inputs");
  assert.equal(workflow.concurrency["cancel-in-progress"], false);
  assert.deepEqual(workflow.permissions, { contents: "read" });
  const { collect, "restore-proof": restoreProof } = workflow.jobs;
  assert.deepEqual(Object.keys(workflow.jobs), ["collect", "restore-proof"]);
  assert.equal(
    collect!.if,
    "github.repository == 'boburning/portcove' && github.ref == 'refs/heads/main'",
  );
  assert.deepEqual(collect!.permissions, { contents: "read", actions: "read", issues: "read" });
  assert.deepEqual(restoreProof!.permissions, { contents: "read" });
  for (const job of [collect!, restoreProof!]) assert.ok(job["timeout-minutes"]! > 0);
  assert.doesNotMatch(source, /set -x|set -o xtrace/u);

  // Secrets reach only step environments, never a command line or job-wide environment.
  const steps = [...collect!.steps, ...restoreProof!.steps];
  for (const step of steps) {
    assert.doesNotMatch(step.run ?? "", /secrets\./u, String(step.name ?? step.uses));
    assert.doesNotMatch(
      JSON.stringify(step.with ?? {}),
      /secrets\./u,
      String(step.name ?? step.uses),
    );
  }
  const using = (secret: string) =>
    steps
      .filter((step) =>
        Object.values(step.env ?? {}).some((value) => value.includes(`secrets.${secret}`)),
      )
      .map((step) => step.name);
  assert.deepEqual(using("PORTCOVE_ROADMAP_TOKEN"), [
    "Require hosted configuration without exposing credentials",
    "Collect every declared source in one transaction",
  ]);
  assert.ok(using("PORTCOVE_DATABASE_URL").length > 1);
  // The secret is exposed to the store commands under their default variable name.
  assert.ok(
    steps.some((step) =>
      (step.env?.PORTCOVE_MAINTENANCE_DATABASE_URL ?? "").includes("secrets.PORTCOVE_DATABASE_URL"),
    ),
  );
  assert.equal(
    restoreProof!.steps.some((step) => step.env),
    false,
    "the restore target is local",
  );
  const collection = collect!.steps.find(
    (step) => step.name === "Collect every declared source in one transaction",
  )!;
  assert.equal(collection.env!.PORTCOVE_ROADMAP_GH_TOKEN, "${{ secrets.PORTCOVE_ROADMAP_TOKEN }}");
  assert.equal(collection.env!.GH_TOKEN, "${{ secrets.GITHUB_TOKEN }}");
  assert.match(collection.run!, /--issues --issues-token-env PORTCOVE_ROADMAP_GH_TOKEN/u);
  for (const flag of [
    "--all",
    "--release-health",
    "--publication",
    "--delivery",
    "--upstream",
    "--hosted-intake",
    "--targets",
  ])
    assert.ok(collection.run!.includes(flag), flag);

  const uploads = steps.filter((step) => step.uses?.startsWith("actions/upload-artifact@"));
  assert.equal(uploads.length, 3);
  for (const upload of uploads) assert.equal(upload.with!["retention-days"], 30);
});

void test("main definitions come from the committed bundle and never from an HTTP status", () => {
  const inspection = {
    index_sha256: "f".repeat(64),
    definitions: [
      {
        namespace: "official",
        stable_id: "example",
        revision: 1,
        definition_target: "sha256/x.json",
      },
    ],
  };
  assert.deepEqual(publicationFacts({ inspection }).facts.get("definition:official/example"), {
    main: {
      index_sha256: "f".repeat(64),
      revision: 1,
      definition_target: "sha256/x.json",
      policy_target: null,
      policy_revision: null,
      launch_revision: null,
    },
  });
  assert.throws(() => publicationFacts({ inspection: {} }), /Unsupported/u);
  assert.throws(
    () =>
      publicationFacts({
        inspection: { index_sha256: "f", definitions: [{ namespace: "../x", stable_id: "y" }] },
      }),
    /Unsupported definition identity/u,
  );
});

const verifiedDelivery = (
  definitions: { stable_id: string; revision: number; target: string }[],
): DefinitionDeliveryInspection => ({
  format_version: 1,
  metadata_base_url: "https://example.test/metadata/",
  serving: "verified",
  reason: null,
  provenance: { index_sha256: "e".repeat(64), timestamp_version: 7 },
  definitions: definitions.map((definition) => ({
    namespace: "official",
    sha256: "d".repeat(64),
    length: 10,
    ...definition,
  })),
});

const unverifiedDelivery = (
  serving: "not_served" | "incomplete" | "unreachable" | "expired",
): DefinitionDeliveryInspection => ({
  format_version: 1,
  metadata_base_url: "https://example.test/metadata/",
  serving,
  reason: "could not acquire authenticated definition repository",
  provenance: null,
  definitions: [],
});

void test("only Core-verified delivery records published definitions", () => {
  const verified = deliveryFacts(
    verifiedDelivery([{ stable_id: "example", revision: 2, target: "sha256/y.json" }]),
  );
  assert.equal(verified.gaps.length, 0);
  assert.match(verified.revision, /serving=verified;index-sha256=e{64};timestamp=7$/u);
  assert.deepEqual(verified.facts.get("definition:official/example"), {
    published: { revision: 2, target: "sha256/y.json", sha256: "d".repeat(64), length: 10 },
  });
  // Not served, unreachable and expired are the run's gap, never "not published".
  for (const serving of ["not_served", "incomplete", "unreachable", "expired"] as const) {
    const outcome = deliveryFacts(unverifiedDelivery(serving));
    assert.equal(outcome.facts.size, 0);
    assert.equal(outcome.expected, null);
    assert.deepEqual(
      outcome.gaps.map(({ subject_key, code }) => [subject_key, code]),
      [["source:definition-delivery", serving]],
    );
  }
  // A claimed verification without provenance, or facts without verification, is refused.
  assert.throws(() => deliveryFacts({ ...verifiedDelivery([]), provenance: null }), /Unsupported/u);
  assert.throws(
    () =>
      deliveryFacts({
        ...unverifiedDelivery("not_served"),
        definitions: verifiedDelivery([{ stable_id: "x", revision: 1, target: "t" }]).definitions,
      }),
    /Unsupported/u,
  );
  assert.throws(
    () =>
      deliveryFacts(
        verifiedDelivery([
          { stable_id: "x", revision: 1, target: "a" },
          { stable_id: "x", revision: 2, target: "b" },
        ]),
      ),
    /Duplicate/u,
  );
});

void test("publication entries compare main with the last verified publication by identity", () => {
  const main = (id: string, revision: number, target: string) => ({
    definition: `definition:official/${id}`,
    facts: { main: { revision, definition_target: target } },
  });
  const published = (id: string, revision: number, target: string) => ({
    definition: `definition:official/${id}`,
    facts: { published: { revision, target } },
  });
  assert.deepEqual(
    publicationEntries(
      [main("same", 1, "a"), main("newer", 2, "c"), main("unpublished", 1, "e")],
      [published("same", 1, "a"), published("newer", 1, "b"), published("withdrawn", 1, "f")],
      true,
    ).map(({ definition, comparison }) => [definition, comparison]),
    [
      ["definition:official/newer", "published-differs-from-main"],
      ["definition:official/same", "published-matches-main"],
      ["definition:official/unpublished", "never-verified-published"],
      ["definition:official/withdrawn", "published-not-on-main"],
    ],
  );
  assert.equal(
    publicationEntries([], [published("only", 1, "a")], false)[0]?.comparison,
    "main-unobserved",
  );
  const absent = (id: string) => ({
    definition: `definition:official/${id}`,
    facts: { absent: true },
  });
  assert.deepEqual(
    publicationEntries([main("pulled", 1, "a")], [absent("pulled"), absent("gone")], true).map(
      ({ definition, comparison, published: value }) => [definition, comparison, value],
    ),
    [["definition:official/pulled", "published-withdrawn", null]],
  );
});

void test("the static report escapes untrusted text and states unknown publication", () => {
  const page = renderHtml({
    format: "portcove-maintenance-inventory",
    format_version: 1,
    generated_at: "2026-11-11T00:00:00.000Z",
    generation: 1,
    scope: "declared-sample",
    publication: { status: "unknown", reason: "<b>none</b>" },
    unsupported_sources: [{ source: "issues", reason: "</script><script>alert(1)</script>" }],
    runs: [
      {
        source: "<i>x</i>",
        coverage: "complete",
        source_revision: "r",
        observed_count: 1,
        expected_count: 1,
        completed_at: "t",
      },
    ],
    subjects: [
      {
        subject_key: "port:</script>",
        state: "s",
        sequence: 1,
        verified_at: "t",
        changed_at: "t",
      },
    ],
  } satisfies InventoryReport);
  assert.equal(page.match(/<\/script>/gu)?.length, 2, "only the page's own two scripts close");
  assert.doesNotMatch(page, /<b>none<\/b>|<i>x<\/i>/u);
  assert.match(page, /unknown/u);
  // The page's own script is valid JavaScript and embeds the tested filter.
  const script = /<script>\n([\s\S]*?)<\/script>/u.exec(page)?.[1] ?? "";
  assert.ok(script.includes(subjectFilterSource));
  assert.doesNotThrow(() => new vm.Script(script));
  for (const id of ["search", "platform", "state", "changed", "attention", "shown"])
    assert.match(page, new RegExp(`id="${id}"`, "u"));
});

const server = postgresServer();

/** A stub Core CLI answering from responses.json and logging its isolation paths. */
function stubCli(root: string) {
  const responses = path.join(root, "responses.json");
  const cli = path.join(root, "portcove-stub.mjs");
  writeFileSync(
    cli,
    `#!${process.execPath}
  import { readFileSync } from "node:fs";
  import { appendFileSync, mkdirSync, realpathSync, writeFileSync } from "node:fs";
  import path from "node:path";
  const args = process.argv.slice(2);
  const responses = JSON.parse(readFileSync(${JSON.stringify(responses)}, "utf8"));
  const preferences = process.env.PORTCOVE_PREFERENCES;
  mkdirSync(path.join(path.dirname(preferences), "diagnostics"), { recursive: true });
  const root = path.dirname(path.dirname(preferences));
  appendFileSync(${JSON.stringify(path.join(root, "isolation.log"))}, JSON.stringify([preferences, process.env.PORTCOVE_APPLICATION_RUNTIME_LOCK, args[1], realpathSync(root) === root, path.dirname(process.env.HOME) === root]) + "\\n");
  writeFileSync(path.join(path.dirname(preferences), "diagnostics", "session-01"), "simulated");
  const reply = (envelope) => { console.log(JSON.stringify({ schema_version: 88, ...envelope })); process.exitCode = envelope.ok ? 0 : 1; };
  if (args.includes("capabilities")) {
    reply({ ok: true, data: { schema_version: 88, port_capability_schema: 1 }, error: null });
  } else if (args.includes("inspect-targets")) {
    const ids = args.flatMap((value, index) => (args[index - 1] === "--port" ? [value] : []));
    reply({ ok: true, error: null, data: { format_version: responses.targetsFormat ?? 2, scope: "fixture", platforms: ["linux-x86-64"],
      producer: responses.producer ?? { source_revision: null, features: [], embedded_catalog_sha256: "c".repeat(64), embedded_listings_sha256: "e".repeat(64), catalog_override: false },
      ports: ids.map((id) => ({ port_id: id, presence: responses["targets:" + id] ?? "operational",
        declared_platforms: ["linux-x86-64"], acquisition_hold: null, download_restriction: null,
        targets: (responses["targets:" + id] ?? "operational") === "operational" ? [{ platform: "linux-x86-64",
          routes: [{ action: "install", offered: true, reason: null }, { action: "register_external", offered: false, reason: "route_not_offered" }],
          provider_resolution_required: false, definition_eligibility: "unknown", readiness: "unknown",
          qualification: responses["qualification:" + id] ?? { state: "unqualified", known_failure: false,
            qualified_refs: [], evidence_route: "unrecorded",
            offered_artifact: { state: "provider_resolved", route: "install" }, scopes: [], legacy_coverage: [] } }] : [] })) } });
  } else {
    const id = args.at(-1);
    const data = responses[id];
    if (typeof data === "string") reply({ ok: false, data: null, error: { code: data, message: "host failure" } });
    else if (data) reply({ ok: true, data, error: null });
    else reply({ ok: false, data: null, error: { code: "not_found", message: "unknown port id: " + id } });
  }
  `,
  );
  chmodSync(cli, 0o755);
  return { cli, responses };
}

void test(
  "declared records flow through Core assessment, the store and a static report",
  { skip: server.skip ?? false, timeout: 240_000 },
  async (context) => {
    const fixture = postgresFixture(context, server.directory!);
    const store = fixture.start("store");
    migrate(store.owner);
    runSql(
      store.owner,
      `CREATE ROLE collector_login LOGIN IN ROLE portcove_maintenance_collector;
       CREATE ROLE report_login LOGIN IN ROLE portcove_maintenance_report;
       CREATE ROLE executor_login LOGIN IN ROLE portcove_maintenance_executor;`,
    );
    const { cli, responses } = stubCli(fixture.root);
    const sample = path.join(fixture.root, "sample.json");
    writeFileSync(
      sample,
      JSON.stringify({ format_version: 1, ports: ["2ship2harkinian", "not-a-catalog-port"] }),
    );
    const respond = (ship: string, other?: string) =>
      writeFileSync(
        responses,
        JSON.stringify({
          "2ship2harkinian": ship === "automatic" || ship === "manual" ? report(ship) : ship,
          ...(other ? { "not-a-catalog-port": other } : {}),
        }),
      );
    const collector = store.as("collector_login");
    const history = () =>
      JSON.parse(
        runSql(
          store.owner,
          `SELECT json_agg(json_build_object('subject', split_part(subject_key, '@', 1), 'sequence', sequence, 'state', state, 'returns', returns_to_earlier_result)
             ORDER BY subject_key, sequence) FROM portcove_maintenance.subject_transitions;`,
        ),
      ) as { subject: string; sequence: number; state: string; returns: boolean }[];

    respond("automatic");
    await collect({ cli, sample, environment: collector, runner: "fixture" });
    await collect({ cli, sample, environment: collector, runner: "fixture" });
    assert.deepEqual(
      history().map(({ subject, state }) => [subject, state]),
      [
        ["port:2ship2harkinian", "managed-setup.automatic"],
        ["port:not-a-catalog-port", "unassessed.not_found"],
      ],
      "an identical repeated pass converges on the same assessments without new transitions",
    );
    respond("manual");
    await collect({ cli, sample, environment: collector, runner: "fixture" });
    respond("automatic");
    await collect({ cli, sample, environment: collector, runner: "fixture" });
    assert.deepEqual(
      history()
        .filter(({ subject }) => subject === "port:2ship2harkinian")
        .map(({ state, returns }) => [state, returns]),
      [
        ["managed-setup.automatic", false],
        ["managed-setup.manual", false],
        ["managed-setup.automatic", true],
      ],
    );

    // Changes-only digest: baselines are quiet, the return to an earlier result is flagged.
    const shipSubject = assessmentSubject("2ship2harkinian", hostPlatform());
    const digest = buildDigest(store.as("report_login"));
    assert.deepEqual(
      digest.entries.map(({ subject_key, previous_state, state, returns_to_earlier_result }) => [
        subject_key,
        previous_state,
        state,
        returns_to_earlier_result,
      ]),
      [
        [shipSubject, "managed-setup.automatic", "managed-setup.manual", false],
        [shipSubject, "managed-setup.manual", "managed-setup.automatic", true],
      ],
    );
    assert.match(renderDigestMarkdown(digest), /returns to an earlier result/u);
    assert.throws(() => acknowledgeDigest(collector, digest, "receipt"), /permission denied/u);
    const executor = store.as("executor_login");
    const receipt = "https://github.com/boburning/portcove/issues/4129#issuecomment-1";
    assert.deepEqual(acknowledgeDigest(executor, digest, receipt), { delivered: 2 });
    assert.deepEqual(acknowledgeDigest(executor, digest, receipt), { delivered: 0 });
    assert.deepEqual(buildDigest(store.as("report_login")).entries, []);
    assert.equal(
      renderDigestMarkdown(buildDigest(store.owner)),
      "No maintenance changes since the last delivered digest.\n",
    );

    // Host failures are coverage gaps, never subject state.
    const runs = () =>
      JSON.parse(
        runSql(
          store.owner,
          `SELECT json_agg(json_build_object('source', source, 'coverage', coverage, 'observed', observed_count, 'gaps', gaps)
             ORDER BY started_at, source) FROM portcove_maintenance.collection_runs;`,
        ),
      ) as {
        source: string;
        coverage: string;
        observed: number;
        gaps: { subject_key: string; code: string }[];
      }[];
    const before = history().length;
    respond("network");
    await collect({ cli, sample, environment: collector, runner: "fixture" });
    respond("conflict", "conflict");
    await collect({ cli, sample, environment: collector, runner: "fixture" });
    respond("automatic");
    await collect({ cli, sample, environment: collector, runner: "fixture" });
    assert.equal(history().length, before, "failures and recovery create no transitions");
    assert.deepEqual(
      runs()
        .slice(-6)
        .map(({ source, coverage, observed, gaps }) => [
          source.startsWith("core-port-capabilities") ? "core" : source,
          coverage,
          observed,
          gaps.map(({ subject_key, code }) => `${subject_key}:${code}`),
        ]),
      [
        ["catalog-records", "complete", 2, []],
        ["core", "partial", 1, ["port:2ship2harkinian:network"]],
        ["catalog-records", "complete", 2, []],
        [
          "core",
          "failed",
          0,
          ["port:2ship2harkinian:conflict", "port:not-a-catalog-port:conflict"],
        ],
        ["catalog-records", "complete", 2, []],
        ["core", "complete", 2, []],
      ],
    );
    // A temporary directory reached through a symlink still yields real, isolated paths.
    const realTemporary = path.join(fixture.root, "real-tmp");
    const linkedTemporary = path.join(fixture.root, "linked-tmp");
    mkdirSync(realTemporary);
    symlinkSync(realTemporary, linkedTemporary);
    const previousTemporary = process.env.TMPDIR;
    process.env.TMPDIR = linkedTemporary;
    try {
      await collect({ cli, sample, environment: collector, runner: "fixture" });
    } finally {
      if (previousTemporary === undefined) delete process.env.TMPDIR;
      else process.env.TMPDIR = previousTemporary;
    }
    // Every CLI call ran with its own preferences, diagnostics, lock and home, all removed afterwards.
    const isolation = readFileSync(path.join(fixture.root, "isolation.log"), "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as [string, string, string, boolean, boolean]);
    assert.equal(isolation.length, 8 * 3);
    assert.equal(new Set(isolation.map(([preferences]) => preferences)).size, isolation.length);
    for (const [preferences, lock, , realRoot, isolatedHome] of isolation) {
      assert.ok(
        realRoot && isolatedHome,
        `isolation root is a real path holding HOME: ${preferences}`,
      );
      assert.ok(path.isAbsolute(preferences) && path.dirname(lock) === path.dirname(preferences));
      assert.equal(
        existsSync(path.dirname(path.dirname(preferences))),
        false,
        "isolated state is removed",
      );
    }

    const reader = store.as("report_login");
    const inventory = buildReport(reader, new Date("2026-11-11T00:00:00Z"));
    assert.equal(inventory.publication.status, "unknown");
    assert.ok(inventory.unsupported_sources.some(({ source }) => source === "project"));
    assert.deepEqual(
      (inventory.runs as { source: string; coverage: string; observed_count: number }[]).map(
        ({ source, coverage, observed_count }) => [
          source.startsWith("core-port-capabilities") ? "core" : source,
          coverage,
          observed_count,
        ],
      ),
      [
        ["catalog-records", "complete", 2],
        ["core", "complete", 2],
      ],
    );
    const ship = (
      inventory.subjects as {
        port_key: string;
        explanation: { listing_only: boolean; catalog_record_present: boolean };
        observations: { input_revision: string }[];
      }[]
    ).find(({ port_key }) => port_key === "port:2ship2harkinian")!;
    assert.equal(ship.explanation.catalog_record_present, true);
    assert.equal(ship.explanation.listing_only, false);
    assert.equal(ship.observations.length, 2);
    assert.equal((ship as unknown as { latest_core_run: string }).latest_core_run, "assessed");
    assert.equal(
      (ship as unknown as { identity: { game: string } }).identity.game,
      "The Legend of Zelda: Majora's Mask",
    );
    const absent = (
      inventory.subjects as {
        port_key: string;
        explanation: { catalog_record_present: boolean };
      }[]
    ).find(({ port_key }) => port_key === "port:not-a-catalog-port")!;
    assert.equal(absent.explanation.catalog_record_present, false);
    // The universe comes from the same stored facts: the authored port is an entry, and the
    // id without a catalog record is not invented as one.
    const universe = new Map((inventory.universe ?? []).map((entry) => [entry.key, entry]));
    assert.equal(universe.get("port:2ship2harkinian")?.game, "The Legend of Zelda: Majora's Mask");
    assert.ok(!universe.has("port:not-a-catalog-port"));
    assert.match(renderHtml(inventory), /Games and implementations/u);

    const output = path.join(fixture.root, "report");
    writeReport(inventory, output);
    assert.deepEqual(
      JSON.parse(readFileSync(path.join(output, "inventory.json"), "utf8")),
      JSON.parse(JSON.stringify(inventory)),
    );
    assert.ok(existsSync(path.join(output, "index.html")));
    assert.throws(() => writeReport(inventory, output), /already exists/u);
    // A late producer of an older generation never replaces a newer accepted report.
    assert.ok(inventory.generation > 0);
    writeReport(inventory, path.join(fixture.root, "same"), output);
    assert.throws(
      () =>
        writeReport(
          { ...inventory, generation: inventory.generation - 1 },
          path.join(fixture.root, "late"),
          output,
        ),
      /reflects newer collections/u,
    );
    assert.ok(!existsSync(path.join(fixture.root, "late")));
    assert.throws(
      () => runSql(reader, "DELETE FROM portcove_maintenance.collection_runs;"),
      /permission denied/u,
      "reporting is read-only",
    );
  },
);

void test(
  "complete collection stores changes only, verifies membership and records absence",
  { skip: server.skip ?? false, timeout: 240_000 },
  async (context) => {
    const fixture = postgresFixture(context, server.directory!);
    const incremental = fixture.start("incremental");
    const direct = fixture.start("direct");
    migrate(incremental.owner);
    migrate(direct.owner);
    const { cli, responses } = stubCli(fixture.root);
    const respond = (setup: string) =>
      writeFileSync(
        responses,
        JSON.stringify({
          "2ship2harkinian": setup.startsWith(":") ? setup.slice(1) : report(setup),
        }),
      );
    const ports = ["2ship2harkinian", "not-a-catalog-port"];
    const count = (environment: NodeJS.ProcessEnv, sql: string) =>
      Number(runSql(environment, sql).trim());
    const runs = () =>
      JSON.parse(
        runSql(
          incremental.owner,
          `SELECT json_agg(json_build_object('source', split_part(source, '-', 1), 'coverage', coverage,
             'observed', observed_count, 'members', member_count,
             'rows', (SELECT count(*) FROM portcove_maintenance.observations o WHERE o.run_id = r.run_id),
             'absent', (SELECT count(*) FROM portcove_maintenance.observations o WHERE o.run_id = r.run_id
                          AND o.payload = portcove_maintenance.absent_payload())) ORDER BY started_at, source)
             FROM portcove_maintenance.collection_runs r;`,
        ),
      ) as {
        source: string;
        coverage: string;
        observed: number;
        members: number;
        rows: number;
        absent: number;
      }[];
    const all = (environment: NodeJS.ProcessEnv, universe: string[]) =>
      collect({ cli, all: true, ports: universe, environment, runner: "fixture", concurrency: 2 });

    respond("automatic");
    await all(incremental.owner, ports);
    await all(incremental.owner, ports);
    respond("manual");
    await all(incremental.owner, ports);
    respond("automatic");
    await all(incremental.owner, ports);
    respond(":network");
    await all(incremental.owner, ["2ship2harkinian"]);
    respond("automatic");
    await all(incremental.owner, ["2ship2harkinian"]);
    assert.deepEqual(
      runs().map(({ source, coverage, observed, members, rows, absent }) => [
        source,
        coverage,
        observed,
        members,
        rows,
        absent,
      ]),
      [
        // First pass: every subject is new.
        ["catalog", "complete", 2, 2, 2, 0],
        ["core", "complete", 2, 2, 2, 0],
        // Unchanged pass: nothing stored, membership still verified.
        ["catalog", "complete", 2, 2, 0, 0],
        ["core", "complete", 2, 2, 0, 0],
        // Core changes only for the changed port, in both directions.
        ["catalog", "complete", 2, 2, 0, 0],
        ["core", "complete", 2, 2, 1, 0],
        ["catalog", "complete", 2, 2, 0, 0],
        ["core", "complete", 2, 2, 1, 0],
        // A partial Core run never records absence; the complete catalog run does.
        ["catalog", "complete", 1, 1, 1, 1],
        ["core", "failed", 0, 0, 0, 0],
        // The next complete Core run records the absence.
        ["catalog", "complete", 1, 1, 0, 0],
        ["core", "complete", 1, 1, 1, 1],
      ],
    );

    // A declared membership that does not match retained observations is refused.
    assert.throws(
      () =>
        runSql(
          incremental.owner,
          `INSERT INTO portcove_maintenance.collection_runs (run_id, source, runner, started_at)
             VALUES ('forged', 'catalog-records', 'fixture', now());
           UPDATE portcove_maintenance.collection_runs SET coverage = 'complete', completed_at = clock_timestamp(),
             source_revision = 'r', expected_count = 2, member_count = 2, member_digest = '${"0".repeat(64)}'
             WHERE run_id = 'forged';`,
        ),
      /membership differs from its retained observations/u,
    );
    assert.throws(
      () =>
        runSql(
          incremental.owner,
          `INSERT INTO portcove_maintenance.collection_runs (run_id, source, runner, started_at) VALUES
             ('first', 'parallel', 'fixture', now()), ('second', 'parallel', 'fixture', now());`,
        ),
      /already has a collection run in progress/u,
    );

    // The verified issue and Project inventory joins canonical work to ports.
    let shipState = "OPEN";
    const issues = () =>
      Promise.resolve({
        repository: "boburning/portcove",
        observed_at: "2026-11-11T00:00:00Z",
        total: 2,
        issues: [
          {
            id: "I1",
            number: 1,
            title: "Ship",
            state: shipState,
            body: "<!-- portcove-catalog-id: 2ship2harkinian -->",
          },
          { id: "I2", number: 2, title: "Other", state: "OPEN", body: "" },
        ],
        memberships: [
          {
            project_id: "P1",
            issue_id: "I1",
            isArchived: false,
            fieldValues: { nodes: [{ name: "Ready", field: { name: "Status" } }] },
          },
        ],
      });
    const withIssues = () =>
      collect({
        cli,
        all: true,
        ports: ["2ship2harkinian"],
        issues,
        environment: incremental.owner,
        runner: "fixture",
      });
    await withIssues();
    await withIssues();
    shipState = "CLOSED";
    await withIssues();
    assert.deepEqual(
      runs()
        .filter(({ source }) => source === "issues")
        .map(({ coverage, members, rows }) => [coverage, members, rows]),
      [
        ["complete", 2, 2],
        ["complete", 2, 0],
        ["complete", 2, 1],
      ],
    );
    const withWork = buildReport(incremental.owner);
    assert.ok(
      !withWork.unsupported_sources.some(
        ({ source }) => source === "issues" || source === "project",
      ),
    );
    assert.equal(withWork.scope, "complete-authored-catalog");
    const shipWork = (
      withWork.subjects as {
        port_key: string;
        work: { number: number; state: string; project: { fields: Record<string, string> }[] }[];
      }[]
    ).find(({ port_key }) => port_key === "port:2ship2harkinian")!.work;
    assert.deepEqual(
      shipWork.map(({ number, state, project }) => [number, state, project[0]?.fields.Status]),
      [[1, "CLOSED", "Ready"]],
    );
    assert.match(renderHtml(withWork), /#1 CLOSED · Ready/u);

    // Full and incremental assessment agree on identical final inputs.
    await all(direct.owner, ["2ship2harkinian"]);
    const current = (environment: NodeJS.ProcessEnv) =>
      runSql(
        environment,
        // The whole applicable assessment agrees, not only its result.
        `SELECT json_agg(json_build_object('subject', c.subject_key, 'result', c.result_digest,
             'state', a.state, 'policy', a.policy_version, 'input', a.input_digest) ORDER BY c.subject_key)
           FROM portcove_maintenance.subject_current c
           JOIN portcove_maintenance.assessments a ON a.assessment_id = c.applicable_assessment_id
          WHERE c.subject_key LIKE 'port:2ship2harkinian@%';`,
      ).trim();
    assert.equal(current(incremental.owner), current(direct.owner));
    assert.equal(
      count(direct.owner, "SELECT count(*) FROM portcove_maintenance.subject_transitions;"),
      1,
    );
  },
);

void test(
  "each host platform keeps its own assessment history, gaps and latest run",
  { skip: server.skip ?? false, timeout: 240_000 },
  async (context) => {
    const fixture = postgresFixture(context, server.directory!);
    const store = fixture.start("platforms");
    migrate(store.owner);
    const { cli, responses } = stubCli(fixture.root);
    const ports = ["2ship2harkinian", "not-a-catalog-port"];
    const on = (platform: string, ship: unknown) => {
      writeFileSync(responses, JSON.stringify({ "2ship2harkinian": ship }));
      return collect({
        cli,
        all: true,
        ports,
        platform,
        environment: store.owner,
        runner: "fixture",
      });
    };
    // Identical Core results on alternating hosts: no spurious transitions or notifications.
    await on("linux-x86-64", report("automatic"));
    await on("windows-x86-64", report("automatic"));
    await on("linux-x86-64", report("automatic"));
    assert.equal(
      runSql(store.owner, "SELECT count(*) FROM portcove_maintenance.subject_transitions;").trim(),
      "4",
      "one baseline per port and platform",
    );
    assert.equal(
      runSql(store.owner, "SELECT count(*) FROM portcove_maintenance.notifications;").trim(),
      "0",
    );
    // The latest Core run (Windows, partial) is not the alphabetically first source.
    await on("windows-x86-64", "network");
    const inventory = buildReport(store.owner);
    const status = (inventory.subjects as { subject_key: string; latest_core_run: string }[]).map(
      ({ subject_key, latest_core_run }) => [subject_key, latest_core_run],
    );
    assert.deepEqual(status, [
      ["port:2ship2harkinian@linux-x86-64", "assessed"],
      ["port:2ship2harkinian@windows-x86-64", "gap"],
      ["port:not-a-catalog-port@linux-x86-64", "assessed"],
      ["port:not-a-catalog-port@windows-x86-64", "assessed"],
    ]);
  },
);

void test(
  "release health records coverage, quiet recurrence and needs-attention conditions",
  { skip: server.skip ?? false, timeout: 240_000 },
  async (context) => {
    const fixture = postgresFixture(context, server.directory!);
    const store = fixture.start("health");
    migrate(store.owner);
    const { cli, responses } = stubCli(fixture.root);
    writeFileSync(responses, JSON.stringify({ "2ship2harkinian": report("automatic") }));
    const health =
      (occurrences: number, stale: string[] = []) =>
      () =>
        Promise.resolve({
          revision: `upstream-health-run:${occurrences}`,
          report: {
            format_version: 1,
            authority:
              "upstream-monitoring-only; no acquisition, artifact, lineage or publication authority",
            inventory: {
              total_ports: 1 + stale.length,
              fresh_complete_port_ids: ["2ship2harkinian"],
              fresh_partial_port_ids: [],
              stale_port_ids: stale,
              unmonitored_port_ids: [],
            },
            known_conditions: [
              {
                key: "k1",
                classification: "unclassified-or-actionable",
                accounted_for: false,
                port_id: "2ship2harkinian",
                operation: "observe-availability",
                rule: "provider-redirect",
                occurrences,
              },
            ],
          },
        });
    const collectWith = (releaseHealth: ReturnType<typeof health>) =>
      collect({
        cli,
        all: true,
        ports: ["2ship2harkinian"],
        releaseHealth,
        environment: store.owner,
        runner: "fixture",
      });
    await collectWith(health(1));
    await collectWith(health(2));
    await collectWith(health(3, ["mdk-sdl-nemo22"]));
    const healthRuns = JSON.parse(
      runSql(
        store.owner,
        `SELECT json_agg(json_build_object('coverage', coverage, 'expected', expected_count, 'observed', observed_count,
           'rows', (SELECT count(*) FROM portcove_maintenance.observations o WHERE o.run_id = r.run_id),
           'gaps', jsonb_array_length(gaps)) ORDER BY started_at)
           FROM portcove_maintenance.collection_runs r WHERE source = 'release-health';`,
      ),
    ) as { coverage: string; expected: number; observed: number; rows: number; gaps: number }[];
    assert.deepEqual(
      healthRuns.map(({ coverage, expected, observed, rows, gaps }) => [
        coverage,
        expected,
        observed,
        rows,
        gaps,
      ]),
      [
        ["complete", 1, 1, 1, 0],
        // A routine recurrence is the same fact: nothing stored.
        ["complete", 1, 1, 0, 0],
        // A stale port is a gap and makes the run partial.
        ["partial", 2, 1, 0, 1],
      ],
    );
    await collect({
      cli,
      all: true,
      ports: ["2ship2harkinian"],
      publication: () =>
        Promise.resolve({
          inspection: {
            index_sha256: "f".repeat(64),
            definitions: [
              {
                namespace: "official",
                stable_id: "example",
                revision: 1,
                definition_target: "sha256/a.json",
              },
            ],
          },
        }),
      delivery: () =>
        Promise.resolve(
          verifiedDelivery([{ stable_id: "example", revision: 1, target: "sha256/a.json" }]),
        ),
      environment: store.owner,
      runner: "fixture",
    });
    const inventory = buildReport(store.owner);
    assert.ok(!inventory.unsupported_sources.some(({ source }) => source === "release-health"));
    assert.ok(
      !inventory.unsupported_sources.some(({ source }) => source === "definition-publication"),
    );
    assert.ok(
      !inventory.unsupported_sources.some(({ source }) => source === "definition-delivery"),
    );
    assert.equal(inventory.publication.status, "observed");
    assert.equal(inventory.publication.serving?.status, "verified");
    assert.deepEqual(
      inventory.publication.definitions?.map(({ comparison }) => comparison),
      ["published-matches-main"],
    );
    // Not served (HTTP 404 behind the client) and an outage erase no verified publication.
    for (const serving of ["not_served", "unreachable"] as const) {
      const outcome = await collect({
        cli,
        all: true,
        ports: ["2ship2harkinian"],
        delivery: () => Promise.resolve(unverifiedDelivery(serving)),
        environment: store.owner,
        runner: "fixture",
      });
      assert.deepEqual(outcome.delivery, { serving, published: 0 });
      const afterOutage = buildReport(store.owner);
      assert.equal(afterOutage.publication.serving?.status, serving);
      assert.equal(
        afterOutage.publication.serving?.last_verified_at,
        inventory.publication.serving?.last_verified_at,
      );
      assert.deepEqual(
        afterOutage.publication.definitions?.map(({ comparison, published }) => [
          comparison,
          published,
        ]),
        [
          [
            "published-matches-main",
            {
              published: {
                revision: 1,
                target: "sha256/a.json",
                sha256: "d".repeat(64),
                length: 10,
              },
            },
          ],
        ],
      );
      assert.match(
        runSql(
          store.owner,
          `SELECT coverage || ':' || (gaps -> 0 ->> 'code') FROM portcove_maintenance.collection_runs
            WHERE run_id = portcove_maintenance.latest_run('definition-delivery');`,
        ),
        new RegExp(`failed:${serving}`, "u"),
      );
    }
    assert.match(
      renderHtml(buildReport(store.owner)),
      /Latest read: <span class="unknown">unreachable/u,
    );
    // A newer main revision is visible as different from what was last verified.
    await collect({
      cli,
      all: true,
      ports: ["2ship2harkinian"],
      publication: () =>
        Promise.resolve({
          inspection: {
            index_sha256: "f".repeat(64),
            definitions: [
              {
                namespace: "official",
                stable_id: "example",
                revision: 2,
                definition_target: "sha256/b.json",
              },
            ],
          },
        }),
      environment: store.owner,
      runner: "fixture",
    });
    assert.deepEqual(
      buildReport(store.owner).publication.definitions?.map(({ comparison }) => comparison),
      ["published-differs-from-main"],
    );
    // A verified read that no longer indexes a definition withdraws it.
    await collect({
      cli,
      all: true,
      ports: ["2ship2harkinian"],
      delivery: () => Promise.resolve(verifiedDelivery([])),
      environment: store.owner,
      runner: "fixture",
    });
    const withdrawn = buildReport(store.owner);
    // The withdrawal stays visible; it is never relabelled as never published.
    assert.deepEqual(
      withdrawn.publication.definitions?.map(({ comparison }) => comparison),
      ["published-withdrawn"],
    );
    assert.equal(withdrawn.publication.serving?.status, "verified");
    assert.match(renderHtml(inventory), /provider-redirect \(observe-availability\)/u);

    // A failed health read keeps the previous read's per-port gap and says it failed.
    await collectWith(() =>
      Promise.resolve({
        revision: "upstream-health-run:4",
        report: {
          format_version: 1,
          authority:
            "upstream-monitoring-only; no acquisition, artifact, lineage or publication authority",
          inventory: {
            total_ports: 1,
            fresh_complete_port_ids: [],
            fresh_partial_port_ids: [],
            stale_port_ids: ["2ship2harkinian"],
            unmonitored_port_ids: [],
          },
          known_conditions: [],
        },
      }),
    );
    await collectWith(() => Promise.reject(new Error("artifact download refused")));
    const afterHealthFailure = buildReport(store.owner);
    // A failed read is an attempt, never a refresh of the last good read.
    const healthAge = afterHealthFailure.freshness?.find(
      ({ source }) => source === "release-health",
    );
    assert.ok(healthAge?.attempted_at && healthAge.last_good_at);
    assert.ok(Date.parse(healthAge.attempted_at) > Date.parse(healthAge.last_good_at));
    assert.match(renderHtml(afterHealthFailure), /Data age: the oldest last good source read is/u);
    const shipHealth = (
      afterHealthFailure.subjects as { port_key: string; latest_health_gap: string | null }[]
    ).find(({ port_key }) => port_key === "port:2ship2harkinian");
    assert.equal(shipHealth?.latest_health_gap, "stale");
    assert.match(
      renderHtml(afterHealthFailure),
      /latest read failed: unavailable; previous read: stale/u,
    );

    // A failed publication-bundle inspection is a failed run; the last facts stay current.
    const bundleFailure = await collect({
      cli,
      all: true,
      ports: ["2ship2harkinian"],
      publication: () => Promise.reject(new Error("bundle export failed")),
      environment: store.owner,
      runner: "fixture",
    });
    assert.deepEqual(bundleFailure.failed_sources, ["definition-publication"]);
    assert.match(
      buildReport(store.owner).publication.reason,
      /definition:official\/example: published-withdrawn \(main revision 2/u,
    );
    assert.equal(
      runSql(
        store.owner,
        `SELECT coverage || ':' || (gaps -> 0 ->> 'subject_key') FROM portcove_maintenance.collection_runs
          WHERE run_id = portcove_maintenance.latest_run('definition-publication');`,
      ).trim(),
      "failed:source:definition-publication",
    );
  },
);

void test(
  "upstream observations record coverage, quiet recurrence, attention and failed reads",
  { skip: server.skip ?? false, timeout: 240_000 },
  async (context) => {
    const fixture = postgresFixture(context, server.directory!);
    const store = fixture.start("upstream");
    migrate(store.owner);
    const { cli, responses } = stubCli(fixture.root);
    writeFileSync(responses, JSON.stringify({ "2ship2harkinian": report("automatic") }));
    // The observer maps its own catalog: the assessed port shares a source key with "alpha".
    const observerCatalog = {
      ports: [
        { id: "2ship2harkinian", channels: ["stable"], release: { repository: "owner/alpha" } },
        catalogFixture.ports[2]!,
      ],
    };
    const observed = (sources: Record<string, unknown>, run: number) => () =>
      Promise.resolve({
        revision: `upstream-observer-run:${run}`,
        config_sha256: scope,
        checkpoint: checkpoint(sources, 9),
        catalog: observerCatalog,
      });
    const collectWith = (upstream: () => Promise<UpstreamInput>) =>
      collect({
        cli,
        all: true,
        ports: ["2ship2harkinian"],
        upstream,
        environment: store.owner,
        runner: "fixture",
      });
    const complete = (overrides = {}) => ({
      [keyOf("owner/alpha")]: progress("owner/alpha", ["2ship2harkinian"], overrides),
      [keyOf("owner/gamma")]: progress("owner/gamma", ["gamma"]),
    });
    await collectWith(observed(complete(), 1));
    // Only per-observation clocks and progress moved: nothing is stored.
    await collectWith(
      observed(
        complete({
          attempted_sequence: 9,
          freshness_observed_at: "2026-11-10T16:00:00.000Z",
          next_due_at: "2026-11-10T22:00:00.000Z",
        }),
        2,
      ),
    );
    // An exception is a changed fact; a never-completed source is a gap.
    await collectWith(
      observed(
        {
          [keyOf("owner/alpha")]: progress("owner/alpha", ["2ship2harkinian"], {
            exception_key: exception,
            exception_rule: "repository-unavailable",
          }),
          [keyOf("owner/gamma")]: progress("owner/gamma", [], {
            completed_scope_sha256: null,
            last_complete_facts_sha256: null,
          }),
        },
        3,
      ),
    );
    // A reset scope is a per-port gap; the stored exception facts stay current.
    await collectWith(
      observed(
        complete({
          completed_scope_sha256: null,
          exception_key: exception,
          exception_rule: "repository-unavailable",
        }),
        4,
      ),
    );
    // A failed read observes nothing; the prior facts stay current.
    await collectWith(() => Promise.reject(new Error("artifact download refused")));
    const runs = JSON.parse(
      runSql(
        store.owner,
        `SELECT json_agg(json_build_object('coverage', coverage, 'expected', expected_count, 'observed', observed_count,
           'rows', (SELECT count(*) FROM portcove_maintenance.observations o WHERE o.run_id = r.run_id),
           'gaps', (SELECT coalesce(json_agg(g ->> 'code'), '[]') FROM jsonb_array_elements(gaps) g)) ORDER BY started_at)
           FROM portcove_maintenance.collection_runs r WHERE source = 'upstream-observations';`,
      ),
    ) as {
      coverage: string;
      expected: number | null;
      observed: number;
      rows: number;
      gaps: string[];
    }[];
    assert.deepEqual(
      runs.map(({ coverage, expected, observed: count, rows, gaps }) => [
        coverage,
        expected,
        count,
        rows,
        gaps,
      ]),
      [
        ["complete", 2, 2, 2, []],
        ["complete", 2, 2, 0, []],
        ["partial", 2, 1, 1, ["unobserved"]],
        ["partial", 2, 1, 0, ["scope-changed"]],
        ["failed", null, 0, 0, ["unavailable"]],
      ],
    );
    const inventory = buildReport(store.owner);
    assert.ok(
      !inventory.unsupported_sources.some(({ source }) => source === "upstream-observations"),
    );
    const subject = inventory.subjects[0] as {
      upstream: { sources: { exception_rule: string }[] } | null;
      latest_upstream_gap: { code: string } | null;
    };
    assert.equal(subject.upstream?.sources[0]?.exception_rule, "repository-unavailable");
    // Per-port gaps come from the latest run that did not fail.
    assert.equal(subject.latest_upstream_gap?.code, "scope-changed");
    const page = renderHtml(inventory);
    assert.match(page, /upstream observer exception: repository-unavailable \(owner\/alpha\)/u);
    assert.match(
      page,
      /owner\/alpha: facts ffffffffffff, last change [^;"]+; latest attempt failed: unavailable; previous checkpoint: scope-changed/u,
    );
    // The failed attempt stays in the source table with its own source-level gap.
    assert.match(page, /source:upstream-observer-checkpoint: unavailable/u);
  },
);

void test(
  "hosted intake records requests, quiet recurrence, attention, gaps and failed reads",
  { skip: server.skip ?? false, timeout: 240_000 },
  async (context) => {
    const fixture = postgresFixture(context, server.directory!);
    const store = fixture.start("hosted");
    migrate(store.owner);
    const { cli, responses } = stubCli(fixture.root);
    writeFileSync(responses, JSON.stringify({ "2ship2harkinian": report("automatic") }));
    const hold = {
      http_status: 404,
      resume:
        "Use owner process dispatch when the exact repository ID and primary evidence are accessible.",
    };
    const slot = (issue: number | null, overrides = {}) => ({
      candidate_index: 0,
      port_key: "example-game",
      repository_id: 7,
      upstream: "https://github.com/owner/example-game",
      delivery_status: issue ? "delivered" : "prepared",
      linked_issue: issue,
      existing: false,
      hold: null,
      ...overrides,
    });
    // Each request exactly as the executor's status() reports it, clocks included.
    const request = (id: number, observed: string, overrides = {}): HostedRequestStatus => ({
      request_comment: id,
      receipt_comment: id + 1,
      reconciles: null,
      body_request_comment: id,
      status: "complete",
      candidates: 1,
      delivered: 1,
      existing: 0,
      held: 0,
      pending: 0,
      full_doctor_required: false,
      doctor: null,
      last_error: null,
      observed_at: observed,
      slots: [slot(id === 10 ? 1 : null)],
      withdrawn: false,
      superseded_by: [],
      ...overrides,
    });
    const requests = (observed: string) => [
      request(10, observed),
      request(20, observed, {
        status: "blocked",
        delivered: 0,
        pending: 1,
        reconciles: 5,
        last_error: { code: "operation_failed", message: `stopped at ${observed}` },
      }),
      request(30, observed, {
        status: "blocked",
        withdrawn: true,
        delivered: 0,
        pending: 1,
        last_error: { code: "operation_failed", message: "withdrawn by the owner" },
      }),
      request(40, observed, {
        status: "complete_with_holds",
        delivered: 0,
        held: 1,
        pending: 1,
        slots: [slot(null, { hold })],
      }),
    ];
    const queue = (comments: number) => ({
      node_id: "I177",
      comments,
      updated_at: `2026-11-11T0${comments}:00:00Z`,
      comments_sha256: String(comments).repeat(64).slice(0, 64),
    });
    const issues = () =>
      Promise.resolve({
        repository: "boburning/portcove",
        observed_at: "2026-11-11T00:00:00Z",
        total: 1,
        issues: [{ id: "I1", number: 1, title: "Example", state: "OPEN", body: "" }],
        memberships: [
          {
            project_id: "P1",
            issue_id: "I1",
            isArchived: false,
            fieldValues: { nodes: [{ name: "Ready", field: { name: "Status" } }] },
          },
        ],
      });
    const collectWith = (hostedIntake: () => Promise<HostedStatusAll>) =>
      collect({
        cli,
        all: true,
        ports: ["2ship2harkinian"],
        issues,
        hostedIntake,
        environment: store.owner,
        runner: "fixture",
      });
    await collectWith(() =>
      Promise.resolve({ queue: queue(1), requests: requests("2026-11-10T00:00:00Z") }),
    );
    // Only receipt clocks, messages and the queue revision moved: nothing is stored.
    await collectWith(() =>
      Promise.resolve({ queue: queue(2), requests: requests("2026-11-11T00:00:00Z") }),
    );
    // A new request is a fact; a request the executor cannot validate is a gap.
    await collectWith(() =>
      Promise.resolve({
        queue: queue(3),
        requests: [
          ...requests("2026-11-11T00:00:00Z").filter(
            ({ request_comment }) => request_comment !== 20,
          ),
          {
            request_comment: 20,
            withdrawn: false,
            superseded_by: [],
            error: { code: "operation_failed", message: "Retained delivery state is incomplete" },
          },
          request(50, "2026-11-11T00:00:00Z", { status: "submitted", receipt_comment: null }),
        ],
      }),
    );
    // Drift and unavailable reads observe nothing; the prior facts stay current.
    await collectWith(() =>
      Promise.reject(new GitHubApiError("inventory_changed", "Hosted request queue changed")),
    );
    await collectWith(() => Promise.reject(new Error("credential unavailable")));
    const runs = JSON.parse(
      runSql(
        store.owner,
        `SELECT json_agg(json_build_object('coverage', coverage, 'expected', expected_count, 'observed', observed_count,
           'revision', source_revision,
           'rows', (SELECT count(*) FROM portcove_maintenance.observations o WHERE o.run_id = r.run_id),
           'gaps', (SELECT coalesce(json_agg(g ->> 'subject_key' || ':' || (g ->> 'code')), '[]') FROM jsonb_array_elements(gaps) g)) ORDER BY started_at)
           FROM portcove_maintenance.collection_runs r WHERE source = 'hosted-intake';`,
      ),
    ) as {
      coverage: string;
      expected: number | null;
      observed: number;
      revision: string;
      rows: number;
      gaps: string[];
    }[];
    assert.deepEqual(
      runs.map(({ coverage, expected, observed, rows, gaps }) => [
        coverage,
        expected,
        observed,
        rows,
        gaps,
      ]),
      [
        ["complete", 4, 4, 4, []],
        ["complete", 4, 4, 0, []],
        ["partial", 5, 4, 1, ["intake:20:invalid-receipt"]],
        ["failed", null, 0, 0, ["source:hosted-intake-queue:inventory-changed"]],
        ["failed", null, 0, 0, ["source:hosted-intake-queue:unavailable"]],
      ],
    );
    assert.equal(
      runs[0]!.revision,
      `hosted-intake:I177:1@2026-11-11T01:00:00Z#sha256:${"1".repeat(64)}`,
    );
    const inventory = buildReport(store.owner);
    assert.ok(!inventory.unsupported_sources.some(({ source }) => source === "hosted-intake"));
    assert.deepEqual(
      inventory.hosted_intake?.map(({ subject_key, issues: work }) => [subject_key, work]),
      [
        ["intake:10", [{ number: 1, state: "OPEN", status: "Ready" }]],
        ["intake:20", []],
        ["intake:30", []],
        ["intake:40", []],
        ["intake:50", []],
      ],
      "a failed read and an invalid request keep the last known facts",
    );
    // Per-request gaps come from the latest run that did not fail.
    assert.deepEqual(
      inventory.hosted_intake?.map(({ subject_key, latest_gap }) => [subject_key, latest_gap]),
      [
        ["intake:10", null],
        ["intake:20", "invalid-receipt"],
        ["intake:30", null],
        ["intake:40", null],
        ["intake:50", null],
      ],
    );
    const page = renderHtml(inventory);
    assert.match(page, /latest attempt failed: unavailable; previous read: invalid-receipt/u);
    assert.doesNotMatch(page, /latest read: /u);
    assert.match(
      page,
      /hosted intake blocked: operation_failed \(receipt comment 21; reconciles request 5\)/u,
    );
    assert.match(page, /hosted intake held candidates \(receipt comment 41\): Use owner process/u);
    assert.doesNotMatch(page, /receipt comment 31/u, "a withdrawn request is never attention");
    assert.match(page, /#1 OPEN · Ready/u);
    assert.match(page, /source:hosted-intake-queue: unavailable/u);
  },
);

void test(
  "handoffs plan once, stay quiet, clear and abandon only after complete runs, and refuse stale fences",
  { skip: server.skip ?? false, timeout: 240_000 },
  async (context) => {
    const fixture = postgresFixture(context, server.directory!);
    const store = fixture.start("handoffs");
    migrate(store.owner);
    runSql(
      store.owner,
      `CREATE ROLE collector_login LOGIN IN ROLE portcove_maintenance_collector;
       CREATE ROLE report_login LOGIN IN ROLE portcove_maintenance_report;
       CREATE ROLE executor_login LOGIN IN ROLE portcove_maintenance_executor;`,
    );
    const collector = store.as("collector_login");
    const executor = store.as("executor_login");
    const reader = store.as("report_login");
    const { cli, responses } = stubCli(fixture.root);
    const respond = (ship: unknown) =>
      writeFileSync(responses, JSON.stringify({ "2ship2harkinian": ship }));
    const slot = (overrides = {}) => ({
      candidate_index: 0,
      port_key: "example-game",
      repository_id: 7,
      upstream: "https://github.com/owner/example-game",
      delivery_status: "prepared",
      linked_issue: null,
      existing: false,
      hold: null,
      ...overrides,
    });
    const request = (id: number, overrides = {}): HostedRequestStatus => ({
      request_comment: id,
      receipt_comment: id + 1,
      reconciles: null,
      body_request_comment: id,
      status: "complete",
      candidates: 1,
      delivered: 1,
      existing: 0,
      held: 0,
      pending: 0,
      full_doctor_required: false,
      doctor: null,
      last_error: null,
      observed_at: "2026-11-11T00:00:00Z",
      slots: [slot()],
      withdrawn: false,
      superseded_by: [],
      ...overrides,
    });
    const blocked = (id: number) =>
      request(id, {
        status: "blocked",
        delivered: 0,
        pending: 1,
        last_error: { code: "operation_failed", message: "stopped" },
      });
    const held = (id: number, resume: string) =>
      request(id, {
        status: "complete_with_holds",
        delivered: 0,
        held: 1,
        slots: [slot({ hold: { http_status: 404, resume } })],
      });
    let comments = 0;
    const queue = () => ({
      node_id: "I177",
      comments: ++comments,
      updated_at: "2026-11-11T00:00:00Z",
      comments_sha256: "c".repeat(64),
    });
    const collectWith = (requests: HostedRequestStatus[] | Error, platform = "linux-x86-64") =>
      collect({
        cli,
        all: true,
        ports: ["2ship2harkinian"],
        platform,
        hostedIntake: () =>
          requests instanceof Error
            ? Promise.reject(requests)
            : Promise.resolve({ queue: queue(), requests }),
        environment: collector,
        runner: "fixture",
      });
    const states = () =>
      JSON.parse(
        runSql(
          store.owner,
          `SELECT coalesce(json_agg(json_build_object('subject', t.subject_key, 'sequence', t.sequence, 'state', t.state,
             'returns', t.returns_to_earlier_result) ORDER BY t.subject_key COLLATE "C", t.sequence), '[]')
             FROM portcove_maintenance.subject_transitions t WHERE starts_with(t.subject_key, 'handoff:');`,
        ),
      ) as { subject: string; sequence: number; state: string; returns: boolean }[];
    const operations = () =>
      JSON.parse(
        runSql(
          store.owner,
          `SELECT coalesce(json_agg(json_build_object('id', operation_id, 'kind', kind, 'state', state, 'fence', fence_sequence,
             'revision', revision, 'executor', executor, 'receipt', receipt_reference, 'receipt_sha256', receipt_sha256)
             ORDER BY operation_id COLLATE "C"), '[]') FROM portcove_maintenance.operations;`,
        ),
      ) as {
        id: string;
        kind: string;
        state: string;
        fence: number;
        revision: number;
        executor: string;
        receipt: string | null;
        receipt_sha256: string | null;
      }[];
    const rowCounts = () =>
      runSql(
        store.owner,
        `SELECT (SELECT count(*) FROM portcove_maintenance.assessments) || '/' ||
                (SELECT count(*) FROM portcove_maintenance.subject_transitions) || '/' ||
                (SELECT count(*) FROM portcove_maintenance.notifications) || '/' ||
                (SELECT count(*) FROM portcove_maintenance.operations);`,
      ).trim();
    const blockedKey = "handoff:hosted-intake-blocked:intake:20";
    const heldKey = "handoff:hosted-intake-holds:intake:40";
    // A handoff plan's identity names its fence and the assessment recorded at that fence.
    const plan = (
      kind: "hosted-intake-blocked" | "hosted-intake-holds",
      request: number,
      fence: number,
    ) =>
      handoffOperationId(
        kind,
        `intake:${request}`,
        fence,
        Number(
          runSql(
            store.owner,
            `SELECT assessment_id FROM portcove_maintenance.subject_transitions
              WHERE subject_key = 'handoff:${kind}:intake:${request}' AND sequence = ${fence};`,
          ).trim(),
        ),
      );

    // A handoff appears: one needs-attention transition and notification; one planned operation.
    respond(report("automatic"));
    await collectWith([request(10), blocked(20), held(40, "first resume")]);
    assert.deepEqual(
      states().map(({ subject, sequence, state }) => [subject, sequence, state]),
      [
        [blockedKey, 1, "needs-attention"],
        [heldKey, 1, "needs-attention"],
      ],
      "a request that never needed attention gets no handoff row",
    );
    assert.throws(() => recordHandoffOperations(reader), /permission denied/u);
    assert.throws(() => recordHandoffOperations(collector), /permission denied/u);
    assert.deepEqual(recordHandoffOperations(executor), { abandoned: 0, planned: 2, open: 2 });
    assert.deepEqual(recordHandoffOperations(executor), { abandoned: 0, planned: 0, open: 2 });
    assert.deepEqual(
      operations().map(({ id, kind, state, fence, revision, executor: name, receipt }) => [
        id,
        kind,
        state,
        fence,
        revision,
        name,
        receipt,
      ]),
      [
        [
          plan("hosted-intake-blocked", 20, 1),
          "handoff.hosted-intake-blocked",
          "planned",
          1,
          1,
          "hosted-discovery-intake.yml",
          null,
        ],
        [
          plan("hosted-intake-holds", 40, 1),
          "handoff.hosted-intake-holds",
          "planned",
          1,
          1,
          "hosted-discovery-intake.yml",
          null,
        ],
      ],
    );

    // An unchanged rerun records nothing new, and a replayed record plans nothing.
    const settled = rowCounts();
    await collectWith([request(10), blocked(20), held(40, "first resume")]);
    assert.deepEqual(recordHandoffOperations(executor), { abandoned: 0, planned: 0, open: 2 });
    assert.equal(rowCounts(), settled);

    // Partial and failed runs never clear, even when the condition looks resolved.
    await collectWith([
      request(10),
      request(20),
      {
        request_comment: 40,
        withdrawn: false,
        superseded_by: [],
        error: { code: "operation_failed", message: "incomplete" },
      },
    ]);
    await collectWith(new Error("credential unavailable"));
    assert.equal(states().length, 2, "a partial or failed run neither clears nor records");
    assert.deepEqual(recordHandoffOperations(executor), { abandoned: 0, planned: 0, open: 2 });

    // A complete run without the condition clears it, and the stale plan is abandoned.
    await collectWith([request(10), request(20), held(40, "first resume")]);
    assert.deepEqual(
      states()
        .filter(({ subject }) => subject === blockedKey)
        .map(({ sequence, state }) => [sequence, state]),
      [
        [1, "needs-attention"],
        [2, "clear"],
      ],
    );
    assert.deepEqual(recordHandoffOperations(executor), { abandoned: 1, planned: 0, open: 1 });
    const abandoned = operations().find(({ id }) => id === plan("hosted-intake-blocked", 20, 1))!;
    assert.deepEqual(
      [abandoned.state, abandoned.revision, abandoned.receipt, abandoned.receipt_sha256],
      ["abandoned", 2, null, null],
    );

    // A changed condition supersedes the earlier plan; a return is flagged as one.
    await collectWith([request(10), blocked(20), held(40, "second resume")]);
    assert.deepEqual(recordHandoffOperations(executor), { abandoned: 1, planned: 2, open: 2 });
    assert.deepEqual(
      states()
        .filter(({ sequence }) => sequence > 1)
        .map(({ subject, sequence, state, returns }) => [subject, sequence, state, returns]),
      [
        [blockedKey, 2, "clear", false],
        [blockedKey, 3, "needs-attention", true],
        [heldKey, 2, "needs-attention", false],
      ],
    );
    assert.deepEqual(
      operations().map(({ id, state, fence }) => [id, state, fence]),
      [
        [plan("hosted-intake-blocked", 20, 1), "abandoned", 1],
        [plan("hosted-intake-blocked", 20, 3), "planned", 3],
        [plan("hosted-intake-holds", 40, 1), "abandoned", 1],
        [plan("hosted-intake-holds", 40, 2), "planned", 2],
      ],
    );

    // A restored or stale worker cannot plan at an earlier fence or revive a superseded plan.
    assert.throws(
      () =>
        runSql(
          executor,
          `INSERT INTO portcove_maintenance.operations (operation_id, kind, subject_key, fence_sequence, executor, created_at, updated_at)
             VALUES ('handoff.hosted-intake-holds.intake:40.1x', 'handoff.hosted-intake-holds', '${heldKey}', 1,
                     'hosted-discovery-intake.yml', now(), now());`,
        ),
      /stale maintenance state/u,
    );
    assert.throws(
      () =>
        runSql(
          executor,
          `UPDATE portcove_maintenance.operations SET state = 'planned', revision = revision + 1
             WHERE operation_id = '${plan("hosted-intake-holds", 40, 1)}';`,
        ),
      /cannot move from abandoned to planned/u,
    );

    // Core owns its assessment: a Core change is a reported transition, never a handoff.
    const steady = [request(10), blocked(20), held(40, "second resume")];
    respond(report("manual"));
    await collectWith(steady);
    respond(report("automatic"));
    await collectWith(steady, "windows-x86-64");
    assert.equal(
      runSql(
        store.owner,
        `SELECT state FROM portcove_maintenance.subject_transitions
           WHERE subject_key = 'port:2ship2harkinian@linux-x86-64' ORDER BY sequence DESC LIMIT 1;`,
      ).trim(),
      "managed-setup.manual",
    );
    assert.ok(
      states().every(({ subject }) => /^handoff:hosted-intake-(blocked|holds):/u.test(subject)),
      "Core transitions create no handoff",
    );

    // A kind no longer in the registry (here, an older store's row) clears only on a
    // complete handoff source run.
    const retiredKey = "handoff:retired-kind:port:2ship2harkinian@linux-x86-64";
    runSql(
      store.owner,
      `INSERT INTO portcove_maintenance.assessments (subject_key, policy_version, input_digest, state, result_digest, explanation, assessed_at)
         VALUES ('${retiredKey}', 'maintenance-handoffs/0', '${"1".repeat(64)}', 'needs-attention', '${"2".repeat(64)}',
                 '{"handoff": "retired-kind"}', now());
       INSERT INTO portcove_maintenance.subject_transitions (subject_key, sequence, assessment_id)
         SELECT subject_key, 1, assessment_id FROM portcove_maintenance.assessments WHERE subject_key = '${retiredKey}';`,
    );
    await collectWith(new Error("credential unavailable"));
    assert.deepEqual(
      states()
        .filter(({ subject }) => subject === retiredKey)
        .map(({ state }) => state),
      ["needs-attention"],
    );
    await collectWith(steady);
    assert.deepEqual(
      states()
        .filter(({ subject }) => subject === retiredKey)
        .map(({ state }) => state),
      ["needs-attention", "clear"],
    );

    const inventory = buildReport(reader);
    assert.ok(
      !(inventory.subjects as { subject_key: string }[]).some(({ subject_key }) =>
        subject_key.startsWith("handoff:"),
      ),
      "handoffs are not inventory subjects",
    );
    assert.deepEqual(
      inventory.handoffs?.map(({ subject_key, operation }) => [
        subject_key,
        operation?.operation_id ?? null,
      ]),
      [
        [blockedKey, plan("hosted-intake-blocked", 20, 3)],
        [heldKey, plan("hosted-intake-holds", 40, 2)],
      ],
    );
    const page = renderHtml(inventory);
    assert.match(page, /<th>Next action<\/th>/u);
    assert.match(
      page,
      /gh workflow run hosted-discovery-intake\.yml --ref main -f mode=process\. Authority: owner-only\. Dispatch disabled: /u,
    );
    assert.ok(page.includes(`operation ${plan("hosted-intake-holds", 40, 2)} planned at fence 2`));
    assert.match(page, /"next_actions":\[\]/u);
    // The changes-only digest carries handoff transitions with the registry action.
    const digest = buildDigest(reader);
    assert.ok(digest.entries.some(({ subject_key }) => subject_key === heldKey));
    assert.match(
      renderDigestMarkdown(digest),
      /`handoff:hosted-intake-holds:intake:40`: none → needs-attention; next action: Resume the held candidates/u,
    );
    assert.deepEqual(
      readOpenHandoffs(reader).map(({ subject_key }) => subject_key),
      [blockedKey, heldKey],
    );
  },
);

void test(
  "current provenance refreshes quietly, stale collections replace nothing and sources fail alone",
  { skip: server.skip ?? false, timeout: 240_000 },
  async (context) => {
    const fixture = postgresFixture(context, server.directory!);
    const store = fixture.start("store");
    migrate(store.owner);
    runSql(
      store.owner,
      "CREATE ROLE collector_login LOGIN IN ROLE portcove_maintenance_collector;",
    );
    const collector = store.as("collector_login");
    const { cli, responses } = stubCli(fixture.root);
    const respond = (data: unknown) =>
      writeFileSync(responses, JSON.stringify({ "2ship2harkinian": data }));
    const subject = assessmentSubject("2ship2harkinian", hostPlatform());
    const current = () =>
      JSON.parse(
        runSql(
          store.owner,
          `SELECT json_build_object('sequence', c.sequence, 'transition', c.assessment_id,
             'applicable', c.applicable_assessment_id, 'policy', a.policy_version, 'input', a.input_digest,
             'verified_run', c.verified_run_id, 'changed_at', c.updated_at, 'verified_at', c.verified_at,
             'transitions', (SELECT count(*) FROM portcove_maintenance.subject_transitions t WHERE t.subject_key = c.subject_key),
             'notifications', (SELECT count(*) FROM portcove_maintenance.notifications n WHERE n.subject_key = c.subject_key))
             FROM portcove_maintenance.subject_current c
             JOIN portcove_maintenance.assessments a ON a.assessment_id = c.applicable_assessment_id
            WHERE c.subject_key = '${subject}';`,
        ),
      ) as {
        sequence: number;
        transition: number;
        applicable: number;
        policy: string;
        input: string;
        verified_run: string;
        changed_at: string;
        verified_at: string;
        transitions: number;
        notifications: number;
      };
    const ports = ["2ship2harkinian"];
    let issuesFail = false;
    const issues = () =>
      issuesFail
        ? Promise.reject(new Error("Project read refused"))
        : Promise.resolve({
            repository: "boburning/portcove",
            observed_at: "2026-11-11T00:00:00Z",
            total: 1,
            issues: [
              {
                id: "I1",
                number: 1,
                title: "Ship",
                state: "OPEN",
                body: "<!-- portcove-catalog-id: 2ship2harkinian -->",
              },
            ],
            memberships: [],
          });
    const all = (extra: Partial<Parameters<typeof collect>[0]> = {}) =>
      collect({ cli, all: true, ports, environment: collector, runner: "fixture", ...extra });

    respond(report("automatic"));
    await all();
    const first = current();
    assert.equal(first.sequence, 1);

    // Same result, new inputs: provenance and verification move, history and notifications do not.
    respond({ ...report("automatic"), port_id: "changed-input" });
    await all();
    const newInput = current();
    assert.equal(newInput.sequence, 1);
    assert.equal(newInput.transition, first.transition, "the last material transition is kept");
    assert.notEqual(newInput.applicable, first.applicable);
    assert.notEqual(newInput.input, first.input);
    assert.notEqual(newInput.verified_run, first.verified_run);
    assert.equal(newInput.changed_at, first.changed_at);
    assert.ok(newInput.verified_at > first.verified_at);
    assert.deepEqual([newInput.transitions, newInput.notifications], [1, 0]);

    // A rebuilt Core binary with identical behavior writes no new assessment: the same
    // projection of the same Core output is the same assessment, now verified by the
    // new binary's run, which records its digest.
    const assessmentsBefore = runSql(
      store.owner,
      "SELECT count(*) FROM portcove_maintenance.assessments;",
    ).trim();
    writeFileSync(cli, `${readFileSync(cli, "utf8")}\n// rebuilt\n`);
    await all();
    const newPolicy = current();
    assert.equal(newPolicy.policy, newInput.policy);
    assert.equal(newPolicy.applicable, newInput.applicable);
    assert.notEqual(newPolicy.verified_run, newInput.verified_run);
    assert.equal(
      runSql(store.owner, "SELECT count(*) FROM portcove_maintenance.assessments;").trim(),
      assessmentsBefore,
      "a rebuild with identical behavior adds no rows",
    );
    assert.deepEqual(
      [newPolicy.sequence, newPolicy.transitions, newPolicy.notifications],
      [1, 1, 0],
    );

    // An unchanged pass verifies again and records nothing else.
    await all();
    const again = current();
    assert.equal(again.applicable, newPolicy.applicable);
    assert.notEqual(again.verified_run, newPolicy.verified_run);
    assert.deepEqual([again.sequence, again.transitions, again.notifications], [1, 1, 0]);

    // Reversed completion: an older collection that finishes after a newer one is refused whole.
    respond(report("manual"));
    let entered!: () => void;
    let release!: () => void;
    const reading = new Promise<void>((resolve) => (entered = resolve));
    const gate = new Promise<void>((resolve) => (release = resolve));
    const slow = all({
      issues: async () => {
        entered();
        await gate;
        return issues();
      },
    });
    await reading;
    respond(report("automatic"));
    await all({ issues });
    const newer = current();
    release();
    await assert.rejects(
      slow,
      /newer maintenance collection finished first; this one replaced nothing/u,
    );
    assert.deepEqual(current(), newer, "the late, older result never becomes current");
    assert.equal(
      runSql(
        store.owner,
        "SELECT count(*) FROM portcove_maintenance.subject_transitions WHERE state = 'managed-setup.manual';",
      ).trim(),
      "0",
      "no false A -> B -> A history",
    );

    // Runner clocks are not freshness: a newer ticket with an older clock is the latest run,
    // and a replayed or restored worker's older ticket is refused.
    const stale = acquireCollection(collector);
    const fresh = acquireCollection(collector);
    runSql(
      collector,
      `INSERT INTO portcove_maintenance.collection_runs (run_id, source, runner, started_at, acquisition)
         VALUES ('skewed', 'catalog-records', 'fixture', '2000-01-01T00:00:00Z', ${fresh});
       UPDATE portcove_maintenance.collection_runs SET coverage = 'failed', completed_at = clock_timestamp(),
         source_revision = 'skewed' WHERE run_id = 'skewed';`,
    );
    assert.equal(
      runSql(store.owner, "SELECT portcove_maintenance.latest_run('catalog-records');").trim(),
      "skewed",
    );
    assert.throws(
      () =>
        runSql(
          collector,
          `INSERT INTO portcove_maintenance.collection_runs (run_id, source, runner, started_at, acquisition)
             VALUES ('replayed', 'catalog-records', 'fixture', '2099-01-01T00:00:00Z', ${stale});`,
        ),
      /stale maintenance collection for catalog-records/u,
    );
    assert.throws(
      () =>
        runSql(
          collector,
          `INSERT INTO portcove_maintenance.collection_runs (run_id, source, runner, started_at, acquisition)
             VALUES ('forged', 'other-source', 'fixture', now(), ${fresh + 1000});`,
        ),
      /unissued acquisition/u,
    );
    assert.throws(
      () =>
        runSql(collector, "SELECT portcove_maintenance.expect_baseline('catalog-records', 'old');"),
      /maintenance baseline changed for catalog-records: expected old, found skewed/u,
    );

    // One failing source keeps its earlier facts and does not discard the others.
    issuesFail = true;
    const outcome = await all({
      issues,
      releaseHealth: () => Promise.reject(new Error("no report")),
    });
    assert.deepEqual(outcome.failed_sources, ["issues-project", "release-health"]);
    const latest = JSON.parse(
      runSql(
        store.owner,
        `SELECT json_object_agg(source, json_build_object('coverage', coverage, 'gap', gaps -> 0 ->> 'subject_key'))
           FROM portcove_maintenance.collection_runs
          WHERE run_id IN (SELECT portcove_maintenance.latest_run(s)
                             FROM unnest(ARRAY['catalog-records', 'issues-project', 'release-health', 'core-port-capabilities-${hostPlatform()}']) s);`,
      ),
    ) as Record<string, { coverage: string; gap: string | null }>;
    assert.deepEqual(latest, {
      "catalog-records": { coverage: "complete", gap: null },
      [`core-port-capabilities-${hostPlatform()}`]: { coverage: "complete", gap: null },
      "issues-project": { coverage: "failed", gap: "source:issues-project" },
      "release-health": { coverage: "failed", gap: "source:release-health-report" },
    });
    const work = (
      buildReport(store.owner).subjects as { subject_key: string; work: { number: number }[] }[]
    ).find((entry) => entry.subject_key === subject)?.work;
    assert.deepEqual(
      work?.map(({ number }) => number),
      [1],
      "the earlier verified issue facts stay current",
    );

    // Quoting never depends on server or role settings, even though the collection is batched.
    runSql(
      store.owner,
      `DO $$ BEGIN EXECUTE format('ALTER DATABASE %I SET standard_conforming_strings = off', current_database()); END $$;`,
    );
    issuesFail = false;
    respond({ ...report("automatic"), port_id: String.raw`back\slash "quoted" \n` });
    await all({ issues });
    assert.equal(
      runSql(
        store.owner,
        `SELECT o.payload #>> '{report,port_id}' FROM portcove_maintenance.observations o
           WHERE o.run_id = portcove_maintenance.latest_run('core-port-capabilities-${hostPlatform()}');`,
      ).trim(),
      String.raw`back\slash "quoted" \n`,
    );
  },
);

void test(
  "migration 0003 binds existing state and handoff plans follow the applicable assessment",
  { skip: server.skip ?? false, timeout: 240_000 },
  async (context) => {
    const fixture = postgresFixture(context, server.directory!);
    const store = fixture.start("upgrade");
    // A populated store at migration 0002, as deployed before this change.
    for (const migration of readMigrations().filter(({ version }) => version <= 2))
      runSql(store.owner, migrationTransaction(migration));
    const kind = "upstream-observer-exception";
    const source = "port:alpha@linux-x86-64";
    const subject = handoffSubject(kind, source);
    const legacyId = handoffOperationId(kind, source, 1);
    const digest = (character: string) => character.repeat(64);
    runSql(
      store.owner,
      `INSERT INTO portcove_maintenance.collection_runs (run_id, source, runner, started_at)
         VALUES ('upstream-1', 'upstream-observations', 'fixture', '2026-11-12T00:00:00Z');
       UPDATE portcove_maintenance.collection_runs SET coverage = 'partial', completed_at = '2026-11-12T00:01:00Z',
         source_revision = 'r1' WHERE run_id = 'upstream-1';
       INSERT INTO portcove_maintenance.assessments (subject_key, policy_version, input_digest, state, result_digest, explanation, assessed_at, run_id)
         VALUES ('${subject}', '${handoffPolicyVersion}', '${digest("1")}', 'needs-attention', '${digest("2")}',
           '{"handoff":"${kind}","source_subject":"${source}","condition":{"exceptions":[]}}', '2026-11-12T00:01:00Z', 'upstream-1');
       INSERT INTO portcove_maintenance.subject_transitions (subject_key, sequence, assessment_id) VALUES ('${subject}', 1, 1);
       INSERT INTO portcove_maintenance.operations (operation_id, kind, subject_key, fence_sequence, executor, created_at, updated_at)
         VALUES ('${legacyId}', 'handoff.${kind}', '${subject}', 1, 'upstream-observer', now(), now());`,
    );
    assert.deepEqual(migrate(store.owner).newly_applied, [3]);
    assert.equal(
      runSql(
        store.owner,
        `SELECT c.applicable_assessment_id || ':' || c.verified_run_id || ':' || (c.verified_acquisition IS NOT NULL)
             || ':' || o.fence_assessment_id || ':' || r.acquisition
           FROM portcove_maintenance.subject_current c
           JOIN portcove_maintenance.operations o ON o.subject_key = c.subject_key
           JOIN portcove_maintenance.collection_runs r ON r.run_id = 'upstream-1';`,
      ).trim(),
      "1:upstream-1:true:1:1",
      "existing current state, runs and plans are bound by the migration",
    );
    runSql(store.owner, "CREATE ROLE executor_login LOGIN IN ROLE portcove_maintenance_executor;");
    const executor = store.as("executor_login");
    const operations = () =>
      runSql(
        store.owner,
        `SELECT string_agg(operation_id || '=' || state, ' ' ORDER BY operation_id COLLATE "C")
           FROM portcove_maintenance.operations;`,
      ).trim();
    // The legacy plan stays the one open plan: nothing is abandoned or duplicated.
    assert.deepEqual(recordHandoffOperations(executor), { abandoned: 0, planned: 0, open: 1 });
    assert.equal(operations(), `${legacyId}=planned`);
    assert.doesNotMatch(
      readOpenHandoffs(store.owner)
        .map(({ operation }) => JSON.stringify(operation))
        .join(),
      /stale/u,
    );

    // The same result under a new policy moves the applicable assessment at the same fence:
    // the old plan is abandoned and replaced in one pass, and a replay changes nothing.
    runSql(
      store.owner,
      `INSERT INTO portcove_maintenance.collection_runs (run_id, source, runner, started_at)
         VALUES ('upstream-2', 'upstream-observations', 'fixture', now());
       INSERT INTO portcove_maintenance.assessments (subject_key, policy_version, input_digest, state, result_digest, explanation, assessed_at, run_id)
         VALUES ('${subject}', 'maintenance-handoffs/next', '${digest("1")}', 'needs-attention', '${digest("2")}',
           '{"handoff":"${kind}","source_subject":"${source}","condition":{"exceptions":[]}}', now(), 'upstream-2');
       SELECT portcove_maintenance.verify_current(2, 'upstream-2');`,
    );
    assert.deepEqual(recordHandoffOperations(executor), { abandoned: 1, planned: 1, open: 1 });
    const replacement = handoffOperationId(kind, source, 1, 2);
    assert.equal(operations(), `${legacyId}=abandoned ${replacement}=planned`);
    assert.deepEqual(recordHandoffOperations(executor), { abandoned: 0, planned: 0, open: 1 });
    const [open] = readOpenHandoffs(store.owner);
    assert.equal(open?.assessment_id, 2);
    assert.equal(open?.operation?.operation_id, replacement);
    assert.equal(open?.operation?.fence_assessment_id, 2);
    // A failed run cannot verify anything, before or after it finishes.
    assert.throws(
      () =>
        runSql(
          store.owner,
          `UPDATE portcove_maintenance.collection_runs SET coverage = 'failed', completed_at = clock_timestamp(),
             source_revision = 'r2' WHERE run_id = 'upstream-2';`,
        ),
      /verified maintenance state and cannot finish failed/u,
    );
    runSql(
      store.owner,
      `UPDATE portcove_maintenance.collection_runs SET coverage = 'partial', completed_at = clock_timestamp(),
         source_revision = 'r2' WHERE run_id = 'upstream-2';
       INSERT INTO portcove_maintenance.collection_runs (run_id, source, runner, started_at)
         VALUES ('upstream-3', 'upstream-observations', 'fixture', now());
       UPDATE portcove_maintenance.collection_runs SET coverage = 'failed', completed_at = clock_timestamp(),
         source_revision = 'r3' WHERE run_id = 'upstream-3';`,
    );
    assert.throws(
      () => runSql(store.owner, "SELECT portcove_maintenance.verify_current(2, 'upstream-3');"),
      /does not exist or failed/u,
    );

    // The applicable assessment moving X -> Y -> X at one fence replans each time under
    // a new identity, and a dispatched operation keeps the handoff from a second plan.
    let verifier = 3;
    const verifyAs = (assessment: number) => {
      verifier += 1;
      runSql(
        store.owner,
        `INSERT INTO portcove_maintenance.collection_runs (run_id, source, runner, started_at)
           VALUES ('upstream-${verifier}', 'upstream-observations', 'fixture', now());
         SELECT portcove_maintenance.verify_current(${assessment}, 'upstream-${verifier}');
         UPDATE portcove_maintenance.collection_runs SET coverage = 'partial', completed_at = clock_timestamp(),
           source_revision = 'r${verifier}' WHERE run_id = 'upstream-${verifier}';`,
      );
    };
    verifyAs(1);
    assert.deepEqual(recordHandoffOperations(executor), { abandoned: 1, planned: 1, open: 1 });
    verifyAs(2);
    assert.deepEqual(recordHandoffOperations(executor), { abandoned: 1, planned: 1, open: 1 });
    const again = `${replacement}.2`;
    assert.equal(
      operations(),
      `${legacyId}=abandoned ${handoffOperationId(kind, source, 1, 1)}=abandoned ${replacement}=abandoned ${again}=planned`,
    );
    runSql(
      executor,
      `UPDATE portcove_maintenance.operations SET state = 'dispatched', revision = 2, updated_at = clock_timestamp()
         WHERE operation_id = '${again}';`,
    );
    verifyAs(1);
    assert.deepEqual(recordHandoffOperations(executor), { abandoned: 0, planned: 0, open: 1 });
    assert.match(operations(), new RegExp(`${again.replaceAll(".", "\\.")}=dispatched$`, "u"));
  },
);

void test(
  "Core per-target route offering is stored per port, reported and fails alone",
  { skip: server.skip ?? false, timeout: 240_000 },
  async (context) => {
    const fixture = postgresFixture(context, server.directory!);
    const store = fixture.start("targets");
    migrate(store.owner);
    const { cli, responses } = stubCli(fixture.root);
    writeFileSync(
      responses,
      JSON.stringify({
        "2ship2harkinian": report("automatic"),
        "targets:not-a-catalog-port": "not_found",
      }),
    );
    const ports = ["2ship2harkinian", "not-a-catalog-port"];
    const all = (targets: Parameters<typeof collect>[0]["targets"]) =>
      collect({ cli, all: true, ports, targets, environment: store.owner, runner: "fixture" });
    await all(true);
    await all(true);
    const runs = JSON.parse(
      runSql(
        store.owner,
        `SELECT json_agg(json_build_object('coverage', coverage, 'expected', expected_count,
           'rows', (SELECT count(*) FROM portcove_maintenance.observations o WHERE o.run_id = r.run_id),
           'revision', source_revision) ORDER BY acquisition)
           FROM portcove_maintenance.collection_runs r WHERE source = 'core-target-routes';`,
      ),
    ) as { coverage: string; expected: number; rows: number; revision: string }[];
    assert.deepEqual(
      runs.map(({ coverage, expected, rows }) => [coverage, expected, rows]),
      [
        ["complete", 2, 2],
        ["complete", 2, 0],
      ],
      "an unchanged inspection is quiet",
    );
    assert.match(
      runs[0]!.revision,
      /^cli-sha256:[0-9a-f]{64};source=unrecorded;producer-sha256=[0-9a-f]{16};binding=unverified$/u,
      "bound to the assessing Core binary, with its unrecorded source visible",
    );
    const inventory = buildReport(store.owner);
    const ship = (inventory.subjects as { port_key: string; target_routes: unknown }[]).find(
      ({ port_key }) => port_key === "port:2ship2harkinian",
    );
    assert.match(
      targetSummary(ship?.target_routes as never) ?? "",
      /^managed install on linux-x86-64; trust eligibility and readiness not assessed$/u,
    );
    assert.equal(qualificationSummary(ship?.target_routes as never), "no recorded qualification");
    assert.match(renderHtml(inventory), /Qualification for the offered artifact \(Core\)/u);
    // An older Core report format is refused, never stored partially.
    writeFileSync(
      responses,
      JSON.stringify({
        "2ship2harkinian": report("automatic"),
        "targets:not-a-catalog-port": "not_found",
        targetsFormat: 1,
      }),
    );
    await assert.rejects(readTargetRoutes(cli, ["2ship2harkinian"]), /unsupported|format/iu);
    assert.match(renderHtml(inventory), /Offered for a fresh library/u);
    // Each subject names when its inputs last changed, from stored observations.
    const shipInputs = (
      inventory.subjects as { port_key: string; reassessment: SubjectReassessment }[]
    ).find(({ port_key }) => port_key === "port:2ship2harkinian")?.reassessment;
    assert.ok(shipInputs?.catalog_changed_at && shipInputs.core_output_changed_at);
    assert.ok(shipInputs.inputs_unchanged_since && shipInputs.last_verified_at);
    assert.match(renderHtml(inventory), /Inputs last changed/u);
    assert.equal(
      targetSummary({
        presence: "not_found",
        declared_platforms: [],
        acquisition_hold: null,
        download_restriction: null,
        targets: [],
      }),
      "not found; no route offered",
    );
    // The producing Core's identity binds every assessment's policy, quietly.
    const head = execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();
    writeFileSync(
      responses,
      JSON.stringify({
        "2ship2harkinian": report("automatic"),
        "targets:not-a-catalog-port": "not_found",
        producer: {
          source_revision: head,
          features: [],
          embedded_catalog_sha256: "d".repeat(64),
          embedded_listings_sha256: "e".repeat(64),
          catalog_override: false,
        },
      }),
    );
    const transitions = () =>
      runSql(store.owner, "SELECT count(*) FROM portcove_maintenance.subject_transitions;").trim();
    const transitionsBefore = transitions();
    await all(true);
    assert.match(
      runSql(
        store.owner,
        `SELECT a.policy_version FROM portcove_maintenance.subject_current c
           JOIN portcove_maintenance.assessments a ON a.assessment_id = c.applicable_assessment_id
          WHERE c.subject_key LIKE 'port:2ship2harkinian@%';`,
      ).trim(),
      /^port-capabilities;api=[0-9]+;projection=[0-9]+$/u,
      "the policy names the projection, never the binary or its build",
    );
    assert.match(
      runSql(
        store.owner,
        `SELECT source_revision FROM portcove_maintenance.collection_runs
          WHERE run_id = portcove_maintenance.latest_run('core-port-capabilities-${hostPlatform()}');`,
      ).trim(),
      new RegExp(
        `^cli-sha256:[0-9a-f]{64};source=${head};producer-sha256=[0-9a-f]{16};binding=(verified|unverified)$`,
        "u",
      ),
    );
    assert.equal(transitions(), transitionsBefore, "a new binding is not a material change");
    // The source binding is verified only for a clean checkout's own revision, the
    // compiled catalog and no behavior-changing features. A new Core payload stores
    // a new observation, which carries the binding.
    const clean =
      execFileSync("git", ["status", "--porcelain", "--", "crates", "Cargo.toml", "Cargo.lock"], {
        encoding: "utf8",
      }).trim() === "";
    const binding = async (producer: Record<string, unknown>, variant: string) => {
      writeFileSync(
        responses,
        JSON.stringify({
          "2ship2harkinian": { ...report("automatic"), port_id: variant },
          "targets:not-a-catalog-port": "not_found",
          producer: {
            source_revision: head,
            features: [],
            embedded_catalog_sha256: "d".repeat(64),
            embedded_listings_sha256: "e".repeat(64),
            catalog_override: false,
            ...producer,
          },
        }),
      );
      await all(true);
      const row = runSql(
        store.owner,
        `SELECT json_build_object('binding', o.scope ->> 'cli_source_binding', 'revision', o.input_revision)
             FROM portcove_maintenance.observations o
            WHERE o.run_id = portcove_maintenance.latest_run('core-port-capabilities-${hostPlatform()}')
              AND o.subject_key = 'port:2ship2harkinian';`,
      ).trim();
      return (row ? JSON.parse(row) : null) as { binding: string; revision: string } | null;
    };
    assert.equal((await binding({}, "a"))?.binding, clean ? "verified" : "unverified");
    // The same output from a different build writes no observation; the verifying
    // run still states that build's binding, and the report shows it.
    await binding({ features: ["qualification-fixtures"] }, "a");
    const verifiedBy = (
      buildReport(store.owner).subjects as { port_key: string; verified_by: string }[]
    ).find(({ port_key }) => port_key === "port:2ship2harkinian")?.verified_by;
    assert.match(verifiedBy ?? "", /;binding=unverified$/u);
    assert.equal((await binding({ catalog_override: true }, "b"))?.binding, "unverified");
    assert.equal(
      (await binding({ features: ["qualification-fixtures"] }, "c"))?.binding,
      "unverified",
    );
    const malformed = await binding({ source_revision: "x".repeat(150) }, "d");
    assert.equal(malformed?.binding, "unverified");
    assert.match(
      malformed?.revision ?? "",
      /;source=unrecorded;producer-sha256=[0-9a-f]{16};binding=unverified$/u,
      "an invalid revision is never stored",
    );
    // A failed inspection is its own failed run; the earlier facts stay current.
    const failed = await all(() => Promise.reject(new Error("inspection refused")));
    assert.deepEqual(failed.failed_sources, ["core-target-routes"]);
    assert.ok(
      (buildReport(store.owner).subjects as { port_key: string; target_routes: unknown }[]).find(
        ({ port_key }) => port_key === "port:2ship2harkinian",
      )?.target_routes,
    );
  },
);

void test("target routes are read in bounded batches and malformed entries are refused", async (context) => {
  const root = mkdtempSync(path.join(os.tmpdir(), "portcove-targets-"));
  context.after(() => rmSync(root, { recursive: true, force: true }));
  const { cli, responses } = stubCli(root);
  const ids = Array.from({ length: 450 }, (_, index) => `port-${index}`);
  writeFileSync(responses, JSON.stringify({}));
  const { facts, producer } = await readTargetRoutes(cli, [...ids, ids[0]!]);
  assert.equal(facts.size, 450, "every requested port once, across three Core calls");
  assert.deepEqual(producer, {
    source_revision: null,
    features: [],
    embedded_catalog_sha256: "c".repeat(64),
    embedded_listings_sha256: "e".repeat(64),
    catalog_override: false,
  });
  const calls = readFileSync(path.join(root, "isolation.log"), "utf8").trim().split("\n");
  assert.equal(calls.length, 3);
  writeFileSync(responses, JSON.stringify({ "targets:port-7": 5 }));
  await assert.rejects(readTargetRoutes(cli, ids.slice(0, 10)), /unsupported entry for port-7/u);
});

void test("explicit blocker fields are read only when present and substantive", () => {
  const body = (section: string) => `## Dependencies and blockers\n\n${section}\n\n## Other\n`;
  assert.deepEqual(
    explicitBlockerFields(
      body(
        "Blocker: Upstream has not published a usable native player.\nResume condition: Upstream publishes a usable player.",
      ),
    ),
    {
      blocker: "Upstream has not published a usable native player.",
      resume_condition: "Upstream publishes a usable player.",
    },
  );
  assert.equal(explicitBlockerFields(body("Resume condition: TBD")), null);
  assert.equal(explicitBlockerFields(body("Waiting until upstream ships a player.")), null);
  assert.equal(explicitBlockerFields("no section"), null);
  // A cut never splits an astral character into a lone surrogate.
  const long = explicitBlockerFields(body(`Resume condition: ${"a".repeat(499)}🎮 and more text.`));
  assert.equal(Array.from(long!.resume_condition).length, 500);
  assert.ok(long!.resume_condition.endsWith("🎮"));
});

void test("holds and deferrals come only from their owners and episodes stay distinct", () => {
  const issue = (
    number: number,
    status: string,
    state = "OPEN",
    archived = false,
    project_id = "PVT_roadmap",
  ) => [
    `issue:${number}`,
    { number, state, project: [{ project_id, archived, fields: { Status: status } }] },
  ];
  const { conditions, closed } = issueReconsiderations(
    new Map<string, unknown>([
      issue(1, "Deferred"),
      issue(2, "Blocked"),
      issue(3, "Ready"),
      issue(4, "Deferred", "CLOSED"),
      issue(5, "Deferred", "OPEN", true),
      // Another Project's Status is not the planning authority.
      issue(6, "Deferred", "OPEN", false, "PVT_other"),
    ] as [string, unknown][]),
    "PVT_roadmap",
  );
  assert.deepEqual(closed, ["issue:4"]);
  assert.deepEqual(
    conditions.map(({ subject_key, kind, revisit_authority }) => [
      subject_key,
      kind,
      revisit_authority,
    ]),
    [
      ["issue:1", "intentional_deferral", "Project owner of issue #1 (Status: Deferred)"],
      ["issue:2", "technical_hold", "Project owner of issue #2 (Status: Blocked)"],
    ],
  );
  assert.match(conditions[0]!.base, /^reconsider\.intentional_deferral\.issue-1\.[0-9a-f]{12}$/u);
  assert.deepEqual(
    targetReconsiderations(
      new Map<string, unknown>([
        ["port:held", { acquisition_hold: "Held while review completes." }],
        ["port:open", { acquisition_hold: null }],
      ]),
    ).map(({ subject_key, kind, condition }) => [subject_key, kind, condition]),
    [
      [
        "port:held",
        "technical_hold",
        { source: "core-target-routes", acquisition_hold: "Held while review completes." },
      ],
    ],
  );
  const entries = deferralChanges(
    [
      {
        reconsideration_id: "r",
        subject_key: "issue:7",
        kind: "intentional_deferral",
        status: "pending",
        revisit_authority: "Project owner of issue #7 (Status: Deferred)",
        condition: { source: "issues-project" },
        created_at: "2026-11-10T00:00:00Z",
        resolved_at: null,
        resolution: null,
      },
    ],
    [
      {
        subject_key: "port:a@linux-x86-64",
        state: "s",
        changed_at: "2026-11-11T00:00:00Z",
        work: [{ number: 7 }],
      },
      {
        subject_key: "port:b@linux-x86-64",
        state: "s",
        changed_at: "2026-11-09T00:00:00Z",
        work: [{ number: 7 }],
      },
      {
        subject_key: "port:c@linux-x86-64",
        state: "s",
        changed_at: "2026-11-11T00:00:00Z",
        work: [{ number: 8 }],
      },
    ],
  );
  assert.deepEqual(
    entries[0]!.technical_changes?.map(({ subject_key }) => subject_key),
    ["port:a@linux-x86-64"],
  );
});

void test(
  "typed reconsiderations follow complete owner reads, stay quiet and keep episodes",
  { skip: server.skip ?? false, timeout: 240_000 },
  async (context) => {
    const fixture = postgresFixture(context, server.directory!);
    const store = fixture.start("reconsider");
    migrate(store.owner);
    const { cli, responses } = stubCli(fixture.root);
    writeFileSync(responses, JSON.stringify({ "2ship2harkinian": report("automatic") }));
    let status = "Deferred";
    let resume = "Resume condition: The owner reprioritizes native Linux packaging.";
    let issuesFail = false;
    let issueState = "OPEN";
    let hold: string | null = "Held while upstream launcher updates are reviewed.";
    const issues = () =>
      issuesFail
        ? Promise.reject(new Error("GraphQL unavailable"))
        : Promise.resolve({
            repository: "boburning/portcove",
            observed_at: "2026-11-13T00:00:00Z",
            roadmap_project_id: "P1",
            total: 1,
            issues: [
              {
                id: "I1",
                number: 1,
                title: "Ship",
                state: issueState,
                body: `<!-- portcove-catalog-id: 2ship2harkinian -->\n\n## Dependencies and blockers\n\nBlocker: Native packaging is deliberately deferred.\n${resume}\n`,
              },
            ],
            memberships: [
              {
                project_id: "P1",
                issue_id: "I1",
                isArchived: false,
                fieldValues: { nodes: [{ name: status, field: { name: "Status" } }] },
              },
            ],
          });
    const targets = () =>
      Promise.resolve({
        facts: new Map<string, unknown>([
          [
            "port:2ship2harkinian",
            {
              presence: "operational",
              declared_platforms: ["linux-x86-64"],
              acquisition_hold: hold,
              download_restriction: null,
              targets: [],
            },
          ],
        ]),
        producer: null,
      });
    const run = () =>
      collect({
        cli,
        all: true,
        ports: ["2ship2harkinian"],
        issues,
        targets,
        environment: store.owner,
        runner: "fixture",
      });
    const rows = () =>
      JSON.parse(
        runSql(
          store.owner,
          `SELECT coalesce(json_agg(json_build_object('id', reconsideration_id, 'kind', kind, 'status', status,
             'outcome', resolution ->> 'outcome', 'authority', resolution ->> 'authority') ORDER BY created_at, reconsideration_id), '[]')
             FROM portcove_maintenance.reconsiderations;`,
        ),
      ) as {
        id: string;
        kind: string;
        status: string;
        outcome: string | null;
        authority: string | null;
      }[];

    await run();
    await run();
    assert.deepEqual(
      rows().map(({ kind, status }) => [kind, status]),
      [
        ["intentional_deferral", "pending"],
        ["technical_hold", "pending"],
      ],
      "recorded once; an unchanged read is quiet",
    );
    const report1 = buildReport(store.owner);
    assert.match(
      String(report1.reconsiderations?.[0]?.condition.resume_condition),
      /reprioritizes native Linux packaging/u,
    );
    assert.match(renderHtml(report1), /Holds and deferrals/u);

    // A failed owner read resolves nothing.
    issuesFail = true;
    status = "Ready";
    await run();
    assert.ok(rows().every(({ status: value }) => value === "pending"));

    // The Project owner lifts the deferral: resolved under its recorded authority.
    issuesFail = false;
    await run();
    const lifted = rows().find(({ kind }) => kind === "intentional_deferral")!;
    assert.deepEqual(
      [lifted.status, lifted.outcome, lifted.authority],
      ["satisfied", "condition-lifted", "Project owner of issue #1 (Status: Deferred)"],
    );
    // Deferred again with the same condition: a new episode, not the old row.
    status = "Deferred";
    await run();
    const deferrals = rows().filter(({ kind }) => kind === "intentional_deferral");
    assert.deepEqual(
      deferrals.map(({ status: value }) => value),
      ["satisfied", "pending"],
    );
    assert.equal(deferrals[1]!.id, `${deferrals[0]!.id}.1`);
    // A changed resume condition withdraws the old condition and records the new one.
    resume = "Resume condition: Upstream publishes a reproducible Linux build.";
    await run();
    assert.deepEqual(
      rows()
        .filter(({ kind }) => kind === "intentional_deferral")
        .map(({ status: value, outcome }) => [value, outcome]),
      [
        ["satisfied", "condition-lifted"],
        ["withdrawn", "condition-changed"],
        ["pending", null],
      ],
    );
    // Lifting the reviewed acquisition hold satisfies the technical hold.
    hold = null;
    await run();
    assert.deepEqual(
      rows()
        .filter(({ kind }) => kind === "technical_hold")
        .map(({ status: value, outcome }) => [value, outcome]),
      [["satisfied", "condition-lifted"]],
    );
    // Closing the issue ends its deferral as closed, never as lifted.
    issueState = "CLOSED";
    await run();
    assert.deepEqual(
      rows()
        .filter(({ kind }) => kind === "intentional_deferral")
        .map(({ status: value, outcome }) => [value, outcome]),
      [
        ["satisfied", "condition-lifted"],
        ["withdrawn", "condition-changed"],
        ["withdrawn", "issue-closed"],
      ],
    );
    issueState = "OPEN";
    await run();
    // Only the recorded authority may reconsider a deferral.
    assert.throws(
      () =>
        runSql(
          store.owner,
          `UPDATE portcove_maintenance.reconsiderations SET status = 'satisfied', resolved_at = now(),
             resolution = '{"authority":"technical viability"}'
             WHERE kind = 'intentional_deferral' AND status = 'pending';`,
        ),
      /only by its recorded authority/u,
    );
  },
);

void test("qualification is worded from Core's states without deciding applicability", () => {
  const target = (qualification: Record<string, unknown>) => ({
    presence: "operational",
    declared_platforms: ["windows-x86-64"],
    acquisition_hold: null,
    download_restriction: null,
    targets: [
      {
        platform: "windows-x86-64",
        routes: [],
        provider_resolution_required: false,
        definition_eligibility: "unknown",
        readiness: "unknown",
        qualification: {
          known_failure: false,
          qualified_refs: [],
          evidence_route: "unrecorded",
          offered_artifact: { state: "provider_resolved", route: "install" },
          scopes: [],
          legacy_coverage: [],
          ...qualification,
        },
      },
    ],
  });
  assert.equal(
    qualificationSummary(
      target({
        state: "reviewed_binding_qualified",
        qualified_refs: ["v1.8.3"],
        known_failure: true,
        scopes: [
          { applicability: "reviewed_release_binding", upstream_ref: "v1.8.3", check_version: "a" },
          { applicability: "reviewed_release_binding", upstream_ref: "v1.8.3", check_version: "b" },
        ],
      }) as never,
    ),
    "qualified for reviewed release v1.8.3 on windows-x86-64 only if the provider resolves it; known failure recorded on windows-x86-64; evidence does not record which route it exercised",
  );
  assert.equal(
    qualificationSummary(
      target({
        state: "offered_artifact_qualified",
        qualified_refs: ["v2"],
        offered_artifact: { state: "fixed", route: "install", upstream_ref: "v2" },
      }) as never,
    ),
    "qualified for the offered artifact v2 on windows-x86-64; evidence does not record which route it exercised",
  );
  assert.equal(
    qualificationSummary(
      target({ state: "historical_only", legacy_coverage: ["automated_tested"] }) as never,
    ),
    "historical qualification only on windows-x86-64; legacy port-wide coverage (automated_tested) on windows-x86-64, not artifact-bound",
  );
  assert.equal(
    qualificationSummary(target({ state: "future_state" }) as never),
    "future_state on windows-x86-64; evidence does not record which route it exercised",
  );
  assert.equal(
    qualificationSummary(target({ state: "unqualified" }) as never),
    "no recorded qualification",
  );
  assert.equal(
    qualificationSummary(target({ state: "applicable_not_passed", known_failure: true }) as never),
    "evidence recorded for what is offered on windows-x86-64, none passed; known failure recorded on windows-x86-64; evidence does not record which route it exercised",
  );
  assert.equal(
    qualificationSummary(target({ state: "structural_only" }) as never),
    "structural checks only on windows-x86-64; evidence does not record which route it exercised",
  );
});

void test("the report page filters subjects by text, platform, state, attention and recency", () => {
  const { subjectMatches } = vm.runInNewContext(`${subjectFilterSource}; ({ subjectMatches })`) as {
    subjectMatches: (subject: unknown, filters: unknown, generatedAt: string) => boolean;
  };
  const generated = "2026-11-13T00:00:00.000Z";
  const quiet = {
    subject_key: "port:alpha@linux-x86-64",
    name: "Alpha",
    game: "Shared Game",
    state: "managed-setup.automatic",
    changed_at: "2026-10-01T00:00:00.000Z",
    work: ["#10 (canonical) OPEN · Ready"],
    offered: "managed install on linux-x86-64",
    attention: [],
    next_actions: [],
  };
  const busy = {
    ...quiet,
    subject_key: "port:beta@windows-x86-64",
    name: "Beta",
    state: "external.registration",
    changed_at: "2026-11-12T12:00:00.000Z",
    attention: ["provider-redirect (observe-availability)"],
  };
  const shown = (filters: Record<string, unknown>) =>
    [quiet, busy]
      .filter((subject) => subjectMatches(subject, filters, generated))
      .map(({ name }) => name);
  assert.deepEqual(shown({}), ["Alpha", "Beta"]);
  // Every token must match somewhere in the row, including linked work and offerings.
  assert.deepEqual(shown({ text: "shared #10 READY" }), ["Alpha", "Beta"]);
  assert.deepEqual(shown({ text: "provider-redirect" }), ["Beta"]);
  assert.deepEqual(shown({ text: "alpha missing-token" }), []);
  assert.deepEqual(shown({ platform: "windows-x86-64" }), ["Beta"]);
  assert.deepEqual(shown({ state: "managed-setup.automatic" }), ["Alpha"]);
  assert.deepEqual(shown({ attention: true }), ["Beta"]);
  // A source-wide failed health read alone does not need every port's attention.
  assert.equal(
    subjectMatches(
      { ...quiet, latest_health_gap: "latest read failed: unavailable" },
      { attention: true },
      generated,
    ),
    false,
  );
  assert.equal(
    subjectMatches({ ...quiet, port_health_gap: "stale" }, { attention: true }, generated),
    true,
  );
  assert.deepEqual(shown({ changedWithinDays: 7 }), ["Beta"]);
  // An unparseable change time never counts as recent.
  assert.deepEqual(
    [{ ...busy, changed_at: "never" }].filter((subject) =>
      subjectMatches(subject, { changedWithinDays: 30 }, generated),
    ).length,
    0,
  );
});

void test("source freshness ages the last good read against the report and flags stale sources", () => {
  const now = new Date("2026-11-13T12:00:00.000Z");
  assert.deepEqual(
    sourceFreshness(
      [
        {
          source: "fresh",
          attempted_at: "2026-11-13T06:00:00.000Z",
          last_good_at: "2026-11-13T06:00:00.000Z",
        },
        // A later failed attempt does not make the facts fresh.
        {
          source: "failing",
          attempted_at: "2026-11-13T06:00:00.000Z",
          last_good_at: "2026-11-11T00:00:00.000Z",
        },
        { source: "never", attempted_at: "2026-11-13T06:00:00.000Z", last_good_at: null },
      ],
      now,
    ).map(({ source, age_hours, stale }) => [source, age_hours, stale]),
    [
      ["fresh", 6, false],
      ["failing", 60, true],
      ["never", null, true],
    ],
  );
  // A verified-only source with nothing served yet is as fresh as its latest attempt.
  assert.deepEqual(
    sourceFreshness(
      [
        {
          source: "definition-delivery",
          attempted_at: "2026-11-13T06:00:00.000Z",
          last_good_at: null,
        },
      ],
      now,
    ).map(({ age_hours, attempt_age_hours, verified_only, stale }) => [
      age_hours,
      attempt_age_hours,
      verified_only,
      stale,
    ]),
    [[null, 6, true, false]],
  );
});

void test("each subject names its assessment inputs, when they last changed and what reassesses it", () => {
  assert.deepEqual(
    subjectReassessment({
      platform: "linux-x86-64",
      assessed_at: "2026-11-10T00:00:00Z",
      verified_at: "2026-11-13T00:00:00Z",
      observations: [
        { source: "catalog-records", observed_at: "2026-11-01T00:00:00Z" },
        { source: "core-port-capabilities-linux-x86-64", observed_at: "2026-11-10T00:00:00Z" },
        // Another host's Core output is never this subject's input.
        { source: "core-port-capabilities-windows-x86-64", observed_at: "2026-11-12T00:00:00Z" },
      ],
    }),
    {
      depends_on: ["catalog-records", "core-port-capabilities-linux-x86-64", "assessment policy"],
      catalog_changed_at: "2026-11-01T00:00:00Z",
      core_output_changed_at: "2026-11-10T00:00:00Z",
      inputs_unchanged_since: "2026-11-10T00:00:00Z",
      last_verified_at: "2026-11-13T00:00:00Z",
    },
  );
  assert.equal(reassessmentTriggers.length, 3);
  // Inputs that returned to an earlier value reuse the older assessment: the
  // latest input change, not the assessment time, bounds "unchanged since".
  assert.equal(
    subjectReassessment({
      platform: "linux-x86-64",
      assessed_at: "2026-11-01T00:00:00Z",
      verified_at: "2026-11-13T00:00:00Z",
      observations: [
        { source: "catalog-records", observed_at: "2026-11-01T00:00:00Z" },
        { source: "core-port-capabilities-linux-x86-64", observed_at: "2026-11-12T00:00:00Z" },
      ],
    }).inputs_unchanged_since,
    "2026-11-12T00:00:00Z",
  );
});
