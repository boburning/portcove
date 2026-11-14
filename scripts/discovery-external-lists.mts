import { isRecord } from "./runtime-values.mts";
import { observationHash } from "./upstream-observer.mts";

// Curated community lists are lead inputs only. A list entry names a repository
// someone else tracks; it never admits, qualifies or describes a Portcove port.
// Only repository URLs and an inert display title are read; fetched text is data.
export const externalLeadLists = [
  {
    id: "decomp-buddy-finds",
    url: "https://tanookistudios.com/decomp-buddy/finds.json",
    format: "finds-json",
    cap: 8 * 1024 * 1024,
  },
  { id: "portsdr", url: "https://portsdr.com/", format: "portsdr-html", cap: 4 * 1024 * 1024 },
  {
    id: "alexbeav-psx",
    url: "https://alexbeavs-ps1-ports.github.io/psxrecomp-ports/catalog-data.js",
    format: "alexbeav-js",
    cap: 1024 * 1024,
  },
] as const;
export type ExternalLeadListId = (typeof externalLeadLists)[number]["id"];
export const externalListIds: readonly string[] = externalLeadLists.map((list) => list.id);
export const externalListRefreshDays = 7;
export const externalResolutionsPerRun = 8;
/** Retry clocks for per-hint outcomes; none of them stops later hints in the run. */
export const externalHintRetryDays = { unavailable: 30, conflict: 30, failed: 1 } as const;
/** A failed list read waits this long before another attempt, keeping its last good clock. */
export const externalListFailureRetryDays = 2;
// Retired list ids remain readable in retained state; only configured lists are collected.
const listId = /^[a-z0-9][a-z0-9-]{0,63}$/u;
const maxEntries = 20000;
const maxTitle = 160;

export interface ExternalListEntry {
  key: string;
  url: string;
  host: "github" | "gitlab" | "codeberg";
  title: string;
}
export interface ParsedExternalList {
  entries: ExternalListEntry[];
  /** Entries without a usable repository link: name-only hints that are not invented mappings. */
  unlinked: number;
}
export interface ExternalListClock {
  completed_at: string;
  evidence: string;
  entries: number;
  unlinked: number;
  fingerprint: string;
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
  first_observed_at: string;
  last_observed_at: string;
  resolution?: {
    status: "queued" | "unavailable" | "conflict";
    checked_at: string;
    id?: number;
    reason?: string;
    /** Required for every status except queued. */
    retry_at?: string;
  };
}
export interface ExternalLeadState {
  lists: Record<string, ExternalListClock>;
  hints: Record<string, ExternalHint>;
  attempts?: Record<string, ExternalListAttempt>;
}

const hosts = {
  "github.com": "github",
  "gitlab.com": "gitlab",
  "codeberg.org": "codeberg",
} as const;
const segment = /^[A-Za-z0-9_.-]{1,100}$/u;
/** Normalizes one credential-free repository URL to its host and project path, or null.
 * GitHub and Codeberg use owner/name. GitLab keeps its full group path (up to four
 * segments before a `/-/` route) so a nested project is not mistaken for another.
 */
export function externalRepository(value: string) {
  let url: URL;
  try {
    url = new URL(value.trim());
  } catch {
    return null;
  }
  const host = hosts[url.hostname.toLowerCase() as keyof typeof hosts];
  if (url.protocol !== "https:" || url.username || url.password || url.port || !host) return null;
  const parts = url.pathname.split("/").filter(Boolean);
  let project = parts.slice(0, 2);
  if (host === "gitlab") {
    const route = parts.indexOf("-");
    project = route === -1 ? parts : parts.slice(0, route);
    if (project.length > 4) return null;
  }
  if (project.length < 2) return null;
  project[project.length - 1] = project.at(-1)!.replace(/\.git$/iu, "");
  if (project.some((part) => !segment.test(part) || /^\.+$/u.test(part))) return null;
  const canonical = `https://${url.hostname.toLowerCase()}/${project.join("/")}`;
  return { key: canonical.toLowerCase(), url: canonical, host } as const;
}
const inert = (value: unknown) =>
  typeof value === "string"
    ? Array.from(
        value
          .replace(/[\p{Cc}\p{Cf}]+/gu, " ")
          .replace(/\s+/gu, " ")
          .trim(),
      )
        .slice(0, maxTitle)
        .join("")
    : "";
const entity = (value: string) =>
  value.replace(/&(?:amp|lt|gt|quot|apos|#39|#(\d{1,7}));/gu, (match, code?: string) => {
    if (code) {
      const point = Number(code);
      return point > 0 && point <= 0x10ffff ? String.fromCodePoint(point) : "";
    }
    return (
      { "&amp;": "&", "&lt;": "<", "&gt;": ">", "&quot;": '"', "&apos;": "'", "&#39;": "'" }[
        match
      ] ?? ""
    );
  });
