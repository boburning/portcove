import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { resolvePhysicalPath, spawnCommand } from "../../../scripts/dev-storage.mjs";

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

if (process.argv[2] === "bootstrap") {
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
} else if (process.argv[2] === "probe") {
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
  const result = spawnCommand(
    process.execPath,
    [
      path.join(root, "node_modules", "vite-plus", "bin", "vp"),
      "test",
      "--config",
      path.join(root, "vite.config.ts"),
      "--project",
      "browser",
      "src/browser/failure-probe.browser.test.tsx",
    ],
    { cwd: desktop, env: process.env, stdio: "inherit", windowsHide: true },
  );
  if (result.status === 0) rmSync(traceRun, { recursive: true });
  process.exit(result.status ?? 1);
} else {
  throw new Error("Usage: browser-runtime.mjs bootstrap|probe");
}
