import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash, generateKeyPairSync, verify } from "node:crypto";
import {
  copyFileSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { isRecord } from "./runtime-values.mts";

function fixture() {
  const root = mkdtempSync(path.join(os.tmpdir(), "portcove-sign-fixture-"));
  const tool = path.join(root, "sign-catalog.mts");
  copyFileSync(new URL("./sign-catalog.mts", import.meta.url), tool);
  // These keys exist only in this owned temporary fixture. No publisher key or
  // credentials are read, and the copied utility runs without dependencies.
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const key = path.join(root, "fixture.pem");
  const catalog = path.join(root, "catalog.json");
  const output = path.join(root, "envelope.json");
  writeFileSync(key, privateKey.export({ format: "pem", type: "pkcs8" }));
  writeFileSync(catalog, '{"fixture":"opaque publisher input"}');
  const run = (args: readonly string[] = []) => {
    const result = spawnSync(
      process.execPath,
      [
        tool,
        "--key",
        key,
        "--catalog",
        catalog,
        "--output",
        output,
        "--sequence",
        "1",
        "--issued-at",
        "100",
        "--expires-at",
        "200",
        ...args,
      ],
      { cwd: root, encoding: "utf8", timeout: 10_000, windowsHide: true },
    );
    assert.ifError(result.error);
    return result;
  };
  return { root, tool, key, catalog, output, publicKey, run };
}
function object(value: unknown) {
  assert.ok(isRecord(value));
  return value;
}
function text(value: unknown) {
  assert.ok(typeof value === "string");
  return value;
}

void test("offline catalog signer preserves exact signed bytes and refuses overwrite", (t) => {
  const item = fixture();
  t.after(() => rmSync(item.root, { recursive: true, force: true }));
  const result = item.run();
  assert.equal(result.status, 0, result.stderr);
  const summary = object(JSON.parse(result.stdout));
  const bytes = readFileSync(item.output);
  const envelope = object(JSON.parse(bytes.toString("utf8")));
  assert.equal(envelope.format_version, 1);
  const point = item.publicKey.export({ format: "jwk" }).x;
  assert.ok(typeof point === "string");
  const publicBytes = Buffer.from(point, "base64url");
  const keyId = createHash("sha256").update(publicBytes).digest("hex");
  assert.deepEqual(summary, {
    public_key: publicBytes.toString("hex"),
    key_id: keyId,
    sequence: 1,
    output: item.output,
  });
  assert.equal(envelope.key_id, keyId);
  const payload = text(envelope.payload);
  assert.equal(
    payload,
    '{"sequence":1,"issued_at":100,"expires_at":200,"catalog":{"fixture":"opaque publisher input"}}',
  );
  assert.equal(
    verify(
      null,
      Buffer.from(`Portcove signed catalog v1\n${keyId}\n${payload}`),
      item.publicKey,
      Buffer.from(text(envelope.signature), "hex"),
    ),
    true,
  );
  assert.equal(
    verify(
      null,
      Buffer.from(`Portcove signed catalog v1\n${keyId}\n${payload} `),
      item.publicKey,
      Buffer.from(text(envelope.signature), "hex"),
    ),
    false,
  );
  assert.notEqual(item.run().status, 0);
  assert.deepEqual(readFileSync(item.output), bytes);
});

void test("offline catalog signer help succeeds without reading inputs or writing output", (t) => {
  const item = fixture();
  t.after(() => rmSync(item.root, { recursive: true, force: true }));
  const help = spawnSync(process.execPath, [item.tool, "--help"], {
    cwd: item.root,
    encoding: "utf8",
    timeout: 10_000,
    windowsHide: true,
  });
  assert.ifError(help.error);
  assert.equal(help.status, 0, help.stderr);
  assert.equal(help.stderr, "");
  assert.match(help.stdout, /^Usage: node scripts\/sign-catalog\.mts/mu);
  assert.match(help.stdout, /Example:/u);
  for (const option of [
    "--catalog",
    "--key",
    "--output",
    "--sequence",
    "--issued-at",
    "--expires-at",
  ])
    assert.ok(help.stdout.includes(option), `Missing help for ${option}`);
  assert.equal(existsSync(item.output), false);

  writeFileSync(item.output, "Preserve the existing output.");
  const result = item.run([
    "--help",
    "--key",
    path.join(item.root, "missing-key.pem"),
    "--catalog",
    path.join(item.root, "missing-catalog.json"),
    "--sequence",
    "invalid",
  ]);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stderr, "");
  assert.equal(result.stdout, help.stdout);
  assert.equal(readFileSync(item.output, "utf8"), "Preserve the existing output.");
});

