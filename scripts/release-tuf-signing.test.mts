import assert from "node:assert/strict";
import {
  assembleIsolatedTufPublication,
  inspectTufAssemblyInputs,
  requireActualTufPublication,
} from "./release-tuf-publication.mts";
import { test } from "node:test";

import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, writeFile, rm, readdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { payloadSigningEnvironment } from "./release-payload-signing.mts";
import { disposableTufWorkerFixture } from "./fixtures/tuf-worker-fixture.mts";
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
void test("role lifecycle callbacks are captured before asynchronous input acquisition", async () => {
  const f = await fixture();
  let guarded = 0,
    keys = 0;
  try {
    const lifecycle = {
      deadline: performance.now() + 10000,
      beforeKey: async (): Promise<void> => {
        guarded++;
        throw new Error("public guard refusal");
      },
      keyMaterial: async () => {
        keys++;
        return Buffer.from("never");
      },
    };
    const operation = signIsolatedTufRole(f.request, lifecycle);
    lifecycle.beforeKey = async () => {};
    lifecycle.keyMaterial = async () => {
      keys++;
      return Buffer.from("replacement");
    };
    await assert.rejects(operation, /public evidence retained/u);
    assert.equal(guarded, 1);
    assert.equal(keys, 0);
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
void test(
  "actual pinned Rust signs five distinct disposable online roles and rejects a wrong role key",
  { skip: !process.env.PORTCOVE_TUF_WORKER_QUALIFICATION_TOOL, timeout: 30000 },
  async () => {
    const tool = process.env.PORTCOVE_TUF_WORKER_QUALIFICATION_TOOL!,
      sha256 = process.env.PORTCOVE_TUF_WORKER_QUALIFICATION_SHA256;
    assert.ok(path.isAbsolute(tool) && sha256 && /^[a-f0-9]{64}$/u.test(sha256));
    assert.equal(hash(await readFile(tool)), sha256);
    const root = await mkdtemp(path.join(os.tmpdir(), "tuf-worker-real-disposable-"));
    const input = path.join(root, "public-context"),
      keys = await disposableTufWorkerFixture(input);
    let passed = false;
    try {
      const results: Awaited<ReturnType<typeof signIsolatedTufRole>>[] = [];
      for (const role of ["releases", "preview", "stable", "snapshot", "timestamp"] as const) {
        const signed_roles = tufRoleDependencies(role).map((dependency) => {
          const result = results.find((entry) => entry.role === dependency);
          assert.ok(result);
          return {
            filename: result.filename,
            path: result.path,
            bytes: result.bytes,
            sha256: result.sha256,
          };
        });
        const key = Buffer.from(keys[role]);
        const result = await signIsolatedTufRole(
          {
            role,
            context_directory: input,
            output: path.join(root, role),
            tool: { path: tool, sha256 },
            signed_roles,
          },
          {
            deadline: performance.now() + 10000,
            beforeKey: async () => {},
            keyMaterial: async () => key,
          },
        );
        assert.equal(result.authority, "none");
        assert.ok(key.every((byte) => byte === 0));
        assert.equal(hash(await readFile(result.path)), result.sha256);
        assert.ok(!(await readdir(path.dirname(result.path))).includes("private-work"));
        results.push(result);
      }
      const wrong = Buffer.from(keys.preview);
      const assembled = await assembleIsolatedTufPublication(
        {
          context_directory: input,
          tool: { path: tool, sha256 },
          signed_roles: results.map(
            ({ filename, path: envelopePath, bytes, sha256: envelopeSha }) => ({
              filename,
              path: envelopePath,
              bytes,
              sha256: envelopeSha,
            }),
          ),
          output_parent: root,
        },
        performance.now() + 10000,
      );
      assert.equal(assembled.records, 0);
      assert.equal(assembled.publication.records_sha256, hash(Buffer.from("[]")));
      assert.ok(!(await readdir(assembled.directory)).includes("private-work"));
      await assert.rejects(requireActualTufPublication(assembled), /actual keyless/u);
      const reordered = results.map(
        ({ filename, path: envelopePath, bytes, sha256: envelopeSha }) => ({
          filename,
          path: envelopePath,
          bytes,
          sha256: envelopeSha,
        }),
      );
      [reordered[0], reordered[1]] = [reordered[1]!, reordered[0]!];
      assert.throws(() => inspectTufAssemblyInputs(reordered), /five exact/u);
      const malformed = Buffer.from('{"signed":{},"signatures":[]}');
      const tampered = path.join(root, "tampered-releases.json");
      await writeFile(tampered, malformed, { flag: "wx" });
      const forged = results.map(
        ({ filename, path: envelopePath, bytes, sha256: envelopeSha }) => ({
          filename,
          path: envelopePath,
          bytes,
          sha256: envelopeSha,
        }),
      );
      forged[0] = {
        filename: "releases.json",
        path: tampered,
        bytes: malformed.length,
        sha256: hash(malformed),
      };
      await assert.rejects(
        assembleIsolatedTufPublication(
          {
            context_directory: input,
            tool: { path: tool, sha256 },
            signed_roles: forged,
            output_parent: root,
          },
          performance.now() + 10000,
        ),
        /public evidence retained/u,
      );
      await assert.rejects(
        signIsolatedTufRole(
          {
            role: "releases",
            context_directory: input,
            output: path.join(root, "wrong-key"),
            tool: { path: tool, sha256 },
            signed_roles: [],
          },
          {
            deadline: performance.now() + 10000,
            beforeKey: async () => {},
            keyMaterial: async () => wrong,
          },
        ),
        /public evidence retained/u,
      );
      assert.ok(wrong.every((byte) => byte === 0));
      assert.ok(!(await readdir(path.join(root, "wrong-key"))).includes("releases.json"));
      passed = true;
    } finally {
      for (const key of Object.values(keys)) key.fill(0);
      if (passed) await rm(root, { recursive: true, force: true });
      else process.stderr.write(`Retain public disposable TUF evidence: ${root}\n`);
    }
  },
);

void test("actual isolated signer rechecks guard after final custody and deadline before key material", async () => {
  const { stripTypeScriptTypes } = await import("node:module");
  const { runInNewContext } = await import("node:vm");
  const { releaseCanonicalDigest: digest } = await import("./release-canonical.mts");
  const source = await readFile(new URL("./release-tuf-signing.mts", import.meta.url), "utf8");
  const start = source.indexOf('phase = "fresh-controls-before-key";'),
    end = source.indexOf("\n    if (!Buffer.isBuffer(secret)", start);
  assert(start > 0 && end > start);
  for (const deadlineExpiry of [false, true]) {
    let clock = 59000,
      keys = 0;
    const guards: number[] = [];
    const tool = Buffer.from("unchanged reviewed tool");
    const guarded = runInNewContext(
      stripTypeScriptTypes(
        "async function guarded(){let phase,secret;" + source.slice(start, end) + "}\nguarded",
      ),
      {
        request: {
          context_directory: "original",
          tool: { path: "fixed", sha256: hash(tool) },
          signed_roles: [],
        },
        publicRoot: "retained",
        inputDigest: digest([]),
        tool: "copy",
        deadline: 115000,
        digest,
        hash,
        inventory: () => [],
        readBoundedReleaseContextFiles: async () => {
          clock = 61000;
          return new Map();
        },
        readControllerToolFile: async () => tool,
        beforeKey: async () => {
          guards.push(clock);
          if (guards.length === 2) {
            if (deadlineExpiry) clock = 116000;
            else throw new Error("original controls expired");
          }
        },
        remaining: () => {
          if (clock >= 115000) throw new Error("original signer deadline exhausted");
        },
        keyMaterial: async () => {
          keys++;
          return Buffer.from("never");
        },
      },
    ) as () => Promise<void>;
    await assert.rejects(
      guarded(),
      deadlineExpiry ? /signer deadline exhausted/ : /controls expired/,
    );
    assert.deepEqual(guards, [59000, 61000]);
    assert.equal(keys, 0);
  }
});
