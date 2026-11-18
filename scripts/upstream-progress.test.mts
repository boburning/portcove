import assert from "node:assert/strict";
import test from "node:test";
import {
  collectProgress,
  parseProgress,
  progressKey,
  progressCondition,
  progressDisplay,
  validateProgressSources,
  type ProgressSource,
} from "./upstream-progress.mts";
import { boundedDiscoveryRequest } from "./discovery-http.mts";
import { progressCollectionSql, visibleProgress } from "./maintenance-progress.mts";
const source: ProgressSource = {
  repository: "doldecomp/melee",
  game_key: "super-smash-bros-melee",
  version: "GALE01",
  provider: "decompdev",
  evidence_url: "https://decomp.dev/doldecomp/melee",
  methodology: "objdiff matched bytes",
  reconsider: { condition: "matching milestone review", metric: "matching-code", threshold: 100 },
};
const report = (percent: unknown = 99.99997) =>
  JSON.stringify({
    owner: "doldecomp",
    repo: "melee",
    default_version: "GALE01",
    commit: { sha: "a".repeat(40), timestamp: "2026-11-17T00:00:00Z" },
    measures: {
      matched_code_percent: percent,
      matched_code: 99999997,
      total_code: 100000000,
      fuzzy_match_percent: 98.123456,
      complete_code_percent: 97.5,
      complete_code: 97500000,
      matched_functions: "9007199254740993",
      total_functions: "9007199254740994",
    },
  });
void test("progress preserves raw precision, exact edition/commit, separate metrics and counts", () => {
  const row = parseProgress(source, report());
  assert.equal(row.metrics.find((m) => m.kind === "matching-code")?.value, "99.99997");
  assert.equal(
    row.metrics.find((m) => m.kind === "matched-functions")?.numerator,
    "9007199254740993",
  );
  assert.equal(row.metrics.find((m) => m.kind === "fuzzy-similarity")?.value, "98.123456");
  assert.match(
    progressDisplay(row, "2026-11-17T00:00:00Z", new Date("2026-11-17T12:00:00Z")).display,
    /matching-code: 99.99%/u,
  );
  assert.equal(
    progressCondition({
      key: progressKey(source),
      source,
      status: "observed",
      checked_at: "2026-11-17T00:00:00Z",
      record: row,
    })?.met,
    false,
  );
  assert.throws(() => parseProgress({ ...source, version: "GALE02" }, report()), /edition/u);
  assert.throws(
    () => parseProgress({ ...source, repository: "template/other" }, report()),
    /identity/u,
  );
  assert.throws(() => parseProgress(source, report(101)), /range/u);
  assert.throws(() => parseProgress(source, "x".repeat(2 * 1024 * 1024 + 1)), /cap/u);
  assert.notEqual(progressKey(source), progressKey({ ...source, game_key: "different-game" }));
  assert.notEqual(
    progressKey({ ...source, provider: "frogress", measure: "code" }),
    progressKey({ ...source, provider: "frogress", measure: "functions" }),
  );
});
void test("frogress and project-owned reports use reviewed scope without copied badge mapping", () => {
  const f = {
    ...source,
    provider: "frogress" as const,
    project: "melee",
    category: "all",
    measure: "code",
    metric_kind: "matching-code" as const,
  };
  const row = parseProgress(
    f,
    JSON.stringify({
      melee: {
        GALE01: {
          all: [
            {
              timestamp: 1794873600,
              git_hash: "a".repeat(40),
              measures: { code: 123, "code/total": 456 },
            },
          ],
        },
      },
    }),
  );
  assert.equal(row.metrics[0]?.numerator, "123");
  assert.equal(row.metrics[0]?.denominator, "456");
  assert.throws(
    () =>
      parseProgress(
        { ...f, category: "other" },
        JSON.stringify({ melee: { GALE01: { all: [] } } }),
      ),
    /unavailable/u,
  );
  const csv = {
    ...source,
    provider: "project-csv" as const,
    report_url: "https://project.example/report.csv",
    csv: { numerator: 3, denominator: 4, timestamp: 1, commit: 2 },
  };
  assert.equal(parseProgress(csv, `1,1794873600,${"a".repeat(40)},7,10`).metrics[0]?.value, "70");
  const project = {
    ...source,
    provider: "project-report" as const,
    report_url: "https://project.example/report.json",
  };
  assert.equal(parseProgress(project, report()).authority, "research-only");
  assert.throws(
    () => validateProgressSources({ format_version: 1, sources: [{ ...f, measure: undefined }] }),
    /exact reviewed/u,
  );
  assert.throws(
    () => validateProgressSources({ format_version: 1, sources: [source, source] }),
    /Duplicate/u,
  );
});
void test("near100 JSON tokens and large counts never round into completion", () => {
  const text = report().replace("99.99997", "99.999999999999999999");
  const row = parseProgress(source, text);
  assert.equal(row.metrics[0]?.value, "99.999999999999999999");
  assert.equal(
    progressCondition({
      key: progressKey(source),
      source,
      status: "observed",
      checked_at: "2026-11-17T00:00:00Z",
      record: row,
    })?.met,
    false,
  );
  assert.match(progressDisplay(row, "2026-11-17T00:00:00Z").display, /matching-code: 99.99%/u);
  const noCounts = {
    ...row,
    metrics: [
      {
        kind: "matching-code" as const,
        value: "99.999999999999999999",
        numerator: null,
        denominator: null,
      },
    ],
  };
  assert.equal(
    progressCondition({
      key: progressKey(source),
      source,
      status: "observed",
      checked_at: "2026-11-17T00:00:00Z",
      record: noCounts,
    })?.met,
    false,
  );
});
void test("provider failure is isolated and project opt-out suppresses fallback and historical display", async () => {
  const other = { ...source, provider: "bytematch" as const };
  let calls = 0;
  const result = await collectProgress(
    [source, other],
    async (url) => {
      calls++;
      return url.includes("bytematch")
        ? { status: 403, text: "denied" }
        : { status: 200, text: report() };
    },
    new Date("2026-11-17T12:00:00Z"),
  );
  assert.equal(calls, 2);
  assert.deepEqual(
    result.results.map((r) => r.status),
    ["observed", "unavailable"],
  );
  const opted = await collectProgress([{ ...source, opt_out: true }, other], async () => {
    assert.fail("opt-out forbids every fallback read");
  });
  assert.ok(opted.results.every((r) => r.status === "opted-out"));
  assert.deepEqual(
    visibleProgress([
      {
        subject_key: progressKey(source),
        payload: { status: "observed", record: parseProgress(source, report()) },
        checked_at: "2026-11-17T00:00:00Z",
      },
      {
        subject_key: progressKey(other),
        payload: { status: "opted-out", repository: source.repository },
        checked_at: "2026-11-17T00:00:00Z",
      },
    ]),
    [],
  );
  const sql = progressCollectionSql(result, "fixture", 1).join("\n");
  assert.match(sql, /verify_current/u);
  assert.match(sql, /dispatch/u);
  assert.match(sql, /source.*research-progress/u);
  assert.doesNotMatch(sql, /absent_payload|DELETE FROM/u);
});

