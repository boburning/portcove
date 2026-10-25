import { resourceEntrypoint } from "../../../scripts/resource-command.mts";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync } from "node:fs";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { resolvePhysicalPath, spawnCommand } from "../../../scripts/dev-storage.mts";
import { createCiMetrics } from "../../../scripts/ci-metrics.mts";
import { isRecord } from "../../../scripts/runtime-values.mts";
import {
  closeProbeRunner,
  createProbeArtifactReader,
  inspectProbeTrace,
  verifyProbeResult,
} from "./browser-trace-probe.mts";
import {
  runScreenshotOnlyProbe,
  screenshotContext,
  screenshotRoutes,
  verifyScreenshotJobs,
  verifyScreenshotPacket,
} from "./browser-screenshot-custody.mts";

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

function headlessShellExecutable() {
  // Pinned Playwright exposes the same registry used by --only-shell and
  // headless launch. BrowserType.executablePath() instead names full Chromium.
  // Registry shape changes produce unknown diagnostics, never a guessed path.
  const bundle: unknown = createRequire(import.meta.resolve("playwright"))(
    "playwright-core/lib/coreBundle",
  );
  const registryModule = isRecord(bundle) ? bundle.registry : null;
  const registry = isRecord(registryModule) ? registryModule.registry : null;
  if (!isRecord(registry) || typeof registry.findExecutable !== "function")
    throw new Error("Unknown pinned browser registry");
  const shell: unknown = Reflect.apply(registry.findExecutable, registry, [
    "chromium-headless-shell",
  ]);
  if (!isRecord(shell) || typeof shell.executablePath !== "function")
    throw new Error("Missing pinned headless shell");
  const shellExecutable: unknown = Reflect.apply(shell.executablePath, shell, []);
  if (typeof shellExecutable !== "string") throw new Error("Missing pinned headless executable");
  return shellExecutable;
}

function recordBrowserCache(metrics: ReturnType<typeof createCiMetrics>) {
  // Presence is an observation before installation, not proof of a usable cache.
  // Diagnostic metadata must never replace the actual installer/readiness result.
  try {
    const manifest = readFileSync(
      new URL("../node_modules/playwright/package.json", import.meta.url),
    );
    const metadata: unknown = JSON.parse(manifest.toString("utf8"));
    const version = isRecord(metadata) ? metadata.version : null;
    const shellExecutable = headlessShellExecutable();
    const shellPresent = existsSync(shellExecutable);
    const physicalShell = shellPresent
      ? realpathSync(shellExecutable)
      : path.join(
          resolvePhysicalPath(path.dirname(shellExecutable)),
          path.basename(shellExecutable),
        );
    const relativeShell = path.relative(physicalCache, physicalShell);
    if (
      path.isAbsolute(relativeShell) ||
      relativeShell === ".." ||
      relativeShell.startsWith(`..${path.sep}`)
    )
      throw new Error("Headless executable outside browser cache");
    metrics.record("browser-bootstrap:cache", {
      cache_outcome: shellPresent ? "executable-present" : "executable-absent",
      fingerprint: createHash("sha256").update(manifest).digest("hex"),
      groups: [
        `playwright=${typeof version === "string" ? version : "unknown"}`,
        `executable=${relativeShell.split(path.sep).join("/")}`,
      ],
    });
  } catch {
    metrics.record("browser-bootstrap:cache", { cache_outcome: "unknown" });
  }
}

async function bootstrapChromium() {
  const metrics = createCiMetrics();
  recordBrowserCache(metrics);
  const result = metrics.measure("browser-bootstrap:install", () =>
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
  const browser = await metrics.measureAsync("browser-bootstrap:launch", () =>
    chromium.launch({ headless: true }),
  );
  try {
    const version = browser.version();
    metrics.record("browser-bootstrap:ready", { groups: [`chromium=${version}`] });
    console.log(`Browser ready: Chromium headless ${version} in ${browserCache}`);
  } finally {
    await metrics.measureAsync("browser-bootstrap:close", () => browser.close());
  }
}

async function runFailureProbe(reportFile: string) {
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
}

function inspectTraceArtifacts(
  artifacts: ReturnType<typeof createProbeArtifactReader>,
  traceRun: string,
  reportFile: string,
) {
  const files = artifacts.list();
  const read = artifacts.read;
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
  return { inspection, png };
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
  const artifacts = createProbeArtifactReader(traceRun);
  const reportFile = path.join(traceRun, "result.json");
  await runFailureProbe(reportFile);
  const { inspection, png } = inspectTraceArtifacts(artifacts, traceRun, reportFile);
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

function verifyScreenshotArtifacts() {
  const context = screenshotContext(process.env);
  const directory = path.resolve(process.argv[3] ?? "");
  const jobs: unknown = JSON.parse(readFileSync(process.argv[4] ?? "", "utf8"));
  verifyScreenshotJobs(jobs, context);
  for (const route of screenshotRoutes) {
    const packet = path.join(
      directory,
      `browser-traces-${route}-${context.run}-${context.attempt}`,
    );
    console.log(JSON.stringify(verifyScreenshotPacket(packet, route, context)));
  }
}

async function runBrowserRuntime() {
  if (process.argv[2] === "bootstrap") await bootstrapChromium();
  else if (process.argv[2] === "probe") await probeBrowserTrace();
  else if (process.argv[2] === "screenshot-only")
    await runScreenshotOnlyProbe(chromium, root, process.argv[3] ?? "", process.env);
  else if (process.argv[2] === "verify-screenshot-only") {
    verifyScreenshotArtifacts();
  } else
    throw new Error(
      "Usage: browser-runtime.mts bootstrap|probe|screenshot-only ROUTE|verify-screenshot-only DIRECTORY JOBS",
    );
  return Number(process.exitCode ?? 0);
}

process.exitCode = await resourceEntrypoint("browser", runBrowserRuntime);
