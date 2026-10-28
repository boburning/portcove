import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { TestContext } from "node:test";
import { isRecord } from "./runtime-values.mts";
import type { QualificationTransport } from "./qualification-report.mts";
import test, { describe } from "node:test";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { captureQualificationReport } from "./qualification-report.mts";

function requiredFixture<T>(value: T | undefined): T {
  assert.notEqual(value, undefined, "Required fixture value is missing");
  if (value === undefined) throw new Error("Required fixture value is missing");
  return value;
}
function readReport(file: string) {
  const report: unknown = JSON.parse(readFileSync(file, "utf8"));
  assert.ok(isRecord(report) && Array.isArray(report.observations) && isRecord(report.evidence));
  const rawObservations: unknown[] = report.observations;
  const observations = rawObservations.map((value) => {
    assert.ok(isRecord(value));
    return value;
  });
  const evidence: Record<string, Record<string, unknown>> = {};
  for (const [key, value] of Object.entries(report.evidence)) {
    assert.ok(isRecord(value));
    evidence[key] = value;
  }
  return {
    report_format: report.report_format,
    cli_sha256: report.cli_sha256,
    observations,
    evidence,
  };
}

const script = fileURLToPath(new URL("./windows-qualification-session.ps1", import.meta.url));
const installerLifecycleTool = fileURLToPath(
  new URL("./test-windows-installer.ps1", import.meta.url),
);

void test("installer lifecycle journals every required process before spawning it", () => {
  const source = readFileSync(installerLifecycleTool, "utf8");
  for (const role of [
    "predecessor_installer",
    "predecessor_smoke",
    "candidate_installer",
    "candidate_smoke",
    "candidate_uninstaller",
  ])
    assert.match(source, new RegExp(`"${role}"`));
  const pending = source.indexOf('status = "launch_pending"');
  const write = source.indexOf("Write-InstallerEvidence $evidence.phase", pending);
  const spawnIndex = source.indexOf("Start-Process -FilePath $exact", pending);
  assert.ok(pending >= 0 && write > pending && spawnIndex > write);
  for (const field of [
    "executable_path",
    "executable_sha256",
    "pid",
    "start_time_filetime",
    "exit_observation",
  ])
    assert.match(source, new RegExp(field));
  assert.match(source, /AllowedRelocationRoot/);
  assert.match(source, /process relocated outside its owned temporary root/);
  assert.match(source, /process bytes do not match its write-ahead record/);
  assert.match(source, /retained handle does not identify the exact requested launch path/);
  assert.match(source, /stable executable image path could not be observed/);
  assert.match(source, /Process exited before a stable executable image path was observable/);
  assert.match(source, /-Role "predecessor_installer".*-AllowedRelocationRoot \$runRoot/);
  assert.match(source, /-Role "candidate_installer".*-AllowedRelocationRoot \$runRoot/);
  assert.match(source, /-Role "candidate_uninstaller".*-AllowedRelocationRoot \$runRoot/);
  assert.match(source, /RetainedLibraryRoot must be an isolated sibling below the TestBase parent/);
  assert.match(source, /RetainedLibraryRoot must be empty before qualification/);
  assert.match(source, /\[switch\]\$RequireSigningAuthorityAbsent/);
  assert.match(source, /private_signing_inputs_absent/);
  assert.match(source, /TAURI_SIGNING_PRIVATE_KEY_PATH/);
  assert.match(
    source,
    /Disposable signing authority is available to the Windows package lifecycle/,
  );
  const authorityCheck = source.indexOf('Write-InstallerEvidence "signing_authority_checked"');
  const firstSpawn = source.indexOf("Start-Process -FilePath $exact");
  assert.ok(
    authorityCheck >= 0 && firstSpawn > authorityCheck,
    "signing authority must be checked and journaled before the first process spawn",
  );
  assert.match(
    source,
    /\$requested\.Equals\(\$base, \[System\.StringComparison\]::OrdinalIgnoreCase\)/,
  );
  assert.match(
    readFileSync(script, "utf8"),
    /RetainedLibraryRoot = Resolve-ContainedPath \$root \$session\.paths\.library "Directory"/,
  );
  assert.match(
    readFileSync(script, "utf8"),
    /Abort retained handle does not identify the journaled launch path/,
  );
  assert.match(readFileSync(script, "utf8"), /Cannot observe a stable abort executable image path/);
});

