import { performance } from "node:perf_hooks";
import { capacityDigest } from "./release-capacity.mts";
import { GitHubApiError } from "./github-api.mts";
import type { GitHubRestReader, IncludedResponse } from "./github-api.mts";
import { inspectCoordinatorRemoteNamespace } from "./release-coordinator-remote.mts";
import { inspectRemoteCommitObject } from "./release-coordinator-recovery.mts";
import { inspectPreparationCommitBytes } from "./release-coordinator-state.mts";
import { inspectPreparedCompilerSource } from "./release-compiler-source.mts";
import { classifyApplicationVersion } from "../apps/desktop/scripts/release-version-policy.mts";
import { isRecord } from "./runtime-values.mts";

const base = "repos/boburning/portcove";
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
  const start = performance.now();
  let requests = 0,
    bytes = 0;
  const cache = new Map<string, IncludedResponse>();
  const api: GitHubRestReader = {
    request(method, endpoint) {
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
        method !== "GET" ||
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
      if (performance.now() - start > 120000)
        throw new Error("published source duration bound exceeded");
      const immutable = !url.pathname.includes("/git/ref/") && !url.pathname.includes("/releases/");
      const prior = immutable ? cache.get(url.href) : null;
      if (prior) return structuredClone(prior);
      if (++requests > 68) throw new Error("published source read count exceeded");
      const response = reader.request("GET", endpoint);
      const size = Buffer.byteLength(JSON.stringify(response.body));
      bytes += size;
      if (size > 16 * 1024 * 1024 || bytes > 64 * 1024 * 1024 || performance.now() - start > 120000)
        throw new Error("published source response byte or duration bound exceeded");
      const copy = structuredClone(response);
      if (immutable) cache.set(url.href, copy);
      return structuredClone(copy);
    },
  };
  const get = (route: string) => {
    const result = api.request("GET", `${base}/${route}`);
    if (result.status !== 200 || !isRecord(result.body))
      throw new Error("published source provider record absent");
    return result.body;
  };
  const release = () => {
    const value = get(`releases/${publication.id}`);
    if (
      value.id !== publication.id ||
      value.tag_name !== `v${publication.version}` ||
      value.draft !== false ||
      typeof value.published_at !== "string" ||
      !Number.isFinite(Date.parse(value.published_at))
    )
      throw new Error("published source Release differs from exact publication");
    return { id: value.id, tag: value.tag_name, published_at: value.published_at };
  };
  const publicationTag = () => {
    const value = get(`git/ref/tags/${encodeURIComponent(`v${publication.version}`)}`);
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
      const annotated = get(`git/tags/${target.sha}`);
      if (annotated.sha !== target.sha || !isRecord(annotated.object))
        throw new Error("published tag peel is incomplete");
      target = annotated.object;
    }
    throw new Error("published tag exceeds bounded commit peel");
  };
  const ref = (name: string) => {
    try {
      const result = api.request("GET", `${base}/git/ref/tags/${encodeURIComponent(name)}`);
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
    } catch (error) {
      if (error instanceof GitHubApiError && error.status === 404) return null;
      throw error;
    }
  };
  const firstRelease = release();
  const firstTag = publicationTag();
  const versionName = `${namespace}-prepared/v${publication.version}`;
  const firstVersion = ref(versionName);
  const preparedBody = get(`git/commits/${publication.prepared_commit}`);
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
      ref(versionName) !== null ||
      capacityDigest(release()) !== capacityDigest(firstRelease) ||
      capacityDigest(publicationTag()) !== capacityDigest(firstTag)
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
    get(`git/commits/${prepared.parents[0]!}`),
    prepared.parents[0]!,
  );
  const sourceName = `${namespace}-prepared-source/${source.object.oid}`;
  const firstSource = ref(sourceName);
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
  const transform = inspectPreparedCompilerSource(api, {
    source_commit: source.object.oid,
    source_tree: source.tree,
    prepared_commit: publication.prepared_commit,
    prepared_tree: publication.prepared_tree,
    version: publication.version,
  });
  if (
    capacityDigest(ref(versionName)) !== capacityDigest(firstVersion) ||
    capacityDigest(ref(sourceName)) !== capacityDigest(firstSource) ||
    capacityDigest(release()) !== capacityDigest(firstRelease) ||
    capacityDigest(publicationTag()) !== capacityDigest(firstTag)
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
