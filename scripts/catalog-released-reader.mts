import { createGitHubClient } from "./github-client.mts";
import { downloadPinnedPortcoveReleaseAsset } from "./portcove-release-download.mts";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { unpackFixedLinuxCli } from "./release-compiler-outputs.mts";
import { isRecord } from "./runtime-values.mts";

const repository = "boburning/portcove";
const releaseBase = `https://github.com/${repository}/releases/download`;
const digest = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
const metadataMaximum = 1024 * 1024;
const packageMaximum = 64 * metadataMaximum;

export function selectedPreview(feed: unknown, withdrawals: unknown) {
  if (!isRecord(feed) || typeof feed.version !== "string" || !isRecord(feed.platforms))
    throw new Error("Invalid official Preview feed");
  const version = feed.version;
  if (
    !/^(?:0|[1-9]\d{0,9})\.(?:0|[1-9]\d{0,9})\.(?:0|[1-9]\d{0,9})(?:-preview\.(?:0|[1-9]\d{0,9}))?$/u.test(
      version,
    )
  )
    throw new Error("Unexpected Preview release version");
  if (!Array.isArray(withdrawals) || withdrawals.some((entry) => typeof entry !== "string"))
    throw new Error("Invalid official withdrawal inventory");
  if (withdrawals.includes(version)) throw new Error("Official Preview is withdrawn");
  const linux = feed.platforms["linux-x86_64"];
  if (!isRecord(linux) || typeof linux.url !== "string")
    throw new Error("Official Preview has no Linux release link");
  const tags = version.includes("-preview.")
    ? [`v${version}`, `nightly-${version}`]
    : [`v${version}`];
  const tag = tags.find(
    (name) => linux.url === `${releaseBase}/${name}/Portcove_${version}_amd64.AppImage`,
  );
  if (!tag) throw new Error("Unexpected official Preview Linux release link");
  return { version, tag };
}

function git(...args: string[]) {
  return execFileSync("git", args, {
    encoding: "utf8",
    timeout: 10000,
    maxBuffer: metadataMaximum,
  });
}

function gh(args: string[], maxBuffer = metadataMaximum) {
  return execFileSync("gh", args, { timeout: 30000, maxBuffer, stdio: ["ignore", "pipe", "pipe"] });
}

function asset(release: Record<string, unknown>, name: string, max: number) {
  const assets = release.assets;
  if (!Array.isArray(assets)) throw new Error("Immutable release asset inventory missing");
  const matching = assets.filter((item: unknown) => isRecord(item) && item.name === name);
  const item: unknown = matching[0];
  if (
    matching.length !== 1 ||
    !isRecord(item) ||
    typeof item.id !== "number" ||
    !Number.isSafeInteger(item.id) ||
    item.id < 1 ||
    item.state !== "uploaded" ||
    typeof item.size !== "number" ||
    !Number.isSafeInteger(item.size) ||
    item.size < 1 ||
    item.size > max ||
    typeof item.digest !== "string" ||
    !/^sha256:[a-f0-9]{64}$/u.test(item.digest)
  )
    throw new Error("Immutable release asset identity missing or outside fixed bounds");
  return { id: item.id, size: item.size, sha256: item.digest.slice(7) };
}

export function requireCatalogReleaseAttestation(
  verified: unknown,
  expected: { tag: string; tagObject: string; releaseId: number; subjects: Record<string, string> },
) {
  const result = isRecord(verified) ? verified.verificationResult : undefined;
  const statement = isRecord(result) ? result.statement : undefined;
  const predicate = isRecord(statement) ? statement.predicate : undefined;
  const purl = `pkg:github/${repository}@${expected.tag}`;
  if (
    !isRecord(statement) ||
    statement.predicateType !== "https://in-toto.io/attestation/release/v0.2" ||
    !isRecord(predicate) ||
    predicate.repository !== repository ||
    predicate.tag !== expected.tag ||
    predicate.purl !== purl ||
    predicate.databaseId !== String(expected.releaseId) ||
    !Array.isArray(statement.subject)
  )
    throw new Error("Verified release attestation identity differs");
  const subjects: unknown[] = statement.subject;
  function confirm(key: "uri" | "name", value: string, algorithm: string, sha: string) {
    const candidates = subjects.filter((entry) => isRecord(entry) && entry[key] === value);
    const member = candidates[0];
    if (
      candidates.length !== 1 ||
      !isRecord(member) ||
      !isRecord(member.digest) ||
      member.digest[algorithm] !== sha
    )
      throw new Error("Verified release attestation subject differs");
  }
  confirm("uri", purl, "sha1", expected.tagObject);
  for (const [name, sha] of Object.entries(expected.subjects)) confirm("name", name, "sha256", sha);
}

