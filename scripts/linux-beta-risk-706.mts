import { errorMessage, isRecord } from "./runtime-values.mts";
import { inspectRiskVersionPreparation706 } from "./linux-beta-risk-706-preparation.mts";
// One owner-approved disposition, not a general advisory exception mechanism.
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import {
  coordinatorCommandTimeout,
  checkCoordinatorDeadline,
} from "./release-coordinator-deadline.mts";
import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { isDeepStrictEqual } from "node:util";
import { risk706GraphDigest } from "./linux-beta-risk-706-profile.mts";
import { GitHubApiClient } from "./github-api.mts";

const root = fileURLToPath(new URL("../", import.meta.url));
export const approval706 =
  "https://github.com/boburning/portcove/issues/706#issuecomment-6182222682";
export const expiry706 = "2026-11-15T04:59:00.000Z";
export const target706 = "x86_64-unknown-linux-gnu";
export const nativePaths706 = [
  "Cargo.toml",
  "Cargo.lock",
  "rust-toolchain.toml",
  ".cargo",
  "apps/desktop/src-tauri",
  "crates/portcove-core",
];
const nativePaths = nativePaths706;
const approvalPath = ".github/linux-beta-risk-706.json";
const hash = (value: string | Uint8Array) => createHash("sha256").update(value).digest("hex");
const sha = /^[a-f0-9]{40}$/u;
const sha256 = /^[a-f0-9]{64}$/u;
import {
  parseDependencyScan,
  knownFinding706,
  scanDependencies,
  developmentSecurity,
} from "./dependency-security.mts";

type Execute706 = (commandName: string, args: string[], cwd: string) => string;
function command(commandName: string, args: string[], cwd: string) {
  const result = execFileSync(commandName, args, {
    cwd,
    encoding: "utf8",
    timeout: coordinatorCommandTimeout(120_000),
    maxBuffer: 32 * 1024 * 1024,
    windowsHide: true,
  });
  checkCoordinatorDeadline();
  // Preparation verification hashes raw commit/blob bytes, including their
  // final newline. Control responses keep the existing trimmed convention.
  return commandName === "git" && ["cat-file", "show"].includes(args[0] ?? "")
    ? result
    : result.trim();
}

interface CargoPackage706 {
  id: string;
  name: string;
  version: string;
  source?: string | null;
}
interface CargoNode706 {
  id: string;
  features: string[];
  deps: { pkg: string; dep_kinds: { kind: string | null }[] }[];
}
function cargoMetadata706(value: unknown): { packages: CargoPackage706[]; nodes: CargoNode706[] } {
  if (
    !isRecord(value) ||
    !Array.isArray(value.packages) ||
    !isRecord(value.resolve) ||
    !Array.isArray(value.resolve.nodes)
  )
    throw new Error("incomplete Linux dependency graph");
  const rawPackages: unknown[] = value.packages;
  const packages = rawPackages.map((pkg): CargoPackage706 => {
    if (
      !isRecord(pkg) ||
      typeof pkg.id !== "string" ||
      typeof pkg.name !== "string" ||
      typeof pkg.version !== "string" ||
      (pkg.source != null && typeof pkg.source !== "string")
    )
      throw new Error("incomplete Linux dependency graph");
    return {
      id: pkg.id,
      name: pkg.name,
      version: pkg.version,
      ...(pkg.source === undefined ? {} : { source: pkg.source }),
    };
  });
  const rawNodes: unknown[] = value.resolve.nodes;
  const nodes = rawNodes.map((node): CargoNode706 => {
    if (
      !isRecord(node) ||
      typeof node.id !== "string" ||
      !Array.isArray(node.features) ||
      !node.features.every((feature: unknown) => typeof feature === "string") ||
      !Array.isArray(node.deps)
    )
      throw new Error("incomplete Linux dependency graph");
    const rawDependencies: unknown[] = node.deps;
    const deps = rawDependencies.map((dep) => {
      if (!isRecord(dep) || typeof dep.pkg !== "string" || !Array.isArray(dep.dep_kinds))
        throw new Error("incomplete Linux dependency graph");
      const rawKinds: unknown[] = dep.dep_kinds;
      const dep_kinds = rawKinds.map((entry) => {
        if (!isRecord(entry) || (entry.kind !== null && typeof entry.kind !== "string"))
          throw new Error("incomplete Linux dependency graph");
        return { kind: entry.kind };
      });
      return { pkg: dep.pkg, dep_kinds };
    });
    return { id: node.id, features: node.features, deps };
  });
  return { packages, nodes };
}

