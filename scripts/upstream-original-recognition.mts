import { createHash } from "node:crypto";
import { orderedJsonSha256 } from "./json-values.mts";
import { isRecord } from "./runtime-values.mts";
import {
  checkN64GameEntries,
  n64GameTablePath,
  parseN64GameTable,
} from "./upstream-n64-game-entry.mts";

import {
  n64RuntimeHashHeaderPaths,
  n64RuntimeHashLinkPath,
  n64RuntimeHashLinkRevision,
  n64RuntimeHashRepository,
  n64RuntimeHashRepositoryId,
  n64RuntimeInputPath,
  n64RuntimeLinkPath,
  n64RuntimeLinkRevision,
  n64RuntimeRepository,
  n64RuntimeRepositoryId,
  readN64RuntimeSourceObservation,
  type N64RuntimeHashSourceObservation,
  type N64RuntimeSourceObservation,
  inspectN64RuntimeSource,
} from "./upstream-n64-runtime-input.mts";

export type OriginalSourceFamily = "libultraship" | "n64-recomp";
const tablePath = "docs/supportedHashes.json";
const maximumTableBytes = 64 * 1024;
const maximumVariants = 256;
const gitSha = /^[a-f0-9]{40}$/u;
const artifactSha = /^[a-f0-9]{64}$/u;

type ReadGitHub = (endpoint: string) => Promise<unknown>;

/** Observed metadata for one exact published release, with artifact coverage from Core. */
export interface OriginalSourceTarget {
  repository: string;
  repository_id: number;
  release_id: number;
  release_tag: string;
  artifacts: { platform: string; sha256: string }[];
}

function readReleaseSourceFile(contents: unknown, path: string, maximumBytes = maximumTableBytes) {
  if (
    !isRecord(contents) ||
    contents.type !== "file" ||
    contents.path !== path ||
    contents.encoding !== "base64" ||
    typeof contents.sha !== "string" ||
    !gitSha.test(contents.sha) ||
    typeof contents.content !== "string" ||
    contents.content.length > maximumBytes * 2 ||
    typeof contents.size !== "number" ||
    !Number.isSafeInteger(contents.size) ||
    contents.size < 1 ||
    contents.size > maximumBytes
  )
    throw new Error("Upstream original recognition metadata is incomplete or exceeds its limit");
  const encoded = contents.content.replaceAll("\n", "");
  const raw = Buffer.from(encoded, "base64");
  if (raw.length !== contents.size || raw.toString("base64") !== encoded)
    throw new Error(
      "Upstream original recognition bytes differ from their declared encoding or size",
    );
  const blob = createHash("sha1").update(`blob ${raw.length}\0`).update(raw).digest("hex");
  if (blob !== contents.sha)
    throw new Error("Upstream original recognition bytes differ from their declared Git object");
  return {
    source_path: path,
    source_blob_sha1: blob,
    source_sha256: createHash("sha256").update(raw).digest("hex"),
    text: new TextDecoder("utf-8", { fatal: true }).decode(raw),
  };
}

/** SHA-1 here is the upstream ROM identifier, never a replacement artifact integrity digest. */
export function parseSupportedOriginalHashes(contents: unknown) {
  const { text, ...source } = readReleaseSourceFile(contents, tablePath);
  const values: unknown = JSON.parse(text);
  if (!Array.isArray(values) || values.length === 0 || values.length > maximumVariants)
    throw new Error("Upstream original recognition table has an unsupported shape or count");
  const hashes = new Set<string>();
  const variants = values.map((row: unknown) => {
    if (
      !isRecord(row) ||
      Object.keys(row).length !== 2 ||
      typeof row.name !== "string" ||
      !row.name.trim() ||
      row.name.length > 256 ||
      /\p{Cc}/u.test(row.name) ||
      typeof row.sha1 !== "string" ||
      !gitSha.test(row.sha1) ||
      hashes.has(row.sha1)
    )
      throw new Error("Upstream original recognition table contains an invalid or repeated entry");
    hashes.add(row.sha1);
    return { name: row.name, sha1: row.sha1 };
  });
  return { ...source, variants };
}

function parseN64ReleaseSource(contents: unknown) {
  const { text, ...source } = readReleaseSourceFile(contents, n64GameTablePath);
  return { ...source, games: parseN64GameTable(text) };
}

