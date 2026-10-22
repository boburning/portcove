import assert from "node:assert/strict";
import test from "node:test";

import { findDirectChildProcessCalls } from "./check-child-process-policy.mts";

void test("accepts the centralized policy and test harness", () => {
  assert.deepEqual(
    findDirectChildProcessCalls([
      ["crates/portcove-core/src/process.rs", "Command::new(program)"],
      ["crates/portcove-cli/tests/machine_contract.rs", "Command::new(binary)"],
      ["crates/portcove-cli/tests/machine_contract/source_discovery.rs", "Command::new(binary)"],
      ["crates/portcove-core/src/tool_process/linux_tests.rs", "Command::new(fixture)"],
      ["crates/portcove-core/src/adapter.rs", "ChildProcessPolicy::native_command(class, tool)"],
    ]),
    [],
  );
});

void test("test-like names do not grant general direct-spawn authority", () => {
  assert.equal(
    findDirectChildProcessCalls([
      ["crates/portcove-core/src/tool_process/other_tests.rs", "Command::new(program)"],
    ]).length,
    1,
  );
});

void test("only the exact runtime writer lease fixture may spawn its independent test process", () => {
  const fixture = "apps/desktop/src-tauri/src/diagnostics_writer_tests.rs";
  assert.deepEqual(findDirectChildProcessCalls([[fixture, "Command::new(owned_test_binary)"]]), []);
  assert.deepEqual(
    findDirectChildProcessCalls([
      [fixture.replaceAll("/", "\\"), "Command::new(owned_test_binary)"],
    ]),
    [],
  );
  const denied = [
    "apps/desktop/src-tauri/src/diagnostics_writer.rs",
    "apps/desktop/src-tauri/src/diagnostics_writer_other_tests.rs",
    "apps/desktop/src-tauri/src/diagnostics_events_tests.rs",
    "crates/portcove-cli/tests/diagnostics_writer_tests.rs",
    "crates/portcove-cli/tests/runtime_diagnostics.rs",
  ];
  assert.deepEqual(
    findDirectChildProcessCalls(denied.map((file) => [file, "Command::new(program)"] as const)),
    denied.map((file) => ({ path: file, line: 1 })),
  );
  assert.deepEqual(
    findDirectChildProcessCalls([
      [
        "crates/portcove-cli/tests/runtime_diagnostics.rs",
        "ChildProcessPolicy::native_command(ChildProcessClass::HostIntegration, cli_binary())",
      ],
    ]),
    [],
  );
});

void test("reports direct constructor spelling with its source line", () => {
  assert.deepEqual(
    findDirectChildProcessCalls([
      ["apps/desktop/src-tauri/src/lib.rs", "fn launch() {\n  Command::new(game);\n}"],
    ]),
    [{ path: "apps/desktop/src-tauri/src/lib.rs", line: 2 }],
  );
});

void test("checks multiline spelling while documenting aliases and comment limitations", () => {
  const file = "crates/portcove-core/src/adapter.rs";
  assert.deepEqual(findDirectChildProcessCalls([[file, "Command\n :: new\n (program)"]]), [
    { path: file, line: 1 },
  ]);
  assert.deepEqual(
    findDirectChildProcessCalls([
      [file, "use std::process::Command as Process;\nProcess::new(program)"],
    ]),
    [],
  );
  assert.deepEqual(findDirectChildProcessCalls([[file, "// Command::new(program)"]]), [
    { path: file, line: 1 },
  ]);
});
