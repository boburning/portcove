import { createHash } from "node:crypto";
import { parse as parseYaml } from "yaml";
import { isRecord } from "./runtime-values.mts";
import { observationHash } from "./upstream-observer.mts";
import {
  bounded,
  collect,
  entity,
  externalLocation,
  externalRepository,
  inert,
  json,
  listId,
  maxTitle,
  validClaimExtensions,
} from "./discovery-claims.mts";
import type {
  ExternalListEntry,
  ExternalSourceEntry,
  ParsedExternalList,
} from "./discovery-claims.mts";
export {
  externalLocation,
  externalRepository,
  externalWebLocation,
  progressBand,
  sourceEntry,
} from "./discovery-claims.mts";
export type {
  ExternalHost,
  ExternalListEntry,
  ExternalSourceEntry,
  ParsedExternalList,
} from "./discovery-claims.mts";

// Curated community lists are lead inputs only. A list entry names a repository
// someone else tracks; it never admits, qualifies or describes a Portcove port.
// Only repository URLs and an inert display title are read; fetched text is data.
export const externalLeadLists = [
  {
    id: "decomp-buddy-finds",
    url: "https://tanookistudios.com/decomp-buddy/finds.json",
    format: "finds-json",
    cap: 8 * 1024 * 1024,
    parser: 1,
    conditional: true,
    refresh_days: 1,
  },
  { id: "portsdr", url: "https://portsdr.com/", format: "portsdr-html", cap: 4 * 1024 * 1024 },
  {
    id: "alexbeav-psx",
    url: "https://alexbeavs-ps1-ports.github.io/psxrecomp-ports/catalog-data.js",
    format: "alexbeav-js",
    cap: 1024 * 1024,
  },
  {
    id: "recompsoftware",
    format: "recompsoftware-json",
    cap: 8 * 1024 * 1024,
    revision_repository: "andrewnakas/recompsoftware",
    repository_id: 1418451069,
    revision_path: "data/projects/games.json",
    reviewed_revision: "e981757f31fdb58b85e546069cf303daac56cc61",
  },
  // decomp.fun's hourly index of matching decompilation projects.
  {
    id: "decomp-fun",
    url: "https://decomp.fun/v1/projects.json",
    format: "decomp-fun-json",
    cap: 8 * 1024 * 1024,
    parser: 1,
    conditional: true,
    refresh_days: 1,
  },
  // unbaked's weekly additions: every project the registry gained, newest week first.
  {
    id: "unbaked-additions",
    url: "https://unbaked.games/api/additions.json",
    format: "unbaked-additions-json",
    cap: 8 * 1024 * 1024,
    parser: 1,
    conditional: true,
    refresh_days: 1,
  },
  // PortMaster's package index names upstream projects only in its prose; those
  // links are read as hints. Its handheld ARM packages say nothing about desktop builds.
  {
    id: "portmaster",
    url: "https://github.com/PortsMaster/PortMaster-New/releases/latest/download/ports.json",
    format: "portmaster-json",
    cap: 8 * 1024 * 1024,
  },
  // Open Source Game Clones: one YAML file per letter under games/ at an exact
  // revision. The repository identity is pinned on its first complete read.
  {
    id: "osgc",
    format: "osgc-yaml",
    cap: 8 * 1024 * 1024,
    revision_repository: "opengaming/osgameclones",
    revision_directory: "games",
  },
] as const;
export type ExternalLeadListId = (typeof externalLeadLists)[number]["id"];
export const externalListIds: readonly string[] = externalLeadLists.map((list) => list.id);
/**
 * Default days between list reads. A list that answers conditional requests is
 * read daily: an unchanged list costs one 304 with no body.
 */
export const externalListRefreshDays = 7;
export const externalResolutionsPerRun = 8;
/** Retry clocks for per-hint outcomes; none of them stops later hints in the run. */
export const externalHintRetryDays = { unavailable: 30, conflict: 30, failed: 1 } as const;
/** A failed list read waits this long before another attempt, keeping its last good clock. */
export const externalListFailureRetryDays = 2;
// Retired list ids remain readable in retained state; only configured lists are collected.

