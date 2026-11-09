import assert from "node:assert/strict";
import test from "node:test";

import {
  classifyCatalogRustEdits,
  isCatalogDataPath,
  isRustTestPath,
  renderCatalogRustEditReport,
} from "./catalog-rust-edit-report.mts";

const port = "crates/portcove-core/catalog/ports/example.json";
const catalog = "crates/portcove-core/catalog/catalog.json";

void test("a data-only catalog change produces no report", () => {
  assert.equal(classifyCatalogRustEdits([port, catalog, "docs/CATALOG.md"]), null);
  assert.equal(renderCatalogRustEditReport(classifyCatalogRustEdits([port, catalog])), null);
});

void test("Rust changes without catalog data produce no report", () => {
  assert.equal(classifyCatalogRustEdits(["crates/portcove-core/src/install.rs"]), null);
});

void test("catalog data with Rust edits separates production from test files", () => {
  const report = classifyCatalogRustEdits([
    port,
    "crates/portcove-core/src/persistence.rs",
    "crates/portcove-core/src/service/user_selected.rs",
    "crates/portcove-core/src/release/tests/unchanged_definition.rs",
    "crates/portcove-core/src/definition_entry_tests.rs",
  ]);
  assert.deepEqual(report, {
    catalogFiles: [port],
    productionRust: [
      "crates/portcove-core/src/persistence.rs",
      "crates/portcove-core/src/service/user_selected.rs",
    ],
    testRust: [
      "crates/portcove-core/src/definition_entry_tests.rs",
      "crates/portcove-core/src/release/tests/unchanged_definition.rs",
    ],
  });
  const message = renderCatalogRustEditReport(report);
  assert.match(
    message ?? "",
    /updates 1 catalog data file and also edits 2 production Rust files:/u,
  );
  assert.match(message ?? "", /; 2 Rust test files:/u);
  assert.match(message ?? "", /`crates\/portcove-core\/src\/persistence\.rs`/u);
});

void test("path classification follows the catalog and test layout", () => {
  assert.equal(isCatalogDataPath("crates/portcove-core/catalog/catalog-shared.json"), false);
  assert.equal(isCatalogDataPath("crates/portcove-core/src/catalog.rs"), false);
  assert.equal(isRustTestPath("crates/portcove-core/src/catalog/tests.rs"), true);
  assert.equal(
    isRustTestPath("crates/portcove-release-tools/tests/tuf_repository/offline.rs"),
    true,
  );
  assert.equal(isRustTestPath("crates/portcove-core/src/catalog.rs"), false);
});

void test("long file lists are bounded", () => {
  const many = Array.from({ length: 25 }, (_, index) => `crates/portcove-core/src/m${index}.rs`);
  const message = renderCatalogRustEditReport(classifyCatalogRustEdits([port, ...many]));
  assert.match(message ?? "", /and 5 more/u);
});
