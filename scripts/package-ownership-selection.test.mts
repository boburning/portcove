import test from "node:test";
import { isRecord } from "./runtime-values.mts";
import assert from "node:assert/strict";
import { needsPackageOwnership } from "./package-ownership-selection.mts";
import { readFileSync } from "node:fs";
void test("frontend dependency patches avoid ownership rehearsal while packaging and uncertainty retain it", () => {
  const before = readFileSync(new URL("../apps/desktop/package.json", import.meta.url), "utf8");
  const after: unknown = JSON.parse(before);
  assert(isRecord(after) && isRecord(after.dependencies) && isRecord(after.scripts));
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

void test("malformed packaging metadata and non-string graph edges conservatively retain ownership rehearsal", () => {
  const inputs = [
    ["apps/desktop/package.json", "null"],
    ["apps/desktop/package.json", '{"dependencies":[]}'],
    ["pnpm-lock.yaml", "lockfileVersion: 9.0\nimporters: []\npackages: {}\nsnapshots: {}\n"],
    [
      "pnpm-lock.yaml",
      'lockfileVersion: 9.0\nimporters: {}\npackages: {"@tauri-apps/cli@1": {}}\nsnapshots: {"@tauri-apps/cli@1": {dependencies: {bad: [1]}}}\n',
    ],
  ] as const;
  for (const [file, malformed] of inputs)
    assert.equal(
      needsPackageOwnership(
        [file],
        () => malformed,
        () => malformed,
      ),
      true,
    );
});

void test("prototype-named dependency closures cannot bypass packaging ownership selection", () => {
  for (const name of ["constructor", "__proto__", "toString"]) {
    const missing = JSON.stringify({
      lockfileVersion: 9,
      importers: {},
      packages: { "@tauri-apps/cli@1": {} },
      snapshots: { "@tauri-apps/cli@1": { dependencies: { bad: name } } },
    });
    assert.equal(
      needsPackageOwnership(
        ["pnpm-lock.yaml"],
        () => missing,
        () => missing,
      ),
      true,
      `missing ${name} closure retains rehearsal`,
    );
    const makeLock = (integrity: string) =>
      JSON.stringify({
        lockfileVersion: 9,
        importers: {},
        packages: { "@tauri-apps/cli@1": {}, [name]: {}, "leaf@1": { resolution: { integrity } } },
        snapshots: {
          "@tauri-apps/cli@1": { dependencies: { bad: name } },
          [name]: { dependencies: { leaf: "1" } },
          "leaf@1": {},
        },
      });
    assert.equal(
      needsPackageOwnership(
        ["pnpm-lock.yaml"],
        () => makeLock("before"),
        () => makeLock("after"),
      ),
      true,
      `changed own ${name} closure retains rehearsal`,
    );
    assert.equal(
      needsPackageOwnership(
        ["pnpm-lock.yaml"],
        () => makeLock("same"),
        () => makeLock("same"),
      ),
      false,
      `identical complete own ${name} closure is understood`,
    );
  }
});
