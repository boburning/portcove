/** Supplied presentation data only. These records never enter Core or grant support. */
export function secondaryPanelFixtures(portId: string, root: string, installId: string) {
  const sha = "a".repeat(64);
  const setupId = "owned-presentation-setup";
  const modName = "Owned presentation mod with a deliberately long file name.o2r";
  const binding = {
    requirement_id: "owned-original",
    sha256: sha,
    size: 4,
    storage_sha256: sha,
    storage_size: 4,
  };
  const build = {
    port_id: portId,
    install_id: installId,
    artifact: { asset_name: "owned-presentation-runtime.zip", size: 4, sha256: sha },
    platform: "windows-x86-64",
    selected_executable: "owned-presentation.exe",
    manifest_sha256: sha,
    installed_contract_sha256: sha,
    definition: null,
    runtime: null,
  };
  const revision = {
    profile_id: setupId,
    revision: 2,
    parent_revision: 1,
    created_at: 1,
    digest: sha,
    save_group: "owned-presentation-progress",
    build,
    originals: [binding],
    packages: [],
    orderings: [],
    limits: ["Supplied native presentation fixture; no runtime or original-file observation."],
  };
  const mods = {
    port_id: portId,
    supported: true,
    current_install_id: installId,
    package_types: ["o2r"],
    later_mods_take_priority: true,
    provider: "gamebanana",
    progress_copy_supported: false,
    held_updates: [],
    last_automatic_checks: [],
    inventory: {
      port_id: portId,
      profiles: [
        {
          profile: {
            id: setupId,
            port_id: portId,
            display_name: "Owned presentation setup",
            is_default: false,
            current_revision: 2,
            created_at: 1,
            updated_at: 1,
            intent: { update_policy: "review_updates", requested_packages: [] },
          },
          revision,
          build_availability: "verified",
          build_version: "1.0-presentation",
          originals: [{ binding, availability: "missing" }],
        },
      ],
    },
    live: {
      profile_id: setupId,
      revision: 2,
      unmanaged: [] as string[],
      changed_owned: [],
      native_list: { state: "in-sync" },
    },
  };
  const original = {
    embedded: false,
    current_instance_id: "owned-original-current",
    current_path: `${root}/original no longer available.z64`,
    instances: [
      {
        instance_id: "owned-original-alternative",
        path: `${root}/other registered original with a long readable name.z64`,
        binding,
      },
    ],
    source_profile: {
      id: "owned-original",
      label: "Owned presentation original",
      kind: "file",
      accepted_extensions: ["z64"],
      accepted_sha1: [],
      accepted_sha256: [],
      disc: null,
      members: [],
      variants: [],
    },
  };
  const retained = { revision: 1, superseded_at: 1, build };
  const recovery = [{ availability: "verified", gap: null, install: null, revision: retained }];
  const retirement = {
    setup_id: setupId,
    revision: retained,
    preview_sha256: sha,
    reference: {
      id: setupId,
      setup_id: setupId,
      revision: 2,
      build,
      history: [retained],
      created_at: 1,
      updated_at: 1,
    },
  };
  const preservation = {
    port_id: portId,
    profile_id: setupId,
    revision: 2,
    file_name: modName,
    observed: { sha256: sha, size: 2048 },
    restore: null,
    plan_sha256: sha,
    revision_sha256: sha,
    slot: 1,
  };
  const recipe = {
    can_apply: false,
    install_id: installId,
    plan_sha256: sha,
    acquisitions: [],
    code_approval: [],
    holds: ["Owned presentation recipe needs an exact provider file before it can be applied."],
    originals: [],
    packages: [{ name: modName, status: "unavailable", detail: "Supplied provider review." }],
    provider_checks: [modName],
    runtime: {
      name: "Owned presentation runtime",
      status: "available",
      detail: "Supplied review.",
    },
    recipe: {
      format: 1,
      port_id: portId,
      identity_sha256: sha,
      runtime: {
        platform: "windows-x86-64",
        artifact: build.artifact,
        runtime: null,
        definition: null,
        installed_contract_sha256: sha,
      },
      loader: null,
      originals: [],
      packages: [
        {
          native_id: modName,
          enabled: true,
          native_version: null,
          sha256: sha,
          size: 2048,
          requires: [],
          provider: { provider: "gamebanana", project: "42", file: "10" },
        },
      ],
      orderings: [],
      uncaptured: ["Supplied native presentation fixture."],
    },
  };
  const file = {
    file_id: "10",
    file_name: "owned-presentation-provider-package.zip",
    size: 4096,
    added_at: 1,
    download_url: "",
    claimed_md5: null,
    claimed_scan: "unknown",
    archived: false,
  };
  const project = {
    provider: "gamebanana",
    project_id: "42",
    game_id: "owned-presentation-game",
    name: "Owned presentation provider project with a long name",
    version: "1.0-presentation",
    updated_at: 1,
    obsolete: false,
    profile_url: "",
    submitter: null,
    files: [file],
    unreadable_files: 1,
  };
  const providerPage = {
    port_id: portId,
    game_name: "Owned presentation game",
    provider: "gamebanana",
    page: { projects: [project], total: 1, page: 1, complete: true },
    last_page: 1,
    other_game_records: 0,
    observed_at: 1,
    freshness: "fresh",
  };
  const providerProject = {
    port_id: portId,
    game_name: "Owned presentation game",
    project,
    observed_at: 1,
    freshness: "fresh",
  };
  const providerPlan = {
    port_id: portId,
    profile_id: setupId,
    project_name: project.name,
    file,
    provider: { provider: "gamebanana", project: "42", file: "10" },
    expected_revision: 2,
    download_size: 4096,
    download_sha256: sha,
    ignored_entries: 1,
    conflicts_truncated: false,
    members: [
      {
        file_name: modName,
        sha256: sha,
        size: 2048,
        asset_count: 1,
        missing_required_mods: [],
        needs_code_permission: false,
      },
    ],
    replaces: [],
    conflicts: [],
    unverified_claims: ["All provider observations in this review are supplied fixtures."],
    plan_sha256: sha,
    wrappers: [],
  };
  const identity = {
    port_id: portId,
    contract_id: "owned-presentation-save-contract",
    version: "1.0-presentation",
    platform: "windows-x86-64",
  };
  const save = { path: "Save/owned-presentation.sav", size: 2048, sha256: sha };
  const portableExport = {
    port_id: portId,
    identity,
    files: [save],
    stays_local: [
      { path: "owned-device-settings.json", role: "device-configuration", directory: false },
    ],
    content_sha256: sha,
    base_sha256: null,
    blockers: [],
  };
  const portableImport = {
    port_id: portId,
    source: { ...identity, platform: "linux-x86-64" },
    destination: identity,
    relation: "diverged",
    changes: [{ path: save.path, effect: "replace", incoming: save, local: save }],
    stays_local: [],
    incoming_content_sha256: sha,
    local_content_sha256: "b".repeat(64),
    options: { remove_local_only_saves: false, replace_diverged_progress: false },
    safety_backup_will_be_created: true,
    blockers: ["conflict-needs-choice"],
    preview_sha256: sha,
  };
  const ready = {
    ready_notices_enabled: true,
    not_assessed: 0,
    assessments: [
      {
        port_id: portId,
        mode: "notify",
        newly_ready: true,
        readiness: {
          state: "installed",
          install_id: installId,
          maintenance: {
            channel: "stable",
            update_policy: "notify",
            active_version: "1.0-presentation",
            available_version: "2.0-presentation",
            available_sha256: sha,
            checked_at: 1,
          },
        },
      },
    ],
  };
  return {
    portId,
    setupId,
    modName,
    sha,
    mods,
    original,
    recovery,
    retirement,
    preservation,
    recipe: { plan: recipe, serialized_plan: JSON.stringify(recipe), setting_values: [] },
    providerPage,
    providerProject,
    providerPlan,
    portableExport,
    portableImport,
    ready,
  };
}

export type SecondaryPanelFixtures = ReturnType<typeof secondaryPanelFixtures>;
