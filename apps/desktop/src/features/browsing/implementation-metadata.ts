import type { CatalogEntry } from "./catalog-entry";

export const implementationMethodLabels = {
  "static-recompilation": "Static recompilation",
  "matching-decompilation": "Matching decompilation",
  "non-matching-decompilation": "Non-matching decompilation",
  "source-port": "Source port",
  "engine-reimplementation": "Engine reimplementation",
  other: "Other implementation method",
} as const;
export const dependencyKindLabels = {
  toolchain: "Built using",
  runtime: "Uses runtime",
  library: "Uses library",
  "source-preparation": "Prepares original files using",
} as const;
interface Method {
  kind: keyof typeof implementationMethodLabels;
  evidence_urls: string[];
  note?: string;
}
interface Dependency {
  kind: keyof typeof dependencyKindLabels;
  project_url: string;
  name: string;
  confidence: "confirmed" | "inferred" | "contradicted";
  evidence_urls: string[];
  version_scope?: string;
  note?: string;
}
export interface ImplementationMetadata {
  methods: Method[];
  dependencies: Dependency[];
}
function record(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}
function text(value: unknown, max = 1024): value is string {
  return (
    typeof value === "string" && value.length > 0 && value.length <= max && !/\p{Cc}/u.test(value)
  );
}
function publicUrl(value: unknown): value is string {
  if (!text(value, 2048)) return false;
  try {
    const url = new URL(value);
    return url.protocol === "https:" && !url.username && !url.password;
  } catch {
    return false;
  }
}
function evidence(value: unknown): value is string[] {
  return Array.isArray(value) && value.length > 0 && value.length <= 8 && value.every(publicUrl);
}
/** Tolerant display reader: unknown envelope versions disappear; unknown kinds remain unknown. */
export function readImplementationMetadata(value: unknown): ImplementationMetadata | undefined {
  if (
    !record(value) ||
    value.format_version !== 1 ||
    !Array.isArray(value.methods) ||
    value.methods.length > 8 ||
    !Array.isArray(value.dependencies) ||
    value.dependencies.length > 16
  )
    return undefined;
  const methods = value.methods.filter(
    (method): method is Method =>
      record(method) &&
      typeof method.kind === "string" &&
      Object.hasOwn(implementationMethodLabels, method.kind) &&
      evidence(method.evidence_urls) &&
      (method.note === undefined || text(method.note)),
  );
  const dependencies = value.dependencies.filter(
    (dependency): dependency is Dependency =>
      record(dependency) &&
      typeof dependency.kind === "string" &&
      Object.hasOwn(dependencyKindLabels, dependency.kind) &&
      publicUrl(dependency.project_url) &&
      text(dependency.name, 128) &&
      typeof dependency.confidence === "string" &&
      ["confirmed", "inferred", "contradicted"].includes(dependency.confidence) &&
      evidence(dependency.evidence_urls) &&
      (dependency.note === undefined || text(dependency.note)) &&
      (dependency.version_scope === undefined || text(dependency.version_scope, 256)),
  );
  return methods.length || dependencies.length ? { methods, dependencies } : undefined;
}
export function implementationMetadata(port: CatalogEntry) {
  // Core's effective listing includes accepted corrections and explicit clears.
  // Only a definition without a listing needs its presentation fallback.
  return readImplementationMetadata(
    port.listing ? port.listing.implementation : port.presentation?.implementation,
  );
}
export function implementationMethodKinds(port: CatalogEntry): string[] {
  return implementationMetadata(port)?.methods.map((method) => method.kind) ?? [];
}
