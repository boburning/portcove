import assert from "node:assert/strict";
import test from "node:test";
import { isRepositoryLintInput } from "./local-validation.mjs";

test("cross-language selection includes Vite+ inputs and actual script consumers", () => {
  for (const file of [
    "vite.config.ts",
    "tsconfig.json",
    "tsconfig.base.json",
    "pnpm-workspace.yaml",
    "scripts/tool.mjs",
    "apps/desktop/src/App.tsx",
    "apps/desktop/vite.config.ts",
  ])
    assert.equal(isRepositoryLintInput(file), true, file);
  for (const file of [
    "docs/QUALITY.md",
    "crates/portcove-core/src/lib.rs",
    "apps/desktop/public/icon.png",
  ])
    assert.equal(isRepositoryLintInput(file), false, file);
});
