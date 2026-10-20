import { Resvg } from "@resvg/resvg-js";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { errorCode, errorMessage } from "./runtime-values.mts";
import {
  familyDigest,
  readVectorFamily,
  sha256,
  validateVectorSource,
  verifyVectorFamily,
  vectorFamilyManifest,
  vectorFamilyRoot,
  type VectorDerivative,
} from "./brand-vector-contract.mts";

const root = fileURLToPath(new URL("../", import.meta.url));

async function writeChanged(relative: string, bytes: string | Buffer, check: boolean) {
  const file = path.join(root, relative);
  const content = Buffer.from(bytes);
  let previous: Buffer | undefined;
  try {
    previous = await readFile(file);
  } catch (error) {
    if (errorCode(error) !== "ENOENT") throw error;
  }
  if (previous?.equals(content)) return;
  if (check) throw new Error(`Deterministic brand output differs: ${relative}`);
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, content);
}

export async function exportVectorBrand(check: boolean) {
  const raw: unknown = JSON.parse(await readFile(path.join(root, vectorFamilyManifest), "utf8"));
  const family = readVectorFamily(raw);
  const derivatives: VectorDerivative[] = [];
  for (const master of family.masters) {
    const source = await readFile(path.join(root, master.path));
    if (sha256(source) !== master.sha256)
      throw new Error(`Master changed; review its candidate identity first: ${master.id}`);
    validateVectorSource(source.toString("utf8"), master.viewBox);
    for (const width of master.exportWidths) {
      const options = {
        font: { loadSystemFonts: false, fontFiles: [], fontDirs: [] },
        fitTo: { mode: "width" as const, value: width },
      };
      const renderer = new Resvg(source, options);
      if (renderer.imagesToResolve().length)
        throw new Error("Brand export cannot resolve external images");
      const rendered = renderer.render();
      const png = rendered.asPng();
      const repeated = new Resvg(source, options).render().asPng();
      if (!png.equals(repeated)) throw new Error(`Brand renderer is not repeatable: ${master.id}`);
      let transparentPixels = 0;
      let opaquePixels = 0;
      const opaqueColors = new Set<string>();
      const pixels = rendered.pixels;
      for (let offset = 0; offset < pixels.length; offset += 4) {
        if (pixels[offset + 3] === 0) transparentPixels++;
        if (pixels[offset + 3] === 255) {
          opaquePixels++;
          opaqueColors.add(pixels.subarray(offset, offset + 3).toString("hex"));
        }
      }
      if (!transparentPixels || !opaquePixels)
        throw new Error(`Brand export lacks intended transparent/solid artwork: ${master.id}`);
      if (master.variant.startsWith("ink")) {
        const color = master.variant === "ink" ? "15171c" : "f5f3ee";
        if (opaqueColors.size !== 1 || !opaqueColors.has(color))
          throw new Error(`Single-ink output contains another painted color: ${master.id}`);
      }
      const relative = `${vectorFamilyRoot}/exports/${master.id}-${width}.png`;
      await writeChanged(relative, png, check);
      derivatives.push({
        source: master.id,
        path: relative,
        width: rendered.width,
        height: rendered.height,
        sha256: sha256(png),
        transparentPixels,
        opaquePixels,
      });
    }
  }
  const next = { ...family, candidate_sha256: familyDigest(family.masters), derivatives };
  const manifest = JSON.stringify(next, null, 2) + "\n";
  await writeChanged(vectorFamilyManifest, manifest, check);
  const legacyPath = "apps/desktop/assets/brand/manifest.json";
  const legacy: unknown = JSON.parse(await readFile(path.join(root, legacyPath), "utf8"));
  if (typeof legacy !== "object" || legacy === null || Array.isArray(legacy))
    throw new Error("Historical brand manifest is invalid");
  await writeChanged(
    legacyPath,
    JSON.stringify(
      {
        ...legacy,
        vector_family: {
          path: vectorFamilyManifest,
          sha256: sha256(manifest),
          status: family.status,
        },
      },
      null,
      2,
    ) + "\n",
    check,
  );
  await verifyVectorFamily(root);
  console.log(
    `Verified ${family.masters.length} original vector masters and ${derivatives.length} transparent deterministic exports; ${family.status}, ${next.candidate_sha256}.`,
  );
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  if (args.length > 1 || (args.length === 1 && args[0] !== "--check"))
    throw new Error("usage: node scripts/export-vector-brand.mts [--check]");
  try {
    await exportVectorBrand(args.includes("--check"));
  } catch (error) {
    console.error(errorMessage(error));
    process.exitCode = 1;
  }
}
