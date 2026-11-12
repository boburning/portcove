// Enroll a title in Core's shared release-selection corpus from a configured
// upstream observation. The author supplies the independently identified asset
// for each release and platform. This tool only transcribes the observed
// inventory and classifies the remaining ZIPs, which Core's test requires.
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { isDeepStrictEqual, parseArgs } from "node:util";
import { pathToFileURL } from "node:url";
import { isRecord } from "./runtime-values.mts";

export const corpusPath =
  "crates/portcove-core/src/testdata/windows-archive-release-selection.json";

export const platformFields = {
  "windows-x86-64": "selected_assets",
  "linux-x86-64": "linux_selected_assets",
  "macos-x86-64": "macos_x86_64_selected_assets",
  "macos-aarch64": "macos_aarch64_selected_assets",
} as const;
export type Platform = keyof typeof platformFields;

export interface InventoryAsset {
  id: number;
  name: string;
  browser_download_url: string;
  size: number;
  digest: string | null;
}
export interface InventoryRelease {
  id: number;
  tag_name: string;
  draft: false;
  prerelease: boolean;
  published_at: string;
  assets: InventoryAsset[];
}
export interface Corpus {
  cases: Record<string, Record<string, unknown>>;
  inventories: Record<string, InventoryRelease[]>;
  other_zip_assets: { inventory: string; release_index: number; asset: string }[];
  [key: string]: unknown;
}
export interface Enrollment {
  portId: string;
  inventory: string;
  repositoryId: number;
  releases: InventoryRelease[];
  selections: Partial<Record<Platform, string[]>>;
  channel?: string;
}

function fail(message: string): never {
  throw new Error(message);
}

function nonNegativeInteger(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0)
    fail(`${label} must be a non-negative integer`);
  return value;
}

function string(value: unknown, label: string): string {
  if (typeof value !== "string" || !value) fail(`${label} must be a non-empty string`);
  return value;
}

/** Read the observed repository and the named releases, oldest first. */
export function inventoryFromObservation(
  observation: unknown,
  portId: string,
  tags: readonly string[],
): { repositoryId: number; releases: InventoryRelease[] } {
  if (!isRecord(observation) || !isRecord(observation.configured_scope))
    fail("expected a configured-upstream observation");
  if (observation.configured_scope.port_id !== portId)
    fail(
      `the observation belongs to ${String(observation.configured_scope.port_id)}, not ${portId}`,
    );
  const facts = isRecord(observation.observation) ? observation.observation.facts : undefined;
  if (!isRecord(facts) || !isRecord(facts.repository) || !Array.isArray(facts.releases))
    fail("the observation has no repository facts or releases");
  const observed: unknown[] = facts.releases;
  if (!tags.length || new Set(tags).size !== tags.length) fail("name each release tag once");
  const releases = tags.map((tag) => {
    const matches = observed.filter(
      (release): release is Record<string, unknown> =>
        isRecord(release) && release.tag_name === tag,
    );
    const release = matches.length === 1 ? matches[0] : undefined;
    if (!release) fail(`release ${tag} must be observed exactly once`);
    if (release.draft === true) fail(`release ${tag} is a draft`);
    if (!Array.isArray(release.assets)) fail(`release ${tag} has no asset list`);
    const assets = release.assets.map((asset, index): InventoryAsset => {
      if (!isRecord(asset)) fail(`release ${tag} asset ${index} is not an object`);
      const digest = asset.digest ?? null;
      if (digest !== null && (typeof digest !== "string" || !/^sha256:[0-9a-f]{64}$/u.test(digest)))
        fail(`release ${tag} asset ${index} has an unexpected digest`);
      return {
        id: nonNegativeInteger(asset.id, `release ${tag} asset id`),
        name: string(asset.name, `release ${tag} asset name`),
        browser_download_url: string(asset.browser_download_url, `release ${tag} asset URL`),
        size: nonNegativeInteger(asset.size, `release ${tag} asset size`),
        digest,
      };
    });
    assets.sort((left, right) => (left.name < right.name ? -1 : left.name > right.name ? 1 : 0));
    if (new Set(assets.map((asset) => asset.name)).size !== assets.length)
      fail(`release ${tag} repeats an asset name`);
    return {
      id: nonNegativeInteger(release.id, `release ${tag} id`),
      tag_name: tag,
      draft: false as const,
      prerelease: release.prerelease === true,
      published_at: string(release.published_at, `release ${tag} publication time`),
      assets,
    };
  });
  releases.sort((left, right) =>
    left.published_at < right.published_at ? -1 : left.published_at > right.published_at ? 1 : 0,
  );
  return {
    repositoryId: nonNegativeInteger(facts.repository.id, "repository id"),
    releases,
  };
}

function selectedNames(corpus: Corpus, inventory: string) {
  const selected = new Set<string>();
  for (const value of Object.values(corpus.cases)) {
    if (value.inventory !== inventory) continue;
    for (const field of Object.values(platformFields)) {
      const names = value[field];
      if (!Array.isArray(names)) continue;
      names.forEach((name, index) => selected.add(`${index}\0${String(name)}`));
    }
  }
  return selected;
}

