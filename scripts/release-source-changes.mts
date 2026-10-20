import { createHash } from "node:crypto";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { GitHubApiClient } from "./github-api.mts";
import type { GitHubRestReader } from "./github-api.mts";
import {
  inspectRemoteCommitObject,
  inspectRemoteGitObject,
} from "./release-coordinator-recovery.mts";
import { isRecord } from "./runtime-values.mts";

export const netTreeDeltaScope = "portcove-release-net-tree-delta-v1";
const base = "repos/boburning/portcove";
const byteOrder = (left: string, right: string) =>
  Buffer.compare(Buffer.from(left), Buffer.from(right));
function object(value: unknown) {
  if (!isRecord(value)) throw new Error("release source record is incomplete");
  return value;
}
function oid(value: unknown): asserts value is string {
  if (typeof value !== "string" || !/^[a-f0-9]{40}$/u.test(value))
    throw new Error("release source needs exact Git identities");
}
type Entry = { mode: string; type: string; oid: string };

/** A complete provider comparison plus cryptographically reconstructed Git
 * trees. Net delta is consistency evidence, never semantic classification,
 * original compilation, source-selection authority or permission to execute.
 * The supplied reader must bound each response/subprocess before collection.
 */
export function collectReleaseSourceChanges(
  reader: GitHubRestReader,
  rawOpportunity: unknown,
  options: { readCommitObject?: (oid: string) => Buffer } = {},
) {
  const opportunity = object(structuredClone(rawOpportunity));
  oid(opportunity.base_commit);
  oid(opportunity.source_commit);
  oid(opportunity.source_tree);
  const before = opportunity.base_commit;
  const source = opportunity.source_commit;
  const started = performance.now();
  let requests = 0;
  const checkTime = () => {
    if (performance.now() - started > 120000)
      throw new Error("release source collection deadline exhausted");
  };
  const request = (endpoint: string) => {
    checkTime();
    if (++requests > 20) throw new Error("release source API read bound exhausted");
    const response = reader.request("GET", endpoint);
    checkTime();
    if (response.status !== 200) throw new Error("release source provider unavailable");
    return response;
  };
  const inspect = (raw: unknown, id: string) => {
    checkTime();
    const result = inspectRemoteCommitObject(raw, id, options.readCommitObject?.(id));
    checkTime();
    return result;
  };
  const original = inspect(request(`${base}/git/commits/${source}`).body, source);
  if (original.tree !== opportunity.source_tree) throw new Error("release source tree differs");
  const previous =
    before === source ? original : inspect(request(`${base}/git/commits/${before}`).body, before);
  const comparisonPath = `/${base}/compare/${before}...${source}`;
  const comparisonById = `/repositories/1354613114/compare/${before}...${source}`;
  let baseline: string | null = null;
  const commits = GitHubApiClient.prototype.paginateRest
    .call(
      {
        request(method: string, endpoint: string) {
          const url = new URL(
            endpoint.startsWith("https:") ? endpoint : `https://api.github.com/${endpoint}`,
          );
          const keys = [...url.searchParams.keys()];
          if (
            method !== "GET" ||
            url.origin !== "https://api.github.com" ||
            url.username ||
            url.password ||
            url.hash ||
            ![comparisonPath, comparisonById].includes(url.pathname) ||
            keys.some((key) => !["per_page", "page"].includes(key)) ||
            new Set(keys).size !== keys.length ||
            url.searchParams.get("per_page") !== "100" ||
            (url.searchParams.has("page") &&
              !/^(?:[1-9]|1[0-6])$/u.test(url.searchParams.get("page") ?? ""))
          )
            throw new Error("release source pagination escaped its fixed comparison");
          return request(endpoint);
        },
      },
      `${comparisonPath.slice(1)}?per_page=100`,
      {
        select(raw: unknown) {
          const value = object(raw);
          if (
            !Number.isSafeInteger(value.total_commits) ||
            typeof value.total_commits !== "number" ||
            value.total_commits < 0 ||
            value.total_commits > 1600 ||
            value.ahead_by !== value.total_commits ||
            value.behind_by !== 0 ||
            value.status !== (before === source ? "identical" : "ahead") ||
            object(value.base_commit).sha !== before ||
            object(value.merge_base_commit).sha !== before ||
            !Array.isArray(value.commits) ||
            value.commits.length > 100
          )
            throw new Error("release source ancestry or comparison completeness differs");
          const current = JSON.stringify([
            value.total_commits,
            value.ahead_by,
            value.status,
            before,
            source,
          ]);
          baseline ??= current;
          if (current !== baseline) throw new Error("release source comparison changed");
          return value.commits as unknown[];
        },
        identity(raw: unknown) {
          const sha = object(raw).sha;
          oid(sha);
          return sha;
        },
        totalCount(raw: unknown) {
          const total = object(raw).total_commits;
          return typeof total === "number" ? total : null;
        },
        label: "complete release source commit comparison",
      },
    )
    .map((raw: unknown) => {
      const value = object(raw);
      oid(value.sha);
      const parsed = inspect(
        { ...object(value.commit), sha: value.sha, parents: value.parents },
        value.sha,
      );
      if (parsed.parents.length > 32 || new Set(parsed.parents).size !== parsed.parents.length)
        throw new Error("release comparison has unsupported parents");
      return { oid: value.sha, tree: parsed.tree, parents: parsed.parents };
    });
  if (before === source) {
    if (commits.length !== 0) throw new Error("identical source has an unexpected commit delta");
  } else {
    const byId = new Map(commits.map((entry) => [entry.oid, entry]));
    const visited = new Set<string>();
    let reachesBase = false;
    const pending = [source];
    while (pending.length) {
      const id = pending.pop()!;
      if (id === before) {
        reachesBase = true;
        continue;
      }
      if (visited.has(id)) continue;
      const entry = byId.get(id);
      if (!entry) continue; // Already in the base's ancestry, per the provider comparison.
      visited.add(id);
      if (id === source && entry.tree !== original.tree)
        throw new Error("comparison source tree differs");
      pending.push(...entry.parents);
    }
    if (!reachesBase || visited.size !== commits.length)
      throw new Error("release comparison does not close over its complete source ancestry");
  }
  const tree = (id: string) =>
    inspectReleaseSourceTree(request(`${base}/git/trees/${id}?recursive=1`).body, id).entries;
  const oldTree = tree(previous.tree);
  const newTree = previous.tree === original.tree ? oldTree : tree(original.tree);
  const changes = [...new Set([...oldTree.keys(), ...newTree.keys()])]
    .sort(byteOrder)
    .flatMap((name) => {
      const old = oldTree.get(name) ?? null;
      const next = newTree.get(name) ?? null;
      return JSON.stringify(old) === JSON.stringify(next)
        ? []
        : [{ path: name, before: old, after: next }];
    });
  const delta = {
    schema_version: 1,
    scope: netTreeDeltaScope,
    base_commit: before,
    base_tree: previous.tree,
    source_commit: source,
    source_tree: original.tree,
    changes,
  };
  const changeSet = createHash("sha256").update(JSON.stringify(delta)).digest("hex");
  checkTime();
  return {
    ...delta,
    change_set_sha256: changeSet,
    commits,
    api_requests: requests,
    qualification:
      "complete provider commit comparison and raw Git net tree consistency only; no semantic classification or source authority",
    authority: "none",
  };
}

