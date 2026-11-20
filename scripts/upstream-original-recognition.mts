import { createHash } from "node:crypto";
import { orderedJsonSha256 } from "./json-values.mts";
import { isRecord } from "./runtime-values.mts";

const tablePath = "docs/supportedHashes.json";
const maximumTableBytes = 64 * 1024;
const maximumVariants = 256;
const gitSha = /^[a-f0-9]{40}$/u;
const artifactSha = /^[a-f0-9]{64}$/u;

type ReadGitHub = (endpoint: string) => Promise<unknown>;

/** Observed metadata for one exact published release, with artifact coverage from Core. */
export interface OriginalRecognitionTarget {
  repository: string;
  repository_id: number;
  release_id: number;
  release_tag: string;
  artifacts: { platform: string; sha256: string }[];
}

/** SHA-1 here is the upstream ROM identifier, never a replacement artifact integrity digest. */
export function parseSupportedOriginalHashes(contents: unknown) {
  if (
    !isRecord(contents) ||
    contents.type !== "file" ||
    contents.path !== tablePath ||
    contents.encoding !== "base64" ||
    typeof contents.sha !== "string" ||
    !gitSha.test(contents.sha) ||
    typeof contents.content !== "string" ||
    contents.content.length > maximumTableBytes * 2 ||
    typeof contents.size !== "number" ||
    !Number.isSafeInteger(contents.size) ||
    contents.size < 1 ||
    contents.size > maximumTableBytes
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
  const values: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(raw));
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
  return {
    source_path: tablePath,
    source_blob_sha1: blob,
    source_sha256: createHash("sha256").update(raw).digest("hex"),
    variants,
  };
}

async function readRecognitionTag(target: OriginalRecognitionTarget, read: ReadGitHub) {
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
  return { type: value.object.type, sha: value.object.sha };
}

/** Observe a family table at the selected tag's exact Git commit. No admission is derived here. */
export async function observeOriginalRecognition(
  target: OriginalRecognitionTarget,
  read: ReadGitHub,
) {
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
  let commit: Record<string, unknown> = tag;
  for (let depth = 0; commit.type === "tag" && depth < 4; depth++) {
    if (typeof commit.sha !== "string" || !gitSha.test(commit.sha))
      throw new Error("Original recognition tag object has an invalid identity");
    const annotated = await read(`${repository}/git/tags/${commit.sha}`);
    if (!isRecord(annotated) || annotated.sha !== commit.sha || !isRecord(annotated.object))
      throw new Error("Original recognition annotated tag does not bind its object");
    commit = annotated.object;
  }
  if (commit.type !== "commit" || typeof commit.sha !== "string" || !gitSha.test(commit.sha))
    throw new Error("Original recognition release does not resolve to a bounded exact commit");
  const document = parseSupportedOriginalHashes(
    await read(`${repository}/contents/${tablePath}?ref=${commit.sha}`),
  );
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
    parser: "libultraship-supported-hashes-v1",
    coverage: "recognition-only",
    ...target,
    source_tag_sha1: tag.sha,
    source_tag_type: tag.type,
    source_commit: commit.sha,
    ...document,
  } as const;
}

/** Reuse Core's current artifact selection. A fallback release supplies no new recognition target. */
export function selectOriginalRecognitionTarget(
  policy: Record<string, unknown>,
  repository: string,
  repositoryId: number,
): OriginalRecognitionTarget | undefined {
  if (!Array.isArray(policy.projections) || policy.projections.length > 12) return;
  const artifacts: OriginalRecognitionTarget["artifacts"] = [];
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

type ObservedOriginalRecognition = Awaited<ReturnType<typeof observeOriginalRecognition>>;

/** On a due refresh, verify the ref before reusing the immutable table. */
export async function revalidateOriginalRecognition(
  fact: ObservedOriginalRecognition,
  read: ReadGitHub,
): Promise<boolean> {
  const current = await readRecognitionTag(fact, read);
  return current.sha === fact.source_tag_sha1 && current.type === fact.source_tag_type;
}

export interface OriginalRecognitionProgress {
  state: string;
  last_complete: {
    binding: string;
    observed_at: string;
    fact: ObservedOriginalRecognition;
  } | null;
}

export function readOriginalRecognitionProgress(
  value: unknown,
  identity: { repository: string; repository_id: number },
): OriginalRecognitionProgress | undefined {
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
    fact.parser !== "libultraship-supported-hashes-v1" ||
    fact.coverage !== "recognition-only" ||
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
    fact.source_path !== tablePath ||
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
    ) ||
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
  const artifacts = (fact.artifacts as OriginalRecognitionTarget["artifacts"]).map(
    ({ platform, sha256 }) => ({ platform, sha256 }),
  );
  const variants = (fact.variants as ObservedOriginalRecognition["variants"]).map(
    ({ name, sha1 }) => ({ name, sha1 }),
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
    new Set(artifacts.map(({ platform }) => platform)).size !== artifacts.length ||
    new Set(variants.map(({ sha1 }) => sha1)).size !== variants.length
  )
    return;
  // Project only the bounded checked evidence fields. Old saved data can carry more keys.
  return {
    state: value.state,
    last_complete: {
      binding: complete.binding,
      observed_at: complete.observed_at,
      fact: {
        format_version: 1,
        parser: "libultraship-supported-hashes-v1",
        coverage: "recognition-only",
        ...target,
        source_tag_sha1: fact.source_tag_sha1,
        source_tag_type: fact.source_tag_type,
        source_commit: fact.source_commit,
        source_path: tablePath,
        source_blob_sha1: fact.source_blob_sha1,
        source_sha256: fact.source_sha256,
        variants,
      },
    },
  };
}
