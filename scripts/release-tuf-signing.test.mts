import assert from "node:assert/strict";
import { test } from "node:test";

import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, writeFile, rm, readdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { payloadSigningEnvironment } from "./release-payload-signing.mts";
import {
  inspectTufSigningRole,
  tufRoleDependencies,
  decodeTufRoleKey,
  inspectTufContextPaths,
  signIsolatedTufRole,
} from "./release-tuf-signing.mts";

const hash = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
const context = Buffer.from(
  '{"schema_version":1,"generated_at":"2026-10-20T00:00:00Z","trusted_root":"trusted-root.json","offline_targets":"offline-targets.json","payload_key_registry":"payload.json","reconstructed_records":"records","previous_repository":"prior","versions":{"targets":1,"releases":9007199254740993},"expires":{}}',
);
async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), "portcove-tuf-worker-"));
  const input = path.join(root, "inputs"),
    tool = path.join(root, "tool");
  await mkdir(input);
  await writeFile(path.join(input, "context.json"), context);
  const toolBytes = Buffer.from("fixed disposable fixture tool bytes");
  await writeFile(tool, toolBytes);
  return {
    root,
    input,
    tool,
    request: {
      role: "releases" as const,
      context_directory: input,
      output: path.join(root, "result"),
      tool: { path: tool, sha256: hash(toolBytes) },
      signed_roles: [],
    },
  };
}
void test("TUF role policy forbids offline roles, exact dependency sets and external context paths", () => {
  for (const role of ["root", "targets", "payload", "release", "", null])
    assert.throws(() => inspectTufSigningRole(role));
  assert.deepEqual(tufRoleDependencies("releases"), []);
  assert.deepEqual(tufRoleDependencies("snapshot"), ["releases", "preview", "stable"]);
  assert.deepEqual(tufRoleDependencies("timestamp"), ["releases", "preview", "stable", "snapshot"]);
  assert.throws(() => (tufRoleDependencies("timestamp") as string[]).push("root"));
  assert.equal(inspectTufContextPaths(context).kind, "routine");
  assert.throws(() =>
    inspectTufContextPaths(Buffer.from(context.toString().replace('"prior"', '"/ambient"'))),
  );
  assert.throws(() =>
    inspectTufContextPaths(
      Buffer.from(
        context.toString().replace('"schema_version":1', '"extra":true,"schema_version":1'),
      ),
    ),
  );
  assert.deepEqual(decodeTufRoleKey("AQID"), Buffer.from([1, 2, 3]));
  for (const value of ["", "AQID\n", "a", "AQ==\n", "not a key", "A".repeat(32769)])
    assert.throws(() => decodeTufRoleKey(value));
});
void test("TUF worker refuses incomplete dependencies, wrong pins and expired phase before key/output", async () => {
  const f = await fixture();
  let keys = 0;
  try {
    const lifecycle = {
      beforeKey: async () => {},
      keyMaterial: async () => {
        keys++;
        return Buffer.from("secret");
      },
      deadline: performance.now() + 10000,
    };
    await assert.rejects(
      signIsolatedTufRole({ ...f.request, role: "snapshot" }, lifecycle),
      /dependencies/u,
    );
    await assert.rejects(
      signIsolatedTufRole(
        { ...f.request, tool: { ...f.request.tool, sha256: "a".repeat(64) } },
        lifecycle,
      ),
      /tool bytes/u,
    );
    await assert.rejects(
      signIsolatedTufRole(f.request, { ...lifecycle, deadline: performance.now() - 1 }),
      /deadline/u,
    );
    assert.equal(keys, 0);
    assert.deepEqual((await readdir(f.root)).sort(), ["inputs", "tool"]);
  } finally {
    await rm(f.root, { recursive: true, force: true });
  }
});
void test("fresh-guard mutation refuses before key, retains public refusal and removes credential scratch", async () => {
  const f = await fixture();
  let keys = 0;
  try {
    await assert.rejects(
      signIsolatedTufRole(f.request, {
        deadline: performance.now() + 10000,
        beforeKey: async () => {
          await writeFile(
            path.join(f.request.output, "public-inputs", "context.json"),
            Buffer.from("changed"),
          );
        },
        keyMaterial: async () => {
          keys++;
          return Buffer.from("never");
        },
      }),
      /public evidence retained/u,
    );
    assert.equal(keys, 0);
    assert.deepEqual((await readdir(f.request.output)).sort(), ["public-inputs", "refusal.json"]);
    const refusal = JSON.parse(
      await readFile(path.join(f.request.output, "refusal.json"), "utf8"),
    ) as { phase: string; partial_envelope: null };
    assert.equal(refusal.phase, "fresh-controls-before-key");
    assert.equal(refusal.partial_envelope, null);
  } finally {
    await rm(f.root, { recursive: true, force: true });
  }
});
void test("actual credential-free wrong executable refuses after key release and scrubs all credential scratch", async () => {
  const f = await fixture();
  const secret = Buffer.from("disposable fixture key, not a signing key");
  try {
    const executable =
      process.platform === "win32"
        ? path.join(process.env.SystemRoot!, "System32", "where.exe")
        : "/usr/bin/false";
    const bytes = await readFile(executable);
    await writeFile(f.tool, bytes);
    let keys = 0;
    await assert.rejects(
      signIsolatedTufRole(
        { ...f.request, tool: { path: f.tool, sha256: hash(bytes) } },
        {
          deadline: performance.now() + 10000,
          beforeKey: async () => {},
          keyMaterial: async () => {
            keys++;
            return secret;
          },
        },
      ),
      /public evidence retained/u,
    );
    assert.equal(keys, 1);
    assert.ok(secret.every((byte) => byte === 0));
    assert.deepEqual((await readdir(f.request.output)).sort(), ["public-inputs", "refusal.json"]);
    const text = await readFile(path.join(f.request.output, "refusal.json"), "utf8");
    const refusal = JSON.parse(text) as { phase: string; partial_envelope: null };
    assert.equal(refusal.phase, "fixed-rust-sign");
    assert.equal(refusal.partial_envelope, null);
    assert.ok(!text.includes("disposable fixture key"));
    await assert.rejects(
      signIsolatedTufRole(f.request, {
        deadline: performance.now() + 10000,
        beforeKey: async () => {},
        keyMaterial: async () => secret,
      }),
      /tool bytes/u,
    );
    const environment = payloadSigningEnvironment(path.join(f.root, "private"));
    for (const key of [
      "GH_TOKEN",
      "PATH",
      "NODE_OPTIONS",
      "AWS_SECRET_ACCESS_KEY",
      "TAURI_SIGNING_PRIVATE_KEY",
    ])
      assert.equal(environment[key], undefined);
    assert.equal(environment.HOME, path.join(f.root, "private", "home"));
  } finally {
    await rm(f.root, { recursive: true, force: true });
  }
});