void test("installer lifecycle waits for managed files and uninstall registration to disappear", () => {
  const source = readFileSync(installerLifecycleTool, "utf8");
  const uninstall = source.indexOf('Invoke-JournaledProcess -Role "candidate_uninstaller"');
  const wait = source.indexOf(
    "$deadline = (Get-Date).AddSeconds($CleanupTimeoutSeconds)",
    uninstall,
  );
  const registryCheck = source.indexOf(
    "$remainingRegistryEntries = @(Get-UninstallEntries $installRoot)",
    wait,
  );
  const waitEnd = source.indexOf("} while ((Get-Date) -lt $deadline)", registryCheck);
  assert.ok(uninstall >= 0 && wait > uninstall && registryCheck > wait && waitEnd > registryCheck);
  assert.match(
    source.slice(wait, waitEnd),
    /if \(-not \$managedFilesRemain -and \$remainingRegistryEntries\.Count -eq 0\)/,
  );
  assert.match(source, /\$deadline = \[DateTime\]::UtcNow\.AddSeconds\(\$ProcessTimeoutSeconds\)/);
  assert.match(source, /WaitForExit\(\$remaining\)/);
  assert.match(
    source,
    /Wait-JournaledUninstallerChild \$launch\.run \$AllowedRelocationRoot \$deadline/,
  );
  const childWait = source.indexOf("function Wait-JournaledUninstallerChild");
  const childWaitEnd = source.indexOf("\nfunction ", childWait + 1);
  assert.ok(childWait >= 0 && childWaitEnd > childWait);
  const childWaitSource = source.slice(childWait, childWaitEnd);
  assert.match(
    childWaitSource,
    /\$initialHasExited = \$process\.HasExited\s+if \(\$initialHasExited\) \{ continue \}/,
  );
  assert.match(
    childWaitSource,
    /\$observation = Read-UninstallerChildImage \$process \$child \$Deadline\s+if \(\$observation\.exited\) \{ continue \}/,
  );
  assert.match(
    childWaitSource,
    /if \(\[string\]::IsNullOrWhiteSpace\(\$observedPath\) -or\s+\[string\]::IsNullOrWhiteSpace\(\[string\]\$child\.ExecutablePath\)\) \{[\s\S]*?\$refusalHasExited = \$process\.HasExited\s+if \(\$refusalHasExited\) \{ continue \}[\s\S]*?throw "Uninstaller child executable image path could not be observed"/,
  );
  assert.match(source, /Uninstaller child executable image path could not be observed/);
  assert.match(source, /\$ProcessIdentityClockToleranceMilliseconds = 1000/);
  const ownershipFilter = source.indexOf("$cimPath = [string]$child.ExecutablePath", childWait);
  const identityCheck = source.indexOf(
    "Owned uninstaller child process identity changed before observation",
    childWait,
  );
  assert.ok(childWait >= 0 && ownershipFilter > childWait && identityCheck > ownershipFilter);
  assert.match(source, /Stop-JournaledProcess \$launch\.run \$launch\.process "timed_out"/);
  const start = source.indexOf("function Start-JournaledProcess");
  const spawn = source.indexOf("$process = Start-Process", start);
  const verificationGuard = source.indexOf("    try {", spawn);
  const verificationCatch = source.indexOf("    } catch {", verificationGuard);
  const cleanup = source.indexOf(
    'Stop-JournaledProcess $run $process "verification_failed"',
    verificationCatch,
  );
  const invoke = source.indexOf("function Invoke-JournaledProcess", start);
  assert.ok(
    start >= 0 &&
      spawn > start &&
      verificationGuard > spawn &&
      verificationCatch > verificationGuard &&
      cleanup > verificationCatch &&
      invoke > cleanup,
  );
});

void describe("qualification report evidence preparation", () => {
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

  function fixture<Status>(
    t: TestContext,
    statuses: Status[],
    overrides: Record<string, unknown> = {},
  ) {
    const root = mkdtempSync(path.join(os.tmpdir(), "portcove-report-"));
    t.after(() => rmSync(root, { recursive: true, force: true }));
    const cli = path.join(root, "fixture CLI.bin");
    const library = path.join(root, "library");
    const output = path.join(root, "report");
    mkdirSync(library);
    writeFileSync(
      cli,
      "Synthetic CLI identity; response transport is a Node fixture subprocess.\n",
    );
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
    const calls: string[][] = [];
    const wireData: Record<string, unknown> = data;
    const execute: QualificationTransport = async (file, args, options) => {
      assert.equal(file, cli);
      assert.deepEqual(args.slice(0, 4), ["--library", library, "--json", "--non-interactive"]);
      assert.deepEqual(options, {
        windowsHide: true,
        maxBuffer: 8 * 1024 * 1024,
        timeout: 120_000,
      });
      const command = args.slice(4);
      calls.push(command);
      assert.ok(
        Object.hasOwn(wireData, requiredFixture(command[0])),
        `Unexpected fixture command: ${command.join(" ")}`,
      );
      const value = wireData[requiredFixture(command[0])];
      const envelope = (isRecord(value) ? value.fixture_error : undefined) ?? {
        ok: true,
        data: value,
      };
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
    };
    return {
      cli,
      library,
      output,
      calls,
      data,
      execute,
      capture: (transport: QualificationTransport = execute) =>
        captureQualificationReport({ cli, library, output }, transport),
      report: () => readReport(path.join(output, "evidence.json")),
      checklist: () => readFileSync(path.join(output, "checklist.md"), "utf8"),
    };
  }

  void test("missing or nonregular report inputs explain the initialized-library remedy before capture", async (t) => {
    for (const missing of ["cli", "library", "database"] as const) {
      const f = fixture(t, []);
      const input = missing === "database" ? path.join(f.library, "portcove.sqlite3") : f[missing];
      rmSync(input, { recursive: true });
      let executions = 0;
      await assert.rejects(
        f.capture(async () => {
          executions++;
          return { stdout: "{}" };
        }),
        (error: unknown) => {
          assert.ok(error instanceof Error);
          assert.match(
            error.message,
            /existing Portcove CLI executable verified for this session and an initialized test library containing portcove.sqlite3/u,
          );
          assert.ok(error.message.includes(JSON.stringify(f.cli)));
          assert.ok(error.message.includes(JSON.stringify(f.library)));
          assert.ok(error.cause instanceof Error && "code" in error.cause);
          assert.equal(error.cause.code, "ENOENT");
          return true;
        },
      );
      assert.equal(executions, 0);
      assert.equal(existsSync(f.output), false);
    }
    const f = fixture(t, []);
    rmSync(f.cli);
    mkdirSync(f.cli);
    await assert.rejects(f.capture(), /Provide an existing Portcove CLI executable/u);
    assert.equal(existsSync(f.output), false);
  });

  void test("unsupported report formats explain the mismatch without replacing known CLI failures", async (t) => {
    const f = fixture(t, []);
    for (const stdout of ["not json", "[]", "{}", '{"ok":"true"}', '{"ok":false}']) {
      await assert.rejects(
        f.capture(async () => ({ stdout })),
        /report format this tool does not support \(doctor:/u,
      );
      assert.equal(existsSync(f.output), false);
    }
    for (const status of [null, [null], [{ port_id: "fixture", active: [] }]]) {
      await assert.rejects(
        f.capture(async (_cli, args) => ({
          stdout: JSON.stringify({
            ok: true,
            data: args[4] === "catalog" ? { ports: [] } : args[4] === "status" ? status : {},
          }),
        })),
        /report format this tool does not support/u,
      );
      assert.equal(existsSync(f.output), false);
    }
    await assert.rejects(
      f.capture(async () => ({
        stdout: JSON.stringify({ ok: false, error: { message: "Snapshot unavailable" } }),
      })),
      /^Error: doctor: Snapshot unavailable$/u,
    );
    const processFailure = new Error("CLI process exited with code 7");
    await assert.rejects(
      f.capture(async () => {
        throw processFailure;
      }),
      (error: unknown) => error === processFailure,
    );
    assert.equal(existsSync(f.output), false);
    assert.equal(
      readFileSync(path.join(f.library, "portcove.sqlite3"), "utf8"),
      "unchanged fixture database\n",
    );
  });

  void test("direct entry validates required arguments through resolved and aliased paths", async () => {
    const entries = [fileURLToPath(new URL("./qualification-report.mts", import.meta.url))];
    // Linux procfs supplies an alias without creating symlinks or invoking a real CLI.
    if (process.platform === "linux")
      entries.push("/proc/self/cwd/scripts/qualification-report.mts");
    for (const entry of entries)
      await assert.rejects(
        subprocess(process.execPath, [entry], {
          cwd: fileURLToPath(new URL("../", import.meta.url)),
          windowsHide: true,
          timeout: 15_000,
        }),
        (error) => {
          assert.ok(isRecord(error));
          assert.equal(error.code, 1, entry);
          assert.equal(error.stdout, "", entry);
          assert.equal(typeof error.stderr, "string");
          assert.match(String(error.stderr), /--cli is required/, entry);
          return true;
        },
      );
  });

  void test("mixed inventory reports exact managed and non-owning facts without inherited observations", async (t) => {
    const f = fixture(t, [managed(), external(), { port_id: "uninstalled", active: null }]);
    const result = await f.capture();
    const report = f.report();
    assert.equal(result.installed_ports, 1);
    assert.equal(result.registered_ports, 1);
    assert.equal(result.reported_ports, 2);
    assert.equal(report.report_format, 1);
    assert.equal(report.cli_sha256, createHash("sha256").update(readFileSync(f.cli)).digest("hex"));
    assert.deepEqual(requiredFixture(report.evidence.status).data, f.data.status);
    assert.deepEqual(f.calls, [
      ["doctor"],
      ["catalog", "export"],
      ["status"],
      ["source", "list"],
      ["activity", "--limit", "50"],
      ["storage"],
      ["backup", "list", "managed-probe"],
    ]);
    const owned = requiredFixture(report.observations[0]);
    const registered = requiredFixture(report.observations[1]);
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
        source: null,
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
        ((status) => ("readiness" in status ? status.readiness : undefined))(
          requiredFixture(f.data.status.find((x) => x.port_id === item.port_id)),
        ),
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

  void test("external-only capture neither reads backups nor offers managed save operations", async (t) => {
    const f = fixture(t, [external()]);
    await f.capture();
    assert.equal(
      f.calls.some((x) => x[0] === "backup"),
      false,
    );
    assert.equal(
      Object.keys(f.report().evidence).some((x: string) => x.startsWith("backups:")),
      false,
    );
    assert.doesNotMatch(f.checklist(), /create a backup|Managed installs only/);
    assert.match(
      f.checklist(),
      /does not establish their save locations or authorize Portcove backup, restore, replacement or deletion/,
    );
  });

  void test("catalog source corrections are declarations, not retained runtime source evidence", async (t) => {
    for (const kind of [managed, external]) {
      const status = kind();
      for (const source of ["source-before", "source-after", null]) {
        const catalog = {
          ports:
            source == null
              ? []
              : [{ id: status.port_id, name: "Current name", source_profile: source }],
        };
        const f = fixture(t, [status], { catalog });
        await f.capture();
        const report = f.report();
        const row = requiredFixture(report.observations[0]);
        assert.equal(row.source_profile, null);
        assert.equal(row.catalog_source_profile, source);
        assert.deepEqual(requiredFixture(report.evidence.status).data, [status]);
        assert.deepEqual(requiredFixture(report.evidence.catalog).data, catalog);
        assert.deepEqual(requiredFixture(report.evidence.sources).data, f.data.source);
        assert.equal(
          row.version,
          status.active?.version ??
            ("external_runtime" in status ? status.external_runtime.version : undefined),
        );
        assert.equal(
          row.install_id ?? row.registration_id,
          status.active?.id ??
            ("external_runtime" in status ? status.external_runtime.id : undefined),
        );
      }
    }
  });

  void test("partial optional facts remain unknown and never inherit current catalog or host facts", async (t) => {
    const f = fixture(t, [
      { port_id: "external-probe", external_runtime: { id: "partial-registration" } },
    ]);
    await f.capture();
    const row = requiredFixture(f.report().observations[0]);
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

  void test("retained records missing from the current catalog retain their exact status identities", async (t) => {
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

  void test("same ID in distinct managed and registration namespaces is not conflated", async (t) => {
    const f = fixture(t, [
      managed("managed-probe", "same-id"),
      external("external-probe", "same-id"),
    ]);
    await f.capture();
    assert.equal(f.report().observations.length, 2);
  });

  void test("ambiguous or missing identities refuse before output and per-port reads", async (t) => {
    const invalid: [string, unknown[], RegExp][] = [
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

  void test("empty inventory is an empty unassessed capture without managed operations", async (t) => {
    const f = fixture(t, []);
    const result = await f.capture();
    assert.equal(result.reported_ports, 0);
    assert.deepEqual(f.report().observations, []);
    assert.doesNotMatch(f.checklist(), /create a backup/);
  });

  void test("failed core capture never publishes a partial report", async (t) => {
    const f = fixture(t, [external()], {
      status: { fixture_error: { ok: false, error: { message: "Snapshot unavailable" } } },
    });
    await assert.rejects(f.capture(), /status: Snapshot unavailable/);
    assert.equal(existsSync(f.output), false);
    assert.deepEqual(f.calls, [["doctor"], ["catalog", "export"], ["status"]]);
  });

  void test("malformed success envelopes refuse before publication or later commands", async (t) => {
    for (const ok of [1, "true", {}, [], false, null]) {
      const f = fixture(t, [external()]);
      await assert.rejects(
        f.capture(async (...args) => {
          const response = await f.execute(...args);
          return args[1][4] === "doctor"
            ? { stdout: JSON.stringify({ ok, data: f.data.doctor }) }
            : response;
        }),
        /doctor:/,
      );
      assert.deepEqual(f.calls, [["doctor"]]);
      assert.equal(existsSync(f.output), false);
    }
  });

  void test("changed CLI bytes after a snapshot refuse further capture and publication", async (t) => {
    const f = fixture(t, [managed(), external()]);
    await assert.rejects(
      f.capture(async (...args) => {
        const result = await f.execute(...args);
        writeFileSync(f.cli, "replacement synthetic CLI bytes\n");
        return result;
      }),
      /Selected CLI identity changed/,
    );
    assert.deepEqual(f.calls, [["doctor"]]);
    assert.equal(existsSync(f.output), false);
  });

  for (const replacement of ["directory", "missing"]) {
    void test(`${replacement} CLI after a snapshot refuses further capture and publication`, async (t) => {
      const f = fixture(t, [external()]);
      await assert.rejects(
        f.capture(async (...args) => {
          const result = await f.execute(...args);
          rmSync(f.cli);
          if (replacement === "directory") mkdirSync(f.cli);
          return result;
        }),
        (error) => {
          assert.ok(error instanceof Error && isRecord(error.cause));
          assert.match(error.message, /Selected CLI identity changed/);
          if (replacement === "missing") assert.equal(error.cause.code, "ENOENT");
          else {
            assert.equal(typeof error.cause.message, "string");
            assert.match(String(error.cause.message), /not a regular file/);
          }
          return true;
        },
      );
      assert.deepEqual(f.calls, [["doctor"]]);
      assert.equal(existsSync(f.output), false);
    });
  }

  void test("CLI drift during the last managed backup refuses report publication", async (t) => {
    const f = fixture(t, [managed(), external()]);
    await assert.rejects(
      f.capture(async (...args) => {
        const result = await f.execute(...args);
        if (args[1][4] === "backup") writeFileSync(f.cli, "changed final backup CLI\n");
        return result;
      }),
      /Selected CLI identity changed/,
    );
    assert.equal(f.calls.length, 7);
    assert.deepEqual(f.calls.at(-1), ["backup", "list", "managed-probe"]);
    assert.equal(f.calls.filter(([command]) => command === "backup").length, 1);
    assert.equal(existsSync(f.output), false);
  });

  void test("unchanged CLI preserves the exact original transport failure", async (t) => {
    const f = fixture(t, [external()]);
    const original = new Error("Owned fixture transport failed");
    await assert.rejects(
      f.capture(async (...args) => {
        await f.execute(...args);
        throw original;
      }),
      (error) => error === original,
    );
    assert.deepEqual(f.calls, [["doctor"]]);
    assert.equal(existsSync(f.output), false);
  });

  void test("transport failure and CLI drift retain both actual errors", async (t) => {
    const f = fixture(t, [external()]);
    const original = new Error("Owned fixture transport failed");
    await assert.rejects(
      f.capture(async (...args) => {
        await f.execute(...args);
        writeFileSync(f.cli, "changed failed transport CLI\n");
        throw original;
      }),
      (error) => {
        assert.ok(error instanceof AggregateError);
        assert.equal(error.errors.length, 2);
        assert.equal(error.errors[0], original);
        assert.equal(error.cause, original);
        const identityError: unknown = error.errors[1];
        assert.ok(identityError instanceof Error);
        assert.match(identityError.message, /Selected CLI identity changed/);
        assert.ok(identityError.cause instanceof Error);
        assert.match(identityError.cause.message, /SHA-256 differs/);
        return true;
      },
    );
    assert.deepEqual(f.calls, [["doctor"]]);
    assert.equal(existsSync(f.output), false);
  });

  void test("core refusal and CLI drift retain the command failure before the identity failure", async (t) => {
    const f = fixture(t, [external()], {
      doctor: { fixture_error: { ok: false, error: { message: "Snapshot unavailable" } } },
    });
    await assert.rejects(
      f.capture(async (...args) => {
        const result = await f.execute(...args);
        writeFileSync(f.cli, "changed core refusal CLI\n");
        return result;
      }),
      (error) => {
        assert.ok(error instanceof AggregateError);
        assert.equal(error.errors.length, 2);
        const commandError: unknown = error.errors[0];
        assert.ok(commandError instanceof Error);
        assert.equal(commandError.message, "doctor: Snapshot unavailable");
        assert.equal(error.cause, error.errors[0]);
        const identityError: unknown = error.errors[1];
        assert.ok(identityError instanceof Error);
        assert.match(identityError.message, /Selected CLI identity changed/);
        return true;
      },
    );
    assert.deepEqual(f.calls, [["doctor"]]);
    assert.equal(existsSync(f.output), false);
  });

  void test("malformed JSON and CLI drift retain the parse failure before the identity failure", async (t) => {
    const f = fixture(t, [external()]);
    await assert.rejects(
      f.capture(async (...args) => {
        await f.execute(...args);
        writeFileSync(f.cli, "changed malformed response CLI\n");
        return { stdout: "{malformed fixture JSON" };
      }),
      (error) => {
        assert.ok(error instanceof AggregateError);
        assert.equal(error.errors.length, 2);
        assert.ok(error.errors[0] instanceof SyntaxError);
        assert.equal(error.cause, error.errors[0]);
        const identityError: unknown = error.errors[1];
        assert.ok(identityError instanceof Error);
        assert.match(identityError.message, /Selected CLI identity changed/);
        return true;
      },
    );
    assert.deepEqual(f.calls, [["doctor"]]);
    assert.equal(existsSync(f.output), false);
  });

  void test("an existing capture directory is preserved", async (t) => {
    const f = fixture(t, [external()]);
    mkdirSync(f.output);
    writeFileSync(path.join(f.output, "evidence.json"), "previous evidence\n");
    await assert.rejects(f.capture(), { code: "EEXIST" });
    assert.equal(readFileSync(path.join(f.output, "evidence.json"), "utf8"), "previous evidence\n");
    assert.equal(existsSync(path.join(f.output, "checklist.md")), false);
  });
});
