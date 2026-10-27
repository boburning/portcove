import { lstatSync, writeFileSync, renameSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { isRecord, errorCode } from "./runtime-values.mts";
import { observationHash } from "./upstream-observer.mts";
import {
  prepareCatalogArtwork,
  artworkPreparationInput,
  ArtworkBatchExhausted,
  readArtworkJson,
  validArtworkMapping,
} from "./inspect-igdb-artwork.mts";
import type {
  ArtworkCatalog,
  ArtworkPort,
  ArtworkRecord,
  ArtworkPreparationOptions,
  ArtworkMetrics,
} from "./inspect-igdb-artwork.mts";

type Inspector = Pick<ArtworkPreparationOptions, "inspectGame" | "inspectImage"> & {
  beginBatch?: () => void;
  batchStatus?: () => {
    deadline: number;
    retry_at: string | null;
    metadata_retry_at?: string | null;
    image_retry_at?: string | null;
  };
  restoreProviderBackoff?: (metadata: number, image: number) => void;
};
interface ItemResult {
  port: ArtworkPort;
  record: ArtworkRecord;
}
interface ItemState {
  format: 1;
  port_id: string;
  input_sha256: string;
  result_sha256: string;
  result: ItemResult;
  complete: boolean;
  observed_at: string;
  last_live_observation_at: string | null;
  retry_at: string | null;
}
const stateBytes = 8 * 1024 * 1024;
const refreshMs = 28 * 24 * 60 * 60 * 1000;
const safeId = (id: string) => /^[a-z0-9][a-z0-9-]{0,127}$/u.test(id);
function readOwned(root: string, name: string): unknown {
  const filename = join(root, name);
  try {
    const metadata = lstatSync(filename);
    if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.nlink !== 1)
      throw new Error("Artwork continuation requires an owned unlinked regular file");
    return readArtworkJson(filename, stateBytes);
  } catch (error) {
    if (errorCode(error) === "ENOENT") return null;
    throw error;
  }
}
function replaceOwned(root: string, name: string, value: unknown) {
  const filename = join(root, name);
  readOwned(root, name);
  const bytes = JSON.stringify(value);
  if (Buffer.byteLength(bytes) > stateBytes)
    throw new Error("Artwork continuation exceeds its physical byte envelope");
  const receipt = join(root, `artwork-attempt-${observationHash(value)}.json`);
  try {
    writeFileSync(receipt, bytes, { flag: "wx", mode: 0o600 });
  } catch (error) {
    if (
      errorCode(error) !== "EEXIST" ||
      JSON.stringify(readOwned(root, `artwork-attempt-${observationHash(value)}.json`)) !== bytes
    )
      throw error;
  }
  const temporary = `${filename}.${randomUUID()}.next`;
  writeFileSync(temporary, bytes, { flag: "wx", mode: 0o600 });
  renameSync(temporary, filename);
}
function itemState(root: string, id: string, now: number): ItemState | null {
  if (!safeId(id)) throw new Error("Artwork continuation requires a stable port identity");
  const value = readOwned(root, `artwork-progress-${id}.json`);
  if (value === null) return null;
  if (
    !isRecord(value) ||
    value.format !== 1 ||
    value.port_id !== id ||
    typeof value.input_sha256 !== "string" ||
    !/^[a-f0-9]{64}$/u.test(value.input_sha256) ||
    !isRecord(value.result) ||
    !isRecord(value.result.port) ||
    value.result.port.id !== id ||
    !isRecord(value.result.record) ||
    value.result.record.port_id !== id ||
    value.result_sha256 !== observationHash(value.result) ||
    typeof value.complete !== "boolean" ||
    typeof value.observed_at !== "string" ||
    !Number.isFinite(Date.parse(value.observed_at)) ||
    Date.parse(value.observed_at) > now ||
    (value.last_live_observation_at !== null &&
      (typeof value.last_live_observation_at !== "string" ||
        !Number.isFinite(Date.parse(value.last_live_observation_at)) ||
        Date.parse(value.last_live_observation_at) > Date.parse(value.observed_at))) ||
    (value.retry_at !== null &&
      (typeof value.retry_at !== "string" || !Number.isFinite(Date.parse(value.retry_at))))
  )
    throw new Error(
      "Artwork continuation identity, facts or clocks differ; preserve it for reconciliation",
    );
  const mapping = value.result.record.mapping;
  if (
    value.result.record.role !== "cover" ||
    !Array.isArray(value.result.record.exceptions) ||
    (mapping !== null && !validArtworkMapping(mapping)) ||
    JSON.stringify(mapping ?? null) !==
      JSON.stringify(
        isRecord(value.result.port.presentation)
          ? (value.result.port.presentation.artwork ?? null)
          : null,
      )
  )
    throw new Error("Artwork continuation mapping differs from its checked record");
  return value as unknown as ItemState;
}
const mappingImage = (port: ArtworkPort) =>
  isRecord(port.presentation?.artwork) && typeof port.presentation.artwork.image_id === "string"
    ? port.presentation.artwork.image_id
    : null;