export function inputEvidenceKey(family: OriginalSourceFamily) {
  return family === "libultraship" ? "original_recognition" : "n64_game_entries";
}

async function readRecognitionTag(target: OriginalSourceTarget, read: ReadGitHub) {
  const path = `/repos/${target.repository}/git/ref/tags/${encodeURIComponent(target.release_tag)}`;
  const value = await read(path);
  if (
    !isRecord(value) ||
    value.ref !== `refs/tags/${target.release_tag}` ||
    !isRecord(value.object) ||
    (value.object.type !== "tag" && value.object.type !== "commit") ||
    typeof value.object.sha !== "string" ||
    !gitSha.test(value.object.sha)
  )
    throw new Error("Provider returned a different original recognition release tag");
  return { type: value.object.type, sha: value.object.sha } as const;
}

type SourceIdentity = OriginalSourceTarget & {
  format_version: 1;
  source_tag_sha1: string;
  source_tag_type: "commit" | "tag";
  source_commit: string;
};

type LibultrashipEvidence = SourceIdentity &
  ReturnType<typeof parseSupportedOriginalHashes> & {
    parser: "libultraship-supported-hashes-v1";
    coverage: "recognition-only";
  };

type N64Evidence = SourceIdentity &
  ReturnType<typeof parseN64ReleaseSource> & {
    parser: "n64-recomp-game-entry-v1";
    coverage: "source-declaration";
    runtime_source?: N64RuntimeSourceObservation;
  };

type ObservedOriginalSource = LibultrashipEvidence | N64Evidence;

async function resolveRecognitionCommit(
  repository: string,
  tag: Awaited<ReturnType<typeof readRecognitionTag>>,
  read: ReadGitHub,
) {
  let object: Record<string, unknown> = tag;
  for (let depth = 0; object.type === "tag" && depth < 4; depth++) {
    if (typeof object.sha !== "string" || !gitSha.test(object.sha))
      throw new Error("Original recognition tag object has an invalid identity");
    const annotated = await read(`${repository}/git/tags/${object.sha}`);
    if (!isRecord(annotated) || annotated.sha !== object.sha || !isRecord(annotated.object))
      throw new Error("Original recognition annotated tag does not bind its object");
    object = annotated.object;
  }
  if (object.type !== "commit" || typeof object.sha !== "string" || !gitSha.test(object.sha))
    throw new Error("Original recognition release does not resolve to a bounded exact commit");
  return object.sha;
}

/** Observe a family table at the selected tag's exact Git commit. */
export function observeOriginalSource(
  target: OriginalSourceTarget,
  read: ReadGitHub,
): Promise<LibultrashipEvidence>;
export function observeOriginalSource(
  target: OriginalSourceTarget,
  read: ReadGitHub,
  family: OriginalSourceFamily,
): Promise<ObservedOriginalSource>;
export async function observeOriginalSource(
  target: OriginalSourceTarget,
  read: ReadGitHub,
  family: OriginalSourceFamily = "libultraship",
): Promise<ObservedOriginalSource> {
  if (
    !/^[A-Za-z0-9][A-Za-z0-9_.-]*\/[A-Za-z0-9][A-Za-z0-9_.-]*$/u.test(target.repository) ||
    !Number.isSafeInteger(target.repository_id) ||
    target.repository_id < 1 ||
    !Number.isSafeInteger(target.release_id) ||
    target.release_id < 1 ||
    !target.release_tag.length ||
    target.release_tag.length > 256 ||
    /\p{Cc}/u.test(target.release_tag) ||
    !target.artifacts.length ||
    target.artifacts.length > 12 ||
    target.artifacts.some((entry) => !artifactSha.test(entry.sha256))
  )
    throw new Error(
      "Original recognition observation needs an exact repository, release and artifact",
    );
  const repository = `/repos/${target.repository}`;
  const tag = await readRecognitionTag(target, read);
  const commit = await resolveRecognitionCommit(repository, tag, read);
  const path = family === "libultraship" ? tablePath : n64GameTablePath;
  const contents = await read(`${repository}/contents/${path}?ref=${commit}`);
  const declaration =
    family === "libultraship"
      ? ({
          parser: "libultraship-supported-hashes-v1",
          coverage: "recognition-only",
          ...parseSupportedOriginalHashes(contents),
        } as const)
      : ({
          parser: "n64-recomp-game-entry-v1",
          coverage: "source-declaration",
          ...parseN64ReleaseSource(contents),
        } as const);
  const confirmed = await readRecognitionTag(target, read);
  if (confirmed.sha !== tag.sha || confirmed.type !== tag.type)
    throw new Error("Original recognition release tag changed during observation");
  const identity = await read(repository);
  if (
    !isRecord(identity) ||
    identity.id !== target.repository_id ||
    identity.full_name !== target.repository
  )
    throw new Error("Original recognition repository identity changed during observation");
  return {
    format_version: 1,
    ...target,
    source_tag_sha1: tag.sha,
    source_tag_type: tag.type,
    source_commit: commit,
    ...declaration,
  } as const;
}

