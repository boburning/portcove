// Generated from Rust output schemas. Do not edit.
// Regenerate: node apps/desktop/scripts/generate-transport-types.mts --write

export type CancellationPhase = "preparing" | "finishing";
export type ErrorCode =
  | "usage"
  | "unsupported"
  | "not_found"
  | "source_invalid"
  | "network"
  | "verification"
  | "install"
  | "state"
  | "launch"
  | "conflict"
  | "cancelled";
export type MutationState = "not_started" | "no_changes" | "committed" | "recovery_required" | "unknown";
export type RecoveryAction = "review_current_state" | "review_preparation" | "view_technical_details";
/**
 * A known item to inspect, never authorization to resume or change it.
 */
export type FailureRecoveryTarget = {
  kind: "preparation";
  port_id: string;
  [k: string]: unknown;
};
export type FailureTone = "neutral" | "error";
export type ActivityLiveness = "active" | "interrupted" | "unknown";
export type ActivityOperation =
  | "settings_change"
  | "download_package"
  | "prepare"
  | "update_catalog"
  | "discover_sources"
  | "import_source"
  | "import_library"
  | "move_library"
  | "relocate_output"
  | "launch"
  | "check_update"
  | "backup"
  | "restore"
  | "delete_backup"
  | "install"
  | "update"
  | "reconcile"
  | "verify_install"
  | "activate"
  | "rollback"
  | "adopt"
  | "remove"
  | "remove_source"
  | "register_external"
  | "relink_external"
  | "remove_external"
  | "register_source"
  | "verify_source";
export type ActivityStatus = "running" | "succeeded" | "failed" | "cancelled";
export type ActivityTargetKind = "port" | "source" | "library";
export type OutputActivityDiagnostic = ActivityDiagnostic[];
export type ReleaseChannel = "stable" | "beta" | "rolling";
export type RuntimeOrigin = "verified_download" | "adopted_tree";
export type OutputLocationSource = "request_override" | "port_setting" | "library_default";
export type AdoptionBatchItemOutcome = "copied" | "changed" | "failed";
/**
 * Durable acquisition state. No phase grants permission to prepare or activate.
 */
export type GameUpdateAcquisitionPhase = "acquiring" | "verifying" | "acquired" | "attention_required";
export type Platform = "windows-x86-64" | "linux-x86-64" | "macos-x86-64" | "macos-aarch64";
export type DefinitionEligibilityOutcome = "eligible" | "hold" | "escalate";
export type DefinitionEligibilityReason =
  | "mandatory_checks_passed"
  | "publisher_revoked"
  | "curated_artifact_revoked"
  | "curated_distribution_withdrawn"
  | "unknown_safety_semantics"
  | "publisher_scope_required"
  | "engine_capability_required"
  | "ownership_migration_required"
  | "metadata_replay"
  | "refresh_incomplete"
  | "metadata_stale"
  | "recorded_identity_changed"
  | "authenticated_integrity_required"
  | "local_integrity_failed"
  | "mandatory_check_failed"
  | "source_identity_mismatch"
  | "required_source_missing";
export type DefinitionOperation = "availability" | "install" | "register_external" | "prepare" | "launch" | "update";
/**
 * A reviewed shared write scope, never a caller-selected external path.
 */
export type PreparedSharedPreferencesContract =
  ("regaiden041-windows" | "smb1r-1.1-stable-windows") | "gbrecompiled-windows-v1";
/**
 * A read-only projection of the existing operation guards for client presentation.
 * An `allowed` result is not an authorization token: execution rechecks current
 * inputs under its own lock and may still require an exact reviewed plan.
 */
export type PortAction =
  | "install"
  | "register_external"
  | "launch"
  | "remove_managed"
  | "remove_external"
  | "rollback"
  | "backup_create"
  | "backup_restore"
  | "update";
export type PortActionAvailability = "not_offered" | "waiting" | "held" | "allowed";
export type PortActionReason =
  | "available"
  | "route_not_offered"
  | "already_registered"
  | "unsupported_platform"
  | "not_installed"
  | "review_required"
  | "missing_source"
  | "unreadable_source"
  | "changed_source"
  | "incompatible_source"
  | "missing_bios"
  | "unreadable_bios"
  | "changed_bios"
  | "incompatible_bios"
  | "missing_runtime"
  | "preparation_required"
  | "shared_preferences_review_required"
  | "shared_preferences_unavailable"
  | "invalid_installation"
  | "definition_ineligible"
  | "missing_data"
  | "missing_backup"
  | "unreadable_data"
  | "unsafe_data"
  | "recovery_required"
  | "assessment_incomplete";
/**
 * Current relationship between a registered source path and its saved storage identity.
 * `Current` means the bytes are unchanged since registration; it does not strengthen the
 * catalog profile's game-revision evidence.
 * `NotBaselined` means readable selected bytes have no saved identity baseline.
 */
export type SourceHealth =
  "unregistered" | "current" | "missing" | "unreadable" | "changed" | "not_checked" | "not_baselined";
export type SourceAdmission =
  | {
      state: "not_evaluated";
      [k: string]: unknown;
    }
  | {
      mode: SourceAdmissionMode;
      state: "admitted";
      [k: string]: unknown;
    }
  | {
      reason: SourceRejectionReason;
      state: "rejected";
      [k: string]: unknown;
    };
export type SourceAdmissionMode =
  "exact_identity" | "structural_checks" | "informational_consent" | "upstream_validator";
export type SourceRejectionReason =
  | "missing"
  | "unreadable"
  | "changed"
  | "known_mismatch"
  | "ambiguous_identity"
  | "missing_tool"
  | "check_failed"
  | "consent_required";
export type SourceClassification =
  | {
      state: "not_evaluated";
      [k: string]: unknown;
    }
  | {
      state: "unrecognized";
      [k: string]: unknown;
    }
  | {
      identity: SourceIdentity;
      state: "recognized";
      [k: string]: unknown;
    }
  | {
      candidates: SourceIdentity[];
      state: "ambiguous";
      [k: string]: unknown;
    };
export type SourceContractResult =
  | {
      state: "not_evaluated";
      [k: string]: unknown;
    }
  | {
      state: "unreviewed_for_release";
      [k: string]: unknown;
    }
  | {
      contract_id: string;
      state: "supported";
      [k: string]: unknown;
    }
  | {
      contract_id: string;
      state: "recognized_not_listed";
      [k: string]: unknown;
    }
  | {
      contract_id: string;
      state: "known_incompatible";
      [k: string]: unknown;
    }
  | {
      contract_id: string;
      state: "informational";
      [k: string]: unknown;
    };
export type SourceEvidenceKind = "structural_check" | "automated_lifecycle" | "hands_on" | "known_failure";
export type SourceEvidenceOutcome = "passed" | "failed" | "not_run" | "unknown";
export type LaunchBlocker =
  | "missing_source"
  | "unreadable_source"
  | "changed_source"
  | "incompatible_source"
  | "missing_bios"
  | "unreadable_bios"
  | "changed_bios"
  | "incompatible_bios"
  | "missing_runtime"
  | "preparation_required"
  | "shared_preferences_review_required"
  | "shared_preferences_unavailable"
  | "invalid_installation";
/**
 * This family currently exposes the catalog's reviewed defaults only.
 */
export type PreparationMode = "default" | "ghostship200_legacy" | "source_only";
/**
 * User-facing installation behavior supplied by the catalog. Adapters remain an
 * implementation detail and must not be translated into product copy by clients.
 */
export type InstallationMethod =
  | "portable-package"
  | "portable-recompilation"
  | "staged-game-files"
  | "referenced-disc"
  | "generated-game-data"
  | "upstream-setup"
  | "managed-recompilation"
  | "user-prepared-runtime";
export type SavesAndSettingsBehavior = "portcove-managed" | "external-user-owned";
export type PortSourceRole = "game" | "bios";
export type SourceVerificationMethod = "catalog-identity" | "upstream-validator" | "catalog-rules";
export type UpdatePolicy = "notify" | "stage" | "automatic";
export type ArtworkImageFormat = "png" | "jpeg";
export type OutputArtworkAssets = LocalArtworkAsset[];
/**
 * A remote provider an image was chosen from; a local import has none.
 */
export type ArtworkProvider = "steamgriddb";
export type DestinationArtworkRole = "portrait_cover" | "landscape_cover" | "hero_banner";
export type ArtworkAvailability = "fallback" | "available" | "unavailable";
export type ArtworkSlot = ("cover" | "detail") | "landscape";
/**
 * Whether SteamGridDB's own listing still includes a stored image.
 */
export type SteamGridDbListingResult =
  | {
      status: "listed";
    }
  | {
      status: "not_listed";
    }
  | {
      reason: SteamGridDbUnknownReason;
      status: "unknown";
    };
export type SteamGridDbUnknownReason =
  | "incomplete_listing"
  | "too_many_images"
  | "game_not_found"
  | "empty_listing"
  | "request_limit"
  | "check_stopped"
  | "unavailable"
  | "invalid_response";
/**
 * The second signal that confirmed a withdrawal after a first absence.
 */
export type ArtworkWithdrawalSignal = "gone" | "absent_again";
/**
 * The source core resolves for one slot before a client attempts to transport
 * or render it. A client can still display the generated fallback if a
 * resolved image cannot be retrieved, decoded or presented safely.
 */
export type ArtworkResolvedSource =
  | {
      asset_sha256: string;
      kind: "local_import";
      [k: string]: unknown;
    }
  | {
      artwork: IgdbArtwork;
      cache_id: string;
      kind: "igdb_cover";
      [k: string]: unknown;
    }
  | {
      kind: "generated_fallback";
      [k: string]: unknown;
    };
export type IgdbArtworkMatch = "port" | "underlying-game";
/**
 * The version change an automatic snapshot protects.
 */
export type VersionChangeKind = "update" | "activation" | "rollback";
/**
 * Public reviewed backup actions; persisted manifests remain an implementation detail.
 *
 * ```
 * use portcove_core::{BackupAction, PortcoveService};
 * let action = BackupAction::Restore;
 * let _ = action;
 * ```
 *
 * ```compile_fail,E0432
 * use portcove_core::BackupManifest;
 * ```
 */
export type BackupAction = "restore" | "delete";
export type BackupProblemKind =
  | "missing_manifest"
  | "unreadable_manifest"
  | "malformed_manifest"
  | "identity_mismatch"
  | "unsupported_entry"
  | "recovery_required";
export type ProtectionCollectionState =
  | ("direct_to_managed_data" | "not_initialized" | "inactive" | "external_not_collected" | "unavailable")
  | "selected_for_collection";
export type ProtectionInstallRole = "active" | "previous" | "staged" | "external";
export type InstallationUpdateOwner = "portcove" | "upstream_or_user";
export type BackupInventoryState = "healthy" | "degraded" | "recovery_required";
export type AdapterKind =
  | (
      | "libultraship-portable"
      | "n64-recomp-portable"
      | "staged-source-portable"
      | "referenced-disc"
      | "generated-cache"
      | "upstream-managed-setup"
      | "psx-recomp-managed"
    )
  | "native-portable";
/**
 * Closed upstream profile resolution for managed portable players.
 */
export type ExternalProfilePolicy =
  | "dune-dynasty-allegro-v1"
  | "fheroes2-v1"
  | "openrct2-mac-v1"
  | "recomp-appimage-v1"
  | "openmohaa-unix-v1"
  | "ironwail-linux-v1"
  | "vkquake-linux-v1"
  | "corsixth-linux-v1"
  | "openloco-unix-v1"
  | "jgrpp-linux-v1"
  | "openglad-mac-v1"
  | "z2rs-desktop-v1"
  | "recomp-direct-v1"
  | "doom3-linux-v1"
  | "openjk-unix-v1"
  | "openomf-linux-v1"
  | "vcmi-windows-v1";
export type GameSettingsFormat = "json" | "ini";
export type GameSettingType =
  | {
      default: boolean;
      kind: "boolean";
    }
  | {
      default: number;
      kind: "integer";
      maximum: number;
      minimum: number;
      step: number;
    }
  | {
      default: number;
      kind: "number";
      maximum: number;
      minimum: number;
      step: number;
    }
  | {
      choices: GameSettingChoice[];
      default: unknown;
      kind: "enum";
    };
/**
 * How a managed multi-disc runtime accepts a launch-time disc choice.
 */
export type LaunchDiscChoice = "psx-settings-selected";
/**
 * Closed initialization recipes, never catalog-supplied scripts or file contents.
 */
export type ManagedInitialization = "tfe-dark-forces-v1.22.420" | "tfe-dark-forces-portable-v1";
/**
 * Preserve complete mod package versions without replacing packaged defaults.
 * This grants neither executable trust nor mod/save compatibility.
 */
export type ModPackagePolicy = "versioned-packages-v1";
export type IgdbGameImageKind = "logo" | "artwork";
export type CatalogMediaRole = "header" | "screenshot" | "logo" | "key_art";
export type CatalogMediaSubject =
  | {
      kind: "port";
      port_id: string;
    }
  | {
      game_id: string;
      kind: "original";
      source_edition_id: string;
    };
export type CartridgeBuildRecipe =
  | "yoshis-cookie-nes-cycle-v1.1.0"
  | "dr-mario-nes-cycle-v1.3.0-usa"
  | "advance-wars-gba-source-cb3facb53b6b-usa-rev1"
  | "earthbound-snes-source-fe1155dc26ff-usa"
  | "render96-us-source-48da5c491c8a"
  | "gundam-wing-snes-source-c7aaaa152192-japan-offline"
  | "cvlod-n64-source-cb8548d145a1-ui-lifetime-v1";
/**
 * Catalog-accepted identity for a runtime the player prepares outside Portcove.
 * Portcove never downloads or owns this package through this route.
 */
export type PreparedRuntimeSettingsContract = "tfe-dark-forces-v1.22.420";
/**
 * Who admitted the executable bytes. User selection grants execution intent,
 * never curated package authenticity or ownership of the selected files.
 */
export type ExternalRuntimeTrust = "accepted-package" | "user-selected";
/**
 * Closed handling of runtime-owned host credentials, never a catalog exclusion DSL.
 */
export type RuntimeDataPolicy = "racewave46-v1.0.0-windows" | "version-local-retroachievements-v1";
/**
 * Disc file-system an image is read as.
 */
export type DiscImageFormat = "xdvdfs" | "iso9660";
/**
 * Patch file format applied by the `rom-patch` materialization.
 */
export type RomPatchFormat = "ips" | "bps" | "ups";
export type RuntimeSourceMaterialization =
  | ("n64-big-endian" | "copy" | "gamecube-iso" | "psx-bin-cue" | "psx-raw-set" | "ps2-iso" | "stfs-directory")
  | "regaiden-gbc"
  | "xdvdfs-directory"
  | "iso9660-directory"
  | "rom-patch";
export type SupportTier = "stable" | "beta" | "rolling";
/**
 * A declared upstream limitation, checked by Core rather than left to the game.
 */
export type WindowsRuntimePathPolicy = "printable-ascii-max-path" | "relative-file-max-path";
export type CatalogAdmissionMode = "enforced" | "informational";
export type SourceReleasePolicy = "integration-contract-v1";
export type CatalogEvidenceRole =
  "upstream_support" | "byte_identity" | "preservation_crosswalk" | "portcove_qualification";
export type SourceIdentityKind = "file" | "file-set" | "optical-disc" | "multi-disc-set" | "compound";
export type SourceRepresentation = {
  evidence_ids: string[];
  extensions: string[];
  id: string;
  [k: string]: unknown;
} & SourceRepresentation1;
export type SourceRepresentation1 =
  | {
      identities: DigestIdentity[];
      kind: "raw-file";
      [k: string]: unknown;
    }
  | {
      identities: DigestIdentity[];
      kind: "canonical-n64";
      [k: string]: unknown;
    }
  | {
      identities: DigestIdentity[];
      kind: "archive-member";
      member_extensions: string[];
      [k: string]: unknown;
    }
  | {
      kind: "file-set";
      members: SourceMemberIdentity[];
      [k: string]: unknown;
    }
  | {
      kind: "relative-file-set";
      members: RelativeSourceMemberIdentity[];
      [k: string]: unknown;
    }
  | {
      identities: DigestIdentity[];
      kind: "gamecube-normalized-iso";
      [k: string]: unknown;
    }
  | {
      identities: DigestIdentity[];
      kind: "optical-track-set";
      track_counts: number[];
      [k: string]: unknown;
    }
  | {
      discs: SourceDiscIdentity[];
      kind: "multi-disc-set";
      [k: string]: unknown;
    }
  | {
      kind: "volume-id";
      track_counts: number[];
      values: string[];
      [k: string]: unknown;
    }
  | {
      kind: "pinned-validator";
      validator_contract_id: string;
      [k: string]: unknown;
    }
  | {
      format: CompoundSourceFormat;
      identities: DigestIdentity[];
      kind: "compound";
      [k: string]: unknown;
    }
  | {
      content_types: string[];
      kind: "stfs-content";
      members: StfsContentMember[];
      package_types: StfsPackageType[];
      title_ids: string[];
      [k: string]: unknown;
    }
  | {
      evidence_gap: string;
      kind: "informational-extension";
      [k: string]: unknown;
    };
export type DigestScope =
  | "original-file"
  | "original-container"
  | "normalized-content"
  | "canonical-n64-big-endian"
  | "archive-member"
  | "gamecube-normalized-iso"
  | "psx-normalized-track-set"
  | "file-set-member"
  | "disc-set-member";
export type CompoundSourceFormat = "stfs-live";
/**
 * The STFS container magic: `LIVE` or `PIRS`. `CON` is not read yet.
 */
export type StfsPackageType = "live" | "pirs";
export type CatalogDownloadAssetId = number | CatalogForeignAssetId;
export type CatalogForeignAssetId = {
  file_id: number;
  link_id: number;
  project_id: number;
  provider: "gitlab";
  tag: string;
};
export type CatalogDownloadReleaseId = number | CatalogForeignReleaseId;
export type CatalogForeignReleaseId = {
  project_id: number;
  provider: "gitlab";
  tag: string;
};
/**
 * Why the upstream listing download is not this host's route. Each one leaves
 * existing-installation registration and every installed copy unchanged.
 */
export type CatalogDownloadRefusal = "managed-route";
export type ListingObservationStatus = "complete" | "incomplete" | "unavailable" | "failed";
export type CatalogOrigin = "embedded" | "signed_active" | "signed_previous" | "definition_selected";
export type CatalogUpdateSource =
  | {
      kind: "file";
      value: string;
      [k: string]: unknown;
    }
  | {
      kind: "https";
      value: string;
      [k: string]: unknown;
    };
export type DefinitionCapabilityOutcome = "supported" | "unsupported_template" | "unsupported_version";
export type DefinitionRefreshDisposition = "revoked" | "selected" | "ineligible";
export type DestinationArtworkContent =
  | {
      asset: LocalArtworkAsset;
      availability: "available";
    }
  | {
      availability: "unavailable";
      reason: DestinationArtworkUnavailableReason;
    };
export type DestinationArtworkUnavailableReason =
  ("no_local_original" | "selected_original_unavailable") | "role_not_provided" | "selected_image_not_wide";
export type DestinationArtworkSource =
  | {
      asset: LocalArtworkAsset;
      kind: "local_import";
    }
  | {
      artwork: IgdbArtwork;
      kind: "catalog_default";
    }
  | {
      kind: "generated_fallback";
    }
  | {
      kind: "unassigned_role";
    };
export type HostToolSource = "environment" | "saved" | "discovery";
export type HostToolState = "available" | "missing" | "misconfigured" | "unsupported";
export type RepairItemKind =
  | "malformed_journal"
  | "retained_preparation"
  | "partial_operation"
  | "cleanup_pending"
  | "orphaned_final_directory"
  | "missing_registered_path"
  | "degraded_backup"
  | "backup_recovery_required";
export type JournalValidationStage =
  "columns" | "kind" | "phase" | "payload" | "family" | "acquisition" | "acquisition_inventory";
export type RecommendationDimension = "gameplay" | "stability" | "performance" | "controls" | "setup" | "maintenance";
export type RecommendationDimensionState = "known" | "unknown" | "not-applicable" | "conflicting";
export type RecommendationEvidenceDisposition =
  "current" | "historical-scope" | "future-observation" | "unsupported-observation-kind" | "superseded" | "invalid";
export type RecommendationClaim =
  | {
      kind: "rating";
      value: number;
      [k: string]: unknown;
    }
  | {
      kind: "unknown";
      [k: string]: unknown;
    }
  | {
      kind: "not-applicable";
      [k: string]: unknown;
    };
export type RecommendationEvidenceKind =
  | "upstream-declared"
  | "artifact-inspected"
  | "setup-observed"
  | "launch-observed"
  | "gameplay-observed"
  | "performance-observed"
  | "maintenance-observed";
export type RecommendationOperationEligibility =
  | {
      kind: "allowed";
      [k: string]: unknown;
    }
  | {
      kind: "unknown";
      reason: string;
      [k: string]: unknown;
    }
  | {
      kind: "held";
      reason: string;
      [k: string]: unknown;
    };
export type RecommendationReason =
  | "different-game-or-edition"
  | "different-platform-or-environment"
  | "source-not-selected"
  | "operation-unknown"
  | "operation-held"
  | "requirement-unknown"
  | "requirement-unsupported"
  | "invalid-evidence"
  | "conflicting-evidence"
  | "critical-regression"
  | "insufficient-coverage"
  | "gameplay-unobserved"
  | "stability-unobserved"
  | "gameplay-below-default-floor"
  | "stability-below-default-floor"
  | "materially-worse-playing-experience";
export type RecommendationRequirement = "satisfied" | "unknown" | "unsupported";
export type PortRecommendationStatus =
  | "recommended-starting-point"
  | "comparable-alternatives"
  | "assessed-single-candidate"
  | "insufficient-evidence"
  | "no-suitable-candidate";
export type ComparisonReleaseState =
  "catalog-pinned" | "provider-resolved" | "collection-failed" | "definition-changed" | "unobserved" | "not-offered";
export type RecommendationMetadataState = "available" | "missing" | "invalid" | "unsupported-version";
export type GameFileRouteKind = "managed_install" | "external_registration" | "managed_launch" | "external_launch";
export type GameFileQueryReason =
  | "complete_compatible_observation"
  | "no_connected_registration"
  | "explicit_empty_requirements"
  | "observation_unavailable"
  | "observation_stale"
  | "source_needs_checking"
  | "storage_absence_unconfirmed"
  | "identity_not_admitted"
  | "contract_not_reviewed"
  | "variant_not_supported"
  | "release_not_bound"
  | "route_not_offered"
  | "profile_context_changed";
export type GameFileQueryState =
  "files_available" | "files_missing" | "needs_checking" | "no_files_required" | "unavailable_context";
export type GameFileRootAvailability = "available" | "unavailable";
export type OutputGameFileRoots = GameFileRoot[];
export type SourceDigestAlgorithm = "sha1" | "sha256" | "crc32";
export type SourceComponentKind = "file_set_member" | "optical_disc";
export type SourceValidatorResult = "not_run" | "passed" | "failed" | "missing_tool";
export type GameFileScanMatchKind = "exact" | "preliminary";
export type OutputGameFileScanSnapshot = GameFileScanSnapshot | null;
export type GameFileScanFreshness = "inputs_match" | "inputs_changed";
export type SourceDiscoveryLimit = "entries" | "depth" | "file_size" | "hash_bytes" | "candidates";
export type InstallPlanAction = "already_active" | "use_staged" | "reuse_retained" | "blocked_unverified" | "download";
export type SourceRequirementRole = "game_source" | "bios";
export type GameSettingChange =
  | {
      action: "set";
      value: unknown;
    }
  | {
      action: "reset";
    };
export type GithubAuthSource = "anonymous" | "environment" | "credential_store";
export type GithubDeviceLoginState = "pending" | "complete";
export type HostToolProbeState =
  | "missing"
  | "invalid"
  | "blocked"
  | "timed_out"
  | "excessive_output"
  | "failed_probe"
  | "incompatible_version"
  | "cancelled"
  | "success";
export type OutputLaunchRequest = LaunchSessionView | null;
export type LaunchSessionOutcome = "succeeded" | "failed" | "cancelled";
export type LaunchSessionPhase = "preparing" | "spawning" | "running" | "collecting" | "recovering";
export type LauncherAppsRootOrigin = "settings" | "default" | "override" | "unresolved";
export type LauncherEntryStatus =
  | "ready-to-review"
  | "ambiguous"
  | "not-in-catalog"
  | "unrecognized-files"
  | "adoption-unsupported"
  | "not-installed"
  | "unsafe-path"
  | "duplicate";
export type LauncherKind = "github-launcher" | "quiver";
export type LibraryContentKind =
  "application_versions" | "user_data" | "source_inbox" | "backups" | "toolchains" | "local_artwork";
export type LibraryMembershipOrigin = "game_file_discovery" | "manual";
/**
 * How a profile follows newer eligible releases. Stored as intent; unattended
 * application is owned by the provider/standing-policy work, not this module.
 */
export type ProfileUpdatePolicy = "keep_current" | "review_updates" | "automatic_eligible";
export type LibrarySelectionSource = "invocation" | "saved" | "platform_default";
export type ListingAction = "attach-existing" | "relink-existing" | "launch" | "remove-registration";
export type AdvisoryApplicability = "current-route" | "historical" | "context-required";
export type CapabilityFeature =
  | "setup"
  | "original-files"
  | "launch"
  | "updates"
  | "settings"
  | "backup"
  | "restore"
  | "previous-version"
  | "gameplay"
  | "controls"
  | "audio"
  | "performance"
  | "save-compatibility";
