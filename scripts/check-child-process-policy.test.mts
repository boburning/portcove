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

void test("exact Clap parser constructors do not exempt bare, process or other namespaces", () => {
  const file = "crates/portcove-cli/src/args.rs";
  for (const source of ["clap::Command::new(name)", "clap\n :: \nCommand::new(name)"])
    assert.deepEqual(findDirectChildProcessCalls([[file, source]]), []);
  for (const prefix of ["", "std::process::", "other::", "myclap::", "other::clap::"])
    assert.deepEqual(findDirectChildProcessCalls([[file, `${prefix}Command::new(program)`]]), [
      { path: file, line: 1 },
    ]);
  assert.deepEqual(
    findDirectChildProcessCalls([
      [file, "clap::Command::new(name);\nstd::process::Command::new(program)"],
    ]),
    [{ path: file, line: 2 }],
  );
  for (const [source, line] of [
    ["other:: clap::Command::new(program)", 1],
    ["other ::\n clap :: Command::new(program)", 2],
    ["other::<T>:: clap::Command::new(program)", 1],
    ["other::r#clap::Command::new(program)", 1],
    ["éclap::Command::new(program)", 1],
    ["other:: /* comment */ clap::Command::new(program)", 1],
    ["other:: /* comment ( */ clap::Command::new(program)", 1],
    ["other:: // comment\n clap::Command::new(program)", 2],
    ["/* ambiguous preceding comment */ clap::Command::new(program)", 1],
  ] as const)
    assert.deepEqual(findDirectChildProcessCalls([[file, source]]), [{ path: file, line }]);
});

void test("reviewed extracted subprocess fixtures retain exact paths and denied siblings", () => {
  const fixtures = [
    "crates/portcove-cli/tests/desktop_host_diagnostics.rs",
    "crates/portcove-cli/tests/host_diagnostics.rs",
    "crates/portcove-cli/tests/machine_contract/human_presentation.rs",
    "crates/portcove-cli/tests/machine_contract/preparation.rs",
    "crates/portcove-core/src/definition_publication_connected_tests.rs",
    "crates/portcove-diagnostics/src/writer_tests.rs",
    "crates/portcove-release-tools/tests/tuf_repository/isolated/renewal.rs",
    "crates/portcove-release-tools/tests/tuf_repository/isolated.rs",
    "crates/portcove-release-tools/tests/tuf_repository/offline.rs",
    "apps/desktop/src-tauri/src/application_update_process_environment_tests.rs",
  ];
  for (const file of fixtures) {
    for (const name of [file, file.replaceAll("/", "\\")])
      assert.deepEqual(findDirectChildProcessCalls([[name, "Command::new(owned_fixture)"]]), []);
    const sibling = file.replace(/\.rs$/u, "_other.rs");
    assert.deepEqual(findDirectChildProcessCalls([[sibling, "Command::new(program)"]]), [
      { path: sibling, line: 1 },
    ]);
  }
  const production = "apps/desktop/src-tauri/src/application_update_process_environment.rs";
  assert.deepEqual(
    findDirectChildProcessCalls([[production, "std::process::Command::new(program)"]]),
    [{ path: production, line: 1 }],
  );
});
