import type * as Requests from "./transport-input-types.generated";
import type { PortStatus } from "./transport-types.generated";
import type * as Generated from "./transport-types.generated";

export type { ReleaseChannel } from "./transport-types.generated";

export type { UpdatePolicy } from "./transport-types.generated";

export type { SourceProfile } from "./transport-types.generated";

export type { DigestIdentity } from "./transport-types.generated";

export type { SourceRepresentation } from "./transport-types.generated";

export type { PortDefinition } from "./transport-types.generated";

export type CatalogDocument = Generated.TransportOutputs["catalog"];
export type ArtworkState = Generated.TransportOutputs["artwork_state"];
export type ArtworkThumbnail = Generated.TransportOutputs["artwork_thumbnail"];
export type ArtworkSlot = ArtworkState["choice"]["slot"];

export type { InstallRecord } from "./transport-types.generated";

export type PreparationPlan = Generated.TransportOutputs["preparation_plan"];
export type GameUpdatePlan = Generated.TransportOutputs["game_update_plan"];

export type { SourceHealth } from "./transport-types.generated";

export type ReadinessBlocker = NonNullable<PortStatus["readiness"]>["blockers"][number];

export type { PortStatus } from "./transport-types.generated";

export type { ActivityOperation } from "./transport-types.generated";

export type { CancellationState } from "./transport-types.generated";

export type ActivityRecord = Generated.TransportOutputs["activity"];
export type ActivityDiagnostic = Generated.TransportOutputs["activity_diagnostic"];

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

export type { SourceInspectionReport } from "./transport-types.generated";

export type SourceIntakeInspection = Generated.TransportOutputs["source_intake_inspection"];

// These envelopes are generated from the exact Tauri-owned Rust definitions.
export type SourceVerificationOutcome =
  Generated.TransportOutputs["desktop_source_verification_outcome"];

export type { UpdateCheck } from "./transport-types.generated";

export type { PortOutputLocation } from "./transport-types.generated";

export type OutputDestinationPreview = Generated.TransportOutputs["output_destination_preview"];

export type OutputRelocationPlan = Generated.TransportOutputs["output_relocation_plan"];

export type OutputRelocationResult = Generated.TransportOutputs["output_relocation_result"];

export type OutputRelocationStatus = Generated.TransportOutputs["output_relocation_status"];

export type InstallPlan = Generated.TransportOutputs["install_plan"];

export type { UpdateSnapshot } from "./transport-types.generated";

export type UpdateCheckOutcome = Generated.TransportOutputs["desktop_update_check_outcome"];

export type OperationEvent = Generated.TransportOutputs["operation_event"];

export type DesktopError = Generated.TransportOutputs["desktop_desktop_error"];

export type BootstrapStatus = Generated.TransportOutputs["desktop_bootstrap_status"];

export type ApplicationUpdatePreferences =
  Generated.TransportOutputs["desktop_application_update_preferences"];

export type ApplicationUpdateChoice = Requests.TransportInputs["desktop_application_update_choice"];

export type ApplicationUpdateStatus =
  Generated.TransportOutputs["desktop_application_update_status"];

export type ApplicationUpdateRecoveryArea =
  Requests.TransportInputs["desktop_application_update_recovery_area"];

export type ApplicationUpdateCheckResult =
  Generated.TransportOutputs["desktop_application_update_check_result"];

export type ApplicationUpdateCheckPhase =
  Generated.TransportOutputs["desktop_application_update_check_phase"];

export type ApplicationUpdateDownloadRequest =
  Requests.TransportInputs["desktop_application_update_download_request"];

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

export type InstallInput = Requests.TransportInputs["desktop_install_input"];
export type LaunchResult = Generated.TransportOutputs["desktop_launch_result"];

export type BackupReview = Generated.TransportOutputs["desktop_backup_review"];
export type BackupAction = BackupReview["preview"]["action"];

export type PortRemovalPreview = Generated.TransportOutputs["port_removal_preview"];

export type CliCommandContext = Generated.TransportOutputs["desktop_cli_command_context"];
