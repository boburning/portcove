// Simple tag-driven application release (owner decision on #534, 2026-11-13).
// A `v*` tag on protected main is the release decision. CI builds, signs with the
// Tauri updater key and publishes the GitHub Release plus a per-channel
// `latest.json` feed. No AI review, journal or controller is involved.
import { execFileSync } from "node:child_process";
import {
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
import { createGitHubClient, type GitHubRequestPolicy } from "./github-client.mts";
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
  const match = workspaceVersionPattern.exec(readFileSync(path.join(root, "Cargo.toml"), "utf8"));
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

const platformAssets: { platform: string; suffix: string }[] = [
  { platform: "windows-x86_64", suffix: "_x64-setup.exe" },
  { platform: "linux-x86_64", suffix: "_amd64.AppImage" },
  { platform: "darwin-aarch64", suffix: "_universal.app.tar.gz" },
  { platform: "darwin-x86_64", suffix: "_universal.app.tar.gz" },
];

/** Tauri static updater feed from the published `.sig` files of one release. */
export function buildFeed(options: {
  version: string;
  notes: string;
  pubDate: string;
  assetsDir: string;
  downloadBase: string;
}) {
  const files = new Set(readdirSync(options.assetsDir));
  const platforms: Record<string, { signature: string; url: string }> = {};
  for (const { platform, suffix } of platformAssets) {
    const name = `Portcove_${options.version}${suffix}`;
    // The published release's asset set is verified separately; the feed needs its signatures.
    if (!files.has(`${name}.sig`)) throw new Error(`missing signed updater asset ${name}`);
    platforms[platform] = {
      signature: readFileSync(path.join(options.assetsDir, `${name}.sig`), "utf8").trim(),
      url: `${options.downloadBase}/${name}`,
    };
  }
  return { version: options.version, notes: options.notes, pub_date: options.pubDate, platforms };
}

export type Runner = (command: "git", args: string[]) => string;

const defaultRunner: Runner = (command, args) =>
  execFileSync(command, args, { encoding: "utf8" }).trim();

/** Refuses a version that is not newer than every existing release tag. */
export function assertNewerThanTags(version: string, tags: readonly string[]) {
  for (const tag of tags) {
    if (tag === `v${version}`) continue;
    const prior = tag.slice(1);
    if (!tag.startsWith("v") || !semver.test(prior)) continue;
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
  const tags = git(["tag", "--list", "v*"]).split("\n").filter(Boolean);
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

/** Release tags: valid SemVer `v*` tags without a pre-release part. */
function releaseVersions(tags: readonly string[]) {
  return tags
    .filter((tag) => tag.startsWith("v") && semver.test(tag.slice(1)))
    .map((tag) => tag.slice(1))
    .filter((version) => parseVersion(version).prerelease === null);
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
  const prefix = `v${base}-preview.`;
  const previous = tags
    .filter((tag) => tag.startsWith(prefix) && /^(0|[1-9]\d*)$/u.test(tag.slice(prefix.length)))
    .map((tag) => Number(tag.slice(prefix.length)));
  const version = `${base}-preview.${Math.max(0, ...previous) + 1}`;
  assertNewerThanTags(version, tags);
  return version;
}

const nightlyCommitLimit = 50;

/**
 * Tags and pushes at most one nightly preview of the `origin/main` commit. Skips
 * when that commit already carries a `v*` tag or its CI has not succeeded.
 */
export function nightlyPreview(
  workspaceVersion: string,
  ci: (sha: string) => string,
  run: Runner = defaultRunner,
): { skipped: string } | { tag: string; version: string; commit: string } {
  const git = (args: string[]) => run("git", args);
  const head = git(["rev-parse", "HEAD"]);
  if (head !== git(["rev-parse", "origin/main"]))
    throw new Error("nightly previews are tagged only from the origin/main commit");
  const existing = git(["tag", "--points-at", head, "--list", "v*"]).split("\n").filter(Boolean);
  if (existing.length > 0)
    return { skipped: `main ${head} is already tagged ${existing.join(", ")}` };
  const conclusion = ci(head);
  if (conclusion !== "success")
    return { skipped: `CI on main ${head} has not succeeded (got '${conclusion || "none"}')` };
  const tags = git(["tag", "--list", "v*"]).split("\n").filter(Boolean);
  const version = nextPreviewVersion(tags, workspaceVersion);
  let previous = "";
  try {
    previous = git(["describe", "--tags", "--abbrev=0", "--match", "v*", head]);
  } catch {
    // No earlier v* tag is reachable; the list then shows the latest commits.
  }
  const commits = git([
    "log",
    "--no-merges",
    "--format=- %s (%h)",
    "-n",
    String(nightlyCommitLimit + 1),
    previous ? `${previous}..${head}` : head,
  ])
    .split("\n")
    .filter(Boolean);
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
  git(["tag", "-a", "--cleanup=verbatim", `v${version}`, "-m", message, head]);
  git(["push", "origin", `refs/tags/v${version}`]);
  return { tag: `v${version}`, version, commit: head };
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
async function listReleases(api: Awaited<ReturnType<typeof client>>) {
  const all: Release[] = [];
  for (let page = 1; page <= 10; page++) {
    const response = await api.request("GET /repos/{owner}/{repo}/releases", {
      owner: "boburning",
      repo: "portcove",
      per_page: 100,
      page,
      ...read(),
    });
    const releases = response.data as Release[];
    all.push(...releases);
    if (releases.length < 100) return all;
  }
  throw new Error("release inventory exceeds its bound");
}

async function findRelease(api: Awaited<ReturnType<typeof client>>, tag: string) {
  const matches = (await listReleases(api)).filter((release) => release.tag_name === tag);
  if (matches.length > 1) throw new Error(`more than one release exists for ${tag}`);
  return matches[0] ?? null;
}

/** Creates or completes the release so its asset set equals `distDir`, then publishes it once. */
export async function publishRelease(options: {
  token: string;
  tag: string;
  version: string;
  prerelease: boolean;
  notes: string;
  distDir: string;
}) {
  const api = await client(options.token);
  const uploads = await client(options.token, "https://uploads.github.com");
  const expected = readdirSync(options.distDir).sort();
  let release = await findRelease(api, options.tag);
  if (release === null) {
    const created = await api.request("POST /repos/{owner}/{repo}/releases", {
      owner: "boburning",
      repo: "portcove",
      tag_name: options.tag,
      name: `Portcove ${options.version}`,
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
  const current = (await findRelease(api, options.tag))!;
  const actual = current.assets.map((asset) => asset.name).sort();
  if (JSON.stringify(actual) !== JSON.stringify(expected))
    throw new Error(
      `release assets differ from this build: ${JSON.stringify({ expected, actual })}`,
    );
  if (current.draft)
    await api.request("PATCH /repos/{owner}/{repo}/releases/{release_id}", {
      owner: "boburning",
      repo: "portcove",
      release_id: current.id,
      draft: false,
      make_latest: options.prerelease ? "false" : "true",
      ...once(),
    });
  return { id: current.id, assets: actual.length };
}

/** Writes the published release's `.sig` files, so the feed always matches the immutable bytes. */
export async function downloadPublishedSignatures(token: string, tag: string, dir: string) {
  const api = await client(token);
  const release = await findRelease(api, tag);
  if (release === null || release.draft) throw new Error(`${tag} is not a published release`);
  mkdirSync(dir, { recursive: true });
  for (const asset of release.assets.filter((entry) => entry.name.endsWith(".sig"))) {
    const response = await fetch(asset.browser_download_url, {
      signal: AbortSignal.timeout(60_000),
    });
    if (!response.ok) throw new Error(`download of ${asset.name} failed with ${response.status}`);
    const bytes = Buffer.from(await response.arrayBuffer());
    if (bytes.length > 4096) throw new Error(`${asset.name} exceeds the signature bound`);
    writeFileSync(path.join(dir, asset.name), bytes);
  }
}

/** Starts `app-release.yml` on an existing release tag; tags pushed with GITHUB_TOKEN start nothing. */
export async function dispatchRelease(token: string, tag: string) {
  if (!tag.startsWith("v")) throw new Error("release tags start with v");
  classifyRelease(tag.slice(1));
  const api = await client(token);
  await api.request("POST /repos/{owner}/{repo}/actions/workflows/{workflow_id}/dispatches", {
    owner: "boburning",
    repo: "portcove",
    workflow_id: "app-release.yml",
    ref: tag,
    ...once(),
  });
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
  version: string;
  prerelease: boolean;
  body: string;
  publishedAt: string;
};

/** Published (non-draft) releases whose tags are Preview, Beta or Stable versions. */
export function publishedReleases(releases: readonly Omit<Release, "assets">[]) {
  const result: PublishedRelease[] = [];
  for (const release of releases) {
    if (release.draft || !release.tag_name.startsWith("v")) continue;
    const version = release.tag_name.slice(1);
    try {
      classifyRelease(version);
    } catch {
      continue; // alpha, rehearsal and other non-release tags
    }
    result.push({
      id: release.id,
      version,
      prerelease: release.prerelease,
      body: release.body ?? "",
      publishedAt: release.published_at ?? "",
    });
  }
  return result;
}

/** Newest published, non-withdrawn release that the channel's feed may offer. */
export function selectReplacement(
  channel: Channel,
  releases: readonly PublishedRelease[],
  withdrawn: readonly string[],
) {
  return newest(
    releases.filter(
      (release) =>
        !withdrawn.includes(release.version) &&
        classifyRelease(release.version).feeds.includes(channel),
    ),
    (release) => release.version,
  );
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
 * withdrawn version to the newest eligible release (or removes it), then marks
 * the GitHub Release. Tags, releases and assets are never deleted. Re-runs are safe.
 */
export async function withdrawRelease(options: {
  version: string;
  note: string;
  repoDir: string;
  workDir: string;
  api: WithdrawApi;
  run?: Runner;
  sleep?: (milliseconds: number) => Promise<void>;
}) {
  const { version, api } = options;
  classifyRelease(version);
  const run = options.run ?? defaultRunner;
  const sleep =
    options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const tag = `v${version}`;
  const listed = await api.releases();
  const target = listed.find((release) => release.tag_name === tag);
  if (!target || target.draft) throw new Error(`${tag} is not a published release`);
  const releases = publishedReleases(listed);
  const latestBefore = await api.latestTag();

  const feeds = new Map<string, string>();
  const feedFor = async (release: PublishedRelease) => {
    const cached = feeds.get(release.version);
    if (cached !== undefined) return cached;
    const releaseTag = `v${release.version}`;
    const dir = path.join(options.workDir, "signatures", releaseTag);
    rmSync(dir, { recursive: true, force: true });
    mkdirSync(dir, { recursive: true });
    await api.signatures(releaseTag, dir);
    const feed = buildFeed({
      version: release.version,
      notes: release.body.trim() || `Portcove ${release.version}`,
      pubDate: release.publishedAt,
      assetsDir: dir,
      downloadBase: `https://github.com/${repository}/releases/download/${releaseTag}`,
    });
    const text = `${JSON.stringify(feed, null, 2)}\n`;
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
    git(["fetch", "--quiet", "origin", "gh-pages"]);
    rmSync(site, { recursive: true, force: true });
    git(["worktree", "prune"]);
    git(["worktree", "add", "--quiet", "--force", "--detach", site, "origin/gh-pages"]);
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
      const replacement = selectReplacement(channel, releases, withdrawn);
      if (replacement === null) {
        rmSync(feedFile);
        changes[channel] = "removed";
      } else {
        writeFileSync(feedFile, await feedFor(replacement));
        changes[channel] = replacement.version;
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
      siteGit(["push", "--quiet", "origin", "HEAD:gh-pages"]);
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
      latest = `v${replacement.version}`;
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
  if (command === "plan") {
    const tag = flag("tag");
    if (!tag.startsWith("v")) throw new Error("release tags start with v");
    const release = classifyRelease(tag.slice(1));
    // The workflow checks out full history, so every release tag is visible here.
    assertNewerThanTags(
      release.version,
      execFileSync("git", ["tag", "--list", "v*"], { encoding: "utf8" })
        .split("\n")
        .filter(Boolean),
    );
    console.log(`version=${release.version}`);
    console.log(`channel=${release.channel}`);
    console.log(`prerelease=${release.prerelease}`);
    console.log(`environment=${release.environment}`);
    console.log(`feeds=${release.feeds.join(" ")}`);
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
    });
    console.log(`published release ${result.id} with ${result.assets} assets`);
  } else if (command === "download-signatures")
    await downloadPublishedSignatures(token(), flag("tag"), flag("dir"));
  else if (command === "withdrawn")
    // Prints true or false; an unreadable list fails instead of reading as "not withdrawn".
    console.log(String(isWithdrawn(flag("version"), readOptional(flag("file")))));
  else if (command === "next-preview")
    console.log(
      nextPreviewVersion(
        defaultRunner("git", ["tag", "--list", "v*"]).split("\n").filter(Boolean),
        readWorkspaceVersion(process.cwd()),
      ),
    );
  else if (command === "nightly-preview") {
    const head = defaultRunner("git", ["rev-parse", "HEAD"]);
    const conclusion = await ciConclusion(token(), head);
    const result = nightlyPreview(readWorkspaceVersion(process.cwd()), (sha) =>
      sha === head ? conclusion : "",
    );
    if ("skipped" in result) {
      console.error(`::notice::No nightly preview: ${result.skipped}`);
      console.log("tag=");
    } else {
      console.error(`Tagged ${result.tag} at ${result.commit}`);
      console.log(`tag=${result.tag}`);
    }
  } else if (command === "dispatch") {
    await dispatchRelease(token(), flag("tag"));
    console.log(`dispatched app-release.yml on ${flag("tag")}`);
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
      "usage: app-release.mts plan|stamp|feed|compare|ci-status|publish|download-signatures|withdrawn|next-preview|nightly-preview|dispatch|withdraw|tag",
    );
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  main(process.argv.slice(2)).catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
