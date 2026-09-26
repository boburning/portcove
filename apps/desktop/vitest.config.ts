import { mergeConfig } from "vite";
import { configDefaults, defineConfig } from "vitest/config";
import viteConfig from "./vite.config.ts";

export default mergeConfig(
  viteConfig,
  defineConfig({ test: { exclude: [...configDefaults.exclude, "src/browser/**"] } }),
);
