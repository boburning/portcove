/**
 * Release-content scan (#5353). For each unheld listing that offers an
 * upstream download, find the release asset its hints select in the listing's
 * channel, download each not-yet-scanned asset once, list its entries with
 * bounded external listers and check them with release-content-signals.
 * Nothing is executed or installed; a finding is evidence for a reviewed hold.
 *
 * Usage: node scripts/release-content-scan.mts scan --listings <listings.json>
 *          --checkpoint <in.json|-> --output <report.json> [--max-assets N]
 *          [--max-asset-bytes N] [--max-total-bytes N]
 */
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import {
  HEAD_BYTES,
  type ContentSignal,
  type PackageEntry,
  headCandidates,
  packageSignals,
} from "./release-content-signals.mts";

export interface ScanTarget {
  id: string;
  provider: "github" | "gitlab";
  repository: string;
  platform: string;
  hints: string[];
  channel: "stable" | "beta";
}

export interface ReleaseAsset {
  name: string;
  url: string;
  size: number | null;
  digest: string | null;
}

export interface UpstreamRelease {
  tag: string;
  draft: boolean;
  prerelease: boolean;
  assets: ReleaseAsset[];
}

export interface ScanRecord {
  key: string;
  id: string;
  platform: string;
  repository: string;
  tag: string;
  asset: string;
  sha256: string;
  entries: number;
  signals: ContentSignal[];
}

export interface ScanReport {
  format_version: 1;
  scanned: ScanRecord[];
  reused: number;
  findings: ScanRecord[];
  unscanned: { id: string; platform: string; reason: string }[];
}

const SKIPPED_ASSET = /(debug|symbols|pdb|source|src)[-_.]|\.(sha256|sig|asc|txt|json)$/i;

