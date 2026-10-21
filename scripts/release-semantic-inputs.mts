import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { collectReleaseSourceChanges } from "./release-source-changes.mts";
import { validateOpportunity } from "./release-coordinator.mts";
import { capacityDigest } from "./release-capacity.mts";
import { GitHubApiClient } from "./github-api.mts";
import type { GitHubRestReader } from "./github-api.mts";
import { isRecord } from "./runtime-values.mts";
import { parseVersionClassification } from "../apps/desktop/scripts/release-version-policy.mts";
import { inspectReleaseReviewRequest } from "./release-review-request.mts";
import { inspectPublishedApplicationSource } from "./release-published-source.mts";
import { inspectCatalogSemanticOpportunity } from "./release-catalog-semantic.mts";
import { inspectCatalogCoreReport } from "./release-catalog-publication-contract.mts";
import {
  assertPreviewWithdrawalClassification,
  readPreviewWithdrawalSource,
} from "./release-preview-withdrawals.mts";

const repository = "repos/boburning/portcove";
const oid = (value: unknown): value is string =>
  typeof value === "string" && /^[a-f0-9]{40}$/u.test(value);
function git(root: string, args: string[], input?: Buffer) {
  return execFileSync("git", ["--no-optional-locks", "--no-replace-objects", "-C", root, ...args], {
    input,
    windowsHide: true,
    timeout: 120000,
    maxBuffer: 256 * 1024 * 1024,
    env: {
      ...process.env,
      GIT_OPTIONAL_LOCKS: "0",
      GIT_TERMINAL_PROMPT: "0",
      GIT_NO_LAZY_FETCH: "1",
      GIT_NO_REPLACE_OBJECTS: "1",
    },
  });
}

/** REST normalizes unsigned actor offsets. Reuse exact local Git objects, whose
 * hashes and metadata the existing verifier checks against provider identities.
 * Batch before collection: no per-commit process loop, fetching or replacement. */
function readSemanticSourceChanges(api: GitHubRestReader, root: string, opportunity: unknown) {
  if (!isRecord(opportunity) || !oid(opportunity.base_commit) || !oid(opportunity.source_commit))
    throw new Error("semantic source requires exact commits");
  const listed = git(root, [
    "rev-list",
    "--max-count=1601",
    opportunity.source_commit,
    `^${opportunity.base_commit}`,
    "--",
  ])
    .toString()
    .trim()
    .split("\n")
    .filter(Boolean);
  if (listed.length > 1600 || listed.some((id) => !oid(id)))
    throw new Error("semantic commit inventory exceeds bound");
  const ids = [...new Set([opportunity.base_commit, opportunity.source_commit, ...listed])];
  const input = Buffer.from(ids.join("\n") + "\n");
  const sizes = git(root, ["cat-file", "--batch-check"], input).toString().trim().split("\n");
  let total = 0;
  if (sizes.length !== ids.length) throw new Error("semantic commit preflight incomplete");
  for (const [index, row] of sizes.entries()) {
    const match = /^([a-f0-9]{40}) commit ([0-9]+)$/u.exec(row),
      size = Number(match?.[2]);
    if (
      !match ||
      match[1] !== ids[index] ||
      !Number.isSafeInteger(size) ||
      size < 1 ||
      size > 128 * 1024 ||
      (total += size + 100) > 32 * 1024 * 1024
    )
      throw new Error("semantic commit preflight exceeds bound");
  }
  const bytes = git(root, ["cat-file", "--batch"], input),
    objects = new Map<string, Buffer>();
  let cursor = 0;
  for (const id of ids) {
    const end = bytes.indexOf(10, cursor),
      match = /^([a-f0-9]{40}) commit ([0-9]+)$/u.exec(bytes.subarray(cursor, end).toString());
    const size = Number(match?.[2]);
    if (
      end < cursor ||
      !match ||
      match[1] !== id ||
      !Number.isSafeInteger(size) ||
      size < 1 ||
      size > 128 * 1024
    )
      throw new Error("semantic commit batch differs");
    cursor = end + 1;
    const raw = bytes.subarray(cursor, cursor + size);
    if (raw.length !== size || bytes[cursor + size] !== 10)
      throw new Error("semantic commit bytes incomplete");
    objects.set(id, raw);
    cursor += size + 1;
  }
  if (cursor !== bytes.length) throw new Error("semantic commit batch trailing bytes");
  return collectReleaseSourceChanges(api, opportunity, {
    readCommitObject(id) {
      const raw = objects.get(id);
      if (!raw) throw new Error("provider comparison commit missing from local bounded inventory");
      return raw;
    },
  });
}

