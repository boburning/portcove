import { runPythonSuite } from "./python-test-results.mts";
import assert from "node:assert/strict";
import test from "node:test";

void test("fixed public services policy and controlled POSIX transport", (context) => {
  const report = runPythonSuite(
    new URL("../apps/desktop/scripts/native-linux-public-services.test.py", import.meta.url),
    context,
  );
  if (process.platform === "linux")
    assert.ok(
      report.cases.every((item) => item.status !== "skipped"),
      "Linux must execute every platform case",
    );
});
