import type {
  ArtworkSlot,
  ArtworkState,
  DesktopError,
  PortDefinition,
  PortStatus,
  SourceProfile,
  SourceRecord,
  SourceInspectionReport,
} from "./types";

/** Fail a fixture's setup at the missing value, rather than pass a partial
 * transport record or silently skip a mocked operation. */
export function fixtureValue<T>(value: T | null | undefined, description: string): T {
  if (value === undefined || value === null) throw new Error(`Missing fixture: ${description}`);
  return value;
}

export function preliminarySourceInspection(
  record: SourceRecord,
): NonNullable<SourceInspectionReport["inspection"]> {
  return {
    profile_id: record.profile_id,
    path: record.path,
    observed_digests: [],
    components: [],
    validator: {
      contract_id: "owned-validator-v1",
      tool_id: "owned-validator",
      protocol_version: "1",
      result: "not_run",
    },
    assessment: {
      health: "not_baselined",
      classification: { state: "not_evaluated" },
      contract: { state: "not_evaluated" },
      admission: { state: "admitted", mode: "structural_checks" },
      evidence: [],
    },
    record,
    message: "Preliminary selection; validation has not run",
  };
}

// Complete serialized values; tests override only the behavior they exercise.
export function artworkState(
  portId = "sample",
  slot: ArtworkSlot = "cover",
  revision = 0,
  selected = false,
): ArtworkState {
  const asset = selected
    ? {
        sha256: "a".repeat(64),
        original_name: "owned-image.png",
        format: "png" as const,
        byte_size: 69,
        width: 1,
        height: 1,
        imported_at: 1789038047,
      }
    : null;
  return {
    choice: {
      port_id: portId,
      slot,
      revision,
      asset_sha256: asset?.sha256 ?? null,
    },
    selection: asset,
    availability: selected ? "available" : "fallback",
    reason: null,
    resolved_source: selected
      ? { kind: "local_import", asset_sha256: asset!.sha256 }
      : { kind: "generated_fallback" },
    generated_fallback: {
      identity: "f".repeat(64),
      style_version: 1,
      initials: "SF",
      palette_index: 4,
    },
  };
}

export function portDefinition(): PortDefinition {
  return {
    id: "sample",
    name: "Sample",
    summary: "Sample port",
    project_url: "https://example.com",
    adapter: "staged-source-portable",
    support_tier: "stable",
    channels: ["stable"],
    platforms: ["windows-x86-64"],
    automated_tested_platforms: [],
    manually_validated_platforms: [],
    upstream_status: "active",
    source_profile: null,
    bios_source_profile: null,
    release: {
      provider: "github",
      repository: "",
      rolling_tag: null,
      asset_hints: {},
      direct: {},
      user_prepared: {},
    },
    executable_hints: {},
    bundled_runtime: {},
    persistent_paths: [],
    persistent_file_patterns: [],
    launch_arguments: [],
    launch_environment: {},
    launch_from_install_root: false,
    portable_marker: false,
    runtime_mutable_paths: [],
    runtime_source_filename: null,
    runtime_source_hashes: {},
    runtime_source_materialization: null,
    runtime_source_set: [],
    runtime_subdirectory: null,
    setup_arguments: [],
    setup_executable_hints: {},
    setup_marker: null,
    setup_output_paths: [],
    source_environment: null,
    user_data_environment: null,
  };
}

export function portStatus(): PortStatus {
  return {
    port_id: "sample",
    channel: "stable",
    update_policy: "notify",
    active: null,
    previous: null,
    staged: null,
    last_launched_at: null,
    successful_launches: 0,
  };
}

/** An explicit positive Core claim for renderer tests; byte health alone is not one. */
export function confirmedSourceAssessment(
  profileId = "sample",
): NonNullable<NonNullable<PortStatus["readiness"]>["source_assessment"]> {
  return {
    health: "current",
    classification: {
      state: "recognized",
      identity: {
        game_id: profileId,
        variant_id: "fixture-edition",
        representation_id: "fixture-raw",
      },
    },
    contract: { state: "supported", contract_id: "fixture-installed-release" },
    admission: { state: "admitted", mode: "exact_identity" },
    evidence: [],
  };
}

