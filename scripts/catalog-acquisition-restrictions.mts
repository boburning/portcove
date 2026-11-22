// Authored typed acquisition restrictions and their exact legacy projections.
// Core's acquisition_restriction module owns evaluation; this checks authored
// shape and derives the two legacy fields older readers still consume.
import { platforms } from "../apps/desktop/src/catalog-values.generated.ts";
import { isRecord } from "./runtime-values.mts";

export type RestrictionCarrier = "listing" | "integration";
export const restrictedOperations = [
  "download",
  "install",
  "update",
  "adopt",
  "activate",
  "prepare",
  "register-external",
  "launch",
] as const;
export type RestrictedOperation = (typeof restrictedOperations)[number];
export const restrictionReasons = [
  "bundled-game-data",
  "upstream-owned-route",
  "package-facts-unresolved",
  "legacy-rights-review",
  "no-useful-route",
  "upstream-prohibition",
  "safety-evidence-mismatch",
  "third-party-component-terms",
  "known-defective-artifact",
  "upstream-transition-unreviewed",
] as const;
const reconsiderConditions = [
  "attributable-grant",
  "clean-upstream-package",
  "owned-input-preparation",
  "publisher-checksum",
  "reviewed-successor-release",
  "upstream-route-change",
  "owner-review",
] as const;
const carrierOperations: Record<RestrictionCarrier, readonly RestrictedOperation[]> = {
  // Only download until older readers gain a gate: the legacy listing string
  // can express a download hold and nothing else.
  listing: ["download"],
  integration: ["download", "install", "update", "adopt", "activate", "prepare"],
};

export interface RestrictedArtifact {
  version: string;
  sha256: string;
  asset_name?: string;
}
export interface RestrictionScope {
  platforms?: string[];
  releases?: string[];
  artifacts?: RestrictedArtifact[];
  inputs?: string[];
  components?: (
    | { kind: "bundled-runtime"; platform: string }
    | { kind: "tool-artifact"; id: string }
  )[];
}
export interface AcquisitionRestriction {
  id: string;
  effect: "hold" | "permit";
  operations: RestrictedOperation[];
  scope?: RestrictionScope;
  reason?: string;
  explanation?: string;
  reconsider_when?: string[];
  tracking_issue?: number;
}
export interface LegacyManagedHold {
  reason: string;
  activation_reason: string;
  reviewed_artifacts?: { version: string; sha256: string }[];
  excluded_artifacts?: { version: string; sha256: string }[];
}

const slug = /^[a-z0-9]+(?:-[a-z0-9]+)*$/u;

function boundedText(value: unknown, maximum: number): value is string {
  if (
    typeof value !== "string" ||
    !value ||
    value.trim() !== value ||
    Buffer.byteLength(value) > maximum
  )
    return false;
  for (const character of value) {
    const code = character.charCodeAt(0);
    if (code < 32 || (code >= 127 && code <= 159)) return false;
  }
  return true;
}

function uniqueStrings(value: unknown, check: (item: string) => boolean) {
  return (
    Array.isArray(value) &&
    value.length > 0 &&
    value.length <= 64 &&
    value.every((item) => typeof item === "string" && check(item)) &&
    new Set(value).size === value.length
  );
}

function sameScope(left: RestrictionScope = {}, right: RestrictionScope = {}) {
  return JSON.stringify(canonicalScope(left)) === JSON.stringify(canonicalScope(right));
}

function canonicalScope(scope: RestrictionScope) {
  return Object.fromEntries(
    Object.entries(scope)
      .filter(([, value]) => Array.isArray(value) && value.length > 0)
      .sort(([a], [b]) => a.localeCompare(b, "en")),
  );
}

