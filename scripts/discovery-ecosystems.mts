import { isRecord } from "./runtime-values.mts";

// Append families: persisted numeric rotation and existing slice IDs retain their meaning.
export const ecosystemSearchFamilies = [
  { id: "ps2recomp", terms: "PS2Recomp in:name,description,readme", clock: "pushed" },
  { id: "xboxrecomp", terms: "XboxRecomp in:name,description,readme", clock: "pushed" },
  { id: "rexglue", terms: "ReXGlue in:name,description,readme", clock: "pushed" },
  { id: "ps3recomp", terms: "PS3Recomp in:name,description,readme", clock: "pushed" },
  { id: "ps4-runtime", terms: "bbport in:name,description,readme", clock: "pushed" },
  { id: "psprecomp", terms: "PSPRecomp in:name,description,readme", clock: "pushed" },
  { id: "gcn-recomp", terms: '"gcn-recomp" in:name,description,readme', clock: "pushed" },
  { id: "dolrecomp", terms: "DolRecomp in:name,description,readme", clock: "pushed" },
  { id: "psxrecomp", terms: "PSXRecomp in:name,description,readme", clock: "pushed" },
  { id: "static-topic", terms: "topic:static-recompilation", clock: "pushed" },
  { id: "xenonrecomp", terms: "XenonRecomp in:name,description,readme", clock: "pushed" },
  { id: "psp-web-recomp", terms: '"PSP-Web-Recomp" in:name,description,readme', clock: "pushed" },
  { id: "gcrecomp", terms: "GCRecomp in:name,description,readme", clock: "pushed" },
  { id: "nwii-recomp", terms: "NWiiRecomp in:name,description,readme", clock: "pushed" },
  { id: "xbox-xbe-recomp", terms: "XboxXBERecomp in:name,description,readme", clock: "pushed" },
  { id: "rexglue-org", terms: "org:rexglue", clock: "pushed" },
  { id: "sp00nznet-owner", terms: "user:sp00nznet", clock: "pushed" },
  { id: "xbox-xbe-hyphen", terms: '"XboxXBE-Recomp" in:name,description,readme', clock: "pushed" },
  { id: "rexglue-topic", terms: "topic:rexglue", clock: "pushed" },
  { id: "xboxrecomp-topic", terms: "topic:xboxrecomp", clock: "pushed" },
  // Append after the published ecosystem entries so persisted numeric cursors retain meaning.
  {
    id: "changed-switch-recomp",
    terms: "switch recomp in:name,description",
    clock: "pushed",
    sort: "updated",
  },
  {
    id: "changed-switch-native",
    terms: '"Nintendo Switch" native in:name,description',
    clock: "pushed",
    sort: "updated",
  },
  {
    id: "changed-switch-framework",
    terms: "SwitchRecomp in:name,description,readme",
    clock: "pushed",
    sort: "updated",
  },
  {
    id: "changed-switch-topics",
    terms: "topic:nintendo-switch topic:static-recompilation",
    clock: "pushed",
    sort: "updated",
  },
] as const;

const words = (value: unknown): string[] => {
  const values = typeof value === "string" ? [value] : value;
  if (
    !Array.isArray(values) ||
    values.length > 64 ||
    values.some((v) => typeof v !== "string" || !v.trim() || v.length > 256)
  )
    throw new Error("Invalid upstream manifest text list");
  return values as string[];
};
export interface RecompManifest {
  game: string;
  systems: string[];
  types: string[];
  toolchains: string[];
  targets: string[];
  status?: string;
  original?: Record<string, string>[];
}
/** Reads the project's own draft v1 format, not recomp.board's restricted table.
 * Spec attribution: https://recomp.fyi/spec (CC BY 4.0). Optional omission is Unknown.
 * One manifest describes one game; .recomp-2..9 need separate reads.
 */
