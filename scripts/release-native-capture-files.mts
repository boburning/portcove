/** Raw native streams may honestly be empty. Public inputs and JSON retain
 * their separate nonempty contracts. Reading bytes creates no provenance. */
import assert from "node:assert/strict";
import { constants } from "node:fs";
import { open, lstat } from "node:fs/promises";
import path from "node:path";
import { assertOwnedUnlinkedPath } from "./release-path-safety.mts";

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
