import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import path from "node:path";
import { fileURLToPath } from "node:url";

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
  plugins: [
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
  ],
  clearScreen: false,
  resolve: { alias: { "@": path.resolve(desktopRoot, "src") } },
  server: { strictPort: true },
  envPrefix: ["VITE_", "TAURI_"],
  build: { target: ["es2021", "chrome105", "safari13"], sourcemap: true },
});