export function parseRecompManifest(value: unknown): RecompManifest {
  if (
    !isRecord(value) ||
    typeof value.game !== "string" ||
    !value.game.trim() ||
    value.game.length > 256
  )
    throw new Error("Manifest needs an explicit game identity");
  if (value.$schema !== undefined && value.$schema !== "https://recomp.fyi/schema/v1.json")
    throw new Error("Unsupported upstream manifest schema");
  const types = words(value.type);
  if (types.length === 0 || types.some((v) => !["recomp", "port", "decomp"].includes(v)))
    throw new Error("Unsupported upstream manifest architecture");
  if (
    value.status !== undefined &&
    (typeof value.status !== "string" ||
      !["exploring", "in-progress", "playable", "released", "complete", "paused"].includes(
        value.status,
      ))
  )
    throw new Error("Unsupported upstream manifest status");
  const systems = words(value.system);
  if (!systems.length) throw new Error("Manifest needs a source system");
  let original: Record<string, string>[] | undefined;
  if (value.original !== undefined) {
    const releases = Array.isArray(value.original) ? value.original : [value.original];
    if (!releases.length || releases.length > 64)
      throw new Error("Invalid manifest source releases");
    original = releases.map((release) => {
      if (!isRecord(release)) throw new Error("Invalid manifest source release");
      const result: Record<string, string> = {};
      for (const key of ["region", "revision", "serial", "sha1"]) {
        const v = release[key];
        if (v === undefined) continue;
        if (
          typeof v !== "string" ||
          !v.trim() ||
          v.length > 256 ||
          (key === "sha1" && !/^[a-fA-F0-9]{40}$/u.test(v))
        )
          throw new Error("Invalid manifest source requirement");
        result[key] = v;
      }
      return result;
    });
  }
  return {
    game: value.game,
    systems,
    types,
    toolchains: value.toolchain === undefined ? [] : words(value.toolchain),
    targets: value.targets === undefined ? [] : words(value.targets),
    ...(typeof value.status === "string" ? { status: value.status } : {}),
    ...(original ? { original } : {}),
  };
}

function xmlText(value: string) {
  return value.replace(
    /&(?:amp|lt|gt|quot|apos);/gu,
    (entity) =>
      ({ "&amp;": "&", "&lt;": "<", "&gt;": ">", "&quot;": '"', "&apos;": "'" })[entity] ?? entity,
  );
}
export interface RecompFeedLead {
  key: string;
  repository: string;
  title: string;
  updated: string;
  categories: string[];
  provenance: string;
  events: {
    id: string;
    title: string;
    updated: string;
    categories: string[];
    provenance: string;
  }[];
}
/** A bounded reader for the publisher's current Atom shape, never a table scraper.
 * Feed entries are leads. Missing entries never establish upstream deletion.
 */
export function parseRecompFeed(input: string): RecompFeedLead[] {
  if (
    Buffer.byteLength(input) > 2 * 1024 * 1024 ||
    /<!DOCTYPE|<!ENTITY/iu.test(input) ||
    !/<feed\s+xmlns="http:\/\/www\.w3\.org\/2005\/Atom"\s*>/u.test(input) ||
    !/<\/feed>\s*$/u.test(input)
  )
    throw new Error("Unsupported or incomplete recomp.board Atom feed");
  const opened = input.match(/<entry\b/gu) ?? [];
  if (opened.length > 500) throw new Error("Oversized recomp.board entry set");
  const entries = [...input.matchAll(/<entry>\s*([\s\S]*?)<\/entry>/gu)];
  if (!entries.length || entries.length > 500 || entries.length !== opened.length)
    throw new Error("Incomplete or oversized recomp.board entry set");
  const ids = new Set<string>();
  const records = new Map<string, RecompFeedLead>();
  for (const entry of entries) {
    const text = entry[1]!;
    const field = (tag: string) => {
      const matches = [...text.matchAll(new RegExp(`<${tag}>([^<]*)</${tag}>`, "gu"))];
      if (matches.length !== 1 || !matches[0]?.[1])
        throw new Error("Missing or duplicate Atom field");
      return xmlText(matches[0][1]);
    };
    const id = field("id"),
      title = field("title"),
      updated = field("updated");
    if (ids.has(id) || !/^tag:recomp\.fyi,/u.test(id) || !Number.isFinite(Date.parse(updated)))
      throw new Error("Invalid Atom identity or clock");
    ids.add(id);
    const links = [...text.matchAll(/<link\s+rel="related"\s+href="([^"]+)"\s*\/>/gu)];
    const url = links[0]?.[1];
    if (
      links.length !== 1 ||
      !url ||
      !/^https:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u.test(url)
    )
      throw new Error("Atom lead needs an exact upstream repository");
    const key = url.toLowerCase();
    const categories = [
      ...new Set(
        [...text.matchAll(/<category\s+term="([^"]+)"\s*\/>/gu)].map((m) => xmlText(m[1]!)),
      ),
    ].sort();
    const provenance = `https://recomp.fyi/#${id.replace(/^tag:recomp\.fyi,\d{4}:/u, "").replace(/:\d{4}-\d{2}-\d{2}$/u, "")}`;
    const record = {
      key,
      repository: key.slice(19),
      title,
      updated,
      categories,
      provenance,
      events: [{ id, title, updated, categories, provenance }],
    };
    const previous = records.get(key);
    if (!previous) records.set(key, record);
    else {
      const events = [...previous.events, ...record.events].sort((a, b) =>
        a.id.localeCompare(b.id),
      );
      // A shared repository can have several games/events on the same date.
      // Preserve all attribution and choose the displayed latest event stably.
      const latest = [...events].sort(
        (a, b) => Date.parse(b.updated) - Date.parse(a.updated) || a.id.localeCompare(b.id),
      )[0]!;
      records.set(key, {
        ...record,
        title: latest.title,
        updated: latest.updated,
        categories: latest.categories,
        provenance: latest.provenance,
        events,
      });
    }
  }
  return [...records.values()].sort((a, b) => a.key.localeCompare(b.key));
}

