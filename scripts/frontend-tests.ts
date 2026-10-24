import { configDefaults, type TestProjectConfiguration, type TestUserConfig } from "vite-plus";
import { fileURLToPath } from "node:url";
import process from "node:process";
import { URL } from "node:url";
import { playwright } from "vite-plus/test/browser-playwright";
import { createBrowserTraceRun } from "./browser-traces.ts";
import { createFrontendCaseObservations } from "./frontend-case-observations.ts";

const traceRun = createBrowserTraceRun(
  fileURLToPath(new URL("../", import.meta.url)),
  process.env.PORTCOVE_BROWSER_TRACE_DIR,
  process.env.VITE_PORTCOVE_BROWSER_TRACE_PROBE === "1",
);
export const testReporters = [
  ...configDefaults.reporters,
  traceRun.reporter,
  createFrontendCaseObservations(fileURLToPath(new URL("../", import.meta.url))),
  ...(process.env.VITE_PORTCOVE_BROWSER_TRACE_PROBE === "1" ? ["json" as const] : []),
] satisfies NonNullable<TestUserConfig["reporters"]>;

process.env.PLAYWRIGHT_BROWSERS_PATH ??= fileURLToPath(
  new URL("../work/browser-cache", import.meta.url),
);

// Each project loads the app's plugins from its config; root metadata never instantiates them.
const browserProject = {
  extends: fileURLToPath(new URL("../apps/desktop/vite.config.ts", import.meta.url)),
  root: fileURLToPath(new URL("../apps/desktop", import.meta.url)),
  server: { port: 0, strictPort: false },
  optimizeDeps: {
    include: ["react-dom/client", "axe-core"],
    exclude: ["vitest-browser-react", "vitest-browser-react/pure"],
  },
  test: {
    name: "browser",
    maxWorkers: 2,
    sequence: { groupOrder: 1 },
    setupFiles: ["test/browser-setup.mts"],
    include: ["src/**/*.browser.test.{ts,tsx}"],
    exclude: ["src/browser/forced-colors.browser.test.tsx"],
    browser: {
      enabled: true,
      headless: true,
      // Bounded headroom for cold Windows browser startup on shared storage.
      // This changes connection setup only, not test assertion deadlines.
      connectTimeout: process.platform === "win32" ? 180_000 : 60_000,
      provider: playwright(),
      instances: [{ browser: "chromium" }],
      trace: {
        mode: "retain-on-failure",
        tracesDir: traceRun.directory,
      },
      screenshotFailures: true,
      screenshotDirectory: traceRun.screenshotDirectory,
    },
  },
} satisfies TestProjectConfiguration;

export const desktopProjects = [
  {
    extends: fileURLToPath(new URL("../apps/desktop/vite.config.ts", import.meta.url)),
    root: fileURLToPath(new URL("../apps/desktop", import.meta.url)),
    test: {
      name: "unit",
      include: ["src/**/*.test.{ts,tsx}", "scripts/**/*.test.{ts,mts}"],
      exclude: ["src/browser/**", "src/**/*.browser.test.{ts,tsx}", "scripts/**/*.native.test.mts"],
      maxWorkers: 2,
      sequence: { groupOrder: 0 },
    },
  },
  browserProject,
  {
    ...browserProject,
    test: {
      ...browserProject.test,
      name: "browser-forced-colors",
      include: ["src/browser/forced-colors.browser.test.tsx"],
      exclude: [],
      browser: {
        ...browserProject.test.browser,
        instances: [{ browser: "chromium" }],
        provider: playwright({
          contextOptions: { forcedColors: "active", reducedMotion: "reduce" },
        }),
      },
    },
  },
] satisfies TestProjectConfiguration[];
