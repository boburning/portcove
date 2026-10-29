import { readIgdbCredentials, resolveIgdbCredentialsFile } from "./maintainer-config.mts";
import type { ReadableStreamReadResult } from "node:stream/web";
import { isRecord, errorCode } from "./runtime-values.mts";
import type {
  IgdbArtwork,
  IgdbArtworkMatch,
  CatalogMediaAsset,
  CatalogMediaSubject,
} from "../apps/desktop/src/transport-types.generated.d.ts";
import {
  readFileSync,
  writeFileSync,
  mkdtempSync,
  mkdirSync,
  openSync,
  readSync,
  fstatSync,
  closeSync,
  copyFileSync,
  chmodSync,
} from "node:fs";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import timers from "node:timers/promises";

export interface ArtworkPort extends Record<string, unknown> {
  id: string;
  name?: unknown;
  project_url?: unknown;
  source_profile?: unknown;
  /** Reviewed original-title facts supplied by per-record preparation. */
  underlying_game?: unknown;
  presentation?: ({ artwork?: unknown } & Record<string, unknown>) | null;
}
export interface ArtworkCatalog extends Record<string, unknown> {
  ports: ArtworkPort[];
}
interface PreparedArtworkPort extends ArtworkPort {
  presentation?: ({ artwork?: IgdbArtwork } & Record<string, unknown>) | null;
}
interface PreparedArtworkCatalog extends ArtworkCatalog {
  ports: PreparedArtworkPort[];
}

function assertPreparedArtwork(catalog: ArtworkCatalog): asserts catalog is PreparedArtworkCatalog {
  for (const port of catalog.ports) {
    const artwork = port.presentation?.artwork;
    if (artwork !== undefined && !validArtworkMapping(artwork))
      throw new Error("Prepared artwork does not satisfy its mapping contract.");
  }
}

interface DeclaredIdentity {
  kind: IgdbArtworkMatch;
  game_id: number | null;
  slug: string | null;
  names: string[];
  evidence_url: string;
  project_url: string | null;
  platform_ids: number[];
  edition: string | null;
}
interface ObservedGame {
  id: number;
  name: string;
  slug: string;
  cover?: unknown;
  alternative_names?: { name: string }[] | null;
  websites?: { url: string }[] | null;
  platforms?: number[] | null;
  version_parent?: number | null;
  version_title?: string | null;
}
interface ImageContent {
  sha256: string;
  bytes: number;
  width: number;
  height: number;
  format: "jpeg";
  validator: "portcove-core";
}
interface ArtworkException {
  kind: IgdbArtworkMatch;
  reason: string;
  resume: string;
  image_id?: string;
  http_status?: 410;
}
type ArtworkChecks =
  | { scope: "retained-accepted-mapping"; download_repeated: false }
  | { scope: "retained-accepted-mapping"; live_refresh_passed: false }
  | {
      identity: DeclaredIdentity;
      scope: "retained-accepted-original-game";
      download_repeated: false;
    }
  | { identity: DeclaredIdentity; content: ImageContent };
interface SelectedCover {
  mapping: IgdbArtwork;
  checks: ArtworkChecks;
  reused_original?: true;
}
export interface ArtworkRecord {
  port_id: string;
  role: "cover";
  reason: string;
  mapping: IgdbArtwork | null;
  checks: ArtworkChecks | null;
  exceptions: ArtworkException[];
}
export interface ArtworkMetrics {
  ports: number;
  reused: number;
  original_reused: number;
  selected: number;
  fallback: number;
  game_queries: number;
  image_queries: number;
  image_bytes: number;
}
export interface ArtworkPreparationOptions {
  acceptedCatalog?: ArtworkCatalog;
  identities?: unknown;
  /** Bound provider work without truncating the catalog or its identity checks. */
  selectedPortIds?: readonly string[];
  refreshPortIds?: readonly string[];
  inspectGame?: (identity: DeclaredIdentity) => unknown;
  inspectImage?: (imageId: string, remainingBytes: number) => unknown;
  signal?: AbortSignal;
  knownGoneImageIds?: readonly string[];
  onRecord?: (
    record: ArtworkRecord,
    port: ArtworkPort,
    goneImages: readonly string[],
  ) => void | Promise<void>;
}
interface ArtworkContext extends ArtworkPreparationOptions {
  acceptedPorts: ArtworkPort[];
  refreshing: boolean;
  metrics: ArtworkMetrics;
  games: Map<string, Promise<unknown>>;
  images: Map<string, Promise<ImageContent>>;
  goneImages: Set<string>;
}
interface ArtworkReader {
  read(): Promise<ReadableStreamReadResult<Uint8Array>>;
  cancel(): Promise<void>;
  releaseLock(): void;
}
interface ArtworkBody {
  getReader(): ArtworkReader;
  cancel(): Promise<void>;
}
export interface ArtworkResponse {
  ok: boolean;
  status: number;
  headers: Pick<Headers, "get">;
  body: ArtworkBody | null;
}
export type ArtworkFetch = (url: string, init: RequestInit) => Promise<ArtworkResponse>;
export type ImageValidator = (bytes: Buffer) => unknown;

const maximumImageBytes = 16 * 1024 * 1024;
const maximumBatchBytes = 512 * 1024 * 1024;
const slugPattern = /^[a-z0-9-]{1,255}$/;
const imagePattern = /^[a-z0-9]{1,128}$/;
const hashPattern = /^[a-f0-9]{64}$/;
const positiveId = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value > 0;
const matchesString = (pattern: RegExp, value: unknown): value is string =>
  typeof value === "string" && pattern.test(value);
// Only this module's fixed image request can establish a Gone observation.
// Provider metadata, generic errors and caller-supplied status properties cannot.
const goneImageObservations = new WeakMap<object, string>();

function goneImageException(kind: IgdbArtworkMatch, imageId: string): ArtworkException {
  return { ...exception(kind, "image-gone"), image_id: imageId, http_status: 410 };
}

export function readArtworkJson(file: string, maximum = 8 * 1024 * 1024) {
  return readArtworkInput(file, maximum).document;
}

export function readArtworkInput(file: string, maximum = 8 * 1024 * 1024) {
  const fd = openSync(file, "r");
  try {
    const before = fstatSync(fd);
    if (!before.isFile()) throw new Error("Artwork input must be a regular file.");
    if (before.size > maximum) throw new Error("Artwork input exceeds its byte contract.");
    const buffer = Buffer.alloc(before.size + 1);
    let length = 0;
    for (;;) {
      const read = readSync(fd, buffer, length, buffer.length - length, null);
      length += read;
      if (length > maximum) throw new Error("Artwork input exceeds its byte contract.");
      if (length > before.size) throw new Error("Artwork input changed while being read.");
      if (!read) break;
    }
    try {
      const after = fstatSync(fd);
      if (
        after.size !== before.size ||
        after.mtimeMs !== before.mtimeMs ||
        after.ctimeMs !== before.ctimeMs ||
        length !== before.size
      )
        throw new Error("Artwork input changed while being read.");
      const bytes = Buffer.from(buffer.subarray(0, length));
      const document: unknown = JSON.parse(bytes.toString("utf8"));
      return { document, bytes };
    } catch {
      throw new Error("Artwork input is not valid JSON.");
    }
  } finally {
    closeSync(fd);
  }
}

function nameKey(value: unknown) {
  return String(value).normalize("NFKC").toLowerCase().replace(/\s+/g, " ").trim();
}

