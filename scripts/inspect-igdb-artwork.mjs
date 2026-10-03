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

const maximumImageBytes = 16 * 1024 * 1024;
const maximumBatchBytes = 512 * 1024 * 1024;
const slugPattern = /^[a-z0-9-]{1,255}$/;
const imagePattern = /^[a-z0-9]{1,128}$/;
const hashPattern = /^[a-f0-9]{64}$/;
const positiveId = (value) => Number.isSafeInteger(value) && value > 0;
const matchesString = (pattern, value) => typeof value === "string" && pattern.test(value);
// Only this module's fixed image request can establish a Gone observation.
// Provider metadata, generic errors and caller-supplied status properties cannot.
const goneImageObservations = new WeakMap();

function goneImageException(kind, imageId) {
  return { ...exception(kind, "image-gone"), image_id: imageId, http_status: 410 };
}

export function readArtworkJson(file, maximum = 8 * 1024 * 1024) {
  return readArtworkInput(file, maximum).document;
}

export function readArtworkInput(file, maximum = 8 * 1024 * 1024) {
  const fd = openSync(file, "r");
  try {
    if (!fstatSync(fd).isFile()) throw new Error("Artwork input must be a regular file.");
    const buffer = Buffer.alloc(maximum + 1);
    let length = 0;
    for (;;) {
      const read = readSync(fd, buffer, length, buffer.length - length, null);
      length += read;
      if (length > maximum) throw new Error("Artwork input exceeds its byte contract.");
      if (!read) break;
    }
    try {
      const bytes = Buffer.from(buffer.subarray(0, length));
      return { document: JSON.parse(bytes.toString("utf8")), bytes };
    } catch {
      throw new Error("Artwork input is not valid JSON.");
    }
  } finally {
    closeSync(fd);
  }
}

function nameKey(value) {
  return String(value).normalize("NFKC").toLowerCase().replace(/\s+/g, " ").trim();
}