export async function candidate706(cwd = root, execute: Execute706 = command) {
  const head = execute("git", ["rev-parse", "HEAD"], cwd);
  if (!sha.test(head)) throw new Error("#706 candidate lacks exact source identity");
  if (
    execute("git", ["status", "--porcelain=v1", "--untracked-files=all", "--", ...nativePaths], cwd)
  )
    throw new Error("#706 candidate must have clean tracked native inputs");
  if (
    [
      "RUSTFLAGS",
      "CARGO_ENCODED_RUSTFLAGS",
      "CARGO_BUILD_RUSTFLAGS",
      "RUSTC_BOOTSTRAP",
      "RUSTC_WRAPPER",
    ].some((name) => process.env[name])
  )
    throw new Error("#706 production build environment requires reassessment");
  if (process.env.GITHUB_SHA && process.env.GITHUB_SHA !== head)
    throw new Error("#706 checkout does not match the workflow candidate");
  const approval: unknown = JSON.parse(readFileSync(path.join(cwd, approvalPath), "utf8"));
  if (
    !isRecord(approval) ||
    typeof approval.reconfirmedHead !== "string" ||
    !sha.test(approval.reconfirmedHead)
  )
    throw new Error("#706 source review baseline missing");
  const versionPreparation = await inspectRiskVersionPreparation706(head, (args) =>
    execute("git", [...args], cwd),
  );
  const productionChanges = execute(
    "git",
    [
      "diff",
      "--name-only",
      approval.reconfirmedHead,
      versionPreparation?.source_commit ?? "HEAD",
      "--",
      ...nativePaths,
    ],
    cwd,
  );
  const rawMetadata: unknown = JSON.parse(
    execute(
      "cargo",
      [
        "metadata",
        "--locked",
        "--format-version",
        "1",
        "--filter-platform",
        target706,
        "--features",
        "tauri/custom-protocol",
      ],
      cwd,
    ),
  );
  const metadata = cargoMetadata706(rawMetadata);
  const packages = new Map(metadata.packages.map((p) => [p.id, p]));
  const nodes = new Map(metadata.nodes.map((n) => [n.id, n]));
  const desktop = metadata.packages.find((p) => p.name === "portcove-desktop");
  if (!desktop || nodes.get(desktop.id)?.features.length !== 0)
    throw new Error("#706 does not cover Desktop qualification features");
  // Follow the actual Linux production/build graph, excluding dev-only edges.
  const selected = new Set<string>();
  const pending = [desktop.id];
  while (pending.length) {
    const id = pending.pop();
    if (id === undefined) throw new Error("incomplete Linux dependency graph");
    if (selected.has(id)) continue;
    selected.add(id);
    const node = nodes.get(id);
    if (!node || !packages.has(id)) throw new Error("incomplete Linux dependency graph");
    pending.push(
      ...node.deps.filter((d) => d.dep_kinds.some((k) => k.kind !== "dev")).map((d) => d.pkg),
    );
  }
  const native = [...selected]
    .map((id) => {
      const p = packages.get(id);
      const node = nodes.get(id);
      if (!p || !node) throw new Error("incomplete Linux dependency graph");
      return {
        id: `${p.name}@${p.version}:${p.source ?? "workspace"}`,
        features: node.features.toSorted(),
      };
    })
    .sort((a, b) => a.id.localeCompare(b.id, "en"));
  return {
    head,
    lockSha256: hash(readFileSync(path.join(cwd, "Cargo.lock"))),
    target: target706,
    features: ["default", "tauri/custom-protocol"],
    productionChanges,
    reviewedHead: approval.reconfirmedHead,
    ...(versionPreparation ? { versionPreparation } : {}),
    native,
    sourceNativeInputsSha256: hash(
      execute(
        "git",
        ["ls-tree", versionPreparation?.source_commit ?? head, "--", ...nativePaths],
        cwd,
      ).trimEnd() + "\n",
    ),
  };
}