const budgetDeferred = (record: ArtworkRecord) =>
  record.exceptions.some((exception) =>
    /^batch-(?:query|image|provider)-budget-exhausted$/u.test(exception.reason),
  );
const finished = (record: ArtworkRecord, gone: ReadonlySet<string>) =>
  record.mapping !== null &&
  !gone.has(record.mapping.image_id) &&
  record.reason !== "accepted-mapping-retained-after-unavailable-refresh";

/** Bounded serialized metadata cache; completed per-ID results remain the durable authority. */
function memoInspector(inspector: Inspector, now: () => number) {
  const entries = new Map<string, { value: Promise<unknown>; bytes: number; observedAt: number }>();
  let bytes = 0;
  const metrics = { game_queries: 0, image_queries: 0, image_bytes: 0 };
  const memo = (key: string, operation: () => unknown) => {
    const existing = entries.get(key);
    if (existing) {
      entries.delete(key);
      entries.set(key, existing);
      return existing.value;
    }
    const entry = {
      value: Promise.resolve().then(operation),
      bytes: Buffer.byteLength(key) + 128,
      observedAt: now(),
    };
    entries.set(key, entry);
    bytes += entry.bytes;
    entry.value = entry.value.then(
      (value: unknown) => {
        let serialized: string;
        try {
          serialized = JSON.stringify(value) ?? "null";
        } catch {
          entries.delete(key);
          bytes -= entry.bytes;
          return value;
        }
        if (entries.get(key) === entry) {
          const growth = Buffer.byteLength(serialized);
          entry.bytes += growth;
          bytes += growth;
        }
        while (bytes > 32 * 1024 * 1024 && entries.size) {
          const first = entries.entries().next().value!;
          entries.delete(first[0]);
          bytes -= first[1].bytes;
        }
        return value;
      },
      (error: unknown) => {
        if (error instanceof ArtworkBatchExhausted && entries.get(key) === entry) {
          entries.delete(key);
          bytes -= entry.bytes;
        }
        throw error;
      },
    );
    return entry.value;
  };
  return {
    metrics,
    observationClock(record: ArtworkRecord) {
      if (
        !record.checks ||
        !("identity" in record.checks) ||
        !("content" in record.checks) ||
        !record.mapping
      )
        return null;
      const game = entries.get(`game:${JSON.stringify(record.checks.identity)}`);
      const image = entries.get(`image:${record.mapping.image_id}`);
      return game && image
        ? new Date(Math.min(game.observedAt, image.observedAt)).toISOString()
        : null;
    },
    options: {
      inspectGame: (identity: unknown) =>
        memo(`game:${JSON.stringify(identity)}`, () => {
          metrics.game_queries++;
          if (!inspector.inspectGame) throw new Error("Artwork identity inspector unavailable");
          return inspector.inspectGame(
            identity as Parameters<NonNullable<Inspector["inspectGame"]>>[0],
          );
        }),
      inspectImage: (id: string, remaining: number) =>
        memo(`image:${id}`, async () => {
          metrics.image_queries++;
          if (!inspector.inspectImage) throw new Error("Artwork image inspector unavailable");
          const value: unknown = await inspector.inspectImage(id, remaining);
          if (isRecord(value) && typeof value.bytes === "number")
            metrics.image_bytes += value.bytes;
          return value;
        }),
    },
  };
}

