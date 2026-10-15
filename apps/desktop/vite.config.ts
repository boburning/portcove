import { defineConfig, lazyPlugins, type PluginOption } from "vite-plus";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { desktopProjects } from "../../vite.config.ts";

const desktopRoot = fileURLToPath(new URL(".", import.meta.url));

export function assertScenarioExclusion(
  moduleIds: Iterable<string>,
  fileNames: Iterable<string>,
  allowCompatibilityFixture = false,
) {
  for (const id of moduleIds) {
    const normalized = id.replaceAll("\\", "/").split("?", 1)[0];
    if (
      normalized.includes("/src/dev-scenarios/") ||
      normalized.includes("/src/browser/") ||
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

export default defineConfig({
  plugins: lazyPlugins(async (): Promise<PluginOption[]> => {
    const [{ default: react }, { default: tailwindcss }] = await Promise.all([
      import("@vitejs/plugin-react"),
      import("@tailwindcss/vite"),
    ]);
    return [
      react(),
      tailwindcss(),
      {
        name: "exclude-development-scenarios",
        apply: "build",
        generateBundle(_options, bundle) {
          assertScenarioExclusion(
            Object.values(bundle).flatMap((output) =>
              output.type === "chunk" ? Object.keys(output.modules) : [],
            ),
            Object.keys(bundle),
            process.env.VITE_PORTCOVE_DESIGN_COMPATIBILITY_FIXTURE === "1",
          );
        },
      },
    ];
  }),
  clearScreen: false,
  resolve: { alias: { "@": path.resolve(desktopRoot, "src") } },
  server: {
    host: "127.0.0.1",
    port: 1420,
    strictPort: true,
    watch: { ignored: ["**/src-tauri/**"] },
  },
  // Only explicitly public frontend inputs are exposed. Tauri target/debug
  // variables remain available to native tooling without exposing signing inputs.
  envPrefix: "VITE_",
  // Transforms match the selected CSS stack; native OS/WebView qualification remains separate.
  build: { target: ["chrome111", "safari16.4"], sourcemap: true },
  test: { projects: desktopProjects },
  run: {
    tasks: {
      "build:cached": {
        command: "vp build",
        cache: {
          input: [{ auto: true }, { pattern: "pnpm-lock.yaml", base: "workspace" }],
          output: ["dist/**"],
        },
      },
      "test:cached": {
        command: "vp test --project unit",
        cache: {
          input: [{ auto: true }, { pattern: "pnpm-lock.yaml", base: "workspace" }],
          output: [],
        },
      },
    },
  },
});
