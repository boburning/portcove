import { isRecord } from "./runtime-values.mts";
import { execFileSync } from "node:child_process";
import { constants } from "node:fs";
import { appendFile, open, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { observationHash } from "./upstream-observer.mts";
import { collectRepositoryHealth } from "./check-catalog-repositories.mts";
import { parseRawDiff } from "./select-ci-plan.mts";
import { healthCatalogInputs, healthLineageInputs } from "./upstream-health-inputs.mts";
import { assertOwnedUnlinkedPath } from "./release-path-safety.mts";

const root = fileURLToPath(new URL("../", import.meta.url));
const catalogPath = "crates/portcove-core/catalog/catalog.json";
const sharedHealthInputs = new Set([
  "scripts/check-catalog-repositories.mts",
  "scripts/check-retcomm-upstreams.mts",
  "scripts/retcomm-psx-upstreams.json",
  "scripts/upstream-health-plan.mts",
  "scripts/upstream-health-inputs.mts",
  "scripts/upstream-health-monitor.mts",
  "scripts/upstream-observer.mts",
  "scripts/upstream-lineage.mts",
  "scripts/release-path-safety.mts",
  "scripts/json-values.mts",
  "scripts/runtime-values.mts",
  "scripts/select-ci-plan.mts",
  ".github/upstream-health-accounting.json",
  ".github/workflows/upstream-health.yml",
  ".node-version",
]);
const sha = /^[a-f0-9]{40}$/u;

type SelectionPort = Record<string, unknown> & { id: string };
type SelectionCatalog = Record<string, unknown> & { ports: SelectionPort[] };
interface LineageComparison {
  base: unknown[];
  head: unknown[];
}
export type HealthScope = { reason: string; port_ids: string[] } & (
  | { mode: "full"; retcomm_port_ids: null }
  | { mode: "affected" | "none"; retcomm_port_ids: string[] }
);
function assertSelectionCatalog(value: unknown): asserts value is SelectionCatalog {
  if (
    !isRecord(value) ||
    !Array.isArray(value.ports) ||
    !value.ports.every((port: unknown) => isRecord(port) && typeof port.id === "string")
  )
    throw new Error("Selection requires catalog port identities");
}
export async function selectUpstreamHealthScope(
  base: unknown,
  head: unknown,
  changes: unknown,
  lineage?: LineageComparison,
): Promise<HealthScope> {
  // Validate both complete inventories without performing any requests.
  for (const catalog of [base, head])
    await collectRepositoryHealth(catalog, {
      portIds: [],
      fetch: () => {
        throw new Error("Selection must not request");
      },
    });
  assertSelectionCatalog(base);
  assertSelectionCatalog(head);
  const baseIds = new Set(base.ports.map((port) => port.id));
  const headIds = new Set(head.ports.map((port) => port.id));
  const full = (reason: string): HealthScope => ({
    mode: "full",
    reason,
    port_ids: head.ports.map((port) => port.id),
    retcomm_port_ids: null,
  });
  if (!Array.isArray(changes)) return full("uncertain Git diff");
  const authored = new Map<string, "A" | "M">();
  for (const change of changes) {
    if (
      !isRecord(change) ||
      !["A", "M", "D", "R", "C"].includes(String(change.status)) ||
      !safePath(change.oldPath) ||
      !safePath(change.newPath)
    )
      return full("nonregular or uncertain Git change");
    const oldRegular = ["100644", "100755"].includes(String(change.oldMode));
    const newRegular = ["100644", "100755"].includes(String(change.newMode));
    const samePath = change.oldPath === change.newPath;
    const regular =
      change.status === "A"
        ? change.oldMode === "000000" && newRegular && samePath
        : change.status === "D"
          ? oldRegular && change.newMode === "000000" && samePath
          : oldRegular && newRegular && (change.status === "M" ? samePath : !samePath);
    if (!regular) return full("nonregular or uncertain Git change");
    if (sharedHealthInputs.has(change.oldPath) || sharedHealthInputs.has(change.newPath))
      return full("shared health tool, workflow or policy changed");
    const oldId = authoringPortId(change.oldPath);
    const newId = authoringPortId(change.newPath);
    for (const filename of [change.oldPath, change.newPath])
      if (authoringJson.test(filename) && !authoringPortId(filename))
        return full("uncertain lineage authoring identity");
    if (oldId || newId) {
      // The authoring catalog also contains listing-only entries. Their lineage
      // is outside this runtime collector; integration changes are already part
      // of the generated catalog comparison below.
      if (!(oldId && baseIds.has(oldId)) && !(newId && headIds.has(newId))) continue;
      if (!newId || (change.status !== "A" && change.status !== "M"))
        return full("removed or renamed lineage authoring requires complete monitoring");
      if (authored.has(newId)) return full("duplicate lineage authoring change");
      authored.set(newId, change.status);
    }
  }
  const baseInputs = healthCatalogInputs(base);
  const headInputs = healthCatalogInputs(head);
  if (
    baseInputs.schema_version !== headInputs.schema_version ||
    observationHash(baseInputs.unassigned_qualification) !==
      observationHash(headInputs.unassigned_qualification)
  )
    return full("catalog schema or unassigned historical evidence changed");
  const old = new Map(baseInputs.ports.map((entry) => [entry.port.id, entry]));
  if (base.ports.some((port) => !head.ports.some((candidate) => candidate.id === port.id)))
    return full("port removal retains complete monitoring");
  const changedLineage = new Set<string>();
  if (authored.size) {
    if (!lineage) return full("changed authoring requires exact lineage comparison");
    const before = lineageMap(lineage.base, base);
    const after = lineageMap(lineage.head, head);
    for (const [id, status] of authored) {
      if (!after.has(id) || (status === "M" && baseIds.has(id) && !before.has(id)))
        throw new Error("Missing exact lineage authoring comparison");
      if (observationHash(before.get(id) ?? null) !== observationHash(after.get(id)))
        changedLineage.add(id);
    }
  }
  const selected = headInputs.ports.filter(
    (entry) =>
      !old.has(entry.port.id) ||
      observationHash(old.get(entry.port.id)) !== observationHash(entry) ||
      changedLineage.has(entry.port.id),
  );
  if (!changes.length && selected.length)
    return full("catalog changed without a matching Git diff");
  return {
    mode: selected.length ? "affected" : "none",
    reason: selected.length
      ? "changed upstream health inputs"
      : "no changed upstream health inputs; global health unassessed",
    port_ids: selected.map((entry) => entry.port.id),
    retcomm_port_ids: selected
      .filter((entry) => entry.port.adapter === "psx-recomp-managed")
      .map((entry) => entry.port.id),
  };
}

const authoringJson = /^crates\/portcove-core\/catalog\/ports\/[^/]+\.json$/u;
const maximumAuthoringFiles = 4096;
function authoringPortId(filename: string): string | undefined {
  return /^crates\/portcove-core\/catalog\/ports\/([a-z0-9]+(?:-[a-z0-9]+)*)\.json$/u.exec(
    filename,
  )?.[1];
}
function lineageMap(records: unknown[], catalog: SelectionCatalog) {
  if (!Array.isArray(records) || records.length > maximumAuthoringFiles)
    throw new Error("Invalid lineage authoring comparison inventory");
  const ports = new Map(catalog.ports.map((port) => [port.id, port]));
  const result = new Map<string, ReturnType<typeof healthLineageInputs>>();
  for (const record of records) {
    const id = isRecord(record) && isRecord(record.listing) ? record.listing.id : null;
    if (typeof id !== "string" || !ports.has(id)) continue;
    const inputs = healthLineageInputs(record);
    const port = ports.get(inputs.listing.id);
    if (!port || result.has(inputs.listing.id) || port.project_url !== inputs.listing.project_url)
      throw new Error("Lineage authoring comparison differs from its catalog identity");
    result.set(inputs.listing.id, inputs);
  }
  return result;
}

const maximumAuthoringBytes = 1024 * 1024;
async function readWorkingAuthoring(relativePath: string): Promise<string> {
  const filename = await assertOwnedUnlinkedPath(
    root,
    path.join(root, relativePath),
    "health lineage readback",
  );
  const handle = await open(
    filename,
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
  );
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size > maximumAuthoringBytes)
      throw new Error("Unbounded health lineage authoring readback");
    const buffer = Buffer.alloc(maximumAuthoringBytes + 1);
    let size = 0;
    while (size < buffer.length) {
      const result = await handle.read(buffer, size, buffer.length - size, null);
      if (!result.bytesRead) break;
      size += result.bytesRead;
    }
    if (size > maximumAuthoringBytes)
      throw new Error("Unbounded health lineage authoring readback");
    return new TextDecoder("utf-8", { fatal: true }).decode(buffer.subarray(0, size));
  } finally {
    await handle.close();
  }
}