void test("offline catalog signer identifies invalid numeric arguments and their limits", (t) => {
  const item = fixture();
  t.after(() => rmSync(item.root, { recursive: true, force: true }));
  for (const { args, message } of [
    { args: ["--sequence", "0"], message: /--sequence.*positive safe integer.*received "0"/u },
    { args: ["--sequence", "NaN"], message: /--sequence.*positive safe integer.*received "NaN"/u },
    {
      args: ["--sequence", "9007199254740992"],
      message: /--sequence.*9007199254740991.*received "9007199254740992"/u,
    },
    { args: ["--issued-at=-1"], message: /--issued-at.*nonnegative safe integer.*received "-1"/u },
    { args: ["--issued-at", "NaN"], message: /--issued-at.*Unix seconds.*received "NaN"/u },
    { args: ["--expires-at", "NaN"], message: /--expires-at.*Unix seconds.*received "NaN"/u },
    {
      args: ["--expires-at", "100"],
      message: /--expires-at.*greater than --issued-at \(100\).*received "100"/u,
    },
    {
      args: ["--expires-at", String(101 + 366 * 86400)],
      message: /at most 366 days \(31622400 seconds\).*received 31622401 seconds/u,
    },
  ]) {
    const result = item.run(args);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, message);
    assert.equal(result.stdout, "");
    assert.equal(existsSync(item.output), false);
  }

  const missing = spawnSync(process.execPath, [item.tool], {
    encoding: "utf8",
    timeout: 10_000,
    windowsHide: true,
  });
  assert.ifError(missing.error);
  assert.notEqual(missing.status, 0);
  assert.match(missing.stderr, /--catalog is required.*--help/u);
  assert.equal(missing.stdout, "");
});

void test("offline catalog signer reports input limits without exposing input contents", (t) => {
  const item = fixture();
  t.after(() => rmSync(item.root, { recursive: true, force: true }));
  const privateKey = readFileSync(item.key);
  const refuses = (args: readonly string[], message: RegExp) => {
    const result = item.run(args);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, message);
    assert.equal(result.stdout, "");
    assert.doesNotMatch(result.stderr, /PRIVATE_INPUT_CANARY/u);
    assert.equal(existsSync(item.output), false);
  };
  writeFileSync(item.key, Buffer.alloc(65537, "PRIVATE_INPUT_CANARY"));
  refuses([], /--key.*65536-byte read limit.*received 65537 bytes/u);
  writeFileSync(item.key, privateKey);
  writeFileSync(item.catalog, "{");
  refuses([], /SyntaxError/u);
  writeFileSync(item.catalog, Buffer.alloc(16777217, "PRIVATE_INPUT_CANARY"));
  refuses([], /--catalog.*16777216-byte read limit.*received 16777217 bytes/u);
  refuses(["--catalog", item.root], /--catalog.*regular file.*directory.*16777216 bytes/u);
  writeFileSync(item.catalog, "{}");
  const wrong = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  writeFileSync(item.key, wrong.privateKey.export({ format: "pem", type: "pkcs8" }));
  refuses([], /--key.*Ed25519 private key.*received ec/u);
});

void test("offline catalog signer retains numeric coercion and the inclusive validity limit", (t) => {
  const item = fixture();
  t.after(() => rmSync(item.root, { recursive: true, force: true }));
  const result = item.run([
    "--sequence",
    "0x1",
    "--issued-at",
    "1e2",
    "--expires-at",
    String(100 + 366 * 86400),
  ]);
  assert.equal(result.status, 0, result.stderr);
  const envelope = object(JSON.parse(readFileSync(item.output, "utf8")));
  const payload = object(JSON.parse(text(envelope.payload)));
  assert.equal(payload.sequence, 1);
  assert.equal(payload.issued_at, 100);
  assert.equal(payload.expires_at, 100 + 366 * 86400);
});

