import { GitHubApiClient } from "./github-api.mts";
import { inspectRemoteCommitObject } from "./release-coordinator-recovery.mts";
import { inspectPreparationCommitBytes } from "./release-coordinator-state.mts";
import { inspectCoordinatorRemoteNamespace } from "./release-coordinator-remote.mts";
import { classifyApplicationVersion } from "../apps/desktop/scripts/release-version-policy.mts";
import { isRecord } from "./runtime-values.mts";
import { performance } from "node:perf_hooks";
const repository = "boburning/portcove";
const base = `repos/${repository}`;
type Api = Pick<GitHubApiClient, "request" | "graphql">;
const refsQuery = `query AdmissionRefs($cursor:String) {
 repository(owner:"boburning",name:"portcove") { id databaseId nameWithOwner
  refs(refPrefix:"refs/tags/",first:100,after:$cursor,orderBy:{field:ALPHABETICAL,direction:ASC}) {
   totalCount pageInfo { hasNextPage endCursor }
   nodes { id name prefix target { __typename oid ... on Tag { target { __typename oid ... on Tag { target { __typename oid ... on Tag { target { __typename oid } } } } } } } }
  }
 }
}`;
function oid(value: unknown): asserts value is string {
  if (typeof value !== "string" || !/^[a-f0-9]{40}$/u.test(value))
    throw new Error("admission requires exact Git object identity");
}
function integer(value: unknown): asserts value is number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1)
    throw new Error("admission requires positive numeric identity");
}
function record(value: unknown): Record<string, unknown> {
  if (!isRecord(value)) throw new Error("admission provider record is incomplete");
  return value;
}
function peel(ref: Record<string, unknown>) {
  let target = record(ref.target);
  for (let depth = 0; depth < 4; depth++) {
    oid(target.oid);
    if (target.__typename === "Commit") return target.oid;
    if (target.__typename !== "Tag") break;
    target = record(target.target);
  }
  throw new Error("published tag does not resolve to one bounded commit");
}

/** Complete bounded provider inventories and exact raw preparation receipts.
 * Facts only: no semantic, publication, initial-seed or execution authority.
 * The same reader is used by admission and the fixed coordinator driver. */