export type PendingSetupState = "downloaded" | "attention-required";
export type OutputListingStatuses = PortListingStatus[];
/**
 * What the package would run on the player's machine if enabled.
 */
export type RecompExecution = "recompiled_code" | "native_libraries" | "external_code";
export type RetainedBuildAvailability = "verified" | "missing" | "changed" | "held" | "unavailable";
export type OriginalAvailability = "verified" | "missing" | "changed";
/**
 * Versioned best-effort progress envelope. Durable activity history remains
 * authoritative after reconnect or restart.
 */
export type OutputOperationEvent = {
  operation: string;
  operation_id: string;
  parent_operation_id: string | null;
  schema_version: number;
  sequence: number;
  target: OperationTarget | null;
  timestamp_ms: number;
  [k: string]: unknown;
} & OutputOperationEvent1;
export type OutputOperationEvent1 =
  | {
      type: "started";
      [k: string]: unknown;
    }
  | {
      path: string;
      profile_id: string;
      sha256: string;
      size: number;
      type: "source_candidate";
      [k: string]: unknown;
    }
  | {
      completed: number;
      phase: string;
      /**
       * Stable producer identity, independent of translated display wording.
       */
      phase_id?: string | null;
      total: number | null;
      type: "progress";
      /**
       * Absent on older producers; clients must not infer it from phase text.
       */
      unit?: ProgressUnit | null;
      [k: string]: unknown;
    }
  | {
      level: string;
      message: string;
      type: "message";
      [k: string]: unknown;
    }
  | {
      result: OperationResult;
      type: "finished";
      [k: string]: unknown;
    };
export type ProgressUnit = "bytes" | "items" | "ports" | "indeterminate";
export type OperationResult = "succeeded" | "failed" | "cancelled";
export type OutputDestinationAvailability = "available" | "full" | "unavailable";
export type OutputDestinationOwnership =
  | "library_default"
  | "unclaimed"
  | "owned_by_port"
  | "owned_by_another_port"
  | "unrelated_content"
  | "invalid"
  | "unknown";
export type OutputPendingSetups = PendingSetupRecord[];
/**
 * Why an export or import cannot proceed as reviewed.
 */
export type PortableSaveBlocker =
  | "unqualified"
  | "not-installed"
  | "unsupported-version"
  | "unsupported-platform"
  | "version-mismatch"
  | "different-game"
  | "busy"
  | "no-portable-progress"
  | "conflict-needs-choice"
  | "already-current";
/**
 * Role of one entry in a canonical player-data root.
 */
export type PersistentDataRole =
  | "mods"
  | "portable-progress"
  | "device-configuration"
  | "generated-content"
  | "original-derived"
  | "local-player-data"
  | "portcove-metadata"
  | "unknown";
export type PortableSaveFileEffect = ("add" | "replace" | "unchanged") | "remove" | "keep-local";
/**
 * How incoming progress relates to this device's progress, by content only.
 */
export type PortableSaveRelation = ("no-local-progress" | "already-current") | "continues" | "diverged";
/**
 * How current an observation is. A confirmed empty result is `Fresh`; an outage
 * that falls back to earlier data is `Stale`, never an empty list.
 */
export type ProviderFreshness = "fresh" | "revalidated" | "stale";
export type ProviderUpdateState = "current" | "newer_files" | "installed_file_removed" | "unavailable";
export type RecipeInputStatus = "available" | "acquirable" | "unavailable";
/**
 * One documented outcome in the assessed scope, not a universal judgment about a project.
 */
export type RecommendationOutcome =
  | {
      dimension: "gameplay";
      outcome: GameplayOutcome;
    }
  | {
      dimension: "stability";
      outcome: StabilityOutcome;
    }
  | {
      dimension: "performance";
      outcome: PerformanceOutcome;
    }
  | {
      dimension: "controls";
      outcome: ControlsOutcome;
    }
  | {
      dimension: "setup";
      outcome: SetupOutcome;
    }
  | {
      dimension: "maintenance";
      outcome: MaintenanceOutcome;
    }
  | {
      dimension: "unknown";
      outcome: RecommendationDimension;
    }
  | {
      dimension: "not-applicable";
      outcome: RecommendationDimension;
    };
export type GameplayOutcome =
  | "cannot-play"
  | "required-content-missing"
  | "progression-defects"
  | "main-loop-with-limitations"
  | "progression-with-minor-defects"
  | "assessed-scope-complete";
export type StabilityOutcome =
  | "destructive-or-unusable"
  | "frequent-crashes-or-save-failures"
  | "material-reliability-gaps"
  | "repeatable-play-and-save-with-limitations"
  | "repeated-reliable-sessions"
  | "assessed-lifecycle-and-recovery-reliable";
export type PerformanceOutcome =
  | "unusable"
  | "severe-interruption"
  | "material-pacing-problems"
  | "playable-within-measured-limits"
  | "consistent-measured-performance"
  | "assessed-target-met";
export type ControlsOutcome =
  | "required-interaction-unusable"
  | "major-interaction-gaps"
  | "material-control-limitations"
  | "assessed-interaction-with-limitations"
  | "useful-controls-and-accessibility"
  | "assessed-interaction-goals-met";
export type SetupOutcome =
  | "cannot-complete"
  | "unrecoverable-problems"
  | "manual-or-recovery-limitations"
  | "repeatable-setup-with-limitations"
  | "repeatable-setup-verification-and-update"
  | "assessed-setup-update-and-recovery-goals-met";
export type MaintenanceOutcome =
  | "explicit-abandonment"
  | "unresolved-continuity-failure"
  | "stated-continuity-limits"
  | "attributable-continuity-with-limitations"
  | "demonstrated-regression-handling"
  | "demonstrated-continuity-and-succession";
export type ReconcileAction = "up_to_date" | "notify" | "staged" | "activated";
/**
 * What the player can usefully do next with a selected save folder.
 */
export type SaveFolderNextStep =
  "up-to-date" | "unavailable" | "blocked" | "incomplete" | "push" | "pull" | "choose-progress";
export type SourceImportMode = "copy" | "move" | "use_current_location";
export type SourceImportOutcome =
  "copied" | "moved" | "reused_existing" | "registered_current_location" | "copied_original_retained";
export type SourceInboxResolutionState =
  "registered" | "exact_match" | "approval_required" | "unresolved" | "conflict" | "incomplete";
export type SourceReuseCompatibility = "listed_identity" | "potential" | "incompatible" | "unavailable";
export type OutputSteamgriddbCandidates = SteamGridDbCandidate[];
export type OutputSteamgriddbGames = SteamGridDbGame[];
/**
 * What SteamGridDB's image server answered for the stored source URL, without the key.
 */
export type SteamGridDbSourceStatus = "not_checked" | "served" | "gone" | "unknown";
/**
 * Why a check ended before every group was read.
 */
export type SteamGridDbCheckStop =
  | {
      reason: "rate_limited";
      retry_after_seconds: number | null;
    }
  | {
      reason: "key_rejected";
    }
  | {
      reason: "unavailable";
    }
  | {
      reason: "time_limit";
    }
  | {
      reason: "cancelled";
    };
export type GameStore = "steam" | "gog" | "epic";
export type OutputDesktopAdoptionBatchResult = AdoptionBatchResult | null;
export type OutputDesktopApplicationUpdateCheckPhase = "checking" | "acquiring-and-verifying" | "staged" | "complete";
export type ApplicationChannel = "preview" | "stable";
export type ApplicationUpdateCheckResultKind =
  | "consent-required"
  | "paused"
  | "manual-mode"
  | "offline"
  | "metered"
  | "metered-state-unknown"
  | "startup-delay"
  | "cadence"
  | "superseded"
  | "current"
  | "update-available"
  | "held"
  | "incompatible"
  | "no-candidate";
export type ApplicationUpdateMode = "automatic" | "notify-only" | "manual";
export type ApplicationUpdateNativeLaunchSummary =
  "starting" | "started" | "failed" | "installer-succeeded" | "installer-failed";
export type ApplicationUpdateRequestedAction = "safe-exit" | "restart-to-apply";
export type ApplicationUpdateObservedTermination =
  "normal-exit" | "restart-to-apply" | "crash" | "os-shutdown" | "steam-stop";
export type ApplicationUpdateInstallEligibility =
  "eligible" | "package-managed-deb" | "package-managed-rpm" | "not-configured" | "unavailable";
export type ApplicationUpdateRecoveryArea = "schedule" | "staging" | "apply";
export type OutputDesktopAutomaticSnapshotsEnabled = boolean;
export type InstallBatchItemState = ("queued" | "running" | "failed" | "cancelled") | "ready" | "held" | "interrupted";
export type OutputDesktopInstallBatches = InstallBatchRecord[];
export type LibraryMembershipOutcomeKind = "added" | "already_saved" | "already_in_library";
export type OutputDesktopLibraryMembershipOutcomes = LibraryMembershipOutcome[];
export type OutputDesktopLibraryMemberships = LibraryMembership[];
export type InstallationContext =
  | {
      installation_id: string;
      kind: "managed";
    }
  | {
      installation_id: string;
      kind: "external";
    };
export type PortIntentMode = "discover_only" | "notify" | "set_up_when_ready" | "ignored";
export type PortReadiness =
  | {
      install_id: string;
      /**
       * The installed game's maintenance state under its own update policy.
       */
      maintenance?: PortMaintenance | null;
      state: "installed";
      [k: string]: unknown;
    }
  | {
      plan_sha256: string;
      state: "ready";
      version: string;
      [k: string]: unknown;
    }
  | {
      reason: string;
      state: "waiting";
      [k: string]: unknown;
    };
export type OutputDesktopPortIntents = PortIntent[];
export type OutputDesktopRootSetupConsent = RootSetupConsent | null;
export type RootSetupEnrollment = "existing_and_future" | "future_only";
export type OutputDesktopRootSetupConsents = RootSetupConsent[];
/**
 * What one standing pass did about one installed provider file.
 */
export type ProviderAutoUpdate = {
  /**
   * The setup's packages from the provider file this outcome is about; empty
   * when the whole setup could not be checked.
   */
  native_ids: string[];
  port_id: string;
  profile_id: string;
  profile_name: string;
  [k: string]: unknown;
} & ProviderAutoUpdate1;
export type ProviderAutoUpdate1 =
  | {
      file_id: string;
      outcome: "applied";
      revision: number;
      [k: string]: unknown;
    }
  | {
      outcome: "held";
      reason: string;
      [k: string]: unknown;
    }
  | {
      outcome: "deferred";
      reason: string;
      [k: string]: unknown;
    }
  | {
      outcome: "unavailable";
      reason: string;
      [k: string]: unknown;
    };
export type SteamArtworkRoleAction =
  "write" | "replace" | "preserve" | "unchanged" | "unavailable" | "remove" | "preserve_modified" | "absent";
/**
 * Separate reviewed Steam artwork action for one owned shortcut.
 */
export type SteamArtworkOperation =
  | {
      kind: "update";
      replace_existing: boolean;
      [k: string]: unknown;
    }
  | {
      kind: "remove_owned";
      [k: string]: unknown;
    };
export type SteamClientState = "closed" | "running" | "unknown";
export type SteamEntryChangeKind = "add" | "repair" | "remove" | "unchanged";
export type SteamEntryOperation = "add_or_repair" | "remove";
export type OutputDesktopSteamProfiles = string[];
export type SupportBundleScope = "bounded_recent_diagnostics";
export type SupportBundleSectionKind = "startup" | "doctor" | "activities" | "activity_capture" | "runtime_log";
export type SupportBundleProvenance =
  | "desktop_startup"
  | "library_doctor_snapshot"
  | "activity_history"
  | "activity_diagnostics"
  | "desktop_runtime_log"
  | "host_runtime_log";
export type SupportBundleReason =
  | "unavailable"
  | "read_failed"
  | "invalid_record"
  | "unsafe_file"
  | "section_limit"
  | "total_limit"
  | "record_limit"
  | "deadline"
  | "incomplete_record"
  | "capture_incomplete"
  | "capture_truncated"
  | "capture_not_collected"
  | "bounded_snapshot";
export type SupportBundleSectionStatus = "included" | "partial" | "omitted";

export interface TransportOutputs {
  about: OutputAbout;
  activity: ActivityFeed;
  activity_diagnostic: OutputActivityDiagnostic;
  adoption_batch_preview: OutputAdoptionBatchPreview;
  adoption_batch_result: AdoptionBatchResult;
  adoption_preview: AdoptionPreview;
  api_response_port_status: OutputApiResponsePortStatus;
  artwork_assets: OutputArtworkAssets;
  artwork_cache_clear: OutputArtworkCacheClear;
  artwork_state: OutputArtworkState;
  artwork_thumbnail: OutputArtworkThumbnail;
  backup: BackupRecord;
  backup_action_preview: BackupActionPreview;
  backup_inventory: OutputBackupInventory;
  cancellation_phase: CancellationPhase;
  cancellation_state: CancellationState;
  capabilities: OutputCapabilities;
  catalog: CatalogDocument;
  catalog_download_candidates: OutputCatalogDownloadCandidates;
  catalog_download_preview: OutputCatalogDownloadPreview;
  catalog_download_request: CatalogDownloadRequest;
  catalog_listings: CatalogListingDocument;
  catalog_provenance: CatalogProvenance;
  catalog_status: OutputCatalogStatus;
  catalog_trust_key: CatalogTrustKey;
  catalog_update_plan: OutputCatalogUpdatePlan;
  catalog_update_source: CatalogUpdateSource;
  check_batch_outcome: OutputCheckBatchOutcome;
  definition_authority_provisioning: OutputDefinitionAuthorityProvisioning;
  definition_authority_review: DefinitionAuthorityReview;
  definition_capability_report: OutputDefinitionCapabilityReport;
  definition_capability_request: OutputDefinitionCapabilityRequest;
  definition_refresh: OutputDefinitionRefresh;
  destination_artwork_bytes: OutputDestinationArtworkBytes;
  destination_artwork_handoff: DestinationArtworkHandoff;
  doctor: OutputDoctor;
  external_runtime_preview: ExternalRuntimePreview;
  external_runtime_record: ExternalRuntimeRecord;
  external_runtime_relink_preview: OutputExternalRuntimeRelinkPreview;
  external_runtime_removal_preview: OutputExternalRuntimeRemovalPreview;
  game_comparison: OutputGameComparison;
  game_comparison_request: OutputGameComparisonRequest;
  game_file_query_request: OutputGameFileQueryRequest;
  game_file_query_snapshot: OutputGameFileQuerySnapshot;
  game_file_roots: OutputGameFileRoots;
  game_file_scan_match_page: OutputGameFileScanMatchPage;
  game_file_scan_match_query: OutputGameFileScanMatchQuery;
  game_file_scan_snapshot: OutputGameFileScanSnapshot;
  game_install_plan: GameInstallPlan;
  game_setting_change: GameSettingChange;
  game_setting_review: OutputGameSettingReview;
  game_settings_contract: GameSettingsContract;
  game_settings_view: GameSettingsView;
  game_update_acquisition: GameUpdateAcquisition;
  game_update_plan: OutputGameUpdatePlan;
  ghostship_recovery_plan: OutputGhostshipRecoveryPlan;
  ghostship_recovery_result: OutputGhostshipRecoveryResult;
  github_auth_status: GithubAuthStatus;
  github_device_login: OutputGithubDeviceLogin;
  github_device_login_result: OutputGithubDeviceLoginResult;
  host_tool_probe_result: OutputHostToolProbeResult;
  host_tool_status: HostToolStatus;
  install_plan: InstallPlan;
  launch_request: OutputLaunchRequest;
  launcher_library_inventory: OutputLauncherLibraryInventory;
  library_identity: LibraryIdentity;
  library_import_plan: OutputLibraryImportPlan;
  library_import_result: OutputLibraryImportResult;
  library_metadata: LibraryMetadata;
  library_metadata_file: LibraryMetadataFile;
  library_move_plan: OutputLibraryMovePlan;
  library_move_result: OutputLibraryMoveResult;
  library_selection: LibrarySelection;
  listing_delivery_status: OutputListingDeliveryStatus;
  listing_statuses: OutputListingStatuses;
  live_mods: LiveMods;
  managed_route_change_preview: OutputManagedRouteChangePreview;
  managed_route_change_result: OutputManagedRouteChangeResult;
  mod_code_review: OutputModCodeReview;
  mod_setups_view: OutputModSetupsView;
  official_catalog_review: OfficialCatalogReview;
  official_catalog_setup: OutputOfficialCatalogSetup;
  operation_event: OutputOperationEvent;
  output_destination_preview: OutputOutputDestinationPreview;
  output_relocation_plan: OutputOutputRelocationPlan;
  output_relocation_result: OutputOutputRelocationResult;
  output_relocation_status: OutputOutputRelocationStatus;
  pending_setups: OutputPendingSetups;
  port: PortDefinition;
  port_capability_report: PortCapabilityReport;
  port_output_location: PortOutputLocation;
  port_paths: OutputPortPaths;
  port_removal_preview: OutputPortRemovalPreview;
  portable_save_export_preview: OutputPortableSaveExportPreview;
  portable_save_export_result: OutputPortableSaveExportResult;
  portable_save_import_preview: OutputPortableSaveImportPreview;
  portable_save_import_result: OutputPortableSaveImportResult;
  preparation_cleanup_preview: OutputPreparationCleanupPreview;
  preparation_options: PreparationOptions;
  preparation_plan: OutputPreparationPlan;
  profile_inventory: ProfileInventory;
  profile_recipe: ProfileRecipe;
  profile_revision: ProfileRevision;
  provider_browse_page: OutputProviderBrowsePage;
  provider_install_plan: OutputProviderInstallPlan;
  provider_project_view: OutputProviderProjectView;
  provider_update_observation: OutputProviderUpdateObservation;
  recipe_import_plan: OutputRecipeImportPlan;
  recommendation_metadata: OutputRecommendationMetadata;
  reconcile_batch_outcome: OutputReconcileBatchOutcome;
  reconcile_result: ReconcileResult;
  restore_result: OutputRestoreResult;
  retained_build_binding_preview: OutputRetainedBuildBindingPreview;
  retained_build_inventory: OutputRetainedBuildInventory;
  retained_build_reference: RetainedBuildReference;
  retained_build_removal_preview: OutputRetainedBuildRemovalPreview;
  retained_build_resolution: RetainedBuildResolution;
  retained_build_retirement_preview: OutputRetainedBuildRetirementPreview;
  save_folder_push_result: OutputSaveFolderPushResult;
  save_folder_status: OutputSaveFolderStatus;
  setup_launch_targets: OutputSetupLaunchTargets;
  signed_catalog_envelope: OutputSignedCatalogEnvelope;
  signed_catalog_payload: OutputSignedCatalogPayload;
  source: SourceRecord;
  source_assessment: SourceAssessment;
  source_batch_outcome: OutputSourceBatchOutcome;
  source_catalog: SourceCatalog;
  source_discovery_issue: SourceDiscoveryIssue;
  source_discovery_limit: SourceDiscoveryLimit;
  source_discovery_limits: SourceDiscoveryLimits;
  source_discovery_report: SourceDiscoveryReport;
  source_discovery_request: OutputSourceDiscoveryRequest;
  source_import_plan: OutputSourceImportPlan;
  source_import_result: OutputSourceImportResult;
  source_inbox_paths: SourceInboxPaths;
  source_inbox_resolution: OutputSourceInboxResolution;
  source_inspection: SourceInspectionReport;
  source_intake_inspection: OutputSourceIntakeInspection;
  source_relink_plan: OutputSourceRelinkPlan;
  source_removal_preview: OutputSourceRemovalPreview;
  source_reuse_review: OutputSourceReuseReview;
  source_verification: SourceVerification;
  status: PortStatus;
  steamgriddb_candidates: OutputSteamgriddbCandidates;
  steamgriddb_games: OutputSteamgriddbGames;
  steamgriddb_key_status: OutputSteamgriddbKeyStatus;
  steamgriddb_listing_report: OutputSteamgriddbListingReport;
  storage: StorageSummary;
  store_game_installs: OutputStoreGameInstalls;
  update_batch_outcome: OutputUpdateBatchOutcome;
  update_check: UpdateCheck;
  update_check_forecast: OutputUpdateCheckForecast;
  update_snapshot: UpdateSnapshot;
  upstream_observation_report: OutputUpstreamObservationReport;
  desktop_adoption_batch_preview: OutputAdoptionBatchPreview;
  desktop_adoption_batch_result: OutputDesktopAdoptionBatchResult;
  desktop_application_update_check_phase: OutputDesktopApplicationUpdateCheckPhase;
  desktop_application_update_check_result: ApplicationUpdateCheckResult;
  desktop_application_update_manual_check_result: OutputDesktopApplicationUpdateManualCheckResult;
  desktop_application_update_notice: OutputDesktopApplicationUpdateNotice;
  desktop_application_update_preferences: ApplicationUpdatePreferences;
  desktop_application_update_production_transition: ApplicationUpdateProductionTransition;
  desktop_application_update_production_transition_result: OutputDesktopApplicationUpdateProductionTransitionResult;
  desktop_application_update_status: OutputDesktopApplicationUpdateStatus;
  desktop_automatic_snapshots_enabled: OutputDesktopAutomaticSnapshotsEnabled;
  desktop_backup_review: OutputDesktopBackupReview;
  desktop_bootstrap_status: OutputDesktopBootstrapStatus;
  desktop_bug_report_draft: OutputDesktopBugReportDraft;
  desktop_bug_report_link: OutputDesktopBugReportLink;
  desktop_catalog_download_candidates: OutputCatalogDownloadCandidates;
  desktop_catalog_download_preview: OutputCatalogDownloadPreview;
  desktop_cli_command_context: OutputDesktopCliCommandContext;
  desktop_desktop_error: FailureReport;
  desktop_external_runtime_preview: ExternalRuntimePreview;
  desktop_external_runtime_record: ExternalRuntimeRecord;
  desktop_external_runtime_relink_preview: OutputExternalRuntimeRelinkPreview;
  desktop_external_runtime_removal_preview: OutputExternalRuntimeRemovalPreview;
  desktop_game_comparison: OutputGameComparison;
  desktop_game_file_query_snapshot: OutputGameFileQuerySnapshot;
  desktop_game_file_roots: OutputGameFileRoots;
  desktop_game_file_scan_match_page: OutputGameFileScanMatchPage;
  desktop_game_file_scan_snapshot: OutputGameFileScanSnapshot;
  desktop_install_batch: InstallBatchRecord;
  desktop_install_batch_review: OutputDesktopInstallBatchReview;
  desktop_install_batches: OutputDesktopInstallBatches;
  desktop_launch_result: OutputDesktopLaunchResult;
  desktop_library_membership_outcomes: OutputDesktopLibraryMembershipOutcomes;
  desktop_library_memberships: OutputDesktopLibraryMemberships;
  desktop_library_organization: OutputDesktopLibraryOrganization;
  desktop_locale_preference: OutputDesktopLocalePreference;
  desktop_managed_route_change_preview: OutputManagedRouteChangePreview;
  desktop_managed_route_change_result: OutputManagedRouteChangeResult;
  desktop_pending_setup_record: PendingSetupRecord;
  desktop_port_intent: PortIntent;
  desktop_port_intent_assessments: OutputDesktopPortIntentAssessments;
  desktop_port_intents: OutputDesktopPortIntents;
  desktop_preparation_cleanup_preview: OutputPreparationCleanupPreview;
  desktop_ready_notices_enabled: OutputDesktopAutomaticSnapshotsEnabled;
  desktop_reconcile_outcome: OutputReconcileBatchOutcome;
  desktop_root_setup_consent: OutputDesktopRootSetupConsent;
  desktop_root_setup_consents: OutputDesktopRootSetupConsents;
  desktop_setup_launch_targets: OutputSetupLaunchTargets;
  desktop_source_reuse_review: OutputSourceReuseReview;
  desktop_source_verification_outcome: OutputSourceBatchOutcome;
  desktop_standing_setup: OutputDesktopStandingSetup;
  desktop_steam_artwork_apply_result: OutputDesktopSteamArtworkApplyResult;
  desktop_steam_artwork_review: OutputDesktopSteamArtworkReview;
  desktop_steam_batch_review: OutputDesktopSteamBatchReview;
  desktop_steam_entry_apply_result: OutputDesktopSteamEntryApplyResult;
  desktop_steam_entry_review: OutputDesktopSteamEntryReview;
  desktop_steam_profiles: OutputDesktopSteamProfiles;
  desktop_store_game_installs: OutputStoreGameInstalls;
  desktop_submitted_report: OutputDesktopSubmittedReport;
  desktop_support_bundle_export: OutputDesktopSupportBundleExport;
  desktop_update_check_outcome: OutputCheckBatchOutcome;
  desktop_workspace_snapshot: OutputDesktopWorkspaceSnapshot;
}
export interface OutputAbout {
  description: string;
  license: string;
  product: string;
  repository: string;
  version: string;
  [k: string]: unknown;
}
/**
 * A complete view of current and actionable work plus a bounded terminal window.
 *
 * `records` is deterministically ordered and contains each durable activity at
 * most once even when it belongs to several protected sets. The three ID lists
 * are complete for the same SQLite snapshot. Failed attention remains complete
 * within the durable 1,000-terminal-record retention policy; older terminal
 * records are retired. Only the ordinary terminal-history presentation is
 * windowed further.
 */
