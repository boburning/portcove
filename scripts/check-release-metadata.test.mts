import type { DesktopCargoFeatures } from "./check-release-metadata.mts";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import {
  canonicalBrandIcns,
  readVectorFamily,
  validateVectorSource,
  verifyVectorFamily,
} from "./brand-vector-contract.mts";

void test("ICNS export order is repeatable without changing encoded payloads", () => {
  const types = [
    "is32",
    "s8mk",
    "il32",
    "l8mk",
    "ic11",
    "ic12",
    "ic07",
    "ic08",
    "ic13",
    "ic09",
    "ic14",
    "ic10",
  ];
  const element = (type: string) => {
    const bytes = Buffer.alloc(12);
    bytes.write(type);
    bytes.writeUInt32BE(12, 4);
    bytes.write(type, 8);
    return bytes;
  };
  const container = (entries: Buffer[]) => {
    const header = Buffer.alloc(8);
    header.write("icns");
    header.writeUInt32BE(8 + entries.reduce((size, entry) => size + entry.length, 0), 4);
    return Buffer.concat([header, ...entries]);
  };
  const expected = container(types.map(element));
  const reordered = container([...types].reverse().map(element));
  assert.deepEqual(canonicalBrandIcns(reordered), expected);
  assert.deepEqual(canonicalBrandIcns(expected), expected);
  assert.throws(() => canonicalBrandIcns(expected.subarray(0, expected.length - 1)), /header/);
  assert.throws(() => canonicalBrandIcns(container(types.slice(1).map(element))), /Incomplete/);
  assert.throws(
    () => canonicalBrandIcns(container([...types, types[0]!].map(element))),
    /duplicate/,
  );
  assert.throws(
    () => canonicalBrandIcns(container([...types.slice(1), "new!"].map(element))),
    /Unexpected/,
  );
});

import {
  formatReleaseMetadataSummary,
  inspectPng,
  loadDesktopCargoFeatures,
  parseArguments,
  parseDesktopCargoFeatures,
  parseWorkspacePackage,
  validateBrandManifestDefinition,
  validateModelManifestDefinition,
  validateReleaseMetadata,
} from "./check-release-metadata.mts";

interface WindowFixture {
  title: string;
  label?: string;
  create?: boolean;
  url?: string;
}
interface CapabilityFixture {
  identifier: string;
  windows: string[];
  permissions: string[];
  local?: boolean;
  remote?: { urls: string[] };
  webviews?: string[];
}
function fixtureElement<T>(values: readonly T[], index: number): T {
  const value = values[index];
  assert.ok(value !== undefined);
  return value;
}

void test("candidate vector family retains transparent derivatives without implying owner approval", async () => {
  const root = fileURLToPath(new URL("../", import.meta.url));
  const verified = await verifyVectorFamily(root);
  assert.equal(verified.family.status, "candidate");
  assert.equal(verified.family.production_approval, null);
  assert.equal(verified.family.masters.length, 20);
  assert.equal(verified.family.derivatives.length, 76);
  assert.throws(
    () => readVectorFamily({ ...verified.family, status: "approved" }),
    /Production approval/,
  );
  assert.throws(
    () =>
      readVectorFamily({
        ...verified.family,
        production_approval: {
          owner: "placeholder",
          evidence: "placeholder",
          candidate_sha256: verified.family.candidate_sha256,
        },
      }),
    /cannot imply production approval/,
  );
  assert.throws(
    () => readVectorFamily({ ...verified.family, candidate_sha256: "0".repeat(64) }),
    /candidate identity changed/,
  );
  const historical: unknown = JSON.parse(
    await readFile(path.join(root, "apps/desktop/assets/brand/manifest.json"), "utf8"),
  );
  assert.deepEqual(validateBrandManifestDefinition(historical), []);
});

