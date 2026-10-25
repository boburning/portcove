import { isRecord } from "./runtime-values.mts";
import { investigationWindow } from "./discovery-checkpoint.mts";

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
    terms: "SwitchRecomp in:name,description",
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
export const leadFamilyIds: readonly string[] = families.map((family) => family.id);
export const leadFamilyCount = families.length;
export const advanceLeadFamily = (index: number) => (index + 1) % leadFamilyCount;
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
  release_hint?: { assets_observed: boolean; observed_at: string; evidence: string };
}
export interface LeadState {
  format: 1;
  next_family: number;
  slices: Record<string, LeadSlice>;
  records: Record<string, DiscoveryLead>;
  retired_slices?: Record<string, LeadSlice>;
}
const clock = (v: unknown): v is string => typeof v === "string" && Number.isFinite(Date.parse(v));
export function parseLeadState(value: unknown): LeadState {
  if (value === undefined) return { format: 1, next_family: 0, slices: {}, records: {} };
  if (
    !isRecord(value) ||
    value.format !== 1 ||
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
  if (Object.keys(value.records).length > 10000) throw new Error("Retained lead capacity exceeded");
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
  return next;
}
export function retainLeadResults(
  state: LeadState,
  rows: unknown[],
  observedAt: string,
  evidence: string,
): LeadState {
  const next = structuredClone(state);
  const ids = new Set<number>();
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
    const id = Number(raw.id);
    const repository = raw.full_name;
    ids.add(id);
    const old = next.records[String(id)];
    if (old && old.repository.toLowerCase() !== raw.full_name.toLowerCase())
      throw new Error("Lead repository relocation needs continuity review");
    if (
      Object.values(next.records).some(
        (r) => r.repository.toLowerCase() === repository.toLowerCase() && r.id !== id,
      )
    )
      throw new Error("Lead repository identity changed");
    const revision = `${typeof raw.pushed_at === "string" ? raw.pushed_at : "unknown"}:${typeof raw.description === "string" ? raw.description : ""}`;
    const due =
      old?.checked_at && Date.parse(observedAt) - Date.parse(old.checked_at) >= 7 * 86400000;
    next.records[String(id)] =
      old?.revision === revision && !due
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
          };
  }
  if (Object.keys(next.records).length > 10000) throw new Error("Retained lead capacity exceeded");
  return next;
}
export function nextLeadPage(state: LeadState, now: string) {
  if (!clock(now)) throw new Error("Invalid lead search clock");
  const family = families[state.next_family]!;
  const sort = "sort" in family ? family.sort : undefined;
  const contract = `${family.terms} [${sort ? `${sort} desc` : "best-match"}]`;
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
    query: `${family.terms} ${family.clock}:${slice.since}..${slice.until} fork:false`,
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
  const next = retainLeadResults(state, response.items, observedAt, evidence);
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
  if (Object.keys(next.records).length > 10000) throw new Error("Retained lead capacity exceeded");
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
  return next;
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