export interface ActivityFeed {
  active_and_actionable_complete: boolean;
  attention_required_activity_ids: string[];
  current_activity_ids: string[];
  records: ActivityRecord[];
  recovery_required_activity_ids: string[];
  terminal_history_complete: boolean;
  terminal_history_count: number;
  terminal_history_limit: number;
  [k: string]: unknown;
}
export interface ActivityRecord {
  cancellation: CancellationState | null;
  failure: FailureReport | null;
  finished_at: number | null;
  id: string;
  /**
   * Best-effort ownership observation, not a replacement for terminal results.
   */
  liveness?: ActivityLiveness | null;
  message: string | null;
  operation: ActivityOperation;
  started_at: number;
  status: ActivityStatus;
  target_id: string | null;
  target_kind: ActivityTargetKind;
  [k: string]: unknown;
}
export interface CancellationState {
  phase: CancellationPhase;
  requested: boolean;
  [k: string]: unknown;
}
export interface FailureReport {
  code: ErrorCode;
  details: {
    [k: string]: string;
  };
  message: string;
  presentation: FailurePresentation;
  [k: string]: unknown;
}
export interface FailurePresentation {
  mutation_state: MutationState;
  phase: string | null;
  presentation_key: string;
  recovery_actions: RecoveryAction[];
  recovery_target?: FailureRecoveryTarget | null;
  summary: string;
  technical_context: {
    [k: string]: string;
  };
  technical_message: string;
  tone: FailureTone;
  [k: string]: unknown;
}
export interface ActivityDiagnostic {
  activity_id: string;
  /**
   * Both streams reached EOF and the process owner recorded the final capture.
   */
  complete: boolean;
  phase: string;
  stderr: DiagnosticStream;
  stdout: DiagnosticStream;
  stream_limit_bytes: number;
  updated_at: number;
  [k: string]: unknown;
}
export interface DiagnosticStream {
  observed_bytes: number;
  text: string;
  truncated: boolean;
  [k: string]: unknown;
}
export interface OutputAdoptionBatchPreview {
  /**
   * Binds the item list and every item's reviewed plan.
   */
  batch_sha256: string;
  /**
   * The ordinary adoption review of each item, in batch order.
   */
  items: AdoptionPreview[];
  /**
   * Items that import saved files while Portcove already holds saved files for
   * that game, so matching files there are replaced.
   */
  items_replacing_saved_files: number;
  original_will_be_modified: boolean;
  total_bytes: number;
  total_files: number;
  [k: string]: unknown;
}
export interface AdoptionPreview {
  application_files_will_be_copied: boolean;
  copy_plan: AdoptionCopyPlan;
  destination: AdoptionDestinationPreview | null;
  detected_port_ids: string[];
  original_will_be_modified: boolean;
  plan_sha256: string;
  selected_port_id: string | null;
  source: string;
  [k: string]: unknown;
}
export interface AdoptionCopyPlan {
  directories: string[];
  files: AdoptionCopyFile[];
  skipped_entries: AdoptionSkippedEntry[];
  total_bytes: number;
  [k: string]: unknown;
}
export interface AdoptionCopyFile {
  relative_path: string;
  sha256: string;
  size: number;
  [k: string]: unknown;
}
export interface AdoptionSkippedEntry {
  reason: string;
  relative_path: string;
  [k: string]: unknown;
}
export interface AdoptionDestinationPreview {
  active_install: InstallRecord | null;
  current_user_data_files: number;
  current_user_data_sha256: string | null;
  imported_user_data_paths: string[];
  output_location: PortOutputLocation;
  [k: string]: unknown;
}
export interface InstallRecord {
  artifact: ArtifactIdentity;
  channel: ReleaseChannel;
  id: string;
  installed_at: number;
  manifest_sha256: string;
  path: string;
  port_id: string;
  runtime: RuntimeIdentity | null;
  selected_executable: string;
  staged: boolean;
  verified: boolean;
  version: string;
  [k: string]: unknown;
}
export interface ArtifactIdentity {
  asset_name: string;
  sha256: string;
  size: number;
  [k: string]: unknown;
}
export interface RuntimeIdentity {
  archive_root: string;
  artifact: ArtifactIdentity1;
  executable: string;
  origin: RuntimeOrigin;
  target_directory: string;
  [k: string]: unknown;
}
export interface ArtifactIdentity1 {
  asset_name: string;
  sha256: string;
  size: number;
  [k: string]: unknown;
}
export interface PortOutputLocation {
  configured_output_directory: string | null;
  default_output_directory: string;
  effective_output_directory: string;
  library_root: string;
  port_id: string;
  selection_source: OutputLocationSource;
  user_data_root: string;
  [k: string]: unknown;
}
export interface AdoptionBatchResult {
  batch_sha256: string;
  items: AdoptionBatchItemResult[];
  [k: string]: unknown;
}
export interface AdoptionBatchItemResult {
  install: InstallRecord | null;
  message: string | null;
  outcome: AdoptionBatchItemOutcome;
  port_id: string;
  source: string;
  [k: string]: unknown;
}
export interface OutputApiResponsePortStatus {
  command: string;
  data: PortStatus | null;
  error: FailureReport | null;
  ok: boolean;
  schema_version: number;
  [k: string]: unknown;
}
export interface PortStatus {
  /**
   * Owned archive acquisition, separate from a staged or active runtime.
   */
  acquisition?: GameUpdateAcquisition | null;
  active: InstallRecord | null;
  channel: ReleaseChannel;
  /**
   * Successor-definition policy decisions. Legacy catalog ports retain an empty list.
   */
  definition_operations?: DefinitionOperationAssessment[];
  external_runtime?: ExternalRuntimeRecord | null;
  last_launched_at: number | null;
  last_update_check?: UpdateSnapshot | null;
  /**
   * Client-facing projection of core-owned operation guards. Execution rechecks.
   */
  port_actions?: PortActionAssessment[];
  port_id: string;
  previous: InstallRecord | null;
  readiness?: LaunchReadiness | null;
  staged: InstallRecord | null;
  successful_launches: number;
  update_policy: UpdatePolicy;
  user_data_root?: string | null;
  [k: string]: unknown;
}
export interface GameUpdateAcquisition {
  created_at: number;
  id: string;
  phase: GameUpdateAcquisitionPhase;
  platform: Platform;
  port_id: string;
  release: ResolvedRelease;
  updated_at: number;
  [k: string]: unknown;
}
export interface ResolvedRelease {
  asset: ReleaseAsset;
  channel: ReleaseChannel;
  published_at: string | null;
  version: string;
  [k: string]: unknown;
}
export interface ReleaseAsset {
  name: string;
  sha256: string;
  size: number;
  url: string;
  [k: string]: unknown;
}
/**
 * One operation decision exposed by the shared core status model.
 *
 * `retained` distinguishes an installed version's immutable admission from the
 * currently selected definition used for new work.
 */
export interface DefinitionOperationAssessment {
  eligibility: DefinitionEligibility;
  operation: DefinitionOperation;
  retained: boolean;
  [k: string]: unknown;
}
export interface DefinitionEligibility {
  outcome: DefinitionEligibilityOutcome;
  reason: DefinitionEligibilityReason;
  [k: string]: unknown;
}
export interface ExternalRuntimeRecord {
  archive_sha256: string;
  executable: string;
  id: string;
  immutable_tree_sha256: string;
  path: string;
  platform: Platform;
  port_id: string;
  registered_at: number;
  retained_definition?: DefinitionSelectionIdentity | null;
  shared_preferences?: AcceptedSharedPreferencesBinding | null;
  user_selected?: UserSelectedLaunch | null;
  version: string;
  [k: string]: unknown;
}
export interface DefinitionSelectionIdentity {
  definition_revision: number;
  grant_id: string;
  namespace: string;
  policy_revision: number;
  provenance: AuthenticatedDefinitionProvenance;
  repository_root_sha256: string;
  stable_id: string;
}
/**
 * Authenticated metadata facts captured with a candidate. They are not a persisted replay floor.
 */
export interface AuthenticatedDefinitionProvenance {
  definitions_sha256: string;
  definitions_version: number;
  earliest_expiration: string;
  index_sha256: string;
  root_sha256: string;
  root_version: number;
  snapshot_sha256: string;
  snapshot_version: number;
  targets_sha256: string;
  targets_version: number;
  timestamp_sha256: string;
  timestamp_version: number;
}
/**
 * Explicitly accepted account and location; mutable contents are not authority.
 */
export interface AcceptedSharedPreferencesBinding {
  account_sid_sha256: string;
  contract: PreparedSharedPreferencesContract;
  path: string;
}
export interface UserSelectedLaunch {
  /**
   * Individual arguments passed directly to the selected native executable.
   * No shell, scripts, environment overrides or hooks are interpreted.
   */
  arguments: string[];
}
export interface UpdateSnapshot {
  check: UpdateCheck;
  checked_at: number;
  [k: string]: unknown;
}
export interface UpdateCheck {
  channel: ReleaseChannel;
  installed_artifact: ArtifactIdentity1 | null;
  installed_runtime: RuntimeIdentity | null;
  installed_version: string | null;
  port_id: string;
  release: ResolvedRelease;
  required_runtime: RuntimeIdentity | null;
  update_available: boolean;
  /**
   * Repository maintenance facts from the provider's most recent observation of
   * this port. Absent means unknown, never active. It may be older than
   * `checked_at` when this check did not read the repository itself.
   */
  upstream_activity?: UpstreamActivity | null;
  [k: string]: unknown;
}
/**
 * What the release provider reported about the upstream repository while Portcove
 * was already reading it to select a release. A maintenance observation only: it
 * grants or revokes no release, update, install or catalog authority, and it is
 * not the catalog's reviewed `upstream_status` declaration.
 */
export interface UpstreamActivity {
  /**
   * The repository owner archived the repository (read-only upstream).
   */
  archived: boolean;
  /**
   * Unix seconds of the latest push the provider reported, when it reported one.
   */
  last_change_at?: number | null;
  /**
   * Unix seconds when the provider reported these facts.
   */
  observed_at: number;
  /**
   * The GitHub `owner/name` repository these facts describe. A port whose
   * catalog provider or repository differs no longer owns this observation.
   * Empty (an observation without a recorded repository) describes no port.
   */
  repository: string;
  [k: string]: unknown;
}
export interface PortActionAssessment {
  action: PortAction;
  availability: PortActionAvailability;
  /**
   * The authoritative signed-definition reason, when it limits this action.
   */
  definition?: DefinitionEligibility | null;
  reason: PortActionReason;
  [k: string]: unknown;
}
export interface LaunchReadiness {
  bios?: SourceHealth | null;
  bios_assessment?: SourceAssessment | null;
  blockers: LaunchBlocker[];
  launchable: boolean;
  pending_setup: boolean;
  /**
   * Core-owned managed preparation route for the retained active installation.
   */
  preparation_mode?: PreparationMode | null;
  /**
   * Original file representation required by the effective runtime contract.
   * This is independent of source identity health and uses the retained
   * definition when an external runtime is registered.
   */
  required_source_extension?: string | null;
  /**
   * Discs a player may choose at launch, from the effective contract of a
   * Portcove-managed multi-disc installation. Absent for every other route.
   */
  selectable_discs?: number | null;
  /**
   * Mechanical explanation from the effective (possibly retained) contract.
   */
  setup_contract?: SetupExplanation | null;
  source?: SourceHealth | null;
  /**
   * Descriptive input evidence for this retained installed release. Missing
   * legacy fields and unreviewed contracts never establish compatibility.
   */
  source_assessment?: SourceAssessment | null;
  /**
   * The saved game-file folder holding this game's missing or unreadable
   * original, when that folder is currently unavailable: reconnecting it is
   * the fix, and nothing was deleted.
   */
  source_folder_unavailable?: string | null;
  [k: string]: unknown;
}
export interface SourceAssessment {
  admission: SourceAdmission;
  classification: SourceClassification;
  contract: SourceContractResult;
  evidence: SourceEvidence[];
  health: SourceHealth;
  [k: string]: unknown;
}
/**
 * Stable catalog identifiers, never display names or inferred hash-array pairs.
 */
export interface SourceIdentity {
  game_id: string;
  representation_id: string;
  variant_id: string;
  [k: string]: unknown;
}
export interface SourceEvidence {
  /**
   * Reviewed catalog evidence IDs. A renderer must not treat these as URLs.
   */
  evidence_ids: string[];
  kind: SourceEvidenceKind;
  method: string;
  observed_at: number;
  outcome: SourceEvidenceOutcome;
  portcove_commit: string | null;
  portcove_version: string | null;
  scope: SourceEvidenceScope;
  [k: string]: unknown;
}
export interface SourceEvidenceScope {
  artifact_sha256: string | null;
  /**
   * Version of the tested adapter/tool/check contract, not today's app build.
   */
  check_version: string | null;
  contract_id: string | null;
  platform: Platform;
  port_id: string;
  upstream_ref: string | null;
  /**
   * Missing legacy scope is explicit, not a wildcard for a newly selected variant.
   */
  variant:
    | {
        state: "unspecified";
        [k: string]: unknown;
      }
    | {
        identity: SourceIdentity;
        state: "exact";
        [k: string]: unknown;
      };
  [k: string]: unknown;
}
export interface SetupExplanation {
  definition_sha256: string;
  installation_method: InstallationMethod | null;
  manual_preparation: string | null;
  manual_setup: ManualSetupGuide | null;
  persistent_file_patterns: PersistentFilePattern[];
  persistent_paths: string[];
  platforms: Platform[];
  retained: boolean;
  saves_and_settings: SavesAndSettingsBehavior | null;
  source_requirements: SourceRequirementPresentation[];
  [k: string]: unknown;
}
/**
 * Authored instructions only; these steps grant no operation or file authority.
 */
export interface ManualSetupGuide {
  help_url?: string | null;
  /**
   * Reference material, never an instruction to execute a setup action.
   */
  references?: ManualSetupStep[];
  steps: ManualSetupStep[];
  warnings: string[];
}
export interface ManualSetupStep {
  instruction: string;
  title: string;
}
export interface PersistentFilePattern {
  /**
   * Match the concatenated prefix and suffix as well as names with an interior.
   */
  allow_empty_middle?: boolean;
  prefix: string;
  suffix: string;
  [k: string]: unknown;
}
export interface SourceRequirementPresentation {
  label: string;
  profile_id: string;
  role: PortSourceRole;
  verification: SourceVerificationMethod;
  [k: string]: unknown;
}
/**
 * Local integrity and user selection do not establish copyright permission.
 */
export interface LocalArtworkAsset {
  byte_size: number;
  format: ArtworkImageFormat;
  height: number;
  imported_at: number;
  original_name: string;
  sha256: string;
  width: number;
}
export interface OutputArtworkCacheClear {
  removed_bytes: number;
  removed_files: number;
  [k: string]: unknown;
}
export interface OutputArtworkState {
  /**
   * Provider credits for the selected image; empty for a purely local import.
   */
  attribution: ArtworkAttribution[];
  availability: ArtworkAvailability;
  choice: ArtworkChoice;
  /**
   * When Portcove removed the selected image's stored copy because every
   * provider that supplied it confirmed a withdrawal. The choice and the
   * credit stay; choosing the image again restores the copy.
   */
  evicted_at: number | null;
  generated_fallback: GeneratedArtworkFallback;
  /**
   * Recorded listing evidence for the credited images; empty until an image
   * is chosen from a provider or checked.
   */
  provider_listing: ArtworkProviderListing[];
  reason: string | null;
  resolved_source: ArtworkResolvedSource;
  selection: LocalArtworkAsset | null;
  [k: string]: unknown;
}
/**
 * Where a provider image came from and who made it. Recorded per origin, never
 * replaced by a later identical import, and shown wherever the image is credited.
 */
export interface ArtworkAttribution {
  /**
   * The provider's identity for this image.
   */
  asset_id: number;
  author_name: string;
  author_steam64: string | null;
  fetched_at: number;
  /**
   * The provider's game the image was listed under; a proposal, not port identity.
   */
  game_id: number;
  provider: ArtworkProvider;
  role: DestinationArtworkRole;
  source_url: string;
}
export interface ArtworkChoice {
  asset_sha256: string | null;
  port_id: string;
  revision: number;
  slot: ArtworkSlot;
}
export interface GeneratedArtworkFallback {
  identity: string;
  initials: string;
  palette_index: number;
  style_version: number;
}
/**
 * Recorded evidence of whether a provider still lists a credited image. A
 * confirmed withdrawal (`withdrawn_at`) can remove a provider-only copy; see
 * [`ArtworkState::evicted_at`].
 */
export interface ArtworkProviderListing {
  asset_id: number;
  /**
   * When a check or a choice last established this evidence.
   */
  last_checked_at: number;
  last_result: SteamGridDbListingResult;
  /**
   * When a verified listing first lacked the image; cleared only when it is
   * seen listed again.
   */
  not_listed_since: number | null;
  provider: ArtworkProvider;
  withdrawal_signal: ArtworkWithdrawalSignal | null;
  /**
   * When a later check confirmed the withdrawal; cleared when the image is
   * seen listed again or chosen again.
   */
  withdrawn_at: number | null;
}
/**
 * Maintainer-reviewed catalog mapping. These public IDs never contain Twitch
 * credentials; the image CDN can serve the mapped cover without an API token.
 */
export interface IgdbArtwork {
  cover_id: number;
  game_id: number;
  game_slug: string;
  image_id: string;
  image_sha256: string;
  match_kind: IgdbArtworkMatch;
}
export interface OutputArtworkThumbnail {
  asset_sha256: string;
  choice_revision: number;
  png: number[];
  [k: string]: unknown;
}
export interface BackupRecord {
  /**
   * Present only for snapshots Portcove took automatically.
   */
  automatic?: AutomaticSnapshotLabel | null;
  created_at: number;
  file_count: number;
  id: string;
  path: string;
  port_id: string;
  sha256: string;
  size: number;
  /**
   * Unknown player-side files kept in the backup's separate area (#5359).
   * They are not counted in `file_count`, and restore does not put them
   * back. Omitted when zero.
   */
  unknown_file_count?: number;
  [k: string]: unknown;
}
/**
 * Marks a snapshot Portcove took itself before a version change. Manual
 * snapshots carry none, and retention never removes a snapshot without one.
 */
export interface AutomaticSnapshotLabel {
  from_version: string | null;
  operation: VersionChangeKind;
  to_version: string;
  [k: string]: unknown;
}
export interface BackupActionPreview {
  action: BackupAction;
  backup: BackupRecord;
  current_user_data_exists: boolean;
  preview_sha256: string;
  retained_runtime_copy_will_be_deleted: boolean;
  safety_backup_will_be_created: boolean;
  [k: string]: unknown;
}
export interface OutputBackupInventory {
  backups: BackupRecord[];
  create_assessment: PortActionAssessment1;
  port_id: string;
  problems: BackupProblem[];
  /**
   * Read-only coverage interpretation; absent in older API responses.
   */
  protection?: PlayerDataProtection | null;
  restore_assessment: PortActionAssessment2;
  state: BackupInventoryState;
  [k: string]: unknown;
}
/**
 * Read-only eligibility to attempt creation; execution rechecks under its lock.
 */
export interface PortActionAssessment1 {
  action: PortAction;
  availability: PortActionAvailability;
  /**
   * The authoritative signed-definition reason, when it limits this action.
   */
  definition?: DefinitionEligibility | null;
  reason: PortActionReason;
  [k: string]: unknown;
}
export interface BackupProblem {
  backup_id: string | null;
  kind: BackupProblemKind;
  message: string;
  operation_id: string | null;
  path: string;
  proposed_action: string;
  [k: string]: unknown;
}
export interface PlayerDataProtection {
  catalog: ProtectionDeclaration;
  exclusions: string[];
  installations: InstallationProtection[];
  /**
   * Last completed port-scoped snapshot with a valid manifest. Payload integrity and
   * current restore eligibility are checked by the existing reviewed restore flow.
   */
  latest_completed_backup: BackupRecord | null;
  managed_data: ProtectionPath;
  port_id: string;
  problem: string | null;
  [k: string]: unknown;
}
export interface ProtectionDeclaration {
  definition_sha256: string;
  persistent_file_patterns: PersistentFilePattern[];
  persistent_paths: string[];
  saves_and_settings: SavesAndSettingsBehavior | null;
  [k: string]: unknown;
}
export interface InstallationProtection {
  collection: ProtectionCollectionState;
  /**
   * Declared fixed entries and current pattern matches, not a recursive backup inventory.
   */
  collection_candidates: ProtectionPath[];
  collection_root: string | null;
  /**
   * The checked contract used by collection; it can differ from either declaration.
   */
  effective: ProtectionDeclaration | null;
  exclusions: string[];
  install_id: string;
  install_root: string;
  problem: string | null;
  /**
   * None means there is no verified retained declaration, including legacy installs.
   */
  retained: ProtectionDeclaration | null;
  role: ProtectionInstallRole;
  update_owner: InstallationUpdateOwner;
  version: string;
  [k: string]: unknown;
}
export interface ProtectionPath {
  path: string;
  /**
   * Presence is metadata only; it does not establish readability or backup integrity.
   */
  state: "present" | "missing" | "unsafe" | "unreadable";
  [k: string]: unknown;
}
/**
 * Eligibility to review a usable snapshot; consent and execution remain authoritative.
 */
export interface PortActionAssessment2 {
  action: PortAction;
  availability: PortActionAvailability;
  /**
   * The authoritative signed-definition reason, when it limits this action.
   */
  definition?: DefinitionEligibility | null;
  reason: PortActionReason;
  [k: string]: unknown;
}
export interface OutputCapabilities {
  adapters: AdapterKind[];
  /**
   * Optional read-only destination handoff; negotiate independently of API/events.
   */
  artwork_handoff_schema?: number | null;
  commands: string[];
  /**
   * Installed engine contracts; these do not grant definition admission.
   */
  engine_templates: EngineTemplateCapability[];
  failure_isolated_batches: string[];
  listing_formats?: number[];
  machine_formats: string[];
  /**
   * Schema used by JSONL operation events, independently from result envelopes.
   */
  operation_event_schema_version: number;
  platforms: Platform[];
  port_capability_schema?: number | null;
  port_operation_locking: string;
  product: string;
  product_version: string;
  raw_stream_commands: string[];
  schema_version: number;
  [k: string]: unknown;
}
export interface EngineTemplateCapability {
  contract_version: number;
  template: AdapterKind;
}
export interface CatalogDocument {
  ports: PortDefinition[];
  schema_version: number;
  source_catalog?: SourceCatalog | null;
  /**
   * Core-owned schema-1 compatibility projection. Schema-2 input may omit it;
   * when present it must equal the deterministic projection from `source_catalog`.
   */
  source_profiles?: SourceProfile[];
  [k: string]: unknown;
}
export interface PortDefinition {
  adapter: AdapterKind;
  archive_data_compatibility_v1?: ArchiveDataCompatibilityV1 | null;
  archive_data_transition_v1?: ArchiveDataTransitionV1 | null;
  automated_tested_platforms: Platform[];
  bios_source_profile: string | null;
  bundled_runtime: {
    "linux-x86-64"?: BundledRuntime;
    "macos-aarch64"?: BundledRuntime;
    "macos-x86-64"?: BundledRuntime;
    "windows-x86-64"?: BundledRuntime;
  };
  channels: ReleaseChannel[];
  executable_hints: {
    "linux-x86-64"?: string[];
    "macos-aarch64"?: string[];
    "macos-x86-64"?: string[];
    "windows-x86-64"?: string[];
  };
  /**
   * Native9: check the external roots selected by the final game environment.
   */
  external_profile_policy?: ExternalProfilePolicy | null;
  /**
   * Optional, release-bound editable configuration. Retained installations
   * keep the exact declaration; today's catalog never grants edits to them.
   */
  game_settings?: GameSettingsContract | null;
  id: string;
  launch_arguments: string[];
  /**
   * Reviewed way a managed multi-disc runtime accepts the disc to start.
   * Without it, Portcove offers no disc choice at launch.
   */
  launch_disc_choice?: LaunchDiscChoice | null;
  launch_environment: {
    [k: string]: string;
  };
  launch_from_install_root: boolean;
  /**
   * Native25: keep the Linux player's portable profile in this declared
   * directory beside the executable, creating it when absent before Play.
   */
  linux_portable_data_directory?: string | null;
  /**
   * Catalog-owned containment for a managed route whose current upstream
   * release still matches its selector but changed reviewed behavior.
   */
  managed_acquisition_hold?: ManagedAcquisitionHold | null;
  managed_initialization?: ManagedInitialization | null;
  managed_shared_preferences?: PreparedSharedPreferencesContract | null;
  /**
   * Reviewed engine save identifier used only to bound managed GB save paths.
   */
  managed_shared_preferences_save_id?: string | null;
  manually_validated_platforms: Platform[];
  mod_package_policy?: ModPackagePolicy | null;
  /**
   * Keep a reviewed N64 package's runtime and data beside its selected player,
   * including when upstream changes the outer archive wrapper name.
   */
  n64_runtime_at_executable_parent?: boolean;
  /**
   * Seed D3D12 only for a fresh Windows N64 portable runtime; never replace settings.
   */
  n64_windows_initial_d3d12?: boolean;
  name: string;
  /**
   * A disc-image source that is offered but not required: with none registered the
   * game is not blocked and the runtime and its persistent files are left as they are;
   * when one is registered it is unpacked as for a required source. Only valid with a
   * disc-image materialization.
   */
  optional_game_source?: boolean;
  persistent_file_patterns: PersistentFilePattern[];
  persistent_paths: string[];
  platforms: Platform[];
  portable_marker: boolean;
  /**
   * Native19: create this empty file beside the launch working directory only when it
   * is missing. For engines whose portable mode is keyed on a named file that is also
   * their configuration, so it must be a declared persistent path and is never reset.
   */
  portable_marker_file?: string | null;
  presentation?: PortPresentation | null;
  project_url: string;
  release: ReleaseSpec;
  /**
   * Bounded fingerprint of the reviewed package layout for each platform. A
   * release that still matches the asset selector but extracts to a different
   * layout is held for review instead of installing as an ordinary update.
   */
  reviewed_package_layouts?: {
    "linux-x86-64"?: ReviewedPackageLayout;
    "macos-aarch64"?: ReviewedPackageLayout;
    "macos-x86-64"?: ReviewedPackageLayout;
    "windows-x86-64"?: ReviewedPackageLayout;
  };
  runtime_data_policy?: RuntimeDataPolicy | null;
  /**
   * Required by, and only valid with, the disc-image unpacking
   * materializations: image kind, size bound and accepted game identifiers.
   */
  runtime_disc_image?: DiscImageProfile | null;
  runtime_mutable_file_patterns?: PersistentFilePattern[];
  runtime_mutable_paths: string[];
  /**
   * Required by, and only valid with, the `rom-patch` materialization: the
   * patch format and the exact original and patch members it combines.
   */
  runtime_rom_patch?: RomPatchProfile | null;
  runtime_source_filename: string | null;
  runtime_source_hashes: {
    [k: string]: string;
  };
  runtime_source_materialization: RuntimeSourceMaterialization | null;
  runtime_source_set: RuntimeSourceTarget[];
  /**
   * Only valid with the `stfs-directory` materialization: accepted header title IDs
   * and content types and a size bound, checked before extraction.
   */
  runtime_stfs_package?: StfsPackageProfile | null;
  runtime_subdirectory: string | null;
  /**
   * Per-platform runtime subdirectories for packages whose wrapper folder is named differently
   * on each platform; a listed platform replaces `runtime_subdirectory`. Requires
   * n64-recomp-portable capability 6.
   */
  runtime_subdirectory_by_platform?: {
    "linux-x86-64"?: string;
    "macos-aarch64"?: string;
    "macos-x86-64"?: string;
    "windows-x86-64"?: string;
  };
  setup_arguments: string[];
  setup_executable_hints: {
    "linux-x86-64"?: string[];
    "macos-aarch64"?: string[];
    "macos-x86-64"?: string[];
    "windows-x86-64"?: string[];
  };
  setup_marker: string | null;
  setup_output_paths: string[];
  source_environment: string | null;
  source_profile: string | null;
  summary: string;
  support_tier: SupportTier;
  upstream_status: "active" | "retired" | "superseded" | "abandoned";
  user_data_environment: string | null;
  windows_runtime_path_policy?: WindowsRuntimePathPolicy | null;
  /**
   * Official Shipwright Windows portable packages write player data in their working directory.
   */
  windows_shipwright_persistence?: boolean;
  /**
   * Native5: dedicated entry-owned data directory used for Windows TEMP/TMP.
   * The upstream process must preserve the reviewed working directory.
   */
  windows_temp_directory?: string | null;
  /**
   * Reviewed Windows tracked handoff: the game can restart into a successor
   * from its own process tree, so the session also waits for job members
   * whose image lies in the install root. Without it, the original process
   * is the whole session.
   */
  windows_tracked_handoff?: boolean;
  [k: string]: unknown;
}
/**
 * Reviewed conventional data shared by compatible runtimes. Every other
 * persistent object remains bound to its producing archive, including unknown
 * children of a declared directory. This does not rewind data on rollback.
 */
