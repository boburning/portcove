import { platforms } from "../apps/desktop/src/catalog-values.generated.ts";
import type { AuthoredPort } from "./catalog-authoring.mts";
import { isRecord } from "./runtime-values.mts";

function flatLayouts(record: AuthoredPort, reviewed: unknown) {
  const integration = record.integration;
  const release = integration?.release;
  const enrolled = integration?.platforms;
  const hints = integration?.executable_hints;
  if (
    integration?.adapter !== "native-portable" ||
    !isRecord(release) ||
    (release.provider !== undefined && release.provider !== "github") ||
    release.curated !== undefined ||
    typeof release.repository !== "string" ||
    !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u.test(release.repository) ||
    !isRecord(hints) ||
    !Array.isArray(enrolled) ||
    !Array.isArray(reviewed) ||
    !reviewed.length ||
    new Set(reviewed).size !== reviewed.length ||
    (!reviewed.includes("windows-x86-64") && !reviewed.includes("linux-x86-64"))
  )
    return undefined;

  const result: Record<string, { directories: string[]; executables: string[] }> = {};
  for (const platform of reviewed as unknown[]) {
    if (
      typeof platform !== "string" ||
      !platforms.some((known) => known === platform) ||
      !enrolled.includes(platform)
    )
      return undefined;
    const selected = hints[platform];
    if (!Array.isArray(selected) || selected.length !== 1) return undefined;
    const basename: unknown = selected[0];
    if (
      typeof basename !== "string" ||
      !/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/u.test(basename) ||
      (platform === "windows-x86-64" && !basename.toLowerCase().endsWith(".exe"))
    )
      return undefined;
    result[platform] = { directories: [], executables: [basename] };
  }
  return result;
}

export function projectReviewedFlatPackageLayout(record: AuthoredPort): AuthoredPort {
  if (record.reviewed_flat_package_layout_v1 === undefined) return record;
  if (record.integration && Object.hasOwn(record.integration, "reviewed_package_layouts"))
    throw new Error("The reviewed flat package layout already owns reviewed_package_layouts.");
  const layouts = flatLayouts(record, record.reviewed_flat_package_layout_v1);
  if (!layouts)
    throw new Error(
      "A reviewed flat package layout requires a managed GitHub archive with one root executable on each declared reviewed platform.",
    );
  return { ...record, integration: { ...record.integration, reviewed_package_layouts: layouts } };
}

export function compactReviewedFlatPackageLayout(record: AuthoredPort): AuthoredPort {
  if (record.reviewed_flat_package_layout_v1 !== undefined) return record;
  const { reviewed_package_layouts, ...integration } = record.integration ?? {};
  if (!isRecord(reviewed_package_layouts)) return record;
  const reviewed = Object.keys(reviewed_package_layouts);
  const projected = flatLayouts(record, reviewed);
  if (!projected) return record;
  if (
    JSON.stringify({ ...integration, reviewed_package_layouts: projected }) !==
    JSON.stringify(record.integration)
  )
    return record;
  return { ...record, reviewed_flat_package_layout_v1: reviewed, integration };
}
