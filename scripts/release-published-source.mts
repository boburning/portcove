import { performance } from "node:perf_hooks";
import { capacityDigest } from "./release-capacity.mts";
import { GitHubApiError } from "./github-operation.mts";
import type { GitHubMetadataResponse, GitHubRestReader } from "./github-operation.mts";
import type { GitHubRequestPolicy } from "./github-client.mts";
import { coordinatorCommandDeadline } from "./release-coordinator-deadline.mts";
import { assertTrustedDirectNode } from "./release-direct-node-transport.mts";
import { inspectCoordinatorRemoteNamespace } from "./release-coordinator-remote.mts";
import { inspectRemoteCommitObject } from "./release-coordinator-recovery.mts";
import { inspectPreparationCommitBytes } from "./release-coordinator-state.mts";
import { preparedCompilerSourceRequests } from "./release-compiler-source.mts";
import { classifyApplicationVersion } from "../apps/desktop/scripts/release-version-policy.mts";
import { isRecord } from "./runtime-values.mts";

const base = "repos/boburning/portcove";
const maxResponseBytes = 16 * 1024 * 1024;
const maxProofBytes = 64 * 1024 * 1024;
type PublishedSourceRead = { endpoint: string; remainingBytes: number };
/** Proves the original-source identity of one already selected publication.
 * The caller still authenticates its publication selection and supplies a
 * transport with pre-parse response bounds. This never selects a baseline,
 * classifies a change, or grants release authority. Legacy direct publications
 * retain their published identity; they acquire no invented preparation proof. */
export function inspectPublishedApplicationSource(
  reader: GitHubRestReader,
  configuration: unknown,
  raw: { id: number; version: string; prepared_commit: string; prepared_tree: string },
) {
  const sequence = publishedSourceRequests(configuration, raw);
  let step = sequence.next();
  while (!step.done) {
    const { endpoint } = step.value;
    let response: GitHubMetadataResponse;
    try {
      response = reader.request("GET", endpoint);
    } catch (error) {
      if (!(error instanceof GitHubApiError) || error.status !== 404) throw error;
      response = { status: 404, headers: new Map(), body: null };
    }
    step = sequence.next(response);
  }
  return step.value;
}

export async function inspectPublishedApplicationSourceWithSdk(
  options: {
    token: string;
    deadline: number;
    requireDirect: boolean;
    guard: () => void;
    fetch?: typeof globalThis.fetch;
  },
  configuration: unknown,
  raw: { id: number; version: string; prepared_commit: string; prepared_tree: string },
) {
  const deadline = Math.min(
    options.deadline,
    coordinatorCommandDeadline() ?? Infinity,
    performance.now() + 120000,
  );
  const sequence = publishedSourceRequests(configuration, raw, deadline);
  let step = sequence.next();
  let expectedUrl: string | undefined;
  const { createGitHubClient } = await import("./github-client.mts");
  const client = await createGitHubClient({
    credential: { kind: "explicit", token: options.token },
    deadline,
    maxBytes: maxResponseBytes,
    requestTimeoutMs: 15000,
    allowRequest(method, url) {
      options.guard();
      if (options.requireDirect) assertTrustedDirectNode("fixed published application source");
      return method === "GET" && url.href === expectedUrl;
    },
    ...(options.fetch ? { fetch: options.fetch } : {}),
  });
  while (!step.done) {
    options.guard();
    let bodyBytes = 0;
    let remainingBytes = step.value.remainingBytes;
    const policy: GitHubRequestPolicy = {
      replay: "once",
      attempts: 0,
      observe: (observation) => {
        bodyBytes = observation.bytes;
      },
      reserve: () => ({
        consumeBytes(bytes) {
          remainingBytes -= bytes;
          if (remainingBytes < 0) throw new Error("published source aggregate byte bound exceeded");
        },
        settle() {},
      }),
    };
    let response: GitHubMetadataResponse;
    const endpoint = new URL(step.value.endpoint, "https://api.github.com/");
    expectedUrl = endpoint.href;
    try {
      const result = await client.request(`GET ${endpoint.pathname}${endpoint.search}`, {
        request: { portcove: policy },
      });
      response = {
        status: result.status,
        headers: new Map(
          Object.entries(result.headers).flatMap(([name, value]) =>
            typeof value === "string" ? [[name, value]] : [],
          ),
        ),
        body: result.data as unknown,
        bodyBytes,
      };
    } catch (error) {
      if (!(error instanceof GitHubApiError) || error.status !== 404) throw error;
      response = { status: 404, headers: new Map(), body: null, bodyBytes };
    }
    options.guard();
    step = sequence.next(response);
  }
  return step.value;
}

