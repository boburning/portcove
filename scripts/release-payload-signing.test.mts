import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { copyFile, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import {
  assertSignedPayloadVersion,
  inspectPayloadSigningRequest,
  signReleasePayload,
} from "./release-payload-signing.mts";
import type { PayloadSigningRequest } from "./release-payload-signing.mts";

const run = promisify(execFile);
const sha = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
function request(): PayloadSigningRequest {
  return {
    schema_version: 1,
    repository: "boburning/portcove",
    version: "0.3.0-beta.1",
    source_commit: "a".repeat(40),
    platform_label: "windows-x86_64",
    filename: "Portcove_0.3.0-beta.1_x64-setup.exe",
    sha256: "b".repeat(64),
    bytes: 180321,
    public_key_sha256: "c".repeat(64),
    qualification_inventory_sha256: "d".repeat(64),
    producer: { run_id: "123", run_attempt: 1, job_id: "456", artifact_id: "789" },
  };
}
void test("signing request snapshots exact independent identities and refuses malformed inputs", () => {
  const original = request();
  const parsed = inspectPayloadSigningRequest(original);
  original.producer.run_id = "999";
  assert.equal(parsed.producer.run_id, "123");
  for (const change of [
    { version: "1.0.0\tversion:2" },
    { filename: "../payload.exe" },
    { bytes: 0 },
    { bytes: 2 * 1024 ** 3 + 1 },
    { source_commit: "main" },
    { qualification_inventory_sha256: "" },
    { public_key_sha256: "" },
    { platform_label: "macos-x86_64" },
    { producer: { run_id: "123", run_attempt: 1, job_id: null, artifact_id: "789" } },
  ])
    assert.throws(() => inspectPayloadSigningRequest({ ...request(), ...change }));
});
void test("signed version parser refuses missing/wrong version and wrong filename", () => {
  const encode = (comment: string) =>
    Buffer.from(`untrusted comment: test\nAAA\ntrusted comment: ${comment}\nBBB\n`).toString(
      "base64",
    );
  assertSignedPayloadVersion(
    encode("timestamp:123\tfile:test.exe\tversion:1.0.0"),
    "test.exe",
    "1.0.0",
  );
  for (const comment of [
    "timestamp:123\tfile:test.exe",
    "timestamp:123\tfile:test.exe\tversion:0.9.0",
    "timestamp:123\tfile:other.exe\tversion:1.0.0",
    "timestamp:123\tfile:test.exe\tversion:1.0.0\tversion:2.0.0",
  ])
    assert.throws(() => assertSignedPayloadVersion(encode(comment), "test.exe", "1.0.0"));
});

function installedAddon() {
  try {
    const desktopRequire = createRequire(new URL("../apps/desktop/package.json", import.meta.url));
    const cliRequire = createRequire(desktopRequire.resolve("@tauri-apps/cli/package.json"));
    const platform =
      process.platform === "win32"
        ? "win32-x64-msvc"
        : process.platform === "linux"
          ? "linux-x64-gnu"
          : process.platform === "darwin"
            ? `darwin-${process.arch}`
            : "unsupported";
    return cliRequire.resolve(`@tauri-apps/cli-${platform}`);
  } catch {
    return undefined;
  }
}
const addon = process.env.PORTCOVE_TEST_TAURI_ADDON ?? installedAddon();
const defaultVerifier = fileURLToPath(
  new URL(
    `../target/debug/portcove-release-tools${process.platform === "win32" ? ".exe" : ""}`,
    import.meta.url,
  ),
);
const verifier =
  process.env.PORTCOVE_TEST_PAYLOAD_VERIFIER ??
  (existsSync(defaultVerifier) ? defaultVerifier : undefined);
void test(
  "real pinned Tauri signs disposable bytes; Rust authenticates bytes/key and signed version",
  {
    skip: (!addon || !verifier) && process.env.PORTCOVE_REQUIRE_SIGNER_FIXTURE !== "1",
    timeout: 120_000,
  },
  async (t) => {
    assert.ok(
      addon && verifier,
      "the signing rehearsal requires installed pinned addon and built Rust verifier",
    );
    const root = await mkdtemp(path.join(os.tmpdir(), "portcove-payload-signing-"));
    const priorKey = process.env.TAURI_SIGNING_PRIVATE_KEY;
    const priorPassword = process.env.TAURI_SIGNING_PRIVATE_KEY_PASSWORD;
    t.after(async () => {
      if (priorKey === undefined) delete process.env.TAURI_SIGNING_PRIVATE_KEY;
      else process.env.TAURI_SIGNING_PRIVATE_KEY = priorKey;
      if (priorPassword === undefined) delete process.env.TAURI_SIGNING_PRIVATE_KEY_PASSWORD;
      else process.env.TAURI_SIGNING_PRIVATE_KEY_PASSWORD = priorPassword;
      await rm(root, { recursive: true, force: true });
    });
    await mkdir(path.join(root, "release"));
    await copyFile(
      fileURLToPath(new URL("../release/package-policy.json", import.meta.url)),
      path.join(root, "release/package-policy.json"),
    );
    const fixtureLauncher = path.join(root, "fixture.cjs");
    await writeFile(
      fixtureLauncher,
      `require(${JSON.stringify(addon)}).run(process.argv.slice(2),"tauri",e=>{if(e)process.exitCode=1});`,
    );
    const privatePath = path.join(root, "disposable.key");
    await run(
      process.execPath,
      [
        fixtureLauncher,
        "signer",
        "generate",
        "--ci",
        "--password",
        "",
        "--write-keys",
        privatePath,
      ],
      { timeout: 30_000, maxBuffer: 64 * 1024, env: { SystemRoot: process.env.SystemRoot } },
    );
    process.env.TAURI_SIGNING_PRIVATE_KEY = await readFile(privatePath, "utf8");
    process.env.TAURI_SIGNING_PRIVATE_KEY_PASSWORD = "";
    const publicKey = `${privatePath}.pub`;
    const publicKeySha = sha(Buffer.from((await readFile(publicKey, "utf8")).trim(), "base64"));
    const payload = Buffer.from(Array.from({ length: 180321 }, (_, index) => index % 251));
    const admitted = { ...request(), sha256: sha(payload), public_key_sha256: publicKeySha };
    const payloadPath = path.join(root, admitted.filename);
    await writeFile(payloadPath, payload);
    const tools = {
      node: { path: process.execPath, sha256: sha(await readFile(process.execPath)) },
      tauriAddon: { path: addon, sha256: sha(await readFile(addon)) },
      verifier: { path: verifier, sha256: sha(await readFile(verifier)) },
    };
    const options = {
      projectRoot: root,
      request: admitted,
      payload: payloadPath,
      publicKey,
      output: path.join(root, "signed"),
      tools,
    };
    const receipt = await signReleasePayload(options);
    assert.equal(receipt.authority, "none");
    assert.deepEqual(await readdir(options.output), [`${admitted.filename}.sig`]);
    assert.deepEqual(await readFile(payloadPath), payload);
    const signaturePath = path.join(options.output, `${admitted.filename}.sig`);
    const signature = await readFile(signaturePath, "utf8");
    assertSignedPayloadVersion(signature, admitted.filename, admitted.version);
    assert.throws(() => assertSignedPayloadVersion(signature, admitted.filename, "0.3.0-beta.2"));
    const linuxRequest = {
      ...admitted,
      platform_label: "linux-x86_64" as const,
      filename: "Portcove_0.3.0-beta.1_amd64.AppImage",
    };
    const linux = await signReleasePayload({
      ...options,
      request: linuxRequest,
      output: path.join(root, "linux-signed"),
    });
    assert.equal(linux.signature.filename, `${linuxRequest.filename}.sig`);
    await assert.rejects(
      signReleasePayload({
        ...options,
        output: path.join(root, "wrong-key"),
        request: { ...admitted, public_key_sha256: "0".repeat(64) },
      }),
      /public key identity/,
    );
    const otherPrivate = path.join(root, "other.key");
    await run(
      process.execPath,
      [
        fixtureLauncher,
        "signer",
        "generate",
        "--ci",
        "--password",
        "",
        "--write-keys",
        otherPrivate,
      ],
      { timeout: 30_000, maxBuffer: 64 * 1024, env: { SystemRoot: process.env.SystemRoot } },
    );
    process.env.TAURI_SIGNING_PRIVATE_KEY = await readFile(otherPrivate, "utf8");
    await assert.rejects(
      signReleasePayload({ ...options, output: path.join(root, "wrong-private-key") }),
      /Rust payload verification refused/,
    );
    assert.deepEqual(await readdir(path.join(root, "wrong-private-key")), []);
    await rm(otherPrivate);
    // Consumer verification starts only after disposable private-store teardown.
    delete process.env.TAURI_SIGNING_PRIVATE_KEY;
    delete process.env.TAURI_SIGNING_PRIVATE_KEY_PASSWORD;
    await rm(privatePath);
    assert.equal(process.env.TAURI_SIGNING_PRIVATE_KEY, undefined);
    await assert.rejects(readFile(privatePath));
    await run(
      verifier,
      ["verify", payloadPath, signaturePath, publicKey, admitted.sha256, String(admitted.bytes)],
      { env: { SystemRoot: process.env.SystemRoot } },
    );
    const changed = Buffer.from(payload);
    changed[90000] = changed[90000]! ^ 1;
    await writeFile(payloadPath, changed);
    await assert.rejects(
      run(
        verifier,
        ["verify", payloadPath, signaturePath, publicKey, sha(changed), String(changed.length)],
        { env: { SystemRoot: process.env.SystemRoot } },
      ),
    );
    await assert.rejects(
      signReleasePayload({ ...options, output: path.join(root, "changed") }),
      /identity mismatch/,
    );
    await writeFile(payloadPath, payload);
    await assert.rejects(
      signReleasePayload({
        ...options,
        output: path.join(root, "wrong-version"),
        request: { ...admitted, version: "0.3.0-beta.2" },
      }),
      /exact policy/,
    );
    await assert.rejects(
      signReleasePayload({
        ...options,
        output: path.join(root, "wrong-tool"),
        tools: { ...tools, tauriAddon: { ...tools.tauriAddon, sha256: "0".repeat(64) } },
      }),
      /tool digest/,
    );
    await assert.rejects(signReleasePayload(options), /EEXIST/);
  },
);
