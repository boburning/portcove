/** Portable package replacement inside an already owned native attempt.
 * It supplies actual filesystem observations, never execution or acceptance. */
import assert from "node:assert/strict";
import { constants } from "node:fs";
import { open, lstat, rename, type FileHandle } from "node:fs/promises";
import { createHash } from "node:crypto";
import path from "node:path";
import { assertOwnedUnlinkedPath } from "./release-path-safety.mts";
import { errorCode } from "./runtime-values.mts";

type PackageIdentity = Readonly<{ bytes: number; sha256: string }>;
function identity(expected: PackageIdentity) {
  assert.ok(
    Number.isSafeInteger(expected.bytes) &&
      expected.bytes > 0 &&
      expected.bytes <= 512 * 1024 * 1024,
  );
  assert.match(expected.sha256, /^[a-f0-9]{64}$/u);
}
async function readPackage(root: string, filename: string, expected: PackageIdentity) {
  identity(expected);
  await assertOwnedUnlinkedPath(root, filename, "native package");
  const file = await open(
    filename,
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
  );
  try {
    const before = await file.stat({ bigint: true });
    assert.ok(
      before.isFile() &&
        before.nlink === 1n &&
        before.size === BigInt(expected.bytes) &&
        (before.mode & 0o077n) === 0n,
    );
    if (process.getuid) assert.equal(before.uid, BigInt(process.getuid()));
    const hash = createHash("sha256"),
      buffer = Buffer.alloc(65536);
    let count = 0;
    for (;;) {
      const { bytesRead } = await file.read(buffer);
      if (!bytesRead) break;
      count += bytesRead;
      assert.ok(count <= expected.bytes);
      hash.update(buffer.subarray(0, bytesRead));
    }
    assert.equal(count, expected.bytes);
    assert.equal(hash.digest("hex"), expected.sha256);
    const after = await file.stat({ bigint: true }),
      current = await lstat(filename, { bigint: true });
    for (const key of ["dev", "ino", "size", "nlink", "mtimeNs", "ctimeNs"] as const) {
      assert.equal(after[key], before[key]);
      assert.equal(current[key], before[key]);
    }
    return before;
  } finally {
    await file.close();
  }
}
/** Fixed leaf names and expected prior bytes prohibit an unrelated overwrite.
 * A failure retains the partial/current file; callers cannot retry this step. */
export async function replaceNativeLinuxPackage(options: {
  attempt: string;
  slot: "candidate" | "predecessor";
  step: "predecessor" | "candidate" | "rollback";
  expected: PackageIdentity;
  previous: PackageIdentity | null;
}) {
  assert.equal(process.platform, "linux");
  const { attempt, slot, step, expected, previous } = structuredClone(options);
  assert.ok(
    ["candidate", "predecessor"].includes(slot) &&
      ["predecessor", "candidate", "rollback"].includes(step),
  );
  identity(expected);
  if (previous) identity(previous);
  const source = path.join(
    attempt,
    "packages",
    slot === "candidate" ? "Candidate.AppImage" : "Predecessor.AppImage",
  );
  const directory = path.join(attempt, "install"),
    active = path.join(directory, "Portcove.AppImage"),
    partial = path.join(directory, `.package-${step}.partial`);
  await assertOwnedUnlinkedPath(path.dirname(attempt), attempt, "native attempt");
  await assertOwnedUnlinkedPath(attempt, directory, "native installation");
  for (const filename of [attempt, directory, path.join(attempt, "packages")]) {
    const info = await lstat(filename);
    assert.ok(
      info.isDirectory() &&
        !info.isSymbolicLink() &&
        info.uid === process.getuid?.() &&
        (info.mode & 0o077) === 0,
    );
  }
  await readPackage(attempt, source, expected);
  const previousIdentity = previous ? await readPackage(attempt, active, previous) : null;
  if (!previous) {
    try {
      await lstat(active);
      assert.fail("active native package already exists");
    } catch (error) {
      if (errorCode(error) !== "ENOENT") throw error;
    }
  }
  const input = await open(
    source,
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
  );
  let output: FileHandle | undefined;
  try {
    output = await open(
      partial,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
      0o500,
    );
    const hash = createHash("sha256"),
      buffer = Buffer.alloc(65536);
    let count = 0;
    for (;;) {
      const { bytesRead } = await input.read(buffer);
      if (!bytesRead) break;
      count += bytesRead;
      assert.ok(count <= expected.bytes);
      hash.update(buffer.subarray(0, bytesRead));
      let offset = 0;
      while (offset < bytesRead) {
        const result = await output.write(buffer, offset, bytesRead - offset);
        assert.ok(result.bytesWritten > 0);
        offset += result.bytesWritten;
      }
    }
    assert.equal(count, expected.bytes);
    assert.equal(hash.digest("hex"), expected.sha256);
    await output.sync();
  } finally {
    await Promise.all([input.close(), ...(output ? [output.close()] : [])]);
  }
  await readPackage(attempt, source, expected);
  await readPackage(attempt, partial, expected);
  if (previous) {
    const current = await readPackage(attempt, active, previous);
    assert.equal(current.dev, previousIdentity!.dev);
    assert.equal(current.ino, previousIdentity!.ino);
  } else {
    try {
      await lstat(active);
      assert.fail("active package appeared before replacement");
    } catch (error) {
      if (errorCode(error) !== "ENOENT") throw error;
    }
  }
  await rename(partial, active);
  const installed = await readPackage(attempt, active, expected);
  const parent = await open(directory, constants.O_RDONLY | constants.O_DIRECTORY);
  try {
    await parent.sync();
  } finally {
    await parent.close();
  }
  return Object.freeze({
    schema_version: 1,
    step,
    slot,
    previous,
    installed: expected,
    active_identity: { device: installed.dev.toString(), inode: installed.ino.toString() },
    authority: "none" as const,
    scope: "portable package replacement only" as const,
  });
}