/** Provider readback selects no new baseline policy: the existing coordinator's
 * expected version must equal the latest published release in this repository.
 * Resolve its tag twice, rather than treating target_commitish as provenance.
 */
export function readSemanticPublicationBaseline(
  api: GitHubRestReader,
  root: string,
  expectedVersion: string,
  namespaceConfiguration?: { schema_version: 1; namespace: string },
) {
  const started = performance.now();
  let requests = 0;
  const request = (route: string) => {
    if (++requests > 24 || performance.now() - started > 120000)
      throw new Error("publication read bound exhausted");
    const response = api.request("GET", route);
    if (Buffer.byteLength(JSON.stringify(response.body)) > 16 * 1024 * 1024)
      throw new Error("publication response exceeds bound");
    if (performance.now() - started > 120000) throw new Error("publication deadline exhausted");
    return response;
  };
  const get = (route: string) => {
    const response = request(route);
    if (
      response.status !== 200 ||
      Buffer.byteLength(JSON.stringify(response.body)) > 16 * 1024 * 1024
    )
      throw new Error("publication baseline unavailable or oversized");
    return response.body;
  };
  const identity = get(repository);
  if (
    !isRecord(identity) ||
    identity.id !== 1354613114 ||
    identity.full_name !== "boburning/portcove"
  )
    throw new Error("publication repository differs");
  const releases = GitHubApiClient.prototype.paginateRest
    .call(
      {
        request(method: string, route: string) {
          const url = new URL(
            route.startsWith("https:") ? route : `https://api.github.com/${route}`,
          );
          const keys = [...url.searchParams.keys()];
          if (
            method !== "GET" ||
            url.origin !== "https://api.github.com" ||
            url.username ||
            url.password ||
            url.hash ||
            url.pathname !== `/${repository}/releases` ||
            keys.some((key) => !["page", "per_page"].includes(key)) ||
            new Set(keys).size !== keys.length ||
            url.searchParams.get("per_page") !== "100" ||
            (url.searchParams.has("page") &&
              !/^(?:[1-9]|1[0-6])$/u.test(url.searchParams.get("page") ?? ""))
          )
            throw new Error("publication pagination escaped fixed inventory");
          return request(route);
        },
      },
      `${repository}/releases?per_page=100`,
      {
        select: (raw: unknown) => {
          if (!Array.isArray(raw) || raw.length > 100)
            throw new Error("release inventory incomplete");
          return raw as unknown[];
        },
        identity: (raw: unknown) => {
          if (!isRecord(raw) || !Number.isSafeInteger(raw.id))
            throw new Error("release identity missing");
          return String(raw.id);
        },
        label: "semantic review publication baseline",
      },
    )
    .map((raw: unknown) => {
      if (
        !isRecord(raw) ||
        typeof raw.draft !== "boolean" ||
        typeof raw.tag_name !== "string" ||
        !(
          raw.published_at === null ||
          (typeof raw.published_at === "string" && Number.isFinite(Date.parse(raw.published_at)))
        )
      )
        throw new Error("release publication facts incomplete");
      return {
        id: Number(raw.id),
        tag: raw.tag_name,
        draft: raw.draft,
        published_at: raw.published_at,
      };
    });
  const published = releases
    .filter((r) => !r.draft && r.published_at !== null)
    .sort((a, b) => String(b.published_at).localeCompare(String(a.published_at)));
  const selected = published[0];
  if (
    !selected ||
    selected.tag !== `v${expectedVersion}` ||
    (published[1] && published[1].published_at === selected.published_at)
  )
    throw new Error("latest publication differs from existing classification baseline");
  const ref = `${repository}/git/ref/tags/${encodeURIComponent(selected.tag)}`;
  const before = get(ref);
  if (
    !isRecord(before) ||
    before.ref !== `refs/tags/${selected.tag}` ||
    !isRecord(before.object) ||
    !oid(before.object.sha) ||
    !["tag", "commit"].includes(String(before.object.type))
  )
    throw new Error("publication tag identity unavailable");
  // Git's trusted local object parser peels raw tag objects; no filters/hooks or
  // candidate code are invoked. Fetching missing objects is a separate action.
  const commit = git(root, ["rev-parse", "--verify", `${before.object.sha}^{commit}`])
    .toString()
    .trim();
  const tree = git(root, ["rev-parse", "--verify", `${commit}^{tree}`])
    .toString()
    .trim();
  if (!oid(commit) || !oid(tree) || capacityDigest(get(ref)) !== capacityDigest(before))
    throw new Error("publication tag changed or cannot be resolved");
  const after = get(`${repository}/releases/${selected.id}`);
  if (
    !isRecord(after) ||
    after.id !== selected.id ||
    after.tag_name !== selected.tag ||
    after.draft !== false ||
    after.published_at !== selected.published_at
  )
    throw new Error("publication baseline changed during readback");
  const publishedSource =
    namespaceConfiguration === undefined
      ? null
      : inspectPublishedApplicationSource(api, namespaceConfiguration, {
          id: selected.id,
          version: expectedVersion,
          prepared_commit: commit,
          prepared_tree: tree,
        });
  if (
    publishedSource === null &&
    git(root, ["cat-file", "commit", commit]).includes(Buffer.from("Portcove-Preparation-SHA256:"))
  )
    throw new Error(
      "prepared publication requires the independently configured coordinator namespace",
    );
  return {
    repository_id: 1354613114,
    release_id: selected.id,
    tag: selected.tag,
    published_at: selected.published_at,
    tag_object: before.object.sha,
    commit,
    tree,
    source_baseline: publishedSource?.source_baseline ?? { commit, tree },
    published_source: publishedSource,
    qualification: "provider publication/tag identity readback; semantic review still required",
  };
}

