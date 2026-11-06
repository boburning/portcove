import { GitHubApiClient } from "./github-api.mts";
import { nextLink } from "./github-operation.mts";
import { coordinatorCommandDeadline } from "./release-coordinator-deadline.mts";
import { inspectRemoteCommitObject } from "./release-coordinator-recovery.mts";
import { inspectPreparationCommitBytes } from "./release-coordinator-state.mts";
import { inspectCoordinatorRemoteNamespace } from "./release-coordinator-remote.mts";
import type { CoordinatorRemoteApi } from "./release-coordinator-remote.mts";
import { classifyApplicationVersion } from "../apps/desktop/scripts/release-version-policy.mts";
import { isRecord } from "./runtime-values.mts";
import { performance } from "node:perf_hooks";
import type { GitHubClientOptions } from "./github-client.mts";
const repository = "boburning/portcove";
const base = `repos/${repository}`;
const maximumPublicationRequests = 160;
type Api = CoordinatorRemoteApi;
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

function repositoryNodeId(value: unknown) {
  const repo = record(value);
  if (repo.id !== 1354613114 || repo.full_name !== repository || typeof repo.node_id !== "string")
    throw new Error("admission repository identity differs");
  return repo.node_id;
}

function runLegacySequence<R, T>(
  sequence: Generator<R, T, unknown>,
  read: (request: R) => unknown,
) {
  let step = sequence.next();
  while (!step.done) step = sequence.next(read(step.value));
  return step.value;
}

type PublicationAllocation = {
  version: string;
  source_commit: string;
  source_tree: string;
  prepared_commit: string;
  prepared_tree: string;
  intent_sha256: string;
};

