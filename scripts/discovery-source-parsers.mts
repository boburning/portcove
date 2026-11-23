import { isRecord } from "./runtime-values.mts";
import {
  bounded,
  externalLocation,
  claimId,
  inert,
  json,
  progressBand,
  sourceEntry,
} from "./discovery-claims.mts";
import type {
  ExternalListEntry,
  ExternalSourceEntry,
  ParsedExternalList,
} from "./discovery-claims.mts";

// Structured aggregator and catalog parsers. Each reads published data only:
// repository or official URLs, inert titles and attributed claims. A schema the
// parser does not recognize fails the read, which keeps the last good copy.

/** Rows carrying one attributed claim each, grouped by repository location. */
function group(
  rows: { url: string | null | undefined; title: string; claim?: ExternalSourceEntry }[],
  extra: { unlinked?: number; excluded?: number } = {},
): ParsedExternalList {
  let unlinked = extra.unlinked ?? 0;
  const entries = new Map<string, ExternalListEntry>();
  for (const row of rows) {
    const location = typeof row.url === "string" ? externalLocation(row.url) : null;
    if (!location) {
      unlinked++;
      continue;
    }
    const entry = entries.get(location.key) ?? { ...location, title: inert(row.title) };
    if (row.claim) {
      const claims = new Map((entry.source_entries ?? []).map((claim) => [claim.id, claim]));
      claims.set(row.claim.id, row.claim);
      entry.source_entries = [...claims.values()].sort((a, b) => a.id.localeCompare(b.id));
    }
    entries.set(location.key, entry);
  }
  if (!entries.size && !unlinked) throw new Error("External list has no entries");
  return {
    entries: [...entries.values()].sort((a, b) => a.key.localeCompare(b.key)),
    unlinked,
    ...(extra.excluded !== undefined ? { excluded: extra.excluded } : {}),
  };
}
const text = (value: unknown) => (typeof value === "string" ? value : "");
const list = (value: unknown) =>
  Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
const releaseOf = (...values: unknown[]) => {
  const found = values.find((value) => typeof value === "string" && value.trim());
  return typeof found === "string" ? inert(found) : null;
};

/** Decomp Buddy lineage keys, named as the configured lists they come from. */
const decompBuddyOrigins: Record<string, string> = {
  finds: "decomp-buddy-finds",
  portsdr: "portsdr",
  alexbeav: "alexbeav-psx",
};
const decompBuddyOrigin = (key: string) =>
  decompBuddyOrigins[key] ?? (key.startsWith("list:") ? `decomp-buddy-${key}` : key);

/**
 * Decomp Buddy `catalog.json` (schema 1): released projects with desktop
 * downloads, one entry per game (a multi-game repository has one entry per
 * game). Each entry's `sources` names the lists it came from; `takedown`
 * entries are kept as attributed status, never as availability evidence.
 */
export function parseDecompBuddyCatalog(textValue: string): ParsedExternalList {
  bounded(textValue, 64 * 1024 * 1024, "Decomp Buddy catalog");
  const value = json(textValue, "Decomp Buddy catalog");
  if (!isRecord(value) || value.schema !== 1 || !Array.isArray(value.games))
    throw new Error("Unsupported Decomp Buddy catalog schema");
  if (value.count !== value.games.length) throw new Error("Incomplete Decomp Buddy catalog");
  const rows = value.games.map((game) => {
    if (!isRecord(game) || typeof game.id !== "string" || !game.id)
      throw new Error("Malformed Decomp Buddy catalog entry");
    const facts = isRecord(game.facts) ? game.facts : {};
    const status = [
      text(game.status),
      game.takedown === true || facts.takedown === true ? "takedown" : "",
    ]
      .filter(Boolean)
      .join(",");
    return {
      url: text(game.repoUrl),
      title: text(game.title),
      claim: sourceEntry({
        id: claimId(game.id),
        subject: text(game.title),
        category: inert(game.console),
        method: inert(facts.completeness),
        status: inert(status),
        targets: list(game.platforms),
        needs_original: null,
        latest_release: releaseOf(game.latestVersion, game.version),
        relation: "implementation",
        games: [text(game.slug) || text(game.title)],
        origin: list(game.sources).map(decompBuddyOrigin),
      }),
    };
  });
  return group(rows);
}

/**
 * Decomp Buddy `waiting.json`: projects without a desktop download yet, which
 * the published catalog leaves out. Only `games` are hints; `hidden` rows are
 * Decomp Buddy's own rejections and count as excluded.
 */
