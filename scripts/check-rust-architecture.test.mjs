import assert from "node:assert/strict";
import test from "node:test";

import { formatViolations, validateArchitecture } from "./check-rust-architecture.mjs";

function metadata(overrides = {}) {
  const dependencies = {
    "portcove-core": ["serde"],
    "portcove-cli": ["clap", "portcove-core"],
    "portcove-desktop": ["portcove-core", "serde", "tauri"],
    "portcove-release-tools": ["minisign-verify"],
    ...overrides,
  };
  return {
    packages: Object.entries(dependencies).map(([name, names]) => ({
      id: name,
      name,
      dependencies: names.map((dependency) => ({ name: dependency })),
    })),
    workspace_default_members: ["portcove-core", "portcove-cli"],
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

test("keeps catalog signature authority out of presentation adapters", () => {
  const violations = validateArchitecture(metadata({
    "portcove-cli": ["clap", "portcove-core", "ed25519-dalek"],
    "portcove-desktop": ["portcove-core", "tauri", "ed25519-dalek"],
  }));
  assert.equal(violations.length, 2);
  assert.ok(violations.every(item => item.dependencyName === "ed25519-dalek"));
});

test("keeps default Cargo builds independent of the desktop package", () => {
  const input = metadata();
  input.workspace_default_members.push("portcove-desktop");
  const violations = validateArchitecture(input);
  assert.equal(violations.length, 1);
  assert.match(formatViolations(violations), /default Rust build stays independent/);
});

test("isolates offline release verification from player and library authority", () => {
  const violations = validateArchitecture(metadata({
    "portcove-release-tools": ["portcove-core", "tauri"],
    "portcove-desktop": ["portcove-core", "tauri", "portcove-release-tools"],
  }));
  assert.equal(violations.length, 3);
});
