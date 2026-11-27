import { isRecord } from "./runtime-values.mts";
import type { LauncherModObservation } from "./port-upstream-facts.mts";

function exactProductCode(system: unknown, value: unknown) {
  if (typeof value !== "string") return undefined;
  if (system === "playstation" && /^S[CL][A-Z]{2}-[0-9]{5}$/u.test(value)) return value;
  if (system === "nintendo-gamecube" && /^[A-Z0-9]{6}$/u.test(value)) return value;
  return undefined;
}

type GameScope = { system: string; codes: ReadonlySet<string> };

/** Only a reviewed game input contract for this exact operational port can
 * authorize a new automatic link. Display names and fuzzy IDs are unused. */
export function launcherModGameScopes(catalog: unknown, listings: readonly unknown[]) {
  const result = new Map<string, GameScope>();
  if (
    !isRecord(catalog) ||
    !Array.isArray(catalog.ports) ||
    !isRecord(catalog.source_catalog) ||
    !Array.isArray(catalog.source_catalog.contracts) ||
    !Array.isArray(catalog.source_catalog.identities)
  )
    return result;
  const ports = new Map(
    (catalog.ports as unknown[]).filter(isRecord).map((port) => [port.id, port]),
  );
  const contracts = (catalog.source_catalog.contracts as unknown[]).filter(isRecord);
  const identities = new Map(
    (catalog.source_catalog.identities as unknown[]).filter(isRecord).map((row) => [row.id, row]),
  );
  for (const listing of listings) {
    if (!isRecord(listing) || typeof listing.id !== "string" || !isRecord(listing.original_game))
      continue;
    const editions = listing.original_game.source_editions;
    const profile = ports.get(listing.id)?.source_profile;
    if (typeof profile !== "string" || !Array.isArray(editions) || editions.length !== 1) continue;
    const edition: unknown = editions[0];
    if (!isRecord(edition) || typeof edition.system !== "string") continue;
    const selected = contracts.filter(
      (contract) =>
        contract.port_id === listing.id &&
        contract.role === "game" &&
        contract.admission_mode === "enforced" &&
        contract.profile_id === profile,
    );
    const contract = selected.length === 1 ? selected[0] : undefined;
    const variants = identities.get(profile)?.variants;
    if (!contract || !Array.isArray(contract.supported_variant_ids) || !Array.isArray(variants))
      continue;
    const supported = new Set<unknown>(contract.supported_variant_ids);
    const declared = edition.verified_sources;
    const codes = new Set<string>();
    for (const variant of variants as unknown[]) {
      if (
        !isRecord(variant) ||
        variant.legacy_projection_only === true ||
        !supported.has(variant.id) ||
        !Array.isArray(variant.product_codes)
      )
        continue;
      if (
        declared !== undefined &&
        (!Array.isArray(declared) ||
          !(declared as unknown[]).some(
            (source) =>
              isRecord(source) &&
              source.game_id === profile &&
              source.variant_id === variant.id &&
              Array.isArray(variant.representations) &&
              (variant.representations as unknown[]).some(
                (representation) =>
                  isRecord(representation) && representation.id === source.representation_id,
              ),
          ))
      )
        continue;
      for (const raw of variant.product_codes as unknown[]) {
        const code = exactProductCode(edition.system, raw);
        if (code) codes.add(code);
      }
    }
    if (codes.size) result.set(listing.id, { system: edition.system, codes });
  }
  return result;
}

export function verifyLauncherModGameScope(
  result: LauncherModObservation,
  scope: GameScope | undefined,
): LauncherModObservation {
  if (result.state !== "observed") return result;
  if (!scope || !result.game_input_ids?.length)
    return { state: "unavailable", reason: "game-input-scope-unproven" };
  return result.game_input_ids.every((raw) => {
    const code = exactProductCode(scope.system, raw);
    return code !== undefined && scope.codes.has(code);
  })
    ? result
    : { state: "held", reason: "game-input-scope-conflict" };
}