export function n64RuntimeSourceCache() {
  return {
    links: new Map<string, string | null>(),
    sources: new Map<string, ReturnType<typeof inspectN64RuntimeSource>>(),
    identity_verified: false,
    hash_links: new Map<string, string | null>(),
    hash_sources: new Map<
      string,
      Extract<N64RuntimeHashSourceObservation, { state: "observed" }>
    >(),
    hash_identity_verified: false,
  };
}

/** Observe the dependency pinned by the release source, using the same request budget. */
export async function observeN64RuntimeSource(
  fact: Pick<N64Evidence, "repository" | "repository_id" | "source_commit">,
  read: ReadGitHub,
  cache: ReturnType<typeof n64RuntimeSourceCache>,
): Promise<N64RuntimeSourceObservation> {
  const linkKey = `${fact.repository_id}:${fact.source_commit}`;
  let revision = cache.links.get(linkKey);
  if (revision === undefined) {
    revision = n64RuntimeLinkRevision(
      await read(
        `/repos/${fact.repository}/contents/${n64RuntimeLinkPath}?ref=${fact.source_commit}`,
      ),
    );
    if (revision === undefined) return { state: "unavailable" };
    cache.links.set(linkKey, revision);
  }
  if (revision === null) return { state: "unsupported-gitlink" };

  const repository = `/repos/${n64RuntimeRepository}`;
  if (!cache.identity_verified) {
    const identity = await read(repository);
    if (
      !isRecord(identity) ||
      identity.id !== n64RuntimeRepositoryId ||
      identity.full_name !== n64RuntimeRepository
    )
      throw new Error("N64 runtime dependency repository identity is unavailable");
    cache.identity_verified = true;
  }
  let source = cache.sources.get(revision);
  if (!source) {
    const contents = await read(`${repository}/contents/${n64RuntimeInputPath}?ref=${revision}`);
    source = inspectN64RuntimeSource(
      revision,
      readReleaseSourceFile(contents, n64RuntimeInputPath),
    );
    cache.sources.set(revision, source);
  }
  return { state: "observed", source };
}

export async function observeN64RuntimeHashSource(
  runtimeRevision: string,
  read: ReadGitHub,
  cache: ReturnType<typeof n64RuntimeSourceCache>,
): Promise<N64RuntimeHashSourceObservation> {
  let revision = cache.hash_links.get(runtimeRevision);
  if (revision === undefined) {
    revision = n64RuntimeHashLinkRevision(
      await read(
        `/repos/${n64RuntimeRepository}/contents/${n64RuntimeHashLinkPath}?ref=${runtimeRevision}`,
      ),
    );
    if (revision === undefined) return { state: "unavailable" };
    cache.hash_links.set(runtimeRevision, revision);
  }
  if (revision === null) return { state: "unsupported-gitlink" };
  const retained = cache.hash_sources.get(revision);
  if (retained) return retained;

  const repository = `/repos/${n64RuntimeHashRepository}`;
  if (!cache.hash_identity_verified) {
    const identity = await read(repository);
    if (
      !isRecord(identity) ||
      identity.id !== n64RuntimeHashRepositoryId ||
      identity.full_name !== n64RuntimeHashRepository
    )
      throw new Error("N64 runtime hash dependency repository identity is unavailable");
    cache.hash_identity_verified = true;
  }
  const observed: Extract<N64RuntimeHashSourceObservation, { state: "observed" }> = {
    state: "observed",
    repository: n64RuntimeHashRepository,
    repository_id: n64RuntimeHashRepositoryId,
    revision,
    headers: [],
  };
  for (const path of n64RuntimeHashHeaderPaths) {
    const file = await read(`${repository}/contents/${path}?ref=${revision}`);
    const { source_blob_sha1, source_sha256 } = readReleaseSourceFile(file, path, 512 * 1024);
    observed.headers.push({ source_path: path, source_blob_sha1, source_sha256 });
  }
  cache.hash_sources.set(revision, observed);
  return observed;
}

