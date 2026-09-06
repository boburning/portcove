export type Platform = "windows-x86-64" | "linux-x86-64" | "macos-x86-64" | "macos-aarch64";
export type ReleaseChannel = "stable" | "beta" | "rolling";
export type UpdatePolicy = "notify" | "stage" | "automatic";
export type SupportTier = ReleaseChannel;
export type UpstreamStatus = "active" | "retired" | "superseded" | "abandoned";
export type AdapterKind = "libultraship-portable" | "n64-recomp-portable" | "staged-source-portable" | "referenced-disc" | "generated-cache" | "upstream-managed-setup" | "psx-recomp-managed";
export type RuntimeSourceMaterialization = "n64-big-endian" | "copy" | "gamecube-iso" | "psx-bin-cue" | "psx-raw-set" | "ps2-iso" | "stfs-directory";
export type SourceKind = "file" | "file-set" | "gamecube-disc" | "psx-disc" | "upstream-validated-disc";
export type ReleaseSource = "github" | "gitlab" | "direct-manifest";

export interface DirectReleaseSpec {
  version: string;
  url: string;
  size: number;
  sha256: string;
  published_at?: string;
}

export interface ReleaseSpec {
  provider?: ReleaseSource;
  repository?: string;
  rolling_tag?: string;
  asset_hints?: Partial<Record<Platform, string[]>>;
  direct?: Partial<Record<Platform, DirectReleaseSpec>>;
}

export interface SourceProfile {
  id: string;
  label: string;
  kind?: SourceKind;
  accepted_extensions: string[];
  accepted_sha1?: string[];
  accepted_sha256?: string[];
  disc?: {
    track_counts: number[];
    discs?: Array<{
      label: string;
      accepted_sha1?: string[];
      accepted_sha256?: string[];
      accepted_volume_ids?: string[];
      track_counts: number[];
    }>;
  };
  members?: Array<{
    id: string;
    label: string;
    accepted_filenames: string[];
    accepted_sha1?: string[];
    accepted_sha256?: string[];
    accepted_crc32?: string[];
  }>;
}

export type CatalogEvidenceRole = "upstream_support" | "byte_identity" | "preservation_crosswalk" | "portcove_qualification";
export type SourceIdentityKind = "file" | "file-set" | "optical-disc" | "multi-disc-set" | "compound";
export type DigestScope = "original-file" | "original-container" | "normalized-content" | "canonical-n64-big-endian" | "archive-member" | "gamecube-normalized-iso" | "psx-normalized-track-set" | "file-set-member" | "disc-set-member";

export interface DigestIdentity {
  scope: DigestScope;
  sha1: string | null;
  sha256: string | null;
  crc32: string | null;
}

export interface CatalogEvidence {
  id: string;
  role: CatalogEvidenceRole;
  authority: string;
  authority_ref: string;
  reviewed_at: string;
  claim: string;
  immutable_url: string;
  live_url: string | null;
}

export type SourceRepresentationKind =
  | { kind: "raw-file" | "canonical-n64" | "gamecube-normalized-iso"; identities: DigestIdentity[] }
  | { kind: "archive-member"; member_extensions: string[]; identities: DigestIdentity[] }
  | { kind: "file-set"; members: Array<{ id: string; label: string; filenames: string[]; identities: DigestIdentity[] }> }
  | { kind: "optical-track-set"; track_counts: number[]; identities: DigestIdentity[] }
  | { kind: "multi-disc-set"; discs: Array<{ id: string; label: string; track_counts: number[]; volume_ids: string[]; identities: DigestIdentity[] }> }
  | { kind: "volume-id"; values: string[]; track_counts: number[] }
  | { kind: "pinned-validator"; validator_contract_id: string }
  | { kind: "compound"; format: "stfs-live"; identities: DigestIdentity[] }
  | { kind: "informational-extension"; evidence_gap: string };

export type SourceRepresentation = {
  id: string;
  extensions: string[];
  evidence_ids: string[];
} & SourceRepresentationKind;

