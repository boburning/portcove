import {
  assertPreparedArtwork,
  catalogGameMediaRoles,
  gameMediaImageTarget,
  reconcileCatalogArtworkWithdrawals,
} from "./inspect-igdb-artwork.mts";
import { hashPattern, imagePattern, matchesString, positiveId } from "./catalog-cover-mapping.mts";
import { isRecord } from "./runtime-values.mts";
import { originalEditionMediaKey } from "./shared-original-media.mts";
import type { CatalogMediaSubject } from "../apps/desktop/src/transport-types.generated.d.ts";
import type {
  ArtworkCatalog,
  ArtworkPort,
  prepareCatalogArtwork,
  prepareCatalogGameMedia,
} from "./inspect-igdb-artwork.mts";

// One artwork operation admits at most 400 ports. A larger cover workset runs as
// consecutive operations over the same unchanged input, like the checkpointed
// artwork driver: each keeps only its own ports and records, the proposal is
// assembled per port, and exact-image Gone observations from every operation are
// reconciled into all records once at the end. The operations share the run's one
// provider budget; this path neither adapts admission nor checkpoints progress.
export const ARTWORK_OPERATION_PORTS = 400;
type CoverPreparation = Awaited<ReturnType<typeof prepareCatalogArtwork>>;
export async function prepareCoverArtworkInOperations(
  input: ArtworkCatalog,
  selectedPortIds: readonly string[] | undefined,
  refreshPortIds: readonly string[],
  operation: (
    ids: readonly string[] | undefined,
    refresh: readonly string[],
    gone: readonly string[],
  ) => Promise<CoverPreparation>,
): Promise<CoverPreparation> {
  const ids = selectedPortIds ?? input.ports.map((port) => port.id);
  if (ids.length <= ARTWORK_OPERATION_PORTS) return operation(selectedPortIds, refreshPortIds, []);
  const known = new Set(input.ports.map((port) => port.id));
  if (new Set(ids).size !== ids.length || ids.some((id) => !known.has(id)))
    throw new Error("Artwork worksets require unique catalog port ids.");
  if (refreshPortIds.some((id) => !ids.includes(id)))
    throw new Error("Artwork refresh names a port outside this workset.");
  // Ports outside the workset keep their unchanged input. An operation changes them
  // only by exact-image Gone fallbacks, which the final reconciliation applies to
  // every port with its fallback record and invalidated ID.
  const ports = new Map(input.ports.map((port) => [port.id, structuredClone(port)]));
  const records: CoverPreparation["records"] = [];
  const metrics = { game_queries: 0, image_queries: 0, image_bytes: 0 };
  let gone: string[] = [];
  const invalidated = new Set<string>();
  for (let start = 0; start < ids.length; start += ARTWORK_OPERATION_PORTS) {
    const batch = new Set(ids.slice(start, start + ARTWORK_OPERATION_PORTS));
    const result = await operation(
      [...batch],
      refreshPortIds.filter((id) => batch.has(id)),
      gone,
    );
    for (const port of result.catalog.ports) if (batch.has(port.id)) ports.set(port.id, port);
    records.push(...result.records.filter((record) => batch.has(record.port_id)));
    metrics.game_queries += result.metrics.game_queries;
    metrics.image_queries += result.metrics.image_queries;
    metrics.image_bytes += result.metrics.image_bytes;
    for (const id of result.workset.invalidated_port_ids) if (batch.has(id)) invalidated.add(id);
    gone = result.gone_image_ids;
  }
  const catalog = {
    ...structuredClone(input),
    ports: input.ports.map((port) => ports.get(port.id)!),
  };
  // Outside ports come from the unchanged input, so check the whole proposal as one operation does.
  assertPreparedArtwork(catalog);
  const prepared: CoverPreparation = {
    catalog,
    records,
    metrics: {
      ports: records.length,
      reused: records.filter((record) => record.reason.startsWith("accepted-mapping")).length,
      original_reused: records.filter((record) => record.reason === "accepted-original-game-reused")
        .length,
      selected: records.filter(
        (record) =>
          (record.mapping !== null || Boolean(record.collection?.length)) &&
          !record.reason.startsWith("accepted-mapping"),
      ).length,
      fallback: records.filter((record) => record.mapping === null && !record.collection?.length)
        .length,
      ...metrics,
    },
    gone_image_ids: gone,
    workset: {
      catalog_ports: input.ports.length,
      selected_port_ids: [...ids],
      invalidated_port_ids: [...invalidated].sort(),
    },
  };
  // A Gone observed by a later operation also withdraws an earlier operation's mapping.
  reconcileCatalogArtworkWithdrawals(prepared, gone);
  return prepared;
}
// Game media has no outside-workset identity check, so its operations run over
// the evolving proposal, carry exact-image Gone observations forward and relabel
// earlier records once at the end.
type GameMediaPreparation = Awaited<ReturnType<typeof prepareCatalogGameMedia>>;
export async function prepareGameMediaInOperations(
  catalog: ArtworkCatalog,
  selectedPortIds: readonly string[] | undefined,
  operation: (
    ids: readonly string[] | undefined,
    catalog: ArtworkCatalog,
    gone: string[],
    cleared: ReadonlySet<string>,
  ) => Promise<GameMediaPreparation>,
): Promise<GameMediaPreparation> {
  const ids = selectedPortIds ?? catalog.ports.map((port) => port.id);
  const cleared = new Set(
    catalog.ports.flatMap(({ id, presentation }) =>
      Array.isArray(presentation?.media) && !presentation.media.length ? [id] : [],
    ),
  );
  if (ids.length <= ARTWORK_OPERATION_PORTS)
    return operation(selectedPortIds, catalog, [], cleared);
  let media: GameMediaPreparation = { catalog, records: [], gone_media_targets: [] };
  for (let start = 0; start < ids.length; start += ARTWORK_OPERATION_PORTS) {
    const next = await operation(
      ids.slice(start, start + ARTWORK_OPERATION_PORTS),
      media.catalog,
      media.gone_media_targets,
      cleared,
    );
    media = { ...next, records: [...media.records, ...next.records] };
  }
  // As within one operation, a selected image a later operation found Gone is
  // relabelled on every earlier record; the catalog already dropped it.
  const gone = new Set(media.gone_media_targets);
  for (const record of media.records)
    if (
      record.reason !== "retained-image-withdrawn" &&
      record.image_id &&
      gone.has(gameMediaImageTarget(record.role, record.image_id))
    )
      record.reason = "selected-image-gone-later-in-batch";
  return media;
}

