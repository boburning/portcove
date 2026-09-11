import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, unlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { compareApplicationVersionPrecedence } from "../apps/desktop/scripts/release-version-policy.mjs";
import { artifactName, loadPackagePolicy, packagesForPlatform } from "./release-package-policy.mjs";
import {
  reconstructApplicationUpdateRecords,
  writeApplicationUpdateReconstruction,
} from "./reconstruct-application-update-records.mjs";
import { updaterIdentity } from "./updater-artifact-inventory.mjs";

const policy = await loadPackagePolicy();
const run = promisify(execFile);
const script = fileURLToPath(
  new URL("./reconstruct-application-update-records.mjs", import.meta.url),
);

function digest(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function source(version, label = "windows-x86_64", overrides = {}) {
  const signatureBytes = Buffer.from(`tauri-signature-${version}-${label}\n`);
  const identity = updaterIdentity(policy, label, version);
  const packages = packagesForPlatform(policy, label).map((entry, index) => ({
    id: entry.id,
    filename: artifactName(entry, version),
    bytes: 1000 + index,
    sha256: String(index + 1).repeat(64),
  }));
  const inventory = {
    schema_version: 1,
    repository: policy.repository,
    version,
    source_commit: "a".repeat(40),
    platform_label: label,
    application_identifier: "io.github.portcove.portcove",
    packages,
    updater: {
      id: identity.id,
      target: identity.target,
      format: identity.format,
      filename: identity.filename,
      bytes: 4096,
      sha256: "b".repeat(64),
      signature: {
        filename: `${identity.filename}.sig`,
        bytes: signatureBytes.length,
        sha256: digest(signatureBytes),
      },
      public_key_sha256: "c".repeat(64),
    },
  };
  return {
    inventoryBytes: Buffer.from(`${JSON.stringify(inventory, null, 2)}\n`),
    signatureBytes,
    source_tree: "d".repeat(40),
    qualified_run: {
      workflow: ".github/workflows/release.yml",
      workflow_commit: "e".repeat(40),
      run_id: 42,
      attempt: 1,
    },
    execution_context:
      label === "windows-x86_64"
        ? "installed-current-user"
        : label === "linux-x86_64"
          ? "user-owned-appimage"
          : "installed-app-bundle",
    compatibility: {
      minimum_os_version: label.startsWith("windows") ? "10.0.19045" : "1.0.0",
      required_capabilities: ["library-lock-v1"],
      cli_protocol: { min: 47, max: 47 },
      catalog_formats: [1, 2],
      library: {
        read: { min: 1, max: 27 },
        write_schema: 27,
        lock_protocol: "library-lock-v1",
      },
    },
    evidence_ids: [`run-${version}-${label}`],
    ...overrides,
  };
}

function evidence(version, overrides = {}) {
  return {
    version,
    preview_eligible: true,
    production_eligible: false,
    targets: ["windows-x86_64"],
    ...overrides,
  };
}

test("reconstructs deterministic versioned release and separately authenticated channel records", async () => {
  const sources = [source("1.0.0"), source("0.9.0")];
  const eligibility = {
    "v0.9.0": evidence("0.9.0"),
    "v1.0.0": evidence("1.0.0", { production_eligible: true }),
  };
  const first = await reconstructApplicationUpdateRecords(sources, eligibility, { policy });
  const second = await reconstructApplicationUpdateRecords(sources.toReversed(), eligibility, {
    policy,
  });
  assert.deepEqual([...first.files], [...second.files]);
  assert.deepEqual(
    [...first.files.keys()],
    [
      "releases/0.9.0/windows-x86_64/nsis.json",
      "channels/preview/windows-x86_64/nsis/0.9.0.json",
      "releases/1.0.0/windows-x86_64/nsis.json",
      "channels/preview/windows-x86_64/nsis/1.0.0.json",
      "channels/stable/windows-x86_64/nsis/1.0.0.json",
      "reconstruction-manifest.json",
    ],
  );
  const releaseBytes = first.files.get("releases/1.0.0/windows-x86_64/nsis.json");
  const release = JSON.parse(releaseBytes);
  const stable = JSON.parse(first.files.get("channels/stable/windows-x86_64/nsis/1.0.0.json"));
  assert.equal(release.qualified_run.inventory_sha256, digest(sources[0].inventoryBytes));
  assert.equal(release.artifact.tauri_signature, "tauri-signature-1.0.0-windows-x86_64");
  assert.equal(release.artifact.payload_key_id, "c".repeat(64));
  assert.equal(stable.release_sha256, digest(releaseBytes));
  assert.equal(stable.release_path, "releases/1.0.0/windows-x86_64/nsis.json");
  assert.equal(stable.production_eligible, true);
  assert.equal(stable.eligible, true);
});

test("canonicalizes compatibility sets and evidence identifiers", async () => {
  const firstSource = source("0.9.1");
  firstSource.compatibility.required_capabilities = ["z-capability", "a-capability"];
  firstSource.compatibility.catalog_formats = [2, 1];
  firstSource.evidence_ids = ["z-evidence", "a-evidence"];
  const secondSource = {
    ...firstSource,
    compatibility: {
      ...firstSource.compatibility,
      required_capabilities: ["a-capability", "z-capability"],
      catalog_formats: [1, 2],
    },
    evidence_ids: ["a-evidence", "z-evidence"],
  };
  const eligibility = { "v0.9.1": evidence("0.9.1") };
  const first = await reconstructApplicationUpdateRecords([firstSource], eligibility, { policy });
  const second = await reconstructApplicationUpdateRecords([secondSource], eligibility, { policy });
  assert.deepEqual([...first.files], [...second.files]);
  const release = JSON.parse(first.files.get("releases/0.9.1/windows-x86_64/nsis.json"));
  assert.deepEqual(release.compatibility.required_capabilities, ["a-capability", "z-capability"]);
  assert.deepEqual(release.compatibility.catalog_formats, [1, 2]);
  assert.deepEqual(release.evidence_ids, ["a-evidence", "z-evidence"]);
});

test("emits explicit held and withdrawn promotions with bridges while Stable stays explicit", async () => {
  const held = await reconstructApplicationUpdateRecords(
    [source("1.2.0")],
    {
      "v1.2.0": evidence("1.2.0", {
        production_eligible: true,
        held: true,
        reason: "native package qualification is incomplete",
        bridges: {
          "windows-x86_64": {
            path: "bridges/windows-x86_64/v1.json",
            sha256: "f".repeat(64),
          },
        },
      }),
    },
    { policy },
  );
  for (const channel of ["preview", "stable"]) {
    const record = JSON.parse(held.files.get(`channels/${channel}/windows-x86_64/nsis/1.2.0.json`));
    assert.equal(record.eligible, false);
    assert.equal(record.withdrawn, false);
    assert.equal(record.reason, "native package qualification is incomplete");
    assert.equal(record.required_bridge.path, "bridges/windows-x86_64/v1.json");
  }
  const withdrawn = await reconstructApplicationUpdateRecords(
    [source("1.2.1")],
    {
      "v1.2.1": evidence("1.2.1", {
        withdrawn: true,
        reason: "release withdrawn after qualification",
      }),
    },
    { policy },
  );
  const preview = JSON.parse(
    withdrawn.files.get("channels/preview/windows-x86_64/nsis/1.2.1.json"),
  );
  assert.equal(preview.withdrawn, true);
  assert.equal(preview.eligible, false);
  assert.equal(withdrawn.files.has("channels/stable/windows-x86_64/nsis/1.2.1.json"), false);
});

test("fails closed on tampered inventories, signatures, eligibility, and ambiguous SemVer", async () => {
  const valid = source("0.8.0");
  const eligibility = { "v0.8.0": evidence("0.8.0") };
  const alteredSignature = { ...valid, signatureBytes: Buffer.from("different") };
  await assert.rejects(
    reconstructApplicationUpdateRecords([alteredSignature], eligibility, { policy }),
    /signature does not match/,
  );
  const inventory = JSON.parse(valid.inventoryBytes);
  inventory.untrusted = true;
  await assert.rejects(
    reconstructApplicationUpdateRecords(
      [{ ...valid, inventoryBytes: Buffer.from(JSON.stringify(inventory)) }],
      eligibility,
      { policy },
    ),
    /unknown field/,
  );
  await assert.rejects(
    reconstructApplicationUpdateRecords(
      [valid],
      { "v0.8.0": evidence("0.8.0", { preview_eligible: false }) },
      { policy },
    ),
    /inactive eligibility reason/,
  );
  await assert.rejects(
    reconstructApplicationUpdateRecords(
      [valid],
      { "v0.8.0": evidence("0.8.0", { production_eligible: true }) },
      { policy },
    ),
    /cannot be production eligible/,
  );
  const metadataTwin = source("0.8.0+rebuilt");
  await assert.rejects(
    reconstructApplicationUpdateRecords(
      [valid, metadataTwin],
      {
        "v0.8.0": evidence("0.8.0"),
        "v0.8.0+rebuilt": evidence("0.8.0+rebuilt"),
      },
      { policy },
    ),
    /duplicate SemVer precedence/,
  );
  await assert.rejects(
    reconstructApplicationUpdateRecords(
      [valid, source("0.8.0", "linux-x86_64", { source_tree: "f".repeat(40) })],
      eligibility,
      { policy },
    ),
    /span multiple source or qualified-run identities/,
  );
  assert.equal(compareApplicationVersionPrecedence("1.0.0-beta.9", "1.0.0-beta.10"), -1);
});

test("atomically repairs partial channel output but never rewrites or omits immutable releases", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "portcove-reconstruct-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const output = path.join(root, "generated");
  const older = source("0.9.0");
  const newer = source("1.0.0");
  const reconstruction = await reconstructApplicationUpdateRecords(
    [older, newer],
    {
      "v0.9.0": evidence("0.9.0"),
      "v1.0.0": evidence("1.0.0", { production_eligible: true }),
    },
    { policy },
  );
  assert.deepEqual(
    await writeApplicationUpdateReconstruction(output, reconstruction, { projectRoot: root }),
    { changed: true, output },
  );
  assert.equal(
    (await writeApplicationUpdateReconstruction(output, reconstruction, { projectRoot: root }))
      .changed,
    false,
  );
  const preview = path.join(output, "channels/preview/windows-x86_64/nsis/1.0.0.json");
  await writeFile(preview, "partial or interrupted promotion");
  await unlink(path.join(output, "channels/preview/windows-x86_64/nsis/0.9.0.json"));
  assert.equal(
    (await writeApplicationUpdateReconstruction(output, reconstruction, { projectRoot: root }))
      .changed,
    true,
  );
  assert.match(await readFile(preview, "utf8"), /"release_sha256"/);
  const immutable = path.join(output, "releases/1.0.0/windows-x86_64/nsis.json");
  await writeFile(immutable, "tampered immutable record");
  await assert.rejects(
    writeApplicationUpdateReconstruction(output, reconstruction, { projectRoot: root }),
    /immutable release record changed/,
  );

  await rm(output, { recursive: true });
  await writeApplicationUpdateReconstruction(output, reconstruction, { projectRoot: root });
  const incompleteHistory = await reconstructApplicationUpdateRecords(
    [newer],
    { "v1.0.0": evidence("1.0.0", { production_eligible: true }) },
    { policy },
  );
  await assert.rejects(
    writeApplicationUpdateReconstruction(output, incompleteHistory, { projectRoot: root }),
    /omitted immutable record/,
  );
  const unsafe = { files: new Map([["../outside.json", Buffer.from("unsafe")]]) };
  await assert.rejects(
    writeApplicationUpdateReconstruction(path.join(root, "unsafe"), unsafe, {
      projectRoot: root,
    }),
    /target path is unsafe/,
  );
  await assert.rejects(readFile(path.join(root, "outside.json")), /ENOENT/);
});