export function parseDecompBuddyWaiting(textValue: string): ParsedExternalList {
  bounded(textValue, 64 * 1024 * 1024, "Decomp Buddy waiting list");
  const value = json(textValue, "Decomp Buddy waiting list");
  if (!isRecord(value) || !Array.isArray(value.games))
    throw new Error("Unsupported Decomp Buddy waiting list shape");
  const rows = value.games.map((game) => {
    if (!isRecord(game) || typeof game.repo !== "string")
      throw new Error("Malformed Decomp Buddy waiting entry");
    const repo = game.repo.trim();
    const url = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u.test(repo)
      ? `https://github.com/${repo}`
      : repo;
    return {
      url,
      title: text(game.title),
      claim: sourceEntry({
        id: claimId(repo),
        subject: text(game.title),
        category: inert(game.console),
        method: "",
        // No Windows, macOS or Linux download is published yet.
        status: "waiting",
        targets: [],
        needs_original: null,
        latest_release: null,
        relation: "implementation",
        games: [text(game.title)],
        origin: ["decomp-buddy-waiting"],
      }),
    };
  });
  return group(rows, { excluded: Array.isArray(value.hidden) ? value.hidden.length : 0 });
}

const ownerRepo = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u;
/** The default build's matching progress, or the first build's. */
function defaultProgress(versions: unknown) {
  if (!Array.isArray(versions)) return null;
  const builds = versions.filter(isRecord);
  const chosen = builds.find((build) => build.default === true) ?? builds[0];
  return chosen ? progressBand(chosen.decompiled_percent) : null;
}

/**
 * decomp.fun `v1/projects.json`: every matching decompilation, including
 * non-leading projects for a game (`leader: false`, `listed_as` the leader).
 * Each project keeps its own identity; its slot names the game.
 */
export function parseDecompFunProjects(textValue: string): ParsedExternalList {
  bounded(textValue, 64 * 1024 * 1024, "decomp.fun index");
  const value = json(textValue, "decomp.fun index");
  if (!isRecord(value) || !Array.isArray(value.projects))
    throw new Error("Unsupported decomp.fun index shape");
  if (value.api_version !== undefined && value.api_version !== 1)
    throw new Error("Unsupported decomp.fun API version");
  let unlinked = 0;
  const rows: Parameters<typeof group>[0] = [];
  for (const project of value.projects) {
    if (!isRecord(project)) throw new Error("Malformed decomp.fun project");
    const title = text(project.game_title) || text(project.name);
    if (typeof project.repository !== "string") {
      unlinked++;
      continue;
    }
    const platform = isRecord(project.platform) ? text(project.platform.key) : "";
    const slot = text(project.slot);
    rows.push({
      url: project.repository,
      title,
      claim: sourceEntry({
        id: claimId(slot || `${text(project.owner)}/${text(project.repo)}`),
        subject: title,
        category: inert(platform),
        method: "matching-decompilation",
        status: [
          project.leader === false ? `alternate-of:${text(project.listed_as)}` : "leader",
          project.archived === true ? "archived" : "",
        ]
          .filter(Boolean)
          .join(","),
        targets: [],
        needs_original: null,
        latest_release: null,
        relation: "implementation",
        games: slot ? [slot] : [],
        progress_band: defaultProgress(project.versions),
      }),
    });
  }
  return group(rows, { unlinked });
}

/**
 * decomp.fun `v1/games.json`: one slot per game with its leading project and
 * every other implementation. A leader never suppresses another project; each
 * keeps its own identity and its relation to the game.
 */
export function parseDecompFunGames(textValue: string): ParsedExternalList {
  bounded(textValue, 64 * 1024 * 1024, "decomp.fun games");
  const value = json(textValue, "decomp.fun games");
  if (!isRecord(value) || value.api_version !== 1 || !isRecord(value.games))
    throw new Error("Unsupported decomp.fun games schema");
  if (typeof value.count === "number" && value.count !== Object.keys(value.games).length)
    throw new Error("Incomplete decomp.fun games index");
  const rows: Parameters<typeof group>[0] = [];
  for (const [slot, game] of Object.entries(value.games)) {
    if (!isRecord(game)) throw new Error("Malformed decomp.fun game");
    const projects = [
      { repo: text(game.leader), leader: true },
      ...list(game.others).map((repo) => ({ repo, leader: false })),
    ];
    for (const project of projects) {
      if (!ownerRepo.test(project.repo)) throw new Error("Malformed decomp.fun game project");
      rows.push({
        url: `https://github.com/${project.repo}`,
        title: text(game.title),
        claim: sourceEntry({
          id: claimId(slot),
          subject: text(game.title),
          category: inert(game.platform),
          method: "matching-decompilation",
          status: project.leader ? "leader" : `alternate-of:${text(game.leader)}`,
          targets: [],
          needs_original: null,
          latest_release: null,
          relation: "implementation",
          games: [slot],
          // Only the leader's progress is published per slot.
          progress_band: project.leader ? progressBand(game.decompiled_percent) : null,
        }),
      });
    }
  }
  return group(rows);
}

/** One unbaked inventory row: the per-game record link and the row's change fingerprint. */
export interface UnbakedInventoryRow {
  slug: string;
  title: string;
  record: string;
  public_code: boolean;
  /** The inventory fields whose change makes the per-game record due again. */
  fingerprint: string;
}
const slugPattern = /^[a-z0-9][a-z0-9-]{0,159}$/u;

/**
 * unbaked `api/games.json`: the complete registry inventory in one file. It has
 * no repository URLs; each row links its per-game record.
 */
