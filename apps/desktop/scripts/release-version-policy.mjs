// Offline repository release policy. This module is not imported by the renderer
// or a runtime updater; authenticated feed ownership remains at the Tauri host.
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import semver from "semver";

function exactVersion(value) {
  if (typeof value !== "string") throw new Error("application version must be a SemVer string");
  const parsed = semver.parse(value);
  if (!parsed) throw new Error(`invalid application version: ${value}`);
  const canonical = `${parsed.major}.${parsed.minor}.${parsed.patch}${parsed.prerelease.length ? `-${parsed.prerelease.join(".")}` : ""}${parsed.build.length ? `+${parsed.build.join(".")}` : ""}`;
  if (value !== canonical) throw new Error(`application version must be canonical: ${value}`);
  return parsed;
}

export function classifyApplicationVersion(version, productionEligible = false) {
  const parsed = exactVersion(version);
  if (typeof productionEligible !== "boolean")
    throw new Error("production eligibility must be explicit boolean evidence");
  if (productionEligible && (parsed.major === 0 || parsed.prerelease.length)) {
    throw new Error("0.x and prerelease versions cannot be production eligible");
  }
  return {
    version,
    github_prerelease: !productionEligible,
    channels: productionEligible ? ["preview", "stable"] : ["preview"],
  };
}

export function compareApplicationVersionPrecedence(left, right) {
  return semver.compare(exactVersion(left), exactVersion(right));
}

function field(release, camel, snake) {
  return release[camel] ?? release[snake];
}

function publishedRelease(release) {
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
  if (Number.isNaN(Date.parse(publishedAt ?? "")))
    throw new Error(
      `published release has an invalid published timestamp: ${publishedAt ?? "missing"}`,
    );
  return { release, tag, version, parsed, githubPrerelease };
}

function eligibilityEvidence(candidate, evidence) {
  const { tag, version } = candidate;
  if (
    evidence &&
    (evidence.version !== version ||
      typeof evidence.preview_eligible !== "boolean" ||
      typeof evidence.production_eligible !== "boolean")
  ) {
    throw new Error(`invalid release eligibility evidence for ${tag}`);
  }
  if (
    evidence &&
    (["held", "withdrawn"].some(
      (key) => evidence[key] !== undefined && typeof evidence[key] !== "boolean",
    ) ||
      (evidence.production_eligible && !evidence.preview_eligible))
  )
    throw new Error(`inconsistent release eligibility evidence for ${tag}`);
  return evidence;
}

