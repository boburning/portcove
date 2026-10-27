/** Exclusive public proof retention. No account, issuer or execution authority. */
import assert from "node:assert/strict";
import { constants, type BigIntStats } from "node:fs";
import { lstat, mkdir, open } from "node:fs/promises";
import path from "node:path";
import {
  inspectNativeRuntimeCustody,
  recheckNativeRuntimeCustody,
} from "./release-native-runtime-custody.mts";
import type { AppRegistrationStore } from "./release-owned-capture-store.mts";

/** NTFS write-through includes request metadata; fsync still flushes the file.
 * https://learn.microsoft.com/windows/win32/api/fileapi/nf-fileapi-createfilew
 * https://docs.libuv.org/en/v1.x/fs.html#file-access-constants */
export async function createHostedWindowsNativeProofStore(
  directory: string,
): Promise<AppRegistrationStore> {
  assert.ok(process.platform === "win32" && process.arch === "x64");
  assert.ok(
    /^[A-Za-z]:\\/u.test(directory) &&
      directory.length <= 4096 &&
      !directory.slice(2).includes(":") &&
      path.normalize(directory) === directory,
    "canonical local Windows proof directory required",
  );
  await mkdir(directory);
  const intent = path.join(directory, "store-created.json"),
    initial = Buffer.from('{"schema_version":1,"authority":"none"}\n'),
    flags = constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_SYNC;
  const handle = await open(intent, flags, 0o600);
  try {
    await handle.writeFile(initial);
    await handle.sync();
  } finally {
    await handle.close();
  }
  const files = [intent];
  let custody = inspectNativeRuntimeCustody(files),
    total = initial.length,
    ordinary = initial.length,
    busy = false,
    failed = false;
  const identity = (info: BigIntStats) =>
    [info.dev, info.ino, info.mode, info.nlink, info.size, info.mtimeNs, info.ctimeNs].join(":");
  return {
    async write(name, bytes) {
      if (busy || failed) {
        failed = true;
        throw new Error("Windows proof store stopped or concurrent");
      }
      busy = true;
      try {
        const capture = name === "capture.json";
        assert.ok(
          /^[a-z][a-z0-9-]{0,48}\.(?:json|body|pem)$/u.test(name) &&
            !/^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])\./u.test(name) &&
            name !== "store-created.json" &&
            Buffer.isBuffer(bytes) &&
            bytes.length <= (capture ? 128 * 1024 + 1 : 128 * 1024) &&
            total + bytes.length <= 384 * 1024 + 128 * 1024 + 1 &&
            ordinary + (capture ? 0 : bytes.length) <= 384 * 1024 &&
            files.length < 16,
          "Windows proof retained-storage boundary exceeded",
        );
        recheckNativeRuntimeCustody(files, custody);
        const filename = path.join(directory, name),
          file = await open(filename, flags, 0o600);
        files.push(filename);
        total += bytes.length;
        ordinary += capture ? 0 : bytes.length;
        try {
          assert.ok(!failed, "Windows proof store stopped during write");
          const before = await file.stat({ bigint: true });
          assert.ok(before.isFile() && before.nlink === 1n);
          await file.writeFile(bytes);
          await file.sync();
          const after = await file.stat({ bigint: true });
          assert.equal(after.dev, before.dev);
          assert.equal(after.ino, before.ino);
          assert.equal(after.nlink, 1n);
          assert.equal(after.size, BigInt(bytes.length));
          assert.equal(identity(await lstat(filename, { bigint: true })), identity(after));
          assert.ok(!failed, "Windows proof store stopped during write");
          const observed = inspectNativeRuntimeCustody(files);
          for (const [key, value] of custody)
            assert.equal(observed.get(key), value, "Windows proof custody changed");
          assert.equal(identity(await file.stat({ bigint: true })), identity(after));
          custody = observed;
        } finally {
          await file.close();
        }
        assert.ok(!failed, "Windows proof store stopped during write");
      } catch (error) {
        failed = true;
        throw error;
      } finally {
        busy = false;
      }
    },
  };
}