void test("offline catalog signer reports the independent escaped-envelope limit", (t) => {
  const item = fixture();
  t.after(() => rmSync(item.root, { recursive: true, force: true }));
  // Each quote is two bytes in the catalog and four after envelope escaping.
  const catalog = JSON.stringify({ fixture: '"'.repeat(4400000) });
  assert.ok(Buffer.byteLength(catalog) < 16777216);
  writeFileSync(item.catalog, catalog);
  const result = item.run();
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /envelope.*16777216-byte.*received \d+ bytes after JSON escaping/u);
  assert.equal(result.stdout, "");
  assert.equal(existsSync(item.output), false);
});

void test("offline capacity diagnostics count escaped growth and retain the existing byte authority", async () => {
  const { catalogCapacity, capacityConstant } = await import("./catalog-capacity.mts");
  const limit = capacityConstant(
    readFileSync(new URL("../crates/portcove-core/src/signed_catalog.rs", import.meta.url), "utf8"),
    "MAX_CATALOG_BYTES",
  );
  assert.equal(limit, 16 * 1024 * 1024);
  const catalog = {
    schema_version: 2,
    ports: [{ id: "one", summary: 'Unicodeé and "quoted" text' }],
  };
  const small = catalogCapacity(catalog, limit, 1700000000);
  const large = catalogCapacity(
    {
      ...catalog,
      ports: Array.from({ length: 1000 }, (_, index) => ({
        ...catalog.ports[0],
        id: `port-${index}`,
      })),
    },
    limit,
    1700000000,
  );
  assert.ok(large.representative_envelope_bytes > small.representative_envelope_bytes);
  assert.equal(large.catalog_ports, 1000);
  assert.equal(large.signature_status, "not-created; fixed-width placeholder counted only");
  assert.equal(large.actual_provider_traffic, "Unknown");
  const overflow = catalogCapacity(catalog, small.representative_envelope_bytes - 1, 1700000000);
  assert.equal(overflow.fits_representative_envelope, false);
  assert.equal(overflow.envelope_remaining_bytes, 0);
  assert.throws(() => capacityConstant("const B: u64 = 0;", "B"), /Invalid/);
  assert.throws(() => capacityConstant("const B: u64 = 1; const B: u64 = 2;", "B"), /ambiguous/);
  assert.throws(
    () => catalogCapacity({ ports: [{ id: "same" }, { id: "same" }] }, limit, 0),
    /unique/,
  );
});

void test("offline capacity diagnostics match the existing publisher envelope byte representation", async (t) => {
  const { catalogCapacity } = await import("./catalog-capacity.mts");
  const item = fixture();
  t.after(() => rmSync(item.root, { recursive: true, force: true }));
  const catalog = { ports: [{ id: "fixture", summary: 'é "quoted"' }] };
  writeFileSync(item.catalog, JSON.stringify(catalog));
  const result = item.run([
    "--sequence",
    String(Number.MAX_SAFE_INTEGER),
    "--issued-at",
    "100",
    "--expires-at",
    "86500",
  ]);
  assert.equal(result.status, 0, result.stderr);
  const report = catalogCapacity(catalog, 4 * 1024 * 1024, 100);
  assert.equal(report.representative_envelope_bytes, readFileSync(item.output).length);
});