function previewAt(siteRevision: string, worktree = ".") {
  const feed: unknown = JSON.parse(
    git("-C", worktree, "show", `${siteRevision}:updates/preview/latest.json`),
  );
  const withdrawalEntries = git(
    "-C",
    worktree,
    "ls-tree",
    siteRevision,
    "--",
    "updates/withdrawn.json",
  );
  const withdrawn: unknown = withdrawalEntries
    ? JSON.parse(git("-C", worktree, "show", `${siteRevision}:updates/withdrawn.json`))
    : [];
  return selectedPreview(feed, withdrawn);
}

export function requireCurrentCatalogReaderSelection(expected: unknown, site: string) {
  const fresh = previewAt(git("-C", site, "rev-parse", "HEAD").trim(), site);
  if (!isRecord(expected) || expected.version !== fresh.version || expected.tag !== fresh.tag)
    throw new Error("Official reader release selection changed before publication");
}

/** Check the served pointers as well as the Git tree used by the publisher.
 * Reading the feed must not disclose the publisher job's GitHub credentials. */
export async function requireServedCatalogReaderSelection(expected: unknown) {
  const base = "https://boburning.github.io/portcove/updates/";
  async function read(relative: string, optional = false) {
    const response = await fetch(base + relative, {
      cache: "no-store",
      credentials: "omit",
      redirect: "error",
      signal: AbortSignal.timeout(15000),
    });
    if (optional && (response.status === 404 || response.status === 410)) return [];
    if (!response.ok || !response.body)
      throw new Error("Official released reader pointer is unavailable");
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let bytes = 0;
    try {
      while (true) {
        const next = await reader.read();
        if (next.done) break;
        const chunk: unknown = next.value;
        if (!(chunk instanceof Uint8Array))
          throw new Error("Official released reader pointer is not a byte stream");
        bytes += chunk.byteLength;
        if (bytes > metadataMaximum)
          throw new Error("Official released reader pointer exceeds its bound");
        chunks.push(chunk);
      }
    } finally {
      await reader.cancel();
    }
    return JSON.parse(
      new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks)),
    ) as unknown;
  }
  const [feed, withdrawn] = await Promise.all([
    read("preview/latest.json"),
    read("withdrawn.json", true),
  ]);
  const served = selectedPreview(feed, withdrawn);
  if (!isRecord(expected) || served.version !== expected.version || served.tag !== expected.tag)
    throw new Error("The deployed Preview feed and the approved released reader differ");
}

