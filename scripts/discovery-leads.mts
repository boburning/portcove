import { isRecord } from "./runtime-values.mts";
import { discoveryCheckpointBytes, investigationWindow } from "./discovery-checkpoint.mts";
import { ecosystemSearchFamilies, parseRecompManifest } from "./discovery-ecosystems.mts";
import type { RecompManifest } from "./discovery-ecosystems.mts";

// Collection cache only: provider identities and research continuations, never planning fields.
const families = [
  { id: "new-recompiled", terms: "recompiled in:name,description", clock: "created" },
  { id: "new-recomp", terms: "recomp in:name,description", clock: "created" },
  {
    id: "changed-recompilation",
    terms: "recompilation in:name,description",
    clock: "pushed",
  },
  { id: "changed-native-port", terms: '"native port" in:name,description', clock: "pushed" },
  ...ecosystemSearchFamilies,
] as const;
export const leadSearchFamilyCount = families.length;
export const leadFamilyIds: readonly string[] = families.map((family) => family.id);
export const advanceLeadFamily = (index: number) => (index + 1) % leadSearchFamilyCount;
export const leadPageSize = 50;
export interface LeadSlice {
  since: string;
  until: string;
  page: number;
  seen: number[];
  total?: number;
  completed_at?: string;
  capped?: true;
  remaining?: { since: string; until: string }[];
  window_until?: string;
  restart_reason?: string;
  terms?: string;
}
export interface DiscoveryLead {
  id: number;
  repository: string;
  url: string;
  description: string;
  revision: string;
  observed_at: string;
  evidence: string;
  status: "pending" | "researched" | "held" | "no-change" | "canonical";
  research?: { evidence_id: string; file: string; material: string };
  disposition?: { reason: string; resume: string };
  checked_at?: string;
  aliases?: string[];
  created_at?: string;
  manifest?: RecompManifest;
  search_families?: string[];
  release_hint?: { assets_observed: boolean; observed_at: string; evidence: string };
}
export interface LeadState {
  format: 1;
  next_family: number;
  slices: Record<string, LeadSlice>;
  records: Record<string, DiscoveryLead>;
  retired_slices?: Record<string, LeadSlice>;
}
function boundLeadState<T>(value: T): T {
  if (Buffer.byteLength(JSON.stringify(value)) > discoveryCheckpointBytes)
    throw new Error("Retained lead byte envelope exceeded; preserve prior continuation");
  return value;
}
const clock = (v: unknown): v is string => typeof v === "string" && Number.isFinite(Date.parse(v));
export function parseLeadState(value: unknown): LeadState {
  if (value === undefined) return { format: 1, next_family: 0, slices: {}, records: {} };
  if (
    !isRecord(value) ||
    value.format !== 1 ||
    Buffer.byteLength(JSON.stringify(value)) > discoveryCheckpointBytes ||
    !isRecord(value.slices) ||
    !isRecord(value.records) ||
    !Number.isSafeInteger(value.next_family) ||
    Number(value.next_family) < 0 ||
    Number(value.next_family) >= families.length
  )
    throw new Error("Invalid retained lead collection state");
  if (value.retired_slices !== undefined && !isRecord(value.retired_slices))
    throw new Error("Invalid retired lead slices");
  for (const [id, raw] of [
    ...Object.entries(value.slices),
    ...Object.entries(value.retired_slices ?? {}),
  ]) {
    if (
      !families.some((f) => f.id === id) ||
      !isRecord(raw) ||
      !clock(raw.since) ||
      !clock(raw.until) ||
      Date.parse(raw.since) > Date.parse(raw.until) ||
      !Number.isSafeInteger(raw.page) ||
      Number(raw.page) < 1 ||
      Number(raw.page) > 21 ||
      !Array.isArray(raw.seen) ||
      !raw.seen.every((n) => Number.isSafeInteger(n) && Number(n) > 0) ||
      new Set(raw.seen).size !== raw.seen.length ||
      (raw.completed_at !== undefined && !clock(raw.completed_at)) ||
      (raw.capped !== undefined && raw.capped !== true) ||
      (raw.remaining !== undefined &&
        (!Array.isArray(raw.remaining) ||
          raw.remaining.length > 64 ||
          !raw.remaining.every(
            (r) => isRecord(r) && clock(r.since) && clock(r.until) && r.since <= r.until,
          ))) ||
      (raw.window_until !== undefined && !clock(raw.window_until)) ||
      (raw.restart_reason !== undefined && typeof raw.restart_reason !== "string") ||
      (raw.terms !== undefined && typeof raw.terms !== "string") ||
      (raw.total !== undefined && (!Number.isSafeInteger(raw.total) || Number(raw.total) < 0))
    )
      throw new Error("Invalid retained lead search slice");
  }
  for (const [id, raw] of Object.entries(value.records)) {
    if (
      !isRecord(raw) ||
      !Number.isSafeInteger(raw.id) ||
      Number(raw.id) <= 0 ||
      id !== String(raw.id) ||
      typeof raw.repository !== "string" ||
      !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u.test(raw.repository) ||
      raw.url !== `https://github.com/${raw.repository}` ||
      typeof raw.description !== "string" ||
      !clock(raw.observed_at) ||
      typeof raw.evidence !== "string" ||
      typeof raw.revision !== "string" ||
      !["pending", "researched", "held", "no-change", "canonical"].includes(String(raw.status))
    )
      throw new Error("Invalid retained lead identity");
    if (raw.created_at !== undefined && !clock(raw.created_at))
      throw new Error("Invalid retained repository creation clock");
    if (
      raw.search_families !== undefined &&
      (!Array.isArray(raw.search_families) ||
        raw.search_families.length > families.length ||
        !raw.search_families.every((id) => families.some((family) => family.id === id)))
    )
      throw new Error("Invalid retained ecosystem search families");
    if (
      raw.aliases !== undefined &&
      (!Array.isArray(raw.aliases) ||
        raw.aliases.length > 64 ||
        !raw.aliases.every(
          (a) => typeof a === "string" && /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u.test(a),
        ))
    )
      throw new Error("Invalid retained repository aliases");
    if (raw.manifest !== undefined) {
      if (!isRecord(raw.manifest)) throw new Error("Invalid retained primary manifest");
      const manifest = raw.manifest;
      if (
        !["systems", "types", "toolchains", "targets"].every((key) => Array.isArray(manifest[key]))
      )
        throw new Error("Retained primary manifest requires normalized lists");
      if (raw.manifest.original !== undefined && !Array.isArray(raw.manifest.original))
        throw new Error("Retained primary manifest requires normalized source releases");
      parseRecompManifest({
        ...raw.manifest,
        system: raw.manifest.systems,
        type: raw.manifest.types,
        toolchain: raw.manifest.toolchains,
      });
    }
    if (
      raw.research !== undefined &&
      (!isRecord(raw.research) ||
        typeof raw.research.evidence_id !== "string" ||
        typeof raw.research.file !== "string" ||
        typeof raw.research.material !== "string")
    )
      throw new Error("Invalid retained lead research");
    if (
      raw.disposition !== undefined &&
      (!isRecord(raw.disposition) ||
        typeof raw.disposition.reason !== "string" ||
        typeof raw.disposition.resume !== "string")
    )
      throw new Error("Invalid retained lead disposition");
    if (raw.checked_at !== undefined && !clock(raw.checked_at))
      throw new Error("Invalid lead research clock");
    if (
      raw.release_hint !== undefined &&
      (!isRecord(raw.release_hint) ||
        typeof raw.release_hint.assets_observed !== "boolean" ||
        !clock(raw.release_hint.observed_at) ||
        typeof raw.release_hint.evidence !== "string")
    )
      throw new Error("Invalid lead release hint");
  }
  return structuredClone(value) as unknown as LeadState;
}
export class LeadSearchChanged extends Error {}
export function restartLeadSlice(
  state: LeadState,
  plan: ReturnType<typeof nextLeadPage>,
  reason: string,
) {
  const next = structuredClone(state);
  if (plan.retired)
    next.retired_slices = {
      ...next.retired_slices,
      [plan.family]: structuredClone(state.slices[plan.family]!),
    };
  next.slices[plan.family] = { ...plan.slice, page: 1, seen: [], restart_reason: reason };
  delete next.slices[plan.family]!.total;
  return boundLeadState(next);
}
export function retainLeadResults(
  state: LeadState,
  rows: unknown[],
  observedAt: string,
  evidence: string,
  family?: string,
): LeadState {
  if (family !== undefined && !families.some((v) => v.id === family))
    throw new Error("Unknown discovery search family");
  const next = structuredClone(state);
  const ids = new Set<number>();
  const paths = new Map<string, number>();
  for (const lead of Object.values(next.records)) {
    const key = lead.repository.toLowerCase();
    if (paths.has(key) && paths.get(key) !== lead.id)
      throw new Error("Lead repository identity changed");
    paths.set(key, lead.id);
  }
  for (const raw of rows) {
    if (
      !isRecord(raw) ||
      !Number.isSafeInteger(raw.id) ||
      Number(raw.id) <= 0 ||
      typeof raw.full_name !== "string" ||
      !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u.test(raw.full_name) ||
      raw.html_url !== `https://github.com/${raw.full_name}` ||
      ids.has(Number(raw.id))
    )
      throw new Error("Duplicate or malformed lead identity; retain prior continuation");
    if (raw.created_at !== undefined && !clock(raw.created_at))
      throw new Error("Invalid provider repository creation clock");
    const id = Number(raw.id);
    const repository = raw.full_name;
    ids.add(id);
    const old = next.records[String(id)];
    // GitHub's immutable numeric identity binds transfers and renames. Requeue the
    // primary review while keeping one lead and its dated historical locations.
    const relocated = old && old.repository !== raw.full_name;
    const path = repository.toLowerCase(),
      previousId = paths.get(path);
    if (previousId !== undefined && previousId !== id)
      throw new Error("Lead repository identity changed");
    if (relocated) paths.delete(old.repository.toLowerCase());
    paths.set(path, id);
    const revision = `${typeof raw.pushed_at === "string" ? raw.pushed_at : "unknown"}:${typeof raw.description === "string" ? raw.description : ""}`;
    const due =
      old?.checked_at && Date.parse(observedAt) - Date.parse(old.checked_at) >= 7 * 86400000;
    next.records[String(id)] =
      old?.revision === revision && !due && !relocated
        ? old
        : {
            id,
            repository: raw.full_name,
            url: String(raw.html_url),
            description: typeof raw.description === "string" ? raw.description : "",
            revision,
            observed_at: observedAt,
            evidence,
            status: "pending",
            ...(typeof raw.created_at === "string" && clock(raw.created_at)
              ? { created_at: raw.created_at }
              : {}),
            ...(old?.aliases || relocated
              ? {
                  aliases: [
                    ...new Set([...(old?.aliases ?? []), ...(relocated ? [old.repository] : [])]),
                  ].slice(-64),
                }
              : {}),
            ...(old?.search_families ? { search_families: old.search_families } : {}),
          };
    if (family)
      next.records[String(id)]!.search_families = [
        ...new Set([...(next.records[String(id)]!.search_families ?? []), family]),
      ];
  }
  return boundLeadState(next);
}
export function nextLeadPage(state: LeadState, now: string) {
  if (!clock(now)) throw new Error("Invalid lead search clock");
  const family = families[state.next_family]!;
  const includeForks = ecosystemSearchFamilies.some((f) => f.id === family.id);
  // Keep the original four contracts stable; new ecosystem cursors bind fork coverage.
  const sort = "sort" in family ? family.sort : undefined;
  const contract = `${family.terms} [${sort ? `${sort} desc` : "best-match"}]${includeForks ? " [fork:true]" : ""}`;
  const saved = state.slices[family.id];
  const retired = saved !== undefined && saved.terms !== contract;
  const previous = retired ? undefined : saved;
  const slice =
    previous && !previous.completed_at
      ? previous
      : {
          ...investigationWindow(previous?.completed_at, now),
          page: 1,
          seen: [],
          terms: contract,
        };
  return {
    family: family.id,
    slice,
    query: `${family.terms} ${family.clock}:${slice.since}..${slice.until} fork:${includeForks}`,
    sort,
    page: slice.page,
    capped: slice.capped === true,
    current: previous?.completed_at === now,
    retired,
  };
}
export function acceptLeadPage(
  state: LeadState,
  plan: ReturnType<typeof nextLeadPage>,
  response: unknown,
  observedAt: string,
  evidence: string,
): LeadState {
  if (
    !clock(observedAt) ||
    !isRecord(response) ||
    response.incomplete_results !== false ||
    !Number.isSafeInteger(response.total_count) ||
    Number(response.total_count) < 0 ||
    !Array.isArray(response.items) ||
    response.items.length > leadPageSize ||
    plan.capped
  )
    throw new Error("Incomplete or malformed lead search page; retain prior continuation");
  const total = Number(response.total_count);
  const slice = structuredClone(plan.slice);
  const next = retainLeadResults(state, response.items, observedAt, evidence, plan.family);
  if (slice.total !== undefined && slice.total !== total)
    throw new LeadSearchChanged("Lead search count changed; retain prior continuation");
  if (plan.retired)
    next.retired_slices = {
      ...next.retired_slices,
      [plan.family]: structuredClone(state.slices[plan.family]!),
    };
  const ids = new Set(slice.seen);
  for (const raw of response.items as unknown[]) {
    if (
      !isRecord(raw) ||
      !Number.isSafeInteger(raw.id) ||
      Number(raw.id) <= 0 ||
      typeof raw.full_name !== "string" ||
      !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u.test(raw.full_name) ||
      raw.html_url !== `https://github.com/${raw.full_name}`
    )
      throw new Error("Duplicate or malformed lead identity; retain prior continuation");
    if (ids.has(Number(raw.id)))
      throw new LeadSearchChanged("Lead search membership moved across pages");
    const id = Number(raw.id);
    ids.add(id);
  }
  const expected = Math.min(
    leadPageSize,
    Math.max(0, Math.min(total, 1000) - (plan.page - 1) * leadPageSize),
  );
  if (response.items.length !== expected)
    throw new LeadSearchChanged("Lead search page coverage changed");
  slice.seen = [...ids];
  slice.total = total;
  slice.page++;
  if (total > 1000) {
    const mid = Math.floor((Date.parse(slice.since) + Date.parse(slice.until)) / 2);
    if (mid <= Date.parse(slice.since) || (slice.remaining?.length ?? 0) >= 63) slice.capped = true;
    else {
      slice.remaining = [
        { since: new Date(mid + 1).toISOString(), until: slice.until },
        ...(slice.remaining ?? []),
      ];
      slice.window_until ??= slice.until;
      slice.until = new Date(mid).toISOString();
      slice.page = 1;
      slice.seen = [];
      delete slice.total;
    }
  } else if (ids.size === total) {
    const tail = slice.remaining?.shift();
    if (tail) {
      slice.since = tail.since;
      slice.until = tail.until;
      slice.page = 1;
      slice.seen = [];
      delete slice.total;
    } else slice.completed_at = slice.window_until ?? slice.until;
  }
  next.slices[plan.family] = slice;
  next.next_family = advanceLeadFamily(state.next_family);
  return boundLeadState(next);
}
export function pendingLeads(
  state: LeadState,
  known: ReadonlySet<string> = new Set(),
  now = Date.now(),
) {
  const hint = (r: DiscoveryLead) =>
    /tooling|framework|games.list|experimental/iu.test(r.description) ? 1 : 0;
  const gameSignal = (r: DiscoveryLead) => {
    if (/\b(?:tooling|tools?|framework|libraries|curated|list|sdk)\b/iu.test(r.description))
      return 0;
    return /\b(?:games?|xbox|playstation|nintendo|wii|n64|gamecube|dreamcast|native pc port)\b/iu.test(
      r.description,
    ) || /recomp|decomp/iu.test(r.repository.split("/")[1] ?? "")
      ? 1
      : 0;
  };
  return Object.values(state.records)
    .filter(
      (r) =>
        (["pending", "researched"].includes(r.status) ||
          (r.checked_at && now - Date.parse(r.checked_at) >= 7 * 86400000)) &&
        !known.has(r.url.toLowerCase()),
    )
    .sort(
      (a, b) =>
        gameSignal(b) - gameSignal(a) ||
        Number(b.release_hint?.assets_observed ?? false) -
          Number(a.release_hint?.assets_observed ?? false) ||
        hint(a) - hint(b) ||
        a.observed_at.localeCompare(b.observed_at) ||
        a.id - b.id,
    );
}