export interface ArchiveDataCompatibilityV1 {
  /**
   * Player progress that cannot move to a different producing archive.
   */
  build_specific_progress_paths: string[];
  contract_id: string;
  shared_paths: string[];
}
/**
 * One finite reviewed predecessor admission, separate from data layout identity.
 * It never redefines that runtime's original source or execution contract.
 */
export interface ArchiveDataTransitionV1 {
  creating_contract_sha256: string;
  predecessor_archive_sha256: string;
}
export interface BundledRuntime {
  archive_root: string;
  asset: ReleaseAsset;
  executable: string;
  target_directory: string;
  [k: string]: unknown;
}
export interface GameSettingsContract {
  files: GameSettingsFile[];
  format_version: number;
  releases: GameSettingsRelease[];
}
export interface GameSettingsFile {
  format: GameSettingsFormat;
  id: string;
  maximum_bytes: number;
  /**
   * An explicit configuration file inside this port's retained persistent
   * paths, never a home-directory template or a caller-provided absolute path.
   */
  path: string;
  settings: GameSetting[];
}
export interface GameSetting {
  id: string;
  /**
   * JSON object members; INI uses one flat key or two section/key components.
   * No array indexing, wildcards, substitutions or executable expressions.
   */
  key: string[];
  label: string;
  value: GameSettingType;
}
export interface GameSettingChoice {
  label: string;
  value: unknown;
}
/**
 * Both the released archive and its inspected source are explicit. A matching
 * title or version string alone cannot qualify another package's settings.
 */
export interface GameSettingsRelease {
  archive_sha256: string;
  evidence_urls: string[];
  platform: Platform;
  source_commit: string;
  version: string;
}
/**
 * Holds fresh managed acquisition and adoption for one route. Installed copies
 * keep their retained definition; only the listed reviewed artifacts may still
 * be activated or recovered.
 */
export interface ManagedAcquisitionHold {
  /**
   * Player-facing explanation for a refused staged activation.
   */
  activation_reason: string;
  /**
   * Player-facing explanation for refused Install and Update.
   */
  reason: string;
  /**
   * Exact reviewed artifacts whose activation remains permitted.
   */
  reviewed_artifacts?: ReviewedHoldArtifact[];
}
export interface ReviewedHoldArtifact {
  sha256: string;
  version: string;
}
/**
 * Additive catalog-owned facts intended for user-facing clients. Older catalog
 * documents may omit this object; current embedded definitions provide it.
 */
export interface PortPresentation {
  artwork?: IgdbArtwork | null;
  installation_method: InstallationMethod;
  manual_preparation?: string | null;
  manual_setup?: ManualSetupGuide | null;
  /**
   * Absent legacy metadata may use the directory; an explicit empty list clears it.
   */
  media?: CatalogMediaAsset[] | null;
  original_game?: OriginalGameIdentity | null;
  /**
   * Descriptive display metadata only. This never replaces the port, source,
   * release or library identity. Explicit original_game metadata owns display grouping.
   */
  original_game_title?: string | null;
  /**
   * Optional inert quality observations. Unknown or malformed recommendation
   * schemas are retained for compatible readers but never invalidate operations.
   */
  recommendation?: unknown;
  saves_and_settings: SavesAndSettingsBehavior;
  source_requirements: SourceRequirementPresentation[];
  variant_label?: string | null;
  [k: string]: unknown;
}
export interface CatalogMediaAsset {
  attribution: string;
  caption: string;
  /**
   * Reviewed applicability across offered original editions, for any media role.
   * Absence never implies that an offered edition is the selected edition.
   */
  edition_neutral?: boolean | null;
  height: number;
  id: string;
  igdb?: IgdbGameImage | null;
  license: string;
  rights_url: string;
  role: CatalogMediaRole;
  sha256: string;
  source_url: string;
  subject: CatalogMediaSubject;
  url: string;
  width: number;
}
/**
 * A reviewed mapping from IGDB's game-logo or artwork endpoint. These are
 * public descriptive IDs, never API credentials or installation authority.
 */
export interface IgdbGameImage {
  alpha_channel?: boolean | null;
  game_id: number;
  game_slug: string;
  image_id: string;
  image_type?: number | null;
  image_type_name?: string | null;
  kind: IgdbGameImageKind;
  record_id: number;
}
/**
 * Reviewed descriptive identity only; port, installation and source authority remain separate.
 */
export interface OriginalGameIdentity {
  evidence_urls: string[];
  format_version: number;
  id: string;
  /**
   * Empty means editions are not specified; never assume a PC edition.
   */
  source_editions: SourceEdition[];
}
export interface SourceEdition {
  evidence_urls: string[];
  id: string;
  /**
   * Original source system, distinct from the port's target operating systems.
   */
  system?: string | null;
  title: string;
}
export interface ReleaseSpec {
  /**
   * Native13: the package relies on in-archive file links, which extraction writes as
   * regular copies of the files they name.
   */
  archive_file_links?: boolean;
  asset_hints: {
    "linux-x86-64"?: string[];
    "macos-aarch64"?: string[];
    "macos-x86-64"?: string[];
    "windows-x86-64"?: string[];
  };
  /**
   * Inert exact-byte proposal records; runtime authority is separately admitted.
   */
  curated?: {
    "linux-x86-64"?: CuratedAcquisitionRecord;
    "macos-aarch64"?: CuratedAcquisitionRecord;
    "macos-x86-64"?: CuratedAcquisitionRecord;
    "windows-x86-64"?: CuratedAcquisitionRecord;
  };
  direct: {
    "linux-x86-64"?: DirectReleaseSpec;
    "macos-aarch64"?: DirectReleaseSpec;
    "macos-x86-64"?: DirectReleaseSpec;
    "windows-x86-64"?: DirectReleaseSpec;
  };
  /**
   * Native22, Libultraship4 or GeneratedCache2 (by adapter): after extraction on a Unix platform, grant
   * execute permission to the declared executable only when it verifies as a binary for
   * that platform. The publisher's own executable bit, when present, is never changed.
   */
  grant_declared_executable?: boolean;
  /**
   * Native8: select the checked TAR.XZ player archive on Linux x86-64.
   */
  linux_tar_xz?: boolean;
  /**
   * Core-owned fixed original-driven recipes, distinct from downloaded executables.
   */
  managed_build?: {
    "linux-x86-64"?: CartridgeBuildRecipe;
    "macos-aarch64"?: CartridgeBuildRecipe;
    "macos-x86-64"?: CartridgeBuildRecipe;
    "windows-x86-64"?: CartridgeBuildRecipe;
  };
  provider: "github" | "gitlab" | "direct-manifest" | "user-prepared";
  repository: string;
  rolling_tag: string | null;
  /**
   * GeneratedCache3: select a checked TAR.XZ player archive on the declared Mac routes.
   */
  tar_xz_platforms?: Platform[];
  user_prepared: {
    "linux-x86-64"?: UserPreparedRuntimeSpec;
    "macos-aarch64"?: UserPreparedRuntimeSpec;
    "macos-x86-64"?: UserPreparedRuntimeSpec;
    "windows-x86-64"?: UserPreparedRuntimeSpec;
  };
  [k: string]: unknown;
}
export interface CuratedAcquisitionRecord {
  acquisition_evidence: CuratedEvidenceReference;
  acquisition_host: string;
  acquisition_url: string;
  asset_id: number;
  commit_sha1: string;
  distribution_basis: string;
  distribution_evidence: CuratedEvidenceReference;
  filename: string;
  independent_review: CuratedEvidenceReference;
  platform: Platform;
  /**
   * Record version 2 only: authorized alternate transports for the same
   * accepted bytes (#1306). Locations are never identity or authority; the
   * accepted size and SHA-256 above still decide every acquisition.
   */
  preserved_locations?: string[];
  protected_acceptance: CuratedEvidenceReference;
  record_version: number;
  release_id: number;
  repository: string;
  route: string;
  sha256: string;
  size: number;
  tag: string;
  upstream_url: string;
}
export interface CuratedEvidenceReference {
  sha256: string;
  url: string;
}
export interface DirectReleaseSpec {
  published_at: string | null;
  sha256: string;
  size: number;
  url: string;
  version: string;
  [k: string]: unknown;
}
export interface UserPreparedRuntimeSpec {
  archive_name: string;
  archive_sha256: string;
  archive_size: number;
  executable: string;
  /**
   * Digest of the bounded, sorted immutable file inventory after extraction.
   */
  immutable_tree_sha256: string;
  /**
   * Opt in to a library-private directory through the port's reviewed environment binding.
   */
  library_user_data?: boolean;
  mutable_paths: string[];
  /**
   * Regular, single-link mutable selectors that must remain present before launch.
   * Contents remain player-owned and are never frozen or seeded by registration.
   */
  required_mutable_files?: string[];
  /**
   * Read-only, version-scoped source-selection semantics; never seeds settings.
   */
  settings_contract?: PreparedRuntimeSettingsContract | null;
  /**
   * Explicit consent to the exact runtime's non-owned, shared preferences.
   */
  shared_preferences?: PreparedSharedPreferencesContract | null;
  source_argument_extension: string | null;
  /**
   * Bind an authenticated relative-file-set directory through source_environment.
   * This does not materialize archives or authorize writes to the source.
   */
  source_directory_environment?: boolean;
  trust?: ExternalRuntimeTrust;
  version: string;
  [k: string]: unknown;
}
/**
 * The parts of an extracted package whose change signals changed runtime
 * behavior: its top-level directories and every program or script (`.exe`,
 * `.appimage`, `.bat`, `.cmd`, `.ps1`, `.sh`, `.msi`, `.jar`, `.vbs`, `.lnk`, or
 * an executable mode bit on non-Windows packages). A single wrapper directory
 * (for example a versioned folder name) is looked through. Names and paths are
 * compared case-insensitively. Plain data files, documentation and libraries
 * (including DLLs) are not fingerprinted and may change between releases.
 */
export interface ReviewedPackageLayout {
  /**
   * Lowercase top-level directory names of the package root, sorted.
   */
  directories: string[];
  /**
   * Lowercase package-relative paths (with `/`) of every program or script at
   * any depth, sorted.
   */
  executables: string[];
  /**
   * Exclude verified macOS shared libraries from this fingerprint.
   */
  ignore_verified_macos_libraries?: boolean;
}
/**
 * Port declaration for a disc image that Portcove unpacks into a runtime
 * directory. Limits and identifiers are evidence-bound; none are inferred.
 */
export interface DiscImageProfile {
  format: DiscImageFormat;
  /**
   * Explicit bound on the selected image in bytes; at most 16 GiB.
   */
  max_image_bytes: number;
  /**
   * Game identifiers accepted from the disc: the `default.xex`/`default.xbe`
   * title ID (eight hex digits), the PS2 `SYSTEM.CNF` boot serial or the PSP
   * `PARAM.SFO` `DISC_ID`. At least one is required.
   */
  product_codes: string[];
  [k: string]: unknown;
}
/**
 * Port declaration for producing a patched runtime file from two members of the
 * port's file-set source. Both inputs are pinned to one exact SHA-256 each; the
 * output is pinned by the port's single `runtime_source_hashes` entry.
 */
export interface RomPatchProfile {
  format: RomPatchFormat;
  /**
   * Accepted filenames of the file-set member holding the unmodified original.
   */
  original_filenames: string[];
  /**
   * The one original this patch applies to; also an accepted SHA-256 of its member.
   */
  original_sha256: string;
  /**
   * Accepted filenames of the file-set member holding the patch file.
   */
  patch_filenames: string[];
  /**
   * The one reviewed patch file; also an accepted SHA-256 of its member.
   */
  patch_sha256: string;
}
export interface RuntimeSourceTarget {
  destination: string;
  materialization: RuntimeSourceMaterialization;
  source_filenames: string[];
  [k: string]: unknown;
}
/**
 * Port binding for an Xbox 360 STFS package that `stfs-directory` extracts. The
 * header facts are compared before anything is extracted, so another game, a title
 * update or downloadable content is refused first. Requires staged-source capability 32.
 */
export interface StfsPackageProfile {
  /**
   * Accepted header content types as eight uppercase hex digits; currently only
   * `000D0000` (Xbox Live Arcade title).
   */
  content_types: string[];
  /**
   * Explicit bound on the selected package in bytes; at most 16 GiB.
   */
  max_package_bytes: number;
  /**
   * Accepted header title IDs as eight uppercase hex digits. At least one is required.
   */
  title_ids: string[];
}
export interface SourceCatalog {
  contracts: PortSourceContract[];
  evidence: CatalogEvidence[];
  identities: SourceIdentityProfile[];
  /**
   * Exact qualification facts. Legacy platform arrays remain on the port and
   * are never promoted into these records because they do not identify an
   * artifact, source variant, representation, or check contract.
   */
  qualification: SourceEvidence[];
  validators: SourceValidatorContract[];
}
export interface PortSourceContract {
  admission_mode: CatalogAdmissionMode;
  aliases: string[];
  applicability: SourceContractApplicability[];
  authority_ref: string;
  evidence_gap: string | null;
  evidence_ids: string[];
  id: string;
  immutable_review_url: string;
  live_review_url: string | null;
  port_id: string;
  profile_id: string;
  /**
   * An explicit one-time acceptance of the declared source integration for
   * compatible provider releases. Exact historical evidence stays exact.
   */
  release_policy?: SourceReleasePolicy | null;
  reviewed_at: string;
  role: PortSourceRole;
  supported_variant_ids: string[];
  tombstones: string[];
  validator_contract_id: string | null;
}
export interface SourceContractApplicability {
  artifact_sha256: string | null;
  upstream_ref: string;
}
export interface CatalogEvidence {
  authority: string;
  authority_ref: string;
  claim: string;
  id: string;
  immutable_url: string;
  live_url: string | null;
  reviewed_at: string;
  role: CatalogEvidenceRole;
}
export interface SourceIdentityProfile {
  aliases: string[];
  evidence_gap: string | null;
  id: string;
  kind: SourceIdentityKind;
  label: string;
  tombstones: string[];
  variants: SourceVariant[];
}
export interface SourceVariant {
  evidence_ids: string[];
  id: string;
  /**
   * Transitional schema-1 projection input. The schema-2 inspector must not
   * classify or admit this record, and contracts may not reference it.
   */
  legacy_projection_only?: boolean;
  product_codes: string[];
  region: string | null;
  representations: SourceRepresentation[];
  revision: string | null;
  title: string;
}
/**
 * Digests inside one record are conjunctive and describe one exact byte scope.
 * Separate records and representations are alternatives.
 */
export interface DigestIdentity {
  crc32: string | null;
  scope: DigestScope;
  sha1: string | null;
  sha256: string | null;
}
export interface SourceMemberIdentity {
  filenames: string[];
  id: string;
  identities: DigestIdentity[];
  label: string;
}
/**
 * Exact relative paths and bytes; distinct from the existing basename file set.
 */
export interface RelativeSourceMemberIdentity {
  id: string;
  path: string;
  sha256: string;
  size: number;
}
export interface SourceDiscIdentity {
  id: string;
  identities: DigestIdentity[];
  label: string;
  track_counts: number[];
  volume_ids: string[];
}
/**
 * One extracted file of a content-identified STFS package.
 */
export interface StfsContentMember {
  /**
   * Relative path inside the package, compared without regard to ASCII case.
   */
  path: string;
  sha256: string;
}
export interface SourceValidatorContract {
  evidence_ids: string[];
  id: string;
  protocol_version: string;
  tool_id: string;
}
export interface SourceProfile {
  accepted_extensions: string[];
  accepted_sha1: string[];
  accepted_sha256: string[];
  disc: DiscSourceProfile | null;
  id: string;
  kind: "file" | "file-set" | "relative-file-set" | "gamecube-disc" | "psx-disc" | "upstream-validated-disc";
  label: string;
  members: SourceMemberProfile[];
  [k: string]: unknown;
}
export interface DiscSourceProfile {
  discs: DiscIdentityProfile[];
  track_counts: number[];
  [k: string]: unknown;
}
export interface DiscIdentityProfile {
  accepted_sha1: string[];
  accepted_sha256: string[];
  accepted_volume_ids: string[];
  label: string;
  track_counts: number[];
  [k: string]: unknown;
}
export interface SourceMemberProfile {
  accepted_crc32: string[];
  accepted_filenames: string[];
  accepted_sha1: string[];
  accepted_sha256: string[];
  id: string;
  label: string;
  [k: string]: unknown;
}
export interface OutputCatalogDownloadCandidates {
  allowed: boolean;
  candidates: CatalogDownloadCandidate[];
  /**
   * Absent when an availability or provider refusal prevented discovery.
   */
  coverage: CatalogDownloadCoverage | null;
  default_destination_parent: string | null;
  packages: CatalogPackageAssessment[];
  port_id: string;
  reason: string | null;
  recommendation_reason: string;
  recommended_asset_id: CatalogDownloadAssetId | null;
  /**
   * Present when the listing download is refused because another route
   * serves this host; `reason` carries the same player explanation.
   */
  refusal?: CatalogDownloadRefusal | null;
  releases: CatalogDownloadRelease[];
  selected_release_id: CatalogDownloadReleaseId | null;
  upstream_url: string;
  [k: string]: unknown;
}
export interface CatalogDownloadCandidate {
  asset_id: CatalogDownloadAssetId;
  can_extract: boolean;
  download_url: string;
  name: string;
  release_id: CatalogDownloadReleaseId;
  release_tag: string;
  release_url: string;
  sha256: string | null;
  size: number;
  [k: string]: unknown;
}
export interface CatalogDownloadCoverage {
  candidate_limit: number;
  /**
   * All assets from the returned published releases are represented.
   */
  candidates_complete: boolean;
  /**
   * Files that could not enter this provider's qualified download route.
   */
  limitations?: string[];
  /**
   * A short first page established the end of the visible release history.
   */
  release_history_complete: boolean;
  release_limit: number;
  /**
   * Published releases whose dedicated asset inventory was fully inspected.
   */
  releases_checked: number;
  [k: string]: unknown;
}
export interface CatalogPackageAssessment {
  asset_id: CatalogDownloadAssetId;
  reason: string;
  suitability: string;
  [k: string]: unknown;
}
export interface CatalogDownloadRelease {
  assets_complete: boolean;
  id: CatalogDownloadReleaseId;
  preview: boolean;
  tag: string;
  [k: string]: unknown;
}
export interface OutputCatalogDownloadPreview {
  artifact: CatalogDownloadCandidate;
  destination_path: string;
  preview_sha256: string;
  request: CatalogDownloadRequest;
  [k: string]: unknown;
}
export interface CatalogDownloadRequest {
  asset_id: CatalogDownloadAssetId;
  destination_parent: string;
  extract_archive: boolean;
  port_id: string;
  release_id: CatalogDownloadReleaseId;
}
/**
 * Independently versioned directory projection. Format 2 can restrict fresh
 * downloads; format 3 adds game/edition identity; format 4 adds inert observations
 * and reason-bearing display overrides/maintenance. No format grants operations.
 */
export interface CatalogListingDocument {
  format_version: number;
  listings: PortListing[];
}
/**
 * Descriptive project information. A listing never grants managed installation,
 * executable selection, source access or ownership of an external directory.
 */