export interface ExternalListClock {
  completed_at: string;
  evidence: string;
  entries: number;
  unlinked: number;
  fingerprint: string;
  source?: ParsedExternalList["source"];
  /** Entries the list itself places outside native-port scope. */
  excluded?: number;
  /** Bytes the read transferred. */
  bytes?: number;
  /** The list's parser version when this read was parsed; validators apply only to it. */
  parser?: number;
  /** Validators of the read, sent with the next one; a 304 keeps the retained copy. */
  etag?: string;
  last_modified?: string;
  /** The last time the source answered that nothing changed since `completed_at`. */
  unchanged_at?: string;
}
export interface ExternalListAttempt {
  attempted_at: string;
  outcome: "complete" | "partial";
  error?: string;
}
export interface ExternalHint {
  url: string;
  host: ExternalListEntry["host"];
  title: string;
  lists: string[];
  /** The list whose read created this hint. */
  discovered_by?: string;
  first_observed_at: string;
  last_observed_at: string;
  source_entries?: Record<string, ExternalSourceEntry[]>;
  /** One changes-only primary research handoff, acknowledged by lead-dispose. */
  source_change?: { fingerprint: string; observed_at: string };
  resolution?: {
    status: "queued" | "unavailable" | "conflict" | "failed";
    checked_at: string;
    id?: number;
    reason?: string;
    /** Set for every status except queued; a missing clock means the hint is due. */
    retry_at?: string;
  };
}
export interface ExternalLeadState {
  lists: Record<string, ExternalListClock>;
  hints: Record<string, ExternalHint>;
  attempts?: Record<string, ExternalListAttempt>;
}

/** Decomp Buddy's published finds feed: `{ updatedAt, games: [{ repo: "owner/name", title }] }`. */
export function parseFindsFeed(text: string): ParsedExternalList {
  bounded(text, externalLeadLists[0].cap, "finds feed");
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    // Never copy list bytes into notes through the parser's diagnostic.
    throw new Error("Malformed finds feed JSON");
  }
  if (!isRecord(value) || !Array.isArray(value.games))
    throw new Error("Unsupported finds feed shape");
  let unlinked = 0;
  const rows: { url: string; title: string }[] = [];
  for (const game of value.games) {
    if (!isRecord(game)) throw new Error("Malformed finds feed entry");
    const repo = typeof game.repo === "string" ? game.repo.trim() : "";
    if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u.test(repo)) {
      unlinked++;
      continue;
    }
    rows.push({ url: `https://github.com/${repo}`, title: inert(game.title) });
  }
  return collect(rows, unlinked);
}

/** portsdr.com: one generated page whose `port-card` articles each hold a Repository link. */
export function parsePortsdrPage(text: string): ParsedExternalList {
  bounded(text, externalLeadLists[1].cap, "portsdr page");
  const opened = text.match(/<article\b[^>]*\bclass="port-card"/gu) ?? [];
  const cards = [
    ...text.matchAll(/<article\b[^>]*\bclass="port-card"[^>]*>([\s\S]*?)<\/article>/gu),
  ];
  if (!cards.length || cards.length !== opened.length)
    throw new Error("Incomplete or unsupported portsdr card set");
  let unlinked = 0;
  const rows: { url: string; title: string }[] = [];
  for (const card of cards) {
    const body = card[1]!;
    const links = [...body.matchAll(/<a\s+href="([^"]*)"[^>]*>\s*Repository\s*<\/a>/gu)];
    if (links.length > 1) throw new Error("Ambiguous portsdr repository link");
    const title = body.match(/<h3>([\s\S]*?)<\/h3>/u)?.[1] ?? "";
    if (!links.length) unlinked++;
    else rows.push({ url: entity(links[0]![1]!), title: entity(title.replace(/<[^>]*>/gu, "")) });
  }
  return collect(rows, unlinked);
}

/** Alexbeav's PS1 catalog script. Read as text and never executed: each game object
 * starts with a `slug` key and carries at most one `repository` string.
 */
export function parseAlexbeavCatalog(text: string): ParsedExternalList {
  bounded(text, externalLeadLists[2].cap, "Alexbeav catalog");
  const start = text.match(/\bCATALOG_GAMES\s*=\s*\[/u);
  if (!start || start.index === undefined) throw new Error("Unsupported Alexbeav catalog shape");
  const body = text.slice(start.index + start[0].length);
  if (!/\]\s*;?\s*$/u.test(body)) throw new Error("Incomplete Alexbeav catalog");
  const chunks = body.split(/\bslug\s*:/u).slice(1);
  let unlinked = 0;
  const rows: { url: string; title: string }[] = [];
  const string = (chunk: string, key: string) => {
    const matches = [
      ...chunk.matchAll(new RegExp(`\\b${key}\\s*:\\s*"((?:[^"\\\\]|\\\\.)*)"`, "gu")),
    ];
    if (matches.length > 1) throw new Error("Ambiguous Alexbeav catalog entry");
    return matches[0]?.[1]?.replace(/\\(.)/gu, "$1");
  };
  for (const chunk of chunks) {
    const repository = string(chunk, "repository");
    if (!repository) unlinked++;
    else rows.push({ url: repository, title: string(chunk, "title") ?? "" });
  }
  return collect(rows, unlinked);
}