function* publishedSourceRequests(
  configuration: unknown,
  raw: { id: number; version: string; prepared_commit: string; prepared_tree: string },
  parentDeadline = Infinity,
) {
  const namespace = inspectCoordinatorRemoteNamespace(structuredClone(configuration));
  const publication = structuredClone(raw);
  if (
    Object.keys(publication).sort().join(",") !== "id,prepared_commit,prepared_tree,version" ||
    !Number.isSafeInteger(publication.id) ||
    publication.id < 1 ||
    !/^[a-f0-9]{40}$/u.test(publication.prepared_commit) ||
    !/^[a-f0-9]{40}$/u.test(publication.prepared_tree)
  )
    throw new Error("published source requires exact existing publication identity");
  classifyApplicationVersion(publication.version);
  const deadline = Math.min(parentDeadline, performance.now() + 120000);
  let requests = 0,
    bytes = 0;
  const cache = new Map<string, GitHubMetadataResponse>();
  function* request(
    endpoint: string,
  ): Generator<PublishedSourceRead, GitHubMetadataResponse, GitHubMetadataResponse> {
    const url = new URL(
      endpoint.startsWith("https:")
        ? endpoint
        : `https://api.github.com/${endpoint.replace(/^\//u, "")}`,
    );
    const route = url.pathname.startsWith(`/${base}/`)
      ? url.pathname.slice(base.length + 2)
      : url.pathname.replace(/^\/repositories\/1354613114\//u, "");
    const query = [...url.searchParams.keys()];
    const refName = route.startsWith("git/ref/tags/")
      ? decodeURIComponent(route.slice("git/ref/tags/".length))
      : "";
    const allowed =
      (route === `releases/${publication.id}` && query.length === 0) ||
      (route.startsWith("git/ref/tags/") &&
        query.length === 0 &&
        (refName === `v${publication.version}` ||
          refName === `${namespace}-prepared/v${publication.version}` ||
          (refName.startsWith(`${namespace}-prepared-source/`) &&
            /^[a-f0-9]{40}$/u.test(refName.slice(`${namespace}-prepared-source/`.length))))) ||
      (/^git\/(?:commits|tags)\/[a-f0-9]{40}$/u.test(route) && query.length === 0) ||
      (/^git\/trees\/[a-f0-9]{40}$/u.test(route) &&
        query.join(",") === "recursive" &&
        url.searchParams.get("recursive") === "1") ||
      (/^contents\/[A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.-]+)*$/u.test(route) &&
        query.join(",") === "ref" &&
        /^[a-f0-9]{40}$/u.test(url.searchParams.get("ref") ?? "")) ||
      (/^compare\/[a-f0-9]{40}\.\.\.[a-f0-9]{40}$/u.test(route) &&
        query.every((key) => ["per_page", "page"].includes(key)) &&
        new Set(query).size === query.length &&
        url.searchParams.get("per_page") === "100" &&
        (!url.searchParams.has("page") ||
          /^(?:[1-9]|1[0-6])$/u.test(url.searchParams.get("page") ?? "")));
    if (
      url.origin !== "https://api.github.com" ||
      url.username ||
      url.password ||
      url.hash ||
      !allowed ||
      !(
        url.pathname.startsWith(`/${base}/`) ||
        url.pathname.startsWith("/repositories/1354613114/compare/")
      )
    )
      throw new Error("published source reader escaped fixed repository");
    if (performance.now() >= deadline) throw new Error("published source duration bound exceeded");
    const immutable = !url.pathname.includes("/git/ref/") && !url.pathname.includes("/releases/");
    const prior = immutable ? cache.get(url.href) : null;
    if (prior) return structuredClone(prior);
    if (++requests > 68) throw new Error("published source read count exceeded");
    const response = yield { endpoint, remainingBytes: maxProofBytes - bytes };
    const size = response.bodyBytes ?? Buffer.byteLength(JSON.stringify(response.body));
    bytes += size;
    if (size > maxResponseBytes || bytes > maxProofBytes || performance.now() >= deadline)
      throw new Error("published source response byte or duration bound exceeded");
    const copy = structuredClone(response);
    if (immutable) cache.set(url.href, copy);
    return structuredClone(copy);
  }
  function* get(route: string) {
    const result = yield* request(`${base}/${route}`);
    if (result.status !== 200 || !isRecord(result.body))
      throw new Error("published source provider record absent");
    return result.body;
  }
  function* release() {
    const value = yield* get(`releases/${publication.id}`);
    if (
      value.id !== publication.id ||
      value.tag_name !== `v${publication.version}` ||
      value.draft !== false ||
      typeof value.published_at !== "string" ||
      !Number.isFinite(Date.parse(value.published_at))
    )
      throw new Error("published source Release differs from exact publication");
    return { id: value.id, tag: value.tag_name, published_at: value.published_at };
  }
  function* publicationTag() {
    const value = yield* get(`git/ref/tags/${encodeURIComponent(`v${publication.version}`)}`);
    if (value.ref !== `refs/tags/v${publication.version}` || !isRecord(value.object))
      throw new Error("actual published version tag unavailable");
    let target = value.object;
    for (let depth = 0; depth < 4; depth++) {
      if (typeof target.sha !== "string" || !/^[a-f0-9]{40}$/u.test(target.sha))
        throw new Error("published tag target identity differs");
      if (target.type === "commit") {
        if (target.sha !== publication.prepared_commit)
          throw new Error("publication tag differs from prepared identity");
        return value;
      }
      if (target.type !== "tag") break;
      const annotated = yield* get(`git/tags/${target.sha}`);
      if (annotated.sha !== target.sha || !isRecord(annotated.object))
        throw new Error("published tag peel is incomplete");
      target = annotated.object;
    }
    throw new Error("published tag exceeds bounded commit peel");
  }
  function* ref(name: string) {
    const result = yield* request(`${base}/git/ref/tags/${encodeURIComponent(name)}`);
    if (result.status === 404) return null;
    const value = result.body;
    if (
      result.status !== 200 ||
      !isRecord(value) ||
      value.ref !== `refs/tags/${name}` ||
      !isRecord(value.object) ||
      value.object.type !== "commit" ||
      value.object.sha !== publication.prepared_commit
    )
      throw new Error("published preparation receipt identity differs");
    return value;
  }
  const firstRelease = yield* release();
  const firstTag = yield* publicationTag();
  const versionName = `${namespace}-prepared/v${publication.version}`;
  const firstVersion = yield* ref(versionName);
  const preparedBody = yield* get(`git/commits/${publication.prepared_commit}`);
  if (
    preparedBody.sha !== publication.prepared_commit ||
    !isRecord(preparedBody.tree) ||
    preparedBody.tree.sha !== publication.prepared_tree ||
    typeof preparedBody.message !== "string"
  )
    throw new Error("actual published commit/tree metadata differs");
  if (!firstVersion) {
    if (
      preparedBody.message.includes("Portcove-Preparation-SHA256:") ||
      (yield* ref(versionName)) !== null ||
      capacityDigest(yield* release()) !== capacityDigest(firstRelease) ||
      capacityDigest(yield* publicationTag()) !== capacityDigest(firstTag)
    )
      throw new Error("published preparation receipts absent or changed");
    const facts = {
      schema_version: 1,
      kind: "legacy-direct-publication" as const,
      publication,
      source_baseline: { commit: publication.prepared_commit, tree: publication.prepared_tree },
      preparation: null,
    };
    return { ...facts, proof_sha256: capacityDigest(facts), authority: "none" as const };
  }
  const prepared = inspectRemoteCommitObject(preparedBody, publication.prepared_commit);
  if (prepared.parents.length !== 1)
    throw new Error("published preparation source parent is not exact");
  const source = inspectRemoteCommitObject(
    yield* get(`git/commits/${prepared.parents[0]!}`),
    prepared.parents[0]!,
  );
  const sourceName = `${namespace}-prepared-source/${source.object.oid}`;
  const firstSource = yield* ref(sourceName);
  if (!firstSource) throw new Error("published source preparation receipt missing");
  const preparedBytes = Buffer.from(prepared.object.bytes).toString("utf8");
  const intent = preparedBytes.match(/\nPortcove-Preparation-SHA256: ([a-f0-9]{64})\n/u)?.[1];
  if (!intent) throw new Error("published preparation intent absent");
  const text = inspectPreparationCommitBytes(
    Buffer.from(source.object.bytes).toString("utf8"),
    preparedBytes,
    {
      source_commit: source.object.oid,
      source_tree: source.tree,
      prepared_commit: publication.prepared_commit,
      prepared_tree: publication.prepared_tree,
      version: publication.version,
      intent_sha256: intent,
    },
  );
  const declared: unknown = JSON.parse(text);
  if (
    !isRecord(declared) ||
    Object.keys(declared).sort().join(",") !== "compatibility,migration_notes,proposal" ||
    !isRecord(declared.proposal) ||
    declared.proposal.source_commit !== source.object.oid ||
    declared.proposal.version !== publication.version ||
    !["compatible", "breaking"].includes(String(declared.compatibility)) ||
    typeof declared.migration_notes !== "string"
  )
    throw new Error("published preparation intent does not bind original source/version");
  const preparedRequests = preparedCompilerSourceRequests(
    {
      source_commit: source.object.oid,
      source_tree: source.tree,
      prepared_commit: publication.prepared_commit,
      prepared_tree: publication.prepared_tree,
      version: publication.version,
    },
    deadline,
  );
  let step = preparedRequests.next();
  while (!step.done) step = preparedRequests.next(yield* request(step.value.endpoint));
  const transform = step.value;
  if (
    capacityDigest(yield* ref(versionName)) !== capacityDigest(firstVersion) ||
    capacityDigest(yield* ref(sourceName)) !== capacityDigest(firstSource) ||
    capacityDigest(yield* release()) !== capacityDigest(firstRelease) ||
    capacityDigest(yield* publicationTag()) !== capacityDigest(firstTag)
  )
    throw new Error("published preparation/Release identities changed during proof");
  const facts = {
    schema_version: 1,
    kind: "verified-prepared-publication" as const,
    publication,
    source_baseline: { commit: source.object.oid, tree: source.tree },
    preparation: {
      intent_sha256: intent,
      proposal: declared.proposal,
      compatibility: declared.compatibility,
      migration_notes: declared.migration_notes,
      version_transform_sha256: transform.prepared_change_set_sha256,
    },
  };
  return { ...facts, proof_sha256: capacityDigest(facts), authority: "none" as const };
}
