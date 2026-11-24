/** Select and verify the released Portcove CLI that compact listing delivery
 * must stay readable by, without credentials. The protected Pages Preview
 * pointer (which also follows newer Beta and Stable releases) names the
 * release; the reader is accepted only when it is not withdrawn, GitHub's
 * signed release attestation (issued only for immutable releases) binds the
 * exact tag object, release, archive and SHA256SUMS, the archive bytes equal
 * that identity, and the tagged source is an ancestor of protected main. Preparation then
 * probes the unpacked reader's capabilities. Network reads are anonymous; no
 * token is read or sent. Every source is injectable so tests and the
 * rehearsal run without a network. */
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { verifyGitHubReleaseAttestation } from "./github-release-attestation.mts";
import {
  downloadPortcoveReleaseAsset,
  fetchPublicPortcoveApi,
} from "./portcove-release-download.mts";
import { unpackFixedLinuxCli } from "./release-compiler-outputs.mts";
import { isRecord } from "./runtime-values.mts";

const repository = "boburning/portcove";
/** Pinned like the application release attestation contract. */
const repositoryId = "1354613114";
const ownerId = "43177418";
const releaseBase = `https://github.com/${repository}/releases/download`;
const digest = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
const metadataMaximum = 1024 * 1024;
const packageMaximum = 64 * metadataMaximum;
const binaryMaximum = 128 * metadataMaximum;
const checksumMaximum = 64 * 1024;
const hex40 = /^[a-f0-9]{40}$/u;

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

/** Bind a verified GitHub release statement to the exact release, tag object
 * and assets. Each expected subject must appear exactly once. */