function evidenceUrl(value: unknown) {
  let evidence;
  try {
    if (typeof value !== "string") throw new Error();
    evidence = new URL(value);
  } catch {
    throw new Error("Artwork identity needs attributable HTTPS evidence.");
  }
  if (
    evidence.protocol !== "https:" ||
    evidence.username ||
    evidence.password ||
    evidence.href.length > 2048
  )
    throw new Error("Artwork identity needs attributable HTTPS evidence.");
  return evidence.href;
}

function declaredIdentity(value: unknown, requestedKind?: IgdbArtworkMatch): DeclaredIdentity {
  const kind = requestedKind ?? (isRecord(value) ? (value.kind ?? "port") : "port");
  if (kind !== "port" && kind !== "underlying-game")
    throw new Error("Artwork identity kind is invalid.");
  if (
    !isRecord(value) ||
    (value.game_id != null && !positiveId(value.game_id)) ||
    (value.slug != null && !matchesString(slugPattern, value.slug)) ||
    !Array.isArray(value.names) ||
    !value.names.length ||
    value.names.length > 16 ||
    !value.names.every(
      (name: unknown): name is string =>
        typeof name === "string" && Boolean(name.trim()) && name.length <= 255,
    )
  ) {
    throw new Error(
      "Artwork identity needs bounded public names and valid optional fixed references.",
    );
  }
  const projectUrl = value.project_url ? evidenceUrl(value.project_url) : null;
  const platforms = value.platform_ids ?? [];
  if (!Array.isArray(platforms) || platforms.length > 16 || !platforms.every(positiveId))
    throw new Error("Artwork original-game platforms are invalid.");
  if (value.game_id == null && (kind === "port" ? !projectUrl : !platforms.length && !projectUrl))
    throw new Error(
      "Name matching requires attributable upstream project or original-game platform facts.",
    );
  if (value.game_id != null && !value.slug)
    throw new Error("A fixed IGDB reference requires its exact slug.");
  if (
    value.edition != null &&
    (typeof value.edition !== "string" || !value.edition.trim() || value.edition.length > 255)
  )
    throw new Error("Artwork edition is invalid.");
  return {
    kind,
    game_id: value.game_id ?? null,
    slug: value.slug ?? null,
    names: [...value.names],
    evidence_url: evidenceUrl(value.evidence_url),
    project_url: projectUrl,
    platform_ids: platforms,
    edition: value.edition ?? null,
  };
}

function websiteKey(value: unknown) {
  try {
    if (typeof value !== "string") return null;
    const url = new URL(value);
    if (!["https:", "http:"].includes(url.protocol) || url.username || url.password) return null;
    if (url.hostname === "github.com" && !url.port && !url.search && !url.hash)
      return `github.com${url.pathname.replace(/\/$/, "").toLowerCase()}`;
    return url.href;
  } catch {
    return null;
  }
}

function matchesIdentity(game: ObservedGame, declared: DeclaredIdentity) {
  if (declared.game_id != null && game.id !== declared.game_id) return false;
  if (declared.slug != null && game.slug !== declared.slug) return false;
  const names = [
    game.name,
    ...(Array.isArray(game.alternative_names)
      ? game.alternative_names.map((name) => name.name)
      : []),
  ];
  if (
    !declared.names.some((name) =>
      names.some((observed) => typeof observed === "string" && nameKey(name) === nameKey(observed)),
    )
  )
    return false;
  if (declared.game_id == null && declared.kind === "port") {
    return (
      Array.isArray(game.websites) &&
      game.websites.some((site) => websiteKey(site.url) === websiteKey(declared.project_url))
    );
  }
  if (declared.kind === "underlying-game") {
    if (
      !declared.platform_ids.every(
        (id) => Array.isArray(game.platforms) && game.platforms.includes(id),
      )
    )
      return false;
    if (declared.edition != null)
      return nameKey(game.version_title ?? "") === nameKey(declared.edition);
    if (declared.game_id == null && (game.version_parent != null || game.version_title))
      return false;
  }
  return true;
}

function validOptionalList<T>(
  value: unknown,
  predicate: (value: unknown) => value is T,
): value is T[] | null | undefined {
  if (value === undefined || value === null) return true;
  if (!Array.isArray(value) || value.length > 256) return false;
  const items: unknown[] = value;
  return items.every(predicate);
}
function validObservedMetadata(game: unknown): game is ObservedGame {
  if (
    !isRecord(game) ||
    !positiveId(game.id) ||
    typeof game.name !== "string" ||
    !matchesString(slugPattern, game.slug)
  )
    return false;
  if (
    !validOptionalList(
      game.alternative_names,
      (name): name is { name: string } =>
        isRecord(name) && typeof name.name === "string" && name.name.length <= 255,
    )
  )
    return false;
  if (
    !validOptionalList(
      game.websites,
      (site): site is { url: string } =>
        isRecord(site) && typeof site.url === "string" && site.url.length <= 2048,
    )
  )
    return false;
  if (!validOptionalList(game.platforms, positiveId)) return false;
  return (
    (game.version_parent == null || positiveId(game.version_parent)) &&
    (game.version_title == null ||
      (typeof game.version_title === "string" && game.version_title.length <= 255))
  );
}

function identifiedGame(
  matches: unknown,
  declared: DeclaredIdentity,
): { game: ObservedGame; reason?: never } | { reason: string; game?: never } {
  if (!Array.isArray(matches)) return { reason: "identity-response-invalid" };
  const values: unknown[] = matches;
  if (!values.every(validObservedMetadata)) return { reason: "identity-response-invalid" };
  if (matches.length >= 21) return { reason: "identity-query-incomplete" };
  if (declared.game_id != null && matches.length !== 1) return { reason: "identity-not-unique" };
  const eligible = values.filter((game) => matchesIdentity(game, declared));
  const game = eligible.length === 1 ? eligible[0] : undefined;
  return game
    ? { game }
    : { reason: eligible.length > 1 ? "identity-not-unique" : "identity-mismatch" };
}

export function validArtworkMapping(value: unknown): value is IgdbArtwork {
  return (
    isRecord(value) &&
    positiveId(value.game_id) &&
    positiveId(value.cover_id) &&
    matchesString(imagePattern, value.image_id) &&
    matchesString(hashPattern, value.image_sha256) &&
    matchesString(slugPattern, value.game_slug) &&
    (value.match_kind === "port" || value.match_kind === "underlying-game")
  );
}

function reusableMapping(
  port: ArtworkPort,
  accepted: ArtworkPort | undefined,
  declarations: unknown,
) {
  if (
    !accepted ||
    port.name !== accepted.name ||
    port.project_url !== accepted.project_url ||
    port.source_profile !== accepted.source_profile ||
    JSON.stringify(port.underlying_game ?? null) !==
      JSON.stringify(accepted.underlying_game ?? null) ||
    !validArtworkMapping(accepted.presentation?.artwork)
  )
    return null;
  const mapping = accepted.presentation.artwork;
  const identity = isRecord(declarations)
    ? declarations[mapping.match_kind === "port" ? "port" : "underlying_game"]
    : undefined;
  if (
    identity &&
    (!isRecord(identity) ||
      identity.game_id !== mapping.game_id ||
      identity.slug !== mapping.game_slug)
  )
    return null;
  return structuredClone(mapping);
}

export class ArtworkBatchExhausted extends Error {
  constructor(message = "Artwork bounded provider batch exhausted.") {
    super(message);
  }
}

