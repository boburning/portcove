import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export function assertScenarioExclusion(moduleIds: Iterable<string>, fileNames: Iterable<string>) {
  for (const id of moduleIds) {
    const normalized = id.replaceAll("\\", "/").split("?", 1)[0];
    if (normalized.includes("/src/dev-scenarios/") || normalized.endsWith("/src/test-fixtures.ts"))
      throw new Error(`Development scenario module cannot ship: ${id}`);
  }
  for (const name of fileNames)
    if (/(^|\/)scenarios\.html$/u.test(name.replaceAll("\\", "/")))
      throw new Error("Development scenario entrypoint cannot ship");
}

export default defineConfig({
  plugins: [
    react(),
    {
      name: "exclude-development-scenarios",
      apply: "build",
      generateBundle(_options, bundle) {
        assertScenarioExclusion(
          Object.values(bundle).flatMap((output) =>
            output.type === "chunk" ? Object.keys(output.modules) : [],
          ),
          Object.keys(bundle),
        );
      },
    },
  ],
  clearScreen: false,
  server: { strictPort: true },
  envPrefix: ["VITE_", "TAURI_"],
  build: { target: ["es2021", "chrome105", "safari13"], sourcemap: true },
});
