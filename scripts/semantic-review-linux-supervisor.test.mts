import { runPythonSuite } from "./python-test-results.mts";
import assert from "node:assert/strict";
import test from "node:test";
import { inspectLinuxQualificationConfiguration } from "./qualify-semantic-linux.mts";

void test("Linux supervisor inert models run without namespace, provider, credential or native operations", (context) => {
  runPythonSuite(
    new URL("./semantic-review-linux-supervisor.test.py", import.meta.url),
    context,
    30000,
  );
});

void test("qualification configuration cannot select auth, reviewer mode, command or another backend", () => {
  const config = {
    schema_version: 1,
    output_parent: "/home/reviewer/q",
    node_executable: "/opt/node",
    codex_executable: "/opt/codex",
    node_sha256: "a".repeat(64),
    codex_sha256: "b".repeat(64),
    supervisor_sha256: "c".repeat(64),
    tools_sha256: {
      python: "d".repeat(64),
      bwrap: "e".repeat(64),
      systemd_run: "f".repeat(64),
      systemctl: "0".repeat(64),
    },
  };
  assert.equal(inspectLinuxQualificationConfiguration(config).output_parent, "/home/reviewer/q");
  for (const extra of [
    { auth_cache: "/home/reviewer/auth.json" },
    { mode: "codex" },
    { command: "sh" },
    { backend: "other" },
  ])
    assert.throws(() => inspectLinuxQualificationConfiguration({ ...config, ...extra }));
  assert.throws(() =>
    inspectLinuxQualificationConfiguration({ ...config, output_parent: "/home/../foreign" }),
  );
});
