import { playwright } from "@vitest/browser-playwright";
import { mergeConfig } from "vite";
import { defineConfig } from "vitest/config";
import viteConfig from "./vite.config.ts";

const traceDirectory = process.env.PORTCOVE_BROWSER_TRACE_DIR;
if (!traceDirectory) throw new Error("Run Browser Mode through pnpm test:browser");

export default mergeConfig(
  viteConfig,
  defineConfig({
    test: {
      include: ["src/browser/**/*.browser.test.tsx"],
      fileParallelism: false,
      retry: 0,
      testTimeout: 10_000,
      browser: {
        enabled: true,
        headless: true,
        provider: playwright(),
        instances: [{ browser: "chromium" }],
        trace: { mode: "retain-on-failure", tracesDir: traceDirectory },
        screenshotFailures: true,
      },
    },
  }),
);
