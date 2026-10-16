import test from "node:test";
import assert from "node:assert/strict";
import { stringify } from "yaml";
import { introducedPackages, lockInventory } from "./pnpm-lock-inventory.mts";

const record = { resolution: { integrity: "sha512-YQ==" } };
const lock = (packages, importers = {}) =>
  stringify({ lockfileVersion: "9.0", importers, packages });

test("artifact inventory covers multi-document locks, scoped aliases and deduplicated peers", () => {
  const base = lock({ "@scope/core@1.0.0(peer@1.0.0)": record }) + "---\n" + lock({});
  const candidate =
    lock({ "@scope/core@1.0.0(peer@2.0.0)": record }) +
    "---\n" +
    lock({ "transitive@2.0.0": record, "transitive@2.0.0(peer@1.0.0)": record });
  assert.deepEqual(introducedPackages(base, candidate), [
    { name: "transitive", version: "2.0.0", integrity: "sha512-YQ==" },
  ]);
  assert.equal(lockInventory(candidate).size, 3);
});
test("changed integrity is a changed artifact even at the same version", () => {
  const changed = { resolution: { integrity: "sha512-Yg==" } };
  assert.equal(
    introducedPackages(lock({ "core@1.0.0": record }), lock({ "core@1.0.0": changed })).length,
    1,
  );
  assert.deepEqual(introducedPackages(lock({ "core@1.0.0": record }), lock({})), []);
});
test("unsupported sources and local importer resolutions remain visible to comparison consumers", () => {
  const candidate = lock(
    { "git+https://example.invalid/core": { resolution: { repo: "core" } } },
    { ".": { dependencies: { local: { specifier: "file:../local", version: "link:../local" } } } },
  );
  const changes = introducedPackages(lock({}), candidate);
  assert.equal(changes.length, 2);
  assert(changes.every((entry) => entry.unsupported));
});
test("malformed, duplicate and unsupported lock schemas cannot yield a partial inventory", () => {
  for (const text of [
    "",
    "packages: [",
    "lockfileVersion: 9.0\npackages: {}\npackages: {}",
    lock({}) + "---\ninvalid: schema",
  ])
    assert.throws(() => lockInventory(text));
});
