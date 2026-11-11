import { readFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { isRecord } from "./runtime-values.mts";
import { main } from "./local-validation.mts";
import assert from "node:assert/strict";
import test from "node:test";
import { compareNextest, annotateNextest } from "./nextest-equivalence.mts";
import { buildValidationPlan, validateValidationPlan } from "./validation-plan.mts";
import { baselineSelection } from "./ci-baseline.mts";

void test("effective nextest comparison handles TOML syntax and keeps semantic changes broad", () => {
  const base = '[profile.default]\nretries=0\ntest-threads=2\nname="quoted # value"\n';
  const formatted =
    '# explanation\n[profile.default]\nname = "quoted # value"\ntest-threads = 2 # slots\nretries = 0\n';
  const proof = compareNextest(base, formatted);
  assert.ok(proof, "test host must provide Python tomllib for the semantic positive control");
  for (const changed of [
    base.replace("retries=0", "retries=1"),
    base.replace("test-threads=2", "test-threads=3"),
    base.replace("quoted # value", "quoted # other"),
    "[invalid",
    base.replace("retries=0", "retries=false"),
  ])
    assert.equal(compareNextest(base, changed), null);
  assert.equal(
    compareNextest('x="""hello\n# real content\n"""', 'x="""hello\n# changed content\n"""'),
    null,
  );
  assert.equal(compareNextest("[[a]]\nx=1\n[[a]]\nx=2", "[[a]]\nx=2\n[[a]]\nx=1"), null);
  assert.equal(
    compareNextest(base, formatted, (command, _args, options) => {
      assert.equal(command, process.platform === "win32" ? "python" : "python3");
      assert.equal(options.timeout, 5000);
      assert.equal(options.maxBuffer, 65536);
      return { status: 1, stdout: "" };
    }),
    null,
  );
  assert.equal(compareNextest(null, formatted), null);
  const changes = annotateNextest(
    [
      {
        status: "M",
        oldMode: "100644",
        newMode: "100644",
        oldPath: ".config/nextest.toml",
        newPath: ".config/nextest.toml",
      },
    ],
    () => base,
    () => formatted,
  );
  const plan = buildValidationPlan({
    changes,
    eventName: "pull_request",
    base: "a".repeat(40),
    mergeBase: "a".repeat(40),
    head: "b".repeat(40),
    checkout: "b".repeat(40),
  });
  validateValidationPlan(plan);
  assert.equal(plan.groups.includes("rust"), false);
  assert.equal(baselineSelection(plan).workspaceRust, false);
  const broad = buildValidationPlan({
    ...{
      changes: annotateNextest(
        changes.map(({ nextest_equivalence: _proof, ...c }) => c),
        () => base,
        () => base.replace("retries=0", "retries=1"),
      ),
      eventName: "pull_request",
      checkout: "b".repeat(40),
    },
  });
  assert.ok(broad.groups.includes("rust"));
});

void test("local command preserves effective-config proof through its hosted-plan conversion", async () => {
  const proof = compareNextest(
    "[profile.default]\nretries=0",
    "# comment\n[profile.default]\nretries=0",
  );
  assert.ok(proof);
  const messages: string[] = [];
  const original = console.log;
  try {
    console.log = (message) => messages.push(String(message));
    await main(["check", "--plan"], {
      readContext: () => ({
        base: "origin/main",
        baseSha: "a".repeat(40),
        mergeBase: "a".repeat(40),
        headSha: "b".repeat(40),
        changes: [
          {
            status: "M",
            path: ".config/nextest.toml",
            oldMode: "100644",
            newMode: "100644",
            nextest_equivalence: proof,
          },
        ],
      }),
    });
  } finally {
    console.log = original;
  }
  assert.ok(messages.some((line) => line === "Validation groups: catalog, rust-quality"));
  assert.equal(
    messages.some((line: string) => line.startsWith("- rust-workspace-tests:")),
    false,
  );
});

void test("Nextest configuration reports slow tests, terminates hangs and preserves scoped budgets", async () => {
  const config = await readFile(new URL("../.config/nextest.toml", import.meta.url), "utf8");
  // Parse the actual configuration consumed by nextest, using the same TOML
  // implementation already used by production nextest-equivalence selection.
  const parsed = spawnSync(
    process.platform === "win32" ? "python" : "python3",
    ["-c", "import sys,json,tomllib; print(json.dumps(tomllib.loads(sys.stdin.read())))"],
    { input: config, encoding: "utf8", timeout: 5000, windowsHide: true },
  );
  assert.ifError(parsed.error);
  assert.equal(parsed.status, 0, parsed.stderr);
  const document: unknown = JSON.parse(parsed.stdout);
  assert.ok(isRecord(document) && isRecord(document.profile));
  const profile = document.profile.default;
  assert.ok(isRecord(profile));
  // The strict default profile serves local and qualification runs: a finite
  // 120s harness cutoff, two slots and no automatic retries.
  const defaultCutoff = { period: "15s", "terminate-after": 8, "grace-period": "0s" };
  assert.deepEqual(profile["slow-timeout"], defaultCutoff);
  assert.equal(profile.retries, 0);
  assert.equal(profile["fail-fast"], false);
  assert.equal(profile["test-threads"], 2);
  assert.equal(profile["success-output"], undefined);
  assert.equal(profile["default-filter"], undefined);
  // Ordinary hosted Windows partitions allow one retry; nextest reports a pass
  // after retry as flaky and the shared outcome reporter retains it.
  const hosted = document.profile["hosted-windows"];
  assert.ok(isRecord(hosted));
  assert.deepEqual(hosted, { "test-threads": 4, retries: 1, junit: { path: "junit.xml" } });
  assert.ok(Array.isArray(profile.overrides));
  const overrides: Record<string, unknown>[] = profile.overrides.map((value: unknown) => {
    assert.ok(isRecord(value));
    return value;
  });
  // Filters are execution identities, so exact values remain contractual.
  const overrideFor = (filter: string, platform?: string | null) => {
    const values = overrides.filter(
      (value) =>
        value.filter === filter &&
        (platform === undefined || (value.platform ?? null) === platform),
    );
    assert.equal(values.length, 1, filter);
    const value = values[0];
    assert.ok(value);
    return value;
  };
  const seconds = (value: unknown) => {
    assert.ok(isRecord(value));
    assert.equal(value["grace-period"], "0s");
    const period = /^([1-9][0-9]*)s$/u.exec(String(value.period));
    assert.ok(period && Number.isSafeInteger(value["terminate-after"]));
    return Number(period[1]) * Number(value["terminate-after"]);
  };
  assert.equal(seconds(defaultCutoff), 120);
  // Only cases whose observed harness budget exceeds the default keep an exact
  // finite override; a budget at or below the default would be redundant.
  const timeoutBudgets = [
    [
      "x86_64-pc-windows-msvc",
      "package(portcove-core) & test(/^service::native_portable::tests::tails_nativeportable_progression_rollback_backup_restore_recovery_1895$/)",
      180,
    ],
    [
      "x86_64-pc-windows-msvc",
      "package(portcove-core) & test(/^service::native_portable::tests::compatible_archive_progression_(mega_man_x2|sonic|super_metroid|winback)$/)",
      600,
    ],
    [
      "x86_64-pc-windows-msvc",
      "package(portcove-core) & test(/^service::native_portable::tests::reviewed_archive_transition_mmx2_populated_install$/)",
      420,
    ],
    [
      "x86_64-pc-windows-msvc",
      "package(portcove-core) & test(/^service::native_portable::tests::reviewed_archive_transition_sonic_populated_install$/)",
      600,
    ],
    [
      "x86_64-pc-windows-msvc",
      "package(portcove-core) & test(/^service::native_portable::tests::reviewed_archive_transition_super_metroid_populated_install$/)",
      420,
    ],
    [
      "x86_64-pc-windows-msvc",
      "package(portcove-core) & test(/^service::native_portable::tests::reviewed_archive_transition_/)",
      600,
    ],
    [
      "x86_64-pc-windows-msvc",
      "package(portcove-core) & test(/^service::native_portable::tests::ready_archive_profile_times_survive_update_backup_and_runtime_rollback$/)",
      270,
    ],
    [
      "x86_64-pc-windows-msvc",
      "package(portcove-core) & test(/^definition_repository::tests::publisher_policy_tests::curated_rollback_withdrawal_permits_exact_retained_target$/)",
      180,
    ],
    [
      "x86_64-apple-darwin",
      "package(portcove-core) & test(/^catalog::tests::upstream_maintenance_status_does_not_reinterpret_existing_port_contracts$/)",
      180,
    ],
    [
      "x86_64-pc-windows-msvc",
      "package(portcove-core) & test(/^catalog::tests::upstream_maintenance_status_does_not_reinterpret_existing_port_contracts$/)",
      180,
    ],
    [
      "x86_64-pc-windows-msvc",
      "package(portcove-core) & test(/^service::runtime_tests::reflectionhle_progression::reflectionhle_progression_(2683|2684|2685|2686|2687|2688|2689|2690|2692)$/)",
      180,
    ],
    [
      "x86_64-pc-windows-msvc",
      "package(portcove-core) & test(/^service::tests::authenticated_admission_survives_staging_rollback_activation_and_refresh$/)",
      180,
    ],
    [
      "x86_64-pc-windows-msvc",
      "package(portcove-core) & test(/^service::native_portable::tests::ready_staged_archive_preserves_preplay_data_and_successor_cache_defaults$/)",
      180,
    ],
    [
      "x86_64-pc-windows-msvc",
      "package(portcove-core) & test(/^service::native_portable::tests::ready_staged_archive_observed_lifecycle_cases$/)",
      330,
    ],
    [
      "x86_64-pc-windows-msvc",
      "package(portcove-core) & test(/^service::native_portable::tests::native_engine_adoption_1878$/)",
      180,
    ],
    [
      null,
      "package(portcove-core) & (test(/^service::game_update_acquisition::tests::immutable_acquisition_can_start_after_verified_game_is_already_running$/) | test(/^service::game_update_acquisition::tests::launch_during_stalled_acquisition_and_finish_while_game_runs$/) | test(/^service::game_update_acquisition::tests::interrupted_marker_publication_has_bounded_exact_owner_discard_route$/))",
      180,
    ],
    [
      "x86_64-pc-windows-msvc",
      "package(portcove-core) & test(/^service::tests::backups::recovers_restore_version_synchronized$/)",
      180,
    ],
    [
      "x86_64-pc-windows-msvc",
      "package(portcove-core) & test(/^service::native_portable::tests::managed_native_declared_/)",
      240,
    ],
  ] as const;
  const timed = overrides.filter((value) => value["slow-timeout"] !== undefined);
  assert.deepEqual(
    timed.map((value) => [value.platform ?? null, value.filter, seconds(value["slow-timeout"])]),
    timeoutBudgets,
  );
  for (const value of timed) {
    assert.ok(seconds(value["slow-timeout"]) > seconds(defaultCutoff), String(value.filter));
    // Budgets of 300s or more never retry, so a hang cannot double a long cutoff.
    const long = seconds(value["slow-timeout"]) >= 300;
    assert.deepEqual(
      Object.keys(value)
        .filter((key) => !["platform", "filter"].includes(key))
        .sort(),
      long ? ["retries", "slow-timeout", "success-output"] : ["slow-timeout", "success-output"],
      String(value.filter),
    );
    if (long) assert.equal(value.retries, 0);
    assert.equal(value["success-output"], "immediate");
  }
  // The exact populated transitions precede their 600s family so their own
  // finite budgets remain the effective first match.
  const transitionFamily = overrideFor(
    "package(portcove-core) & test(/^service::native_portable::tests::reviewed_archive_transition_/)",
    "x86_64-pc-windows-msvc",
  );
  for (const title of ["mmx2", "sonic", "super_metroid"])
    assert.ok(
      overrides.indexOf(
        overrideFor(
          `package(portcove-core) & test(/^service::native_portable::tests::reviewed_archive_transition_${title}_populated_install$/)`,
          "x86_64-pc-windows-msvc",
        ),
      ) < overrides.indexOf(transitionFamily),
    );
  // Exclusive slot reservation is limited to exact cases that conflict with any
  // concurrent disk or process work; contending families use serial groups.
  const capacityFilter =
    "package(portcove-cli) & (test(/^output_/) | test(cancellation_from_another_cli_stops_discovery_with_a_durable_cancelled_result))";
  assert.deepEqual(
    overrides
      .filter((value) => value["threads-required"] !== undefined)
      .map((value) => [value.filter, value["threads-required"]]),
    [
      [
        "package(portcove-core) & test(/^catalog::tests::upstream_maintenance_status_does_not_reinterpret_existing_port_contracts$/)",
        "num-test-threads",
      ],
      [capacityFilter, "num-test-threads"],
      [
        "package(portcove-core) & test(/^definition_repository::tests::publisher_policy_tests::curated_cache_.*_during_copy_/)",
        "num-test-threads",
      ],
      [
        "package(portcove-core) & test(import_execution::tests::import_round_trip_preserves_versions_pointers_payloads_and_history_in_an_empty_library)",
        "num-test-threads",
      ],
      [
        "package(portcove-cli) & binary(runtime_diagnostics) & test(/^runtime_diagnostics_correlates_real_install_update_prepare_and_launch$/)",
        "num-test-threads",
      ],
      [
        "package(portcove-core) & test(adapter::source_conversion_tests::failed_and_cancelled_conversion_retains_logs_and_reaps_owned_processes)",
        "num-test-threads",
      ],
    ],
  );
  assert.ok(isRecord(document["test-groups"]));
  const groups = {
    "cli-lifecycle": "package(portcove-cli)",
    "core-output-relocation": "package(portcove-core) & test(output_relocation::tests::)",
    "core-catalog-update": "package(portcove-core) & test(catalog_update::tests::)",
    "core-definition-repository": "package(portcove-core) & test(definition_repository::tests::)",
    "core-activity-diagnostics": "package(portcove-core) & test(activity_diagnostics::tests::)",
    "core-database": "package(portcove-core) & test(database::tests::)",
    "core-cancellation": "package(portcove-core) & test(cancellation::tests::)",
  };
  assert.deepEqual(
    document["test-groups"],
    Object.fromEntries(Object.keys(groups).map((name) => [name, { "max-threads": 1 }])),
  );
  for (const [group, filter] of Object.entries(groups))
    assert.equal(overrideFor(filter)["test-group"], group);
  for (const value of overrides) {
    const group = value["test-group"];
    if (group !== undefined)
      assert.ok(group === "@global" || (typeof group === "string" && Object.hasOwn(groups, group)));
  }
  // Pure argument and presentation contracts leave the serial CLI group and the
  // exclusive capacity cases leave it too, since they already hold every slot.
  const cliLifecycle = overrideFor("package(portcove-cli)");
  assert.equal(cliLifecycle.priority, -100);
  const argumentContracts = overrideFor(
    "package(portcove-cli) & kind(bin) & test(/^args::tests::/)",
  );
  assert.deepEqual(argumentContracts, {
    filter: "package(portcove-cli) & kind(bin) & test(/^args::tests::/)",
    "test-group": "@global",
    priority: 100,
  });
  const presentationContracts = overrideFor(
    "package(portcove-cli) & kind(bin) & test(/^(catalog::render::tests|human::(phases|task_results|transfers)::tests|progress::tests)::/)",
  );
  assert.equal(presentationContracts["test-group"], "@global");
  const capacity = overrideFor(capacityFilter);
  assert.equal(capacity["test-group"], "@global");
  for (const value of [argumentContracts, presentationContracts, capacity])
    assert.ok(
      overrides.indexOf(value) < overrides.indexOf(cliLifecycle),
      "the first matching group and priority must precede the CLI lifecycle family",
    );
  assert.equal(
    overrideFor("package(portcove-core) & test(activity_diagnostics::tests::)").priority,
    -50,
  );
  // Every override names one known setting family; no broad discovery
  // exceptions are admitted per case, and a per-case retry setting may only
  // remove retries.
  for (const value of overrides) {
    if (value.retries !== undefined) assert.equal(value.retries, 0, String(value.filter));
    for (const key of Object.keys(value))
      assert.ok(
        [
          "platform",
          "filter",
          "retries",
          "slow-timeout",
          "success-output",
          "threads-required",
          "test-group",
          "priority",
        ].includes(key),
        key,
      );
  }
});
