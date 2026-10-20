import { readFile, mkdir, mkdtemp, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnCommand } from "./dev-storage.mts";
import {
  canonicalBrandIcns,
  readVectorFamily,
  sha256,
  vectorFamilyManifest,
  vectorFamilyRoot,
  vectorIconFiles,
  vectorIconManifest,
} from "./brand-vector-contract.mts";
import { exportVectorBrand } from "./export-vector-brand.mts";
import { errorCode, isRecord } from "./runtime-values.mts";

const root = fileURLToPath(new URL("../", import.meta.url));
const args = process.argv.slice(2);
if (args.length > 1 || (args.length === 1 && args[0] !== "--check"))
  throw new Error("usage: node scripts/export-vector-brand-icons.mts [--check]");
const check = args.includes("--check");
const family = readVectorFamily(
  JSON.parse(await readFile(path.join(root, vectorFamilyManifest), "utf8")),
);
const source = family.masters.find((master) => master.id === "compact-small-color")!;
const sourceBytes = await readFile(path.join(root, source.path));
if (sha256(sourceBytes) !== source.sha256)
  throw new Error("Icon source changed before reviewed export");
const cliPackage: unknown = JSON.parse(
  await readFile(path.join(root, "apps/desktop/node_modules/@tauri-apps/cli/package.json"), "utf8"),
);
const desktopPackage: unknown = JSON.parse(
  await readFile(path.join(root, "apps/desktop/package.json"), "utf8"),
);
if (
  !isRecord(cliPackage) ||
  typeof cliPackage.version !== "string" ||
  !isRecord(desktopPackage) ||
  !isRecord(desktopPackage.devDependencies) ||
  cliPackage.version !== desktopPackage.devDependencies["@tauri-apps/cli"]
)
  throw new Error("Use the repository-pinned Tauri CLI");
await mkdir(path.join(root, "work/brand-icons"), { recursive: true });
const evidence = await mkdtemp(path.join(root, "work/brand-icons/export-"));
// Feed a font-independent JS-rendered PNG to Tauri's platform packager. Its SVG
// loader loads system fonts even when the source contains no text.
const { Resvg } = await import("@resvg/resvg-js");
const input = path.join(evidence, "icon-source-1024.png");
await writeFile(
  input,
  new Resvg(sourceBytes, {
    font: { loadSystemFonts: false, fontFiles: [], fontDirs: [] },
    fitTo: { mode: "width", value: 1024 },
  })
    .render()
    .asPng(),
);
const passes = ["first", "repeat"];
for (const pass of passes) {
  const result = spawnCommand(
    process.execPath,
    [
      path.join(root, "apps/desktop/node_modules/@tauri-apps/cli/tauri.js"),
      "icon",
      input,
      "--output",
      path.join(evidence, pass),
    ],
    { cwd: root, encoding: "utf8", timeout: 120_000 },
  );
  await writeFile(
    path.join(evidence, `${pass}.log`),
    `${result.stdout ?? ""}\n${result.stderr ?? ""}`,
  );
  if (result.error || result.status !== 0)
    throw new Error(`Pinned Tauri icon export failed; retained ${evidence}`, {
      cause: result.error,
    });
}
async function output(relative: string, bytes: Buffer) {
  const file = path.join(root, relative);
  let previous: Buffer | undefined;
  try {
    previous = await readFile(file);
  } catch (error) {
    if (errorCode(error) !== "ENOENT") throw error;
  }
  if (previous?.equals(bytes)) return;
  if (check) throw new Error(`Platform brand output differs: ${relative}; retained ${evidence}`);
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, bytes);
}
const outputs = [];
for (const name of vectorIconFiles) {
  const read = async (pass: string) => {
    const bytes = await readFile(path.join(evidence, pass, name));
    return name === "icon.icns" ? canonicalBrandIcns(bytes) : bytes;
  };
  const first = await read("first"),
    repeat = await read("repeat");
  if (!first.equals(repeat))
    throw new Error(`Platform export is not repeatable: ${name}; retained ${evidence}`);
  await output(`${vectorFamilyRoot}/platform-icons/${name}`, first);
  outputs.push({ name, sha256: sha256(first) });
}
const manifest = Buffer.from(
  JSON.stringify(
    {
      schema_version: 1,
      candidate_sha256: family.candidate_sha256,
      source: source.id,
      source_sha256: source.sha256,
      renderer: "@resvg/resvg-js 2.6.2; system fonts disabled; 1024px transparent PNG",
      packager: `@tauri-apps/cli ${cliPackage.version}`,
      icns_order: "canonical known element order; encoded payloads unchanged",
      outputs,
    },
    null,
    2,
  ) + "\n",
);
await output(vectorIconManifest, manifest);
const nextFamily = Buffer.from(
  JSON.stringify(
    { ...family, platform_icons: { path: vectorIconManifest, sha256: sha256(manifest) } },
    null,
    2,
  ) + "\n",
);
await output(vectorFamilyManifest, nextFamily);
await exportVectorBrand(check);
console.log(
  `Verified ${outputs.length} desktop platform icons; raw repeated outputs retained at ${evidence}. No runtime promotion or native platform qualification.`,
);
