import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { findStaleConsumerPins, githubOutputs, validateQualityManifest } from "./quality-tools.mjs";
import { runActionlint } from "./run-actionlint.mjs";
import { readToolPins } from "./tool-cache.mjs";

const manifest = JSON.parse(
  await readFile(new URL("../.github/quality-tools.json", import.meta.url)),
);

test("quality manifest owns exact unique Rust pins and workflow outputs", () => {
  assert.doesNotThrow(() => validateQualityManifest(manifest));
  assert.deepEqual(githubOutputs(manifest), {
    required_prebuilt: "just@1.58.0,cargo-shear@1.13.4,cargo-deny@0.20.2,cargo-nextest@0.9.100",
    required_all:
      "just@1.58.0,cargo-shear@1.13.4,cargo-deny@0.20.2,rscheck-cli@0.1.0,cargo-nextest@0.9.100",
    rscheck_spec: "rscheck-cli@0.1.0",
    semdup_spec: "semdup@0.2.0",
    hawk_version: "0.1.13",
    hawk_rust: "1.98.0",
  });
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
    ["stale:1 duplicates cargo-deny pin 0.20.2", "stale:1 duplicates cargo-deny pin 0.19.0"],
  );
  assert.deepEqual(findStaleConsumerPins(manifest, { copied: "cargo +1.98.0 hawk --version" }), [
    "copied:1 duplicates cargo-hawk pin 1.98.0",
  ]);
});

test("actionlint receives the exact aqua-managed ShellCheck path", () => {
  const calls = [];
  const run = (command, arguments_, options) => {
    calls.push({ command, arguments_, options });
    if (arguments_[0] === "which") return { status: 0, stdout: "C:\\aqua\\shellcheck.exe\r\n" };
    return { status: 0 };
  };
  assert.equal(runActionlint(["workflow.yml"], run).status, 0);
  assert.deepEqual(calls[1].arguments_, [
    "exec",
    "--",
    "actionlint",
    "-shellcheck=C:\\aqua\\shellcheck.exe",
    "workflow.yml",
  ]);
  assert.throws(
    () => runActionlint([], () => ({ status: 1, stdout: "" })),
    /aqua-managed ShellCheck executable is unavailable/,
  );
});

test("standalone lint pins use aqua checksums and PSResourceGet data", async () => {
  const aquaVersion = (await readFile(new URL("../.aqua-version", import.meta.url), "utf8")).trim();
  assert.match(aquaVersion, /^v\d+\.\d+\.\d+$/u);

  const aqua = await readFile(new URL("../aqua.yaml", import.meta.url), "utf8");
  assert.match(aqua, /^checksum:\r?\n {2}enabled: true\r?\n {2}require_checksum: true$/mu);
  const packages = [...aqua.matchAll(/^ {2}- name: ([^@\s]+)@([^\s]+)$/gmu)].map(
    ([, name, version]) => ({ name, version }),
  );
  assert.deepEqual(
    packages.map(({ name }) => name),
    ["astral-sh/ruff", "rhysd/actionlint", "koalaman/shellcheck"],
  );
  for (const { version } of packages) assert.match(version, /^v?\d+\.\d+\.\d+$/u);

  const lock = JSON.parse(
    await readFile(new URL("../aqua-checksums.json", import.meta.url), "utf8"),
  );
  const ids = lock.checksums.map(({ id }) => id);
  assert.equal(new Set(ids).size, ids.length);
  for (const entry of lock.checksums) {
    assert.match(entry.checksum, /^[A-F0-9]{64}$/u);
    assert.equal(entry.algorithm, "sha256");
  }
  for (const identity of ["astral-sh/ruff", "rhysd/actionlint", "koalaman/shellcheck"])
    for (const platform of ["windows", "linux", "darwin"])
      assert.ok(
        ids.some(
          (id) =>
            id.includes(identity) &&
            (id.includes(platform) ||
              (identity === "koalaman/shellcheck" &&
                platform === "windows" &&
                id.endsWith(".zip"))),
        ),
        `${identity} has no ${platform} checksum`,
      );

  const resources = await readFile(
    new URL("../.config/powershell-resources.psd1", import.meta.url),
    "utf8",
  );
  assert.match(resources, /PSScriptAnalyzer/u);
  assert.match(resources, /version\s*=\s*'\d+\.\d+\.\d+'/u);

  const manager = await readFile(new URL("./quality-tools.mjs", import.meta.url), "utf8");
  assert.doesNotMatch(manager, /install-managed|PORTCOVE_QUALITY_TOOLS_DIR|managedToolPath/u);
});

test("bootstrap pins use verified official Windows download origins", () => {
  const pins = readToolPins();
  assert.equal(
    pins.bootstrap.aqua.release_base,
    "https://github.com/aquaproj/aqua/releases/download",
  );
  assert.equal(pins.bootstrap.desktop.edge_driver_base, "https://msedgedriver.microsoft.com");
  assert.match(pins.bootstrap.desktop.tauri_driver, /^\d+\.\d+\.\d+$/u);
  for (const artifact of Object.values(pins.bootstrap.aqua.artifacts))
    assert.match(artifact.sha256, /^[A-F0-9]{64}$/u);
});