/** Only the checked-out protected Pages pointer may select an official immutable release. */
export async function acquireCatalogReleasedReader(privateRoot: string) {
  if (process.platform !== "linux" || process.arch !== "x64")
    throw new Error("Released catalog reader acquisition requires Linux x86-64");
  const siteRevision = git("rev-parse", "refs/remotes/origin/gh-pages").trim();
  const { version, tag } = previewAt(siteRevision);
  const endpoint = `/repos/${repository}/releases/tags/${tag}`;
  const token = process.env.GH_TOKEN ?? process.env.GITHUB_TOKEN;
  const api = await createGitHubClient({
    credential: token ? { kind: "explicit", token } : { kind: "anonymous" },
    deadline: performance.now() + 30000,
    maxBytes: metadataMaximum,
    allowRequest: (method, url) => method === "GET" && url.pathname === endpoint && !url.search,
  });
  const release: unknown = (
    await api.request(`GET ${endpoint}`, {
      request: { portcove: { replay: "safe-read", attempts: 0 } },
    })
  ).data;
  if (
    !isRecord(release) ||
    typeof release.id !== "number" ||
    !Number.isSafeInteger(release.id) ||
    release.id < 1 ||
    release.draft !== false ||
    release.immutable !== true ||
    release.tag_name !== tag ||
    typeof release.target_commitish !== "string" ||
    !/^[a-f0-9]{40}$/u.test(release.target_commitish)
  )
    throw new Error("Official Preview does not identify an immutable source commit");
  const taggedRefs = git(
    "ls-remote",
    "--tags",
    "origin",
    `refs/tags/${tag}`,
    `refs/tags/${tag}^{}`,
  );
  const refs = new Map(
    taggedRefs
      .trim()
      .split("\n")
      .map((line) => line.split("\t") as [string, string])
      .map(([sha, ref]) => [ref, sha]),
  );
  const tagObject = refs.get(`refs/tags/${tag}`);
  const source = refs.get(`refs/tags/${tag}^{}`) ?? tagObject;
  if (!tagObject || !/^[a-f0-9]{40}$/u.test(tagObject) || source !== release.target_commitish)
    throw new Error("Official Preview source differs from the immutable tag");
  git("merge-base", "--is-ancestor", source, "refs/remotes/origin/main");
  const filename = `portcove-cli-${version}-linux-x86_64.tar.gz`;
  const archiveIdentity = asset(release, filename, packageMaximum);
  const checksumIdentity = asset(release, "SHA256SUMS", 64 * 1024);
  const checksums = (
    await downloadPinnedPortcoveReleaseAsset(tag, {
      name: "SHA256SUMS",
      bytes: checksumIdentity.size,
      sha256: checksumIdentity.sha256,
    })
  ).toString("utf8");
  const lines = checksums.split("\n").filter((line) => line.endsWith(`  ${filename}`));
  if (lines.length !== 1 || lines[0] !== `${archiveIdentity.sha256}  ${filename}`)
    throw new Error("Published checksum manifest differs from exact Linux CLI identity");
  const archive = await downloadPinnedPortcoveReleaseAsset(tag, {
    name: filename,
    bytes: archiveIdentity.size,
    sha256: archiveIdentity.sha256,
  });
  const directory = mkdtempSync(path.join(privateRoot, "official-catalog-reader-"));
  const archivePath = path.join(directory, filename);
  writeFileSync(archivePath, archive, { flag: "wx", mode: 0o600 });
  requireCatalogReleaseAttestation(
    JSON.parse(
      gh([
        "release",
        "verify-asset",
        tag,
        archivePath,
        "--repo",
        repository,
        "--format",
        "json",
      ]).toString("utf8"),
    ),
    {
      tag,
      tagObject,
      releaseId: release.id,
      subjects: { [filename]: archiveIdentity.sha256, SHA256SUMS: checksumIdentity.sha256 },
    },
  );
  const binary = unpackFixedLinuxCli(archive, 128 * metadataMaximum);
  const cli = path.join(directory, "portcove");
  writeFileSync(cli, binary, { flag: "wx", mode: 0o600 });
  return {
    cli,
    sha256: digest(binary),
    version,
    receipt: {
      feed_commit: siteRevision,
      version,
      source,
      tag,
      tag_object: tagObject,
      release_id: release.id,
      asset_id: archiveIdentity.id,
      archive_bytes: archiveIdentity.size,
      archive_sha256: archiveIdentity.sha256,
      checksum_sha256: checksumIdentity.sha256,
    },
  };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const site = process.argv[2];
  if (!site) throw new Error("Fresh Pages worktree path is required");
  const expected: unknown = JSON.parse(process.env.CATALOG_READER_ACTIVATION ?? "");
  requireCurrentCatalogReaderSelection(expected, site);
}