void test("offline catalog signer accepts an envelope above the legacy 4 MiB floor", async (t) => {
  const { capacityConstant } = await import("./catalog-capacity.mts");
  const limit = capacityConstant(
    readFileSync(new URL("../crates/portcove-core/src/signed_catalog.rs", import.meta.url), "utf8"),
    "MAX_CATALOG_BYTES",
  );
  const item = fixture();
  t.after(() => rmSync(item.root, { recursive: true, force: true }));
  const catalog = JSON.stringify({ fixture: "x".repeat(4194304) });
  writeFileSync(item.catalog, catalog);
  const result = item.run();
  assert.equal(result.status, 0, result.stderr);
  assert.ok(readFileSync(item.output).length > 4194304);
  const help = item.run(["--help"]);
  assert.ok(help.stdout.includes(`at most ${limit} bytes (16 MiB)`));
  assert.ok(help.stdout.includes(`fit within ${limit} bytes (16 MiB)`));
  writeFileSync(item.catalog, Buffer.alloc(limit + 1, " "));
  const refused = item.run(["--output", `${item.output}.over`]);
  assert.notEqual(refused.status, 0);
  assert.ok(refused.stderr.includes(`${limit}-byte read limit: received ${limit + 1} bytes`));
  assert.match(help.stdout, /catalog-capacity\.mts --check/u);
});