/** Listings that offer a download and are not held, one target per hinted platform. */
export function scanTargets(listings: unknown): ScanTarget[] {
  const items = Array.isArray((listings as { listings?: unknown })?.listings)
    ? (listings as { listings: Record<string, unknown>[] }).listings
    : [];
  const targets: ScanTarget[] = [];
  for (const listing of items) {
    if (listing.download_block_reason) continue;
    const hints = listing.download_asset_hints as Record<string, string[]> | undefined;
    if (!hints) continue;
    const url =
      [listing.release_url, listing.project_url].find(
        (value): value is string => typeof value === "string",
      ) ?? "";
    const github = /^https:\/\/github\.com\/([^/]+\/[^/#?]+)/i.exec(url);
    const gitlab = /^https:\/\/gitlab\.com\/([^#?]+?)(?:\/-\/.*)?$/i.exec(url);
    if (!github && !gitlab) continue;
    for (const [platform, platformHints] of Object.entries(hints))
      targets.push({
        id: String(listing.id),
        provider: github ? "github" : "gitlab",
        repository: (github?.[1] ?? gitlab?.[1] ?? "").replace(/\.git$/, ""),
        platform,
        hints: platformHints,
        channel: listing.recommended_download_channel === "beta" ? "beta" : "stable",
      });
  }
  return targets;
}

/** The newest published release in the channel: stable skips prereleases. */
export function channelRelease(releases: readonly UpstreamRelease[], channel: "stable" | "beta") {
  return releases.find((release) => !release.draft && (channel === "beta" || !release.prerelease));
}

/** The single asset every hint names, ignoring checksums, symbols and sources. */
export function hintedAsset(assets: readonly ReleaseAsset[], hints: readonly string[]) {
  const matches = assets.filter(
    (asset) =>
      !SKIPPED_ASSET.test(asset.name) &&
      hints.every((hint) => asset.name.toLowerCase().includes(hint.toLowerCase())),
  );
  return matches.length === 1 ? matches[0] : undefined;
}

export const assetKey = (target: ScanTarget, tag: string, asset: ReleaseAsset) =>
  [
    target.provider,
    target.repository.toLowerCase(),
    tag,
    asset.name,
    asset.digest ?? asset.size ?? "",
  ].join("|");

export interface ScanDependencies {
  releases(target: ScanTarget): Promise<UpstreamRelease[]>;
  download(asset: ReleaseAsset, file: string, maxBytes: number): Promise<void>;
  list(file: string, name: string): Promise<PackageEntry[]>;
  heads(file: string, name: string, entries: PackageEntry[]): Promise<Map<string, Buffer>>;
}

export async function scan(
  targets: readonly ScanTarget[],
  checkpoint: ReadonlyMap<string, ScanRecord>,
  deps: ScanDependencies,
  { maxAssets = 40, maxAssetBytes = 1_500_000_000, maxTotalBytes = 12_000_000_000 } = {},
): Promise<{ report: ScanReport; checkpoint: Map<string, ScanRecord> }> {
  const next = new Map(checkpoint);
  const report: ScanReport = {
    format_version: 1,
    scanned: [],
    reused: 0,
    findings: [],
    unscanned: [],
  };
  const releaseCache = new Map<string, Promise<UpstreamRelease[]>>();
  let budget = maxTotalBytes;
  for (const target of targets) {
    const skip = (reason: string) =>
      report.unscanned.push({ id: target.id, platform: target.platform, reason });
    let releases: UpstreamRelease[];
    try {
      const cacheKey = `${target.provider}|${target.repository.toLowerCase()}`;
      if (!releaseCache.has(cacheKey)) releaseCache.set(cacheKey, deps.releases(target));
      releases = await releaseCache.get(cacheKey)!;
    } catch (error) {
      skip(`release read failed: ${(error as Error).message}`);
      continue;
    }
    const release = channelRelease(releases, target.channel);
    if (!release) {
      skip("no published release in the channel");
      continue;
    }
    const asset = hintedAsset(release.assets, target.hints);
    if (!asset) {
      skip(`hints select no single asset in ${release.tag}`);
      continue;
    }
    const key = assetKey(target, release.tag, asset);
    const known = next.get(key);
    if (known) {
      report.reused++;
      if (known.signals.length)
        report.findings.push({ ...known, id: target.id, platform: target.platform });
      continue;
    }
    if (report.scanned.length >= maxAssets) {
      skip("asset budget reached; scanned in a later run");
      continue;
    }
    if (asset.size !== null && (asset.size > maxAssetBytes || asset.size > budget)) {
      skip(`asset ${asset.name} exceeds the byte budget`);
      continue;
    }
    const dir = await mkdtemp(path.join(os.tmpdir(), "release-scan-"));
    try {
      const file = path.join(dir, "package");
      await deps.download(asset, file, Math.min(maxAssetBytes, budget));
      const bytes = await readFile(file);
      budget -= bytes.length;
      const entries = await deps.list(file, asset.name);
      const heads = await deps.heads(file, asset.name, headCandidates(entries).slice(0, 64));
      const record: ScanRecord = {
        key,
        id: target.id,
        platform: target.platform,
        repository: target.repository,
        tag: release.tag,
        asset: asset.name,
        sha256: createHash("sha256").update(bytes).digest("hex"),
        entries: entries.length,
        signals: packageSignals(entries, heads),
      };
      next.set(key, record);
      report.scanned.push(record);
      if (record.signals.length) report.findings.push(record);
    } catch (error) {
      skip(`asset ${asset.name} could not be scanned: ${(error as Error).message}`);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }
  return { report, checkpoint: next };
}

// ---- Hosted implementations -------------------------------------------------

const run = promisify(execFile);

async function json(url: string, token?: string) {
  const response = await fetch(url, {
    headers: {
      Accept: "application/json",
      "User-Agent": "portcove-release-scan",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    redirect: "error",
  });
  if (!response.ok) throw new Error(`${response.status} from ${new URL(url).host}`);
  return response.json();
}

export const hostedDependencies = (token?: string): ScanDependencies => ({
  async releases(target) {
    if (target.provider === "github") {
      const list = (await json(
        `https://api.github.com/repos/${target.repository}/releases?per_page=10`,
        token,
      )) as Record<string, unknown>[];
      return list.map((release) => ({
        tag: String(release.tag_name),
        draft: Boolean(release.draft),
        prerelease: Boolean(release.prerelease),
        assets: ((release.assets as Record<string, unknown>[]) ?? []).map((asset) => ({
          name: String(asset.name),
          url: String(asset.browser_download_url),
          size: typeof asset.size === "number" ? asset.size : null,
          digest: typeof asset.digest === "string" ? asset.digest : null,
        })),
      }));
    }
    const list = (await json(
      `https://gitlab.com/api/v4/projects/${encodeURIComponent(target.repository)}/releases?per_page=10`,
    )) as Record<string, unknown>[];
    return list.map((release) => ({
      tag: String(release.tag_name),
      draft: false,
      prerelease: Boolean(release.upcoming_release),
      assets: (
        ((release.assets as Record<string, unknown>)?.links as Record<string, unknown>[]) ?? []
      ).map((link) => ({
        name: String(link.name),
        url: String(link.direct_asset_url ?? link.url),
        size: null,
        digest: null,
      })),
    }));
  },
  async download(asset, file, maxBytes) {
    await run(
      "curl",
      ["-fsSL", "--proto", "=https", "--max-filesize", String(maxBytes), "-o", file, asset.url],
      {
        timeout: 15 * 60_000,
      },
    );
  },
  async list(file, name) {
    const lower = name.toLowerCase();
    if (lower.endsWith(".appimage")) {
      const offset = await squashfsOffset(file);
      const { stdout } = await run("unsquashfs", ["-o", String(offset), "-lls", file], {
        maxBuffer: 64 << 20,
      });
      return parseUnsquashfs(stdout);
    }
    if (/\.(tar\.gz|tgz|tar\.xz|txz)$/.test(lower)) {
      const { stdout } = await run("tar", ["-tvf", file], { maxBuffer: 64 << 20 });
      return parseTarVerbose(stdout);
    }
    const { stdout } = await run("7z", ["l", "-ba", "-slt", file], { maxBuffer: 64 << 20 });
    return parse7zTechnical(stdout);
  },
  async heads(file, name, entries) {
    const lower = name.toLowerCase();
    const heads = new Map<string, Buffer>();
    for (const entry of entries) {
      let args: [string, string[]];
      if (/\.(tar\.gz|tgz|tar\.xz|txz)$/.test(lower)) args = ["tar", ["-xOf", file, entry.path]];
      else if (lower.endsWith(".appimage"))
        args = ["unsquashfs", ["-o", String(await squashfsOffset(file)), "-cat", file, entry.path]];
      else args = ["7z", ["e", "-so", file, entry.path]];
      try {
        const { stdout } = await run(args[0], args[1], {
          encoding: "buffer",
          maxBuffer: Math.max(entry.size, HEAD_BYTES) + 1024,
        });
        heads.set(entry.path, (stdout as unknown as Buffer).subarray(0, HEAD_BYTES));
      } catch {
        // An unreadable entry keeps its name-only judgement.
      }
    }
    return heads;
  },
});

/** The SquashFS image of an AppImage starts where its ELF section headers end. */
export async function squashfsOffset(file: string) {
  const elf = await readFile(file);
  if (elf.readUInt32BE(0) !== 0x7f454c46) throw new Error("not an ELF AppImage");
  const offset =
    Number(elf.readBigUInt64LE(0x28)) + elf.readUInt16LE(0x3a) * elf.readUInt16LE(0x3c);
  if (elf.subarray(offset, offset + 4).toString("latin1") !== "hsqs")
    throw new Error("no SquashFS image");
  return offset;
}

export function parse7zTechnical(text: string): PackageEntry[] {
  const entries: PackageEntry[] = [];
  for (const block of text.split(/\r?\n\r?\n/)) {
    const fields = new Map(
      block.split(/\r?\n/).flatMap((line) => {
        const at = line.indexOf(" = ");
        return at > 0 ? [[line.slice(0, at), line.slice(at + 3)] as const] : [];
      }),
    );
    const name = fields.get("Path");
    if (!name || fields.get("Folder") === "+") continue;
    entries.push({ path: name.replaceAll("\\", "/"), size: Number(fields.get("Size") ?? 0) });
  }
  return entries;
}

export function parseTarVerbose(text: string): PackageEntry[] {
  return text
    .split(/\r?\n/)
    .map((line) => /^-\S+\s+\S+\s+(\d+)\s+\S+\s+\S+\s+(.+)$/.exec(line))
    .flatMap((match) =>
      match?.[2] ? [{ path: match[2].replace(/^\.\//, ""), size: Number(match[1]) }] : [],
    );
}

export function parseUnsquashfs(text: string): PackageEntry[] {
  return text
    .split(/\r?\n/)
    .map((line) => /^-\S+\s+\S+\s+(\d+)\s+\S+\s+\S+\s+squashfs-root\/(.+)$/.exec(line))
    .flatMap((match) => (match?.[2] ? [{ path: match[2], size: Number(match[1]) }] : []));
}

/** Job-summary text: findings first, then coverage. */
export function summaryMarkdown(report: ScanReport) {
  const lines = ["## Release content scan", ""];
  lines.push(
    `Scanned ${report.scanned.length} new package(s); ${report.reused} already scanned; ${report.unscanned.length} not scanned.`,
    "",
  );
  if (report.findings.length) {
    lines.push("### Game-data signals to review", "");
    for (const finding of report.findings)
      lines.push(
        `- \`${finding.id}\` (${finding.platform}) ${finding.tag} \`${finding.asset}\`: ${finding.signals
          .map((signal) => `${signal.path} (${signal.reason})`)
          .join("; ")}`,
      );
    lines.push("");
  } else lines.push("No game-data signals.", "");
  if (report.unscanned.length) {
    lines.push("### Not scanned", "");
    for (const entry of report.unscanned)
      lines.push(`- \`${entry.id}\` (${entry.platform}): ${entry.reason}`);
    lines.push("");
  }
  return `${lines.join("\n")}\n`;
}

// ---- Command line -----------------------------------------------------------

async function main(argv: string[]) {
  const option = (name: string) => {
    const at = argv.indexOf(name);
    return at >= 0 ? argv[at + 1] : undefined;
  };
  if (argv[0] === "summary" && option("--report")) {
    const report = JSON.parse(await readFile(option("--report")!, "utf8")) as ScanReport;
    process.stdout.write(summaryMarkdown(report));
    return;
  }
  if (argv[0] !== "scan" || !option("--listings") || !option("--output")) {
    process.stderr.write(
      "Usage: node scripts/release-content-scan.mts scan --listings <listings.json> --checkpoint <file|-> --output <report.json>\n",
    );
    process.exit(2);
  }
  const targets = scanTargets(JSON.parse(await readFile(option("--listings")!, "utf8")));
  const checkpointPath = option("--checkpoint");
  const previous = new Map<string, ScanRecord>();
  if (checkpointPath && checkpointPath !== "-") {
    try {
      const stored = JSON.parse(await readFile(checkpointPath, "utf8")) as {
        records?: ScanRecord[];
      };
      for (const record of stored.records ?? []) previous.set(record.key, record);
    } catch {
      // A missing or unreadable checkpoint scans from scratch.
    }
  }
  const numeric = (name: string) => (option(name) ? Number(option(name)) : undefined);
  const { report, checkpoint } = await scan(
    targets,
    previous,
    hostedDependencies(process.env.GH_TOKEN),
    {
      maxAssets: numeric("--max-assets"),
      maxAssetBytes: numeric("--max-asset-bytes"),
      maxTotalBytes: numeric("--max-total-bytes"),
    },
  );
  await writeFile(option("--output")!, `${JSON.stringify(report, null, 2)}\n`);
  if (option("--checkpoint-out"))
    await writeFile(
      option("--checkpoint-out")!,
      `${JSON.stringify({ format_version: 1, records: [...checkpoint.values()] }, null, 2)}\n`,
    );
  process.stdout.write(
    `${JSON.stringify({ targets: targets.length, scanned: report.scanned.length, reused: report.reused, findings: report.findings.length, unscanned: report.unscanned.length })}\n`,
  );
}

if (import.meta.url === `file://${process.argv[1]}`) await main(process.argv.slice(2));
