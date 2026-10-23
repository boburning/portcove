import { cp, lstat, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { comparisonEntries } from "../src/dev-scenarios/interactive/comparison-scene.ts";

/** Make a new reference copy; never modify the supplied reference or user assets. */
export async function prepareLibraryComparison(referenceRoot: string, output: string) {
  if (!path.isAbsolute(referenceRoot) || !path.isAbsolute(output))
    throw Error("Use absolute reference and output paths");
  const source = path.resolve(referenceRoot);
  const destination = path.resolve(output);
  if (destination === source || destination.startsWith(source + path.sep))
    throw Error("Output must be separate from the supplied reference");
  const existing = await lstat(destination).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== "ENOENT") throw error;
    return undefined;
  });
  if (existing)
    throw Error("Comparison output already exists; retain it and choose a new directory");
  const app = await readFile(path.join(source, "app.js"), "utf8");
  const importLine = "import {games,stress,largeCollection} from './fixtures.js';";
  const entriesLine =
    "const entries=()=>state.scenario==='stress'?stress:state.scenario==='large'?largeCollection:games;";
  if (app.split(importLine).length !== 2 || app.split(entriesLine).length !== 2)
    throw Error(
      "The reference changed; review its fixture entry points before preparing a comparison",
    );
  const sessionLine = app
    .split(/\r?\n/)
    .find((line) => line.startsWith("const session=createSession("));
  if (
    !sessionLine ||
    !sessionLine.includes("createSession([...games,...stress,...largeCollection])")
  )
    throw Error("The reference task fixture entry point is unavailable");
  // PNG bytes are the same ones the development transport returns. No catalog mapping changes.
  const entries = comparisonEntries.map((entry) => ({
    id: entry.id,
    title: entry.title,
    port: entry.port + (entry.variant ? " · " + entry.variant : ""),
    state: entry.state,
    version: entry.version,
    art: entry.artwork ? "portrait" : "missing",
    artKind: "cover",
    ...(entry.artwork ? { artSrc: "data:image/png;base64," + entry.artwork.png } : {}),
    installation: { kind: "managed", owner: "portcove" },
    capabilities: { play: true, prepare: true, install: true, reference: false },
  }));
  await mkdir(destination, { recursive: true });
  for (const name of [
    "app.html",
    "fixtures.js",
    "operation-fixtures.js",
    "style.css",
    "start.mjs",
    "assets",
  ]) {
    await cp(path.join(source, name), path.join(destination, name), {
      recursive: true,
      errorOnExist: true,
      force: false,
    });
  }
  await writeFile(
    path.join(destination, "app.js"),
    app
      .replace(importLine, importLine + "\nimport {comparison} from './comparison-fixtures.js';")
      .replace(
        entriesLine,
        "const entries=()=>state.scenario==='comparison'?comparison:state.scenario==='stress'?stress:state.scenario==='large'?largeCollection:games;",
      )
      .replace(
        sessionLine,
        sessionLine.replace(
          "createSession([...games,...stress,...largeCollection])",
          "createSession([...games,...stress,...largeCollection,...comparison])",
        ) +
          "\nif(state.scenario==='comparison'){session.operations.clear();session.recoveryId=null;}",
      ),
  );
  await writeFile(
    path.join(destination, "comparison-fixtures.js"),
    "// Generated comparison-only fixtures; all actions simulated.\nexport const comparison=" +
      JSON.stringify(entries) +
      ";\n",
  );
  const manifest = comparisonEntries.map(({ artwork, ...entry }) => ({
    ...entry,
    artwork: artwork
      ? {
          width: artwork.width,
          height: artwork.height,
          sha256: createHash("sha256").update(Buffer.from(artwork.png, "base64")).digest("hex"),
        }
      : null,
  }));
  const repository = fileURLToPath(new URL("../../../", import.meta.url));
  const sourceRevision = execFileSync("git", ["rev-parse", "HEAD"], {
    cwd: repository,
    encoding: "utf8",
  }).trim();
  const workingTreeModified =
    execFileSync("git", ["status", "--porcelain"], { cwd: repository, encoding: "utf8" }).trim()
      .length > 0;
  await writeFile(
    path.join(destination, "COMPARISON.json"),
    JSON.stringify(
      {
        format: 1,
        entries: manifest,
        productionSource: { revision: sourceRevision, workingTreeModified },
        referenceAppSha256: createHash("sha256").update(app).digest("hex"),
        condition:
          "Same data/order/artwork/readiness. Set the same theme, view, text scale and actual frame size before comparing composition. Browser fixtures do not establish native behavior.",
      },
      null,
      2,
    ),
  );
  await writeFile(
    path.join(destination, "index.html"),
    `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Portcove matched Library comparison</title><style>*{box-sizing:border-box}body{margin:0;background:#202226;color:#f5f3ef;font:14px/1.5 system-ui}header{padding:14px 20px}h1{font-size:21px;margin:0 0 8px}p{margin:6px 0;max-width:100ch}a{color:#b9d5ff}.panes{display:grid;grid-template-columns:1fr 1fr;gap:8px}section{min-width:0}h2{font-size:14px;padding:8px 20px;margin:0}iframe{width:100%;height:calc(100vh - 200px);min-height:480px;border:1px solid #808894}@media(max-width:800px){.panes{grid-template-columns:1fr}}</style><header><h1>Matched Library comparison</h1><p>Production source: ${sourceRevision.slice(0, 12)}${workingTreeModified ? " + working changes" : ""}. Prototype source SHA-256 and matching artwork hashes are recorded in the manifest.</p><p>Both sides use the same 12 entries, order, readiness and diagnostic image bytes, including duplicate ports, long identity and real landscape/square inputs. All operations are simulated; real game files are not used.</p><p>Use the same theme and cover/row view. Side-by-side frames have equal available width; open each full-size for ordinary desktop comparisons. Native interface sizing is available only in the desktop host.</p><a href="COMPARISON.json">Inspect shared content and image hashes</a></header><main class="panes"><section><h2><a href="http://127.0.0.1:4182/scenarios.html?mode=interactive&journey=comparison">Production components · full size</a></h2><iframe title="Actual App with matched disposable comparison library" src="http://127.0.0.1:4182/scenarios.html?mode=interactive&journey=comparison&embed=1"></iframe></section><section><h2><a href="app.html?screen=library&scenario=comparison&theme=dark&zoom=100">Corrected prototype · full size</a></h2><iframe title="Prototype with matched comparison library" src="app.html?screen=library&scenario=comparison&theme=dark&zoom=100"></iframe></section></main></html>`,
  );
  await writeFile(
    path.join(destination, "README.txt"),
    "Matched comparison-only reference copy. The supplied reference and ZIP are unchanged.\nRun PORTCOVE_PROTOTYPE_PORT=4184 node start.mjs in this directory, and the actual Desktop dev server on 4182.\nOpen http://127.0.0.1:4184/. Choose the same theme, view and actual viewport for both sides. All file/game operations are simulated.\nRegenerate into a new output directory using apps/desktop/scripts/prepare-library-comparison.mts.\n",
  );
  return { destination, entries: manifest };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [referenceRoot, output] = process.argv.slice(2);
  if (!referenceRoot || !output)
    throw Error(
      "Usage: prepare-library-comparison.mts <absolute-reference-root> <new-absolute-output-directory>",
    );
  console.log(JSON.stringify(await prepareLibraryComparison(referenceRoot, output)));
}
