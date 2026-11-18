import {
  assertPreparedArtwork,
  reconcileCatalogArtworkWithdrawals,
} from "./inspect-igdb-artwork.mts";
import type {
  ArtworkCatalog,
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
  knownGoneImageIds: string[],
  operation: (
    ids: readonly string[] | undefined,
    catalog: ArtworkCatalog,
    gone: string[],
  ) => Promise<GameMediaPreparation>,
): Promise<GameMediaPreparation> {
  const ids = selectedPortIds ?? catalog.ports.map((port) => port.id);
  if (ids.length <= ARTWORK_OPERATION_PORTS)
    return operation(selectedPortIds, catalog, knownGoneImageIds);
  let media: GameMediaPreparation = { catalog, records: [], gone_image_ids: knownGoneImageIds };
  for (let start = 0; start < ids.length; start += ARTWORK_OPERATION_PORTS) {
    const next = await operation(
      ids.slice(start, start + ARTWORK_OPERATION_PORTS),
      media.catalog,
      media.gone_image_ids,
    );
    media = { ...next, records: [...media.records, ...next.records] };
  }
  // As within one operation, a selected image a later operation found Gone is
  // relabelled on every earlier record; the catalog already dropped it.
  const gone = new Set(media.gone_image_ids);
  for (const record of media.records)
    if (record.image_id && gone.has(record.image_id))
      record.reason = "selected-image-gone-later-in-batch";
  return media;
}
