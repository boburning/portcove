import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { lstat, opendir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { fileIdentity } from "./development-evidence.mts";
import { readBoundedPublicBuildInputFile } from "./release-public-build-inputs.mts";
import { assertOwnedUnlinkedPath } from "./release-path-safety.mts";
import { errorCode, isRecord } from "./runtime-values.mts";
import {
  readInstalledGameCliReceipt,
  seedInstalledGameData,
  observeInstalledGameData,
  assertInstalledGameDataPreserved,
  saveInstalledGameLibraryChoice,
  type InstalledGameFixtureOptions,
} from "./installed-game-data-fixture.mts";

function text(value: unknown): string {
  assert.ok(typeof value === "string" && value.length > 0);
  return value;
}

/** Fixture-only admission. Config hashes/source claims grant no release authority. */
export async function readWindowsInstalledGameDataConfiguration(
  filename: string,
  sha256: string,
  library: string,
  environment: NodeJS.ProcessEnv,
) {
  assert.ok(path.isAbsolute(filename) && path.isAbsolute(library));
  assert.match(sha256, /^[a-f0-9]{64}$/u);
  const ownedRoot = path.dirname(filename);
  const bytes = await readBoundedPublicBuildInputFile(ownedRoot, path.basename(filename), 65_536);
  assert.equal(createHash("sha256").update(bytes).digest("hex"), sha256);
  const config: unknown = JSON.parse(bytes.toString());
  assert.ok(isRecord(config));
  assert.deepEqual(Object.keys(config).sort(), [
    "cli_receipt",
    "cli_source_commit",
    "library",
    "preferences_path",
    "schema_version",
  ]);
  assert.equal(config.schema_version, 1);
  assert.equal(
    text(config.library),
    library,
    "Configuration must name the installer's original library",
  );
  await assertOwnedUnlinkedPath(ownedRoot, library, "installer game library");
  assert.equal(environment.PORTCOVE_PREFERENCES, text(config.preferences_path));
  await assertOwnedUnlinkedPath(
    ownedRoot,
    text(config.preferences_path),
    "private host preferences",
  );
  for (const name of ["APPDATA", "LOCALAPPDATA"])
    await assertOwnedUnlinkedPath(ownedRoot, text(environment[name]), `private ${name}`);
  const selected = await readInstalledGameCliReceipt(
    ownedRoot,
    text(config.cli_receipt),
    text(config.cli_source_commit),
  );
  assert.equal(
    selected.receipt.archive && isRecord(selected.receipt.archive) && selected.receipt.archive.id,
    "cli-windows-x86_64-zip",
  );
  return {
    ownedRoot,
    config,
    selected,
    preferences: text(config.preferences_path),
    playerRoot: path.join(text(environment.APPDATA), "OpenTyrian"),
  };
}

/** Prove private stores start empty before the installer or any Core mutation. */
export async function assertFreshWindowsInstalledGameStores(
  environment: NodeJS.ProcessEnv,
  preferences: string,
) {
  for (const name of ["APPDATA", "LOCALAPPDATA"]) {
    for await (const entry of await opendir(text(environment[name]))) {
      assert.fail(`Private ${name} must start empty; found ${entry.name}`);
    }
  }
  const prior = await lstat(preferences).catch((error: unknown) => {
    if (errorCode(error) !== "ENOENT") throw error;
    return null;
  });
  assert.equal(prior, null, "Private host preference file must be absent before qualification");
}

async function run() {
  assert.equal(process.platform, "win32", "This adapter belongs to the Windows installer fixture");
  const { values } = parseArgs({
    options: Object.fromEntries(
      ["phase", "configuration", "sha256", "library"].map(
        (name) => [name, { type: "string" }] as const,
      ),
    ),
  });
  const phase = text(values.phase);
  assert.ok(["admit", "seed", "after-uninstall"].includes(phase));
  const configSha256 = text(values.sha256);
  const admitted = await readWindowsInstalledGameDataConfiguration(
    text(values.configuration),
    configSha256,
    text(values.library),
    process.env,
  );
  const baselinePath = path.join(admitted.ownedRoot, "game-data-baseline.json");
  await assertOwnedUnlinkedPath(admitted.ownedRoot, baselinePath, "game-data baseline");
  if (phase !== "after-uninstall") {
    const prior = await lstat(baselinePath).catch((error: unknown) => {
      if (errorCode(error) !== "ENOENT") throw error;
      return null;
    });
    assert.equal(prior, null, "Game-data baseline must be new; no reseeding");
  }
  if (phase === "admit") {
    await assertFreshWindowsInstalledGameStores(process.env, admitted.preferences);
    console.log(
      JSON.stringify({ phase, configuration_sha256: configSha256, cli: admitted.selected.receipt }),
    );
    return;
  }
  const evidencePath = path.join(admitted.ownedRoot, `game-data-${phase}.json`);
  await assertOwnedUnlinkedPath(admitted.ownedRoot, evidencePath, "game-data evidence");
  const events: Array<{ phase: string; details: unknown }> = [];
  const report: Record<string, unknown> = {
    phase: "running",
    configuration_sha256: configSha256,
    cli: admitted.selected.receipt,
    events,
    credential_scope:
      "Normal Core fixed Windows OS store is not isolated by these paths; credential continuity not_evaluated",
    scope:
      "Original game files and normally saved library choice across the installer fixture; no gameplay or raw database-preimage claim",
  };
  await writeFile(evidencePath, JSON.stringify(report, null, 2) + "\n", {
    flag: "wx",
    mode: 0o600,
  });
  const save = () => writeFile(evidencePath, JSON.stringify(report, null, 2) + "\n");
  const options: InstalledGameFixtureOptions = {
    ownedRoot: admitted.ownedRoot,
    library: text(values.library),
    playerRoot: admitted.playerRoot,
    cli: admitted.selected.cli.path,
    cliSha256: admitted.selected.cli.sha256,
    cliVersion: admitted.selected.cli.version,
    cliSourceCommit: text(admitted.config.cli_source_commit),
    platform: "windows-x86_64",
    environment: { ...process.env },
    record: async (event) => {
      events.push(event);
      await save();
    },
  };
  try {
    if (phase === "seed") {
      await saveInstalledGameLibraryChoice(options);
      const prepared = await seedInstalledGameData(options);
      const preferences = await fileIdentity(admitted.preferences, { maxBytes: 65_536 });
      report.prepared = prepared;
      report.preferences = preferences;
      await writeFile(
        baselinePath,
        JSON.stringify({ configuration_sha256: configSha256, prepared, preferences }, null, 2) +
          "\n",
        { flag: "wx", mode: 0o600 },
      );
    } else {
      const baseline: unknown = JSON.parse(
        (
          await readBoundedPublicBuildInputFile(
            admitted.ownedRoot,
            path.basename(baselinePath),
            16 * 1024 * 1024,
          )
        ).toString(),
      );
      assert.ok(
        isRecord(baseline) && isRecord(baseline.prepared) && isRecord(baseline.preferences),
      );
      assert.equal(baseline.configuration_sha256, configSha256);
      // This file was emitted by the same private fixture. Runtime admission and
      // exact comparisons still execute in the shared observer before Core status.
      const prepared = baseline.prepared as Awaited<ReturnType<typeof seedInstalledGameData>>;
      const preferences = await fileIdentity(admitted.preferences, { maxBytes: 65_536 });
      report.preferences = preferences;
      await save();
      const after = await observeInstalledGameData(options, prepared.baseline.installed);
      report.after = after;
      await save();
      assertInstalledGameDataPreserved(prepared.baseline, after);
      assert.equal(preferences.bytes, baseline.preferences.bytes);
      assert.equal(preferences.sha256, baseline.preferences.sha256);
    }
    report.phase = "complete";
    await save();
    console.log(JSON.stringify({ phase, result: "complete", evidence: evidencePath }));
  } catch (error) {
    report.phase = "failed";
    report.failure = error instanceof Error ? error.message : String(error);
    await save();
    throw error;
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1]))
  await run();
