import { observationHash } from "./upstream-observer.mts";

// Shared shapes and helpers for discovery sources: repository and official-URL
// locations, inert display text and attributed claims. Fetched text is data.
export const listId = /^[a-z0-9][a-z0-9-]{0,63}$/u;
export const maxTitle = 160;

/**
 * External claims only: source slug/subject never establish Portcove game identity.
 * Every claim is attributed to the list that made it; `origin` names the lists
 * or sites the claim was copied from, so one claim repeated by several
 * aggregators counts once for its originating source.
 */
export interface ExternalSourceEntry {
  id: string;
  subject: string;
  category: string;
  method: string;
  status: string;
  targets: string[];
  needs_original: boolean | null;
  latest_release: string | null;
  /** How the linked repository relates to the claim's games. */
  relation?: "implementation" | "distribution" | "mirror";
  /** Every game the source associates with this repository. */
  games?: string[];
  /** Matching progress in tenths; small changes inside a band are not research changes. */
  progress_band?: number | null;
  /** Lineage: the sources this claim was copied from. */
  origin?: string[];
  /** A distribution channel that builds or packages the upstream separately. */
  channel?: string;
  /** The distribution's pinned version, tag or commit of the upstream. */
  pinned?: string | null;
  fingerprint: string;
}
/** Repository hosts with provider resolution, and `web` for any other official URL. */
export type ExternalHost = "github" | "gitlab" | "codeberg" | "web";
export interface ExternalListEntry {
  key: string;
  url: string;
  host: ExternalHost;
  title: string;
  source_entries?: ExternalSourceEntry[];
}
export interface ParsedExternalList {
  entries: ExternalListEntry[];
  /** Entries without a usable repository link: name-only hints that are not invented mappings. */
  unlinked: number;
  /** Entries the list itself classifies outside native-port scope (clones, similar games, tools). */
  excluded?: number;
  source?: { url: string; revision: string; content_sha256: string; repository_id?: number };
}

export const hosts = {
  "github.com": "github",
  "gitlab.com": "gitlab",
  "codeberg.org": "codeberg",
} as const;
export const segment = /^[A-Za-z0-9_.-]{1,100}$/u;
/**
 * Hosts that never identify a project's own code or official site: video,
 * social, chat, storefront, encyclopedia, archive, donation and link-shortening
 * services. A source naming one is not naming an upstream.
 */
export const nonProjectHost =
  /(?:^|\.)(?:youtube\.com|youtu\.be|twitter\.com|x\.com|discord\.gg|discord\.com|reddit\.com|redd\.it|store\.steampowered\.com|steamcommunity\.com|wikipedia\.org|archive\.org|patreon\.com|ko-fi\.com|bit\.ly|t\.co|imgur\.com|twitch\.tv|facebook\.com|instagram\.com|tiktok\.com|bsky\.app|gog\.com|google\.com|tanookistudios\.com|decompbuddy\.com|decomp\.fun|unbaked\.games|portsdr\.com|recomplauncher\.com)$/u;
/**
 * An official project URL on a host without provider resolution: a SourceForge
 * project, a self-hosted forge or an independent site. It is retained as an
 * unresolved hint so a later provider adapter or an attributed repository link
 * can take it up; it is never researched as a GitHub repository.
 */
export function externalWebLocation(value: string) {
  let url: URL;
  try {
    url = new URL(value.trim());
  } catch {
    return null;
  }
  const host = url.hostname.toLowerCase().replace(/\.$/u, "");
  if (
    !["https:", "http:"].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.port ||
    !/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/u.test(host) ||
    nonProjectHost.test(host) ||
    // Any other GitHub, GitLab or Codeberg route (gists, archives, raw files)
    // names no project; a repository on those hosts is resolved, not kept as web.
    /(?:^|\.)(?:github\.com|githubusercontent\.com|gitlab\.com|codeberg\.org)$/u.test(host)
  )
    return null;
  let parts = url.pathname.split("/").filter(Boolean);
  if (parts.some((part) => part.length > 200 || /^\.+$/u.test(part)) || parts.length > 12)
    return null;
  let search = url.search.length > 1 && url.search.length <= 200 ? url.search : "";
  const site = /(?:^|\.)sourceforge\.net$/u.test(host) ? "sourceforge.net" : host;
  // SourceForge serves one project under several routes, mirror hosts and a
  // project site (`<name>.sourceforge.net`); its project root is the identity.
  // Mirror and service hosts name the project only in their path.
  const sourceforge = /(?:^|\.)sourceforge\.net$/u.test(host);
  if (sourceforge) {
    const labels = host.split(".").slice(0, -2);
    const projectSite =
      labels.length === 1 && !sourceforgeServiceHosts.has(labels[0]!) ? labels[0] : undefined;
    const routed =
      parts[0] === "projects" || parts[0] === "project" || parts[0] === "p"
        ? parts[1]
        : // A mirror's `/<name>/<file>` download route.
          labels.length && labels[0] === "prdownloads"
          ? parts[0]
          : undefined;
    const project = projectSite ?? routed;
    if (!project || !segment.test(project)) return null;
    parts = ["projects", project.toLowerCase()];
    search = "";
  } else {
    // A GitLab-style `/-/` route belongs to the project before it.
    const route = parts.indexOf("-");
    if (route > 0) {
      parts = parts.slice(0, route);
      search = "";
    }
  }
  const path = `${parts.length ? `/${parts.join("/")}` : ""}${search}`;
  // One site served over HTTP and HTTPS is one location; the key ignores the scheme.
  return {
    key: `https://${site}${path}`.toLowerCase(),
    url: `${sourceforge ? "https:" : url.protocol}//${site}${path}`,
    host: "web",
  } as const;
}
/** SourceForge hosts that serve many projects: mirrors and services, never a project site. */
const sourceforgeServiceHosts = new Set([
  "www",
  "downloads",
  "prdownloads",
  "master",
  "dl",
  "svn",
  "git",
  "hg",
  "cvs",
  "web",
  "shell",
  "frs",
  "apps",
  "a",
]);
/** A repository on a resolvable host, or else an official URL on any other host. */
export function externalLocation(value: string) {
  return externalRepository(value) ?? externalWebLocation(value);
}
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
  // `www.` serves the same repositories. A non-HTTPS repository link is never
  // turned into a mapping.
  const hostname = url.hostname.toLowerCase().replace(/^www\./u, "");
  const host = hosts[hostname as keyof typeof hosts];
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
  const canonical = `https://${hostname}/${project.join("/")}`;
  return { key: canonical.toLowerCase(), url: canonical, host } as const;
}
export const inert = (value: unknown) =>
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
export const entity = (value: string) =>
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
export function bounded(text: string, cap: number, label: string) {
  if (Buffer.byteLength(text) > cap) throw new Error(`Oversized ${label}`);
}
/**
 * Rows are the URLs a source labels as a project's repository or official site.
 * Repositories on resolvable hosts become resolvable hints; official URLs on
 * other hosts are retained as unresolved `web` hints.
 */
