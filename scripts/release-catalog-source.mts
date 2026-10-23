/** Inert authoring inputs from one reconstructed Git tree. Candidate files are
 * never executed, imported as instructions, or treated as publisher authority. */
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import path from "node:path";
import { performance } from "node:perf_hooks";
import type { GitHubRestReader } from "./github-api.mts";
import {
  inspectRemoteCommitObject,
  inspectRemoteGitObject,
} from "./release-coordinator-recovery.mts";
import { inspectReleaseSourceTree } from "./release-source-changes.mts";
import { catalogPublicationInventory } from "./release-catalog-publication-contract.mts";
import { releaseCanonicalDigest as digest } from "./release-canonical.mts";
import { isRecord } from "./runtime-values.mts";
import { assertOwnedUnlinkedPath } from "./release-path-safety.mts";

export const catalogPublicationSourcePrefix = "release/catalog-publication/";
const repository = "repos/boburning/portcove";
const hash = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
function check(deadline: number) {
  if (!Number.isFinite(deadline) || performance.now() >= deadline)
    throw new Error("catalog source original deadline exhausted");
}
function target(name: string) {
  return (
    name === "definitions/index.json" ||
    name === "policy/official/catalog.listings.json" ||
    /^sha256\/[a-f0-9]{64}\.json$/u.test(name) ||
    /^policy\/official\/[a-z0-9][a-z0-9-]{0,127}(?:\.launch)?\.json$/u.test(name)
  );
}

/** Reader injection is deliberately integrity-only. The fixed controller owns
 * the real read-only provider transport, source selection and later admission.
 * Missing request is absence at this exact complete tree, not catalog support. */
