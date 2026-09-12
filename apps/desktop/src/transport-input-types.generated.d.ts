// Generated from Rust input schemas. Do not edit.
// Regenerate: node apps/desktop/scripts/generate-transport-types.mjs --write

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
export type ApplicationChannel = "preview" | "stable";
export type ApplicationUpdateMode = "automatic" | "notify-only" | "manual";
export type InputDesktopApplicationUpdateRecoveryArea = "schedule" | "staging" | "apply";
export type ReleaseChannel = "stable" | "beta" | "rolling";

export interface TransportInputs {
  catalog_update_source: InputCatalogUpdateSource;
  definition_capability_request: InputDefinitionCapabilityRequest;
  source_discovery_limits: SourceDiscoveryLimits;
  source_discovery_request: InputSourceDiscoveryRequest;
  desktop_application_update_choice: InputDesktopApplicationUpdateChoice;
  desktop_application_update_recovery_area: InputDesktopApplicationUpdateRecoveryArea;
  desktop_install_input: InputDesktopInstallInput;
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
export interface InputDesktopInstallInput {
  bios?: string | null;
  channel?: ReleaseChannel | null;
  portId: string;
  source?: string | null;
  stage: boolean;
  [k: string]: unknown;
}
