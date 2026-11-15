/**
 * Pure rules and the feed gate for the hosted installed-update acceptance
 * (`.github/workflows/hosted-installed-update.yml`, issue #52).
 *
 * Everything here reads public HTTPS only: the fixed production channel feeds
 * and public GitHub Release assets. Nothing authenticates, publishes, signs or
 * writes outside the caller's evidence directory. The Windows driver lives in
 * `apps/desktop/scripts/desktop-hosted-installed-update.mts` and reuses these
 * rules so they stay unit-tested on every platform.
 */
import { createHash } from "node:crypto";
import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { isRecord, errorMessage } from "./runtime-values.mts";

export const repository = "boburning/portcove";
export const channels = ["preview", "beta"] as const;
export type Channel = (typeof channels)[number];
/** The client's fixed feed URLs (`application_update.rs`); never configurable here. */
export const feedUrls: Record<Channel, string> = {
  beta: "https://boburning.github.io/portcove/updates/beta/latest.json",
  preview: "https://boburning.github.io/portcove/updates/preview/latest.json",
};
export const windowsPlatform = "windows-x86_64";
const maxFeedBytes = 256 * 1024;
const maxSumsBytes = 64 * 1024;

const semverPattern =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*))*))?(?:\+([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/u;

interface ParsedVersion {
  core: [bigint, bigint, bigint];
  prerelease: string[];
}

function parseVersion(version: string): ParsedVersion {
  const match = semverPattern.exec(version);
  if (!match) throw new Error(`not a semantic version: ${JSON.stringify(version)}`);
  return {
    core: [BigInt(match[1] ?? ""), BigInt(match[2] ?? ""), BigInt(match[3] ?? "")],
    prerelease: match[4] ? match[4].split(".") : [],
  };
}

export function isSemver(version: string) {
  return semverPattern.test(version);
}

/** SemVer 2.0.0 precedence (build metadata ignored): -1, 0 or 1. */
export function compareVersions(left: string, right: string): -1 | 0 | 1 {
  const a = parseVersion(left);
  const b = parseVersion(right);
  for (let index = 0; index < 3; index++) {
    const x = a.core[index] ?? 0n;
    const y = b.core[index] ?? 0n;
    if (x !== y) return x < y ? -1 : 1;
  }
  if (!a.prerelease.length || !b.prerelease.length) {
    if (a.prerelease.length === b.prerelease.length) return 0;
    return a.prerelease.length ? -1 : 1;
  }
  for (let index = 0; index < Math.max(a.prerelease.length, b.prerelease.length); index++) {
    const x = a.prerelease[index];
    const y = b.prerelease[index];
    if (x === undefined) return -1;
    if (y === undefined) return 1;
    const xNumeric = /^\d+$/u.test(x);
    const yNumeric = /^\d+$/u.test(y);
    if (xNumeric && yNumeric) {
      const difference = BigInt(x) - BigInt(y);
      if (difference !== 0n) return difference < 0n ? -1 : 1;
    } else if (xNumeric !== yNumeric) return xNumeric ? -1 : 1;
    else if (x !== y) return x < y ? -1 : 1;
  }
  return 0;
}

/** Release asset names the existing release pipeline publishes for one version. */
export function windowsAssetNames(version: string) {
  if (!isSemver(version)) throw new Error(`not a semantic version: ${version}`);
  return {
    installer: `Portcove_${version}_x64-setup.exe`,
    cli: `portcove-cli-${version}-windows-x86_64.zip`,
  };
}

const tagPattern = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;
const assetPattern = /^[A-Za-z0-9][A-Za-z0-9._+-]{0,254}$/u;

export function releaseAssetUrl(tag: string, asset: string) {
  if (!tagPattern.test(tag)) throw new Error(`unsupported release tag: ${tag}`);
  if (!assetPattern.test(asset)) throw new Error(`unsupported asset name: ${asset}`);
  return `https://github.com/${repository}/releases/download/${tag}/${asset}`;
}

/** Splits a public release download URL of this repository into tag and asset. */
export function parseReleaseAssetUrl(url: string) {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(`feed URL is not a URL: ${url}`);
  }
  const prefix = `/${repository}/releases/download/`;
  if (
    parsed.protocol !== "https:" ||
    parsed.host !== "github.com" ||
    parsed.search ||
    parsed.hash ||
    !parsed.pathname.startsWith(prefix)
  )
    throw new Error(`feed URL is not a ${repository} release asset: ${url}`);
  const parts = parsed.pathname.slice(prefix.length).split("/");
  const [tag, asset] = parts.map((part) => decodeURIComponent(part));
  if (parts.length !== 2 || !tag || !asset || !tagPattern.test(tag) || !assetPattern.test(asset))
    throw new Error(`feed URL has an unexpected release path: ${url}`);
  return { tag, asset };
}

/** Parses `SHA256SUMS` (`<hex>  <name>` lines). Names must be plain and unique. */
export function parseSha256Sums(text: string) {
  if (Buffer.byteLength(text) > maxSumsBytes) throw new Error("SHA256SUMS is too large");
  const sums = new Map<string, string>();
  for (const [index, line] of text.split(/\r?\n/u).entries()) {
    if (!line.trim()) continue;
    const match = /^([a-f0-9]{64}) [ *]([^\s/\\][^/\\]*)$/u.exec(line);
    if (!match?.[1] || !match[2] || !assetPattern.test(match[2]))
      throw new Error(`SHA256SUMS line ${index + 1} is malformed`);
    if (sums.has(match[2])) throw new Error(`SHA256SUMS lists ${match[2]} twice`);
    sums.set(match[2], match[1]);
  }
  if (!sums.size) throw new Error("SHA256SUMS is empty");
  return sums;
}

export function sha256(bytes: Uint8Array) {
  return createHash("sha256").update(bytes).digest("hex");
}

/** Requires downloaded bytes to match the release's published checksum. */
export function verifyAgainstSums(sums: Map<string, string>, asset: string, bytes: Uint8Array) {
  const expected = sums.get(asset);
  if (!expected) throw new Error(`SHA256SUMS does not list ${asset}`);
  const actual = sha256(bytes);
  if (actual !== expected)
    throw new Error(`${asset} SHA-256 ${actual} differs from SHA256SUMS ${expected}`);
  return { asset, sha256: actual, bytes: bytes.byteLength };
}

export interface FeedOffer {
  version: string;
  pub_date: string | null;
  url: string;
  tag: string;
  asset: string;
  signature_sha256: string;
}

/** Validates the Tauri static feed and returns the Windows offer. */
export function readFeedOffer(raw: unknown, platform = windowsPlatform): FeedOffer {
  if (!isRecord(raw)) throw new Error("feed is not a JSON object");
  const version = raw.version;
  if (typeof version !== "string" || !isSemver(version))
    throw new Error("feed version is not a semantic version");
  const pubDate = raw.pub_date;
  if (pubDate !== undefined && (typeof pubDate !== "string" || Number.isNaN(Date.parse(pubDate))))
    throw new Error("feed pub_date is not a date");
  if (!isRecord(raw.platforms)) throw new Error("feed has no platforms");
  const entry = raw.platforms[platform];
  if (!isRecord(entry)) throw new Error(`feed does not offer ${platform}`);
  const { url, signature } = entry;
  if (typeof url !== "string") throw new Error(`feed ${platform} URL is missing`);
  if (typeof signature !== "string" || !signature.trim() || signature.length > 8192)
    throw new Error(`feed ${platform} signature is missing`);
  const { tag, asset } = parseReleaseAssetUrl(url);
  if (platform === windowsPlatform && asset !== windowsAssetNames(version).installer)
    throw new Error(`feed ${platform} asset ${asset} does not name version ${version}`);
  return {
    version,
    pub_date: pubDate ?? null,
    url,
    tag,
    asset,
    signature_sha256: sha256(Buffer.from(signature)),
  };
}

export type FeedDecision =
  | { outcome: "offered"; from_version: string; to_version: string }
  | { outcome: "not-newer"; from_version: string; to_version: string; reason: string };

/** The acceptance needs a strictly newer offer than the installed version. */
export function decideFeedOffer(fromVersion: string, offer: Pick<FeedOffer, "version">) {
  const order = compareVersions(offer.version, fromVersion);
  if (order > 0)
    return {
      outcome: "offered",
      from_version: fromVersion,
      to_version: offer.version,
    } satisfies FeedDecision;
  return {
    outcome: "not-newer",
    from_version: fromVersion,
    to_version: offer.version,
    reason:
      order === 0
        ? `the feed still offers ${offer.version}, the installed version`
        : `the feed offers ${offer.version}, older than the installed ${fromVersion}`,
  } satisfies FeedDecision;
}

/** Defaults the from-version's release tag to the `v<version>` form. */
export function fromReleaseTag(version: string, tag?: string) {
  if (!isSemver(version)) throw new Error(`from version is not a semantic version: ${version}`);
  const resolved = tag?.trim() ? tag.trim() : `v${version}`;
  if (!tagPattern.test(resolved)) throw new Error(`unsupported from release tag: ${resolved}`);
  return resolved;
}

/** Exact bytes the client accepts (`ApplicationUpdatePreferences`, no extra keys).
 * Automatic checks stay off so no background check races the observed one. */
export function updatePreferenceBytes(channel: Channel) {
  if (!channels.includes(channel)) throw new Error(`unknown channel: ${channel}`);
  return Buffer.from(`${JSON.stringify({ channel, automatic_checks: false }, null, 2)}\n`);
}

/** Deterministic files standing for one player's save and settings. They live
 * under the library's persistent `user/` tree in a folder no port owns. */
export const playerDataFolder = "user/hosted-update-acceptance";
export function playerDataSeed() {
  const save = Buffer.alloc(4096);
  for (let index = 0; index < save.length; index++) save[index] = (index * 31 + 7) % 251;
  return [
    { relative: `${playerDataFolder}/saves/slot-1.sav`, bytes: save },
    {
      relative: `${playerDataFolder}/settings.ini`,
      bytes: Buffer.from("[video]\nfullscreen=false\nscale=2\n[audio]\nvolume=70\n"),
    },
  ];
}

/** Snapshot of whether each location exists. */
export type LocationSnapshot = Record<string, boolean>;

/**
 * A comparison key for a Windows path: surrounding quotes and the extended-length
 * `\\?\` (or `\\?\UNC\`) prefix that Rust's canonicalized paths carry are removed,
 * then the path is resolved, its trailing separators dropped and its case folded.
 */
export function windowsPathKey(value: string) {
  let plain = value.trim().replace(/^"|"$/gu, "");
  if (/^\\\\\?\\UNC\\/iu.test(plain)) plain = `\\\\${plain.slice(8)}`;
  else if (plain.startsWith("\\\\?\\")) plain = plain.slice(4);
  return path.win32
    .resolve(plain)
    .replace(/(?<=[^:\\])\\+$/u, "")
    .toLowerCase();
}

/** Broad default Portcove folders, observed only (Windows paths). */
export function defaultFolders(localAppData: string, roamingAppData: string) {
  return [
    path.win32.join(localAppData, "Portcove"),
    path.win32.join(roamingAppData, "Portcove"),
    // Tauri creates `app_local_data_dir()` for its webview data directory even
    // when `WEBVIEW2_USER_DATA_FOLDER` redirects WebView2, so an isolated app
    // creates this folder too. Its existence proves nothing about overrides.
    path.win32.join(localAppData, "io.github.portcove.portcove"),
    path.win32.join(roamingAppData, "io.github.portcove.portcove"),
  ];
}

/** Locations only a Portcove process without its overrides would create:
 * `ProjectDirs("io.github", "Portcove", "Portcove")` default preferences and the
 * runtime lock beside them (`host_preferences.rs`, `application_runtime.rs`),
 * the default library (`library.rs`), and WebView2 data in Tauri's default
 * data directory instead of `WEBVIEW2_USER_DATA_FOLDER`. */
export function isolationMarkers(localAppData: string) {
  const project = path.win32.join(localAppData, "Portcove", "Portcove");
  return [
    path.win32.join(project, "config", "preferences.json"),
    path.win32.join(project, "config", ".application-runtime.lock"),
    path.win32.join(project, "data", "library"),
    path.win32.join(localAppData, "io.github.portcove.portcove", "EBWebView"),
  ];
}

/** Locations present in `after` that were absent from `baseline`. */
export function appearedSince(baseline: LocationSnapshot, after: LocationSnapshot) {
  return Object.keys(after)
    .filter((location) => after[location] && !baseline[location])
    .sort();
}

export interface ManifestEntry {
  path: string;
  sha256: string;
  bytes: number;
}

/** Paths whose bytes or presence differ between two manifests. */
export function manifestDifferences(before: ManifestEntry[], after: ManifestEntry[]) {
  const index = (entries: ManifestEntry[]) => {
    const map = new Map<string, ManifestEntry>();
    for (const entry of entries) {
      if (map.has(entry.path)) throw new Error(`manifest lists ${entry.path} twice`);
      map.set(entry.path, entry);
    }
    return map;
  };
  const a = index(before);
  const b = index(after);
  const differences: { path: string; change: "removed" | "added" | "changed" }[] = [];
  for (const [file, entry] of a) {
    const other = b.get(file);
    if (!other) differences.push({ path: file, change: "removed" });
    else if (other.sha256 !== entry.sha256 || other.bytes !== entry.bytes)
      differences.push({ path: file, change: "changed" });
  }
  for (const file of b.keys()) if (!a.has(file)) differences.push({ path: file, change: "added" });
  return differences.sort((x, y) => x.path.localeCompare(y.path));
}

/** Picks the first catalog port for the CLI's held confirmation prompt. */
export function holdPortFromCatalogList(raw: unknown) {
  if (!isRecord(raw) || raw.ok !== true || !Array.isArray(raw.data))
    throw new Error("catalog list did not succeed");
  for (const port of raw.data)
    if (isRecord(port) && typeof port.id === "string" && /^[a-z0-9][a-z0-9-]{0,63}$/u.test(port.id))
      return port.id;
  throw new Error("catalog list has no port");
}

export function cliData(raw: unknown, command: string) {
  if (!isRecord(raw) || raw.ok !== true || raw.command !== command || !isRecord(raw.data))
    throw new Error(`CLI ${command} did not succeed`);
  return raw.data;
}

/** Reads the localized strings the acceptance clicks and expects, from one
 * version's own `applicationUpdate` locale so copy changes never mislead. */
export function updateCopy(raw: unknown) {
  if (!isRecord(raw)) throw new Error("locale is not an object");
  const text = (group: string, key: string) => {
    const section = raw[group];
    const value = isRecord(section) ? section[key] : undefined;
    if (typeof value !== "string" || !value.trim() || value.length > 1024)
      throw new Error(`locale lacks ${group}.${key}`);
    return value;
  };
  return {
    check: text("status", "check"),
    install: text("available", "install"),
    availableTitle: text("available", "title"),
    libraryInUse: text("failure", "libraryInUse"),
    preview: text("channel", "preview"),
  };
}

export function localeUrl(tag: string) {
  if (!tagPattern.test(tag)) throw new Error(`unsupported tag: ${tag}`);
  return `https://raw.githubusercontent.com/${repository}/${tag}/apps/desktop/src/locales/en/applicationUpdate.json`;
}

export async function fetchBounded(url: string, maxBytes: number, timeoutMs = 60_000) {
  const response = await fetch(url, {
    redirect: "follow",
    signal: AbortSignal.timeout(timeoutMs),
    headers: { "user-agent": "portcove-hosted-acceptance", "cache-control": "no-cache" },
  });
  if (!response.ok) throw new Error(`GET ${url} returned HTTP ${response.status}`);
  const bytes = Buffer.from(await response.arrayBuffer());
  if (bytes.byteLength > maxBytes) throw new Error(`GET ${url} exceeded ${maxBytes} bytes`);
  return bytes;
}

/** Fetches the channel feed once, retaining its exact bytes and time. */
export async function observeFeed(channel: Channel, fetchBytes = fetchBounded) {
  const fetched_at = new Date().toISOString();
  const bytes = await fetchBytes(feedUrls[channel], maxFeedBytes);
  return {
    channel,
    url: feedUrls[channel],
    fetched_at,
    sha256: sha256(bytes),
    bytes,
    offer: readFeedOffer(JSON.parse(bytes.toString("utf8"))),
  };
}

/** Polls until the feed offers a strictly newer version or the wait ends. */
export async function awaitNewerFeed({
  channel,
  fromVersion,
  waitMinutes,
  observe = observeFeed,
  sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms)),
  now = Date.now,
  pollMs = 60_000,
}: {
  channel: Channel;
  fromVersion: string;
  waitMinutes: number;
  observe?: typeof observeFeed;
  sleep?: (ms: number) => Promise<unknown>;
  now?: () => number;
  pollMs?: number;
}) {
  if (!Number.isInteger(waitMinutes) || waitMinutes < 0 || waitMinutes > 180)
    throw new Error("wait minutes must be an integer from 0 to 180");
  const deadline = now() + waitMinutes * 60_000;
  const attempts: { fetched_at: string; version?: string; sha256?: string; error?: string }[] = [];
  for (;;) {
    try {
      const feed = await observe(channel);
      attempts.push({
        fetched_at: feed.fetched_at,
        version: feed.offer.version,
        sha256: feed.sha256,
      });
      const decision = decideFeedOffer(fromVersion, feed.offer);
      if (decision.outcome === "offered" || now() + pollMs > deadline)
        return { decision, feed, attempts };
    } catch (error) {
      attempts.push({ fetched_at: new Date(now()).toISOString(), error: errorMessage(error) });
      if (now() + pollMs > deadline) throw new Error(`feed unavailable: ${errorMessage(error)}`);
    }
    await sleep(pollMs);
  }
}

