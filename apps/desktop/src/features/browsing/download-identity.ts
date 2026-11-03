import type { CatalogDownloadCandidate, PendingSetupRecord } from "../../types";

export type ReleaseReference = CatalogDownloadCandidate["release_id"];
type AssetReference = CatalogDownloadCandidate["asset_id"];

function positive(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

function object(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function tag(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    !/[\ud800-\udfff]/u.test(value) &&
    new TextEncoder().encode(value).length <= 512 &&
    !Array.from(value).some((character) => {
      const code = character.charCodeAt(0);
      return code < 32 || (code >= 127 && code <= 159);
    })
  );
}

export function isReleaseReference(value: unknown): value is ReleaseReference {
  return (
    positive(value) ||
    (object(value) &&
      Object.keys(value).sort().join(",") === "project_id,provider,tag" &&
      value.provider === "gitlab" &&
      positive(value.project_id) &&
      tag(value.tag))
  );
}

export function isAssetReference(value: unknown): value is AssetReference {
  return (
    positive(value) ||
    (object(value) &&
      Object.keys(value).sort().join(",") === "file_id,link_id,project_id,provider,tag" &&
      value.provider === "gitlab" &&
      positive(value.project_id) &&
      positive(value.link_id) &&
      positive(value.file_id) &&
      tag(value.tag))
  );
}

export function releaseKey(value: ReleaseReference): string {
  return typeof value === "number"
    ? String(value)
    : `gitlab:${JSON.stringify([value.project_id, value.tag])}`;
}

function assetReferenceKey(value: AssetReference): string {
  return typeof value === "number"
    ? String(value)
    : `gitlab:${JSON.stringify([value.project_id, value.tag, value.link_id, value.file_id])}`;
}

export function sameAsset(
  left: AssetReference | null | undefined,
  right: AssetReference | null | undefined,
) {
  return left != null && right != null && assetReferenceKey(left) === assetReferenceKey(right);
}

export function matchingReferences(release: unknown, asset: unknown): boolean {
  if (!isReleaseReference(release) || !isAssetReference(asset)) return false;
  if (typeof release === "number") return typeof asset === "number";
  return (
    typeof asset !== "number" &&
    release.project_id === asset.project_id &&
    release.tag === asset.tag
  );
}

export function validCandidate(candidate: CatalogDownloadCandidate): boolean {
  return (
    matchingReferences(candidate.release_id, candidate.asset_id) &&
    (typeof candidate.release_id === "number" || candidate.release_id.tag === candidate.release_tag)
  );
}

export function assetKey(candidate: CatalogDownloadCandidate): string {
  return typeof candidate.release_id === "number"
    ? `${candidate.release_id}:${assetReferenceKey(candidate.asset_id)}`
    : assetReferenceKey(candidate.asset_id);
}

export function validPackageKey(value: string, legacy = false): boolean {
  if (value === "") return true;
  if (/^[1-9][0-9]*:[1-9][0-9]*$/u.test(value))
    return value.split(":").every((part) => positive(Number(part)));
  if (legacy || !value.startsWith("gitlab:")) return false;
  try {
    const parts: unknown = JSON.parse(value.slice(7));
    if (!Array.isArray(parts) || parts.length !== 4) return false;
    const tuple: readonly unknown[] = parts;
    const [project_id, releaseTag, link_id, file_id] = tuple;
    const asset = { provider: "gitlab", project_id, tag: releaseTag, link_id, file_id };
    return isAssetReference(asset) && assetReferenceKey(asset) === value;
  } catch {
    return false;
  }
}

export function readablePendingRecord(record: PendingSetupRecord): boolean {
  const version = record.format_version === undefined ? 1 : record.format_version;
  return (
    validCandidate(record.artifact) &&
    ((version === 1 && typeof record.artifact.release_id === "number") ||
      (version === 2 &&
        typeof record.artifact.release_id !== "number" &&
        typeof record.artifact.sha256 === "string" &&
        /^[0-9a-f]{64}$/iu.test(record.artifact.sha256)))
  );
}