function eligibleChannels(candidate, evidence) {
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

function supportsTarget(evidence, target) {
  if (target === undefined) return true;
  if (typeof target !== "string" || !target.trim())
    throw new Error("target must be an explicit nonempty identity");
  return Array.isArray(evidence?.targets) && evidence.targets.includes(target);
}

function eligibleCandidate(candidate, channel, options) {
  if (!candidate) return null;
  const evidence = eligibilityEvidence(candidate, options.eligibility?.[candidate.tag]);
  if (evidence?.withdrawn === true || evidence?.held === true) return null;
  if (!eligibleChannels(candidate, evidence).includes(channel)) return null;
  if (!supportsTarget(evidence, options.target)) return null;
  return { release: candidate.release, version: candidate.version };
}

function selectionRequest(releases, channel, options) {
  if (!["preview", "stable"].includes(channel))
    throw new Error(`unknown release channel: ${channel}`);
  if (!Array.isArray(releases)) throw new Error("release response must be an array");
  if (
    options.eligibility !== undefined &&
    (!options.eligibility ||
      typeof options.eligibility !== "object" ||
      Array.isArray(options.eligibility))
  )
    throw new Error("eligibility must be a separately verified map");
  if (options.currentVersion !== undefined) exactVersion(options.currentVersion);
}

function uniquePrecedence(versions) {
  const sorted = versions.toSorted(semver.compare);
  for (let index = 1; index < sorted.length; index += 1) {
    if (semver.eq(sorted[index - 1], sorted[index]))
      throw new Error(
        "ambiguous application releases contain duplicate version precedence (equal SemVer precedence)",
      );
  }
}

/** Eligibility is supplied separately by the trusted caller, never inferred from
 * GitHub's latest marker, date, or a field embedded in an arbitrary release body.
 */
export function selectApplicationRelease(releases, channel, options = {}) {
  selectionRequest(releases, channel, options);
  const candidates = releases
    .map(publishedRelease)
    .map((candidate) => eligibleCandidate(candidate, channel, options))
    .filter(Boolean);
  candidates.sort((left, right) => semver.rcompare(left.version, right.version));
  uniquePrecedence(candidates.map((candidate) => candidate.version));
  const candidate = candidates[0];
  if (
    !candidate ||
    (options.currentVersion !== undefined && !semver.gt(candidate.version, options.currentVersion))
  )
    return null;
  return candidate.release;
}

function reviewedClassification(classification) {
  if (!/^[a-f0-9]{40}$/.test(classification?.source_commit ?? ""))
    throw new Error("classification requires an exact source commit");
  if (classification.reviewed_commit !== classification.source_commit)
    throw new Error("classification review does not match the frozen source commit");
  const base = exactVersion(classification.base_version);
  const change = classification.change;
  if (
    ![
      "patch",
      "minor",
      "major",
      "prepatch",
      "preminor",
      "premajor",
      "prerelease",
      "finalize",
    ].includes(change)
  )
    throw new Error("unknown reviewed change classification");
  if (!["compatible", "breaking"].includes(classification.compatibility))
    throw new Error("compatibility classification is required");
  return { base, change };
}

function publishedHistory(classification, publishedVersions) {
  if (!Array.isArray(publishedVersions))
    throw new Error("published version inventory must be complete and explicit");
  publishedVersions.forEach(exactVersion);
  uniquePrecedence(publishedVersions);
  if (!publishedVersions.includes(classification.base_version))
    throw new Error("classification base is absent from published history");
  if (publishedVersions.some((version) => semver.gt(version, classification.base_version)))
    throw new Error("classification base is behind published history");
}

function compatibilityChange(classification, publishedVersions, base, change) {
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
      (version) => !semver.prerelease(version) && semver.major(version) >= base.major,
    )
  ) {
    throw new Error("breaking prereleases must move beyond the published public major version");
  }
}

function advanceVersion(base, change, identifier) {
  if (change === "finalize") {
    if (!base.prerelease.length) throw new Error("only a prerelease can be finalized");
    return `${base.major}.${base.minor}.${base.patch}`;
  }
  if (change === "prerelease") {
    if (!base.prerelease.length)
      throw new Error("prerelease progression requires an existing prerelease train");
    return semver.inc(base, "prerelease");
  }
  if (base.prerelease.length)
    throw new Error("explicitly finalize or progress the existing prerelease train");
  if (["prepatch", "preminor", "premajor"].includes(change)) {
    if (typeof identifier !== "string" || !/^[A-Za-z][A-Za-z0-9-]*$/.test(identifier))
      throw new Error("a new prerelease train requires an explicit identifier");
    return semver.inc(base, change, identifier, "1");
  }
  return semver.inc(base, change);
}

/** Prepare a deterministic proposal from a reviewed classification. This does not
 * allocate a version, edit metadata, grant eligibility or publish anything.
 */
export function proposeApplicationVersion(classification, publishedVersions) {
  const { base, change } = reviewedClassification(classification);
  publishedHistory(classification, publishedVersions);
  compatibilityChange(classification, publishedVersions, base, change);
  const version = advanceVersion(base, change, classification.prerelease_identifier);
  if (!version || !semver.gt(version, classification.base_version))
    throw new Error("prepared version must increase");
  if (publishedVersions.some((published) => semver.eq(version, published)))
    throw new Error("published version precedence cannot be reused");
  return {
    schema_version: 1,
    source_commit: classification.source_commit,
    base_version: classification.base_version,
    version,
    change,
    ...classifyApplicationVersion(version),
  };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [operation, inputPath] = process.argv.slice(2);
  if (process.argv.length !== 4 || !inputPath)
    throw new Error("usage: release-version-policy.mjs classify|select|propose INPUT.json");
  const input = JSON.parse(await readFile(inputPath, "utf8"));
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
