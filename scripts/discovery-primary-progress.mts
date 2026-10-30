import { discoveryCheckpointBytes } from "./discovery-checkpoint.mts";
import { GitHubApiError, nextLink } from "./github-api.mts";
import type { GitHubApiClient, IncludedResponse } from "./github-api.mts";
import { observationHash } from "./upstream-observer.mts";
import { isRecord } from "./runtime-values.mts";

export interface DiscoveryPrimaryProgress {
  entries: Record<string, unknown>;
  persist: () => void;
  now?: () => number;
}
export class DiscoveryCheckpointInterrupted extends Error {}
interface Read {
  endpoint: string;
  body: unknown;
  status: 200 | 404;
  link: string | null;
  etag: string | null;
  sha256: string;
  observed_at: string;
}
interface Progress {
  format: 1;
  repository: string;
  repository_id: number;
  reads: Read[];
  validation_cursor: number;
}
const maximumBytes = discoveryCheckpointBytes;
const freshnessMs = 12 * 3600000;
const digest = (read: Pick<Read, "endpoint" | "body" | "link" | "status">) =>
  observationHash({
    endpoint: read.endpoint,
    body: read.body,
    link: read.link,
    status: read.status,
  });

/** Exact read positions in the existing discovery operation journal, never mutation authority. */
export class DiscoveryPrimaryReads {
  private cursor = 0;
  private readonly key: string;
  private readonly state: Progress;
  private readonly resumed: boolean;
  private readonly started: number;
  private readonly api: GitHubApiClient;
  private readonly journal: DiscoveryPrimaryProgress;
  constructor(
    api: GitHubApiClient,
    repository: string,
    repositoryId: number,
    journal: DiscoveryPrimaryProgress,
  ) {
    this.api = api;
    this.journal = journal;
    this.started = (journal.now ?? Date.now)();
    this.key = repository.toLowerCase();
    const previous = journal.entries[this.key];
    this.resumed = previous !== undefined;
    if (previous !== undefined) {
      if (
        !isRecord(previous) ||
        previous.format !== 1 ||
        previous.repository !== repository ||
        previous.repository_id !== repositoryId ||
        !Array.isArray(previous.reads) ||
        !Number.isSafeInteger(previous.validation_cursor) ||
        Number(previous.validation_cursor) < 0 ||
        Number(previous.validation_cursor) > previous.reads.length
      )
        throw new Error(
          "Research continuation repository identity or shape changed; preserve for reconciliation",
        );
      for (const item of previous.reads) {
        if (
          !isRecord(item) ||
          typeof item.endpoint !== "string" ||
          ![200, 404].includes(Number(item.status)) ||
          (item.status === 404 && !/\/contents\/\.recomp\.json\?ref=/u.test(item.endpoint)) ||
          !item.endpoint.startsWith(`repos/${repository}/`) ||
          !(item.link === null || typeof item.link === "string") ||
          !(
            item.etag === null ||
            (typeof item.etag === "string" && item.etag.length <= 512 && !/[\r\n]/u.test(item.etag))
          ) ||
          typeof item.observed_at !== "string" ||
          !Number.isFinite(Date.parse(item.observed_at)) ||
          Date.parse(item.observed_at) > this.started ||
          item.sha256 !== digest(item as unknown as Read)
        )
          throw new Error("Research continuation contains corrupt or foreign read evidence");
      }
      this.state = previous as unknown as Progress;
    } else
      this.state = {
        format: 1,
        repository,
        repository_id: repositoryId,
        reads: [],
        validation_cursor: 0,
      };
    journal.entries[this.key] = this.state;
    this.persist();
  }
  private persist() {
    if (Buffer.byteLength(JSON.stringify(this.journal.entries)) > maximumBytes)
      throw new Error("Research continuation exceeds the bounded journal byte envelope");
    try {
      this.journal.persist();
    } catch (error) {
      throw new DiscoveryCheckpointInterrupted(
        "Research checkpoint interrupted; preserve accepted reads",
        { cause: error },
      );
    }
  }
  private read(endpoint: string, etag?: string): IncludedResponse {
    try {
      return this.api.request("GET", endpoint, null, etag ? { "If-None-Match": etag } : {});
    } catch (error) {
      if (
        error instanceof GitHubApiError &&
        error.status === 404 &&
        /\/contents\/\.recomp\.json\?ref=/u.test(endpoint)
      )
        return { status: 404, body: null, headers: new Map() };
      throw error;
    }
  }
  request(endpoint: string): IncludedResponse {
    if (!endpoint.startsWith(`repos/${this.state.repository}/`) || endpoint.length > 2048)
      throw new Error("Research request escaped its bound repository");
    let read = this.state.reads[this.cursor];
    if (read && read.endpoint !== endpoint)
      throw new Error("Research continuation read order changed; reconcile before reuse");
    if (!read) {
      const response = this.read(endpoint);
      if (response.status !== undefined && response.status !== 200 && response.status !== 404)
        throw new Error("Research collection requires a complete successful response");
      const value: Pick<Read, "endpoint" | "body" | "status" | "link"> = {
        endpoint,
        body: structuredClone(response.body),
        status: response.status === 404 ? 404 : 200,
        link: response.headers.get("link") ?? null,
      };
      read = {
        ...value,
        etag:
          (response.headers.get("etag")?.length ?? 0) <= 512
            ? (response.headers.get("etag") ?? null)
            : null,
        sha256: digest(value),
        observed_at: new Date((this.journal.now ?? Date.now)()).toISOString(),
      };
      const candidate = { ...this.state, reads: [...this.state.reads, read] };
      if (
        Buffer.byteLength(JSON.stringify({ ...this.journal.entries, [this.key]: candidate })) >
        maximumBytes
      )
        throw new Error("Research continuation exceeds the bounded journal byte envelope");
      this.state.reads.push(read);
      this.persist();
    }
    this.cursor += 1;
    if (read.status === 404)
      throw new GitHubApiError("http_error", "Optional primary manifest is absent", {
        status: 404,
      });
    const headers = new Map<string, string>();
    if (read.link) headers.set("link", read.link);
    if (read.etag) headers.set("etag", read.etag);
    return { status: 200, body: structuredClone(read.body), headers };
  }
  finish() {
    if (this.cursor !== this.state.reads.length)
      throw new Error("Research continuation retained an unmatched read tail");
    // Fresh uninterrupted reads keep their ordinary cost. Resumed mutable facts
    // receive a durable complete validation pass before becoming research evidence.
    if (this.resumed)
      while (this.state.validation_cursor < this.state.reads.length) {
        const read = this.state.reads[this.state.validation_cursor]!;
        const response = this.read(read.endpoint, read.etag ?? undefined);
        if (
          response.status !== 304 &&
          ((response.status !== undefined && response.status !== read.status) ||
            digest({
              status: response.status === 404 ? 404 : 200,
              endpoint: read.endpoint,
              body: response.body,
              link: response.headers.get("link") ?? null,
            }) !== read.sha256)
        ) {
          this.discard();
          throw new Error(
            "Primary facts changed during research continuation; restart the exact collection",
          );
        }
        read.observed_at = new Date((this.journal.now ?? Date.now)()).toISOString();
        this.state.validation_cursor += 1;
        this.persist();
      }
    const oldest =
      this.state.reads.map((read) => read.observed_at).toSorted()[0] ??
      new Date(this.started).toISOString();
    if ((this.journal.now ?? Date.now)() - Date.parse(oldest) >= freshnessMs) {
      this.state.validation_cursor = this.state.reads.findIndex(
        (read) => (this.journal.now ?? Date.now)() - Date.parse(read.observed_at) >= freshnessMs,
      );
      this.persist();
      throw new GitHubApiError(
        "budget_exhausted",
        "Research validation freshness expired; resume conditional validation",
      );
    }
    return oldest;
  }
  discard() {
    delete this.journal.entries[this.key];
    this.journal.persist();
  }
}