export function collect(
  rows: { url: string; title: string }[],
  unlinked: number,
): ParsedExternalList {
  if (!rows.length && !unlinked) throw new Error("External list has no entries");
  const entries = new Map<string, ExternalListEntry>();
  for (const row of rows) {
    const repository = externalLocation(row.url);
    if (!repository) {
      unlinked++;
      continue;
    }
    if (!entries.has(repository.key))
      entries.set(repository.key, { ...repository, title: inert(row.title) });
  }
  return { entries: [...entries.values()].sort((a, b) => a.key.localeCompare(b.key)), unlinked };
}

export const json = (text: string, label: string): unknown => {
  try {
    return JSON.parse(text);
  } catch {
    // Never copy list bytes into notes through the parser's diagnostic.
    throw new Error(`Malformed ${label} JSON`);
  }
};

export const strings = (v: unknown) =>
  Array.isArray(v) && v.every((item) => typeof item === "string" && item.length <= 160);
/** The optional attributed-claim fields, when present, have their documented shapes. */
export function validClaimExtensions(row: Record<string, unknown>) {
  return (
    (row.relation === undefined ||
      (typeof row.relation === "string" &&
        ["implementation", "distribution", "mirror"].includes(row.relation))) &&
    (row.games === undefined || strings(row.games)) &&
    (row.origin === undefined || strings(row.origin)) &&
    (row.progress_band === undefined ||
      row.progress_band === null ||
      (Number.isSafeInteger(row.progress_band) &&
        Number(row.progress_band) >= 0 &&
        Number(row.progress_band) <= 10)) &&
    (row.channel === undefined || (typeof row.channel === "string" && listId.test(row.channel))) &&
    (row.pinned === undefined ||
      row.pinned === null ||
      (typeof row.pinned === "string" && row.pinned.length <= 256))
  );
}
/** Tenths of matching progress; a source's small percentage moves stay in one band. */
export function progressBand(percent: unknown) {
  // Every source publishes a percentage (0 to 100); 0.99 means under one percent.
  if (typeof percent !== "number" || !Number.isFinite(percent) || percent < 0 || percent > 100)
    return null;
  return percent >= 100 ? 10 : Math.floor(percent / 10);
}
/**
 * A claim identity: its inert text, or a long one's prefix and digest, so two
 * long identities never collapse into one by truncation.
 */
export function claimId(value: unknown) {
  const text = typeof value === "string" ? value : "";
  const clean = text
    .replace(/[\p{Cc}\p{Cf}]+/gu, " ")
    .replace(/\s+/gu, " ")
    .trim();
  return Array.from(clean).length <= maxTitle
    ? clean
    : `${Array.from(clean)
        .slice(0, maxTitle - 17)
        .join("")}#${observationHash(clean).slice(0, 16)}`;
}
/** One attributed claim with its fingerprint over every claim field. */
export function sourceEntry(claims: Omit<ExternalSourceEntry, "fingerprint">): ExternalSourceEntry {
  const normalized = {
    ...claims,
    subject: inert(claims.subject),
    targets: [...new Set(claims.targets.map(inert).filter(Boolean))].sort(),
    ...(claims.games
      ? { games: [...new Set(claims.games.map(inert).filter(Boolean))].sort() }
      : {}),
    ...(claims.origin
      ? { origin: [...new Set(claims.origin.map(inert).filter(Boolean))].sort() }
      : {}),
  };
  return { ...normalized, fingerprint: observationHash(normalized) };
}