/** Complete inert source snapshots. Original filenames exist only in JSON;
 * nothing is checked out, symlinked, imported or executed in the reviewer root.
 * Caller-provided classification/compatibility evidence remains labelled input,
 * not acceptance. The independent reviewer must explicitly decide it.
 */
export function prepareFrozenSemanticInputs(
  api: GitHubRestReader,
  root: string,
  rawOpportunity: unknown,
  evidence: { classification: unknown; compatibility: unknown },
  namespaceConfiguration?: { schema_version: 1; namespace: string },
) {
  const opportunity = validateOpportunity(structuredClone(rawOpportunity));
  const bundle = freezeSemanticSnapshots(
    api,
    root,
    opportunity,
    parseVersionClassification(opportunity.classification).base_version,
    evidence,
    namespaceConfiguration,
  );
  assertPreviewWithdrawalClassification(
    opportunity.classification,
    readPreviewWithdrawalSource(bundle),
  );
  prepared.set(bundle, bundle.bundle_sha256);
  return bundle;
}

/** Uses the same full Git-object collector and reader custody. Baseline and Core
 * facts are explicit inert inputs; their actual custody belongs to the caller. */
export function prepareFrozenCatalogSemanticInputs(
  api: GitHubRestReader,
  root: string,
  rawOpportunity: unknown,
  input: {
    inspection: Buffer;
    files: ReadonlyMap<string, Buffer>;
    prior_repository: ReadonlyMap<string, Buffer> | null;
  },
) {
  const opportunity = inspectCatalogSemanticOpportunity(structuredClone(rawOpportunity));
  if (
    !Buffer.isBuffer(input.inspection) ||
    !input.inspection.length ||
    input.inspection.length > 4 * 1024 ** 2
  )
    throw new Error("catalog frozen Core inspection bytes differ");
  const inspection = Buffer.from(input.inspection);
  if (
    createHash("sha256").update(inspection).digest("hex") !== opportunity.core_inspection_sha256 ||
    !Buffer.from(inspection.toString("utf8")).equals(inspection)
  )
    throw new Error("catalog frozen Core inspection bytes differ");
  const copyFiles = (
    values: ReadonlyMap<string, Buffer>,
    maximumFiles: number,
    maximumBytes: number,
  ) => {
    const captured = new Map<string, Buffer>();
    let total = 0;
    for (const [target, bytes] of values) {
      if (
        !Buffer.isBuffer(bytes) ||
        captured.has(target) ||
        captured.size >= maximumFiles ||
        bytes.length > 8 * 1024 ** 2 ||
        (total += bytes.length) > maximumBytes
      )
        throw new Error("catalog semantic capture exceeds reader bound");
      captured.set(target, Buffer.from(bytes));
    }
    return captured;
  };
  const files = copyFiles(input.files, 16385, 32 * 1024 ** 2);
  const inventory = (values: ReadonlyMap<string, Buffer>, key: "target" | "path") =>
    [...values]
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([target, bytes]) => ({
        [key]: target,
        bytes: bytes.length,
        sha256: createHash("sha256").update(bytes).digest("hex"),
      }));
  const report = inspectCatalogCoreReport(JSON.parse(inspection.toString("utf8")), files);
  if (
    capacityDigest(inventory(files, "target")) !== opportunity.bundle_sha256 ||
    report.index_sha256 !== opportunity.classification.index_sha256 ||
    capacityDigest(report.definitions) !== capacityDigest(opportunity.classification.definitions) ||
    (input.prior_repository === null) !== (opportunity.baseline.catalog_repository_sha256 === null)
  )
    throw new Error("catalog frozen inspection/classification/prior differs");
  const prior =
    input.prior_repository === null
      ? null
      : copyFiles(input.prior_repository, 20000, 128 * 1024 ** 2);
  if (
    prior &&
    capacityDigest(inventory(prior, "path")) !== opportunity.baseline.catalog_repository_sha256
  )
    throw new Error("catalog frozen prior repository bytes differ");
  const bundle = freezeSemanticSnapshots(
    api,
    root,
    opportunity,
    null,
    { classification: opportunity.classification, compatibility: opportunity.compatibility },
    undefined,
    opportunity.baseline,
  );
  const append = (
    snapshot: "catalog" | "catalog_prior",
    values: ReadonlyMap<string, Buffer>,
    totalMax: number,
  ) => {
    if (values.size > (snapshot === "catalog" ? 16385 : 20000))
      throw new Error("catalog semantic snapshot file count exceeds reader bound");
    let total = 0;
    const rows = [...values]
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([target, bytes]) => {
        const allowed =
          snapshot === "catalog"
            ? target === "definitions/index.json" ||
              /^sha256\/[a-f0-9]{64}\.json$/u.test(target) ||
              /^policy\/official\/[a-z0-9][a-z0-9-]*(?:\.launch)?\.json$/u.test(target)
            : /^(?:metadata\/[a-zA-Z0-9.-]+\.json|targets\/(?:[a-z0-9_.-]+\/)*[a-zA-Z0-9_.-]+)$/u.test(
                target,
              );
        const maximum =
          snapshot === "catalog"
            ? target.startsWith("policy/")
              ? 65536
              : 4 * 1024 ** 2
            : 8 * 1024 ** 2;
        if (
          !allowed ||
          target.split("/").some((part) => part === "." || part === "..") ||
          !bytes.length ||
          bytes.length > maximum ||
          (total += bytes.length) > totalMax
        )
          throw new Error("catalog semantic snapshot path/byte bound differs");
        const oid = createHash("sha1").update(`blob ${bytes.length}\0`).update(bytes).digest("hex");
        const name = `objects/${oid}.data`;
        if (!bundle.files.some((file) => file.name === name))
          bundle.files.push({
            name,
            bytes: Buffer.from(bytes),
            sha256: createHash("sha256").update(bytes).digest("hex"),
          });
        return { path: target, oid, mode: "100644" };
      });
    bundle.manifest.snapshots[snapshot] = rows;
  };
  append("catalog", files, 32 * 1024 ** 2);
  if (prior) append("catalog_prior", prior, 128 * 1024 ** 2);
  bundle.manifest.evidence = {
    ...bundle.manifest.evidence,
    core_inspection: {
      raw_utf8: inspection.toString("utf8"),
      sha256: opportunity.core_inspection_sha256,
    },
  };
  bundle.files.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  if (
    bundle.files.length > 20000 ||
    bundle.files.reduce((sum, file) => sum + file.bytes.length, 0) > 192 * 1024 ** 2
  )
    throw new Error("catalog review combined objects exceed existing reader bound");
  bundle.manifest.objects = bundle.files.map(({ name, sha256, bytes }) => ({
    name,
    sha256,
    bytes: bytes.length,
  }));
  if (Buffer.byteLength(JSON.stringify(bundle.manifest)) > 16 * 1024 ** 2)
    throw new Error("catalog review manifest exceeds existing bound");
  bundle.bundle_sha256 = capacityDigest(bundle.manifest);
  prepared.set(bundle, bundle.bundle_sha256);
  return bundle;
}

