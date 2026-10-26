import { isRecord } from "../../../scripts/runtime-values.mts";
import type { SemVer } from "semver";
// Offline repository release policy. This module is not imported by the renderer
// or a runtime updater; authenticated feed ownership remains at the Tauri host.
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
// Control-plane imports need no version runtime; version calls retain its original load failure.
let semverLoadFailure: unknown;
const semver = await import("semver").then(
  (module) => module.default,
  (error: unknown) => {
    semverLoadFailure = error;
    return undefined;
  },
);
function semverRuntime() {
  if (!semver) throw semverLoadFailure;
  return semver;
}

function diagnosticText(value: unknown): string {
  return String(value);
}
function exactVersion(value: unknown) {
  if (typeof value !== "string") throw new Error("application version must be a SemVer string");
  const parsed = semverRuntime().parse(value);
  if (!parsed) throw new Error(`invalid application version: ${value}`);
  const canonical = `${parsed.major}.${parsed.minor}.${parsed.patch}${parsed.prerelease.length ? `-${parsed.prerelease.join(".")}` : ""}${parsed.build.length ? `+${parsed.build.join(".")}` : ""}`;
  if (value !== canonical) throw new Error(`application version must be canonical: ${value}`);
  return parsed;
}

export function classifyApplicationVersion(version: unknown, productionEligible: unknown = false) {
  const parsed = exactVersion(version);
  if (typeof productionEligible !== "boolean")
    throw new Error("production eligibility must be explicit boolean evidence");
  if (productionEligible && (parsed.major === 0 || parsed.prerelease.length)) {
    throw new Error("0.x and prerelease versions cannot be production eligible");
  }
  return {
    version: parsed.raw,
    github_prerelease: !productionEligible,
    channels: productionEligible ? ["preview", "stable"] : ["preview"],
  };
}

export function compareApplicationVersionPrecedence(left: unknown, right: unknown) {
  return semverRuntime().compare(exactVersion(left), exactVersion(right));
}

function field(release: unknown, camel: string, snake: string) {
  return isRecord(release) ? (release[camel] ?? release[snake]) : undefined;
}

function publishedRelease<Release>(release: Release) {
  if (field(release, "isDraft", "draft") !== false) return null;
  const githubPrerelease = field(release, "isPrerelease", "prerelease");
  if (typeof githubPrerelease !== "boolean")
    throw new Error("published release is missing its prerelease flag");
  const tag = field(release, "tagName", "tag_name");
  if (typeof tag !== "string" || !tag.startsWith("v"))
    throw new Error("published application release must have a version tag");
  const version = tag.slice(1);
  const parsed = exactVersion(version);
  const publishedAt = field(release, "publishedAt", "published_at");
  if (typeof publishedAt !== "string" || Number.isNaN(Date.parse(publishedAt)))
    throw new Error(
      `published release has an invalid published timestamp: ${diagnosticText(publishedAt ?? "missing")}`,
    );
  return { release, tag, version, parsed, githubPrerelease };
}

interface Eligibility {
  version: string;
  preview_eligible: boolean;
  production_eligible: boolean;
  held?: boolean;
  withdrawn?: boolean;
  targets?: unknown;
}
type Candidate<Release> = NonNullable<ReturnType<typeof publishedRelease<Release>>>;
function eligibilityEvidence(
  candidate: { tag: string; version: string },
  evidence: unknown,
): Eligibility | undefined {
  const { tag, version } = candidate;
  if (
    evidence &&
    (!isRecord(evidence) ||
      evidence.version !== version ||
      typeof evidence.preview_eligible !== "boolean" ||
      typeof evidence.production_eligible !== "boolean")
  ) {
    throw new Error(`invalid release eligibility evidence for ${tag}`);
  }
  if (!evidence) return undefined;
  if (!isRecord(evidence)) throw new Error(`invalid release eligibility evidence for ${tag}`);
  if (
    ["held", "withdrawn"].some(
      (key) => evidence[key] !== undefined && typeof evidence[key] !== "boolean",
    ) ||
    (evidence.production_eligible && !evidence.preview_eligible)
  )
    throw new Error(`inconsistent release eligibility evidence for ${tag}`);
  if (
    evidence.version !== version ||
    typeof evidence.preview_eligible !== "boolean" ||
    typeof evidence.production_eligible !== "boolean"
  )
    throw new Error(`invalid release eligibility evidence for ${tag}`);
  return {
    version,
    preview_eligible: evidence.preview_eligible,
    production_eligible: evidence.production_eligible,
    ...(typeof evidence.held === "boolean" ? { held: evidence.held } : {}),
    ...(typeof evidence.withdrawn === "boolean" ? { withdrawn: evidence.withdrawn } : {}),
    ...(evidence.targets !== undefined ? { targets: evidence.targets } : {}),
  };
}

