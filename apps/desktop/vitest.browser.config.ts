import { playwright } from "@vitest/browser-playwright";
import { mergeConfig } from "vite";
import { defineConfig } from "vitest/config";
import viteConfig from "./vite.config.ts";

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
        trace: { mode: "retain-on-failure", tracesDir: "../../work/browser-traces" },
        screenshotFailures: true,
      },
    },
  }),
);
