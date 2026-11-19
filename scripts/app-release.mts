// Simple tag-driven application release (owner decision on #534, 2026-11-13).
// A `v*` tag on protected main is the release decision. CI builds, signs with the
// Tauri updater key and publishes the GitHub Release plus a per-channel
// `latest.json` feed. No AI review, journal or controller is involved.
import { execFileSync } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import { performance } from "node:perf_hooks";
import {
  createGitHubClient,
  iterateGitHubPages,
  type GitHubRequestPolicy,
} from "./github-client.mts";
import {
  artifactName,
  assertExactArtifactNames,
  loadPackagePolicy,
} from "./release-package-policy.mts";
import path from "node:path";
import { fileURLToPath } from "node:url";

export type Channel = "preview" | "beta" | "stable";

const semver =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/u;

export function parseVersion(version: string) {
  const match = semver.exec(version);
  if (!match) throw new Error(`not a SemVer version: ${version}`);
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    prerelease: match[4] ?? null,
  };
}

/** Preview: `X.Y.Z-preview.N`. Beta: any other 0.x release. Stable: 1.0.0 and later. */
export function classifyRelease(version: string) {
  const parsed = parseVersion(version);
  let channel: Channel;
  if (parsed.prerelease !== null) {
    if (!/^preview\.(0|[1-9]\d*)$/u.test(parsed.prerelease))
      throw new Error(`only -preview.N pre-releases are published: ${version}`);
    channel = "preview";
  } else channel = parsed.major === 0 ? "beta" : "stable";
  return {
    version,
    channel,
    prerelease: channel === "preview",
    environment: channel === "stable" ? "release-stable" : "release",
    // A newer Beta/Stable is also offered to Preview users; a Preview never reaches Beta.
    feeds:
      channel === "preview"
        ? ["preview"]
        : channel === "beta"
          ? ["beta", "preview"]
          : ["stable", "beta", "preview"],
  };
}

function identifiers(value: string | null) {
  return value === null ? null : value.split(".");
}

/** SemVer 2.0.0 precedence. */
export function compareVersions(a: string, b: string) {
  const x = parseVersion(a),
    y = parseVersion(b);
  for (const key of ["major", "minor", "patch"] as const)
    if (x[key] !== y[key]) return x[key] < y[key] ? -1 : 1;
  const p = identifiers(x.prerelease),
    q = identifiers(y.prerelease);
  if (p === null || q === null) return p === q ? 0 : p === null ? 1 : -1;
  for (let i = 0; i < Math.max(p.length, q.length); i++) {
    if (p[i] === undefined) return -1;
    if (q[i] === undefined) return 1;
    const m = /^\d+$/u.test(p[i]!),
      n = /^\d+$/u.test(q[i]!);
    if (m && n && Number(p[i]) !== Number(q[i])) return Number(p[i]) < Number(q[i]) ? -1 : 1;
    if (m !== n) return m ? -1 : 1;
    if (p[i] !== q[i]) return p[i]! < q[i]! ? -1 : 1;
  }
  return 0;
}