function eligibleChannels(
  candidate: { version: string; parsed: SemVer; githubPrerelease: boolean },
  evidence: Eligibility | undefined,
) {
  const { version, parsed, githubPrerelease } = candidate;
  const classification = classifyApplicationVersion(
    version,
    evidence?.production_eligible ?? false,
  );
  // Historical 0.x and syntactic previews remain discoverable. Final production
  // versions need separate explicit eligibility, even in Preview.
  const previewEligible = evidence
    ? evidence.preview_eligible
    : parsed.major === 0 || parsed.prerelease.length > 0;
  if (!previewEligible) return [];
  if (githubPrerelease) return ["preview"];
  return classification.channels;
}

function supportsTarget(evidence: Eligibility | undefined, target: unknown) {
  if (target === undefined) return true;
  if (typeof target !== "string" || !target.trim())
    throw new Error("target must be an explicit nonempty identity");
  return Array.isArray(evidence?.targets) && evidence.targets.includes(target);
}

function eligibleCandidate<Release>(
  candidate: Candidate<Release> | null,
  channel: string,
  options: SelectionOptions,
) {
  if (!candidate) return null;
  const evidence = eligibilityEvidence(candidate, options.eligibility?.[candidate.tag]);
  if (evidence?.withdrawn === true || evidence?.held === true) return null;
  if (!eligibleChannels(candidate, evidence).includes(channel)) return null;
  if (!supportsTarget(evidence, options.target)) return null;
  return { release: candidate.release, version: candidate.version };
}

interface SelectionOptions {
  eligibility?: Record<string, unknown>;
  currentVersion?: string;
  target?: unknown;
}
function selectionRequest(
  releases: unknown,
  channel: unknown,
  rawOptions: unknown,
): { channel: string; options: SelectionOptions } {
  if (typeof channel !== "string" || !["preview", "stable"].includes(channel))
    throw new Error(`unknown release channel: ${String(channel)}`);
  if (!Array.isArray(releases)) throw new Error("release response must be an array");
  if (!isRecord(rawOptions)) throw new Error("release selection options must be an object");
  if (rawOptions.eligibility !== undefined && !isRecord(rawOptions.eligibility))
    throw new Error("eligibility must be a separately verified map");
  if (rawOptions.currentVersion !== undefined) exactVersion(rawOptions.currentVersion);
  return {
    channel,
    options: {
      ...(isRecord(rawOptions.eligibility) ? { eligibility: rawOptions.eligibility } : {}),
      ...(typeof rawOptions.currentVersion === "string"
        ? { currentVersion: rawOptions.currentVersion }
        : {}),
      ...(rawOptions.target !== undefined ? { target: rawOptions.target } : {}),
    },
  };
}

function uniquePrecedence(versions: readonly string[]) {
  const sorted = versions.toSorted(semverRuntime().compare);
  for (let index = 1; index < sorted.length; index += 1) {
    if (semverRuntime().eq(sorted[index - 1] ?? "", sorted[index] ?? ""))
      throw new Error(
        "ambiguous application releases contain duplicate version precedence (equal SemVer precedence)",
      );
  }
}

/** Eligibility is supplied separately by the trusted caller, never inferred from
 * GitHub's latest marker, date, or a field embedded in an arbitrary release body.
 */
export function selectApplicationRelease<Release>(
  releases: readonly Release[],
  requestedChannel: unknown,
  rawOptions?: unknown,
): Release | null;
export function selectApplicationRelease(
  releases: unknown,
  requestedChannel: unknown,
  rawOptions?: unknown,
): unknown;
export function selectApplicationRelease(
  releases: unknown,
  requestedChannel: unknown,
  rawOptions: unknown = {},
) {
  const { channel, options } = selectionRequest(releases, requestedChannel, rawOptions);
  if (!Array.isArray(releases)) throw new Error("release response must be an array");
  const values: unknown[] = releases;
  const candidates = values
    .map(publishedRelease)
    .map((candidate) => eligibleCandidate(candidate, channel, options))
    .filter((candidate) => candidate !== null);
  candidates.sort((left, right) => semverRuntime().rcompare(left.version, right.version));
  uniquePrecedence(candidates.map((candidate) => candidate.version));
  const candidate = candidates[0];
  if (
    !candidate ||
    (options.currentVersion !== undefined &&
      !semverRuntime().gt(candidate.version, options.currentVersion))
  )
    return null;
  return candidate.release;
}

const changeKinds = [
  "patch",
  "minor",
  "major",
  "prepatch",
  "preminor",
  "premajor",
  "prerelease",
  "finalize",
] as const;
type VersionChange = (typeof changeKinds)[number];
export interface ReviewedClassification {
  source_commit: string;
  reviewed_commit: string;
  base_version: string;
  change: VersionChange;
  compatibility: "compatible" | "breaking";
  migration_notes?: unknown;
  prerelease_identifier?: unknown;
}
export function parseVersionClassification(value: unknown): ReviewedClassification {
  if (
    !isRecord(value) ||
    typeof value.source_commit !== "string" ||
    !/^[a-f0-9]{40}$/.test(value.source_commit)
  )
    throw new Error("classification requires an exact source commit");
  if (value.reviewed_commit !== value.source_commit)
    throw new Error("classification review does not match the frozen source commit");
  exactVersion(value.base_version);
  if (typeof value.base_version !== "string")
    throw new Error("application version must be a SemVer string");
  const change = changeKinds.find((change) => change === value.change);
  if (!change) throw new Error("unknown reviewed change classification");
  if (value.compatibility !== "compatible" && value.compatibility !== "breaking")
    throw new Error("compatibility classification is required");
  return {
    source_commit: value.source_commit,
    reviewed_commit: value.reviewed_commit,
    base_version: value.base_version,
    change,
    compatibility: value.compatibility,
    ...(value.migration_notes !== undefined ? { migration_notes: value.migration_notes } : {}),
    ...(value.prerelease_identifier !== undefined
      ? { prerelease_identifier: value.prerelease_identifier }
      : {}),
  };
}
function reviewedClassification(value: unknown) {
  const classification = parseVersionClassification(value);
  return {
    classification,
    base: exactVersion(classification.base_version),
    change: classification.change,
  };
}

