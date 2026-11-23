import type { AuthoredPort } from "./catalog-authoring.mts";
import type {
  AcquisitionRestriction,
  RestrictionScope,
} from "./catalog-acquisition-restrictions.mts";
import { isRecord } from "./runtime-values.mts";

/**
 * Shared, data-only route checks used by the route-fit report and the generated
 * registration route. No title, id or name appears here.
 */

/** The engine identity behind every ScummVM-hosted listing, compared as a URL. */
const scummvmEngineProject = "github.com/scummvm/scummvm";

function engineProject(url: unknown): string | undefined {
  if (typeof url !== "string") return undefined;
  try {
    const parsed = new URL(url);
    return `${parsed.hostname}${parsed.pathname}`
      .toLowerCase()
      .replace(/\.git$/u, "")
      .replace(/\/+$/u, "");
  } catch {
    return undefined;
  }
}

/** Engine identity from the implementation's declared runtime, never the title. */
export function usesScummvmEngine(record: AuthoredPort): boolean {
  const implementation: unknown = record.listing.implementation;
  if (!isRecord(implementation) || !Array.isArray(implementation.dependencies)) return false;
  return implementation.dependencies.some(
    (dependency: unknown) =>
      isRecord(dependency) &&
      dependency.kind === "runtime" &&
      engineProject(dependency.project_url) === scummvmEngineProject,
  );
}

// ---------------------------------------------------------------------------
// Restrictions: an offer-time port of Core's evaluate_carrier/evaluate.

export type CarrierRestrictions = {
  carrier: "listing" | "managed";
  list: AcquisitionRestriction[];
};

/** Core's PortListing::effective_restrictions and definition_restrictions. */
export function carriers(record: AuthoredPort): CarrierRestrictions[] {
  const listing = record.listing as Record<string, unknown>;
  const authored = Array.isArray(listing.restrictions)
    ? (listing.restrictions as AcquisitionRestriction[])
    : [];
  const legacy =
    !authored.length && typeof listing.download_block_reason === "string"
      ? [
          {
            id: "legacy-download-block",
            effect: "hold",
            operations: ["download"],
          } as const,
        ]
      : [];
  const integration = isRecord(record.integration) ? record.integration : undefined;
  const managed = Array.isArray(integration?.acquisition_restrictions)
    ? (integration.acquisition_restrictions as AcquisitionRestriction[])
    : [];
  return [
    { carrier: "managed", list: managed },
    {
      carrier: "listing",
      list: authored.length ? authored : (legacy as unknown as AcquisitionRestriction[]),
    },
  ];
}

const filled = (values: readonly unknown[] | undefined) => (values?.length ?? 0) > 0;

/** Artifacts > releases > inputs = components > platforms > whole. */
function specificity(scope: RestrictionScope = {}): number {
  if (filled(scope.artifacts)) return 5;
  if (filled(scope.releases)) return 4;
  if (filled(scope.inputs) || filled(scope.components)) return 3;
  if (filled(scope.platforms)) return 2;
  return 1;
}

type Fit = "no" | "possible" | "yes";

/**
 * Subject: a known operation and platform at offer time, with the release and
 * artifact deferred. Core resolves no input or component yet, so those
 * dimensions use its final rule: a hold fails closed, a permit never matches.
 */
function fit(restriction: AcquisitionRestriction, operation: string, platform: string): Fit {
  if (!(restriction.operations as readonly string[]).includes(operation)) return "no";
  const hold = restriction.effect === "hold";
  const scope = restriction.scope ?? {};
  if (filled(scope.platforms) && !scope.platforms!.includes(platform)) return "no";
  if ((filled(scope.inputs) || filled(scope.components)) && !hold) return "no";
  return filled(scope.releases) || filled(scope.artifacts) ? "possible" : "yes";
}

function evaluateCarrier(list: readonly AcquisitionRestriction[], op: string, platform: string) {
  let best: { rank: number; hold: boolean; restriction: AcquisitionRestriction } | undefined;
  let possiblePermit = 0;
  for (const restriction of list) {
    const rank = specificity(restriction.scope);
    const hold = restriction.effect === "hold";
    const result = fit(restriction, op, platform);
    if (result === "possible" && !hold) possiblePermit = Math.max(possiblePermit, rank);
    if (
      result === "yes" &&
      (!best || rank > best.rank || (rank === best.rank && hold && !best.hold))
    )
      best = { rank, hold, restriction };
  }
  if (!best || (best.hold && possiblePermit > best.rank)) return undefined;
  return best;
}

/** Any held carrier wins; a permit cancels only its own carrier's holds. */
export function heldAt(record: AuthoredPort, operation: string, platform: string) {
  for (const { list } of carriers(record)) {
    const decision = evaluateCarrier(list, operation, platform);
    if (decision?.hold) return decision.restriction;
  }
  return undefined;
}
