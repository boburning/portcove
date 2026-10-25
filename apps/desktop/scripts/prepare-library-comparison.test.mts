import { mkdtemp, mkdir, readFile, writeFile, lstat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { expect, it } from "vite-plus/test";
import { prepareLibraryComparison } from "./prepare-library-comparison.mts";
import { comparisonEntries } from "../src/dev-scenarios/interactive/comparison-scene.ts";

it("creates an isolated matched scene without changing its input or overwriting previous evidence", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "portcove-comparison-"));
  const source = path.join(root, "reference");
  const output = path.join(root, "comparison");
  await mkdir(path.join(source, "assets"), { recursive: true });
  const app =
    "import {games,stress,largeCollection} from './fixtures.js';\nconst entries=()=>state.scenario==='stress'?stress:state.scenario==='large'?largeCollection:games;\nconst session=createSession([...games,...stress,...largeCollection]);\n";
  await writeFile(path.join(source, "app.js"), app);
  for (const name of ["app.html", "fixtures.js", "operation-fixtures.js", "style.css", "start.mjs"])
    await writeFile(path.join(source, name), "reference input");
  await prepareLibraryComparison(source, output);
  expect(await readFile(path.join(source, "app.js"), "utf8")).toBe(app);
  const generated = await readFile(path.join(output, "comparison-fixtures.js"), "utf8");
  const entries = JSON.parse(
    generated
      .slice(generated.indexOf("export const comparison=") + "export const comparison=".length)
      .trim()
      .replace(/;$/u, ""),
  ) as { id: string; artSrc?: string }[];
  expect(entries.map((entry) => entry.id)).toEqual(comparisonEntries.map((entry) => entry.id));
  for (const [index, entry] of entries.entries())
    expect(entry.artSrc).toBe(
      comparisonEntries[index]?.artwork
        ? "data:image/png;base64," + comparisonEntries[index].artwork.png
        : undefined,
    );
  const manifest = JSON.parse(await readFile(path.join(output, "COMPARISON.json"), "utf8")) as {
    referenceAppSha256: string;
    productionSource: { revision: string };
  };
  expect(manifest.referenceAppSha256).toBe(createHash("sha256").update(app).digest("hex"));
  expect(manifest.productionSource.revision).toMatch(/^[a-f0-9]{40}$/u);
  await expect(prepareLibraryComparison(source, output)).rejects.toThrow("already exists");
  await expect(prepareLibraryComparison(source, path.join(source, "nested"))).rejects.toThrow(
    "separate",
  );
  await writeFile(path.join(source, "app.js"), "changed reference");
  const refused = path.join(root, "refused");
  await expect(prepareLibraryComparison(source, refused)).rejects.toThrow("reference changed");
  await expect(lstat(refused)).rejects.toMatchObject({ code: "ENOENT" });
}, 30_000);
