// One owner-approved disposition, not a general advisory exception mechanism.
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { GitHubApiClient } from "./github-api.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
export const approval706 =
  "https://github.com/boburning/portcove/issues/706#issuecomment-6182222682";
export const expiry706 = "2026-11-15T04:59:00.000Z";
export const target706 = "x86_64-unknown-linux-gnu";
const approvalPath = ".github/linux-beta-risk-706.json";
const hash = (value) => createHash("sha256").update(value).digest("hex");
const sha = /^[a-f0-9]{40}$/u;
const sha256 = /^[a-f0-9]{64}$/u;
import {
  parseDependencyScan,
  knownFinding706,
  scanDependencies,
  developmentSecurity,
} from "./dependency-security.mjs";

function command(commandName, args, cwd) {
  return execFileSync(commandName, args, {
    cwd,
    encoding: "utf8",
    timeout: 120_000,
    maxBuffer: 32 * 1024 * 1024,
    windowsHide: true,
  }).trim();
}

export function candidate706(cwd = root, execute = command) {
  const head = execute("git", ["rev-parse", "HEAD"], cwd);
  if (!sha.test(head)) throw new Error("#706 candidate lacks exact source identity");
  if (
    execute(
      "git",
      [
        "status",
        "--porcelain=v1",
        "--untracked-files=all",
        "--",
        "Cargo.toml",
        "Cargo.lock",
        "rust-toolchain.toml",
        ".cargo",
        "apps/desktop/src-tauri",
        "crates/portcove-core",
      ],
      cwd,
    )
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
  const approval = JSON.parse(readFileSync(path.join(cwd, approvalPath), "utf8"));
  if (!sha.test(approval.reconfirmedHead)) throw new Error("#706 source review baseline missing");
  const productionChanges = execute(
    "git",
    [
      "diff",
      "--name-only",
      approval.reconfirmedHead,
      "HEAD",
      "--",
      "Cargo.toml",
      "rust-toolchain.toml",
      ".cargo",
      "apps/desktop/src-tauri",
      "crates/portcove-core",
    ],
    cwd,
  );
  const metadata = JSON.parse(
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
  const packages = new Map(metadata.packages.map((p) => [p.id, p]));
  const nodes = new Map(metadata.resolve.nodes.map((n) => [n.id, n]));
  const desktop = metadata.packages.find((p) => p.name === "portcove-desktop");
  if (!desktop || nodes.get(desktop.id)?.features.length !== 0)
    throw new Error("#706 does not cover Desktop qualification features");
  // Follow the actual Linux production/build graph, excluding dev-only edges.
  const selected = new Set();
  const pending = [desktop.id];
  while (pending.length) {
    const id = pending.pop();
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
      return {
        id: `${p.name}@${p.version}:${p.source ?? "workspace"}`,
        features: nodes.get(id).features.toSorted(),
      };
    })
    .sort((a, b) => a.id.localeCompare(b.id, "en"));
  return {
    head,
    lockSha256: hash(readFileSync(path.join(cwd, "Cargo.lock"))),
    lockUnchanged:
      readFileSync(path.join(cwd, "Cargo.lock"), "utf8").replaceAll("\r\n", "\n").trim() ===
      execute("git", ["show", `${approval.reconfirmedHead}:Cargo.lock`], cwd)
        .replaceAll("\r\n", "\n")
        .trim(),
    target: target706,
    features: ["default", "tauri/custom-protocol"],
    productionChanges,
    reviewedHead: approval.reconfirmedHead,
    native,
  };
}

export function validateApproval706(approval, now = new Date().toISOString()) {
  if (
    approval?.approvalUrl !== approval706 ||
    approval.owner !== "boburning" ||
    approval.expiresAt !== expiry706 ||
    approval.approvedAt !== "2026-10-15T01:21:44.000Z" ||
    approval.advisory !== "RUSTSEC-2024-0429" ||
    approval.alias !== "GHSA-wrw7-89jp-8q8g" ||
    approval.package !== "glib" ||
    approval.version !== "0.18.5"
  )
    throw new Error("#706 approval is absent or out of scope");
  const instant = Date.parse(now);
  if (
    !Number.isFinite(instant) ||
    instant < Date.parse(approval.approvedAt) ||
    instant >= Date.parse(expiry706)
  )
    throw new Error("#706 approval is not valid at this instant");
}

export function decide706({
  approval,
  candidate,
  scan,
  releases,
  purpose = "release",
  publicationTag = null,
  now = new Date().toISOString(),
}) {
  validateApproval706(approval, now);
  if (
    !sha.test(candidate?.head) ||
    !sha256.test(candidate?.lockSha256) ||
    candidate.target !== target706 ||
    JSON.stringify(candidate.features) !== '["default","tauri/custom-protocol"]' ||
    candidate.productionChanges !== "" ||
    candidate.reviewedHead !== approval.reconfirmedHead ||
    !sha.test(candidate.reviewedHead) ||
    candidate.lockUnchanged !== true
  )
    throw new Error("#706 candidate inputs changed: reassessment required");
  if (
    !scan ||
    scan.head !== candidate.head ||
    scan.lockSha256 !== candidate.lockSha256 ||
    scan.complete !== true ||
    scan.signal !== null ||
    scan.error !== null ||
    scan.exitCode !== 1 ||
    scan.unsoundAll !== true ||
    scan.configSha256 !== approval.policySha256 ||
    !sha256.test(approval.policySha256) ||
    scan.toolVersion !== "cargo-deny 0.20.2" ||
    scan.scope !== "workspace-default-all-targets-all-checks" ||
    !Number.isFinite(Date.parse(scan.completedAt)) ||
    Date.parse(scan.completedAt) > Date.parse(now) ||
    Date.parse(now) - Date.parse(scan.completedAt) > 15 * 60 * 1000
  )
    throw new Error(
      "#706 requires a complete exact-candidate failed scan with full unsoundness coverage",
    );
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
          d.advisory.id === "RUSTSEC-2024-0370" &&
          d.advisory.package === "proc-macro-error"
        ),
    )
  )
    throw new Error("#706 does not accept additional advisory findings, including warnings");
  if (!Array.isArray(releases)) throw new Error("#706 release inventory is incomplete");
  const ids = new Set();
  for (const release of releases) {
    if (
      !Number.isSafeInteger(release.id) ||
      ids.has(release.id) ||
      typeof release.draft !== "boolean"
    )
      throw new Error("#706 release inventory has missing or duplicate identity");
    ids.add(release.id);
    if (
      !release.draft &&
      (!Number.isFinite(Date.parse(release.published_at)) ||
        typeof release.tag_name !== "string" ||
        !Array.isArray(release.assets))
    )
      throw new Error("#706 published release inventory is incomplete");
  }
  // Conservative: any published Linux x86-64 desktop package consumes the one-release budget,
  // irrespective of its marketing label. Drafts never consume it.
  const published = releases.filter(
    (r) =>
      !r.draft &&
      Date.parse(r.published_at) >= Date.parse(approval.approvedAt) &&
      r.assets.some(
        (a) =>
          typeof a.name === "string" && /(?:\.AppImage$|amd64\.deb$|x86_64\.rpm$)/iu.test(a.name),
      ),
  );
  if (published.some((r) => r.tag_name !== approval.firstPublicationTag) || published.length > 1)
    throw new Error("#706 expires before publication of the second ordinary Linux beta");
  if (purpose !== "release") throw new Error("unknown #706 decision purpose");
  // A reviewed first tag is durable budget identity even if a release is later deleted.
  // It is intentionally unallocated until the actual first candidate is reconfirmed.
  if (
    !/^v\d+\.\d+\.\d+-(?:alpha|beta)\.\d+$/u.test(approval.firstPublicationTag ?? "") ||
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

export function decisionInputs706(
  cwd,
  scan,
  now,
  purpose = "release",
  publicationTag = process.env.GITHUB_REF_NAME,
  candidate = candidate706(cwd),
) {
  const approval = JSON.parse(readFileSync(path.join(cwd, approvalPath), "utf8"));
  const releases = new GitHubApiClient().paginateRest(
    "repos/boburning/portcove/releases?per_page=100",
    {
      identity: (r) => r.id,
      label: "#706 publication inventory",
    },
  );
  const api = new GitHubApiClient();
  for (const release of releases)
    if (!release.draft && Date.parse(release.published_at) >= Date.parse(approval.approvedAt))
      release.assets = api.paginateRest(
        `repos/boburning/portcove/releases/${release.id}/assets?per_page=100`,
        {
          identity: (asset) => asset.id,
          label: "#706 published asset inventory",
        },
      );
  return {
    approval,
    candidate,
    scan,
    releases,
    now,
    purpose,
    publicationTag,
  };
}

// Fresh, fail-closed check at distribution boundaries; a development decision is never an input.
export function releaseSecurity(cwd, scan, publicationTag = process.env.GITHUB_REF_NAME) {
  const development = developmentSecurity(scan, readFileSync(path.join(cwd, "deny.toml"), "utf8"));
  const candidate = candidate706(cwd);
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
  return decide706(decisionInputs706(cwd, scan, undefined, "release", publicationTag, candidate));
}

export function authorizeLinuxRelease(cwd = root, publicationTag = process.env.GITHUB_REF_NAME) {
  const { scan, output } = scanDependencies(cwd);
  const decision = releaseSecurity(cwd, scan, publicationTag);
  writeFileSync(`${output}.release.json`, `${JSON.stringify(decision, null, 2)}\n`, { flag: "wx" });
  return decision;
}

if (path.resolve(process.argv[1] ?? "") === fileURLToPath(import.meta.url)) {
  try {
    const [mode] = process.argv.slice(2);
    if (mode === "candidate") console.log(JSON.stringify(candidate706(), null, 2));
    else if (mode === "check") {
      const decision = authorizeLinuxRelease();
      console.log(JSON.stringify(decision));
      if (process.env.GITHUB_OUTPUT)
        appendFileSync(
          process.env.GITHUB_OUTPUT,
          `expires_at=${decision.expiresAt ?? ""}\nauthorized_at=${new Date().toISOString()}\n`,
        );
    } else
      throw new Error(
        "usage: linux-beta-risk-706.mjs check|candidate (Linux release authorization)",
      );
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
