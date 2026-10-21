import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { lstat, mkdir, open, rename } from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import path from "node:path";
import { errorCode } from "../../../scripts/runtime-values.mts";

const fixedStateFiles = [
  ["update-schedule.json", 1024 * 1024],
  ["update-preferences.json", 1024 * 1024],
  ["preferences.json", 1024 * 1024],
  ["staging/staging.json", 1024 * 1024],
  ["staging/apply.json", 1024 * 1024],
  ["staging/candidate-installer.exe", 512 * 1024 * 1024],
  ["staging/.candidate.payload.incoming", 512 * 1024 * 1024],
] as const;

async function directoryAncestry(directory: string) {
  let cursor = path.resolve(directory);
  for (let depth = 0; depth < 64; depth++) {
    const item = await lstat(cursor);
    assert.ok(
      item.isDirectory() && !item.isSymbolicLink(),
      "Public update state directory ancestry changed",
    );
    const parent = path.dirname(cursor);
    if (parent === cursor) return;
    cursor = parent;
  }
  throw new Error("Public update state directory ancestry exceeds its fixed bound");
}

async function regular(file: string, limit: number) {
  await directoryAncestry(path.dirname(file));
  const value = await lstat(file);
  assert.ok(value.isFile() && !value.isSymbolicLink() && value.nlink === 1);
  assert.ok(value.size >= 0 && value.size <= limit);
  return value;
}

/** Copy fixed raw files, not reconciled JSON. Caller owns positive process quiescence. */
export async function retainWindowsPublicUpdatePreimages(
  runtime: string,
  output: string,
  deadline: number,
) {
  const active = () => assert.ok(Number.isFinite(deadline) && performance.now() < deadline);
  active();
  await directoryAncestry(runtime);
  await mkdir(output, { recursive: false });
  const staging = await lstat(path.join(runtime, "staging")).catch((error: unknown) => {
    if (errorCode(error) !== "ENOENT") throw error;
    return null;
  });
  if (staging) assert.ok(staging.isDirectory() && !staging.isSymbolicLink());
  const files = [];
  for (const [name, limit] of fixedStateFiles) {
    active();
    const file = path.join(runtime, name);
    const before = await regular(file, limit).catch((error: unknown) => {
      if (errorCode(error) !== "ENOENT") throw error;
      return null;
    });
    if (!before) {
      files.push({ path: name, absent: true });
      continue;
    }
    const input = await open(file, "r");
    let retained: FileHandle | undefined;
    try {
      retained = await open(path.join(output, name.replaceAll("/", "-")), "wx");
      const opened = await input.stat();
      assert.equal(opened.dev, before.dev);
      assert.equal(opened.ino, before.ino);
      const digest = createHash("sha256");
      let total = 0;
      for await (const chunk of input.createReadStream({ autoClose: false })) {
        active();
        assert.ok(Buffer.isBuffer(chunk));
        total += chunk.length;
        assert.ok(total <= before.size);
        digest.update(chunk);
        await retained.writeFile(chunk);
      }
      const after = await regular(file, limit),
        handle = await input.stat();
      for (const value of [after, handle]) {
        assert.equal(value.dev, before.dev);
        assert.equal(value.ino, before.ino);
        assert.equal(value.size, before.size);
        assert.equal(value.mtimeMs, before.mtimeMs);
        assert.equal(value.ctimeMs, before.ctimeMs);
        assert.equal(value.nlink, 1);
      }
      assert.equal(total, before.size);
      await retained.sync();
      active();
      files.push({ path: name, bytes: total, sha256: digest.digest("hex") });
    } finally {
      await input.close();
      await retained?.close();
    }
  }
  active();
  return {
    schema_version: 1,
    files,
    authority: "none" as const,
    scope: "fixed raw preimages before startup/reconciliation" as const,
  };
}

/** Fixed malformed-journal fault, used only after positive account-tree settlement. */
export async function prepareWindowsPublicJournalFault(
  runtime: string,
  area: "schedule" | "staging" | "apply",
  deadline: number,
) {
  const active = () => assert.ok(Number.isFinite(deadline) && performance.now() < deadline);
  active();
  const names = {
    schedule: "update-schedule.json",
    staging: "staging/staging.json",
    apply: "staging/apply.json",
  };
  assert.ok(Object.hasOwn(names, area));
  const file = path.join(runtime, names[area]);
  const directory = await lstat(path.dirname(file));
  assert.ok(directory.isDirectory() && !directory.isSymbolicLink());
  await regular(file, 1024 * 1024).catch((error: unknown) => {
    if (errorCode(error) !== "ENOENT") throw error;
  });
  const temporary = path.join(path.dirname(file), `.public-journey-${area}.fault`);
  active();
  const handle = await open(temporary, "wx");
  try {
    await handle.writeFile("{");
    await handle.sync();
  } finally {
    await handle.close();
  }
  active();
  await directoryAncestry(path.dirname(file));
  await rename(temporary, file);
  active();
  return {
    area,
    path: names[area],
    bytes: 1,
    sha256: createHash("sha256").update("{").digest("hex"),
    authority: "none" as const,
  };
}

/** One fixed local payload-byte corruption after actual owned-tree settlement.
 * It exercises custody/reconciliation refusal, not the cryptographic error subtype. */
export async function prepareWindowsPublicPayloadFault(runtime: string, deadline: number) {
  assert.ok(Number.isFinite(deadline) && performance.now() < deadline);
  const file = path.join(runtime, "staging", "candidate-installer.exe");
  const directory = await lstat(path.dirname(file));
  assert.ok(directory.isDirectory() && !directory.isSymbolicLink());
  const before = await regular(file, 512 * 1024 * 1024);
  assert.ok(before.size > 0);
  const handle = await open(file, "r+");
  try {
    const opened = await handle.stat();
    assert.equal(opened.ino, before.ino);
    assert.equal(opened.dev, before.dev);
    const byte = Buffer.alloc(1);
    assert.equal((await handle.read(byte, 0, 1, 0)).bytesRead, 1);
    const original = byte[0]!;
    byte[0] = original ^ 1;
    assert.ok(performance.now() < deadline);
    await directoryAncestry(path.dirname(file));
    assert.equal((await handle.write(byte, 0, 1, 0)).bytesWritten, 1);
    await handle.sync();
    const after = await regular(file, 512 * 1024 * 1024);
    assert.equal(after.ino, before.ino);
    assert.equal(after.dev, before.dev);
    assert.equal(after.size, before.size);
    assert.ok(performance.now() < deadline);
    return {
      path: "staging/candidate-installer.exe",
      offset: 0,
      before_byte: original,
      after_byte: byte[0],
      authority: "none" as const,
    };
  } finally {
    await handle.close();
  }
}
