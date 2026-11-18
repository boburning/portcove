import { isRecord } from "./runtime-values.mts";

export const implementationMethods = [
  "static-recompilation",
  "matching-decompilation",
  "non-matching-decompilation",
  "source-port",
  "engine-reimplementation",
  "other",
] as const;
export const dependencyKinds = ["toolchain", "runtime", "library", "source-preparation"] as const;
export interface ImplementationMetadata {
  format_version: 1;
  methods: {
    kind: (typeof implementationMethods)[number];
    evidence_urls: string[];
    note?: string;
  }[];
  dependencies: {
    kind: (typeof dependencyKinds)[number];
    project_url: string;
    name: string;
    confidence: "confirmed" | "inferred" | "contradicted";
    version_scope?: string;
    evidence_urls: string[];
    note?: string;
  }[];
}
function text(value: unknown, maximum = 1024): value is string {
  return (
    typeof value === "string" &&
    value.trim() === value &&
    value.length > 0 &&
    Buffer.byteLength(value) <= maximum &&
    !/\p{Cc}/u.test(value)
  );
}
function url(value: unknown) {
  if (!text(value, 2048)) throw new Error("Implementation evidence requires a bounded HTTPS URL.");
  const parsed = new URL(value);
  if (parsed.protocol !== "https:" || parsed.username || parsed.password)
    throw new Error("Implementation evidence requires credential-free HTTPS.");
}
function evidence(value: unknown) {
  if (
    !Array.isArray(value) ||
    !value.length ||
    value.length > 8 ||
    new Set(value).size !== value.length
  )
    throw new Error("Implementation claims require unique attributable evidence URLs.");
  value.forEach(url);
}
function object(value: unknown, fields: string[]): asserts value is Record<string, unknown> {
  if (!isRecord(value) || Object.keys(value).some((key) => !fields.includes(key)))
    throw new Error("Invalid implementation metadata fields.");
}
/** Strict authoring only. Consumers ignore malformed/future optional envelopes. Never an operation grant. */
export function checkImplementationMetadata(
  value: unknown,
): asserts value is ImplementationMetadata {
  object(value, ["format_version", "methods", "dependencies"]);
  if (
    value.format_version !== 1 ||
    !Array.isArray(value.methods) ||
    !Array.isArray(value.dependencies) ||
    value.methods.length > 8 ||
    value.dependencies.length > 16 ||
    (!value.methods.length && !value.dependencies.length)
  )
    throw new Error("Invalid implementation metadata version or bounds.");
  const methods = new Set();
  for (const method of value.methods) {
    object(method, ["kind", "evidence_urls", "note"]);
    if (
      !(implementationMethods as readonly unknown[]).includes(method.kind) ||
      methods.has(method.kind) ||
      (method.note !== undefined && !text(method.note))
    )
      throw new Error("Invalid or duplicate implementation method.");
    methods.add(method.kind);
    evidence(method.evidence_urls);
  }
  const dependencies = new Set();
  for (const dependency of value.dependencies) {
    object(dependency, [
      "kind",
      "project_url",
      "name",
      "confidence",
      "version_scope",
      "evidence_urls",
      "note",
    ]);
    if (
      typeof dependency.kind !== "string" ||
      !(dependencyKinds as readonly unknown[]).includes(dependency.kind) ||
      typeof dependency.confidence !== "string" ||
      !["confirmed", "inferred", "contradicted"].includes(dependency.confidence) ||
      !text(dependency.name, 128) ||
      (dependency.version_scope !== undefined && !text(dependency.version_scope, 256)) ||
      (dependency.note !== undefined && !text(dependency.note))
    )
      throw new Error("Invalid dependency description.");
    url(dependency.project_url);
    evidence(dependency.evidence_urls);
    const project = new URL(String(dependency.project_url));
    if (project.hostname === "github.com")
      project.pathname = project.pathname.replace(/\/$/u, "").toLowerCase();
    const identity = `${dependency.kind}:${project.href}`;
    if (dependencies.has(identity)) throw new Error("Duplicate dependency relationship.");
    dependencies.add(identity);
  }
}
