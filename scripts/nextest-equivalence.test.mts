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
  const immutableArchiveOverrides = (
    [
      [
        18,
        [
          "service::game_update_acquisition::tests::acquired_archive_cannot_bypass_changed_original_source_bytes",
          "service::game_update_acquisition::tests::acquired_archive_survives_restart_and_requires_fresh_exclusive_apply_review",
        ],
      ],
      [
        18,
        [
          "service::game_update_acquisition::tests::live_and_completed_acquisitions_block_library_move_with_exact_discard_resume",
          "service::game_update_acquisition::tests::orphan_archive_remains_visible_after_install_and_catalog_removal_until_exact_discard",
          "service::game_update_acquisition::tests::removing_managed_runtime_during_transfer_preserves_archive_and_never_resurrects_it",
          "service::game_update_acquisition::tests::cancellation_retains_bounded_attention_and_exact_discard_allows_retry",
          "service::game_update_review::tests::activity_apply_refuses_other_handle_file_work_before_consuming_review_or_mutating",
          "service::game_update_review::tests::an_unverified_retained_plan_cannot_authorize_execution",
          "service::game_update_review::tests::cancellation_and_invalid_retained_bytes_preserve_the_active_version",
          "service::game_update_review::tests::reviewed_stage_and_activation_are_explicit_and_ignore_saved_automatic_policy",
        ],
      ],
      [
        36,
        [
          "service::game_update_acquisition::tests::immutable_acquisition_can_start_after_verified_game_is_already_running",
          "service::game_update_acquisition::tests::launch_during_stalled_acquisition_and_finish_while_game_runs",
          "service::game_update_acquisition::tests::interrupted_marker_publication_has_bounded_exact_owner_discard_route",
        ],
      ],
    ] as const
  ).map(([periods, cases]) => ({
    filter: `package(portcove-core) & (${cases.map((name) => `test(/^${name}$/)`).join(" | ")})`,
    periods,
  }));
  // The retained v58 observations calibrate only these exact cases. No retries,
  // concurrency, platform, priority or broad discovery exception is admitted.
  for (const { filter, periods } of immutableArchiveOverrides) {
    assert.deepEqual(overrideFor(filter), {
      filter,
      "slow-timeout": { period: "5s", "terminate-after": periods, "grace-period": "0s" },
      "success-output": "immediate",
    });
  }
  const outputOverrides = overrides.filter((value) => value["success-output"] !== undefined);
  const linuxLifecycleFilter =
    "package(portcove-cli) & (test(/^preparation_contract::reusable_preparation_qualification_runs_real_cli_iso_case$/) | test(/^preparation_contract::reusable_preparation_qualification_uses_same_sequence_for_another_port_and_chd$/) | test(/^preparation_contract::lost_preparation_output_is_resolved_by_fresh_public_readback_without_replay$/) | test(/^preparation_contract::reviewed_chd_conversion_retains_both_phases_through_fresh_cli_and_play$/) | test(/^runtime_diagnostics_correlates_real_install_update_prepare_and_launch$/))";
  const intelPreparationFilter =
    "package(portcove-cli) & (test(/^preparation_contract::reusable_preparation_qualification_runs_real_cli_iso_case$/) | test(/^preparation_contract::reusable_preparation_qualification_uses_same_sequence_for_another_port_and_chd$/))";
  const intelObservedLifecycle = [
    {
      filter:
        "package(portcove-core) & (test(/^service::tests::authenticated_admission_survives_staging_rollback_activation_and_refresh$/) | test(/^service::tests::backups::recovers_restore_version_synchronized$/) | test(/^service::tests::backups::restore_preserves_its_journal_when_a_retained_save_path_is_a_symlink$/) | test(/^service::tests::backups::restore_remains_authoritative_after_launch_rollback_and_staged_activation$/) | test(/^definition_projection::tests::every_current_port_retains_exact_bytes_and_complete_validated_source_graph$/) | test(/^definition_repository::tests::publisher_policy_tests::curated_activation_withdrawal_permits_exact_retained_target$/))",
      periods: 12,
    },
    {
      filter:
        "package(portcove-cli) & (test(/^preparation_contract::reviewed_preparation_runs_through_jsonl_and_a_fresh_cli_plays_without_setup$/) | test(/^runtime_diagnostics_correlates_real_install_update_prepare_and_launch$/))",
      periods: 18,
    },
  ];
  for (const { filter, periods } of intelObservedLifecycle) {
    assert.deepEqual(overrideFor(filter, "x86_64-apple-darwin"), {
      platform: "x86_64-apple-darwin",
      filter,
      "slow-timeout": { period: "5s", "terminate-after": periods, "grace-period": "0s" },
      "success-output": "immediate",
    });
  }
  const windowsPreparationAndDriftFilter =
    "(package(portcove-core) & test(/^game_file_query::tests::late_channel_or_instance_drift_discards_the_private_refresh_result$/)) | (package(portcove-cli) & binary(machine_contract) & (test(/^preparation_contract::reusable_preparation_qualification_runs_real_cli_iso_case$/) | test(/^preparation_contract::reusable_preparation_qualification_uses_same_sequence_for_another_port_and_chd$/)))";
  const windowsDiagnosticsFilter =
    "package(portcove-cli) & binary(runtime_diagnostics) & test(/^runtime_diagnostics_correlates_real_install_update_prepare_and_launch$/)";
  const windowsRelocationRecoveryFilter =
    "package(portcove-core) & test(/^service::tests::publication_recovery_retains_conflicting_(relocation|quarantine|original_paths)_intent$/)";
  const linuxRelocationRecoveryFilter =
    "package(portcove-core) & test(/^service::tests::publication_recovery_retains_conflicting_relocation_intent$/)";
  const linuxRelocationRecovery = overrideFor(
    linuxRelocationRecoveryFilter,
    "x86_64-unknown-linux-gnu",
  );
  assert.deepEqual(linuxRelocationRecovery, {
    platform: "x86_64-unknown-linux-gnu",
    filter: linuxRelocationRecoveryFilter,
    "slow-timeout": { period: "5s", "terminate-after": 12, "grace-period": "0s" },
    "success-output": "immediate",
  });
  const windowsRecoveryFamilyFilter =
    "package(portcove-core) & test(/^service::tests::publication_recovery_retains_conflicting_(relocation|source_import|quarantine|original_paths)_intent$/)";
  const windowsRetainedMovePolicyFilter =
    "package(portcove-core) & test(/^runtime_path_policy::tests::move_previews_check_retained_policy_before_creating_destinations$/)";
  assert.deepEqual(overrideFor(windowsRetainedMovePolicyFilter, "x86_64-pc-windows-msvc"), {
    platform: "x86_64-pc-windows-msvc",
    filter: windowsRetainedMovePolicyFilter,
    "slow-timeout": { period: "5s", "terminate-after": 12, "grace-period": "0s" },
    "success-output": "immediate",
  });
  const windowsSourceImportRecoveryFilter =
    "package(portcove-core) & test(/^service::tests::publication_recovery_retains_conflicting_source_import_intent$/)";
  const sourceImportRecovery = overrideFor(
    windowsSourceImportRecoveryFilter,
    "x86_64-pc-windows-msvc",
  );
  assert.deepEqual(sourceImportRecovery, {
    platform: "x86_64-pc-windows-msvc",
    filter: windowsSourceImportRecoveryFilter,
    "slow-timeout": { period: "5s", "terminate-after": 18, "grace-period": "0s" },
    "success-output": "immediate",
  });
  assert.ok(
    overrides.indexOf(sourceImportRecovery) <
      overrides.indexOf(overrideFor(windowsRecoveryFamilyFilter, "x86_64-pc-windows-msvc")),
    "The exact source-import90s identity must precede its60s family",
  );
  const relocationRecovery = overrideFor(windowsRelocationRecoveryFilter, "x86_64-pc-windows-msvc");
  assert.deepEqual(relocationRecovery, {
    platform: "x86_64-pc-windows-msvc",
    filter: windowsRelocationRecoveryFilter,
    "slow-timeout": { period: "5s", "terminate-after": 18, "grace-period": "0s" },
    "success-output": "immediate",
  });
  assert.ok(
    overrides.indexOf(relocationRecovery) <
      overrides.indexOf(overrideFor(windowsRecoveryFamilyFilter, "x86_64-pc-windows-msvc")),
    "The exact90s identity must precede its60s family",
  );
  const intelCuratedRepinFilter =
    "package(portcove-core) & test(/^definition_repository::tests::publisher_policy_tests::curated_admitted_scope_resolves_missing_digest_and_revalidates_mutable_identity$/)";
  assert.deepEqual(overrideFor(intelCuratedRepinFilter, "x86_64-apple-darwin"), {
    platform: "x86_64-apple-darwin",
    filter: intelCuratedRepinFilter,
    "slow-timeout": { period: "5s", "terminate-after": 12, "grace-period": "0s" },
  });
  const intelObservedControlFilter =
    "package(portcove-core) & (test(/^game_file_query::tests::retained_launch_uses_verified_platform_and_marks_unreadable_context_unavailable$/) | test(/^library_move::sequence_tests::copying_resume_resume$/) | test(/^definition_repository::tests::publisher_policy_tests::curated_publication_recovery_published_permitted_artifact_commits_once$/) | test(/^library_move::sequence_tests::activated_abort_abort$/) | test(/^library_move::sequence_tests::activated_abort_resume$/) | test(/^library_move::sequence_tests::activated_resume_abort$/) | test(/^library_move::sequence_tests::activated_resume_resume$/) | test(/^service::tests::additive_current_mutability_recovers_a_retained_install_and_survives_rollback$/))";
  const intelRelocationControlFilter =
    "package(portcove-core) & test(/^service::tests::publication_recovery_retains_conflicting_relocation_intent$/)";
  assert.deepEqual(overrideFor(intelObservedControlFilter, "x86_64-apple-darwin"), {
    platform: "x86_64-apple-darwin",
    filter: intelObservedControlFilter,
    "slow-timeout": { period: "5s", "terminate-after": 12, "grace-period": "0s" },
    "success-output": "immediate",
  });
  assert.deepEqual(overrideFor(intelRelocationControlFilter, "x86_64-apple-darwin"), {
    platform: "x86_64-apple-darwin",
    filter: intelRelocationControlFilter,
    "slow-timeout": { period: "5s", "terminate-after": 24, "grace-period": "0s" },
    "success-output": "immediate",
  });
  const linuxWholeProjectionFilter =
    "package(portcove-core) & test(/^definition_projection::tests::every_current_port_retains_exact_bytes_and_complete_validated_source_graph$/)";
  assert.deepEqual(overrideFor(linuxWholeProjectionFilter, "x86_64-unknown-linux-gnu"), {
    platform: "x86_64-unknown-linux-gnu",
    filter: linuxWholeProjectionFilter,
    "slow-timeout": { period: "5s", "terminate-after": 12, "grace-period": "0s" },
    "success-output": "immediate",
  });
  const windowsWholeMatrixFilter =
    "package(portcove-core) & (test(/^service::generated_cache_tests::generated_cache_unclaimed_outputs_hold_every_prewrite_data_route$/) | test(/^definition_projection::tests::every_current_port_retains_exact_bytes_and_complete_validated_source_graph$/))";
  const curatedInstalledWithdrawalFilter =
    "package(portcove-core) & (test(/^definition_repository::tests::publisher_policy_tests::curated_installed_withdrawal_allows_critical_verification_but_holds_fresh_acquisition$/) | test(/^definition_repository::tests::publisher_policy_tests::curated_installed_revocation_holds_critical_verification_and_fresh_acquisition$/))";
  const currentFullBaselineBudgets = [
    {
      platform: "x86_64-unknown-linux-gnu",
      filter:
        "package(portcove-core) & (test(/^definition_repository::tests::publisher_policy_tests::curated_retained_launch_withdrawal_supervises_exact_owned_child_after_reopen$/) | test(/^service::tests::backups::recovers_restore_prepared$/) | test(/^service::tests::backups::recovers_restore_published$/) | test(/^service::tests::backups::recovers_restore_version_synchronized$/) | test(/^service::tests::backups::restore_preserves_its_journal_when_a_retained_save_path_is_a_symlink$/))",
      periods: 12,
    },
    {
      platform: "x86_64-apple-darwin",
      filter:
        "package(portcove-core) & (test(/^definition_repository::tests::publisher_policy_tests::curated_installed_withdrawal_allows_critical_verification_but_holds_fresh_acquisition$/) | test(/^definition_repository::tests::publisher_policy_tests::curated_retained_launch_withdrawal_supervises_exact_owned_child_after_reopen$/) | test(/^definition_repository::tests::publisher_policy_tests::curated_rollback_withdrawal_permits_exact_retained_target$/) | test(/^definition_repository::tests::publisher_policy_tests::managed_ordinary_artifacts_and_compatible_correction_retain_exact_contract$/))",
      periods: 18,
    },
    {
      platform: "x86_64-apple-darwin",
      filter:
        "package(portcove-core) & (test(/^definition_repository::tests::publisher_policy_tests::curated_status_withdrawal_holds_acquisition_and_permits_retained_launch$/) | test(/^game_file_query::tests::late_channel_or_instance_drift_discards_the_private_refresh_result$/) | test(/^library_move::sequence_tests::published_resume_abort$/) | test(/^library_move::sequence_tests::published_resume_resume$/) | test(/^library_move::sequence_tests::verified_resume_resume$/) | test(/^output_relocation::tests::external_to_external_cleanup_recovers_after_authority_commit$/) | test(/^service::tests::successor_staged_and_rollback_versions_keep_exact_contracts$/))",
      periods: 12,
    },
    {
      platform: "x86_64-apple-darwin",
      filter:
        "package(portcove-cli) & binary(machine_contract) & test(/^game_file_query_uses_core_refresh_and_truthful_operation_events$/)",
      periods: 18,
    },
    {
      platform: "x86_64-unknown-linux-gnu",
      filter:
        "package(portcove-core) & test(/^catalog::tests::upstream_maintenance_status_does_not_reinterpret_existing_port_contracts$/)",
      periods: 12,
    },
    {
      platform: "x86_64-unknown-linux-gnu",
      filter:
        "package(portcove-core) & (test(/^definition_repository::tests::publisher_policy_tests::curated_installed_withdrawal_allows_critical_verification_but_holds_fresh_acquisition$/) | test(/^definition_repository::tests::publisher_policy_tests::curated_installed_revocation_holds_critical_verification_and_fresh_acquisition$/))",
      periods: 12,
    },
    {
      platform: "aarch64-apple-darwin",
      filter:
        "package(portcove-core) & test(/^catalog::tests::upstream_maintenance_status_does_not_reinterpret_existing_port_contracts$/)",
      periods: 12,
    },
    {
      platform: "aarch64-apple-darwin",
      filter:
        "package(portcove-core) & (test(/^definition_repository::tests::publisher_policy_tests::curated_installed_withdrawal_allows_critical_verification_but_holds_fresh_acquisition$/) | test(/^definition_repository::tests::publisher_policy_tests::curated_installed_revocation_holds_critical_verification_and_fresh_acquisition$/))",
      periods: 12,
    },
    {
      platform: "x86_64-apple-darwin",
      filter:
        "package(portcove-core) & test(/^catalog::tests::upstream_maintenance_status_does_not_reinterpret_existing_port_contracts$/)",
      periods: 36,
    },
    {
      platform: "x86_64-apple-darwin",
      filter:
        "package(portcove-core) & (test(/^service::tests::backups::recovers_restore_prepared$/) | test(/^service::tests::backups::recovers_restore_published$/) | test(/^definition_repository::tests::publisher_policy_tests::curated_adoption_prepared_revocation_preserves_evidence$/) | test(/^import_execution::tests::import_round_trip_preserves_versions_pointers_payloads_and_history_in_an_empty_library$/))",
      periods: 12,
    },
  ];
  for (const { platform, filter, periods } of currentFullBaselineBudgets)
    assert.deepEqual(overrideFor(filter, platform), {
      platform,
      filter,
      "slow-timeout": { period: "5s", "terminate-after": periods, "grace-period": "0s" },
      "success-output": "immediate",
    });
  const historicalByteOnlyBackupFilter =
    "package(portcove-core) & test(/^service::tests::backups::historical_byte_only_backup_keeps_its_existing_integrity_contract$/)";
  const windowsRestoreSynchronizedFilter =
    "package(portcove-core) & test(/^service::tests::backups::recovers_restore_version_synchronized$/)";
  assert.deepEqual(overrideFor(windowsRestoreSynchronizedFilter, "x86_64-pc-windows-msvc"), {
    platform: "x86_64-pc-windows-msvc",
    filter: windowsRestoreSynchronizedFilter,
    "slow-timeout": { period: "5s", "terminate-after": 18, "grace-period": "0s" },
    "success-output": "immediate",
  });
  const windowsSelectedPlayerDiagnosticFilter =
    "package(portcove-core) & (test(/^catalog::tests::upstream_maintenance_status_does_not_reinterpret_existing_port_contracts$/) | test(/^game_file_query::tests::cancellation_after_inspection_waits_for_the_actual_blocking_refresh_worker$/))";
  const windowsSelectedPlayerDiagnostic = overrideFor(
    windowsSelectedPlayerDiagnosticFilter,
    "x86_64-pc-windows-msvc",
  );
  assert.deepEqual(windowsSelectedPlayerDiagnostic, {
    platform: "x86_64-pc-windows-msvc",
    filter: windowsSelectedPlayerDiagnosticFilter,
    "slow-timeout": { period: "5s", "terminate-after": 24, "grace-period": "0s" },
    "success-output": "immediate",
  });
  assert.ok(
    overrides.indexOf(windowsSelectedPlayerDiagnostic) <
      overrides.indexOf(
        overrideFor(
          "package(portcove-core) & (test(/^catalog::tests::upstream_maintenance_status_does_not_reinterpret_existing_port_contracts$/) | test(/^service::tests::successor_staged_and_rollback_versions_keep_exact_contracts$/))",
          "x86_64-pc-windows-msvc",
        ),
      ),
    "The exact120s catalog identity must precede its60s family",
  );
  const windowsCopyingResumeFilter =
    "package(portcove-core) & test(/^library_move::sequence_tests::copying_resume_resume$/)";
  assert.deepEqual(overrideFor(windowsCopyingResumeFilter, "x86_64-pc-windows-msvc"), {
    platform: "x86_64-pc-windows-msvc",
    filter: windowsCopyingResumeFilter,
    "slow-timeout": { period: "5s", "terminate-after": 12, "grace-period": "0s" },
    "success-output": "immediate",
  });
  const windowsLifecycleFilters = [
    "package(portcove-core) & test(/^service::tests::unavailable_artwork_does_not_block_reviewed_install_update_or_supervised_launch$/)",
    "package(portcove-core) & test(/^service::tests::additive_current_mutability_recovers_a_retained_install_and_survives_rollback$/)",
    "package(portcove-core) & test(/^service::tests::publication_recovery_retains_foreign_install_and_adoption_owners_in_every_phase$/)",
    "package(portcove-core) & test(/^service::tests::unpublished_install_cleanup_retains_conflicting_family_intent$/)",
    historicalByteOnlyBackupFilter,
    "package(portcove-core) & test(/^definition_repository::tests::publisher_policy_tests::curated_cache_reuse_refuses_corruption_and_preserves_capacity_evidence$/)",
    "package(portcove-core) & (test(/^service::tests::backups::recovers_restore_prepared$/) | test(/^service::tests::backups::recovers_restore_published$/) | test(/^service::tests::backups::restore_remains_authoritative_after_launch_rollback_and_staged_activation$/))",
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
    "package(portcove-core) & (test(/^catalog::tests::upstream_maintenance_status_does_not_reinterpret_existing_port_contracts$/) | test(/^service::tests::successor_staged_and_rollback_versions_keep_exact_contracts$/))",
    "package(portcove-core) & (test(/^library_move::sequence_tests::activated_abort_abort$/) | test(/^library_move::sequence_tests::verified_resume_resume$/) | test(/^library_move::sequence_tests::verified_resume_abort$/) | test(/^library_move::sequence_tests::activated_resume_abort$/) | test(/^library_move::sequence_tests::verified_abort_resume$/) | test(/^library_move::sequence_tests::activated_abort_resume$/))",
    "package(portcove-core) & test(/^service::runtime_tests::reflectionhle_progression::reflectionhle_progression_(2683|2684|2685|2686|2687|2688|2689|2690|2692)$/)",
    "package(portcove-core) & (test(/^output_relocation::tests::external_cleanup_preserves_unowned_sibling_after_authority_commit$/) | test(/^library_move::sequence_tests::copying_resume_abort$/) | test(/^output_relocation::tests::external_to_external_cleanup_recovers_after_authority_commit$/))",
  ];
  const replacementDownloadFilter =
    "package(portcove-core) & test(/^service::catalog_download::tests::replacement_download_keeps_current_registration_until_reviewed_relink$/)";
  const psxProgressionFilter =
    "package(portcove-core) & test(/^service::runtime_tests::psx_progression::(unchanged_psx_definition_completes_provider_install_and_update_with_registered_inputs|retained_direct_psx_runtime_updates_through_current_provider_without_rewriting_contract)$/)";
  const namedSaveRestoreFilter =
    "package(portcove-core) & test(/^service::runtime_tests::named_save_restore_updates_every_version_and_preserves_import_policy$/)";
  const sourcePreparationFilter =
    "package(portcove-core) & (test(/^preparation::source::tests::source_only_fresh_install_rechecks_original_before_rename$/) | test(/^preparation::source::tests::source_only_fresh_install_rechecks_original_before_registration$/) | test(/^preparation::source::tests::source_only_gamecube_install_seals_the_nested_iso$/) | test(/^preparation::source::tests::source_only_directory_install_survives_two_launches_and_full_verify$/) | test(/^preparation::source::tests::source_only_zip_install_survives_two_launches_and_full_verify$/) | test(/^preparation::source::tests::source_only_review_repairs_historical_extras_but_refuses_unrelated_changes$/) | test(/^preparation::source::tests::source_only_recovery_refuses_original_changes_before_publication$/) | test(/^preparation::source::tests::native6_flat_directory_originals_survive_launch_and_full_verify$/) | test(/^preparation::source::tests::native6_flat_zip_originals_survive_launch_and_full_verify$/) | test(/^preparation::source::tests::native6_wrapped_directory_originals_survive_launch_and_full_verify$/) | test(/^preparation::source::tests::native6_wrapped_zip_originals_survive_launch_and_full_verify$/) | test(/^preparation::source::tests::native6_wrapped_installed_preparation_preserves_unprepared_runtime$/) | test(/^preparation::source::tests::native6_wrapped_publication_rechecks_original_before_rename_and_registration$/) | test(/^preparation::source::tests::native6_mixed_sets_and_same_profile_edition_replacement_cannot_reprepare_player_data$/) | test(/^preparation::source::tests::native6_removal_preserves_profile_and_external_originals$/) | test(/^preparation::source::tests::native6_late_canonical_data_holds_publication_and_already_renamed_recovery$/) | test(/^preparation::source::tests::native6_late_no_active_profile_data_holds_staged_activation$/) | test(/^preparation::source::tests::native6_late_canonical_originals_hold_staged_activation$/) | test(/^preparation::source::tests::native6_late_ordinary_profile_data_restores_on_unix$/) | test(/^preparation::source::tests::native6_authenticated_active_import_and_backup_restore_preserve_source_and_profile$/) | test(/^preparation::source::tests::native6_same_source_stage_activate_and_rollback_preserve_current_profile_and_hold_remapping$/) | test(/^preparation::source::tests::native6_unadmitted_raw_import_refuses_before_destination_mutation$/))";
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
  const intelFullControlBudgets = [
    {
      filter:
        "package(portcove-core) & (test(/^catalog_update::tests::catalog_status_verifies_each_cached_candidate_once_per_snapshot$/) | test(/^definition_repository::tests::publisher_policy_tests::curated_adoption_published_refuses_unsupported_grant$/) | test(/^definition_repository::tests::publisher_policy_tests::curated_install_prepared_revocation_preserves_owned_payload$/) | test(/^definition_repository::tests::publisher_policy_tests::curated_publication_recovery_published_withdrawal_preserves_payload$/) | test(/^definition_repository::tests::publisher_policy_tests::curated_publication_recovery_revocation_preserves_private_payload$/) | test(/^definition_repository::tests::publisher_policy_tests::curated_publication_recovery_withdrawal_preserves_private_payload$/) | test(/^library_move::sequence_tests::copying_resume_abort$/) | test(/^library_move::sequence_tests::published_abort_resume$/))",
      periods: 12,
    },
    {
      filter:
        "package(portcove-core) & (test(/^artwork_tests::local_artwork_writers_share_the_same_library_lock$/) | test(/^catalog_update::tests::rollback_keeps_the_replay_floor$/) | test(/^definition_repository::tests::publisher_policy_tests::curated_install_prepared_withdrawal_preserves_owned_payload$/) | test(/^library_move::sequence_tests::verified_resume_abort$/) | test(/^output_relocation::tests::external_cleanup_preserves_unowned_sibling_after_authority_commit$/) | test(/^service::generated_cache_tests::generated_cache_unclaimed_outputs_hold_every_prewrite_data_route$/))",
      periods: 12,
    },
    {
      filter:
        "package(portcove-core) & (test(/^definition_repository::tests::publisher_policy_tests::curated_activation_recovery_withdrawal_permits_local_commit$/) | test(/^definition_repository::tests::publisher_policy_tests::curated_installed_revocation_holds_critical_verification_and_fresh_acquisition$/))",
      periods: 24,
    },
    {
      filter:
        "package(portcove-cli) & binary(machine_contract) & (test(/^artwork_contract::artwork_cli_keeps_cover_and_detail_independent_through_the_local_lifecycle$/) | test(/^retained_build_contract::retained_build_reference_roundtrip_binds_exact_bytes_and_keeps_missing_reference$/))",
      periods: 12,
    },
  ];
  const intelRetainedContractBudgets = [
    {
      filter:
        "package(portcove-core) & test(/^service::tests::backups::current_persistence_cannot_restore_an_unmanifested_companion_into_lifecycle_paths$/)",
      periods: 12,
    },
    {
      filter:
        "package(portcove-core) & test(/^service::tests::authenticated_admission_survives_staging_rollback_activation_and_refresh$/)",
      periods: 18,
    },
  ];
  const olderIntelRetainedLifecycle = intelObservedLifecycle[0];
  assert.ok(olderIntelRetainedLifecycle);
  for (const [index, { filter, periods }] of intelRetainedContractBudgets.entries()) {
    const observed = overrideFor(filter, "x86_64-apple-darwin");
    assert.deepEqual(observed, {
      platform: "x86_64-apple-darwin",
      filter,
      "slow-timeout": { period: "5s", "terminate-after": periods, "grace-period": "0s" },
      "success-output": "immediate",
    });
    assert.equal(overrides.indexOf(observed), intelFullControlBudgets.length + index);
    assert.ok(
      overrides.indexOf(observed) <
        overrides.indexOf(overrideFor(olderIntelRetainedLifecycle.filter, "x86_64-apple-darwin")),
      "Exact retained-contract budgets precede the older overlapping Intel60s group",
    );
  }
  const windowsReviewedPreparationFilter =
    "package(portcove-cli) & binary(machine_contract) & test(/^preparation_contract::reviewed_preparation_runs_through_jsonl_and_a_fresh_cli_plays_without_setup$/)";
  assert.deepEqual(overrideFor(windowsReviewedPreparationFilter, "x86_64-pc-windows-msvc"), {
    platform: "x86_64-pc-windows-msvc",
    filter: windowsReviewedPreparationFilter,
    "slow-timeout": { period: "5s", "terminate-after": 12, "grace-period": "0s" },
    "success-output": "immediate",
  });
  const windowsRetainedQueryAndResumeFilter =
    "package(portcove-core) & (test(/^game_file_query::tests::retained_launch_uses_verified_platform_and_marks_unreadable_context_unavailable$/) | test(/^library_move::sequence_tests::published_resume_resume$/) | test(/^library_move::sequence_tests::activated_resume_resume$/) | test(/^library_move::sequence_tests::published_resume_abort$/))";
  assert.deepEqual(overrideFor(windowsRetainedQueryAndResumeFilter, "x86_64-pc-windows-msvc"), {
    platform: "x86_64-pc-windows-msvc",
    filter: windowsRetainedQueryAndResumeFilter,
    "slow-timeout": { period: "5s", "terminate-after": 12, "grace-period": "0s" },
    "success-output": "immediate",
  });
  const windowsSuccessorMoveFilter =
    "package(portcove-core) & test(/^library_move::tests::admitted_post_client_definition_survives_interrupted_move_resume$/)";
  assert.deepEqual(overrideFor(windowsSuccessorMoveFilter, "x86_64-pc-windows-msvc"), {
    platform: "x86_64-pc-windows-msvc",
    filter: windowsSuccessorMoveFilter,
    "slow-timeout": { period: "5s", "terminate-after": 12, "grace-period": "0s" },
    "success-output": "immediate",
  });
  const windowsPublishedMoveFilter =
    "package(portcove-core) & (test(/^library_move::sequence_tests::published_abort_resume$/) | test(/^library_move::sequence_tests::published_resume_resume$/))";
  const windowsObservedRecoveryBudgets = [
    {
      filter:
        "package(portcove-core) & test(/^service::tests::backups::recovers_restore_published$/)",
      periods: 24,
      beforeFilter:
        "package(portcove-core) & (test(/^service::tests::backups::recovers_restore_prepared$/) | test(/^service::tests::backups::recovers_restore_published$/) | test(/^service::tests::backups::restore_remains_authoritative_after_launch_rollback_and_staged_activation$/))",
    },
    {
      filter:
        "package(portcove-core) & test(/^service::native_portable::tests::ready_staged_archive_preserves_preplay_data_and_successor_cache_defaults$/)",
      periods: 24,
      beforeFilter: "package(portcove-core) & test(/^service::native_portable::tests::/)",
    },
    {
      filter:
        "package(portcove-core) & test(/^service::native_portable::tests::ready_archive_profile_times_survive_update_backup_and_runtime_rollback$/)",
      periods: 36,
      beforeFilter: "package(portcove-core) & test(/^service::native_portable::tests::/)",
    },
    {
      filter:
        "package(portcove-core) & test(/^service::tests::backups::recovers_restore_prepared$/)",
      periods: 24,
      beforeFilter:
        "package(portcove-core) & (test(/^service::tests::backups::recovers_restore_prepared$/) | test(/^service::tests::backups::recovers_restore_published$/) | test(/^service::tests::backups::restore_remains_authoritative_after_launch_rollback_and_staged_activation$/))",
    },
  ];
  const windowsTrackedCancellationFilter =
    "package(portcove-core) & test(/^game_file_query::tests::tracked_refresh_settles_cancellation_only_after_worker_exit$/)";
  const outputIdentity = (value: Readonly<Record<string, unknown>>) =>
    JSON.stringify([value.platform ?? null, value.filter]);
  const intelRecoveryFilter =
    "package(portcove-core) & (test(/^catalog_update::tests::refused_artwork_only_commit_reopens_prior_mapping_and_local_choice_then_retries$/) | test(/^service::tests::publication_recovery_retains_conflicting_(quarantine|relocation|source_import|original_paths)_intent$/))";
  assert.deepEqual(
    outputOverrides.map(outputIdentity).sort(),
    [
      ...windowsLifecycleFilters.map((filter) => ({ platform: "x86_64-pc-windows-msvc", filter })),
      ...windowsObservedRecoveryBudgets.map(({ filter }) => ({
        platform: "x86_64-pc-windows-msvc",
        filter,
      })),
      { platform: "x86_64-pc-windows-msvc", filter: windowsRestoreSynchronizedFilter },
      { platform: "x86_64-pc-windows-msvc", filter: windowsSelectedPlayerDiagnosticFilter },
      { platform: "x86_64-pc-windows-msvc", filter: windowsCopyingResumeFilter },
      ...currentFullBaselineBudgets.map(({ platform, filter }) => ({ platform, filter })),
      { platform: "x86_64-pc-windows-msvc", filter: windowsTrackedCancellationFilter },
      { platform: "x86_64-pc-windows-msvc", filter: windowsPublishedMoveFilter },
      { platform: "x86_64-pc-windows-msvc", filter: windowsSuccessorMoveFilter },
      { platform: "x86_64-pc-windows-msvc", filter: windowsRetainedQueryAndResumeFilter },
      ...intelFullControlBudgets.map(({ filter }) => ({ platform: "x86_64-apple-darwin", filter })),
      ...intelRetainedContractBudgets.map(({ filter }) => ({
        platform: "x86_64-apple-darwin",
        filter,
      })),
      ...publicationFilters,
      { filter: sourcePreparationFilter },
      ...immutableArchiveOverrides.map(({ filter }) => ({ filter })),
      { platform: "x86_64-unknown-linux-gnu", filter: linuxLifecycleFilter },
      { platform: "x86_64-unknown-linux-gnu", filter: linuxWholeProjectionFilter },
      { platform: "x86_64-apple-darwin", filter: intelObservedControlFilter },
      { platform: "x86_64-apple-darwin", filter: intelRelocationControlFilter },
      { platform: "x86_64-apple-darwin", filter: intelPreparationFilter },
      { platform: "x86_64-apple-darwin", filter: intelRecoveryFilter },
      ...intelObservedLifecycle.map(({ filter }) => ({ platform: "x86_64-apple-darwin", filter })),
      { platform: "x86_64-pc-windows-msvc", filter: observedCoreFilter },
      { platform: "x86_64-pc-windows-msvc", filter: observedCliFilter },
      { platform: "x86_64-pc-windows-msvc", filter: windowsWholeMatrixFilter },
      { platform: "x86_64-pc-windows-msvc", filter: curatedInstalledWithdrawalFilter },
      { platform: "x86_64-pc-windows-msvc", filter: replacementDownloadFilter },
      { platform: "x86_64-pc-windows-msvc", filter: namedSaveRestoreFilter },
      { platform: "x86_64-pc-windows-msvc", filter: psxProgressionFilter },
      { platform: "x86_64-pc-windows-msvc", filter: windowsPreparationAndDriftFilter },
      { platform: "x86_64-pc-windows-msvc", filter: windowsDiagnosticsFilter },
      { platform: "x86_64-pc-windows-msvc", filter: windowsRelocationRecoveryFilter },
      { platform: "x86_64-pc-windows-msvc", filter: windowsSourceImportRecoveryFilter },
      { platform: "x86_64-pc-windows-msvc", filter: windowsRetainedMovePolicyFilter },
      { platform: "x86_64-pc-windows-msvc", filter: windowsReviewedPreparationFilter },
      { platform: "x86_64-unknown-linux-gnu", filter: linuxRelocationRecoveryFilter },
    ]
      .map(outputIdentity)
      .sort(),
  );
  assert.deepEqual(overrideFor(windowsPublishedMoveFilter, "x86_64-pc-windows-msvc"), {
    platform: "x86_64-pc-windows-msvc",
    filter: windowsPublishedMoveFilter,
    "slow-timeout": { period: "5s", "terminate-after": 12, "grace-period": "0s" },
    "success-output": "immediate",
  });
  for (const { filter, periods, beforeFilter } of windowsObservedRecoveryBudgets) {
    const observed = overrideFor(filter, "x86_64-pc-windows-msvc");
    assert.deepEqual(observed, {
      platform: "x86_64-pc-windows-msvc",
      filter,
      "slow-timeout": { period: "5s", "terminate-after": periods, "grace-period": "0s" },
      "success-output": "immediate",
    });
    assert.ok(
      overrides.indexOf(observed) <
        overrides.indexOf(overrideFor(beforeFilter, "x86_64-pc-windows-msvc")),
      "Exact observed Windows cases precede their overlapping Windows family budgets",
    );
    assert.equal(overrides.filter((entry) => entry.filter === filter).length, 1);
  }
  assert.deepEqual(overrideFor(windowsTrackedCancellationFilter, "x86_64-pc-windows-msvc"), {
    platform: "x86_64-pc-windows-msvc",
    filter: windowsTrackedCancellationFilter,
    "slow-timeout": { period: "5s", "terminate-after": 18, "grace-period": "0s" },
    "success-output": "immediate",
  });
  for (const { filter, periods } of intelFullControlBudgets) {
    const observed = overrideFor(filter, "x86_64-apple-darwin");
    assert.deepEqual(observed, {
      platform: "x86_64-apple-darwin",
      filter,
      "slow-timeout": { period: "5s", "terminate-after": periods, "grace-period": "0s" },
      "success-output": "immediate",
    });
    assert.ok(
      overrides.indexOf(observed) < intelFullControlBudgets.length,
      "New exact Intel cases precede older overlapping budgets",
    );
    assert.equal(overrides.filter((entry) => entry.filter === filter).length, 1);
  }
  for (const filter of [curatedInstalledWithdrawalFilter, windowsWholeMatrixFilter])
    assert.deepEqual(overrideFor(filter, "x86_64-pc-windows-msvc"), {
      platform: "x86_64-pc-windows-msvc",
      filter,
      "slow-timeout": { period: "5s", "terminate-after": 12, "grace-period": "0s" },
      "success-output": "immediate",
    });
  assert.ok(
    overrides.indexOf(overrideFor(intelRelocationControlFilter, "x86_64-apple-darwin")) <
      overrides.indexOf(overrideFor(intelRecoveryFilter, "x86_64-apple-darwin")),
    "The exact120s relocation identity must precede its60s family",
  );
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
  const retainedLinux = overrideFor(
    "package(portcove-core) & (test(/^service::tests::external_source_representation_uses_retained_contract_without_changing_source_health$/) | test(/^service::tests::authenticated_admission_survives_staging_rollback_activation_and_refresh$/))",
    "x86_64-unknown-linux-gnu",
  );
  assert.deepEqual(retainedLinux["slow-timeout"], {
    period: "5s",
    "terminate-after": 12,
    "grace-period": "0s",
  });
  for (const field of [
    "retries",
    "threads-required",
    "priority",
    "default-filter",
    "success-output",
  ])
    assert.equal(retainedLinux[field], undefined);
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
      overrides.indexOf(override) < overrides.indexOf(overrideFor(historicalByteOnlyBackupFilter)),
    );
  }
  const ninetySecondWindowsLifecycles = new Set([
    "package(portcove-core) & test(/^service::tests::authenticated_admission_survives_staging_rollback_activation_and_refresh$/)",
    "package(portcove-core) & test(/^service::runtime_tests::reflectionhle_progression::reflectionhle_progression_(2683|2684|2685|2686|2687|2688|2689|2690|2692)$/)",
  ]);
  for (const filter of windowsLifecycleFilters) {
    const override = overrideFor(filter, "x86_64-pc-windows-msvc");
    assert.equal(override.platform, "x86_64-pc-windows-msvc");
    assert.equal(override["success-output"], "immediate");
    assert.deepEqual(override["slow-timeout"], {
      period: "5s",
      "terminate-after": ninetySecondWindowsLifecycles.has(filter) ? 18 : 12,
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
  for (const filter of [
    replacementDownloadFilter,
    namedSaveRestoreFilter,
    psxProgressionFilter,
    windowsPreparationAndDriftFilter,
    windowsDiagnosticsFilter,
  ]) {
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