void test("catalog size guard reads Core bounds and fails above its stated margin", async (t) => {
  const { catalogSizeBounds, catalogSizeGuard, formatCatalogSizeGuard } =
    await import("./catalog-capacity.mts");
  const bounds = catalogSizeBounds(
    readFileSync(new URL("../crates/portcove-core/src/signed_catalog.rs", import.meta.url), "utf8"),
  );
  assert.deepEqual(bounds, { current: 16777216, percent: 85 });
  assert.throws(
    () =>
      catalogSizeBounds(
        "const MAX_CATALOG_BYTES: usize = 4;\nconst CATALOG_SUPPORTED_CAPACITY_PERCENT: usize = 100;",
      ),
    /Invalid/u,
  );
  const small = { ports: [{ id: "one", summary: 'é "quoted"' }] };
  const passing = catalogSizeGuard(100, small, bounds);
  assert.equal(
    catalogSizeGuard(
      5 * 1024 * 1024,
      { ports: [{ id: "one", summary: "a".repeat(5 * 1024 * 1024) }] },
      bounds,
    ).ok,
    true,
  );
  assert.equal(passing.ok, true);
  assert.deepEqual(
    passing.rows.map((row) => [row.name, row.basis, row.ceiling]),
    [
      ["generated catalog.json bytes", "generated input bound", 14260633],
      ["compact catalog bytes", "catalog input bound", 14260633],
      ["escaped signed envelope bytes (unsigned placeholder)", "signed envelope bound", 14260633],
    ],
  );
  assert.match(
    formatCatalogSizeGuard(passing),
    /^ok {3}compact catalog bytes: \d+ of 14260633 \(85% of the catalog input bound 16777216\); headroom \d+/mu,
  );
  // Escaping alone can carry the envelope past the margin while the compact bytes still fit.
  const escaped = { ports: [{ id: "one", summary: '"'.repeat(3600000) }] };
  const failing = catalogSizeGuard(100, escaped, bounds);
  assert.equal(failing.ok, false);
  assert.deepEqual(
    failing.rows.map((row) => row.ok),
    [true, true, false],
  );
  assert.ok(failing.rows[2]!.headroom < 0);
  assert.match(formatCatalogSizeGuard(failing), /^FAIL escaped signed envelope bytes/mu);
  assert.equal(catalogSizeGuard(14260634, small, bounds).rows[0]!.ok, false);

  const root = mkdtempSync(path.join(os.tmpdir(), "portcove-size-guard-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const input = path.join(root, "catalog.json");
  const tool = fileURLToPath(new URL("./catalog-capacity.mts", import.meta.url));
  writeFileSync(input, JSON.stringify(escaped));
  const refused = spawnSync(process.execPath, [tool, "--check", "--catalog", input], {
    encoding: "utf8",
  });
  assert.equal(refused.status, 1);
  assert.match(refused.stdout, /FAIL escaped signed envelope bytes/u);
  assert.match(refused.stderr, /Catalog size guard failed/u);
  writeFileSync(input, JSON.stringify(small));
  const accepted = spawnSync(process.execPath, [tool, "--check", "--catalog", input], {
    encoding: "utf8",
  });
  assert.equal(accepted.status, 0, accepted.stderr);
  assert.equal(accepted.stdout.trim().split("\n").length, 3);
});

void test("listing directory guard measures every delivery consumer, not an embedded ceiling", async () => {
  const {
    capacityConstant,
    catalogSizeGuard,
    compactCarrierModel,
    definitionIndexMeasures,
    formatCatalogSizeGuard,
    legacyRowProjection,
    listingDeliveryBounds,
    listingDirectoryMeasures,
    signedObservations,
  } = await import("./catalog-capacity.mts");
  const { encodeCompactListing, listingDirectoryTextMaximum } =
    await import("./listing-directory-carrier.mts");
  assert.equal(capacityConstant("const N: usize = 10_000;", "N"), 10000);
  const carrierSource = readFileSync(
    new URL("../crates/portcove-listing-carrier/src/lib.rs", import.meta.url),
    "utf8",
  );
  const listingsSource = readFileSync(
    new URL("../crates/portcove-core/src/catalog/listings.rs", import.meta.url),
    "utf8",
  );
  const deliverySource = readFileSync(
    new URL("../crates/portcove-core/src/listing_delivery.rs", import.meta.url),
    "utf8",
  );
  // Tooling that reads the canonical directory follows Core's text bound.
  assert.equal(
    listingDirectoryTextMaximum,
    capacityConstant(listingsSource, "MAX_LISTING_DIRECTORY_TEXT_BYTES"),
  );
  const bounds = listingDeliveryBounds(carrierSource, listingsSource, deliverySource);
  assert.deepEqual(bounds, {
    wire: 8388608,
    decoded: 33554432,
    record: 1048576,
    entries: 10000,
    text: 67108864,
    elementBudget: 41943040,
    listingCharge: 4027,
    withdrawalCharge: 68,
  });
  // A next-generation raise of a Rust carrier constant does not loosen the
  // released-reader bounds the guard (and the publisher) use ...
  const raised = carrierSource.replace(
    "MAX_COMPACT_DECODED_BYTES: usize = 32 * 1024 * 1024",
    "MAX_COMPACT_DECODED_BYTES: usize = 64 * 1024 * 1024",
  );
  assert.notEqual(raised, carrierSource);
  assert.equal(listingDeliveryBounds(raised, listingsSource, deliverySource).decoded, 33554432);
  // ... and a current bound below a released one is refused.
  assert.throws(
    () =>
      listingDeliveryBounds(
        carrierSource.replace(
          "MAX_LISTING_ENTRIES: usize = 10_000",
          "MAX_LISTING_ENTRIES: usize = 9_000",
        ),
        listingsSource,
        deliverySource,
      ),
    /entries \(9000\) is below the released readers' 10000/u,
  );
  assert.throws(
    () =>
      listingDeliveryBounds(
        carrierSource,
        listingsSource.replace(
          "MAX_LISTING_DIRECTORY_TEXT_BYTES: usize = 64 * 1024 * 1024",
          "MAX_LISTING_DIRECTORY_TEXT_BYTES: usize = 32 * 1024 * 1024",
        ),
        deliverySource,
      ),
    /differs from Core's MAX_LISTING_DIRECTORY_TEXT_BYTES/u,
  );
  const row = (id: string, summary = "Description") => ({
    id,
    name: "Listing",
    summary,
    project_url: "https://example.org",
  });
  const text = Buffer.from(
    JSON.stringify({ format_version: 15, listings: [row("one"), row("two")] }, null, 2),
  );
  const measures = listingDirectoryMeasures(text, bounds, undefined, ["gone"]);
  const unobserved = "modeled: 0 signed observations, 2 charged the mean";
  assert.deepEqual(
    measures.map(([name, , bound, , margin]) => [name, bound, margin?.kind ?? "percent"]),
    [
      ["generated listings.json bytes", 67108864, "percent"],
      [`compact listing directory decoded bytes (${unobserved})`, 33554432, "growth"],
      [`compact listing carrier bytes (${unobserved})`, 8388608, "growth"],
      ["largest compact listing record bytes (modeled)", 1048576, "half"],
      ["listing records", 10000, "growth"],
      ["listing withdrawals", 10000, "growth"],
      ["listing element charge", 41943040, "percent"],
      [
        "frozen legacy listing target (revision 47): complete format-11 successor bytes",
        8388608,
        "informational",
      ],
    ],
  );
  assert.equal(measures[0]![1], text.length);
  assert.equal(measures[4]![1], 2);
  assert.equal(measures[5]![1], 1);
  assert.equal(measures[6]![1], 2 * 4027 + 68);
  // Every row without a signed observation is charged the mean, and its
  // largest record the largest live observation.
  assert.ok(measures[1]![1] > 2 * compactCarrierModel.observationBytesPerRow);
  assert.equal(
    measures[3]![1],
    Buffer.byteLength(JSON.stringify(row("one"))) + compactCarrierModel.largestObservationBytes,
  );
  // Signed observations, read from a compact carrier, replace the mean.
  const observation = { provider: "github", repository: "owner/repo", payload: "x".repeat(4096) };
  const staged = JSON.parse(
    encodeCompactListing(
      Buffer.from(
        JSON.stringify({
          listing_delivery_schema: 1,
          revision: 48,
          withdrawn_ids: [],
          directory: {
            format_version: 15,
            listings: [{ ...row("one"), upstream_observation: observation }, row("x")],
          },
        }),
      ),
    ).toString("utf8"),
  ) as unknown;
  const observed = listingDirectoryMeasures(text, bounds, signedObservations(staged), ["gone"]);
  assert.equal(
    observed[1]![0],
    "compact listing directory decoded bytes (modeled: 1 signed observations, 1 charged the mean)",
  );
  assert.ok(observed[1]![1] < measures[1]![1]);
  assert.ok(observed[7]![1] > measures[7]![1]);
  assert.deepEqual(
    signedObservations({ directory: { listings: [{ id: "a", upstream_observation: 1 }] } }),
    new Map([["a", 1]]),
  );
  // The format-11 projection drops only format-12+ facts.
  assert.deepEqual(
    legacyRowProjection({
      ...row("one"),
      restrictions: [{}],
      implementation: {},
      upstream_observation: {},
      media: [{ role: "screenshot", igdb: { image_id: "a" } }],
      original_game: { id: "game", source_editions: [{ id: "e", verified_sources: [] }] },
    }),
    { ...row("one"), original_game: { id: "game", source_editions: [{ id: "e" }] } },
  );
  const definitionSource = readFileSync(
    new URL("../crates/portcove-core/src/definition_index.rs", import.meta.url),
    "utf8",
  );
  assert.deepEqual(
    definitionIndexMeasures(
      Buffer.from(JSON.stringify({ contents: [{ length: 10 }, { length: 32 }] })),
      definitionSource,
    ).map(([name, value, bound]) => [name, value, bound]),
    [
      ["definition index bytes", 42, 4194304],
      ["definition content aggregate bytes", 42, 33554432],
    ],
  );
  const catalogBounds = { current: 16777216, percent: 85 };
  const passing = catalogSizeGuard(100, { ports: [] }, catalogBounds, measures);
  assert.equal(passing.ok, true);
  // Growth rows reserve lead-time growth; the record reserves half its bound.
  const decodedRow = passing.rows.find((entry) =>
    entry.name.startsWith("compact listing directory"),
  )!;
  assert.equal(
    decodedRow.ceiling,
    33554432 -
      Math.ceil(
        (compactCarrierModel.authoredBytesPerDay +
          compactCarrierModel.rowsPerDay * compactCarrierModel.observationBytesPerRow) *
          compactCarrierModel.leadDays,
      ),
  );
  assert.ok(decodedRow.days_before_ceiling! > 0);
  assert.equal(passing.rows.find((entry) => entry.margin === "half")!.ceiling, 512 * 1024);
  assert.match(formatCatalogSizeGuard(passing), /^info frozen legacy listing target/mu);
  // The frozen legacy target is informational: past its bound, CI still passes.
  const informational = catalogSizeGuard(100, { ports: [] }, catalogBounds, [
    [
      "frozen legacy",
      9_000_000,
      8388608,
      "released legacy target bound",
      { kind: "informational" },
    ],
  ]);
  assert.equal(informational.ok, true);
  assert.equal(informational.rows.at(-1)!.headroom, 8388608 - 9_000_000);
  // One oversized record fails its own row while the whole directory still fits.
  const large = Buffer.from(
    JSON.stringify({ format_version: 15, listings: [row("one", "x".repeat(600_000))] }),
  );
  const guarded = catalogSizeGuard(
    100,
    { ports: [] },
    catalogBounds,
    listingDirectoryMeasures(large, bounds),
  );
  assert.deepEqual(
    guarded.rows.filter((entry) => !entry.ok).map((entry) => entry.name),
    ["largest compact listing record bytes (modeled)"],
  );
  // Inside a bound but within the lead-time margin fails CI.
  const rows = Math.ceil(10000 - compactCarrierModel.rowsPerDay * compactCarrierModel.leadDays) + 1;
  const crowded = catalogSizeGuard(
    100,
    { ports: [] },
    catalogBounds,
    listingDirectoryMeasures(
      Buffer.from(
        JSON.stringify({
          format_version: 15,
          listings: Array.from({ length: rows }, (_, i) => ({ id: `r${i}` })),
        }),
      ),
      bounds,
    ),
  );
  const count = crowded.rows.find((entry) => entry.name === "listing records")!;
  assert.ok(count.bytes < count.bound && !count.ok && !crowded.ok);
  const withdrawals = catalogSizeGuard(
    100,
    { ports: [] },
    catalogBounds,
    listingDirectoryMeasures(
      Buffer.from(JSON.stringify({ format_version: 15, listings: [] })),
      bounds,
      undefined,
      Array.from({ length: 9600 }, (_, i) => `w${i}`),
    ),
  );
  assert.equal(withdrawals.rows.find((entry) => entry.name === "listing withdrawals")!.ok, false);
  assert.throws(
    () => listingDirectoryMeasures(Buffer.from("{}"), bounds),
    /require a listing directory/u,
  );
});

void test("legacy signer refuses reviewed package choices before key access", (t) => {
  const item = fixture();
  t.after(() => rmSync(item.root, { recursive: true, force: true }));
  rmSync(item.key);
  for (const declaration of [
    {
      repository_id: 42,
      prefix: "fixture_",
      choices: {
        "mingw64-cross": "_win-mingw64-cross.zip",
        "msvc64-142": "_win-msvc64-142.zip",
      },
    },
    null,
  ]) {
    writeFileSync(
      item.catalog,
      JSON.stringify({ ports: [{ release: { reviewed_package_choices_v2: declaration } }] }),
    );
    const result = item.run();
    assert.notEqual(result.status, 0);
    assert.match(
      result.stderr,
      /Format-1 signed catalogs cannot deliver reviewed package choices/u,
    );
    assert.equal(existsSync(item.output), false);
  }
});

void test("legacy signer refuses a mod provider withdrawal before key access", (t) => {
  const item = fixture();
  t.after(() => rmSync(item.root, { recursive: true, force: true }));
  rmSync(item.key);
  writeFileSync(
    item.catalog,
    JSON.stringify({ ports: [{ id: "shipwright", mod_provider_bindings: [] }] }),
  );
  const result = item.run();
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Format-1 signed catalogs cannot deliver mod provider bindings/u);
  assert.equal(existsSync(item.output), false);
});

void test("legacy signer refuses mod sources before key access", (t) => {
  const item = fixture();
  t.after(() => rmSync(item.root, { recursive: true, force: true }));
  rmSync(item.key);
  writeFileSync(
    item.catalog,
    JSON.stringify({ ports: [{ id: "quake-ironwail", mod_sources: [] }] }),
  );
  const result = item.run();
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Format-1 signed catalogs cannot deliver mod sources/u);
  assert.equal(existsSync(item.output), false);
});