/** Reconstruct the complete bounded tree closure. Returned objects are inert
 * digest-verified bytes, not source selection or execution authority. */
export function inspectReleaseSourceTree(raw: unknown, id: string) {
  oid(id);
  const response = object(raw);
  const objects: ReturnType<typeof inspectRemoteGitObject>[] = [];
  if (
    response.sha !== id ||
    response.truncated !== false ||
    !Array.isArray(response.tree) ||
    response.tree.length > 5000
  )
    throw new Error("release source tree is truncated, unavailable or oversized");
  const entries = new Map<string, Entry>();
  const directories = new Map<string, string>([["", id]]);
  for (const raw of response.tree) {
    const entry = object(raw);
    oid(entry.sha);
    if (
      typeof entry.path !== "string" ||
      !entry.path ||
      Buffer.byteLength(entry.path) > 1024 ||
      entry.path.includes("\0") ||
      entry.path.includes("\\") ||
      entry.path.split("/").some((part) => !part || part === "." || part === "..") ||
      entry.path.split("/").length > 32 ||
      entries.has(entry.path) ||
      !(
        (entry.type === "blob" && ["100644", "100755", "120000"].includes(String(entry.mode))) ||
        (entry.type === "tree" && entry.mode === "040000") ||
        (entry.type === "commit" && entry.mode === "160000")
      )
    )
      throw new Error("release source tree entry is invalid, duplicate or unsupported");
    entries.set(entry.path, {
      mode: String(entry.mode),
      type: String(entry.type),
      oid: entry.sha,
    });
    if (entry.type === "tree") directories.set(entry.path, entry.sha);
  }
  const children = new Map<string, { name: string; entry: Entry }[]>();
  for (const [name, entry] of entries) {
    const parent = path.posix.dirname(name) === "." ? "" : path.posix.dirname(name);
    if (!directories.has(parent)) throw new Error("release source tree omits a parent directory");
    const siblings = children.get(parent) ?? [];
    siblings.push({ name: path.posix.basename(name), entry });
    children.set(parent, siblings);
  }
  for (const [directory, expected] of directories) {
    const rows = (children.get(directory) ?? []).sort((a, b) =>
      byteOrder(
        a.name + (a.entry.type === "tree" ? "/" : ""),
        b.name + (b.entry.type === "tree" ? "/" : ""),
      ),
    );
    const bytes = Buffer.concat(
      rows.map(({ name, entry }) =>
        Buffer.concat([
          Buffer.from(`${entry.type === "tree" ? "40000" : entry.mode} ${name}\0`),
          Buffer.from(entry.oid, "hex"),
        ]),
      ),
    );
    // Reuse the existing raw Git object validator and its unchanged 128 KiB
    // object cap. Unsupported empty/large trees hold rather than weakening it.
    objects.push(inspectRemoteGitObject("tree", expected, bytes));
  }
  return { entries, objects };
}
