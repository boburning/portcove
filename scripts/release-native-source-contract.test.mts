import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  nativeCompatibilitySourcePaths,
  inspectNativeCompatibilitySources,
} from "./release-native-source-contract.mts";
import { readActualNativeSourceDeclarations } from "./release-native-candidate.mts";

void test("actual maintained source recipe supplies declarations without runtime or admission authority", async () => {
  const files: Record<string, Buffer> = Object.fromEntries(
    await Promise.all(
      nativeCompatibilitySourcePaths.map(
        async (name) => [name, await readFile(new URL(`../${name}`, import.meta.url))] as const,
      ),
    ),
  );
  const result = inspectNativeCompatibilitySources(files);
  assert.deepEqual(result.cli_protocol, { min: 77, max: 77 });
  assert.deepEqual(result.catalog_formats, [2]);
  assert.deepEqual(result.library, {
    read: { min: 1, max: 37 },
    write_schema: 37,
    lock_protocol: "library-lock-v1",
  });
  assert.equal(result.authority, "none");
  assert.equal(result.files.length, 4);
  const lib = nativeCompatibilitySourcePaths[0],
    db = nativeCompatibilitySourcePaths[1],
    catalog = nativeCompatibilitySourcePaths[2],
    windows = nativeCompatibilitySourcePaths[3];
  for (const changed of [
    { ...files, [lib]: Buffer.from("invalid source") },
    {
      ...files,
      [lib]: Buffer.concat([
        files[lib]!,
        Buffer.from("\npub const API_SCHEMA_VERSION: u32 = 77;\n"),
      ]),
    },
    {
      ...files,
      [db]: Buffer.from(
        files[db]!.toString().replace(
          "CURRENT_SCHEMA_VERSION: i64 = 37",
          "CURRENT_SCHEMA_VERSION: i64 = 0",
        ),
      ),
    },
    { ...files, [catalog]: Buffer.from('{"schema_version":3}') },
    { ...files, [lib]: Buffer.from([255]) },
    {
      ...files,
      [windows]: Buffer.from(
        files[windows]!.toString().replace(
          "cli_protocol: portcove_core::API_SCHEMA_VERSION,",
          "cli_protocol: 999,",
        ),
      ),
    },
    { ...files, unreviewed: Buffer.from("extra") },
  ])
    assert.throws(() => inspectNativeCompatibilitySources(changed));
  const missing = { ...files };
  delete missing[catalog];
  assert.throws(() => inspectNativeCompatibilitySources(missing));
  await assert.rejects(readActualNativeSourceDeclarations({}), /actual native source selection/);
});