export interface PortListing {
  artwork?: IgdbArtwork | null;
  /**
   * A dated discovery fact, not a managed support or artifact admission decision.
   */
  availability: "unknown" | "packages" | "source-only" | "unavailable";
  /**
   * Authored exception takes precedence over observations only with this reason.
   */
  availability_override_reason?: string | null;
  /**
   * Inert optional advisory envelope. Invalid/future content is unavailable as advice,
   * never an acquisition restriction or an operation grant. Requires listing format 7.
   */
  compatibility?: unknown;
  /**
   * Advisory literal filename hints for an upstream-owned download. They do
   * not authenticate a package or grant installation/execution ownership.
   */
  download_asset_hints?: {
    "linux-x86-64"?: string[];
    "macos-aarch64"?: string[];
    "macos-x86-64"?: string[];
    "windows-x86-64"?: string[];
  };
  /**
   * A reviewed restriction on fresh self-service downloads only. It grants
   * no execution, management or permission over an existing copy.
   */
  download_block_reason?: string | null;
  /**
   * Reviewed pages where the upstream developers accept funding, normally taken
   * from the project's `FUNDING.yml` at authoring time. Descriptive only: public
   * HTTPS links that grant nothing. Requires listing format 10; when present it
   * is never empty, so an earlier strict reader never meets an inert empty key.
   */
  funding_urls?: string[] | null;
  id: string;
  issue_number?: number | null;
  /**
   * The UTC date (`YYYY-MM-DD`) this listing was first added to the directory.
   * Descriptive only: it orders a "Recently added" view and grants nothing.
   * Requires listing format 9.
   */
  listed_at?: string | null;
  manual_setup?: ManualSetupGuide | null;
  media?: CatalogMediaAsset[];
  name: string;
  original_game?: OriginalGameIdentity | null;
  original_game_title?: string | null;
  /**
   * Empty means unknown; it is not an execution compatibility declaration.
   */
  platforms: Platform[];
  project_url: string;
  /**
   * Initial self-service release choice only; never the installed update policy.
   */
  recommended_download_channel?: ReleaseChannel | null;
  release_maintenance?: ListingReleaseMaintenance | null;
  release_url?: string | null;
  setup_url?: string | null;
  summary: string;
  /**
   * Accepted descriptive observation, never a package or execution grant.
   */
  upstream_observation?: ListingUpstreamObservation | null;
  variant_label?: string | null;
}
export interface ListingReleaseMaintenance {
  /**
   * Derived from accepted direct contracts, not independently maintained versions.
   */
  pinned_releases: ListingPinnedRelease[];
  reason: string;
  reconsider_when: string;
}
export interface ListingPinnedRelease {
  platform: Platform;
  published_at: string | null;
  version: string;
}
export interface ListingUpstreamObservation {
  attempted_at: string;
  facts_sha256: string | null;
  fresh_until: string | null;
  observed_at: string | null;
  provider: string;
  release_limit: number;
  releases: ListingObservedRelease[];
  repository: string;
  repository_id: number | null;
  status: ListingObservationStatus;
}
export interface ListingObservedRelease {
  assets: ListingObservedAsset[];
  assets_complete: boolean;
  id: CatalogDownloadReleaseId;
  provider_prerelease: boolean;
  published_at: string;
  release_url: string;
  version: string;
}
export interface ListingObservedAsset {
  id: number;
  name: string;
  /**
   * Descriptive authored filename hints, never execution capabilities.
   */
  platform_hints: Platform[];
  /**
   * Provider-reported claim; this does not verify downloaded bytes.
   */
  sha256: string | null;
  size: number;
  url: string;
}
export interface CatalogProvenance {
  catalog_sha256: string;
  expires_at: number | null;
  fallback_reasons: string[];
  key_id: string | null;
  origin: CatalogOrigin;
  sequence: number | null;
  [k: string]: unknown;
}
export interface OutputCatalogStatus {
  can_rollback: boolean;
  can_use_cached: boolean;
  highest_sequence: number;
  provenance: CatalogProvenance;
  state_sha256: string;
  trusted_keys: CatalogTrustKey[];
  updates_enabled: boolean;
  [k: string]: unknown;
}
export interface CatalogTrustKey {
  key_id: string;
  public_key: string;
  [k: string]: unknown;
}
export interface OutputCatalogUpdatePlan {
  changed_port_ids: string[];
  changed_ports: CatalogChangedPort[];
  current: CatalogProvenance;
  envelope_sha256: string;
  expires_at: number;
  issued_at: number;
  key_id: string;
  plan_sha256: string;
  sequence: number;
  source: CatalogUpdateSource;
  [k: string]: unknown;
}
export interface CatalogChangedPort {
  id: string;
  name: string;
  [k: string]: unknown;
}
export interface OutputCheckBatchOutcome {
  error: FailureReport | null;
  ok: boolean;
  port_id: string;
  result: UpdateCheck | null;
  [k: string]: unknown;
}
export interface OutputDefinitionAuthorityProvisioning {
  changed: boolean;
  review: DefinitionAuthorityReview;
  [k: string]: unknown;
}
export interface DefinitionAuthorityReview {
  compiled_anchor_sha256: string | null;
  configured: boolean;
  expected_plan: string;
  installed: boolean;
  installed_anchor_sha256: string | null;
  library_id: string;
  provisioning_schema: number;
  [k: string]: unknown;
}
export interface OutputDefinitionCapabilityReport {
  capability_contract_schema: number;
  checks: DefinitionCapabilityResult[];
  compatible: boolean;
  [k: string]: unknown;
}
export interface DefinitionCapabilityResult {
  installed_version: number | null;
  outcome: DefinitionCapabilityOutcome;
  requirement: DefinitionCapabilityRequirement;
  [k: string]: unknown;
}
export interface DefinitionCapabilityRequirement {
  maximum_version: number;
  minimum_version: number;
  template: string;
}
export interface OutputDefinitionCapabilityRequest {
  capability_contract_schema: number;
  required_capabilities: DefinitionCapabilityRequirement[];
}
export interface OutputDefinitionRefresh {
  disposition: DefinitionRefreshDisposition;
  eligibility: DefinitionEligibility | null;
  launch_assessment_changed: boolean;
  namespace: string;
  policy_changed: boolean;
  refresh_schema: number;
  selection: DefinitionSelectionStatus;
  stable_id: string;
  [k: string]: unknown;
}
export interface DefinitionSelectionStatus {
  can_rollback: boolean;
  replay_floor: DefinitionReplayFloor | null;
  revision: number;
  selected: DefinitionSelectionIdentity | null;
  [k: string]: unknown;
}
/**
 * Highest authenticated metadata identities accepted with a selected definition snapshot.
 *
 * The floor is inert until a later catalog-selection transaction persists it. Each digest is
 * the canonical signed body for that TUF role, excluding replaceable signature bytes.
 */
export interface DefinitionReplayFloor {
  definitions_sha256: string;
  definitions_version: number;
  index_sha256: string;
  root_sha256: string;
  root_version: number;
  snapshot_sha256: string;
  snapshot_version: number;
  targets_sha256: string;
  targets_version: number;
  timestamp_sha256: string;
  timestamp_version: number;
  [k: string]: unknown;
}
export interface OutputDestinationArtworkBytes {
  handoff: DestinationArtworkHandoff;
  /**
   * Exact bounded original bytes, with no resize, crop, URL or filesystem path.
   */
  original: number[];
}
/**
 * An observation, never provider permission, destination ownership or write consent.
 * Portrait exposes the validated local cover original; hero banner and landscape
 * cover expose the validated local detail or landscape original only when it is
 * wider than tall. Catalog defaults remain explicit unavailable states; nothing is
 * synthesized, cropped or resized from another role or cache.
 */
export interface DestinationArtworkHandoff {
  /**
   * Provider credits for the selected local image, shown by a destination that
   * presents the image; empty for a purely local import and every other source.
   */
  attribution: ArtworkAttribution[];
  choice: ArtworkChoice | null;
  content: DestinationArtworkContent;
  handoff_schema: number;
  library: LibraryIdentity;
  port_id: string;
  role: DestinationArtworkRole;
  selected_asset_sha256: string | null;
  source: DestinationArtworkSource;
}
/**
 * Durable library identity and its current effective location.
 */
export interface LibraryIdentity {
  /**
   * Opaque identity, preserved by managed moves; not an authentication token.
   */
  id: string;
  /**
   * Current location, which may differ from the root originally requested.
   */
  root: string;
  [k: string]: unknown;
}
export interface OutputDoctor {
  catalog_port_count: number;
  catalog_provenance: CatalogProvenance;
  host_tools: HostToolStatus[];
  installed_port_count: number;
  library: StorageSummary;
  platform: Platform;
  registered_source_count: number;
  repair: RepairPlan;
  [k: string]: unknown;
}
export interface HostToolStatus {
  configuration_variable: string;
  display_name: string;
  id: string;
  official_url: string;
  path: string | null;
  purpose: string;
  source: HostToolSource | null;
  state: HostToolState;
  [k: string]: unknown;
}
export interface StorageSummary {
  library_root: string;
  volume_available_bytes: number;
  volume_total_bytes: number;
  [k: string]: unknown;
}
export interface RepairPlan {
  generated_at: number;
  items: RepairItem[];
  /**
   * Absent in older reports. A successful current enumeration can still
   * contain invalid rows and is never proof that operations may be recovered.
   */
  journal_diagnostics?: JournalDiagnostics | null;
  [k: string]: unknown;
}
export interface RepairItem {
  kind: RepairItemKind;
  message: string;
  operation_id: string | null;
  path: string | null;
  port_id: string | null;
  proposed_action: string;
  [k: string]: unknown;
}
/**
 * Complete SQL enumeration is distinct from successful row interpretation.
 * This is observation only; even a decoded row is not proof of recoverability.
 */
export interface JournalDiagnostics {
  decoded_rows: number;
  enumerated_rows: number;
  enumeration_complete: boolean;
  problems: JournalRowProblem[];
  /**
   * False when malformed state prevents dependent orphan/backup assessments.
   */
  related_assessments_complete: boolean;
  [k: string]: unknown;
}
export interface JournalRowProblem {
  /**
   * Bounded untrusted observations. Absent if unreadable or unsafe to display.
   */
  operation_id: string | null;
  operation_kind: string | null;
  port_id: string | null;
  /**
   * Static explanation; never raw JSON, parser text, paths or environment data.
   */
  reason: string;
  /**
   * Local SQLite locator, never an operation capability or filesystem path.
   */
  rowid: number;
  stage: JournalValidationStage;
  [k: string]: unknown;
}
export interface ExternalRuntimePreview {
  archive_sha256: string;
  executable: string;
  immutable_file_count: number;
  immutable_tree_sha256: string;
  path: string;
  port_id: string;
  preview_sha256: string;
  shared_preferences?: SharedPreferencesReview | null;
  user_selected?: UserSelectedLaunch | null;
  version: string;
  [k: string]: unknown;
}
export interface SharedPreferencesReview {
  binding: AcceptedSharedPreferencesBinding;
  local_fallback_path: string | null;
  local_fallback_present: boolean;
  present: boolean;
}
/**
 * Review of a location change for the same retained external installation.
 * No files are moved, adopted, deleted or upgraded by this operation.
 */
export interface OutputExternalRuntimeRelinkPreview {
  external_files_will_be_preserved: boolean;
  port_id: string;
  preview_sha256: string;
  previous_path: string;
  proposed: ExternalRuntimePreview;
  registration_id: string;
  [k: string]: unknown;
}
export interface OutputExternalRuntimeRemovalPreview {
  external_files_will_be_preserved: boolean;
  path: string;
  port_id: string;
  preview_sha256: string;
  version: string;
  [k: string]: unknown;
}
export interface OutputGameComparison {
  assessment: PortRecommendationAssessment | null;
  edition_id: string | null;
  editions: ComparisonEdition[];
  environment_id: string;
  evaluated_at: number;
  format_version: number;
  game_id: string | null;
  input_id: string;
  limitations: string[];
  platform: Platform;
  policy_version: string;
  ports: ComparisonPort[];
  required_capabilities: string[];
  source_context_is_hypothetical: boolean;
  source_profile_ids: string[];
  [k: string]: unknown;
}
export interface PortRecommendationAssessment {
  candidates: RecommendationCandidateAssessment[];
  comparable: RecommendationScope[];
  evaluated_at: number;
  evidence_snapshot_id: string;
  policy_version: string;
  recommended: RecommendationScope | null;
  /**
   * Feed this union back through the existing observation store on refresh.
   * Corrections do not erase original failure evidence.
   */
  retained_regressions: RecommendationRegression[];
  status: PortRecommendationStatus;
  [k: string]: unknown;
}
export interface RecommendationCandidateAssessment {
  dimensions: RecommendationDimensionAssessment[];
  evidence: RecommendationEvidenceAssessment[];
  /**
   * Coverage of this policy's evidence, not probability of successful play.
   */
  evidence_coverage_permille: number;
  operation_eligibility: RecommendationOperationEligibility;
  /**
   * Diagnostic 0..10000, never a cross-game public quality score. All-unknown
   * evidence is None, not a displayed neutral 50/100.
   */
  ranking_score_basis_points: number | null;
  reasons: RecommendationReason[];
  recommendation_eligible: boolean;
  required_capabilities: {
    [k: string]: RecommendationRequirement;
  };
  scope: RecommendationScope;
  unresolved_regression_ids: string[];
  [k: string]: unknown;
}
export interface RecommendationDimensionAssessment {
  dimension: RecommendationDimension;
  evidence_ids: string[];
  rating: number | null;
  state: RecommendationDimensionState;
  strength_permille: number;
  weight_percent: number;
  [k: string]: unknown;
}
export interface RecommendationEvidenceAssessment {
  disposition: RecommendationEvidenceDisposition;
  evidence: RecommendationEvidence;
  [k: string]: unknown;
}
export interface RecommendationEvidence {
  claim: RecommendationClaim;
  dimension: RecommendationDimension;
  explanation: string;
  id: string;
  kind: RecommendationEvidenceKind;
  observed_at: number;
  scope: RecommendationScope;
  source: string;
  /**
   * Explicit accepted corrections, never implicit latest-report-wins ordering.
   */
  supersedes: string[];
}
export interface RecommendationScope {
  /**
   * Accepted artifact identity, not a mutable tag or download URL.
   */
  artifact_id: string;
  edition_id: string;
  /**
   * Explicit relevant environment identity; not inferred from the current host.
   */
  environment_id: string;
  game_id: string;
  platform: Platform;
  port_id: string;
  release_id: string;
  route_id: string;
  source_profile_id: string;
}
export interface RecommendationRegression {
  affected_scope: RecommendationScope1;
  /**
   * Missing in legacy history: retain the failure, withhold automatic correction.
   */
  dimension: RecommendationDimension | null;
  explanation: string;
  id: string;
  observed_at: number;
  source: string;
}
/**
 * Retain the originally affected artifact as provenance. A new artifact does
 * not itself resolve this accepted failure for the same route/environment.
 */
export interface RecommendationScope1 {
  /**
   * Accepted artifact identity, not a mutable tag or download URL.
   */
  artifact_id: string;
  edition_id: string;
  /**
   * Explicit relevant environment identity; not inferred from the current host.
   */
  environment_id: string;
  game_id: string;
  platform: Platform;
  port_id: string;
  release_id: string;
  route_id: string;
  source_profile_id: string;
}
export interface ComparisonEdition {
  evidence_urls: string[];
  id: string;
  system: string | null;
  title: string;
  [k: string]: unknown;
}
export interface ComparisonPort {
  declared_platforms: Platform[];
  edition_ids: string[];
  followed: boolean;
  freshness: ComparisonFreshness;
  installed: boolean;
  launch_ready: boolean;
  limitations: string[];
  metadata: RecommendationMetadataState;
  name: string;
  offered_identity: string | null;
  offered_release: ComparisonRelease | null;
  /**
   * Existing Core assessment, not recommendation policy. Never an execution token.
   */
  operation:
    | {
        kind: "allowed";
        [k: string]: unknown;
      }
    | {
        kind: "unknown";
        reason: string;
        [k: string]: unknown;
      }
    | {
        kind: "held";
        reason: string;
        [k: string]: unknown;
      };
  port_id: string;
  project_url: string;
  source_health: SourceHealth | null;
  source_profile_ids: string[];
  /**
   * A single current observed change, deduplicated by exact release/artifact identity.
   */
  update_notice: ComparisonUpdateNotice | null;
  [k: string]: unknown;
}
export interface ComparisonFreshness {
  last_attempt_at: number | null;
  /**
   * Successful provider resolution may use the provider's existing cache. This
   * is deliberately not labelled a fresh network request or upstream change time.
   */
  last_successful_resolution_at: number | null;
  offered_identity_changed_at: number | null;
  state: ComparisonReleaseState;
  [k: string]: unknown;
}
export interface ComparisonRelease {
  artifact_sha256: string;
  asset_name: string;
  channel: ReleaseChannel;
  published_at: string | null;
  size: number;
  version: string;
}
export interface ComparisonUpdateNotice {
  artifact_sha256: string;
  identity: string;
  observed_at: number;
  version: string;
  [k: string]: unknown;
}
export interface OutputGameComparisonRequest {
  edition_id: string | null;
  /**
   * An explicit observation environment, not a claim that this machine matches it.
   * Omission uses an unqualified environment and cannot inherit another device's evidence.
   */
  environment_id: string | null;
  /**
   * Explicit replay clock. Adapters must not replace a supplied clock.
   */
  evaluated_at: number | null;
  platform: Platform | null;
  /**
   * A current or retained listing. Only explicit original-game IDs relate alternatives.
   */
  port_id: string;
  /**
   * Reuse the existing provider's conditional requests, cache and network limits.
   */
  refresh: boolean;
  required_capabilities: string[];
  /**
   * Catalog profile IDs only. Omission uses this library's explicit registrations;
   * presence describes a hypothetical source context, not a fresh file verification.
   */
  source_profile_ids: string[] | null;
}
/**
 * Explicit refresh inputs. Inspection reports are never accepted from a client.
 */
export interface OutputGameFileQueryRequest {
  limits: RegisteredSourceInspectionLimits;
  maximum_age_seconds: number;
  routes: GameFileRouteRequest[];
}
export interface RegisteredSourceInspectionLimits {
  /**
   * Cooperative deadline, checked between reads; does not interrupt blocked filesystem calls.
   */
  max_elapsed_ms: number;
  max_file_bytes: number;
  max_hash_bytes: number;
}
export interface GameFileRouteRequest {
  channel: ReleaseChannel;
  platform: Platform;
  port_id: string;
  route: GameFileRouteKind;
}
export interface OutputGameFileQuerySnapshot {
  catalog_binding_sha256: string;
  expires_at: number;
  library: LibraryIdentity;
  observed_at: number;
  registration_sha256: string;
  routes: GameFileRouteProjection[];
  schema_version: number;
  selection_sha256: string;
  [k: string]: unknown;
}
export interface GameFileRouteProjection {
  channel: ReleaseChannel;
  contract_id: string | null;
  identity: SourceIdentity | null;
  platform: Platform;
  port_id: string;
  reason: GameFileQueryReason;
  route: GameFileRouteKind;
  route_definition_sha256: string | null;
  route_instance_sha256: string | null;
  /**
   * Digest of the complete registered instance, never its private path.
   */
  source_instance_sha256: string | null;
  state: GameFileQueryState;
  [k: string]: unknown;
}
export interface GameFileRoot {
  availability: GameFileRootAvailability;
  created_at: number;
  id: string;
  path: string;
  updated_at: number;
  [k: string]: unknown;
}
export interface OutputGameFileScanMatchPage {
  candidates: SourceRecord[];
  kind: GameFileScanMatchKind;
  next_offset: number | null;
  offset: number;
  preliminary_selections: SourceInspection[];
  /**
   * Absent when the current report keeps every match inline.
   */
  scan_id: string | null;
  /**
   * Matches of this kind (inside `root_id`, when given).
   */
  total: number;
  [k: string]: unknown;
}
export interface SourceRecord {
  /**
   * Versioned facts observed when this registration was created. Legacy rows and
   * metadata omit this field rather than guessing a schema-2 variant.
   */
  observed_identity?: ObservedSourceIdentity | null;
  path: string;
  profile_id: string;
  sha256: string;
  size: number;
  storage_sha256: string;
  storage_size: number;
  updated_at: number;
  [k: string]: unknown;
}
/**
 * Durable, catalog-independent facts observed when a source registration is written.
 * Classification and admission are intentionally recomputed from the active catalog.
 */
export interface ObservedSourceIdentity {
  archive_member_name?: string | null;
  components?: ObservedSourceComponent[];
  digests: ObservedSourceDigest[];
  schema_version: number;
  validator?: ObservedSourceValidator | null;
  [k: string]: unknown;
}
export interface ObservedSourceComponent {
  digests: ObservedSourceDigest[];
  id: string;
  kind: SourceComponentKind;
  name: string | null;
  size: number;
  track_count: number | null;
  volume_id: string | null;
  [k: string]: unknown;
}
export interface ObservedSourceDigest {
  algorithm: SourceDigestAlgorithm;
  scope: DigestScope;
  size: number;
  value: string;
  [k: string]: unknown;
}
export interface ObservedSourceValidator {
  contract_id: string;
  protocol_version: string;
  result: SourceValidatorResult;
  tool_id: string;
  [k: string]: unknown;
}
/**
 * Facts returned by read-only inspection. A record is present only when the
 * admission state permits existing callers to register or use the source.
 */
export interface SourceInspection {
  archive_member_name?: string | null;
  assessment: SourceAssessment;
  components: ObservedSourceComponent[];
  /**
   * Integrity checks that did not pass but did not decide admission, such as an STFS
   * hash-tree mismatch on a package already proven by its exact whole-file digest.
   */
  integrity_advisories?: string[];
  message: string;
  observed_digests: ObservedSourceDigest[];
  path: string;
  profile_id: string;
  record: SourceRecord | null;
  validator?: ObservedSourceValidator | null;
  [k: string]: unknown;
}
/**
 * One page of the current saved-folder scan's retained matches.
 */
export interface OutputGameFileScanMatchQuery {
  kind: GameFileScanMatchKind;
  /**
   * 1 to 512 matches.
   */
  limit: number;
  offset: number;
  /**
   * Only matches inside this saved folder.
   */
  root_id?: string | null;
  /**
   * The scan the caller is paging; a different current scan is a conflict.
   */
  scan_id?: string | null;
  [k: string]: unknown;
}
export interface GameFileScanSnapshot {
  catalog_sha256: string;
  completed_at: number;
  continuation?: unknown;
  coverage?: GameFileScanCoverage | null;
  format_version: number;
  freshness: GameFileScanFreshness;
  limits: SourceDiscoveryLimits | null;
  /**
   * Where the scan's retained matches live. When present, the report's
   * `candidates` and `preliminary_selections` are only a bounded preview
   * and every match is read in pages. Absent means every match is inline
   * in the report (older formats).
   */
  matches?: GameFileScanMatchSummary | null;
  report: SourceDiscoveryReport;
  roots: GameFileRoot[];
  [k: string]: unknown;
}
export interface GameFileScanCoverage {
  batch_entries_examined: number;
  batches: number;
  can_resume: boolean;
  entries_relisted: number;
  frontier_exhausted: boolean;
  metadata_checks: number;
  /**
   * File identities (one per file and representation) reused because the
   * recorded metadata and inspector version still match. Never admission.
   */
  observations_reused: number;
  pending_directories: number;
  prior_member_rechecks: number;
  remaining_entries: number | null;
  restart_required: boolean;
  [k: string]: unknown;
}
export interface SourceDiscoveryLimits {
  max_candidates: number;
  max_depth: number;
  max_entries: number;
  max_file_bytes: number;
  max_hash_bytes: number;
  [k: string]: unknown;
}
/**
 * Totals for one saved-folder scan's retained matches. The preview in the
 * report holds the first matches in page order, exact matches first.
 */
export interface GameFileScanMatchSummary {
  exact_matches: number;
  preliminary_selections: number;
  /**
   * Whether the report's preview holds every retained match.
   */
  preview_complete: boolean;
  scan_id: string;
  [k: string]: unknown;
}
export interface SourceDiscoveryReport {
  candidates: SourceRecord[];
  entries_examined: number;
  files_hashed: number;
  hash_bytes: number;
  issues: SourceDiscoveryIssue[];
  issues_omitted: number;
  limits_reached: SourceDiscoveryLimit[];
  /**
   * Preliminary selections are not exact matches and their pinned validator has not run.
   */
  preliminary_selections?: SourceInspection[];
  searched_profiles: string[];
  searched_roots: string[];
  symlinks_skipped: number;
  [k: string]: unknown;
}
export interface SourceDiscoveryIssue {
  message: string;
  path: string | null;
  profile_id: string | null;
  [k: string]: unknown;
}
/**
 * Exact registered-input review for the first managed installation.
 */
export interface GameInstallPlan {
  plan: InstallPlan;
  plan_sha256: string;
  /**
   * The exact existing copy that execution will activate, if any.
   */
  selected_install: InstallRecord | null;
  [k: string]: unknown;
}
export interface InstallPlan {
  action: InstallPlanAction;
  /**
   * Required recipe inputs in addition to the primary release and bundled runtime.
   * These are cold acquisition quantities; existing cache reuse is not guaranteed.
   */
  auxiliary_downloads?: ReleaseAsset[];
  bundled_runtime: BundledRuntime | null;
  channel: ReleaseChannel;
  download_bytes: number;
  output_location: PortOutputLocation;
  platform: Platform;
  port_id: string;
  preservation_notices?: string[];
  release: ResolvedRelease;
  shared_preferences?: ManagedSharedPreferencesReview | null;
  source_requirements: InstallSourceRequirement[];
  storage: StorageSummary;
  /**
   * Execution's temporary free-space floor, not a final installed-size estimate.
   */
  temporary_space?: InstallSpaceRequirement | null;
  [k: string]: unknown;
}
/**
 * Managed local fallback and non-owned account-wide preferences have distinct ownership.
 */
export interface ManagedSharedPreferencesReview {
  binding: AcceptedSharedPreferencesBinding;
  local_fallback_path: string;
  local_fallback_present: boolean;
  shared_present: boolean;
}
export interface InstallSourceRequirement {
  label: string;
  /**
   * The definition offers this source but does not require it; an unregistered
   * optional source never blocks installing, updating or launching.
   */
  optional?: boolean;
  profile_id: string;
  registered: boolean;
  role: SourceRequirementRole;
  [k: string]: unknown;
}
export interface InstallSpaceRequirement {
  available_bytes: number | null;
  path: string;
  required_bytes: number;
  /**
   * Unknown when capacity could not be observed. Execution always rechecks.
   */
  sufficient: boolean | null;
  volume_identity: string | null;
  [k: string]: unknown;
}
/**
 * One-file, one-key review. Apply recomputes this binding from authoritative
 * retained state and fresh bytes; a client-supplied review is never authority.
 */
export interface OutputGameSettingReview {
  change: GameSettingChange;
  configuration_sha256: string;
  file_id: string;
  install_id: string;
  label: string;
  path: string;
  port_id: string;
  previous_value: unknown;
  proposed_value: unknown;
  review_sha256: string;
  setting_id: string;
  [k: string]: unknown;
}
/**
 * A missing optional capability is local to settings. It does not disable the
 * installation's independently assessed basic setup or launch capabilities.
 */
export interface GameSettingsView {
  available: boolean;
  files: GameSettingsFileView[];
  install_id: string | null;
  port_id: string;
  reason: string | null;
  [k: string]: unknown;
}
export interface GameSettingsFileView {
  available: boolean;
  configuration_sha256: string | null;
  id: string;
  path: string;
  reason: string | null;
  settings: GameSettingView[];
  [k: string]: unknown;
}
export interface GameSettingView {
  id: string;
  label: string;
  /**
   * None means this declared key is absent; the verified consumer default
   * remains separate from an observed persisted value.
   */
  value: unknown;
  value_type: GameSettingType;
  [k: string]: unknown;
}
/**
 * A reviewed game update, independent of the saved automatic-update policy.
 */
