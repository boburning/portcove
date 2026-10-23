import { resourceEntrypoint } from "../../../scripts/resource-command.mts";
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  lstatSync,
  realpathSync,
} from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { resolvePhysicalPath, spawnCommand } from "../../../scripts/dev-storage.mts";
import { closeProbeRunner, inspectProbeTrace, verifyProbeResult } from "./browser-trace-probe.mts";

const desktop = fileURLToPath(new URL("../", import.meta.url));
const root = path.resolve(desktop, "../..");
const browserCache = path.join(root, "work", "browser-cache");
const physicalCache = resolvePhysicalPath(browserCache);
const physicalRoot = resolvePhysicalPath(root);
const relativeCache = path.relative(physicalRoot, physicalCache);
if (
  path.isAbsolute(relativeCache) ||
  relativeCache === ".." ||
  relativeCache.startsWith(`..${path.sep}`)
)
  throw new Error(`Browser cache resolves outside the checkout: ${physicalCache}`);
process.env.PLAYWRIGHT_BROWSERS_PATH = browserCache;
const { chromium } = await import("playwright");
const executable = chromium.executablePath();
const relativeExecutable = path.relative(browserCache, executable);
if (
  path.isAbsolute(relativeExecutable) ||
  relativeExecutable === ".." ||
  relativeExecutable.startsWith(`..${path.sep}`)
) {
  throw new Error(`Chromium executable is outside the browser cache: ${executable}`);
}

async function bootstrapChromium() {
  const result = spawnCommand(
    process.execPath,
    [
      path.join(desktop, "node_modules", "playwright", "cli.js"),
      "install",
      "--only-shell",
      "chromium",
    ],
    { cwd: desktop, env: process.env, stdio: "inherit", windowsHide: true },
  );
  if (result.status !== 0) process.exit(result.status ?? 1);
  const browser = await chromium.launch({ headless: true });
  try {
    console.log(`Browser ready: Chromium headless ${browser.version()} in ${browserCache}`);
  } finally {
    await browser.close();
  }
}

async function probeBrowserTrace() {
  process.env.VITE_PORTCOVE_BROWSER_TRACE_PROBE = "1";
  let browser;
  try {
    browser = await chromium.launch({ headless: true });
  } catch (error) {
    throw new Error("Chromium is unavailable; run pnpm --dir apps/desktop browser:bootstrap", {
      cause: error,
    });
  } finally {
    await browser?.close();
  }
  const traceRoot = path.join(root, "work", "bt");
  mkdirSync(traceRoot, { recursive: true });
  const traceRun = mkdtempSync(path.join(traceRoot, "run-"));
  if (path.dirname(resolvePhysicalPath(traceRun)) !== resolvePhysicalPath(traceRoot)) {
    throw new Error(`Browser trace run resolves outside the trace root: ${traceRun}`);
  }
  process.env.PORTCOVE_BROWSER_TRACE_DIR = traceRun;
  const reportFile = path.join(traceRun, "result.json");
  const { createVitest } = await import("vite-plus/test/node");
  const runner = await createVitest({
    root,
    config: path.join(root, "vite.config.ts"),
    watch: false,
    run: true,
    outputFile: { json: reportFile },
  });
  try {
    await runner.standalone();
    const probe = path.join(desktop, "src/browser/failure-probe.browser.test.tsx");
    const key = (value: string) => (process.platform === "win32" ? value.toLowerCase() : value);
    const specifications = (await runner.globTestSpecifications()).filter(
      (specification) => key(path.resolve(specification.moduleId)) === key(probe),
    );
    if (specifications.length !== 1) throw new Error("Browser probe has no unique specification");
    await runner.runTestSpecifications(specifications);
  } finally {
    // The pinned runner reports some close failures through exitCode instead
    // of rejecting close(). Keep that result distinct from the expected failure.
    await closeProbeRunner(runner);
  }
  const files = readdirSync(traceRun, { recursive: true, withFileTypes: true });
  const read = (file: string, limit: number) => {
    const stat = lstatSync(file);
    if (!stat.isFile() || stat.size < 1 || stat.size > limit)
      throw new Error("Browser probe artifact is empty, oversized or not a regular file");
    const relative = path.relative(resolvePhysicalPath(traceRun), realpathSync(file));
    if (path.isAbsolute(relative) || relative === ".." || relative.startsWith(`..${path.sep}`))
      throw new Error("Browser probe artifact resolves outside its run");
    const bytes = readFileSync(file);
    if (bytes.length !== stat.size) throw new Error("Browser probe artifact changed during read");
    return bytes;
  };
  const outcomes = files.filter((file) => file.isFile() && file.name === "run-outcome.json");
  if (outcomes.length !== 1) throw new Error("Browser probe has no unique runner outcome");
  const outcome = outcomes[0]!;
  verifyProbeResult(
    Number(process.exitCode ?? 0),
    JSON.parse(read(reportFile, 1024 * 1024).toString("utf8")),
    JSON.parse(read(path.join(outcome.parentPath, outcome.name), 1024).toString("utf8")),
  );
  const traces = files.filter((file) => file.isFile() && file.name.endsWith(".trace.zip"));
  const screenshots = files.filter(
    (file) =>
      file.isFile() &&
      file.name.endsWith(".png") &&
      path.relative(traceRun, file.parentPath).split(path.sep).includes("screenshots"),
  );
  if (traces.length !== 1 || screenshots.length !== 1)
    throw new Error(`Browser probe requires one fresh trace and screenshot: ${traceRun}`);
  const trace = traces[0]!;
  const inspection = inspectProbeTrace(
    read(path.join(trace.parentPath, trace.name), 16 * 1024 * 1024),
  );
  const screenshot = screenshots[0]!;
  const png = read(path.join(screenshot.parentPath, screenshot.name), 16 * 1024 * 1024);
  if (!png.subarray(0, 8).equals(Buffer.from("89504e470d0a1a0a", "hex")))
    throw new Error("Browser probe screenshot is not PNG");
  browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    const dimensions = await page.evaluate(
      async (url) => {
        const image = new globalThis.Image();
        image.src = url;
        await image.decode();
        return { width: image.naturalWidth, height: image.naturalHeight };
      },
      `data:image/png;base64,${png.toString("base64")}`,
    );
    if (dimensions.width < 1 || dimensions.height < 1)
      throw new Error("Empty browser probe screenshot");
    console.log(
      `Browser probe verified: expected failure, ${inspection.events} trace events, ${dimensions.width}x${dimensions.height} PNG; retained ${traceRun}`,
    );
  } finally {
    await browser.close();
  }
  process.exitCode = 0;
}

async function runBrowserRuntime() {
  if (process.argv[2] === "bootstrap") await bootstrapChromium();
  else if (process.argv[2] === "probe") await probeBrowserTrace();
  else throw new Error("Usage: browser-runtime.mts bootstrap|probe");
  return Number(process.exitCode ?? 0);
}

process.exitCode = await resourceEntrypoint("browser", runBrowserRuntime);
