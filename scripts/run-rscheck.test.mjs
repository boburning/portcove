import assert from "node:assert/strict";
import test from "node:test";

import { assessRscheckReport } from "./run-rscheck.mjs";

test("separates advisory findings from hard policy failures", () => {
  const assessment = assessRscheckReport({
    findings: [
      { severity: "warn", rule_id: "shape.file_complexity" },
      { severity: "deny", rule_id: "portability.absolute_literal_paths" },
    ],
  });
  assert.equal(assessment.warnings.length, 1);
  assert.equal(assessment.denies.length, 1);
});
