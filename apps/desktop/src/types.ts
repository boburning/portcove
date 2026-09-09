import type * as Requests from "./transport-input-types.generated";
import type { ErrorCode, SourceVerification, PortStatus, UpdateCheck, ReconcileResult } from "./transport-types.generated";
import type * as Generated from "./transport-types.generated";

export type { ReleaseChannel } from "./transport-types.generated";

export type { UpdatePolicy } from "./transport-types.generated";

export type { SourceProfile } from "./transport-types.generated";

export type { DigestIdentity } from "./transport-types.generated";

export type { SourceRepresentation } from "./transport-types.generated";

export type { PortDefinition } from "./transport-types.generated";

export type CatalogDocument = Generated.TransportOutputs["catalog"];

export type { InstallRecord } from "./transport-types.generated";

export type { SourceHealth } from "./transport-types.generated";

export type ReadinessBlocker = NonNullable<PortStatus["readiness"]>["blockers"][number];

export type { PortStatus } from "./transport-types.generated";

export type { ActivityOperation } from "./transport-types.generated";

export type { CancellationState } from "./transport-types.generated";

export type ActivityRecord = Generated.TransportOutputs["activity"];

export type { StorageSummary } from "./transport-types.generated";

export type { HostToolStatus } from "./transport-types.generated";

export type HostToolProbeResult = Generated.TransportOutputs["host_tool_probe_result"];

export type DoctorReport = Generated.TransportOutputs["doctor"];

export type BackupRecord = Generated.TransportOutputs["backup"];

export type { BackupProblem } from "./transport-types.generated";

export type BackupInventory = Generated.TransportOutputs["backup_inventory"];

export type RestoreResult = Generated.TransportOutputs["restore_result"];

export type AdoptionPreview = Generated.TransportOutputs["adoption_preview"];

export type { SourceRecord } from "./transport-types.generated";

export type { ObservedSourceDigest } from "./transport-types.generated";

export type { ObservedSourceComponent } from "./transport-types.generated";

export type SourceRemovalPreview = Generated.TransportOutputs["source_removal_preview"];

export type SourceRelinkPlan = Generated.TransportOutputs["source_relink_plan"];

export type { SourceVerification } from "./transport-types.generated";

export type { SourceInspectionReport } from "./transport-types.generated";

export type SourceIntakeInspection = Generated.TransportOutputs["source_intake_inspection"];

// Tauri-owned response envelopes; domain payloads above come from core.
export interface SourceVerificationOutcome {
  profile_id: string;
  ok: boolean;
  result: SourceVerification | null;
  error: DesktopError | null;
}

export type { UpdateCheck } from "./transport-types.generated";

export type { PortOutputLocation } from "./transport-types.generated";

export type OutputDestinationPreview = Generated.TransportOutputs["output_destination_preview"];

export type OutputRelocationPlan = Generated.TransportOutputs["output_relocation_plan"];

export type OutputRelocationResult = Generated.TransportOutputs["output_relocation_result"];

export type OutputRelocationStatus = Generated.TransportOutputs["output_relocation_status"];

export type InstallPlan = Generated.TransportOutputs["install_plan"];

export type { UpdateSnapshot } from "./transport-types.generated";

export type { ReconcileAction } from "./transport-types.generated";

export type { ReconcileResult } from "./transport-types.generated";

export interface BatchOutcome<T> {
  port_id: string;
  ok: boolean;
  result: T | null;
  error: DesktopError | null;
}

export type UpdateCheckOutcome = BatchOutcome<UpdateCheck>;

export type ReconcileOutcome = BatchOutcome<ReconcileResult>;

export type OperationEvent = Generated.TransportOutputs["operation_event"];

export interface DesktopError {
  code: ErrorCode;
  message: string;
  details: Record<string, string>;
}

export type { ErrorCode } from "./transport-types.generated";

export interface BootstrapStatus {
  ready: boolean;
  library_root: string | null;
  selection: LibrarySelection | null;
  generation: number;
  error: DesktopError | null;
}

export type LibrarySelection = Generated.TransportOutputs["library_selection"];

export type { LibraryMetadataFile } from "./transport-types.generated";

export type LibraryMovePlan = Generated.TransportOutputs["library_move_plan"];

export type LibraryMoveResult = Generated.TransportOutputs["library_move_result"];

export type LibraryImportPlan = Generated.TransportOutputs["library_import_plan"];

export type LibraryImportResult = Generated.TransportOutputs["library_import_result"];

export type SourceDiscoveryLimits = Requests.TransportInputs["source_discovery_limits"];

export type SourceDiscoveryRequest = Requests.TransportInputs["source_discovery_request"];

export type SourceDiscoveryReport = Generated.TransportOutputs["source_discovery_report"];

export type SourceInboxPaths = Generated.TransportOutputs["source_inbox_paths"];

export type SourceInboxResolution = Generated.TransportOutputs["source_inbox_resolution"];

export type { SourceImportMode } from "./transport-types.generated";

export type SourceImportPlan = Generated.TransportOutputs["source_import_plan"];

export type SourceImportResult = Generated.TransportOutputs["source_import_result"];

export type GithubAuthStatus = Generated.TransportOutputs["github_auth_status"];

export type GithubDeviceLogin = Generated.TransportOutputs["github_device_login"];

export type GithubDeviceLoginResult = Generated.TransportOutputs["github_device_login_result"];

export type CatalogUpdateSource = Requests.TransportInputs["catalog_update_source"];

export type CatalogProvenance = Generated.TransportOutputs["catalog_provenance"];

export type CatalogStatus = Generated.TransportOutputs["catalog_status"];

export type CatalogUpdatePlan = Generated.TransportOutputs["catalog_update_plan"];