interface Approval706 {
  approvalUrl: typeof approval706;
  owner: "boburning";
  expiresAt: typeof expiry706;
  approvedAt: "2026-10-15T01:21:44.000Z";
  advisory: "RUSTSEC-2024-0429";
  alias: "GHSA-wrw7-89jp-8q8g";
  package: "glib";
  version: "0.18.5";
  reconfirmedHead?: unknown;
  policySha256?: unknown;
  firstPublicationTag?: unknown;
}
export function validateApproval706(
  approval: unknown,
  now: unknown = new Date().toISOString(),
): asserts approval is Approval706 {
  if (
    !isRecord(approval) ||
    approval.approvalUrl !== approval706 ||
    approval.owner !== "boburning" ||
    approval.expiresAt !== expiry706 ||
    approval.approvedAt !== "2026-10-15T01:21:44.000Z" ||
    approval.advisory !== "RUSTSEC-2024-0429" ||
    approval.alias !== "GHSA-wrw7-89jp-8q8g" ||
    approval.package !== "glib" ||
    approval.version !== "0.18.5"
  )
    throw new Error("#706 approval is absent or out of scope");
  const instant = typeof now === "string" ? Date.parse(now) : NaN;
  if (
    !Number.isFinite(instant) ||
    instant < Date.parse(approval.approvedAt) ||
    instant >= Date.parse(expiry706)
  )
    throw new Error("#706 approval is not valid at this instant");
}

/** A dispatched build can measure the candidate without exercising a risk
 * waiver. This result is deliberately unusable as a distribution decision. */
export function assessDispatchedBuild706({
  candidate,
  scan,
  policy,
  now = new Date().toISOString(),
}: {
  candidate: unknown;
  scan: unknown;
  policy: string;
  now?: string;
}) {
  if (
    !isRecord(candidate) ||
    typeof candidate.head !== "string" ||
    !sha.test(candidate.head) ||
    typeof candidate.lockSha256 !== "string" ||
    !sha256.test(candidate.lockSha256) ||
    candidate.target !== target706 ||
    JSON.stringify(candidate.features) !== '["default","tauri/custom-protocol"]' ||
    !Array.isArray(candidate.native) ||
    candidate.native.length === 0 ||
    typeof candidate.productionChanges !== "string" ||
    !isRecord(scan) ||
    scan.head !== candidate.head ||
    scan.lockSha256 !== candidate.lockSha256 ||
    typeof scan.completedAt !== "string" ||
    !Number.isFinite(Date.parse(now)) ||
    !Number.isFinite(Date.parse(scan.completedAt)) ||
    Date.parse(scan.completedAt) > Date.parse(now) ||
    Date.parse(now) - Date.parse(scan.completedAt) > 15 * 60 * 1000
  )
    throw new Error("dispatched build requires fresh exact-source Linux assessment inputs");
  const ids = new Set<string>();
  for (const node of candidate.native) {
    if (
      !isRecord(node) ||
      typeof node.id !== "string" ||
      !node.id ||
      ids.has(node.id) ||
      !Array.isArray(node.features) ||
      !node.features.every((feature: unknown) => typeof feature === "string")
    )
      throw new Error("dispatched build dependency graph is incomplete");
    ids.add(node.id);
  }
  const development = developmentSecurity(scan, policy);
  if (
    development.scanPassed &&
    candidate.native.some(
      (node: unknown) =>
        isRecord(node) && typeof node.id === "string" && node.id.startsWith("glib@0.18.5:"),
    )
  )
    throw new Error("affected compiler graph requires original full-scope scanner finding");
  assertBuildAssessmentAdvisories(scan);
  return {
    schema_version: 1,
    disposition: "build-assessment-only",
    authority: "none",
    candidate: candidate.head,
    lockSha256: candidate.lockSha256,
    dependencyGraphSha256: risk706GraphDigest(candidate.native),
    policySha256: hash(policy),
    sourceReview: "not-authorized",
    productionChanges: candidate.productionChanges,
    versionPreparation: candidate.versionPreparation ?? null,
    evaluatedAt: now,
    scanPassed: development.scanPassed,
    scanExitCode: development.scanExitCode,
    knownFinding: development.knownFinding,
    riskAuthorization: "pending-protected-controller-assessment",
    releaseAuthorization: "not-evaluated",
    pending: [
      "authenticated-owner-amendment",
      "protected-risk-admission",
      "publication-exposure-readback",
    ],
  };
}

