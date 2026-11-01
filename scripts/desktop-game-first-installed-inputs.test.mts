import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  gameFirstInstalledArgumentNames,
  parseGameFirstInstalledInputPaths,
  parseGameFirstInstalledMetadata,
  prepareGameFirstInstalledInputs,
  verifyGameFirstInstalledInputs,
} from "./desktop-game-first-installed-inputs.mts";

const digest = (bytes: Buffer) => ({
  bytes: bytes.length,
  sha256: createHash("sha256").update(bytes).digest("hex"),
});
// Deliberately inert synthetic bytes: these tests never read originals or execute a runtime.
async function fixture(
  action: (fixture: Awaited<ReturnType<typeof createFixture>>) => Promise<void>,
) {
  const current = await createFixture();
  try {
    await action(current);
  } finally {
    await rm(current.root, { recursive: true, force: true });
  }
}
async function createFixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), "portcove-picori-inputs-"));
  const output = path.join(root, "output");
  await mkdir(output);
  const buffers = {
    source: Buffer.from("synthetic original bytes"),
    runtime: Buffer.from("inert runtime bytes"),
    shapes: Buffer.from('{"synthetic":true}'),
    logic: Buffer.from("synthetic logic"),
    archive: Buffer.from("inert archive provenance bytes"),
  };
  const inputPaths = {
    metadata: path.join(root, "metadata.json"),
    source: path.join(root, "source.bin"),
    runtime: path.join(root, "runtime.bin"),
    shapes: path.join(root, "shapes.bin"),
    logic: path.join(root, "logic.bin"),
    archive: path.join(root, "archive.bin"),
  };
  for (const name of ["source", "runtime", "shapes", "logic", "archive"] as const)
    await writeFile(inputPaths[name], buffers[name], { flag: "wx" });
  const metadata = {
    format_version: 1,
    port_id: "project-picori",
    source_profile: "minish-cap-gba",
    upstream_release: "synthetic-v1",
    archive: digest(buffers.archive),
    source: {
      ...digest(buffers.source),
      sha1: createHash("sha1").update(buffers.source).digest("hex"),
    },
    runtime_files: [
      { path: "tmc_pc.exe", ...digest(buffers.runtime) },
      { path: "voxel_shapes.json", ...digest(buffers.shapes) },
      { path: "assets/rando/default.logic", ...digest(buffers.logic) },
    ],
  };
  await writeFile(inputPaths.metadata, JSON.stringify(metadata), { flag: "wx" });
  return { root, output, buffers, inputPaths, metadata };
}

void test("Picori captured argument paths require all six absolute files", () => {
  const values = Object.fromEntries(
    gameFirstInstalledArgumentNames.map((name) => [name, path.resolve(name)]),
  );
  assert.equal(parseGameFirstInstalledInputPaths(values).metadata, values["game-first-inputs"]);
  for (const name of gameFirstInstalledArgumentNames) {
    assert.throws(() => parseGameFirstInstalledInputPaths({ ...values, [name]: undefined }));
    assert.throws(() => parseGameFirstInstalledInputPaths({ ...values, [name]: "relative" }));
  }
});
void test("Picori metadata rejects extra authority, aliases, duplicate paths and nonfinite/oversized bytes", async () =>
  fixture(async ({ metadata }) => {
    assert.equal(parseGameFirstInstalledMetadata(metadata).upstream_release, "synthetic-v1");
    for (const change of [
      { port_id: "another-port" },
      { source_profile: "another-profile" },
      { format_version: 2 },
      { install_id: "manufactured" },
      { upstream_release: "../private" },
      { archive: { ...metadata.archive, bytes: Infinity } },
      { source: { ...metadata.source, bytes: 33 * 1024 ** 2 } },
      { source: { ...metadata.source, sha1: "0" } },
      { runtime_files: metadata.runtime_files.map((row) => ({ ...row, path: "../escape" })) },
      {
        runtime_files: [
          metadata.runtime_files[0],
          metadata.runtime_files[0],
          metadata.runtime_files[2],
        ],
      },
      { runtime_files: metadata.runtime_files.slice(1) },
      { archive: { ...metadata.archive, sha256: "G".repeat(64) } },
    ])
      assert.throws(() => parseGameFirstInstalledMetadata({ ...metadata, ...change }));
  }));
void test("Picori preparation copies exactly three runtime files and baserom into fresh owned folders", async () =>
  fixture(async ({ output, buffers, inputPaths }) => {
    const prepared = await prepareGameFirstInstalledInputs(inputPaths, output);
    assert.equal(prepared.metadata.upstream_release, "synthetic-v1");
    assert.equal(path.basename(prepared.sourceDirectory), "selected-setup-inputs");
    for (const [relative, buffer] of [
      ["tmc_pc.exe", buffers.runtime],
      ["voxel_shapes.json", buffers.shapes],
      ["assets/rando/default.logic", buffers.logic],
      ["baserom.gba", buffers.source],
    ] as const)
      assert.deepEqual(await readFile(path.join(prepared.runtimeDirectory, relative)), buffer);
    assert.deepEqual(await readFile(prepared.source), buffers.source);
    await verifyGameFirstInstalledInputs(inputPaths, prepared.metadata, prepared.metadataIdentity);
    await assert.rejects(prepareGameFirstInstalledInputs(inputPaths, output), /EEXIST/u);
  }));
void test("Picori preparation rejects same-size corruption and source SHA1 mismatch", async () => {
  await fixture(async ({ inputPaths, output, buffers }) => {
    await writeFile(inputPaths.runtime, Buffer.alloc(buffers.runtime.length, 88));
    await assert.rejects(prepareGameFirstInstalledInputs(inputPaths, output), /SHA256 differs/u);
  });
  await fixture(async ({ inputPaths, output, metadata }) => {
    await writeFile(
      inputPaths.metadata,
      JSON.stringify({ ...metadata, source: { ...metadata.source, sha1: "0".repeat(40) } }),
    );
    await assert.rejects(prepareGameFirstInstalledInputs(inputPaths, output), /SHA1 differs/u);
  });
});
void test("Picori preparation rejects a linked input ancestor and a nonregular source", async () => {
  await fixture(async ({ root, inputPaths, output }) => {
    const link = path.join(root, "linked-inputs");
    await symlink(root, link, process.platform === "win32" ? "junction" : "dir");
    await assert.rejects(
      prepareGameFirstInstalledInputs(
        { ...inputPaths, runtime: path.join(link, "runtime.bin") },
        output,
      ),
      /symbolic links/u,
    );
  });
  await fixture(async ({ inputPaths, output }) => {
    await rm(inputPaths.source);
    await mkdir(inputPaths.source);
    await assert.rejects(
      prepareGameFirstInstalledInputs(inputPaths, output),
      /size\/type changed/u,
    );
  });
});
void test("Picori post-run baseline verifies metadata and every captured input including archive", async () => {
  for (const name of ["metadata", "source", "runtime", "shapes", "logic", "archive"] as const) {
    await fixture(async ({ inputPaths, output }) => {
      const prepared = await prepareGameFirstInstalledInputs(inputPaths, output);
      const bytes = await readFile(inputPaths[name]);
      bytes[0] = bytes[0] === 88 ? 89 : 88;
      await writeFile(inputPaths[name], bytes);
      await assert.rejects(
        verifyGameFirstInstalledInputs(inputPaths, prepared.metadata, prepared.metadataIdentity),
      );
    });
  }
});
