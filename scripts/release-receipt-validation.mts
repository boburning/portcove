/** One-time, read-only validation of every release preparation receipt pair.
 *
 * Each complete pair is verified with the full raw-commit check: the prepared
 * commit's sole parent is the original source, both trees match the Git
 * objects, the preparation intent digest is bound by the prepared commit, and
 * the intent names the same version and source as the receipt tags. Every
 * discrepancy is reported; none stops the inventory early. Nothing is written
 * to GitHub. */
import { createHash } from "node:crypto";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";
import { inspectCoordinatorRemoteNamespace } from "./release-coordinator-namespace.mts";
import { peelReleaseReference } from "./release-publication-inventory.mts";
import { isRecord } from "./runtime-values.mts";

type Tag = Record<string, unknown>;
type VerifiedPair = {
  version: string;
  source_commit: string;
  source_tree: string;
  prepared_commit: string;
  prepared_tree: string;
  intent_sha256: string;
};

export interface ReceiptValidationReader {
  namespaceTags(namespace: string): Promise<Tag[]>;
  readAllocations(
    tags: Tag[],
    namespace: string,
  ): Promise<{ allocations: readonly VerifiedPair[] }>;
}

export type ReceiptDiscrepancy = { tags: string[]; reason: string };

const message = (error: unknown) => (error instanceof Error ? error.message : String(error));

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (isRecord(value))
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`)
      .join(",")}}`;
  return JSON.stringify(value);
}

/** Pairs receipt tags without trusting any one of them, then verifies each
 * complete pair against its raw commits. Returns the covered inventory, its
 * digest and every discrepancy. An empty namespace is a complete, explicit
 * result with zero pairs. */
export async function validateReleaseReceipts(namespace: string, reader: ReceiptValidationReader) {
  inspectCoordinatorRemoteNamespace({ schema_version: 1, namespace });
  const versionPrefix = `${namespace}-prepared/`;
  const sourcePrefix = `${namespace}-prepared-source/`;
  // The reader lists both prefixes to provider exhaustion or fails visibly.
  const tags = await reader.namespaceTags(namespace);
  const discrepancies: ReceiptDiscrepancy[] = [];
  const direct = (tag: Tag) => {
    try {
      if (!isRecord(tag.target) || tag.target.__typename !== "Commit")
        throw new Error("receipt does not point directly to a raw commit");
      return peelReleaseReference(tag);
    } catch (error) {
      discrepancies.push({ tags: [String(tag.name)], reason: message(error) });
      return null;
    }
  };
  const versions: { tag: Tag; prepared: string }[] = [];
  const sourcesByPrepared = new Map<string, Tag[]>();
  for (const tag of tags) {
    const name = String(tag.name);
    const prepared = direct(tag);
    if (prepared === null) continue;
    if (name.startsWith(versionPrefix)) versions.push({ tag, prepared });
    else if (name.startsWith(sourcePrefix))
      sourcesByPrepared.set(prepared, [...(sourcesByPrepared.get(prepared) ?? []), tag]);
    else discrepancies.push({ tags: [name], reason: "tag is outside both receipt prefixes" });
  }
  const paired = new Set<string>();
  const verified: VerifiedPair[] = [];
  const versionsByPrepared = new Map<string, number>();
  for (const { prepared } of versions)
    versionsByPrepared.set(prepared, (versionsByPrepared.get(prepared) ?? 0) + 1);
  for (const { tag, prepared } of versions.toSorted((a, b) =>
    String(a.tag.name).localeCompare(String(b.tag.name)),
  )) {
    const sources = sourcesByPrepared.get(prepared) ?? [];
    const name = String(tag.name);
    if (sources.length !== 1 || versionsByPrepared.get(prepared) !== 1) {
      discrepancies.push({
        tags: [name, ...sources.map((source) => String(source.name))],
        reason: "receipt source pair is missing or ambiguous",
      });
      for (const source of sources) paired.add(String(source.name));
      continue;
    }
    const source = sources[0]!;
    paired.add(String(source.name));
    try {
      // The full pre-reduction verification of exactly this one pair.
      const { allocations } = await reader.readAllocations([tag, source], namespace);
      if (allocations.length !== 1) throw new Error("pair verification returned no allocation");
      verified.push(structuredClone(allocations[0]!));
    } catch (error) {
      discrepancies.push({ tags: [name, String(source.name)], reason: message(error) });
    }
  }
  for (const sources of sourcesByPrepared.values())
    for (const source of sources)
      if (!paired.has(String(source.name)))
        discrepancies.push({
          tags: [String(source.name)],
          reason: "source receipt has no version receipt",
        });
  const seenVersions = new Set<string>();
  const seenSources = new Set<string>();
  for (const pair of verified) {
    if (seenVersions.has(pair.version) || seenSources.has(pair.source_commit))
      discrepancies.push({
        tags: [`${versionPrefix}v${pair.version}`, `${sourcePrefix}${pair.source_commit}`],
        reason: "version or source allocated more than once",
      });
    seenVersions.add(pair.version);
    seenSources.add(pair.source_commit);
  }
  const pairs = verified.toSorted((a, b) => a.version.localeCompare(b.version));
  const inventory = {
    schema_version: 1,
    namespace,
    tag_count: tags.length,
    pair_count: pairs.length,
    pairs,
  };
  return {
    ...inventory,
    empty: tags.length === 0,
    inventory_sha256: createHash("sha256").update(canonical(inventory)).digest("hex"),
    discrepancies: discrepancies.toSorted((a, b) =>
      a.tags.join(" ").localeCompare(b.tags.join(" ")),
    ),
  };
}

async function main() {
  const args = process.argv.slice(2);
  const namespace =
    args.length === 0
      ? "portcove-production"
      : args.length === 2 && args[0] === "--namespace"
        ? args[1]!
        : null;
  if (namespace === null)
    throw new Error("usage: release-receipt-validation.mts [--namespace NAMESPACE]");
  const token = process.env.GH_TOKEN ?? process.env.GITHUB_TOKEN;
  if (!token) throw new Error("GH_TOKEN (read access to boburning/portcove) is required");
  const { createPublicationInventoryWithSdk } = await import("./release-publication-inventory.mts");
  const deadline = performance.now() + 15 * 60 * 1000;
  // One-time command: its request budget is sized to the inventory it reads
  // (listing pages plus two raw-commit reads per pair), never a fixed ceiling.
  let granted = 0;
  let allowance = 64;
  const reader = await createPublicationInventoryWithSdk({
    token,
    deadline,
    recheck: async () => {},
    accounting: {
      reserve() {
        if (++granted > allowance) throw new Error("validation request allowance exhausted");
        return { consumeBytes() {}, settle() {} };
      },
      elapsed() {},
      currentDeadline: () => deadline,
    },
  });
  const result = await validateReleaseReceipts(namespace, {
    async namespaceTags(selected) {
      allowance = granted + 4096;
      const tags = await reader.namespaceTags(selected);
      allowance = granted + 2 * tags.length + 8;
      return tags;
    },
    readAllocations: (tags, selected) => reader.readAllocations(tags, selected),
  });
  console.log(JSON.stringify(result, null, 2));
  if (result.empty)
    console.error(
      `No receipt tags exist under ${namespace}-prepared/ or ${namespace}-prepared-source/; ` +
        "the covered inventory is explicitly empty.",
    );
  if (result.discrepancies.length) process.exitCode = 1;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  await main();
