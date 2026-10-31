import assert from "node:assert/strict";
import test from "node:test";
function requiredFixture<T>(value: T): NonNullable<T> {
  assert.ok(value !== undefined && value !== null);
  return value;
}

import {
  artifactName,
  loadPackagePolicy,
  packagesForPlatform,
  releaseLabels,
  releaseBuildArtifactName,
  selectReleasePackagePolicy,
  releaseBuildMatrix,
  inspectReleaseProfile,
  nativePlatformsForReleaseProfile,
  validatePackagePolicy,
} from "./release-package-policy.mts";

const policy = await loadPackagePolicy();

void test("Windows first beta selects only its exact installer and CLI without widening historical profiles", () => {
  const profile = "initial-beta-windows-x86_64-v1";
  const original = structuredClone(policy);
  const selected = selectReleasePackagePolicy(policy, profile);
  assert.equal(inspectReleaseProfile(profile), profile);
  assert.deepEqual(selected.packages.map((p) => `${p.interface}:${p.platform_label}:${p.format}`), [
    "desktop:windows-x86_64:nsis", "cli:windows-x86_64:zip",
  ]);
  assert.deepEqual(releaseBuildMatrix(profile).include, [
    { os: "windows-latest", label: "windows-x86_64", bundles: "nsis", target: "" },
  ]);
  assert.deepEqual(nativePlatformsForReleaseProfile(profile), ["windows-x86_64"]);
  assert.deepEqual(nativePlatformsForReleaseProfile("initial-beta-win-linux"), ["windows-x86_64", "linux-x86_64"]);
  assert.throws(() => nativePlatformsForReleaseProfile("full"), /explicit initial beta/);
  for (const alias of ["initial-beta-windows", "windows", "initial-beta-windows-aarch64-v1", ""])
    assert.throws(() => inspectReleaseProfile(alias), /unknown trusted release profile/);
  for (const format of ["nsis", "zip"])
    assert.throws(() => selectReleasePackagePolicy({ ...policy, packages: policy.packages.filter(
      (p) => p.platform_label !== "windows-x86_64" || p.format !== format,
    ) }, profile));
  assert.deepEqual(policy, original);
  assert.equal(selectReleasePackagePolicy(policy, "initial-beta-win-linux").packages.length, 6);
  assert.equal(selectReleasePackagePolicy(policy, "full").packages.length, 10);
});

void test("initial beta derives six mandatory Windows/Linux packages from the complete policy", () => {
  const beta = selectReleasePackagePolicy(policy, "initial-beta-win-linux");
  assert.equal(beta.packages.length, 6);
  assert.deepEqual(releaseLabels(beta), ["windows-x86_64", "linux-x86_64"]);
  assert.deepEqual(
    beta.packages.map((p) => p.format),
    ["nsis", "zip", "appimage", "deb", "rpm", "tar.gz"],
  );
  assert.deepEqual(
    releaseBuildMatrix("initial-beta-win-linux").include.map((p) => p.label),
    releaseLabels(beta),
  );
  assert.equal(selectReleasePackagePolicy(policy).packages.length, 10);
  assert.throws(
    () => selectReleasePackagePolicy(policy, "missing-packages"),
    /unknown trusted release profile/,
  );
  assert.throws(
    () =>
      selectReleasePackagePolicy({ ...policy, packages: beta.packages }, "initial-beta-win-linux"),
    /invalid release package policy/,
  );
  assert.throws(
    () =>
      selectReleasePackagePolicy(
        { ...policy, packages: policy.packages.filter((entry) => entry.format !== "deb") },
        "initial-beta-win-linux",
      ),
    /exact six/,
  );
});

void test("provider artifact names bind one platform, run and immutable attempt", () => {
  assert.equal(
    releaseBuildArtifactName("linux-x86_64", "12345", 1),
    "release-build-linux-x86_64-12345-1",
  );
  assert.notEqual(
    releaseBuildArtifactName("linux-x86_64", "12345", 1),
    releaseBuildArtifactName("linux-x86_64", "12345", 2),
  );
  for (const args of [
    ["foreign", "12345", 1],
    ["linux-x86_64", "0", 1],
    ["linux-x86_64", "12345", 0],
    ["linux-x86_64", "12345", 1.5],
  ] as const)
    assert.throws(() => releaseBuildArtifactName(args[0], args[1], args[2]));
});

