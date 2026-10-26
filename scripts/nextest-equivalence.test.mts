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
  assert.deepEqual(profile["slow-timeout"], {
    period: "5s",
    "terminate-after": 6,
    "grace-period": "0s",
  });
  assert.equal(profile.retries, 0);
  assert.equal(profile["fail-fast"], false);
  assert.equal(profile["test-threads"], 2);
  assert.equal(profile["success-output"], undefined);
  assert.equal(profile["default-filter"], undefined);
  assert.ok(Array.isArray(profile.overrides));
  const overrides: Record<string, unknown>[] = profile.overrides.map((value: unknown) => {
    assert.ok(isRecord(value));
    return value;
  });
  // Filters are execution identities, so exact values remain contractual.
  const overrideFor = (filter: string, platform?: string) => {
    const values = overrides.filter(
      (value) => value.filter === filter && (platform === undefined || value.platform === platform),
    );
    assert.equal(values.length, 1, filter);
    const value = values[0];
    assert.ok(value);
    return value;
  };
  for (const filter of [
    "package(portcove-cli)",
    "package(portcove-core) & test(output_relocation::tests::)",
    "package(portcove-core) & test(cancellation::tests::)",
    "package(portcove-core) & test(definition_repository::tests::)",
    "package(portcove-core) & test(activity_diagnostics::tests::)",
    "package(portcove-core) & test(database::tests::)",
    "package(portcove-core) & test(adapter::source_conversion_tests::failed_and_cancelled_conversion_retains_logs_and_reaps_owned_processes)",
  ])
    assert.equal(overrideFor(filter)["threads-required"], "num-test-threads");
  const hosted = document.profile["hosted-windows"];
  assert.ok(isRecord(hosted));
  assert.equal(hosted["test-threads"], 4);
  assert.equal(hosted["default-filter"], undefined);
  assert.equal(overrideFor("package(portcove-cli)").priority, -100);
  const argumentContracts = overrideFor("package(portcove-cli) & test(/^args::tests::/)");
  assert.deepEqual(argumentContracts, {
    filter: "package(portcove-cli) & test(/^args::tests::/)",
    priority: 100,
  });
  assert.ok(
    overrides.indexOf(argumentContracts) < overrides.indexOf(overrideFor("package(portcove-cli)")),
    "the first matching priority must run pure command contracts before CLI lifecycles",
  );
  assert.equal(
    overrideFor("package(portcove-core) & test(activity_diagnostics::tests::)").priority,
    -50,
  );
  // These observed Windows-only failures retain exact case identities and
  // finite room for complete durable fixture setup, without broader policy.
  const observedImportCases = [
    "import_execution::tests::admitted_post_client_definition_survives_interrupted_import_resume",
    "import_execution::tests::admitted_post_client_definition_survives_offline_import_with_its_full_graph",
    "import_execution::tests::changed_import_destination_is_retained_and_never_published",
    "import_execution::tests::changed_import_input_is_retained_and_never_published",
    "import_execution::tests::copied_successor_snapshot_without_admission_cannot_grant_unknown_port_authority",
    "import_execution::tests::copying_import_recovers_without_replaying_old_saves",
    "import_execution::tests::forged_but_self_consistent_successor_admission_cannot_reuse_portability_authority",
    "import_execution::tests::import_missing_retained_reference_stops_recovery",
    "import_execution::tests::import_round_trip_preserves_versions_pointers_payloads_and_history_in_an_empty_library",
    "import_execution::tests::imported_retained_arguments_cannot_grant_themselves_execution_authority",
    "import_execution::tests::interrupted_abort_cannot_be_resumed_as_a_successful_import",
    "import_execution::tests::journal_phase_cannot_manufacture_import_publication",
    "import_execution::tests::late_credentials_hold_import_before_the_open_gate",
    "import_execution::tests::published_import_recovers_without_replaying_old_saves",
    "import_execution::tests::verified_import_recovers_without_replaying_old_saves",
    "library_transfer::tests::move_plan_accepts_an_admitted_post_client_definition",
  ];
  const observedCapabilityCases = [
    "definition_capability_contract::advertised_engine_templates_match_negotiation_and_exported_schemas",
    "definition_capability_contract::fixed_definition_authority_is_advertised_reviewable_and_unconfigured",
    "definition_capability_contract::listing_delivery_is_negotiable_and_cannot_provision_an_incoming_authority",
    "definition_capability_contract::ordinary_definition_refresh_advertises_contract_and_refuses_unconfigured_authority",
  ];
  const observedCoreFilter = `package(portcove-core) & (${observedImportCases.map((name) => `test(/^${name}$/)`).join(" | ")})`;
  const observedCliFilter = `package(portcove-cli) & (${observedCapabilityCases.map((name) => `test(/^${name}$/)`).join(" | ")})`;
  const outputOverrides = overrides.filter((value) => value["success-output"] !== undefined);
  const linuxLifecycleFilter =
    "package(portcove-cli) & (test(/^preparation_contract::reusable_preparation_qualification_runs_real_cli_iso_case$/) | test(/^preparation_contract::reusable_preparation_qualification_uses_same_sequence_for_another_port_and_chd$/) | test(/^runtime_diagnostics_correlates_real_install_update_prepare_and_launch$/))";
  const intelPreparationFilter =
    "package(portcove-cli) & test(/^preparation_contract::reusable_preparation_qualification_runs_real_cli_iso_case$/)";
  const curatedInstalledWithdrawalFilter =
    "package(portcove-core) & test(/^definition_repository::tests::publisher_policy_tests::curated_installed_withdrawal_allows_critical_verification_but_holds_fresh_acquisition$/)";
  const windowsLifecycleFilters = [
    "package(portcove-core) & test(/^service::tests::backups::historical_byte_only_backup_keeps_its_existing_integrity_contract$/)",
    "package(portcove-core) & (test(/^service::tests::backups::recovers_restore_prepared$/) | test(/^service::tests::backups::recovers_restore_published$/))",
    "package(portcove-cli) & test(/^artwork_contract::artwork_cli_keeps_cover_and_detail_independent_through_the_local_lifecycle$/)",
    "package(portcove-core) & (test(/^service::tests::backups::current_persistence_cannot_restore_an_unmanifested_companion_into_lifecycle_paths$/) | test(/^service::tests::backups::interrupted_backup_stages_are_visible_without_hiding_verified_backups$/))",
    "package(portcove-core) & test(/^service::psx_mod_data::tests::lifecycle::explicit_backup_restore_preserves_successor_packages_and_preflights_conflicts$/)",
    "package(portcove-core) & (test(/^definition_repository::tests::publisher_policy_tests::curated_retained_launch_withdrawal_supervises_exact_owned_child_after_reopen$/) | test(/^definition_repository::tests::publisher_policy_tests::curated_rollback_revocation_preserves_unaffected_active_and_recovery_evidence$/))",
    "package(portcove-core) & (test(/^service::shipwright_persistence_tests::shipwright_activation_and_rollback_collect_before_replacing_working_save$/) | test(/^service::shipwright_persistence_tests::shipwright_backup_restore_keeps_the_displaced_runtime_save_in_safety_backup$/))",
    "package(portcove-core) & (test(/^import_execution::tests::late_credentials_hold_import_before_the_open_gate$/) | test(/^library_move::tests::late_credentials_hold_move_before_authority_or_destination_activation$/))",
    "package(portcove-core) & (test(/^service::tests::tfe_recovery_hold_protects_inactive_versions_and_invalidates_earlier_removal_consent$/) | test(/^service::tests::tfe_recovery_hold_survives_quarantine_reopen_and_committed_metadata_removal$/))",
    "package(portcove-core) & test(/^definition_repository::tests::publisher_policy_tests::curated_rollback_withdrawal_permits_exact_retained_target$/)",
    "package(portcove-core) & test(/^service::tests::authenticated_admission_survives_staging_rollback_activation_and_refresh$/)",
    "package(portcove-core) & test(/^service::tests::publication_recovery_retains_conflicting_(relocation|source_import|quarantine|original_paths)_intent$/)",
  ];
  const replacementDownloadFilter =
    "package(portcove-core) & test(/^service::catalog_download::tests::replacement_download_keeps_current_registration_until_reviewed_relink$/)";
  const psxProgressionFilter =
    "package(portcove-core) & test(/^service::runtime_tests::psx_progression::(unchanged_psx_definition_completes_provider_install_and_update_with_registered_inputs|retained_direct_psx_runtime_updates_through_current_provider_without_rewriting_contract)$/)";
  const namedSaveRestoreFilter =
    "package(portcove-core) & test(/^service::runtime_tests::named_save_restore_updates_every_version_and_preserves_import_policy$/)";
  const sourcePreparationFilter =
    "package(portcove-core) & (test(/^preparation::source::tests::source_only_fresh_install_rechecks_original_before_rename$/) | test(/^preparation::source::tests::source_only_fresh_install_rechecks_original_before_registration$/) | test(/^preparation::source::tests::source_only_gamecube_install_seals_the_nested_iso$/) | test(/^preparation::source::tests::source_only_directory_install_survives_two_launches_and_full_verify$/) | test(/^preparation::source::tests::source_only_zip_install_survives_two_launches_and_full_verify$/) | test(/^preparation::source::tests::source_only_review_repairs_historical_extras_but_refuses_unrelated_changes$/) | test(/^preparation::source::tests::source_only_recovery_refuses_original_changes_before_publication$/))";
  const publicationFilters = [
    {
      filter:
        "package(portcove-core) & test(/^definition_repository::tests::publisher_policy_tests::managed_ordinary_artifacts_and_compatible_correction_retain_exact_contract$/)",
      platform: undefined,
    },
    {
      filter:
        "package(portcove-core) & test(/^definition_repository::tests::publisher_policy_tests::curated_publication_recovery_permitted_artifact_commits_once$/)",
      platform: "x86_64-apple-darwin",
    },
  ];
  // Admit only these exact platform/filter identities. Comparing the complete
  // inventory also rejects duplicates without a separately maintained count.
  const outputIdentity = (value: Readonly<Record<string, unknown>>) =>
    JSON.stringify([value.platform ?? null, value.filter]);
  const intelRecoveryFilter =
    "package(portcove-core) & (test(/^catalog_update::tests::refused_artwork_only_commit_reopens_prior_mapping_and_local_choice_then_retries$/) | test(/^service::tests::publication_recovery_retains_conflicting_(quarantine|relocation)_intent$/) | test(/^catalog::tests::upstream_maintenance_status_does_not_reinterpret_existing_port_contracts$/))";
  assert.deepEqual(
    outputOverrides.map(outputIdentity).sort(),
    [
      ...windowsLifecycleFilters.map((filter) => ({ platform: "x86_64-pc-windows-msvc", filter })),
      ...publicationFilters,
      { filter: sourcePreparationFilter },
      { platform: "x86_64-unknown-linux-gnu", filter: linuxLifecycleFilter },
      { platform: "x86_64-apple-darwin", filter: intelPreparationFilter },
      { platform: "x86_64-apple-darwin", filter: intelRecoveryFilter },
      { platform: "x86_64-pc-windows-msvc", filter: observedCoreFilter },
      { platform: "x86_64-pc-windows-msvc", filter: observedCliFilter },
      { platform: "x86_64-pc-windows-msvc", filter: curatedInstalledWithdrawalFilter },
      { platform: "x86_64-pc-windows-msvc", filter: replacementDownloadFilter },
      { platform: "x86_64-pc-windows-msvc", filter: namedSaveRestoreFilter },
      { platform: "x86_64-pc-windows-msvc", filter: psxProgressionFilter },
    ]
      .map(outputIdentity)
      .sort(),
  );
  assert.deepEqual(overrideFor(curatedInstalledWithdrawalFilter, "x86_64-pc-windows-msvc"), {
    platform: "x86_64-pc-windows-msvc",
    filter: curatedInstalledWithdrawalFilter,
    "slow-timeout": { period: "5s", "terminate-after": 12, "grace-period": "0s" },
    "success-output": "immediate",
  });
  assert.deepEqual(overrideFor(intelRecoveryFilter, "x86_64-apple-darwin"), {
    platform: "x86_64-apple-darwin",
    filter: intelRecoveryFilter,
    "slow-timeout": { period: "5s", "terminate-after": 12, "grace-period": "0s" },
    "success-output": "immediate",
  });
  const sourcePreparation = overrideFor(sourcePreparationFilter);
  assert.deepEqual(sourcePreparation["slow-timeout"], {
    period: "5s",
    "terminate-after": 18,
    "grace-period": "0s",
  });
  assert.equal(sourcePreparation["success-output"], "immediate");
  for (const field of ["platform", "retries", "threads-required", "priority", "default-filter"])
    assert.equal(sourcePreparation[field], undefined);
  const linuxLifecycle = overrideFor(linuxLifecycleFilter, "x86_64-unknown-linux-gnu");
  assert.deepEqual(linuxLifecycle["slow-timeout"], {
    period: "5s",
    "terminate-after": 18,
    "grace-period": "0s",
  });
  assert.equal(linuxLifecycle["success-output"], "immediate");
  for (const field of ["retries", "threads-required", "priority", "default-filter"])
    assert.equal(linuxLifecycle[field], undefined);
  const intelPreparation = overrideFor(intelPreparationFilter, "x86_64-apple-darwin");
  assert.deepEqual(intelPreparation["slow-timeout"], {
    period: "5s",
    "terminate-after": 18,
    "grace-period": "0s",
  });
  assert.equal(intelPreparation["success-output"], "immediate");
  for (const field of ["retries", "threads-required", "priority", "default-filter"])
    assert.equal(intelPreparation[field], undefined);
  for (const [filter, periods] of [
    [observedCoreFilter, 18],
    [observedCliFilter, 12],
  ] as const) {
    const override = overrideFor(filter, "x86_64-pc-windows-msvc");
    assert.deepEqual(override["slow-timeout"], {
      period: "5s",
      "terminate-after": periods,
      "grace-period": "0s",
    });
    assert.equal(override["success-output"], "immediate");
    for (const field of ["retries", "threads-required", "priority", "default-filter"])
      assert.equal(override[field], undefined);
    assert.ok(
      overrides.indexOf(override) < overrides.indexOf(overrideFor(windowsLifecycleFilters[0]!)),
    );
  }
  for (const filter of windowsLifecycleFilters) {
    const override = overrideFor(filter, "x86_64-pc-windows-msvc");
    assert.equal(override.platform, "x86_64-pc-windows-msvc");
    assert.equal(override["success-output"], "immediate");
    assert.deepEqual(override["slow-timeout"], {
      period: "5s",
      "terminate-after": 12,
      "grace-period": "0s",
    });
    for (const field of ["retries", "threads-required", "priority"])
      assert.equal(override[field], undefined);
  }
  // The measured copy-start wait must fit inside an exact Windows-only outer
  // budget; it must not add output, retries, workers or priority exceptions.
  const cacheRetention = overrideFor(
    "package(portcove-core) & (test(/^definition_repository::tests::publisher_policy_tests::curated_cache_retention_cancellation_preserves_partial_after_worker_exit$/) | test(/^definition_repository::tests::publisher_policy_tests::curated_cache_retention_revocation_during_copy_refuses_publication$/))",
  );
  assert.equal(cacheRetention.platform, "x86_64-pc-windows-msvc");
  const macCacheRetentionFilter =
    "package(portcove-core) & test(/^definition_repository::tests::publisher_policy_tests::curated_cache_retention_cancellation_preserves_partial_after_worker_exit$/)";
  for (const platform of ["x86_64-apple-darwin", "aarch64-apple-darwin"]) {
    assert.deepEqual(overrideFor(macCacheRetentionFilter, platform), {
      platform,
      filter: macCacheRetentionFilter,
      "slow-timeout": { period: "5s", "terminate-after": 9, "grace-period": "0s" },
    });
  }
  assert.deepEqual(cacheRetention["slow-timeout"], {
    period: "5s",
    "terminate-after": 12,
    "grace-period": "0s",
  });
  for (const field of ["success-output", "retries", "threads-required", "priority"])
    assert.equal(cacheRetention[field], undefined);
  for (const { filter, platform } of publicationFilters) {
    const override = overrideFor(filter);
    assert.equal(override.platform, platform);
    assert.equal(override["success-output"], "immediate");
    for (const field of ["retries", "threads-required", "priority"])
      assert.equal(override[field], undefined);
  }
  for (const filter of [replacementDownloadFilter, namedSaveRestoreFilter, psxProgressionFilter]) {
    const override = overrideFor(filter, "x86_64-pc-windows-msvc");
    assert.equal(override["success-output"], "immediate");
    assert.deepEqual(override["slow-timeout"], {
      period: "5s",
      "terminate-after": 18,
      "grace-period": "0s",
    });
    for (const field of ["retries", "threads-required", "priority"])
      assert.equal(override[field], undefined);
  }
  for (const value of [profile, ...overrides]) {
    assert.ok(value.retries === undefined || value.retries === 0);
    assert.equal(value["on-timeout"], undefined);
    if (value !== profile) assert.equal(typeof value.filter, "string");
    const timeout: unknown = value["slow-timeout"];
    if (timeout === undefined) continue;
    assert.ok(isRecord(timeout));
    // Nextest owns duration syntax; calibrated warning/grace durations may vary.
    assert.equal(typeof timeout.period, "string");
    if (timeout["grace-period"] !== undefined)
      assert.equal(typeof timeout["grace-period"], "string");
    assert.ok(Number.isSafeInteger(timeout["terminate-after"]));
    assert.ok(typeof timeout["terminate-after"] === "number" && timeout["terminate-after"] > 0);
  }
});
