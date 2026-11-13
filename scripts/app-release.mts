// Simple tag-driven application release (owner decision on #534, 2026-11-13).
// A `v*` tag on protected main is the release decision. CI builds, signs with the
// Tauri updater key and publishes the GitHub Release plus a per-channel
// `latest.json` feed. No AI review, journal or controller is involved.
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync, readdirSync } from "node:fs";
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

/** Tauri static updater feed from the signed assets of one release. */
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
    if (!files.has(name) || !files.has(`${name}.sig`))
      throw new Error(`missing signed updater asset ${name}`);
    platforms[platform] = {
      signature: readFileSync(path.join(options.assetsDir, `${name}.sig`), "utf8").trim(),
      url: `${options.downloadBase}/${name}`,
    };
  }
  return { version: options.version, notes: options.notes, pub_date: options.pubDate, platforms };
}

export type Runner = (command: "git" | "gh", args: string[]) => string;

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
export function tagRelease(version: string, notesFile?: string, run: Runner = defaultRunner) {
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
  const runs = JSON.parse(
    run("gh", [
      "run",
      "list",
      "--commit",
      head,
      "--workflow",
      "CI",
      "--event",
      "push",
      "--json",
      "conclusion,status",
    ]),
  ) as { conclusion: string; status: string }[];
  if (!runs.some((entry) => entry.status === "completed" && entry.conclusion === "success"))
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

function main(argv: string[]) {
  const [command, ...rest] = argv;
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
  } else if (command === "tag") {
    const result = tagRelease(
      flag("version"),
      process.env.PORTCOVE_RELEASE_NOTES_FILE || undefined,
    );
    console.log(`tagged ${result.tag} (${result.channel}) at ${result.commit}`);
  } else throw new Error("usage: app-release.mts plan|stamp|feed|compare|tag");
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  main(process.argv.slice(2));
