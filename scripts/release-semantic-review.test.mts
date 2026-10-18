import assert from "node:assert/strict";
import test from "node:test";
import { isRecord } from "./runtime-values.mts";
import {
  prepareSemanticReviewHandoff,
  semanticReviewCheckName,
} from "./release-semantic-review.mts";
const opportunity = {
  source_commit: "a".repeat(40),
  source_tree: "b".repeat(40),
  base_commit: "c".repeat(40),
  change_set_sha256: "d".repeat(64),
  complete_change_set: true,
  meaningful: true,
  documentation_only: false,
  urgency: false,
  requested_channel: "preview",
  classification: {
    source_commit: "a".repeat(40),
    reviewed_commit: "a".repeat(40),
    source_tree: "b".repeat(40),
    reviewed_tree: "b".repeat(40),
    change_set_sha256: "d".repeat(64),
    change_set_scope: "portcove-release-net-tree-delta-v1",
    base_version: "0.1.0-alpha.2",
    change: "prerelease",
    compatibility: "compatible",
  },
};
function review() {
  return {
    scope: "complete-release-opportunity",
    runtime: "codex-independent-local-review",
    session_ref: "fixture:independent-task",
    completed_at: "2026-01-01T00:00:00Z",
    coverage: { accumulated_changes: true, classification: true, compatibility: true },
    accepted_opportunity: structuredClone(opportunity),
    report: "Fixture whole-opportunity review; not production authority.",
  };
}
void test("handoff serializes the existing whole-opportunity consumer wire without posting or granting authority", () => {
  const record = review(),
    result = prepareSemanticReviewHandoff(opportunity, record);
  assert.equal(result.authority, "none");
  assert.equal(result.proposed_request.endpoint, "repos/boburning/portcove/check-runs");
  assert.equal(result.proposed_request.body.name, semanticReviewCheckName);
  const summary: unknown = JSON.parse(result.proposed_request.body.output.summary);
  assert.ok(isRecord(summary));
  assert.deepEqual(Object.keys(summary).sort(), [
    "opportunity",
    "opportunity_sha256",
    "review",
    "schema_version",
  ]);
  assert.deepEqual(summary.opportunity, opportunity);
  assert.equal(result.evidence.report, record.report);
  assert.match(result.evidence.report_sha256, /^[a-f0-9]{64}$/u);
  record.report = "changed";
  assert.notEqual(result.evidence.report, record.report);
});
void test("implementation-only clearance cannot be relabelled as full release acceptance", () => {
  assert.throws(
    () => prepareSemanticReviewHandoff(opportunity, { ...review(), scope: "implementation-pr" }),
    /implementation review/,
  );
  for (const key of ["accumulated_changes", "classification", "compatibility"]) {
    const record = review();
    Object.assign(record.coverage, { [key]: false });
    assert.throws(() => prepareSemanticReviewHandoff(opportunity, record), /omitted/);
  }
});
void test("changed reviewed inputs, incomplete evidence and opaque net-delta scope refuse before handoff", () => {
  const record = review();
  record.accepted_opportunity.urgency = true;
  assert.throws(() => prepareSemanticReviewHandoff(opportunity, record), /different exact inputs/);
  assert.throws(
    () => prepareSemanticReviewHandoff({ ...opportunity, complete_change_set: false }, review()),
    /complete accumulated/,
  );
  assert.throws(
    () =>
      prepareSemanticReviewHandoff(
        {
          ...opportunity,
          classification: { ...opportunity.classification, change_set_scope: "opaque" },
        },
        review(),
      ),
    /versioned/,
  );
  assert.throws(() => prepareSemanticReviewHandoff(opportunity, { ...review(), report: "" }));
  for (const completed_at of ["2026-01-01T00:00:00.123Z", "2026-02-30T00:00:00Z"])
    assert.throws(() => prepareSemanticReviewHandoff(opportunity, { ...review(), completed_at }));
  assert.throws(() =>
    prepareSemanticReviewHandoff(opportunity, { ...review(), report: "界".repeat(20000) }),
  );
});
