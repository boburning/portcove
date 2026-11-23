// Listing package facts: typed player facts for listing-only GitHub packages.
//
// The existing listing observer states which releases and assets an upstream
// publishes and whether that coverage is complete. It never reads bytes, so a
// filename is all it knows, and a filename never authorizes a runtime. This
// worker reads the exact bytes of the latest stable release's archives through
// Core (`portcove --json catalog inspect-listing-artifact`, which executes
// nothing) and records each archive's player candidates with header machine and
// SHA-256 as an `exact-release-structured` fact. The generated registration
// route reads only these facts (`scripts/catalog-generated-registration.mts`).
//
// Bounded and resumable: one run inspects at most `maxIdentities` identities
// and `maxBytes` of archives, in identity order after a cursor. Unchanged
// archives are reused, never downloaded again. The cursor moves past an
// identity only when its coverage is complete; an incomplete identity is
// recorded as UNKNOWN (never eligible) and retried first on the next run,
// while the run continues with the others.
//
//   node scripts/listing-package-facts.mts --check
//   node scripts/listing-package-facts.mts derive --observations REPORT.json \
//     --cli PORTCOVE [--cursor CURSOR.json] [--output TABLE.json]
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { createWriteStream } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { parseCatalogSource, readCatalogSource, type AuthoredPort } from "./catalog-authoring.mts";
import {
  checkListingFactsTable,
  digestOf,
  emptyFactsTable,
  FACTS_PARSER,
  FACTS_PARSER_VERSION,
  type ArtifactFactV1,
  type ListingFactsEntry,
  type ListingFactsTable,
  type PlayerFact,
} from "./catalog-generated-registration.mts";
import { listingProviderIdentity } from "./listing-upstream-observation.mts";
import { isRecord } from "./runtime-values.mts";

export const defaultBudget = {
  maxIdentities: 24,
  maxBytes: 2 * 1024 ** 3,
  maxArchiveBytes: 512 * 1024 ** 2,
  maxArchivesPerRelease: 6,
} as const;
export type Budget = { -readonly [K in keyof typeof defaultBudget]: number };
export interface Cursor {
  format: 1;
  /** Identities up to and including this one completed in order; null starts over. */
  after: string | null;
}
export interface ObservedAsset {
  id: number;
  name: string;
  url: string;
  size: number;
  sha256: string | null;
}
interface ObservedRelease {
  id: number;
  version: string;
  published_at: string | null;
  provider_prerelease: boolean;
  assets_complete: boolean;
  assets: ObservedAsset[];
}
/** Reads verified archive bytes and returns their player candidates; throws on failure. */
export type ByteInspector = (asset: ObservedAsset, readerPlatform: string) => Promise<PlayerFact[]>;

const archiveForms = [".zip", ".tar.gz", ".tgz", ".tar.xz"];
const sha = /^[a-f0-9]{64}$/u;

/** Listing-only identities the generated route could serve, by observer report. */
function observations(records: readonly AuthoredPort[], report: unknown) {
  const listingOnly = new Map(
    records
      .filter((record) => record.integration === undefined)
      .flatMap((record) => {
        const identity = listingProviderIdentity(record.listing);
        return identity?.provider === "github" ? [[record.listing.id, identity.repository]] : [];
      }),
  );
  const entries: unknown =
    isRecord(report) && Array.isArray(report.listings) ? report.listings : report;
  if (!Array.isArray(entries)) throw new Error("Observer report needs a listings array.");
  const result = new Map<string, { repository: string; observation: Record<string, unknown> }>();
  for (const raw of entries) {
    const update: unknown =
      isRecord(raw) && isRecord(raw.listing_update) ? raw.listing_update : raw;
    if (!isRecord(update) || typeof update.id !== "string") continue;
    const repository = listingOnly.get(update.id);
    const observation = update.upstream_observation;
    if (!repository || !isRecord(observation) || observation.provider !== "github") continue;
    if (String(observation.repository).toLowerCase() !== repository.toLowerCase()) continue;
    result.set(update.id, {
      repository: String(observation.repository),
      observation,
    });
  }
  return result;
}

