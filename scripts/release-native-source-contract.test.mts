import assert from "node:assert/strict";
import { createHash } from "node:crypto";
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
  assert.ok(Number.isSafeInteger(result.cli_protocol.min) && result.cli_protocol.min > 0);
  assert.equal(result.cli_protocol.max, result.cli_protocol.min);
  const apiDeclaration = `pub const API_SCHEMA_VERSION: u32 = ${result.cli_protocol.min};`;
  const lib = nativeCompatibilitySourcePaths[0],
    db = nativeCompatibilitySourcePaths[1],
    catalog = nativeCompatibilitySourcePaths[2],
    windows = nativeCompatibilitySourcePaths[3];
  // This is a source-derived protocol, not a second pin to update on every API
  // revision. Bind the reported value and receipts to the actual input bytes.
  assert.equal(
    files[lib]!.toString("utf8")
      .split(/\r?\n/u)
      .filter((line) => line === apiDeclaration).length,
    1,
  );
  assert.deepEqual(
    result.files,
    nativeCompatibilitySourcePaths.map((name) => ({
      path: name,
      sha256: createHash("sha256").update(files[name]!).digest("hex"),
      bytes: files[name]!.byteLength,
    })),
  );
  // Independently expected ranges exercise decoding across changing declarations;
  // a hardcoded protocol result cannot satisfy these fixtures.
  for (const protocol of [17, 821]) {
    const revised = {
      ...files,
      [lib]: Buffer.from(
        files[lib]!.toString("utf8").replace(
          apiDeclaration,
          `pub const API_SCHEMA_VERSION: u32 = ${protocol};`,
        ),
      ),
    };
    assert.deepEqual(inspectNativeCompatibilitySources(revised).cli_protocol, {
      min: protocol,
      max: protocol,
    });
  }
  assert.deepEqual(result.catalog_formats, [2]);
  assert.deepEqual(result.library, {
    read: { min: 1, max: 37 },
    write_schema: 37,
    lock_protocol: "library-lock-v1",
  });
  assert.equal(result.authority, "none");
  assert.equal(result.files.length, 4);
  for (const changed of [
    { ...files, [lib]: Buffer.from("invalid source") },
    {
      ...files,
      [lib]: Buffer.concat([
        files[lib]!,
        Buffer.from("\npub const API_SCHEMA_VERSION: u32 = 17;\n"),
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
