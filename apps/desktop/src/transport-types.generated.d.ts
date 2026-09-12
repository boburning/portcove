// Generated from Rust output schemas. Do not edit.
// Regenerate: node apps/desktop/scripts/generate-transport-types.mjs --write

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
export type FailureTone = "neutral" | "error";
export type ActivityOperation =
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
  | "register_source"
  | "verify_source";
export type ActivityStatus = "running" | "succeeded" | "failed" | "cancelled";
export type ActivityTargetKind = "port" | "source" | "library";
export type OutputActivityDiagnostic = ActivityDiagnostic[];
export type ReleaseChannel = "stable" | "beta" | "rolling";
export type RuntimeOrigin = "verified_download" | "adopted_tree";
export type OutputLocationSource = "request_override" | "port_setting" | "library_default";
export type DefinitionEligibilityOutcome = "eligible" | "hold" | "escalate";
export type DefinitionEligibilityReason =
  | "mandatory_checks_passed"
  | "publisher_revoked"
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
export type DefinitionOperation = "availability" | "install" | "prepare" | "launch";
/**
 * Current relationship between a registered source path and its saved storage identity.
 * `Current` means the bytes are unchanged since registration; it does not strengthen the
 * catalog profile's game-revision evidence.
 * `NotBaselined` means readable selected bytes have no saved identity baseline.
 */
export type SourceHealth =
  "unregistered" | "current" | "missing" | "unreadable" | "changed" | "not_checked" | "not_baselined";
export type LaunchBlocker =
  | "missing_source"
  | "unreadable_source"
  | "changed_source"
  | "missing_bios"
  | "unreadable_bios"
  | "changed_bios"
  | "missing_runtime"
  | "preparation_required"
  | "invalid_installation";
export type UpdatePolicy = "notify" | "stage" | "automatic";
export type ArtworkImageFormat = "png" | "jpeg";
export type OutputArtworkAssets = LocalArtworkAsset[];
export type ArtworkAvailability = "fallback" | "available" | "unavailable";
export type ArtworkSlot = "cover" | "detail";
export type BackupAction = "restore" | "delete";
export type BackupProblemKind =
  | "missing_manifest"
  | "unreadable_manifest"
  | "malformed_manifest"
  | "identity_mismatch"
  | "unsupported_entry"
  | "recovery_required";
export type BackupInventoryState = "healthy" | "degraded" | "recovery_required";
export type AdapterKind =
  | "libultraship-portable"
  | "n64-recomp-portable"
  | "staged-source-portable"
  | "referenced-disc"
  | "generated-cache"
  | "upstream-managed-setup"
  | "psx-recomp-managed";
export type Platform = "windows-x86-64" | "linux-x86-64" | "macos-x86-64" | "macos-aarch64";
export type RuntimeSourceMaterialization =
  "n64-big-endian" | "copy" | "gamecube-iso" | "psx-bin-cue" | "psx-raw-set" | "ps2-iso" | "stfs-directory";
export type SupportTier = "stable" | "beta" | "rolling";
export type CatalogAdmissionMode = "enforced" | "informational";
export type PortSourceRole = "game" | "bios";
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
export type SourceEvidenceKind = "structural_check" | "automated_lifecycle" | "hands_on" | "known_failure";
export type SourceEvidenceOutcome = "passed" | "failed" | "not_run" | "unknown";
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
export type HostToolSource = "environment" | "saved" | "discovery";
export type HostToolState = "available" | "missing" | "misconfigured" | "unsupported";
export type RepairItemKind =
  | "partial_operation"
  | "cleanup_pending"
  | "orphaned_final_directory"
  | "missing_registered_path"
  | "degraded_backup"
  | "backup_recovery_required";