export function parseUnbakedInventory(textValue: string): UnbakedInventoryRow[] {
  bounded(textValue, 64 * 1024 * 1024, "unbaked inventory");
  const value = json(textValue, "unbaked inventory");
  if (!isRecord(value) || !Array.isArray(value.games))
    throw new Error("Unsupported unbaked inventory shape");
  if (typeof value.count === "number" && value.count !== value.games.length)
    throw new Error("Incomplete unbaked inventory");
  const seen = new Set<string>();
  return value.games.map((game) => {
    if (
      !isRecord(game) ||
      typeof game.slug !== "string" ||
      !slugPattern.test(game.slug) ||
      seen.has(game.slug) ||
      game.json !== `https://unbaked.games/api/games/${game.slug}.json`
    )
      throw new Error("Malformed unbaked inventory entry");
    seen.add(game.slug);
    const { stars: _stars, ...facts } = game;
    return {
      slug: game.slug,
      title: inert(game.title),
      record: game.json,
      public_code: game.has_public_code === true,
      // Popularity moves daily; the record is due again only for other changes.
      fingerprint: sourceEntry({
        id: game.slug,
        subject: text(game.title),
        category: "",
        method: JSON.stringify(facts),
        status: "",
        targets: [],
        needs_original: null,
        latest_release: null,
      }).fingerprint,
    };
  });
}

/**
 * unbaked per-game record: every project the registry associates with one
 * game. A game without public code keeps its candidate status on each
 * project's claim; general tools are outside native-port scope and excluded.
 */
export function parseUnbakedGame(textValue: string, slug: string): ParsedExternalList {
  bounded(textValue, 64 * 1024 * 1024, "unbaked game record");
  const value = json(textValue, "unbaked game record");
  if (!isRecord(value) || value.slug !== slug || !Array.isArray(value.projects))
    throw new Error("Unsupported unbaked game record");
  let excluded = 0;
  const rows: Parameters<typeof group>[0] = [];
  for (const project of value.projects) {
    if (!isRecord(project)) throw new Error("Malformed unbaked project");
    if (project.general_tool === true) {
      excluded++;
      continue;
    }
    const status = [
      value.has_public_code === true ? "" : "candidate-without-public-code",
      project.archived === true ? "archived" : "",
      project.new_unvetted === true ? "unvetted" : "",
    ]
      .filter(Boolean)
      .join(",");
    const progress = isRecord(project.progress) ? project.progress.matched_code_percent : null;
    rows.push({
      // A project without a repository may still name its official site.
      url: text(project.url) || text(project.website) || null,
      title: text(value.title),
      claim: sourceEntry({
        id: claimId(`${slug}:${text(project.name)}`),
        subject: text(value.title),
        category: inert(value.platform),
        method: list(project.methods).map(inert).join(","),
        status: inert(status),
        targets: list(project.runs_on),
        needs_original: null,
        latest_release: null,
        relation: "implementation",
        games: [slug],
        progress_band: progressBand(progress),
      }),
    });
  }
  if (!rows.length && !excluded)
    // A game with no listed project is a research candidate, not an empty read.
    return { entries: [], unlinked: 0, excluded: 0 };
  return group(rows, { excluded });
}

/**
 * Recompendium's launcher feed (`unricopie/catalogo.json`, format 1). Its data
 * is CC BY-SA 4.0: only repository identities and attributed claims are kept;
 * descriptions and requirement prose are never read. A retired or unlinked
 * entry keeps that status; it is a lead, never support evidence.
 */
export function parseRecompendiumCatalog(textValue: string): ParsedExternalList {
  bounded(textValue, 64 * 1024 * 1024, "Recompendium catalog");
  const value = json(textValue, "Recompendium catalog");
  if (!isRecord(value) || value.formato !== 1 || !Array.isArray(value.entradas))
    throw new Error("Unsupported Recompendium catalog format");
  const rows = value.entradas.map((entry) => {
    if (!isRecord(entry) || typeof entry.entry !== "string" || !entry.entry)
      throw new Error("Malformed Recompendium entry");
    const repo = text(entry.repo).trim();
    // GitHub `owner/name`; a dotted first segment names its own host.
    const url = ownerRepo.test(repo)
      ? repo.split("/")[0]!.includes(".")
        ? `https://${repo}`
        : `https://github.com/${repo}`
      : null;
    return {
      url,
      title: text(entry.nombre) || text(entry.proyecto),
      claim: sourceEntry({
        id: claimId(entry.entry),
        subject: text(entry.proyecto) || text(entry.nombre),
        category: inert(entry.consola),
        method: [text(entry.metodo), text(entry.toolchain)].filter(Boolean).map(inert).join(","),
        status: [
          text(entry.estado),
          entry.retirado === true ? "retired" : "",
          entry.sin_enlace === true ? "unlinked" : "",
        ]
          .filter(Boolean)
          .map(inert)
          .join(","),
        targets: [],
        needs_original: null,
        latest_release: releaseOf(entry.version),
        relation: "implementation",
        games: [text(entry.juego)],
      }),
    };
  });
  return group(rows);
}