function assertBuildAssessmentAdvisories(scan: Record<string, unknown>) {
  // Do not turn an additional advisory warning into an initial-proof exception.
  const { diagnostics } = parseDependencyScan(String(scan.stdout), String(scan.stderr));
  if (
    diagnostics.some(
      (entry) =>
        entry.advisory &&
        !knownFinding706(entry) &&
        !(
          entry.severity === "warning" &&
          entry.code === "unmaintained" &&
          isRecord(entry.advisory) &&
          entry.advisory.id === "RUSTSEC-2024-0370" &&
          entry.advisory.package === "proc-macro-error"
        ),
    )
  )
    throw new Error("dispatched build assessment contains another advisory finding");
}

/** Windows package production still measures the original all-target scan.
 * This does not authorize distribution or consume the Linux-only risk waiver. */
export function assessWindowsDispatchedBuild({
  head,
  lockSha256,
  scan,
  policy,
  now = new Date().toISOString(),
}: {
  head: string;
  lockSha256: string;
  scan: unknown;
  policy: string;
  now?: string;
}) {
  if (
    !sha.test(head) ||
    !sha256.test(lockSha256) ||
    !isRecord(scan) ||
    scan.head !== head ||
    scan.lockSha256 !== lockSha256 ||
    typeof scan.completedAt !== "string" ||
    !Number.isFinite(Date.parse(now)) ||
    !Number.isFinite(Date.parse(scan.completedAt)) ||
    Date.parse(scan.completedAt) > Date.parse(now) ||
    Date.parse(now) - Date.parse(scan.completedAt) > 15 * 60 * 1000
  )
    throw new Error("Windows dispatched build requires fresh exact-source assessment inputs");
  const development = developmentSecurity(scan, policy);
  assertBuildAssessmentAdvisories(scan);
  return {
    schema_version: 1,
    disposition: "build-assessment-only",
    authority: "none",
    release_profile: "initial-beta-windows-x86_64-v1",
    candidate: head,
    lockSha256,
    scanScope: scan.scope,
    policySha256: hash(policy),
    sourceReview: "not-authorized",
    evaluatedAt: now,
    scanPassed: development.scanPassed,
    scanExitCode: development.scanExitCode,
    knownFinding: development.knownFinding,
    riskAuthorization: "not-evaluated",
    releaseAuthorization: "not-evaluated",
    pending: [
      "authenticated-owner-amendment",
      "protected-Windows-admission",
      "publication-exposure-readback",
    ],
  };
}

/** Build-only dispatch assessment and tag publication retain separate routes.
 * Called by the release audit after retaining the unmodified full-scope scan. */
export async function releaseAuditDisposition({
  root,
  head,
  scan,
  environment,
  now,
}: {
  root: string;
  head: string;
  scan: unknown;
  environment: NodeJS.ProcessEnv;
  now?: string;
}) {
  const policy = readFileSync(path.join(root, "deny.toml"), "utf8");
  if (
    environment.GITHUB_EVENT_NAME === "workflow_dispatch" &&
    environment.PORTCOVE_RELEASE_PROFILE === "initial-beta-windows-x86_64-v1"
  ) {
    return {
      suffix: "build-assessment.json",
      decision: assessWindowsDispatchedBuild({
        head,
        lockSha256: hash(readFileSync(path.join(root, "Cargo.lock"))),
        scan,
        policy,
        ...(now === undefined ? {} : { now }),
      }),
    };
  }
  if (dispatchedBuildAssessment706(environment)) {
    return {
      suffix: "build-assessment.json",
      decision: assessDispatchedBuild706({
        candidate: await candidate706(root),
        scan,
        policy,
      }),
    };
  }
  return { suffix: "release.json", decision: await releaseSecurity(root, scan) };
}
/** Routing only. Environment strings cannot appoint a risk waiver. */
export function dispatchedBuildAssessment706(environment: NodeJS.ProcessEnv) {
  return (
    environment.GITHUB_EVENT_NAME === "workflow_dispatch" &&
    environment.PORTCOVE_RELEASE_PROFILE === "initial-beta-win-linux"
  );
}

