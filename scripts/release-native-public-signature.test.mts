import assert from "node:assert/strict";
import test from "node:test";
import path from "node:path";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import {
  inspectPublicSignatureControlReport,
  planPublicSignatureControl,
  runActualPublicSignatureControl,
  requireActualPublicSignatureControl,
} from "./release-native-public-signature.mts";
const expected = {
  config_sha256: "a".repeat(64),
  registry_sha256: "b".repeat(64),
  payload_sha256: "c".repeat(64),
  payload_bytes: 123,
  payload_key_id: "d".repeat(64),
  v1_signature_sha256: "e".repeat(64),
  prior_signature_sha256: "f".repeat(64),
};
const report = () => ({
  ...expected,
  schema_version: 1,
  kind: "public-signature-control",
  authority: "none",
  native_acceptance: "not-established",
  scope: "shipping payload verifier component only; caller owns public provenance",
  positive: "verified",
  negative: "SignatureMismatch",
});

void test("signature component report requires positive verification, exact negative type and every raw input identity", () => {
  assert.deepEqual(inspectPublicSignatureControlReport(report(), expected), report());
  for (const key of Object.keys(expected)) {
    assert.throws(() =>
      inspectPublicSignatureControlReport({ ...report(), [key]: "changed" }, expected),
    );
  }
  for (const changed of [
    { positive: "failed" },
    { negative: "HashMismatch" },
    { negative: "InvalidVerificationMaterial" },
    { native_acceptance: "accepted" },
    { authority: "native" },
    { scope: "public native proof" },
    { extra: true },
    { schema_version: 2 },
  ])
    assert.throws(() => inspectPublicSignatureControlReport({ ...report(), ...changed }, expected));
});

void test("fixed component command carries only pinned mode/paths/hash and a scrubbed original-clock environment", () => {
  const directory = path.resolve(tmpdir(), "signature-fixed-plan");
  const executable = path.join(
    directory,
    `verify_packaged_application_update${process.platform === "win32" ? ".exe" : ""}`,
  );
  const config = path.join(directory, "control.json"),
    deadline = performance.now() + 5000;
  const command = planPublicSignatureControl(
    executable,
    config,
    expected.config_sha256,
    directory,
    deadline,
  );
  assert.deepEqual(command.arguments, ["public-signature-control", config, expected.config_sha256]);
  assert.ok(command.options.timeout > 0 && command.options.timeout <= 5000);
  assert.equal(command.options.cwd, directory);
  assert.equal(command.options.maxBuffer, 64 * 1024);
  assert.deepEqual(
    Object.keys(command.options.env).sort(),
    [
      "APPDATA",
      "HOME",
      "LOCALAPPDATA",
      "PATH",
      "SystemDrive",
      "SystemRoot",
      "TEMP",
      "TMP",
      "TMPDIR",
      "USERPROFILE",
      "WINDIR",
    ].sort(),
  );
  for (const secret of [
    "GH_TOKEN",
    "GITHUB_TOKEN",
    "PORTCOVE_NATIVE_APP_PRIVATE_KEY",
    "NODE_OPTIONS",
    "NODE_PATH",
    "AWS_SECRET_ACCESS_KEY",
  ])
    assert.ok(!(secret in command.options.env));
  assert.throws(() =>
    planPublicSignatureControl(
      path.join(directory, "other.exe"),
      config,
      expected.config_sha256,
      directory,
      deadline,
    ),
  );
  assert.throws(() =>
    planPublicSignatureControl(
      executable,
      config,
      expected.config_sha256,
      directory,
      performance.now() - 1,
    ),
  );
  assert.throws(() =>
    planPublicSignatureControl(executable, config, expected.config_sha256, directory, Number.NaN),
  );
  assert.throws(() =>
    planPublicSignatureControl(
      executable,
      path.join(directory, "else.json"),
      expected.config_sha256,
      directory,
      deadline,
    ),
  );
});

void test("imported public receipts cannot create configuration, start a child or mint a component receipt", async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), "public-signature-import-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await assert.rejects(
    runActualPublicSignatureControl(
      { kind: "actual-public-journey-pair" },
      {},
      {},
      directory,
      performance.now() + 10000,
    ),
    /actual parent\/public Tough pair required/u,
  );
  assert.deepEqual(await readdir(directory), []);
  await assert.rejects(
    requireActualPublicSignatureControl({
      kind: "actual-public-signature-component",
      authority: "none",
    }),
    /actual public signature component receipt required/u,
  );
  await assert.rejects(
    runActualPublicSignatureControl({}, {}, {}, directory, performance.now() - 1),
    /deadline exhausted/u,
  );
  assert.deepEqual(await readdir(directory), []);
});