/** Parse structured data without evaluating upstream code or reusing its prose. */
export function parseRecompSoftwareCatalog(text: string): ParsedExternalList {
  bounded(text, 8 * 1024 * 1024, "RecompSoftware catalog");
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new Error("Malformed RecompSoftware JSON");
  }
  if (!Array.isArray(value) || !value.length)
    throw new Error("Unsupported RecompSoftware entry set");
  const entries = new Map<string, ExternalListEntry>();
  const ids = new Set<string>();
  let unlinked = 0;
  for (const row of value) {
    if (
      !isRecord(row) ||
      typeof row.slug !== "string" ||
      !/^[a-z0-9][a-z0-9-]{0,159}$/u.test(row.slug) ||
      ids.has(row.slug) ||
      typeof row.name !== "string" ||
      typeof row.subject !== "string" ||
      typeof row.category !== "string" ||
      typeof row.method !== "string" ||
      typeof row.status !== "string" ||
      !Array.isArray(row.targets) ||
      row.targets.length > 64 ||
      !row.targets.every((v) => typeof v === "string" && v.length <= 160) ||
      !(row.needsOriginal === null || typeof row.needsOriginal === "boolean") ||
      !(
        row.latestRelease === null ||
        (typeof row.latestRelease === "string" && row.latestRelease.length <= 256) ||
        (isRecord(row.latestRelease) &&
          typeof row.latestRelease.version === "string" &&
          row.latestRelease.version.length <= 256 &&
          typeof row.latestRelease.date === "string" &&
          row.latestRelease.date.length <= 64)
      )
    )
      throw new Error("Malformed RecompSoftware entry");
    ids.add(row.slug);
    const repository = typeof row.repo === "string" && externalRepository(row.repo);
    if (!repository) {
      unlinked++;
      continue;
    }
    const claims = {
      id: row.slug,
      subject: inert(row.subject),
      category: inert(row.category),
      method: inert(row.method),
      status: inert(row.status),
      targets: [...new Set(row.targets.map(inert))].sort(),
      needs_original: row.needsOriginal,
      latest_release:
        row.latestRelease === null
          ? null
          : typeof row.latestRelease === "string"
            ? row.latestRelease
            : JSON.stringify({ version: row.latestRelease.version, date: row.latestRelease.date }),
    };
    const source = { ...claims, fingerprint: observationHash(claims) };
    const entry = entries.get(repository.key) ?? {
      ...repository,
      title: inert(row.name),
      source_entries: [],
    };
    entry.source_entries!.push(source);
    entries.set(repository.key, entry);
  }
  for (const entry of entries.values())
    entry.source_entries!.sort((a, b) => a.id.localeCompare(b.id));
  return { entries: [...entries.values()].sort((a, b) => a.key.localeCompare(b.key)), unlinked };
}

/** Revision is resolved before the bounded raw read; The raw read uses the immutable revision. */
export function bindExternalListSource(
  parsed: ParsedExternalList,
  text: string,
  url: string,
  revision: string,
): ParsedExternalList {
  if (
    !/^[a-f0-9]{40}$/u.test(revision) ||
    url !==
      `https://raw.githubusercontent.com/andrewnakas/recompsoftware/${revision}/data/projects/games.json`
  )
    throw new Error("Invalid immutable external source binding");
  return {
    ...parsed,
    source: { url, revision, content_sha256: createHash("sha256").update(text).digest("hex") },
  };
}

/** decomp.fun `projects.json`: `{ projects: [{ repository, game_title, name }] }`. */
export function parseDecompFunProjects(text: string): ParsedExternalList {
  bounded(text, 8 * 1024 * 1024, "decomp.fun index");
  const value = json(text, "decomp.fun index");
  if (!isRecord(value) || !Array.isArray(value.projects))
    throw new Error("Unsupported decomp.fun index shape");
  let unlinked = 0;
  const rows: { url: string; title: string }[] = [];
  for (const project of value.projects) {
    if (!isRecord(project)) throw new Error("Malformed decomp.fun project");
    const title = inert(project.game_title) || inert(project.name);
    if (typeof project.repository === "string") rows.push({ url: project.repository, title });
    else unlinked++;
  }
  return collect(rows, unlinked);
}