function safePath(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    !value.startsWith("/") &&
    !value.includes("\\") &&
    !value.includes("\0") &&
    !value.split("/").includes("..")
  );
}
interface DiscoveryContext {
  event?: string | undefined;
  baseSha?: string | undefined;
  headSha?: string | undefined;
  checkoutSha?: string | undefined;
}
export async function discoverUpstreamHealthScope(
  { event, baseSha, headSha, checkoutSha }: DiscoveryContext,
  git: (args: string[]) => string | Buffer = (args) =>
    execFileSync("git", args, { cwd: root, maxBuffer: 8 * 1024 * 1024 }),
  readCheckout: () => string | Promise<string> = () =>
    readFile(path.join(root, catalogPath), "utf8"),
  readAuthoring: (relativePath: string) => string | Promise<string> = readWorkingAuthoring,
) {
  const current: unknown = JSON.parse(await readCheckout());
  assertSelectionCatalog(current);
  if (event !== "pull_request")
    return {
      mode: "full" as const,
      reason: "main, scheduled and manual monitoring retain full inventory",
      port_ids: current.ports.map((port) => port.id),
      retcomm_port_ids: null,
    };
  if (
    !baseSha ||
    !headSha ||
    !checkoutSha ||
    ![baseSha, headSha, checkoutSha].every((value) => sha.test(value))
  )
    throw new Error("PR health selection requires exact base, head and checkout SHAs");
  const read = (args: string[]) => String(git(args)).trim();
  for (const value of [baseSha, headSha, checkoutSha])
    if (read(["rev-parse", "--verify", `${value}^{commit}`]) !== value)
      throw new Error("Git identity differs");
  if (read(["rev-parse", "HEAD"]) !== checkoutSha)
    throw new Error("Checked-out HEAD differs from the workflow checkout identity");
  const parentLine = read(["rev-list", "--parents", "-n", "1", checkoutSha]).split(/\s+/u);
  if (parentLine[0] !== checkoutSha || parentLine.some((value) => !sha.test(value)))
    throw new Error("Missing checkout parent identities");
  const parents = parentLine.slice(1);
  let targetSha = baseSha;
  if (checkoutSha !== headSha) {
    if (parents.length !== 2 || parents[1] !== headSha || !parents[0])
      throw new Error("PR merge checkout must bind its target parent and exact PR head");
    targetSha = parents[0];
    if (read(["rev-parse", "--verify", `${targetSha}^{commit}`]) !== targetSha)
      throw new Error("Merge target identity differs");
    // The event's base may have advanced since GitHub produced this merge ref.
    // Its recorded first parent owns the tested target, provided both observed
    // target identities are on the same ancestry rather than unrelated history.
    const targetAncestry = read(["merge-base", "--all", baseSha, targetSha]);
    if (targetAncestry !== baseSha && targetAncestry !== targetSha)
      throw new Error("Merge target differs from the event target ancestry");
  }
  const mergeBase = read(["merge-base", "--all", targetSha, headSha]);
  if (!sha.test(mergeBase)) throw new Error("Missing unique merge base");
  const checkoutTree = read(["rev-parse", `${checkoutSha}^{tree}`]);
  const headTree = read(["rev-parse", `${headSha}^{tree}`]);
  const baseTree = read(["rev-parse", `${baseSha}^{tree}`]);
  const targetTree = read(["rev-parse", `${targetSha}^{tree}`]);
  if (![checkoutTree, headTree, baseTree, targetTree].every((value) => sha.test(value)))
    throw new Error("Missing exact Git tree identities");
  const comparisonBase = checkoutSha === headSha ? mergeBase : targetSha;
  const changes = parseRawDiff(
    git(["diff", "--raw", "-z", "--find-renames", comparisonBase, checkoutSha]),
  );
  const base: unknown = JSON.parse(read(["show", `${comparisonBase}:${catalogPath}`]));
  const head: unknown = JSON.parse(read(["show", `${headSha}:${catalogPath}`]));
  const checkedOut: unknown = JSON.parse(read(["show", `${checkoutSha}:${catalogPath}`]));
  if (observationHash(current) !== observationHash(checkedOut))
    throw new Error("Working catalog differs from the exact checkout commit");
  assertSelectionCatalog(base);
  assertSelectionCatalog(checkedOut);
  const baseIds = new Set(base.ports.map((port) => port.id));
  const checkoutIds = new Set(checkedOut.ports.map((port) => port.id));
  const lineage: LineageComparison = { base: [], head: [] };
  const readRecord = (text: string, expectedId: string) => {
    if (Buffer.byteLength(text) > maximumAuthoringBytes)
      throw new Error("Unbounded health lineage authoring input");
    const value: unknown = JSON.parse(text);
    const inputs = healthLineageInputs(value);
    if (inputs.listing.id !== expectedId)
      throw new Error("Lineage authoring path differs from its port identity");
    return inputs;
  };
  for (const change of changes) {
    const id = authoringPortId(change.newPath);
    // Uncertain, deleted and renamed authoring takes the conservative full path.
    // Do not read nonregular working paths while discovering that applicability.
    if (
      !id ||
      (!baseIds.has(id) && !checkoutIds.has(id)) ||
      !["100644", "100755"].includes(String(change.newMode)) ||
      (change.status !== "A" && change.status !== "M")
    )
      continue;
    if (change.status === "M") {
      if (!["100644", "100755"].includes(String(change.oldMode))) continue;
      if (baseIds.has(id))
        lineage.base.push(readRecord(read(["show", `${comparisonBase}:${change.oldPath}`]), id));
    }
    if (!checkoutIds.has(id)) continue;
    const record = readRecord(read(["show", `${checkoutSha}:${change.newPath}`]), id);
    const working = readRecord(await readAuthoring(change.newPath), id);
    if (observationHash(working) !== observationHash(record))
      throw new Error("Working lineage differs from the exact checkout commit");
    lineage.head.push(record);
  }
  const selection = await selectUpstreamHealthScope(base, checkedOut, changes, lineage);
  return {
    ...selection,
    identities: {
      base: baseSha,
      merge_base: mergeBase,
      head: headSha,
      checkout: checkoutSha,
      actual_target: targetSha,
      comparison_base: comparisonBase,
      checkout_parents: parents,
      base_tree: baseTree,
      target_tree: targetTree,
      head_tree: headTree,
      checkout_tree: checkoutTree,
    },
    base_catalog_sha256: observationHash(base),
    head_catalog_sha256: observationHash(head),
    checkout_catalog_sha256: observationHash(checkedOut),
    base_lineage_sha256: observationHash(lineage.base),
    checkout_lineage_sha256: observationHash(lineage.head),
    changes,
  };
}

async function main() {
  const args = process.argv.slice(2);
  if (args.length) throw new Error("upstream-health-plan accepts only fixed workflow environment");
  const plan = await discoverUpstreamHealthScope({
    event: process.env.GITHUB_EVENT_NAME,
    baseSha: process.env.PR_BASE_SHA,
    headSha: process.env.PR_HEAD_SHA,
    checkoutSha: process.env.GITHUB_SHA,
  });
  console.log(JSON.stringify(plan, null, 2));
  if (process.env.GITHUB_OUTPUT)
    await appendFile(
      process.env.GITHUB_OUTPUT,
      `mode=${plan.mode}\nport_ids=${plan.port_ids.join(",")}\nretcomm_port_ids=${(plan.retcomm_port_ids ?? []).join(",")}\nretcomm=${plan.mode === "full" || plan.retcomm_port_ids.length > 0}\n`,
    );
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  main().catch(() => {
    console.error("Upstream health scope discovery failed; no narrower check is authorized.");
    process.exitCode = 1;
  });
