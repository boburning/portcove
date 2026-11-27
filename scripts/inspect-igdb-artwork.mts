import { readIgdbCredentials, resolveIgdbCredentialsFile } from "./maintainer-config.mts";
import type { ReadableStreamReadResult } from "node:stream/web";
import { isRecord, errorCode } from "./runtime-values.mts";
import { originalEditionMediaKey, typedIgdbScene } from "./shared-original-media.mts";
import type { ReviewedOriginalMediaDecision } from "./reviewed-original-media.mts";
import {
  artworkEvidenceUrl,
  hashPattern,
  imagePattern,
  matchesIgdbRegionalCover,
  matchesString,
  positiveId,
  slugPattern,
  validArtworkMapping,
  validArtworkCollection,
  validIgdbRegionalCover,
  type IgdbRegionalCover,
} from "./catalog-cover-mapping.mts";
import type {
  IgdbArtwork,
  IgdbArtworkMatch,
  CatalogMediaAsset,
  CatalogMediaSubject,
} from "../apps/desktop/src/transport-types.generated.d.ts";
import {
  constants,
  writeFileSync,
  mkdtempSync,
  mkdirSync,
  openSync,
  readSync,
  fstatSync,
  closeSync,
  copyFileSync,
  chmodSync,
  rmSync,
} from "node:fs";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { isDeepStrictEqual } from "node:util";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import timers from "node:timers/promises";

export { validArtworkMapping } from "./catalog-cover-mapping.mts";

