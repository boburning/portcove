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
export type ReleaseChannel = "stable" | "beta" | "rolling";

export interface TransportInputs {
  catalog_update_source: InputCatalogUpdateSource;
  source_discovery_limits: SourceDiscoveryLimits;
  source_discovery_request: InputSourceDiscoveryRequest;
  desktop_install_input: InputDesktopInstallInput;
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
export interface InputDesktopInstallInput {
  bios?: string | null;
  channel?: ReleaseChannel | null;
  portId: string;
  source?: string | null;
  stage: boolean;
  [k: string]: unknown;
}