/** Return a new corpus with the title enrolled and this inventory's ZIPs classified. */
export function enrollSelectionCase(corpus: Corpus, enrollment: Enrollment): Corpus {
  const { portId, inventory, releases, selections } = enrollment;
  if (Object.hasOwn(corpus.cases, portId)) fail(`${portId} is already enrolled`);
  if (releases.length < 2) fail("enroll at least two releases");
  if (!selections["windows-x86-64"]) fail("the Windows x86-64 selection is required");
  const existing = corpus.inventories[inventory];
  if (existing !== undefined && !isDeepStrictEqual(existing, releases))
    fail(`inventory ${inventory} already holds different releases`);
  const entry: Record<string, unknown> = {
    inventory,
    repository_id: enrollment.repositoryId,
  };
  if (enrollment.channel !== undefined) entry.channel = enrollment.channel;
  for (const [platform, field] of Object.entries(platformFields) as [Platform, string][]) {
    const names = selections[platform];
    if (names === undefined) continue;
    if (names.length !== releases.length)
      fail(`${platform} needs exactly one selected asset for each of ${releases.length} releases`);
    names.forEach((name, index) => {
      const release = releases[index]!;
      const asset = release.assets.find((candidate) => candidate.name === name);
      if (!asset) fail(`${release.tag_name} has no asset named ${name}`);
      if (!asset.digest) fail(`${release.tag_name} ${name} has no published SHA-256`);
    });
    entry[field] = [...names];
  }
  const next: Corpus = {
    ...corpus,
    cases: { ...corpus.cases, [portId]: entry },
    inventories: { ...corpus.inventories, [inventory]: releases },
  };
  const selected = selectedNames(next, inventory);
  const others = next.other_zip_assets.filter(
    (other) =>
      other.inventory !== inventory || !selected.has(`${other.release_index}\0${other.asset}`),
  );
  const known = new Set(
    others
      .filter((other) => other.inventory === inventory)
      .map((other) => `${other.release_index}\0${other.asset}`),
  );
  releases.forEach((release, index) => {
    for (const asset of release.assets) {
      const key = `${index}\0${asset.name}`;
      if (asset.name.endsWith(".zip") && !selected.has(key) && !known.has(key))
        others.push({ inventory, release_index: index, asset: asset.name });
    }
  });
  return { ...next, other_zip_assets: others };
}

function parseSelections(values: readonly string[]) {
  const selections: Partial<Record<Platform, string[]>> = {};
  for (const value of values) {
    const separator = value.indexOf("=");
    const platform = value.slice(0, separator) as Platform;
    if (separator < 1 || !Object.hasOwn(platformFields, platform))
      fail(`--select ${value}: use PLATFORM=ASSET,ASSET with a supported platform`);
    if (selections[platform]) fail(`--select repeats ${platform}`);
    selections[platform] = value.slice(separator + 1).split(",");
  }
  return selections;
}

const usage = `Usage: node scripts/catalog-selection-enrollment.mts --observation FILE --port ID \\
  --tags OLD,NEW --select windows-x86-64=ASSET,ASSET [--select PLATFORM=...] \\
  [--inventory KEY] [--channel CHANNEL] [--write]

Without --write, prints the corpus entries that would be added.`;

export function main(argv: readonly string[], root = process.cwd()) {
  const { values } = parseArgs({
    args: [...argv],
    options: {
      observation: { type: "string" },
      port: { type: "string" },
      tags: { type: "string" },
      select: { type: "string", multiple: true },
      inventory: { type: "string" },
      channel: { type: "string" },
      write: { type: "boolean", default: false },
      help: { type: "boolean", default: false },
    },
    strict: true,
  });
  if (values.help) return usage;
  if (!values.observation || !values.port || !values.tags || !values.select) fail(usage);
  const observation: unknown = JSON.parse(readFileSync(values.observation, "utf8"));
  const { repositoryId, releases } = inventoryFromObservation(
    observation,
    values.port,
    values.tags.split(","),
  );
  const path = resolve(root, corpusPath);
  const corpus = JSON.parse(readFileSync(path, "utf8")) as Corpus;
  const inventory = values.inventory ?? values.port;
  const next = enrollSelectionCase(corpus, {
    portId: values.port,
    inventory,
    repositoryId,
    releases,
    selections: parseSelections(values.select),
    ...(values.channel === undefined ? {} : { channel: values.channel }),
  });
  if (values.write) {
    writeFileSync(path, `${JSON.stringify(next, null, 2)}\n`);
    return `Enrolled ${values.port}. Format the corpus with: pnpm exec vp fmt ${corpusPath}`;
  }
  return JSON.stringify(
    {
      case: next.cases[values.port],
      inventory: { [inventory]: next.inventories[inventory] },
      other_zip_assets: next.other_zip_assets.filter((other) => other.inventory === inventory),
    },
    null,
    2,
  );
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  try {
    console.log(main(process.argv.slice(2)));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
