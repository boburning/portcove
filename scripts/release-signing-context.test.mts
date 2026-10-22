import assert from "node:assert/strict";
import test from "node:test";
import { createHash } from "node:crypto";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import {
  mergeReleaseRecordBytes,
  releaseRecordManifestBytes,
  releaseSigningContextBytes,
  prepareReleaseSigningContext,
  requireReleaseSigningContext,
  prepareControllerReleaseSigningContext,
} from "./release-signing-context.mts";
import type { inspectPreparedMetadataRenewal } from "./release-metadata-renewal.mts";
import { readRemoteCoordinatorSnapshot } from "./release-coordinator-recovery.mts";
import { performance } from "node:perf_hooks";

void test("fixed current-baseline preparation refuses imported payload before configuration or output and honors finite deadline", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "release-context-controller-refusal-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await assert.rejects(
    prepareControllerReleaseSigningContext({}, root, performance.now() + 1000),
    /actual same-process payload/,
  );
  await assert.rejects(
    prepareControllerReleaseSigningContext({}, root, performance.now() - 1),
    /deadline/,
  );
  assert.deepEqual(await readdir(root), []);
});
void test("current journal snapshot caps real default transport to remaining context phase before each request", async () => {
  const configuration = { schema_version: 1, namespace: "portcove-fixture" };
  let calls = 0;
  const transport = {
    cwd: process.cwd(),
    spawn: (
      _command: string,
      _args: readonly string[],
      settings?: import("node:child_process").SpawnSyncOptionsWithStringEncoding,
    ) => {
      calls++;
      assert.ok(
        typeof settings?.timeout === "number" && settings.timeout > 0 && settings.timeout <= 1000,
      );
      return {
        status: 0,
        stdout: "HTTP/2.0 503 Unavailable\r\nContent-Type: application/json\r\n\r\n{}",
        stderr: "",
      };
    },
  };
  await assert.rejects(
    readRemoteCoordinatorSnapshot(process.cwd(), configuration, {
      transport: { ...transport, deadline: performance.now() - 1 },
    }),
    /deadline/,
  );
  assert.equal(calls, 0);
  await assert.rejects(
    readRemoteCoordinatorSnapshot(process.cwd(), configuration, {
      transport: { ...transport, deadline: performance.now() + 1000 },
    }),
  );
  assert.equal(calls, 1);
});

void test("release record merge preserves exact historical bytes and rejects re-issued or unsafe targets", () => {
  const name = "releases/1.0.0/windows-x86_64/nsis.json",
    bytes = Buffer.from("historical\n");
  const old = new Map([[name, bytes]]),
    added = new Map([["channels/preview/windows-x86_64/nsis/1.1.0.json", Buffer.from("new\n")]]);
  const merged = mergeReleaseRecordBytes(old, added);
  bytes.fill(0);
  assert.equal(merged.get(name)!.toString(), "historical\n");
  assert.equal(merged.size, 2);
  assert.throws(
    () => mergeReleaseRecordBytes(merged, new Map([[name, Buffer.from("replacement")]])),
    /collision/,
  );
  for (const name of [
    "../x.json",
    "releases/../x.json",
    "keys/payload.json",
    "releases//x.json",
    "releases/x.json/extra",
  ])
    assert.throws(
      () => mergeReleaseRecordBytes(new Map(), new Map([[name, Buffer.from("x")]])),
      /path/,
    );
  assert.throws(
    () =>
      mergeReleaseRecordBytes(
        new Map(),
        new Map([["releases/x.json", Buffer.alloc(1024 * 1024 + 1)]]),
      ),
    /bytes/,
  );
});
void test("combined reconstruction manifest covers every retained record and exact byte identity", () => {
  const name = "releases/1.0.0/windows-x86_64/nsis.json",
    bytes = Buffer.from("exact\n"),
    files = new Map([[name, bytes]]);
  const entry = {
    kind: "release",
    path: name,
    version: "1.0.0",
    target: "windows-x86_64",
    package: "nsis",
    bytes: bytes.length,
    sha256: createHash("sha256").update(bytes).digest("hex"),
  };
  const manifest = { schema_version: 1, records: [entry] };
  assert.deepEqual(
    JSON.parse(releaseRecordManifestBytes([manifest, manifest], files).toString()),
    manifest,
  );
  assert.throws(
    () => releaseRecordManifestBytes([{ ...manifest, records: [] }], files),
    /incomplete/,
  );
  assert.throws(
    () =>
      releaseRecordManifestBytes(
        [{ ...manifest, records: [{ ...entry, sha256: "0".repeat(64) }] }],
        files,
      ),
    /byte identity/,
  );
  assert.throws(
    () =>
      releaseRecordManifestBytes(
        [manifest, { ...manifest, records: [{ ...entry, version: "other" }] }],
        files,
      ),
    /collision/,
  );
});
void test("context preserves exact positive u64 numeric tokens above Number precision", () => {
  type Descriptor = Awaited<ReturnType<typeof inspectPreparedMetadataRenewal>>["descriptor"];
  const descriptor = {
    generated_at: "2026-10-20T00:00:00Z",
    next_versions: Object.fromEntries(
      ["targets", "releases", "preview", "stable", "snapshot", "timestamp"].map((role) => [
        role,
        "18446744073709551615",
      ]),
    ),
    next_expires: {},
  } as Descriptor;
  const bytes = releaseSigningContextBytes(descriptor).toString();
  assert.match(bytes, /"releases":18446744073709551615/);
  assert.doesNotMatch(bytes, /"18446744073709551615"/);
  const raw: unknown = JSON.parse(bytes);
  assert.equal(typeof raw, "object");
  assert(!bytes.includes("initial_root_profile"));
  const one = releaseSigningContextBytes(descriptor, "single-owner-one-of-one-v1").toString();
  assert.match(one, /"initial_root_profile":"single-owner-one-of-one-v1"/);
  assert.match(one, /"releases":18446744073709551615/);
  const online = releaseSigningContextBytes(
    { ...descriptor, schema_version: 2 },
    "single-owner-one-of-one-v1",
    "online-unchanged-authority-v1",
  ).toString();
  assert.match(online, /"top_level_targets_profile":"online-unchanged-authority-v1"/);
  assert.match(online, /"releases":18446744073709551615/);
  assert.throws(
    () => releaseSigningContextBytes({ ...descriptor, schema_version: 2 }),
    /Targets mode/,
  );
  assert.throws(
    () =>
      releaseSigningContextBytes(
        { ...descriptor, schema_version: 2 },
        "legacy-two-of-three-v1",
        "online-unchanged-authority-v1",
      ),
    /single-owner/,
  );
  assert.throws(
    () => releaseSigningContextBytes(descriptor, "download-selected" as never),
    /Root profile/,
  );
  for (const invalid of ["0", "01", "18446744073709551616", "1e3", '1,"extra":1'])
    assert.throws(
      () =>
        releaseSigningContextBytes({
          ...descriptor,
          next_versions: { ...descriptor.next_versions, releases: invalid },
        }),
      /u64/,
    );
});
void test("imported context/payload cannot mint genuine same-process context or create outputs", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "release-context-refusal-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await assert.rejects(
    requireReleaseSigningContext({ kind: "actual-release-signing-context", authority: "none" }),
    /same-process/,
  );
  await assert.rejects(
    prepareReleaseSigningContext(
      {},
      {
        kind: "authenticated-metadata-renewal-preparation",
        descriptor_sha256: "0".repeat(64),
        input_manifest_sha256: "1".repeat(64),
      },
      root,
    ),
    /same-process/,
  );
  assert.deepEqual(await readdir(root), []);
});
