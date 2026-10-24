import { createHash } from "node:crypto";
import { GitHubApiClient, nextLink } from "./github-api.mts";
import type { IncludedResponse } from "./github-api.mts";
import { isRecord } from "./runtime-values.mts";

const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const version = { "X-GitHub-Api-Version": "2026-03-10" };
/** Cache entries are usable only after a fresh authorized 304, never as offline evidence. */
export class RestInventoryTransport {
  private cache = new Map<string, { response: IncludedResponse; digest: string; etag: string }>();
  readonly api: GitHubApiClient;
  constructor(api: GitHubApiClient) {
    this.api = api;
  }

  get(endpoint: string): IncludedResponse {
    const old = this.cache.get(endpoint);
    // Refresh terminal pages unconditionally: a newly appended page can change Link
    // without changing the preceding page's representation/ETag.
    const conditional = old && nextLink(old.response.headers) !== null;
    let response = this.api.request("GET", endpoint, null, {
      ...version,
      ...(conditional ? { "If-None-Match": old.etag } : {}),
    });
    if (response.status === 304) {
      if (!old || !conditional || hash(old.response.body) !== old.digest)
        throw new Error("REST 304 has no unchanged authenticated page preimage");
      if (!response.headers.has("link")) {
        response = this.api.request("GET", endpoint, null, version);
      } else {
        response = { ...response, body: old.response.body };
      }
    }
    if (response.status !== 200 && response.status !== 304)
      throw new Error("REST inventory did not return a complete representation");
    const etag = response.headers.get("etag") ?? (response.status === 304 ? old?.etag : undefined);
    if (etag) this.cache.set(endpoint, { response, digest: hash(response.body), etag });
    else this.cache.delete(endpoint);
    return response;
  }

  write(method: "POST" | "PATCH", endpoint: string, body: unknown) {
    return this.api.request(method, endpoint, body, version);
  }

  pages(endpoint: string, allowedPaths: readonly string[]) {
    const rows: Record<string, unknown>[] = [];
    const identities = new Set<string>();
    const visited = new Set<string>();
    const initial = new URL(endpoint, "https://api.github.com/");
    const pages: { endpoint_sha256: string; count: number; terminal: boolean }[] = [];
    const started = Date.now();
    let current: string | null = endpoint;
    while (current !== null) {
      if (Date.now() - started > 120_000)
        throw new Error("REST inventory exceeded its finite collection budget");
      const url = new URL(current, "https://api.github.com/");
      url.searchParams.sort();
      if (
        url.origin !== "https://api.github.com" ||
        !allowedPaths.includes(url.pathname) ||
        visited.has(url.href)
      )
        throw new Error("REST inventory pagination changed identity or repeated a cursor");
      const keys = [...url.searchParams.keys()];
      if (
        url.username ||
        url.password ||
        url.hash ||
        new Set(keys).size !== keys.length ||
        keys.some(
          (key) => !initial.searchParams.has(key) && !["page", "after", "before"].includes(key),
        ) ||
        url.searchParams.has("before") ||
        (url.searchParams.has("after") && !url.searchParams.get("after")) ||
        (url.searchParams.has("page") && !/^[1-9][0-9]*$/u.test(url.searchParams.get("page") ?? ""))
      )
        throw new Error("REST inventory pagination added an unreviewed query or cursor");
      for (const [key, value] of initial.searchParams) {
        if (!["page", "after", "before"].includes(key) && url.searchParams.get(key) !== value)
          throw new Error("REST inventory pagination changed its filter scope");
      }
      visited.add(url.href);
      const response = this.get(url.href);
      if (!Array.isArray(response.body)) throw new Error("Malformed REST inventory page");
      const link = response.headers.get("link");
      if (link !== undefined) {
        const relations = [...link.matchAll(/<([^>]+)>;\s*rel="([^"]+)"/gu)];
        if (
          !relations.length ||
          link.replace(/<([^>]+)>;\s*rel="([^"]+)"/gu, "").replace(/[,\s]/gu, "") ||
          relations.filter((match) => match[2]?.split(/\s/u).includes("next")).length > 1
        )
          throw new Error("Malformed or repeated REST pagination relation");
      }
      const next = nextLink(response.headers);
      if (next !== null && url.searchParams.has("sort")) {
        const following = new URL(next);
        if (
          Number(following.searchParams.get("page")) !==
          Number(url.searchParams.get("page") ?? 1) + 1
        )
          throw new Error("REST repository inventory skipped a page");
      }
      if (response.body.length === 0 && next !== null)
        throw new Error("Empty nonterminal REST inventory page");
      for (const raw of response.body) {
        if (
          !isRecord(raw) ||
          typeof raw.node_id !== "string" ||
          !raw.node_id ||
          identities.has(raw.node_id)
        )
          throw new Error("Missing or duplicate opaque REST inventory identity");
        identities.add(raw.node_id);
        rows.push(raw);
      }
      pages.push({
        endpoint_sha256: hash(url.href),
        count: response.body.length,
        terminal: next === null,
      });
      current = next;
    }
    return { rows, pages };
  }
}