const workspaceVersionPattern = /(\[workspace\.package\][^[]*?\nversion = ")([^"]+)(")/u;

/** The `[workspace.package]` version in Cargo.toml. */
export function readWorkspaceVersion(root: string) {
  return parseWorkspaceVersion(readFileSync(path.join(root, "Cargo.toml"), "utf8"));
}

/** The `[workspace.package]` version in Cargo.toml text. */
export function parseWorkspaceVersion(cargoToml: string) {
  const match = workspaceVersionPattern.exec(cargoToml);
  if (!match) throw new Error("workspace.package version not found");
  parseVersion(match[2]!);
  return match[2]!;
}

/** Writes the release version into every version source used by the build. */
export function stampVersion(root: string, version: string) {
  parseVersion(version);
  const cargo = path.join(root, "Cargo.toml");
  const text = readFileSync(cargo, "utf8");
  const section = workspaceVersionPattern;
  if (!section.test(text)) throw new Error("workspace.package version not found");
  writeFileSync(cargo, text.replace(section, `$1${version}$3`));
  for (const file of ["apps/desktop/package.json", "apps/desktop/src-tauri/tauri.conf.json"]) {
    const target = path.join(root, file);
    const json = JSON.parse(readFileSync(target, "utf8")) as Record<string, unknown>;
    if (typeof json.version !== "string") throw new Error(`${file} has no version`);
    json.version = version;
    writeFileSync(target, `${JSON.stringify(json, null, 2)}\n`);
  }
}

type AppReleaseTarget = {
  label: string;
  os: string;
  target: string;
  rust_targets: string;
  bundles: string;
  cliTargets: Partial<
    Record<"windows-x86_64" | "linux-x86_64" | "macos-aarch64" | "macos-x86_64", string>
  >;
  display: string;
  download: { directory: string; suffix: string; purpose: string };
  updater: { directory: string; suffix: string; aliases: readonly string[]; source?: string };
};

export const appReleaseProfile: readonly AppReleaseTarget[] = [
  {
    label: "windows-x86_64",
    os: "windows-latest",
    target: "x86_64-pc-windows-msvc",
    rust_targets: "x86_64-pc-windows-msvc",
    bundles: "nsis",
    cliTargets: { "windows-x86_64": "x86_64-pc-windows-msvc" },
    display: "Windows x86-64",
    download: { directory: "nsis", suffix: "_x64-setup.exe", purpose: "Desktop installer" },
    updater: { directory: "nsis", suffix: "_x64-setup.exe", aliases: ["windows-x86_64"] },
  },
  {
    label: "linux-x86_64",
    os: "ubuntu-24.04",
    target: "x86_64-unknown-linux-gnu",
    rust_targets: "x86_64-unknown-linux-gnu",
    bundles: "appimage",
    cliTargets: { "linux-x86_64": "x86_64-unknown-linux-gnu" },
    display: "Linux x86-64",
    download: {
      directory: "appimage",
      suffix: "_amd64.AppImage",
      purpose: "Desktop AppImage (run directly)",
    },
    updater: { directory: "appimage", suffix: "_amd64.AppImage", aliases: ["linux-x86_64"] },
  },
  {
    label: "macos-universal",
    os: "macos-15",
    target: "universal-apple-darwin",
    rust_targets: "aarch64-apple-darwin,x86_64-apple-darwin",
    bundles: "app,dmg",
    cliTargets: { "macos-aarch64": "aarch64-apple-darwin", "macos-x86_64": "x86_64-apple-darwin" },
    display: "macOS Apple Silicon and Intel",
    download: { directory: "dmg", suffix: "_universal.dmg", purpose: "Desktop disk image" },
    updater: {
      directory: "macos",
      suffix: "_universal.app.tar.gz",
      aliases: ["darwin-aarch64", "darwin-x86_64"],
      source: "Portcove.app.tar.gz",
    },
  },
];

export function appReleaseMatrix() {
  return {
    include: appReleaseProfile.map(({ label, os, target, rust_targets, bundles, cliTargets }) => ({
      label,
      os,
      target,
      rust_targets,
      bundles,
      cli_targets: JSON.stringify(cliTargets),
    })),
  };
}

function bundleName(version: string, suffix: string) {
  return `Portcove_${version}${suffix}`;
}

function updaterSignature(bytes: string, filename: string) {
  const signature = bytes.trim();
  if (!signature) throw new Error(`missing signed updater asset signature in ${filename}`);
  return signature;
}

export function collectAppReleaseBundles(
  root: string,
  dist: string,
  label: string,
  version: string,
) {
  classifyRelease(version);
  const target = appReleaseProfile.find((entry) => entry.label === label);
  if (!target) throw new Error(`unknown app release target ${label}`);
  const bundle = path.join(root, "target", target.target, "release", "bundle");
  const files = new Map<string, string>();
  const download = bundleName(version, target.download.suffix);
  const updater = bundleName(version, target.updater.suffix);
  const source = path.join(bundle, target.updater.directory, target.updater.source ?? updater);
  files.set(download, path.join(bundle, target.download.directory, download));
  files.set(updater, source);
  files.set(`${updater}.sig`, `${source}.sig`);
  updaterSignature(readFileSync(`${source}.sig`, "utf8"), path.basename(source));
  mkdirSync(dist, { recursive: true });
  for (const [filename, from] of files) copyFileSync(from, path.join(dist, filename));
}

/** Tauri static updater feed from the published `.sig` files of one release. */
export function buildFeed(options: {
  version: string;
  notes: string;
  pubDate: string;
  assetsDir: string;
  downloadBase: string;
  profile?: readonly AppReleaseTarget[];
}) {
  const files = new Set(readdirSync(options.assetsDir));
  const platforms: Record<string, { signature: string; url: string }> = {};
  for (const { updater } of options.profile ?? appReleaseProfile) {
    const name = bundleName(options.version, updater.suffix);
    // The published release's asset set is verified separately; the feed needs its signatures.
    if (!files.has(`${name}.sig`)) throw new Error(`missing signed updater asset ${name}`);
    const signature = updaterSignature(
      readFileSync(path.join(options.assetsDir, `${name}.sig`), "utf8"),
      name,
    );
    for (const platform of updater.aliases)
      platforms[platform] = { signature, url: `${options.downloadBase}/${name}` };
  }
  return { version: options.version, notes: options.notes, pub_date: options.pubDate, platforms };
}

export type Runner = (command: "git", args: string[]) => string;

const defaultRunner: Runner = (command, args) =>
  execFileSync(command, args, { encoding: "utf8" }).trim();

/** Release tags are `vX.Y.Z[-preview.N]` (owner-only); nightly previews use `nightly-X.Y.Z-preview.N`. */
export const nightlyTagPrefix = "nightly-";
const versionTagPatterns = ["v*", `${nightlyTagPrefix}*`];

/**
 * The version a `v*` tag or a preview `nightly-*` tag names, or null for any other
 * tag. Any writer can create a `nightly-*` tag, so one naming a non-preview version
 * (such as `nightly-9.9.9`) is ignored rather than blocking owner releases.
 */
export function tagVersion(tag: string) {
  if (tag.startsWith("v")) {
    const version = tag.slice(1);
    return semver.test(version) ? version : null;
  }
  if (!tag.startsWith(nightlyTagPrefix)) return null;
  const version = tag.slice(nightlyTagPrefix.length);
  if (!semver.test(version)) return null;
  try {
    return classifyRelease(version).channel === "preview" ? version : null;
  } catch {
    return null;
  }
}

/** Every `v*` and `nightly-*` tag; both name versions that must never repeat. */
export function listVersionTags(run: Runner = defaultRunner) {
  return run("git", ["tag", "--list", ...versionTagPatterns])
    .split("\n")
    .filter(Boolean);
}

/** Refuses a version that is not newer than every existing `v*` and `nightly-*` version. */
export function assertNewerThanTags(
  version: string,
  tags: readonly string[],
  ownTag = `v${version}`,
) {
  for (const tag of tags) {
    if (tag === ownTag) continue;
    const prior = tagVersion(tag);
    if (prior === null) continue;
    if (compareVersions(prior, version) >= 0)
      throw new Error(`version ${version} must be greater than existing ${tag}`);
  }
}

/** Local guarded tagging for owners and agents: `just release X.Y.Z`. */
export function tagRelease(
  version: string,
  notesFile: string | undefined,
  ci: (sha: string) => string,
  run: Runner = defaultRunner,
) {
  const release = classifyRelease(version);
  const git = (args: string[]) => run("git", args);
  git(["fetch", "--quiet", "--tags", "origin", "main"]);
  const head = git(["rev-parse", "HEAD"]);
  if (head !== git(["rev-parse", "origin/main"]))
    throw new Error("HEAD must equal origin/main; check out the exact main commit to release");
  if (git(["status", "--porcelain", "--untracked-files=no"]) !== "")
    throw new Error("working tree has uncommitted changes");
  const tags = listVersionTags(run);
  if (tags.includes(`v${version}`)) throw new Error(`tag v${version} already exists`);
  assertNewerThanTags(version, tags);
  const conclusion = ci(head);
  if (conclusion !== "success")
    throw new Error(`CI has not succeeded on main commit ${head}; wait for it before releasing`);
  // verbatim keeps Markdown headings ("## Fixes") that the default strip mode removes.
  git([
    "tag",
    "-a",
    "--cleanup=verbatim",
    `v${version}`,
    ...(notesFile ? ["-F", notesFile] : ["-m", `Portcove ${version}`]),
    head,
  ]);
  git(["push", "origin", `refs/tags/v${version}`]);
  return { tag: `v${version}`, channel: release.channel, commit: head };
}

/** Release versions: valid SemVer `v*` tags without a pre-release part. */
function releaseVersions(tags: readonly string[]) {
  const versions: string[] = [];
  for (const tag of tags) {
    const version = tag.startsWith("v") ? tagVersion(tag) : null;
    if (version !== null && parseVersion(version).prerelease === null) versions.push(version);
  }
  return versions;
}

function newest<T>(items: readonly T[], version: (item: T) => string) {
  return items.reduce<T | null>(
    (best, item) =>
      best === null || compareVersions(version(item), version(best)) > 0 ? item : best,
    null,
  );
}

/**
 * The next nightly preview: a pre-release of the patch after the newest release,
 * or of the workspace version when that is higher or nothing is released yet.
 * N follows the highest `v*` or `nightly-*` preview of that version.
 */
export function nextPreviewVersion(tags: readonly string[], workspaceVersion: string) {
  const workspace = parseVersion(workspaceVersion);
  if (workspace.prerelease !== null)
    throw new Error(`workspace version ${workspaceVersion} must be X.Y.Z`);
  const released = newest(releaseVersions(tags), (version) => version);
  let base = workspaceVersion;
  if (released !== null) {
    const latest = parseVersion(released);
    const nextPatch = `${latest.major}.${latest.minor}.${latest.patch + 1}`;
    base = compareVersions(workspaceVersion, nextPatch) > 0 ? workspaceVersion : nextPatch;
  }
  const prefix = `${base}-preview.`;
  const previous: number[] = [];
  for (const tag of tags) {
    const version = tagVersion(tag);
    if (version?.startsWith(prefix) && /^(0|[1-9]\d*)$/u.test(version.slice(prefix.length)))
      previous.push(Number(version.slice(prefix.length)));
  }
  const version = `${base}-preview.${Math.max(0, ...previous) + 1}`;
  assertNewerThanTags(version, tags);
  return version;
}

const nightlyCommitLimit = 50;

/** Commit subjects become release notes; a full-width at sign cannot mention anyone. */
export function quietMentions(text: string) {
  return text.replaceAll("@", "＠");
}

/** How many first-parent `main` commits a nightly looks back for a CI-green one. */
export const nightlyLookback = 100;

/**
 * Tags and pushes at most one `nightly-X.Y.Z-preview.N`, at the newest CI-green
 * first-parent commit of `origin/main` that is newer than every commit carrying a
 * `v*` or `nightly-*` tag. On a busy `main` the newest commit often has no finished
 * `CI` run yet (pending runs are replaced), so an older reviewed commit is used.
 * The selected commit must support the reusable workflow's packaging profile.
 * The version follows the chosen commit's `Cargo.toml` workspace version.
 * The tag only names the release: signing is admitted by the `main` ref of the
 * nightly run, never by this tag.
 */
export async function nightlyPreview(
  ci: (sha: string) => Promise<string>,
  run: Runner = defaultRunner,
): Promise<{ skipped: string } | { tag: string; version: string; commit: string }> {
  const git = (args: string[]) => run("git", args);
  const head = git(["rev-parse", "HEAD"]);
  if (head !== git(["rev-parse", "origin/main"]))
    throw new Error("nightly previews are tagged only from the origin/main commit");
  const candidates = git(["rev-list", "--first-parent", "-n", String(nightlyLookback), head])
    .split("\n")
    .filter(Boolean);
  const seen: string[] = [];
  let commit = "";
  for (const sha of candidates) {
    const existing = git(["tag", "--points-at", sha, "--list", ...versionTagPatterns])
      .split("\n")
      .filter((tag) => tag.startsWith("v") || tagVersion(tag) !== null);
    if (existing.length > 0) {
      if (sha === head) return { skipped: `main ${head} is already tagged ${existing.join(", ")}` };
      return {
        skipped: `no CI-green main commit is newer than ${existing.join(", ")} (${seen.join("; ")})`,
      };
    }
    const conclusion = await ci(sha);
    if (conclusion === "success") {
      let script = "";
      try {
        script = git(["show", `${sha}:scripts/app-release.mts`]);
      } catch {
        // Older source may predate the tag release workflow.
      }
      if (
        script.includes('command === "build-matrix"') &&
        script.includes('command === "collect-bundles"')
      ) {
        commit = sha;
        break;
      }
      seen.push(`${sha.slice(0, 9)} predates the release profile`);
      continue;
    }
    seen.push(`${sha.slice(0, 9)} got '${conclusion || "none"}'`);
  }
  if (!commit)
    return {
      skipped: `No eligible CI-green candidate among any of the latest ${candidates.length} main commits (${seen.join("; ")})`,
    };
  const workspaceVersion = parseWorkspaceVersion(git(["show", `${commit}:Cargo.toml`]));
  const tags = listVersionTags(run);
  const version = nextPreviewVersion(tags, workspaceVersion);
  const tag = `${nightlyTagPrefix}${version}`;
  let previous = "";
  try {
    previous = git([
      "describe",
      "--tags",
      "--abbrev=0",
      ...versionTagPatterns.flatMap((pattern) => ["--match", pattern]),
      commit,
    ]);
  } catch {
    // No earlier version tag is reachable; the list then shows the latest commits.
  }
  const commits = git([
    "log",
    "--no-merges",
    "--format=- %s (%h)",
    "-n",
    String(nightlyCommitLimit + 1),
    previous ? `${previous}..${commit}` : commit,
  ])
    .split("\n")
    .filter(Boolean)
    .map(quietMentions);
  const listed = commits.slice(0, nightlyCommitLimit);
  if (commits.length > nightlyCommitLimit) listed.push("- and earlier commits");
  const message = [
    `Portcove ${version} (nightly)`,
    "",
    previous ? `Changes since ${previous}:` : "Recent changes:",
    "",
    ...listed,
    "",
  ].join("\n");
  git(["tag", "-a", "--cleanup=verbatim", tag, "-m", message, commit]);
  git(["push", "origin", `refs/tags/${tag}`]);
  return { tag, version, commit };
}

/**
 * Refuses to publish when another `v*` or `nightly-*` tag on the remote names the
 * same version, for example an owner tag pushed while a nightly was building.
 */
export function assertVersionUnclaimed(
  version: string,
  ownTag: string,
  run: Runner = defaultRunner,
) {
  const remote = run("git", [
    "ls-remote",
    "--tags",
    "origin",
    ...versionTagPatterns.map((pattern) => `refs/tags/${pattern}`),
  ]);
  const tags = new Set(
    remote
      .split("\n")
      .map((line) => line.split("\t")[1] ?? "")
      .filter((ref) => ref.startsWith("refs/tags/"))
      .map((ref) => ref.slice("refs/tags/".length).replace(/\^\{\}$/u, "")),
  );
  if (!tags.has(ownTag)) throw new Error(`${ownTag} is not on the remote`);
  const others = [...tags].filter((tag) => tag !== ownTag && tagVersion(tag) === version);
  if (others.length > 0)
    throw new Error(
      `${others.join(", ")} already names ${version}; ${ownTag} is not published to avoid two releases of one version`,
    );
}

/**
 * Refuses inputs to the shared build-and-publish workflow that disagree with the
 * version's classification, so no caller can route a Stable build to `release`
 * or publish anything but a preview under a `nightly-*` tag.
 */
export function verifyReleaseInputs(inputs: {
  tag: string;
  version: string;
  prerelease: string;
  feeds: string;
  environment: string;
  commit: string;
}) {
  const release = classifyRelease(inputs.version);
  const tags = [`v${inputs.version}`];
  if (release.channel === "preview") tags.push(`${nightlyTagPrefix}${inputs.version}`);
  if (!tags.includes(inputs.tag))
    throw new Error(`tag ${inputs.tag} does not name release ${inputs.version}`);
  if (!/^[a-f0-9]{40}$/u.test(inputs.commit)) throw new Error("commit must be a full SHA");
  const expected = {
    prerelease: String(release.prerelease),
    feeds: release.feeds.join(" "),
    environment: release.environment,
  };
  for (const key of ["prerelease", "feeds", "environment"] as const)
    if (inputs[key] !== expected[key])
      throw new Error(`${key} '${inputs[key]}' differs from ${inputs.version}: '${expected[key]}'`);
  return release;
}

const repository = "boburning/portcove";
const read = (): { request: { portcove: GitHubRequestPolicy } } => ({
  request: { portcove: { replay: "safe-read", attempts: 0 } },
});
const once = (): { request: { portcove: GitHubRequestPolicy } } => ({
  request: { portcove: { replay: "once", attempts: 0 } },
});

async function client(token: string, baseUrl?: string) {
  return createGitHubClient({
    credential: { kind: "explicit", token },
    deadline: performance.now() + 20 * 60_000,
    requestTimeoutMs: 600_000,
    maxBytes: 4 * 1024 * 1024,
    ...(baseUrl ? { baseUrl } : {}),
  });
}

/** Conclusion of the newest completed `CI` push run for one commit, or "" when none. */
export async function ciConclusion(token: string, sha: string) {
  const api = await client(token);
  const response = await api.request("GET /repos/{owner}/{repo}/actions/runs", {
    owner: "boburning",
    repo: "portcove",
    head_sha: sha,
    event: "push",
    per_page: 100,
    ...read(),
  });
  const runs = (
    response.data as {
      workflow_runs: {
        name: string;
        status: string;
        conclusion: string | null;
        run_attempt: number;
        id: number;
      }[];
    }
  ).workflow_runs
    .filter((run) => run.name === "CI" && run.status === "completed")
    .sort((a, b) => a.id - b.id || a.run_attempt - b.run_attempt);
  return runs.at(-1)?.conclusion ?? "";
}

type MainCiRun = {
  name: string;
  head_sha: string;
  head_branch: string;
  path: string;
  event: string;
  head_repository: { full_name: string } | null;
  status: string;
  conclusion: string | null;
  run_attempt: number;
  id: number;
};

export async function mainCiConclusions(token: string) {
  return readMainCiConclusions(await client(token));
}

/** Read the completed lookback and a recent view of the same main CI pushes.
 * GitHub's status index can omit an already completed recent run. Keep both
 * reads bounded and use the run's own current attempt and completion fields. */
export async function readMainCiConclusions(api: Awaited<ReturnType<typeof client>>) {
  const route = "GET /repos/{owner}/{repo}/actions/workflows/{workflow_id}/runs";
  const scope = {
    owner: "boburning",
    repo: "portcove",
    workflow_id: "ci.yml",
    branch: "main",
    event: "push",
    per_page: nightlyLookback,
    ...read(),
  };
  const views = await Promise.all([
    api.request(route, { ...scope, status: "completed" }),
    api.request(route, scope),
  ]);
  return newestConclusions(
    views.flatMap(({ data }) => {
      const { workflow_runs } = data as { workflow_runs: MainCiRun[] };
      if (!Array.isArray(workflow_runs) || workflow_runs.length > nightlyLookback)
        throw new Error("main CI run inventory exceeds its expected page");
      return workflow_runs;
    }),
  );
}

type MainCiConclusion = string | { unresolved: string };
export type MainCiConclusions = ReadonlyMap<string, MainCiConclusion>;

/** Read one first-parent decision. Earlier selection leaves older disputes alone. */
export function mainCiConclusion(conclusions: MainCiConclusions, sha: string) {
  const finding = conclusions.get(sha);
  if (typeof finding === "object") throw new Error(finding.unresolved);
  return finding ?? "";
}

/** Reconcile the newest observed main CI run and attempt per commit. */
export function newestConclusions(runs: readonly MainCiRun[]): MainCiConclusions {
  const newest = new Map<string, MainCiRun>();
  const attempts = new Map<string, MainCiRun>();
  const commits = new Map<number, string>();
  const successfulHeads = new Set<string>();
  const unresolved = new Map<string, string>();
  for (const run of runs) {
    if (
      run.name !== "CI" ||
      run.path !== ".github/workflows/ci.yml" ||
      run.head_branch !== "main" ||
      run.event !== "push" ||
      run.head_repository?.full_name !== "boburning/portcove" ||
      !/^[a-f0-9]{40}$/u.test(run.head_sha) ||
      !Number.isSafeInteger(run.id) ||
      run.id <= 0 ||
      !Number.isSafeInteger(run.run_attempt) ||
      run.run_attempt <= 0
    )
      continue;
    const oldCommit = commits.get(run.id);
    if (oldCommit !== undefined && oldCommit !== run.head_sha) {
      const reason = `main CI inventory disagrees about the commit for run ${run.id}`;
      unresolved.set(oldCommit, reason);
      unresolved.set(run.head_sha, reason);
      continue;
    }
    commits.set(run.id, run.head_sha);
    const identity = `${run.id}/${run.run_attempt}`;
    const seen = attempts.get(identity);
    if (seen) {
      const complete = run.status === "completed";
      if (
        (seen.status === "completed") !== complete ||
        (complete && seen.conclusion !== run.conclusion)
      )
        unresolved.set(run.head_sha, `main CI inventory disagrees about run attempt ${identity}`);
      continue;
    }
    attempts.set(identity, run);
    if (run.status === "completed" && run.conclusion === "success")
      successfulHeads.add(run.head_sha);
    const known = newest.get(run.head_sha);
    if (!known || run.id > known.id || (run.id === known.id && run.run_attempt > known.run_attempt))
      newest.set(run.head_sha, run);
  }
  const findings = new Map<string, MainCiConclusion>();
  for (const [sha, run] of newest) {
    if (run.status !== "completed" && successfulHeads.has(sha) && !unresolved.has(sha))
      unresolved.set(sha, `main CI success is superseded by an unfinished attempt for ${sha}`);
    findings.set(sha, run.status === "completed" ? (run.conclusion ?? "") : "");
  }
  for (const [sha, reason] of unresolved) findings.set(sha, { unresolved: reason });
  return findings;
}

type Release = {
  id: number;
  tag_name: string;
  draft: boolean;
  prerelease: boolean;
  body: string | null;
  published_at: string | null;
  assets: { id: number; name: string; browser_download_url: string }[];
};

/** Every release, drafts included (the by-tag endpoint omits drafts). */
export async function listReleases(api: Awaited<ReturnType<typeof client>>) {
  const origin = "https://api.github.com";
  const path = `/repos/${repository}/releases`;
  const inventoryPaths = [path, "/repositories/1354613114/releases"];
  const all = new Map<number, Release>();
  let pages = 0;
  try {
    for await (const response of iterateGitHubPages(api, {
      url: `${origin}${path}?per_page=100`,
      prepareRequest: async (url) => {
        const next = new URL(url);
        if (next.origin !== origin || !inventoryPaths.includes(next.pathname) || ++pages > 100)
          throw new Error("release inventory pagination exceeded its scope or 100-page budget");
      },
    })) {
      if (!Array.isArray(response.data)) throw new Error("invalid release inventory page");
      for (const release of response.data as Release[]) {
        if (!Number.isSafeInteger(release.id) || release.id <= 0 || !release.tag_name)
          throw new Error("release inventory lacks a stable ID or tag");
        const previous = all.get(release.id);
        if (
          previous &&
          (previous.tag_name !== release.tag_name || previous.draft !== release.draft)
        )
          throw new Error("release changed during inventory collection");
        all.set(release.id, release);
      }
    }
  } catch (cause) {
    throw new Error("release inventory is incomplete", { cause });
  }
  return [...all.values()];
}

export async function findPublishedRelease(api: Awaited<ReturnType<typeof client>>, tag: string) {
  try {
    const response = await api.request("GET /repos/{owner}/{repo}/releases/tags/{tag}", {
      owner: "boburning",
      repo: "portcove",
      tag,
      ...read(),
    });
    const release = response.data as Release;
    if (
      release.tag_name !== tag ||
      release.draft ||
      !Number.isSafeInteger(release.id) ||
      release.id <= 0
    )
      throw new Error("published release lookup returned an unexpected identity");
    return release;
  } catch (error) {
    if ((error as { status?: unknown }).status === 404) return null;
    throw error;
  }
}

export async function findRelease(api: Awaited<ReturnType<typeof client>>, tag: string) {
  const published = await findPublishedRelease(api, tag);
  if (published) return published;
  const matches = (await listReleases(api)).filter((release) => release.tag_name === tag);
  if (matches.length > 1) throw new Error(`more than one release exists for ${tag}`);
  return matches[0] ?? null;
}

export async function readReleaseById(
  api: Awaited<ReturnType<typeof client>>,
  id: number,
  tag: string,
) {
  const response = await api.request("GET /repos/{owner}/{repo}/releases/{release_id}", {
    owner: "boburning",
    repo: "portcove",
    release_id: id,
    ...read(),
  });
  const release = response.data as Release;
  if (release.id !== id || release.tag_name !== tag)
    throw new Error("release readback returned an unexpected identity");
  return release;
}

export async function assertAppReleaseAssets(
  version: string,
  names: readonly string[],
  profile = appReleaseProfile,
) {
  const policy = await loadPackagePolicy();
  const cliPlatforms = new Set(profile.flatMap(({ cliTargets }) => Object.keys(cliTargets)));
  const cli = policy.packages
    .filter((entry) => entry.interface === "cli" && cliPlatforms.has(entry.platform_label))
    .map((entry) => ({ label: entry.display_label, filename: artifactName(entry, version) }));
  if (cli.length !== cliPlatforms.size)
    throw new Error("app release CLI targets lack package policy");
  const desktopAssets = new Set(
    profile.flatMap(({ download, updater }) => {
      const name = bundleName(version, updater.suffix);
      return [bundleName(version, download.suffix), name, `${name}.sig`];
    }),
  );
  assertExactArtifactNames(
    [...cli.map((entry) => entry.filename), ...desktopAssets, "SHA256SUMS"],
    names,
    "app release assets",
  );
  return cli;
}

export async function renderAppReleaseDownloadSection(
  tag: string,
  version: string,
  names: readonly string[],
  profile = appReleaseProfile,
) {
  const cli = await assertAppReleaseAssets(version, names, profile);
  const channel = classifyRelease(version).channel;
  if (tag !== `v${version}` && !(channel === "preview" && tag === `nightly-${version}`))
    throw new Error("download section tag and version disagree");

  const base = `https://github.com/${repository}/releases/download/${tag}`;
  const link = (name: string) => `[${name}](${base}/${name})`;
  const rows: [string, string, string][] = profile.map(({ display, download }) => [
    display,
    download.purpose,
    bundleName(version, download.suffix),
  ]);
  for (const entry of cli)
    rows.push([entry.label, "Standalone CLI (extract and run)", entry.filename]);
  return [
    `## Download Portcove ${version}`,
    "",
    tag.startsWith("nightly-")
      ? "Channel: Nightly Preview"
      : `Channel: ${channel.charAt(0).toUpperCase()}${channel.slice(1)}`,
    "",
    "| Operating system and processor | Purpose | Download |",
    "| --- | --- | --- |",
    ...rows.map(([platform, purpose, name]) => `| ${platform} | ${purpose} | ${link(name)} |`),
    "",
    `Check the SHA-256 for your exact filename in ${link("SHA256SUMS")} before using it.`,
    "",
    ...profile.flatMap(({ download, updater }) =>
      updater.suffix === download.suffix
        ? []
        : [
            `The ${link(bundleName(version, updater.suffix))} archive is for the macOS updater. The signature files also serve the updater.`,
          ],
    ),
    "",
    "### CLI quick start",
    "",
    "Extract the standalone archive and open a terminal in that folder. Run `./portcove --version` and `./portcove --json capabilities` on Linux or macOS. In Windows PowerShell, use `.\\portcove.exe` in both commands. Check `schema_version` and the commands your frontend needs in the JSON. For Steam Add or Repair, use the CLI from this same release and processor.",
    "",
    `See the [CLI guide](https://github.com/${repository}/blob/${tag}/docs/CLI.md) for library selection and launch commands.`,
  ].join("\n");
}

/** Creates or completes the release so its asset set equals `distDir`, then publishes it once. */
export async function publishRelease(options: {
  token: string;
  tag: string;
  version: string;
  prerelease: boolean;
  notes: string;
  distDir: string;
  /** The built commit; GitHub uses it only if the tag does not exist yet. */
  commit?: string;
}) {
  const expected = readdirSync(options.distDir).sort();
  await assertAppReleaseAssets(options.version, expected);
  for (const name of expected.filter((entry) => entry.endsWith(".sig")))
    updaterSignature(readFileSync(path.join(options.distDir, name), "utf8"), name);
  const api = await client(options.token);
  const uploads = await client(options.token, "https://uploads.github.com");
  let release = await findRelease(api, options.tag);
  if (release === null) {
    const created = await api.request("POST /repos/{owner}/{repo}/releases", {
      owner: "boburning",
      repo: "portcove",
      tag_name: options.tag,
      ...(options.commit ? { target_commitish: options.commit } : {}),
      name: `Portcove ${options.tag.startsWith("nightly-") ? "Nightly — " : ""}${options.version}`,
      body: options.notes,
      draft: true,
      prerelease: options.prerelease,
      make_latest: "false",
      ...once(),
    });
    release = { ...(created.data as Release), assets: [] };
  }
  if (release.draft) {
    for (const asset of release.assets)
      await api.request("DELETE /repos/{owner}/{repo}/releases/assets/{asset_id}", {
        owner: "boburning",
        repo: "portcove",
        asset_id: asset.id,
        ...once(),
      });
    for (const name of expected)
      await uploads.request(
        `POST /repos/${repository}/releases/${release.id}/assets?name=${encodeURIComponent(name)}`,
        {
          data: new Uint8Array(readFileSync(path.join(options.distDir, name))),
          headers: { "Content-Type": "application/octet-stream" },
          ...once(),
        },
      );
  }
  const current = await readReleaseById(api, release.id, options.tag);
  const actual = current.assets.map((asset) => asset.name).sort();
  if (JSON.stringify(actual) !== JSON.stringify(expected))
    throw new Error(
      `release assets differ from this build: ${JSON.stringify({ expected, actual })}`,
    );
  if (current.draft) {
    const downloads = await renderAppReleaseDownloadSection(options.tag, options.version, actual);
    await api.request("PATCH /repos/{owner}/{repo}/releases/{release_id}", {
      owner: "boburning",
      repo: "portcove",
      release_id: current.id,
      draft: false,
      body: `${downloads}\n\n${options.notes}`,
      make_latest: options.prerelease ? "false" : "true",
      ...once(),
    });
  }
  return { id: current.id, assets: actual.length };
}

/** Writes the published release's `.sig` files, so the feed always matches the immutable bytes. */
export async function downloadPublishedSignatures(
  token: string,
  tag: string,
  dir: string,
  exactProfile = false,
) {
  const api = await client(token);
  const release = await findPublishedRelease(api, tag);
  if (release === null) throw new Error(`${tag} is not a published release`);
  if (exactProfile) {
    const version = tagVersion(tag);
    if (version === null) throw new Error("publisher readback has no release version");
    await assertAppReleaseAssets(
      version,
      release.assets.map(({ name }) => name),
    );
  }
  mkdirSync(dir, { recursive: true });
  for (const asset of release.assets.filter((entry) => entry.name.endsWith(".sig"))) {
    const response = await fetch(asset.browser_download_url, {
      signal: AbortSignal.timeout(60_000),
    });
    if (!response.ok) throw new Error(`download of ${asset.name} failed with ${response.status}`);
    const bytes = Buffer.from(await response.arrayBuffer());
    if (bytes.length > 4096) throw new Error(`${asset.name} exceeds the signature bound`);
    if (exactProfile) updaterSignature(bytes.toString("utf8"), asset.name);
    writeFileSync(path.join(dir, asset.name), bytes);
  }
}

/** `updates/withdrawn.json` on gh-pages: a sorted, unique JSON array of versions. */
export function parseWithdrawnList(text: string | null) {
  if (text === null) return [];
  const value: unknown = JSON.parse(text);
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string"))
    throw new Error("withdrawn.json must be a JSON array of versions");
  const versions = value as string[];
  for (const version of versions) parseVersion(version);
  return versions;
}

export function addWithdrawn(list: readonly string[], version: string) {
  parseVersion(version);
  return [...new Set([...list, version])].sort(compareVersions);
}

export function isWithdrawn(version: string, listText: string | null) {
  return parseWithdrawnList(listText).includes(version);
}

export type PublishedRelease = {
  id: number;
  tag: string;
  version: string;
  prerelease: boolean;
  body: string;
  publishedAt: string;
};

/**
 * Published (non-draft) releases whose `v*` tags name Preview, Beta or Stable
 * versions, or whose `nightly-*` tags name previews.
 */
export function publishedReleases(releases: readonly Omit<Release, "assets">[]) {
  const result: PublishedRelease[] = [];
  for (const release of releases) {
    const version = tagVersion(release.tag_name);
    if (release.draft || version === null) continue;
    let channel: Channel;
    try {
      channel = classifyRelease(version).channel;
    } catch {
      continue; // alpha, rehearsal and other non-release tags
    }
    if (release.tag_name.startsWith(nightlyTagPrefix) && channel !== "preview") continue;
    result.push({
      id: release.id,
      tag: release.tag_name,
      version,
      prerelease: release.prerelease,
      body: release.body ?? "",
      publishedAt: release.published_at ?? "",
    });
  }
  return result;
}

/** Published, non-withdrawn releases that the channel's feed may offer, newest first. */
export function replacementCandidates(
  channel: Channel,
  releases: readonly PublishedRelease[],
  withdrawn: readonly string[],
) {
  return releases
    .filter(
      (release) =>
        !withdrawn.includes(release.version) &&
        classifyRelease(release.version).feeds.includes(channel),
    )
    .sort((a, b) => compareVersions(b.version, a.version));
}

export const withdrawnNotice = "⚠️ Withdrawn — do not install.";
const channels: Channel[] = ["preview", "beta", "stable"];

export type WithdrawApi = {
  releases(): Promise<Omit<Release, "assets">[]>;
  /** Tag of the repository's Latest release, or null when none is Latest. */
  latestTag(): Promise<string | null>;
  /** Writes the published `.sig` assets of `tag` into `dir`. */
  signatures(tag: string, dir: string): Promise<void>;
  editRelease(id: number, fields: { body?: string; make_latest?: "true" | "false" }): Promise<void>;
};

function readOptional(file: string) {
  return existsSync(file) ? readFileSync(file, "utf8") : null;
}

/**
 * Records `version` as withdrawn on gh-pages, repoints every feed that serves a
 * withdrawn version to the newest eligible release with all four signatures (or
 * removes it), then marks the GitHub Release. Tags, releases and assets are never
 * deleted. The release may carry a `v*` or `nightly-*` tag. Re-runs are safe.
 */
export async function withdrawRelease(options: {
  version: string;
  note: string;
  repoDir: string;
  workDir: string;
  api: WithdrawApi;
  run?: Runner;
  sleep?: (milliseconds: number) => Promise<void>;
  log?: (message: string) => void;
}) {
  const { version, api } = options;
  classifyRelease(version);
  const run = options.run ?? defaultRunner;
  const log = options.log ?? ((message: string) => console.error(message));
  const sleep =
    options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const listed = await api.releases();
  const matches = listed.filter((release) => tagVersion(release.tag_name) === version);
  if (matches.length > 1) throw new Error(`more than one release exists for ${version}`);
  const target = matches[0];
  if (!target || target.draft) throw new Error(`${version} is not a published release`);
  const tag = target.tag_name;
  const releases = publishedReleases(listed);
  const latestBefore = await api.latestTag();

  // One feed per release, or null when its published signatures are incomplete.
  const feeds = new Map<string, string | null>();
  const feedFor = async (release: PublishedRelease) => {
    const cached = feeds.get(release.version);
    if (cached !== undefined) return cached;
    const dir = path.join(options.workDir, "signatures", release.tag);
    rmSync(dir, { recursive: true, force: true });
    mkdirSync(dir, { recursive: true });
    await api.signatures(release.tag, dir);
    let text: string | null = null;
    try {
      const feed = buildFeed({
        version: release.version,
        notes: release.body.trim() || `Portcove ${release.version}`,
        pubDate: release.publishedAt,
        assetsDir: dir,
        downloadBase: `https://github.com/${repository}/releases/download/${release.tag}`,
      });
      text = `${JSON.stringify(feed, null, 2)}\n`;
    } catch (error) {
      if (!(error instanceof Error && error.message.startsWith("missing signed updater asset")))
        throw error;
      log(`::warning::${release.tag} cannot replace a feed: ${error.message}`);
    }
    feeds.set(release.version, text);
    return text;
  };

  const git = (args: string[]) => run("git", ["-C", options.repoDir, ...args]);
  const site = path.join(options.workDir, "site");
  const siteGit = (args: string[]) => run("git", ["-C", site, ...args]);
  let withdrawn: string[] = [];
  const changes: Partial<Record<Channel, string>> = {};
  let pushed = false;
  for (let attempt = 1; ; attempt++) {
    git(["fetch", "--quiet", "origin", "refs/heads/gh-pages:refs/remotes/origin/gh-pages"]);
    rmSync(site, { recursive: true, force: true });
    git(["worktree", "prune"]);
    git([
      "worktree",
      "add",
      "--quiet",
      "--force",
      "--detach",
      site,
      "refs/remotes/origin/gh-pages",
    ]);
    const updates = path.join(site, "updates");
    const listFile = path.join(updates, "withdrawn.json");
    withdrawn = addWithdrawn(parseWithdrawnList(readOptional(listFile)), version);
    mkdirSync(updates, { recursive: true });
    writeFileSync(listFile, `${JSON.stringify(withdrawn, null, 2)}\n`);
    for (const key of Object.keys(changes)) delete changes[key as Channel];
    for (const channel of channels) {
      const feedFile = path.join(updates, channel, "latest.json");
      const text = readOptional(feedFile);
      if (text === null) continue;
      const current = (JSON.parse(text) as { version?: unknown }).version;
      if (typeof current !== "string") throw new Error(`${channel} feed has no version`);
      if (!withdrawn.includes(current)) continue;
      let replaced = false;
      for (const candidate of replacementCandidates(channel, releases, withdrawn)) {
        const feed = await feedFor(candidate);
        if (feed === null) continue;
        writeFileSync(feedFile, feed);
        changes[channel] = candidate.version;
        replaced = true;
        break;
      }
      if (!replaced) {
        rmSync(feedFile);
        changes[channel] = "removed";
      }
    }
    siteGit(["add", "--all", "updates"]);
    if (siteGit(["status", "--porcelain"]) === "") break;
    const summary = Object.entries(changes)
      .map(([channel, change]) => `${channel}: ${change}`)
      .join(", ");
    siteGit([
      "commit",
      "--quiet",
      "-m",
      `Withdraw Portcove ${version}${summary ? ` (${summary})` : ""}`,
    ]);
    try {
      siteGit(["push", "--quiet", "origin", "HEAD:refs/heads/gh-pages"]);
      pushed = true;
      break;
    } catch (error) {
      git(["worktree", "remove", "--force", site]);
      if (attempt >= 4)
        throw new Error("could not publish the withdrawal to gh-pages", { cause: error });
      await sleep(attempt * 5000);
    }
  }
  git(["worktree", "remove", "--force", site]);

  // The feeds are safe now; then mark the immutable release (notes and Latest stay editable).
  const fields: { body?: string; make_latest?: "true" | "false" } = {};
  const body = target.body ?? "";
  if (!body.startsWith(withdrawnNotice)) {
    const note = options.note.trim();
    fields.body = `${withdrawnNotice}${note ? ` ${note}` : ""}\n\n---\n\n${body}`;
  }
  if (!target.prerelease) fields.make_latest = "false";
  if (Object.keys(fields).length > 0) await api.editRelease(target.id, fields);
  let latest: string | null = null;
  if (latestBefore === tag) {
    const replacement = newest(
      releases.filter(
        (release) =>
          !release.prerelease &&
          !withdrawn.includes(release.version) &&
          classifyRelease(release.version).channel !== "preview",
      ),
      (release) => release.version,
    );
    if (replacement !== null) {
      await api.editRelease(replacement.id, { make_latest: "true" });
      latest = replacement.tag;
    }
  }
  const latestAfter = await api.latestTag();
  return { tag, withdrawn, feeds: changes, pushed, latestBefore, latest, latestAfter };
}

async function withdrawApi(token: string): Promise<WithdrawApi> {
  const api = await client(token);
  return {
    releases: () => listReleases(api),
    latestTag: async () => {
      try {
        const response = await api.request("GET /repos/{owner}/{repo}/releases/latest", {
          owner: "boburning",
          repo: "portcove",
          ...read(),
        });
        return (response.data as { tag_name: string }).tag_name;
      } catch (error) {
        if ((error as { status?: unknown }).status === 404) return null;
        throw error;
      }
    },
    signatures: (tag, dir) => downloadPublishedSignatures(token, tag, dir),
    editRelease: async (id, fields) => {
      await api.request("PATCH /repos/{owner}/{repo}/releases/{release_id}", {
        owner: "boburning",
        repo: "portcove",
        release_id: id,
        ...fields,
        ...once(),
      });
    },
  };
}

async function main(argv: string[]) {
  const [command, ...rest] = argv;
  const token = () => {
    const value = process.env.GH_TOKEN;
    if (!value) throw new Error("GH_TOKEN is required");
    return value;
  };
  // Locally an owner usually has `gh auth` rather than GH_TOKEN.
  const localToken = () =>
    process.env.GH_TOKEN || execFileSync("gh", ["auth", "token"], { encoding: "utf8" }).trim();
  const flag = (name: string) => {
    const index = rest.indexOf(`--${name}`);
    if (index < 0 || rest[index + 1] === undefined) throw new Error(`--${name} is required`);
    return rest[index + 1]!;
  };
  if (command === "build-matrix") {
    console.log(`matrix=${JSON.stringify(appReleaseMatrix())}`);
  } else if (command === "collect-bundles") {
    collectAppReleaseBundles(process.cwd(), flag("dist"), flag("target-label"), flag("version"));
  } else if (command === "plan") {
    const tag = flag("tag");
    if (!tag.startsWith("v")) throw new Error("release tags start with v");
    const release = classifyRelease(tag.slice(1));
    // The workflow checks out full history, so every v* and nightly-* tag is visible here.
    assertNewerThanTags(release.version, listVersionTags());
    console.log(`version=${release.version}`);
    console.log(`channel=${release.channel}`);
    console.log(`prerelease=${release.prerelease}`);
    console.log(`environment=${release.environment}`);
    console.log(`feeds=${release.feeds.join(" ")}`);
  } else if (command === "verify-inputs") {
    const release = verifyReleaseInputs({
      tag: flag("tag"),
      version: flag("version"),
      prerelease: flag("prerelease"),
      feeds: flag("feeds"),
      environment: flag("environment"),
      commit: flag("commit"),
    });
    console.log(`${flag("tag")} is a ${release.channel} release signed in ${release.environment}`);
  } else if (command === "version-unclaimed") {
    assertVersionUnclaimed(flag("version"), flag("tag"));
    console.log(`no other tag names ${flag("version")}`);
  } else if (command === "stamp") stampVersion(process.cwd(), flag("version"));
  else if (command === "feed")
    console.log(
      JSON.stringify(
        buildFeed({
          version: flag("version"),
          notes: readFileSync(flag("notes-file"), "utf8").trim(),
          pubDate: flag("pub-date"),
          assetsDir: flag("assets-dir"),
          downloadBase: flag("download-base"),
        }),
        null,
        2,
      ),
    );
  else if (command === "compare") {
    // Exit 0 when --candidate is newer than --current (or no current feed exists).
    const current = rest.includes("--current") ? flag("current") : "";
    process.exitCode = current === "" || compareVersions(flag("candidate"), current) > 0 ? 0 : 1;
  } else if (command === "ci-status") {
    const conclusion = await ciConclusion(token(), flag("sha"));
    if (conclusion !== "success")
      throw new Error(`CI on ${flag("sha")} has not succeeded (got '${conclusion || "none"}')`);
  } else if (command === "publish") {
    const result = await publishRelease({
      token: token(),
      tag: flag("tag"),
      version: flag("version"),
      prerelease: flag("prerelease") === "true",
      notes: readFileSync(flag("notes-file"), "utf8"),
      distDir: flag("dist"),
      commit: flag("commit"),
    });
    console.log(`published release ${result.id} with ${result.assets} assets`);
  } else if (command === "download-signatures")
    await downloadPublishedSignatures(
      token(),
      flag("tag"),
      flag("dir"),
      rest.includes("--exact-profile"),
    );
  else if (command === "withdrawn")
    // Prints true or false; an unreadable list fails instead of reading as "not withdrawn".
    console.log(String(isWithdrawn(flag("version"), readOptional(flag("file")))));
  else if (command === "next-preview")
    console.log(nextPreviewVersion(listVersionTags(), readWorkspaceVersion(process.cwd())));
  else if (command === "nightly-preview") {
    const conclusions = await mainCiConclusions(token());
    const result = await nightlyPreview(async (sha) => mainCiConclusion(conclusions, sha));
    if ("skipped" in result) {
      console.error(`::notice::No nightly preview: ${result.skipped}`);
      console.log("tag=");
    } else {
      console.error(`Tagged ${result.tag} at ${result.commit}`);
      console.log(`tag=${result.tag}`);
      console.log(`version=${result.version}`);
      console.log(`commit=${result.commit}`);
      const release = classifyRelease(result.version);
      console.log(`prerelease=${release.prerelease}`);
      console.log(`feeds=${release.feeds.join(" ")}`);
    }
  } else if (command === "withdraw") {
    const note = process.env.PORTCOVE_WITHDRAW_NOTE ?? "";
    if (note.length > 2000) throw new Error("the replacement note exceeds 2000 characters");
    const version = flag("version");
    parseVersion(version);
    const workDir = mkdtempSync(path.join(os.tmpdir(), "portcove-withdraw-"));
    const result = await withdrawRelease({
      version,
      note,
      repoDir: process.cwd(),
      workDir,
      api: await withdrawApi(token()),
    });
    console.log(JSON.stringify(result, null, 2));
    if (result.latestAfter === result.tag)
      console.error(`::warning::${result.tag} is still the Latest release; change it manually.`);
  } else if (command === "tag") {
    // Resolve CI first; the guard itself stays synchronous and re-checks HEAD.
    const head = defaultRunner("git", ["rev-parse", "HEAD"]);
    const conclusion = await ciConclusion(localToken(), head);
    const result = tagRelease(
      flag("version"),
      process.env.PORTCOVE_RELEASE_NOTES_FILE || undefined,
      (sha) => (sha === head ? conclusion : ""),
    );
    console.log(`tagged ${result.tag} (${result.channel}) at ${result.commit}`);
  } else
    throw new Error(
      "usage: app-release.mts build-matrix|collect-bundles|plan|stamp|feed|compare|ci-status|publish|download-signatures|withdrawn|next-preview|nightly-preview|verify-inputs|version-unclaimed|withdraw|tag",
    );
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  main(process.argv.slice(2)).catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