void test("declares the exact supported desktop and CLI package matrix", () => {
  assert.deepEqual(releaseLabels(policy), [
    "windows-x86_64",
    "linux-x86_64",
    "macos-aarch64",
    "macos-x86_64",
  ]);
  assert.deepEqual(
    policy.packages.map((entry) => `${entry.interface}:${entry.platform_label}:${entry.format}`),
    [
      "desktop:windows-x86_64:nsis",
      "cli:windows-x86_64:zip",
      "desktop:linux-x86_64:appimage",
      "desktop:linux-x86_64:deb",
      "desktop:linux-x86_64:rpm",
      "cli:linux-x86_64:tar.gz",
      "desktop:macos-aarch64:dmg",
      "cli:macos-aarch64:tar.gz",
      "desktop:macos-x86_64:dmg",
      "cli:macos-x86_64:tar.gz",
    ],
  );
});

void test("resolves versioned CLI names without changing executable identity", () => {
  const expected = new Map([
    ["windows-x86_64", "portcove-cli-1.2.3-beta.4-windows-x86_64.zip"],
    ["linux-x86_64", "portcove-cli-1.2.3-beta.4-linux-x86_64.tar.gz"],
    ["macos-aarch64", "portcove-cli-1.2.3-beta.4-macos-aarch64.tar.gz"],
    ["macos-x86_64", "portcove-cli-1.2.3-beta.4-macos-x86_64.tar.gz"],
  ]);
  for (const [platform, name] of expected) {
    const cli = packagesForPlatform(policy, platform).filter((entry) => entry.interface === "cli");
    assert.equal(cli.length, 1);
    assert.equal(artifactName(requiredFixture(cli[0]), "1.2.3-beta.4"), name);
  }
});

void test("rejects duplicate, unsafe, and incomplete package policy entries", () => {
  const invalid = structuredClone(policy);
  requiredFixture(invalid.packages[1]).id = requiredFixture(invalid.packages[0]).id;
  requiredFixture(invalid.packages[1]).filename = "../portcove-{version}.zip";
  requiredFixture(invalid.packages[0]).os = "linux";
  requiredFixture(invalid.packages[0]).format = "dmg";
  invalid.packages = invalid.packages.filter(
    (entry) => entry.platform_label !== "macos-x86_64" || entry.interface !== "cli",
  );
  const errors = validatePackagePolicy(invalid).join("\n");
  assert.match(errors, /duplicate package id/);
  assert.match(errors, /safe \{version\} filename/);
  assert.match(errors, /OS\/architecture does not match windows-x86_64/);
  assert.match(errors, /format dmg does not match windows-x86_64 desktop/);
  assert.match(errors, /macos-x86_64 must declare exactly one CLI archive/);
});

void test("rejects filename and identifier characters that could alter shells or generated Markdown", () => {
  const invalid = structuredClone(policy);
  requiredFixture(invalid.packages[0]).id = "desktop]bad";
  requiredFixture(invalid.packages[0]).filename = "Portcove_{version})[bad].exe";
  const errors = validatePackagePolicy(invalid).join("\n");
  assert.match(errors, /unsafe.*package id/);
  assert.match(errors, /safe \{version\} filename/);
});

void test("rejects malformed versions before resolving filenames", () => {
  assert.throws(
    () => artifactName(requiredFixture(policy.packages[0]), "0.1"),
    /invalid release version/,
  );
});

void test("policy validation rejects non-text display and format labels", () => {
  for (const field of ["display_label", "format_label"] as const) {
    for (const value of [{ label: "misleading" }, ["misleading"], 7, true]) {
      const candidate = structuredClone(policy);
      const entry: Record<string, unknown> = {
        ...requiredFixture(candidate.packages[0]),
        [field]: value,
      };
      const raw = { ...candidate, packages: [entry, ...candidate.packages.slice(1)] };
      assert.match(
        validatePackagePolicy(raw).join("\n"),
        /must declare OS, architecture, format, and display labels/,
      );
    }
  }
});
