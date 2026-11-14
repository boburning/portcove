// Generated from Rust input schemas. Do not edit.
// Regenerate: node apps/desktop/scripts/generate-transport-types.mts --write

export type InputCatalogUpdateSource =
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
export type ReleaseChannel = "stable" | "beta" | "rolling";
export type Platform = "windows-x86-64" | "linux-x86-64" | "macos-x86-64" | "macos-aarch64";
export type GameFileRouteKind = "managed_install" | "external_registration" | "managed_launch" | "external_launch";
export type InputGameSettingChange =
  | {
      action: "set";
      value: unknown;
    }
  | {
      action: "reset";
    };
export type InputDesktopAdoptionBatchItems = AdoptionBatchItem[];
export type ApplicationChannel = "preview" | "stable";
export type ApplicationUpdateMode = "automatic" | "notify-only" | "manual";
export type InputDesktopApplicationUpdateProductionDecision = "use-stable" | "keep-preview";
export type InputDesktopApplicationUpdateRecoveryArea = "schedule" | "staging" | "apply";
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
export type GameFileScanMatchKind = "exact" | "preliminary";
export type InputDesktopInstallBatchRequestItems = InstallBatchRequestItem[];
export type LibraryMembershipOrigin = "game_file_discovery" | "manual";
export type InputDesktopLibraryMembershipRequests = LibraryMembershipRequest[];
export type InputDesktopOrganizationChange =
  | {
      game_id: string;
      kind: "set_preferred_implementation";
      port_id?: string | null;
    }
  | {
      followed: boolean;
      kind: "set_followed_project";
      /**
       * Optionally acknowledge the exact release already visible when following.
       */
      observed_identity?: string | null;
      port_id: string;
    }
  | {
      identity: string;
      kind: "acknowledge_followed_release";
      port_id: string;
    }
  | {
      hidden: boolean;
      kind: "set_hidden";
      port_id: string;
    }
  | {
      game_id: string;
      kind: "set_saved";
      saved: boolean;
    }
  | {
      game_id: string;
      kind: "set_saved_group";
      legacy_port_ids: string[];
      saved: boolean;
    }
  | {
      collection_id: string;
      kind: "upsert_collection";
      name: string;
    }
  | {
      collection_id: string;
      kind: "remove_collection";
    }
  | {
      collection_id: string;
      included: boolean;
      kind: "set_collection_port";
      port_id: string;
    }
  | {
      choice: UpdateNoticeChoice;
      kind: "set_update_notice";
      port_id: string;
    }
  | {
      confirmation: SetupConfirmation;
      confirmed: boolean;
      kind: "set_setup_confirmation";
    };
export type InstallationContext =
  | {
      installation_id: string;
      kind: "managed";
    }
  | {
      installation_id: string;
      kind: "external";
    };
export type InputDesktopPortIntentMode = "discover_only" | "notify" | "set_up_when_ready" | "ignored";
export type InputDesktopPortReadinessAcknowledgements = PortReadinessAcknowledgement[];
/**
 * Which issue form a report fills.
 */
export type InputDesktopReportKind = "problem" | "feedback";
export type InputDesktopRootSetupEnrollment = RootSetupEnrollment | null;
export type RootSetupEnrollment = "existing_and_future" | "future_only";
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
    }
  | {
      kind: "remove_owned_role";
      role: DestinationArtworkRole;
      [k: string]: unknown;
    };
export type DestinationArtworkRole = "portrait_cover" | "landscape_cover" | "hero_banner";
export type SteamEntryOperation = "add_or_repair" | "remove";

export interface TransportInputs {
  catalog_update_source: InputCatalogUpdateSource;
  definition_capability_request: InputDefinitionCapabilityRequest;
  game_file_query_request: InputGameFileQueryRequest;
  game_setting_change: InputGameSettingChange;
  source_discovery_limits: SourceDiscoveryLimits;
  source_discovery_request: InputSourceDiscoveryRequest;
  desktop_adoption_batch_items: InputDesktopAdoptionBatchItems;
  desktop_application_update_choice: InputDesktopApplicationUpdateChoice;
  desktop_application_update_download_request: InputDesktopApplicationUpdateDownloadRequest;
  desktop_application_update_manual_check_request: InputDesktopApplicationUpdateManualCheckRequest;
  desktop_application_update_production_decision: InputDesktopApplicationUpdateProductionDecision;
  desktop_application_update_recovery_area: InputDesktopApplicationUpdateRecoveryArea;
  desktop_bug_report_field: InputDesktopBugReportField;
  desktop_catalog_download_request: InputDesktopCatalogDownloadRequest;
  desktop_game_comparison_request: InputDesktopGameComparisonRequest;
  desktop_game_file_query_request: InputGameFileQueryRequest;
  desktop_game_file_scan_match_query: InputDesktopGameFileScanMatchQuery;
  desktop_install_batch_request_items: InputDesktopInstallBatchRequestItems;
  desktop_install_input: InputDesktopInstallInput;
  desktop_library_membership_requests: InputDesktopLibraryMembershipRequests;
  desktop_organization_change: InputDesktopOrganizationChange;
  desktop_port_intent_mode: InputDesktopPortIntentMode;
  desktop_port_readiness_acknowledgements: InputDesktopPortReadinessAcknowledgements;
  desktop_report_kind: InputDesktopReportKind;
  desktop_root_setup_enrollment: InputDesktopRootSetupEnrollment;
  desktop_steam_artwork_selection: InputDesktopSteamArtworkSelection;
  desktop_steam_batch_selection: InputDesktopSteamBatchSelection;
  desktop_steam_entry_selection: InputDesktopSteamEntrySelection;
}
export interface InputDefinitionCapabilityRequest {
  capability_contract_schema: number;
  required_capabilities: DefinitionCapabilityRequirement[];
}
export interface DefinitionCapabilityRequirement {
  maximum_version: number;
  minimum_version: number;
  template: string;
}
/**
 * Explicit refresh inputs. Inspection reports are never accepted from a client.
 */