export interface OutputGameUpdatePlan {
  /**
   * Exact retained archive selected by this review; never authorization.
   */
  acquisition?: GameUpdateAcquisition | null;
  activate: boolean;
  assessment: PortActionAssessment3;
  data_transition?: ArchiveDataTransitionReview | null;
  plan: InstallPlan;
  plan_sha256: string;
  [k: string]: unknown;
}
/**
 * Read-only decision for this exact reviewed candidate, not authorization.
 */
export interface PortActionAssessment3 {
  action: PortAction;
  availability: PortActionAvailability;
  /**
   * The authoritative signed-definition reason, when it limits this action.
   */
  definition?: DefinitionEligibility | null;
  reason: PortActionReason;
  [k: string]: unknown;
}
export interface ArchiveDataTransitionReview {
  preimage_sha256: string;
  producing_archive_sha256: string;
  retained_installations: number;
  temporary_space: InstallSpaceRequirement;
  [k: string]: unknown;
}
export interface OutputGhostshipRecoveryPlan {
  active_install: InstallRecord;
  active_install_tree: AdoptionCopyPlan;
  backup: BackupRecord;
  canonical_data: AdoptionCopyPlan;
  channel: ReleaseChannel;
  format_version: number;
  legacy_install: InstallRecord;
  legacy_install_tree: AdoptionCopyPlan;
  library_root: string;
  plan_sha256: string;
  qualification_sha256: string;
  required_bytes: number;
  snapshot_data: AdoptionCopyPlan;
  source: SourceRecord;
  staged_install: InstallRecord | null;
  update_policy: UpdatePolicy;
}
export interface OutputGhostshipRecoveryResult {
  install: InstallRecord;
  restored_backup: BackupRecord;
  runtime_safety_path: string;
  safety_backup: BackupRecord;
  [k: string]: unknown;
}
export interface GithubAuthStatus {
  authenticated: boolean;
  device_login_available: boolean;
  environment_variable?: string | null;
  login: string | null;
  rate_limit: GithubRateLimit | null;
  source: GithubAuthSource;
  [k: string]: unknown;
}
export interface GithubRateLimit {
  limit: number;
  remaining: number;
  resets_at: number;
  [k: string]: unknown;
}
export interface OutputGithubDeviceLogin {
  expires_at: number;
  interval_seconds: number;
  session_id: string;
  user_code: string;
  verification_uri: string;
  [k: string]: unknown;
}
export interface OutputGithubDeviceLoginResult {
  state: GithubDeviceLoginState;
  status: GithubAuthStatus | null;
  [k: string]: unknown;
}
export interface OutputHostToolProbeResult {
  clear_action_available: boolean;
  message: string;
  path: string;
  persisted: boolean;
  retry_action: string;
  sha256: string | null;
  state: HostToolProbeState;
  tool_id: string;
  [k: string]: unknown;
}
/**
 * A launch-session record plus the explanation for an unsuccessful exit.
 * The record stays the only durable authority; the explanation is derived.
 */
export interface LaunchSessionView {
  child_identity: string | null;
  child_pid: number | null;
  exit_code: number | null;
  exit_explanation?: ExitExplanation | null;
  finished_at: number | null;
  id: string;
  install_id: string;
  install_root: string;
  message: string | null;
  outcome: LaunchSessionOutcome | null;
  owner_kind: "managed" | "external";
  phase: LaunchSessionPhase;
  port_id: string;
  started_at: number;
  supervisor_identity: string | null;
  supervisor_pid: number;
  updated_at: number;
  [k: string]: unknown;
}
export interface ExitExplanation {
  explanation: string;
  /**
   * Stable machine key, e.g. `dll_not_found`.
   */
  key: string;
  next_action: string;
  /**
   * Raw status as Windows reports it, e.g. `0xC0000135`, or the decimal value.
   */
  raw_code: string;
  table_version: number;
  [k: string]: unknown;
}
export interface OutputLauncherLibraryInventory {
  apps_root: string | null;
  apps_root_origin: LauncherAppsRootOrigin;
  data_root: string;
  entries: LauncherLibraryEntry[];
  /**
   * Upstream source revision whose library format this reader implements.
   */
  format_revision: string;
  /**
   * Content fingerprint of this inventory, excluding this field.
   */
  inventory_sha256: string;
  launcher: LauncherKind;
  /**
   * True when only the launcher's legacy `games.json` was present.
   */
  legacy_library_file: boolean;
  library_file: string;
  /**
   * Inspection reads only; launcher data and installations stay untouched.
   */
  original_will_be_modified: boolean;
  skipped_entries: LauncherLibrarySkippedEntry[];
  [k: string]: unknown;
}
export interface LauncherLibraryEntry {
  /**
   * Port to pass to the existing reviewed `adopt --port` for `install_path`.
   * Absent unless exactly one copyable catalog port was detected.
   */
  adopt_port_id: string | null;
  /**
   * Catalog ports whose reviewed upstream repository matches this entry.
   */
  candidate_port_ids: string[];
  /**
   * Catalog ports whose declared executable was found in the installation.
   */
  detected_port_ids: string[];
  explanation: string;
  /**
   * True when `installPath` was explicit rather than apps folder plus folder name.
   */
  explicit_install_path: boolean;
  folder_name: string;
  hints: LauncherEntryHints;
  /**
   * Zero-based position across the launcher library's entry arrays.
   */
  index: number;
  /**
   * Resolved installation folder, when the entry names a safe absolute location.
   */
  install_path: string | null;
  mods: LauncherModInventory | null;
  name: string;
  /**
   * Launcher settings for this app that Portcove does not carry over.
   */
  not_carried_over: string[];
  repository: string;
  /**
   * `github`, `gitlab`, `codeberg` or `manual`, as the launcher interprets the entry.
   */
  repository_source: string;
  /**
   * Earlier entry naming the same installation folder for a different app.
   */
  shares_folder_with: number | null;
  status: LauncherEntryStatus;
  /**
   * Declared saves/configuration present in the installation for a single match.
   */
  user_data_paths: string[];
  [k: string]: unknown;
}
export interface LauncherEntryHints {
  /**
   * First line of `version.txt` in the installation. Untrusted label.
   */
  installed_version_label: string | null;
  /**
   * `preferredVersion` from the launcher library. Untrusted label.
   */
  preferred_version: string | null;
  /**
   * First line of `selected_executable.txt`. Portcove uses its own declared executable.
   */
  selected_executable: string | null;
  [k: string]: unknown;
}
export interface LauncherModInventory {
  providers: string[];
  /**
   * False when the sidecar exists but could not be read within limits.
   */
  readable: boolean;
  /**
   * Records in `.quiver-mods.json`; they are inventoried, never activated.
   */
  records: number;
  [k: string]: unknown;
}
export interface LauncherLibrarySkippedEntry {
  index: number;
  reason: string;
  [k: string]: unknown;
}
/**
 * The export carries metadata; all payload bytes remain in the explicitly chosen content root.
 */
export interface OutputLibraryImportPlan {
  available_bytes: number;
  content: LibraryTreePlan[];
  content_root: string;
  destination_exists: boolean;
  destination_root: string;
  metadata: LibraryMetadata;
  metadata_file: LibraryMetadataFile;
  plan_sha256: string;
  required_bytes: number;
  [k: string]: unknown;
}
export interface LibraryTreePlan {
  copy: AdoptionCopyPlan;
  kind: LibraryContentKind;
  relative_path: string;
  [k: string]: unknown;
}
/**
 * Metadata only; content trees and original source files are never embedded.
 */
export interface LibraryMetadata {
  application_versions: InstallRecord[];
  artwork?: ArtworkMetadata | null;
  content_roots: LibraryContentRoot[];
  exported_at: number;
  launch_history: LibraryLaunchHistory[];
  /**
   * Explicit add-only Library entries; present only under metadata schema 7 or later,
   * so an older reader refuses the export instead of silently dropping them.
   */
  library_memberships?: LibraryMembership[];
  original_root: string;
  port_settings: LibraryPortSettings[];
  portability_authority?: PortabilityAuthority | null;
  /**
   * Local profiles and revisions; present only under metadata schema 6 or later.
   */
  profiles?: LibraryProfile[];
  retained_build_references?: RetainedBuildReference[];
  schema_version: number;
  source_references: SourceRecord[];
  [k: string]: unknown;
}
export interface ArtworkMetadata {
  assets: LocalArtworkAsset[];
  choices: ArtworkChoice[];
  /**
   * Provider-only assets whose originals Portcove removed after every record
   * was withdrawn. Their files are not carried; schema 10.
   */
  evicted_assets?: ArtworkEvictedAsset[];
  /**
   * Assets that exist only because a provider image was chosen; no local import
   * of the same bytes was made. Present only under library metadata schema 8.
   */
  provider_only_assets?: string[];
  /**
   * Provider provenance; present only under library metadata schema 8.
   */
  providers?: ArtworkProviderRecord[];
  /**
   * Confirmed withdrawals of provider records; library metadata schema 10.
   */
  withdrawals?: ArtworkWithdrawalRecord[];
}
export interface ArtworkEvictedAsset {
  asset_sha256: string;
  evicted_at: number;
}
export interface ArtworkProviderRecord {
  asset_sha256: string;
  attribution: ArtworkAttribution;
}
export interface ArtworkWithdrawalRecord {
  asset_id: number;
  asset_sha256: string;
  provider: ArtworkProvider;
  signal: ArtworkWithdrawalSignal;
  withdrawn_at: number;
}
export interface LibraryContentRoot {
  kind: LibraryContentKind;
  relative_path: string;
  [k: string]: unknown;
}
export interface LibraryLaunchHistory {
  last_launched_at: number;
  port_id: string;
  successful_launches: number;
  [k: string]: unknown;
}
export interface LibraryMembership {
  added_at: number;
  format_version: number;
  origin: LibraryMembershipOrigin;
  port_id: string;
  sources?: LibraryMembershipSource[];
}
/**
 * A reviewed original the player associated with the saved entry. This is a
 * hint for explaining requirements; reinspection remains the authority.
 */
export interface LibraryMembershipSource {
  profile_id: string;
  sha256: string;
}
export interface LibraryPortSettings {
  active_install_id: string | null;
  channel: ReleaseChannel;
  output_directory?: string | null;
  port_id: string;
  previous_install_id: string | null;
  update_policy: UpdatePolicy;
  [k: string]: unknown;
}
export interface PortabilityAuthority {
  entries: PortabilityAdmission[];
  format: number;
  mac_sha256: string;
}
export interface PortabilityAdmission {
  install_id: string;
  manifest_sha256: string;
  port_id: string;
  role: string;
  selection_sha256: string;
}
/**
 * One profile with every revision, as carried by library metadata schema 6.
 */
export interface LibraryProfile {
  profile: Profile;
  revisions: ProfileRevision[];
  /**
   * Set when this profile's revision currently owns the port's live player data.
   */
  selected_revision?: number | null;
}
export interface Profile {
  created_at: number;
  current_revision: number;
  display_name: string;
  id: string;
  intent: ProfileIntent;
  is_default: boolean;
  port_id: string;
  updated_at: number;
}
export interface ProfileIntent {
  requested_packages?: RequestedPackage[];
  update_policy: ProfileUpdatePolicy;
}
export interface RequestedPackage {
  native_id: string;
  provider?: ProviderPackageRef | null;
  version_constraint?: string | null;
}
/**
 * A provider's own coordinates. Provider IDs never double as native loader IDs.
 */
export interface ProviderPackageRef {
  file?: string | null;
  project: string;
  provider: string;
  version?: string | null;
}
export interface ProfileRevision {
  build: RetainedBuildIdentity;
  created_at: number;
  /**
   * SHA-256 of this revision's canonical content (with this field empty).
   */
  digest: string;
  /**
   * Explicit uncaptured or external inputs this revision cannot reproduce.
   */
  limits?: string[];
  loader?: LoaderContractRef | null;
  orderings?: TypedOrdering[];
  originals: OriginalBinding[];
  packages?: ResolvedPackage[];
  parent_revision: number | null;
  profile_id: string;
  revision: number;
  /**
   * Revisions sharing a group share progress; a copy gets its own group.
   */
  save_group: string;
  /**
   * Consequential native settings only; ordinary preferences stay mutable state.
   */
  settings?: {
    [k: string]: string;
  };
}
/**
 * Immutable identity only. Paths, version labels, and active selection are not keys.
 * `runtime: None` means no separately identified bundled loader/runtime; the
 * selected executable and installed contract still bind an integrated loader.
 */
export interface RetainedBuildIdentity {
  artifact: ArtifactIdentity1;
  definition: DefinitionSelectionIdentity | null;
  install_id: string;
  installed_contract_sha256: string;
  manifest_sha256: string;
  platform: Platform;
  port_id: string;
  runtime: RuntimeIdentity | null;
  selected_executable: string;
}
export interface LoaderContractRef {
  id: string;
  version: string;
}
/**
 * One precedence domain. A loader may need several; no universal number exists.
 */
export interface TypedOrdering {
  domain: string;
  native_ids: string[];
}
/**
 * One required original, bound by observed content and storage identity rather
 * than by path, so relocation and rescans cannot silently change which original
 * a profile means.
 */
export interface OriginalBinding {
  observed_identity_sha256?: string | null;
  /**
   * The catalog source requirement this original satisfies.
   */
  requirement_id: string;
  sha256: string;
  size: number;
  storage_sha256: string;
  storage_size: number;
}
/**
 * Exact package bytes plus its separate identities. A local import carries no
 * provider coordinates but still has its own native ID and digest.
 */
export interface ResolvedPackage {
  enabled: boolean;
  native_id: string;
  native_version?: string | null;
  provider?: ProviderPackageRef | null;
  /**
   * Native IDs this package requires, from native metadata (not provider claims).
   */
  requires?: string[];
  sha256: string;
  size: number;
}
/**
 * One binding per (port, setup). The caller supplies a stable opaque setup ID,
 * never its display name, source-contract ID, installation path, or active slot.
 */
export interface RetainedBuildReference {
  build: RetainedBuildIdentity;
  created_at: number;
  /**
   * Former bindings still offered as recovery targets. Rebinding `build` keeps
   * each superseded exact build protected until it is explicitly retired.
   */
  history?: RetainedBuildRevision[];
  id: string;
  /**
   * Monotonic binding revision, including same-build rebindings. Wall-clock
   * timestamps alone cannot invalidate approvals after an A-to-B-to-A change.
   */
  revision: number;
  setup_id: string;
  updated_at: number;
}
/**
 * A superseded binding. `revision` is the binding revision it held while current.
 */
export interface RetainedBuildRevision {
  build: RetainedBuildIdentity;
  revision: number;
  superseded_at: number;
}
export interface LibraryMetadataFile {
  path: string;
  sha256: string;
  size: number;
  [k: string]: unknown;
}
export interface OutputLibraryImportResult {
  completed: boolean;
  destination_root: string;
  input_retained: boolean;
  transfer_id: string;
  [k: string]: unknown;
}
export interface OutputLibraryMovePlan {
  available_bytes: number;
  content: LibraryTreePlan[];
  destination_root: string;
  metadata: LibraryMetadata;
  plan_sha256: string;
  required_bytes: number;
  source_root: string;
  source_will_be_retained: boolean;
  [k: string]: unknown;
}
export interface OutputLibraryMoveResult {
  active_root: string;
  completed: boolean;
  destination_root: string;
  source_retained: boolean;
  source_root: string;
  transfer_id: string;
  [k: string]: unknown;
}
export interface LibrarySelection {
  root: string;
  source: LibrarySelectionSource;
  [k: string]: unknown;
}
export interface OutputListingDeliveryStatus {
  anchor_sha256: string | null;
  delivery_schema: number;
  expires_at: string | null;
  fallback_reason: string | null;
  listing_count: number;
  repository_root_sha256: string | null;
  revision: number | null;
  selected: boolean;
  target_sha256: string | null;
  withdrawn_ids: string[];
  [k: string]: unknown;
}
export interface PortListingStatus {
  actions: ListingActionAssessment[];
  /**
   * Optional inert read model; absence cannot suppress an independently allowed action.
   */
  capabilities?: PortCapabilityReport | null;
  /**
   * Explicit saved Library entry, independent of any installation or registration.
   */
  library_membership?: LibraryMembership | null;
  port_id: string;
  status: PortStatus;
  [k: string]: unknown;
}
export interface ListingActionAssessment {
  action: ListingAction;
  allowed: boolean;
  reason?: string | null;
  [k: string]: unknown;
}
export interface PortCapabilityReport {
  advisories: PortCapabilityNotice[];
  advisory_state: string;
  /**
   * Optional detail failures are local to this report, never action refusals.
   */
  detail_problems: string[];
  format_version: number;
  /**
   * Matching observations are enriched only on a focused request. Absence is untested.
   */
  observations: RecommendationEvidence[];
  pending_setup: PendingSetupState | null;
  port_id: string;
  protection: PlayerDataProtection | null;
  routes: PortCapabilityRoute[];
  settings: GameSettingsView | null;
  setup_guide: ManualSetupGuide | null;
  source_readiness: LaunchReadiness | null;
  [k: string]: unknown;
}
export interface PortCapabilityNotice {
  applicability: AdvisoryApplicability;
  notice: CapabilityAdvisory;
  [k: string]: unknown;
}
export interface CapabilityAdvisory {
  artifact_sha256: string | null;
  edition: string | null;
  evidence: string;
  explanation: string;
  feature: CapabilityFeature;
  id: string;
  /**
   * Unix seconds. A newer date never proves an earlier failure is fixed.
   */
  observed_at: number;
  platform: Platform;
  provenance: string;
  release: string | null;
  route: string;
  workaround: string | null;
}
export interface PortCapabilityRoute {
  features: PortCapabilityFeature[];
  install_id: string | null;
  route: string;
  [k: string]: unknown;
}
export interface PortCapabilityFeature {
  action: PortActionAssessment | null;
  explanation: string;
  feature: CapabilityFeature;
  listing_action: ListingActionAssessment | null;
  /**
   * Management mode, separate from prerequisites and evidence of successful use.
   */
  mode: "automatic" | "manual" | "unavailable" | "unknown";
  next_step: string;
  [k: string]: unknown;
}
export interface LiveMods {
  /**
   * Installed files whose bytes changed outside Portcove; never overwritten.
   */
  changed_owned: string[];
  /**
   * The game's own enabled-mods list compared with the selected revision.
   */
  native_list:
    | {
        state: "not-applicable";
        [k: string]: unknown;
      }
    | {
        state: "in-sync";
        [k: string]: unknown;
      }
    | {
        state: "not-written";
        [k: string]: unknown;
      }
    | {
        native_order: string[];
        state: "reordered";
        [k: string]: unknown;
      }
    | {
        missing: string[];
        state: "differs";
        unexpected: string[];
        [k: string]: unknown;
      }
    | {
        reason: string;
        state: "unreadable";
        [k: string]: unknown;
      };
  profile_id: string | null;
  revision: number | null;
  /**
   * Files in the mods folder this profile did not install; never touched.
   */
  unmanaged: string[];
  [k: string]: unknown;
}
export interface OutputManagedRouteChangePreview {
  current_registration: ExternalRuntimeRecord;
  external_data_will_be_copied: boolean;
  external_files_will_be_preserved: boolean;
  installation: InstallPlan;
  permitted: boolean;
  port_id: string;
  preview_sha256: string;
  reason: string | null;
  update_policy: UpdatePolicy;
  [k: string]: unknown;
}
export interface OutputManagedRouteChangeResult {
  external_files_preserved: boolean;
  installation: InstallRecord;
  previous_registration: ExternalRuntimeRecord;
  [k: string]: unknown;
}
/**
 * What a mod package would run, shown before the player allows its code.
 */
export interface OutputModCodeReview {
  /**
   * True when these bytes were already allowed in this library.
   */
  already_allowed: boolean;
  /**
   * The name the mod gives itself; a claim, not verified.
   */
  display_name: string;
  /**
   * The loader's identity for the mod.
   */
  native_id: string;
  runs: RecompExecution[];
  /**
   * The exact bytes any consent covers.
   */
  sha256: string;
  [k: string]: unknown;
}
/**
 * Everything a game-level mods view needs in one read: whether the game has a
 * reviewed mod contract, its setups and what is live now. Read-only.
 */
export interface OutputModSetupsView {
  /**
   * The game's current installation. A setup whose build differs stays on
   * its own build; an upgraded copy can use this one.
   */
  current_install_id?: string | null;
  /**
   * Unattended provider updates waiting for the player's review, for each
   * setup's current revision.
   */
  held_updates: HeldModUpdate[];
  /**
   * None until the installed game has its default setup.
   */
  inventory: ProfileInventory | null;
  /**
   * True when reviewed loader source shows that the later of two mods changing
   * the same asset wins. False when the order is kept but which mod wins is not
   * established.
   */
  later_mods_take_priority: boolean;
  live: LiveMods | null;
  /**
   * Package file types the game loads, such as `o2r`.
   */
  package_types: string[];
  port_id: string;
  /**
   * The mod provider this game has a reviewed binding for (`gamebanana` or
   * `thunderstore`), if any.
   */
  provider: string | null;
  /**
   * False when the game has no reviewed mod package contract; nothing else is
   * offered then.
   */
  supported: boolean;
  [k: string]: unknown;
}
/**
 * An unattended update the player has to review, remembered for a setup's
 * current revision.
 */
export interface HeldModUpdate {
  candidate_file_id: string;
  /**
   * The setup's mods from the installed provider file.
   */
  native_ids: string[];
  profile_id: string;
  project_id: string;
  reason: string;
  [k: string]: unknown;
}
export interface ProfileInventory {
  port_id: string;
  profiles: ProfileView[];
  [k: string]: unknown;
}
export interface ProfileView {
  build_availability: RetainedBuildAvailability;
  originals: OriginalStatus[];
  profile: Profile;
  revision: ProfileRevision;
  [k: string]: unknown;
}
export interface OriginalStatus {
  availability: OriginalAvailability;
  binding: OriginalBinding;
  [k: string]: unknown;
}
export interface OfficialCatalogReview {
  configured: boolean;
  enabled: boolean;
  expected_plan: string | null;
  source: OfficialCatalogSource | null;
  [k: string]: unknown;
}
export interface OfficialCatalogSource {
  metadata_base_url: string;
  targets_base_url: string;
}
export interface OutputOfficialCatalogSetup {
  changed: boolean;
  review: OfficialCatalogReview;
  [k: string]: unknown;
}
export interface OperationTarget {
  id: string;
  kind: ActivityTargetKind;
  [k: string]: unknown;
}
export interface OutputOutputDestinationPreview {
  affected_installs: OutputAffectedInstall[];
  availability: OutputDestinationAvailability;
  available_bytes: number | null;
  current: PortOutputLocation;
  moves_existing_install: boolean;
  ownership: OutputDestinationOwnership;
  port_id: string;
  preview_sha256: string;
  proposed: PortOutputLocation;
  reset_to_default: boolean;
  total_bytes: number | null;
  validation_errors: string[];
  volume_identity: string | null;
  [k: string]: unknown;
}
export interface OutputAffectedInstall {
  active: boolean;
  install_id: string;
  path: string;
  previous: boolean;
  staged: boolean;
  version: string;
  [k: string]: unknown;
}
export interface OutputOutputRelocationPlan {
  availability: OutputDestinationAvailability;
  available_bytes: number | null;
  backups_will_move: boolean;
  channel: ReleaseChannel;
  current: PortOutputLocation;
  destination_root: string;
  installs: OutputRelocationInstall[];
  ownership: OutputDestinationOwnership;
  plan_sha256: string;
  port_id: string;
  required_bytes: number;
  sources_will_move: boolean;
  total_bytes: number | null;
  user_data_will_move: boolean;
  validation_errors: string[];
  volume_identity: string | null;
  [k: string]: unknown;
}
export interface OutputRelocationInstall {
  active: boolean;
  copy: AdoptionCopyPlan;
  destination_path: string;
  install: InstallRecord;
  previous: boolean;
  retained: boolean;
  staged: boolean;
  [k: string]: unknown;
}
export interface OutputOutputRelocationResult {
  cleanup_pending: boolean;
  old_paths_retained: string[];
  operation_id: string;
  output_location: PortOutputLocation;
  port_id: string;
  relocated_installs: InstallRecord[];
  [k: string]: unknown;
}
export interface OutputOutputRelocationStatus {
  cleanup_pending_paths: string[];
  destination_root: string;
  last_error: string | null;
  operation_id: string;
  phase: string;
  port_id: string;
  [k: string]: unknown;
}
export interface PendingSetupRecord {
  /**
   * Observed archive bytes, not a curated acceptance or executable identity.
   */
  archive_sha256: string;
  artifact: CatalogDownloadCandidate;
  downloaded_at: string;
  format_version?: number;
  id: string;
  listing: PortListing;
  path: string;
  port_id: string;
  reason: string | null;
  state: PendingSetupState;
}
export interface OutputPortPaths {
  active_install_root: string | null;
  library_root: string;
  output_location: PortOutputLocation;
  port_id: string;
  previous_install_root: string | null;
  staged_install_root: string | null;
  user_data_root: string;
  [k: string]: unknown;
}
export interface OutputPortRemovalPreview {
  managed_paths: string[];
  persistent_data_path: string;
  persistent_data_will_be_preserved: boolean;
  port_id: string;
  preview_sha256: string;
  /**
   * Unknown player-side files in the versions being removed (#5359).
   * Removal copies them to a new backup's separate area before it deletes
   * the version folders; restore does not put them back. Omitted when zero.
   */
  unknown_file_count?: number;
  /**
   * The first unknown file paths, each relative to its version folder.
   */
  unknown_files?: string[];
  [k: string]: unknown;
}
export interface OutputPortableSaveExportPreview {
  base_sha256?: string | null;
  blockers: PortableSaveBlocker[];
  content_sha256?: string | null;
  /**
   * Exactly the files the export would contain.
   */
  files: PortableSaveFile[];
  identity?: PortableSaveIdentity | null;
  port_id: string;
  /**
   * Everything else in the game's player-data folder, which stays here.
   */
  stays_local: LocalDataEntry[];
  [k: string]: unknown;
}
export interface PortableSaveFile {
  /**
   * Relative path inside the game's player-data folder, `/` separated.
   */
  path: string;
  sha256: string;
  size: number;
  [k: string]: unknown;
}
/**
 * Exact identity of one side of a portable-save transfer.
 */