/** Inert decoding inside the existing authenticated compiler subject. The
 * producing job, source closure and report attestation are checked by its caller. */
export function inspectCompilerRiskAssessment706(
  raw: unknown,
  expected: {
    source_commit: string;
    started: number;
    finished: number;
    lock_sha256: string;
  },
) {
  if (
    !isRecord(raw) ||
    Object.keys(raw).sort().join(",") !== "assessment,candidate,scan" ||
    Buffer.byteLength(JSON.stringify(raw)) > 128 * 1024 ||
    !isRecord(raw.candidate) ||
    raw.candidate.head !== expected.source_commit ||
    !isRecord(raw.scan) ||
    raw.scan.lockSha256 !== expected.lock_sha256 ||
    typeof raw.scan.completedAt !== "string" ||
    !isRecord(raw.assessment) ||
    raw.assessment.evaluatedAt !== raw.scan.completedAt ||
    typeof raw.scan.sourceConfig !== "string" ||
    Date.parse(raw.scan.completedAt) < expected.started ||
    Date.parse(raw.scan.completedAt) > expected.finished
  )
    throw new Error("compiler risk assessment lacks bounded same-producing-job source custody");
  const assessed = assessDispatchedBuild706({
    candidate: raw.candidate,
    scan: raw.scan,
    policy: raw.scan.sourceConfig,
    now: raw.scan.completedAt,
  });
  if (!isDeepStrictEqual(assessed, raw.assessment))
    throw new Error("compiler risk assessment differs from raw scan");
  return {
    candidate: structuredClone(raw.candidate),
    scan: structuredClone(raw.scan),
    assessment: assessed,
  };
}