export interface SourceCatalog {
  evidence: CatalogEvidence[];
  identities: Array<{
    id: string;
    label: string;
    kind: SourceIdentityKind;
    variants: Array<{
      id: string;
      title: string;
      region: string | null;
      revision: string | null;
      legacy_projection_only?: boolean;
      product_codes: string[];
      representations: SourceRepresentation[];
      evidence_ids: string[];
    }>;
    aliases: string[];
    tombstones: string[];
    evidence_gap: string | null;
  }>;
  contracts: Array<{
    id: string;
    port_id: string;
    role: "game" | "bios";
    profile_id: string;
    admission_mode: "enforced" | "informational";
    supported_variant_ids: string[];
    validator_contract_id: string | null;
    evidence_ids: string[];
    authority_ref: string;
    reviewed_at: string;
    immutable_review_url: string;
    live_review_url: string | null;
    evidence_gap: string | null;
    applicability: Array<{ upstream_ref: string; artifact_sha256: string | null }>;
    aliases: string[];
    tombstones: string[];
  }>;
  validators: Array<{
    id: string;
    tool_id: string;
    protocol_version: string;
    evidence_ids: string[];
  }>;
}

export interface PortDefinition {
  id: string;
  name: string;
  summary: string;
  project_url: string;
  support_tier: SupportTier;
  channels: ReleaseChannel[];
  platforms: Platform[];
  automated_tested_platforms: Platform[];
  manually_validated_platforms: Platform[];
  adapter: AdapterKind;
  source_profile?: string;
  bios_source_profile?: string;
  persistent_paths: string[];
  persistent_file_patterns?: { prefix: string; suffix: string }[];
  runtime_mutable_paths?: string[];
  portable_marker?: boolean;
  source_environment?: string;
  user_data_environment?: string;
  launch_environment?: Record<string, string>;
  launch_arguments?: string[];
  runtime_subdirectory?: string;
  runtime_source_filename?: string;
  runtime_source_materialization?: RuntimeSourceMaterialization;
  runtime_source_hashes?: Record<string, string>;
  runtime_source_set?: Array<{
    source_filenames: string[];
    destination: string;
    materialization: RuntimeSourceMaterialization;
  }>;
  launch_from_install_root?: boolean;
  setup_executable_hints?: Partial<Record<Platform, string[]>>;
  setup_arguments?: string[];
  setup_marker?: string;
  upstream_status: UpstreamStatus;
  release: ReleaseSpec;
  bundled_runtime?: Partial<Record<Platform, BundledRuntime>>;
  executable_hints: Partial<Record<Platform, string[]>>;
}

export interface CatalogDocument {
  schema_version: number;
  source_catalog?: SourceCatalog;
  source_profiles: SourceProfile[];
  ports: PortDefinition[];
}

export interface ArtifactIdentity {
  asset_name: string;
  sha256: string;
  size: number;
}

export interface BundledRuntime {
  asset: ResolvedRelease["asset"];
  archive_root: string;
  target_directory: string;
  executable: string;
}

export interface RuntimeIdentity {
  origin: "verified_download" | "adopted_tree";
  artifact: ArtifactIdentity;
  archive_root: string;
  target_directory: string;
  executable: string;
}

export interface InstallRecord {
  id: string;
  port_id: string;
  version: string;
  path: string;
  channel: ReleaseChannel;
  installed_at: number;
  verified: boolean;
  staged: boolean;
  artifact: ArtifactIdentity;
  runtime?: RuntimeIdentity;
  manifest_sha256: string;
  selected_executable: string;
}

export type SourceHealth = "unregistered" | "current" | "missing" | "unreadable" | "changed" | "not_checked" | "not_baselined";
export type ReadinessBlocker = "missing_source" | "unreadable_source" | "changed_source" | "missing_bios" | "unreadable_bios" | "changed_bios" | "missing_runtime";

export interface PortStatus {
  port_id: string;
  user_data_root?: string;
  channel: ReleaseChannel;
  update_policy: UpdatePolicy;
  active?: InstallRecord;
  previous?: InstallRecord;
  staged?: InstallRecord;
  last_launched_at?: number;
  successful_launches?: number;
  readiness?: {
    launchable: boolean;
    blockers: ReadinessBlocker[];
    pending_setup: boolean;
    source?: SourceHealth;
    bios?: SourceHealth;
  };
  last_update_check?: UpdateSnapshot;
}

