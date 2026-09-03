import assert from "node:assert/strict";
import test from "node:test";

import {
  inspectPng,
  parseArguments,
  parseWorkspacePackage,
  validateBrandManifestDefinition,
  validateReleaseMetadata,
} from "./check-release-metadata.mjs";

function validMetadata() {
  return {
    cargo: {
      version: "1.2.3-beta.1",
      repository: "https://github.com/boburning/portcove",
      license: "MIT OR Apache-2.0",
    },
    desktopPackage: { version: "1.2.3-beta.1", packageManager: "pnpm@11.25.0" },
    tauri: {
      productName: "Portcove",
      version: "1.2.3-beta.1",
      identifier: "io.github.portcove.portcove",
      app: { windows: [{ title: "Portcove" }] },
      bundle: {
        active: true,
        icon: [
          "icons/32x32.png",
          "icons/128x128.png",
          "icons/128x128@2x.png",
          "icons/icon.icns",
          "icons/icon.ico",
        ],
        homepage: "https://github.com/boburning/portcove",
        shortDescription: "Native ports, kept current.",
        longDescription: "A local-first native port manager.",
        licenseFile: "../../../LICENSE-MIT",
      },
    },
    missingFiles: [],
  };
}

function pngHeader(width, height, colorType = 6, bitDepth = 8) {
  const buffer = Buffer.alloc(29);
  Buffer.from("89504e470d0a1a0a", "hex").copy(buffer);
  buffer.writeUInt32BE(13, 8);
  buffer.write("IHDR", 12, 4, "ascii");
  buffer.writeUInt32BE(width, 16);
  buffer.writeUInt32BE(height, 20);
  buffer[24] = bitDepth;
  buffer[25] = colorType;
  return buffer;
}

function validBrandManifest() {
  return {
    schema_version: 1,
    brand_version: 2,
    assets: [{
      id: "logo-v2",
      path: "apps/desktop/assets/brand/generated/v2/logo.png",
      category: "canonical_master",
      role: "Canonical logo",
      width: 1024,
      height: 512,
      color_mode: "RGBA",
      sha256: "a".repeat(64),
    }],
  };
}

test("parses release identity from the Cargo workspace table", () => {
  const parsed = parseWorkspacePackage(`
[workspace]
members = []

[workspace.package]
version = "0.1.0"
license = "MIT OR Apache-2.0"
repository = "https://github.com/boburning/portcove"

[workspace.dependencies]
serde = "1"
`);
  assert.deepEqual(parsed, {
    version: "0.1.0",
    repository: "https://github.com/boburning/portcove",
    license: "MIT OR Apache-2.0",
  });
});

test("accepts one matching semantic version and tag across every surface", () => {
  assert.deepEqual(validateReleaseMetadata(validMetadata(), {
    tag: "v1.2.3-beta.1",
    expectedVersion: "1.2.3-beta.1",
  }), []);
});

test("reports every mismatched release identity in one pass", () => {
  const metadata = validMetadata();
  metadata.desktopPackage.version = "1.2.2";
  metadata.tauri.version = "1.2.4";
  metadata.tauri.bundle.homepage = "https://example.invalid/portcove";
  metadata.missingFiles = ["apps/desktop/src-tauri/icons/icon.ico"];
  const errors = validateReleaseMetadata(metadata, { tag: "v1.2.3", expectedVersion: "1.2.4" });
  assert.equal(errors.length, 6);
  assert.match(errors.join("\n"), /desktop package version 1\.2\.2/);
  assert.match(errors.join("\n"), /Tauri bundle version 1\.2\.4/);
  assert.match(errors.join("\n"), /release tag v1\.2\.3/);
  assert.match(errors.join("\n"), /required release file is missing/);
});

test("rejects malformed versions before a tag can be accepted", () => {
  const metadata = validMetadata();
  metadata.cargo.version = "01.2";
  metadata.desktopPackage.version = "01.2";
  metadata.tauri.version = "01.2";
  const errors = validateReleaseMetadata(metadata, { tag: "v01.2" });
  assert.match(errors.join("\n"), /not valid SemVer/);
});

test("requires the complete platform icon set", () => {
  const metadata = validMetadata();
  metadata.tauri.bundle.icon = ["icons/icon.ico"];
  const errors = validateReleaseMetadata(metadata);
  assert.match(errors.join("\n"), /complete platform icon set/);
});

test("reads dimensions and color mode from a PNG header", () => {
  assert.deepEqual(inspectPng(pngHeader(1024, 512)), {
    width: 1024,
    height: 512,
    bitDepth: 8,
    colorMode: "RGBA",
  });
  assert.equal(inspectPng(pngHeader(1254, 962, 2)).colorMode, "RGB");
  assert.throws(() => inspectPng(Buffer.from("not a png")), /not a valid PNG/);
});

test("rejects ambiguous or unsafe brand manifest entries", () => {
  const manifest = validBrandManifest();
  manifest.assets.push({ ...manifest.assets[0], path: "../outside.png" });
  const errors = validateBrandManifestDefinition(manifest);
  assert.match(errors.join("\n"), /duplicate id/);
  assert.match(errors.join("\n"), /invalid PNG path/);
});

test("reports brand asset integrity failures with release metadata", () => {
  const metadata = validMetadata();
  metadata.brandManifestErrors = ["brand asset logo-v2 SHA-256 does not match manifest"];
  assert.match(validateReleaseMetadata(metadata).join("\n"), /brand asset logo-v2 SHA-256/);
});

test("parses inline and positional release options", () => {
  assert.deepEqual(parseArguments(["--tag=v1.2.3", "--expect-version", "1.2.3", "--print-version"]), {
    printVersion: true,
    tag: "v1.2.3",
    expectedVersion: "1.2.3",
  });
  assert.throws(() => parseArguments(["--tag"]), /requires a value/);
  assert.throws(() => parseArguments(["--unknown"]), /unknown argument/);
});