export interface PortableSaveIdentity {
  contract_id: string;
  platform: Platform;
  port_id: string;
  /**
   * Installed game version that produced or will read the progress.
   */
  version: string;
  [k: string]: unknown;
}
/**
 * An entry that stays on this device, with the reason it does not move.
 */
export interface LocalDataEntry {
  directory: boolean;
  path: string;
  role: PersistentDataRole;
  [k: string]: unknown;
}
export interface OutputPortableSaveExportResult {
  base_sha256?: string | null;
  content_sha256: string;
  files: PortableSaveFile[];
  identity: PortableSaveIdentity;
  path: string;
  [k: string]: unknown;
}
export interface OutputPortableSaveImportPreview {
  blockers: PortableSaveBlocker[];
  changes: PortableSaveFileChange[];
  destination?: PortableSaveIdentity | null;
  incoming_content_sha256: string;
  local_content_sha256?: string | null;
  options: PortableSaveImportOptions;
  port_id: string;
  preview_sha256: string;
  relation: PortableSaveRelation;
  /**
   * Current player data is copied to a backup before anything changes.
   */
  safety_backup_will_be_created: boolean;
  source: PortableSaveIdentity;
  stays_local: LocalDataEntry[];
  [k: string]: unknown;
}
export interface PortableSaveFileChange {
  effect: PortableSaveFileEffect;
  incoming?: PortableSaveFile | null;
  local?: PortableSaveFile | null;
  path: string;
  [k: string]: unknown;
}
/**
 * Explicit player choices bound into the reviewed import.
 */
export interface PortableSaveImportOptions {
  /**
   * Remove local save slots that are absent from the incoming progress.
   */
  remove_local_only_saves: boolean;
  /**
   * Replace diverged local progress. Local progress is still kept in the
   * safety backup and the incoming progress in its own snapshot.
   */
  replace_diverged_progress: boolean;
  [k: string]: unknown;
}
export interface OutputPortableSaveImportResult {
  content_sha256: string;
  import_snapshot: BackupRecord1;
  /**
   * Snapshot of this device's data from immediately before the import.
   */
  safety_backup?: BackupRecord | null;
  [k: string]: unknown;
}
/**
 * Snapshot holding the imported state; restorable like any backup.
 */
export interface BackupRecord1 {
  /**
   * Present only for snapshots Portcove took automatically.
   */
  automatic?: AutomaticSnapshotLabel | null;
  created_at: number;
  file_count: number;
  id: string;
  path: string;
  port_id: string;
  sha256: string;
  size: number;
  /**
   * Unknown player-side files kept in the backup's separate area (#5359).
   * They are not counted in `file_count`, and restore does not put them
   * back. Omitted when zero.
   */
  unknown_file_count?: number;
  [k: string]: unknown;
}
/**
 * Exact retained private work that may be discarded after explicit review.
 */
export interface OutputPreparationCleanupPreview {
  backup_path: string;
  cleanup_is_irreversible: boolean;
  format_version: number;
  interrupted_cleanup_will_retry: boolean;
  logs_path: string;
  operation_id: string;
  original_install_path: string;
  persistent_data_path: string;
  port_id: string;
  preview_sha256: string;
  retained: AdoptionCopyPlan;
  retained_path: string;
  source_path: string;
  [k: string]: unknown;
}
export interface PreparationOptions {
  /**
   * This family currently exposes the catalog's reviewed defaults only.
   */
  mode: "default" | "ghostship200_legacy" | "source_only";
  target: Platform;
}
export interface OutputPreparationPlan {
  copy: AdoptionCopyPlan1;
  format_version: number;
  inputs: PreparationInputs;
  plan_sha256: string;
  port_id: string;
  [k: string]: unknown;
}
/**
 * A copy identity, checked only after the existing install trust checks pass.
 */
export interface AdoptionCopyPlan1 {
  directories: string[];
  files: AdoptionCopyFile[];
  skipped_entries: AdoptionSkippedEntry[];
  total_bytes: number;
  [k: string]: unknown;
}
export interface PreparationInputs {
  conversion_tool: PreparationTool | null;
  /**
   * Binds the admitted port and source definitions; hashing does not admit a definition.
   */
  definition_sha256: string;
  host: Platform;
  install: InstallRecord;
  options: PreparationOptions;
  setup_tool?: PreparationTool | null;
  source: SourceRecord;
  source_inspection: SourceInspectionReport;
  [k: string]: unknown;
}
export interface PreparationTool {
  path: string;
  sha256: string;
  size: number;
  [k: string]: unknown;
}
/**
 * A stable, complete explanation of selected source bytes. `state_code` is an
 * open string so clients can preserve an unfamiliar future state instead of
 * failing enum deserialization. Detailed enums remain versioned by the report
 * and outer API schema boundaries.
 */
export interface SourceInspectionReport {
  applications: SourceApplicationInspection[];
  evidence: SourceEvidenceLink[];
  expected_identity?: SourceIdentityProfile | null;
  health: SourceHealth;
  inspection?: SourceInspection | null;
  legacy: SourceLegacyCoverage;
  next_action: string;
  problem?: SourceInspectionProblem | null;
  profile_id: string;
  registered?: SourceRecord | null;
  schema_version: number;
  state_code: string;
  summary: string;
  [k: string]: unknown;
}
export interface SourceApplicationInspection {
  contract: PortSourceContract;
  contract_result: SourceContractResult;
  port_id: string;
  port_name: string;
  qualification: SourceQualificationCoverage;
  release_applicability: SourceReleaseApplicability;
  role: PortSourceRole;
  [k: string]: unknown;
}
export interface SourceQualificationCoverage {
  exact_records: SourceEvidence[];
  /**
   * Conservative legacy port-wide coverage. It is not exact source qualification.
   */
  legacy_automated_platforms: Platform[];
  /**
   * Conservative legacy port-wide coverage. It is not exact source qualification.
   */
  legacy_hands_on_platforms: Platform[];
  [k: string]: unknown;
}
export interface SourceReleaseApplicability {
  reviewed_bindings: SourceContractApplicability[];
  /**
   * Open code: `artifact_bound`, `upstream_release_bound`,
   * `integration_contract_bound`, or `not_rebound`.
   */
  state_code: string;
  [k: string]: unknown;
}
export interface SourceEvidenceLink {
  authority: string;
  authority_ref: string;
  claim: string;
  id: string;
  immutable_url: string;
  live_url?: string | null;
  reviewed_at: string;
  role: CatalogEvidenceRole;
  [k: string]: unknown;
}
export interface SourceLegacyCoverage {
  /**
   * True for an Alpha 1 or other supported row that predates structured observations.
   */
  registration_identity_not_recorded: boolean;
  /**
   * Historical evidence without an exact variant remains visible but is never exact coverage.
   */
  variant_unspecified_records: SourceEvidence[];
  [k: string]: unknown;
}
export interface SourceInspectionProblem {
  /**
   * Open, stable machine code. Unknown future values remain readable.
   */
  code: string;
  message: string;
  /**
   * Optional host-tool identifier that adapters can use to offer the
   * matching shared readiness controls. Other error details remain private.
   */
  tool_id?: string | null;
  [k: string]: unknown;
}
export interface ProfileRecipe {
  format: number;
  /**
   * SHA-256 of the recipe's canonical content with this field empty.
   */
  identity_sha256: string;
  loader: LoaderContractRef | null;
  orderings: TypedOrdering[];
  originals: RecipeOriginal[];
  packages: RecipePackage[];
  port_id: string;
  runtime: RecipeRuntime;
  /**
   * Inputs this recipe cannot reproduce; always stated, never implied.
   */
  uncaptured: string[];
}
/**
 * A reference to an original, by content identity only. No path, no payload.
 */
export interface RecipeOriginal {
  requirement_id: string;
  sha256: string;
  size: number;
}
export interface RecipePackage {
  enabled: boolean;
  native_id: string;
  native_version: string | null;
  provider: ProviderPackageRef | null;
  requires: string[];
  sha256: string;
  size: number;
}
export interface RecipeRuntime {
  artifact: ArtifactIdentity1;
  definition: DefinitionSelectionIdentity | null;
  installed_contract_sha256: string;
  platform: Platform;
  runtime: RuntimeIdentity | null;
}
export interface OutputProviderBrowsePage {
  /**
   * `stale` means the provider could not be reached and this is earlier data.
   */
  freshness: "fresh" | "revalidated" | "stale";
  /**
   * The game's catalog name, for presentation.
   */
  game_name: string;
  /**
   * Highest page browsing offers.
   */
  last_page: number;
  observed_at: number;
  /**
   * Records on this page the provider labels as another game; not listed.
   */
  other_game_records: number;
  page: ProviderPage;
  port_id: string;
  provider: string;
  [k: string]: unknown;
}
/**
 * One page of mods, most downloaded first. `page.complete` is false when more
 * pages exist.
 */
export interface ProviderPage {
  /**
   * False when more pages exist; callers must not treat a page as the whole result.
   */
  complete: boolean;
  page: number;
  projects: ProviderProject[];
  total: number;
  [k: string]: unknown;
}
export interface ProviderProject {
  files: ProviderFileCandidate[];
  /**
   * The provider's game identity for this project; compared against a reviewed
   * binding, never matched by name or popularity.
   */
  game_id: string | null;
  name: string;
  obsolete: boolean;
  profile_url: string;
  project_id: string;
  provider: string;
  submitter: string | null;
  /**
   * File records the adapter could not read. Non-zero means the file list is
   * incomplete, so "no newer file" or "file removed" cannot be concluded.
   */
  unreadable_files: number;
  updated_at: number;
  /**
   * Displayed version label; it does not identify bytes (a file can change
   * under an unchanged label).
   */
  version: string | null;
  [k: string]: unknown;
}
/**
 * A provider's own claims about one downloadable file. The checksum is the
 * provider's claim; an MD5 or any provider-supplied digest never authenticates
 * a publisher.
 */
export interface ProviderFileCandidate {
  added_at: number;
  archived: boolean;
  claimed_md5: string | null;
  /**
   * Provider scan outcomes, as claimed ("clean", "infected", ...). Not an assurance.
   */
  claimed_scan: string | null;
  /**
   * Canonical download location derived from `file_id`, never a provider-supplied URL.
   */
  download_url: string;
  /**
   * Provider file identity; distinct from the project and from any version label.
   */
  file_id: string;
  file_name: string;
  size: number;
  [k: string]: unknown;
}
export interface OutputProviderInstallPlan {
  conflicts: AssetConflict[];
  conflicts_truncated: boolean;
  /**
   * Computed from the actual downloaded bytes.
   */
  download_sha256: string;
  download_size: number;
  /**
   * Profile revision this plan was reviewed against.
   */
  expected_revision: number;
  file: ProviderFileCandidate;
  /**
   * Entries of the provider's wrapper that are not packages and were not read.
   */
  ignored_entries: number;
  members: PlanMember[];
  plan_sha256: string;
  port_id: string;
  profile_id: string;
  project_name: string;
  provider: ProviderPackageRef;
  /**
   * Installed packages this plan replaces: the same native ID with different
   * bytes, or a package the game loads as the same mod under another extension.
   */
  replaces: string[];
  /**
   * What this plan relies on without verifying.
   */
  unverified_claims: string[];
  [k: string]: unknown;
}
/**
 * Several packages claim the same asset path.
 */
export interface AssetConflict {
  path: string;
  /**
   * Packages providing the path, in the supplied precedence order.
   */
  providers: string[];
  /**
   * The provider that takes effect under that order.
   */
  winner: string;
  [k: string]: unknown;
}
export interface PlanMember {
  asset_count: number;
  file_name: string;
  /**
   * What the package runs if installed (Recomp code); empty for asset mods.
   */
  runs_code?: RecompExecution[];
  sha256: string;
  size: number;
  [k: string]: unknown;
}
export interface OutputProviderProjectView {
  freshness: ProviderFreshness;
  /**
   * The game's catalog name, for presentation.
   */
  game_name: string;
  observed_at: number;
  port_id: string;
  project: ProviderProject1;
  [k: string]: unknown;
}
/**
 * The project's files; a file ID with this project ID is what `provider-plan`
 * reviews.
 */
export interface ProviderProject1 {
  files: ProviderFileCandidate[];
  /**
   * The provider's game identity for this project; compared against a reviewed
   * binding, never matched by name or popularity.
   */
  game_id: string | null;
  name: string;
  obsolete: boolean;
  profile_url: string;
  project_id: string;
  provider: string;
  submitter: string | null;
  /**
   * File records the adapter could not read. Non-zero means the file list is
   * incomplete, so "no newer file" or "file removed" cannot be concluded.
   */
  unreadable_files: number;
  updated_at: number;
  /**
   * Displayed version label; it does not identify bytes (a file can change
   * under an unchanged label).
   */
  version: string | null;
  [k: string]: unknown;
}
export interface OutputProviderUpdateObservation {
  freshness: ProviderFreshness | null;
  installed_version: string | null;
  native_id: string;
  /**
   * Candidates oldest first (GameBanana file ID, Thunderstore publish date);
   * more than one is ambiguous.
   */
  newer_files: ProviderFileCandidate[];
  observed_version: string | null;
  provider: ProviderPackageRef;
  reason: string | null;
  state: ProviderUpdateState;
  /**
   * False with `NewerFiles` means files changed under an unchanged version label.
   */
  version_changed: boolean;
  [k: string]: unknown;
}
export interface OutputRecipeImportPlan {
  can_apply: boolean;
  /**
   * Why applying is not possible yet; empty when every input is present.
   */
  holds: string[];
  /**
   * The exact installation the new profile would bind, when one matches.
   */
  install_id: string | null;
  originals: RecipeInputPlan[];
  packages: RecipeInputPlan[];
  plan_sha256: string;
  recipe: ProfileRecipe;
  runtime: RecipeInputPlan;
  [k: string]: unknown;
}
export interface RecipeInputPlan {
  detail: string;
  name: string;
  status: RecipeInputStatus;
  [k: string]: unknown;
}
export interface OutputRecommendationMetadata {
  capabilities: RecommendationCapabilityObservation[];
  format_version: number;
  observations: RecommendationObservation[];
}
export interface RecommendationCapabilityObservation {
  capability: string;
  explanation: string;
  id: string;
  kind: RecommendationEvidenceKind;
  observed_at: number;
  scope: RecommendationScope;
  source: string;
  state: RecommendationRequirement;
}
export interface RecommendationObservation {
  explanation: string;
  /**
   * Explicit accepted fixes. Only exact-scope observed gameplay/save success can clear a failure.
   */
  fixes: string[];
  id: string;
  kind: RecommendationEvidenceKind;
  observed_at: number;
  outcome: RecommendationOutcome;
  scope: RecommendationScope;
  source: string;
  supersedes: string[];
}
export interface OutputReconcileBatchOutcome {
  error: FailureReport | null;
  ok: boolean;
  port_id: string;
  result: ReconcileResult | null;
  [k: string]: unknown;
}
export interface ReconcileResult {
  action: ReconcileAction;
  check: UpdateCheck;
  install: InstallRecord | null;
  policy: UpdatePolicy;
  port_id: string;
  [k: string]: unknown;
}
export interface OutputRestoreResult {
  restored_backup: BackupRecord;
  safety_backup: BackupRecord | null;
  [k: string]: unknown;
}
export interface OutputRetainedBuildBindingPreview {
  build: RetainedBuildIdentity;
  preview_sha256: string;
  previous: RetainedBuildReference | null;
  setup_id: string;
  [k: string]: unknown;
}
export interface OutputRetainedBuildInventory {
  builds: RetainedBuild[];
  port_id: string;
  references: RetainedBuildResolution[];
  [k: string]: unknown;
}
export interface RetainedBuild {
  active: boolean;
  availability: RetainedBuildAvailability;
  gap: RetainedBuildGap | null;
  identity: RetainedBuildIdentity | null;
  install: InstallRecord;
  /**
   * Setups keeping this build only as an offered recovery target.
   */
  offered_by: string[];
  previous: boolean;
  retained_by: string[];
  [k: string]: unknown;
}
export interface RetainedBuildGap {
  code: ErrorCode;
  details: {
    [k: string]: string;
  };
  message: string;
  [k: string]: unknown;
}
/**
 * A verified observation, not permission to launch. Consumers must use the
 * ordinary locked launch/preparation paths and recheck their current holds.
 */
export interface RetainedBuildResolution {
  availability: RetainedBuildAvailability;
  gap: RetainedBuildGap | null;
  history: RetainedBuildHistoryResolution[];
  install: InstallRecord | null;
  reference: RetainedBuildReference;
  [k: string]: unknown;
}
/**
 * Current availability of one offered recovery target.
 */
export interface RetainedBuildHistoryResolution {
  availability: RetainedBuildAvailability;
  gap: RetainedBuildGap | null;
  install: InstallRecord | null;
  revision: RetainedBuildRevision;
  [k: string]: unknown;
}
export interface OutputRetainedBuildRemovalPreview {
  preview_sha256: string;
  reference: RetainedBuildReference;
  [k: string]: unknown;
}
export interface OutputRetainedBuildRetirementPreview {
  preview_sha256: string;
  revision: RetainedBuildRevision;
  setup_id: string;
  [k: string]: unknown;
}
export interface OutputSaveFolderPushResult {
  /**
   * The same saves were already in the folder; nothing was written.
   */
  already_present: boolean;
  base_sha256?: string | null;
  content_sha256: string;
  path: string;
  [k: string]: unknown;
}
export interface OutputSaveFolderStatus {
  available: boolean;
  /**
   * False when the folder exceeded review limits; history is then unknown.
   */
  complete: boolean;
  entries: SaveFolderEntry[];
  folder: string;
  local_content_sha256?: string | null;
  local_published: boolean;
  /**
   * Another device set this device's current saves aside.
   */
  local_set_aside: boolean;
  next_step: SaveFolderNextStep;
  port_id: string;
  /**
   * Files in the folder that were ignored, with the reason.
   */
  problems: string[];
  [k: string]: unknown;
}
export interface SaveFolderEntry {
  /**
   * This device's progress already includes these saves.
   */
  already_included_here: boolean;
  base_sha256?: string | null;
  /**
   * Same qualified game version and platform contract as this device.
   */
  compatible: boolean;
  content_sha256: string;
  files: PortableSaveFile[];
  /**
   * Latest on its branch: no other saves in the folder continue from it.
   */
  head: boolean;
  relation: PortableSaveRelation;
  source: PortableSaveIdentity;
  /**
   * Set aside by an explicit choice; still kept and importable.
   */
  superseded: boolean;
  [k: string]: unknown;
}
export interface OutputSetupLaunchTargets {
  candidates: SetupLaunchTarget[];
  complete: boolean;
  entries_checked: number;
  explanation: string;
  pending_id: string;
  port_id: string;
  recommended_executable: string | null;
  [k: string]: unknown;
}
export interface SetupLaunchTarget {
  executable: string;
  reason: string;
  supporting_program: boolean;
  working_directory: string;
  [k: string]: unknown;
}
export interface OutputSignedCatalogEnvelope {
  format_version: number;
  key_id: string;
  /**
   * Exact UTF-8 bytes are signed; consumers must not reserialize before verification.
   */
  payload: string;
  signature: string;
}
export interface OutputSignedCatalogPayload {
  catalog: CatalogDocument;
  expires_at: number;
  issued_at: number;
  sequence: number;
}
export interface OutputSourceBatchOutcome {
  error: FailureReport | null;
  ok: boolean;
  profile_id: string;
  result: SourceVerification | null;
  [k: string]: unknown;
}
export interface SourceVerification {
  inspection: SourceInspectionReport1;
  path: string;
  profile_id: string;
  registered_at: number;
  sha256: string;
  size: number;
  storage_sha256: string;
  storage_size: number;
  verified_at: number;
  [k: string]: unknown;
}
/**
 * A stable, complete explanation of selected source bytes. `state_code` is an
 * open string so clients can preserve an unfamiliar future state instead of
 * failing enum deserialization. Detailed enums remain versioned by the report
 * and outer API schema boundaries.
 */
export interface SourceInspectionReport1 {
  applications: SourceApplicationInspection[];
  evidence: SourceEvidenceLink[];
  expected_identity?: SourceIdentityProfile | null;
  health: SourceHealth;
  inspection?: SourceInspection | null;
  legacy: SourceLegacyCoverage;
  next_action: string;
  problem?: SourceInspectionProblem | null;
  profile_id: string;
  registered?: SourceRecord | null;
  schema_version: number;
  state_code: string;
  summary: string;
  [k: string]: unknown;
}
export interface OutputSourceDiscoveryRequest {
  limits: SourceDiscoveryLimits1;
  profile_ids: string[];
  roots: string[];
  [k: string]: unknown;
}
export interface SourceDiscoveryLimits1 {
  max_candidates: number;
  max_depth: number;
  max_entries: number;
  max_file_bytes: number;
  max_hash_bytes: number;
  [k: string]: unknown;
}
export interface OutputSourceImportPlan {
  admission_mode: SourceAdmissionMode;
  destination: string;
  destination_exists: boolean;
  existing_registration: SourceRecord | null;
  mode: SourceImportMode;
  plan_sha256: string;
  profile_id: string;
  required_bytes: number;
  reuse_existing: boolean;
  schema_version: number;
  source: SourceRecord;
  /**
   * Binds the reviewed path to its filesystem objects as well as its bytes.
   */
  source_guard_sha256: string;
  [k: string]: unknown;
}
export interface OutputSourceImportResult {
  copied: boolean;
  import_id: string;
  mode: SourceImportMode;
  original_deleted: boolean;
  original_retained: boolean;
  outcome: SourceImportOutcome;
  profile_id: string;
  recovered: boolean;
  registered: SourceRecord;
  retained_original_path?: string | null;
  [k: string]: unknown;
}
export interface SourceInboxPaths {
  profile: string | null;
  profile_id: string | null;
  root: string;
  [k: string]: unknown;
}
export interface OutputSourceInboxResolution {
  candidates: SourceInboxCandidate[];
  operation_id: string;
  paths: SourceInboxPaths;
  profile_id: string;
  selected: SourceRecord | null;
  state: SourceInboxResolutionState;
  stats: SourceInboxScanStats;
  [k: string]: unknown;
}
export interface SourceInboxCandidate {
  automatically_reusable: boolean;
  inspection: SourceInspection;
  [k: string]: unknown;
}
export interface SourceInboxScanStats {
  candidates_inspected: number;
  entries_examined: number;
  /**
   * Bytes charged to the scan's hashing budget. Specialized disc estimates
   * are conservative because their established tools materialize normalized bytes.
   */
  hash_bytes: number;
  issues: SourceDiscoveryIssue[];
  issues_omitted: number;
  limits_reached: SourceDiscoveryLimit[];
  symlinks_skipped: number;
  [k: string]: unknown;
}
/**
 * Read-only result for paths offered through a host intake surface such as
 * native drag and drop. The core, rather than the host adapter, decides
 * whether the offered shape can be inspected for the requested profile.
 */
export interface OutputSourceIntakeInspection {
  input_count: number;
  next_action: string;
  problem?: SourceInspectionProblem | null;
  profile_id: string;
  report?: SourceInspectionReport | null;
  schema_version: number;
  /**
   * Open stable code. A successful single-path inspection reuses the nested
   * source report's state code.
   */
  state_code: string;
  summary: string;
  [k: string]: unknown;
}
export interface OutputSourceRelinkPlan {
  original: SourceRecord;
  preview_sha256: string;
  replacement: SourceRecord;
  [k: string]: unknown;
}
export interface OutputSourceRemovalPreview {
  dependent_port_ids: string[];
  installed_dependent_port_ids: string[];
  preview_sha256: string;
  source: SourceRecord;
  [k: string]: unknown;
}
export interface OutputSourceReuseReview {
  applications: SourceReuseApplication[];
  inspection: SourceInspectionReport;
  reference: SourceRegistrationReference;
  registration: SourceRecord;
  [k: string]: unknown;
}
export interface SourceReuseApplication {
  additional_checks: string[];
  can_review_setup: boolean;
  compatibility: SourceReuseCompatibility;
  contract_id: string;
  port_id: string;
  port_name: string;
  role: PortSourceRole;
  summary: string;
  [k: string]: unknown;
}
export interface SourceRegistrationReference {
  profile_id: string;
  reference_sha256: string;
}
/**
 * A proposed static image for one role, with attribution. Not a selection.
 */
