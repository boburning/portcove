import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { disposableDirectory } from "./fixtures/disposable-directory.mts";
import {
  readInstalledGameFixture,
  assertSavedInstalledGameLibraryChoice,
  readInstalledGameCliReceipt,
  observeInstalledGameData,
  seedInstalledGameData,
  type InstalledGameFixtureOptions,
} from "./installed-game-data-fixture.mts";

async function options(context: Parameters<typeof disposableDirectory>[0]) {
  const ownedRoot = disposableDirectory(context, path.join(os.tmpdir(), "pcv-real-game-data-"));
  const library = path.join(ownedRoot, "library");
  const config = path.join(ownedRoot, "config");
  await mkdir(library);
  await mkdir(config);
  const cli = path.join(ownedRoot, "inert-cli");
  const bytes = Buffer.from("Inert bytes: this control must never execute a CLI");
  await writeFile(cli, bytes);
  const value: InstalledGameFixtureOptions = {
    ownedRoot,
    library,
    playerRoot: path.join(config, process.platform === "win32" ? "OpenTyrian" : "opentyrian"),
    cli,
    cliSha256: createHash("sha256").update(bytes).digest("hex"),
    cliVersion: "0.1.0",
    cliSourceCommit: "a".repeat(40),
    platform: process.platform === "win32" ? "windows-x86_64" : "linux-x86_64",
    environment: { ...process.env, XDG_CONFIG_HOME: config, APPDATA: config },
    record: async () => {
      throw new Error("Refusal must precede a Core observation or mutation");
    },
  };
  return value;
}

void test("installed-game fixture admits exactly the three provenance-bound game-authored files", async () => {
  const fixture = await readInstalledGameFixture();
  assert.deepEqual(
    fixture.files.map(({ name, bytes, sha256 }) => ({ name, bytes: bytes.length, sha256 })),
    [
      {
        name: "opentyrian.cfg",
        bytes: 313,
        sha256: "3e6f6b90a9e5e7fb4c64df0d7653f534440b8dc21f671ff73550ee409a05bff6",
      },
      {
        name: "tyrian.cfg",
        bytes: 28,
        sha256: "3fb31a744ea76ac3862ec07b9d75276263c4e0f3867c1c8074ad96a802c63107",
      },
      {
        name: "tyrian.sav",
        bytes: 2502,
        sha256: "bcc134793513e0c2abc7c2dc7a9781bc99a2e623185b3293903ad1aab9d71c3e",
      },
    ],
  );
});

void test("game-data seeding refuses an existing player store before executing the CLI", async (context) => {
  const input = await options(context);
  await mkdir(input.playerRoot);
  await assert.rejects(seedInstalledGameData(input), /Player store must be new/u);
});

void test("game-data observation rejects an original runtime link before canonicalization or Core access", async (context) => {
  const input = await options(context);
  const actual = path.join(input.library, "actual");
  const link = path.join(input.library, "linked");
  await mkdir(actual);
  await symlink(actual, link, process.platform === "win32" ? "junction" : "dir");
  await assert.rejects(
    observeInstalledGameData(input, { id: "owned", path: link }),
    /symbolic-link|reparse-point/u,
  );
});

void test("post-uninstall game files must exist before any Core command can reconcile state", async (context) => {
  const input = await options(context);
  await assert.rejects(
    observeInstalledGameData(input, { id: "owned", path: path.join(input.library, "missing") }),
    (error: unknown) => error instanceof Error && "code" in error && error.code === "ENOENT",
  );
});

void test("retained CLI receipt joins source and exact inert binary before native use", async (context) => {
  const input = await options(context);
  const filename = path.join(input.ownedRoot, "predecessor-cli.json");
  const receipt = {
    schema_version: 1,
    source_commit: input.cliSourceCommit,
    version: input.cliVersion,
    cli: {
      path: input.cli,
      bytes: Buffer.byteLength("Inert bytes: this control must never execute a CLI"),
      sha256: input.cliSha256,
    },
    archive: {
      id: "cli-linux-x86_64-tar-gz",
      filename: "portcove-cli.tar.gz",
      bytes: 20,
      sha256: "b".repeat(64),
    },
  };
  await writeFile(filename, JSON.stringify(receipt));
  const admitted = await readInstalledGameCliReceipt(
    input.ownedRoot,
    filename,
    input.cliSourceCommit,
  );
  assert.equal(admitted.cli.sha256, input.cliSha256);
  assert.equal(admitted.cli.version, "0.1.0");
  await assert.rejects(readInstalledGameCliReceipt(input.ownedRoot, filename, "c".repeat(40)));
  await writeFile(input.cli, "changed inert bytes");
  await assert.rejects(
    readInstalledGameCliReceipt(input.ownedRoot, filename, input.cliSourceCommit),
  );
});

void test("saved library preference requires positive Core status, saved source and exact canonical root", () => {
  const root = path.resolve(os.tmpdir(), "owned-library");
  assertSavedInstalledGameLibraryChoice({ ok: true, data: { root, source: "saved" } }, root);
  for (const value of [
    { ok: false, data: { root, source: "saved" } },
    { ok: true, data: { root, source: "environment" } },
    { ok: true, data: { root: path.resolve(os.tmpdir(), "other-library"), source: "saved" } },
  ])
    assert.throws(() => assertSavedInstalledGameLibraryChoice(value, root));
});
