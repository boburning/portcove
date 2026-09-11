import assert from "node:assert/strict";
import test from "node:test";

import { findDirectChildProcessCalls } from "./check-child-process-policy.mjs";

test("accepts the centralized policy and test harness", () => {
  assert.deepEqual(
    findDirectChildProcessCalls([
      ["crates/portcove-core/src/process.rs", "Command::new(program)"],
      ["crates/portcove-cli/tests/machine_contract.rs", "Command::new(binary)"],
      ["crates/portcove-core/src/adapter.rs", "ChildProcessPolicy::native_command(class, tool)"],
    ]),
    [],
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
