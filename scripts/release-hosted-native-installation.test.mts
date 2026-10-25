import assert from "node:assert/strict";
import test from "node:test";
import { prepareActualHostedLinuxInstallation } from "./release-hosted-native-installation.mts";
import { runPythonSuite } from "./python-test-results.mts";

void test("imported installation parent/tool data cannot start a host operation", async () => {
  await assert.rejects(
    prepareActualHostedLinuxInstallation(
      { kind: "hosted-native-parent-source", authority: "none" },
      { kind: "verified-controller-tools" },
      { kind: "hosted-native-runtime" },
    ),
    /original active hosted native parent/u,
  );
});

void test("Linux materialization graph, source/parent and refusal contracts", (context) => {
  runPythonSuite(
    new URL("./prepare-hosted-native-linux-installation.test.py", import.meta.url),
    context,
    30000,
  );
});
