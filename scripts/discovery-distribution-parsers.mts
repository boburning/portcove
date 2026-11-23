import { isRecord } from "./runtime-values.mts";
import {
  bounded,
  claimId,
  externalLocation,
  inert,
  json,
  sourceEntry,
} from "./discovery-claims.mts";
import type {
  ExternalListEntry,
  ExternalSourceEntry,
  ParsedExternalList,
} from "./discovery-claims.mts";

// Distribution channels and launcher catalogs. A distribution builds or
// packages an upstream separately: its paths, patches, pins and builds stay
// attributed to the channel, and the hint names the original project, whose
// own releases are resolved there. Definitions are read as text; no packaging
// script is executed.

/** Rows grouped by repository location, each carrying one attributed claim. */
function group(
  rows: { url: string | null | undefined; title: string; claim: ExternalSourceEntry }[],
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
    const claims = new Map((entry.source_entries ?? []).map((claim) => [claim.id, claim]));
    claims.set(row.claim.id, row.claim);
    entry.source_entries = [...claims.values()].sort((a, b) => a.id.localeCompare(b.id));
    entries.set(location.key, entry);
  }
  return {
    entries: [...entries.values()].sort((a, b) => a.key.localeCompare(b.key)),
    unlinked,
    ...(extra.excluded !== undefined ? { excluded: extra.excluded } : {}),
  };
}
const text = (value: unknown) => (typeof value === "string" ? value : "");
const strings = (value: unknown) =>
  Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
/** The ScummVM engine itself is outside Portcove's onboarding scope. */
const scummvm = (url: string) => /\/\/(?:www\.)?github\.com\/scummvm\//iu.test(url);

/**
 * Luxtorpeda engines that are not native replacement engines for a game:
 * emulators and interpreters used as fallbacks, generic runtimes, launchers and
 * tools. ScummVM is excluded separately; Proton-only packages are recognized
 * by their `uses_proton` notice.
 */
const luxtorpedaNonNative = new Map<string, string>([
  ["dosbox-staging", "emulator"],
  ["dreamm", "emulator"],
  ["ruffle", "emulator"],
  ["easyrpg-player", "emulator"],
  ["blastem", "emulator"],
  ["lectrote", "interpreter"],
  ["retroarch", "emulator"],
  ["godot", "runtime"],
  ["godot-4", "runtime"],
  ["love2d", "runtime"],
  ["nwjs", "runtime"],
  ["renpy", "runtime"],
  ["doom-runner", "tool"],
  ["doomseeker", "tool"],
  ["quake-injector", "tool"],
]);

/**
 * Luxtorpeda's published package index (`packagessniper_v2.json`, generated
 * from codeberg.org/luxtorpeda/packages): native Linux engines for Steam games.
 * Each native engine's upstream link is a hint with the games it serves, its
 * pinned version and Luxtorpeda as the distribution channel.
 */
export function parseLuxtorpedaIndex(textValue: string): ParsedExternalList {
  bounded(textValue, 64 * 1024 * 1024, "Luxtorpeda index");
  const value = json(textValue, "Luxtorpeda index");
  if (!isRecord(value) || !Array.isArray(value.engines) || !Array.isArray(value.games))
    throw new Error("Unsupported Luxtorpeda index shape");
  // Games served by each engine, directly or as one of their choices.
  const served = new Map<string, Set<string>>();
  for (const game of value.games) {
    if (!isRecord(game) || typeof game.app_id !== "string" || !/^\d{1,12}$/u.test(game.app_id))
      throw new Error("Malformed Luxtorpeda game");
    const names = [
      text(game.engine_name),
      ...(Array.isArray(game.choices)
        ? game.choices.filter(isRecord).map((choice) => text(choice.engine_name))
        : []),
    ].filter(Boolean);
    for (const name of names) {
      const games = served.get(name) ?? new Set<string>();
      games.add(`steam:${game.app_id} ${inert(game.game_name)}`.trim());
      served.set(name, games);
    }
  }
  let excluded = 0;
  const rows: Parameters<typeof group>[0] = [];
  const seen = new Set<string>();
  for (const engine of value.engines) {
    if (!isRecord(engine) || typeof engine.internal_engine_name !== "string")
      throw new Error("Malformed Luxtorpeda engine");
    const id = engine.internal_engine_name;
    const notices = Array.isArray(engine.notices)
      ? engine.notices
          .filter(isRecord)
          .map((notice) => text(notice.key))
          .filter(Boolean)
      : [];
    const link = text(engine.engine_link);
    if (
      luxtorpedaNonNative.has(id) ||
      id === "scummvm" ||
      scummvm(link) ||
      notices.includes("uses_proton")
    ) {
      excluded++;
      continue;
    }
    // One engine can be listed for several game families; its claim is one.
    const key = `${id}:${link}`;
    if (seen.has(key)) continue;
    seen.add(key);
    rows.push({
      url: link,
      title: text(engine.engine_name),
      claim: sourceEntry({
        id: claimId(id),
        subject: text(engine.engine_name),
        category: "native-engine",
        method: "",
        status: [...new Set(notices)].sort().join(","),
        targets: ["Linux"],
        needs_original: true,
        latest_release: null,
        relation: "distribution",
        games: [...(served.get(text(engine.engine_name)) ?? [])],
        channel: "luxtorpeda",
        pinned: text(engine.version) ? inert(engine.version) : null,
      }),
    });
  }
  return group(rows, { excluded });
}