function option(args: string[], name: string) {
  const index = args.indexOf(`--${name}`);
  const value = index >= 0 ? args[index + 1] : undefined;
  if (value === undefined || value.startsWith("--")) throw new Error(`--${name} is required`);
  return value;
}

/** `feed-gate`: decides whether the acceptance can run and records why. */
async function feedGate(args: string[]) {
  const channel = option(args, "channel");
  if (!channels.includes(channel as Channel)) throw new Error(`unknown channel: ${channel}`);
  const fromVersion = option(args, "from-version");
  const fromTag = fromReleaseTag(fromVersion, option(args, "from-tag"));
  const waitMinutes = Number(option(args, "wait-minutes"));
  const output = path.resolve(option(args, "output"));
  mkdirSync(output, { recursive: true });
  let record: Record<string, unknown>;
  try {
    const { decision, feed, attempts } = await awaitNewerFeed({
      channel: channel as Channel,
      fromVersion,
      waitMinutes,
    });
    writeFileSync(path.join(output, "feed.json"), feed.bytes);
    record = {
      schema_version: 1,
      ...decision,
      from_tag: fromTag,
      channel,
      feed: { url: feed.url, fetched_at: feed.fetched_at, sha256: feed.sha256, offer: feed.offer },
      attempts,
    };
  } catch (error) {
    record = { schema_version: 1, outcome: "feed-unavailable", error: errorMessage(error) };
  }
  writeFileSync(path.join(output, "feed-decision.json"), `${JSON.stringify(record, null, 2)}\n`);
  const outcome = String(record.outcome);
  const toVersion = typeof record.to_version === "string" ? record.to_version : "";
  if (process.env.GITHUB_OUTPUT)
    appendFileSync(process.env.GITHUB_OUTPUT, `outcome=${outcome}\nto_version=${toVersion}\n`);
  if (process.env.GITHUB_STEP_SUMMARY)
    appendFileSync(
      process.env.GITHUB_STEP_SUMMARY,
      `### Feed gate\n\n- Outcome: **${outcome}**\n- From: ${fromVersion} (${fromTag})\n- Feed: ${toVersion || "unavailable"}\n${typeof record.reason === "string" ? `- ${record.reason}\n` : ""}${typeof record.error === "string" ? `- ${record.error}\n` : ""}`,
    );
  console.log(JSON.stringify(record, null, 2));
  return outcome === "feed-unavailable" ? 1 : 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [command, ...rest] = process.argv.slice(2);
  if (command !== "feed-gate") {
    console.error(
      "usage: hosted-installed-update.mts feed-gate --channel preview|beta --from-version V --from-tag TAG --wait-minutes N --output DIR",
    );
    process.exit(2);
  }
  feedGate(rest).then(
    (code) => process.exit(code),
    (error: unknown) => {
      console.error(errorMessage(error));
      process.exit(1);
    },
  );
}