export function sourceProfile(): SourceProfile {
  return {
    id: "sample",
    label: "Sample",
    kind: "file",
    accepted_extensions: [],
    accepted_sha1: [],
    accepted_sha256: [],
    disc: null,
    members: [],
  };
}

export function failureReport(): DesktopError {
  return {
    code: "source_invalid",
    message: "source changed since registration",
    details: {},
    presentation: {
      presentation_key: "source_not_accepted",
      summary: "The required game files could not be accepted or prepared.",
      tone: "error",
      mutation_state: "unknown",
      phase: null,
      recovery_actions: ["review_current_state", "view_technical_details"],
      technical_message: "source changed since registration",
      technical_context: {},
    },
  };
}

export const sourceIdentityCalculatedSha = "a".repeat(64);
export const sourceIdentityExpectedSha = "b".repeat(64);

type FixtureReport = SourceInspectionReport & {
  applications: [SourceInspectionReport["applications"][number]];
  evidence: [SourceInspectionReport["evidence"][number]];
};
export function sourceInspectionIdentityFixture(stateCode = "recognized_exact"): FixtureReport {
  const classification =
    stateCode === "ambiguous_identity"
      ? {
          state: "ambiguous" as const,
          candidates: [
            {
              game_id: "game",
              variant_id: "edition",
              representation_id: "raw",
            },
            { game_id: "game", variant_id: "other", representation_id: "raw" },
          ],
        }
      : stateCode === "accepted_identity_unknown" || stateCode === "known_mismatch"
        ? { state: "unrecognized" as const }
        : {
            state: "recognized" as const,
            identity: {
              game_id: "game",
              variant_id: "edition",
              representation_id: "raw",
            },
          };
  const admission =
    stateCode === "known_mismatch"
      ? { state: "rejected" as const, reason: "known_mismatch" as const }
      : stateCode === "accepted_identity_unknown"
        ? { state: "admitted" as const, mode: "informational_consent" as const }
        : { state: "admitted" as const, mode: "exact_identity" as const };
  const inspection: SourceInspectionReport["inspection"] =
    stateCode === "source_missing"
      ? undefined
      : {
          profile_id: "game",
          path: "D:/Games/selected.zip",
          observed_digests: [
            {
              algorithm: "sha256",
              scope: "original-container",
              value: "c".repeat(64),
              size: 8192,
            },
            {
              algorithm: "sha256",
              scope: "normalized-content",
              value: sourceIdentityCalculatedSha,
              size: 4096,
            },
          ],
          archive_member_name: "game.z64",
          components: [
            {
              id: "program",
              kind: "file_set_member",
              name: "program.bin",
              digests: [
                {
                  algorithm: "sha256",
                  scope: "file-set-member",
                  value: "d".repeat(64),
                  size: 1024,
                },
              ],
              size: 1024,
              track_count: null,
              volume_id: null,
            },
            {
              id: "disc-1",
              kind: "optical_disc",
              name: "Disc 1",
              digests: [
                {
                  algorithm: "sha1",
                  scope: "disc-set-member",
                  value: "e".repeat(40),
                  size: 2048,
                },
              ],
              size: 2048,
              track_count: 12,
              volume_id: "GAME_DISC_1",
            },
          ],
          assessment: {
            health: "current",
            classification,
            contract: { state: "supported", contract_id: "game-port" },
            admission,
            evidence: [],
          },
          message: "Checked locally",
          record: null,
        };
  return {
    schema_version: 1,
    profile_id: "game",
    health:
      stateCode === "source_missing"
        ? "missing"
        : stateCode === "source_changed"
          ? "changed"
          : "current",
    state_code: stateCode,
    summary:
      stateCode === "known_mismatch"
        ? "This file is a known mismatch."
        : "The selected source was checked locally.",
    next_action: "Review this result before setup.",
    registered: {
      profile_id: "game",
      path: "D:/Games/selected.zip",
      sha256: sourceIdentityCalculatedSha,
      size: 4096,
      storage_sha256: "c".repeat(64),
      storage_size: 8192,
      updated_at: 1,
    },
    ...(inspection ? { inspection } : {}),
    ...(stateCode === "source_missing"
      ? { problem: { code: "not_found", message: "The registered file is missing." } }
      : {}),
    expected_identity: {
      id: "game",
      label: "Sample Game File",
      kind: "compound",
      aliases: [],
      tombstones: [],
      evidence_gap: null,
      variants: [
        {
          id: "edition",
          title: "Reviewed Edition",
          region: "USA",
          revision: "1.0",
          product_codes: ["GAME-01"],
          evidence_ids: ["identity-proof"],
          representations: [
            {
              id: "raw",
              kind: "compound",
              format: "stfs-live",
              extensions: ["zip"],
              evidence_ids: ["identity-proof"],
              identities: [
                {
                  scope: "normalized-content",
                  sha1: null,
                  sha256: sourceIdentityExpectedSha,
                  crc32: null,
                },
              ],
            },
            {
              id: "members",
              kind: "file-set",
              extensions: [],
              evidence_ids: [],
              members: [
                {
                  id: "program",
                  label: "Program",
                  filenames: ["program.bin"],
                  identities: [
                    {
                      scope: "file-set-member",
                      sha1: null,
                      sha256: "d".repeat(64),
                      crc32: null,
                    },
                  ],
                },
              ],
            },
          ],
        },
      ],
    },
    applications: [
      {
        port_id: "sample",
        port_name: "Sample Port",
        role: "game",
        contract: {
          id: "game-port",
          port_id: "sample",
          role: "game",
          profile_id: "game",
          admission_mode: "enforced",
          supported_variant_ids: ["edition"],
          validator_contract_id: null,
          evidence_ids: ["identity-proof"],
          authority_ref: "Sample upstream requirement",
          reviewed_at: "2026-09-06",
          immutable_review_url: "https://example.com/review/commit",
          live_review_url: null,
          evidence_gap: null,
          applicability: [{ upstream_ref: "v1", artifact_sha256: "f".repeat(64) }],
          aliases: [],
          tombstones: [],
        },
        contract_result:
          stateCode === "recognized_not_listed"
            ? { state: "recognized_not_listed", contract_id: "game-port" }
            : stateCode === "known_mismatch"
              ? { state: "known_incompatible", contract_id: "game-port" }
              : stateCode === "release_inapplicable"
                ? { state: "unreviewed_for_release" }
                : { state: "supported", contract_id: "game-port" },
        release_applicability: {
          state_code: stateCode === "release_inapplicable" ? "not_rebound" : "artifact_bound",
          reviewed_bindings: [{ upstream_ref: "v1", artifact_sha256: "f".repeat(64) }],
        },
        qualification: {
          legacy_automated_platforms: ["windows-x86-64"],
          legacy_hands_on_platforms: [],
          exact_records: [
            {
              scope: {
                port_id: "sample",
                platform: "linux-x86-64",
                artifact_sha256: "f".repeat(64),
                upstream_ref: "v1",
                contract_id: "game-port",
                variant: {
                  state: "exact",
                  identity: {
                    game_id: "game",
                    variant_id: "edition",
                    representation_id: "raw",
                  },
                },
                check_version: "1",
              },
              kind: "automated_lifecycle",
              outcome: "passed",
              observed_at: 1,
              portcove_version: "0.1.0-alpha.2",
              portcove_commit: "1".repeat(40),
              method: "fixture",
              evidence_ids: [],
            },
          ],
        },
      },
    ],
    evidence: [
      {
        id: "identity-proof",
        role: "byte_identity",
        authority: "Sample authority",
        authority_ref: "catalog row",
        reviewed_at: "2026-09-06",
        claim: "Expected source identity",
        immutable_url: "https://example.com/review/commit",
      },
    ],
    legacy: {
      registration_identity_not_recorded: false,
      variant_unspecified_records: [],
    },
  };
}

export const installedLaunchStatus = (readiness?: PortStatus["readiness"]): PortStatus => ({
  ...portStatus(),
  active: {
    id: "owned-install",
    port_id: portDefinition().id,
    version: "1.0",
    path: "D:/Library/versions/owned",
    channel: "stable",
    installed_at: 1,
    verified: true,
    staged: false,
    artifact: { asset_name: "owned.zip", sha256: "a".repeat(64), size: 1 },
    manifest_sha256: "b".repeat(64),
    selected_executable: "game.exe",
    runtime: null,
  },
  ...(readiness !== undefined ? { readiness } : {}),
  last_launched_at: 1,
  successful_launches: 1,
});