/** The caller owns the existing prepare-port checkpoint lock for this entire logical workset. */
export async function prepareArtworkWorkset(
  catalog: ArtworkCatalog,
  options: {
    root: string;
    inspector: Inspector;
    identities: unknown;
    validatorIdentity: string | null;
    selectedPortIds?: readonly string[];
    refreshPortIds?: readonly string[];
    maintenance?: boolean;
    now?: () => number;
    signal?: AbortSignal;
    onProgress?: (id: string) => void | Promise<void>;
  },
) {
  const now = options.now ?? Date.now;
  const providerAdmission = readOwned(options.root, "artwork-provider-admission.json");
  if (providerAdmission !== null) {
    if (
      !isRecord(providerAdmission) ||
      providerAdmission.format !== 1 ||
      [providerAdmission.metadata_retry_at, providerAdmission.image_retry_at].some(
        (value) =>
          value !== null && (typeof value !== "string" || !Number.isFinite(Date.parse(value))),
      )
    )
      throw new Error("Invalid durable artwork provider backoff");
    options.inspector.restoreProviderBackoff?.(
      typeof providerAdmission.metadata_retry_at === "string"
        ? Date.parse(providerAdmission.metadata_retry_at)
        : 0,
      typeof providerAdmission.image_retry_at === "string"
        ? Date.parse(providerAdmission.image_retry_at)
        : 0,
    );
  }
  const ports = new Map(catalog.ports.map((port) => [port.id, port]));
  const inspectedIds = options.maintenance
    ? catalog.ports.map((port) => port.id)
    : [...(options.selectedPortIds ?? [])];
  if (
    new Set(inspectedIds).size !== inspectedIds.length ||
    inspectedIds.some((id) => !ports.has(id))
  )
    throw new Error("Artwork work requires unique known identities");
  const states = new Map(inspectedIds.map((id) => [id, itemState(options.root, id, now())]));
  const goneDocument = readOwned(options.root, "artwork-gone.json");
  if (
    goneDocument !== null &&
    (!isRecord(goneDocument) ||
      goneDocument.format !== 1 ||
      !Array.isArray(goneDocument.image_ids) ||
      goneDocument.sha256 !== observationHash(goneDocument.image_ids) ||
      goneDocument.image_ids.some(
        (id: unknown) => typeof id !== "string" || !/^[A-Za-z0-9_]{1,128}$/u.test(id),
      ))
  )
    throw new Error("Invalid retained exact-image Gone observations");
  const gone = new Set<string>(isRecord(goneDocument) ? (goneDocument.image_ids as string[]) : []);
  const baseKey = (id: string, refresh: boolean) =>
    observationHash({
      input: artworkPreparationInput(ports.get(id)!, catalog, options.identities),
      refresh,
      validator: options.validatorIdentity,
    });
  const explicitRefresh = new Set(options.refreshPortIds ?? []);
  const due = (id: string) => {
    const state = states.get(id);
    const image = mappingImage(
      state?.input_sha256 === baseKey(id, true) ? state.result.port : ports.get(id)!,
    );
    return (
      !image ||
      gone.has(image) ||
      !state ||
      state.input_sha256 !== baseKey(id, true) ||
      !state.last_live_observation_at ||
      now() - Date.parse(state.last_live_observation_at) >= refreshMs
    );
  };
  const selected = options.maintenance
    ? catalog.ports
        .filter((port) => due(port.id))
        .map((port) => port.id)
        .sort(
          (a, b) =>
            Number(mappingImage(ports.get(a)!) !== null) -
              Number(mappingImage(ports.get(b)!) !== null) ||
            Date.parse(states.get(a)?.last_live_observation_at ?? "1970-01-01") -
              Date.parse(states.get(b)?.last_live_observation_at ?? "1970-01-01") ||
            a.localeCompare(b),
        )
    : [...(options.selectedPortIds ?? [])];
  if (
    new Set(selected).size !== selected.length ||
    selected.some((id) => !ports.has(id)) ||
    [...explicitRefresh].some((id) => !selected.includes(id))
  )
    throw new Error("Artwork work requires unique known identities and a matching refresh scope");
  const records = new Map<string, ArtworkRecord>();
  const output = structuredClone(catalog);
  const outputPorts = new Map(output.ports.map((port) => [port.id, port]));
  const refresh = (id: string) =>
    options.maintenance === true ||
    explicitRefresh.has(id) ||
    gone.has(mappingImage(ports.get(id)!) ?? "");
  const apply = (id: string, result: ItemResult) => {
    outputPorts.set(id, structuredClone(result.port));
    records.set(id, structuredClone(result.record));
  };
  const queue: string[] = [];
  let cacheHits = 0;
  const carried: string[] = [];
  if (options.maintenance) {
    const dueIds = new Set(selected);
    for (const id of inspectedIds) {
      const state = states.get(id);
      if (
        !dueIds.has(id) &&
        state?.input_sha256 === baseKey(id, true) &&
        state.complete &&
        finished(state.result.record, gone) &&
        state.last_live_observation_at !== null &&
        now() - Date.parse(state.last_live_observation_at) < refreshMs
      ) {
        apply(id, state.result);
        carried.push(id);
        cacheHits++;
      }
    }
  }
  for (const id of selected) {
    const state = states.get(id);
    if (
      state?.input_sha256 === baseKey(id, refresh(id)) &&
      state.complete &&
      finished(state.result.record, gone) &&
      (!options.maintenance ||
        (state.last_live_observation_at !== null &&
          now() - Date.parse(state.last_live_observation_at) < refreshMs))
    ) {
      apply(id, state.result);
      cacheHits++;
    } else if (
      state?.input_sha256 === baseKey(id, refresh(id)) &&
      state.retry_at &&
      Date.parse(state.retry_at) > now()
    )
      apply(id, state.result);
    else queue.push(id);
  }
  const memo = memoInspector(options.inspector, now);
  let batches = 0;
  let admission = 400;
  while (queue.length) {
    options.signal?.throwIfAborted();
    const batch = queue.splice(0, admission);
    const started = now();
    options.inspector.beginBatch?.();
    batches++;
    const result = await prepareCatalogArtwork(catalog, {
      acceptedCatalog: catalog,
      selectedPortIds: batch,
      refreshPortIds: batch.filter(refresh),
      identities: options.identities,
      ...memo.options,
      ...(options.signal ? { signal: options.signal } : {}),
      knownGoneImageIds: [...gone],
      onRecord: async (record, port, currentGone) => {
        gone.clear();
        for (const id of currentGone) gone.add(id);
        replaceOwned(options.root, "artwork-gone.json", {
          format: 1,
          image_ids: [...gone].sort((a, b) => a.localeCompare(b)),
          sha256: observationHash([...gone].sort((a, b) => a.localeCompare(b))),
        });
        const providerStatus = options.inspector.batchStatus?.();
        if (
          providerStatus &&
          (Object.hasOwn(providerStatus, "metadata_retry_at") ||
            Object.hasOwn(providerStatus, "image_retry_at"))
        )
          replaceOwned(options.root, "artwork-provider-admission.json", {
            format: 1,
            metadata_retry_at: providerStatus.metadata_retry_at ?? null,
            image_retry_at: providerStatus.image_retry_at ?? null,
          });
        const value = { port, record };
        const complete = finished(record, gone);
        const live = complete && isRecord(record.checks) && Object.hasOwn(record.checks, "content");
        const state: ItemState = {
          format: 1,
          port_id: record.port_id,
          input_sha256: baseKey(record.port_id, refresh(record.port_id)),
          result_sha256: observationHash(value),
          result: value,
          complete,
          observed_at: new Date(now()).toISOString(),
          last_live_observation_at: live ? memo.observationClock(record) : null,
          retry_at: providerStatus?.retry_at ?? null,
        };
        replaceOwned(options.root, `artwork-progress-${record.port_id}.json`, state);
        states.set(record.port_id, state);
        apply(record.port_id, value);
        await options.onProgress?.(record.port_id);
      },
    });
    for (const record of result.records)
      apply(record.port_id, {
        record,
        port: result.catalog.ports.find((port) => port.id === record.port_id)!,
      });
    const elapsed = Math.max(1, now() - started);
    const count = Math.max(1, batch.length);
    const capacity = (limit: number, used: number) =>
      used > 0 ? Math.floor((limit * count) / used) : 400;
    admission = Math.max(
      1,
      Math.min(
        400,
        capacity(15 * 60 * 1000, elapsed),
        capacity(800, result.metrics.game_queries),
        capacity(400, result.metrics.image_queries),
        capacity(512 * 1024 * 1024, result.metrics.image_bytes),
      ),
    );
    const deferred = result.records
      .filter((record) => !finished(record, gone) && budgetDeferred(record))
      .map((record) => record.port_id);
    // An unproductive provider batch remains pending; later offline or unrelated work still runs.
    // Only requeue when this operation completed other work, never merely because a request failed.
    if (deferred.length < batch.length) queue.push(...deferred);
  }
  const invalidated: string[] = [];
  for (const port of outputPorts.values()) {
    const image = mappingImage(port);
    if (!image || !gone.has(image)) continue;
    if (port.presentation) delete port.presentation.artwork;
    invalidated.push(port.id);
    const record = records.get(port.id);
    if (record) {
      record.mapping = null;
      record.reason = "generated-fallback";
      record.checks = null;
      record.exceptions.push({
        kind: "port",
        reason: "image-gone",
        image_id: image,
        http_status: 410,
        resume:
          "Reassess this exact provider image or supply a verified replacement; no legal withdrawal is inferred.",
      });
    }
  }
  output.ports = catalog.ports.map((port) => outputPorts.get(port.id)!);
  const values = [...records.values()];
  const metrics: ArtworkMetrics = {
    ports: values.length,
    reused: values.filter((record) => record.reason.startsWith("accepted-mapping")).length,
    original_reused: values.filter((record) => record.reason === "accepted-original-game-reused")
      .length,
    selected: values.filter(
      (record) => record.mapping !== null && !record.reason.startsWith("accepted-mapping"),
    ).length,
    fallback: values.filter((record) => record.mapping === null).length,
    ...memo.metrics,
  };
  return {
    catalog: output,
    records: values,
    metrics,
    workset: {
      catalog_ports: catalog.ports.length,
      selected_port_ids: selected,
      carried_port_ids: carried,
      invalidated_port_ids: invalidated,
    },
    continuation: {
      batches,
      completed_cache_hits: cacheHits,
      complete: selected.every((id) => records.has(id) && finished(records.get(id)!, gone)),
      pending_port_ids: selected.filter(
        (id) => !records.has(id) || !finished(records.get(id)!, gone),
      ),
    },
    reused: batches === 0 && cacheHits === records.size,
  };
}