function evidenceUrl(value) {
  let evidence;
  try {
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

function declaredIdentity(value, kind = value?.kind ?? "port") {
  if (
    !value ||
    (value.game_id != null && !positiveId(value.game_id)) ||
    (value.slug != null && !matchesString(slugPattern, value.slug)) ||
    !Array.isArray(value.names) ||
    !value.names.length ||
    value.names.length > 16 ||
    value.names.some((name) => typeof name !== "string" || !name.trim() || name.length > 255)
  ) {
    throw new Error(
      "Artwork identity needs bounded public names and valid optional fixed references.",
    );
  }
  const projectUrl = value.project_url ? evidenceUrl(value.project_url) : null;
  const platforms = value.platform_ids ?? [];
  if (!Array.isArray(platforms) || platforms.length > 16 || platforms.some((id) => !positiveId(id)))
    throw new Error("Artwork original-game platforms are invalid.");
  if (value.game_id == null && (kind === "port" ? !projectUrl : !platforms.length))
    throw new Error(
      "Name matching requires exact upstream project or original-game platform facts.",
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

function websiteKey(value) {
  try {
    const url = new URL(value);
    if (!["https:", "http:"].includes(url.protocol) || url.username || url.password) return null;
    if (url.hostname === "github.com" && !url.port && !url.search && !url.hash)
      return `github.com${url.pathname.replace(/\/$/, "").toLowerCase()}`;
    return url.href;
  } catch {
    return null;
  }
}

function matchesIdentity(game, declared) {
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

function validOptionalList(value, predicate) {
  return value == null || (Array.isArray(value) && value.length <= 256 && value.every(predicate));
}

function validObservedMetadata(game) {
  if (
    !game ||
    !positiveId(game.id) ||
    typeof game.name !== "string" ||
    !matchesString(slugPattern, game.slug)
  )
    return false;
  if (
    !validOptionalList(
      game.alternative_names,
      (name) => name && typeof name.name === "string" && name.name.length <= 255,
    )
  )
    return false;
  if (
    !validOptionalList(
      game.websites,
      (site) => site && typeof site.url === "string" && site.url.length <= 2048,
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

function identifiedGame(matches, declared) {
  if (!Array.isArray(matches) || matches.some((game) => !validObservedMetadata(game)))
    return { reason: "identity-response-invalid" };
  if (matches.length >= 21) return { reason: "identity-query-incomplete" };
  if (declared.game_id != null && matches.length !== 1) return { reason: "identity-not-unique" };
  const eligible = matches.filter((game) => matchesIdentity(game, declared));
  return eligible.length === 1
    ? { game: eligible[0] }
    : { reason: eligible.length > 1 ? "identity-not-unique" : "identity-mismatch" };
}

function validMapping(value) {
  return (
    value &&
    positiveId(value.game_id) &&
    positiveId(value.cover_id) &&
    matchesString(imagePattern, value.image_id) &&
    matchesString(hashPattern, value.image_sha256) &&
    matchesString(slugPattern, value.game_slug) &&
    ["port", "underlying-game"].includes(value.match_kind)
  );
}

function reusableMapping(port, accepted, declarations) {
  if (
    !accepted ||
    port.name !== accepted.name ||
    port.project_url !== accepted.project_url ||
    port.source_profile !== accepted.source_profile ||
    !validMapping(accepted.presentation?.artwork)
  )
    return null;
  const mapping = accepted.presentation.artwork;
  const identity = declarations?.[mapping.match_kind === "port" ? "port" : "underlying_game"];
  if (identity && (identity.game_id !== mapping.game_id || identity.slug !== mapping.game_slug))
    return null;
  return structuredClone(mapping);
}

function exception(kind, reason) {
  return {
    kind,
    reason,
    resume:
      reason === "identity-not-declared"
        ? "Supply attributable exact project/original-game identity facts."
        : "Correct the exact identity or asset fact, or retry after a confirmed provider/environment change.",
  };
}

function observedContent(value) {
  if (
    !value ||
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
  return value;
}

function acceptedOriginal(declared, context) {
  const mappings = context.acceptedPorts
    .map((port) => port.presentation?.artwork)
    .filter(
      (mapping) =>
        validMapping(mapping) &&
        !context.goneImages.has(mapping.image_id) &&
        mapping.match_kind === "underlying-game" &&
        mapping.game_id === declared.game_id &&
        mapping.game_slug === declared.slug,
    );
  const unique = new Map(mappings.map((mapping) => [JSON.stringify(mapping), mapping]));
  return unique.size === 1 ? structuredClone([...unique.values()][0]) : null;
}

async function selectCover(identity, kind, context, exceptions) {
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
      Promise.resolve().then(() => context.inspectGame(declared)),
    );
  }
  let matches;
  try {
    matches = await context.games.get(key);
  } catch {
    exceptions.push(exception(kind, "identity-provider-unavailable"));
    return null;
  }
  const identified = identifiedGame(matches, declared);
  if (!identified.game) {
    exceptions.push(exception(kind, identified.reason));
    return null;
  }
  const game = identified.game;
  if (!positiveId(game.cover?.id) || !matchesString(imagePattern, game.cover?.image_id)) {
    exceptions.push(exception(kind, "no-usable-cover"));
    return null;
  }
  const imageId = game.cover.image_id;
  if (!context.images.has(imageId)) {
    if (context.metrics.image_queries >= 400 || context.metrics.image_bytes >= maximumBatchBytes) {
      exceptions.push(exception(kind, "batch-image-budget-exhausted"));
      return null;
    }
    context.metrics.image_queries++;
    context.images.set(
      imageId,
      Promise.resolve()
        .then(() => context.inspectImage(imageId, maximumBatchBytes - context.metrics.image_bytes))
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
  } catch (error) {
    if (goneImageObservations.get(error) === imageId) {
      context.goneImages.add(imageId);
      exceptions.push(goneImageException(kind, imageId));
    } else {
      exceptions.push(exception(kind, "image-unavailable-or-invalid"));
    }
    return null;
  }
  return {
    mapping: {
      game_id: game.id,
      cover_id: game.cover.id,
      image_id: imageId,
      image_sha256: content.sha256,
      game_slug: game.slug,
      match_kind: kind,
    },
    checks: { identity: declared, content },
  };
}

function applyGoneImageFallbacks(catalog, records, context) {
  for (const [index, record] of records.entries()) {
    const mapping = record.mapping;
    if (!mapping || !context.goneImages.has(mapping.image_id)) continue;
    delete catalog.ports[index].presentation.artwork;
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
}

// Proposal preparation only. The accepted baseline is caller-selected trusted
// authoring data; neither a provider response nor this output admits a port.
export async function prepareCatalogArtwork(catalog, options) {
  if (
    !Array.isArray(catalog?.ports) ||
    catalog.ports.length > 400 ||
    new Set(catalog.ports.map((port) => port.id)).size !== catalog.ports.length ||
    catalog.ports.some((port) => !/^[a-z0-9][a-z0-9-]{0,127}$/.test(port.id ?? ""))
  ) {
    throw new Error("Artwork batches require at most400 unique stable port ids.");
  }
  const result = structuredClone(catalog);
  const accepted = new Map((options.acceptedCatalog?.ports ?? []).map((port) => [port.id, port]));
  const refresh = new Set(options.refreshPortIds ?? []);
  if ([...refresh].some((id) => !catalog.ports.some((port) => port.id === id)))
    throw new Error("Artwork refresh names a port outside this batch.");
  const context = {
    ...options,
    games: new Map(),
    images: new Map(),
    goneImages: new Set(),
    acceptedPorts: options.acceptedCatalog?.ports ?? [],
    metrics: {
      ports: catalog.ports.length,
      reused: 0,
      original_reused: 0,
      selected: 0,
      fallback: 0,
      game_queries: 0,
      image_queries: 0,
      image_bytes: 0,
    },
  };
  const records = [];
  for (const port of result.ports) {
    const supplied = options.identities?.[port.id];
    const reused = reusableMapping(port, accepted.get(port.id), supplied);
    if (reused && !refresh.has(port.id)) {
      port.presentation = { ...port.presentation, artwork: reused };
      records.push({
        port_id: port.id,
        role: "cover",
        reason: "accepted-mapping-reused",
        mapping: reused,
        checks: { scope: "retained-accepted-mapping", download_repeated: false },
        exceptions: [],
      });
      context.metrics.reused++;
      continue;
    }
    const declarations = {
      ...supplied,
      port: supplied?.port ?? {
        names: [port.name],
        project_url: port.project_url,
        evidence_url: port.project_url,
      },
    };
    context.refreshing = refresh.has(port.id);
    const exceptions = [];
    const selected =
      (await selectCover(declarations?.port, "port", context, exceptions)) ??
      (await selectCover(declarations?.underlying_game, "underlying-game", context, exceptions));
    if (!selected && reused && !context.goneImages.has(reused.image_id)) {
      port.presentation = { ...port.presentation, artwork: reused };
      context.metrics.reused++;
      records.push({
        port_id: port.id,
        role: "cover",
        reason: "accepted-mapping-retained-after-unavailable-refresh",
        mapping: reused,
        checks: { scope: "retained-accepted-mapping", live_refresh_passed: false },
        exceptions,
      });
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
    records.push({
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
    });
  }
  // A later refreshed record can observe Gone for an earlier reused mapping.
  // Apply that exact-image fact to every output reference without extra requests.
  applyGoneImageFallbacks(result, records, context);
  return { catalog: result, records, metrics: context.metrics };
}

async function readBounded(response, maximum, observeBytes = () => {}) {
  if (Number(response.headers.get("content-length")) > maximum || !response.body)
    throw new Error("Response exceeds its byte contract.");
  const reader = response.body.getReader();
  const chunks = [];
  let length = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) return Buffer.concat(chunks, length);
      length += value.byteLength;
      observeBytes(value.byteLength);
      if (length > maximum) throw new Error("Response exceeds its byte contract.");
      chunks.push(value);
    }
  } finally {
    await reader.cancel();
  }
}

function readCredentials(file) {
  try {
    const value = readArtworkJson(file, 64 * 1024);
    if (
      typeof value.client_id !== "string" ||
      !value.client_id ||
      typeof value.client_secret !== "string" ||
      !value.client_secret
    )
      throw new Error();
    return value;
  } catch {
    throw new Error("Private IGDB credentials are unavailable or invalid.");
  }
}

function metadataRetryAt(header, now, deadline) {
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
    date.getUTCMonth() !== months.indexOf(parts[2]) ||
    date.getUTCHours() !== Number(parts[3]) ||
    date.getUTCMinutes() !== Number(parts[4]) ||
    date.getUTCSeconds() !== Number(parts[5])
  )
    return now;
  return Number.isFinite(parsed) ? Math.min(deadline, Math.max(now, parsed)) : now;
}

// One lazy authentication attempt, sequential requests, no retries. Credentials
// and response bodies never enter proposal evidence or error messages.
export function createIgdbInspector(credentialsFile, validateImage, fetchImpl = fetch) {
  let tokenPromise;
  let lastGameRequest = 0;
  let gameRetryAt = 0;
  const metrics = {
    authentication_requests: 0,
    game_requests: 0,
    image_requests: 0,
    metadata_bytes: 0,
    image_bytes: 0,
  };
  const deadline = Date.now() + 15 * 60 * 1000;
  const signal = () => {
    if (Date.now() >= deadline) throw new Error("Artwork provider batch deadline reached.");
    return AbortSignal.timeout(Math.min(15000, Math.max(1, deadline - Date.now())));
  };
  const credentials = () => readCredentials(credentialsFile);
  async function waitForMetadata() {
    for (;;) {
      const now = Date.now();
      const due = Math.max(lastGameRequest + 300, gameRetryAt);
      if (now >= deadline || due >= deadline)
        throw new Error("Artwork provider batch deadline reached.");
      if (due <= now) return;
      await timers.setTimeout(due - now, undefined, {
        signal: AbortSignal.timeout(deadline - now),
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
        if (!response.ok) throw new Error("Twitch authentication unavailable.");
        const value = JSON.parse((await readBounded(response, 64 * 1024)).toString("utf8"));
        if (typeof value.access_token !== "string" || !value.access_token)
          throw new Error("Twitch authentication unavailable.");
        return { clientId: privateValue.client_id, token: value.access_token };
      })();
    return tokenPromise;
  }
  return {
    providerMetrics: metrics,
    async inspectGame(identity) {
      const verified = declaredIdentity(identity);
      const auth = await token();
      if (metrics.game_requests >= 800 || metrics.metadata_bytes >= 32 * 1024 * 1024)
        throw new Error("Artwork metadata budget reached.");
      await waitForMetadata();
      // Another caller can consume the shared budget while this request waits.
      if (metrics.game_requests >= 800 || metrics.metadata_bytes >= 32 * 1024 * 1024)
        throw new Error("Artwork metadata budget reached.");
      const requestSignal = signal();
      lastGameRequest = Date.now();
      metrics.game_requests++;
      const response = await fetchImpl("https://api.igdb.com/v4/games", {
        method: "POST",
        redirect: "error",
        signal: requestSignal,
        headers: {
          "Client-ID": auth.clientId,
          Authorization: `Bearer ${auth.token}`,
          "Content-Type": "text/plain",
        },
        body: `fields id,name,slug,alternative_names.name,websites.url,platforms,version_parent,version_title,cover.id,cover.image_id; where ${
          verified.game_id != null
            ? `id = ${verified.game_id}`
            : verified.names
                .map(
                  (name) =>
                    `(name ~ ${JSON.stringify(name)} | alternative_names.name ~ ${JSON.stringify(name)})`,
                )
                .join(" | ")
        }; limit 21;`,
      });
      if (response.status === 429 || response.status === 503)
        gameRetryAt = Math.max(
          gameRetryAt,
          metadataRetryAt(response.headers.get("retry-after"), Date.now(), deadline),
        );
      if (!response.ok) throw new Error("IGDB identity request unavailable.");
      return JSON.parse(
        (
          await readBounded(
            response,
            Math.min(1024 * 1024, 32 * 1024 * 1024 - metrics.metadata_bytes),
            (bytes) => {
              metrics.metadata_bytes += bytes;
            },
          )
        ).toString("utf8"),
      );
    },
    async inspectImage(imageId, remainingBytes = maximumBatchBytes) {
      if (!matchesString(imagePattern, imageId)) throw new Error("Invalid image identity.");
      if (metrics.image_requests >= 400 || metrics.image_bytes >= maximumBatchBytes)
        throw new Error("Artwork image budget reached.");
      metrics.image_requests++;
      const response = await fetchImpl(
        `https://images.igdb.com/igdb/image/upload/t_cover_big/${imageId}.jpg`,
        { redirect: "error", signal: signal() },
      );
      if (response.status === 410) {
        const error = new Error("IGDB image is gone.");
        goneImageObservations.set(error, imageId);
        throw error;
      }
      if (!response.ok || !response.headers.get("content-type")?.startsWith("image/jpeg"))
        throw new Error("IGDB image unavailable.");
      const bytes = await readBounded(
        response,
        Math.min(maximumImageBytes, remainingBytes, maximumBatchBytes - metrics.image_bytes),
        (length) => {
          metrics.image_bytes += length;
        },
      );
      const sha256 = createHash("sha256").update(bytes).digest("hex");
      const validated = await validateImage(bytes);
      return observedContent({ ...validated, sha256, bytes: bytes.length });
    },
  };
}

// Reuse the actual core decoder through its existing CLI import into a fresh
// task-owned library. No user library/choice or arbitrary provider command.
export function createCoreImageValidator(cli, scratchRoot) {
  mkdirSync(scratchRoot, { recursive: true });
  const root = mkdtempSync(join(resolve(scratchRoot), "core-image-validation-"));
  const artifact = join(root, process.platform === "win32" ? "validator.exe" : "validator");
  copyFileSync(resolve(cli), artifact);
  chmodSync(artifact, 0o500);
  const artifactSha256 = createHash("sha256").update(readFileSync(artifact)).digest("hex");
  let ordinal = 0;
  return (bytes) => {
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
          error_code: child.error?.code ?? null,
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
    const value = JSON.parse(child.stdout).data?.selection;
    if (
      !value ||
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
    "Use catalog batch preparation: node scripts/generate-catalog.mjs --prepare-artwork INPUT --identities FACTS --credentials-file PRIVATE --validator-cli CLI --output-dir OUTPUT.",
  );
}