/** unbaked `additions.json`: `{ weeks: [{ games: [{ title, projects: [{ url, name }] }] }] }`. */
export function parseUnbakedAdditions(text: string): ParsedExternalList {
  bounded(text, 8 * 1024 * 1024, "unbaked additions");
  const value = json(text, "unbaked additions");
  if (!isRecord(value) || !Array.isArray(value.weeks))
    throw new Error("Unsupported unbaked additions shape");
  let unlinked = 0;
  const rows: { url: string; title: string }[] = [];
  for (const week of value.weeks) {
    if (!isRecord(week) || !Array.isArray(week.games)) throw new Error("Malformed unbaked week");
    for (const game of week.games) {
      if (!isRecord(game) || !Array.isArray(game.projects))
        throw new Error("Malformed unbaked game");
      for (const project of game.projects) {
        if (!isRecord(project)) throw new Error("Malformed unbaked project");
        if (typeof project.url === "string")
          rows.push({ url: project.url, title: inert(game.title) });
        else unlinked++;
      }
    }
  }
  return collect(rows, unlinked);
}

// Repository links in prose: GitHub, GitLab and Codeberg project paths only.
const proseLink =
  /https?:\/\/(?:github\.com|gitlab\.com|codeberg\.org)\/[A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.-]+){1,4}/gu;

/**
 * PortMaster `ports.json`: `{ ports: { name: { attr: { title, desc, inst, ... } } } }`.
 * The index has no upstream field, so only repository links its own text names
 * are hints; links to PortMaster's own repositories are not upstreams.
 */
