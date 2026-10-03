import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { captureQualificationReport } from "./qualification-report.mjs";

const subprocess = promisify(execFile);
const managed = (portId = "managed-probe", id = "managed-install") => ({
  port_id: portId,
  active: {
    id,
    port_id: portId,
    version: "v1",
    path: "/managed/runtime",
    selected_executable: "game.exe",
    artifact: { sha256: "a".repeat(64) },
  },
  readiness: { launchable: false, summary: "Game files needed" },
  user_data_root: "/managed/saves",
});
const external = (portId = "external-probe", id = "external-registration") => ({
  port_id: portId,
  active: null,
  external_runtime: {
    id,
    port_id: portId,
    version: "v2",
    platform: "linux-x86_64",
    path: "/player/runtime",
    executable: "game.exe",
    archive_sha256: "b".repeat(64),
    immutable_tree_sha256: "c".repeat(64),
    registered_at: 1,
  },
  readiness: { launchable: true, summary: "Ready" },
  // The library's port user directory does not establish external save ownership.
  user_data_root: "/library/user/external-probe",
});

function fixture(t, statuses, overrides = {}) {
  const root = mkdtempSync(path.join(os.tmpdir(), "portcove-report-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const cli = path.join(root, "fixture CLI.bin");
  const library = path.join(root, "library");
  const output = path.join(root, "report");
  mkdirSync(library);
  writeFileSync(cli, "Synthetic CLI identity; response transport is a Node fixture subprocess.\n");
  writeFileSync(path.join(library, "portcove.sqlite3"), "unchanged fixture database\n");
  const data = {
    doctor: { platform: "windows-x86_64" },
    catalog: {
      ports: [
        { id: "managed-probe", name: "Managed control", source_profile: "source-a" },
        {
          id: "external-probe",
          name: "External | control\nname",
          source_profile: "current-unbound-source",
        },
      ],
    },
    status: statuses,
    source: [{ profile_id: "source-a", sha256: "d".repeat(64) }],
    activity: [],
    storage: {},
    backup: [{ id: "retained-backup" }],
    ...overrides,
  };
  const calls = [];
  async function execute(file, args, options) {
    assert.equal(file, cli);
    assert.deepEqual(args.slice(0, 4), ["--library", library, "--json", "--non-interactive"]);
    assert.deepEqual(options, { windowsHide: true, maxBuffer: 8 * 1024 * 1024, timeout: 120_000 });
    const command = args.slice(4);
    calls.push(command);
    assert.ok(Object.hasOwn(data, command[0]), `Unexpected fixture command: ${command}`);
    const envelope = data[command[0]]?.fixture_error ?? { ok: true, data: data[command[0]] };
    // Portable real subprocess transport, with synthetic core responses and no real CLI/game.
    return subprocess(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        "process.stdout.write(process.argv[1]);",
        JSON.stringify(envelope),
      ],
      options,
    );
  }
  return {
    cli,
    library,
    output,
    calls,
    data,
    execute,
    capture: () => captureQualificationReport({ cli, library, output }, execute),
    report: () => JSON.parse(readFileSync(path.join(output, "evidence.json"), "utf8")),
    checklist: () => readFileSync(path.join(output, "checklist.md"), "utf8"),
  };
}

test("direct entry validates required arguments through resolved and aliased paths", async () => {
  const entries = [fileURLToPath(new URL("./qualification-report.mjs", import.meta.url))];
  // Linux procfs supplies an alias without creating symlinks or invoking a real CLI.
  if (process.platform === "linux") entries.push("/proc/self/cwd/scripts/qualification-report.mjs");
  for (const entry of entries)
    await assert.rejects(
      subprocess(process.execPath, [entry], {
        cwd: fileURLToPath(new URL("../", import.meta.url)),
        windowsHide: true,
        timeout: 15_000,
      }),
      (error) => {
        assert.equal(error.code, 1, entry);
        assert.equal(error.stdout, "", entry);
        assert.match(error.stderr, /--cli is required/, entry);
        return true;
      },
    );
});

test("mixed inventory reports exact managed and non-owning facts without inherited observations", async (t) => {
  const f = fixture(t, [managed(), external(), { port_id: "uninstalled", active: null }]);
  const result = await f.capture();
  const report = f.report();
  assert.equal(result.installed_ports, 1);
  assert.equal(result.registered_ports, 1);
  assert.equal(result.reported_ports, 2);
  assert.equal(report.report_format, 1);
  assert.equal(report.cli_sha256, createHash("sha256").update(readFileSync(f.cli)).digest("hex"));
  assert.deepEqual(report.evidence.status.data, f.data.status);
  assert.deepEqual(f.calls, [
    ["doctor"],
    ["catalog", "export"],
    ["status"],
    ["source", "list"],
    ["activity", "--limit", "50"],
    ["storage"],
    ["backup", "list", "managed-probe"],
  ]);
  const [owned, registered] = report.observations;
  assert.deepEqual(
    {
      kind: owned.runtime_kind,
      id: owned.install_id,
      registration: owned.registration_id,
      hash: owned.artifact_sha256,
      version: owned.version,
      platform: owned.platform,
      source: owned.source_profile,
      saves: owned.user_data_root,
      path: owned.runtime_path,
      executable: owned.executable,
    },
    {
      kind: "managed",
      id: "managed-install",
      registration: null,
      hash: "a".repeat(64),
      version: "v1",
      platform: null,
      source: "source-a",
      saves: "/managed/saves",
      path: "/managed/runtime",
      executable: "game.exe",
    },
  );
  assert.deepEqual(
    {
      kind: registered.runtime_kind,
      id: registered.registration_id,
      install: registered.install_id,
      archive: registered.artifact_sha256,
      tree: registered.immutable_tree_sha256,
      version: registered.version,
      platform: registered.platform,
      path: registered.runtime_path,
      executable: registered.executable,
      saves: registered.user_data_root,
      source: registered.source_profile,
    },
    {
      kind: "external",
      id: "external-registration",
      install: null,
      archive: "b".repeat(64),
      tree: "c".repeat(64),
      version: "v2",
      platform: "linux-x86_64",
      path: "/player/runtime",
      executable: "game.exe",
      saves: null,
      source: null,
    },
  );
  for (const item of report.observations) {
    assert.deepEqual(item.manual_observations, {
      gameplay: null,
      audio: null,
      controller: null,
      save_load: null,
    });
    assert.deepEqual(
      item.readiness,
      f.data.status.find((x) => x.port_id === item.port_id).readiness,
    );
  }
  assert.match(
    f.checklist(),
    /Managed control \| Managed install \| v1 \| Needs setup \| Unassessed/,
  );
  assert.match(
    f.checklist(),
    /External   control name \| External registration \| v2 \| Ready \| Unassessed/,
  );
  assert.match(f.checklist(), /Managed installs only: create a backup/);
  assert.equal(
    readFileSync(path.join(f.library, "portcove.sqlite3"), "utf8"),
    "unchanged fixture database\n",
  );
});

test("external-only capture neither reads backups nor offers managed save operations", async (t) => {
  const f = fixture(t, [external()]);
  await f.capture();
  assert.equal(
    f.calls.some((x) => x[0] === "backup"),
    false,
  );
  assert.equal(
    Object.keys(f.report().evidence).some((x) => x.startsWith("backups:")),
    false,
  );
  assert.doesNotMatch(f.checklist(), /create a backup|Managed installs only/);
  assert.match(
    f.checklist(),
    /does not establish their save locations or authorize Portcove backup, restore, replacement or deletion/,
  );
});

test("partial optional facts remain unknown and never inherit current catalog or host facts", async (t) => {
  const f = fixture(t, [
    { port_id: "external-probe", external_runtime: { id: "partial-registration" } },
  ]);
  await f.capture();
  const row = f.report().observations[0];
  assert.equal(row.registration_id, "partial-registration");
  for (const name of [
    "install_id",
    "artifact_sha256",
    "immutable_tree_sha256",
    "version",
    "platform",
    "runtime_path",
    "executable",
    "source_profile",
    "user_data_root",
    "readiness",
  ])
    assert.equal(row[name], null, name);
  assert.match(f.checklist(), /External registration \| Unknown \| Unknown \| Unassessed/);
});

test("retained records missing from the current catalog retain their exact status identities", async (t) => {
  const f = fixture(t, [managed("retained-managed"), external("retained-external")], {
    catalog: { ports: [] },
  });
  await f.capture();
  assert.deepEqual(
    f.report().observations.map((x) => [x.port_id, x.name, x.source_profile]),
    [
      ["retained-managed", "retained-managed", null],
      ["retained-external", "retained-external", null],
    ],
  );
});

test("same ID in distinct managed and registration namespaces is not conflated", async (t) => {
  const f = fixture(t, [
    managed("managed-probe", "same-id"),
    external("external-probe", "same-id"),
  ]);
  await f.capture();
  assert.equal(f.report().observations.length, 2);
});

test("ambiguous or missing identities refuse before output and per-port reads", async (t) => {
  const invalid = [
    ["missing port", [{ active: managed().active }], /Missing port identity/],
    [
      "missing managed ID",
      [{ ...managed(), active: { port_id: "managed-probe" } }],
      /Missing managed record identity/,
    ],
    [
      "missing external ID",
      [{ ...external(), external_runtime: { id: " " } }],
      /Missing external record identity/,
    ],
    ["duplicate port", [managed(), managed()], /Duplicate port identity/],
    [
      "duplicate managed record",
      [managed(), managed("other")],
      /Duplicate managed record identity/,
    ],
    [
      "duplicate registration",
      [external(), external("other")],
      /Duplicate external record identity/,
    ],
    [
      "foreign owner",
      [{ ...external(), external_runtime: { ...external().external_runtime, port_id: "other" } }],
      /owner differs/,
    ],
    [
      "conflicting routes",
      [{ ...managed(), external_runtime: external().external_runtime }],
      /Ambiguous managed and external/,
    ],
  ];
  for (const [label, statuses, expected] of invalid)
    await t.test(label, async (subtest) => {
      const f = fixture(subtest, statuses);
      await assert.rejects(f.capture(), expected);
      assert.equal(existsSync(f.output), false);
      assert.equal(
        f.calls.some((x) => x[0] === "backup"),
        false,
      );
    });
});

test("empty inventory is an empty unassessed capture without managed operations", async (t) => {
  const f = fixture(t, []);
  const result = await f.capture();
  assert.equal(result.reported_ports, 0);
  assert.deepEqual(f.report().observations, []);
  assert.doesNotMatch(f.checklist(), /create a backup/);
});

test("failed core capture never publishes a partial report", async (t) => {
  const f = fixture(t, [external()], {
    status: { fixture_error: { ok: false, error: { message: "Snapshot unavailable" } } },
  });
  await assert.rejects(f.capture(), /status: Snapshot unavailable/);
  assert.equal(existsSync(f.output), false);
  assert.deepEqual(f.calls, [["doctor"], ["catalog", "export"], ["status"]]);
});

test("an existing capture directory is preserved", async (t) => {
  const f = fixture(t, [external()]);
  mkdirSync(f.output);
  writeFileSync(path.join(f.output, "evidence.json"), "previous evidence\n");
  await assert.rejects(f.capture(), { code: "EEXIST" });
  assert.equal(readFileSync(path.join(f.output, "evidence.json"), "utf8"), "previous evidence\n");
  assert.equal(existsSync(path.join(f.output, "checklist.md")), false);
});
