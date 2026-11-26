import { nextLink } from "./github-operation.mts";
import { coordinatorCommandDeadline } from "./release-coordinator-deadline.mts";
import { inspectRemoteCommitObject } from "./release-coordinator-recovery.mts";
import { inspectPreparationCommitBytes } from "./release-coordinator-state.mts";
import { inspectCoordinatorRemoteNamespace } from "./release-coordinator-remote.mts";
import type { CoordinatorRemoteApi } from "./release-coordinator-remote.mts";
import { classifyApplicationVersion } from "../apps/desktop/scripts/release-version-policy.mts";
import { isRecord } from "./runtime-values.mts";
import { performance } from "node:perf_hooks";
import { isDeepStrictEqual } from "node:util";
import type { GitHubClientOptions } from "./github-client.mts";
const repository = "boburning/portcove";
const base = `repos/${repository}`;
/** Per-reader request budget. It paces one reader; it is never a lifetime
 * ceiling. A scan that reaches it ends with a resumable checkpoint. */
const maximumPublicationRequests = 160;
const tagsRefPrefix = "refs/tags/";
type Api = CoordinatorRemoteApi;
const refsQuery = `query AdmissionRefs($cursor:String) {
 repository(owner:"boburning",name:"portcove") { id databaseId nameWithOwner
  refs(refPrefix:"refs/tags/",first:100,after:$cursor,orderBy:{field:ALPHABETICAL,direction:ASC}) {
   totalCount pageInfo { hasNextPage endCursor }
   nodes { id name prefix target { __typename oid ... on Tag { target { __typename oid ... on Tag { target { __typename oid ... on Tag { target { __typename oid } } } } } } } }
  }
 }
}`;
const prefixRefsQuery = `query AdmissionPrefixRefs($prefix:String!,$cursor:String) {
 repository(owner:"boburning",name:"portcove") { id databaseId nameWithOwner
  refs(refPrefix:$prefix,first:100,after:$cursor,orderBy:{field:ALPHABETICAL,direction:ASC}) {
   totalCount pageInfo { hasNextPage endCursor }
   nodes { id name prefix target { __typename oid ... on Tag { target { __typename oid ... on Tag { target { __typename oid ... on Tag { target { __typename oid } } } } } } } }
  }
 }
}`;
const exactRefQuery = `query AdmissionExactRef($name:String!) {
 repository(owner:"boburning",name:"portcove") { id databaseId nameWithOwner
  ref(qualifiedName:$name) { id name prefix target { __typename oid ... on Tag { target { __typename oid ... on Tag { target { __typename oid ... on Tag { target { __typename oid } } } } } } } }
 }
}`;

/** Resumable position of a provider inventory scan that a budget interrupted.
 * It is evidence of what was read, never evidence that the rest is absent. */
export type PublicationInventoryCheckpoint =
  | {
      schema_version: 1;
      kind: "tags";
      ref_prefix: string;
      total: number | null;
      cursor: string | null;
      cursors: string[];
      head: string[];
      rows: Record<string, unknown>[];
    }
  | {
      schema_version: 1;
      kind: "releases";
      projection: ReleaseProjection;
      suffix: string;
      page: number;
      route: string;
      previous: { route: string; ids: number[] } | null;
      head: number[];
      ids: number[];
      rows: unknown[];
    };
type ReleaseProjection = "publication" | "notes" | "raw";

/** Rows of a scan continued across budget windows from a checkpoint. Every
 * page was read and the provider reported exhaustion, and the resume re-read
 * the head page and the last accepted page unchanged, before and again after
 * the continued walk. Pages read in an earlier window are not otherwise
 * re-observed, so an in-place edit of an older record can go unseen, and for
 * tags an add and a delete that cancel out behind the head page can too.
 * Releases list newest first, so a new Release lands on the head page; tags
 * list alphabetically, so a tag composite usually misses a new tag. A
 * composite is therefore not allocation or conflict authority on its own:
 * confirm it with a single-pass read or the caller's freshness bracket. */
export type CompositePublicationInventory<T> = {
  snapshot: "composite-across-budget-windows";
  rows: T[];
};