export type ActivityOperation = "update_catalog" | "discover_sources" | "import_library" | "import_source" | "move_library" | "relocate_output" | "launch" | "check_update" | "backup" | "restore" | "delete_backup" | "install" | "update" | "reconcile" | "verify_install" | "activate" | "rollback" | "adopt" | "remove" | "remove_source" | "register_source" | "verify_source";
export type ActivityStatus = "running" | "succeeded" | "failed" | "cancelled";
export type CancellationPhase = "preparing" | "finishing";
export interface CancellationState {
  phase: CancellationPhase;
  requested: boolean;
}
export type ActivityTargetKind = "port" | "source" | "library";

export interface ActivityRecord {
  id: string;
  operation: ActivityOperation;
  target_kind: ActivityTargetKind;
  target_id?: string;
  status: ActivityStatus;
  message?: string;
  started_at: number;
  finished_at?: number;
  cancellation?: CancellationState;
}

export interface StorageSummary {
  library_root: string;
  volume_total_bytes: number;
  volume_available_bytes: number;
}

export type HostToolState = "available" | "missing" | "misconfigured" | "unsupported";
export type HostToolSource = "environment" | "saved" | "discovery";

export interface HostToolStatus {
  id: string;
  display_name: string;
  state: HostToolState;
  path?: string;
  source?: HostToolSource;
  configuration_variable: string;
  purpose: string;
  official_url: string;
}

export type HostToolProbeState = "missing" | "invalid" | "blocked" | "timed_out" | "excessive_output" | "failed_probe" | "incompatible_version" | "cancelled" | "success";

export interface HostToolProbeResult {
  tool_id: string;
  path: string;
  state: HostToolProbeState;
  message: string;
  sha256?: string;
  persisted: boolean;
  retry_action: string;
  clear_action_available: boolean;
}

export interface DoctorReport {
  platform: Platform;
  library: StorageSummary;
  catalog_port_count: number;
  catalog_provenance: CatalogProvenance;
  installed_port_count: number;
  registered_source_count: number;
  host_tools: HostToolStatus[];
  repair: RepairPlan;
}

export interface RepairPlan {
  generated_at: number;
  items: Array<{
    kind: "partial_operation" | "cleanup_pending" | "orphaned_final_directory" | "missing_registered_path" | "degraded_backup" | "backup_recovery_required";
    operation_id?: string;
    port_id?: string;
    path?: string;
    message: string;
    proposed_action: string;
  }>;
}

export interface BackupRecord {
  id: string;
  port_id: string;
  path: string;
  created_at: number;
  file_count: number;
  size: number;
  sha256: string;
}

export interface BackupProblem {
  kind: "missing_manifest" | "unreadable_manifest" | "malformed_manifest" | "identity_mismatch" | "unsupported_entry" | "recovery_required";
  backup_id?: string;
  operation_id?: string;
  path: string;
  message: string;
  proposed_action: string;
}

export interface BackupInventory {
  port_id: string;
  state: "healthy" | "degraded" | "recovery_required";
  backups: BackupRecord[];
  problems: BackupProblem[];
}

export interface RestoreResult {
  restored_backup: BackupRecord;
  safety_backup?: BackupRecord;
}

export interface AdoptionCopyFile {
  relative_path: string;
  size: number;
  sha256: string;
}

export interface AdoptionSkippedEntry {
  relative_path: string;
  reason: string;
}

export interface AdoptionCopyPlan {
  directories: string[];
  files: AdoptionCopyFile[];
  skipped_entries: AdoptionSkippedEntry[];
  total_bytes: number;
}

export interface AdoptionPreview {
  source: string;
  detected_port_ids: string[];
  selected_port_id?: string;
  application_files_will_be_copied: boolean;
  original_will_be_modified: boolean;
  copy_plan: AdoptionCopyPlan;
  plan_sha256: string;
}

export interface SourceRecord {
  profile_id: string;
  path: string;
  sha256: string;
  size: number;
  storage_sha256: string;
  storage_size: number;
  updated_at: number;
  observed_identity?: ObservedSourceIdentity;
}

