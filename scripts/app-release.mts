// Simple tag-driven application release (owner decision on #534, 2026-11-13).
// A `v*` tag on protected main is the release decision. CI builds, signs with the
// Tauri updater key and publishes the GitHub Release plus a per-channel
// `latest.json` feed. No AI review, journal or controller is involved.
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync, readdirSync, mkdirSync } from "node:fs";
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

/** Writes the release version into every version source used by the build. */
export function stampVersion(root: string, version: string) {
  parseVersion(version);
  const cargo = path.join(root, "Cargo.toml");
  const text = readFileSync(cargo, "utf8");
  const section = /(\[workspace\.package\][^[]*?\nversion = ")[^"]+(")/u;
  if (!section.test(text)) throw new Error("workspace.package version not found");
  writeFileSync(cargo, text.replace(section, `$1${version}$2`));
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
  assets: { id: number; name: string; browser_download_url: string }[];
};

async function findRelease(api: Awaited<ReturnType<typeof client>>, tag: string) {
  // The list endpoint includes drafts, which the by-tag endpoint does not.
  for (let page = 1; page <= 10; page++) {
    const response = await api.request("GET /repos/{owner}/{repo}/releases", {
      owner: "boburning",
      repo: "portcove",
      per_page: 100,
      page,
      ...read(),
    });
    const releases = response.data as Release[];
    const matches = releases.filter((release) => release.tag_name === tag);
    if (matches.length > 1) throw new Error(`more than one release exists for ${tag}`);
    if (matches[0]) return matches[0];
    if (releases.length < 100) return null;
  }
  throw new Error("release inventory exceeds its bound");
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

async function main(argv: string[]) {
  const [command, ...rest] = argv;
  const token = () => {
    const value = process.env.GH_TOKEN;
    if (!value) throw new Error("GH_TOKEN is required");
    return value;
  };
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
  else if (command === "tag") {
    const result = tagRelease(
      flag("version"),
      process.env.PORTCOVE_RELEASE_NOTES_FILE || undefined,
    );
    console.log(`tagged ${result.tag} (${result.channel}) at ${result.commit}`);
  } else
    throw new Error(
      "usage: app-release.mts plan|stamp|feed|compare|ci-status|publish|download-signatures|tag",
    );
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  main(process.argv.slice(2)).catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
