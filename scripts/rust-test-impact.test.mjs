import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import test from "node:test";

import {
  readRustTestImpactMap,
  selectRustTestImpact,
  validateRustTestImpactMap,
  runnableImpactTests,
  runRustImpactUnion,
} from "./rust-test-impact.mjs";

const map = readRustTestImpactMap();
const modified = (path) => ({ status: "M", path });

function inventory(names) {
  return {
    "test-count": names.length,
    "rust-suites": {
      "portcove-core": {
        "package-name": "portcove-core",
        "binary-id": "portcove-core",
        status: "listed",
        testcases: Object.fromEntries(
          names.map((name) => [
            name,
            {
              ignored: false,
              "filter-match": { status: "matches" },
            },
          ]),
        ),
      },
    },
  };
}

test("impact union proves all groups before executing each distinct test once", () => {
  const calls = [];
  const reports = [];
  const inventories = [
    inventory(["a", "shared"]),
    inventory(["b", "shared"]),
    inventory(["a", "b", "shared"]),
  ];
  const status = runRustImpactUnion("portcove-core", ["catalog-contract", "definition-delivery"], {
    map,
    report: (message) => reports.push(message),
    spawnSync(command, args) {
      calls.push([command, ...args]);
      return args[1] === "list"
        ? { status: 0, stdout: JSON.stringify(inventories.shift()) }
        : { status: 7 };
    },
  });
  assert.equal(status, 7);
  assert.deepEqual(
    calls.map((call) => call[2]),
    ["list", "list", "list", "run"],
  );
  assert.equal(calls[2].at(-3), calls[3].at(-1));
  assert.match(reports.join("\n"), /union: 3 distinct runnable tests/u);
});

test("empty groups, incomplete inventories and union drift stop before test execution", () => {
  for (const inventories of [
    [inventory(["a"]), inventory([])],
    [inventory(["a"]), inventory(["b"]), inventory(["a"])],
    [inventory(["a"]), inventory(["b"]), inventory(["a", "unexpected"])],
    [{ ...inventory(["a"]), "test-count": 2 }],
    [{ ...inventory(["a"]), "rust-suites": {} }],
  ]) {
    assert.throws(() =>
      runRustImpactUnion("portcove-core", ["catalog-contract", "definition-delivery"], {
        map,
        report() {},
        spawnSync(_command, args) {
          assert.equal(args[1], "list");
          return { status: 0, stdout: JSON.stringify(inventories.shift()) };
        },
      }),
    );
  }
  const ignored = inventory(["ignored"]);
  ignored["rust-suites"]["portcove-core"].testcases.ignored.ignored = true;
  assert.equal(runnableImpactTests(ignored, "portcove-core").size, 0);
  assert.throws(() => runnableImpactTests(inventory(["a"]), "wrong-package"));
});

test("impact union rejects unknown or repeated group IDs and preserves inventory errors", () => {
  for (const ids of [["unknown", "catalog-contract"], ["catalog-contract", "catalog-contract"], []])
    assert.throws(() =>
      runRustImpactUnion("portcove-core", ids, {
        map,
        spawnSync() {
          assert.fail();
        },
      }),
    );
  for (const result of [
    { status: 1, stderr: "inventory failure" },
    { error: new Error("spawn failed") },
    { status: 0, stdout: "invalid json" },
  ])
    assert.throws(() =>
      runRustImpactUnion("portcove-core", ["catalog-contract", "definition-delivery"], {
        map,
        spawnSync: () => result,
      }),
    );
});

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

test("cross-cutting, manifest, unmapped addition, rename, and deletion changes use the broad fallback", () => {
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

test("an explicitly mapped addition uses its reviewed focused group", () => {
  const selected = selectRustTestImpact(map, "portcove-core", [
    { status: "A", path: "crates/portcove-core/catalog/catalog-current-authoring.json" },
  ]);
  assert.equal(selected.mode, "focused");
  assert.deepEqual(
    selected.groups.map((group) => group.id),
    ["catalog-contract"],
  );
  assert.match(selected.reason, /added or modified Rust path/u);
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
