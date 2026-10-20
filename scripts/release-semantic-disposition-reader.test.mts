import assert from "node:assert/strict";
import test from "node:test";
import { negativeSemanticDispositionFixture } from "./fixtures/release-semantic-disposition-fixture.mts";
import { prepareNegativeSemanticDispositionCheck } from "./release-semantic-disposition.mts";
import {
  readIndependentSemanticDisposition,
  discoverIndependentSemanticDisposition,
} from "./release-semantic-disposition-reader.mts";
import {
  semanticReviewCheckName,
  prepareSemanticReviewHandoff,
} from "./release-semantic-review.mts";
import { isRecord } from "./runtime-values.mts";

const config = {
  schema_version: 1,
  review_app_id: 123,
  writer_app_id: 456,
  review_check_name: semanticReviewCheckName,
};
function fixture(stage = "complete-opportunity", mode = "valid") {
  const full = negativeSemanticDispositionFixture();
  const wire =
    stage === "complete-opportunity"
      ? full
      : {
          ...full,
          stage,
          disposition: "refused",
          opportunity: null,
          opportunity_sha256: null,
          review: { ...full.review, scope: "release-classification-proposal", coverage: null },
        };
  const serialized = prepareNegativeSemanticDispositionCheck(wire);
  const check = {
    ...serialized.proposed_request.body,
    id: 99,
    app: { id: config.review_app_id },
    output: { ...serialized.proposed_request.body.output, annotations_count: 0, text: "" },
  };
  const calls: string[] = [];
  let checks = 0;
  return {
    wire: serialized.wire,
    check,
    calls,
    api: {
      request(method: string, endpoint: string) {
        assert.equal(method, "GET");
        calls.push(endpoint);
        let body: Record<string, unknown>;
        if (endpoint === "repos/boburning/portcove")
          body = {
            id: 1354613114,
            full_name: "boburning/portcove",
            node_id: mode === "repository-drift" && calls.length > 1 ? "R_changed" : "R_fixture",
          };
        else {
          assert.equal(endpoint, "repos/boburning/portcove/check-runs/99");
          checks++;
          body = structuredClone(check);
          if (mode === "app") body.app = { id: config.writer_app_id };
          if (mode === "head") body.head_sha = "f".repeat(40);
          if (mode === "success") body.conclusion = "success";
          if (mode === "name") body.name = "caller-selected-check";
          if (mode === "external")
            body.external_id = "portcove-release-review-negative-v1:" + "f".repeat(64);
          if (mode === "future") body.completed_at = "2999-01-01T00:00:00Z";
          assert.ok(isRecord(body.output));
          if (mode === "title") body.output.title = "Portcove independent release review v1";
          if (mode === "annotations") body.output.annotations_count = 1;
          if (mode === "body-drift" && checks > 1)
            body.output.summary = String(body.output.summary) + " ";
          if (mode === "report-tamper") {
            const value: unknown = JSON.parse(String(body.output.summary));
            assert.ok(isRecord(value) && isRecord(value.review));
            value.review.report = "changed report bytes";
            body.output.summary = JSON.stringify(value);
          }
        }
        return { status: 200, headers: new Map<string, string>(), body };
      },
    },
  };
}
void test("fixed GET consumer brackets real-format negative Check and repository for both exact stages", () => {
  for (const stage of ["complete-opportunity", "classification-proposal"]) {
    const f = fixture(stage);
    const read = readIndependentSemanticDisposition(f.api, config, f.wire.request, 99);
    assert.deepEqual(read.wire, f.wire);
    assert.equal(read.authority, "none");
    assert.equal(read.check_run_id, 99);
    assert.equal(read.review_app_id, config.review_app_id);
    assert.equal(f.calls.length, 4);
  }
});
void test("foreign issuer/input, success, malformed report, future time and changed second read refuse without writes", () => {
  for (const mode of [
    "app",
    "head",
    "success",
    "name",
    "external",
    "future",
    "title",
    "annotations",
    "body-drift",
    "report-tamper",
    "repository-drift",
  ]) {
    const f = fixture("complete-opportunity", mode);
    assert.throws(() => readIndependentSemanticDisposition(f.api, config, f.wire.request, 99));
    assert.ok(f.calls.length <= 4);
  }
  const f = fixture();
  for (const bad of [
    { ...config, review_app_id: 15368 },
    { ...config, writer_app_id: config.review_app_id },
    { ...config, review_check_name: "generic" },
  ]) {
    assert.throws(() => readIndependentSemanticDisposition(f.api, bad, f.wire.request, 99));
    assert.equal(f.calls.length, 0);
  }
  assert.throws(() =>
    readIndependentSemanticDisposition(
      f.api,
      config,
      { ...f.wire.request, requested_at: "2026-10-20T00:00:01.000Z" },
      99,
    ),
  );
  assert.equal(f.calls.length, 0);
});