/** Only the current port and equivalent accepted original-game mappings affect its preparation. */
export function artworkPreparationInput(
  port: ArtworkPort,
  accepted: ArtworkCatalog,
  identities: unknown,
) {
  const supplied = isRecord(identities) ? identities[port.id] : undefined;
  const underlying = isRecord(supplied)
    ? (supplied.underlying_game ?? port.underlying_game)
    : port.underlying_game;
  let original: DeclaredIdentity | null = null;
  try {
    if (underlying) original = declaredIdentity(underlying, "underlying-game");
  } catch {
    /* The raw declaration remains bound and produces the existing refusal. */
  }
  const mappings = accepted.ports
    .map((entry) => entry.presentation?.artwork)
    .filter(
      (mapping) =>
        validArtworkMapping(mapping) &&
        mapping.match_kind === "underlying-game" &&
        mapping.game_id === original?.game_id &&
        mapping.game_slug === original?.slug,
    );
  return {
    port,
    accepted: accepted.ports.find((entry) => entry.id === port.id) ?? null,
    supplied: supplied ?? null,
    accepted_original_candidates: [
      ...new Map(mappings.map((mapping) => [JSON.stringify(mapping), mapping])).values(),
    ],
  };
}

function exception(kind: IgdbArtworkMatch, reason: string): ArtworkException {
  return {
    kind,
    reason,
    resume:
      reason === "identity-not-declared"
        ? "Supply attributable exact project/original-game identity facts."
        : "Correct the exact identity or asset fact, or retry after a confirmed provider/environment change.",
  };
}

function assertObservedContent(value: unknown): asserts value is ImageContent {
  if (
    !isRecord(value) ||
    !matchesString(hashPattern, value.sha256) ||
    !positiveId(value.bytes) ||
    value.bytes > maximumImageBytes ||
    !positiveId(value.width) ||
    !positiveId(value.height) ||
    value.width > 8192 ||
    value.height > 8192 ||
    value.width * value.height > 8 * 1024 * 1024 ||
    value.format !== "jpeg" ||
    value.validator !== "portcove-core"
  )
    throw new Error("Image did not pass the core content contract.");
}
function observedContent(value: unknown): ImageContent {
  assertObservedContent(value);
  return value;
}

function acceptedOriginal(declared: DeclaredIdentity, context: ArtworkContext) {
  const mappings = context.acceptedPorts
    .map((port) => port.presentation?.artwork)
    .filter(
      (mapping): mapping is IgdbArtwork =>
        validArtworkMapping(mapping) &&
        !context.goneImages.has(mapping.image_id) &&
        mapping.match_kind === "underlying-game" &&
        mapping.game_id === declared.game_id &&
        mapping.game_slug === declared.slug,
    );
  const unique = new Map(mappings.map((mapping) => [JSON.stringify(mapping), mapping]));
  return unique.size === 1 ? structuredClone([...unique.values()][0]) : null;
}

async function selectCover(
  identity: unknown,
  kind: IgdbArtworkMatch,
  context: ArtworkContext,
  exceptions: ArtworkException[],
): Promise<SelectedCover | null> {
  if (!identity) {
    exceptions.push(exception(kind, "identity-not-declared"));
    return null;
  }
  let declared;
  try {
    declared = declaredIdentity(identity, kind);
  } catch {
    exceptions.push(exception(kind, "identity-declaration-invalid"));
    return null;
  }
  if (kind === "underlying-game" && !context.refreshing) {
    const mapping = acceptedOriginal(declared, context);
    if (mapping)
      return {
        mapping,
        reused_original: true,
        checks: {
          identity: declared,
          scope: "retained-accepted-original-game",
          download_repeated: false,
        },
      };
  }
  const key = JSON.stringify(declared);
  if (!context.games.has(key)) {
    if (context.metrics.game_queries >= 800) {
      exceptions.push(exception(kind, "batch-query-budget-exhausted"));
      return null;
    }
    context.metrics.game_queries++;
    context.games.set(
      key,
      Promise.resolve().then(() => {
        if (!context.inspectGame) throw new Error("Artwork identity inspector unavailable.");
        return context.inspectGame(declared);
      }),
    );
  }
  let matches;
  try {
    matches = await context.games.get(key);
  } catch (error) {
    if (context.signal?.aborted) throw error;
    exceptions.push(
      exception(
        kind,
        error instanceof ArtworkBatchExhausted
          ? "batch-provider-budget-exhausted"
          : "identity-provider-unavailable",
      ),
    );
    return null;
  }
  const identified = identifiedGame(matches, declared);
  if (!identified.game) {
    exceptions.push(exception(kind, identified.reason));
    return null;
  }
  const game = identified.game;
  const cover = isRecord(game.cover) ? game.cover : undefined;
  if (!cover || !positiveId(cover.id) || !matchesString(imagePattern, cover.image_id)) {
    exceptions.push(exception(kind, "no-usable-cover"));
    return null;
  }
  const imageId = cover.image_id;
  if (!context.images.has(imageId)) {
    if (context.metrics.image_queries >= 400 || context.metrics.image_bytes >= maximumBatchBytes) {
      exceptions.push(exception(kind, "batch-image-budget-exhausted"));
      return null;
    }
    context.metrics.image_queries++;
    context.images.set(
      imageId,
      Promise.resolve()
        .then(() => {
          if (!context.inspectImage) throw new Error("Artwork image inspector unavailable.");
          return context.inspectImage(imageId, maximumBatchBytes - context.metrics.image_bytes);
        })
        .then((value) => {
          const content = observedContent(value);
          context.metrics.image_bytes += content.bytes;
          if (context.metrics.image_bytes > maximumBatchBytes)
            throw new Error("Batch image byte budget exceeded.");
          return content;
        }),
    );
  }
  let content;
  try {
    content = await context.images.get(imageId);
    context.signal?.throwIfAborted();
    if (!content) throw new Error("Image observation disappeared.");
  } catch (error) {
    if (isRecord(error) && goneImageObservations.get(error) === imageId) {
      context.goneImages.add(imageId);
      exceptions.push(goneImageException(kind, imageId));
    } else {
      if (context.signal?.aborted) throw error;
      exceptions.push(
        exception(
          kind,
          error instanceof ArtworkBatchExhausted
            ? "batch-provider-budget-exhausted"
            : "image-unavailable-or-invalid",
        ),
      );
    }
    return null;
  }
  context.goneImages.delete(imageId);
  return {
    mapping: {
      game_id: game.id,
      cover_id: cover.id,
      image_id: imageId,
      image_sha256: content.sha256,
      game_slug: game.slug,
      match_kind: kind,
    },
    checks: { identity: declared, content },
  };
}

function applyGoneImageFallbacks(
  catalog: ArtworkCatalog,
  records: ArtworkRecord[],
  context: Pick<ArtworkContext, "goneImages" | "metrics">,
) {
  const byId = new Map(records.map((record) => [record.port_id, record]));
  const invalidated: string[] = [];
  for (const port of catalog.ports) {
    const mapping = port.presentation?.artwork;
    if (!validArtworkMapping(mapping)) continue;
    if (!mapping || !context.goneImages.has(mapping.image_id)) continue;
    if (!port.presentation) throw new Error("Artwork output relationship disappeared.");
    delete port.presentation.artwork;
    invalidated.push(port.id);
    const record = byId.get(port.id);
    if (!record) {
      // A sparse refresh still invalidates every reference to these exact bytes.
      records.push({
        port_id: port.id,
        role: "cover",
        reason: "generated-fallback",
        mapping: null,
        checks: null,
        exceptions: [goneImageException(mapping.match_kind, mapping.image_id)],
      });
      context.metrics.ports++;
      context.metrics.fallback++;
      continue;
    }
    if (
      ["accepted-mapping-reused", "accepted-mapping-retained-after-unavailable-refresh"].includes(
        record.reason,
      )
    ) {
      context.metrics.reused--;
    } else {
      context.metrics.selected--;
      if (record.reason === "accepted-original-game-reused") context.metrics.original_reused--;
    }
    context.metrics.fallback++;
    record.reason = "generated-fallback";
    record.mapping = null;
    record.checks = null;
    record.exceptions.push(goneImageException(mapping.match_kind, mapping.image_id));
  }
  return invalidated;
}