/** Neutral proposal input for the same selected independent runtime. The
 * request supplies exact source/baseline identities only. It cannot claim a
 * classification, compatibility, acceptance or a publishable review capture. */
export function prepareFrozenSemanticProposalInputs(
  api: GitHubRestReader,
  root: string,
  rawRequest: unknown,
  namespaceConfiguration?: { schema_version: 1; namespace: string },
) {
  const request = inspectReleaseReviewRequest(structuredClone(rawRequest));
  if (!request) throw new Error("exact frozen semantic review request required");
  const bundle = freezeSemanticSnapshots(
    api,
    root,
    request,
    request.base_version,
    {
      classification: "not yet proposed; no classification or acceptance authority",
      compatibility: "must be assessed from the complete inert source and existing contracts",
    },
    namespaceConfiguration,
  );
  readPreviewWithdrawalSource(bundle);
  proposalPrepared.set(bundle, bundle.bundle_sha256);
  return bundle;
}

type SemanticSourceIdentity = {
  base_commit: string;
  source_commit: string;
  source_tree: string;
  change_set_sha256: string;
};

function freezeSemanticSnapshots<T extends SemanticSourceIdentity>(
  api: GitHubRestReader,
  root: string,
  opportunity: T,
  baseVersion: string | null,
  evidence: { classification: unknown; compatibility: unknown; core_inspection?: unknown },
  namespaceConfiguration?: { schema_version: 1; namespace: string },
  catalogBaseline?: ReturnType<typeof inspectCatalogSemanticOpportunity>["baseline"],
) {
  const baseline = catalogBaseline
    ? {
        kind: "catalog-publication-baseline" as const,
        ...catalogBaseline,
        source_baseline: {
          commit: catalogBaseline.source_commit,
          tree: catalogBaseline.source_tree,
        },
        tree: catalogBaseline.source_tree,
        published_source: undefined,
      }
    : readSemanticPublicationBaseline(api, root, baseVersion!, namespaceConfiguration);
  if (baseline.source_baseline.commit !== opportunity.base_commit)
    throw new Error("opportunity omits accumulated publication delta");
  const source = readSemanticSourceChanges(api, root, opportunity);
  if (
    source.change_set_sha256 !== opportunity.change_set_sha256 ||
    source.source_tree !== opportunity.source_tree ||
    (catalogBaseline && source.base_tree !== catalogBaseline.source_tree)
  )
    throw new Error("review opportunity change set differs");
  for (const [commit, tree] of [
    [opportunity.base_commit, source.base_tree],
    [opportunity.source_commit, source.source_tree],
  ])
    if (
      git(root, ["rev-parse", "--verify", `${commit}^{tree}`])
        .toString()
        .trim() !== tree
    )
      throw new Error("local review tree differs from reconstructed provider tree");
  const snapshot = (commit: string) => {
    const rows = git(root, ["ls-tree", "-rz", "--full-tree", commit])
      .toString("utf8")
      .split("\0")
      .filter(Boolean);
    if (rows.length > 20000) throw new Error("review tree file bound exceeded");
    return rows.map((row) => {
      const match = /^(100644|100755) blob ([a-f0-9]{40})\t(.+)$/su.exec(row);
      if (!match || match[3]!.includes("\ufffd")) throw new Error("unsupported review tree entry");
      return { mode: match[1]!, oid: match[2]!, path: match[3]! };
    });
  };
  const snapshots: {
    baseline: ReturnType<typeof snapshot>;
    source: ReturnType<typeof snapshot>;
    published?: ReturnType<typeof snapshot>;
    catalog?: ReturnType<typeof snapshot>;
    catalog_prior?: ReturnType<typeof snapshot>;
  } = {
    baseline: snapshot(source.base_tree),
    source: snapshot(source.source_tree),
    ...(baseline.published_source?.kind === "verified-prepared-publication"
      ? { published: snapshot(baseline.tree) }
      : {}),
  };
  const objects = [
    ...new Set(
      Object.values(snapshots)
        .flat()
        .map((entry) => entry.oid),
    ),
  ].sort();
  if (objects.length > 20000) throw new Error("review object count exceeded");
  const inventory = git(root, ["cat-file", "--batch-check"], Buffer.from(objects.join("\n") + "\n"))
    .toString()
    .trim()
    .split("\n");
  let total = 0;
  if (inventory.length !== objects.length) throw new Error("review object preflight incomplete");
  for (const [index, row] of inventory.entries()) {
    const match = /^([a-f0-9]{40}) blob ([0-9]+)$/u.exec(row);
    const size = Number(match?.[2]);
    if (
      !match ||
      match[1] !== objects[index] ||
      !Number.isSafeInteger(size) ||
      size > 16 * 1024 * 1024 ||
      (total += size + 100) > 192 * 1024 * 1024
    )
      throw new Error("review object preflight exceeded bound");
  }
  const bytes = git(root, ["cat-file", "--batch"], Buffer.from(objects.join("\n") + "\n"));
  let cursor = 0;
  const files = objects.map((id) => {
    const end = bytes.indexOf(10, cursor);
    const match = /^([a-f0-9]{40}) blob ([0-9]+)$/u.exec(bytes.subarray(cursor, end).toString());
    if (end < cursor || !match || match[1] !== id) throw new Error("review blob batch differs");
    const size = Number(match[2]);
    if (!Number.isSafeInteger(size) || size > 16 * 1024 * 1024)
      throw new Error("review blob exceeds finite bound");
    cursor = end + 1;
    const blob = bytes.subarray(cursor, cursor + size);
    if (
      blob.length !== size ||
      bytes[cursor + size] !== 10 ||
      createHash("sha1").update(`blob ${size}\0`).update(blob).digest("hex") !== id
    )
      throw new Error("review blob bytes differ");
    cursor += size + 1;
    return {
      name: `objects/${id}.data`,
      bytes: blob,
      sha256: createHash("sha256").update(blob).digest("hex"),
    };
  });
  if (cursor !== bytes.length) throw new Error("review blob batch contains trailing data");
  const manifest = {
    schema_version: 1,
    opportunity,
    opportunity_sha256: capacityDigest(opportunity),
    baseline,
    source,
    snapshots,
    evidence: structuredClone(evidence),
    objects: files.map(({ name, sha256, bytes: blob }) => ({ name, sha256, bytes: blob.length })),
  };
  if (Buffer.byteLength(JSON.stringify(manifest)) > 16 * 1024 * 1024)
    throw new Error("review manifest exceeds bound");
  const bundle = { authority: "none", manifest, bundle_sha256: capacityDigest(manifest), files };
  return bundle;
}