function* readTags(nodeId: string): Generator<string | null, Record<string, unknown>[], unknown> {
  const result: Record<string, unknown>[] = [];
  const ids = new Set<string>();
  const names = new Set<string>();
  const cursors = new Set<string>();
  let cursor: string | null = null;
  let total: number | null = null;
  for (let index = 0; index < 16; index++) {
    const data = record(yield cursor);
    const r = record(data.repository);
    if (r.id !== nodeId || r.databaseId !== 1354613114 || r.nameWithOwner !== repository)
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
}

function* readAllocationPairs(
  initialTags: Record<string, unknown>[],
  namespace: string,
): Generator<
  string,
  { allocations: PublicationAllocation[]; intents: Map<string, string> },
  unknown
> {
  inspectCoordinatorRemoteNamespace({ schema_version: 1, namespace });
  const intents = new Map<string, string>();
  const commits = new Map<string, ReturnType<typeof inspectRemoteCommitObject>>();
  function* commit(
    id: string,
  ): Generator<string, ReturnType<typeof inspectRemoteCommitObject>, unknown> {
    let value = commits.get(id);
    if (!value) {
      value = inspectRemoteCommitObject(yield id, id);
      commits.set(id, value);
    }
    return value;
  }
  const versionPrefix = `${namespace}-prepared/`;
  const sourcePrefix = `${namespace}-prepared-source/`;
  const versions = initialTags.filter((r) => String(r.name).startsWith(versionPrefix));
  const sources = initialTags.filter((r) => String(r.name).startsWith(sourcePrefix));
  if ([...versions, ...sources].some((ref) => record(ref.target).__typename !== "Commit"))
    throw new Error("preparation receipts must point directly to raw commits");
  if (versions.length !== sources.length)
    throw new Error("reservation namespace has incomplete receipt pairs");
  const allocations: PublicationAllocation[] = [];
  const seenSources = new Set<string>();
  for (const ref of versions) {
    const tag = String(ref.name).slice(versionPrefix.length);
    if (!tag.startsWith("v")) throw new Error("reservation version prefix differs");
    const allocated = classifyApplicationVersion(tag.slice(1)).version;
    const prepared = peel(ref);
    const object = yield* commit(prepared);
    const matches = sources.filter((r) => peel(r) === prepared);
    if (matches.length !== 1) throw new Error("reservation source pair is missing or ambiguous");
    const source = String(matches[0]!.name).slice(sourcePrefix.length);
    oid(source);
    if (seenSources.has(source)) throw new Error("reservation source allocated more than once");
    seenSources.add(source);
    const original = yield* commit(source);
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
}

function inspectPublicationReleaseRecord(r: Record<string, unknown>) {
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
}

/** Complete bounded provider inventories and exact raw preparation receipts.
 * Facts only: no semantic, publication, initial-seed or execution authority.
 * The same reader is used by admission and the fixed coordinator driver. */
export function createReleasePublicationReader(rawApi: Api) {
  let requests = 0,
    milliseconds = 0;
  const bounded = <T,>(read: () => T): T => {
    if (++requests > maximumPublicationRequests || milliseconds > 120000)
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
      .call({ request: api.request.bind(api) }, `${base}/${endpoint}`, {
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
  const nodeId = repositoryNodeId(get(""));
  const tags = () =>
    runLegacySequence(readTags(nodeId), (cursor) => api.graphql(refsQuery, { cursor }).data);
  const releases = () =>
    page("releases?per_page=100")
      .map(inspectPublicationReleaseRecord)
      .sort((a, b) => a.id - b.id);

  const readAllocations = (initialTags: Record<string, unknown>[], namespace: string) =>
    runLegacySequence(readAllocationPairs(initialTags, namespace), (sha) =>
      get(`git/commits/${sha}`),
    );
  return { tags, releases, readAllocations };
}
/** The installed public parent uses the same complete tag and receipt checks. */
export async function readPublicationAllocationsWithSdk(
  namespace: string,
  options: Parameters<typeof createPublicationInventoryWithSdk>[0],
) {
  inspectCoordinatorRemoteNamespace({ schema_version: 1, namespace });
  const provider = await createPublicationInventoryWithSdk(options);
  return provider.readAllocations(await provider.tags(), namespace);
}

export async function createPublicationInventoryWithSdk(options: {
  token: string;
  deadline: number;
  fetch?: typeof globalThis.fetch;
  recheck: () => Promise<void>;
  beforeDispatch?: () => void;
  currentDeadline?: () => number;
  maxBytes?: number;
  requestTimeoutMs?: number;
  accounting?: {
    reserve: NonNullable<GitHubClientOptions["reserve"]>;
    elapsed: (milliseconds: number) => void;
    currentDeadline: () => number;
  };
}) {
  const { token, fetch, recheck, accounting } = options;
  const deadline = Math.min(options.deadline, coordinatorCommandDeadline() ?? Infinity);
  let requests = 0;
  let milliseconds = 0;
  const remaining = () => {
    const now = performance.now();
    const budget = accounting ? accounting.currentDeadline() - now : 120000 - milliseconds;
    if (budget <= 0 || now >= deadline) throw new Error("publication inventory budget exceeded");
    return budget;
  };
  const { createGitHubClient } = await import("./github-client.mts");
  let expected: { method: string; url: string } | undefined;
  const client = await createGitHubClient({
    credential: { kind: "explicit", token },
    deadline,
    maxBytes: options.maxBytes ?? 2 * 1024 ** 2,
    ...(fetch ? { fetch } : {}),
    ...(options.requestTimeoutMs === undefined
      ? {}
      : { requestTimeoutMs: options.requestTimeoutMs }),
    allowRequest(method, url) {
      options.beforeDispatch?.();
      return expected !== undefined && method === expected.method && url.href === expected.url;
    },
    reserve:
      accounting?.reserve ??
      (() => {
        if (requests >= maximumPublicationRequests)
          throw new Error("publication inventory budget exceeded");
        requests++;
        return {
          consumeBytes() {},
          settle(observation) {
            if (!observation.dispatched) requests--;
          },
        };
      }),
    observe(observation) {
      if (accounting) accounting.elapsed(observation.elapsedMs);
      else milliseconds += observation.elapsedMs;
    },
  });
  const read = async (route: string, body: Record<string, unknown> = {}) => {
    await recheck();
    const [method, path] = route.split(" ");
    expected = { method: method!, url: new URL(path!, "https://api.github.com").href };
    const response = await client.request(route, {
      ...body,
      request: {
        portcove: {
          replay: "once",
          attempts: 0,
          deadline: Math.min(
            deadline,
            options.currentDeadline?.() ?? Infinity,
            performance.now() + remaining(),
          ),
        },
      },
    });
    await recheck();
    remaining();
    if (response.status !== 200) throw new Error("publication inventory provider unavailable");
    return response;
  };
  async function run<R, T>(
    sequence: Generator<R, T, unknown>,
    readStep: (request: R) => Promise<unknown>,
  ) {
    let step = sequence.next();
    while (!step.done) step = sequence.next(await readStep(step.value));
    return step.value;
  }
  const nodeId = repositoryNodeId((await read(`GET /${base}`)).data);
  return {
    tags: () =>
      run(readTags(nodeId), async (cursor) => {
        const response = await read("POST /graphql", { query: refsQuery, variables: { cursor } });
        const envelope = record(response.data);
        if (
          envelope.errors !== undefined &&
          (!Array.isArray(envelope.errors) || envelope.errors.length)
        )
          throw new Error("publication ref inventory GraphQL response unavailable");
        return envelope.data;
      }),
    async releases() {
      const rows = await readReleaseInventoryPages(
        (url) => read(`GET ${url.pathname}${url.search}`),
        inspectPublicationReleaseRecord,
      );
      return rows.sort((a, b) => a.id - b.id);
    },
    readAllocations: (tags: Record<string, unknown>[], namespace: string) =>
      run(readAllocationPairs(tags, namespace), async (sha) => {
        const data: unknown = (await read(`GET /${base}/git/commits/${sha}`)).data;
        return data;
      }),
  };
}
function inspectReleaseNotes(r: Record<string, unknown>) {
  integer(r.id);
  if (
    typeof r.tag_name !== "string" ||
    r.tag_name.length > 128 ||
    typeof r.draft !== "boolean" ||
    typeof r.prerelease !== "boolean" ||
    typeof r.immutable !== "boolean" ||
    typeof r.target_commitish !== "string" ||
    !(r.body === null || typeof r.body === "string") ||
    (typeof r.body === "string" && Buffer.byteLength(r.body) > 65536)
  )
    throw new Error("native release notes inventory incomplete or oversized");
  return r;
}

/** Complete fixed repository Release inventory, without publication authority. */
export async function readReleaseNotesWithSdk(options: {
  token: string;
  deadline: number;
  guard: () => void;
  fetch?: typeof globalThis.fetch;
}) {
  const { token, guard, fetch } = options;
  const deadline = Math.min(
    options.deadline,
    coordinatorCommandDeadline() ?? Infinity,
    performance.now() + 120000,
  );
  const { createGitHubClient } = await import("./github-client.mts");
  let expected: string | undefined;
  const client = await createGitHubClient({
    credential: { kind: "explicit", token },
    deadline,
    maxBytes: 8 * 1024 ** 2,
    requestTimeoutMs: 30000,
    allowRequest(method, url) {
      guard();
      return method === "GET" && url.href === expected;
    },
    ...(fetch ? { fetch } : {}),
  });
  const read = async (endpoint: URL) => {
    expected = endpoint.href;
    guard();
    const response = await client.request(`GET ${endpoint.pathname}${endpoint.search}`, {
      request: { portcove: { replay: "once", attempts: 0 } },
    });
    guard();
    if (response.status !== 200) throw new Error("release notes inventory provider unavailable");
    return response;
  };
  repositoryNodeId((await read(new URL(`https://api.github.com/${base}`))).data);
  return readReleaseInventoryPages(read, inspectReleaseNotes);
}

async function readReleaseInventoryPages<T>(
  read: (endpoint: URL) => Promise<{ data: unknown; headers: { link?: unknown } }>,
  project: (row: Record<string, unknown>) => T,
) {
  let route = new URL(`https://api.github.com/${base}/releases?per_page=100`);
  const ids = new Set<number>();
  const rows: T[] = [];
  for (let page = 1; page < maximumPublicationRequests; page++) {
    const response = await read(route);
    const body: unknown = response.data;
    if (!Array.isArray(body) || body.length > 100 || rows.length + body.length > 1600)
      throw new Error("release notes inventory exceeds record bound");
    for (const raw of body as unknown[]) {
      const row = record(raw);
      const id = row.id;
      integer(id);
      if (ids.has(id)) throw new Error("release notes inventory duplicates a Release ID");
      ids.add(id);
      rows.push(project(row));
    }
    const link: unknown = response.headers.link;
    if (link === undefined) return rows;
    if (typeof link !== "string") throw new Error("malformed release notes pagination relation");
    const relation = /<([^>]+)>;\s*rel="([^"]+)"/gu;
    const links = [...link.matchAll(relation)];
    if (
      !links.length ||
      link.replace(relation, "").replace(/[,\s]/gu, "") ||
      links.filter((match) => match[2]?.split(/\s/u).includes("next")).length > 1
    )
      throw new Error("malformed release notes pagination relation");
    const next = nextLink(new Map([["link", link]]));
    if (next === null) return rows;
    route = new URL(next);
    if (
      route.origin !== "https://api.github.com" ||
      route.username ||
      route.password ||
      route.hash ||
      ![`/${base}/releases`, "/repositories/1354613114/releases"].includes(route.pathname) ||
      route.searchParams.size !== 2 ||
      route.searchParams.get("per_page") !== "100" ||
      route.searchParams.get("page") !== String(page + 1) ||
      body.length === 0
    )
      throw new Error("release notes inventory pagination changed scope or skipped a page");
  }
  throw new Error("release notes inventory exceeds page bound");
}

export { peel as peelReleaseReference, refsQuery as releasePublicationRefsQuery };
