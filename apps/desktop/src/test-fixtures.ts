import type { PortDefinition, PortStatus, SourceProfile } from "./types";

// Complete serialized values; tests override only the behavior they exercise.
export function portDefinition(): PortDefinition {
  return {
    id: "sample", name: "Sample", summary: "Sample port", project_url: "https://example.com",
    adapter: "staged-source-portable", support_tier: "stable", channels: ["stable"],
    platforms: ["windows-x86-64"], automated_tested_platforms: [], manually_validated_platforms: [],
    upstream_status: "active", source_profile: null, bios_source_profile: null,
    release: { provider: "github", repository: "", rolling_tag: null, asset_hints: {}, direct: {} },
    executable_hints: {}, bundled_runtime: {}, persistent_paths: [], persistent_file_patterns: [],
    launch_arguments: [], launch_environment: {}, launch_from_install_root: false, portable_marker: false,
    runtime_mutable_paths: [], runtime_source_filename: null, runtime_source_hashes: {},
    runtime_source_materialization: null, runtime_source_set: [], runtime_subdirectory: null,
    setup_arguments: [], setup_executable_hints: {}, setup_marker: null, source_environment: null,
    user_data_environment: null,
  };
}

export function portStatus(): PortStatus {
  return { port_id: "sample", channel: "stable", update_policy: "notify", active: null, previous: null, staged: null, last_launched_at: null, successful_launches: 0 };
}

export function sourceProfile(): SourceProfile {
  return { id: "sample", label: "Sample", kind: "file", accepted_extensions: [], accepted_sha1: [], accepted_sha256: [], disc: null, members: [] };
}