test("the documented CLI resolves descriptor inputs and verifies an identical retry", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "portcove-reconstruct-cli-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(path.join(root, "release"), { recursive: true });
  await mkdir(path.join(root, "inputs"));
  await writeFile(path.join(root, "release/package-policy.json"), JSON.stringify(policy));
  const qualified = source("0.9.0");
  await writeFile(path.join(root, "inputs/inventory.json"), qualified.inventoryBytes);
  await writeFile(path.join(root, "inputs/payload.sig"), qualified.signatureBytes);
  const descriptor = {
    schema_version: 1,
    releases: [
      {
        inventory: "inventory.json",
        signature: "payload.sig",
        source_tree: qualified.source_tree,
        qualified_run: qualified.qualified_run,
        execution_context: qualified.execution_context,
        compatibility: qualified.compatibility,
        evidence_ids: qualified.evidence_ids,
      },
    ],
  };
  const descriptorPath = path.join(root, "inputs/descriptor.json");
  const eligibilityPath = path.join(root, "inputs/eligibility.json");
  const output = path.join(root, "generated");
  await writeFile(descriptorPath, JSON.stringify(descriptor));
  await writeFile(eligibilityPath, JSON.stringify({ "v0.9.0": evidence("0.9.0") }));
  const arguments_ = [
    script,
    "--project-root",
    root,
    "--input",
    descriptorPath,
    "--eligibility",
    eligibilityPath,
    "--output",
    output,
  ];
  assert.match((await run(process.execPath, arguments_)).stdout, /^Reconstructed 2/);
  assert.match((await run(process.execPath, arguments_)).stdout, /^Verified 2/);
  assert.equal(
    JSON.parse(await readFile(path.join(output, "reconstruction-manifest.json"))).records.length,
    2,
  );
});