function bounded(text: string, cap: number, label: string) {
  if (Buffer.byteLength(text) > cap) throw new Error(`Oversized ${label}`);
}
function collect(rows: { url: string; title: string }[], unlinked: number): ParsedExternalList {
  if (!rows.length && !unlinked) throw new Error("External list has no entries");
  if (rows.length + unlinked > maxEntries) throw new Error("Oversized external list entry set");
  const entries = new Map<string, ExternalListEntry>();
  for (const row of rows) {
    const repository = externalRepository(row.url);
    if (!repository) {
      unlinked++;
      continue;
    }
    if (!entries.has(repository.key))
      entries.set(repository.key, { ...repository, title: inert(row.title) });
  }
  return { entries: [...entries.values()].sort((a, b) => a.key.localeCompare(b.key)), unlinked };
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
  if (value.games.length > maxEntries) throw new Error("Oversized external list entry set");
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

export function parseExternalList(id: string, text: string): ParsedExternalList {
  const list = externalLeadLists.find((candidate) => candidate.id === id);
  if (!list) throw new Error("Unknown external lead list");
  if (list.format === "finds-json") return parseFindsFeed(text);
  if (list.format === "portsdr-html") return parsePortsdrPage(text);
  return parseAlexbeavCatalog(text);
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
  for (const [id, raw] of Object.entries(value.lists))
    if (
      !listId.test(id) ||
      !isRecord(raw) ||
      !clock(raw.completed_at) ||
      typeof raw.evidence !== "string" ||
      typeof raw.fingerprint !== "string" ||
      !Number.isSafeInteger(raw.entries) ||
      Number(raw.entries) < 0 ||
      !Number.isSafeInteger(raw.unlinked) ||
      Number(raw.unlinked) < 0
    )
      throw new Error("Invalid retained external list clock");
  for (const [key, raw] of Object.entries(value.hints)) {
    const repository = isRecord(raw) && typeof raw.url === "string" && externalRepository(raw.url);
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
      !clock(raw.last_observed_at)
    )
      throw new Error("Invalid retained external hint");
    const resolution = raw.resolution;
    if (
      resolution !== undefined &&
      (!isRecord(resolution) ||
        !["queued", "unavailable", "conflict"].includes(String(resolution.status)) ||
        !clock(resolution.checked_at) ||
        (resolution.status === "queued"
          ? !Number.isSafeInteger(resolution.id) || Number(resolution.id) <= 0
          : typeof resolution.reason !== "string" || !clock(resolution.retry_at)))
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
  const previous = state?.lists[id]?.completed_at;
  return !previous || Date.parse(now) - Date.parse(previous) >= externalListRefreshDays * 86400000;
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
): ExternalLeadState {
  if (!externalListIds.includes(id)) throw new Error("Unknown external lead list");
  if (!clock(observedAt)) throw new Error("Invalid external list clock");
  const next: ExternalLeadState = structuredClone(state ?? { lists: {}, hints: {} });
  for (const entry of parsed.entries) {
    const old = next.hints[entry.key];
    next.hints[entry.key] = old
      ? {
          ...old,
          title: old.title || entry.title,
          lists: [...new Set([...old.lists, id])].sort(),
          last_observed_at: observedAt,
        }
      : {
          url: entry.url,
          host: entry.host,
          title: entry.title,
          lists: [id],
          first_observed_at: observedAt,
          last_observed_at: observedAt,
        };
  }
  next.lists[id] = {
    completed_at: observedAt,
    evidence,
    entries: parsed.entries.length,
    unlinked: parsed.unlinked,
    fingerprint: observationHash(parsed.entries.map((entry) => entry.key)),
  };
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
  | "unresolved"
  | "unavailable"
  | "conflict";
export function externalHintCoverage(
  hint: ExternalHint,
  key: string,
  covered: ReadonlySet<string>,
  paths: ReadonlyMap<string, number>,
  now: string,
): ExternalHintCoverage {
  if (covered.has(key)) return "covered";
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

/** Uncovered GitHub hints due for one primary metadata read, newest observation first. */
export function selectExternalResolutions(
  state: ExternalLeadState | undefined,
  covered: ReadonlySet<string>,
  paths: ReadonlyMap<string, number>,
  now: string,
  limit = externalResolutionsPerRun,
) {
  return Object.entries(state?.hints ?? {})
    .filter(([key, hint]) => externalHintCoverage(hint, key, covered, paths, now) === "unresolved")
    .sort(
      ([a, x], [b, y]) =>
        y.first_observed_at.localeCompare(x.first_observed_at) ||
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
    unresolved: 0,
    unavailable: 0,
    conflict: 0,
  };
  for (const [key, hint] of Object.entries(state?.hints ?? {}))
    counts[externalHintCoverage(hint, key, covered ?? new Set(), paths, now)]++;
  return {
    lists: Object.fromEntries(
      externalLeadLists.map((list) => [
        list.id,
        {
          last_complete: state?.lists[list.id] ?? null,
          last_attempt: state?.attempts?.[list.id] ?? null,
          due: externalListDue(state, list.id, now),
        },
      ]),
    ),
    hints: Object.keys(state?.hints ?? {}).length,
    // Without a validated canonical inventory, covered hints are reported as unresolved.
    canonical_overlap: covered ? "observed" : "unknown",
    ...counts,
    scope:
      "Curated community list hints; lead input only, no admission, support or completeness claim",
  };
}
