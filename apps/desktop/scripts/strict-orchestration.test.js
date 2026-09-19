import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const desktop = fileURLToPath(new URL("../", import.meta.url));
const readJson = (name) => JSON.parse(readFileSync(path.join(desktop, name), "utf8"));

describe("selected strict orchestration", () => {
  it("keeps the stricter options and bounded production inventory in the required typecheck", () => {
    const config = readJson("tsconfig.orchestration.json");
    const manifest = readJson("package.json");

    expect(config).toMatchObject({
      extends: "./tsconfig.json",
      compilerOptions: {
        exactOptionalPropertyTypes: true,
        noUncheckedIndexedAccess: true,
      },
      include: [],
      references: [],
    });
    expect(config.files).toEqual([
      "src/gamepad.ts",
      "src/keyboard-shortcuts.ts",
      "src/native-source-drop.ts",
      "src/operation-state.ts",
      "src/shared/concurrency-state.ts",
      "src/shared/subscription-lifecycle.ts",
      "src/view-model.ts",
    ]);
    expect(manifest.scripts.typecheck).toBe("tsc && pnpm typecheck:orchestration");
    expect(manifest.scripts["typecheck:orchestration"]).toBe(
      "tsc --project tsconfig.orchestration.json",
    );
  });
});