// Proposal preparation only. The accepted baseline is caller-selected trusted
// authoring data; neither a provider response nor this output admits a port.
// Only the inspected projection is promised: artwork is deliberately widened
// because preparation can replace or remove it. All other authoring data stays
// in the cloned document; Core remains its schema and admission authority.
export async function prepareCatalogArtwork(
  catalog: ArtworkCatalog,
  options: ArtworkPreparationOptions,
) {
  if (
    !Array.isArray(catalog?.ports) ||
    catalog.ports.length > 10000 ||
    new Set(catalog.ports.map((port) => port.id)).size !== catalog.ports.length ||
    catalog.ports.some(
      (port) => typeof port.id !== "string" || !/^[a-z0-9][a-z0-9-]{0,127}$/.test(port.id),
    )
  ) {
    throw new Error("Artwork catalogs require at most10000 unique stable port ids.");
  }
  validateKnownGoneImages(options.knownGoneImageIds);
  const result = structuredClone(catalog);
  const accepted = new Map((options.acceptedCatalog?.ports ?? []).map((port) => [port.id, port]));
  const selectedIds = options.selectedPortIds ?? catalog.ports.map((port) => port.id);
  const workset = new Set(selectedIds);
  const allIds = new Set(catalog.ports.map((port) => port.id));
  if (
    workset.size > 400 ||
    workset.size !== selectedIds.length ||
    [...workset].some((id) => !allIds.has(id))
  )
    throw new Error("Artwork worksets require at most400 unique catalog port ids.");
  const refresh = new Set(options.refreshPortIds ?? []);
  if ([...refresh].some((id) => !workset.has(id)))
    throw new Error("Artwork refresh names a port outside this workset.");
  const context: ArtworkContext = {
    ...options,
    refreshing: false,
    games: new Map(),
    images: new Map(),
    goneImages: new Set(options.knownGoneImageIds ?? []),
    acceptedPorts: options.acceptedCatalog?.ports ?? [],
    metrics: {
      ports: workset.size,
      reused: 0,
      original_reused: 0,
      selected: 0,
      fallback: 0,
      game_queries: 0,
      image_queries: 0,
      image_bytes: 0,
    },
  };
  const records: ArtworkRecord[] = [];
  const completed = async (record: ArtworkRecord, port: ArtworkPort) => {
    records.push(record);
    await options.onRecord?.(structuredClone(record), structuredClone(port), [
      ...context.goneImages,
    ]);
  };
  for (const port of result.ports) {
    options.signal?.throwIfAborted();
    const rawSupplied = isRecord(options.identities) ? options.identities[port.id] : undefined;
    const supplied = isRecord(rawSupplied) ? rawSupplied : undefined;
    const reused = reusableMapping(port, accepted.get(port.id), supplied);
    if (!workset.has(port.id)) {
      const prior = accepted.get(port.id)?.presentation?.artwork;
      const mapping = port.presentation?.artwork;
      if (
        JSON.stringify(mapping ?? null) !== JSON.stringify(prior ?? null) ||
        (mapping !== undefined && !reused)
      )
        throw new Error(`Changed artwork identity outside selected workset: ${port.id}`);
      continue;
    }
    if (reused && !refresh.has(port.id)) {
      port.presentation = { ...port.presentation, artwork: reused };
      await completed(
        {
          port_id: port.id,
          role: "cover",
          reason: "accepted-mapping-reused",
          mapping: reused,
          checks: { scope: "retained-accepted-mapping", download_repeated: false },
          exceptions: [],
        },
        port,
      );
      context.metrics.reused++;
      continue;
    }
    const declarations: { port: unknown; underlying_game?: unknown } = {
      underlying_game: port.underlying_game,
      ...supplied,
      port: supplied?.port ?? {
        names: [port.name],
        project_url: port.project_url,
        evidence_url: port.project_url,
      },
    };
    context.refreshing = refresh.has(port.id);
    const exceptions: ArtworkException[] = [];
    const selected =
      (await selectCover(declarations?.port, "port", context, exceptions)) ??
      (await selectCover(declarations?.underlying_game, "underlying-game", context, exceptions));
    if (!selected && reused && !context.goneImages.has(reused.image_id)) {
      port.presentation = { ...port.presentation, artwork: reused };
      context.metrics.reused++;
      await completed(
        {
          port_id: port.id,
          role: "cover",
          reason: "accepted-mapping-retained-after-unavailable-refresh",
          mapping: reused,
          checks: { scope: "retained-accepted-mapping", live_refresh_passed: false },
          exceptions,
        },
        port,
      );
      continue;
    }
    if (selected) {
      port.presentation = { ...port.presentation, artwork: selected.mapping };
      context.metrics.selected++;
      if (selected.reused_original) context.metrics.original_reused++;
    } else {
      if (port.presentation) delete port.presentation.artwork;
      context.metrics.fallback++;
    }
    await completed(
      {
        port_id: port.id,
        role: "cover",
        reason: selected
          ? selected.reused_original
            ? "accepted-original-game-reused"
            : selected.mapping.match_kind === "port"
              ? "exact-port-cover"
              : "exact-original-game-cover"
          : "generated-fallback",
        mapping: selected?.mapping ?? null,
        checks: selected?.checks ?? null,
        exceptions,
      },
      port,
    );
  }
  // A later refreshed record can observe Gone for an earlier reused mapping.
  // Apply that exact-image fact to every output reference without extra requests.
  const invalidatedPortIds = applyGoneImageFallbacks(result, records, context);
  removeWithdrawnCatalogMedia(result, [], context.goneImages);
  assertPreparedArtwork(result);
  return {
    catalog: result,
    records,
    metrics: context.metrics,
    gone_image_ids: [...context.goneImages].sort(),
    workset: {
      catalog_ports: catalog.ports.length,
      selected_port_ids: [...workset],
      invalidated_port_ids: invalidatedPortIds,
    },
  };
}

function validateKnownGoneImages(imageIds: readonly string[] | undefined) {
  if (
    imageIds &&
    (Buffer.byteLength(JSON.stringify(imageIds)) > 8 * 1024 * 1024 ||
      imageIds.some((id) => !matchesString(imagePattern, id)))
  )
    throw new Error("Invalid bounded exact-image Gone observations.");
}

/** Reconcile later role observations into the existing cover proposal and its
 * evidence. No provider requests or authority are introduced by reconciliation. */
export function reconcileCatalogArtworkWithdrawals(
  prepared: Awaited<ReturnType<typeof prepareCatalogArtwork>>,
  imageIds: readonly string[],
) {
  validateKnownGoneImages(imageIds);
  const goneImages = new Set([...prepared.gone_image_ids, ...imageIds]);
  const invalidated = applyGoneImageFallbacks(prepared.catalog, prepared.records, {
    goneImages,
    metrics: prepared.metrics,
  });
  removeWithdrawnCatalogMedia(prepared.catalog, [], goneImages);
  prepared.gone_image_ids = [...goneImages].sort();
  prepared.workset.invalidated_port_ids = [
    ...new Set([...prepared.workset.invalidated_port_ids, ...invalidated]),
  ].sort();
}

function cancelBody(body: Pick<ArtworkReader, "cancel"> | null | undefined) {
  try {
    // Start abandonment now; an untrusted cancellation promise must neither
    // delay fallback nor replace its original failure. Fetch cancellation
    // aborts the owned transfer without draining its remaining bytes.
    void body?.cancel().catch(() => {});
  } catch {
    // Preserve the operation's result even if cancellation throws immediately.
  }
}