/**
 * Mac Source Ports `meta.json`: every macOS build it lists, with its upstream
 * repository. A build Mac Source Ports produced itself (`MSPBuild`) is a
 * separately produced distribution build; any other is the project's own build
 * listed by the site. Mac Source Ports' own forks are never upstreams.
 */
export function parseMacSourcePortsMeta(textValue: string): ParsedExternalList {
  bounded(textValue, 64 * 1024 * 1024, "Mac Source Ports index");
  const value = json(textValue, "Mac Source Ports index");
  if (!Array.isArray(value) || !value.length) throw new Error("Unsupported Mac Source Ports index");
  let excluded = 0;
  const rows: Parameters<typeof group>[0] = [];
  for (const build of value) {
    if (!isRecord(build) || typeof build.sourcePortStub !== "string" || !build.sourcePortStub)
      throw new Error("Malformed Mac Source Ports build");
    const upstream = text(build.sourcePortGitHub);
    // Mac Source Ports' own repositories are its forks or builds, not upstreams.
    if (scummvm(upstream) || /\/\/(?:www\.)?github\.com\/MacSourcePorts\//iu.test(upstream)) {
      excluded++;
      continue;
    }
    rows.push({
      url: upstream || null,
      title: text(build.sourcePortTitle),
      claim: sourceEntry({
        id: claimId(`${build.sourcePortStub}#${text(build.sourcePortType)}`),
        subject: text(build.sourcePortTitle),
        category: "macos-build",
        method: "",
        status: build.MSPBuild === true ? "separately-built" : "upstream-build",
        targets: [`macOS ${text(build.sourcePortType)}`.trim()],
        needs_original: null,
        latest_release: text(build.buildVersion) ? inert(build.buildVersion) : null,
        relation: "distribution",
        games: [],
        channel: "macsourceports",
        pinned: text(build.buildVersion) ? inert(build.buildVersion) : null,
      }),
    });
  }
  return group(rows, { excluded });
}

/** Joins Makefile line continuations so one assignment is one line. */
const logicalLines = (source: string) => source.replace(/\\\r?\n[ \t]*/gu, " ").split(/\r?\n/u);

/**
 * One Batocera port package (`package/batocera/ports/<name>/<name>.mk`), read as
 * text. `<PKG>_SITE` names the upstream (a `$(call github|gitlab,owner,repo,…)`
 * or a literal URL); `<PKG>_VERSION` is Batocera's pin. Several packages in one
 * file each make a claim.
 */
export function parseBatoceraPackage(source: string, path: string): ParsedExternalList {
  bounded(source, 8 * 1024 * 1024, "Batocera package");
  const versions = new Map<string, string>();
  const sites = new Map<string, string>();
  for (const raw of logicalLines(source)) {
    const line = raw.trim();
    const version = /^([A-Z0-9_]+)_VERSION\s*[:?]?=\s*(\S+)/u.exec(line);
    if (version) versions.set(version[1]!, version[2]!);
    const call =
      /^([A-Z0-9_]+)_SITE\s*[:?]?=\s*\$\(call (github|gitlab),\s*([^,\s]+),\s*([^,\s)]+)/u.exec(
        line,
      );
    if (call && !sites.has(call[1]!))
      sites.set(
        call[1]!,
        `https://${call[2] === "github" ? "github.com" : "gitlab.com"}/${call[3]}/${call[4]}`,
      );
    else {
      // A site naming its download route with make variables still names the
      // project before them; the location keeps only the project path.
      const literal = /^([A-Z0-9_]+)_SITE\s*[:?]?=\s*(https?:\/\/\S+)/u.exec(line);
      if (literal) {
        const project = literal[2]!.split("$(")[0]!.replace(/\.git$/iu, "");
        if (!sites.has(literal[1]!) && project.length > 8) sites.set(literal[1]!, project);
      }
    }
  }
  let excluded = 0;
  const rows: Parameters<typeof group>[0] = [];
  for (const [name, site] of sites) {
    if (scummvm(site)) {
      excluded++;
      continue;
    }
    const version = versions.get(name);
    rows.push({
      url: site,
      title: name.toLowerCase().replaceAll("_", "-"),
      claim: sourceEntry({
        id: claimId(`${path}#${name}`),
        subject: name.toLowerCase().replaceAll("_", "-"),
        category: "batocera-port",
        method: "buildroot",
        status: "",
        targets: ["Linux"],
        needs_original: null,
        latest_release: null,
        relation: "distribution",
        games: [],
        channel: "batocera",
        // A pin that is itself a make variable is not a resolvable version.
        pinned: version && !version.includes("$(") ? inert(version) : null,
      }),
    });
  }
  return group(rows, { unlinked: sites.size ? 0 : 1, excluded });
}

