import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { inspectLinuxQualificationConfiguration } from "./qualify-semantic-linux.mts";

void test("Linux supervisor inert models run without namespace, provider, credential or native operations", () => {
  const result = execFileSync(
    process.platform === "win32" ? "python" : "python3",
    [
      "-I",
      "-S",
      "-B",
      fileURLToPath(new URL("./semantic-review-linux-supervisor.test.py", import.meta.url)),
    ],
    {
      encoding: "utf8",
      windowsHide: true,
      timeout: 30000,
      maxBuffer: 65536,
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  assert.equal(result, "");
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