function releasesOf(observation: Record<string, unknown>): ObservedRelease[] {
  return (Array.isArray(observation.releases) ? observation.releases : []).flatMap(
    (release: unknown) =>
      isRecord(release) &&
      Number.isSafeInteger(release.id) &&
      typeof release.version === "string" &&
      Array.isArray(release.assets)
        ? [
            {
              id: Number(release.id),
              version: release.version,
              published_at: typeof release.published_at === "string" ? release.published_at : null,
              provider_prerelease: release.provider_prerelease === true,
              assets_complete: release.assets_complete === true,
              assets: release.assets.flatMap((asset: unknown) =>
                isRecord(asset) &&
                Number.isSafeInteger(asset.id) &&
                typeof asset.name === "string" &&
                typeof asset.url === "string" &&
                Number.isSafeInteger(asset.size)
                  ? [
                      {
                        id: Number(asset.id),
                        name: asset.name,
                        url: asset.url,
                        size: Number(asset.size),
                        sha256:
                          typeof asset.sha256 === "string" && sha.test(asset.sha256)
                            ? asset.sha256
                            : null,
                      },
                    ]
                  : [],
              ),
            },
          ]
        : [],
  );
}

/** The latest stable release: newest publication, then highest provider id. */
function latestStable(releases: readonly ObservedRelease[]) {
  return releases
    .filter((release) => !release.provider_prerelease)
    .toSorted(
      (left, right) =>
        (Date.parse(right.published_at ?? "") || 0) - (Date.parse(left.published_at ?? "") || 0) ||
        right.id - left.id,
    )[0];
}

const isArchive = (name: string) => archiveForms.some((form) => name.toLowerCase().endsWith(form));
/** Reader rules only; TAR.XZ is read by the Linux reader. */
const readerPlatform = (name: string) =>
  name.toLowerCase().endsWith(".tar.xz") ? "linux-x86-64" : "windows-x86-64";

const machineOs = (machine: string) =>
  machine.startsWith("pe-")
    ? "windows"
    : machine.startsWith("elf")
      ? "linux"
      : machine.startsWith("macho-")
        ? "macos"
        : "unknown";
function machineArch(machine: string) {
  if (machine.startsWith("macho-universal-")) return "universal";
  const arch = machine.replace(/^(?:pe|elf32|elf64|elf32be|elf64be|macho)-/u, "");
  return arch === "arm64" ? "aarch64" : ["x86-64", "x86"].includes(arch) ? arch : "unknown";
}
const agreed = (values: string[]) =>
  values.length && values.every((value) => value === values[0]) ? values[0]! : "unknown";

/** One archive's structural fact. A player-free archive's role stays unknown. */
export function artifactFact(asset: ObservedAsset, players: PlayerFact[]): ArtifactFactV1 {
  return {
    asset_id: asset.id,
    name: asset.name,
    size: asset.size,
    sha256: asset.sha256,
    role: players.length ? "desktop-game-runtime" : "unknown",
    os: agreed(players.map(({ machine }) => machineOs(machine))),
    arch: agreed(players.map(({ machine }) => machineArch(machine))),
    source: {
      kind: "exact-release-structured",
      shape_version: 2,
      archive_sha256: asset.sha256,
    },
    players: players.toSorted((left, right) => (left.path < right.path ? -1 : 1)),
    contradictory: false,
  };
}

export interface DeriveInputs {
  records: readonly AuthoredPort[];
  observerReport: unknown;
  table: unknown;
  cursor?: Cursor;
  budget?: Partial<Budget>;
  inspect: ByteInspector;
  now: string;
}
export interface DeriveResult {
  table: ListingFactsTable;
  cursor: Cursor;
  report: {
    port_id: string;
    coverage: string;
    inspected: number;
    reused: number;
  }[];
  bytes: number;
}