export interface ObservedSourceDigest {
  algorithm: "sha1" | "sha256" | "crc32";
  scope: DigestScope;
  value: string;
  size: number;
}

export interface ObservedSourceComponent {
  id: string;
  kind: "file_set_member" | "optical_disc";
  name: string | null;
  digests: ObservedSourceDigest[];
  size: number;
  track_count: number | null;
  volume_id: string | null;
}

export interface ObservedSourceValidator {
  contract_id: string;
  tool_id: string;
  protocol_version: string;
  result: "not_run" | "passed" | "failed" | "missing_tool";
}

export interface ObservedSourceIdentity {
  schema_version: number;
  archive_member_name?: string;
  digests: ObservedSourceDigest[];
  components?: ObservedSourceComponent[];
  validator?: ObservedSourceValidator;
}

export interface SourceRemovalPreview {
  source: SourceRecord;
  preview_sha256: string;
  dependent_port_ids: string[];
  installed_dependent_port_ids: string[];
}

export interface SourceRelinkPlan {
  original: SourceRecord;
  replacement: SourceRecord;
  preview_sha256: string;
}

export interface SourceVerification {
  profile_id: string;
  path: string;
  sha256: string;
  size: number;
  storage_sha256: string;
  storage_size: number;
  registered_at: number;
  verified_at: number;
  inspection: SourceInspectionReport;
}

export interface SourceIdentity {
  game_id: string;
  variant_id: string;
  representation_id: string;
}

export type SourceClassification =
  | { state: "not_evaluated" }
  | { state: "unrecognized" }
  | { state: "recognized"; identity: SourceIdentity }
  | { state: "ambiguous"; candidates: SourceIdentity[] };

export type SourceContractResult =
  | { state: "not_evaluated" }
  | { state: "unreviewed_for_release" }
  | { state: "supported"; contract_id: string }
  | { state: "recognized_not_listed"; contract_id: string }
  | { state: "known_incompatible"; contract_id: string }
  | { state: "informational"; contract_id: string };

export type SourceAdmission =
  | { state: "not_evaluated" }
  | { state: "admitted"; mode: "exact_identity" | "structural_checks" | "informational_consent" | "upstream_validator" }
  | { state: "rejected"; reason: "missing" | "unreadable" | "changed" | "known_mismatch" | "ambiguous_identity" | "missing_tool" | "check_failed" | "consent_required" };

export interface SourceEvidenceRecord {
  scope: {
    port_id: string;
    platform: Platform;
    artifact_sha256: string | null;
    upstream_ref: string | null;
    contract_id: string | null;
    variant: { state: "unspecified" } | { state: "exact"; identity: SourceIdentity };
    check_version: string | null;
  };
  kind: "structural_check" | "automated_lifecycle" | "hands_on" | "known_failure";
  outcome: "passed" | "failed" | "not_run" | "unknown";
  observed_at: number;
  portcove_version: string | null;
  portcove_commit: string | null;
  method: string;
  evidence_ids: string[];
}

export interface SourceInspection {
  profile_id: string;
  path: string;
  observed_digests: ObservedSourceDigest[];
  archive_member_name?: string;
  components: ObservedSourceComponent[];
  validator?: ObservedSourceValidator;
  assessment: {
    health: SourceHealth;
    classification: SourceClassification;
    contract: SourceContractResult;
    admission: SourceAdmission;
    evidence: SourceEvidenceRecord[];
  };
  record?: SourceRecord;
  message: string;
}

export interface SourceInspectionReport {
  schema_version: number;
  profile_id: string;
  health: SourceHealth;
  /** Open stable code: preserve unfamiliar future values. */
  state_code: string;
  summary: string;
  next_action: string;
  registered?: SourceRecord;
  inspection?: SourceInspection;
  problem?: { code: string; message: string };
  expected_identity?: SourceCatalog["identities"][number];
  applications: Array<{
    port_id: string;
    port_name: string;
    role: "game" | "bios";
    contract: SourceCatalog["contracts"][number];
    contract_result: SourceContractResult;
    release_applicability: {
      /** Open stable code for artifact, upstream-release, or missing rebinding. */
      state_code: string;
      reviewed_bindings: Array<{ upstream_ref: string; artifact_sha256: string | null }>;
    };
    qualification: {
      legacy_automated_platforms: Platform[];
      legacy_hands_on_platforms: Platform[];
      exact_records: SourceEvidenceRecord[];
    };
  }>;
  evidence: Array<Omit<CatalogEvidence, "live_url"> & { live_url?: string }>;
  legacy: {
    registration_identity_not_recorded: boolean;
    variant_unspecified_records: SourceEvidenceRecord[];
  };
}

