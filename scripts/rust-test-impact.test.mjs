import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import test from "node:test";

import {
  readRustTestImpactMap,
  selectRustTestImpact,
  validateRustTestImpactMap,
} from "./rust-test-impact.mjs";

const map = readRustTestImpactMap();
const modified = (path) => ({ status: "M", path });

test("the versioned map owns unique tracked paths and nonempty filters", () => {
  const tracked = new Set(
    execFileSync("git", ["ls-files", "-z"], { cwd: new URL("../", import.meta.url) })
      .toString("utf8")
      .split("\0")
      .filter(Boolean),
  );
  for (const config of Object.values(map.packages))
    for (const group of config.groups) {
      assert.ok(group.filter.length > 0);
      for (const path of group.paths) assert.ok(tracked.has(path), `${path} is not tracked`);
    }
});

test("module-local changes select their owned groups and union mixed impacts", () => {
  const selected = selectRustTestImpact(map, "portcove-core", [
    modified("crates/portcove-core/src/source_report.rs"),
    modified("crates/portcove-core/src/release/observation.rs"),
  ]);
  assert.equal(selected.mode, "focused");
  assert.deepEqual(
    selected.groups.map((group) => group.id),
    ["release-discovery", "source-inspection"],
  );
  assert.match(selected.groups[0].reason, /release discovery/u);
  assert.match(selected.groups[1].reason, /source discovery/u);
});

test("cross-cutting, manifest, addition, rename, and deletion changes use the broad fallback", () => {
  for (const change of [
    modified("crates/portcove-core/src/types.rs"),
    modified("crates/portcove-core/Cargo.toml"),
    { status: "A", path: "crates/portcove-core/src/new_module.rs" },
    {
      status: "R",
      path: "crates/portcove-core/src/source_report.rs",
      previousPath: "crates/portcove-core/src/old_report.rs",
    },
    { status: "D", path: "crates/portcove-core/src/source_report.rs" },
  ]) {
    const selected = selectRustTestImpact(map, "portcove-core", [change]);
    assert.equal(selected.mode, "broad", JSON.stringify(change));
    assert.match(selected.reason, /complete portcove-core test inventory/u);
  }
});

test("one unmapped path makes an otherwise focused mixed change broad", () => {
  const selected = selectRustTestImpact(map, "portcove-core", [
    modified("crates/portcove-core/src/source_report.rs"),
    modified("crates/portcove-core/src/service.rs"),
  ]);
  assert.equal(selected.mode, "broad");
  assert.match(selected.reason, /service\.rs is outside the explicit focused map/u);
});

test("adding explicit ownership turns a representative broad fixture into a focused group", () => {
  const fixture = modified("crates/portcove-core/src/source_report.rs");
  const withoutOwnership = structuredClone(map);
  const sourceGroup = withoutOwnership.packages["portcove-core"].groups.find(
    (group) => group.id === "source-inspection",
  );
  sourceGroup.paths = sourceGroup.paths.filter((path) => path !== fixture.path);
  assert.equal(selectRustTestImpact(withoutOwnership, "portcove-core", [fixture]).mode, "broad");
  assert.equal(selectRustTestImpact(map, "portcove-core", [fixture]).mode, "focused");
});

test("missing package ownership and malformed maps fail closed", () => {
  assert.equal(selectRustTestImpact(null, "portcove-core", [modified("any.rs")]).mode, "broad");
  const selected = selectRustTestImpact(map, "future-package", [modified("future/src/lib.rs")]);
  assert.equal(selected.mode, "broad");
  assert.match(selected.reason, /no focused Rust test-impact contract/u);
  assert.throws(
    () => validateRustTestImpactMap({ schema_version: 2, packages: {} }),
    /unsupported Rust test-impact schema/u,
  );
  assert.throws(
    () =>
      validateRustTestImpactMap({
        schema_version: 1,
        packages: {
          sample: {
            path_prefix: "sample/",
            broad_reason: "fallback",
            groups: [
              { id: "same", reason: "one", filter: "test(one)", paths: ["sample/a.rs"] },
              { id: "same", reason: "two", filter: "test(two)", paths: ["sample/b.rs"] },
            ],
          },
        },
      }),
    /duplicate Rust test-impact group/u,
  );
  assert.throws(
    () =>
      validateRustTestImpactMap({
        schema_version: 1,
        packages: {
          sample: {
            path_prefix: "sample/",
            broad_reason: "fallback",
            groups: [
              {
                id: "first",
                reason: "one",
                filter: "test(one)",
                paths: ["sample/a.rs"],
              },
              {
                id: "second",
                reason: "two",
                filter: "test(two)",
                paths: ["sample/a.rs"],
              },
            ],
          },
        },
      }),
    /duplicate Rust test-impact path/u,
  );
});
