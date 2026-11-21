import type { CatalogPort } from "./catalog-authoring.mts";
import { isRecord } from "./runtime-values.mts";

const platformMaps = ["curated", "direct", "managed_build", "user_prepared"] as const;

const scopedStepTitle =
  /\b(?:external|existing|retained|historical|previous|older|pinned|dependency|dependencies|requirements|abi)\b/iu;
const externalOwnership =
  /outside (?:your |the )?portcove library|\b(?:a|the) copy you (?:manage|own)\b/iu;
const exactTagAction =
  /^(?:choose|select|pick|open|use) (?:the )?(?:official )?release (?:tagged|tag) [`"']?([\w./+-]+)[`"']?$/iu;
const exactLinkAction =
  /^(?:choose|select|pick|open|use|download|get) (?:(?:the )?(?:official )?(?:release asset|release|asset|package|archive) (?:at|from) )?[`"']?(https:\/\/[^\s`"']+)[`"']?$/iu;
const exactAssetAction = /^(?:download|get) (?:the )?[`"']?([\w.+-]+)[`"']?$/iu;
const versionInAsset = /(?:^|[-_])v?\d+(?:\.\d+){1,3}(?=[-_.]|$)/iu;

const plainSegment = /^[\w.+-]+$/u;

function githubReleaseLiteral(url: string, repository: string) {
  const path =
    /^https:\/\/github\.com\/([\w.-]+\/[\w.-]+)\/releases\/(tag|download)\/([\w.%+/-]+)$/u.exec(
      url,
    );
  if (!path || path[1]?.toLowerCase() !== repository.toLowerCase()) return undefined;
  const [, , area, suffix] = path;
  if (!suffix) return undefined;
  const segments = suffix.split("/");
  const asset = area === "download" ? segments.pop() : undefined;
  if (
    area === "download" &&
    (!asset || !plainSegment.test(asset) || asset === "." || asset === "..")
  )
    return undefined;

  // The release tag can have literal path separators or one encoded tag segment.
  // Decode slash only within that tag and never normalize repo or asset paths.
  if (segments.length > 1 && segments.some((segment) => segment.includes("%"))) return undefined;
  const tag = segments.join("/").replace(/%2f/giu, "/");
  if (
    tag
      .split("/")
      .some((segment) => !plainSegment.test(segment) || segment === "." || segment === "..")
  )
    return undefined;
  return { tag, asset };
}

/** Detect explicit package choices in current managed guide actions. This is authoring feedback. */
export function managedSetupReleaseAdvice(
  port: CatalogPort | undefined,
  listingReleaseUrl?: string,
) {
  const release = port?.release;
  const presentation = port?.presentation;
  const guide = presentation?.manual_setup;
  if (
    !isRecord(release) ||
    (release.provider !== undefined && release.provider !== "github") ||
    typeof release.repository !== "string" ||
    release.rolling_tag != null ||
    platformMaps.some((field) => {
      const model = release[field];
      return isRecord(model) && Object.keys(model).length > 0;
    }) ||
    presentation?.installation_method === "upstream-setup" ||
    presentation?.installation_method === "user-prepared-runtime" ||
    !isRecord(guide) ||
    !Array.isArray(guide.steps)
  )
    return [];

  const repository = release.repository;
  const listingRelease =
    listingReleaseUrl === undefined
      ? undefined
      : githubReleaseLiteral(listingReleaseUrl, repository);
  const hints = isRecord(release.asset_hints)
    ? Object.values(release.asset_hints).flatMap((assets) =>
        Array.isArray(assets)
          ? assets.filter((asset: unknown): asset is string => typeof asset === "string")
          : [],
      )
    : [];
  return guide.steps.flatMap((step, index) => {
    if (
      !isRecord(step) ||
      typeof step.title !== "string" ||
      typeof step.instruction !== "string" ||
      scopedStepTitle.test(step.title) ||
      externalOwnership.test(step.instruction)
    )
      return [];

    const matches = new Map<string, "release tag" | "repository asset">();
    for (const sentence of step.instruction.split(/(?<=[.!?])\s+/u)) {
      const action = sentence.trim().replace(/[.!?]$/u, "");
      const namedTag = exactTagAction.exec(action)?.[1];
      if (listingRelease && namedTag === listingRelease.tag && listingRelease.asset === undefined)
        matches.set(listingRelease.tag, "release tag");

      const link = exactLinkAction.exec(action)?.[1];
      if (link) {
        const parsed = githubReleaseLiteral(link, repository);
        if (parsed)
          matches.set(link, parsed.asset === undefined ? "release tag" : "repository asset");
      }

      const asset = exactAssetAction.exec(action)?.[1];
      if (asset && versionInAsset.test(asset) && hints.includes(asset))
        matches.set(asset, "repository asset");
    }
    return [...matches].map(([literal, kind]) => ({
      step: index + 1,
      kind,
      literal,
    }));
  });
}

export const managedSetupReleaseAdviceText =
  "Review whether current managed setup can use the selected release or asset. Keep intentional pins, version-specific requirements, and historical evidence.";
