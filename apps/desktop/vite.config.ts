import { defineConfig, lazyPlugins, type PluginOption } from "vite-plus";
import { productionCssFailures } from "./scripts/production-css.mjs";

export function assertScenarioExclusion(
  moduleIds: Iterable<string>,
  fileNames: Iterable<string>,
  allowCompatibilityFixture = false,
) {
  for (const id of moduleIds) {
    const normalized = id.replaceAll("\\", "/").replace(/\?[\s\S]*$/u, "");
    if (
      normalized.includes("/src/dev-scenarios/") ||
      normalized.includes("/src/browser/") ||
      /\/src\/.*\.test\.[cm]?[jt]sx?$/u.test(normalized) ||
      normalized.endsWith("/src/test-fixtures.ts")
    )
      throw new Error(`Development scenario module cannot ship: ${id}`);
    if (!allowCompatibilityFixture && normalized.includes("/src/design-compatibility/"))
      throw new Error(`Design compatibility fixture cannot ship: ${id}`);
  }
  for (const name of fileNames)
    if (/(^|\/)scenarios\.html$/u.test(name.replaceAll("\\", "/")))
      throw new Error("Development scenario entrypoint cannot ship");
}

// Metadata resolution intentionally omits plugins; ordinary dev/build keeps the
// asynchronous loader. Omit the key rather than claim an undefined plugin list.
const plugins = lazyPlugins(async (): Promise<PluginOption[]> => {
  let allowCompatibilityFixture = false;
  const [{ default: react }, { default: tailwindcss }] = await Promise.all([
    import("@vitejs/plugin-react"),
    import("@tailwindcss/vite"),
  ]);
  return [
    react(),
    tailwindcss({ optimize: false }),
    {
      name: "exclude-development-scenarios",
      apply: "build",
      configResolved(config) {
        allowCompatibilityFixture = config.env.VITE_PORTCOVE_DESIGN_COMPATIBILITY_FIXTURE === "1";
      },
      generateBundle: {
        order: "post",
        handler(_options, bundle) {
          const css = Object.values(bundle)
            .flatMap((output) =>
              output.type === "asset" && output.fileName.endsWith(".css")
                ? [String(output.source)]
                : [],
            )
            .join("\n");
          const failures = productionCssFailures(css);
          if (failures.length)
            this.error(`Current build CSS contract failed: ${failures.join("; ")}`);
          assertScenarioExclusion(
            Object.values(bundle).flatMap((output) =>
              output.type === "chunk" ? Object.keys(output.modules) : [],
            ),
            Object.keys(bundle),
            allowCompatibilityFixture,
          );
        },
      },
    },
  ];
});

export default defineConfig({
  ...(plugins === undefined ? {} : { plugins }),
  clearScreen: false,
  resolve: { tsconfigPaths: true },
  server: {
    host: "127.0.0.1",
    port: 1420,
    strictPort: true,
    watch: { ignored: ["**/src-tauri/**"] },
  },
  // Only explicitly public frontend inputs are exposed. Tauri target/debug
  // variables remain available to native tooling without exposing signing inputs.
  envPrefix: "VITE_",
  css: {
    transformer: "lightningcss",
    devSourcemap: true,
    lightningcss: { targets: { chrome: 111 << 16, safari: (16 << 16) | (4 << 8) } },
  },
  // Transforms match the selected CSS stack; native OS/WebView qualification remains separate.
  build: {
    target: ["chrome111", "safari16.4"],
    cssTarget: ["chrome111", "safari16.4"],
    cssMinify: "lightningcss",
    sourcemap: true,
  },
  run: {
    tasks: {
      "frontend:bundle": {
        command: "vp build",
        cache: {
          input: [{ auto: true }, { pattern: "pnpm-lock.yaml", base: "workspace" }],
          output: ["dist/**"],
        },
      },
    },
  },
});
