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
export type ApplicationChannel = "preview" | "stable";
export type ApplicationUpdateMode = "automatic" | "notify-only" | "manual";
export type InputDesktopApplicationUpdateProductionDecision = "use-stable" | "keep-preview";
export type InputDesktopApplicationUpdateRecoveryArea = "schedule" | "staging" | "apply";
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
export type SteamEntryOperation = "add_or_repair" | "remove";

export interface TransportInputs {
  catalog_update_source: InputCatalogUpdateSource;
  definition_capability_request: InputDefinitionCapabilityRequest;
  game_file_query_request: InputGameFileQueryRequest;
  source_discovery_limits: SourceDiscoveryLimits;
  source_discovery_request: InputSourceDiscoveryRequest;
  desktop_application_update_choice: InputDesktopApplicationUpdateChoice;
  desktop_application_update_download_request: InputDesktopApplicationUpdateDownloadRequest;
  desktop_application_update_manual_check_request: InputDesktopApplicationUpdateManualCheckRequest;
  desktop_application_update_production_decision: InputDesktopApplicationUpdateProductionDecision;
  desktop_application_update_recovery_area: InputDesktopApplicationUpdateRecoveryArea;
  desktop_catalog_download_request: InputDesktopCatalogDownloadRequest;
  desktop_game_comparison_request: InputDesktopGameComparisonRequest;
  desktop_game_file_query_request: InputGameFileQueryRequest;
  desktop_install_input: InputDesktopInstallInput;
  desktop_organization_change: InputDesktopOrganizationChange;
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
export interface InputDesktopCatalogDownloadRequest {
  asset_id: number;
  destination_parent: string;
  extract_archive: boolean;
  port_id: string;
  release_id: number;
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
export interface InputDesktopInstallInput {
  bios?: string | null;
  channel?: ReleaseChannel | null;
  portId: string;
  source?: string | null;
  stage: boolean;
  [k: string]: unknown;
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
export interface InputDesktopSteamBatchSelection {
  portIds: string[];
  steamRoot: string;
  steamUserId: string;
  [k: string]: unknown;
}
export interface InputDesktopSteamEntrySelection {
  operation: SteamEntryOperation;
  portId: string;
  steamRoot: string;
  steamUserId: string;
  [k: string]: unknown;
}