/** A scan ended before the provider reported exhaustion. Callers must treat
 * the inventory as incomplete; `checkpoint` lets a later reader continue. */
export class PublicationInventoryIncompleteError extends Error {
  readonly checkpoint: PublicationInventoryCheckpoint;
  constructor(cause: unknown, checkpoint: PublicationInventoryCheckpoint) {
    const reason = cause instanceof Error ? cause.message : String(cause);
    super(
      `${reason} (publication ${checkpoint.kind} inventory incomplete after ${checkpoint.rows.length} records; resumable checkpoint retained)`,
      { cause },
    );
    this.name = "PublicationInventoryIncompleteError";
    this.checkpoint = structuredClone(checkpoint);
  }
}

type TagScan = Extract<PublicationInventoryCheckpoint, { kind: "tags" }>;
type ReleaseScan = Extract<PublicationInventoryCheckpoint, { kind: "releases" }>;

function tagScan(refPrefix: string, resume?: PublicationInventoryCheckpoint): TagScan {
  if (resume === undefined)
    return {
      schema_version: 1,
      kind: "tags",
      ref_prefix: refPrefix,
      total: null,
      cursor: null,
      cursors: [],
      head: [],
      rows: [],
    };
  const scan = structuredClone(resume);
  if (
    scan.schema_version !== 1 ||
    scan.kind !== "tags" ||
    scan.ref_prefix !== refPrefix ||
    !Array.isArray(scan.rows) ||
    !Array.isArray(scan.cursors) ||
    !Array.isArray(scan.head) ||
    scan.rows.length === 0 ||
    scan.cursor === null ||
    scan.head.some((id, index) => scan.rows[index]?.id !== id) ||
    (scan.cursor !== null && scan.cursors.at(-1) !== scan.cursor) ||
    (scan.total !== null && (!Number.isSafeInteger(scan.total) || scan.rows.length > scan.total))
  )
    throw new Error("publication tag inventory checkpoint does not match this scan");
  return scan;
}

function releaseScan(
  suffix: string,
  projection: ReleaseProjection,
  resume?: PublicationInventoryCheckpoint,
): ReleaseScan {
  const first = `https://api.github.com/${base}${suffix}?per_page=100`;
  if (resume === undefined)
    return {
      schema_version: 1,
      kind: "releases",
      projection,
      suffix,
      page: 1,
      route: first,
      previous: null,
      head: [],
      ids: [],
      rows: [],
    };
  const scan = structuredClone(resume);
  if (
    scan.schema_version !== 1 ||
    scan.kind !== "releases" ||
    scan.projection !== projection ||
    scan.suffix !== suffix ||
    !Number.isSafeInteger(scan.page) ||
    // Only a scan that accepted at least one page has anything to continue.
    scan.page < 2 ||
    scan.previous === null ||
    typeof scan.previous.route !== "string" ||
    !Array.isArray(scan.previous.ids) ||
    !Array.isArray(scan.head) ||
    !scan.head.length ||
    !Array.isArray(scan.ids) ||
    !Array.isArray(scan.rows) ||
    scan.ids.length !== scan.rows.length ||
    new Set(scan.ids).size !== scan.ids.length ||
    scan.head.some((id, index) => scan.ids[index] !== id) ||
    scan.previous.ids.some(
      (id, index) => scan.ids[scan.ids.length - scan.previous!.ids.length + index] !== id,
    ) ||
    (scan.page === 2 && scan.previous.route !== first)
  )
    throw new Error("publication release inventory checkpoint does not match this scan");
  return scan;
}

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
  checkpoint?: PublicationInventoryCheckpoint,
) {
  let step = sequence.next();
  while (!step.done) {
    let value: unknown;
    try {
      value = read(step.value);
    } catch (error) {
      if (checkpoint) throw new PublicationInventoryIncompleteError(error, checkpoint);
      throw error;
    }
    step = sequence.next(value);
  }
  return step.value;
}

async function runSequence<R, T>(
  sequence: Generator<R, T, unknown>,
  read: (request: R) => Promise<unknown>,
  checkpoint?: PublicationInventoryCheckpoint,
) {
  let step = sequence.next();
  while (!step.done) {
    let value: unknown;
    try {
      value = await read(step.value);
    } catch (error) {
      if (checkpoint) throw new PublicationInventoryIncompleteError(error, checkpoint);
      throw error;
    }
    step = sequence.next(value);
  }
  return step.value;
}