void test("legacy signer refuses a native mod loader binding before key access", (t) => {
  const item = fixture();
  t.after(() => rmSync(item.root, { recursive: true, force: true }));
  rmSync(item.key);
  writeFileSync(
    item.catalog,
    JSON.stringify({ ports: [{ id: "banjo-recomp", mod_loader: { native_game: "bk" } }] }),
  );
  const result = item.run();
  assert.notEqual(result.status, 0);
  assert.match(
    result.stderr,
    /Format-1 signed catalogs cannot deliver native mod loader bindings/u,
  );
  assert.equal(existsSync(item.output), false);
});

void test("legacy signer refuses reviewed package and launch declarations before key access", (t) => {
  const item = fixture();
  t.after(() => rmSync(item.root, { recursive: true, force: true }));
  rmSync(item.key);
  writeFileSync(
    item.catalog,
    JSON.stringify({
      ports: [
        {
          id: "banjo-recomp",
          reviewed_launch_contract_v1: { package_format: { "windows-x86-64": "tar.xz" } },
        },
      ],
    }),
  );
  const result = item.run();
  assert.notEqual(result.status, 0);
  assert.match(
    result.stderr,
    /Format-1 signed catalogs cannot deliver reviewed package and launch declarations/u,
  );
  assert.equal(existsSync(item.output), false);
});