type SceneRole = (typeof catalogGameMediaRoles)[number];

function scopeKey(subject: CatalogMediaSubject, role: SceneRole) {
  return JSON.stringify(
    subject.kind === "port"
      ? [subject.kind, subject.port_id, role]
      : [subject.kind, subject.game_id, subject.source_edition_id, role],
  );
}

function sceneSubject(portId: string, value: unknown): CatalogMediaSubject | undefined {
  if (!isRecord(value)) return undefined;
  if (value.kind === "port" && value.port_id === portId) return { kind: "port", port_id: portId };
  if (
    value.kind === "original" &&
    typeof value.game_id === "string" &&
    typeof value.source_edition_id === "string"
  )
    return { kind: "original", game_id: value.game_id, source_edition_id: value.source_edition_id };
  return undefined;
}

function sceneRole(value: unknown): value is SceneRole {
  return catalogGameMediaRoles.some((role) => role === value);
}

function providerScope(
  port: ArtworkPort | undefined,
  subject: CatalogMediaSubject,
  role: SceneRole,
  accepted?: ArtworkPort,
): string {
  const local = scopeKey(subject, role);
  if (subject.kind === "port") return local;
  const original = port?.presentation?.original_game;
  const edition =
    isRecord(original) && original.id === subject.game_id && Array.isArray(original.source_editions)
      ? (original.source_editions as unknown[]).find(
          (item) => isRecord(item) && item.id === subject.source_edition_id,
        )
      : undefined;
  const key = originalEditionMediaKey(subject.game_id, edition);
  if (!key && accepted && accepted !== port) return providerScope(accepted, subject, role);
  return JSON.stringify([key ? "edition" : "local", key ?? port?.id, local]);
}