export async function deriveListingFacts(inputs: DeriveInputs): Promise<DeriveResult> {
  const budget = { ...defaultBudget, ...inputs.budget };
  const previous = inputs.table ?? emptyFactsTable();
  checkListingFactsTable(previous);
  const known = new Set(inputs.records.map((record) => record.listing.id));
  const operational = new Set(
    inputs.records.filter((record) => record.integration !== undefined).map((r) => r.listing.id),
  );
  const entries = new Map(
    previous.entries
      .filter((entry) => known.has(entry.port_id) && !operational.has(entry.port_id))
      .map((entry) => [entry.port_id, entry]),
  );
  const observed = observations(inputs.records, inputs.observerReport);
  const order = [...observed.keys()].toSorted();
  const after = inputs.cursor?.after ?? null;
  const start = after === null ? 0 : order.findIndex((id) => id > after);
  const queue = start < 0 ? [] : order.slice(start);
  const report: DeriveResult["report"] = [];
  let bytes = 0;
  let cursor: string | null = after;
  let contiguous = true;
  for (const id of queue) {
    if (report.length >= budget.maxIdentities) break;
    const { repository, observation } = observed.get(id)!;
    const release = latestStable(releasesOf(observation));
    const prior = entries.get(id);
    const base = (coverage: ListingFactsEntry["observation"]["coverage"], complete: boolean) => ({
      port_id: id,
      provider: "github" as const,
      repository,
      parser: FACTS_PARSER,
      parser_version: FACTS_PARSER_VERSION,
      observation: {
        release_id: release!.id,
        tag: release!.version,
        published_at: release!.published_at,
        provider_prerelease: release!.provider_prerelease,
        observed_at:
          typeof observation.observed_at === "string" ? observation.observed_at : inputs.now,
        coverage,
        assets_complete: complete,
      },
    });
    if (!release) {
      // No stable release: nothing to establish; any earlier facts are stale.
      entries.delete(id);
      report.push({
        port_id: id,
        coverage: "no-stable-release",
        inspected: 0,
        reused: 0,
      });
      if (contiguous) cursor = id;
      continue;
    }
    const archives = release.assets
      .filter((asset) => isArchive(asset.name))
      .toSorted((left, right) => left.id - right.id);
    const selected = archives
      .filter((asset) => asset.sha256 && asset.size > 0 && asset.size <= budget.maxArchiveBytes)
      .slice(0, budget.maxArchivesPerRelease);
    const reusable = new Map(
      prior?.observation.release_id === release.id
        ? prior.artifacts.map((artifact) => [`${artifact.asset_id}/${artifact.sha256}`, artifact])
        : [],
    );
    const needed = selected.filter((asset) => !reusable.has(`${asset.id}/${asset.sha256}`));
    const cost = needed.reduce((sum, asset) => sum + asset.size, 0);
    if (bytes + cost > budget.maxBytes) break;
    bytes += cost;
    const artifacts: ArtifactFactV1[] = [];
    let failed = 0;
    for (const asset of selected) {
      const reused = reusable.get(`${asset.id}/${asset.sha256}`);
      if (reused) {
        artifacts.push(reused);
        continue;
      }
      try {
        artifacts.push(
          artifactFact(asset, await inputs.inspect(asset, readerPlatform(asset.name))),
        );
      } catch {
        failed++;
      }
    }
    const complete =
      observation.status === "complete" &&
      release.assets_complete &&
      failed === 0 &&
      selected.length === archives.length;
    const coverage =
      observation.status !== "complete"
        ? "partial"
        : failed
          ? "failed"
          : complete
            ? "complete"
            : "partial";
    entries.set(id, { ...base(coverage, complete), artifacts });
    report.push({
      port_id: id,
      coverage,
      inspected:
        selected.length - artifacts.filter((a) => reusable.has(`${a.asset_id}/${a.sha256}`)).length,
      reused: artifacts.filter((a) => reusable.has(`${a.asset_id}/${a.sha256}`)).length,
    });
    if (complete && contiguous) cursor = id;
    else contiguous = false;
  }
  const processedAll = report.length === queue.length && contiguous;
  const sorted = [...entries.values()].toSorted((left, right) =>
    left.port_id < right.port_id ? -1 : 1,
  );
  const table: ListingFactsTable = {
    format: previous.format,
    generator: previous.generator,
    entries: sorted,
    entries_sha256: digestOf(sorted),
  };
  checkListingFactsTable(table);
  return {
    table,
    cursor: { format: 1, after: processedAll ? null : cursor },
    report,
    bytes,
  };
}

// ---------------------------------------------------------------------------
// I/O shell: bounded download, Core inspection, then delete the bytes.

const run = promisify(execFile);