export type InstallPlanAction = "already_active" | "use_staged" | "reuse_retained" | "blocked_unverified" | "download";
export type SourceRequirementRole = "game_source" | "bios";
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
export type OutputLaunchRequest = LaunchSessionRecord | null;
export type LaunchSessionOutcome = "succeeded" | "failed" | "cancelled";
export type LaunchSessionPhase = "preparing" | "spawning" | "running" | "collecting" | "recovering";
export type LibraryContentKind =
  "application_versions" | "user_data" | "source_inbox" | "backups" | "toolchains" | "local_artwork";
export type SourceDigestAlgorithm = "sha1" | "sha256" | "crc32";
export type SourceComponentKind = "file_set_member" | "optical_disc";
export type SourceValidatorResult = "not_run" | "passed" | "failed" | "missing_tool";
export type LibrarySelectionSource = "invocation" | "saved" | "platform_default";
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
      completed: number;
      phase: string;
      total: number | null;
      type: "progress";
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
export type ReconcileAction = "up_to_date" | "notify" | "staged" | "activated";
export type SourceDiscoveryLimit = "entries" | "depth" | "file_size" | "hash_bytes" | "candidates";
export type SourceImportMode = "copy" | "move" | "use_current_location";
export type SourceImportOutcome =
  "copied" | "moved" | "reused_existing" | "registered_current_location" | "copied_original_retained";
export type SourceInboxResolutionState =
  "registered" | "exact_match" | "approval_required" | "unresolved" | "conflict" | "incomplete";
export type ApplicationChannel = "preview" | "stable";
export type ApplicationUpdateMode = "automatic" | "notify-only" | "manual";
export type ApplicationUpdateRequestedAction = "safe-exit" | "restart-to-apply";
export type ApplicationUpdateObservedTermination =
  "normal-exit" | "restart-to-apply" | "crash" | "os-shutdown" | "steam-stop";
export type ApplicationUpdateRecoveryArea = "schedule" | "staging" | "apply";

