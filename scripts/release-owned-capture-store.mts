/** Exclusive owned capture storage only; no App, credential, network or CLI imports. */
import { lstat, mkdir, open, realpath } from "node:fs/promises";
import { constants } from "node:fs";
import path from "node:path";
const maximumBody = 128 * 1024;
export interface AppRegistrationStore {
  write(name: string, bytes: Buffer): Promise<void>;
}

export async function syncRegistrationDirectory(directory: string) {
  const handle = await open(
    directory,
    constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
  );
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

/** Linux owner-only custody outside the reviewer namespace. Existing attempts,
 * linked/foreign/writable ancestry and non-private modes are refused, never
 * repaired or overwritten. There is no credential in the repository or stdout. */
export async function createAppRegistrationStore(
  directory: string,
  synchronizeDirectory = syncRegistrationDirectory,
): Promise<AppRegistrationStore> {
  return createOwnedCaptureStore(directory, synchronizeDirectory, null);
}

/** Same exclusive owner-only custody; only the fixed transition file receives
 * the bounded native checkpoint allowance. App registration limits stay intact. */
export async function createCheckpointSigningStore(
  directory: string,
  synchronizeDirectory = syncRegistrationDirectory,
): Promise<AppRegistrationStore> {
  return createOwnedCaptureStore(directory, synchronizeDirectory, {
    name: "transition.json",
    bytes: 1024 * 1024,
  });
}

/** Same custody and ordinary384KiB limit. Only the fixed structured native
 * capture receives its existing128KiB-plus-newline proof allowance. */
export async function createHostedNativeProofStore(
  directory: string,
  synchronizeDirectory = syncRegistrationDirectory,
): Promise<AppRegistrationStore> {
  return createOwnedCaptureStore(directory, synchronizeDirectory, {
    name: "capture.json",
    bytes: 128 * 1024 + 1,
  });
}

async function createOwnedCaptureStore(
  directory: string,
  synchronizeDirectory: typeof syncRegistrationDirectory,
  special: { name: string; bytes: number } | null,
): Promise<AppRegistrationStore> {
  const uid = process.getuid?.();
  if (
    process.platform !== "linux" ||
    uid === undefined ||
    uid === 0 ||
    !path.isAbsolute(directory) ||
    path.normalize(directory) !== directory
  )
    throw new Error("ordinary native Linux registration custody required");
  const parent = path.dirname(directory);
  if ((await realpath(parent)) !== parent) throw new Error("linked registration parent refused");
  for (let cursor = parent; ; cursor = path.dirname(cursor)) {
    const stat = await lstat(cursor);
    if (
      !stat.isDirectory() ||
      stat.isSymbolicLink() ||
      ![0, uid].includes(stat.uid) ||
      (stat.mode & 0o022) !== 0
    )
      throw new Error("registration ancestry is linked, foreign-owned or writable");
    if (path.dirname(cursor) === cursor) break;
  }
  await mkdir(directory, { mode: 0o700 });
  await synchronizeDirectory(parent);
  const owner = await lstat(directory);
  if (!owner.isDirectory() || owner.uid !== uid || (owner.mode & 0o077) !== 0)
    throw new Error("private registration directory unavailable");
  let total = 0,
    ordinaryTotal = 0,
    files = 0;
  return {
    async write(name, bytes) {
      if (
        !/^[a-z][a-z0-9-]{0,48}\.(?:json|body|pem)$/u.test(name) ||
        bytes.length > (name === special?.name ? special.bytes : maximumBody) ||
        total + bytes.length > 384 * 1024 + (special?.bytes ?? 0) ||
        ordinaryTotal + (name === special?.name ? 0 : bytes.length) > 384 * 1024 ||
        files >= 16
      )
        throw new Error("registration retained-storage boundary exceeded");
      if ((await realpath(directory)) !== directory)
        throw new Error("registration custody changed");
      const stat = await lstat(directory);
      if (stat.uid !== uid || (stat.mode & 0o077) !== 0)
        throw new Error("registration custody changed");
      const file = await open(path.join(directory, name), "wx", 0o600);
      files++;
      try {
        const opened = await file.stat();
        if (
          !opened.isFile() ||
          opened.uid !== uid ||
          opened.nlink !== 1 ||
          (opened.mode & 0o077) !== 0
        )
          throw new Error("private registration file identity differs");
        total += bytes.length;
        ordinaryTotal += name === special?.name ? 0 : bytes.length;
        await file.writeFile(bytes);
        await file.sync();
        await synchronizeDirectory(directory);
      } finally {
        await file.close();
      }
    },
  };
}
