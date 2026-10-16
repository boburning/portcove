import test from "node:test";
import assert from "node:assert/strict";
import { needsPackageOwnership } from "./package-ownership-selection.mts";
import { readFileSync } from "node:fs";
test("frontend dependency patches avoid ownership rehearsal while packaging and uncertainty retain it", () => {
  const before = readFileSync(new URL("../apps/desktop/package.json", import.meta.url), "utf8");
  const after = JSON.parse(before);
  after.dependencies.react = "99.0.0";
  assert.equal(
    needsPackageOwnership(
      ["apps/desktop/package.json"],
      () => before,
      () => JSON.stringify(after),
    ),
    false,
  );
  after.scripts.tauri = "changed";
  assert.equal(
    needsPackageOwnership(
      ["apps/desktop/package.json"],
      () => before,
      () => JSON.stringify(after),
    ),
    true,
  );
  const lock = readFileSync(new URL("../pnpm-lock.yaml", import.meta.url), "utf8");
  assert.equal(
    needsPackageOwnership(
      ["pnpm-lock.yaml"],
      () => lock,
      () => lock.replace(/i18next@26\.4\.6/gu, "i18next@26.4.99"),
    ),
    false,
  );
  assert.equal(
    needsPackageOwnership(
      ["pnpm-lock.yaml"],
      () => lock,
      () => lock.replace(/@tauri-apps\/cli@2\.12\.2/gu, "@tauri-apps/cli@99.0.0"),
    ),
    true,
  );
  for (const file of [
    "Cargo.lock",
    "rust-toolchain.toml",
    "scripts/test-linux-package-ownership.sh",
  ])
    assert.equal(
      needsPackageOwnership(
        [file],
        () => "",
        () => "",
      ),
      true,
    );
  assert.equal(
    needsPackageOwnership(
      ["pnpm-lock.yaml"],
      () => lock,
      () => "invalid: [",
    ),
    true,
  );
});
