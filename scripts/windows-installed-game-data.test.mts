import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { disposableDirectory } from "./fixtures/disposable-directory.mts";
import {
  assertFreshWindowsInstalledGameStores,
  readWindowsInstalledGameDataConfiguration,
} from "./windows-installed-game-data.mts";

async function fixture(context: Parameters<typeof disposableDirectory>[0]) {
  const root = disposableDirectory(context, path.join(os.tmpdir(), "pcv-windows-game-data-"));
  const library = path.join(root, "library");
  const roaming = path.join(root, "roaming");
  const local = path.join(root, "local");
  for (const directory of [library, roaming, local]) await mkdir(directory);
  const cli = path.join(root, "inert-cli");
  const cliBytes = Buffer.from("Inert CLI; configuration admission must never execute this");
  await writeFile(cli, cliBytes);
  const receipt = path.join(root, "predecessor-cli.json");
  await writeFile(
    receipt,
    JSON.stringify({
      schema_version: 1,
      source_commit: "a".repeat(40),
      version: "0.1.0",
      cli: {
        path: cli,
        bytes: cliBytes.length,
        sha256: createHash("sha256").update(cliBytes).digest("hex"),
      },
      archive: {
        id: "cli-windows-x86_64-zip",
        filename: "portcove-cli.zip",
        bytes: 25,
        sha256: "b".repeat(64),
      },
    }),
  );
  const preferences = path.join(root, "preferences.json");
  const configuration = path.join(root, "configuration.json");
  const bytes = Buffer.from(
    JSON.stringify({
      schema_version: 1,
      cli_receipt: receipt,
      cli_source_commit: "a".repeat(40),
      library,
      preferences_path: preferences,
    }),
  );
  await writeFile(configuration, bytes);
  return {
    root,
    library,
    configuration,
    sha256: createHash("sha256").update(bytes).digest("hex"),
    environment: { APPDATA: roaming, LOCALAPPDATA: local, PORTCOVE_PREFERENCES: preferences },
  };
}

void test("Windows game-data configuration binds the original installer library and private stores before execution", async (context) => {
  const input = await fixture(context);
  const admitted = await readWindowsInstalledGameDataConfiguration(
    input.configuration,
    input.sha256,
    input.library,
    input.environment,
  );
  assert.equal(admitted.ownedRoot, input.root);
  assert.equal(admitted.selected.cli.version, "0.1.0");
  assert.equal(admitted.playerRoot, path.join(input.environment.APPDATA, "OpenTyrian"));
});

void test("Windows game-data admission refuses changed configuration and unrelated original library", async (context) => {
  const input = await fixture(context);
  await assert.rejects(
    readWindowsInstalledGameDataConfiguration(
      input.configuration,
      "c".repeat(64),
      input.library,
      input.environment,
    ),
  );
  await assert.rejects(
    readWindowsInstalledGameDataConfiguration(
      input.configuration,
      input.sha256,
      path.join(input.root, "different-library"),
      input.environment,
    ),
  );
});

void test("Windows game-data admission refuses personal roaming/local/preferences outside its owned fixture", async (context) => {
  const input = await fixture(context);
  for (const name of ["APPDATA", "LOCALAPPDATA", "PORTCOVE_PREFERENCES"]) {
    await assert.rejects(
      readWindowsInstalledGameDataConfiguration(input.configuration, input.sha256, input.library, {
        ...input.environment,
        [name]: os.homedir(),
      }),
    );
  }
});

void test("Windows fixture preflight refuses existing data before any installer or Core mutation", async (context) => {
  const input = await fixture(context);
  await assertFreshWindowsInstalledGameStores(
    input.environment,
    input.environment.PORTCOVE_PREFERENCES,
  );
  await writeFile(path.join(input.environment.APPDATA, "existing-save"), "preserve");
  await assert.rejects(
    assertFreshWindowsInstalledGameStores(
      input.environment,
      input.environment.PORTCOVE_PREFERENCES,
    ),
    /must start empty/u,
  );
  const other = await fixture(context);
  await writeFile(other.environment.PORTCOVE_PREFERENCES, "existing preferences");
  await assert.rejects(
    assertFreshWindowsInstalledGameStores(
      other.environment,
      other.environment.PORTCOVE_PREFERENCES,
    ),
    /must be absent/u,
  );
});