/** Provider links may change only their sequential page within the exact collection. */
export function discoveryNextPage(
  response: IncludedResponse,
  first: string,
  current: string,
  repositoryId?: number,
) {
  const raw = response.headers.get("link");
  if (raw) {
    const links = [...raw.matchAll(/<([^>]+)>;\s*rel="([^"]+)"/gu)];
    if (
      !links.length ||
      links.filter((match) => (match[2] ?? "").split(/\s+/u).includes("next")).length > 1
    )
      throw new Error("Research pagination has malformed or ambiguous continuation");
  }
  const next = nextLink(response.headers);
  if (!next) return null;
  const base = new URL(first, "https://api.github.com/");
  const last = new URL(current, "https://api.github.com/");
  const candidate = new URL(next, "https://api.github.com/");
  const collection = /^\/repos\/[^/]+\/[^/]+\/(releases(?:\/[1-9]\d*\/assets)?)$/u.exec(
    base.pathname,
  )?.[1];
  // GitHub emits immutable numeric repository routes in Link headers even when
  // the request used owner/name. Accept only the primary metadata's exact ID
  // and this exact collection; keep journal requests on their original route.
  const boundAlias =
    collection !== undefined &&
    Number.isSafeInteger(repositoryId) &&
    Number(repositoryId) > 0 &&
    candidate.pathname === `/repositories/${repositoryId}/${collection}`;
  const page = candidate.searchParams.get("page");
  if (
    candidate.origin !== base.origin ||
    (candidate.pathname !== base.pathname && !boundAlias) ||
    candidate.username ||
    candidate.password ||
    candidate.hash ||
    candidate.searchParams.getAll("page").length !== 1 ||
    candidate.searchParams.getAll("per_page").length !== 1 ||
    candidate.searchParams.get("per_page") !== base.searchParams.get("per_page") ||
    [...candidate.searchParams.keys()].some((key) => !["page", "per_page"].includes(key)) ||
    !page ||
    !/^[1-9]\d*$/u.test(page) ||
    !Number.isSafeInteger(Number(page)) ||
    Number(page) !== Number(last.searchParams.get("page") ?? 1) + 1
  )
    throw new Error("Research pagination escaped or failed to advance its exact collection");
  return base.pathname.slice(1) + candidate.search;
}