export function createReleasePublicationReader(rawApi: Api) {
  let requests = 0,
    milliseconds = 0;
  const bounded = <T,>(read: () => T): T => {
    if (++requests > 160 || milliseconds > 120000)
      throw new Error("publication inventory budget exceeded");
    const started = performance.now();
    let result: T;
    try {
      result = read();
    } finally {
      milliseconds += performance.now() - started;
    }
    if (milliseconds > 120000) throw new Error("publication inventory response was late");
    return result;
  };
  const api: Api = {
    request: (method, endpoint, body) => {
      if (method !== "GET" || body != null) throw new Error("publication reader is GET-only");
      return bounded(() => rawApi.request(method, endpoint));
    },
    graphql: (query, variables) => bounded(() => rawApi.graphql(query, variables)),
  };
  const get = (endpoint: string) =>
    api.request("GET", endpoint ? `${base}/${endpoint}` : base).body;
  const page = (endpoint: string, key?: string) => {
    let count = 0;
    return GitHubApiClient.prototype.paginateRest
      .call({ request: api.request }, `${base}/${endpoint}`, {
        select: (body: unknown) => {
          const rows = key ? record(body)[key] : body;
          if (!Array.isArray(rows) || rows.length > 100 || (count += rows.length) > 1600)
            throw new Error("admission collection exceeds record bound");
          return rows as unknown[];
        },
        identity: (item: unknown) => {
          const id = record(item).id;
          integer(id);
          return id;
        },
        ...(key
          ? {
              totalCount: (body: unknown) => {
                const n = record(body).total_count;
                if (typeof n !== "number" || !Number.isSafeInteger(n) || n < 0 || n > 1600)
                  throw new Error("admission collection exceeds bound");
                return n;
              },
            }
          : {}),
        label: "release admission inventory",
      })
      .map(record);
  };
  const repo = record(get(""));
  if (repo.id !== 1354613114 || repo.full_name !== repository || typeof repo.node_id !== "string")
    throw new Error("admission repository identity differs");
  const tags = () => {
    const result: Record<string, unknown>[] = [];
    const ids = new Set<string>();
    const names = new Set<string>();
    const cursors = new Set<string>();
    let cursor: string | null = null;
    let total: number | null = null;
    for (let index = 0; index < 16; index++) {
      const data = record(api.graphql(refsQuery, { cursor }).data);
      const r = record(data.repository);
      if (r.id !== repo.node_id || r.databaseId !== 1354613114 || r.nameWithOwner !== repository)
        throw new Error("admission ref repository identity differs");
      const connection = record(r.refs);
      const info = record(connection.pageInfo);
      if (
        typeof connection.totalCount !== "number" ||
        !Number.isSafeInteger(connection.totalCount) ||
        connection.totalCount < 0 ||
        connection.totalCount > 1600 ||
        !Array.isArray(connection.nodes) ||
        connection.nodes.length > 100 ||
        typeof info.hasNextPage !== "boolean"
      )
        throw new Error("admission ref connection is incomplete or oversized");
      total ??= connection.totalCount;
      if (total !== connection.totalCount) throw new Error("admission ref count changed");
      for (const raw of connection.nodes) {
        const ref = record(raw);
        if (
          typeof ref.id !== "string" ||
          !ref.id ||
          ref.id.length > 512 ||
          typeof ref.name !== "string" ||
          ref.name.length > 256 ||
          ref.prefix !== "refs/tags/" ||
          ids.has(ref.id) ||
          names.has(ref.name)
        )
          throw new Error("admission refs duplicate identities or names");
        ids.add(ref.id);
        names.add(ref.name);
        result.push(structuredClone(ref));
      }
      if (result.length > total) throw new Error("admission refs exceed total");
      if (!info.hasNextPage) {
        if (result.length !== total) throw new Error("admission refs omit records");
        return result.sort((a, b) => String(a.name).localeCompare(String(b.name)));
      }
      if (
        typeof info.endCursor !== "string" ||
        !info.endCursor ||
        info.endCursor.length > 1024 ||
        cursors.has(info.endCursor) ||
        connection.nodes.length === 0
      )
        throw new Error("admission ref cursor did not advance");
      cursors.add(info.endCursor);
      cursor = info.endCursor;
    }
    throw new Error("admission refs exceed page bound");
  };
  const releases = () =>
    page("releases?per_page=100")
      .map((r) => {
        integer(r.id);
        if (
          typeof r.tag_name !== "string" ||
          r.tag_name.length > 128 ||
          typeof r.draft !== "boolean" ||
          typeof r.prerelease !== "boolean" ||
          (r.published_at !== null && typeof r.published_at !== "string") ||
          typeof r.updated_at !== "string"
        )
          throw new Error("publication record is incomplete");
        return {
          id: r.id,
          tag_name: r.tag_name,
          draft: r.draft,
          prerelease: r.prerelease,
          published_at: r.published_at,
          updated_at: r.updated_at,
        };
      })
      .sort((a, b) => a.id - b.id);

  const readAllocations = (initialTags: Record<string, unknown>[], namespace: string) => {
    inspectCoordinatorRemoteNamespace({ schema_version: 1, namespace });
    const intents = new Map<string, string>();
    const commits = new Map<string, ReturnType<typeof inspectRemoteCommitObject>>();
    const commit = (id: string) => {
      let value = commits.get(id);
      if (!value) {
        value = inspectRemoteCommitObject(get(`git/commits/${id}`), id);
        commits.set(id, value);
      }
      return value;
    };
    const versionPrefix = `${namespace}-prepared/`;
    const sourcePrefix = `${namespace}-prepared-source/`;
    const versions = initialTags.filter((r) => String(r.name).startsWith(versionPrefix));
    const sources = initialTags.filter((r) => String(r.name).startsWith(sourcePrefix));
    if ([...versions, ...sources].some((ref) => record(ref.target).__typename !== "Commit"))
      throw new Error("preparation receipts must point directly to raw commits");
    if (versions.length !== sources.length)
      throw new Error("reservation namespace has incomplete receipt pairs");
    const allocations = [];
    const seenSources = new Set<string>();
    for (const ref of versions) {
      const tag = String(ref.name).slice(versionPrefix.length);
      if (!tag.startsWith("v")) throw new Error("reservation version prefix differs");
      const allocated = classifyApplicationVersion(tag.slice(1)).version;
      const prepared = peel(ref);
      const object = commit(prepared);
      const matches = sources.filter((r) => peel(r) === prepared);
      if (matches.length !== 1) throw new Error("reservation source pair is missing or ambiguous");
      const source = String(matches[0]!.name).slice(sourcePrefix.length);
      oid(source);
      if (seenSources.has(source)) throw new Error("reservation source allocated more than once");
      seenSources.add(source);
      const original = commit(source);
      const text = Buffer.from(object.object.bytes).toString("utf8");
      const intent = text.match(/\nPortcove-Preparation-SHA256: ([a-f0-9]{64})\n/u)?.[1];
      if (!intent) throw new Error("reservation prepared intent is missing");
      const payload = inspectPreparationCommitBytes(
        Buffer.from(original.object.bytes).toString("utf8"),
        text,
        {
          source_commit: source,
          source_tree: original.tree,
          prepared_commit: prepared,
          prepared_tree: object.tree,
          version: allocated,
          intent_sha256: intent,
        },
      );
      const declared = record(JSON.parse(payload));
      const proposal = record(declared.proposal);
      if (proposal.source_commit !== source || proposal.version !== allocated)
        throw new Error("reservation intent does not match its complete receipt pair");
      intents.set(allocated, payload);
      allocations.push({
        version: allocated,
        source_commit: source,
        source_tree: original.tree,
        prepared_commit: prepared,
        prepared_tree: object.tree,
        intent_sha256: intent,
      });
    }

    return { allocations, intents };
  };
  return { tags, releases, readAllocations };
}
export { peel as peelReleaseReference, refsQuery as releasePublicationRefsQuery };