async function readBounded(
  response: ArtworkResponse,
  maximum: number,
  observeBytes: (bytes: number) => void = () => {},
  operationRemaining = maximum,
) {
  const admit = (length: number) => {
    if (length > maximum) throw new Error("Response exceeds its byte contract.");
    if (length > operationRemaining)
      throw new ArtworkBatchExhausted(
        "Response exceeds the remaining bounded operation; continue in a fresh batch.",
      );
  };
  admit(Number(response.headers.get("content-length")));
  if (!response.body) throw new Error("Response exceeds its byte contract.");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) return Buffer.concat(chunks, length);
      length += value.byteLength;
      observeBytes(value.byteLength);
      admit(length);
      chunks.push(value);
    }
  } finally {
    cancelBody(reader);
    reader.releaseLock();
  }
}

function metadataRetryAt(header: string | null, now: number, deadline: number) {
  if (header === null) return now;
  // Bound parsing and arithmetic before provider input reaches a timer.
  if (/^\d+$/.test(header)) {
    if (header.length > 128) return deadline;
    const seconds = Number(header);
    if (!Number.isSafeInteger(seconds) || seconds >= (deadline - now) / 1000) return deadline;
    return now + seconds * 1000;
  }
  if (header.length > 128) return now;
  const weekday = "(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun)";
  const month = "(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)";
  const time = "\\d{2}:\\d{2}:\\d{2}";
  const httpDate = new RegExp(
    `^(?:${weekday}, \\d{2} ${month} \\d{4} ${time} GMT|` +
      `(?:Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday), \\d{2}-${month}-\\d{2} ${time} GMT|` +
      `${weekday} ${month} (?: \\d|\\d{2}) ${time} \\d{4})$`,
  );
  if (!httpDate.test(header)) return now;
  let parsed;
  const shortYear = header.match(/-([0-9]{2}) /);
  if (shortYear) {
    // HTTP's obsolete two-digit year is relative to receipt, not JS's fixed pivot.
    const latestYear = new Date(now).getUTCFullYear() + 50;
    const year = Math.floor((latestYear - Number(shortYear[1])) / 100) * 100 + Number(shortYear[1]);
    parsed = Date.parse(header.replace(/-([0-9]{2}) /, `-${year} `));
    const futureLimit = new Date(now);
    futureLimit.setUTCFullYear(latestYear);
    if (parsed > futureLimit.getTime()) {
      const earlier = new Date(parsed);
      earlier.setUTCFullYear(year - 100);
      parsed = earlier.getTime();
    }
  } else {
    // HTTP's zoneless asctime form is UTC, not the host's local timezone.
    // Only grammar-accepted input reaches this normalization.
    parsed = Date.parse(header.endsWith("GMT") ? header : `${header} GMT`);
  }
  const parts =
    header.match(
      /, ([0-9]{2})[ -]([A-Z][a-z]{2})[ -][0-9]{2,4} ([0-9]{2}):([0-9]{2}):([0-9]{2})/,
    ) ??
    (() => {
      const value = header.match(
        /^[A-Z][a-z]{2} ([A-Z][a-z]{2}) ( [0-9]|[0-9]{2}) ([0-9]{2}):([0-9]{2}):([0-9]{2}) /,
      );
      return value && [value[0], value[2], value[1], ...value.slice(3)];
    })();
  const date = new Date(parsed);
  const explicitYear = header.match(/(?:^| )([0-9]{4})(?: |$)/)?.[1];
  const months = [
    "Jan",
    "Feb",
    "Mar",
    "Apr",
    "May",
    "Jun",
    "Jul",
    "Aug",
    "Sep",
    "Oct",
    "Nov",
    "Dec",
  ];
  if (
    !parts ||
    (!shortYear && date.getUTCFullYear() !== Number(explicitYear)) ||
    date.getUTCDate() !== Number(parts[1]) ||
    date.getUTCMonth() !== months.indexOf(parts[2] ?? "") ||
    date.getUTCHours() !== Number(parts[3]) ||
    date.getUTCMinutes() !== Number(parts[4]) ||
    date.getUTCSeconds() !== Number(parts[5])
  )
    return now;
  return Number.isFinite(parsed) ? Math.min(deadline, Math.max(now, parsed)) : now;
}