/** Inventory reviewed catalog rows and bounded provider observations independently of publication. */
export function sceneCoverage(
  accepted: ArtworkCatalog,
  preparation: GameMediaPreparation,
  selectedPortIds?: readonly string[],
) {
  const selected = selectedPortIds && new Set(selectedPortIds);
  const proposedPorts = new Map(preparation.catalog.ports.map((port) => [port.id, port]));
  const acceptedById = new Map(accepted.ports.map((port) => [port.id, port]));
  const ports = [
    ...accepted.ports,
    ...preparation.catalog.ports.filter(({ id }) => !acceptedById.has(id)),
  ];
  const gone = new Set(preparation.gone_media_targets);
  type Observation = GameMediaPreparation["records"][number];
  const byPort = new Map<string, Observation[]>();
  const providerGames = new Map<string, Set<number>>();
  const recordGame = (key: string, gameId: unknown) => {
    if (!positiveId(gameId)) return;
    const ids = providerGames.get(key) ?? new Set<number>();
    ids.add(gameId);
    providerGames.set(key, ids);
  };
  for (const observation of preparation.records) {
    if (!sceneRole(observation.role)) continue;
    const observations = byPort.get(observation.port_id) ?? [];
    observations.push(observation);
    byPort.set(observation.port_id, observations);
    recordGame(
      providerScope(
        proposedPorts.get(observation.port_id),
        observation.subject,
        observation.role,
        acceptedById.get(observation.port_id),
      ),
      observation.provider_game_id,
    );
  }
  const inventory = (catalog: ArtworkCatalog) =>
    new Map(
      catalog.ports.map((port) => {
        const assets = [];
        const media: unknown = port.presentation?.media;
        if (Array.isArray(media))
          for (const asset of media) {
            if (!isRecord(asset) || !sceneRole(asset.role)) continue;
            const subject = sceneSubject(port.id, asset.subject);
            if (!subject || !matchesString(hashPattern, asset.sha256)) continue;
            const igdb = isRecord(asset.igdb) ? asset.igdb : undefined;
            const imageId =
              igdb && matchesString(imagePattern, igdb.image_id) ? igdb.image_id : null;
            const catalogId = typeof asset.id === "string" ? asset.id : null;
            if (!imageId && (asset.igdb != null || !catalogId)) continue;
            assets.push({
              subject,
              role: asset.role,
              scope: scopeKey(subject, asset.role),
              providerScope: providerScope(port, subject, asset.role),
              imageId,
              catalogId,
              sha256: asset.sha256,
              gameId: igdb?.game_id,
            });
          }
        return [port.id, assets] as const;
      }),
    );
  const acceptedMedia = inventory(accepted);
  const proposedMedia = inventory(preparation.catalog);
  for (const entries of [...acceptedMedia.values(), ...proposedMedia.values()]) {
    for (const entry of entries) {
      if (!entry.imageId || !gone.has(gameMediaImageTarget(entry.role, entry.imageId)))
        recordGame(entry.providerScope, entry.gameId);
    }
  }
  return ports
    .filter(({ id }) => !selected || selected.has(id))
    .flatMap((port) => {
      const observations = byPort.get(port.id) ?? [];
      const subjects = new Map<string, CatalogMediaSubject>();
      const add = (subject: CatalogMediaSubject) =>
        subjects.set(scopeKey(subject, "header"), subject);
      add({ kind: "port", port_id: port.id });
      const addEditions = (entry: ArtworkPort | undefined) => {
        const original = entry?.presentation?.original_game;
        if (
          !isRecord(original) ||
          typeof original.id !== "string" ||
          !Array.isArray(original.source_editions)
        )
          return;
        for (const edition of original.source_editions) {
          if (isRecord(edition) && typeof edition.id === "string")
            add({ kind: "original", game_id: original.id, source_edition_id: edition.id });
        }
      };
      addEditions(port);
      addEditions(proposedPorts.get(port.id));
      for (const asset of [
        ...(acceptedMedia.get(port.id) ?? []),
        ...(proposedMedia.get(port.id) ?? []),
      ])
        add(asset.subject);
      for (const observation of observations) add(observation.subject);
      return [...subjects.values()].flatMap((subject) =>
        catalogGameMediaRoles.map((role) => {
          const withdrawnImage = (id: string) => gone.has(gameMediaImageTarget(role, id));
          const key = scopeKey(subject, role);
          const exactScope = providerScope(proposedPorts.get(port.id), subject, role, port);
          const currentImages = (acceptedMedia.get(port.id) ?? []).filter(
            (asset) => asset.scope === key && asset.providerScope === exactScope,
          );
          const proposedImages = (proposedMedia.get(port.id) ?? []).filter(
            (asset) => asset.scope === key && asset.providerScope === exactScope,
          );
          const admitted = currentImages.filter(
            ({ imageId }) => !imageId || !withdrawnImage(imageId),
          );
          const proposed = proposedImages.filter(
            ({ imageId, catalogId, sha256 }) =>
              (!imageId || !withdrawnImage(imageId)) &&
              !admitted.some(
                (asset) =>
                  asset.sha256 === sha256 &&
                  (imageId
                    ? asset.imageId === imageId
                    : asset.imageId === null && asset.catalogId === catalogId),
              ),
          );
          const observed = observations.filter(
            (item) => item.role === role && scopeKey(item.subject, role) === key,
          );
          const withdrawn = [
            ...new Set([
              ...currentImages.flatMap(({ imageId }) =>
                imageId && withdrawnImage(imageId) ? [imageId] : [],
              ),
              ...observed.flatMap(({ image_id }) =>
                image_id && withdrawnImage(image_id) ? [image_id] : [],
              ),
              ...observed.flatMap(({ withdrawn_image_ids }) =>
                (withdrawn_image_ids ?? []).filter(withdrawnImage),
              ),
            ]),
          ];
          const knownGames = providerGames.get(exactScope) ?? new Set<number>();
          const reasons = [...new Set(observed.map(({ reason }) => reason))].sort();
          if (!reasons.length)
            reasons.push(
              proposedPorts.has(port.id)
                ? "no-exact-provider-observation"
                : "outside-proposal-input",
            );
          const state =
            knownGames.size > 1 || reasons.includes("identity-ambiguous")
              ? "conflicting"
              : admitted.length
                ? "admitted"
                : proposed.length
                  ? "proposed"
                  : withdrawn.length
                    ? "withdrawn"
                    : reasons.length === 1 && reasons[0] === "provider-role-empty"
                      ? "missing"
                      : "unknown";
          return {
            port_id: port.id,
            subject,
            role,
            provider: "igdb",
            provider_game_ids: [...knownGames].sort((a, b) => a - b),
            state,
            admitted_image_ids: [
              ...new Set(admitted.flatMap(({ imageId }) => (imageId ? [imageId] : []))),
            ].sort(),
            proposed_image_ids: [
              ...new Set(proposed.flatMap(({ imageId }) => (imageId ? [imageId] : []))),
            ].sort(),
            admitted_catalog_asset_ids: [
              ...new Set(admitted.flatMap(({ catalogId }) => (catalogId ? [catalogId] : []))),
            ].sort(),
            proposed_catalog_asset_ids: [
              ...new Set(proposed.flatMap(({ catalogId }) => (catalogId ? [catalogId] : []))),
            ].sort(),
            withdrawn_image_ids: withdrawn.sort(),
            reasons,
          };
        }),
      );
    });
}