export function decide706({
  approval,
  candidate,
  scan,
  releases,
  purpose = "release",
  publicationTag = null,
  now = new Date().toISOString(),
}: {
  approval: unknown;
  candidate: unknown;
  scan: unknown;
  releases: unknown;
  purpose?: string;
  publicationTag?: unknown;
  now?: string;
}) {
  validateApproval706(approval, now);
  if (
    !isRecord(candidate) ||
    typeof candidate.head !== "string" ||
    !sha.test(candidate.head) ||
    typeof candidate.lockSha256 !== "string" ||
    !sha256.test(candidate.lockSha256) ||
    candidate.target !== target706 ||
    JSON.stringify(candidate.features) !== '["default","tauri/custom-protocol"]' ||
    candidate.productionChanges !== "" ||
    candidate.reviewedHead !== approval.reconfirmedHead ||
    typeof candidate.reviewedHead !== "string" ||
    !sha.test(candidate.reviewedHead)
  )
    throw new Error("#706 candidate inputs changed: reassessment required");
  if (!isRecord(scan) || typeof scan.executionConfig !== "string")
    throw new Error("incomplete or changed dependency-policy execution");
  const policy = developmentSecurity(scan, scan.executionConfig);
  if (
    scan.head !== candidate.head ||
    scan.lockSha256 !== candidate.lockSha256 ||
    policy.scanPassed ||
    scan.configSha256 !== approval.policySha256 ||
    typeof approval.policySha256 !== "string" ||
    !sha256.test(approval.policySha256) ||
    typeof scan.completedAt !== "string" ||
    !Number.isFinite(Date.parse(scan.completedAt)) ||
    Date.parse(scan.completedAt) > Date.parse(now) ||
    Date.parse(now) - Date.parse(scan.completedAt) > 15 * 60 * 1000
  )
    throw new Error(
      "#706 requires a complete exact-candidate failed scan with full unsoundness coverage",
    );
  if (typeof scan.stdout !== "string" || typeof scan.stderr !== "string")
    throw new Error("incomplete or changed dependency-policy execution");
  const { errors, summary, diagnostics } = parseDependencyScan(scan.stdout, scan.stderr);
  if (errors.length !== 1 || !knownFinding706(errors[0]))
    throw new Error("#706 does not accept an additional or different finding");
  if (
    diagnostics.some(
      (d) =>
        d.advisory &&
        d !== errors[0] &&
        !(
          d.severity === "warning" &&
          d.code === "unmaintained" &&
          isRecord(d.advisory) &&
          d.advisory.id === "RUSTSEC-2024-0370" &&
          d.advisory.package === "proc-macro-error"
        ),
    )
  )
    throw new Error("#706 does not accept additional advisory findings, including warnings");
  if (!Array.isArray(releases)) throw new Error("#706 release inventory is incomplete");
  const ids = new Set<number>();
  const rawReleases: unknown[] = releases;
  for (const release of rawReleases) {
    if (
      !isRecord(release) ||
      typeof release.id !== "number" ||
      !Number.isSafeInteger(release.id) ||
      ids.has(release.id) ||
      typeof release.draft !== "boolean"
    )
      throw new Error("#706 release inventory has missing or duplicate identity");
    ids.add(release.id);
    if (
      !release.draft &&
      (typeof release.published_at !== "string" ||
        !Number.isFinite(Date.parse(release.published_at)) ||
        typeof release.tag_name !== "string" ||
        !Array.isArray(release.assets))
    )
      throw new Error("#706 published release inventory is incomplete");
  }
  // Conservative: any published Linux x86-64 desktop package consumes the one-release budget,
  // irrespective of its marketing label. Drafts never consume it.
  const published = rawReleases.filter((r): r is Record<string, unknown> => {
    if (
      !isRecord(r) ||
      r.draft ||
      typeof r.published_at !== "string" ||
      Date.parse(r.published_at) < Date.parse(approval.approvedAt) ||
      !Array.isArray(r.assets)
    )
      return false;
    const assets: unknown[] = r.assets;
    return assets.some((asset) => {
      if (!isRecord(asset)) throw new Error("#706 published release asset inventory is incomplete");
      return (
        typeof asset.name === "string" &&
        /(?:\.AppImage$|amd64\.deb$|x86_64\.rpm$)/iu.test(asset.name)
      );
    });
  });
  if (published.some((r) => r.tag_name !== approval.firstPublicationTag) || published.length > 1)
    throw new Error("#706 expires before publication of the second ordinary Linux beta");
  if (purpose !== "release") throw new Error("unknown #706 decision purpose");
  // A reviewed first tag is durable budget identity even if a release is later deleted.
  // It is intentionally unallocated until the actual first candidate is reconfirmed.
  if (
    typeof approval.firstPublicationTag !== "string" ||
    !/^v\d+\.\d+\.\d+-(?:alpha|beta)\.\d+$/u.test(approval.firstPublicationTag) ||
    publicationTag !== approval.firstPublicationTag
  )
    throw new Error("#706 first publication tag is not bound to this candidate");
  return {
    disposition: "accepted-risk",
    approvalUrl: approval706,
    candidate: candidate.head,
    lockSha256: candidate.lockSha256,
    evaluatedAt: now,
    expiresAt: expiry706,
    scanExitCode: scan.exitCode,
    scanPassed: false,
    purpose,
    publicationTag,
    summary,
    advisory: approval.advisory,
    owner: approval.owner,
  };
}