function checkScope(
  id: string,
  scope: unknown,
  carrier: RestrictionCarrier,
  context: ScopeContext,
) {
  const invalid = (detail: string) => new Error(`${id} acquisition restriction scope ${detail}.`);
  if (!isRecord(scope)) throw invalid("must be an object");
  const keys = ["platforms", "releases", "artifacts", "inputs", "components"];
  if (Object.keys(scope).some((key) => !keys.includes(key)))
    throw invalid("has an unknown dimension");
  if (Object.keys(scope).length === 0) throw invalid("must be omitted when whole");
  if (
    scope.platforms !== undefined &&
    !uniqueStrings(scope.platforms, (value) => (platforms as readonly string[]).includes(value))
  )
    throw invalid("platforms must be unique known platforms");
  if (scope.releases !== undefined && !uniqueStrings(scope.releases, (v) => boundedText(v, 255)))
    throw invalid("releases must be unique exact versions");
  if (scope.inputs !== undefined && !uniqueStrings(scope.inputs, (v) => slug.test(v)))
    throw invalid("inputs must be unique source identities");
  if (scope.artifacts !== undefined) {
    const artifacts: unknown = scope.artifacts;
    if (!Array.isArray(artifacts) || artifacts.length === 0 || artifacts.length > 64)
      throw invalid("artifacts must be a bounded nonempty list");
    const seen = new Set<string>();
    for (const artifact of artifacts) {
      if (
        !isRecord(artifact) ||
        Object.keys(artifact).some((key) => !["version", "sha256", "asset_name"].includes(key)) ||
        !boundedText(artifact.version, 255) ||
        typeof artifact.sha256 !== "string" ||
        !/^[0-9a-f]{64}$/u.test(artifact.sha256) ||
        (artifact.asset_name !== undefined &&
          (!boundedText(artifact.asset_name, 255) || /[/\\]/u.test(artifact.asset_name))) ||
        seen.has(`${artifact.version}\u0000${artifact.sha256}\u0000${String(artifact.asset_name)}`)
      )
        throw invalid(
          "artifacts require a unique version, lowercase SHA-256 and optional file name",
        );
      seen.add(`${artifact.version}\u0000${artifact.sha256}\u0000${String(artifact.asset_name)}`);
    }
  }
  if (scope.components !== undefined) {
    const components: unknown = scope.components;
    if (
      !Array.isArray(components) ||
      components.length === 0 ||
      components.length > 64 ||
      components.some(
        (component) =>
          !isRecord(component) ||
          !(
            (component.kind === "bundled-runtime" &&
              Object.keys(component).length === 2 &&
              (platforms as readonly string[]).includes(String(component.platform))) ||
            (component.kind === "tool-artifact" &&
              Object.keys(component).length === 2 &&
              typeof component.id === "string" &&
              slug.test(component.id))
          ),
      ) ||
      new Set(components.map((component) => JSON.stringify(component))).size !== components.length
    )
      throw invalid("components must be unique bundled runtimes or tool artifacts");
  }
  if (
    carrier === "listing" &&
    (scope.releases !== undefined || scope.artifacts !== undefined) &&
    !context.hasReleaseRoute
  )
    throw invalid("names releases or artifacts without a listing release route");
}

interface ScopeContext {
  /** The listing names a release page or reviewed asset hints. */
  hasReleaseRoute: boolean;
}