export interface EcosystemObservation {
  id: number;
  repository: string;
  created_at?: string;
  manifest?: RecompManifest;
  search_families?: string[];
}
const consoleName = (name: string) => {
  const key = name.toLowerCase().replace(/[^a-z0-9]/gu, "");
  return (
    (
      {
        playstation: "ps1",
        playstation1: "ps1",
        playstation2: "ps2",
        playstation3: "ps3",
        playstation4: "ps4",
        playstationportable: "psp",
        originalxbox: "xbox",
        xbox360: "xbox360",
        nintendogamecube: "gamecube",
        nintendowii: "wii",
        nintendowiiu: "wiiu",
      } as Record<string, string>
    )[key] ?? key
  );
};
/** >=3 distinct public repository IDs created in 14 days, with primary project manifests.
 * This asks for a focused sweep; it never admits, qualifies or publishes a port.
 */
export function ecosystemBursts(rows: readonly EcosystemObservation[], now: string) {
  const until = Date.parse(now);
  if (!Number.isFinite(until)) throw new Error("Invalid ecosystem observation clock");
  const groups = new Map<string, Map<number, string>>();
  for (const row of rows) {
    const at = Date.parse(row.created_at ?? "");
    if (
      !Number.isSafeInteger(row.id) ||
      row.id <= 0 ||
      !Number.isFinite(at) ||
      at > until ||
      until - at > 14 * 86400000
    )
      continue;
    const primary = row.manifest?.types.some((t) => t === "recomp" || t === "port");
    const keys = [
      ...(primary ? row.manifest!.systems.map((s) => `console:${consoleName(s)}`) : []),
      ...(primary
        ? row.manifest!.toolchains.map((s) => `framework:${s.trim().toLowerCase()}`)
        : []),
      ...(row.search_families ?? [])
        .filter((id) => ecosystemSearchFamilies.some((f) => f.id === id))
        .map((id) => `search-family:${id}`),
    ];
    for (const key of keys) {
      const group = groups.get(key) ?? new Map<number, string>();
      group.set(row.id, row.repository);
      groups.set(key, group);
    }
  }
  return [...groups]
    .filter(([, ids]) => ids.size >= 3)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([ecosystem, ids]) => ({
      ecosystem,
      repositories: [...ids].sort(([a], [b]) => a - b),
      threshold: 3,
      interval_days: 14,
      confidence: ecosystem.startsWith("search-family:")
        ? "unverified repository leads"
        : "primary project manifest claims",
      action:
        "Focused reconciliation required; validate architecture and identity before any intake",
    }));
}