export interface TransportOutputs {
  about: OutputAbout;
  activity: OutputActivity;
  activity_diagnostic: OutputActivityDiagnostic;
  adoption_preview: OutputAdoptionPreview;
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
  catalog_provenance: CatalogProvenance;
  catalog_status: OutputCatalogStatus;
  catalog_trust_key: CatalogTrustKey;
  catalog_update_plan: OutputCatalogUpdatePlan;
  catalog_update_source: CatalogUpdateSource;
  check_batch_outcome: OutputCheckBatchOutcome;
  definition_capability_report: OutputDefinitionCapabilityReport;
  definition_capability_request: OutputDefinitionCapabilityRequest;
  doctor: OutputDoctor;
  game_update_plan: OutputGameUpdatePlan;
  github_auth_status: GithubAuthStatus;
  github_device_login: OutputGithubDeviceLogin;
  github_device_login_result: OutputGithubDeviceLoginResult;
  host_tool_probe_result: OutputHostToolProbeResult;
  host_tool_status: HostToolStatus;
  install_plan: InstallPlan;
  launch_request: OutputLaunchRequest;
  library_identity: OutputLibraryIdentity;
  library_import_plan: OutputLibraryImportPlan;
  library_import_result: OutputLibraryImportResult;
  library_metadata: LibraryMetadata;
  library_metadata_file: LibraryMetadataFile;
  library_move_plan: OutputLibraryMovePlan;
  library_move_result: OutputLibraryMoveResult;
  library_selection: LibrarySelection;
  operation_event: OutputOperationEvent;
  output_destination_preview: OutputOutputDestinationPreview;
  output_relocation_plan: OutputOutputRelocationPlan;
  output_relocation_result: OutputOutputRelocationResult;
  output_relocation_status: OutputOutputRelocationStatus;
  port: PortDefinition;
  port_output_location: PortOutputLocation;
  port_paths: OutputPortPaths;
  port_removal_preview: OutputPortRemovalPreview;
  preparation_options: PreparationOptions;
  preparation_plan: OutputPreparationPlan;
  reconcile_batch_outcome: OutputReconcileBatchOutcome;
  reconcile_result: ReconcileResult;
  restore_result: OutputRestoreResult;
  signed_catalog_envelope: OutputSignedCatalogEnvelope;
  signed_catalog_payload: OutputSignedCatalogPayload;
  source: SourceRecord;
  source_assessment: SourceAssessment;
  source_batch_outcome: OutputSourceBatchOutcome;
  source_catalog: SourceCatalog;
  source_discovery_issue: SourceDiscoveryIssue;
  source_discovery_limit: SourceDiscoveryLimit;
  source_discovery_limits: SourceDiscoveryLimits;
  source_discovery_report: OutputSourceDiscoveryReport;
  source_discovery_request: OutputSourceDiscoveryRequest;
  source_import_plan: OutputSourceImportPlan;
  source_import_result: OutputSourceImportResult;
  source_inbox_paths: SourceInboxPaths;
  source_inbox_resolution: OutputSourceInboxResolution;
  source_inspection: SourceInspectionReport;
  source_intake_inspection: OutputSourceIntakeInspection;
  source_relink_plan: OutputSourceRelinkPlan;
  source_removal_preview: OutputSourceRemovalPreview;
  source_verification: SourceVerification;
  status: PortStatus;
  storage: StorageSummary;
  update_batch_outcome: OutputUpdateBatchOutcome;
  update_check: UpdateCheck;
  update_snapshot: UpdateSnapshot;
  upstream_observation_report: OutputUpstreamObservationReport;
  desktop_application_update_preferences: OutputDesktopApplicationUpdatePreferences;
  desktop_application_update_status: OutputDesktopApplicationUpdateStatus;
  desktop_backup_review: OutputDesktopBackupReview;
  desktop_bootstrap_status: OutputDesktopBootstrapStatus;
  desktop_cli_command_context: OutputDesktopCliCommandContext;
  desktop_desktop_error: FailureReport;
  desktop_launch_result: OutputDesktopLaunchResult;
  desktop_reconcile_outcome: OutputReconcileBatchOutcome;
  desktop_source_verification_outcome: OutputSourceBatchOutcome;
  desktop_update_check_outcome: OutputCheckBatchOutcome;
}
export interface OutputAbout {
  description: string;
  license: string;
  product: string;
  repository: string;
  version: string;
  [k: string]: unknown;
}
export interface OutputActivity {
  cancellation: CancellationState | null;
  failure: FailureReport | null;
  finished_at: number | null;
  id: string;
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
export interface OutputAdoptionPreview {
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
export interface OutputApiResponsePortStatus {
  command: string;
  data: PortStatus | null;
  error: FailureReport | null;
  ok: boolean;
  schema_version: number;
  [k: string]: unknown;
}
export interface PortStatus {
  active: InstallRecord | null;
  channel: ReleaseChannel;
  /**
   * Successor-definition policy decisions. Legacy catalog ports retain an empty list.
   */
  definition_operations?: DefinitionOperationAssessment[];
  last_launched_at: number | null;
  last_update_check?: UpdateSnapshot | null;
  port_id: string;
  previous: InstallRecord | null;
  readiness?: LaunchReadiness | null;
  staged: InstallRecord | null;
  successful_launches: number;
  update_policy: UpdatePolicy;
  user_data_root?: string | null;
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
export interface LaunchReadiness {
  bios?: SourceHealth | null;
  blockers: LaunchBlocker[];
  launchable: boolean;
  pending_setup: boolean;
  source?: SourceHealth | null;
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
  availability: ArtworkAvailability;
  choice: ArtworkChoice;
  reason: string | null;
  selection: LocalArtworkAsset | null;
  [k: string]: unknown;
}
export interface ArtworkChoice {
  asset_sha256: string | null;
  port_id: string;
  revision: number;
  slot: ArtworkSlot;
}
export interface OutputArtworkThumbnail {
  asset_sha256: string;
  choice_revision: number;
  png: number[];
  [k: string]: unknown;
}
export interface BackupRecord {
  created_at: number;
  file_count: number;
  id: string;
  path: string;
  port_id: string;
  sha256: string;
  size: number;
  [k: string]: unknown;
}
export interface BackupActionPreview {
  action: BackupAction;
  backup: BackupRecord;
  current_user_data_exists: boolean;
  preview_sha256: string;
  safety_backup_will_be_created: boolean;
  [k: string]: unknown;
}
export interface OutputBackupInventory {
  backups: BackupRecord[];
  port_id: string;
  problems: BackupProblem[];
  state: BackupInventoryState;
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
export interface OutputCapabilities {
  adapters: AdapterKind[];
  commands: string[];
  /**
   * Installed engine contracts; these do not grant definition admission.
   */
  engine_templates: EngineTemplateCapability[];
  failure_isolated_batches: string[];
  machine_formats: string[];
  platforms: Platform[];
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
  id: string;
  launch_arguments: string[];
  launch_environment: {
    [k: string]: string;
  };
  launch_from_install_root: boolean;
  manually_validated_platforms: Platform[];
  name: string;
  persistent_file_patterns: PersistentFilePattern[];
  persistent_paths: string[];
  platforms: Platform[];
  portable_marker: boolean;
  project_url: string;
  release: ReleaseSpec;
  runtime_mutable_paths: string[];
  runtime_source_filename: string | null;
  runtime_source_hashes: {
    [k: string]: string;
  };
  runtime_source_materialization: RuntimeSourceMaterialization | null;
  runtime_source_set: RuntimeSourceTarget[];
  runtime_subdirectory: string | null;
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
  [k: string]: unknown;
}
export interface BundledRuntime {
  archive_root: string;
  asset: ReleaseAsset;
  executable: string;
  target_directory: string;
  [k: string]: unknown;
}
export interface PersistentFilePattern {
  prefix: string;
  suffix: string;
  [k: string]: unknown;
}
export interface ReleaseSpec {
  asset_hints: {
    "linux-x86-64"?: string[];
    "macos-aarch64"?: string[];
    "macos-x86-64"?: string[];
    "windows-x86-64"?: string[];
  };
  direct: {
    "linux-x86-64"?: DirectReleaseSpec;
    "macos-aarch64"?: DirectReleaseSpec;
    "macos-x86-64"?: DirectReleaseSpec;
    "windows-x86-64"?: DirectReleaseSpec;
  };
  provider: "github" | "gitlab" | "direct-manifest";
  repository: string;
  rolling_tag: string | null;
  [k: string]: unknown;
}
export interface DirectReleaseSpec {
  published_at: string | null;
  sha256: string;
  size: number;
  url: string;
  version: string;
  [k: string]: unknown;
}
export interface RuntimeSourceTarget {
  destination: string;
  materialization: RuntimeSourceMaterialization;
  source_filenames: string[];
  [k: string]: unknown;
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
export interface SourceDiscIdentity {
  id: string;
  identities: DigestIdentity[];
  label: string;
  track_counts: number[];
  volume_ids: string[];
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
/**
 * Stable catalog identifiers, never display names or inferred hash-array pairs.
 */
export interface SourceIdentity {
  game_id: string;
  representation_id: string;
  variant_id: string;
  [k: string]: unknown;
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
  kind: "file" | "file-set" | "gamecube-disc" | "psx-disc" | "upstream-validated-disc";
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
export interface OutputCheckBatchOutcome {
  error: FailureReport | null;
  ok: boolean;
  port_id: string;
  result: UpdateCheck | null;
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
 * A reviewed game update, independent of the saved automatic-update policy.
 */
export interface OutputGameUpdatePlan {
  activate: boolean;
  plan: InstallPlan;
  plan_sha256: string;
  [k: string]: unknown;
}
export interface InstallPlan {
  action: InstallPlanAction;
  bundled_runtime: BundledRuntime | null;
  channel: ReleaseChannel;
  download_bytes: number;
  output_location: PortOutputLocation;
  platform: Platform;
  port_id: string;
  release: ResolvedRelease;
  source_requirements: InstallSourceRequirement[];
  storage: StorageSummary;
  [k: string]: unknown;
}
export interface InstallSourceRequirement {
  label: string;
  profile_id: string;
  registered: boolean;
  role: SourceRequirementRole;
  [k: string]: unknown;
}
export interface GithubAuthStatus {
  authenticated: boolean;
  device_login_available: boolean;
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
export interface LaunchSessionRecord {
  child_identity: string | null;
  child_pid: number | null;
  exit_code: number | null;
  finished_at: number | null;
  id: string;
  install_id: string;
  install_root: string;
  message: string | null;
  outcome: LaunchSessionOutcome | null;
  phase: LaunchSessionPhase;
  port_id: string;
  started_at: number;
  supervisor_identity: string | null;
  supervisor_pid: number;
  updated_at: number;
  [k: string]: unknown;
}
/**
 * Durable library identity and its current effective location.
 */
export interface OutputLibraryIdentity {
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
  original_root: string;
  port_settings: LibraryPortSettings[];
  schema_version: number;
  source_references: SourceRecord[];
  [k: string]: unknown;
}
export interface ArtworkMetadata {
  assets: LocalArtworkAsset[];
  choices: ArtworkChoice[];
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
export interface LibraryPortSettings {
  active_install_id: string | null;
  channel: ReleaseChannel;
  output_directory?: string | null;
  port_id: string;
  previous_install_id: string | null;
  update_policy: UpdatePolicy;
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
  [k: string]: unknown;
}
export interface PreparationOptions {
  /**
   * This family currently exposes the catalog's reviewed defaults only.
   */
  mode: "default";
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
  setup_tool: PreparationTool;
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
   * Open code: `artifact_bound`, `upstream_release_bound`, or `not_rebound`.
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
/**
 * Facts returned by read-only inspection. A record is present only when the
 * admission state permits existing callers to register or use the source.
 */
export interface SourceInspection {
  archive_member_name?: string | null;
  assessment: SourceAssessment;
  components: ObservedSourceComponent[];
  message: string;
  observed_digests: ObservedSourceDigest[];
  path: string;
  profile_id: string;
  record: SourceRecord | null;
  validator?: ObservedSourceValidator | null;
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
export interface SourceDiscoveryIssue {
  message: string;
  path: string | null;
  profile_id: string | null;
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
export interface OutputSourceDiscoveryReport {
  candidates: SourceRecord[];
  entries_examined: number;
  files_hashed: number;
  hash_bytes: number;
  issues: SourceDiscoveryIssue[];
  issues_omitted: number;
  limits_reached: SourceDiscoveryLimit[];
  searched_profiles: string[];
  searched_roots: string[];
  symlinks_skipped: number;
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
export interface OutputUpdateBatchOutcome {
  error: FailureReport | null;
  ok: boolean;
  port_id: string;
  result: InstallRecord | null;
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
export interface ObservedResolution {
  asset_id: number;
  release: ResolvedRelease;
  release_id: number;
  [k: string]: unknown;
}
export interface OutputDesktopApplicationUpdatePreferences {
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
export interface OutputDesktopApplicationUpdateStatus {
  apply: ApplicationUpdateApplySummary | null;
  recovery_required: ApplicationUpdateRecoveryNotice[];
  schedule: ApplicationUpdateScheduleSummary | null;
  staged: ApplicationUpdateCandidateSummary | null;
  [k: string]: unknown;
}
export interface ApplicationUpdateApplySummary {
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
export interface ApplicationUpdateCandidateSummary {
  bytes: number;
  channel: ApplicationChannel;
  version: string;
  [k: string]: unknown;
}
export interface OutputDesktopBackupReview {
  persistent_data_path: string;
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
export interface OutputDesktopCliCommandContext {
  executable: string | null;
  library_root: string;
  platform: Platform;
  [k: string]: unknown;
}
export interface OutputDesktopLaunchResult {
  processId: number | null;
  sessionId: string;
  [k: string]: unknown;
}
