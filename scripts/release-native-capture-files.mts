/** Raw native streams may honestly be empty. Public inputs and JSON retain
 * their separate nonempty contracts. Reading bytes creates no provenance. */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { open, lstat } from "node:fs/promises";
import path from "node:path";
import { assertOwnedUnlinkedPath } from "./release-path-safety.mts";

/** Bounded retained-file identity only. This supplies no capture provenance. */
export async function hashNativeCapturedFile(
  root: string,
  name: string,
  maximum: number,
  deadline: number,
) {
  assert.ok(Number.isSafeInteger(maximum) && maximum > 0 && maximum <= 512 * 1024 * 1024);
  const active = () =>
    assert.ok(
      Number.isFinite(deadline) && performance.now() < deadline,
      "original native file read deadline exhausted",
    );
  active();
  const filename = await assertOwnedUnlinkedPath(
      root,
      path.join(root, name),
      "retained native capture file",
    ),
    before = await lstat(filename);
  assert.ok(
    before.isFile() && !before.isSymbolicLink() && before.nlink === 1 && before.size <= maximum,
  );
  const handle = await open(
    filename,
    constants.O_RDONLY | (process.platform === "win32" ? 0 : constants.O_NOFOLLOW),
  );
  const same = (actual: typeof before) => {
    for (const key of ["dev", "ino", "size", "mtimeMs", "ctimeMs", "nlink"] as const)
      assert.equal(actual[key], before[key], "retained native file changed");
  };
  try {
    same(await handle.stat());
    const hash = createHash("sha256"),
      buffer = Buffer.alloc(64 * 1024);
    let count = 0;
    while (true) {
      active();
      const { bytesRead } = await handle.read(
        buffer,
        0,
        Math.min(buffer.length, before.size - count + 1),
        null,
      );
      if (!bytesRead) break;
      count += bytesRead;
      assert.ok(count <= before.size);
      hash.update(buffer.subarray(0, bytesRead));
    }
    assert.equal(count, before.size);
    same(await handle.stat());
    same(await lstat(filename));
    active();
    return { path: name, bytes: count, sha256: hash.digest("hex") };
  } finally {
    await handle.close();
  }
}

export async function readNativeCapturedStream(root: string, name: string) {
  assert.match(name, /^[a-z][a-z0-9-]{0,63}\.(?:stdout|stderr)\.bin$/u);
  const filename = await assertOwnedUnlinkedPath(
    root,
    path.join(root, name),
    "native captured stream",
  );
  const before = await lstat(filename);
  assert.ok(
    before.isFile() &&
      !before.isSymbolicLink() &&
      before.nlink === 1 &&
      before.size <= 4 * 1024 * 1024,
  );
  const handle = await open(filename, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  const same = (actual: typeof before) => {
    for (const key of ["dev", "ino", "size", "mtimeMs", "ctimeMs"] as const)
      assert.equal(actual[key], before[key], "native captured stream changed");
  };
  try {
    same(await handle.stat());
    const buffer = Buffer.alloc(before.size + 1);
    let length = 0;
    while (length <= before.size) {
      const { bytesRead } = await handle.read(buffer, length, buffer.length - length, null);
      if (!bytesRead) break;
      length += bytesRead;
    }
    assert.equal(length, before.size, "native captured stream size changed");
    same(await handle.stat());
    same(await lstat(filename));
    return buffer.subarray(0, length);
  } finally {
    await handle.close();
  }
}
