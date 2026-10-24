import assert from "node:assert/strict";
import test from "node:test";
import { lstat, readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { disposableDirectory } from "./fixtures/disposable-directory.mts";
import { retainReleaseRoutingMarker } from "./release-routing-marker.mts";
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
