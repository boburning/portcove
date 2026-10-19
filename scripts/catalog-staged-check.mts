import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  checkedCurrentCatalog,
  serializeCurrentCatalog,
  reviewCompatibilityFixture,
} from "./catalog-authoring.mts";
import { errorMessage } from "./runtime-values.mts";

const root = fileURLToPath(new URL("../", import.meta.url));
export const catalogCoherenceInputs = [
  "catalog-current-authoring.json",
  "catalog.json",
  "catalog-schema1-fixture.json",
  "catalog-legacy-additions-fixture.json",
].map((name) => `crates/portcove-core/catalog/${name}`);

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
  if (!changed.some((file) => catalogCoherenceInputs.includes(file))) return { checked: false };
  if (git("ls-files", "--unmerged", "-z")) throw new Error("Cannot inspect an unmerged index");
  const snapshot = () => git("ls-files", "--stage", "-z", "--", ...catalogCoherenceInputs);
  const before = snapshot();
  const blobs = new Map<string, string>();
  for (const entry of before.split("\0").filter(Boolean)) {
    const match = /^(100644|100755) ([a-f0-9]{40,64}) 0\t(.+)$/u.exec(entry);
    if (!match || !match[2] || !match[3] || blobs.has(match[3]))
      throw new Error("Catalog index requires unique regular stage-zero inputs");
    blobs.set(match[3], match[2]);
  }
  const inputs = catalogCoherenceInputs.map((file) => {
    const blob = blobs.get(file);
    if (!blob) throw new Error("Required indexed catalog input is missing");
    return git("cat-file", "blob", blob);
  });
  const [authoring, embedded, legacy, additions] = inputs;
  if (
    authoring === undefined ||
    embedded === undefined ||
    legacy === undefined ||
    additions === undefined
  )
    throw new Error("Incomplete indexed catalog inputs");
  const current = checkedCurrentCatalog(JSON.parse(authoring));
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
