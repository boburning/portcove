import assert from "node:assert/strict";
import test from "node:test";
import {
  compactHostedReceiptWire,
  expandHostedReceiptWire,
} from "./hosted-discovery-receipt-wire.mts";

const receipt = {
  schema_version: 1,
  plan_encoding: "proposal-bound-v2",
  request_comment: 100,
  plan: [
    {
      body_sha256: "body",
      evidence_sha256: null,
      primary: null,
      candidate_index: 0,
      port_key: "zero",
    },
    {
      body_sha256: "second",
      evidence_sha256: "evidence",
      candidate_index: 1,
      port_key: "one",
      primary: {
        repository_id: 42,
        readme_commit: "commit",
        readme_blob: "blob",
        release_fingerprint: "release",
      },
      location: { declared: "old/game", current: "new/game", repository_id: 42 },
      amendment: { comment: 101, sha256: "amendment" },
    },
  ],
  delivery: [
    { status: "pending", existing: false, hold: { http_status: null, resume: "Retain the hold" } },
    {
      status: "existing",
      existing: true,
      canonical_issue: 123,
      created_comment: 124,
      observation_sha256: "observation",
      fields: { Status: "Done", Priority: "None" },
      doctor: {
        status: "passed",
        coverage: "complete",
        global_health: "not_evaluated",
        issues: [123],
        checked_issue_count: 1,
        receipt_sha256: "proof",
      },
    },
  ],
  audit_pending: true,
  doctor: { status: "incomplete", errors: ["Retain the full audit"] },
  error: { code: "operation_failed", message: "診断" },
};

void test("tuple receipts preserve mixed owner proofs, holds, false and null through JSON", () => {
  const before = structuredClone(receipt);
  const wire = compactHostedReceiptWire(receipt);
  assert.deepEqual(wire.plan[0], [31, "body", null, null, 0, "zero"]);
  assert.deepEqual(expandHostedReceiptWire(JSON.parse(JSON.stringify(wire))), receipt);
  assert.deepEqual(receipt, before);
  assert.equal(expandHostedReceiptWire(receipt), receipt, "legacy objects are not rewritten");
});

void test("unknown object extensions survive compact receipt fallback", () => {
  const extended = structuredClone(receipt);
  Object.assign(extended.plan[1]!.primary!, { future_metadata: { value: null } });
  Object.assign(extended.delivery[1]!.doctor!, { future_proof: false });
  Object.assign(extended.delivery[1]!, { future_delivery: { note: "retain" } });
  const wire = compactHostedReceiptWire(extended);
  assert.ok(!Array.isArray(wire.delivery[1]));
  assert.deepEqual(expandHostedReceiptWire(JSON.parse(JSON.stringify(wire))), extended);
});

void test("tuple receipts reject unknown versions, malformed masks and shifted payloads", () => {
  assert.throws(
    () => expandHostedReceiptWire({ ...receipt, wire_encoding: "tuple-v99" }),
    /encoding/u,
  );
  for (const mask of [-1, 0.5, 128, Number.MAX_SAFE_INTEGER]) {
    const wire = compactHostedReceiptWire(receipt);
    const row = wire.plan[0]!;
    assert.ok(Array.isArray(row));
    row[0] = mask;
    assert.throws(() => expandHostedReceiptWire(wire), /wire mask/u);
  }
  for (const operation of ["missing", "extra"] as const) {
    const wire = compactHostedReceiptWire(receipt);
    const row = wire.plan[0]!;
    assert.ok(Array.isArray(row));
    if (operation === "missing") row.pop();
    else row.push("unexpected");
    assert.throws(() => expandHostedReceiptWire(wire), /wire tuple/u);
  }
  const wire = compactHostedReceiptWire(receipt);
  const row = wire.plan[1]!;
  assert.ok(Array.isArray(row) && Array.isArray(row[3]));
  row[3][0] = 16;
  assert.throws(() => expandHostedReceiptWire(wire), /wire mask/u);
});
