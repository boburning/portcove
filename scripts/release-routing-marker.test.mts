import assert from "node:assert/strict";
import test from "node:test";
import { lstat, readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { createHash } from "node:crypto";
import { disposableDirectory } from "./fixtures/disposable-directory.mts";
import {
  retainCompletedReleaseRoutingRecord,
  retainReleaseRoutingMarker,
} from "./release-routing-marker.mts";
import {
  inspectNativeRuntimeCustody,
  recheckNativeRuntimeCustody,
} from "./release-native-runtime-custody.mts";
import { errorCode } from "./runtime-values.mts";

void test("competing publishers retain one complete winner and both original staging records", async (t) => {
  const root = disposableDirectory(t, path.join(os.tmpdir(), "routing-marker-"));
  const file = path.join(root, "event.json");
  const values = [
    { slot: 1, text: "a".repeat(8192) },
    { slot: 2, text: "b".repeat(8192) },
  ];
  const results = await Promise.allSettled(
    values.map((value) => retainReleaseRoutingMarker(file, value)),
  );
  assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
  const rejected = results.find((result) => result.status === "rejected");
  assert.ok(rejected?.status === "rejected" && errorCode(rejected.reason) === "EEXIST");
  const observed = await readFile(file);
  assert.ok(values.some((value) => observed.equals(Buffer.from(JSON.stringify(value)))));
  const aliases = (await readdir(root)).filter((name) => name.includes(".retained-"));
  assert.equal(aliases.length, 2);
  assert.equal((await lstat(file)).nlink, 2);
  const retained = await Promise.all(aliases.map((name) => readFile(path.join(root, name))));
  for (const value of values)
    assert.ok(retained.some((bytes) => bytes.equals(Buffer.from(JSON.stringify(value)))));
});

void test("completed routing data retains single-link native custody and bounded atomic completion", async (t) => {
  const root = disposableDirectory(t, path.join(os.homedir(), ".completed-routing-"));
  const file = path.join(root, "windows-stage.json"),
    value = { schema_version: 1, authority: "none", stage: "pre-sign" };
  await retainCompletedReleaseRoutingRecord(file, value);
  const bytes = await readFile(file);
  assert.equal((await lstat(file)).nlink, 1);
  assert.equal((await lstat(`${file}.complete.json`)).nlink, 2);
  assert.deepEqual(JSON.parse(await readFile(`${file}.complete.json`, "utf8")), {
    schema_version: 1,
    record: "windows-stage.json",
    bytes: bytes.length,
    sha256: createHash("sha256").update(bytes).digest("hex"),
    authority: "none",
  });
  const custody = inspectNativeRuntimeCustody([file]);
  recheckNativeRuntimeCustody([file], custody);
  await assert.rejects(retainCompletedReleaseRoutingRecord(file, { replaced: true }), {
    code: "EEXIST",
  });
  assert.deepEqual(await readFile(file), bytes);
});

void test("completed routing refusal preserves an existing completion and refuses oversized publication", async (t) => {
  const root = disposableDirectory(t, path.join(os.tmpdir(), "completed-routing-refusal-"));
  const oversized = path.join(root, "large.json");
  await assert.rejects(retainCompletedReleaseRoutingRecord(oversized, { text: "a".repeat(8192) }));
  assert.deepEqual(await readdir(root), []);
  const file = path.join(root, "retained.json");
  await writeFile(`${file}.complete.json`, "original", { flag: "wx" });
  await assert.rejects(retainCompletedReleaseRoutingRecord(file, { partial: true }), {
    code: "EEXIST",
  });
  await assert.rejects(readFile(file), { code: "ENOENT" });
  assert.equal(await readFile(`${file}.complete.json`, "utf8"), "original");
  await assert.rejects(retainCompletedReleaseRoutingRecord(file, { retry: true }), {
    code: "EEXIST",
  });
});

void test("serialization refusal publishes nothing; an existing final remains byte-identical", async (t) => {
  const root = disposableDirectory(t, path.join(os.tmpdir(), "routing-marker-refusal-"));
  const file = path.join(root, "event.json");
  await assert.rejects(retainReleaseRoutingMarker(file, { value: 1n }), /BigInt/u);
  assert.deepEqual(await readdir(root), []);
  await writeFile(file, "original", { flag: "wx" });
  const before = await lstat(file);
  await assert.rejects(retainReleaseRoutingMarker(file, { value: "replacement" }), {
    code: "EEXIST",
  });
  assert.equal(await readFile(file, "utf8"), "original");
  const after = await lstat(file);
  assert.equal(after.ino, before.ino);
  assert.equal(after.ctimeMs, before.ctimeMs);
  assert.equal((await readdir(root)).length, 2);
});
