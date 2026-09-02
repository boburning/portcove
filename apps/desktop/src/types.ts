export type Platform = "windows-x86-64" | "linux-x86-64" | "macos-x86-64" | "macos-aarch64";
export type ReleaseChannel = "stable" | "beta" | "rolling";
export type UpdatePolicy = "notify" | "stage" | "automatic";
export type SupportTier = ReleaseChannel;
export type UpstreamStatus = "active" | "retired" | "superseded" | "abandoned";

export interface SourceProfile {
  id: string;
  label: string;
  kind?: "file" | "file-set" | "gamecube-disc" | "psx-disc" | "upstream-validated-disc";
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
  adapter: string;
  source_profile?: string;
  bios_source_profile?: string;
  persistent_paths: string[];
  portable_marker?: boolean;
  source_environment?: string;
  launch_arguments?: string[];
  runtime_subdirectory?: string;
  runtime_source_filename?: string;
  runtime_source_materialization?: "n64-big-endian" | "copy" | "gamecube-iso" | "psx-bin-cue" | "psx-raw-set" | "ps2-iso";
  runtime_source_set?: Array<{
    source_filenames: string[];
    destination: string;
    materialization: "n64-big-endian" | "copy" | "gamecube-iso" | "psx-bin-cue" | "psx-raw-set" | "ps2-iso";
  }>;
  launch_from_install_root?: boolean;
  setup_executable_hints?: Partial<Record<Platform, string[]>>;
  setup_arguments?: string[];
  setup_marker?: string;
  upstream_status: UpstreamStatus;
}

export interface CatalogDocument {
  schema_version: number;
  source_profiles: SourceProfile[];
  ports: PortDefinition[];
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
}

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
    blockers: Array<"missing_source" | "missing_bios">;
    pending_setup: boolean;
  };
  last_update_check?: UpdateSnapshot;
}

export type ActivityOperation = "check_update" | "backup" | "restore" | "delete_backup" | "install" | "update" | "reconcile" | "verify_install" | "activate" | "rollback" | "adopt" | "remove" | "register_source" | "verify_source";
export type ActivityStatus = "running" | "succeeded" | "failed";

export interface ActivityRecord {
  id: string;
  operation: ActivityOperation;
  target_kind: "port" | "source" | "library";
  target_id?: string;
  status: ActivityStatus;
  message?: string;
  started_at: number;
  finished_at?: number;
}

export interface StorageSummary {
  library_root: string;
  volume_total_bytes: number;
  volume_available_bytes: number;
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

export interface RestoreResult {
  restored_backup: BackupRecord;
  safety_backup?: BackupRecord;
}

export interface SourceRecord {
  profile_id: string;
  path: string;
  sha256: string;
  size: number;
  storage_sha256: string;
  storage_size: number;
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

export interface InstallPlan {
  port_id: string;
  channel: ReleaseChannel;
  platform: Platform;
  release: ResolvedRelease;
  action: InstallPlanAction;
  source_requirements: Array<{
    profile_id: string;
    label: string;
    role: "game_source" | "bios";
    registered: boolean;
  }>;
  storage: StorageSummary;
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
  type: "started" | "progress" | "message" | "finished";
  operation?: string;
  port_id?: string;
  phase?: string;
  completed?: number;
  total?: number;
  level?: string;
  message?: string;
  success?: boolean;
}

export interface DesktopError {
  code: string;
  message: string;
  details: Record<string, string>;
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
