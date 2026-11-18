import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { readCatalogSource, type AuthoredPort } from "./catalog-authoring.mts";
import { isRecord } from "./runtime-values.mts";

/**
 * Report-only audit of the catalog facts behind the browsing chips: original
 * system, supported operating system and update channel. It reads the generated
 * catalog and listings, classifies every gap, and never edits anything. A gap is
 * unknown, not wrong: the catalog contract forbids inferring these facts, so each
 * class names what evidence would resolve it. Candidate systems are only
 * suggestions drawn from reviewed siblings and still need their own evidence.
 */

export type OriginalSystemGap =
  | "no-game-identity-with-title"
  | "no-game-identity-no-title"
  | "game-without-editions"
  | "edition-without-system";
export type PlatformGap = "no-platforms";
export type ChannelGap = "integrated-without-channel";

export interface ChipGap {
  id: string;
  originalSystem?: OriginalSystemGap;
  platforms?: PlatformGap;
  channel?: ChannelGap;
  availability: string;
  /** Same-title research leads require separate evidence of the actual edition. */
  titleMatchResearchLeads?: string[];
  disposition?: NonNullable<AuthoredPort["original_game_review"]>["disposition"];
}

export interface ChipGapReport {
  total: number;
  integrated: number;
  gaps: ChipGap[];
  coverage: { sourceSystems: number; supportedOs: number; upstreamManaged: number };
  counts: Record<string, number>;
}

const text = (value: unknown): string | undefined =>
  typeof value === "string" && value.trim() ? value : undefined;
const strings = (value: unknown): string[] =>
  Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
const records = (value: unknown): Record<string, unknown>[] =>
  Array.isArray(value) ? value.filter(isRecord) : [];

function normalizedTitle(title: string): string {
  return title
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

function editionSystems(originalGame: unknown): string[] {
  if (!isRecord(originalGame)) return [];
  return records(originalGame.source_editions).flatMap((edition) => text(edition.system) ?? []);
}

/** Pure analysis over the generated listings and catalog documents. */
export function auditChipGaps(
  listingsDocument: unknown,
  catalogDocument: unknown,
  authored: readonly AuthoredPort[] = [],
): ChipGapReport {
  const listings = isRecord(listingsDocument) ? records(listingsDocument.listings) : [];
  const ports = new Map(
    (isRecord(catalogDocument) ? records(catalogDocument.ports) : []).map((port) => [
      String(port.id),
      port,
    ]),
  );

  const reviews = new Map(
    authored.map(({ listing, original_game_review }) => [
      listing.id,
      original_game_review?.disposition,
    ]),
  );
  const reviewed = new Map<string, Set<string>>();
  for (const listing of listings) {
    const title = text(listing.original_game_title);
    const port = ports.get(String(listing.id));
    const presentation = isRecord(port?.presentation) ? port.presentation : undefined;
    const systems = editionSystems(presentation?.original_game ?? listing.original_game);
    if (!title || !systems.length) continue;
    const key = normalizedTitle(title);
    reviewed.set(key, new Set([...(reviewed.get(key) ?? []), ...systems]));
  }

  const gaps: ChipGap[] = [];
  const counts: Record<string, number> = {};
  const coverage = { sourceSystems: 0, supportedOs: 0, upstreamManaged: 0 };
  const count = (key: string) => (counts[key] = (counts[key] ?? 0) + 1);

  for (const listing of listings) {
    const id = String(listing.id);
    const port = ports.get(id);
    const presentation = isRecord(port?.presentation) ? port.presentation : undefined;
    const originalGame = presentation?.original_game ?? listing.original_game;
    const title = text(listing.original_game_title) ?? text(presentation?.original_game_title);
    const gap: ChipGap = { id, availability: text(listing.availability) ?? "unspecified" };

    const disposition = reviews.get(id);
    const deliberateScope = disposition && disposition !== "separate";
    if (editionSystems(originalGame).length) coverage.sourceSystems++;
    if (deliberateScope) {
      gap.disposition = disposition;
      count(`disposition:${disposition}`);
    } else if (!isRecord(originalGame)) {
      gap.originalSystem = title ? "no-game-identity-with-title" : "no-game-identity-no-title";
    } else if (!records(originalGame.source_editions).length) {
      gap.originalSystem = "game-without-editions";
    } else if (records(originalGame.source_editions).some((edition) => !text(edition.system))) {
      gap.originalSystem = "edition-without-system";
    }
    if (gap.originalSystem && title) {
      const candidates = reviewed.get(normalizedTitle(title));
      if (candidates?.size)
        gap.titleMatchResearchLeads = [...candidates].sort((left, right) =>
          left.localeCompare(right),
        );
    }

    const platforms = new Set([...strings(listing.platforms), ...strings(port?.platforms)]);
    if (platforms.size) coverage.supportedOs++;
    else gap.platforms = "no-platforms";

    if (port) {
      if (!strings(port.channels).length) gap.channel = "integrated-without-channel";
    } else {
      coverage.upstreamManaged++;
    }

    if (gap.originalSystem) count(`originalSystem:${gap.originalSystem}`);
    if (gap.platforms) count(`platforms:${gap.platforms}:${gap.availability}`);
    if (gap.channel) count(`channel:${gap.channel}`);
    if (gap.originalSystem || gap.platforms || gap.channel || gap.disposition) gaps.push(gap);
  }
  return { total: listings.length, integrated: ports.size, coverage, gaps, counts };
}

export function renderChipGapSummary(report: ChipGapReport): string {
  const lines = [`Catalog chip gaps: ${report.total} listings, ${report.integrated} integrated`];
  for (const [key, value] of Object.entries(report.counts).sort(([left], [right]) =>
    left.localeCompare(right),
  ))
    lines.push(`  ${key.padEnd(58)} ${String(value).padStart(5)}`);
  const leads = report.gaps.filter((gap) => gap.titleMatchResearchLeads).length;
  lines.push(`Source system recorded: ${report.coverage.sourceSystems}/${report.total}`);
  lines.push(`Supported OS recorded: ${report.coverage.supportedOs}/${report.total}`);
  lines.push(`Upstream manages updates: ${report.coverage.upstreamManaged}`);
  lines.push(
    `Same-title research leads: ${leads}. Confirm the edition against pinned upstream evidence.`,
  );
  return lines.join("\n");
}

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const read = (name: string): unknown =>
    JSON.parse(readFileSync(join(root, "crates/portcove-core/catalog", name), "utf8"));
  const { records: authored } = readCatalogSource(join(root, "crates/portcove-core/catalog"));
  const report = auditChipGaps(read("listings.json"), read("catalog.json"), authored);
  if (process.argv.includes("--json")) console.log(JSON.stringify(report, null, 2));
  else console.log(renderChipGapSummary(report));
}
