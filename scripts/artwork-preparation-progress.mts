import { lstatSync, mkdirSync, readFileSync, writeFileSync, renameSync } from "node:fs";
import { join } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { isRecord, errorCode } from "./runtime-values.mts";
import { observationHash } from "./upstream-observer.mts";
import {
  prepareCatalogArtwork,
  artworkPreparationInputs,
  ArtworkBatchExhausted,
  readArtworkJson,
  validArtworkMapping,
  withdrawCompanionCover,
  collectionCovers,
  withdrawCollectionCovers,
} from "./inspect-igdb-artwork.mts";
import type {
  ArtworkCatalog,
  ArtworkPort,
  ArtworkRecord,
  ArtworkPreparationOptions,
  ArtworkMetrics,
  prepareCatalogGameMedia,
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
const currentLiveObservation = (state: ItemState, now: number) =>
  state.last_live_observation_at !== null &&
  now - Date.parse(state.last_live_observation_at) < refreshMs;
const safeId = (id: string) => /^[a-z0-9][a-z0-9-]{0,127}$/u.test(id);

const checkpointOwner = { format_version: 1, tool: "portcove-prepare-port" };

export function openArtworkCheckpoint(directory: string) {
  try {
    mkdirSync(directory);
    writeFileSync(join(directory, "owner.json"), JSON.stringify(checkpointOwner), { flag: "wx" });
  } catch (error) {
    if (errorCode(error) !== "EEXIST") throw error;
  }
  const info = lstatSync(directory);
  if (
    !info.isDirectory() ||
    info.isSymbolicLink() ||
    observationHash(readOwned(directory, "owner.json")) !== observationHash(checkpointOwner)
  )
    throw new Error("Output directory is not a recognized preparation checkpoint.");
  mkdirSync(join(directory, "active.lock"));
}
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

export function readKnownGoneArtwork(root: string) {
  const document = readOwned(root, "artwork-gone.json");
  if (
    document !== null &&
    (!isRecord(document) ||
      document.format !== 1 ||
      !Array.isArray(document.image_ids) ||
      document.sha256 !== observationHash(document.image_ids) ||
      document.image_ids.some(
        (id: unknown) => typeof id !== "string" || !/^[A-Za-z0-9_]{1,128}$/u.test(id),
      ))
  )
    throw new Error("Invalid retained exact-image Gone observations");
  return new Set<string>(isRecord(document) ? (document.image_ids as string[]) : []);
}

export function restoreArtworkProviderBackoff(root: string, inspector: Inspector) {
  const prior = readOwned(root, "artwork-provider-admission.json");
  if (prior === null) return;
  if (
    !isRecord(prior) ||
    prior.format !== 1 ||
    [prior.metadata_retry_at, prior.image_retry_at].some(
      (value) =>
        value !== null && (typeof value !== "string" || !Number.isFinite(Date.parse(value))),
    )
  )
    throw new Error("Invalid durable artwork provider backoff");
  inspector.restoreProviderBackoff?.(
    typeof prior.metadata_retry_at === "string" ? Date.parse(prior.metadata_retry_at) : 0,
    typeof prior.image_retry_at === "string" ? Date.parse(prior.image_retry_at) : 0,
  );
}

export function retainArtworkProviderBackoff(
  root: string,
  status:
    | Pick<
        ReturnType<NonNullable<Inspector["batchStatus"]>>,
        "metadata_retry_at" | "image_retry_at"
      >
    | undefined,
) {
  if (
    status &&
    (Object.hasOwn(status, "metadata_retry_at") || Object.hasOwn(status, "image_retry_at"))
  )
    replaceOwned(root, "artwork-provider-admission.json", {
      format: 1,
      metadata_retry_at: status.metadata_retry_at ?? null,
      image_retry_at: status.image_retry_at ?? null,
    });
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
/** Save the round once and advance a small cursor between bounded passes. A
 * newly due identity joins the next round without displacing retained work. */
function boundedArtworkDuePass(
  root: string,
  dueIds: readonly string[],
  runnable: ReadonlySet<string>,
  limit: number,
  kind: "artwork" | "game-media" = "artwork",
) {
  const artworkDueRoundName = `${kind}-due-round.json`;
  const value = readOwned(root, artworkDueRoundName);
  let round: { format: 1; ids_sha256: string; next: number } | undefined;
  let ids: string[] = [];
  if (value !== null) {
    if (
      !isRecord(value) ||
      value.format !== 1 ||
      typeof value.ids_sha256 !== "string" ||
      !/^[a-f0-9]{64}$/u.test(value.ids_sha256) ||
      typeof value.next !== "number" ||
      !Number.isSafeInteger(value.next) ||
      value.next < 0
    )
      throw new Error("Invalid retained artwork due cursor");
    const cursorHash = observationHash(value);
    const cursorReceipt = readOwned(root, `artwork-attempt-${cursorHash}.json`);
    if (cursorReceipt === null || observationHash(cursorReceipt) !== cursorHash)
      throw new Error("Retained artwork due cursor does not match its receipt");
    const saved = readOwned(root, `${kind}-due-ids-${value.ids_sha256}.json`);
    if (
      !Array.isArray(saved) ||
      saved.some((id: unknown) => typeof id !== "string" || !safeId(id)) ||
      new Set(saved).size !== saved.length ||
      observationHash(saved) !== value.ids_sha256 ||
      value.next > saved.length
    )
      throw new Error("Invalid retained artwork due workset");
    ids = saved as string[];
    round = { format: 1, ids_sha256: value.ids_sha256, next: value.next };
  }
  if (!round || round.next === ids.length) {
    if (runnable.size === 0) return { selected: [], finish() {} };
    ids = [...dueIds];
    const ids_sha256 = observationHash(ids);
    replaceOwned(root, `${kind}-due-ids-${ids_sha256}.json`, ids);
    round = { format: 1, ids_sha256, next: 0 };
    replaceOwned(root, artworkDueRoundName, round);
  }
  const active = round;
  const selected: string[] = [];
  let next = active.next;
  while (next < ids.length && selected.length < limit) {
    const id = ids[next++]!;
    if (runnable.has(id)) selected.push(id);
  }
  if (!selected.length && next === ids.length && dueIds.some((id) => runnable.has(id))) {
    replaceOwned(root, artworkDueRoundName, { ...active, next });
    return boundedArtworkDuePass(root, dueIds, runnable, limit, kind);
  }
  return {
    selected,
    finish() {
      if (next !== active.next) replaceOwned(root, artworkDueRoundName, { ...active, next });
    },
  };
}

const dayMs = 24 * 60 * 60 * 1000;
type MediaObservation = Awaited<ReturnType<typeof prepareCatalogGameMedia>>["records"][number];

export function planDueGameMedia(
  root: string,
  candidates: readonly { id: string; input_sha256: string }[],
  limit: number,
  now = Date.now(),
) {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 400)
    throw new Error("Bounded game media requires a limit from 1 through 400");
  const inputs = new Map(candidates.map(({ id, input_sha256 }) => [id, input_sha256]));
  if (inputs.size !== candidates.length) throw new Error("Duplicate game media work identity");
  const progressName = (id: string) => `game-media-progress-${id}.json`;
  const previous = new Map<
    string,
    { lastAttempt: string | null; successful: Record<string, unknown> }
  >();
  const due = [];
  for (const [id, input] of inputs) {
    if (!safeId(id) || !/^[a-f0-9]{64}$/u.test(input))
      throw new Error("Invalid game media work identity");
    const prior = readOwned(root, progressName(id));
    if (prior === null) {
      due.push({ id, attempted: 0 });
      continue;
    }
    if (
      !isRecord(prior) ||
      prior.format !== 1 ||
      prior.port_id !== id ||
      typeof prior.input_sha256 !== "string" ||
      !/^[a-f0-9]{64}$/u.test(prior.input_sha256) ||
      typeof prior.next_due !== "string" ||
      !Number.isFinite(Date.parse(prior.next_due)) ||
      !isRecord(prior.successful) ||
      Object.values(prior.successful).some(
        (value) => typeof value !== "string" || !Number.isFinite(Date.parse(value)),
      ) ||
      (prior.last_attempt !== null &&
        (typeof prior.last_attempt !== "string" ||
          !Number.isFinite(Date.parse(prior.last_attempt))))
    )
      throw new Error("Invalid game media progress receipt");
    const priorHash = observationHash(prior);
    const retained = readOwned(root, `artwork-attempt-${priorHash}.json`);
    if (retained === null || observationHash(retained) !== priorHash)
      throw new Error("Game media progress does not match its retained receipt");
    previous.set(id, {
      lastAttempt: prior.last_attempt,
      successful: prior.input_sha256 === input ? prior.successful : {},
    });
    if (prior.input_sha256 !== input || Date.parse(prior.next_due) <= now)
      due.push({ id, attempted: prior.last_attempt === null ? 0 : Date.parse(prior.last_attempt) });
  }
  due.sort((a, b) => a.attempted - b.attempted || a.id.localeCompare(b.id, "en"));
  const dueIds = due.map(({ id }) => id);
  const pass = boundedArtworkDuePass(root, dueIds, new Set(dueIds), limit, "game-media");
  return {
    selected: pass.selected,
    due: dueIds.length,
    finish(
      records: readonly MediaObservation[],
      retryAt: string | null,
      receipt: string,
      finished = Date.now(),
    ) {
      const byPort = new Map<string, MediaObservation[]>();
      for (const record of records) {
        const old = byPort.get(record.port_id) ?? [];
        old.push(record);
        byPort.set(record.port_id, old);
      }
      let attempted = 0;
      let deferred = 0;
      const observedAt = new Date(finished).toISOString();
      const retry = retryAt ? Date.parse(retryAt) : 0;
      if (!Number.isFinite(retry)) throw new Error("Invalid game media provider retry time");
      for (const id of pass.selected) {
        const results = byPort.get(id) ?? [];
        const observed = results.some(
          ({ reason }) =>
            reason !== "batch-provider-budget-exhausted" &&
            reason !== "identity-provider-unavailable" &&
            reason !== "media-provider-unavailable-or-incomplete" &&
            reason !== "existing-scene-retained" &&
            reason !== "scene-role-capacity",
        );
        const transient = results.some(({ reason }) => /unavailable|incomplete/u.test(reason));
        const blocked =
          !results.length ||
          (!observed && transient) ||
          results.some(({ reason }) => reason === "batch-provider-budget-exhausted");
        if (observed) attempted++;
        if (blocked) deferred++;
        const next = blocked || transient ? dayMs : refreshMs;
        const prior = previous.get(id);
        const successful = { ...prior?.successful };
        for (const { subject, role, reason } of results)
          if (reason === "role-selected" || reason === "retained-image-verified")
            successful[observationHash([subject, role])] = observedAt;
        replaceOwned(root, progressName(id), {
          format: 1,
          port_id: id,
          input_sha256: inputs.get(id),
          last_attempt: observed ? observedAt : (prior?.lastAttempt ?? null),
          next_due: new Date(
            blocked && retry > finished ? retry : Math.max(finished + next, retry),
          ).toISOString(),
          deferred: blocked,
          successful,
          roles: results,
          receipt,
        });
      }
      pass.finish();
      return { attempted, deferred };
    },
  };
}

function itemStateName(id: string, refresh: boolean, maintenance: boolean) {
  const kind = maintenance ? "maintenance-" : refresh ? "refresh-" : "";
  return `artwork-${kind}progress-${id}.json`;
}

export function retainedCoverDigests(root: string, portIds: readonly string[], now: number) {
  const observed = new Map<string, { at: number; digest: string | null }>();
  const retain = (id: string, at: number, digest: string | null) => {
    const previous = observed.get(id);
    if (!previous || at > previous.at) observed.set(id, { at, digest });
    else if (at === previous.at && previous.digest !== digest)
      observed.set(id, { at, digest: null });
  };
  for (const id of portIds) {
    for (const [refresh, maintenance] of [
      [false, false],
      [true, false],
      [true, true],
    ] as const) {
      const state = itemState(root, id, now, refresh, maintenance);
      if (!state) continue;
      const { mapping, checks, exceptions } = state.result.record;
      for (const issue of exceptions) {
        if (
          isRecord(issue) &&
          (issue.reason === "collection-image-digest-changed" ||
            issue.reason === "companion-image-digest-changed") &&
          typeof issue.image_id === "string" &&
          /^[A-Za-z0-9_]{1,128}$/u.test(issue.image_id)
        )
          retain(issue.image_id, Date.parse(state.observed_at), null);
      }
      if (
        !state.complete ||
        !state.last_live_observation_at ||
        !mapping ||
        !validArtworkMapping(mapping) ||
        !checks ||
        !("content" in checks) ||
        !isRecord(checks.content) ||
        checks.content.sha256 !== mapping.image_sha256
      )
        continue;
      retain(mapping.image_id, Date.parse(state.last_live_observation_at), mapping.image_sha256);
    }
  }
  return observed;
}

function itemState(
  root: string,
  id: string,
  now: number,
  refresh: boolean,
  maintenance: boolean,
): ItemState | null {
  if (!safeId(id)) throw new Error("Artwork continuation requires a stable port identity");
  const value = readOwned(root, itemStateName(id, refresh, maintenance));
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
  if (
    JSON.stringify(value.result.record.collection ?? []) !==
    JSON.stringify(collectionCovers(value.result.port as unknown as ArtworkPort))
  )
    throw new Error("Artwork continuation collection differs from its checked record");
  return value as unknown as ItemState;
}
const mappingImages = (port: ArtworkPort) => [
  ...(validArtworkMapping(port.presentation?.artwork) ? [port.presentation.artwork.image_id] : []),
  ...collectionCovers(port).map((cover) => cover.image_id),
];
const mappingImage = (port: ArtworkPort) => mappingImages(port)[0] ?? null;
const budgetDeferred = (record: ArtworkRecord) =>
  record.exceptions.some((exception) =>
    /^batch-(?:query|image|provider)-budget-exhausted$/u.test(exception.reason),
  );
const finished = (record: ArtworkRecord, gone: ReadonlySet<string>) =>
  (record.mapping !== null || Boolean(record.collection?.length)) &&
  (!record.mapping || !gone.has(record.mapping.image_id)) &&
  !(record.collection ?? []).some((cover) => gone.has(cover.image_id)) &&
  !record.reason.includes("retained-after-unavailable-refresh");

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
        record.checks &&
        "scope" in record.checks &&
        record.checks.scope === "reviewed-cover-collection" &&
        record.checks.live_refresh_passed
      ) {
        const observations = (record.collection ?? []).map(
          (cover) => entries.get(`image:${cover.image_id}`)?.observedAt,
        );
        return observations.length &&
          observations.every((value): value is number => value !== undefined)
          ? new Date(Math.min(...observations)).toISOString()
          : null;
      }
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
    acceptedCatalog?: ArtworkCatalog;
    inspector: Inspector;
    identities: unknown;
    reviewedOriginalMedia?: ArtworkPreparationOptions["reviewedOriginalMedia"];
    validatorIdentity: string | null;
    selectedPortIds?: readonly string[];
    refreshPortIds?: readonly string[];
    maintenance?: boolean;
    revalidateAccepted?: boolean;
    retainedCoverLimit?: number;
    dueCoverLimit?: number;
    now?: () => number;
    signal?: AbortSignal;
    onProgress?: (id: string) => void | Promise<void>;
  },
) {
  const now = options.now ?? Date.now;
  const maintenance = options.maintenance === true;
  const revalidateAccepted = maintenance || options.revalidateAccepted === true;
  const limit = options.dueCoverLimit ?? options.retainedCoverLimit;
  if (options.dueCoverLimit !== undefined && options.retainedCoverLimit !== undefined)
    throw new Error("Choose one bounded artwork workset scope");
  if (
    limit !== undefined &&
    (!options.maintenance || !Number.isSafeInteger(limit) || limit < 1 || limit > 400)
  )
    throw new Error("Bounded artwork maintenance requires a limit from 1 through 400");
  restoreArtworkProviderBackoff(options.root, options.inspector);
  const ports = new Map(catalog.ports.map((port) => [port.id, port]));
  const inspectedIds = options.maintenance
    ? catalog.ports
        .filter(
          (port) => options.retainedCoverLimit === undefined || mappingImages(port).length > 0,
        )
        .map((port) => port.id)
    : [...(options.selectedPortIds ?? [])];
  if (
    new Set(inspectedIds).size !== inspectedIds.length ||
    inspectedIds.some((id) => !ports.has(id))
  )
    throw new Error("Artwork work requires unique known identities");
  const gone = readKnownGoneArtwork(options.root);
  const accepted = options.acceptedCatalog ?? catalog;
  const tool = createHash("sha256");
  for (const file of [
    "./artwork-preparation-progress.mts",
    "./catalog-cover-mapping.mts",
    "./inspect-igdb-artwork.mts",
    "./maintainer-config.mts",
    "./runtime-values.mts",
  ]) {
    tool.update(
      createHash("sha256")
        .update(readFileSync(new URL(file, import.meta.url)))
        .digest(),
    );
  }
  const toolIdentity = tool.digest("hex");
  const prepareInput = artworkPreparationInputs(
    accepted,
    options.identities,
    options.reviewedOriginalMedia,
  );
  const inputs = new Map<string, ReturnType<typeof prepareInput>>();
  const baseKey = (id: string, refresh: boolean) => {
    let input = inputs.get(id);
    if (input === undefined) {
      input = prepareInput(ports.get(id)!);
      inputs.set(id, input);
    }
    return observationHash({
      input,
      refresh,
      maintenance,
      revalidateAccepted,
      validator: options.validatorIdentity,
      tool: toolIdentity,
      // A newly verified image can restore an otherwise ambiguous original mapping.
      gone_original_candidates: input.accepted_original_candidates.filter(
        (mapping) => validArtworkMapping(mapping) && gone.has(mapping.image_id),
      ),
    });
  };
  const explicitRefresh = new Set(options.refreshPortIds ?? []);
  const refresh = (id: string) =>
    options.maintenance === true ||
    explicitRefresh.has(id) ||
    mappingImages(ports.get(id)!).some((image) => gone.has(image));
  const states = new Map(
    inspectedIds.map((id) => [id, itemState(options.root, id, now(), refresh(id), maintenance)]),
  );
  const due = (id: string) => {
    const state = states.get(id);
    if (!state?.complete || state.input_sha256 !== baseKey(id, true)) return true;
    const images = mappingImages(state.result.port);
    return (
      images.length === 0 ||
      images.some((value) => gone.has(value)) ||
      !currentLiveObservation(state, now())
    );
  };
  const dueIds = options.maintenance
    ? inspectedIds
        .filter(due)
        .sort(
          (a, b) =>
            Number(mappingImage(ports.get(a)!) !== null) -
              Number(mappingImage(ports.get(b)!) !== null) ||
            Date.parse(states.get(a)?.observed_at ?? "1970-01-01") -
              Date.parse(states.get(b)?.observed_at ?? "1970-01-01") ||
            a.localeCompare(b),
        )
    : [...(options.selectedPortIds ?? [])];
  const bounded =
    options.dueCoverLimit === undefined
      ? undefined
      : boundedArtworkDuePass(
          options.root,
          dueIds,
          new Set(
            dueIds.filter((id) => {
              const state = states.get(id);
              return (
                !state?.retry_at ||
                state.input_sha256 !== baseKey(id, true) ||
                Date.parse(state.retry_at) <= now()
              );
            }),
          ),
          options.dueCoverLimit,
        );
  const selected = bounded?.selected ?? (limit === undefined ? dueIds : dueIds.slice(0, limit));
  if (
    new Set(selected).size !== selected.length ||
    selected.some((id) => !ports.has(id)) ||
    [...explicitRefresh].some((id) => !selected.includes(id))
  )
    throw new Error("Artwork work requires unique known identities and a matching refresh scope");
  const records = new Map<string, ArtworkRecord>();
  const output = structuredClone(catalog);
  const outputPorts = new Map(output.ports.map((port) => [port.id, port]));
  const apply = (id: string, result: ItemResult) => {
    outputPorts.set(id, structuredClone(result.port));
    records.set(id, structuredClone(result.record));
  };
  const queue: string[] = [];
  let cacheHits = 0;
  const carried: string[] = [];
  if (options.maintenance) {
    const dueSet = new Set(dueIds);
    for (const id of inspectedIds) {
      const state = states.get(id);
      if (
        !dueSet.has(id) &&
        state?.input_sha256 === baseKey(id, true) &&
        state.complete &&
        finished(state.result.record, gone) &&
        currentLiveObservation(state, now())
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
      (!refresh(id) || currentLiveObservation(state, now()))
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
    const identities = options.identities;
    const refreshing = new Set(batch.filter(refresh));
    const result = await prepareCatalogArtwork(catalog, {
      acceptedCatalog: accepted,
      selectedPortIds: batch,
      refreshPortIds: [...refreshing],
      revalidateAccepted,
      ...(options.reviewedOriginalMedia
        ? { reviewedOriginalMedia: options.reviewedOriginalMedia }
        : {}),
      identities: isRecord(identities)
        ? Object.fromEntries(batch.map((id) => [id, identities[id]]))
        : undefined,
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
        retainArtworkProviderBackoff(options.root, providerStatus);
        const value = { port, record };
        const complete = finished(record, gone);
        const live =
          complete &&
          isRecord(record.checks) &&
          (Object.hasOwn(record.checks, "content") ||
            ("scope" in record.checks &&
              record.checks.scope === "reviewed-cover-collection" &&
              record.checks.live_refresh_passed === true));
        const refreshed = refreshing.has(record.port_id);
        const input = baseKey(record.port_id, refreshed);
        const previous = states.get(record.port_id);
        const retainedObservation =
          record.reason.includes("retained-after-unavailable-refresh") &&
          previous?.input_sha256 === input &&
          observationHash([
            previous.result.record.mapping,
            previous.result.record.collection ?? [],
          ]) === observationHash([record.mapping, record.collection ?? []])
            ? previous.last_live_observation_at
            : null;
        const state: ItemState = {
          format: 1,
          port_id: record.port_id,
          input_sha256: input,
          result_sha256: observationHash(value),
          result: value,
          complete,
          observed_at: new Date(now()).toISOString(),
          last_live_observation_at: live ? memo.observationClock(record) : retainedObservation,
          retry_at: providerStatus?.retry_at ?? null,
        };
        replaceOwned(options.root, itemStateName(record.port_id, refreshed, maintenance), state);
        states.set(record.port_id, state);
        apply(record.port_id, value);
        await options.onProgress?.(record.port_id);
      },
    });
    const resultPorts = new Map(result.catalog.ports.map((port) => [port.id, port]));
    for (const record of result.records)
      apply(record.port_id, { record, port: resultPorts.get(record.port_id)! });
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
    const companion = ports.get(port.id)?.presentation?.companion_cover;
    const companionWithdrawn = validArtworkMapping(companion) && gone.has(companion.image_id);
    withdrawCompanionCover(port, gone);
    if (withdrawCollectionCovers(port, gone)) {
      invalidated.push(port.id);
      const record = records.get(port.id);
      if (record?.collection) {
        const remaining = collectionCovers(port);
        if (remaining.length) record.collection = remaining;
        else {
          delete record.collection;
          record.reason = "generated-fallback";
          record.checks = null;
        }
      }
    }
    const image = mappingImage(port);
    if (!image || !gone.has(image)) {
      if (companionWithdrawn) invalidated.push(port.id);
      continue;
    }
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
      (record) =>
        (record.mapping !== null || Boolean(record.collection?.length)) &&
        !record.reason.startsWith("accepted-mapping"),
    ).length,
    fallback: values.filter((record) => record.mapping === null && !record.collection?.length)
      .length,
    ...memo.metrics,
  };
  bounded?.finish();
  return {
    catalog: output,
    records: values,
    metrics,
    gone_image_ids: [...gone].sort(),
    workset: {
      catalog_ports: catalog.ports.length,
      selected_port_ids: selected,
      carried_port_ids: carried,
      invalidated_port_ids: invalidated,
    },
    continuation: {
      batches,
      completed_cache_hits: cacheHits,
      ...(limit !== undefined ? { unselected_due_count: dueIds.length - selected.length } : {}),
      complete:
        dueIds.length === selected.length &&
        selected.every((id) => records.has(id) && finished(records.get(id)!, gone)),
      pending_port_ids: selected.filter(
        (id) => !records.has(id) || !finished(records.get(id)!, gone),
      ),
    },
    reused: batches === 0 && cacheHits === records.size,
  };
}
