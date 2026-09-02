import assert from "node:assert/strict";
import test from "node:test";

import { formatViolations, validateArchitecture } from "./check-rust-architecture.mjs";

function metadata(overrides = {}) {
  const dependencies = {
    "portcove-core": ["serde"],
    "portcove-cli": ["clap", "portcove-core"],
    "portcove-desktop": ["portcove-core", "serde", "tauri"],
    ...overrides,
  };
  return {
    packages: Object.entries(dependencies).map(([name, names]) => ({
      name,
      dependencies: names.map((dependency) => ({ name: dependency })),
    })),
  };
}

test("accepts the intended core and adapter graph", () => {
  assert.deepEqual(validateArchitecture(metadata()), []);
});

test("reports forbidden cross-layer dependencies with actionable context", () => {
  const violations = validateArchitecture(metadata({ "portcove-core": ["serde", "tauri"] }));
  assert.equal(violations.length, 1);
  assert.match(formatViolations(violations), /portcove-core -> tauri/);
  assert.match(formatViolations(violations), /presentation-layer/);
});

test("reports missing required adapter dependencies", () => {
  const violations = validateArchitecture(metadata({ "portcove-cli": ["clap"] }));
  assert.equal(violations.length, 1);
  assert.match(formatViolations(violations), /portcove-cli -\/-> portcove-core/);
});

test("fails closed when a governed workspace package disappears", () => {
  const input = metadata();
  input.packages = input.packages.filter((pkg) => pkg.name !== "portcove-desktop");
  const violations = validateArchitecture(input);
  assert.equal(violations.length, 1);
  assert.match(formatViolations(violations), /was not found/);
});
