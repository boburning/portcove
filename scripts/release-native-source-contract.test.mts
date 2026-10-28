import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  nativeCompatibilitySourcePaths,
  nativeSourceDeclarationByteLimit,
  inspectNativeCompatibilitySources,
} from "./release-native-source-contract.mts";
import {
  createNativeSourceApiReader,
  readActualNativeSourceDeclarations,
} from "./release-native-candidate.mts";

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
  const schemaDeclaration = `pub(crate) const CURRENT_SCHEMA_VERSION: i64 = ${result.library.write_schema};`;
  const minimumDeclaration = `pub const MIN_LIBRARY_SCHEMA_VERSION: u32 = ${result.library.read.min};`;
  // This is a source-derived protocol, not a second pin to update on every API
  // revision. Bind the reported value and receipts to the actual input bytes.
  assert.equal(
    files[lib]!.toString("utf8")
      .split(/\r?\n/u)
      .filter((line) => line === apiDeclaration).length,
    1,
  );
  for (const [name, declaration] of [
    [db, schemaDeclaration],
    [lib, minimumDeclaration],
  ] as const)
    assert.equal(
      files[name]!.toString("utf8")
        .split(/\r?\n/u)
        .filter((line) => line === declaration).length,
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
  const catalogLimit = nativeSourceDeclarationByteLimit(catalog);
  assert.equal(catalogLimit, 4 * 1024 * 1024);
  const atLimit = Buffer.concat([
    files[catalog]!,
    Buffer.alloc(catalogLimit - files[catalog]!.length, 32),
  ]);
  assert.deepEqual(
    inspectNativeCompatibilitySources({ ...files, [catalog]: atLimit }).catalog_formats,
    [2],
  );
  assert.throws(
    () =>
      inspectNativeCompatibilitySources({
        ...files,
        [catalog]: Buffer.concat([atLimit, Buffer.from(" ")]),
      }),
    /oversized/,
  );
  assert.equal(nativeSourceDeclarationByteLimit(lib), 1024 * 1024);
  assert.throws(
    () => inspectNativeCompatibilitySources({ ...files, [lib]: Buffer.alloc(1024 * 1024 + 1, 32) }),
    /oversized/,
  );
  assert.deepEqual(result.library, {
    read: { min: 1, max: result.library.write_schema },
    write_schema: result.library.write_schema,
    lock_protocol: "library-lock-v1",
  });
  assert.ok(Number.isSafeInteger(result.library.write_schema) && result.library.write_schema > 0);
  // The database declaration owns the current schema. Independently chosen
  // ranges and a future increment exercise decoding without another version pin.
  for (const [minimum, current] of [
    [1, 17],
    [7, 821],
    [1, result.library.write_schema + 1],
  ] as const) {
    const revised = {
      ...files,
      [lib]: Buffer.from(
        files[lib]!.toString("utf8").replace(
          minimumDeclaration,
          `pub const MIN_LIBRARY_SCHEMA_VERSION: u32 = ${minimum};`,
        ),
      ),
      [db]: Buffer.from(
        files[db]!.toString("utf8").replace(
          schemaDeclaration,
          `pub(crate) const CURRENT_SCHEMA_VERSION: i64 = ${current};`,
        ),
      ),
    };
    assert.deepEqual(inspectNativeCompatibilitySources(revised).library, {
      read: { min: minimum, max: current },
      write_schema: current,
      lock_protocol: "library-lock-v1",
    });
  }
  assert.equal(result.authority, "none");
  assert.equal(result.files.length, 4);
  for (const changed of [
    { ...files, [lib]: Buffer.from("invalid source") },
    { ...files, [lib]: Buffer.concat([files[lib]!, Buffer.from(`\n${apiDeclaration}\n`)]) },
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
          schemaDeclaration,
          "pub(crate) const CURRENT_SCHEMA_VERSION: i64 = 0;",
        ),
      ),
    },
    { ...files, [db]: Buffer.from("invalid source") },
    { ...files, [db]: Buffer.concat([files[db]!, Buffer.from(`\n${schemaDeclaration}\n`)]) },
    {
      ...files,
      [db]: Buffer.concat([
        files[db]!,
        Buffer.from("\npub(crate) const CURRENT_SCHEMA_VERSION: i64 = 17;\n"),
      ]),
    },
    {
      ...files,
      [lib]: Buffer.from(
        files[lib]!.toString("utf8").replace(
          minimumDeclaration,
          `pub const MIN_LIBRARY_SCHEMA_VERSION: u32 = ${result.library.write_schema + 1};`,
        ),
      ),
    },
    {
      ...files,
      [lib]: Buffer.from(
        files[lib]!.toString("utf8").replace(
          "pub const LIBRARY_SCHEMA_VERSION: u32 = database::CURRENT_SCHEMA_VERSION as u32;",
          "pub const LIBRARY_SCHEMA_VERSION: u32 = 999;",
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

void test("actual source transport bounds immutable blob JSON separately from metadata", () => {
  const payload = JSON.stringify({
    sha: "a".repeat(40),
    size: 4 * 1024 * 1024,
    encoding: "base64",
    content: Buffer.alloc(4 * 1024 * 1024, 32).toString("base64"),
  });
  const observed: number[] = [];
  const api = createNativeSourceApiReader(process.cwd(), (_command, _args, options) => {
    observed.push(options.maxBuffer!);
    assert.ok(Buffer.byteLength(payload) < options.maxBuffer!);
    return { status: 0, stdout: payload, stderr: "" };
  });
  const result = api.request("GET", `repos/boburning/portcove/git/blobs/${"a".repeat(40)}`);
  assert.equal((result.body as { size: number }).size, 4 * 1024 * 1024);
  const metadata = createNativeSourceApiReader(process.cwd(), (_command, _args, options) => {
    observed.push(options.maxBuffer!);
    return { status: 0, stdout: "{}", stderr: "" };
  });
  for (const endpoint of [
    "repos/boburning/portcove/contents/crates/portcove-core/catalog/catalog.json?ref=" +
      "a".repeat(40),
    "repos/boburning/portcove/actions/runs/1",
    "repos/boburning/portcove/git/blobs/not-an-immutable-sha",
  ])
    metadata.request("GET", endpoint);
  assert.deepEqual(
    observed,
    [8, 2, 2, 2].map((mib) => mib * 1024 * 1024),
  );
  assert.throws(() =>
    metadata.request("POST", "repos/boburning/portcove/git/blobs/" + "a".repeat(40)),
  );
  assert.throws(() =>
    metadata.request("GET", "repos/other/repository/git/blobs/" + "a".repeat(40)),
  );
  assert.equal(observed.length, 4, "refused routes never reach the credentialled transport");
});