// One lazy authentication attempt, sequential requests, no retries. Credentials
// and response bodies never enter proposal evidence or error messages.
export function createIgdbInspector(
  credentialsFile: string | null | undefined,
  validateImage: ImageValidator,
  fetchImpl: ArtworkFetch = fetch,
  control: { signal?: AbortSignal } = {},
) {
  let tokenPromise: Promise<{ clientId: string; token: string }> | undefined;
  let lastGameRequest = 0;
  let gameRetryAt = 0;
  let imageRetryAt = 0;
  const metrics = {
    authentication_requests: 0,
    game_requests: 0,
    image_requests: 0,
    metadata_bytes: 0,
    image_bytes: 0,
  };
  let deadline = Date.now() + 15 * 60 * 1000;
  let baseline = { ...metrics };
  const used = (key: keyof typeof metrics) => metrics[key] - baseline[key];
  const signal = () => {
    control.signal?.throwIfAborted();
    if (Date.now() >= deadline)
      throw new ArtworkBatchExhausted("Artwork provider batch deadline reached.");
    const timeout = AbortSignal.timeout(Math.min(15000, Math.max(1, deadline - Date.now())));
    return control.signal ? AbortSignal.any([control.signal, timeout]) : timeout;
  };
  const credentials = () => readIgdbCredentials(resolveIgdbCredentialsFile(credentialsFile));
  async function waitForMetadata() {
    for (;;) {
      const now = Date.now();
      const due = Math.max(lastGameRequest + 300, gameRetryAt);
      if (now >= deadline || due >= deadline)
        throw new ArtworkBatchExhausted("Artwork provider batch deadline reached.");
      if (due <= now) return;
      await timers.setTimeout(due - now, undefined, {
        signal: control.signal
          ? AbortSignal.any([control.signal, AbortSignal.timeout(deadline - now)])
          : AbortSignal.timeout(deadline - now),
      });
    }
  }
  async function waitForImages() {
    for (;;) {
      control.signal?.throwIfAborted();
      const now = Date.now();
      if (now >= deadline || imageRetryAt >= deadline)
        throw new ArtworkBatchExhausted(
          "Artwork image provider remains deferred beyond this operation",
        );
      if (imageRetryAt <= now) return;
      const timeout = AbortSignal.timeout(deadline - now);
      await timers.setTimeout(imageRetryAt - now, undefined, {
        signal: control.signal ? AbortSignal.any([control.signal, timeout]) : timeout,
      });
    }
  }
  async function token() {
    if (!tokenPromise)
      tokenPromise = (async () => {
        const privateValue = credentials();
        metrics.authentication_requests++;
        const response = await fetchImpl("https://id.twitch.tv/oauth2/token", {
          method: "POST",
          redirect: "error",
          signal: signal(),
          body: new URLSearchParams({
            client_id: privateValue.client_id,
            client_secret: privateValue.client_secret,
            grant_type: "client_credentials",
          }),
        });
        try {
          if (!response.ok) throw new Error("Twitch authentication unavailable.");
          const value: unknown = JSON.parse(
            (await readBounded(response, 64 * 1024)).toString("utf8"),
          );
          if (!isRecord(value) || typeof value.access_token !== "string" || !value.access_token)
            throw new Error("Twitch authentication unavailable.");
          return { clientId: privateValue.client_id, token: value.access_token };
        } finally {
          cancelBody(response.body);
        }
      })();
    return tokenPromise;
  }
  // One authenticated, paced and bounded metadata transport for game identities and
  // their image relationships. The retained game_requests metric counts these calls.
  async function inspectMetadata(
    endpoint: "games" | "logos" | "artworks" | "image_types",
    body: string,
  ): Promise<unknown> {
    const auth = await token();
    if (used("game_requests") >= 800 || used("metadata_bytes") >= 32 * 1024 * 1024)
      throw new ArtworkBatchExhausted("Artwork metadata budget reached.");
    await waitForMetadata();
    // Another caller can consume the shared budget while this request waits.
    if (used("game_requests") >= 800 || used("metadata_bytes") >= 32 * 1024 * 1024)
      throw new ArtworkBatchExhausted("Artwork metadata budget reached.");
    const requestSignal = signal();
    lastGameRequest = Date.now();
    metrics.game_requests++;
    const response = await fetchImpl(`https://api.igdb.com/v4/${endpoint}`, {
      method: "POST",
      redirect: "error",
      signal: requestSignal,
      headers: {
        "Client-ID": auth.clientId,
        Authorization: `Bearer ${auth.token}`,
        "Content-Type": "text/plain",
      },
      body,
    });
    try {
      if (response.status === 429 || response.status === 503)
        gameRetryAt = Math.max(
          gameRetryAt,
          metadataRetryAt(response.headers.get("retry-after"), Date.now(), 8.64e15),
        );
      if (!response.ok)
        throw new Error(
          endpoint === "games"
            ? "IGDB identity request unavailable."
            : "IGDB media request unavailable.",
        );
      return JSON.parse(
        (
          await readBounded(
            response,
            1024 * 1024,
            (bytes) => {
              metrics.metadata_bytes += bytes;
            },
            32 * 1024 * 1024 - used("metadata_bytes"),
          )
        ).toString("utf8"),
      );
    } finally {
      cancelBody(response.body);
    }
  }
  async function inspectRemoteImage(
    imageId: string,
    variant: "cover_big" | "logo_med_2x" | "720p",
    remainingBytes: number,
  ): Promise<Record<string, unknown> & { sha256: string; bytes: number }> {
    if (!matchesString(imagePattern, imageId)) throw new Error("Invalid image identity.");
    if (used("image_requests") >= 400 || used("image_bytes") >= maximumBatchBytes)
      throw new ArtworkBatchExhausted("Artwork image budget reached.");
    await waitForImages();
    if (used("image_requests") >= 400 || used("image_bytes") >= maximumBatchBytes)
      throw new ArtworkBatchExhausted("Artwork image budget reached.");
    const requestSignal = signal();
    metrics.image_requests++;
    const response = await fetchImpl(
      `https://images.igdb.com/igdb/image/upload/t_${variant}/${imageId}.${variant === "cover_big" ? "jpg" : "png"}`,
      { redirect: "error", signal: requestSignal },
    );
    try {
      if (
        (response.status === 429 || response.status === 503) &&
        response.headers.get("retry-after") !== null
      )
        imageRetryAt = metadataRetryAt(response.headers.get("retry-after"), Date.now(), 8.64e15);
      if (response.status === 410) {
        const error = new Error("IGDB image is gone.");
        goneImageObservations.set(error, imageId);
        throw error;
      }
      if (
        !response.ok ||
        !response.headers
          .get("content-type")
          ?.startsWith(variant === "cover_big" ? "image/jpeg" : "image/png")
      )
        throw new Error("IGDB image unavailable.");
      const bytes = await readBounded(
        response,
        maximumImageBytes,
        (length) => {
          metrics.image_bytes += length;
        },
        Math.min(remainingBytes, maximumBatchBytes - used("image_bytes")),
      );
      const sha256 = createHash("sha256").update(bytes).digest("hex");
      const validated = await validateImage(bytes);
      if (!isRecord(validated)) throw new Error("Image did not pass the core content contract.");
      return { ...validated, sha256, bytes: bytes.length };
    } finally {
      cancelBody(response.body);
    }
  }
  return {
    providerMetrics: metrics,
    ...(control.signal ? { signal: control.signal } : {}),
    restoreProviderBackoff(metadata: number, image: number) {
      gameRetryAt = Math.max(gameRetryAt, metadata);
      imageRetryAt = Math.max(imageRetryAt, image);
    },
    batchStatus: () => ({
      deadline,
      metadata_retry_at: gameRetryAt > Date.now() ? new Date(gameRetryAt).toISOString() : null,
      image_retry_at: imageRetryAt > Date.now() ? new Date(imageRetryAt).toISOString() : null,
      retry_at:
        Math.max(gameRetryAt, imageRetryAt) > Date.now()
          ? new Date(Math.max(gameRetryAt, imageRetryAt)).toISOString()
          : null,
      used: Object.fromEntries(
        Object.keys(metrics).map((key) => [key, used(key as keyof typeof metrics)]),
      ),
    }),
    beginBatch() {
      // Completed operations keep their original signals; authentication and provider pacing survive.
      baseline = { ...metrics };
      deadline = Date.now() + 15 * 60 * 1000;
    },
    async inspectGame(identity: unknown): Promise<unknown> {
      const verified = declaredIdentity(identity);
      return inspectMetadata(
        "games",
        `fields id,name,slug,alternative_names.name,websites.url,platforms,version_parent,version_title,cover.id,cover.image_id; where ${
          verified.game_id != null
            ? `id = ${verified.game_id}`
            : verified.names
                .map(
                  (name) =>
                    `(name ~ ${JSON.stringify(name)} | alternative_names.name ~ ${JSON.stringify(name)})`,
                )
                .join(" | ")
        }; limit 21;`,
      );
    },
    async inspectGameMedia(gameId: number, kind: "logo" | "key_art"): Promise<unknown> {
      if (!positiveId(gameId)) throw new Error("Invalid game media identity.");
      return inspectMetadata(
        kind === "logo" ? "logos" : "artworks",
        `fields id,game,image_id,width,height,alpha_channel,animated,image_type.id,image_type.name; where game = ${gameId}; sort id asc; limit 21;`,
      );
    },
    async inspectImageTypes(): Promise<unknown> {
      // IGDB rejects limits above 500, including an in-page overflow sentinel.
      // Keep the inventory bounded, and prove a full page is complete separately.
      const types = await inspectMetadata("image_types", "fields id,name; sort id asc; limit 500;");
      if (!Array.isArray(types) || types.length > 500)
        throw new Error("IGDB image-type inventory is invalid or incomplete.");
      if (types.length === 500) {
        const overflow = await inspectMetadata(
          "image_types",
          "fields id; sort id asc; limit 1; offset 500;",
        );
        if (!Array.isArray(overflow) || overflow.length !== 0)
          throw new Error("IGDB image-type inventory is invalid or incomplete.");
      }
      return types;
    },
    async inspectImage(imageId: string, remainingBytes = maximumBatchBytes) {
      return observedContent(await inspectRemoteImage(imageId, "cover_big", remainingBytes));
    },
    async inspectMediaImage(
      imageId: string,
      kind: "logo" | "key_art",
      remainingBytes = maximumBatchBytes,
    ) {
      const result = await inspectRemoteImage(
        imageId,
        kind === "logo" ? "logo_med_2x" : "720p",
        remainingBytes,
      );
      if (
        result.format !== "png" ||
        result.validator !== "portcove-core" ||
        !positiveId(result.width) ||
        !positiveId(result.height) ||
        result.width > (kind === "logo" ? 568 : 1280) ||
        result.height > (kind === "logo" ? 320 : 720)
      )
        throw new Error("Game media did not pass its core content and fit-variant contract.");
      return {
        sha256: result.sha256,
        bytes: result.bytes,
        width: result.width,
        height: result.height,
        format: "png" as const,
        validator: "portcove-core" as const,
      };
    },
  };
}