/**
 * One RetroPie port module (`scriptmodules/ports/<id>.sh`), read as text and
 * never sourced. `rp_module_repo` is `<type> <url> [branch] [commit]`; a token
 * starting with `:` is resolved by a shell function at install time and is not
 * a static pin. Further repositories passed to `gitPullOrClone` are hints too.
 */
export function parseRetropieModule(source: string, path: string): ParsedExternalList {
  bounded(source, 8 * 1024 * 1024, "RetroPie module");
  const field = (name: string) => {
    const match = new RegExp(`^rp_module_${name}=(?:"([^"]*)"|'([^']*)')`, "mu").exec(source);
    return match?.[1] ?? match?.[2] ?? "";
  };
  const id = field("id") || path.replace(/^.*\/|\.sh$/gu, "");
  const repo = field("repo").trim().split(/\s+/u).filter(Boolean);
  const urls: { url: string; pinned: string | null }[] = [];
  if (repo[0] === "git" && repo[1]) {
    // Only a commit is a pin; a branch moves and a `:function` resolves at install.
    const commit = repo[3] && /^[0-9a-f]{7,40}$/iu.test(repo[3]) ? repo[3] : null;
    urls.push({ url: repo[1], pinned: commit });
  }
  for (const match of source.matchAll(/gitPullOrClone\s+\S+\s+["']?(https?:\/\/[^\s"';)]+)/gu))
    urls.push({ url: match[1]!, pinned: null });
  let excluded = 0;
  const rows: Parameters<typeof group>[0] = [];
  for (const { url, pinned } of urls) {
    const upstream = url.replace(/\.git$/iu, "");
    if (scummvm(upstream)) {
      excluded++;
      continue;
    }
    rows.push({
      url: upstream,
      title: field("desc") || id,
      claim: sourceEntry({
        id: claimId(`${path}#${upstream}`),
        subject: field("desc") || id,
        category: "retropie-port",
        method: field("section"),
        status: field("flags"),
        targets: ["Linux"],
        needs_original: null,
        latest_release: null,
        relation: "distribution",
        games: [inert(id)],
        channel: "retropie",
        pinned: pinned ? inert(pinned) : null,
      }),
    });
  }
  // A module installing from system packages or a download names no repository.
  return group(rows, { unlinked: urls.length ? 0 : 1, excluded });
}

/**
 * RecompLauncher's repository value for each host it supports, or null. A host
 * it does not name, or a GitHub value that is not exactly `owner/name` (a
 * dotted first segment names another host), is never mapped to GitHub.
 */
function recompLauncherUrl(repo: string, host: string) {
  if (!repo) return null;
  const segments = repo.split("/");
  if (host === "gitlab") return `https://gitlab.com/${repo}`;
  if (host === "forgejo") return segments.length >= 3 ? `https://${repo}` : null;
  if (host === "sourceforge")
    return segments.length === 1 ? `https://sourceforge.net/projects/${repo}` : null;
  if ((host === "" || host === "github") && segments.length === 2 && !segments[0]!.includes("."))
    return `https://github.com/${repo}`;
  return null;
}

/**
 * RecompLauncher's `pc-catalog.json` (catalog version 1): PC builds of
 * recompilations, decompilation ports and native games, including the groups
 * only newer launchers show. Catalog inclusion and platform labels are the
 * launcher's attributed observations.
 */
export function parseRecompLauncherCatalog(textValue: string): ParsedExternalList {
  bounded(textValue, 64 * 1024 * 1024, "RecompLauncher catalog");
  const value = json(textValue, "RecompLauncher catalog");
  if (!isRecord(value) || value.catalogVersion !== 1 || !Array.isArray(value.apps))
    throw new Error("Unsupported RecompLauncher catalog");
  const groups: unknown[] = Array.isArray(value.apps_min) ? value.apps_min : [];
  const apps: unknown[] = [
    ...(value.apps as unknown[]),
    ...groups
      .filter(isRecord)
      .flatMap((group): unknown[] => (Array.isArray(group.apps) ? (group.apps as unknown[]) : [])),
  ];
  const rows: Parameters<typeof group>[0] = [];
  for (const app of apps) {
    if (!isRecord(app) || typeof app.id !== "string" || !app.id)
      throw new Error("Malformed RecompLauncher app");
    const games = strings(app.games).length ? strings(app.games) : [text(app.game)];
    rows.push({
      url: recompLauncherUrl(text(app.repo).trim(), text(app.host)),
      title: text(app.game) || text(app.name),
      claim: sourceEntry({
        id: claimId(app.id),
        subject: text(app.name),
        category: inert(app.origin),
        method: "",
        status: [
          text(app.status),
          app.archived === true ? "archived" : "",
          app.soon === true ? "soon" : "",
        ]
          .filter(Boolean)
          .join(","),
        targets: strings(app.systems),
        needs_original: null,
        latest_release: text(app.tag) || text(app.version) || null,
        relation: "implementation",
        games,
      }),
    });
  }
  return group(rows);
}