export function requireCatalogReleaseAttestation(
  statement: unknown,
  expected: { tag: string; tagObject: string; subjects: Record<string, string> },
) {
  const predicate = isRecord(statement) ? statement.predicate : undefined;
  const purl = `pkg:github/${repository}@${expected.tag}`;
  if (
    !isRecord(statement) ||
    statement.predicateType !== "https://in-toto.io/attestation/release/v0.2" ||
    !isRecord(predicate) ||
    predicate.repository !== repository ||
    predicate.repositoryId !== repositoryId ||
    predicate.ownerId !== ownerId ||
    predicate.tag !== expected.tag ||
    predicate.purl !== purl ||
    typeof predicate.databaseId !== "string" ||
    !/^[1-9]\d{0,15}$/u.test(predicate.databaseId) ||
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
  return Number(predicate.databaseId);
}

/** Everything the selection reads. The live sources are anonymous. */
export interface ReleasedReaderSources {
  /** The protected Pages commit the Preview pointer is read from. */
  pagesRevision: string;
  /** A file of that Pages commit, or null when it is absent. */
  pagesFile(file: string): Buffer | null;
  /** The annotated tag object and the commit it peels to. */
  tagRefs(tag: string): { object: string | null; peeled: string | null };
  isProtectedMainAncestor(commit: string): boolean;
  /** One public release asset, at most `maximumBytes` bytes. */
  download(tag: string, name: string, maximumBytes: number): Promise<Buffer>;
  /** GitHub's attestation listing for one artifact digest. */
  attestations(sha256: string): Promise<unknown>;
  /** Verify one Sigstore bundle and return its in-toto statement. */
  verifyAttestation(bundle: unknown): unknown;
}

function git(cwd: string, args: string[]) {
  // No credential helper and no prompt: every read is anonymous.
  return execFileSync("git", ["-c", "credential.helper=", "-C", cwd, ...args], {
    encoding: "utf8",
    timeout: 30000,
    maxBuffer: metadataMaximum,
    env: { ...credentialFree(process.env), GIT_TERMINAL_PROMPT: "0" },
    stdio: ["ignore", "pipe", "pipe"],
  });
}

/** The environment without any token a child could send. */
export function credentialFree(environment: NodeJS.ProcessEnv) {
  const result = { ...environment };
  for (const name of Object.keys(result))
    if (/TOKEN|PASSWORD|SECRET|CREDENTIAL|^GH_|^GITHUB_|^ACTIONS_/u.test(name)) delete result[name];
  return result;
}

/** GitHub's Sigstore trusted root, read through the GitHub CLI's own TUF
 * client without authentication. Only GitHub's internal authority is used. */
export function githubTrustedRoot(privateRoot: string) {
  const result = spawnSync("gh", ["attestation", "trusted-root"], {
    encoding: "utf8",
    timeout: 60000,
    maxBuffer: 4 * metadataMaximum,
    env: {
      ...credentialFree(process.env),
      GH_CONFIG_DIR: mkdtempSync(path.join(privateRoot, "gh-")),
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (result.error || result.status !== 0 || typeof result.stdout !== "string")
    throw new Error("GitHub trusted root unavailable without credentials");
  const roots = result.stdout
    .split("\n")
    .filter((line) => line.trim())
    .map((line): unknown => JSON.parse(line));
  const github = roots.filter(
    (root) =>
      isRecord(root) &&
      Array.isArray(root.certificateAuthorities) &&
      root.certificateAuthorities.length > 0 &&
      root.certificateAuthorities.every(
        (authority) => isRecord(authority) && authority.uri === "fulcio.githubapp.com",
      ),
  );
  if (github.length !== 1) throw new Error("GitHub trusted root differs");
  return github[0];
}

/** The commit a Pages worktree has checked out. Selection reads the Pages
 * files from this exact commit, the one the prior catalog was read from,
 * never from a remote-tracking ref another step may move. */
export function pagesWorktreeRevision(checkout: string, pages: string) {
  const top = (cwd: string) => git(cwd, ["rev-parse", "--show-toplevel"]).trim();
  if (top(pages) === top(checkout))
    throw new Error("Released-reader selection requires a Pages worktree, not the source checkout");
  return git(pages, ["rev-parse", "--verify", "HEAD^{commit}"]).trim();
}

/** Anonymous live sources over the protected checkout, the Pages worktree's
 * checked-out commit and public GitHub. */
export function liveReleasedReaderSources(checkout: string, privateRoot: string, pages: string) {
  const pagesRevision = pagesWorktreeRevision(checkout, pages);
  let trustedRoot: unknown;
  const sources: ReleasedReaderSources = {
    pagesRevision,
    pagesFile(file) {
      if (!git(checkout, ["ls-tree", pagesRevision, "--", file]).trim()) return null;
      return Buffer.from(git(checkout, ["show", `${pagesRevision}:${file}`]));
    },
    tagRefs(tag) {
      const refs = new Map(
        git(checkout, ["ls-remote", "--tags", "origin", `refs/tags/${tag}`, `refs/tags/${tag}^{}`])
          .trim()
          .split("\n")
          .filter(Boolean)
          .map((line) => line.split("\t"))
          .map(([sha, ref]) => [ref, sha]),
      );
      return {
        object: refs.get(`refs/tags/${tag}`) ?? null,
        peeled: refs.get(`refs/tags/${tag}^{}`) ?? null,
      };
    },
    isProtectedMainAncestor(commit) {
      const result = spawnSync(
        "git",
        ["-C", checkout, "merge-base", "--is-ancestor", commit, "refs/remotes/origin/main"],
        { timeout: 30000, env: credentialFree(process.env), stdio: "ignore" },
      );
      if (result.status === 0) return true;
      if (result.status === 1) return false;
      throw new Error("Protected main ancestry could not be read");
    },
    download: (tag, name, maximumBytes) => downloadPortcoveReleaseAsset(tag, name, maximumBytes),
    attestations: (sha256) =>
      retryUnavailableApi(() =>
        fetchPublicPortcoveApi(`attestations/sha256:${sha256}`, 4 * metadataMaximum),
      ),
    verifyAttestation(bundle) {
      trustedRoot ??= githubTrustedRoot(privateRoot);
      return verifyGitHubReleaseAttestation(bundle, trustedRoot).statement;
    },
  };
  return sources;
}

/** Harness budget for the anonymous attestation read: up to four attempts,
 * waiting 5, 15 and 45 seconds (65 seconds in all) after a rate limit (403,
 * 429) or server error (5xx). A shared runner address can exceed the 60
 * requests an hour GitHub allows anonymously; a transient refusal should not
 * defer the cutover by a 12-hour cycle. Other failures are not retried, and
 * the last refusal is returned unchanged so the gate still fails closed. */
export const attestationRetryDelaysMs = [5_000, 15_000, 45_000] as const;

export async function retryUnavailableApi<T>(
  read: () => Promise<T>,
  delays: readonly number[] = attestationRetryDelaysMs,
  sleep: (ms: number) => Promise<void> = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await read();
    } catch (error) {
      const retryable =
        error instanceof Error && /unavailable \((?:403|429|5\d\d)\)$/u.test(error.message);
      if (!retryable || attempt >= delays.length) throw error;
      await sleep(delays[attempt]!);
    }
  }
}

export interface AcquiredReleasedReader {
  cli: string;
  sha256: string;
  version: string;
  receipt: Record<string, unknown>;
}

function previewAt(sources: Pick<ReleasedReaderSources, "pagesFile">) {
  const feed = sources.pagesFile("updates/preview/latest.json");
  if (!feed) throw new Error("Official Preview feed unavailable");
  const withdrawn = sources.pagesFile("updates/withdrawn.json");
  return selectedPreview(
    JSON.parse(feed.toString("utf8")),
    withdrawn ? JSON.parse(withdrawn.toString("utf8")) : [],
  );
}

/** Select, download and verify the official released reader. The unpacked
 * executable is written privately under `privateRoot`; it is not run here.
 * Only the attestation listing uses the GitHub API (one anonymous read); the
 * manifest and archive come from the public release download route. GitHub
 * issues a release attestation only for an immutable release, so the verified
 * attestation is the immutability, release identity and asset identity proof. */
export async function acquireCatalogReleasedReader(
  privateRoot: string,
  sources: ReleasedReaderSources,
): Promise<AcquiredReleasedReader> {
  const { version, tag } = previewAt(sources);
  const { object: tagObject, peeled } = sources.tagRefs(tag);
  const source = peeled ?? tagObject;
  if (!tagObject || !hex40.test(tagObject) || !source || !hex40.test(source))
    throw new Error("Official Preview tag is not an immutable tag object");
  if (!sources.isProtectedMainAncestor(source))
    throw new Error("Official Preview source is not on protected main");
  const filename = `portcove-cli-${version}-linux-x86_64.tar.gz`;
  const checksums = await sources.download(tag, "SHA256SUMS", checksumMaximum);
  const lines = checksums
    .toString("utf8")
    .split("\n")
    .filter((line) => line.endsWith(`  ${filename}`));
  const archiveSha256 = lines.length === 1 ? lines[0]!.slice(0, 64) : "";
  if (!/^[a-f0-9]{64}$/u.test(archiveSha256) || lines[0] !== `${archiveSha256}  ${filename}`)
    throw new Error("Published checksum manifest lacks the exact Linux CLI identity");
  const listing = await sources.attestations(archiveSha256);
  const bundles =
    isRecord(listing) && Array.isArray(listing.attestations)
      ? listing.attestations.map((entry: unknown) => (isRecord(entry) ? entry.bundle : undefined))
      : [];
  if (!bundles.length || bundles.length > 8)
    throw new Error("Release attestation unavailable or outside its bound");
  const expected = {
    tag,
    tagObject,
    subjects: { [filename]: archiveSha256, SHA256SUMS: digest(checksums) },
  };
  const failures: string[] = [];
  let releaseId: number | undefined;
  for (const bundle of bundles) {
    try {
      releaseId = requireCatalogReleaseAttestation(sources.verifyAttestation(bundle), expected);
      break;
    } catch (error) {
      failures.push(error instanceof Error ? error.message : "refused");
    }
  }
  if (releaseId === undefined)
    throw new Error(`No verified release attestation binds the reader: ${failures.join("; ")}`);
  const archive = await sources.download(tag, filename, packageMaximum);
  if (digest(archive) !== archiveSha256)
    throw new Error("Release archive differs from its attested identity");
  const binary = unpackFixedLinuxCli(archive, binaryMaximum);
  const directory = mkdtempSync(path.join(privateRoot, "official-catalog-reader-"));
  const cli = path.join(directory, "portcove");
  writeFileSync(cli, binary, { flag: "wx", mode: 0o600 });
  return {
    cli,
    sha256: digest(binary),
    version,
    receipt: {
      feed_commit: sources.pagesRevision,
      version,
      source,
      tag,
      tag_object: tagObject,
      release_id: releaseId,
      archive_bytes: archive.length,
      archive_sha256: archiveSha256,
      checksum_sha256: digest(checksums),
    },
  };
}

/** Publish-time recheck: the fresh Pages base still selects the prepared
 * release and has not withdrawn it. */
export function requireCurrentCatalogReaderSelection(expected: unknown, site: string) {
  const revision = git(site, ["rev-parse", "HEAD"]).trim();
  const fresh = previewAt({
    pagesFile(file) {
      if (!git(site, ["ls-tree", revision, "--", file]).trim()) return null;
      return Buffer.from(git(site, ["show", `${revision}:${file}`]));
    },
  });
  if (!isRecord(expected) || expected.version !== fresh.version || expected.tag !== fresh.tag)
    throw new Error("Official reader release selection changed before publication");
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv[2] === "select") {
    // Read-only preflight: what automatic selection would verify and probe now.
    const work = process.argv[3];
    const pages = process.argv[4] ?? "site";
    if (!work) throw new Error("select requires a new private work directory");
    mkdirSync(work, { recursive: false, mode: 0o700 });
    const reader = await acquireCatalogReleasedReader(
      work,
      liveReleasedReaderSources(".", work, pages),
    );
    chmodSync(reader.cli, 0o700);
    const capabilities: unknown = JSON.parse(
      execFileSync(reader.cli, ["--json", "capabilities"], {
        cwd: work,
        env: { PATH: process.env.PATH, HOME: work, TMPDIR: work },
        encoding: "utf8",
        timeout: 30000,
        maxBuffer: metadataMaximum,
      }),
    );
    const data = isRecord(capabilities) && isRecord(capabilities.data) ? capabilities.data : {};
    console.log(
      JSON.stringify(
        {
          receipt: reader.receipt,
          reader_sha256: reader.sha256,
          product_version: data.product_version,
          listing_formats: data.listing_formats,
          listing_delivery_carriers: data.listing_delivery_carriers,
        },
        null,
        2,
      ),
    );
  } else {
    const site = process.argv[2];
    if (!site) throw new Error("Fresh Pages worktree path is required");
    const expected: unknown = JSON.parse(process.env.CATALOG_READER_ACTIVATION ?? "");
    requireCurrentCatalogReaderSelection(expected, site);
  }
}