type HeroRole = "key_art" | "logo";
type HeroIdentity = {
  declaration: unknown;
  subject: CatalogMediaSubject;
  neutral: boolean | undefined;
};
type HeroImageCandidate = Record<string, unknown> & { id: number; game: number; image_id: string };
type HeroMediaRecord = {
  port_id: string;
  role: HeroRole;
  subject: CatalogMediaSubject;
  reason: string;
  image_id?: string;
};
type HeroPreparationContext = {
  inspector: Parameters<typeof prepareCatalogGameMedia>[1]["inspector"];
  signal: AbortSignal | undefined;
  games: Map<string, Promise<unknown>>;
  goneImages: Set<string>;
};

function declaredHeroMediaIdentities(port: ArtworkPort, input: unknown): HeroIdentity[] {
  const value = isRecord(input) ? input[port.id] : undefined;
  const supplied: Record<string, unknown> = isRecord(value) ? value : {};
  const original = port.presentation?.original_game;
  const underlying = supplied.underlying_game ?? port.underlying_game;
  const identities: HeroIdentity[] = [
    {
      declaration: supplied.port ?? {
        names: [port.name],
        project_url: port.project_url,
        evidence_url: port.project_url,
      },
      subject: { kind: "port", port_id: port.id },
      neutral: undefined,
    },
  ];
  // An offered edition is never a selected edition. Require an explicit binding;
  // the renderer additionally requires actual applicability or reviewed neutrality.
  if (
    isRecord(original) &&
    typeof original.id === "string" &&
    isRecord(underlying) &&
    typeof underlying.source_edition_id === "string" &&
    Array.isArray(original.source_editions) &&
    original.source_editions.some(
      (edition) => isRecord(edition) && edition.id === underlying.source_edition_id,
    )
  ) {
    identities.push({
      declaration: underlying,
      subject: {
        kind: "original",
        game_id: original.id,
        source_edition_id: underlying.source_edition_id,
      },
      neutral:
        typeof underlying.hero_media_edition_neutral === "boolean"
          ? underlying.hero_media_edition_neutral
          : undefined,
    });
  }
  return identities;
}

async function inspectHeroIdentity(identity: HeroIdentity, context: HeroPreparationContext) {
  try {
    const declared = declaredIdentity(
      identity.declaration,
      identity.subject.kind === "port" ? "port" : "underlying-game",
    );
    const key = JSON.stringify(declared);
    if (!context.games.has(key))
      context.games.set(key, Promise.resolve(context.inspector.inspectGame(declared)));
    const identified = identifiedGame(await context.games.get(key), declared);
    return { game: identified.game, reason: identified.reason ?? "identity-mismatch" };
  } catch (error) {
    context.signal?.throwIfAborted();
    return {
      game: undefined,
      reason:
        error instanceof ArtworkBatchExhausted
          ? "batch-provider-budget-exhausted"
          : "identity-provider-unavailable",
    };
  }
}

function eligibleHeroImage(
  value: unknown,
  game: ObservedGame,
  role: HeroRole,
  gone: Set<string>,
): value is HeroImageCandidate {
  if (
    !isRecord(value) ||
    !positiveId(value.id) ||
    value.game !== game.id ||
    !matchesString(imagePattern, value.image_id) ||
    gone.has(value.image_id) ||
    value.animated === true
  )
    return false;
  if (role === "logo") return true;
  const type = value.image_type;
  return isRecord(type) && positiveId(type.id) && isIgdbKeyArtTypeName(type.name);
}
function heroImageHasLogo(record: HeroImageCandidate) {
  return (
    isRecord(record.image_type) &&
    typeof record.image_type.name === "string" &&
    record.image_type.name.toLowerCase().replace(/[^a-z]/g, "") === "keyartwithlogo"
  );
}
function heroImageCandidates(
  observed: unknown,
  game: ObservedGame,
  role: HeroRole,
  gone: Set<string>,
) {
  if (!Array.isArray(observed) || observed.length >= 21)
    throw new Error("Game image inventory is invalid or incomplete.");
  return observed
    .filter((value): value is HeroImageCandidate => eligibleHeroImage(value, game, role, gone))
    .sort((a, b) => Number(heroImageHasLogo(b)) - Number(heroImageHasLogo(a)) || a.id - b.id);
}

function heroAssetProposal(
  candidate: HeroImageCandidate,
  game: ObservedGame,
  role: HeroRole,
  identity: HeroIdentity,
  image: Awaited<ReturnType<HeroPreparationContext["inspector"]["inspectMediaImage"]>>,
): CatalogMediaAsset {
  const type = isRecord(candidate.image_type) ? candidate.image_type : undefined;
  return {
    id: `igdb-${role.replaceAll("_", "-")}-${identity.subject.kind}-${candidate.id}`,
    role,
    subject: identity.subject,
    ...(identity.neutral === undefined ? {} : { edition_neutral: identity.neutral }),
    caption: role === "logo" ? "Game logo" : "Game key art",
    url: `https://images.igdb.com/igdb/image/upload/t_${role === "logo" ? "logo_med_2x" : "720p"}/${candidate.image_id}.png`,
    sha256: image.sha256,
    width: image.width,
    height: image.height,
    attribution: "Game artwork via IGDB; copyright remains with its rights holders.",
    source_url: `https://www.igdb.com/games/${game.slug}`,
    license: "LicenseRef-IGDB-Terms",
    rights_url: "https://www.twitch.tv/p/en/legal/developer-agreement/",
    igdb: {
      game_id: game.id,
      record_id: candidate.id,
      kind: role === "logo" ? "logo" : "artwork",
      image_id: candidate.image_id,
      game_slug: game.slug,
      ...(typeof candidate.alpha_channel === "boolean"
        ? { alpha_channel: candidate.alpha_channel }
        : {}),
      ...(type && positiveId(type.id) && typeof type.name === "string"
        ? { image_type: type.id, image_type_name: type.name }
        : {}),
    },
  };
}

function observeWithdrawnHeroImage(
  error: unknown,
  media: unknown[],
  context: HeroPreparationContext,
) {
  const gone =
    typeof error === "object" && error !== null ? goneImageObservations.get(error) : undefined;
  if (!gone) return;
  context.goneImages.add(gone);
  for (let index = media.length - 1; index >= 0; index--) {
    const asset = media[index];
    if (isRecord(asset) && isRecord(asset.igdb) && asset.igdb.image_id === gone)
      media.splice(index, 1);
  }
}
async function inspectHeroRole(
  game: ObservedGame,
  role: HeroRole,
  identity: HeroIdentity,
  media: unknown[],
  context: HeroPreparationContext,
) {
  const observed = await context.inspector.inspectGameMedia(game.id, role);
  const candidates = heroImageCandidates(observed, game, role, context.goneImages);
  let reason = candidates.length ? "images-unavailable-or-unsuitable" : "no-suitable-role-observed";
  // Finite candidate chain; one bad file does not erase another media role.
  for (const candidate of candidates.slice(0, 4)) {
    context.signal?.throwIfAborted();
    if (context.goneImages.has(candidate.image_id)) continue;
    try {
      const image = await context.inspector.inspectMediaImage(candidate.image_id, role);
      return {
        asset: heroAssetProposal(candidate, game, role, identity, image),
        reason: "role-selected",
      };
    } catch (error) {
      context.signal?.throwIfAborted();
      observeWithdrawnHeroImage(error, media, context);
      if (error instanceof ArtworkBatchExhausted) {
        reason = "batch-provider-budget-exhausted";
        break;
      }
    }
  }
  return { asset: undefined, reason };
}

