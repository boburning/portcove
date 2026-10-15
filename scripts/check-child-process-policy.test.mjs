import assert from "node:assert/strict";
import test from "node:test";

import { findDirectChildProcessCalls } from "./check-child-process-policy.mjs";

test("accepts the centralized policy and test harness", () => {
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

test("test-like names do not grant general direct-spawn authority", () => {
  assert.equal(
    findDirectChildProcessCalls([
      ["crates/portcove-core/src/tool_process/other_tests.rs", "Command::new(program)"],
    ]).length,
    1,
  );
});

test("reports a production bypass with its source line", () => {
  assert.deepEqual(
    findDirectChildProcessCalls([
      ["apps/desktop/src-tauri/src/lib.rs", "fn launch() {\n  Command::new(game);\n}"],
    ]),
    [{ path: "apps/desktop/src-tauri/src/lib.rs", line: 2 }],
  );
});
