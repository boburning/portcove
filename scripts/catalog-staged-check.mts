import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  checkedCurrentCatalog,
  serializeCurrentCatalog,
  reviewCompatibilityFixture,
  assembleCatalogRecords,
  checkedAuthoredPort,
  parseCatalogSource,
} from "./catalog-authoring.mts";
import { errorMessage } from "./runtime-values.mts";

const root = fileURLToPath(new URL("../", import.meta.url));
export const catalogCoherenceInputs = [
  "catalog-current-authoring.json",
  "catalog.json",
  "catalog-schema1-fixture.json",
  "catalog-legacy-additions-fixture.json",
  "catalog-shared.json",
  "listings.json",
].map((name) => `crates/portcove-core/catalog/${name}`);
export const catalogPortSourcePrefix = "crates/portcove-core/catalog/ports/";

export function checkStagedCatalog(cwd = root) {
  const git = (...args: string[]) => {
    const result = spawnSync("git", args, {
      cwd,
      encoding: "utf8",
      windowsHide: true,
      maxBuffer: 8 * 1024 * 1024,
    });
    if (result.error) throw result.error;
    if (result.status !== 0) throw new Error("Cannot read indexed catalog inputs");
    return result.stdout;
  };
  const changed = git("diff", "--cached", "--name-only", "--no-renames", "-z").split("\0");
  if (
    !changed.some(
      (file) => catalogCoherenceInputs.includes(file) || file.startsWith(catalogPortSourcePrefix),
    )
  )
    return { checked: false };
  if (git("ls-files", "--unmerged", "-z")) throw new Error("Cannot inspect an unmerged index");
  const snapshot = () =>
    git("ls-files", "--stage", "-z", "--", ...catalogCoherenceInputs, catalogPortSourcePrefix);
  const before = snapshot();
  const blobs = new Map<string, string>();
  for (const entry of before.split("\0").filter(Boolean)) {
    const match = /^(100644|100755) ([a-f0-9]{40,64}) 0\t(.+)$/u.exec(entry);
    if (!match || !match[2] || !match[3] || blobs.has(match[3]))
      throw new Error("Catalog index requires unique regular stage-zero inputs");
    blobs.set(match[3], match[2]);
  }
  // One process for the complete indexed snapshot. Per-record spawning would
  // make the authoring split increasingly expensive as the directory grows.
  const objects = [...new Set(blobs.values())];
  const batch = spawnSync("git", ["cat-file", "--batch"], {
    cwd,
    input: `${objects.join("\n")}\n`,
    windowsHide: true,
    maxBuffer: 32 * 1024 * 1024,
  });
  if (batch.error) throw batch.error;
  if (batch.status !== 0) throw new Error("Cannot read indexed catalog blobs");
  const contents = new Map<string, string>();
  let offset = 0;
  for (const oid of objects) {
    const end = batch.stdout.indexOf(10, offset);
    if (end < offset) throw new Error("Malformed indexed catalog blob header");
    const header = batch.stdout.subarray(offset, end).toString("ascii");
    const match = /^([a-f0-9]{40,64}) blob ([0-9]+)$/u.exec(header);
    const size = Number(match?.[2]);
    if (
      match?.[1] !== oid ||
      !Number.isSafeInteger(size) ||
      size < 0 ||
      end + size + 1 >= batch.stdout.length ||
      batch.stdout[end + size + 1] !== 10
    )
      throw new Error("Malformed indexed catalog blob content");
    contents.set(oid, batch.stdout.subarray(end + 1, end + size + 1).toString("utf8"));
    offset = end + size + 2;
  }
  if (offset !== batch.stdout.length) throw new Error("Unexpected indexed catalog blob output");
  const inputs = catalogCoherenceInputs.map((file) => {
    const blob = blobs.get(file);
    if (!blob) throw new Error("Required indexed catalog input is missing");
    return contents.get(blob);
  });
  const [authoring, embedded, legacy, additions, shared, listings] = inputs;
  if (
    authoring === undefined ||
    embedded === undefined ||
    legacy === undefined ||
    additions === undefined ||
    shared === undefined ||
    listings === undefined
  )
    throw new Error("Incomplete indexed catalog inputs");
  const current = checkedCurrentCatalog(JSON.parse(authoring));
  const records = [...blobs.entries()]
    .filter(([file]) => file.startsWith(catalogPortSourcePrefix))
    .map(([file, blob]) => {
      const name = file.slice(catalogPortSourcePrefix.length);
      if (!/^[a-z0-9-]+\.json$/u.test(name))
        throw new Error("Indexed catalog port source requires one JSON file per stable ID");
      const content = contents.get(blob);
      if (content === undefined) throw new Error("Required indexed port blob is missing");
      return checkedAuthoredPort(parseCatalogSource(content), name.slice(0, -5));
    });
  const assembled = assembleCatalogRecords(parseCatalogSource(shared), records);
  if (serializeCurrentCatalog(assembled.catalog) !== authoring)
    throw new Error(
      "Indexed authoring projection is stale; generate and stage matching source records",
    );
  if (`${JSON.stringify(assembled.directory, null, 2)}\n` !== listings)
    throw new Error(
      "Indexed listing projection is stale; generate and stage matching listing bytes",
    );
  if (serializeCurrentCatalog(current) !== embedded)
    throw new Error("Indexed embedded catalog is stale; generate and stage matching catalog bytes");
  const compatibility = reviewCompatibilityFixture(
    current,
    JSON.parse(legacy),
    Buffer.from(additions),
  );
  if (compatibility.status !== "matched")
    throw new Error("Indexed compatibility fixture requires independent review");
  if (snapshot() !== before) throw new Error("Indexed catalog changed during coherence check");
  return { checked: true };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    if (process.argv.slice(2).join(" ") !== "--staged")
      throw new Error("usage: catalog-staged-check.mts --staged");
    if (checkStagedCatalog().checked) console.log("Indexed catalog coherence: matched");
  } catch (error) {
    console.error(errorMessage(error));
    process.exitCode = 1;
  }
}