export interface SourceIntakeInspection {
  schema_version: number;
  profile_id: string;
  input_count: number;
  /** Open stable code. Successful single-path checks reuse the source report code. */
  state_code: string;
  summary: string;
  next_action: string;
  report?: SourceInspectionReport;
  problem?: { code: string; message: string };
}

export interface SourceVerificationOutcome {
  profile_id: string;
  ok: boolean;
  result?: SourceVerification;
  error?: DesktopError;
}

export interface UpdateCheck {
  port_id: string;
  channel: ReleaseChannel;
  installed_version?: string;
  installed_artifact?: ArtifactIdentity;
  installed_runtime?: RuntimeIdentity;
  required_runtime?: RuntimeIdentity;
  update_available: boolean;
  release: ResolvedRelease;
}

export interface ResolvedRelease {
  version: string;
  channel: ReleaseChannel;
  published_at?: string;
  asset: { name: string; url: string; size: number; sha256: string };
}

export type InstallPlanAction = "already_active" | "use_staged" | "reuse_retained" | "blocked_unverified" | "download";
export type OutputLocationSource = "request_override" | "port_setting" | "library_default";
export type OutputDestinationAvailability = "available" | "full" | "unavailable";
export type OutputDestinationOwnership = "library_default" | "unclaimed" | "owned_by_port" | "owned_by_another_port" | "unrelated_content" | "invalid" | "unknown";

export interface PortOutputLocation {
  port_id: string;
  library_root: string;
  default_output_directory: string;
  configured_output_directory?: string;
  effective_output_directory: string;
  selection_source: OutputLocationSource;
  user_data_root: string;
}

export interface OutputAffectedInstall {
  install_id: string;
  version: string;
  path: string;
  active: boolean;
  previous: boolean;
  staged: boolean;
}

export interface OutputDestinationPreview {
  port_id: string;
  current: PortOutputLocation;
  proposed: PortOutputLocation;
  reset_to_default: boolean;
  availability: OutputDestinationAvailability;
  ownership: OutputDestinationOwnership;
  available_bytes: number | null;
  total_bytes: number | null;
  volume_identity: string | null;
  validation_errors: string[];
  affected_installs: OutputAffectedInstall[];
  moves_existing_install: boolean;
  preview_sha256: string;
}

export interface OutputRelocationInstall {
  install: InstallRecord;
  destination_path: string;
  active: boolean;
  previous: boolean;
  staged: boolean;
  retained: boolean;
  copy: AdoptionCopyPlan;
}

export interface OutputRelocationPlan {
  port_id: string;
  current: PortOutputLocation;
  channel: ReleaseChannel;
  destination_root: string;
  installs: OutputRelocationInstall[];
  required_bytes: number;
  available_bytes: number | null;
  total_bytes: number | null;
  volume_identity: string | null;
  availability: OutputDestinationAvailability;
  ownership: OutputDestinationOwnership;
  validation_errors: string[];
  sources_will_move: boolean;
  user_data_will_move: boolean;
  backups_will_move: boolean;
  plan_sha256: string;
}

export interface OutputRelocationResult {
  operation_id: string;
  port_id: string;
  output_location: PortOutputLocation;
  relocated_installs: InstallRecord[];
  old_paths_retained: string[];
  cleanup_pending: boolean;
}

export interface OutputRelocationStatus {
  operation_id: string;
  port_id: string;
  phase: string;
  destination_root: string;
  cleanup_pending_paths: string[];
  last_error?: string;
}

