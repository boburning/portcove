import test from "node:test";
import assert from "node:assert/strict";
import { stringify } from "yaml";
import {
  introducedPackages,
  lockInventory,
  validateRootPnpmToolchain,
} from "./pnpm-lock-inventory.mts";

const record = { resolution: { integrity: "sha512-YQ==" } };
const lock = (packages: unknown, importers: unknown = {}) =>
  stringify({ lockfileVersion: "9.0", importers, packages });

const version = "12.14.0";
const platforms = [
  "darwin-arm64",
  "darwin-x64",
  "linux-arm64",
  "linux-x64",
  "win32-arm64",
  "win32-x64",
];
function toolchainFixture() {
  const optionalDependencies = Object.fromEntries(
    platforms.map((p) => [`@pnpm/exe.${p}`, version]),
  );
  const identities = [`pnpm@${version}`, ...platforms.map((p) => `@pnpm/exe.${p}@${version}`)];
  return {
    lockfileVersion: "9.0",
    importers: { ".": { packageManagerDependencies: { pnpm: { specifier: version, version } } } },
    packages: Object.fromEntries(
      identities.map((p) => [
        p,
        { resolution: { integrity: `sha512-${Buffer.alloc(64).toString("base64")}` } },
      ]),
    ),
    snapshots: Object.fromEntries(
      identities.map((p) => [
        p,
        p === `pnpm@${version}` ? { optionalDependencies } : { optional: true },
      ]),
    ),
  };
}
const workspace = "pmOnFail: error\nruntimeOnFail: ignore\n";
const rootLock = (env: ReturnType<typeof toolchainFixture>) =>
  `${stringify(env)}---\n${lock({}, { ".": {} })}`;

void test("root toolchain validation preserves complete cross-platform authority without changing generic inventory", () => {
  const text = rootLock(toolchainFixture());
  assert.deepEqual(validateRootPnpmToolchain(text, `pnpm@${version}`, workspace), {
    version,
    artifacts: 7,
  });
  assert.equal(lockInventory(lock({})).size, 0);
  for (const policy of ["ignore", "warn", "download"])
    assert.throws(
      () => validateRootPnpmToolchain(text, `pnpm@${version}`, workspace.replace("error", policy)),
      /Provider-owned/u,
    );
  assert.throws(
    () =>
      validateRootPnpmToolchain(
        text,
        `pnpm@${version}`,
        workspace.replace("runtimeOnFail: ignore", "runtimeOnFail: download"),
      ),
    /Provider-owned/u,
  );
  assert.throws(
    () => validateRootPnpmToolchain(lock({}), `pnpm@${version}`, workspace),
    /one toolchain document/u,
  );
  assert.throws(
    () =>
      validateRootPnpmToolchain(
        `${text}---\n${stringify(toolchainFixture())}`,
        `pnpm@${version}`,
        workspace,
      ),
    /one toolchain document/u,
  );
  assert.throws(
    () => validateRootPnpmToolchain(text, "pnpm@^12", workspace),
    /exact pnpm version/u,
  );
  assert.throws(
    () => validateRootPnpmToolchain(text, "pnpm@12.15.0", workspace),
    /does not match/u,
  );
});

void test("root integrity checks reject missing native records, malformed integrity and broken closure", () => {
  for (const platform of platforms) {
    const env = toolchainFixture();
    const identity = `@pnpm/exe.${platform}@${version}`;
    delete env.packages[identity];
    assert.throws(
      () => validateRootPnpmToolchain(rootLock(env), `pnpm@${version}`, workspace),
      /artifact/u,
    );
    const dropped = toolchainFixture();
    delete dropped.packages[identity];
    delete dropped.snapshots[identity];
    const edge = dropped.snapshots[`pnpm@${version}`]?.optionalDependencies;
    assert.ok(edge);
    delete edge[`@pnpm/exe.${platform}`];
    assert.throws(
      () => validateRootPnpmToolchain(rootLock(dropped), `pnpm@${version}`, workspace),
      /Missing maintained pnpm platform/u,
    );
  }
  const malformed = toolchainFixture();
  const entry = malformed.packages[`pnpm@${version}`];
  assert.ok(entry);
  entry.resolution.integrity = "sha512-YQ==";
  assert.throws(
    () => validateRootPnpmToolchain(rootLock(malformed), `pnpm@${version}`, workspace),
    /integrity/u,
  );
  const incomplete = toolchainFixture();
  delete incomplete.snapshots[`@pnpm/exe.win32-x64@${version}`];
  assert.throws(
    () => validateRootPnpmToolchain(rootLock(incomplete), `pnpm@${version}`, workspace),
    /snapshot/u,
  );
});

void test("artifact inventory covers multi-document locks, scoped aliases and deduplicated peers", () => {
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
void test("changed integrity is a changed artifact even at the same version", () => {
  const changed = { resolution: { integrity: "sha512-Yg==" } };
  assert.equal(
    introducedPackages(lock({ "core@1.0.0": record }), lock({ "core@1.0.0": changed })).length,
    1,
  );
  assert.deepEqual(introducedPackages(lock({ "core@1.0.0": record }), lock({})), []);
});
void test("unsupported sources and local importer resolutions remain visible to comparison consumers", () => {
  const candidate = lock(
    { "git+https://example.invalid/core": { resolution: { repo: "core" } } },
    { ".": { dependencies: { local: { specifier: "file:../local", version: "link:../local" } } } },
  );
  const changes = introducedPackages(lock({}), candidate);
  assert.equal(changes.length, 2);
  assert(changes.every((entry) => entry.unsupported));
});
void test("malformed, duplicate and unsupported lock schemas cannot yield a partial inventory", () => {
  for (const text of [
    "",
    "packages: [",
    "lockfileVersion: 9.0\npackages: {}\npackages: {}",
    lock({}) + "---\ninvalid: schema",
  ])
    assert.throws(() => lockInventory(text));
});