/** Closed authored validation of one carrier's restrictions. */
export function checkAcquisitionRestrictions(
  id: string,
  value: unknown,
  carrier: RestrictionCarrier,
  context: ScopeContext = { hasReleaseRoute: false },
): asserts value is AcquisitionRestriction[] {
  const invalid = (detail: string) => new Error(`${id} acquisition restrictions ${detail}.`);
  if (!Array.isArray(value) || value.length === 0 || value.length > 64)
    throw invalid("must be a bounded nonempty list; omit the field when there is none");
  const ids = new Set<string>();
  for (const restriction of value) {
    if (!isRecord(restriction)) throw invalid("must contain objects");
    const allowed = [
      "id",
      "effect",
      "operations",
      "scope",
      "reason",
      "explanation",
      "reconsider_when",
      "tracking_issue",
    ];
    if (Object.keys(restriction).some((key) => !allowed.includes(key)))
      throw invalid("contain an unknown field");
    if (
      typeof restriction.id !== "string" ||
      !slug.test(restriction.id) ||
      restriction.id.length > 64
    )
      throw invalid("require slug ids");
    if (ids.has(restriction.id)) throw invalid(`repeat the id ${restriction.id}`);
    ids.add(restriction.id);
    if (restriction.effect !== "hold" && restriction.effect !== "permit")
      throw invalid("require a hold or permit effect");
    if (
      !Array.isArray(restriction.operations) ||
      restriction.operations.length === 0 ||
      new Set(restriction.operations).size !== restriction.operations.length ||
      restriction.operations.some(
        (operation: unknown) =>
          typeof operation !== "string" ||
          !(carrierOperations[carrier] as readonly string[]).includes(operation),
      )
    )
      throw invalid(
        `name operations outside the ${carrier} carrier (${carrierOperations[carrier].join(", ")})`,
      );
    if (restriction.effect === "hold") {
      if (!(restrictionReasons as readonly unknown[]).includes(restriction.reason))
        throw invalid("require a known reason code for each hold");
      if (!boundedText(restriction.explanation, 4096))
        throw invalid("require bounded player copy for each hold");
      if (/\bexecution\s+intent\b/iu.test(restriction.explanation))
        throw new Error(
          `${id} acquisition restriction: explain the program and launch options instead of "execution intent".`,
        );
    } else if (restriction.reason !== undefined || restriction.explanation !== undefined)
      throw invalid("carry no reason or explanation on a permit");
    if (
      restriction.reconsider_when !== undefined &&
      !uniqueStrings(restriction.reconsider_when, (value) =>
        (reconsiderConditions as readonly string[]).includes(value),
      )
    )
      throw invalid("require unique known reconsideration conditions");
    if (
      restriction.tracking_issue !== undefined &&
      (!Number.isSafeInteger(restriction.tracking_issue) || Number(restriction.tracking_issue) < 1)
    )
      throw invalid("require a positive tracking issue");
    if (restriction.scope !== undefined) checkScope(id, restriction.scope, carrier, context);
    // No Core path resolves inputs or components yet; a permit on them could
    // never be proven, so it is refused until one does. Holds may keep them.
    if (
      restriction.effect === "permit" &&
      isRecord(restriction.scope) &&
      (restriction.scope.inputs !== undefined || restriction.scope.components !== undefined)
    )
      throw invalid("let a permit name inputs or components, which Core cannot yet prove");
  }
  const restrictions = value as AcquisitionRestriction[];
  const holds = restrictions.filter((restriction) => restriction.effect === "hold");
  for (const permit of restrictions.filter((restriction) => restriction.effect === "permit")) {
    const shared = holds.filter((hold) =>
      hold.operations.some((operation) => permit.operations.includes(operation)),
    );
    if (shared.length === 0)
      throw invalid(`let the permit ${permit.id} cancel no hold in its carrier`);
    if (shared.some((hold) => sameScope(hold.scope, permit.scope)))
      throw invalid(`give the permit ${permit.id} the same scope as a hold it overlaps`);
  }
}

/** The first authored hold that names Download, at any scope. */
export function legacyDownloadProjection(
  restrictions: readonly AcquisitionRestriction[] | undefined,
): string | undefined {
  return restrictions?.find(
    (restriction) => restriction.effect === "hold" && restriction.operations.includes("download"),
  )?.explanation;
}

/** The legacy listing download restriction derived from authored typed data. */
export function listingDownloadBlockReason(listing: { restrictions?: unknown }) {
  return Array.isArray(listing.restrictions)
    ? legacyDownloadProjection(listing.restrictions as AcquisitionRestriction[])
    : undefined;
}

const artifactScope = (artifacts: { version: string; sha256: string }[]) => ({
  artifacts: artifacts.map(({ version, sha256 }) => ({ version, sha256 })),
});