export function readCatalogPublicationSourceBytes(
  api: GitHubRestReader,
  sourceCommit: string,
  deadline: number,
) {
  if (!/^[a-f0-9]{40}$/u.test(sourceCommit)) throw new Error("exact catalog source required");
  let reads = 0,
    total = 0;
  const get = (route: string) => {
    check(deadline);
    if (++reads > 2051) throw new Error("catalog source read bound exhausted");
    const response = api.request("GET", route);
    check(deadline);
    if (response.status !== 200) throw new Error("catalog source unavailable");
    return response.body;
  };
  const commit = inspectRemoteCommitObject(
    get(`${repository}/git/commits/${sourceCommit}`),
    sourceCommit,
  );
  const tree = inspectReleaseSourceTree(
    get(`${repository}/git/trees/${commit.tree}?recursive=1`),
    commit.tree,
  );
  const requestPath = `${catalogPublicationSourcePrefix}request.json`;
  const requestEntry = tree.entries.get(requestPath);
  const entries = [...tree.entries].filter(([name]) =>
    name.startsWith(catalogPublicationSourcePrefix),
  );
  if (!requestEntry) {
    if (entries.length) throw new Error("catalog publication source exists without its request");
    return {
      source: { commit: sourceCommit, tree: commit.tree },
      request: null,
      files: new Map<string, Buffer>(),
      api_reads: reads,
      authority: "none" as const,
    };
  }
  const read = (entry: { mode: string; type: string; oid: string }, bound = 128 * 1024) => {
    if (entry.mode !== "100644" || entry.type !== "blob")
      throw new Error("catalog source must be regular inert Git blobs");
    const raw = get(`${repository}/git/blobs/${entry.oid}`);
    if (
      !isRecord(raw) ||
      raw.sha !== entry.oid ||
      raw.encoding !== "base64" ||
      typeof raw.size !== "number" ||
      !Number.isSafeInteger(raw.size) ||
      raw.size < 1 ||
      raw.size > bound ||
      typeof raw.content !== "string" ||
      raw.content.length > Math.ceil(bound / 3) * 4 + Math.ceil(bound / 57)
    )
      throw new Error("catalog source blob bound or identity differs");
    const encoded = raw.content.replace(/\n/gu, ""),
      bytes = Buffer.from(encoded, "base64");
    if (bytes.length !== raw.size || bytes.toString("base64") !== encoded)
      throw new Error("catalog source blob encoding differs");
    inspectRemoteGitObject("blob", entry.oid, bytes);
    if ((total += bytes.length) > 32 * 1024 ** 2)
      throw new Error("catalog source total exceeds bound");
    return bytes;
  };
  const requestBytes = read(requestEntry);
  if (requestBytes.length > 16384) throw new Error("catalog authoring request exceeds bound");
  const requestText = requestBytes.toString("utf8");
  if (!Buffer.from(requestText, "utf8").equals(requestBytes))
    throw new Error("catalog authoring request is not lossless UTF-8");
  const request: unknown = JSON.parse(requestText);
  if (
    !isRecord(request) ||
    Object.keys(request).sort().join(",") !== "compatibility,kind,schema_version" ||
    request.schema_version !== 1 ||
    request.kind !== "catalog-publication" ||
    !isRecord(request.compatibility) ||
    Object.keys(request.compatibility).sort().join(",") !== "contract,notes" ||
    !["official-definition-policy-launch-v1", "official-catalog-listings-v2"].includes(
      String(request.compatibility.contract),
    ) ||
    typeof request.compatibility.notes !== "string" ||
    !request.compatibility.notes.trim() ||
    Buffer.byteLength(request.compatibility.notes) > 8192
  )
    throw new Error("catalog authoring request schema differs");
  const files = new Map<string, Buffer>();
  const bundlePrefix = `${catalogPublicationSourcePrefix}bundle/`;
  const directories = new Set([
    catalogPublicationSourcePrefix.slice(0, -1),
    `${catalogPublicationSourcePrefix}bundle`,
    ...["definitions", "sha256", "policy", "policy/official"].map(
      (name) => `${bundlePrefix}${name}`,
    ),
  ]);
  for (const [name, entry] of entries) {
    if (name === requestPath) continue;
    if (entry.type === "tree" && entry.mode === "040000" && directories.has(name)) continue;
    const relative = name.slice(bundlePrefix.length);
    if (!name.startsWith(bundlePrefix) || !target(relative) || files.size >= 2048)
      throw new Error("catalog source contains unlisted content or exceeds context file bound");
    files.set(
      relative,
      read(
        entry,
        relative === "policy/official/catalog.listings.json" ? 8 * 1024 ** 2 : 128 * 1024,
      ),
    );
  }
  if (!files.has("definitions/index.json")) throw new Error("catalog source index missing");
  check(deadline);
  return {
    source: { commit: sourceCommit, tree: commit.tree },
    request: {
      compatibility: {
        contract: request.compatibility.contract as
          | "official-definition-policy-launch-v1"
          | "official-catalog-listings-v2",
        notes: request.compatibility.notes,
      },
    },
    request_sha256: hash(requestBytes),
    bundle_sha256: digest(catalogPublicationInventory(files)),
    files,
    api_reads: reads,
    authority: "none" as const,
  };
}

export async function materializeCatalogPublicationSource(
  api: GitHubRestReader,
  sourceCommit: string,
  privateParent: string,
  deadline: number,
) {
  if (!path.isAbsolute(privateParent)) throw new Error("absolute private catalog parent required");
  const selected = readCatalogPublicationSourceBytes(api, sourceCommit, deadline);
  if (!selected.request) return selected;
  check(deadline);
  const directory = await mkdtemp(path.join(privateParent, "catalog-source-"));
  const bundle = path.join(directory, "bundle");
  await mkdir(bundle, { mode: 0o700 });
  for (const [name, bytes] of selected.files) {
    check(deadline);
    const filename = await assertOwnedUnlinkedPath(
      directory,
      path.join(bundle, name),
      "catalog source staging",
    );
    await mkdir(path.dirname(filename), { recursive: true, mode: 0o700 });
    await writeFile(filename, bytes, { flag: "wx", mode: 0o600 });
  }
  await writeFile(
    path.join(directory, "source.json"),
    JSON.stringify({
      source: selected.source,
      request_sha256: selected.request_sha256,
      bundle_sha256: selected.bundle_sha256,
      api_reads: selected.api_reads,
      authority: "none",
    }),
    { flag: "wx", mode: 0o600 },
  );
  check(deadline);
  return { ...selected, directory, bundle };
}