function upsertHeroMedia(media: unknown[], asset: CatalogMediaAsset) {
  const index = media.findIndex(
    (value) =>
      isRecord(value) &&
      value.role === asset.role &&
      sameMediaSubject(value.subject, asset.subject),
  );
  if (index >= 0) media[index] = asset;
  else media.push(asset);
}
async function prepareHeroIdentity(
  portId: string,
  identity: HeroIdentity,
  media: unknown[],
  records: HeroMediaRecord[],
  context: HeroPreparationContext,
) {
  const identified = await inspectHeroIdentity(identity, context);
  for (const role of ["key_art", "logo"] as const) {
    if (!identified.game) {
      records.push({ port_id: portId, role, subject: identity.subject, reason: identified.reason });
      continue;
    }
    try {
      const selected = await inspectHeroRole(identified.game, role, identity, media, context);
      if (selected.asset) upsertHeroMedia(media, selected.asset);
      records.push({
        port_id: portId,
        role,
        subject: identity.subject,
        reason: selected.reason,
        ...(selected.asset?.igdb ? { image_id: selected.asset.igdb.image_id } : {}),
      });
    } catch (error) {
      context.signal?.throwIfAborted();
      records.push({
        port_id: portId,
        role,
        subject: identity.subject,
        reason:
          error instanceof ArtworkBatchExhausted
            ? "batch-provider-budget-exhausted"
            : "media-provider-unavailable-or-incomplete",
      });
    }
  }
}
function removeWithdrawnCatalogMedia(
  catalog: ArtworkCatalog,
  records: HeroMediaRecord[],
  gone: Set<string>,
) {
  // A withdrawal invalidates every candidate reference, including unselected ports
  // and records completed earlier in this batch.
  for (const port of catalog.ports) {
    const artwork = port.presentation?.artwork;
    if (validArtworkMapping(artwork) && gone.has(artwork.image_id) && port.presentation)
      delete port.presentation.artwork;
    const media = port.presentation?.media;
    if (Array.isArray(media))
      port.presentation = {
        ...port.presentation,
        media: media.filter(
          (asset) =>
            !isRecord(asset) || !isRecord(asset.igdb) || !gone.has(String(asset.igdb.image_id)),
        ),
      };
  }
  for (const record of records)
    if (record.image_id && gone.has(record.image_id))
      record.reason = "selected-image-gone-later-in-batch";
}

/** Propose descriptive foreground assets through the existing identity/provider
 * authority. This grants no publication or image-payload export rights. */
export async function prepareCatalogGameMedia(
  catalog: ArtworkCatalog,
  options: {
    identities?: unknown;
    selectedPortIds?: readonly string[];
    knownGoneImageIds?: readonly string[];
    inspector: Pick<
      ReturnType<typeof createIgdbInspector>,
      "inspectGame" | "inspectGameMedia" | "inspectMediaImage"
    >;
    signal?: AbortSignal;
  },
) {
  validateKnownGoneImages(options.knownGoneImageIds);
  const selected = options.selectedPortIds ?? catalog.ports.map((port) => port.id);
  if (
    selected.length > 400 ||
    new Set(selected).size !== selected.length ||
    selected.some((id) => !catalog.ports.some((port) => port.id === id))
  )
    throw new Error("Game media worksets require at most400 unique catalog port ids.");
  const result = structuredClone(catalog);
  const records: HeroMediaRecord[] = [];
  const context: HeroPreparationContext = {
    inspector: options.inspector,
    signal: options.signal,
    games: new Map(),
    goneImages: new Set(options.knownGoneImageIds ?? []),
  };
  for (const port of result.ports) {
    if (!selected.includes(port.id)) continue;
    options.signal?.throwIfAborted();
    const current = port.presentation?.media;
    const media: unknown[] = Array.isArray(current) ? structuredClone(current as unknown[]) : [];
    for (const identity of declaredHeroMediaIdentities(port, options.identities))
      await prepareHeroIdentity(port.id, identity, media, records, context);
    if (media.length || Array.isArray(current)) port.presentation = { ...port.presentation, media };
  }
  removeWithdrawnCatalogMedia(result, records, context.goneImages);
  return { catalog: result, records, gone_image_ids: [...context.goneImages].sort() };
}

function sameMediaSubject(value: unknown, subject: CatalogMediaSubject) {
  if (!isRecord(value) || value.kind !== subject.kind) return false;
  return subject.kind === "port"
    ? value.port_id === subject.port_id
    : value.game_id === subject.game_id && value.source_edition_id === subject.source_edition_id;
}

function isIgdbKeyArtTypeName(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length <= 128 &&
    ["keyart", "keyartwithlogo", "keyartwithoutlogo"].includes(
      value.toLowerCase().replace(/[^a-z0-9]/g, ""),
    )
  );
}

// Reuse the actual core decoder through its existing CLI import into a fresh
// task-owned library. No user library/choice or arbitrary provider command.
export function createCoreImageValidator(cli: string, scratchRoot: string) {
  mkdirSync(scratchRoot, { recursive: true });
  const root = mkdtempSync(join(resolve(scratchRoot), "core-image-validation-"));
  const artifact = join(root, process.platform === "win32" ? "validator.exe" : "validator");
  copyFileSync(resolve(cli), artifact);
  chmodSync(artifact, 0o500);
  const artifactSha256 = createHash("sha256").update(readFileSync(artifact)).digest("hex");
  let ordinal = 0;
  return (bytes: Buffer) => {
    const runRoot = join(root, String(++ordinal));
    mkdirSync(runRoot);
    const file = join(runRoot, "image.jpg");
    writeFileSync(file, bytes, { flag: "wx" });
    const env = Object.fromEntries(
      Object.entries(process.env).filter(([name]) => name.toUpperCase() !== "PORTCOVE_LIBRARY"),
    );
    const child = spawnSync(
      artifact,
      [
        "--library",
        join(runRoot, "library"),
        "--json",
        "--non-interactive",
        "artwork",
        "import",
        "shipwright",
        file,
      ],
      { env, encoding: "utf8", timeout: 30000, maxBuffer: 1024 * 1024, windowsHide: true },
    );
    writeFileSync(
      join(runRoot, "validation-process.json"),
      JSON.stringify(
        {
          validator_artifact_sha256: artifactSha256,
          status: child.status,
          signal: child.signal,
          error_code: errorCode(child.error) ?? null,
          stdout_tail: child.stdout?.slice(-16384) ?? "",
          stderr_tail: child.stderr?.slice(-16384) ?? "",
        },
        null,
        2,
      ),
      { flag: "wx" },
    );
    if (child.error || child.status !== 0)
      throw new Error("Core image validation refused or unavailable.");
    const envelope: unknown = JSON.parse(child.stdout);
    const data = isRecord(envelope) ? envelope.data : undefined;
    const value = isRecord(data) ? data.selection : undefined;
    if (
      !isRecord(value) ||
      value.sha256 !== createHash("sha256").update(bytes).digest("hex") ||
      value.byte_size !== bytes.length
    )
      throw new Error("Core image validation identity mismatch.");
    return {
      width: value.width,
      height: value.height,
      format: value.format,
      validator: "portcove-core",
      validator_artifact_sha256: artifactSha256,
    };
  };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  throw new Error(
    "Use catalog batch preparation: node scripts/generate-catalog.mts --prepare-artwork INPUT --identities FACTS --credentials-file PRIVATE --validator-cli CLI --output-dir OUTPUT.",
  );
}