export function parsePortMasterIndex(text: string): ParsedExternalList {
  bounded(text, 8 * 1024 * 1024, "PortMaster index");
  const value = json(text, "PortMaster index");
  if (!isRecord(value) || !isRecord(value.ports))
    throw new Error("Unsupported PortMaster index shape");
  let unlinked = 0;
  const rows: { url: string; title: string }[] = [];
  for (const port of Object.values(value.ports)) {
    if (!isRecord(port) || !isRecord(port.attr)) throw new Error("Malformed PortMaster entry");
    const attr = port.attr;
    const prose = [attr.desc, attr.desc_md, attr.inst, attr.inst_md]
      .filter((field): field is string => typeof field === "string")
      .join(" ");
    // Prose often ends a link with sentence punctuation that is not part of the path.
    const links = [
      ...new Set(
        (prose.match(proseLink) ?? []).map((link) => link.replace(/[.,;:!?)\]}'"]+$/u, "")),
      ),
    ].filter((link) => !/\/\/github\.com\/(?:PortsMaster|PortsMaster-MV)\//iu.test(link));
    if (!links.length) unlinked++;
    for (const link of links) rows.push({ url: link, title: inert(attr.title) });
  }
  return collect(rows, unlinked);
}

/** Open Source Game Clones entry types that reimplement or release the original game. */
const osgcPortTypes = new Set(["remake", "official"]);

/**
 * Open Source Game Clones `games/*.yaml`, read as `{ files: { name: yamlText } }`.
 * Only `remake` and `official` entries are native-port leads; clones, similar
 * games and tools are counted as excluded, never hinted.
 */
export function parseOsgcGames(text: string): ParsedExternalList {
  bounded(text, 32 * 1024 * 1024, "Open Source Game Clones files");
  const value = json(text, "Open Source Game Clones files");
  if (!isRecord(value) || !isRecord(value.files) || !Object.keys(value.files).length)
    throw new Error("Unsupported Open Source Game Clones file set");
  let unlinked = 0;
  let excluded = 0;
  const rows: { url: string; title: string }[] = [];
  for (const [file, body] of Object.entries(value.files)) {
    if (typeof body !== "string" || !/^[A-Za-z0-9_-]+\.ya?ml$/u.test(file))
      throw new Error("Malformed Open Source Game Clones file");
    let games: unknown;
    try {
      // Data only: the schema-free core parser builds plain objects, never tags or code.
      games = parseYaml(body, { schema: "core", maxAliasCount: 0, logLevel: "error" });
    } catch {
      throw new Error("Malformed Open Source Game Clones YAML");
    }
    if (games === null) continue;
    if (!Array.isArray(games)) throw new Error("Unsupported Open Source Game Clones shape");
    for (const game of games) {
      if (!isRecord(game) || typeof game.type !== "string")
        throw new Error("Malformed Open Source Game Clones entry");
      if (!osgcPortTypes.has(game.type)) {
        excluded++;
        continue;
      }
      const originals = Array.isArray(game.originals)
        ? game.originals
            .filter((name): name is string => typeof name === "string")
            .map(inert)
            .filter(Boolean)
            .join(", ")
        : "";
      if (typeof game.repo === "string")
        rows.push({ url: game.repo, title: originals || inert(game.name) });
      else unlinked++;
    }
  }
  return { ...collect(rows, unlinked), excluded };
}

export function parseExternalList(id: string, text: string): ParsedExternalList {
  const list = externalLeadLists.find((candidate) => candidate.id === id);
  if (!list) throw new Error("Unknown external lead list");
  if (list.format === "recompsoftware-json") return parseRecompSoftwareCatalog(text);
  if (list.format === "decomp-fun-json") return parseDecompFunProjects(text);
  if (list.format === "unbaked-additions-json") return parseUnbakedAdditions(text);
  if (list.format === "portmaster-json") return parsePortMasterIndex(text);
  if (list.format === "osgc-yaml") return parseOsgcGames(text);
  if (list.format === "finds-json") return parseFindsFeed(text);
  if (list.format === "portsdr-html") return parsePortsdrPage(text);
  return parseAlexbeavCatalog(text);
}

/** The immutable source URLs a retained list clock may name for one revision. */
function expectedSourceUrls(id: string, revision: string): string[] {
  const list = externalLeadLists.find((candidate) => candidate.id === id);
  if (!list || !("revision_repository" in list)) return [];
  if ("revision_directory" in list)
    return [
      `https://github.com/${list.revision_repository}/tree/${revision}/${list.revision_directory}`,
    ];
  return [
    `https://raw.githubusercontent.com/${list.revision_repository}/${revision}/${list.revision_path}`,
  ];
}
const clock = (v: unknown): v is string => typeof v === "string" && Number.isFinite(Date.parse(v));
export function parseExternalLeadState(value: unknown): ExternalLeadState | undefined {
  if (value === undefined) return undefined;
  if (!isRecord(value) || !isRecord(value.lists) || !isRecord(value.hints))
    throw new Error("Invalid retained external list state");
  if (value.attempts !== undefined && !isRecord(value.attempts))
    throw new Error("Invalid retained external list attempts");
  for (const [id, raw] of Object.entries(value.attempts ?? {}))
    if (
      !listId.test(id) ||
      !isRecord(raw) ||
      !clock(raw.attempted_at) ||
      !["complete", "partial"].includes(String(raw.outcome)) ||
      (raw.error !== undefined && typeof raw.error !== "string")
    )
      throw new Error("Invalid retained external list attempt");
  for (const [id, raw] of Object.entries(value.lists)) {
    if (
      !listId.test(id) ||
      !isRecord(raw) ||
      !clock(raw.completed_at) ||
      typeof raw.evidence !== "string" ||
      typeof raw.fingerprint !== "string" ||
      !Number.isSafeInteger(raw.entries) ||
      Number(raw.entries) < 0 ||
      !Number.isSafeInteger(raw.unlinked) ||
      Number(raw.unlinked) < 0 ||
      (["excluded", "bytes", "parser"] as const).some(
        (field) =>
          raw[field] !== undefined && (!Number.isSafeInteger(raw[field]) || Number(raw[field]) < 0),
      ) ||
      (["etag", "last_modified"] as const).some(
        (field) =>
          raw[field] !== undefined &&
          (typeof raw[field] !== "string" ||
            !raw[field] ||
            String(raw[field]).length > 512 ||
            /[\r\n]/u.test(String(raw[field]))),
      ) ||
      (raw.unchanged_at !== undefined && !clock(raw.unchanged_at))
    )
      throw new Error("Invalid retained external list clock");
    if (
      raw.source !== undefined &&
      (!isRecord(raw.source) ||
        typeof raw.source.revision !== "string" ||
        !/^[a-f0-9]{40}$/u.test(raw.source.revision) ||
        typeof raw.source.url !== "string" ||
        !expectedSourceUrls(id, raw.source.revision).includes(raw.source.url) ||
        typeof raw.source.content_sha256 !== "string" ||
        !/^[a-f0-9]{64}$/u.test(raw.source.content_sha256) ||
        (raw.source.repository_id !== undefined &&
          (!Number.isSafeInteger(raw.source.repository_id) ||
            Number(raw.source.repository_id) <= 0)))
    )
      throw new Error("Invalid retained immutable external source");
  }
  for (const [key, raw] of Object.entries(value.hints)) {
    const repository = isRecord(raw) && typeof raw.url === "string" && externalLocation(raw.url);
    if (
      !repository ||
      !isRecord(raw) ||
      repository.key !== key ||
      repository.url !== raw.url ||
      repository.host !== raw.host ||
      typeof raw.title !== "string" ||
      Array.from(raw.title).length > maxTitle ||
      !Array.isArray(raw.lists) ||
      !raw.lists.length ||
      !raw.lists.every((id) => typeof id === "string" && listId.test(id)) ||
      new Set(raw.lists).size !== raw.lists.length ||
      !clock(raw.first_observed_at) ||
      !clock(raw.last_observed_at) ||
      (raw.discovered_by !== undefined &&
        (typeof raw.discovered_by !== "string" || !raw.lists.includes(raw.discovered_by)))
    )
      throw new Error("Invalid retained external hint");
    if (
      raw.source_change !== undefined &&
      (!isRecord(raw.source_change) ||
        typeof raw.source_change.fingerprint !== "string" ||
        !/^[a-f0-9]{64}$/u.test(raw.source_change.fingerprint) ||
        !clock(raw.source_change.observed_at))
    )
      throw new Error("Invalid external source change");
    if (raw.source_entries !== undefined) {
      if (
        !isRecord(raw.source_entries) ||
        Object.entries(raw.source_entries).some(
          ([source, rows]) =>
            !listId.test(source) ||
            !Array.isArray(rows) ||
            rows.some((row) => {
              if (!isRecord(row)) return true;
              const { fingerprint, ...claims } = row;
              return (
                typeof row.id !== "string" ||
                typeof row.subject !== "string" ||
                typeof row.category !== "string" ||
                typeof row.method !== "string" ||
                typeof row.status !== "string" ||
                !Array.isArray(row.targets) ||
                !row.targets.every((v) => typeof v === "string") ||
                !(row.needs_original === null || typeof row.needs_original === "boolean") ||
                !(row.latest_release === null || typeof row.latest_release === "string") ||
                !validClaimExtensions(row) ||
                fingerprint !== observationHash(claims)
              );
            }),
        )
      )
        throw new Error("Invalid retained external source entries");
    }
    const resolution = raw.resolution;
    if (
      resolution !== undefined &&
      (!isRecord(resolution) ||
        !["queued", "unavailable", "conflict", "failed"].includes(String(resolution.status)) ||
        !clock(resolution.checked_at) ||
        (resolution.status === "queued"
          ? !Number.isSafeInteger(resolution.id) || Number(resolution.id) <= 0
          : typeof resolution.reason !== "string" ||
            (resolution.retry_at !== undefined && !clock(resolution.retry_at))))
    )
      throw new Error("Invalid retained external hint resolution");
  }
  return structuredClone(value) as unknown as ExternalLeadState;
}

export function isExternalListId(id: unknown): id is string {
  return typeof id === "string" && listId.test(id);
}
export function externalListDue(state: ExternalLeadState | undefined, id: string, now: string) {
  const attempt = state?.attempts?.[id];
  if (
    attempt?.outcome === "partial" &&
    Date.parse(now) - Date.parse(attempt.attempted_at) < externalListFailureRetryDays * 86400000
  )
    return false;
  const clockValue = state?.lists[id];
  const previous = [clockValue?.completed_at, clockValue?.unchanged_at]
    .filter((value): value is string => Boolean(value))
    .sort()
    .at(-1);
  const list = externalLeadLists.find((candidate) => candidate.id === id);
  const days = list && "refresh_days" in list ? Number(list.refresh_days) : externalListRefreshDays;
  return !previous || Date.parse(now) - Date.parse(previous) >= days * 86400000;
}
/** Records a failed list read without touching its hints or last successful clock. */
export function recordExternalListFailure(
  state: ExternalLeadState | undefined,
  id: string,
  attemptedAt: string,
  error: string,
): ExternalLeadState {
  if (!externalListIds.includes(id)) throw new Error("Unknown external lead list");
  const next: ExternalLeadState = structuredClone(state ?? { lists: {}, hints: {} });
  next.attempts = {
    ...next.attempts,
    [id]: { attempted_at: attemptedAt, outcome: "partial", error: error.slice(0, 300) },
  };
  return next;
}

/** Merges one complete, validated list observation. Absent entries are retained:
 * leaving a curated list is not evidence that an upstream was deleted.
 */
export function mergeExternalList(
  state: ExternalLeadState | undefined,
  id: string,
  parsed: ParsedExternalList,
  observedAt: string,
  evidence: string,
  read: { bytes?: number; etag?: string | undefined; last_modified?: string | undefined } = {},
): ExternalLeadState {
  if (!externalListIds.includes(id)) throw new Error("Unknown external lead list");
  if (!clock(observedAt)) throw new Error("Invalid external list clock");
  const next: ExternalLeadState = structuredClone(state ?? { lists: {}, hints: {} });
  for (const entry of parsed.entries) {
    const old = next.hints[entry.key];
    const previous = old?.source_entries?.[id];
    const retained = entry.source_entries
      ? [
          ...new Map(
            [...(previous ?? []), ...entry.source_entries].map((row) => [row.id, row]),
          ).values(),
        ].sort((a, b) => a.id.localeCompare(b.id))
      : undefined;
    const changed = previous && retained && observationHash(previous) !== observationHash(retained);
    const sourceFields = entry.source_entries
      ? {
          source_entries: { ...old?.source_entries, [id]: retained! },
          ...(changed
            ? { source_change: { fingerprint: observationHash(retained), observed_at: observedAt } }
            : {}),
        }
      : {};
    next.hints[entry.key] = old
      ? {
          ...old,
          ...sourceFields,
          title: old.title || entry.title,
          lists: [...new Set([...old.lists, id])].sort(),
          last_observed_at: observedAt,
        }
      : {
          ...sourceFields,
          url: entry.url,
          host: entry.host,
          title: entry.title,
          lists: [id],
          discovered_by: id,
          first_observed_at: observedAt,
          last_observed_at: observedAt,
        };
  }
  const parser = parserVersion(id);
  next.lists[id] = {
    completed_at: observedAt,
    evidence,
    entries: parsed.entries.length,
    unlinked: parsed.unlinked,
    fingerprint: observationHash(parsed.entries),
    ...(parsed.source ? { source: parsed.source } : {}),
    ...(parsed.excluded !== undefined ? { excluded: parsed.excluded } : {}),
    ...(read.bytes !== undefined ? { bytes: read.bytes } : {}),
    ...(parser !== undefined ? { parser } : {}),
    ...(read.etag ? { etag: read.etag } : {}),
    ...(read.last_modified ? { last_modified: read.last_modified } : {}),
  };
  next.attempts = { ...next.attempts, [id]: { attempted_at: observedAt, outcome: "complete" } };
  return next;
}

/** The list's configured parser version; a retained copy from another version is re-read. */
export function parserVersion(id: string) {
  const list = externalLeadLists.find((candidate) => candidate.id === id);
  return list && "parser" in list ? Number(list.parser) : undefined;
}
/**
 * Validators to send for a list's next read: only for a list that supports
 * conditional reads and only when its retained copy was parsed by the current
 * parser version, so a parser change always reads the source in full.
 */
export function externalListValidators(state: ExternalLeadState | undefined, id: string) {
  const list = externalLeadLists.find((candidate) => candidate.id === id);
  const previous = state?.lists[id];
  if (!list || !("conditional" in list) || !previous || previous.parser !== parserVersion(id))
    return undefined;
  const validators = {
    ...(previous.etag ? { etag: previous.etag } : {}),
    ...(previous.last_modified ? { last_modified: previous.last_modified } : {}),
  };
  return Object.keys(validators).length ? validators : undefined;
}
/** A response validator header worth retaining, or undefined. */
export function responseValidator(value: unknown) {
  return typeof value === "string" && value && value.length <= 512 && !/[\r\n]/u.test(value)
    ? value
    : undefined;
}
/**
 * A conditional read the source answered with 304: the retained entries and
 * hints still describe it, so the list is current again without a new parse.
 */
export function markExternalListUnchanged(
  state: ExternalLeadState | undefined,
  id: string,
  observedAt: string,
  bytes: number,
): ExternalLeadState {
  const previous = state?.lists[id];
  if (!state || !previous) throw new Error("An unchanged list needs its retained complete read");
  if (!clock(observedAt) || Date.parse(observedAt) < Date.parse(previous.completed_at))
    throw new Error("Invalid unchanged external list clock");
  const next = structuredClone(state);
  next.lists[id] = { ...previous, unchanged_at: observedAt, bytes };
  next.attempts = { ...next.attempts, [id]: { attempted_at: observedAt, outcome: "complete" } };
  return next;
}

/** Current repository paths (`owner/name`, lowercase) of retained leads. Historical
 * aliases are excluded: another repository can reuse an old path, so a hint naming
 * one is resolved through a fresh primary read rather than assumed to be the old lead.
 */
export function leadPaths(records: Iterable<{ id: number; repository: string }>) {
  const paths = new Map<string, number>();
  for (const record of records) paths.set(record.repository.toLowerCase(), record.id);
  return paths;
}

export type ExternalHintCoverage =
  | "covered"
  | "queued"
  | "non-github"
  | "unsupported-host"
  | "unresolved"
  | "unavailable"
  | "conflict"
  | "failed";
export function externalHintCoverage(
  hint: ExternalHint,
  key: string,
  covered: ReadonlySet<string>,
  paths: ReadonlyMap<string, number>,
  now: string,
): ExternalHintCoverage {
  const changed = hint.source_change !== undefined;
  if (!changed && covered.has(key)) return "covered";
  if (hint.host === "web") return "unsupported-host";
  if (hint.host !== "github") return "non-github";
  if (paths.has(key.slice(19))) return "queued";
  const resolution = hint.resolution;
  if (
    resolution &&
    resolution.status !== "queued" &&
    resolution.retry_at &&
    Date.parse(now) < Date.parse(resolution.retry_at)
  )
    return resolution.status;
  return "unresolved";
}

/**
 * Uncovered GitHub hints due for one primary metadata read. The interactive
 * runner takes a bounded newest-first slice. Fair order takes every due hint,
 * longest-waiting first, so sustained new hints cannot starve older ones; the
 * caller's physical budget decides where a run stops.
 */
export function selectExternalResolutions(
  state: ExternalLeadState | undefined,
  covered: ReadonlySet<string>,
  paths: ReadonlyMap<string, number>,
  now: string,
  limit: number = externalResolutionsPerRun,
  order: "newest" | "fair" = "newest",
) {
  // A hint waits from its last failed check, or from its first observation.
  const waitingSince = (hint: ExternalHint) =>
    hint.resolution?.checked_at ?? hint.first_observed_at;
  return Object.entries(state?.hints ?? {})
    .filter(([key, hint]) => externalHintCoverage(hint, key, covered, paths, now) === "unresolved")
    .sort(([a, x], [b, y]) =>
      order === "fair"
        ? waitingSince(x).localeCompare(waitingSince(y)) || a.localeCompare(b)
        : y.first_observed_at.localeCompare(x.first_observed_at) ||
          y.lists.length - x.lists.length ||
          a.localeCompare(b),
    )
    .slice(0, limit)
    .map(([key, hint]) => ({ key, repository: key.slice(19), hint }));
}

export function externalHintSummary(
  state: ExternalLeadState | undefined,
  covered: ReadonlySet<string> | undefined,
  paths: ReadonlyMap<string, number>,
  now: string,
) {
  const counts: Record<ExternalHintCoverage, number> = {
    covered: 0,
    queued: 0,
    "non-github": 0,
    "unsupported-host": 0,
    unresolved: 0,
    unavailable: 0,
    conflict: 0,
    failed: 0,
  };
  // Contribution per list. A hint counts as discovered by the list whose read
  // created it, and as originated by the sources its claims name as lineage
  // (or, without lineage, by its discovering list), so a claim several
  // aggregators repeat counts once for its originating source.
  const contribution: Record<
    string,
    {
      hints: number;
      discovered: number;
      originated: number;
      platform_claims: number;
      pending_changes: number;
      unresolved_hosts: number;
      coverage: Partial<Record<ExternalHintCoverage, number>>;
    }
  > = {};
  const row = (id: string) =>
    (contribution[id] ??= {
      hints: 0,
      discovered: 0,
      originated: 0,
      platform_claims: 0,
      pending_changes: 0,
      unresolved_hosts: 0,
      coverage: {},
    });
  const unsupportedHosts: Record<string, number> = {};
  for (const [key, hint] of Object.entries(state?.hints ?? {})) {
    const status = externalHintCoverage(hint, key, covered ?? new Set(), paths, now);
    counts[status]++;
    if (status === "unsupported-host") {
      const hostname = new URL(hint.url).hostname;
      unsupportedHosts[hostname] = (unsupportedHosts[hostname] ?? 0) + 1;
    }
    const origins = new Set(
      Object.values(hint.source_entries ?? {}).flatMap((rows) =>
        rows.flatMap((r) => r.origin ?? []),
      ),
    );
    if (!origins.size && hint.discovered_by) origins.add(hint.discovered_by);
    for (const origin of origins) row(origin).originated++;
    for (const id of hint.lists) {
      const entry = row(id);
      entry.hints++;
      entry.coverage[status] = (entry.coverage[status] ?? 0) + 1;
      if (hint.discovered_by === id) entry.discovered++;
      if (hint.host === "web") entry.unresolved_hosts++;
      if (hint.source_change) entry.pending_changes++;
      entry.platform_claims += (hint.source_entries?.[id] ?? []).filter(
        (claim) => claim.targets.length,
      ).length;
    }
  }
  return {
    lists: Object.fromEntries(
      externalLeadLists.map((list) => [
        list.id,
        {
          last_complete: state?.lists[list.id] ?? null,
          last_attempt: state?.attempts?.[list.id] ?? null,
          due: externalListDue(state, list.id, now),
          contribution: contribution[list.id] ?? null,
        },
      ]),
    ),
    // Originating sources outside the configured lists (lineage named by a claim).
    origins: Object.fromEntries(
      Object.entries(contribution)
        .filter(([id]) => !externalListIds.includes(id))
        .map(([id, value]) => [id, value.originated]),
    ),
    unsupported_hosts: unsupportedHosts,
    unsupported_host_reconsideration:
      "Retained as unresolved; taken up when a provider adapter supports the host or an attributed source names a resolvable repository for the project",
    hints: Object.keys(state?.hints ?? {}).length,
    // Without a validated canonical inventory, covered hints are reported as unresolved.
    canonical_overlap: covered ? "observed" : "unknown",
    ...counts,
    scope:
      "Curated community list hints; lead input only, no admission, support or completeness claim",
  };
}