/** Mirror of Core's ManagedAcquisitionHold::to_restrictions. */
export function restrictionsFromManagedHold(hold: LegacyManagedHold): AcquisitionRestriction[] {
  const acquisition: RestrictedOperation[] = ["download", "install", "update", "adopt"];
  const reviewed = hold.reviewed_artifacts ?? [];
  const excluded = hold.excluded_artifacts ?? [];
  if (excluded.length === 0)
    return [
      {
        id: "acquisition",
        effect: "hold",
        operations: acquisition,
        reason: "upstream-transition-unreviewed",
        explanation: hold.reason,
      },
      {
        id: "activation",
        effect: "hold",
        operations: ["activate"],
        reason: "upstream-transition-unreviewed",
        explanation: hold.activation_reason,
      },
      ...reviewed.map((artifact, index) => ({
        id: `reviewed-${index + 1}`,
        effect: "permit" as const,
        operations: ["activate" as const],
        scope: artifactScope([artifact]),
      })),
    ];
  return [
    {
      id: "excluded-acquisition",
      effect: "hold",
      operations: acquisition,
      scope: artifactScope(excluded),
      reason: "known-defective-artifact",
      explanation: hold.reason,
    },
    {
      id: "excluded-activation",
      effect: "hold",
      operations: ["activate"],
      scope: artifactScope(excluded),
      reason: "known-defective-artifact",
      explanation: hold.activation_reason,
    },
    ...(reviewed.length
      ? [
          {
            id: "reviewed",
            effect: "permit" as const,
            operations: ["install", "update", "activate"] as RestrictedOperation[],
            scope: artifactScope(reviewed),
          },
        ]
      : []),
  ];
}

/**
 * The existing managed_acquisition_hold bytes for typed integration data.
 * Typed data that this struct cannot represent exactly is refused, so the
 * managed wire format and every older reader stay unchanged.
 */
export function managedHoldFromRestrictions(
  id: string,
  restrictions: readonly AcquisitionRestriction[],
): LegacyManagedHold {
  const first = restrictions[0];
  const second = restrictions[1];
  const artifacts = (restriction: AcquisitionRestriction | undefined) =>
    (restriction?.scope?.artifacts ?? []).map(({ version, sha256 }) => ({ version, sha256 }));
  const excluded = first?.id === "excluded-acquisition";
  const hold: LegacyManagedHold = {
    reason: first?.explanation ?? "",
    activation_reason: second?.explanation ?? "",
  };
  const reviewed = excluded
    ? artifacts(restrictions[2])
    : restrictions.slice(2).flatMap((restriction) => artifacts(restriction));
  // Key order is the established generated byte order.
  if (excluded) hold.excluded_artifacts = artifacts(first);
  if (reviewed.length) hold.reviewed_artifacts = reviewed;
  if (JSON.stringify(restrictionsFromManagedHold(hold)) !== JSON.stringify(restrictions))
    throw new Error(
      `${id} integration.acquisition_restrictions cannot yet be delivered: managed definitions carry only a route-wide transition hold with reviewed activation permits, or exact-artifact exclusions with one reviewed permit, in that canonical form.`,
    );
  return hold;
}

/** Replace one key in place, preserving the authored key order. */
export function replaceKey(
  record: Record<string, unknown>,
  from: string,
  entries: [string, unknown][],
): Record<string, unknown> {
  if (!Object.hasOwn(record, from)) return record;
  return Object.fromEntries(
    Object.entries(record).flatMap(([key, value]) => (key === from ? entries : [[key, value]])),
  );
}

/** Generated managed integration: typed authored data, legacy wire bytes. */
export function projectManagedRestrictions(
  id: string,
  integration: Record<string, unknown>,
): Record<string, unknown> {
  const restrictions = integration.acquisition_restrictions;
  if (restrictions === undefined) return integration;
  return replaceKey(integration, "acquisition_restrictions", [
    [
      "managed_acquisition_hold",
      managedHoldFromRestrictions(id, restrictions as AcquisitionRestriction[]),
    ],
  ]);
}

/** Generated listing row: the legacy string precedes its typed source. */
export function projectListingRestrictions<T extends Record<string, unknown>>(
  listing: T,
): T & { download_block_reason?: string } {
  const restrictions = listing.restrictions as AcquisitionRestriction[] | undefined;
  if (restrictions === undefined) return listing;
  const legacy = legacyDownloadProjection(restrictions);
  return replaceKey(listing, "restrictions", [
    ...(legacy === undefined ? [] : [["download_block_reason", legacy] as [string, unknown]]),
    ["restrictions", restrictions],
  ]) as T & { download_block_reason?: string };
}