function publishedHistory(
  classification: ReviewedClassification,
  publishedVersions: unknown,
): asserts publishedVersions is string[] {
  if (!Array.isArray(publishedVersions))
    throw new Error("published version inventory must be complete and explicit");
  const versions: unknown[] = publishedVersions;
  versions.forEach(exactVersion);
  if (!versions.every((version) => typeof version === "string"))
    throw new Error("published versions must be strings");
  uniquePrecedence(versions);
  if (!publishedVersions.includes(classification.base_version))
    throw new Error("classification base is absent from published history");
  if (versions.some((version) => semverRuntime().gt(version, classification.base_version)))
    throw new Error("classification base is behind published history");
}

function compatibilityChange(
  classification: ReviewedClassification,
  publishedVersions: readonly string[],
  base: SemVer,
  change: VersionChange,
) {
  if (classification.compatibility !== "breaking") return;
  if (typeof classification.migration_notes !== "string" || !classification.migration_notes.trim())
    throw new Error("breaking changes require migration notes");
  const required =
    base.major === 0
      ? ["minor", "major", "preminor", "premajor", "prerelease"]
      : ["major", "premajor", "prerelease"];
  if (!required.includes(change))
    throw new Error("change classification cannot carry this compatibility break");
  if (
    base.major > 0 &&
    change === "prerelease" &&
    publishedVersions.some(
      (version) =>
        !semverRuntime().prerelease(version) && semverRuntime().major(version) >= base.major,
    )
  ) {
    throw new Error("breaking prereleases must move beyond the published public major version");
  }
}

function advanceVersion(base: SemVer, change: VersionChange, identifier: unknown) {
  if (change === "finalize") {
    if (!base.prerelease.length) throw new Error("only a prerelease can be finalized");
    return `${base.major}.${base.minor}.${base.patch}`;
  }
  if (change === "prerelease") {
    if (!base.prerelease.length)
      throw new Error("prerelease progression requires an existing prerelease train");
    return semverRuntime().inc(base, "prerelease");
  }
  if (base.prerelease.length)
    throw new Error("explicitly finalize or progress the existing prerelease train");
  if (["prepatch", "preminor", "premajor"].includes(change)) {
    if (typeof identifier !== "string" || !/^[A-Za-z][A-Za-z0-9-]*$/.test(identifier))
      throw new Error("a new prerelease train requires an explicit identifier");
    return semverRuntime().inc(base, change, identifier, "1");
  }
  return semverRuntime().inc(base, change);
}

/** Prepare a deterministic proposal from a reviewed classification. This does not
 * allocate a version, edit metadata, grant eligibility or publish anything.
 */
export function proposeApplicationVersion(value: unknown, publishedVersions: unknown) {
  const { classification, base, change } = reviewedClassification(value);
  publishedHistory(classification, publishedVersions);
  compatibilityChange(classification, publishedVersions, base, change);
  const version = advanceVersion(base, change, classification.prerelease_identifier);
  if (!version || !semverRuntime().gt(version, classification.base_version))
    throw new Error("prepared version must increase");
  if (publishedVersions.some((published) => semverRuntime().eq(version, published)))
    throw new Error("published version precedence cannot be reused");
  const classificationResult = classifyApplicationVersion(version);
  return {
    schema_version: 1,
    source_commit: classification.source_commit,
    base_version: classification.base_version,
    version,
    change,
    github_prerelease: classificationResult.github_prerelease,
    channels: classificationResult.channels,
  };
}

async function settleDirectCli() {
  if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    const [operation, inputPath] = process.argv.slice(2);
    if (process.argv.length !== 4 || !inputPath)
      throw new Error("usage: release-version-policy.mts classify|select|propose INPUT.json");
    const raw: unknown = JSON.parse(await readFile(inputPath, "utf8"));
    if (!isRecord(raw)) throw new Error("release policy input must be an object");
    const input = raw;
    let output;
    if (operation === "classify")
      output = classifyApplicationVersion(input.version, input.production_eligible);
    else if (operation === "select")
      output = selectApplicationRelease(input.releases, input.channel, input.options);
    else if (operation === "propose")
      output = proposeApplicationVersion(input.classification, input.published_versions);
    else throw new Error("unknown release policy operation");
    console.log(JSON.stringify(output));
  }
}
void settleDirectCli().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
