import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { expect, it } from "vite-plus/test";

// A new Tauri command that the Desktop app calls must be answered by the
// interactive fixture transport, or the browser suites that mount the app fail
// with "Unsupported fixture action" minutes into hosted CI. This guard catches
// that disagreement at unit-test speed.

const srcRoot = fileURLToPath(new URL("../../", import.meta.url));
const transportPath = fileURLToPath(new URL("./transport.ts", import.meta.url));

// Commands the app can call that the fixture transport does not answer. Each
// group shares one reviewed reason; reaching one of these in a fixture refuses
// visibly with "Unsupported fixture action" instead of faking native state.
// A command the app calls on mount (or in any flow the browser suites exercise)
// must NOT be listed here: give it a handler in transport.ts.
const unsupportedByReason: Record<string, string[]> = {
  "mutation or native action the fixtures do not model; they never change the host": `
    acquire_game_update activate_port add_game_file_root add_source adopt_port
    apply_catalog_update apply_game_setting apply_game_update apply_steam_batch_add
    apply_steam_entry begin_github_device_login cancel_application_update_check
    change_to_managed_runtime clear_host_tool_path
    complete_application_update_production_transition create_backup
    create_support_bundle delete_backup discard_game_update_acquisition
    dismiss_application_update_notice download_application_update
    download_catalog_package export_library_metadata forget_pending_setup
    import_artwork import_library import_source install_port logout_github
    move_library open_bug_report open_external_url open_host_tool_official_site
    open_manual_setup_folder open_pending_setup_folder open_source_evidence
    open_source_inbox open_support_report_folder open_user_data
    poll_github_device_login recheck_host_tool
    recover_application_update_preferences recover_application_update_state
    recover_ghostship_legacy_data recover_library_import refresh_game_file_query
    refresh_official_definition register_external_runtime
    register_user_selected_runtime relink_external_runtime relink_game_file_root
    relink_source relink_user_selected_runtime relocate_output
    remove_external_runtime remove_game_file_root remove_port remove_source
    reset_application_update_preferences reset_artwork reset_output_location
    restart_to_apply_application_update restore_backup revoke_catalog_key
    rollback_catalog rollback_port set_application_update_preferences set_channel
    set_default_library set_github_token set_host_tool_path set_locale_preference
    set_output_location set_policy trust_catalog_key use_cached_catalog
    use_embedded_catalog verify_port verify_sources
  `.split(/\s+/),
  "review, plan or inspection step of a user-started flow the fixtures do not mount": `
    catalog_download_candidates check_definition_capabilities check_installed
    check_port discover_setup_launch_targets discover_sources inspect_source
    inspect_source_intake plan_catalog_update plan_game_update
    plan_game_update_acquisition plan_ghostship_legacy_recovery plan_library_import
    plan_library_move plan_output_relocation plan_port plan_source_import
    plan_source_relink preview_adoption preview_backup_action preview_bug_report
    preview_catalog_download preview_external_removal preview_external_runtime
    preview_external_runtime_relink preview_managed_route_change preview_removal
    preview_source_removal preview_steam_batch_add preview_steam_entry
    preview_user_selected_runtime preview_user_selected_runtime_relink
    review_game_setting review_source_reuse scan_game_file_roots scan_source_inbox
  `.split(/\s+/),
  "read-only getter that the mounted fixture surfaces do not request, or a user-started flow they do not mount":
    `
    get_catalog_media_thumbnail get_default_library_root get_game_settings
    get_library_identity list_steam_profiles
  `.split(/\s+/),
};
const intentionallyUnsupported: Record<string, string> = Object.fromEntries(
  Object.entries(unsupportedByReason).flatMap(([reason, names]) =>
    names.filter(Boolean).map((name) => [name, reason] as const),
  ),
);

const sourceFiles = (directory: string): string[] =>
  readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = `${directory}${entry.name}`;
    if (entry.isDirectory()) return sourceFiles(`${path}/`);
    return /\.tsx?$/.test(entry.name) && !/\.(test|browser\.test)\.tsx?$/.test(entry.name)
      ? [path]
      : [];
  });

/** Every literal command name passed to `invoke(...)` by Desktop production code. */
function appCommands(): Set<string> {
  const commands = new Set<string>();
  for (const file of sourceFiles(srcRoot)) {
    const source = readFileSync(file, "utf8");
    // `invoke("name"` and `invoke<Result>("name"`; the generic may span `import("./x")`.
    const named = [...source.matchAll(/\binvoke\b(?:<[\s\S]{0,300}?>)?\s*\(\s*"([\w:|]+)"/g)];
    const calls = [...source.matchAll(/\binvoke\s*[<(]/g)];
    // A call whose command is not a string literal would escape this guard.
    expect(
      named.length,
      `${file}: every invoke(...) call must name its command with a string literal so the fixture coverage guard can see it`,
    ).toBe(calls.length);
    for (const match of named) commands.add(match[1]!);
  }
  return commands;
}

/** The command names registered in the fixture's `handlers` table. */
function fixtureCommands(): Set<string> {
  const source = readFileSync(transportPath, "utf8");
  const start = source.indexOf("const handlers: Record<string,");
  const end = source.indexOf("\n  };\n", start);
  expect(
    start,
    "transport.ts no longer declares `const handlers: Record<string, ...>`",
  ).toBeGreaterThan(-1);
  expect(end).toBeGreaterThan(start);
  const table = source.slice(start, end);
  // Handler keys sit at the table's own indentation, either bare or quoted.
  return new Set([...table.matchAll(/^ {4}(?:"([^"]+)"|(\w+)): /gm)].map((m) => m[1] ?? m[2]!));
}

it("answers or explicitly refuses every command the Desktop app can invoke", () => {
  const commands = appCommands();
  const handled = fixtureCommands();
  expect(commands.size, "found no invoke() commands; the extraction is broken").toBeGreaterThan(50);
  expect(handled.size, "found no fixture handlers; the extraction is broken").toBeGreaterThan(20);

  const missing = [...commands]
    .filter((command) => !handled.has(command) && !(command in intentionallyUnsupported))
    .sort();
  expect(
    missing,
    `The interactive fixture does not know ${missing.length === 1 ? "this command" : "these commands"}: ${missing.join(", ")}. ` +
      "The app would throw `Unsupported fixture action` on mount in the browser tests. " +
      "Add a handler in apps/desktop/src/dev-scenarios/interactive/transport.ts, " +
      "or add the command with a one-line reason to `intentionallyUnsupported` in " +
      "apps/desktop/src/dev-scenarios/interactive/transport-coverage.test.ts.",
  ).toEqual([]);
});

it("keeps the intentionally unsupported list current", () => {
  const commands = appCommands();
  const handled = fixtureCommands();
  for (const [command, reason] of Object.entries(intentionallyUnsupported)) {
    expect(reason.length, `${command} needs a reason`).toBeGreaterThan(0);
    expect(commands.has(command), `${command} is no longer invoked by the app; remove it`).toBe(
      true,
    );
    expect(
      handled.has(command),
      `${command} now has a fixture handler; remove it from the list`,
    ).toBe(false);
  }
});
