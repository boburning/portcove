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
  writeFileSync(item.catalog, Buffer.alloc(4194305, "PRIVATE_INPUT_CANARY"));
  refuses([], /--catalog.*4194304-byte read limit.*received 4194305 bytes/u);
  refuses(["--catalog", item.root], /--catalog.*regular file.*directory.*4194304 bytes/u);
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
  const catalog = JSON.stringify({ fixture: '"'.repeat(1100000) });
  assert.ok(Buffer.byteLength(catalog) < 4194304);
  writeFileSync(item.catalog, catalog);
  const result = item.run();
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /envelope.*4194304-byte.*received \d+ bytes after JSON escaping/u);
  assert.equal(result.stdout, "");
  assert.equal(existsSync(item.output), false);
});

void test("offline capacity diagnostics count escaped growth and retain the existing byte authority", async () => {
  const { catalogCapacity, capacityConstant } = await import("./catalog-capacity.mts");
  const limit = capacityConstant(
    readFileSync(new URL("../crates/portcove-core/src/signed_catalog.rs", import.meta.url), "utf8"),
    "MAX_CATALOG_BYTES",
  );
  assert.equal(limit, 4 * 1024 * 1024);
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