void test("authored vector sources cannot depend on fonts, raster embedding or linked resources", () => {
  const svg = (body: string) => `<svg viewBox="0 0 64 64">${body}</svg>`;
  validateVectorSource(svg('<path d="M1 1H4V4Z" fill="#15171c"/>'), [64, 64]);
  for (const body of [
    "<text>Portcove</text>",
    '<image href="data:image/png;base64,AAAA"/>',
    '<path fill="url(https://example.com/fill.svg)"/>',
    '<use href="#other"/>',
    "<script/>",
    "<foreignObject/>",
    '<path onclick="run()"/>',
    '<!ENTITY remote SYSTEM "outside">',
  ])
    assert.throws(() => validateVectorSource(svg(body), [64, 64]));
  assert.throws(() => validateVectorSource(svg(""), [128, 128]), /natural aspect ratio/);
});
interface MetadataFixture {
  cargo: Required<ReturnType<typeof parseWorkspacePackage>>;
  repositoryPackage: { packageManager: string };
  desktopPackage: { version: string };
  desktopCargoFeatures: DesktopCargoFeatures;
  desktopCapability: CapabilityFixture;
  tauri: {
    productName: string;
    version: string;
    identifier: string;
    app: { windows: WindowFixture[] };
    bundle: {
      active: boolean;
      icon: string[];
      homepage: string;
      shortDescription: string;
      longDescription: string;
      licenseFile: string;
    };
  };
  missingFiles: string[];
  brandManifestErrors: string[];
  modelManifestErrors: string[];
}
function validMetadata(): MetadataFixture {
  return {
    cargo: {
      version: "1.2.3-beta.1",
      repository: "https://github.com/boburning/portcove",
      license: "MIT OR Apache-2.0",
    },
    repositoryPackage: { packageManager: "pnpm@12.4.1" },
    desktopPackage: { version: "1.2.3-beta.1" },
    desktopCargoFeatures: {
      names: [
        "application-update-qualification",
        "native-compatibility-qualification",
        "qualification-fixtures",
      ],
      default: [],
      definitions: {
        "application-update-qualification": [],
        "native-compatibility-qualification": ["dep:tauri-plugin-wdio-webdriver"],
        "qualification-fixtures": ["portcove-core/qualification-fixtures"],
      },
      coreQualificationReferences: [
        "portcove-core/qualification-fixtures",
        "portcove-core?/qualification-fixtures",
      ],
      alwaysEnabledCoreFeatures: [],
    },
    desktopCapability: {
      identifier: "default",
      windows: ["main"],
      permissions: ["core:default"],
    },
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
        shortDescription: "Install, update, and play native game ports.",
        longDescription: "A local-first native port manager.",
        licenseFile: "../../../LICENSE-MIT",
      },
    },
    missingFiles: [],
    brandManifestErrors: [],
    modelManifestErrors: [],
  };
}

function pngHeader(width: number, height: number, colorType = 6, bitDepth = 8) {
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
    assets: [
      {
        id: "logo-v2",
        path: "apps/desktop/assets/brand/generated/v2/logo.png",
        category: "canonical_master",
        role: "Canonical logo",
        width: 1024,
        height: 512,
        color_mode: "RGBA",
        sha256: "a".repeat(64),
      },
    ],
  };
}

function validModelManifest() {
  return {
    schema_version: 1,
    brand_version: 2,
    model_version: 1,
    blender_version: "5.2.1 LTS",
    geometry: {
      triangles: 1564,
      eyes: 2,
      claws: 2,
      walking_legs: 4,
      side_spikes: 4,
      fixed_cameras: 5,
      lid_hinges: 2,
    },
    materials: [
      "MAT_SignatureRed",
      "MAT_CobaltBlue",
      "MAT_GoldenYellow",
      "MAT_EmeraldGreen",
      "MAT_WarmWhite",
      "MAT_Graphite",
    ],
    files: (
      [
        ["mascot-v2-blender-source", "source.blend"],
        ["mascot-v2-glb-exchange", "exchange.glb"],
        ["mascot-v2-model-builder", "build.py"],
        ["mascot-v2-model-validator", "validate.py"],
        ["mascot-v2-proof-builder", "proofs.py"],
      ] as const
    ).map(([id, name]) => ({
      id,
      path: `apps/desktop/assets/brand/models/v2/${name}`,
      role: "Model file",
      bytes: 1,
      sha256: "a".repeat(64),
    })),
  };
}