const prepared = new WeakMap<object, string>();
const proposalPrepared = new WeakMap<object, string>();
export type FrozenSemanticSnapshot = ReturnType<
  typeof freezeSemanticSnapshots<SemanticSourceIdentity>
>;
export type FrozenSemanticAcceptanceBundle =
  | ReturnType<typeof prepareFrozenSemanticInputs>
  | ReturnType<typeof prepareFrozenCatalogSemanticInputs>;
/** Only builder-produced inputs may enter direct capture. Copy before any await;
 * callers cannot mutate the expected evidence during a review. */
export function requireFrozenSemanticInputs<T extends FrozenSemanticAcceptanceBundle>(bundle: T) {
  return requireFrozenSnapshot(bundle, prepared);
}

export function requireFrozenSemanticProposalInputs(
  bundle: ReturnType<typeof prepareFrozenSemanticProposalInputs>,
) {
  return requireFrozenSnapshot(bundle, proposalPrepared);
}

function requireFrozenSnapshot<T extends FrozenSemanticSnapshot>(
  bundle: T,
  originals: WeakMap<object, string>,
): T {
  if (
    originals.get(bundle) !== bundle.bundle_sha256 ||
    capacityDigest(bundle.manifest) !== bundle.bundle_sha256
  )
    throw new Error("imported or changed review bundle");
  const expected = new Map(bundle.manifest.objects.map((object) => [object.name, object]));
  if (expected.size !== bundle.manifest.objects.length || bundle.files.length !== expected.size)
    throw new Error("review manifest/object inventory differs");
  const seen = new Set<string>();
  const files = bundle.files.map((file) => {
    const object = expected.get(file.name);
    const match = /^objects\/([a-f0-9]{40})\.data$/u.exec(file.name);
    if (
      !object ||
      !match ||
      seen.has(file.name) ||
      object.bytes !== file.bytes.length ||
      object.sha256 !== file.sha256 ||
      createHash("sha256").update(file.bytes).digest("hex") !== object.sha256 ||
      createHash("sha1").update(`blob ${file.bytes.length}\0`).update(file.bytes).digest("hex") !==
        match[1]
    )
      throw new Error("review object differs from frozen manifest");
    seen.add(file.name);
    return { ...file, bytes: Buffer.from(file.bytes) };
  });
  for (const entry of Object.values(bundle.manifest.snapshots).flat())
    if (!seen.has(`objects/${entry.oid}.data`)) throw new Error("review snapshot object missing");
  return {
    authority: bundle.authority,
    manifest: structuredClone(bundle.manifest),
    bundle_sha256: bundle.bundle_sha256,
    files,
  } as T;
}
