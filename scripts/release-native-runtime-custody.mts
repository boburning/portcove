/** Read-only Linux executable custody. This is filesystem evidence, never an
 * artifact, parent, execution or acceptance authority. */
import assert from "node:assert/strict";
import { lstatSync, realpathSync } from "node:fs";
import path from "node:path";

export type NativeRuntimeCustody = ReadonlyMap<string, string>;

/** Match the existing fixed-tool policy: broker/root owned, no group/other
 * writes anywhere, canonical paths, and regular single-link executable inputs.
 * Retain directory identities without their mutable child-list timestamps. */
export function inspectNativeRuntimeCustody(files: readonly string[]): NativeRuntimeCustody {
  const uid = process.getuid?.();
  assert.ok(process.platform === "linux" && uid !== undefined && uid !== 0);
  const observed = new Map<string, string>();
  for (const filename of files) {
    assert.ok(path.isAbsolute(filename) && path.normalize(filename) === filename);
    assert.equal(realpathSync(filename), filename, "linked native runtime refused");
    for (let cursor = filename; ; cursor = path.dirname(cursor)) {
      const info = lstatSync(cursor, { bigint: true });
      assert.ok(
        !info.isSymbolicLink() &&
          [0n, BigInt(uid)].includes(info.uid) &&
          (info.mode & 0o022n) === 0n,
        "native runtime custody is foreign-owned or writable",
      );
      const regular = cursor === filename;
      assert.ok(
        regular ? info.isFile() && info.nlink === 1n : info.isDirectory(),
        "native runtime requires regular single-link files and directory ancestry",
      );
      const identity = [info.dev, info.ino, info.uid, info.gid, info.mode];
      if (regular) identity.push(info.nlink, info.size, info.mtimeNs, info.ctimeNs);
      const serialized = identity.join(":");
      const previous = observed.get(cursor);
      assert.ok(previous === undefined || previous === serialized, "native custody changed");
      observed.set(cursor, serialized);
      if (cursor === "/") break;
    }
    assert.equal(realpathSync(filename), filename);
  }
  return observed;
}

export function recheckNativeRuntimeCustody(
  files: readonly string[],
  retained: NativeRuntimeCustody,
) {
  assert.deepEqual(inspectNativeRuntimeCustody(files), retained, "original native custody changed");
}