/** Reuse Core's current artifact selection. A fallback release supplies no new recognition target. */
export function selectOriginalSourceTarget(
  policy: Record<string, unknown>,
  repository: string,
  repositoryId: number,
): OriginalSourceTarget | undefined {
  if (!Array.isArray(policy.projections) || policy.projections.length > 12) return;
  const artifacts: OriginalSourceTarget["artifacts"] = [];
  let releaseId: number | undefined;
  let releaseTag: string | undefined;
  for (const row of policy.projections as unknown[]) {
    if (
      !isRecord(row) ||
      row.channel !== "stable" ||
      typeof row.platform !== "string" ||
      !isRecord(row.channel_candidate) ||
      !isRecord(row.latest_eligible) ||
      !isRecord(row.latest_eligible.release) ||
      !isRecord(row.latest_eligible.release.asset)
    )
      continue;
    const candidate = row.channel_candidate;
    const selected = row.latest_eligible;
    const release = selected.release as Record<string, unknown>;
    const asset = release.asset as Record<string, unknown>;
    if (
      typeof candidate.id !== "number" ||
      !Number.isSafeInteger(candidate.id) ||
      candidate.id < 1 ||
      typeof candidate.tag !== "string" ||
      selected.release_id !== candidate.id ||
      release.version !== candidate.tag ||
      typeof asset.sha256 !== "string" ||
      !artifactSha.test(asset.sha256)
    )
      continue;
    if (releaseId !== undefined && (releaseId !== candidate.id || releaseTag !== candidate.tag))
      return;
    releaseId = candidate.id;
    releaseTag = candidate.tag;
    artifacts.push({ platform: row.platform, sha256: asset.sha256 });
  }
  if (releaseId === undefined || releaseTag === undefined) return;
  return {
    repository,
    repository_id: repositoryId,
    release_id: releaseId,
    release_tag: releaseTag,
    artifacts: artifacts.sort((a, b) => a.platform.localeCompare(b.platform)),
  };
}

/** On a due refresh, verify the ref before reusing the immutable table. */
export async function revalidateOriginalSource(
  fact: ObservedOriginalSource,
  read: ReadGitHub,
): Promise<boolean> {
  const current = await readRecognitionTag(fact, read);
  if (current.sha !== fact.source_tag_sha1 || current.type !== fact.source_tag_type) return false;
  if (current.type === "commit") return current.sha === fact.source_commit;
  if (fact.parser === "n64-recomp-game-entry-v1")
    return (
      (await resolveRecognitionCommit(`/repos/${fact.repository}`, current, read)) ===
      fact.source_commit
    );
  return true;
}

export interface OriginalSourceProgress {
  state: string;
  last_complete: {
    binding: string;
    observed_at: string;
    fact: ObservedOriginalSource;
  } | null;
}