export interface InstallPlan {
  port_id: string;
  channel: ReleaseChannel;
  platform: Platform;
  release: ResolvedRelease;
  action: InstallPlanAction;
  bundled_runtime?: BundledRuntime;
  download_bytes: number;
  source_requirements: Array<{
    profile_id: string;
    label: string;
    role: "game_source" | "bios";
    registered: boolean;
  }>;
  storage: StorageSummary;
  output_location: PortOutputLocation;
}

export interface UpdateSnapshot {
  checked_at: number;
  check: UpdateCheck;
}

export type ReconcileAction = "up_to_date" | "notify" | "staged" | "activated";

export interface ReconcileResult {
  port_id: string;
  policy: UpdatePolicy;
  action: ReconcileAction;
  check: UpdateCheck;
  install?: InstallRecord;
}

export interface BatchOutcome<T> {
  port_id: string;
  ok: boolean;
  result?: T;
  error?: DesktopError;
}

export type UpdateCheckOutcome = BatchOutcome<UpdateCheck>;
export type ReconcileOutcome = BatchOutcome<ReconcileResult>;

export interface OperationEvent {
  schema_version: 2;
  operation_id: string;
  parent_operation_id?: string;
  sequence: number;
  timestamp_ms: number;
  operation: string;
  target?: { kind: ActivityTargetKind; id: string };
  type: OperationEventType;
  phase?: string;
  completed?: number;
  total?: number;
  level?: string;
  message?: string;
  result?: OperationResult;
}

export type OperationEventType = "started" | "progress" | "message" | "finished";
export type OperationResult = "succeeded" | "failed" | "cancelled";

export interface DesktopError {
  code: ErrorCode;
  message: string;
  details: Record<string, string>;
}

export type ErrorCode = "usage" | "unsupported" | "not_found" | "source_invalid" | "network" | "verification" | "install" | "state" | "launch" | "conflict" | "cancelled";

export interface BootstrapStatus {
  ready: boolean;
  library_root?: string;
  selection?: LibrarySelection;
  generation: number;
  error?: DesktopError;
}

export type LibrarySelectionSource = "invocation" | "saved" | "platform_default";

export interface LibrarySelection {
  root: string;
  source: LibrarySelectionSource;
}

export interface LibraryMetadataFile {
  path: string;
  sha256: string;
  size: number;
}

export type LibraryContentKind = "application_versions" | "user_data" | "backups" | "toolchains";

export interface LibraryMetadata {
  schema_version: number;
  exported_at: number;
  original_root: string;
  content_roots: { kind: LibraryContentKind; relative_path: string }[];
  source_references: SourceRecord[];
  application_versions: InstallRecord[];
  port_settings: { port_id: string; channel: ReleaseChannel; update_policy: UpdatePolicy; active_install_id?: string | null; previous_install_id?: string | null }[];
  launch_history: { port_id: string; last_launched_at: number; successful_launches: number }[];
}

export interface LibraryMovePlan {
  source_root: string;
  destination_root: string;
  metadata: LibraryMetadata;
  content: { kind: LibraryContentKind; relative_path: string; copy: AdoptionCopyPlan }[];
  required_bytes: number;
  available_bytes: number;
  source_will_be_retained: boolean;
  plan_sha256: string;
}

export interface LibraryMoveResult {
  transfer_id: string;
  source_root: string;
  destination_root: string;
  active_root: string;
  source_retained: boolean;
  completed: boolean;
}

export interface LibraryImportPlan {
  metadata_file: LibraryMetadataFile;
  content_root: string;
  destination_root: string;
  destination_exists: boolean;
  metadata: LibraryMetadata;
  content: { kind: LibraryContentKind; relative_path: string; copy: AdoptionCopyPlan }[];
  required_bytes: number;
  available_bytes: number;
  plan_sha256: string;
}

export interface LibraryImportResult {
  transfer_id: string;
  destination_root: string;
  completed: boolean;
  input_retained: boolean;
}

export interface SourceDiscoveryLimits {
  max_entries: number;
  max_depth: number;
  max_file_bytes: number;
  max_hash_bytes: number;
  max_candidates: number;
}

export interface SourceDiscoveryRequest {
  roots: string[];
  profile_ids: string[];
  limits?: SourceDiscoveryLimits;
}

