import assert from "node:assert/strict";
import test from "node:test";

import {
  artifactName,
  loadPackagePolicy,
  packagesForPlatform,
  releaseLabels,
  validatePackagePolicy,
} from "./release-package-policy.mjs";

const policy = await loadPackagePolicy();

test("declares the exact supported desktop and CLI package matrix", () => {
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

test("resolves versioned CLI names without changing executable identity", () => {
  const expected = new Map([
    ["windows-x86_64", "portcove-cli-1.2.3-beta.4-windows-x86_64.zip"],
    ["linux-x86_64", "portcove-cli-1.2.3-beta.4-linux-x86_64.tar.gz"],
    ["macos-aarch64", "portcove-cli-1.2.3-beta.4-macos-aarch64.tar.gz"],
    ["macos-x86_64", "portcove-cli-1.2.3-beta.4-macos-x86_64.tar.gz"],
  ]);
  for (const [platform, name] of expected) {
    const cli = packagesForPlatform(policy, platform).filter((entry) => entry.interface === "cli");
    assert.equal(cli.length, 1);
    assert.equal(artifactName(cli[0], "1.2.3-beta.4"), name);
  }
});

test("rejects duplicate, unsafe, and incomplete package policy entries", () => {
  const invalid = structuredClone(policy);
  invalid.packages[1].id = invalid.packages[0].id;
  invalid.packages[1].filename = "../portcove-{version}.zip";
  invalid.packages[0].os = "linux";
  invalid.packages[0].format = "dmg";
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

test("rejects filename and identifier characters that could alter shells or generated Markdown", () => {
  const invalid = structuredClone(policy);
  invalid.packages[0].id = "desktop]bad";
  invalid.packages[0].filename = "Portcove_{version})[bad].exe";
  const errors = validatePackagePolicy(invalid).join("\n");
  assert.match(errors, /unsafe.*package id/);
  assert.match(errors, /safe \{version\} filename/);
});

test("rejects malformed versions before resolving filenames", () => {
  assert.throws(() => artifactName(policy.packages[0], "0.1"), /invalid release version/);
});