export function readOriginalSourceProgress(
  value: unknown,
  identity: { repository: string; repository_id: number },
  family: OriginalSourceFamily = "libultraship",
): OriginalSourceProgress | undefined {
  if (
    !isRecord(value) ||
    typeof value.state !== "string" ||
    !/^[a-z][a-z0-9-]{0,63}$/u.test(value.state)
  )
    return;
  if (value.last_complete === null) return { state: value.state, last_complete: null };
  const complete = value.last_complete;
  if (
    !isRecord(complete) ||
    typeof complete.binding !== "string" ||
    !artifactSha.test(complete.binding) ||
    typeof complete.observed_at !== "string" ||
    !Number.isFinite(Date.parse(complete.observed_at)) ||
    !isRecord(complete.fact)
  )
    return;
  const fact = complete.fact;
  if (
    fact.format_version !== 1 ||
    fact.repository !== identity.repository ||
    fact.repository_id !== identity.repository_id ||
    !Number.isSafeInteger(fact.release_id) ||
    Number(fact.release_id) < 1 ||
    typeof fact.release_tag !== "string" ||
    !fact.release_tag.length ||
    fact.release_tag.length > 256 ||
    /\p{Cc}/u.test(fact.release_tag) ||
    typeof fact.source_tag_sha1 !== "string" ||
    !gitSha.test(fact.source_tag_sha1) ||
    (fact.source_tag_type !== "commit" && fact.source_tag_type !== "tag") ||
    typeof fact.source_commit !== "string" ||
    !gitSha.test(fact.source_commit) ||
    (fact.source_tag_type === "commit" && fact.source_commit !== fact.source_tag_sha1) ||
    typeof fact.source_blob_sha1 !== "string" ||
    !gitSha.test(fact.source_blob_sha1) ||
    typeof fact.source_sha256 !== "string" ||
    !artifactSha.test(fact.source_sha256) ||
    !Array.isArray(fact.artifacts) ||
    fact.artifacts.length < 1 ||
    fact.artifacts.length > 12 ||
    !fact.artifacts.every(
      (artifact: unknown) =>
        isRecord(artifact) &&
        typeof artifact.platform === "string" &&
        /^(?:windows-x86-64|linux-x86-64|macos-x86-64|macos-aarch64)$/u.test(artifact.platform) &&
        typeof artifact.sha256 === "string" &&
        artifactSha.test(artifact.sha256),
    )
  )
    return;
  const artifacts = (fact.artifacts as OriginalSourceTarget["artifacts"]).map(
    ({ platform, sha256 }) => ({ platform, sha256 }),
  );
  const target = {
    repository: identity.repository,
    repository_id: identity.repository_id,
    release_id: Number(fact.release_id),
    release_tag: fact.release_tag,
    artifacts,
  };
  if (
    complete.binding !== orderedJsonSha256(target) ||
    new Set(artifacts.map(({ platform }) => platform)).size !== artifacts.length
  )
    return;
  const source = {
    format_version: 1,
    ...target,
    source_tag_sha1: fact.source_tag_sha1,
    source_tag_type: fact.source_tag_type,
    source_commit: fact.source_commit,
    source_blob_sha1: fact.source_blob_sha1,
    source_sha256: fact.source_sha256,
  } as const;
  let evidence: ObservedOriginalSource;
  if (family === "n64-recomp") {
    const games = checkN64GameEntries(fact.games);
    if (
      fact.parser !== "n64-recomp-game-entry-v1" ||
      fact.coverage !== "source-declaration" ||
      fact.source_path !== n64GameTablePath ||
      !games
    )
      return;
    const runtime = readN64RuntimeSourceObservation(fact.runtime_source);
    evidence = {
      ...source,
      parser: fact.parser,
      coverage: fact.coverage,
      source_path: n64GameTablePath,
      games,
      ...(runtime ? { runtime_source: runtime } : {}),
    };
  } else {
    if (
      fact.parser !== "libultraship-supported-hashes-v1" ||
      fact.coverage !== "recognition-only" ||
      fact.source_path !== tablePath ||
      !Array.isArray(fact.variants) ||
      fact.variants.length < 1 ||
      fact.variants.length > maximumVariants ||
      !fact.variants.every(
        (variant: unknown) =>
          isRecord(variant) &&
          typeof variant.name === "string" &&
          !!variant.name.trim() &&
          variant.name.length <= 256 &&
          !/\p{Cc}/u.test(variant.name) &&
          typeof variant.sha1 === "string" &&
          gitSha.test(variant.sha1),
      )
    )
      return;
    const variants = (fact.variants as LibultrashipEvidence["variants"]).map(({ name, sha1 }) => ({
      name,
      sha1,
    }));
    if (new Set(variants.map(({ sha1 }) => sha1)).size !== variants.length) return;
    evidence = {
      ...source,
      parser: fact.parser,
      coverage: fact.coverage,
      source_path: tablePath,
      variants,
    };
  }
  return {
    state: value.state,
    last_complete: {
      binding: complete.binding,
      observed_at: complete.observed_at,
      fact: evidence,
    },
  };
}