export interface SourceDiscoveryIssue {
  path?: string | null;
  profile_id?: string | null;
  message: string;
}

export type SourceDiscoveryLimit = "entries" | "depth" | "file_size" | "hash_bytes" | "candidates";

export interface SourceDiscoveryReport {
  searched_roots: string[];
  searched_profiles: string[];
  candidates: SourceRecord[];
  entries_examined: number;
  files_hashed: number;
  hash_bytes: number;
  symlinks_skipped: number;
  limits_reached: SourceDiscoveryLimit[];
  issues: SourceDiscoveryIssue[];
  issues_omitted: number;
}

export interface SourceInboxPaths {
  root: string;
  profile_id?: string;
  profile?: string;
}

export type SourceInboxResolutionState = "registered" | "exact_match" | "approval_required" | "unresolved" | "conflict" | "incomplete";

export interface SourceInboxCandidate {
  inspection: SourceInspection;
  automatically_reusable: boolean;
}

export interface SourceInboxScanStats {
  entries_examined: number;
  candidates_inspected: number;
  hash_bytes: number;
  symlinks_skipped: number;
  limits_reached: SourceDiscoveryLimit[];
  issues: SourceDiscoveryIssue[];
  issues_omitted: number;
}

export interface SourceInboxResolution {
  operation_id: string;
  profile_id: string;
  paths: SourceInboxPaths;
  state: SourceInboxResolutionState;
  selected?: SourceRecord;
  candidates: SourceInboxCandidate[];
  stats: SourceInboxScanStats;
}

export type SourceImportMode = "copy" | "move" | "use_current_location";
export type SourceImportOutcome = "copied" | "moved" | "reused_existing" | "registered_current_location" | "copied_original_retained";
export type SourceAdmissionMode = "exact_identity" | "structural_checks" | "informational_consent" | "upstream_validator";

export interface SourceImportPlan {
  schema_version: number;
  profile_id: string;
  mode: SourceImportMode;
  source: SourceRecord;
  admission_mode: SourceAdmissionMode;
  destination: string;
  destination_exists: boolean;
  reuse_existing: boolean;
  required_bytes: number;
  existing_registration?: SourceRecord;
  source_guard_sha256: string;
  plan_sha256: string;
}

export interface SourceImportResult {
  import_id: string;
  profile_id: string;
  mode: SourceImportMode;
  outcome: SourceImportOutcome;
  registered: SourceRecord;
  copied: boolean;
  original_deleted: boolean;
  original_retained: boolean;
  retained_original_path?: string;
  recovered: boolean;
}

export type GithubAuthSource = "anonymous" | "environment" | "credential_store";

export interface GithubAuthStatus {
  source: GithubAuthSource;
  authenticated: boolean;
  login?: string;
  rate_limit?: { limit: number; remaining: number; resets_at: number };
  device_login_available: boolean;
}

export interface GithubDeviceLogin {
  session_id: string;
  user_code: string;
  verification_uri: string;
  expires_at: number;
  interval_seconds: number;
}

export interface GithubDeviceLoginResult {
  state: "pending" | "complete";
  status?: GithubAuthStatus;
}

export type CatalogOrigin = "embedded" | "signed_active" | "signed_previous";
export type CatalogUpdateSource = { kind: "file" | "https"; value: string };

export interface CatalogTrustKey {
  key_id: string;
  public_key: string;
}

export interface CatalogProvenance {
  origin: CatalogOrigin;
  catalog_sha256: string;
  sequence: number | null;
  key_id: string | null;
  expires_at: number | null;
  fallback_reasons: string[];
}

export interface CatalogStatus {
  provenance: CatalogProvenance;
  trusted_keys: CatalogTrustKey[];
  highest_sequence: number;
  updates_enabled: boolean;
  can_rollback: boolean;
  can_use_cached: boolean;
  state_sha256: string;
}

export interface CatalogUpdatePlan {
  source: CatalogUpdateSource;
  envelope_sha256: string;
  key_id: string;
  sequence: number;
  issued_at: number;
  expires_at: number;
  changed_port_ids: string[];
  current: CatalogProvenance;
  plan_sha256: string;
}