function discoveryFixture(mode = "valid") {
  const f = fixture();
  assert.ok(f.wire.opportunity);
  const acceptedOpportunity =
    mode === "conflict"
      ? f.wire.opportunity
      : {
          ...f.wire.opportunity,
          base_commit: "e".repeat(40),
          classification: { ...f.wire.opportunity.classification, base_version: "0.1.0-alpha.1" },
        };
  const accepted = prepareSemanticReviewHandoff(acceptedOpportunity, {
    accepted_opportunity: acceptedOpportunity,
    scope: "complete-release-opportunity",
    runtime: "codex-independent-local-review",
    session_ref: "fixture:accepted-other-baseline",
    completed_at: f.wire.review.completed_at,
    coverage: { accumulated_changes: true, classification: true, compatibility: true },
    report: "Fixture accepted different published baseline; no runtime authority.",
  });
  let suiteReads = 0;
  const calls: string[] = [];
  const row = (index: number) => ({
    ...f.check,
    ...((index > 0 && mode !== "ambiguous") || mode === "absent"
      ? {
          ...accepted.proposed_request.body,
          output: { ...accepted.proposed_request.body.output, annotations_count: 0, text: "" },
        }
      : {}),
    id: index === 0 ? 99 : 1000 + index,
    conclusion: (index === 0 && mode !== "absent") || mode === "ambiguous" ? "failure" : "success",
    check_suite: { id: 700 },
  });
  return {
    ...f,
    discoveryCalls: calls,
    api: {
      request(method: string, endpoint: string) {
        assert.equal(method, "GET");
        calls.push(endpoint);
        if (endpoint.includes(`/commits/${f.wire.request.source_commit}/check-suites?`)) {
          suiteReads++;
          assert.ok(endpoint.endsWith(`?app_id=${config.review_app_id}&per_page=100&page=1`));
          const suites = [
            {
              id: 700,
              app: { id: mode === "suite-app" ? 456 : config.review_app_id },
              head_sha: f.wire.request.source_commit,
              repository: { id: 1354613114, full_name: "boburning/portcove" },
            },
          ];
          return {
            status: 200,
            headers: new Map<string, string>(),
            body: { total_count: mode === "suite-bound" ? 17 : 1, check_suites: suites },
          };
        }
        if (endpoint.includes("/check-suites/700/check-runs?")) {
          const url = new URL(`https://api.github.com/${endpoint}`);
          assert.equal(url.searchParams.get("filter"), "all");
          assert.equal(url.searchParams.get("check_name"), semanticReviewCheckName);
          const page = Number(url.searchParams.get("page"));
          const total = mode === "ceiling" ? 1000 : 101;
          const rows = Array.from({ length: Math.min(100, total - (page - 1) * 100) }, (_, index) =>
            row((page - 1) * 100 + index),
          );
          if (mode === "duplicate" && page === 2) rows[0] = row(0);
          if (mode === "omitted" && page === 2) rows.pop();
          if (mode === "drift" && suiteReads > 1) rows[0] = { ...rows[0]!, external_id: "changed" };
          return {
            status: 200,
            headers: new Map<string, string>(),
            body: { total_count: total, check_runs: rows },
          };
        }
        return f.api.request(method, endpoint);
      },
    },
  };
}
void test("automatic discovery enumerates complete suites and 101 fixed-App checks before exact bracketed GET", () => {
  const f = discoveryFixture();
  const result = discoverIndependentSemanticDisposition(f.api, config, f.wire.request);
  assert.equal(result.check_run_id, 99);
  assert.deepEqual(result.wire, f.wire);
  assert.equal(
    f.discoveryCalls.filter((endpoint) => endpoint.includes("/check-suites?")).length,
    3,
  );
  assert.equal(
    f.discoveryCalls.filter(
      (endpoint) => endpoint.includes("/check-runs?") && endpoint.endsWith("page=2"),
    ).length,
    3,
  );
});
void test("automatic discovery never chooses missing/duplicate/changed/capped or incomplete check inventory", () => {
  for (const mode of [
    "absent",
    "ambiguous",
    "suite-app",
    "suite-bound",
    "ceiling",
    "duplicate",
    "omitted",
    "drift",
    "conflict",
  ]) {
    const f = discoveryFixture(mode);
    assert.throws(() => discoverIndependentSemanticDisposition(f.api, config, f.wire.request));
    assert.ok(f.discoveryCalls.length <= 14);
  }
});