export interface ArtworkPort extends Record<string, unknown> {
  id: string;
  name?: unknown;
  project_url?: unknown;
  source_profile?: unknown;
  /** Reviewed original-title facts supplied by per-record preparation. */
  underlying_game?: unknown;
  igdb_regional_cover?: IgdbRegionalCover;
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

export function assertPreparedArtwork(
  catalog: ArtworkCatalog,
): asserts catalog is PreparedArtworkCatalog {
  for (const port of catalog.ports) {
    const artwork = port.presentation?.artwork;
    collectionCovers(port);
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
  localization?: { id: number; region_id: number };
}
interface ObservedGame {
  id: number;
  name: string;
  slug: string;
  cover?: unknown;
  game_localizations?: unknown;
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
  | {
      scope: "reviewed-cover-collection";
      members: { image_id: string; content: ImageContent }[];
      live_refresh_passed: boolean;
    }
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
  collection?: IgdbArtwork[];
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
  reviewedOriginalMedia?: ReadonlyMap<string, ReviewedOriginalMediaDecision>;
  reviewedOriginalMediaExclusions?: ReadonlySet<string>;
  /** Bound provider work without truncating the catalog or its identity checks. */
  selectedPortIds?: readonly string[];
  refreshPortIds?: readonly string[];
  /** Maintenance revalidates the approved owner of each retained cover. */
  revalidateAccepted?: boolean;
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
// Only this module's fixed image request can establish a Gone observation.
// Provider metadata, generic errors and caller-supplied status properties cannot.
type IgdbImageVariant = "cover_big" | "logo_med_2x" | "720p";
const goneImageObservations = new WeakMap<object, string>();

export function isConfirmedIgdbImageGone(
  error: unknown,
  imageId: string,
  variant: IgdbImageVariant = "cover_big",
) {
  return isRecord(error) && goneImageObservations.get(error) === `${variant}/${imageId}`;
}

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

function declaredIdentity(
  value: unknown,
  requestedKind?: IgdbArtworkMatch,
  allowUnnamedExact = false,
): DeclaredIdentity {
  const kind = requestedKind ?? (isRecord(value) ? (value.kind ?? "port") : "port");
  if (kind !== "port" && kind !== "underlying-game")
    throw new Error("Artwork identity kind is invalid.");
  if (
    !isRecord(value) ||
    (value.game_id != null && !positiveId(value.game_id)) ||
    (value.slug != null && !matchesString(slugPattern, value.slug)) ||
    !Array.isArray(value.names) ||
    (!value.names.length &&
      !(
        allowUnnamedExact &&
        positiveId(value.game_id) &&
        matchesString(slugPattern, value.slug)
      )) ||
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
  const localization = value.localization;
  if (
    localization !== undefined &&
    (kind !== "underlying-game" ||
      !positiveId(value.game_id) ||
      !isRecord(localization) ||
      !positiveId(localization.id) ||
      !positiveId(localization.region_id))
  )
    throw new Error("Artwork localization requires a fixed original game and region.");
  const projectUrl = value.project_url ? artworkEvidenceUrl(value.project_url) : null;
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
    evidence_url: artworkEvidenceUrl(value.evidence_url),
    project_url: projectUrl,
    platform_ids: platforms,
    edition: value.edition ?? null,
    ...(isRecord(value.localization) &&
    positiveId(value.localization.id) &&
    positiveId(value.localization.region_id)
      ? { localization: { id: value.localization.id, region_id: value.localization.region_id } }
      : {}),
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
    declared.names.length > 0 &&
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
  const regional = port.igdb_regional_cover ?? accepted.igdb_regional_cover;
  if (regional)
    return JSON.stringify(regional) === JSON.stringify(accepted.igdb_regional_cover) &&
      matchesIgdbRegionalCover(mapping, regional)
      ? structuredClone(mapping)
      : null;
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

/** Index the exact accepted inputs once per workset. Only the current port
 * and equivalent accepted original-game mappings affect its preparation. */
export function artworkPreparationInputs(
  accepted: ArtworkCatalog,
  identities: unknown,
  reviewedOriginalMedia?: ArtworkPreparationOptions["reviewedOriginalMedia"],
) {
  const originalKey = (id: number, slug: string) => JSON.stringify([id, slug]);
  const ports = new Map<string, ArtworkPort>();
  const originals = new Map<string, Map<string, IgdbArtwork>>();
  for (const entry of accepted.ports) {
    if (!ports.has(entry.id)) ports.set(entry.id, entry);
    const mapping = entry.presentation?.artwork;
    if (
      entry.igdb_regional_cover ||
      !validArtworkMapping(mapping) ||
      mapping.match_kind !== "underlying-game"
    )
      continue;
    const key = originalKey(mapping.game_id, mapping.game_slug);
    const values = originals.get(key) ?? new Map<string, IgdbArtwork>();
    values.set(JSON.stringify(mapping), mapping);
    originals.set(key, values);
  }

  return (port: ArtworkPort) => {
    const supplied = isRecord(identities) ? identities[port.id] : undefined;
    const underlying = isRecord(supplied)
      ? (supplied.underlying_game ?? port.underlying_game)
      : port.underlying_game;
    const cover = reviewedCoverDeclaration(port, underlying, reviewedOriginalMedia);
    let original: DeclaredIdentity | null = null;
    try {
      if (cover.declaration)
        original = declaredIdentity(cover.declaration, "underlying-game", Boolean(cover.review));
    } catch {
      /* The raw declaration remains bound and produces the existing refusal. */
    }
    const mappings =
      original?.game_id != null && original.slug != null
        ? originals.get(originalKey(original.game_id, original.slug))
        : undefined;
    return {
      port,
      accepted: ports.get(port.id) ?? null,
      supplied: supplied ?? null,
      ...(cover.review ? { reviewed_original_cover: cover.review } : {}),
      accepted_original_candidates: [...(mappings?.values() ?? [])],
    };
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

function reviewedCoverDeclaration(
  port: ArtworkPort,
  underlying: unknown,
  reviewed: ArtworkPreparationOptions["reviewedOriginalMedia"],
) {
  if (!reviewed?.size) return { declaration: underlying };
  const scopes = originalMediaScopes(port);
  const edition = isRecord(underlying) ? underlying.source_edition_id : undefined;
  const scope =
    edition === undefined && scopes.length === 1
      ? scopes[0]
      : scopes.find(({ subject }) => subject.source_edition_id === edition);
  const decision = scope && reviewed.get(scope.key);
  if (decision?.decision === "match")
    return {
      declaration: {
        game_id: decision.game_id,
        slug: decision.slug,
        evidence_url: decision.evidence_url,
        names: [],
      },
      review: decision,
    };
  if (decision?.decision === "exclude")
    return { declaration: null, review: decision, reason: "reviewed-original-match-excluded" };
  if (!scope && scopes.some(({ key }) => reviewed.has(key)))
    return {
      declaration: null,
      review: "ambiguous",
      reason: "reviewed-original-edition-ambiguous",
    };
  return { declaration: underlying };
}

function selectOriginalCover(
  port: ArtworkPort,
  underlying: unknown,
  context: ArtworkContext,
  exceptions: ArtworkException[],
) {
  const cover = reviewedCoverDeclaration(
    port,
    underlying,
    context.reviewedOriginalMediaExclusions?.has(port.id)
      ? undefined
      : context.reviewedOriginalMedia,
  );
  if (cover.reason) {
    exceptions.push(exception("underlying-game", cover.reason));
    return null;
  }
  return selectCover(
    cover.declaration,
    "underlying-game",
    context,
    exceptions,
    undefined,
    Boolean(cover.review),
  );
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
    .filter((port) => !port.igdb_regional_cover)
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

async function inspectCoverContent(
  imageId: string,
  kind: IgdbArtworkMatch,
  context: ArtworkContext,
  exceptions: ArtworkException[],
) {
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
    if (isConfirmedIgdbImageGone(error, imageId)) {
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
  return content;
}

async function selectCover(
  identity: unknown,
  kind: IgdbArtworkMatch,
  context: ArtworkContext,
  exceptions: ArtworkException[],
  authoredRegional?: IgdbRegionalCover,
  allowUnnamedExact = false,
): Promise<SelectedCover | null> {
  if (!identity) {
    exceptions.push(exception(kind, "identity-not-declared"));
    return null;
  }
  let declared;
  try {
    declared = declaredIdentity(identity, kind, allowUnnamedExact);
    if (declared.localization && !authoredRegional)
      throw new Error("Regional cover selection requires an authored port record.");
  } catch {
    exceptions.push(exception(kind, "identity-declaration-invalid"));
    return null;
  }
  if (kind === "underlying-game" && !declared.localization && !context.refreshing) {
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
  let candidate = game.cover;
  if (declared.localization) {
    const { id, region_id } = declared.localization;
    const localizations: unknown[] = Array.isArray(game.game_localizations)
      ? game.game_localizations
      : [];
    const matches = localizations.filter((row) => isRecord(row) && row.id === id);
    const regional = matches.length === 1 && isRecord(matches[0]) ? matches[0] : undefined;
    if (
      localizations.length > 256 ||
      regional?.game !== game.id ||
      regional.region !== region_id ||
      !isRecord(regional.cover) ||
      regional.cover.game_localization !== id ||
      !authoredRegional ||
      regional.cover.id !== authoredRegional.cover_id ||
      regional.cover.image_id !== authoredRegional.image_id
    ) {
      exceptions.push(exception(kind, "regional-cover-unavailable-or-mismatched"));
      return null;
    }
    candidate = regional.cover;
  }
  const cover = isRecord(candidate) ? candidate : undefined;
  if (!cover || !positiveId(cover.id) || !matchesString(imagePattern, cover.image_id)) {
    exceptions.push(exception(kind, "no-usable-cover"));
    return null;
  }
  const imageId = cover.image_id;
  const content = await inspectCoverContent(imageId, kind, context, exceptions);
  if (!content) return null;
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
    if (withdrawCompanionCover(port, context.goneImages)) invalidated.push(port.id);
    if (withdrawCollectionCovers(port, context.goneImages)) {
      invalidated.push(port.id);
      const record = byId.get(port.id);
      if (record?.collection) {
        const remaining = collectionCovers(port);
        if (remaining.length) record.collection = remaining;
        else {
          delete record.collection;
          if (record.reason.startsWith("accepted-mapping")) context.metrics.reused--;
          else context.metrics.selected--;
          record.reason = "generated-fallback";
          record.checks = null;
          context.metrics.fallback++;
        }
      }
    }
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
    const priorPort = accepted.get(port.id);
    const members = collectionCovers(port);
    const regional = port.igdb_regional_cover ?? priorPort?.igdb_regional_cover;
    if (regional !== undefined && !validIgdbRegionalCover(regional))
      throw new Error(`Invalid authored regional cover: ${port.id}`);
    if (priorPort?.igdb_regional_cover && priorPort.project_url !== port.project_url)
      throw new Error(`Regional cover needs new source review: ${port.id}`);
    const reused = reusableMapping(
      port,
      priorPort,
      options.revalidateAccepted ? undefined : supplied,
    );
    if (!workset.has(port.id)) {
      if (JSON.stringify(members) !== JSON.stringify(priorPort ? collectionCovers(priorPort) : []))
        throw new Error(`Changed collection identity outside selected workset: ${port.id}`);
      const prior = accepted.get(port.id)?.presentation?.artwork;
      const mapping = port.presentation?.artwork;
      if (
        JSON.stringify(mapping ?? null) !== JSON.stringify(prior ?? null) ||
        (mapping !== undefined && !reused)
      )
        throw new Error(`Changed artwork identity outside selected workset: ${port.id}`);
      continue;
    }
    if (members.length) {
      const same =
        priorPort &&
        port.name === priorPort.name &&
        port.project_url === priorPort.project_url &&
        port.source_profile === priorPort.source_profile &&
        JSON.stringify(port.underlying_game ?? null) ===
          JSON.stringify(priorPort.underlying_game ?? null) &&
        JSON.stringify(members) === JSON.stringify(collectionCovers(priorPort));
      if (!same) {
        if (port.presentation) delete port.presentation.collection_covers;
        context.metrics.fallback++;
        await completed(
          {
            port_id: port.id,
            role: "cover",
            reason: "collection-mapping-review-required",
            mapping: null,
            checks: null,
            exceptions: [exception("underlying-game", "collection-mapping-review-required")],
          },
          port,
        );
        continue;
      }
      const exceptions: ArtworkException[] = [];
      const observed: { image_id: string; content: ImageContent }[] = [];
      const refreshing = refresh.has(port.id);
      if (refreshing) {
        for (const cover of members) {
          const content = await inspectCoverContent(
            cover.image_id,
            cover.match_kind,
            context,
            exceptions,
          );
          if (content?.sha256 === cover.image_sha256) {
            context.goneImages.delete(cover.image_id);
            observed.push({ image_id: cover.image_id, content });
          } else if (content)
            exceptions.push({
              ...exception(cover.match_kind, "collection-image-digest-changed"),
              image_id: cover.image_id,
            });
        }
      }
      withdrawCollectionCovers(port, context.goneImages);
      const remaining = collectionCovers(port);
      const passed =
        remaining.length > 0 &&
        remaining.every((cover) => observed.some((value) => value.image_id === cover.image_id));
      if (remaining.length) context.metrics.reused++;
      else context.metrics.fallback++;
      await completed(
        {
          port_id: port.id,
          role: "cover",
          mapping: null,
          ...(remaining.length ? { collection: remaining } : {}),
          reason: !remaining.length
            ? "generated-fallback"
            : !refreshing
              ? "accepted-mapping-collection-reused"
              : passed
                ? "accepted-mapping-collection-refreshed"
                : "accepted-mapping-collection-retained-after-unavailable-refresh",
          checks: !remaining.length
            ? null
            : refreshing
              ? {
                  scope: "reviewed-cover-collection",
                  members: observed,
                  live_refresh_passed: passed,
                }
              : { scope: "retained-accepted-mapping", download_repeated: false },
          exceptions,
        },
        port,
      );
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
    const retainedIdentity =
      options.revalidateAccepted && reused && !regional
        ? { kind: reused.match_kind, game_id: reused.game_id, slug: reused.game_slug }
        : null;
    const retainedDeclaration =
      retainedIdentity?.kind === "port" ? declarations.port : declarations.underlying_game;
    const selected = retainedIdentity
      ? await selectCover(
          {
            ...(retainedDeclaration === undefined
              ? { names: [], evidence_url: port.project_url }
              : isRecord(retainedDeclaration)
                ? retainedDeclaration
                : {}),
            ...retainedIdentity,
          },
          retainedIdentity.kind,
          context,
          exceptions,
          undefined,
          retainedDeclaration === undefined,
        )
      : regional
        ? await selectCover(
            {
              game_id: regional.game_id,
              slug: regional.slug,
              names: [regional.name],
              evidence_url: port.project_url,
              platform_ids: [regional.platform_id],
              localization: { id: regional.localization_id, region_id: regional.region_id },
            },
            "underlying-game",
            context,
            exceptions,
            regional,
          )
        : ((await selectCover(declarations.port, "port", context, exceptions)) ??
          (await selectOriginalCover(port, declarations.underlying_game, context, exceptions)));
    const companion = port.presentation?.companion_cover;
    if (context.refreshing && validArtworkMapping(companion)) {
      const content = await inspectCoverContent(
        companion.image_id,
        companion.match_kind,
        context,
        exceptions,
      );
      if (content?.sha256 === companion.image_sha256) context.goneImages.delete(companion.image_id);
      else if (content)
        exceptions.push({
          kind: companion.match_kind,
          reason: "companion-image-digest-changed",
          image_id: companion.image_id,
          resume: "Review the changed cover before replacing its pinned digest.",
        });
    }

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
  assertPreparedArtwork(result);
  return {
    catalog: result,
    records,
    metrics: context.metrics,
    gone_image_ids: [...context.goneImages].sort(),
    workset: {
      catalog_ports: catalog.ports.length,
      selected_port_ids: [...workset],
      invalidated_port_ids: [...new Set(invalidatedPortIds)],
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

/** Reconcile later cover observations into the existing cover proposal and its
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
  control: {
    signal?: AbortSignal;
    onBackoff?: (status: {
      metadata_retry_at: string | null;
      image_retry_at: string | null;
    }) => void;
  } = {},
) {
  let tokenPromise: Promise<{ clientId: string; token: string }> | undefined;
  let lastGameRequest = 0;
  let gameRetryAt = 0;
  let imageRetryAt = 0;
  const backoff = () => ({
    metadata_retry_at: gameRetryAt > Date.now() ? new Date(gameRetryAt).toISOString() : null,
    image_retry_at: imageRetryAt > Date.now() ? new Date(imageRetryAt).toISOString() : null,
  });
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
    endpoint: "games" | "logos" | "artworks" | "screenshots" | "image_types",
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
      if (response.status === 429 || response.status === 503) {
        gameRetryAt = Math.max(
          gameRetryAt,
          metadataRetryAt(response.headers.get("retry-after"), Date.now(), 8.64e15),
        );
        control.onBackoff?.(backoff());
      }
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
    variant: IgdbImageVariant,
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
      ) {
        imageRetryAt = metadataRetryAt(response.headers.get("retry-after"), Date.now(), 8.64e15);
        control.onBackoff?.(backoff());
      }
      if (response.status === 410) {
        const error = new Error("IGDB image is gone.");
        goneImageObservations.set(error, `${variant}/${imageId}`);
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
      ...backoff(),
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
      const verified = declaredIdentity(identity, undefined, true);
      return inspectMetadata(
        "games",
        `fields id,name,slug,alternative_names.name,websites.url,platforms,version_parent,version_title,cover.id,cover.image_id${verified.localization ? ",game_localizations.id,game_localizations.game,game_localizations.region,game_localizations.cover.id,game_localizations.cover.image_id,game_localizations.cover.game_localization" : ""}; where ${
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
    async inspectGameMedia(
      gameId: number,
      role: "logo" | "key_art" | "screenshot",
    ): Promise<unknown> {
      if (!positiveId(gameId)) throw new Error("Invalid game media identity.");
      const fields = "id,game,image_id,width,height,alpha_channel,animated";
      return inspectMetadata(
        gameMediaRoles[role].endpoint,
        `fields ${fields}${role === "screenshot" ? "" : ",image_type.id,image_type.name"}; where game = ${gameId}; sort id asc; limit 21;`,
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
      role: GameMediaRole,
      remainingBytes = maximumBatchBytes,
    ) {
      const result = await inspectRemoteImage(
        imageId,
        gameMediaRoles[role].variant,
        remainingBytes,
      );
      if (
        result.format !== "png" ||
        result.validator !== "portcove-core" ||
        !positiveId(result.width) ||
        !positiveId(result.height) ||
        !gameMediaDimensionsFit(role, result.width, result.height)
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

export const gameMediaRoles = {
  key_art: { endpoint: "artworks", kind: "artwork", variant: "720p", caption: "Game key art" },
  logo: { endpoint: "logos", kind: "logo", variant: "logo_med_2x", caption: "Game logo" },
  header: { endpoint: "artworks", kind: "artwork", variant: "720p", caption: "Game background" },
  screenshot: {
    endpoint: "screenshots",
    kind: "screenshot",
    variant: "720p",
    caption: "Game screenshot",
  },
} as const;
type GameMediaRole = keyof typeof gameMediaRoles;
export function gameMediaImageTarget(role: GameMediaRole, imageId: string) {
  return `${gameMediaRoles[role].variant}/${imageId}`;
}
export function gameMediaDimensionsFit(role: GameMediaRole, width: number, height: number) {
  return width <= (role === "logo" ? 568 : 1280) && height <= (role === "logo" ? 320 : 720);
}
export const catalogGameMediaRoles = Object.freeze(Object.keys(gameMediaRoles) as GameMediaRole[]);
const gameMediaRoleLimits: Readonly<Record<GameMediaRole, number>> = {
  header: 2,
  key_art: 2,
  logo: 2,
  screenshot: 8,
};
type HeroIdentity = {
  declaration: unknown;
  subject: CatalogMediaSubject;
  foregroundNeutral: boolean | undefined;
  acceptedExact?: true;
  conflictingAcceptedMatches?: true;
  excludedByReview?: true;
};
type HeroImageCandidate = Record<string, unknown> & { id: number; game: number; image_id: string };
type HeroMediaRecord = {
  port_id: string;
  role: GameMediaRole;
  subject: CatalogMediaSubject;
  reason: string;
  image_id?: string;
  provider_game_id?: number;
  withdrawn_image_ids?: string[];
};
type HeroPreparationContext = {
  inspector: Parameters<typeof prepareCatalogGameMedia>[1]["inspector"];
  signal: AbortSignal | undefined;
  games: Map<string, Promise<unknown>>;
  inventories: Map<string, Promise<unknown>>;
  images: Map<string, ReturnType<HeroPreparationContext["inspector"]["inspectMediaImage"]>>;
  imageDigests: Map<string, Set<string>>;
  goneImages: Set<string>;
  heldImages: Set<string>;
};

function originalMediaScopes(port: ArtworkPort) {
  const original = port.presentation?.original_game;
  if (
    !isRecord(original) ||
    typeof original.id !== "string" ||
    !Array.isArray(original.source_editions)
  )
    return [];
  const gameId = original.id;
  return (original.source_editions as unknown[]).flatMap((edition) => {
    if (!isRecord(edition) || typeof edition.id !== "string") return [];
    const key = originalEditionMediaKey(gameId, edition);
    if (!key) return [];
    return [
      {
        key,
        subject: { kind: "original" as const, game_id: gameId, source_edition_id: edition.id },
      },
    ];
  });
}

export function acceptedHeroMediaMatches(
  catalog: ArtworkCatalog | undefined,
  excluded: ReadonlySet<string>,
) {
  const matches = new Map<string, { game_id: number; slug: string } | null>();
  for (const port of catalog?.ports ?? []) {
    const media = port.presentation?.media;
    if (excluded.has(port.id) || !Array.isArray(media)) continue;
    for (const { key, subject } of originalMediaScopes(port)) {
      for (const asset of media as unknown[]) {
        if (!isRecord(asset) || !sameMediaSubject(asset.subject, subject) || !isRecord(asset.igdb))
          continue;
        const { game_id, game_slug: slug, record_id } = asset.igdb;
        const target = catalogMediaImageTarget(asset);
        if (
          !target ||
          !matchesString(imagePattern, asset.igdb.image_id) ||
          !positiveId(game_id) ||
          !positiveId(record_id) ||
          !matchesString(slugPattern, slug) ||
          !matchesString(hashPattern, asset.sha256) ||
          asset.source_url !== `https://www.igdb.com/games/${slug}` ||
          asset.url !== `https://images.igdb.com/igdb/image/upload/t_${target}.png`
        )
          continue;
        const previous = matches.get(key);
        if (previous === undefined) matches.set(key, { game_id, slug });
        else if (previous && (previous.game_id !== game_id || previous.slug !== slug))
          matches.set(key, null);
      }
    }
  }
  return matches;
}

function retainedDirectoryMedia(port: ArtworkPort, accepted: ArtworkPort | undefined) {
  const media = accepted?.presentation?.media;
  if (!accepted || port.project_url !== accepted.project_url || !Array.isArray(media)) return [];
  const strict = port.presentation?.media;
  if (
    Array.isArray(strict) &&
    (!strict.length ||
      !isDeepStrictEqual(
        strict,
        media.filter((asset: unknown) => !typedIgdbScene(asset)),
      ))
  )
    return [];
  const offered = new Set(originalMediaScopes(port).map(({ key }) => key));
  const applicable = originalMediaScopes(accepted).filter(({ key }) => offered.has(key));
  return (media as unknown[]).filter((asset) => {
    if (!isRecord(asset) || !isRecord(asset.subject)) return false;
    if (Array.isArray(strict) && !typedIgdbScene(asset)) return false;
    if (asset.subject.kind === "port")
      return (
        typeof port.project_url === "string" &&
        port.project_url === accepted.project_url &&
        asset.subject.port_id === port.id
      );
    return applicable.some(({ subject }) => sameMediaSubject(asset.subject, subject));
  });
}

function declaredHeroMediaIdentities(
  port: ArtworkPort,
  input: unknown,
  accepted: ReturnType<typeof acceptedHeroMediaMatches>,
  reviewed: ReadonlyMap<string, ReviewedOriginalMediaDecision> | undefined,
  cleared: boolean,
): HeroIdentity[] {
  const value = isRecord(input) ? input[port.id] : undefined;
  const supplied: Record<string, unknown> = isRecord(value) ? value : {};
  const underlying = supplied.underlying_game ?? port.underlying_game;
  const identities: HeroIdentity[] = [
    {
      declaration: supplied.port ?? {
        names: [port.name],
        project_url: port.project_url,
        evidence_url: port.project_url,
      },
      subject: { kind: "port", port_id: port.id },
      foregroundNeutral: undefined,
    },
  ];
  // A reviewed decision takes precedence over preparation inputs and previously
  // inferred matches. The renderer still requires applicability for an edition.
  for (const { key, subject } of originalMediaScopes(port)) {
    const decision = reviewed?.get(key);
    if (decision) {
      if (!cleared)
        identities.push({
          subject,
          foregroundNeutral: undefined,
          declaration:
            decision.decision === "match"
              ? {
                  game_id: decision.game_id,
                  slug: decision.slug,
                  evidence_url: decision.evidence_url,
                  names: [],
                }
              : null,
          ...(decision.decision === "match" ? { acceptedExact: true } : { excludedByReview: true }),
        });
      continue;
    }
    if (isRecord(underlying) && underlying.source_edition_id !== undefined) {
      if (underlying.source_edition_id === subject.source_edition_id)
        identities.push({
          declaration: underlying,
          subject,
          foregroundNeutral:
            typeof underlying.hero_media_edition_neutral === "boolean"
              ? underlying.hero_media_edition_neutral
              : undefined,
        });
      continue;
    }
    const match = accepted.get(key);
    if (!cleared && match !== undefined)
      identities.push({
        subject,
        foregroundNeutral: undefined,
        declaration: match && {
          ...match,
          names: [],
          evidence_url: `https://www.igdb.com/games/${match.slug}`,
        },
        ...(match ? { acceptedExact: true } : { conflictingAcceptedMatches: true }),
      });
  }
  return identities;
}

async function inspectHeroIdentity(identity: HeroIdentity, context: HeroPreparationContext) {
  if (identity.excludedByReview) return { game: undefined, reason: "identity-excluded-by-review" };
  if (identity.conflictingAcceptedMatches) return { game: undefined, reason: "identity-ambiguous" };
  try {
    const declared = declaredIdentity(
      identity.declaration,
      identity.subject.kind === "port" ? "port" : "underlying-game",
      identity.acceptedExact,
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
  role: GameMediaRole,
): value is HeroImageCandidate {
  if (
    !isRecord(value) ||
    !positiveId(value.id) ||
    value.game !== game.id ||
    !matchesString(imagePattern, value.image_id) ||
    value.animated === true
  )
    return false;
  if (role === "logo" || role === "screenshot") return true;
  const type = value.image_type;
  if (!isRecord(type) || !positiveId(type.id)) return false;
  const name = normalizedArtworkTypeName(type.name);
  return role === "header"
    ? name === "keyartwithoutlogo"
    : name === "keyart" || name === "keyartwithlogo" || name === "keyartwithoutlogo";
}
function heroImageHasLogo(record: HeroImageCandidate) {
  return (
    isRecord(record.image_type) &&
    normalizedArtworkTypeName(record.image_type.name) === "keyartwithlogo"
  );
}
function heroImageCandidates(observed: unknown, game: ObservedGame, role: GameMediaRole) {
  if (!Array.isArray(observed) || observed.length >= 21)
    throw new Error("Game image inventory is invalid or incomplete.");
  return observed
    .filter((value): value is HeroImageCandidate => eligibleHeroImage(value, game, role))
    .sort((a, b) => Number(heroImageHasLogo(b)) - Number(heroImageHasLogo(a)) || a.id - b.id);
}

function heroAssetProposal(
  candidate: HeroImageCandidate,
  game: ObservedGame,
  role: GameMediaRole,
  identity: HeroIdentity,
  image: Awaited<ReturnType<HeroPreparationContext["inspector"]["inspectMediaImage"]>>,
): CatalogMediaAsset {
  const type = isRecord(candidate.image_type) ? candidate.image_type : undefined;
  const { caption, variant, kind } = gameMediaRoles[role];
  const foregroundNeutral =
    role === "logo" || role === "key_art" ? identity.foregroundNeutral : undefined;
  const providerId = `igdb-${role.replaceAll("_", "-")}-${identity.subject.kind}-${candidate.id}`;
  // The provider can serve one image for multiple accepted original editions.
  // Catalog IDs distinguish their separate applicability on a single listing.
  const id = identity.acceptedExact
    ? `${providerId}-${createHash("sha256").update(JSON.stringify(identity.subject)).digest("hex")}`
    : providerId;
  return {
    id,
    role,
    subject: identity.subject,
    ...(foregroundNeutral === undefined ? {} : { edition_neutral: foregroundNeutral }),
    caption:
      role === "screenshot" && identity.subject.kind === "original"
        ? "Original game screenshot"
        : caption,
    url: `https://images.igdb.com/igdb/image/upload/t_${variant}/${candidate.image_id}.png`,
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
      kind,
      image_id: candidate.image_id,
      game_slug: game.slug,
      ...(typeof candidate.alpha_channel === "boolean"
        ? { alpha_channel: candidate.alpha_channel }
        : {}),
      ...(role !== "screenshot" && type && positiveId(type.id) && typeof type.name === "string"
        ? { image_type: type.id, image_type_name: type.name }
        : {}),
    },
  };
}

function observeWithdrawnHeroImage(
  error: unknown,
  role: GameMediaRole,
  imageId: string,
  media: unknown[],
  context: HeroPreparationContext,
) {
  if (!isConfirmedIgdbImageGone(error, imageId, gameMediaRoles[role].variant)) return;
  const target = gameMediaImageTarget(role, imageId);
  context.goneImages.add(target);
  for (let index = media.length - 1; index >= 0; index--) {
    if (catalogMediaImageTarget(media[index]) === target) media.splice(index, 1);
  }
  return imageId;
}

function catalogMediaImageTarget(asset: unknown) {
  if (
    isRecord(asset) &&
    typeof asset.role === "string" &&
    Object.hasOwn(gameMediaRoles, asset.role) &&
    isRecord(asset.igdb) &&
    typeof asset.igdb.image_id === "string"
  )
    return gameMediaImageTarget(asset.role as GameMediaRole, asset.igdb.image_id);
}
async function inspectHeroRole(
  game: ObservedGame,
  role: GameMediaRole,
  identity: HeroIdentity,
  media: unknown[],
  directoryMedia: unknown[],
  context: HeroPreparationContext,
) {
  const inventoryRole = role === "header" ? "key_art" : role;
  const inventoryKey = `${game.id}:${inventoryRole}`;
  let inventory = context.inventories.get(inventoryKey);
  if (!inventory) {
    inventory = Promise.resolve().then(() =>
      context.inspector.inspectGameMedia(game.id, inventoryRole),
    );
    context.inventories.set(inventoryKey, inventory);
  }
  const observed = await inventory;
  const eligible = heroImageCandidates(observed, game, role);
  const withdrawn = new Set(
    eligible
      .map(({ image_id }) => image_id)
      .filter((id) => context.goneImages.has(gameMediaImageTarget(role, id))),
  );
  const candidates = eligible.filter(
    ({ image_id }) =>
      !withdrawn.has(image_id) && !context.heldImages.has(gameMediaImageTarget(role, image_id)),
  );
  let reason = "no-suitable-role-observed";
  if (candidates.length) reason = "images-unavailable-or-unsuitable";
  else if (
    eligible.some(({ image_id }) => context.heldImages.has(gameMediaImageTarget(role, image_id)))
  )
    reason = "image-bytes-held-for-review";
  else if (Array.isArray(observed) && observed.length === 0) reason = "provider-role-empty";
  // Finite candidate chain; one bad file does not erase another media role.
  for (const candidate of candidates.slice(0, 4)) {
    context.signal?.throwIfAborted();
    const target = gameMediaImageTarget(role, candidate.image_id);
    if (context.goneImages.has(target) || context.heldImages.has(target)) continue;
    try {
      const image = await observeHeroImage(candidate.image_id, role, context);
      if (context.heldImages.has(target)) {
        reason = "image-bytes-held-for-review";
        continue;
      }
      if (role === "header" && image.width * 2 < image.height * 3) continue;
      const asset = heroAssetProposal(candidate, game, role, identity, image);
      if (
        [...media, ...directoryMedia].some(
          (existing) =>
            isRecord(existing) &&
            existing.id === asset.id &&
            !context.goneImages.has(catalogMediaImageTarget(existing) ?? ""),
        )
      )
        continue;
      return { asset, reason: "role-selected", withdrawn };
    } catch (error) {
      context.signal?.throwIfAborted();
      const gone = observeWithdrawnHeroImage(error, role, candidate.image_id, media, context);
      if (gone === candidate.image_id) withdrawn.add(gone);
      if (error instanceof ArtworkBatchExhausted) {
        reason = "batch-provider-budget-exhausted";
        break;
      }
    }
  }
  return { asset: undefined, reason, withdrawn };
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

function observeHeroImage(
  imageId: string,
  role: GameMediaRole,
  context: HeroPreparationContext,
  revalidate = false,
) {
  // The provider variant identifies the bytes. Role fit and the exact
  // provider-game and catalog subjects are checked by each caller. An
  // explicit refresh must independently observe the retained image.
  const target = gameMediaImageTarget(role, imageId);
  const key = `${revalidate ? "refresh:" : ""}${target}`;
  let pending = context.images.get(key);
  if (!pending) {
    pending = Promise.resolve()
      .then(() => context.inspector.inspectMediaImage(imageId, role))
      .then((image) => {
        const digests = context.imageDigests.get(target) ?? new Set<string>();
        if (digests.size && (!digests.has(image.sha256) || digests.size > 1))
          context.heldImages.add(target);
        digests.add(image.sha256);
        context.imageDigests.set(target, digests);
        return image;
      });
    context.images.set(key, pending);
  }
  return pending;
}

async function refreshRetainedHeroMedia(
  port: ArtworkPort,
  media: unknown[],
  directoryMedia: unknown[],
  records: HeroMediaRecord[],
  context: HeroPreparationContext,
) {
  const original = port.presentation?.original_game;
  const editions = new Set(
    isRecord(original) && Array.isArray(original.source_editions)
      ? original.source_editions.flatMap((edition: unknown) =>
          isRecord(edition) && typeof edition.id === "string" ? [edition.id] : [],
        )
      : [],
  );
  for (const asset of [...media, ...directoryMedia]) {
    if (
      !isRecord(asset) ||
      !isRecord(asset.subject) ||
      typeof asset.role !== "string" ||
      !Object.hasOwn(gameMediaRoles, asset.role) ||
      !isRecord(asset.igdb) ||
      !matchesString(imagePattern, asset.igdb.image_id) ||
      !matchesString(hashPattern, asset.sha256)
    )
      continue;
    const scope = asset.subject;
    let subject: CatalogMediaSubject;
    if (scope.kind === "port" && scope.port_id === port.id)
      subject = { kind: "port", port_id: port.id };
    else if (
      scope.kind === "original" &&
      typeof scope.game_id === "string" &&
      isRecord(original) &&
      scope.game_id === original.id &&
      typeof scope.source_edition_id === "string" &&
      editions.has(scope.source_edition_id)
    )
      subject = {
        kind: "original",
        game_id: scope.game_id,
        source_edition_id: scope.source_edition_id,
      };
    else continue;
    const role = asset.role as GameMediaRole;
    const imageId = asset.igdb.image_id;
    const key = gameMediaImageTarget(role, imageId);
    if (context.goneImages.has(key)) continue;
    let reason: string;
    try {
      const image = await observeHeroImage(imageId, role, context, true);
      context.images.delete(key);
      reason =
        image.sha256 === asset.sha256 ? "retained-image-verified" : "retained-image-bytes-changed";
    } catch (error) {
      context.signal?.throwIfAborted();
      const withdrawn = observeWithdrawnHeroImage(error, role, imageId, media, context);
      reason =
        withdrawn === imageId
          ? "retained-image-withdrawn"
          : error instanceof ArtworkBatchExhausted
            ? "batch-provider-budget-exhausted"
            : "media-provider-unavailable-or-incomplete";
    }
    records.push({
      port_id: port.id,
      role,
      subject,
      reason,
      image_id: imageId,
      ...(positiveId(asset.igdb.game_id) ? { provider_game_id: asset.igdb.game_id } : {}),
    });
  }
}

async function prepareHeroIdentity(
  portId: string,
  identity: HeroIdentity,
  media: unknown[],
  directoryMedia: unknown[],
  records: HeroMediaRecord[],
  context: HeroPreparationContext,
) {
  let identified: Awaited<ReturnType<typeof inspectHeroIdentity>> | undefined;
  for (const role of catalogGameMediaRoles) {
    const existing = [...media, ...directoryMedia].filter(
      (asset): asset is Record<string, unknown> =>
        isRecord(asset) &&
        asset.role === role &&
        !(
          isRecord(asset.igdb) &&
          typeof asset.igdb.image_id === "string" &&
          context.goneImages.has(gameMediaImageTarget(role, asset.igdb.image_id))
        ),
    );
    const retained = existing.find((asset) => sameMediaSubject(asset.subject, identity.subject));
    if (retained || existing.length >= gameMediaRoleLimits[role]) {
      const providerGameId = isRecord(retained?.igdb) ? retained.igdb.game_id : undefined;
      records.push({
        port_id: portId,
        role,
        subject: identity.subject,
        reason: retained ? "existing-scene-retained" : "scene-role-capacity",
        ...(positiveId(providerGameId) ? { provider_game_id: providerGameId } : {}),
      });
      continue;
    }
    identified ??= await inspectHeroIdentity(identity, context);
    if (!identified.game) {
      records.push({ port_id: portId, role, subject: identity.subject, reason: identified.reason });
      continue;
    }
    try {
      const selected = await inspectHeroRole(
        identified.game,
        role,
        identity,
        media,
        directoryMedia,
        context,
      );
      if (selected.asset) upsertHeroMedia(media, selected.asset);
      records.push({
        port_id: portId,
        role,
        subject: identity.subject,
        reason: selected.reason,
        provider_game_id: identified.game.id,
        ...(selected.withdrawn.size ? { withdrawn_image_ids: [...selected.withdrawn] } : {}),
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
        provider_game_id: identified.game.id,
      });
    }
  }
}
export function withdrawCompanionCover(port: ArtworkPort, gone: ReadonlySet<string>) {
  const companion = port.presentation?.companion_cover;
  if (!port.presentation || !validArtworkMapping(companion) || !gone.has(companion.image_id))
    return false;
  delete port.presentation.companion_cover;
  return true;
}

export function collectionCovers(port: ArtworkPort): IgdbArtwork[] {
  const covers = port.presentation?.collection_covers;
  if (covers === undefined) return [];
  if (
    !validArtworkCollection(covers) ||
    port.presentation?.artwork != null ||
    port.presentation?.companion_cover != null
  )
    throw new Error(
      "A reviewed cover collection requires one to four distinct mappings and no individual cover.",
    );
  return covers;
}

export function withdrawCollectionCovers(port: ArtworkPort, gone: ReadonlySet<string>) {
  const covers = collectionCovers(port);
  const remaining = covers.filter((cover) => !gone.has(cover.image_id));
  if (remaining.length === covers.length || !port.presentation) return false;
  if (remaining.length) port.presentation.collection_covers = remaining;
  else delete port.presentation.collection_covers;
  return true;
}

function removeWithdrawnCatalogMedia(
  catalog: ArtworkCatalog,
  records: HeroMediaRecord[],
  gone: Set<string>,
  excluded: ReadonlySet<string>,
) {
  // A withdrawal invalidates every candidate reference, including unselected ports
  // and records completed earlier in this batch.
  for (const port of catalog.ports) {
    if (excluded.has(port.id)) continue;
    const media = port.presentation?.media;
    if (Array.isArray(media))
      port.presentation = {
        ...port.presentation,
        media: media.filter((asset) => !gone.has(catalogMediaImageTarget(asset) ?? "")),
      };
  }
  for (const record of records)
    if (
      record.reason !== "retained-image-withdrawn" &&
      record.image_id &&
      gone.has(gameMediaImageTarget(record.role, record.image_id))
    )
      record.reason = "selected-image-gone-later-in-batch";
}

export function withholdChangedHeroProposals(
  original: ArtworkCatalog,
  catalog: ArtworkCatalog,
  records: HeroMediaRecord[],
  held: ReadonlySet<string>,
) {
  if (!held.size) return;
  const baseline = new Map(original.ports.map(({ id, presentation }) => [id, presentation]));
  const byPort = new Map<
    string,
    { role: GameMediaRole; subject: CatalogMediaSubject; target: string }[]
  >();
  for (const record of records) {
    if (record.reason !== "role-selected" || !record.image_id) continue;
    const target = gameMediaImageTarget(record.role, record.image_id);
    if (!held.has(target)) continue;
    record.reason = "image-bytes-held-for-review";
    const pending = byPort.get(record.port_id) ?? [];
    pending.push({ role: record.role, subject: record.subject, target });
    byPort.set(record.port_id, pending);
  }
  for (const port of catalog.ports) {
    const pending = byPort.get(port.id);
    if (!pending || !port.presentation || !Array.isArray(port.presentation.media)) continue;
    const media = (port.presentation.media as unknown[]).filter(
      (asset) =>
        !pending.some(
          (record) =>
            isRecord(asset) &&
            asset.role === record.role &&
            sameMediaSubject(asset.subject, record.subject) &&
            catalogMediaImageTarget(asset) === record.target,
        ),
    );
    if (media.length || Array.isArray(baseline.get(port.id)?.media))
      port.presentation.media = media;
    else {
      delete port.presentation.media;
      if (!Object.keys(port.presentation).length) {
        const originalPresentation = baseline.get(port.id);
        if (originalPresentation === undefined) delete port.presentation;
        else port.presentation = originalPresentation;
      }
    }
  }
}

/** Propose descriptive game media through the existing identity/provider
 * authority. This grants no publication or image-payload export rights. */
export async function prepareCatalogGameMedia(
  catalog: ArtworkCatalog,
  options: {
    identities?: unknown;
    acceptedCatalog?: ArtworkCatalog;
    reviewedOriginalMedia?: ReadonlyMap<string, ReviewedOriginalMediaDecision>;
    excludedPortIds?: ReadonlySet<string>;
    explicitClearPortIds?: ReadonlySet<string>;
    selectedPortIds?: readonly string[];
    refreshPortIds?: readonly string[];
    knownGoneMediaTargets?: readonly string[];
    knownHeldMediaTargets?: readonly string[];
    inspector: Pick<
      ReturnType<typeof createIgdbInspector>,
      "inspectGame" | "inspectGameMedia" | "inspectMediaImage"
    >;
    signal?: AbortSignal;
  },
) {
  const knownGone = options.knownGoneMediaTargets ?? [];
  const knownHeld = options.knownHeldMediaTargets ?? [];
  const knownTargets = [...knownGone, ...knownHeld];
  if (
    Buffer.byteLength(JSON.stringify(knownTargets)) > 8 * 1024 * 1024 ||
    knownTargets.some((target) => {
      const [variant, id, extra] = target.split("/");
      return (
        extra !== undefined ||
        (variant !== "720p" && variant !== "logo_med_2x") ||
        !matchesString(imagePattern, id)
      );
    })
  )
    throw new Error("Invalid bounded media variant observations.");
  const selected = options.selectedPortIds ?? catalog.ports.map((port) => port.id);
  if (
    selected.length > 400 ||
    new Set(selected).size !== selected.length ||
    selected.some((id) => !catalog.ports.some((port) => port.id === id))
  )
    throw new Error("Game media worksets require at most 400 unique catalog port ids.");
  const refresh = new Set(options.refreshPortIds ?? []);
  if ([...refresh].some((id) => !selected.includes(id)))
    throw new Error("Game media refresh names a port outside this workset.");
  const result = structuredClone(catalog);
  const excluded = options.excludedPortIds ?? new Set<string>();
  const accepted = acceptedHeroMediaMatches(options.acceptedCatalog, excluded);
  const acceptedPorts = new Map(options.acceptedCatalog?.ports.map((port) => [port.id, port]));
  const records: HeroMediaRecord[] = [];
  const imageDigests = new Map<string, Set<string>>();
  for (const source of [catalog, options.acceptedCatalog])
    for (const { id, presentation } of source?.ports ?? []) {
      if (excluded.has(id)) continue;
      if (!Array.isArray(presentation?.media)) continue;
      for (const asset of presentation.media as unknown[]) {
        const target = catalogMediaImageTarget(asset);
        if (!target || !isRecord(asset) || !matchesString(hashPattern, asset.sha256)) continue;
        const digests = imageDigests.get(target) ?? new Set<string>();
        digests.add(asset.sha256);
        imageDigests.set(target, digests);
      }
    }
  const context: HeroPreparationContext = {
    inspector: options.inspector,
    signal: options.signal,
    games: new Map(),
    inventories: new Map(),
    images: new Map(),
    imageDigests,
    goneImages: new Set(knownGone),
    heldImages: new Set(knownHeld),
  };
  for (const port of result.ports) {
    if (!selected.includes(port.id) || excluded.has(port.id)) continue;
    options.signal?.throwIfAborted();
    const current = port.presentation?.media;
    const cleared =
      options.explicitClearPortIds?.has(port.id) ?? (Array.isArray(current) && !current.length);
    const media: unknown[] = Array.isArray(current) ? structuredClone(current as unknown[]) : [];
    const directoryMedia = retainedDirectoryMedia(port, acceptedPorts.get(port.id));
    if (refresh.has(port.id))
      await refreshRetainedHeroMedia(port, media, directoryMedia, records, context);
    for (const identity of declaredHeroMediaIdentities(
      port,
      options.identities,
      accepted,
      options.reviewedOriginalMedia,
      cleared,
    ))
      await prepareHeroIdentity(port.id, identity, media, directoryMedia, records, context);
    if (media.length || Array.isArray(current)) port.presentation = { ...port.presentation, media };
  }
  removeWithdrawnCatalogMedia(result, records, context.goneImages, excluded);
  withholdChangedHeroProposals(catalog, result, records, context.heldImages);
  return {
    catalog: result,
    records,
    gone_media_targets: [...context.goneImages].sort(),
    ...(context.heldImages.size ? { held_media_targets: [...context.heldImages].sort() } : {}),
  };
}

function sameMediaSubject(value: unknown, subject: CatalogMediaSubject) {
  if (!isRecord(value) || value.kind !== subject.kind) return false;
  return subject.kind === "port"
    ? value.port_id === subject.port_id
    : value.game_id === subject.game_id && value.source_edition_id === subject.source_edition_id;
}

function normalizedArtworkTypeName(value: unknown): string | undefined {
  if (typeof value === "string" && value.length <= 128 && !/[\p{Cc}]/u.test(value))
    return value.replace(/[^a-zA-Z0-9]/g, "").toLowerCase();
}

/** Hash a stable, nonempty validator executable through one regular-file
 * descriptor. Unlike JSON or controller payload reads, this needs no whole-file
 * byte envelope: memory stays bounded independently of the compiled CLI size. */
export function hashCoreImageValidatorFile(file: string) {
  const fd = openSync(
    file,
    constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0),
  );
  try {
    const before = fstatSync(fd, { bigint: true });
    if (!before.isFile() || before.size <= 0n)
      throw new Error("Core image validator must be a nonempty regular file.");
    const buffer = Buffer.alloc(1024 * 1024);
    const hash = createHash("sha256");
    let length = 0n;
    for (;;) {
      // Read at most the original extent plus one byte to detect growth.
      const remaining = before.size - length + 1n;
      const read = readSync(
        fd,
        buffer,
        0,
        Number(remaining < BigInt(buffer.length) ? remaining : BigInt(buffer.length)),
        null,
      );
      if (!read) break;
      length += BigInt(read);
      if (length > before.size) throw new Error("Core image validator changed while hashing.");
      hash.update(buffer.subarray(0, read));
    }
    const after = fstatSync(fd, { bigint: true });
    if (
      length !== before.size ||
      after.size !== before.size ||
      after.dev !== before.dev ||
      after.ino !== before.ino ||
      after.mtimeNs !== before.mtimeNs ||
      after.ctimeNs !== before.ctimeNs
    )
      throw new Error("Core image validator changed while hashing.");
    return hash.digest("hex");
  } finally {
    closeSync(fd);
  }
}

// Reuse the actual core decoder through its existing CLI import into a fresh
// task-owned library. No user library/choice or arbitrary provider command.
export function createCoreImageValidator(
  cli: string,
  scratchRoot: string,
  expectedSha256?: string,
) {
  mkdirSync(scratchRoot, { recursive: true });
  const root = mkdtempSync(join(resolve(scratchRoot), "core-image-validation-"));
  const artifact = join(root, process.platform === "win32" ? "validator.exe" : "validator");
  copyFileSync(resolve(cli), artifact);
  chmodSync(artifact, 0o500);
  const artifactSha256 = hashCoreImageValidatorFile(artifact);
  if (expectedSha256 !== undefined && artifactSha256 !== expectedSha256)
    throw new Error("Core image validator changed during preparation.");
  let ordinal = 0;
  return (bytes: Buffer, deadline?: number) => {
    const remaining = () => (deadline === undefined ? 30000 : deadline - performance.now());
    if (remaining() < 1) throw new Error("Core image validation deadline reached.");
    const runRoot = join(root, String(++ordinal));
    mkdirSync(runRoot);
    const file = join(runRoot, "image.jpg");
    writeFileSync(file, bytes, { flag: "wx" });
    const env = Object.fromEntries(
      Object.entries(process.env).filter(([name]) => name.toUpperCase() !== "PORTCOVE_LIBRARY"),
    );
    // Core needs atomic publication in its temporary library. The operator's
    // evidence directory can be on a mounted filesystem that lacks it.
    const child = (() => {
      const library = mkdtempSync(join(tmpdir(), "portcove-image-library-"));
      try {
        const timeout = Math.min(30000, Math.floor(remaining()));
        if (timeout < 1) throw new Error("Core image validation deadline reached.");
        const process = spawnSync(
          artifact,
          [
            "--library",
            library,
            "--json",
            "--non-interactive",
            "artwork",
            "import",
            "shipwright",
            file,
          ],
          {
            env,
            encoding: "utf8",
            timeout,
            maxBuffer: 1024 * 1024,
            windowsHide: true,
            ...(deadline === undefined ? {} : { killSignal: "SIGKILL" }),
          },
        );
        writeFileSync(
          join(runRoot, "validation-process.json"),
          JSON.stringify(
            {
              validator_artifact_sha256: artifactSha256,
              status: process.status,
              signal: process.signal,
              error_code: errorCode(process.error) ?? null,
              stdout_tail: process.stdout?.slice(-16384) ?? "",
              stderr_tail: process.stderr?.slice(-16384) ?? "",
            },
            null,
            2,
          ),
          { flag: "wx" },
        );
        return process;
      } finally {
        try {
          rmSync(library, { recursive: true, force: true, maxRetries: 2 });
        } catch (error) {
          process.emitWarning(
            `Temporary Core image validation library cleanup failed (${errorCode(error) ?? "unknown error"}).`,
            { code: "PORTCOVE_IMAGE_LIBRARY_CLEANUP" },
          );
        }
      }
    })();
    if (child.error || child.status !== 0)
      throw new Error("Core image validation refused or unavailable.");
    if (remaining() < 1) throw new Error("Core image validation deadline reached.");
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