export function cliInspector(cli: string, workDirectory: string): ByteInspector {
  return async (asset, platform) => {
    if (!asset.sha256 || !/^https:\/\/github\.com\//u.test(asset.url))
      throw new Error("Only digest-bound GitHub release assets are inspected.");
    const directory = await mkdtemp(path.join(workDirectory, "asset-"));
    try {
      const file = path.join(directory, path.basename(new URL(asset.url).pathname));
      const response = await fetch(asset.url, { redirect: "follow" });
      if (!response.ok || !response.body) throw new Error(`Download failed: ${response.status}`);
      const hash = createHash("sha256");
      let received = 0;
      const body = Readable.fromWeb(response.body as never);
      body.on("data", (chunk: Buffer) => {
        received += chunk.length;
        if (received > asset.size) body.destroy(new Error("Archive exceeds its declared size."));
        hash.update(chunk);
      });
      await pipeline(body, createWriteStream(file, { flags: "wx" }));
      if (received !== asset.size || hash.digest("hex") !== asset.sha256)
        throw new Error("Archive bytes differ from the provider's size or digest.");
      const { stdout } = await run(
        cli,
        [
          "--json",
          "catalog",
          "inspect-listing-artifact",
          file,
          "--platform",
          platform,
          "--size",
          String(asset.size),
          "--sha256",
          asset.sha256,
        ],
        { maxBuffer: 16 * 1024 * 1024, timeout: 10 * 60_000 },
      );
      const response_: unknown = JSON.parse(stdout);
      const data = isRecord(response_) && isRecord(response_.data) ? response_.data : undefined;
      if (!data || data.sha256 !== asset.sha256 || !Array.isArray(data.player_candidates))
        throw new Error("Core returned no inspection for these bytes.");
      return data.player_candidates.flatMap((player: unknown) =>
        isRecord(player) &&
        typeof player.path === "string" &&
        typeof player.machine === "string" &&
        typeof player.sha256 === "string"
          ? [
              {
                path: player.path,
                machine: player.machine,
                sha256: player.sha256,
              },
            ]
          : [],
      );
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  };
}

const root = fileURLToPath(new URL("../", import.meta.url));
const catalogRoot = path.join(root, "crates/portcove-core/catalog");
export const factsTablePath = path.join(catalogRoot, "listing-package-facts.generated.json");
const usage =
  "Usage: node scripts/listing-package-facts.mts --check | derive --observations REPORT --cli PORTCOVE [--cursor FILE] [--output FILE]";

async function main(argv: string[]) {
  if (argv.length === 1 && argv[0] === "--check") {
    checkListingFactsTable(parseCatalogSource(await readFile(factsTablePath, "utf8")));
    return "Listing package facts are well formed.\n";
  }
  if (argv[0] !== "derive") throw new Error(usage);
  const options: Record<string, string> = {};
  for (let index = 1; index < argv.length; index += 2) {
    const name = argv[index];
    const value = argv[index + 1];
    if (!name?.startsWith("--") || !value || value.startsWith("--")) throw new Error(usage);
    options[name.slice(2)] = value;
  }
  if (!options.observations || !options.cli) throw new Error(usage);
  const output = options.output ?? factsTablePath;
  const { records } = readCatalogSource(catalogRoot);
  const work = await mkdtemp(path.join(os.tmpdir(), "listing-facts-"));
  try {
    const result = await deriveListingFacts({
      records,
      observerReport: JSON.parse(await readFile(options.observations, "utf8")),
      table: parseCatalogSource(await readFile(factsTablePath, "utf8")),
      ...(options.cursor
        ? {
            cursor: await readFile(options.cursor, "utf8")
              .then((text) => JSON.parse(text) as Cursor)
              .catch(() => ({ format: 1 as const, after: null })),
          }
        : {}),
      inspect: cliInspector(path.resolve(options.cli), work),
      now: new Date().toISOString(),
    });
    await writeFile(output, `${JSON.stringify(result.table, null, 2)}\n`);
    if (options.cursor) await writeFile(options.cursor, `${JSON.stringify(result.cursor)}\n`);
    return `${JSON.stringify({ cursor: result.cursor, bytes: result.bytes, identities: result.report })}\n`;
  } finally {
    await rm(work, { recursive: true, force: true });
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).then(
    (text) => process.stdout.write(text),
    (error: unknown) => {
      process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
      process.exitCode = 1;
    },
  );
}