void test("external progress APIs receive JSON Accept rather than GitHub media type", async () => {
  let accept = "";
  const r = await boundedDiscoveryRequest(
    {
      url: "https://progress.deco.mp/data/project/us/default/",
      method: "GET",
      cap: 1000,
      timeout: 1000,
      maxRequests: 1,
    },
    async (_url, init) => {
      accept = String((init!.headers as Record<string, string>).Accept);
      return new Response("{}", { status: accept.includes("application/json") ? 200 : 406 });
    },
  );
  assert.equal(r.status, 200);
  assert.doesNotMatch(accept, /vnd.github/u);
});

void test("dated report rows expose staleness and reject unsafe optional stored links", () => {
  const row = parseProgress(source, report());
  assert.equal(
    progressDisplay(row, "2026-11-17T00:00:00Z", new Date("2026-11-19T00:00:00Z")).freshness,
    "stale",
  );
  assert.deepEqual(
    visibleProgress([
      {
        subject_key: progressKey(source),
        payload: { status: "observed", record: { ...row, source_url: "javascript:alert(1)" } },
        checked_at: "2026-11-17T00:00:00Z",
      },
    ]),
    [],
  );
  const record = visibleProgress(
    [
      {
        subject_key: progressKey(source),
        payload: { status: "observed", record: row },
        checked_at: "2026-11-17T00:00:00Z",
        latest_attempt: "failed",
        last_attempt_at: "2026-11-18T00:00:00Z",
      },
    ],
    new Date("2026-11-19T00:00:00Z"),
  )[0];
  assert.equal(record?.latest_attempt, "failed");
  assert.equal(record?.freshness, "stale");
});

void test("malformed stored provider and metric objects cannot stall optional report rendering", () => {
  const row = parseProgress(source, report());
  const malformedRecords = [
    { ...row, provider: { toString: null } },
    { ...row, metrics: [{ ...row.metrics[0], kind: { toString: null } }] },
  ];
  for (const malformed of malformedRecords) {
    const record = JSON.parse(JSON.stringify(malformed)) as typeof row;
    assert.deepEqual(
      visibleProgress([
        {
          subject_key: progressKey(source),
          payload: { status: "observed", record },
          checked_at: "2026-11-17T00:00:00Z",
        },
      ]),
      [],
    );
  }
  assert.throws(
    () =>
      validateProgressSources({
        format_version: 1,
        sources: [{ ...source, provider: { toString: null } }],
      }),
    /reviewed project/u,
  );
});
