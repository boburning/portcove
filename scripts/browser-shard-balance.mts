// Balances the hosted browser shards by recorded file duration instead of path hash.
// `.config/browser-test-weights.json` holds scheduling estimates only: the current Vitest
// spec list owns membership, and a file without a weight receives the median weight.
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { BaseSequencer, type TestSpecification } from "vite-plus/test/node";

export const projectRoot = fileURLToPath(new URL("..", import.meta.url));
export const browserWeightsPath = path.join(projectRoot, ".config", "browser-test-weights.json");

export interface BrowserWeightsFile {
  format_version: 1;
  source: string;
  purpose: string;
  weights: Record<string, number>;
}

const purpose =
  "Scheduling estimates only. The current Vitest spec list owns membership; files without a weight receive the median weight.";

export interface WeightedItem<T> {
  item: T;
  key: string;
  weight: number;
}

const pathHash = (key: string) => createHash("sha1").update(key).digest("hex");

/**
 * Splits every item into exactly one of `count` shards, longest first onto the lightest shard.
 * Equal weights break on the path hash, and equal loads on the lower shard index, so the result
 * depends only on the item keys and weights.
 */
export function partitionByWeight<T>(items: readonly WeightedItem<T>[], count: number): T[][] {
  if (!Number.isSafeInteger(count) || count < 1) throw new Error("Shard count must be at least 1");
  const ordered = items
    .map((entry) => ({ ...entry, hash: pathHash(entry.key) }))
    .sort((left, right) =>
      left.weight !== right.weight
        ? right.weight - left.weight
        : left.hash < right.hash
          ? -1
          : left.hash > right.hash
            ? 1
            : 0,
    );
  const shards = Array.from({ length: count }, () => ({ load: 0, items: [] as T[] }));
  for (const entry of ordered) {
    let lightest = shards[0]!;
    for (const shard of shards) if (shard.load < lightest.load) lightest = shard;
    lightest.load += entry.weight;
    lightest.items.push(entry.item);
  }
  return shards.map((shard) => shard.items);
}

function median(values: number[]) {
  if (!values.length) return 1;
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle]! : (sorted[middle - 1]! + sorted[middle]!) / 2;
}

export function validateBrowserWeights(value: unknown): BrowserWeightsFile {
  const file = value as Partial<BrowserWeightsFile> | null;
  if (
    !file ||
    file.format_version !== 1 ||
    typeof file.source !== "string" ||
    typeof file.weights !== "object" ||
    file.weights === null ||
    Array.isArray(file.weights)
  )
    throw new Error("Browser test weights must use format_version 1 with a weights object");
  for (const [key, weight] of Object.entries(file.weights))
    if (key.startsWith("/") || key.includes("\\") || !(Number.isFinite(weight) && weight > 0))
      throw new Error(
        `Browser test weight for ${key} must be a positive repository-relative entry`,
      );
  return file as BrowserWeightsFile;
}

export function readBrowserWeights(file = browserWeightsPath): Record<string, number> {
  return validateBrowserWeights(JSON.parse(readFileSync(file, "utf8"))).weights;
}

/** Weights keyed by repository-relative path; unknown files take the median known weight. */
export function weighItems<T>(
  items: readonly { item: T; key: string }[],
  weights: Record<string, number>,
): WeightedItem<T>[] {
  const fallback = median(
    items
      .map(({ key }) => weights[key])
      .filter((value): value is number => value !== undefined && value > 0),
  );
  return items.map(({ item, key }) => ({ item, key, weight: weights[key] ?? fallback }));
}

/** Vitest sequencer that changes only shard assignment; per-shard ordering stays Vitest's own. */
export class WeightedShardSequencer extends BaseSequencer {
  override async shard(files: TestSpecification[]): Promise<TestSpecification[]> {
    const { index, count } = this.ctx.config.shard!;
    const root = this.ctx.config.root;
    const keyed = files.map((spec) => ({
      item: spec,
      key: path.relative(root, spec.moduleId).split(path.sep).join("/"),
    }));
    const shard = partitionByWeight(weighItems(keyed, readBrowserWeights()), count)[index - 1];
    if (!shard) throw new Error(`Shard ${index}/${count} is outside the partition`);
    return shard;
  }
}

interface VitestJsonReport {
  testResults?: { name?: unknown; startTime?: unknown; endTime?: unknown }[];
}

/** Derives per-file weights in milliseconds from a Vitest JSON report. */
export function weightsFromReport(report: VitestJsonReport, root = projectRoot) {
  const weights: Record<string, number> = {};
  for (const result of report.testResults ?? []) {
    const { name, startTime, endTime } = result;
    if (typeof name !== "string" || typeof startTime !== "number" || typeof endTime !== "number")
      continue;
    const key = path.relative(root, name).split(path.sep).join("/");
    if (key.startsWith("..") || path.isAbsolute(key)) continue;
    weights[key] = Math.max(1, Math.round(endTime - startTime));
  }
  return Object.fromEntries(
    Object.entries(weights).sort(([left], [right]) => left.localeCompare(right)),
  );
}

function main(argv: string[]) {
  const reportIndex = argv.indexOf("--report");
  const sourceIndex = argv.indexOf("--source");
  const report = reportIndex >= 0 ? argv[reportIndex + 1] : undefined;
  if (!report) {
    console.error(
      "Usage: node scripts/browser-shard-balance.mts --report <vitest-json-report> [--source <description>]",
    );
    return 2;
  }
  const weights = weightsFromReport(JSON.parse(readFileSync(report, "utf8")) as VitestJsonReport);
  if (!Object.keys(weights).length) throw new Error(`${report} contains no timed test files`);
  const file: BrowserWeightsFile = {
    format_version: 1,
    source: sourceIndex >= 0 ? (argv[sourceIndex + 1] ?? "") : "Vitest JSON report",
    purpose,
    weights,
  };
  writeFileSync(browserWeightsPath, `${JSON.stringify(file, null, 2)}\n`);
  console.log(`Wrote ${Object.keys(weights).length} browser test weights to ${browserWeightsPath}`);
  return 0;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href)
  process.exitCode = main(process.argv.slice(2));
