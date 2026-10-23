import { resourceEntrypoint } from "../../../scripts/resource-command.mts";
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  lstatSync,
  existsSync,
  realpathSync,
} from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { resolvePhysicalPath, spawnCommand } from "../../../scripts/dev-storage.mts";
import { vitePlusCommand } from "../../../scripts/viteplus-cli.mts";
import { inspectProbeTrace, verifyProbeResult } from "./browser-trace-probe.mts";
import { createCiMetrics } from "../../../scripts/ci-metrics.mts";

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
  const metrics = createCiMetrics();
  const cachedFiles = new Set(
    existsSync(browserCache)
      ? readdirSync(browserCache, { recursive: true, withFileTypes: true })
          .filter((file) => file.isFile())
          .map((file) => path.join(file.parentPath, file.name))
      : [],
  );
  const started = performance.now();
  const result = metrics.measure("browser-install", () =>
    spawnCommand(
      process.execPath,
      [
        path.join(desktop, "node_modules", "playwright", "cli.js"),
        "install",
        "--only-shell",
        "chromium",
      ],
      { cwd: desktop, env: process.env, stdio: "inherit", windowsHide: true },
    ),
  );
  if (result.status !== 0) process.exit(result.status ?? 1);
  const installed = performance.now();
  const browser = await metrics.measureAsync("browser-readiness", () =>
    chromium.launch({ headless: true, args: ["--enable-automation"] }),
  );
  try {
    // executablePath() advertises full Chromium even after --only-shell. Ask
    // the launched pinned engine for the actual executable rather than calling
    // an absent full-browser path a cache miss.
    const session = await browser.newBrowserCDPSession();
    let actualExecutable: string;
    try {
      const command = await session.send("Browser.getBrowserCommandLine");
      actualExecutable = command.arguments[0] ?? "";
      const relative = path.relative(physicalCache, realpathSync(actualExecutable));
      if (
        !path.isAbsolute(actualExecutable) ||
        path.isAbsolute(relative) ||
        relative === ".." ||
        relative.startsWith(`..${path.sep}`)
      )
        throw new Error("Launched Chromium executable is outside the browser cache");
    } finally {
      await session.detach();
    }
    const cachePresent = cachedFiles.has(actualExecutable);
    console.log(`Browser ready: Chromium headless ${browser.version()} in ${browserCache}`);
    console.log(
      `Browser bootstrap observation: ${JSON.stringify({
        cache_present_before: cachePresent,
        version: browser.version(),
        executable: actualExecutable,
        install_ms: Math.round(installed - started),
        readiness_ms: Math.round(performance.now() - installed),
      })}`,
    );
    metrics.record("browser-cache", {
      cache_outcome: cachePresent ? "present-before-install" : "absent-before-install",
      fingerprint: `${browser.version()}:${actualExecutable}`,
    });
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
  const cli = vitePlusCommand(root);
  const result = spawnCommand(
    cli.command,
    [
      ...cli.args,
      "test",
      "--config",
      path.join(root, "vite.config.ts"),
      "--project",
      "browser",
      `--outputFile.json=${reportFile}`,
      "src/browser/failure-probe.browser.test.tsx",
    ],
    { cwd: desktop, env: process.env, stdio: "inherit", windowsHide: true },
  );
  if (result.error || result.signal)
    throw new Error("Browser probe runner failed", { cause: result.error });
  if (lstatSync(reportFile).size > 1024 * 1024)
    throw new Error("Browser probe report is oversized");
  const files = readdirSync(traceRun, { recursive: true, withFileTypes: true });
  const outcomes = files.filter((file) => file.isFile() && file.name === "run-outcome.json");
  if (outcomes.length !== 1) throw new Error("Browser probe has no unique runner outcome");
  const outcome = outcomes[0]!;
  const outcomeFile = path.join(outcome.parentPath, outcome.name);
  if (lstatSync(outcomeFile).size > 1024) throw new Error("Browser probe outcome is oversized");
  verifyProbeResult(
    result.status,
    JSON.parse(readFileSync(reportFile, "utf8")),
    JSON.parse(readFileSync(outcomeFile, "utf8")),
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
  const traceFile = path.join(trace.parentPath, trace.name);
  if (lstatSync(traceFile).size > 16 * 1024 * 1024)
    throw new Error("Browser probe trace is oversized");
  const inspection = inspectProbeTrace(readFileSync(traceFile));
  const screenshot = screenshots[0]!;
  const screenshotFile = path.join(screenshot.parentPath, screenshot.name);
  if (lstatSync(screenshotFile).size > 16 * 1024 * 1024)
    throw new Error("Browser probe screenshot is oversized");
  const png = readFileSync(screenshotFile);
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
}

async function runBrowserRuntime() {
  if (process.argv[2] === "bootstrap") await bootstrapChromium();
  else if (process.argv[2] === "probe") await probeBrowserTrace();
  else throw new Error("Usage: browser-runtime.mts bootstrap|probe");
  return Number(process.exitCode ?? 0);
}

process.exitCode = await resourceEntrypoint("browser", runBrowserRuntime);