export type PublicationAllocation = {
  version: string;
  source_commit: string;
  source_tree: string;
  prepared_commit: string;
  prepared_tree: string;
  intent_sha256: string;
};

/** Reads one ref namespace until the provider reports exhaustion. Records are
 * not capped: the caller's request and time budgets pace the scan, and `scan`
 * is advanced only after a whole page is validated so it stays resumable. */
function* readTags(
  nodeId: string,
  scan: TagScan,
): Generator<string | null, Record<string, unknown>[], unknown> {
  const tagPrefix = scan.ref_prefix.slice(tagsRefPrefix.length);
  const ids = new Set(scan.rows.map((row) => row.id));
  const names = new Set(scan.rows.map((row) => row.name));
  const cursors = new Set(scan.cursors);
  if (scan.rows.length) {
    // Continuing: the head page must be unchanged before later pages count.
    const repo = record(record(yield null).repository);
    if (repo.id !== nodeId || repo.databaseId !== 1354613114 || repo.nameWithOwner !== repository)
      throw new Error("admission ref repository identity differs");
    const head = record(repo.refs);
    if (
      head.totalCount !== scan.total ||
      !Array.isArray(head.nodes) ||
      head.nodes.length !== scan.head.length ||
      head.nodes.some(
        (node, index) =>
          record(node).id !== scan.head[index] ||
          !isDeepStrictEqual(projectTag(record(node), tagPrefix), scan.rows[index]),
      )
    )
      throw new Error("admission refs changed before their resume point");
  }
  for (;;) {
    const data = record(yield scan.cursor);
    const r = record(data.repository);
    if (r.id !== nodeId || r.databaseId !== 1354613114 || r.nameWithOwner !== repository)
      throw new Error("admission ref repository identity differs");
    const connection = record(r.refs);
    const info = record(connection.pageInfo);
    if (
      typeof connection.totalCount !== "number" ||
      !Number.isSafeInteger(connection.totalCount) ||
      connection.totalCount < 0 ||
      !Array.isArray(connection.nodes) ||
      connection.nodes.length > 100 ||
      typeof info.hasNextPage !== "boolean"
    )
      throw new Error("admission ref connection is incomplete or oversized");
    const total = scan.total ?? connection.totalCount;
    if (total !== connection.totalCount) throw new Error("admission ref count changed");
    const accepted: Record<string, unknown>[] = [];
    for (const raw of connection.nodes) {
      const ref = record(raw);
      if (
        typeof ref.id !== "string" ||
        !ref.id ||
        ref.id.length > 512 ||
        typeof ref.name !== "string" ||
        !ref.name ||
        ref.name.length > 256 - tagPrefix.length ||
        ref.prefix !== scan.ref_prefix ||
        ids.has(ref.id) ||
        names.has(tagPrefix + ref.name)
      )
        throw new Error("admission refs duplicate identities or names");
      const row = projectTag(ref, tagPrefix);
      ids.add(ref.id);
      names.add(row.name);
      accepted.push(row);
    }
    if (scan.rows.length + accepted.length > total) throw new Error("admission refs exceed total");
    if (!info.hasNextPage) {
      if (scan.rows.length + accepted.length !== total)
        throw new Error("admission refs omit records");
      return [...scan.rows, ...accepted].sort((a, b) =>
        String(a.name).localeCompare(String(b.name)),
      );
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
    if (!scan.rows.length) scan.head = accepted.map((row) => String(row.id));
    scan.total = total;
    scan.rows.push(...accepted);
    scan.cursors.push(info.endCursor);
    scan.cursor = info.endCursor;
  }
}

/** A namespace scan reports names relative to its prefix; keep the
 * complete-scan shape so allocation checks see identical records. */
function projectTag(ref: Record<string, unknown>, tagPrefix: string) {
  const row = structuredClone(ref);
  row.name = tagPrefix + String(ref.name);
  row.prefix = tagsRefPrefix;
  return row;
}

function namespaceRefPrefixes(namespace: string) {
  inspectCoordinatorRemoteNamespace({ schema_version: 1, namespace });
  return [
    `${tagsRefPrefix}${namespace}-prepared/`,
    `${tagsRefPrefix}${namespace}-prepared-source/`,
  ] as const;
}

function tagName(name: unknown): asserts name is string {
  if (
    typeof name !== "string" ||
    !name ||
    name.length > 256 ||
    name.startsWith("refs/") ||
    name.includes("..") ||
    !/^[A-Za-z0-9][A-Za-z0-9._/+-]*$/u.test(name)
  )
    throw new Error("exact tag lookup requires one valid tag name");
}

/** Authoritative exact lookup: the provider answers one qualified ref, so a
 * null result is a complete answer rather than absence from a partial list. */
function inspectExactTag(data: unknown, nodeId: string, name: string) {
  const r = record(record(data).repository);
  if (r.id !== nodeId || r.databaseId !== 1354613114 || r.nameWithOwner !== repository)
    throw new Error("admission ref repository identity differs");
  if (!Object.hasOwn(r, "ref")) throw new Error("exact tag lookup response is incomplete");
  if (r.ref === null) return null;
  const ref = record(r.ref);
  if (
    typeof ref.id !== "string" ||
    !ref.id ||
    ref.id.length > 512 ||
    ref.name !== name ||
    ref.prefix !== tagsRefPrefix
  )
    throw new Error("exact tag lookup returned a different identity");
  return structuredClone(ref);
}

/** One complete receipt pair of a reservation namespace, established from the
 * two receipt tags alone: the version tag and the source tag point to the same
 * raw prepared commit. It costs no provider request beyond the tag listing. */
export type PublicationReceipt = {
  version: string;
  source_commit: string;
  prepared_commit: string;
};

/** Pairs every receipt in a namespace from tag names and direct targets. The
 * pair structure, unique sources, direct commit targets and version identity
 * are checked for every receipt; no receipt is dropped or capped. */
function receiptPairs(
  initialTags: readonly Record<string, unknown>[],
  namespace: string,
): PublicationReceipt[] {
  inspectCoordinatorRemoteNamespace({ schema_version: 1, namespace });
  const versionPrefix = `${namespace}-prepared/`;
  const sourcePrefix = `${namespace}-prepared-source/`;
  const versions = initialTags.filter((r) => String(r.name).startsWith(versionPrefix));
  const sources = initialTags.filter((r) => String(r.name).startsWith(sourcePrefix));
  if ([...versions, ...sources].some((ref) => record(ref.target).__typename !== "Commit"))
    throw new Error("preparation receipts must point directly to raw commits");
  if (versions.length !== sources.length)
    throw new Error("reservation namespace has incomplete receipt pairs");
  const sourcesByPrepared = new Map<string, string[]>();
  for (const ref of sources) {
    const prepared = peel(ref);
    sourcesByPrepared.set(prepared, [
      ...(sourcesByPrepared.get(prepared) ?? []),
      String(ref.name).slice(sourcePrefix.length),
    ]);
  }
  const receipts: PublicationReceipt[] = [];
  const seenSources = new Set<string>();
  const seenVersions = new Set<string>();
  for (const ref of versions) {
    const tag = String(ref.name).slice(versionPrefix.length);
    if (!tag.startsWith("v")) throw new Error("reservation version prefix differs");
    const version = classifyApplicationVersion(tag.slice(1)).version;
    if (seenVersions.has(version)) throw new Error("reservation version allocated more than once");
    seenVersions.add(version);
    const prepared = peel(ref);
    const matches = sourcesByPrepared.get(prepared) ?? [];
    if (matches.length !== 1) throw new Error("reservation source pair is missing or ambiguous");
    const source = matches[0]!;
    oid(source);
    if (seenSources.has(source)) throw new Error("reservation source allocated more than once");
    seenSources.add(source);
    receipts.push({ version, source_commit: source, prepared_commit: prepared });
  }
  return receipts;
}

/** Selects which receipts a decision reads beyond their pair identity. */
export type ReceiptVerification = "all" | readonly string[];

/** Reads both raw commits of each selected receipt and checks the prepared
 * intent against its pair. A receipt's raw commits are content-addressed and
 * its intent was verified when it was allocated (and, for a published
 * version, by the published-source proof). A decision that consumes only a
 * historical receipt's pair identity (version tag and source tag naming one
 * prepared commit) does not re-read them, so this work is proportional to the
 * selection, not to history. A pair whose tags disagree with its intent is not
 * detected here; the receipt tags are the allocation authority. */
function* readAllocationPairs(
  initialTags: readonly Record<string, unknown>[],
  namespace: string,
  verify: ReceiptVerification = "all",
): Generator<
  string,
  {
    receipts: PublicationReceipt[];
    allocations: PublicationAllocation[];
    intents: Map<string, string>;
  },
  unknown
> {
  const receipts = receiptPairs(initialTags, namespace);
  if (verify !== "all") {
    if (!Array.isArray(verify) || verify.some((version) => typeof version !== "string"))
      throw new Error("receipt verification selection is invalid");
    for (const version of verify) classifyApplicationVersion(version);
  }
  const selected = verify === "all" ? null : new Set(verify);
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
  const allocations: PublicationAllocation[] = [];
  for (const receipt of receipts) {
    if (selected && !selected.has(receipt.version)) continue;
    const { version: allocated, source_commit: source, prepared_commit: prepared } = receipt;
    const object = yield* commit(prepared);
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

  return { receipts, allocations, intents };
}

/** The decision-ready receipt list: every receipt, with the verified
 * allocation in place of the bare pair wherever one was read. */
export function mergeVerifiedReceipts(
  receipts: readonly PublicationReceipt[],
  allocations: readonly PublicationAllocation[],
): (PublicationReceipt | PublicationAllocation)[] {
  const verified = new Map(allocations.map((allocation) => [allocation.version, allocation]));
  return receipts.map((receipt) => {
    const allocation = verified.get(receipt.version);
    if (
      allocation &&
      (allocation.source_commit !== receipt.source_commit ||
        allocation.prepared_commit !== receipt.prepared_commit)
    )
      throw new Error("verified allocation differs from its receipt pair");
    return structuredClone(allocation ?? receipt);
  });
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

/** Complete provider inventories and exact raw preparation receipts.
 * Facts only: no semantic, publication, initial-seed or execution authority.
 * The same reader is used by admission and the fixed coordinator driver.
 * Inventories have no lifetime record ceiling: per-reader request and time
 * budgets pace them, and a scan that a budget interrupts fails with a
 * resumable checkpoint instead of being treated as complete. */
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
  const nodeId = repositoryNodeId(get(""));
  const scanTags = (refPrefix: string, resume?: PublicationInventoryCheckpoint) => {
    const scan = tagScan(refPrefix, resume);
    return runLegacySequence(
      readTags(nodeId, scan),
      (cursor) =>
        refPrefix === tagsRefPrefix
          ? api.graphql(refsQuery, { cursor }).data
          : api.graphql(prefixRefsQuery, { prefix: refPrefix, cursor }).data,
      scan,
    );
  };
  const tags = () => scanTags(tagsRefPrefix);
  const namespaceTags = (namespace: string) =>
    namespaceRefPrefixes(namespace)
      .flatMap((prefix) => scanTags(prefix))
      .sort((a, b) => String(a.name).localeCompare(String(b.name)));
  const tag = (name: string) => {
    tagName(name);
    return inspectExactTag(
      api.graphql(exactRefQuery, { name: `${tagsRefPrefix}${name}` }).data,
      nodeId,
      name,
    );
  };
  const releases = () => {
    const scan = releaseScan("/releases", "publication");
    return runLegacySequence(
      walkReleaseInventory(scan, inspectPublicationReleaseRecord),
      (url) => {
        const response = api.request("GET", url.href);
        return {
          data: response.body,
          headers: { link: response.headers.get("link") ?? undefined },
        };
      },
      scan,
    ).sort((a, b) => a.id - b.id);
  };

  const readAllocations = (
    initialTags: readonly Record<string, unknown>[],
    namespace: string,
    verify?: ReceiptVerification,
  ) =>
    runLegacySequence(readAllocationPairs(initialTags, namespace, verify), (sha) =>
      get(`git/commits/${sha}`),
    );
  return { tags, namespaceTags, tag, releases, readAllocations };
}
/** The installed public parent uses the same tag and receipt checks, reading
 * only the namespace's two receipt prefixes instead of the lifetime tag list. */
export async function readPublicationAllocationsWithSdk(
  namespace: string,
  options: Parameters<typeof createPublicationInventoryWithSdk>[0],
) {
  inspectCoordinatorRemoteNamespace({ schema_version: 1, namespace });
  const provider = await createPublicationInventoryWithSdk(options);
  return provider.readAllocations(await provider.namespaceTags(namespace), namespace);
}

export async function createPublicationInventoryWithSdk(options: {
  token: string;
  deadline: number;
  fetch?: typeof globalThis.fetch;
  recheck: () => Promise<void>;
  beforeDispatch?: (method: string, url: URL) => void;
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
      options.beforeDispatch?.(method, url);
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
    expected = {
      method: method!,
      url: new URL(path!, "https://api.github.com").href,
    };
    const response = await client.request(route, {
      ...body,
      request: {
        portcove: {
          // Inventory reads are pure: transient provider failures retry with
          // the client's bounded backoff inside the same request budget.
          replay: method === "GET" ? "safe-read" : "pure-query",
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
  const graphql = async (query: string, variables: Record<string, unknown>) => {
    const response = await read("POST /graphql", { query, variables });
    const envelope = record(response.data);
    if (
      envelope.errors !== undefined &&
      (!Array.isArray(envelope.errors) || envelope.errors.length)
    )
      throw new Error("publication ref inventory GraphQL response unavailable");
    return envelope.data;
  };
  const nodeId = repositoryNodeId((await read(`GET /${base}`)).data);
  const scanTags = (refPrefix: string, resume?: PublicationInventoryCheckpoint) => {
    const scan = tagScan(refPrefix, resume);
    return runSequence(
      readTags(nodeId, scan),
      (cursor) =>
        refPrefix === tagsRefPrefix
          ? graphql(refsQuery, { cursor })
          : graphql(prefixRefsQuery, { prefix: refPrefix, cursor }),
      scan,
    );
  };
  return {
    /** Single-pass lifetime tag inventory, read until the provider is exhausted. */
    tags: () => scanTags(tagsRefPrefix),
    /** Continues an interrupted lifetime tag scan; see CompositePublicationInventory. */
    async resumeTags(
      checkpoint: PublicationInventoryCheckpoint,
    ): Promise<CompositePublicationInventory<Record<string, unknown>>> {
      return {
        snapshot: "composite-across-budget-windows",
        rows: await scanTags(tagsRefPrefix, checkpoint),
      };
    },
    /** Complete receipt tags of one reservation namespace (its two prefixes). */
    async namespaceTags(namespace: string) {
      const rows: Record<string, unknown>[] = [];
      for (const prefix of namespaceRefPrefixes(namespace)) rows.push(...(await scanTags(prefix)));
      return rows.sort((a, b) => String(a.name).localeCompare(String(b.name)));
    },
    /** Exact tag identity, or null when the provider authoritatively has none. */
    async tag(name: string) {
      tagName(name);
      return inspectExactTag(
        await graphql(exactRefQuery, { name: `${tagsRefPrefix}${name}` }),
        nodeId,
        name,
      );
    },
    /** Single-pass Release inventory, read until the provider is exhausted. */
    async releases() {
      const rows = await readReleaseInventoryPages(
        (url) => read(`GET ${url.pathname}${url.search}`),
        inspectPublicationReleaseRecord,
        "publication",
      );
      return rows.sort((a, b) => a.id - b.id);
    },
    /** Continues an interrupted Release scan; see CompositePublicationInventory. */
    async resumeReleases(
      checkpoint: PublicationInventoryCheckpoint,
    ): Promise<CompositePublicationInventory<ReturnType<typeof inspectPublicationReleaseRecord>>> {
      const rows = await readReleaseInventoryPages(
        (url) => read(`GET ${url.pathname}${url.search}`),
        inspectPublicationReleaseRecord,
        "publication",
        "/releases",
        checkpoint,
      );
      return {
        snapshot: "composite-across-budget-windows",
        rows: rows.sort((a, b) => a.id - b.id),
      };
    },
    /** Every receipt pair, with raw-commit intent verification limited to
     * `verify` (all receipts when omitted). */
    readAllocations: (
      tags: readonly Record<string, unknown>[],
      namespace: string,
      verify?: ReceiptVerification,
    ) =>
      runSequence(readAllocationPairs(tags, namespace, verify), async (sha) => {
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
      request: { portcove: { replay: "safe-read", attempts: 0 } },
    });
    guard();
    if (response.status !== 200) throw new Error("release notes inventory provider unavailable");
    return response;
  };
  repositoryNodeId((await read(new URL(`https://api.github.com/${base}`))).data);
  return readReleaseInventoryPages(read, inspectReleaseNotes, "notes");
}

type InventoryRead = (endpoint: URL) => Promise<{ data: unknown; headers: { link?: unknown } }>;

export function readPublicationReleases(read: InventoryRead) {
  return readReleaseInventoryPages(read, (row) => row, "raw");
}

export function readPublicationReleaseAssets(releaseId: number, read: InventoryRead) {
  integer(releaseId);
  return readReleaseInventoryPages(read, (row) => row, "raw", `/releases/${releaseId}/assets`);
}

/** Validates one page's `next` relation and returns its URL, or null at the end. */
function nextInventoryRoute(link: unknown, page: number, suffix: string, rows: number) {
  if (link === undefined) return null;
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
  if (next === null) return null;
  const route = new URL(next);
  if (
    route.origin !== "https://api.github.com" ||
    route.username ||
    route.password ||
    route.hash ||
    ![`/${base}${suffix}`, `/repositories/1354613114${suffix}`].includes(route.pathname) ||
    route.searchParams.size !== 2 ||
    route.searchParams.get("per_page") !== "100" ||
    route.searchParams.get("page") !== String(page + 1) ||
    rows === 0
  )
    throw new Error("release inventory pagination changed scope or skipped a page");
  return route.href;
}

type ReleasePage = { data: unknown; headers: { link?: unknown } };

/** Reads a Release collection until the provider has no next page. There is no
 * record or page ceiling; the caller's request and time budgets pace the scan.
 * A failed read ends with a resumable checkpoint. Resuming first re-reads the
 * head page (where a new Release appears) and the last accepted page (which a
 * deletion shifts), and fails if either changed instead of skipping rows.
 *
 * Listing is page-number based and newest first, so a Release deleted from an
 * already-read page during the walk shifts every later page back by one: the
 * first row of the next page is never returned and no duplicate shows it. A
 * deleted Release ID never returns, so before the walk is accepted every
 * accepted page except the last one this walk read is re-read and must hold
 * the identical IDs in the identical order; a deletion behind the walk leaves
 * the page that held it different. A new Release shifts rows forward into a
 * duplicate, which is refused. A final page that is full is followed by one
 * probe of the next page, which must be empty, so a provider that drops the
 * `next` relation exactly at a page boundary is refused. A provider that ends
 * a short page without `next` while more Releases exist is not detectable from
 * the REST listing, which reports no total. Any mismatch is incomplete, never
 * complete, and the scan's checkpoint is kept for a retry. */
function* walkReleaseInventory<T>(
  scan: ReleaseScan,
  project: (row: Record<string, unknown>) => T,
): Generator<URL, T[], ReleasePage> {
  const { suffix } = scan;
  const first = `https://api.github.com/${base}${suffix}?per_page=100`;
  const ids = new Set(scan.ids);
  // A re-read page must hold the identical IDs in the identical order and the
  // identical stable identity fields, so an in-place edit of an already-read
  // record (tag, draft, prerelease, publication, immutability, target, asset
  // name/size/state) is detected at no extra cost. Counters, reactions,
  // bodies and modification clocks change during ordinary use (downloads,
  // custody notes) and are not part of a record's publication identity.
  const samePage = (body: unknown, page: { ids: number[]; rows: unknown[] }) =>
    Array.isArray(body) &&
    body.length === page.ids.length &&
    body.every((raw, index) => {
      const row = record(raw);
      return (
        row.id === page.ids[index] &&
        isDeepStrictEqual(
          stableReleaseIdentity(project(row)),
          stableReleaseIdentity(page.rows[index]),
        )
      );
    });
  // Pages that end-of-walk verification re-reads, in the order they were read.
  const verify: { route: string; ids: number[]; rows: unknown[] }[] = [];
  if (scan.previous) {
    const previous = {
      ...scan.previous,
      rows: scan.rows.slice(scan.rows.length - scan.previous.ids.length),
    };
    const headPage = { route: first, ids: scan.head, rows: scan.rows.slice(0, scan.head.length) };
    if (scan.page > 2) {
      const head = yield new URL(first);
      if (!samePage(head.data, headPage))
        throw new Error("release inventory changed before its resume point");
      verify.push(headPage);
    }
    const response = yield new URL(previous.route);
    const body: unknown = response.data;
    if (
      !Array.isArray(body) ||
      !samePage(body, previous) ||
      nextInventoryRoute(response.headers.link, scan.page - 1, suffix, body.length) !== scan.route
    )
      throw new Error("release inventory changed before its resume point");
    verify.push(previous);
  }
  let route = new URL(scan.route);
  for (;;) {
    const response = yield route;
    const body: unknown = response.data;
    if (!Array.isArray(body) || body.length > 100)
      throw new Error("release inventory page is incomplete or oversized");
    const pageIds: number[] = [];
    const pageRows: T[] = [];
    for (const raw of body as unknown[]) {
      const row = record(raw);
      const id = row.id;
      integer(id);
      if (ids.has(id) || pageIds.includes(id))
        throw new Error("release inventory duplicates a Release ID");
      pageIds.push(id);
      pageRows.push(project(row));
    }
    const next = nextInventoryRoute(response.headers.link, scan.page, suffix, body.length);
    if (next === null) {
      // Verify before accepting the final page, so a failure keeps a checkpoint
      // that resumes at this page rather than one that claims the walk ended.
      if (body.length === 100) {
        const probe = new URL(route);
        probe.searchParams.set("page", String(scan.page + 1));
        const after = yield probe;
        if (
          !Array.isArray(after.data) ||
          after.data.length ||
          nextInventoryRoute(after.headers.link, scan.page + 1, suffix, 0) !== null
        )
          throw new PublicationInventoryIncompleteError(
            new Error("release inventory pagination ended before the provider was exhausted"),
            scan,
          );
      }
      for (const page of verify) {
        const again = yield new URL(page.route);
        if (!samePage(again.data, page))
          throw new PublicationInventoryIncompleteError(
            new Error("release inventory changed during the scan"),
            scan,
          );
      }
    }
    for (const id of pageIds) ids.add(id);
    if (scan.page === 1) scan.head = pageIds;
    scan.ids.push(...pageIds);
    scan.rows.push(...pageRows);
    if (next === null) return scan.rows as T[];
    verify.push({ route: route.href, ids: pageIds, rows: pageRows });
    scan.previous = { route: route.href, ids: pageIds };
    scan.page++;
    scan.route = next;
    route = new URL(next);
  }
}

const stableReleaseFields = [
  "id",
  "tag_name",
  "name",
  "draft",
  "prerelease",
  "published_at",
  "immutable",
  "target_commitish",
  "size",
  "state",
  "digest",
] as const;

/** The fields of a Release or asset row that identify what was published. */
function stableReleaseIdentity(row: unknown) {
  const value = record(row);
  return Object.fromEntries(
    stableReleaseFields.filter((key) => Object.hasOwn(value, key)).map((key) => [key, value[key]]),
  );
}

async function readReleaseInventoryPages<T>(
  read: InventoryRead,
  project: (row: Record<string, unknown>) => T,
  projection: ReleaseProjection,
  suffix = "/releases",
  resume?: PublicationInventoryCheckpoint,
) {
  const scan = releaseScan(suffix, projection, resume);
  return runSequence(walkReleaseInventory(scan, project), read, scan);
}

export { peel as peelReleaseReference, refsQuery as releasePublicationRefsQuery };
export {
  prefixRefsQuery as releasePublicationPrefixRefsQuery,
  exactRefQuery as releasePublicationExactRefQuery,
};