export async function decisionInputs706(
  cwd: string,
  scan: unknown,
  now: string | undefined,
  purpose = "release",
  publicationTag = process.env.GITHUB_REF_NAME,
  candidate?: Awaited<ReturnType<typeof candidate706>>,
) {
  const selectedCandidate = candidate ?? (await candidate706(cwd));
  const approval: unknown = JSON.parse(readFileSync(path.join(cwd, approvalPath), "utf8"));
  if (!isRecord(approval) || typeof approval.approvedAt !== "string")
    throw new Error("#706 approval is absent or out of scope");
  const api = new GitHubApiClient();
  const releases = api.paginateRest("repos/boburning/portcove/releases?per_page=100", {
    identity: (r) => (isRecord(r) && typeof r.id === "number" ? r.id : null),
    label: "#706 publication inventory",
  });
  for (const release of releases) {
    if (!isRecord(release) || typeof release.id !== "number" || typeof release.draft !== "boolean")
      throw new Error("#706 release inventory has missing or duplicate identity");
    if (
      !release.draft &&
      typeof release.published_at === "string" &&
      Date.parse(release.published_at) >= Date.parse(approval.approvedAt)
    )
      release.assets = api.paginateRest(
        `repos/boburning/portcove/releases/${release.id}/assets?per_page=100`,
        {
          identity: (asset) => (isRecord(asset) && typeof asset.id === "number" ? asset.id : null),
          label: "#706 published asset inventory",
        },
      );
  }
  return {
    approval,
    candidate: selectedCandidate,
    scan,
    releases,
    ...(now === undefined ? {} : { now }),
    purpose,
    publicationTag,
  };
}

// Fresh, fail-closed check at distribution boundaries; a development decision is never an input.
export async function releaseSecurity(
  cwd: string,
  scan: unknown,
  publicationTag = process.env.GITHUB_REF_NAME,
) {
  const development = developmentSecurity(scan, readFileSync(path.join(cwd, "deny.toml"), "utf8"));
  const candidate = await candidate706(cwd);
  if (!isRecord(scan) || typeof scan.completedAt !== "string")
    throw new Error("Linux release requires fresh exact-candidate scanner evidence");
  const age = Date.now() - Date.parse(scan.completedAt);
  if (
    scan.head !== candidate.head ||
    scan.lockSha256 !== candidate.lockSha256 ||
    !Number.isFinite(age) ||
    age < 0 ||
    age > 15 * 60 * 1000
  )
    throw new Error("Linux release requires fresh exact-candidate scanner evidence");
  if (development.scanPassed) {
    if (candidate.native.some((p) => p.id.startsWith("glib@0.18.5:")))
      throw new Error("Affected Linux release lacks the expected full-scope advisory evidence");
    return { disposition: "clean-scan", candidate: candidate.head, publicationTag };
  }
  return decide706(
    await decisionInputs706(cwd, scan, undefined, "release", publicationTag, candidate),
  );
}

export async function authorizeLinuxRelease(
  cwd = root,
  publicationTag = process.env.GITHUB_REF_NAME,
) {
  const { scan, output } = scanDependencies(cwd);
  const decision = await releaseSecurity(cwd, scan, publicationTag);
  writeFileSync(`${output}.release.json`, `${JSON.stringify(decision, null, 2)}\n`, { flag: "wx" });
  return decision;
}

async function settleDirectCli() {
  if (
    /^linux-beta-risk-706(?:[.]mts|(?:[.]bundle)?[.]mjs)$/u.test(
      path.basename(process.argv[1] ?? ""),
    ) &&
    path.resolve(process.argv[1] ?? "") === fileURLToPath(import.meta.url)
  ) {
    try {
      const [mode] = process.argv.slice(2);
      if (mode === "candidate") console.log(JSON.stringify(await candidate706(), null, 2));
      else if (mode === "check") {
        const decision = await authorizeLinuxRelease();
        console.log(JSON.stringify(decision));
        if (process.env.GITHUB_OUTPUT)
          appendFileSync(
            process.env.GITHUB_OUTPUT,
            `expires_at=${"expiresAt" in decision ? decision.expiresAt : ""}\nauthorized_at=${new Date().toISOString()}\n`,
          );
      } else
        throw new Error(
          "usage: linux-beta-risk-706.mts check|candidate (Linux release authorization)",
        );
    } catch (error) {
      console.error(errorMessage(error));
      process.exitCode = 1;
    }
  }
}
void settleDirectCli().catch((error: unknown) => {
  console.error(errorMessage(error));
  process.exitCode = 1;
});
