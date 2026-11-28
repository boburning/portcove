import { validArtworkMapping } from "./catalog-cover-mapping.mts";
import { isRecord } from "./runtime-values.mts";

const maxJournal = 256 * 1024;
const maxEntries = 256;
const sha = /^[a-f0-9]{64}$/u;
const commit = /^[a-f0-9]{40}$/u;
const subject = /^[a-z0-9]+(?:-[a-z0-9]+)*$/u;
export const digest = (value: unknown): value is string =>
  typeof value === "string" && sha.test(value);
export const fixedId = (value: unknown): value is string =>
  typeof value === "string" && value.length <= 128 && subject.test(value);
export const exact = (value: unknown, keys: string) =>
  isRecord(value) && Object.keys(value).sort().join(",") === keys;
export const bounded = (value: unknown, bound: number): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value > 0 && value <= bound;

export type Mapping = {
  game_id: number;
  game_slug: string;
  cover_id: number;
  image_id: string;
  image_sha256: string;
  match_kind: "underlying-game";
};
export function mapping(value: unknown): value is Mapping {
  return (
    validArtworkMapping(value) &&
    exact(value, "cover_id,game_id,game_slug,image_id,image_sha256,match_kind") &&
    value.match_kind === "underlying-game"
  );
}
export function replacement(prior: Mapping, candidate: Mapping) {
  return (
    prior.game_id === candidate.game_id &&
    prior.game_slug === candidate.game_slug &&
    prior.cover_id !== candidate.cover_id &&
    prior.image_id !== candidate.image_id &&
    prior.image_sha256 !== candidate.image_sha256
  );
}
export interface Approval {
  id: string;
  scope: string;
  authored: Mapping;
  prior: Mapping;
  role: "cover";
  candidate: Mapping;
  bytes: number;
  packet: string;
  source: string;
  run: string;
}
export interface ApprovedCoverJournal {
  format_version: 1;
  approvals: Approval[];
  consumed_packets: string[];
}
const empty: ApprovedCoverJournal = { format_version: 1, approvals: [], consumed_packets: [] };

export function readApprovedCoverJournal(raw: unknown): ApprovedCoverJournal {
  if (raw === undefined) return empty;
  if (
    !isRecord(raw) ||
    !exact(raw, "approvals,consumed_packets,format_version") ||
    raw.format_version !== 1 ||
    !Array.isArray(raw.approvals) ||
    !Array.isArray(raw.consumed_packets) ||
    raw.approvals.length > maxEntries ||
    raw.consumed_packets.length > maxEntries ||
    Buffer.byteLength(JSON.stringify(raw)) > maxJournal
  )
    throw new Error("Invalid signed cover replacement journal");
  const consumed = (raw.consumed_packets as unknown[]).filter(digest);
  const consumedSet = new Set(consumed);
  if (consumed.length !== raw.consumed_packets.length || consumed.length !== consumedSet.size)
    throw new Error("Invalid consumed cover replacement packets");
  const seen = new Set();
  for (const row of raw.approvals as unknown[]) {
    if (
      !isRecord(row) ||
      !exact(row, "authored,bytes,candidate,id,packet,prior,role,run,scope,source") ||
      !fixedId(row.id) ||
      seen.has(row.id) ||
      !digest(row.scope) ||
      !mapping(row.authored) ||
      !mapping(row.candidate) ||
      !mapping(row.prior) ||
      row.role !== "cover" ||
      !replacement(row.authored, row.candidate) ||
      !replacement(row.prior, row.candidate) ||
      !bounded(row.bytes, 16 * 1024 * 1024) ||
      !digest(row.packet) ||
      !consumedSet.has(row.packet) ||
      typeof row.source !== "string" ||
      !commit.test(row.source) ||
      typeof row.run !== "string" ||
      !/^[1-9][0-9]{0,15}$/u.test(row.run)
    )
      throw new Error("Invalid or duplicate signed cover replacement");
    seen.add(row.id);
  }
  return raw as unknown as ApprovedCoverJournal;
}