export interface InputGameFileQueryRequest {
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
export interface SourceDiscoveryLimits {
  max_candidates: number;
  max_depth: number;
  max_entries: number;
  max_file_bytes: number;
  max_hash_bytes: number;
  [k: string]: unknown;
}
export interface InputSourceDiscoveryRequest {
  limits?: SourceDiscoveryLimits1;
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
export interface AdoptionBatchItem {
  /**
   * Catalog port this folder is reviewed for.
   */
  port_id: string;
  /**
   * Existing installation folder to copy; it is never modified.
   */
  source: string;
  [k: string]: unknown;
}
export interface InputDesktopApplicationUpdateChoice {
  channel: ApplicationChannel;
  mode: ApplicationUpdateMode;
  paused: boolean;
}
export interface InputDesktopApplicationUpdateDownloadRequest {
  expected_candidate: ApplicationUpdateCandidateSummary;
  expected_preference_revision: number;
}
export interface ApplicationUpdateCandidateSummary {
  bytes: number;
  channel: ApplicationChannel;
  version: string;
}
export interface InputDesktopApplicationUpdateManualCheckRequest {
  channel?: ApplicationChannel | null;
}
export interface InputDesktopBugReportField {
  id: string;
  label: string;
  value: string;
  [k: string]: unknown;
}
export interface InputDesktopCatalogDownloadRequest {
  asset_id: CatalogDownloadAssetId;
  destination_parent: string;
  extract_archive: boolean;
  port_id: string;
  release_id: CatalogDownloadReleaseId;
}
export interface InputDesktopGameComparisonRequest {
  edition_id?: string | null;
  /**
   * An explicit observation environment, not a claim that this machine matches it.
   * Omission uses an unqualified environment and cannot inherit another device's evidence.
   */
  environment_id?: string | null;
  /**
   * Explicit replay clock. Adapters must not replace a supplied clock.
   */
  evaluated_at?: number | null;
  platform?: Platform | null;
  /**
   * A current or retained listing. Only explicit original-game IDs relate alternatives.
   */
  port_id: string;
  /**
   * Reuse the existing provider's conditional requests, cache and network limits.
   */
  refresh?: boolean;
  required_capabilities?: string[];
  /**
   * Catalog profile IDs only. Omission uses this library's explicit registrations;
   * presence describes a hypothetical source context, not a fresh file verification.
   */
  source_profile_ids?: string[] | null;
}
/**
 * One page of the current saved-folder scan's retained matches.
 */
export interface InputDesktopGameFileScanMatchQuery {
  kind: GameFileScanMatchKind;
  /**
   * 1 to 512 matches.
   */
  limit: number;
  offset?: number;
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
export interface InstallBatchRequestItem {
  /**
   * Digest of the plan the player reviewed for this game.
   */
  expected_plan_sha256: string;
  port_id: string;
}
export interface InputDesktopInstallInput {
  bios?: string | null;
  channel?: ReleaseChannel | null;
  portId: string;
  source?: string | null;
  sourceReference?: SourceRegistrationReference | null;
  stage: boolean;
}
export interface SourceRegistrationReference {
  profile_id: string;
  reference_sha256: string;
}
export interface LibraryMembershipRequest {
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
export interface UpdateNoticeChoice {
  paused: boolean;
  skipped_release?: UpdateNoticeRelease | null;
  [k: string]: unknown;
}
export interface UpdateNoticeRelease {
  /**
   * Same-tag rebuilds with different bytes must remain visible.
   */
  artifact_sha256: string;
  version: string;
}
export interface SetupConfirmation {
  context: InstallationContext;
  port_id: string;
}
export interface PortReadinessAcknowledgement {
  plan_sha256: string;
  port_id: string;
}
export interface InputDesktopSteamArtworkSelection {
  operation: SteamArtworkOperation;
  portId: string;
  steamRoot: string;
  steamUserId: string;
  [k: string]: unknown;
}
export interface InputDesktopSteamBatchSelection {
  /**
   * Also fill missing Steam artwork for each newly added shortcut.
   */
  includeArtwork?: boolean;
  portIds: string[];
  steamRoot: string;
  steamUserId: string;
  [k: string]: unknown;
}
export interface InputDesktopSteamEntrySelection {
  /**
   * Also fill missing Steam artwork for a newly added shortcut.
   */
  includeArtwork?: boolean;
  operation: SteamEntryOperation;
  portId: string;
  steamRoot: string;
  steamUserId: string;
  [k: string]: unknown;
}
