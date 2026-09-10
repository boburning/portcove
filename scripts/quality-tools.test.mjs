import assert from "node:assert/strict";
import {
  mkdtemp,
  mkdir,
  readFile,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import {
  activateStaging,
  findStaleConsumerPins,
  githubOutputs,
  managedToolPath,
  platformKey,
  validateArchiveEntries,
  validateQualityManifest,
  verifySha256,
} from "./quality-tools.mjs";

const manifest = JSON.parse(
  await readFile(new URL("../.github/quality-tools.json", import.meta.url)),
);

test("quality manifest owns exact unique pins and workflow outputs", () => {
  assert.doesNotThrow(() => validateQualityManifest(manifest));
  assert.deepEqual(githubOutputs(manifest), {
    required_prebuilt:
      "just@1.58.0,cargo-shear@1.13.4,cargo-deny@0.20.2,cargo-nextest@0.9.100",
    required_all:
      "just@1.58.0,cargo-shear@1.13.4,cargo-deny@0.20.2,rscheck-cli@0.1.0,cargo-nextest@0.9.100",
    rscheck_spec: "rscheck-cli@0.1.0",
    semdup_spec: "semdup@0.2.0",
    hawk_version: "0.1.13",
    hawk_rust: "1.98.0",
  });
});

test("managed quality manifest validation rejects incomplete platform coverage", () => {
  const incomplete = structuredClone(manifest);
  delete incomplete.tools.find((tool) => tool.id === "ruff").install.assets[
    "linux-x64"
  ];
  assert.throws(
    () => validateQualityManifest(incomplete),
    /do not cover the required platforms/,
  );
  const portablePowerShell = structuredClone(manifest);
  delete portablePowerShell.tools.find((tool) => tool.id === "psscriptanalyzer")
    .install.platform_limited;
  assert.throws(
    () => validateQualityManifest(portablePowerShell),
    /must be platform-limited/,
  );
});

test("stale consumer detection rejects copied current or divergent pins", () => {
  assert.deepEqual(
    findStaleConsumerPins(manifest, {
      clean: "tool: ${{ steps.pins.outputs.required }}",
    }),
    [],
  );
  assert.deepEqual(
    findStaleConsumerPins(manifest, {
      stale: "tool: cargo-deny@0.20.2,cargo-deny@0.19.0",
    }),
    [
      "stale:1 duplicates cargo-deny pin 0.20.2",
      "stale:1 duplicates cargo-deny pin 0.19.0",
    ],
  );
  assert.deepEqual(
    findStaleConsumerPins(manifest, { copied: "cargo +1.98.0 hawk --version" }),
    ["copied:1 duplicates cargo-hawk pin 1.98.0"],
  );
});

test("managed quality tools use explicit supported platform identities and safe paths", () => {
  assert.equal(platformKey("win32", "x64"), "win32-x64");
  assert.equal(platformKey("darwin", "arm64"), "darwin-arm64");
  assert.equal(platformKey("linux", "riscv64"), "linux-riscv64");
  for (const entry of [
    "../tool",
    "/absolute/tool",
    "C:\\absolute\\tool",
    "safe/../../tool",
    "bad\0tool",
    "",
  ]) {
    assert.throws(
      () => validateArchiveEntries([entry]),
      /unsafe archive entry/,
    );
  }
  assert.doesNotThrow(() =>
    validateArchiveEntries(["tool", "nested/tool.exe"]),
  );

  const ruff = manifest.tools.find((tool) => tool.id === "ruff");
  assert.equal(
    managedToolPath(ruff, path.join("cache", "tools"), "linux-x64"),
    path.join("cache", "tools", "ruff", ruff.version, "linux-x64", "ruff"),
  );
  assert.throws(
    () => managedToolPath(ruff, path.join("cache", "tools"), "linux-riscv64"),
    /does not support/,
  );
});

test("managed quality tool checksums fail closed", () => {
  const contents = Buffer.from("verified fixture");
  const expected =
    "f9adb7d924ed98c558040c910600d7363d749e7d20e8d355626edd53b4fb929f";
  assert.equal(verifySha256(contents, expected), expected);
  assert.throws(
    () => verifySha256(contents, "0".repeat(64)),
    /asset checksum mismatch/,
  );
});

test("managed quality tool activation replaces only a complete staging directory", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "portcove-quality-tools-"));
  const target = path.join(root, "target");
  const staging = path.join(root, "staging");
  try {
    await mkdir(target);
    await writeFile(path.join(target, "old.txt"), "old");
    await mkdir(staging);
    await writeFile(path.join(staging, "new.txt"), "new");
    await activateStaging(staging, target);
    assert.equal(await readFile(path.join(target, "new.txt"), "utf8"), "new");
    await assert.rejects(readFile(path.join(target, "old.txt")), /ENOENT/);
    await assert.rejects(
      activateStaging(path.join(root, "missing"), target),
      /staged quality tool is missing/,
    );
    assert.equal(await readFile(path.join(target, "new.txt"), "utf8"), "new");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("managed quality tool activation restores the prior version after an interrupted replacement", async () => {
  const root = await mkdtemp(
    path.join(tmpdir(), "portcove-quality-tools-interrupted-"),
  );
  const target = path.join(root, "target");
  const staging = path.join(root, "staging");
  try {
    await mkdir(target);
    await writeFile(path.join(target, "old.txt"), "old");
    await mkdir(staging);
    await writeFile(path.join(staging, "new.txt"), "new");
    let calls = 0;
    const interruptSecondRename = async (source, destination) => {
      calls += 1;
      if (calls === 2) throw new Error("simulated activation interruption");
      await rename(source, destination);
    };
    await assert.rejects(
      activateStaging(staging, target, interruptSecondRename),
      /simulated activation interruption/,
    );
    assert.equal(await readFile(path.join(target, "old.txt"), "utf8"), "old");
    assert.equal(await readFile(path.join(staging, "new.txt"), "utf8"), "new");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