export interface SteamGridDbCandidate {
  author: SteamGridDbAuthor;
  height: number;
  id: number;
  mime: string;
  role: DestinationArtworkRole;
  score: number;
  style: string;
  thumb: string;
  url: string;
  width: number;
  [k: string]: unknown;
}
export interface SteamGridDbAuthor {
  name: string;
  steam64: string | null;
  [k: string]: unknown;
}
export interface SteamGridDbGame {
  id: number;
  name: string;
  verified: boolean;
  [k: string]: unknown;
}
export interface OutputSteamgriddbKeyStatus {
  /**
   * Whether a player key is stored; the key itself is never returned.
   */
  configured: boolean;
  [k: string]: unknown;
}
export interface OutputSteamgriddbListingReport {
  checked_at: number;
  images: SteamGridDbImageCheck[];
  /**
   * Whether these results were recorded in the library. A cancelled check, or
   * one whose recording failed, still reports what it saw.
   */
  recorded: boolean;
  /**
   * Removals left for the next check, export or move because one check
   * removes a bounded number while it holds the library.
   */
  removal_deferred: number;
  /**
   * Removals that failed, usually because another program holds the file.
   * Portcove no longer shows or hands out these copies.
   */
  removal_failed: number;
  /**
   * Copies of withdrawn images removed from the library during this check,
   * including removals left over from earlier checks.
   */
  removed: number;
  /**
   * Attempted results that could not be written and stay unrecorded; they are
   * checked again first next time.
   */
  skipped: number;
  stopped: SteamGridDbCheckStop | null;
}
export interface SteamGridDbImageCheck {
  asset_sha256: string;
  /**
   * Whether this run requested the image's listing and reached a conclusion
   * other than running out of budget; images not reached are `false`.
   */
  attempted: boolean;
  attribution: ArtworkAttribution;
  /**
   * What recording this result changed; `none` when the check was not recorded.
   */
  effect: "none" | "withdrawn" | "removed" | "listed_again";
  /**
   * When Portcove removed the stored copy behind this record, as recorded
   * after this check; choosing the image again restores it.
   */
  evicted_at: number | null;
  listing: SteamGridDbListingResult;
  /**
   * The `total` SteamGridDB reported for the image's listing, when one was read.
   */
  listing_total: number | null;
  /**
   * When a verified listing first lacked this image, as recorded in the
   * library after this check; cleared only by a later observed listing.
   */
  not_listed_since: number | null;
  source: SteamGridDbSourceStatus;
  /**
   * When a check confirmed this record withdrawn, as recorded after this
   * check; cleared when it is seen listed again or chosen again.
   */
  withdrawn_at: number | null;
}
export interface OutputStoreGameInstalls {
  /**
   * The stores this host's metadata was read for. A store missing here was
   * not checked, which is different from having no games installed.
   */
  checked_stores: GameStore[];
  installs: StoreGameInstall[];
  /**
   * Whether a detection bound stopped the list early.
   */
  limited: boolean;
  /**
   * Store entries left out because their metadata was unreadable, malformed,
   * unsafe or named a folder that does not exist.
   */
  skipped_entries: number;
  [k: string]: unknown;
}
/**
 * One game folder a store installed, as the store's own metadata records it.
 */
export interface StoreGameInstall {
  /**
   * Canonical existing folder.
   */
  path: string;
  /**
   * The saved game-file folder at exactly this path, when there is one.
   */
  saved_root_id: string | null;
  store: GameStore;
  /**
   * The store's title for the game; a label, never an identity.
   */
  title: string;
  [k: string]: unknown;
}
export interface OutputUpdateBatchOutcome {
  error: FailureReport | null;
  ok: boolean;
  port_id: string;
  result: InstallRecord | null;
  [k: string]: unknown;
}
/**
 * The expected provider cost of checking a set of games at once.
 */
export interface OutputUpdateCheckForecast {
  counted_requests: number;
  games: number;
  sign_in_relief_requests: number;
  [k: string]: unknown;
}
export interface OutputUpstreamObservationReport {
  adapter: AdapterKind;
  catalog_definition_sha256: string;
  eligibility_scope: string;
  engine_api_schema_version: number;
  evidence: ObservationEvidence;
  facts_sha256: string;
  format: number;
  observed_at: string;
  port_id: string;
  projections: ChannelObservation[];
  repository_id: number;
  [k: string]: unknown;
}
export interface ObservationEvidence {
  artifact_bytes_verified: boolean;
  catalog_admission_assessed: boolean;
  provider_authenticated: boolean;
  [k: string]: unknown;
}
export interface ChannelObservation {
  channel: ReleaseChannel;
  channel_candidate: ObservedReleaseIdentity | null;
  /**
   * Exact provider assets required for automatic integrity continuation.
   */
  checksum_sources?: ObservedChecksumSource[];
  hold_reasons: string[];
  latest_eligible: ObservedResolution | null;
  latest_observed: ObservedReleaseIdentity | null;
  platform: Platform;
  [k: string]: unknown;
}
export interface ObservedReleaseIdentity {
  id: number;
  provider_prerelease: boolean;
  published_at: string | null;
  tag: string;
  [k: string]: unknown;
}
export interface ObservedChecksumSource {
  asset_id: number;
  release_id: number;
  [k: string]: unknown;
}
export interface ObservedResolution {
  asset_id: number;
  release: ResolvedRelease;
  release_id: number;
  [k: string]: unknown;
}
export interface ApplicationUpdateCheckResult {
  candidate: ApplicationUpdateCandidateSummary | null;
  kind: ApplicationUpdateCheckResultKind;
  reasons: string[];
  staged: boolean;
  [k: string]: unknown;
}
export interface ApplicationUpdateCandidateSummary {
  bytes: number;
  channel: ApplicationChannel;
  version: string;
}
export interface OutputDesktopApplicationUpdateManualCheckResult {
  checked_channel: ApplicationChannel;
  result: ApplicationUpdateCheckResult;
  [k: string]: unknown;
}
export interface OutputDesktopApplicationUpdateNotice {
  notice: ApplicationUpdateNotice | null;
  revision: number;
  [k: string]: unknown;
}
export interface ApplicationUpdateNotice {
  preference_revision: number;
  result: ApplicationUpdateCheckResult;
  [k: string]: unknown;
}
export interface ApplicationUpdatePreferences {
  /**
   * `None` means the user has not completed the one-time choice.
   */
  choice: ApplicationUpdateChoice | null;
  revision: number;
  schema_version: number;
}
export interface ApplicationUpdateChoice {
  channel: ApplicationChannel;
  mode: ApplicationUpdateMode;
  paused: boolean;
}
export interface ApplicationUpdateProductionTransition {
  offer_required: boolean;
  preference_revision: number;
  schema_version: number;
  [k: string]: unknown;
}
export interface OutputDesktopApplicationUpdateProductionTransitionResult {
  preferences: ApplicationUpdatePreferences;
  transition: ApplicationUpdateProductionTransition;
  [k: string]: unknown;
}
export interface OutputDesktopApplicationUpdateStatus {
  apply: ApplicationUpdateApplySummary | null;
  install_eligibility: ApplicationUpdateInstallEligibility;
  recovery_required: ApplicationUpdateRecoveryNotice[];
  schedule: ApplicationUpdateScheduleSummary | null;
  staged: ApplicationUpdateCandidateSummary | null;
  [k: string]: unknown;
}
export interface ApplicationUpdateApplySummary {
  native_launch: ApplicationUpdateNativeLaunchSummary | null;
  request: ApplicationUpdateRequestedAction;
  revision: number;
  termination: ApplicationUpdateObservedTermination | null;
  [k: string]: unknown;
}
export interface ApplicationUpdateRecoveryNotice {
  area: ApplicationUpdateRecoveryArea;
  [k: string]: unknown;
}
export interface ApplicationUpdateScheduleSummary {
  consecutive_failures: number;
  last_success_unix_seconds: number | null;
  next_automatic_check_unix_seconds: number | null;
  [k: string]: unknown;
}
export interface OutputDesktopBackupReview {
  persistent_data_path: string;
  port_name: string;
  preview: BackupActionPreview;
  [k: string]: unknown;
}
export interface OutputDesktopBootstrapStatus {
  error: FailureReport | null;
  generation: number;
  library_root: string | null;
  ready: boolean;
  selection: LibrarySelection | null;
  [k: string]: unknown;
}
/**
 * The exact text that will appear in the issue form, after redaction.
 */
export interface OutputDesktopBugReportDraft {
  /**
   * Dropdowns the player picks; empty for a bug report.
   */
  choices: ReportChoice[];
  fields: BugReportField[];
  [k: string]: unknown;
}
/**
 * A dropdown from the issue form. Its value travels as a field with the same id
 * and must be one of `options`.
 */
export interface ReportChoice {
  id: string;
  label: string;
  options: string[];
  [k: string]: unknown;
}
export interface BugReportField {
  id: string;
  label: string;
  value: string;
  [k: string]: unknown;
}
export interface OutputDesktopBugReportLink {
  /**
   * Plain text to copy when there is no link.
   */
  clipboard_text: string;
  /**
   * Pre-filled form link, or `None` when the text does not fit in a link.
   */
  url: string | null;
  [k: string]: unknown;
}
export interface OutputDesktopCliCommandContext {
  executable: string | null;
  library_root: string;
  platform: Platform;
  [k: string]: unknown;
}
export interface InstallBatchRecord {
  cancel_requested: boolean;
  created_at: number;
  format_version: number;
  id: string;
  items: InstallBatchItem[];
  updated_at: number;
}
export interface InstallBatchItem {
  detail?: string | null;
  expected_plan_sha256: string;
  install_id?: string | null;
  port_id: string;
  state: InstallBatchItemState;
}
export interface OutputDesktopInstallBatchReview {
  capacity: InstallBatchCapacity;
  items: InstallBatchReviewItem[];
  [k: string]: unknown;
}
/**
 * Combined needs of the games ready to install.
 */
export interface InstallBatchCapacity {
  /**
   * Known downloads: releases, bundled runtimes and required extras.
   */
  download_bytes: number;
  /**
   * Ready games whose space needs could not be estimated.
   */
  unknown_space?: string[];
  volumes: InstallBatchVolume[];
  [k: string]: unknown;
}
/**
 * Space one volume needs for the games in a batch that will download.
 */
export interface InstallBatchVolume {
  available_bytes?: number | null;
  /**
   * A destination on the volume (the first game's).
   */
  path: string;
  port_ids: string[];
  /**
   * Sum of the games' temporary space floors on this volume. Final
   * installed sizes are not known in advance.
   */
  required_bytes: number;
  /**
   * Whether the volume has room for all of them together; unknown when its
   * free space could not be observed. Each game is checked again before it runs.
   */
  sufficient?: boolean | null;
  volume_identity?: string | null;
  [k: string]: unknown;
}
/**
 * One game in a batch review: its exact plan, or why it cannot run yet.
 */
export interface InstallBatchReviewItem {
  hold?: string | null;
  plan?: GameInstallPlan | null;
  port_id: string;
  [k: string]: unknown;
}
export interface OutputDesktopLaunchResult {
  processId: number | null;
  sessionId: string;
  [k: string]: unknown;
}
export interface LibraryMembershipOutcome {
  outcome: LibraryMembershipOutcomeKind;
  port_id: string;
  [k: string]: unknown;
}
export interface OutputDesktopLibraryOrganization {
  collections: {
    [k: string]: CollectionPreference;
  };
  /**
   * Explicit opt-in, separate from Saved or Favorites and never automatic installation.
   */
  followed_port_ids: string[];
  followed_release_acknowledgments: {
    [k: string]: string[];
  };
  hidden_port_ids: string[];
  /**
   * Advisory implementation choice for an explicit original-game identity.
   * This never selects a release, installation, source edition or action grant.
   */
  preferred_port_by_game?: {
    [k: string]: string;
  };
  revision: number;
  saved_game_ids: string[];
  setup_confirmations: SetupConfirmation[];
  update_notices: {
    [k: string]: UpdateNoticeChoice;
  };
  [k: string]: unknown;
}
export interface CollectionPreference {
  name: string;
  port_ids: string[];
  [k: string]: unknown;
}
export interface SetupConfirmation {
  context: InstallationContext;
  port_id: string;
}
export interface UpdateNoticeChoice {
  paused: boolean;
  skipped_release: UpdateNoticeRelease | null;
  [k: string]: unknown;
}
export interface UpdateNoticeRelease {
  /**
   * Same-tag rebuilds with different bytes must remain visible.
   */
  artifact_sha256: string;
  version: string;
}
export interface OutputDesktopLocalePreference {
  locale: string | null;
  [k: string]: unknown;
}
export interface PortIntent {
  /**
   * The ready plan the player was last told about; a notification repeats
   * only when the ready plan changes.
   */
  acknowledged_plan_sha256?: string | null;
  /**
   * The release channel chosen with this choice. A different channel later
   * waits for the player to choose again.
   */
  channel?: ReleaseChannel | null;
  /**
   * Set when the player uninstalled the game. Standing setup and
   * notifications stay quiet until the player chooses a mode again.
   */
  explicitly_uninstalled_at?: number | null;
  failed_attempts?: number;
  /**
   * The plan whose standing setup last failed, and how many times it has
   * failed. It is retried on later passes up to a small limit, then waits
   * until the plan changes, so a permanent failure does not recur.
   */
  failed_plan_sha256?: string | null;
  failure?: string | null;
  format_version: number;
  mode: PortIntentMode;
  port_id: string;
  /**
   * The registered copies of this game's files when the choice was made.
   * A different or removed copy later waits for the player; it is never
   * silently retargeted. Empty when no files were registered yet: the first
   * files that arrive are used.
   */
  sources?: PortIntentSource[];
  updated_at: number;
}
/**
 * One registered copy a remembered choice is bound to.
 */
export interface PortIntentSource {
  profile_id: string;
  sha256: string;
}
export interface OutputDesktopPortIntentAssessments {
  assessments: PortIntentAssessment[];
  /**
   * Intents left for a later pass because one pass is bounded.
   */
  not_assessed: number;
  /**
   * Whether the player wants ready notices. While off, a game set to be
   * told is never reported as newly ready; nothing about its choice or its
   * readiness changes, and set-up-when-ready games are unaffected.
   */
  ready_notices_enabled: boolean;
  [k: string]: unknown;
}
export interface PortIntentAssessment {
  mode: PortIntentMode;
  /**
   * Ready with a plan, or installed with an update, the player has not
   * been told about yet.
   */
  newly_ready: boolean;
  port_id: string;
  readiness: PortReadiness;
  /**
   * Why this intent will not act or notify right now, if it won't.
   */
  suppressed?: string | null;
  [k: string]: unknown;
}
/**
 * An installed game's maintenance state, read from its saved channel and
 * update policy and its last update check. Assessing it downloads, stages or
 * activates nothing; the existing update check and policy own that.
 */
export interface PortMaintenance {
  active_version: string;
  /**
   * Identity of that release, used to announce it once.
   */
  available_sha256?: string | null;
  /**
   * A newer release the last check found on this channel, if any.
   */
  available_version?: string | null;
  /**
   * The game is running or its launch must recover, an update is
   * downloading or verifying, or an install, update or data change for it
   * is unfinished or must recover; maintenance waits for it.
   */
  busy?: boolean;
  channel: ReleaseChannel;
  /**
   * When updates were last checked for this install on this channel;
   * `None` means not yet.
   */
  checked_at?: number | null;
  /**
   * The earlier version Portcove keeps for this game, if any. Whether a
   * rollback to it is allowed right now is decided by the game's actions.
   */
  previous_version?: string | null;
  staged_version?: string | null;
  update_policy: UpdatePolicy;
  [k: string]: unknown;
}
export interface RootSetupConsent {
  enabled_at: number;
  enrollment: RootSetupEnrollment;
  /**
   * Files remembered as already in the folder (future-only); they are never
   * set up by this choice.
   */
  existing_files: number;
  failures?: RootSetupFailure[];
  format_version: number;
  /**
   * Explicit implementation choices. Files several games can use wait
   * until one is chosen; Portcove never sets up every fork.
   */
  implementations?: RootSetupImplementation[];
  /**
   * Copy each matched game's required files into Portcove's game-file
   * folder instead of using them in place, so games that read their
   * originals at launch don't need this folder connected. The originals
   * are never moved. Off by default.
   */
  keep_local_copy?: boolean;
  root_id: string;
  updated_at: number;
  [k: string]: unknown;
}
export interface RootSetupFailure {
  attempts: number;
  /**
   * The install plan, or `source:` and the file, that failed.
   */
  plan_sha256: string;
  port_id: string;
  reason: string;
  [k: string]: unknown;
}
/**
 * The game the player chose for files that several implementations can use.
 */
export interface RootSetupImplementation {
  port_id: string;
  profile_id: string;
  [k: string]: unknown;
}
/**
 * What one standing-setup pass did for each game it considered.
 */
export interface OutputDesktopStandingSetup {
  /**
   * Another process is already running a pass; this one did nothing.
   */
  already_running: boolean;
  assessments: PortIntentAssessment[];
  /**
   * One single-game batch per game that started, in order.
   */
  batches: InstallBatchRecord[];
  /**
   * Games that could not start; the others were not affected.
   */
  failures: StandingSetupFailure[];
  /**
   * Provider updates for mod setups whose policy allows unattended updates.
   */
  mod_updates?: ProviderAutoUpdate[];
  not_assessed: number;
  /**
   * Matched files in folders with automatic setup that wait for a person
   * or a requirement.
   */
  root_waiting?: RootSetupWaiting[];
  [k: string]: unknown;
}
export interface StandingSetupFailure {
  port_id: string;
  reason: string;
  [k: string]: unknown;
}
/**
 * An eligible-looking file in a consented folder that is waiting for a person
 * or a requirement.
 */
export interface RootSetupWaiting {
  port_id?: string | null;
  profile_id: string;
  reason: string;
  root_id: string;
  [k: string]: unknown;
}
export interface OutputDesktopSteamArtworkApplyResult {
  backup_paths: string[];
  plan_sha256: string;
  roles: SteamArtworkRoleChange[];
  wrote: boolean;
  [k: string]: unknown;
}
export interface SteamArtworkRoleChange {
  action: SteamArtworkRoleAction;
  destination_path: string | null;
  existing_paths: string[];
  existing_sha256: string | null;
  /**
   * The destination-local ownership record for this role is dropped.
   */
  forget_ownership: boolean;
  proposed_sha256: string | null;
  role: DestinationArtworkRole;
  unavailable_reason: DestinationArtworkUnavailableReason | null;
  [k: string]: unknown;
}
export interface OutputDesktopSteamArtworkReview {
  app_id: number | null;
  display_name: string;
  grid_path: string;
  operation: SteamArtworkOperation;
  plan_sha256: string;
  port_id: string;
  recovered: SteamArtworkRecovery | null;
  /**
   * An interrupted shortcut (or, for shortcut reviews, artwork) change in this
   * profile was settled before review.
   */
  recovered_shortcut_change: boolean;
  roles: SteamArtworkRoleChange[];
  schema_version: number;
  steam_client_state: SteamClientState;
  steam_root: string;
  steam_user_id: string;
  writes_required: boolean;
  [k: string]: unknown;
}
/**
 * Roles an earlier interrupted artwork change settled before this review.
 */
export interface SteamArtworkRecovery {
  abandoned: DestinationArtworkRole[];
  completed: DestinationArtworkRole[];
  [k: string]: unknown;
}
export interface OutputDesktopSteamBatchReview {
  artwork: SteamEntryArtworkPreview[];
  artwork_review_sha256: string | null;
  changes: SteamEntryChange[];
  cli_path: string;
  cli_product_version: string;
  cli_sha256: string;
  library_root: string;
  proposed_sha256: string;
  /**
   * An interrupted shortcut (or, for shortcut reviews, artwork) change in this
   * profile was settled before review.
   */
  recovered_shortcut_change: boolean;
  review_sha256: string;
  schema_version: number;
  selected_games: SteamGameEntryTarget[];
  shortcuts_path: string;
  snapshot_sha256: string | null;
  steam_client_state: SteamClientState;
  steam_root: string;
  steam_user_id: string;
  writer_plan_sha256: string;
  writes_required: boolean;
  [k: string]: unknown;
}
/**
 * Artwork reviewed together with a shortcut Add for one game.
 */
export interface SteamEntryArtworkPreview {
  port_id: string;
  roles: SteamArtworkRoleChange[];
  /**
   * Why this game's artwork cannot be reviewed now; the shortcut is unaffected.
   */
  unavailable: string | null;
  [k: string]: unknown;
}
export interface SteamEntryChange {
  display_name: string | null;
  kind: SteamEntryChangeKind;
  port_id: string;
  [k: string]: unknown;
}
export interface SteamGameEntryTarget {
  display_name: string;
  port_id: string;
  [k: string]: unknown;
}
export interface OutputDesktopSteamEntryApplyResult {
  /**
   * Per-game outcome of artwork included with a shortcut Add. A failed or
   * unavailable role never undoes a successfully written shortcut.
   */
  artwork: SteamEntryArtworkOutcome[];
  backup_path: string | null;
  changes: SteamEntryChange[];
  plan_sha256: string;
  shortcuts_path: string;
  wrote: boolean;
  [k: string]: unknown;
}
export interface SteamEntryArtworkOutcome {
  backup_paths: string[];
  /**
   * Why no artwork was written for this game; retry with Review artwork update.
   */
  error: string | null;
  port_id: string;
  roles: SteamArtworkRoleChange[];
  wrote: boolean;
  [k: string]: unknown;
}
export interface OutputDesktopSteamEntryReview {
  artwork: SteamEntryArtworkPreview[];
  artwork_review_sha256: string | null;
  changes: SteamEntryChange[];
  cli_path: string | null;
  cli_product_version: string | null;
  cli_sha256: string | null;
  display_name: string;
  library_root: string;
  operation: SteamEntryOperation;
  plan_sha256: string;
  port_id: string;
  proposed_sha256: string;
  /**
   * An interrupted shortcut (or, for shortcut reviews, artwork) change in this
   * profile was settled before review.
   */
  recovered_shortcut_change: boolean;
  schema_version: number;
  shortcuts_path: string;
  snapshot_sha256: string | null;
  steam_client_state: SteamClientState;
  steam_root: string;
  steam_user_id: string;
  writes_required: boolean;
  [k: string]: unknown;
}
/**
 * An issue GitHub created from a submitted report.
 */
export interface OutputDesktopSubmittedReport {
  number: number;
  url: string;
  [k: string]: unknown;
}
export interface OutputDesktopSupportBundleExport {
  manifest: SupportBundleManifest;
  path: string;
  [k: string]: unknown;
}
export interface SupportBundleManifest {
  created_at_ms: number;
  library_available: boolean;
  limits: SupportBundleLimits;
  product_version: string;
  schema_version: number;
  scope: SupportBundleScope;
  sections: SupportBundleSection[];
  /**
   * No source revision is invented when the build does not provide one.
   */
  source_revision: string | null;
  target_arch: string;
  target_os: string;
  [k: string]: unknown;
}
export interface SupportBundleLimits {
  activity_count: number;
  capture_count: number;
  /**
   * Cooperative checkpoints; this does not time out a blocked OS call.
   */
  collection_seconds: number;
  log_bytes: number;
  /**
   * Aggregate raw runtime-log input across session and legacy candidates.
   */
  log_input_bytes: number;
  record_bytes: number;
  section_bytes: number;
  total_bytes: number;
  [k: string]: unknown;
}
export interface SupportBundleSection {
  bytes_read: number | null;
  bytes_written: number;
  entry: string | null;
  kind: SupportBundleSectionKind;
  provenance: SupportBundleProvenance;
  /**
   * Closed reasons only. OS/SQL errors, paths and payloads never enter here.
   */
  reasons: SupportBundleReason[];
  records: number | null;
  status: SupportBundleSectionStatus;
  [k: string]: unknown;
}
export interface OutputDesktopWorkspaceSnapshot {
  activities: ActivityFeed;
  browsing?: CatalogBrowsingSnapshot | null;
  /**
   * Omitted only when `catalog_unchanged` is true.
   */
  catalog?: CatalogDocument | null;
  /**
   * SHA-256 of the catalog and listing documents as serialized here. A
   * caller that already holds these exact documents passes the digest back
   * and receives `catalog_unchanged` without either document.
   */
  catalog_digest?: string | null;
  /**
   * True when `catalog` and `listing_catalog` were omitted because the
   * caller's known digest matched; the caller keeps its own copies.
   */
  catalog_unchanged?: boolean;
  listing_catalog?: CatalogListingDocument | null;
  listing_statuses?: PortListingStatus[];
  pending_setups?: PendingSetupRecord[];
  sources: SourceRecord[];
  statuses: PortStatus[];
  [k: string]: unknown;
}
export interface CatalogBrowsingSnapshot {
  contexts: CatalogBrowsingContext[];
  host_platform: Platform;
  library: LibraryIdentity;
  /**
   * False when bounded retained metadata could not be observed. Membership
   * still comes from complete Core status, not from metadata-read success.
   */
  retained_metadata_complete: boolean;
  schema_version: number;
  /**
   * Binds the complete catalog, status and source inputs; never a private path.
   */
  workspace_binding_sha256: string;
  [k: string]: unknown;
}
export interface CatalogBrowsingContext {
  artifact_sha256: string | null;
  channel: ReleaseChannel | null;
  context_id: string;
  definition_sha256: string | null;
  installation_id: string | null;
  installation_method: InstallationMethod | null;
  instance_sha256: string | null;
  member_context: boolean;
  /**
   * Legacy managed metadata can lack this fact. Do not substitute the host.
   */
  platform: Platform | null;
  port_id: string;
  /**
   * Whole-port membership is distinct from membership of this exact context.
   */
  port_member: boolean;
  release_version: string | null;
  route: GameFileRouteKind;
  [k: string]: unknown;
}
