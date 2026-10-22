import assert from "node:assert/strict";
import test from "node:test";

import { formatViolations, validateArchitecture } from "./check-rust-architecture.mts";

function metadata(overrides: Record<string, string[]> = {}) {
  const dependencies = {
    "portcove-core": ["serde"],
    "portcove-diagnostics": ["portcove-core", "tracing-subscriber"],
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

void test("accepts the intended core and adapter graph", () => {
  assert.deepEqual(validateArchitecture(metadata()), []);
});

void test("shared host logging cannot import Desktop or become a Core dependency", () => {
  const violations = validateArchitecture(
    metadata({
      "portcove-core": ["serde", "portcove-diagnostics"],
      "portcove-diagnostics": ["portcove-core", "tauri", "portcove-desktop"],
    }),
  );
  assert.equal(violations.length, 3);
  assert.ok(
    violations.every((item) =>
      ["portcove-core", "portcove-diagnostics"].includes(item.packageName),
    ),
  );
});

void test("reports forbidden cross-layer dependencies with actionable context", () => {
  const violations = validateArchitecture(metadata({ "portcove-core": ["serde", "tauri"] }));
  assert.equal(violations.length, 1);
  assert.match(formatViolations(violations), /portcove-core -> tauri/);
  assert.match(formatViolations(violations), /presentation-layer/);
});

void test("reports missing required adapter dependencies", () => {
  const violations = validateArchitecture(metadata({ "portcove-cli": ["clap"] }));
  assert.equal(violations.length, 1);
  assert.match(formatViolations(violations), /portcove-cli -\/-> portcove-core/);
});

void test("fails closed when a governed workspace package disappears", () => {
  const input = metadata();
  input.packages = input.packages.filter((pkg) => pkg.name !== "portcove-desktop");
  const violations = validateArchitecture(input);
  assert.equal(violations.length, 1);
  assert.match(formatViolations(violations), /was not found/);
});

void test("keeps catalog signature authority out of presentation adapters", () => {
  const violations = validateArchitecture(
    metadata({
      "portcove-cli": ["clap", "portcove-core", "ed25519-dalek"],
      "portcove-desktop": ["portcove-core", "tauri", "ed25519-dalek"],
    }),
  );
  assert.equal(violations.length, 2);
  assert.ok(violations.every((item) => item.dependencyName === "ed25519-dalek"));
});

void test("keeps artwork decoding in core while hosts bridge display and file selection", () => {
  const violations = validateArchitecture(
    metadata({
      "portcove-core": ["serde", "image"],
      "portcove-cli": ["clap", "portcove-core", "image"],
      "portcove-desktop": ["portcove-core", "tauri", "image"],
    }),
  );
  assert.equal(violations.length, 2);
  assert.ok(violations.every((item) => item.dependencyName === "image"));
});

void test("keeps default Cargo builds independent of the desktop package", () => {
  const input = metadata();
  input.workspace_default_members.push("portcove-desktop");
  const violations = validateArchitecture(input);
  assert.equal(violations.length, 1);
  assert.match(formatViolations(violations), /default Rust build stays independent/);
});

void test("isolates offline release verification from player and library authority", () => {
  const violations = validateArchitecture(
    metadata({
      "portcove-release-tools": ["portcove-core", "tauri"],
      "portcove-desktop": ["portcove-core", "tauri", "portcove-release-tools"],
    }),
  );
  assert.equal(violations.length, 3);
});

void test("keeps host tracing collectors outside the core failure authority", () => {
  const violations = validateArchitecture(
    metadata({ "portcove-core": ["serde", "tracing-subscriber"] }),
  );
  assert.equal(violations.length, 1);
  assert.ok(violations[0]);
  assert.equal(violations[0].dependencyName, "tracing-subscriber");
});

void test("rejects malformed Cargo metadata before evaluating architecture", () => {
  for (const value of [
    null,
    {},
    { packages: {} },
    { packages: [null] },
    { packages: [{ id: [], name: "portcove-core", dependencies: [] }] },
    { packages: [{ id: "core", name: "portcove-core", dependencies: ["tauri"] }] },
    { ...metadata(), workspace_default_members: [42] },
  ]) {
    assert.throws(() => validateArchitecture(value), TypeError);
  }
});
