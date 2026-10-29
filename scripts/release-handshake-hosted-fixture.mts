/** Credential-free process-lifetime fixture, never release/control authority. */
import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { mkdir, open } from "node:fs/promises";
import path from "node:path";
import { setTimeout } from "node:timers/promises";
import { retainReleaseRoutingMarker } from "./release-routing-marker.mts";

const hash = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");
const root = process.env.RUNNER_TEMP;
if (!root || !path.isAbsolute(root)) throw new Error("fixed runner root required");
const directory = path.join(root, "portcove-handshake-fixture");
const mode = process.argv[2];
if (process.argv.length !== 3 || !["start", "complete", "check"].includes(mode ?? ""))
  throw new Error("fixed fixture mode required");
async function read(name: string) {
  const handle = await open(path.join(directory, name), "r");
  try {
    const metadata = await handle.stat();
    if (!metadata.isFile() || metadata.size < 1 || metadata.size > 4096)
      throw new Error("fixture input exceeds bound");
    const bytes = Buffer.alloc(4097);
    let length = 0;
    for (;;) {
      const next = await handle.read(bytes, length, bytes.length - length);
      length += next.bytesRead;
      if (!next.bytesRead || length === bytes.length) break;
    }
    if (length !== metadata.size) throw new Error("fixture input changed or exceeds bound");
    return bytes.subarray(0, length);
  } finally {
    await handle.close();
  }
}
async function write(name: string, value: unknown) {
  // Readers must never observe the creation-before-write interval. This public
  // fixture retains the existing no-clobber routing publication authority.
  await retainReleaseRoutingMarker(path.join(directory, name), value);
}
const scope = "credential-free-hosted-process-fixture";
if (mode === "start") {
  await mkdir(directory, { mode: 0o700 });
  // This sentinel and its associated fact remain exclusively in this process
  // until the artifact round trip has finished. No imported authority exists.
  const sentinel = randomBytes(32).toString("hex");
  const fact = randomBytes(32).toString("hex");
  await write("ready.json", { scope, pid: process.pid, commitment: hash(sentinel + fact) });
  const deadline = Date.now() + 45000;
  let completed = false;
  while (Date.now() < deadline) {
    let input: Buffer;
    try {
      input = await read("completion-input.json");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      await setTimeout(100);
      continue;
    }
    const value: unknown = JSON.parse(input.toString("utf8"));
    assert.ok(value && typeof value === "object");
    const record = value as Record<string, unknown>;
    assert.deepEqual(Object.keys(record).sort(), [
      "artifact_digest",
      "artifact_id",
      "ready_sha256",
    ]);
    assert.match(String(record.artifact_id), /^[1-9][0-9]{0,15}$/);
    assert.match(String(record.artifact_digest), /^[a-f0-9]{64}$/);
    assert.equal(record.ready_sha256, hash(await read("ready.json")));
    assert.deepEqual(await read("roundtrip/ready.json"), await read("ready.json"));
    await write("result.json", { scope, pid: process.pid, sentinel, fact, ...record });
    completed = true;
    break;
  }
  if (!completed) throw new Error("bounded hosted fixture deadline expired");
} else if (mode === "complete") {
  const artifact_id = process.env.FIXTURE_ARTIFACT_ID;
  const artifact_digest = process.env.FIXTURE_ARTIFACT_DIGEST;
  assert.match(artifact_id ?? "", /^[1-9][0-9]{0,15}$/);
  assert.match(artifact_digest ?? "", /^[a-f0-9]{64}$/);
  await write("completion-input.json", {
    artifact_id,
    artifact_digest,
    ready_sha256: hash(await read("roundtrip/ready.json")),
  });
} else {
  const deadline = Date.now() + 10000;
  for (;;) {
    try {
      await read("result.json");
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT" || Date.now() > deadline) throw error;
      await setTimeout(100);
    }
  }
  const ready = JSON.parse((await read("ready.json")).toString("utf8")) as Record<string, unknown>;
  const result = JSON.parse((await read("result.json")).toString("utf8")) as Record<
    string,
    unknown
  >;
  assert.equal(result.scope, scope);
  assert.equal(result.pid, ready.pid);
  assert.match(String(result.sentinel), /^[a-f0-9]{64}$/);
  assert.match(String(result.fact), /^[a-f0-9]{64}$/);
  assert.equal(hash(String(result.sentinel) + String(result.fact)), ready.commitment);
  assert.equal(result.ready_sha256, hash(await read("ready.json")));
  assert.deepEqual(await read("roundtrip/ready.json"), await read("ready.json"));
  for (;;) {
    let live = false;
    try {
      process.kill(Number(result.pid), 0);
      live = true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
    }
    if (!live) break;
    if (Date.now() > deadline) throw new Error("fixture process did not settle");
    await setTimeout(100);
  }
  await write("qualified.json", {
    scope,
    process_settled: true,
    artifact_id: result.artifact_id,
    artifact_digest: result.artifact_digest,
    authority: "none",
  });
}