void test("parses release identity from the Cargo workspace table", () => {
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

void test("Cargo metadata preserves comments and always-on dependency features", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "portcove-release-metadata-"));
  const desktopRoot = path.join(root, "desktop");
  const coreRoot = path.join(root, "core");
  const desktopCargoPath = path.join(desktopRoot, "Cargo.toml");
  await mkdir(path.join(desktopRoot, "src"), { recursive: true });
  await mkdir(path.join(coreRoot, "src"), { recursive: true });
  await writeFile(
    path.join(root, "Cargo.toml"),
    '[workspace]\nmembers = ["desktop", "core"]\nresolver = "2"\n',
  );
  await writeFile(path.join(desktopRoot, "src", "lib.rs"), "");
  await writeFile(path.join(coreRoot, "src", "lib.rs"), "");
  await writeFile(
    path.join(coreRoot, "Cargo.toml"),
    '[package]\nname = "portcove-core"\nversion = "0.0.0"\nedition = "2024"\n\n[features]\nqualification-fixtures = []\nproduction-alias = ["qualification-fixtures"]\n',
  );
  try {
    await writeFile(
      desktopCargoPath,
      '[package]\nname = "portcove-desktop"\nversion = "0.0.0"\nedition = "2024"\n\n[features]\ndefault = [\n  # ] explanatory comment\n  "application-update-qualification",\n]\napplication-update-qualification = []\nqualification-fixtures = ["portcove-core/qualification-fixtures"]\n\n[dependencies]\nportcove-core = { path = "../core" }\n',
    );
    const commented = await loadDesktopCargoFeatures(desktopCargoPath, { locked: false });
    assert.deepEqual(commented.default, ["application-update-qualification"]);

    await writeFile(
      desktopCargoPath,
      '[package]\nname = "portcove-desktop"\nversion = "0.0.0"\nedition = "2024"\n\n[features]\napplication-update-qualification = []\nqualification-fixtures = ["portcove-core/qualification-fixtures"]\n\n[dependencies]\nportcove-core = { path = "../core", features = ["production-alias"] }\n',
    );
    const dependencyEnabled = await loadDesktopCargoFeatures(desktopCargoPath, { locked: false });
    assert.deepEqual(
      dependencyEnabled.alwaysEnabledCoreFeatures.toSorted(),
      ["production-alias", "qualification-fixtures"].toSorted(),
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

void test("accepts one matching semantic version and tag across every surface", () => {
  assert.deepEqual(
    validateReleaseMetadata(validMetadata(), {
      tag: "v1.2.3-beta.1",
      expectedVersion: "1.2.3-beta.1",
    }),
    [],
  );
});

void test("rejects additional release windows and remote capability contexts", () => {
  const metadata = validMetadata();
  metadata.tauri.app.windows.push({ label: "secondary", title: "Secondary" });
  metadata.desktopCapability.windows.push("secondary");
  metadata.desktopCapability.remote = { urls: ["https://example.invalid"] };
  const errors = validateReleaseMetadata(metadata);
  assert.match(errors.join("\n"), /exactly one local main window/);
  assert.match(errors.join("\n"), /only to the local main window/);
});

void test("rejects external main windows and independent capability webviews", () => {
  const externalWindow = validMetadata();
  fixtureElement(externalWindow.tauri.app.windows, 0).url = "https://example.invalid";
  assert.match(validateReleaseMetadata(externalWindow).join("\n"), /exactly one local main window/);

  const independentWebview = validMetadata();
  independentWebview.desktopCapability.webviews = ["secondary"];
  assert.match(
    validateReleaseMetadata(independentWebview).join("\n"),
    /only to the local main window and no independent webviews/,
  );
});

void test("rejects a configured main window that is not created", () => {
  const metadata = validMetadata();
  fixtureElement(metadata.tauri.app.windows, 0).create = false;
  assert.match(validateReleaseMetadata(metadata).join("\n"), /exactly one local main window/);
});

void test("rejects capabilities that disable the local application context", () => {
  const metadata = validMetadata();
  metadata.desktopCapability.local = false;
  assert.match(
    validateReleaseMetadata(metadata).join("\n"),
    /only to the local main window and no independent webviews/,
  );
});

void test("rejects qualification-only features from default desktop builds", () => {
  const metadata = validMetadata();
  metadata.desktopCargoFeatures.default = [
    "application-update-qualification",
    "native-compatibility-qualification",
    "qualification-fixtures",
  ];
  assert.match(
    validateReleaseMetadata(metadata).join("\n"),
    /default features must exclude qualification-only features: application-update-qualification, native-compatibility-qualification, qualification-fixtures/,
  );

  metadata.desktopCargoFeatures.default = [];
  metadata.desktopCargoFeatures.names = ["application-update-qualification"];
  assert.match(
    validateReleaseMetadata(metadata).join("\n"),
    /retain the qualification-only feature declarations/,
  );
});

void test("rejects transitive aliases and dependency activation for qualification-only features", () => {
  const metadata = validMetadata();
  metadata.desktopCargoFeatures.default = ["shipping"];
  metadata.desktopCargoFeatures.definitions.shipping = [
    "application-update-qualification",
    "fixture-alias",
  ];
  metadata.desktopCargoFeatures.definitions["fixture-alias"] = [
    "portcove-core/qualification-fixtures",
  ];
  assert.match(
    validateReleaseMetadata(metadata).join("\n"),
    /default features must exclude qualification-only features: application-update-qualification, portcove-core\/qualification-fixtures/,
  );

  metadata.desktopCargoFeatures.default = [];
  metadata.desktopCargoFeatures.alwaysEnabledCoreFeatures = ["qualification-fixtures"];
  assert.match(
    validateReleaseMetadata(metadata).join("\n"),
    /portcove-core\/qualification-fixtures \(dependency declaration\)/,
  );
});

void test("reports every mismatched release identity in one pass", () => {
  const metadata = validMetadata();
  metadata.desktopPackage.version = "1.2.2";
  metadata.tauri.version = "1.2.4";
  metadata.tauri.bundle.homepage = "https://example.invalid/portcove";
  metadata.missingFiles = ["apps/desktop/src-tauri/icons/icon.ico"];
  const errors = validateReleaseMetadata(metadata, {
    tag: "v1.2.3",
    expectedVersion: "1.2.4",
  });
  assert.equal(errors.length, 6);
  assert.match(errors.join("\n"), /desktop package version 1\.2\.2/);
  assert.match(errors.join("\n"), /Tauri bundle version 1\.2\.4/);
  assert.match(errors.join("\n"), /release tag v1\.2\.3/);
  assert.match(errors.join("\n"), /required release file is missing/);
});

void test("rejects malformed versions before a tag can be accepted", () => {
  const metadata = validMetadata();
  metadata.cargo.version = "01.2";
  metadata.desktopPackage.version = "01.2";
  metadata.tauri.version = "01.2";
  const errors = validateReleaseMetadata(metadata, { tag: "v01.2" });
  assert.match(errors.join("\n"), /not valid SemVer/);
});

void test("requires the complete platform icon set", () => {
  const metadata = validMetadata();
  metadata.tauri.bundle.icon = ["icons/icon.ico"];
  const errors = validateReleaseMetadata(metadata);
  assert.match(errors.join("\n"), /complete platform icon set/);
});

void test("reads dimensions and color mode from a PNG header", () => {
  assert.deepEqual(inspectPng(pngHeader(1024, 512)), {
    width: 1024,
    height: 512,
    bitDepth: 8,
    colorMode: "RGBA",
  });
  assert.equal(inspectPng(pngHeader(1254, 962, 2)).colorMode, "RGB");
  assert.throws(() => inspectPng(Buffer.from("not a png")), /not a valid PNG/);
});

void test("rejects ambiguous or unsafe brand manifest entries", () => {
  const manifest = validBrandManifest();
  manifest.assets.push({ ...fixtureElement(manifest.assets, 0), path: "../outside.png" });
  const errors = validateBrandManifestDefinition(manifest);
  assert.match(errors.join("\n"), /duplicate id/);
  assert.match(errors.join("\n"), /invalid PNG path/);
});

void test("locks model anatomy, materials, and repository-contained files", () => {
  assert.deepEqual(validateModelManifestDefinition(validModelManifest()), []);
  const manifest = validModelManifest();
  manifest.geometry.walking_legs = 6;
  fixtureElement(manifest.files, 0).path = "../outside.blend";
  manifest.files.pop();
  const errors = validateModelManifestDefinition(manifest);
  assert.match(errors.join("\n"), /walking_legs must be 4/);
  assert.match(errors.join("\n"), /invalid model path/);
  assert.match(errors.join("\n"), /missing required file id/);
});

void test("reports brand asset integrity failures with release metadata", () => {
  const metadata = validMetadata();
  metadata.brandManifestErrors = ["brand asset logo-v2 SHA-256 does not match manifest"];
  assert.match(validateReleaseMetadata(metadata).join("\n"), /brand asset logo-v2 SHA-256/);
});

void test("reports model integrity failures with release metadata", () => {
  const metadata = validMetadata();
  metadata.modelManifestErrors = [
    "model file mascot-v2-glb-exchange SHA-256 does not match manifest",
  ];
  assert.match(
    validateReleaseMetadata(metadata).join("\n"),
    /model file mascot-v2-glb-exchange SHA-256/,
  );
});

void test("parses inline and positional release options", () => {
  assert.deepEqual(
    parseArguments(["--tag=v1.2.3", "--expect-version", "1.2.3", "--print-version"]),
    {
      printVersion: true,
      tag: "v1.2.3",
      expectedVersion: "1.2.3",
    },
  );
  assert.throws(() => parseArguments(["--tag"]), /requires a value/);
  assert.throws(() => parseArguments(["--unknown"]), /unknown argument/);
  assert.deepEqual(parseArguments(["--help"]), { printVersion: false, help: true });
  assert.throws(() => parseArguments(["--help", "--unknown"]), /unknown argument/);
  assert.throws(() => parseArguments(["--help", "--tag"]), /requires a value/);
});

void test("release metadata summary scopes versions, tags, and zero/one/many counts", () => {
  assert.equal(
    formatReleaseMetadataSummary("1.2.3", undefined, {
      requiredFiles: 0,
      brandAssets: 1,
      modelFiles: 2,
    }),
    "Release metadata passed for Portcove 1.2.3. Checked 0 required files, 1 brand asset, and 2 model files.",
  );
  assert.equal(
    formatReleaseMetadataSummary("1.2.3", "v1.2.3", {
      requiredFiles: 1,
      brandAssets: 2,
      modelFiles: 0,
    }),
    "Release metadata passed for Portcove 1.2.3 (tag v1.2.3). Checked 1 required file, 2 brand assets, and 0 model files.",
  );
  assert.equal(
    formatReleaseMetadataSummary("1.2.3", undefined, {
      requiredFiles: 2,
      brandAssets: 0,
      modelFiles: 1,
    }),
    "Release metadata passed for Portcove 1.2.3. Checked 2 required files, 0 brand assets, and 1 model file.",
  );
});

void test("release identity and asset digests reject coercible arrays", () => {
  const metadata = validMetadata();
  assert.match(
    validateReleaseMetadata({
      ...metadata,
      repositoryPackage: { packageManager: [metadata.repositoryPackage.packageManager] },
    }).join("\n"),
    /exact pnpm version/,
  );
  const manifest = validBrandManifest();
  const asset = fixtureElement(manifest.assets, 0);
  assert.match(
    validateBrandManifestDefinition({
      ...manifest,
      assets: [{ ...asset, sha256: [asset.sha256] }],
    }).join("\n"),
    /lowercase SHA-256/,
  );
  const model = validModelManifest();
  const file = fixtureElement(model.files, 0);
  assert.match(
    validateModelManifestDefinition({
      ...model,
      files: [{ ...file, sha256: [file.sha256] }, ...model.files.slice(1)],
    }).join("\n"),
    /lowercase SHA-256/,
  );
});
void test("malformed Cargo feature references cannot disguise qualification defaults", () => {
  const metadata = validMetadata();
  assert.match(
    validateReleaseMetadata({
      ...metadata,
      desktopCargoFeatures: {
        ...metadata.desktopCargoFeatures,
        definitions: { shipping: "qualification-fixtures" },
        default: ["shipping"],
      },
    }).join("\n"),
    /feature references are invalid/,
  );
});

void test("own prototype-named feature aliases retain qualification edges", () => {
  const definitions: unknown = JSON.parse(
    '{"default":["__proto__"],"__proto__":["qualification-fixtures"]}',
  );
  const desktop = {
    name: "portcove-desktop",
    manifest_path: "/fixture/desktop/Cargo.toml",
    features: definitions,
    dependencies: [
      { name: "portcove-core", kind: null, path: "/fixture/core", uses_default_features: true },
    ],
  };
  const core = {
    name: "portcove-core",
    manifest_path: "/fixture/core/Cargo.toml",
    features: definitions,
    dependencies: [],
  };
  const features = parseDesktopCargoFeatures({ packages: [desktop, core] }, desktop.manifest_path);
  assert.equal(Object.hasOwn(features.definitions, "__proto__"), true);
  assert.equal(features.alwaysEnabledCoreFeatures.includes("qualification-fixtures"), true);
  const metadata = validMetadata();
  const rawDefinitions: unknown = JSON.parse('{"__proto__":["application-update-qualification"]}');
  const errors = validateReleaseMetadata({
    ...metadata,
    desktopCargoFeatures: {
      ...metadata.desktopCargoFeatures,
      default: ["__proto__"],
      definitions: rawDefinitions,
    },
  });
  assert.match(
    errors.join("\n"),
    /default features must exclude qualification-only features: application-update-qualification/,
  );
});
