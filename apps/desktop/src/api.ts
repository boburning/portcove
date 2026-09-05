import type { CatalogStatus, CatalogUpdatePlan, CatalogUpdateSource } from "./types";
import { Channel, invoke } from "@tauri-apps/api/core";
import type { CancellationState, OperationEvent } from "./types";
import type { LibraryImportPlan, LibraryImportResult, LibraryMovePlan, LibraryMoveResult } from "./types";
import type { SourceDiscoveryRequest, SourceDiscoveryReport } from "./types";
import type { ActivityRecord, AdoptionPreview, BackupInventory, BackupRecord, BootstrapStatus, CatalogDocument, DoctorReport, GithubAuthStatus, GithubDeviceLogin, GithubDeviceLoginResult, InstallPlan, InstallRecord, LibraryMetadataFile, PortStatus, ReconcileOutcome, ReleaseChannel, RestoreResult, SourceRecord, SourceRelinkPlan, SourceRemovalPreview, SourceVerificationOutcome, UpdateCheck, UpdateCheckOutcome, UpdatePolicy } from "./types";

export const desktopApi = {
  catalogStatus: () => invoke<CatalogStatus>("get_catalog_status"),
  trustCatalogKey: (publicKey: string) => invoke<CatalogStatus | null>("trust_catalog_key", { publicKey }),
  revokeCatalogKey: (keyId: string, expectedState: string) => invoke<CatalogStatus>("revoke_catalog_key", { keyId, expectedState }),
  planCatalogUpdate: (source: CatalogUpdateSource) => invoke<CatalogUpdatePlan>("plan_catalog_update", { source }),
  applyCatalogUpdate: (source: CatalogUpdateSource, expectedPlan: string, onEvent: (event: OperationEvent) => void) => {
    const channel = new Channel<OperationEvent>();
    channel.onmessage = onEvent;
    return invoke<CatalogStatus>("apply_catalog_update", { source, expectedPlan, onEvent: channel });
  },
  rollbackCatalog: (expectedState: string) => invoke<CatalogStatus>("rollback_catalog", { expectedState }),
  useCachedCatalog: (expectedState: string) => invoke<CatalogStatus>("use_cached_catalog", { expectedState }),
  useEmbeddedCatalog: (expectedState: string) => invoke<CatalogStatus>("use_embedded_catalog", { expectedState }),

  bootstrapStatus: () => invoke<BootstrapStatus>("get_bootstrap_status"),
  githubAuthStatus: () => invoke<GithubAuthStatus>("get_github_auth_status"),
  setGithubToken: (token: string) => invoke<GithubAuthStatus>("set_github_token", { token }),
  logoutGithub: () => invoke<GithubAuthStatus>("logout_github"),
  beginGithubDeviceLogin: () => invoke<GithubDeviceLogin>("begin_github_device_login"),
  pollGithubDeviceLogin: (sessionId: string) => invoke<GithubDeviceLoginResult>("poll_github_device_login", { sessionId }),
  catalog: () => invoke<CatalogDocument>("get_catalog"),
  statuses: () => invoke<PortStatus[]>("get_statuses"),
  sources: () => invoke<SourceRecord[]>("get_sources"),
  activities: () => invoke<ActivityRecord[]>("get_activities"),
  cancelOperation: (operationId: string) => invoke<CancellationState>("cancel_operation", { operationId }),
  backups: (portId: string) => invoke<BackupInventory>("get_backups", { portId }),
  backup: (portId: string) => invoke<BackupRecord>("create_backup", { portId }),
  restoreBackup: (portId: string, backupId: string) => invoke<RestoreResult | null>("restore_backup", { portId, backupId }),
  deleteBackup: (portId: string, backupId: string) => invoke<BackupRecord | null>("delete_backup", { portId, backupId }),
  addSource: (profileId: string, path: string, expectedSha256?: string) => invoke<SourceRecord>("add_source", { profileId, path, expectedSha256 }),
  discoverSources: (request: SourceDiscoveryRequest, onEvent?: (event: OperationEvent) => void) => {
    const channel = new Channel<OperationEvent>();
    channel.onmessage = event => onEvent?.(event);
    return invoke<SourceDiscoveryReport>("discover_sources", { request, onEvent: channel });
  },
  planSourceRelink: (profileId: string, path: string) => invoke<SourceRelinkPlan>("plan_source_relink", { profileId, path }),
  relinkSource: (profileId: string, path: string, previewSha256: string) => invoke<SourceRecord>("relink_source", { profileId, path, previewSha256 }),
  previewSourceRemoval: (profileId: string) => invoke<SourceRemovalPreview>("preview_source_removal", { profileId }),
  removeSource: (profileId: string, previewSha256: string) => invoke<SourceRemovalPreview | null>("remove_source", { profileId, previewSha256 }),
  verifySources: () => invoke<SourceVerificationOutcome[]>("verify_sources"),
  check: (portId: string) => invoke<UpdateCheck>("check_port", { portId }),
  checkInstalled: () => invoke<UpdateCheckOutcome[]>("check_installed"),
  reconcileInstalled: () => invoke<ReconcileOutcome[]>("reconcile_installed"),
  doctor: () => invoke<DoctorReport>("get_doctor_report"),
  createSupportBundle: () => invoke<string>("create_support_bundle"),
  exportLibraryMetadata: (path: string) => invoke<LibraryMetadataFile>("export_library_metadata", { path }),
  planLibraryMove: (destination: string) => invoke<LibraryMovePlan>("plan_library_move", { destination }),
  moveLibrary: (destination: string, expectedPlan: string) => invoke<LibraryMoveResult>("move_library", { destination, expectedPlan }),
  recoverLibraryMove: (source: string, abort: boolean) => invoke<LibraryMoveResult>("recover_library_move", { source, abort }),
  planLibraryImport: (metadata: string, contentRoot: string) => invoke<LibraryImportPlan>("plan_library_import", { metadata, contentRoot }),
  importLibrary: (metadata: string, contentRoot: string, expectedPlan: string) => invoke<LibraryImportResult>("import_library", { metadata, contentRoot, expectedPlan }),
  recoverLibraryImport: (destination: string) => invoke<LibraryImportResult>("recover_library_import", { destination, abort: false }),
  reportFrontendError: (message: string, componentStack: string) => invoke<void>("report_frontend_error", { message, componentStack }),
  plan: (portId: string, channel: ReleaseChannel) => invoke<InstallPlan>("plan_port", { portId, channel }),
  openUserData: (portId: string) => invoke<string>("open_user_data", { portId }),
  openExternalUrl: (url: string) => invoke<void>("open_external_url", { url }),
  setChannel: (portId: string, channel: ReleaseChannel) => invoke<PortStatus>("set_channel", { portId, channel }),
  setPolicy: (portId: string, policy: UpdatePolicy) => invoke<PortStatus>("set_policy", { portId, policy }),
  install: (portId: string, channel: ReleaseChannel, source: string, bios: string, stage: boolean) =>
    invoke<InstallRecord>("install_port", { input: { portId, channel, source: source || null, bios: bios || null, stage } }),
  update: (portId: string, source: string, bios: string, stage: boolean) =>
    invoke<InstallRecord>("update_port", { portId, source: source || null, bios: bios || null, stage }),
  verify: (portId: string) => invoke("verify_port", { portId }),
  activate: (portId: string) => invoke("activate_port", { portId }),
  rollback: (portId: string) => invoke("rollback_port", { portId }),
  remove: (portId: string) => invoke<string[] | null>("remove_port", { portId }),
  launch: (portId: string, source: string) => invoke("launch_port", { portId, source: source || null, arguments: [] }),
  previewAdoption: (path: string, portId?: string) => invoke<AdoptionPreview>("preview_adoption", { path, portId: portId ?? null }),
  adopt: (path: string, planSha256: string, portId?: string) => invoke<InstallRecord | null>("adopt_port", { path, portId: portId ?? null, planSha256 }),
};