void test("legacy signer refuses package-only settings before key access", (t) => {
  const item = fixture();
  t.after(() => rmSync(item.root, { recursive: true, force: true }));
  rmSync(item.key);
  writeFileSync(
    item.catalog,
    JSON.stringify({
      ports: [{ id: "super-mario-world-recomp", game_settings: { format_version: 2 } }],
    }),
  );
  const result = item.run();
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Format-1 signed catalogs cannot deliver package-only settings/u);
  assert.equal(existsSync(item.output), false);
});

void test("legacy signer refuses Shipwright working-directory persistence before key access", (t) => {
  const item = fixture();
  t.after(() => rmSync(item.root, { recursive: true, force: true }));
  rmSync(item.key);
  writeFileSync(
    item.catalog,
    JSON.stringify({
      ports: [{ id: "shipwright", windows_shipwright_persistence: true }],
    }),
  );
  const result = item.run();
  assert.notEqual(result.status, 0);
  assert.match(
    result.stderr,
    /Format-1 signed catalogs cannot deliver Shipwright working-directory persistence/u,
  );
  assert.equal(existsSync(item.output), false);
});

void test("legacy signer refuses a Windows tracked handoff before key access", (t) => {
  const item = fixture();
  t.after(() => rmSync(item.root, { recursive: true, force: true }));
  rmSync(item.key);
  writeFileSync(
    item.catalog,
    JSON.stringify({
      ports: [{ id: "windows-restart", windows_tracked_handoff: true }],
    }),
  );
  const result = item.run();
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Format-1 signed catalogs cannot deliver a Windows tracked handoff/u);
  assert.equal(existsSync(item.output), false);
});

void test("legacy signer refuses empty-middle file patterns before key access", (t) => {
  const item = fixture();
  t.after(() => rmSync(item.root, { recursive: true, force: true }));
  rmSync(item.key);
  writeFileSync(
    item.catalog,
    JSON.stringify({
      ports: [
        {
          persistent_file_patterns: [{ prefix: "demorec.", suffix: "1", allow_empty_middle: true }],
        },
      ],
    }),
  );
  const result = item.run();
  assert.notEqual(result.status, 0);
  assert.match(
    result.stderr,
    /Format-1 signed catalogs cannot deliver empty-middle file patterns/u,
  );
  assert.equal(existsSync(item.output), false);
});

void test("legacy signer refuses an alternate forge selector before key access", (t) => {
  const item = fixture();
  t.after(() => rmSync(item.root, { recursive: true, force: true }));
  rmSync(item.key);
  writeFileSync(
    item.catalog,
    JSON.stringify({ ports: [{ release: { provider: "reviewed-forge" } }] }),
  );
  const result = item.run();
  assert.notEqual(result.status, 0);
  assert.match(
    result.stderr,
    /Format-1 signed catalogs cannot deliver reviewed alternate forge selectors/u,
  );
  assert.equal(existsSync(item.output), false);
});
