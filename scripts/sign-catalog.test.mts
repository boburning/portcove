import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash, generateKeyPairSync, verify } from "node:crypto";
import { copyFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
  const run = (args: readonly string[] = []) =>
    spawnSync(
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
  return { root, key, catalog, output, publicKey, run };
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

void test("offline catalog signer refuses invalid bounds, input and key algorithms", (t) => {
  const item = fixture();
  t.after(() => rmSync(item.root, { recursive: true, force: true }));
  for (const args of [
    ["--sequence", "0"],
    ["--sequence", "NaN"],
    ["--expires-at", "100"],
    ["--expires-at", String(101 + 366 * 86400)],
  ]) {
    const result = item.run(args);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /positive safe integer sequence and Unix-second validity/u);
    assert.equal(result.stdout, "");
  }
  writeFileSync(item.catalog, "{");
  assert.notEqual(item.run().status, 0);
  writeFileSync(item.catalog, Buffer.alloc(4 * 1024 * 1024 + 1));
  assert.match(item.run().stderr, /bounded regular file/u);
  assert.match(item.run(["--catalog", item.root]).stderr, /bounded regular file/u);
  writeFileSync(item.catalog, "{}");
  const wrong = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  writeFileSync(item.key, wrong.privateKey.export({ format: "pem", type: "pkcs8" }));
  assert.match(item.run().stderr, /Ed25519 private key is required/u);
  const missing = spawnSync(process.execPath, [path.join(item.root, "sign-catalog.mts")], {
    encoding: "utf8",
    timeout: 10_000,
    windowsHide: true,
  });
  assert.notEqual(missing.status, 0);
  assert.match(missing.stderr, /--catalog is required/u);
});
