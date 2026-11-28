import { discoveryNextPage } from "./discovery-primary-progress.mts";
import type { DiscoveryMetadataResponse } from "./discovery-primary-progress.mts";
import { isRecord } from "./runtime-values.mts";

/** Explicit framework roots already covered by the N64 ecosystem search contract. */
export const frameworkForkNetworks = [
  { key: "n64recomp", repositoryId: 566578350 },
  { key: "libultraship", repositoryId: 561153676 },
] as const;

type FrameworkForkNetwork = (typeof frameworkForkNetworks)[number];
export type FrameworkForkNetworkKey = FrameworkForkNetwork["key"];

export interface FrameworkForkProgress {
  repository_id: number;
  attempted_at: string;
  turn: number;
  conflicts?: Record<string, { repository: string; retained_id: number }>;
  next_page: number | null;
  advanced_at?: string;
  seen: number[];
  completed_at?: string;
}

export function frameworkForkRequest(repositoryId: number, page = 1) {
  return `repositories/${repositoryId}/forks?sort=oldest&per_page=100&page=${page}`;
}

const clock = (value: unknown) => typeof value === "string" && Number.isFinite(Date.parse(value));
const positiveInt = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value > 0;

export function isFrameworkForkNetworkKey(value: unknown): value is FrameworkForkNetworkKey {
  return frameworkForkNetworks.some((network) => network.key === value);
}

export function validateFrameworkForkProgress(value: unknown) {
  if (value === undefined) return;
  if (!isRecord(value)) throw new Error("Invalid framework fork checkpoint");
  for (const [key, raw] of Object.entries(value)) {
    if (
      !isFrameworkForkNetworkKey(key) ||
      !isRecord(raw) ||
      !Number.isSafeInteger(raw.repository_id) ||
      Number(raw.repository_id) <= 0 ||
      !clock(raw.attempted_at) ||
      !positiveInt(raw.turn) ||
      (raw.conflicts !== undefined &&
        (!isRecord(raw.conflicts) ||
          Object.entries(raw.conflicts).some(
            ([id, row]) =>
              !/^[1-9]\d*$/u.test(id) ||
              !positiveInt(Number(id)) ||
              !isRecord(row) ||
              typeof row.repository !== "string" ||
              !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u.test(row.repository) ||
              !positiveInt(row.retained_id) ||
              row.retained_id === Number(id),
          ))) ||
      (raw.next_page !== null &&
        (!positiveInt(raw.next_page) || raw.next_page < 2 || !clock(raw.advanced_at))) ||
      !Array.isArray(raw.seen) ||
      new Set(raw.seen).size !== raw.seen.length ||
      raw.seen.some((id: unknown) => !Number.isSafeInteger(id) || Number(id) <= 0) ||
      (raw.completed_at !== undefined && (!clock(raw.completed_at) || raw.next_page !== null)) ||
      (raw.next_page === null && raw.seen.length > 0 && raw.completed_at === undefined)
    ) {
      throw new Error("Invalid framework fork checkpoint");
    }
  }
}

export class FrameworkForkPaginationChanged extends Error {}

export function parseFrameworkForkPage(
  network: FrameworkForkNetwork,
  response: Pick<DiscoveryMetadataResponse, "data" | "headers">,
  previous: FrameworkForkProgress | undefined,
) {
  if (previous && previous.repository_id !== network.repositoryId) {
    throw new Error("Framework fork continuation belongs to another repository");
  }
  if (!Array.isArray(response.data) || response.data.length > 100) {
    throw new Error("Malformed framework fork collection");
  }
  const page = previous?.next_page ?? 1;
  const first = frameworkForkRequest(network.repositoryId);
  const next = discoveryNextPage(
    response,
    first,
    frameworkForkRequest(network.repositoryId, page),
    undefined,
    ["sort"],
  );
  if (next && response.data.length === 0) {
    throw new FrameworkForkPaginationChanged("Framework fork page did not advance");
  }
  const previousIds = new Set(previous?.next_page ? previous.seen : []);
  const seen = new Set(previousIds);
  const paths = new Set<string>();
  const rows = response.data.map((row: unknown) => {
    const id = isRecord(row) ? row.id : undefined;
    if (positiveInt(id) && previousIds.has(id)) {
      throw new FrameworkForkPaginationChanged("Fork membership shifted during pagination");
    }
    if (
      !isRecord(row) ||
      !positiveInt(id) ||
      id === network.repositoryId ||
      seen.has(id) ||
      row.private !== false ||
      row.fork !== true ||
      typeof row.full_name !== "string" ||
      !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u.test(row.full_name) ||
      paths.has(row.full_name.toLowerCase()) ||
      row.html_url !== `https://github.com/${row.full_name}` ||
      (row.description !== null && typeof row.description !== "string") ||
      !clock(row.created_at) ||
      (row.pushed_at !== null && !clock(row.pushed_at))
    ) {
      throw new Error("Duplicate or malformed public framework fork");
    }
    seen.add(id);
    paths.add(row.full_name.toLowerCase());
    return {
      id,
      full_name: row.full_name,
      html_url: row.html_url,
      description: row.description,
      pushed_at: row.pushed_at,
      created_at: row.created_at,
    };
  });
  return { rows, seen: [...seen], next_page: next ? page + 1 : null };
}
