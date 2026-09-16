import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  commandFor,
  findStaleConsumerPins,
  githubOutputs,
  validateQualityManifest,
} from "./quality-tools.mjs";
import {
  parseAquaConfig,
  parseReleaseChecksumId,
  requireStableNonReleaseEntries,
  validateAquaChecksumLedger,
  verifyPublisherDigests,
} from "./aqua-integrity.mjs";
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
    hawk_rust: "1.98.1",
  });
  const hawk = manifest.tools.find((tool) => tool.id === "cargo-hawk");
  assert.deepEqual(commandFor(manifest, hawk), ["cargo", "+1.98.1", "hawk", "--version"]);
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
  assert.deepEqual(findStaleConsumerPins(manifest, { copied: "cargo +1.98.1 hawk --version" }), [
    "copied:1 duplicates cargo-hawk pin 1.98.1",
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
  validateAquaChecksumLedger(parseAquaConfig(aqua), lock);
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

test("Aqua integrity rejects stale, incomplete, unexpected and untrusted package checksums", async () => {
  const aqua = await readFile(new URL("../aqua.yaml", import.meta.url), "utf8");
  const config = parseAquaConfig(aqua);
  const ledger = JSON.parse(
    await readFile(new URL("../aqua-checksums.json", import.meta.url), "utf8"),
  );
  const entries = validateAquaChecksumLedger(config, ledger);

  const missing = structuredClone(ledger);
  missing.checksums.splice(0, 1);
  assert.throws(() => validateAquaChecksumLedger(config, missing), /missing:/u);

  const stale = structuredClone(ledger);
  stale.checksums[0].id = stale.checksums[0].id.replace("/0.16.7/", "/0.16.6/");
  assert.throws(
    () => validateAquaChecksumLedger(config, stale),
    /missing:.*0\.16\.7.*unexpected:.*0\.16\.6/u,
  );

  const duplicate = structuredClone(ledger);
  duplicate.checksums.push(structuredClone(duplicate.checksums[0]));
  assert.throws(() => validateAquaChecksumLedger(config, duplicate), /contains duplicates/u);

  const unexpected = structuredClone(ledger);
  unexpected.checksums.push({
    id: "github_release/github.com/astral-sh/ruff/0.16.7/ruff-unreviewed-platform.zip",
    checksum: "A".repeat(64),
    algorithm: "sha256",
  });
  assert.throws(() => validateAquaChecksumLedger(config, unexpected), /unexpected:/u);

  const releases = {};
  for (const entry of entries) {
    const identity = parseReleaseChecksumId(entry.id);
    const key = `${identity.name}@${identity.version}`;
    releases[key] ??= { tag_name: identity.version, assets: [] };
    releases[key].assets.push({
      name: identity.asset,
      digest: `sha256:${entry.checksum.toLowerCase()}`,
    });
  }
  assert.doesNotThrow(() => verifyPublisherDigests(entries, releases));
  releases["astral-sh/ruff@0.16.7"].assets[0].digest = `sha256:${"0".repeat(64)}`;
  assert.throws(
    () => verifyPublisherDigests(entries, releases),
    /publisher SHA-256 digest differs/u,
  );

  const changedRegistry = structuredClone(ledger);
  changedRegistry.checksums.at(-1).checksum = "B".repeat(64);
  assert.throws(
    () => requireStableNonReleaseEntries(ledger, changedRegistry),
    /review it separately/u,
  );
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
