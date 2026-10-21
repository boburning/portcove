import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { lstat, mkdir, open, rename, writeFile, readdir, chmod } from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import path from "node:path";
import { errorCode, isRecord } from "../../../scripts/runtime-values.mts";

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
export async function retainPublicUpdatePreimages(
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

/** Fixed malformed-journal fault, used only after positive owned-tree settlement. */
export async function preparePublicJournalFault(
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
export async function preparePublicPayloadFault(runtime: string, deadline: number) {
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

/** Stable regular-file read, including replacement checks around the open handle. */
export async function readPublicUpdateFile(file: string, maximumBytes = 512 * 1024 * 1024) {
  assert.ok(
    Number.isSafeInteger(maximumBytes) && maximumBytes > 0 && maximumBytes <= 512 * 1024 * 1024,
  );
  const before = await lstat(file);
  assert.ok(before.isFile() && !before.isSymbolicLink() && before.nlink === 1);
  assert.ok(before.size > 0 && before.size <= maximumBytes);
  const handle = await open(file, "r");
  try {
    const opened = await handle.stat();
    assert.equal(opened.ino, before.ino);
    assert.equal(opened.dev, before.dev);
    const digest = createHash("sha256");
    let total = 0;
    for await (const chunk of handle.createReadStream({ autoClose: false })) {
      assert.ok(Buffer.isBuffer(chunk));
      total += chunk.length;
      assert.ok(total <= before.size, "Installed executable grew during readback");
      digest.update(chunk);
    }
    const after = await lstat(file),
      retained = await handle.stat();
    for (const value of [after, retained]) {
      assert.equal(value.ino, before.ino);
      assert.equal(value.dev, before.dev);
      assert.equal(value.size, before.size);
      assert.equal(value.mtimeMs, before.mtimeMs);
      assert.equal(value.ctimeMs, before.ctimeMs);
      assert.ok(value.isFile() && !value.isSymbolicLink() && value.nlink === 1);
    }
    assert.equal(total, before.size);
    return { path: file, bytes: total, sha256: digest.digest("hex") };
  } finally {
    await handle.close();
  }
}

// Exact maintained shipping parser ceilings: host_preferences.rs,
// application_update_preferences/schedule.rs (64KiB each), staging/apply.rs
// (512KiB each). Oversized raw data refuses rather than enlarging the proof.
export const publicUpdateRawMetadataBytes = 3 * 64 * 1024 + 2 * 512 * 1024;
const publicRawStateFiles = fixedStateFiles.map(([name, limit]): readonly [string, number] => [
  name,
  name === "staging/staging.json" || name === "staging/apply.json"
    ? 512 * 1024
    : name.endsWith(".json")
      ? 64 * 1024
      : limit,
]);

const preimageStores = new WeakMap<
  object,
  {
    directory: string;
    bytes: number;
    entries: Map<string, { bytes: number; path: string }>;
    observations: number;
  }
>();
/** Fixed 192MiB of the existing 256MiB export envelope. This is retained byte
 * custody only; the caller must positively settle candidate writers first. */
export async function createPublicUpdatePreimageStore(directory: string) {
  await directoryAncestry(path.dirname(directory));
  await mkdir(directory, { mode: 0o700 });
  const receipt = Object.freeze({ authority: "none" as const });
  preimageStores.set(receipt, { directory, bytes: 0, entries: new Map(), observations: 0 });
  return receipt;
}
async function rawStoreBytes(filename: string, limit: number, deadline: number) {
  assert.ok(performance.now() < deadline);
  const before = await regular(filename, limit),
    handle = await open(filename, "r");
  try {
    const opened = await handle.stat();
    assert.equal(opened.dev, before.dev);
    assert.equal(opened.ino, before.ino);
    const buffer = Buffer.alloc(before.size + 1);
    let bytes = 0;
    while (bytes < buffer.length) {
      assert.ok(performance.now() < deadline);
      const result = await handle.read(buffer, bytes, Math.min(65536, buffer.length - bytes), null);
      if (!result.bytesRead) break;
      bytes += result.bytesRead;
    }
    assert.equal(bytes, before.size, "Raw retained preimage grew during observation");
    const current = await regular(filename, limit),
      retained = await handle.stat();
    for (const value of [current, retained])
      for (const field of ["dev", "ino", "size", "mtimeMs", "ctimeMs", "nlink"] as const)
        assert.equal(value[field], before[field]);
    return buffer.subarray(0, bytes);
  } finally {
    await handle.close();
  }
}
/** Stable held-file bytes with a fixed allocation and limit+1 growth refusal. */
export function readBoundedPublicUpdateBytes(
  filename: string,
  maximumBytes: number,
  deadline: number,
) {
  assert.ok(
    Number.isSafeInteger(maximumBytes) && maximumBytes >= 0 && maximumBytes <= 192 * 1024 * 1024,
  );
  return rawStoreBytes(filename, maximumBytes, deadline);
}
/** Re-reads every actual raw preimage and rehashes any reused retained bytes.
 * Equal bytes share storage; observations and fault-byte preimages remain exact. */
export async function retainDeduplicatedPublicUpdatePreimages(
  runtime: string,
  output: string,
  storeReceipt: object,
  deadline: number,
) {
  return retainRawSelections(runtime, output, storeReceipt, deadline, publicRawStateFiles);
}
async function retainRawSelections(
  runtime: string,
  output: string,
  storeReceipt: object,
  deadline: number,
  selectedFiles: readonly (readonly [string, number])[],
) {
  const store = preimageStores.get(storeReceipt);
  assert.ok(store, "Original private preimage store required");
  assert.ok(Number.isFinite(deadline) && performance.now() < deadline);
  assert.ok(store.observations < 11, "Public preimage observation count exhausted");
  store.observations++;
  await directoryAncestry(runtime);
  await mkdir(output, { mode: 0o700 });
  const files = [];
  for (const [name, limit] of selectedFiles) {
    const source = path.join(runtime, name);
    const before = await regular(source, Math.min(limit, 192 * 1024 * 1024)).catch(
      (error: unknown) => {
        if (errorCode(error) !== "ENOENT") throw error;
        return null;
      },
    );
    if (!before) {
      files.push({ path: name, absent: true });
      continue;
    }
    const handle = await open(source, "r");
    const chunks: { bytes: number; sha256: string; retained: string }[] = [];
    const fullHash = createHash("sha256");
    let total = 0;
    try {
      const opened = await handle.stat();
      assert.equal(opened.dev, before.dev);
      assert.equal(opened.ino, before.ino);
      while (total < before.size) {
        assert.ok(performance.now() < deadline);
        const bytes = Buffer.alloc(Math.min(1024 * 1024, before.size - total));
        let count = 0;
        while (count < bytes.length) {
          assert.ok(performance.now() < deadline);
          const read = await handle.read(bytes, count, bytes.length - count, null);
          assert.ok(read.bytesRead > 0, "Raw preimage shrank during observation");
          count += read.bytesRead;
        }
        total += count;
        fullHash.update(bytes);
        const sha256 = createHash("sha256").update(bytes).digest("hex");
        let entry: { bytes: number; path: string } | undefined = store.entries.get(sha256);
        if (entry) {
          assert.equal(entry.bytes, bytes.length);
          const retained = await rawStoreBytes(entry.path, entry.bytes, deadline);
          assert.ok(retained.equals(bytes), "Previously retained preimage bytes changed");
        } else {
          assert.ok(
            store.entries.size < 384 && store.bytes + bytes.length <= 192 * 1024 * 1024,
            "Original trusted preimage storage bound exhausted",
          );
          store.bytes += bytes.length; // Failed writes remain charged and retained.
          const destination = path.join(store.directory, `${sha256}.bin`);
          await writeFile(destination, bytes, { flag: "wx", mode: 0o600 });
          const retained = await rawStoreBytes(destination, bytes.length, deadline);
          assert.ok(retained.equals(bytes));
          entry = { bytes: bytes.length, path: destination };
          store.entries.set(sha256, entry);
        }
        chunks.push({
          bytes: bytes.length,
          sha256,
          retained: path.relative(output, entry.path).split(path.sep).join("/"),
        });
      }
      assert.equal(
        (await handle.read(Buffer.alloc(1))).bytesRead,
        0,
        "Raw preimage grew during observation",
      );
      const current = await regular(source, limit),
        retained = await handle.stat();
      for (const value of [current, retained])
        for (const field of ["dev", "ino", "size", "mtimeMs", "ctimeMs", "nlink"] as const)
          assert.equal(value[field], before[field]);
      assert.equal(total, before.size);
      files.push({ path: name, bytes: total, sha256: fullHash.digest("hex"), chunks });
    } finally {
      await handle.close();
    }
  }
  const result = {
    schema_version: 1,
    files,
    retained_bytes: store.bytes,
    authority: "none" as const,
    scope: "raw preimages with reverified identical-byte storage reuse",
  };
  await writeFile(path.join(output, "preimages.json"), JSON.stringify(result) + "\n", {
    flag: "wx",
    mode: 0o600,
  });
  return result;
}

/** Snapshot of an already settled isolated profile, never an admitted restore.
 * The exact previous actual claim/capture must authenticate any later use. */
export async function retainPublicUpdateProfile(
  runtime: string,
  output: string,
  storeReceipt: object,
  deadline: number,
  stagedPayload: { bytes: number; sha256: string },
) {
  assert.equal(process.platform, "linux");
  assert.ok(Number.isFinite(deadline) && performance.now() < deadline);
  assert.ok(
    Number.isSafeInteger(stagedPayload.bytes) &&
      stagedPayload.bytes > 0 &&
      stagedPayload.bytes <= 192 * 1024 * 1024,
  );
  assert.match(stagedPayload.sha256, /^[a-f0-9]{64}$/u);
  await directoryAncestry(runtime);
  const directories: { path: string; mode: number; identity: Awaited<ReturnType<typeof lstat>> }[] =
    [];
  const selected: [string, number][] = [];
  const fileModes = new Map<string, number>();
  let ordinaryBytes = 0;
  const walk = async (relative: string, depth: number) => {
    assert.ok(performance.now() < deadline && depth <= 16 && directories.length < 512);
    const directory = path.join(runtime, relative),
      identity = await lstat(directory);
    assert.ok(
      identity.isDirectory() && !identity.isSymbolicLink() && (identity.mode & 0o022) === 0,
    );
    if (process.getuid) assert.equal(identity.uid, process.getuid());
    directories.push({ path: relative, mode: identity.mode & 0o777, identity });
    const entries = await readdir(directory);
    assert.ok(entries.length <= 512);
    for (const name of entries.sort()) {
      assert.ok(
        /^[A-Za-z0-9._ -]{1,128}$/u.test(name) &&
          name !== "." &&
          name !== ".." &&
          !name.endsWith(".") &&
          !name.endsWith(" "),
      );
      const next = relative ? relative + "/" + name : name;
      assert.ok(next.length <= 2048 && selected.length < 512);
      const info = await lstat(path.join(runtime, next));
      assert.ok(!info.isSymbolicLink() && (info.mode & 0o022) === 0);
      if (process.getuid) assert.equal(info.uid, process.getuid());
      if (info.isDirectory()) {
        await walk(next, depth + 1);
        continue;
      }
      assert.ok(info.isFile() && info.nlink === 1 && info.size >= 0);
      assert.notEqual(
        next,
        "staging/.candidate.payload.incoming",
        "Incomplete payload cannot establish a parked profile",
      );
      if (next === "staging/candidate-installer.exe") assert.equal(info.size, stagedPayload.bytes);
      else {
        ordinaryBytes += info.size;
        assert.ok(
          ordinaryBytes <= 64 * 1024 * 1024,
          "Original retained user-profile bound exhausted",
        );
      }
      fileModes.set(next, info.mode & 0o777);
      selected.push([
        next,
        next === "staging/candidate-installer.exe" ? stagedPayload.bytes : 64 * 1024 * 1024,
      ]);
    }
  };
  await walk("", 0);
  const retained = await retainRawSelections(runtime, output, storeReceipt, deadline, selected);
  for (const directory of directories) {
    const after = await lstat(path.join(runtime, directory.path));
    for (const field of ["dev", "ino", "mtimeMs", "ctimeMs"] as const)
      assert.equal(after[field], directory.identity[field], "Settled profile directory changed");
  }
  const payload = retained.files.find((file) => file.path === "staging/candidate-installer.exe");
  if (payload) assert.equal(payload.sha256, stagedPayload.sha256);
  const manifest = {
    schema_version: 1,
    kind: "settled-public-profile-snapshot",
    ordinary_bytes: ordinaryBytes,
    directories: directories.map(({ path, mode }) => ({ path, mode })),
    files: retained.files.map((file) => {
      assert.ok(!file.absent && fileModes.has(file.path));
      return { ...file, mode: fileModes.get(file.path)! };
    }),
    authority: "none",
  };
  const bytes = Buffer.from(JSON.stringify(manifest) + "\n");
  assert.ok(bytes.length <= 1024 * 1024);
  await writeFile(path.join(output, "profile.json"), bytes, { flag: "wx", mode: 0o600 });
  return {
    manifest,
    sha256: createHash("sha256").update(bytes).digest("hex"),
    bytes: bytes.length,
    scope: "exact settled profile snapshot, not restore authority",
  };
}

function profileRelative(value: unknown, root = false): asserts value is string {
  assert.ok(typeof value === "string" && value.length <= 2048);
  if (root && value === "") return;
  assert.ok(value.length > 0 && !value.includes("\\"));
  for (const part of value.split("/"))
    assert.ok(
      /^[A-Za-z0-9._ -]{1,128}$/u.test(part) &&
        part !== "." &&
        part !== ".." &&
        !part.endsWith(".") &&
        !part.endsWith(" "),
    );
  assert.ok(value.split("/").length <= 17);
}
/** Bounded byte restoration only. The caller must authenticate the exact old
 * settled claim/capture and select the same fixed profile before calling. */
export async function restorePublicUpdateProfile(
  snapshotDirectory: string,
  manifestSha256: string,
  target: string,
  deadline: number,
) {
  assert.equal(process.platform, "linux");
  assert.match(manifestSha256, /^[a-f0-9]{64}$/u);
  assert.ok(Number.isFinite(deadline) && performance.now() < deadline);
  const filename = path.join(snapshotDirectory, "profile.json");
  const identity = await readPublicUpdateFile(filename, 1024 * 1024);
  assert.equal(identity.sha256, manifestSha256);
  const bytes = await rawStoreBytes(filename, 1024 * 1024, deadline);
  assert.equal(bytes.length, identity.bytes);
  assert.equal(createHash("sha256").update(bytes).digest("hex"), manifestSha256);
  const raw: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  assert.ok(
    isRecord(raw) &&
      Object.keys(raw).sort().join(",") ===
        "authority,directories,files,kind,ordinary_bytes,schema_version",
  );
  assert.equal(raw.schema_version, 1);
  assert.equal(raw.kind, "settled-public-profile-snapshot");
  assert.equal(raw.authority, "none");
  assert.ok(
    Array.isArray(raw.directories) &&
      raw.directories.length > 0 &&
      raw.directories.length <= 512 &&
      Array.isArray(raw.files) &&
      raw.files.length <= 512,
  );
  const directories = new Map<string, number>();
  for (const value of raw.directories) {
    assert.ok(isRecord(value) && Object.keys(value).sort().join(",") === "mode,path");
    profileRelative(value.path, true);
    assert.ok(!directories.has(value.path));
    assert.ok(
      Number.isSafeInteger(value.mode) &&
        Number(value.mode) >= 0 &&
        Number(value.mode) <= 0o777 &&
        (Number(value.mode) & 0o022) === 0,
    );
    if (directories.size === 0) assert.equal(value.path, "");
    else
      assert.ok(
        directories.has(
          path.posix.dirname(value.path) === "." ? "" : path.posix.dirname(value.path),
        ),
      );
    directories.set(value.path, Number(value.mode));
  }
  const files: {
    path: string;
    mode: number;
    bytes: number;
    sha256: string;
    chunks: { bytes: number; sha256: string; retained: string }[];
  }[] = [];
  const names = new Set<string>();
  let ordinary = 0;
  for (const value of raw.files) {
    assert.ok(
      isRecord(value) && Object.keys(value).sort().join(",") === "bytes,chunks,mode,path,sha256",
    );
    profileRelative(value.path);
    assert.ok(!names.has(value.path) && !directories.has(value.path));
    names.add(value.path);
    assert.ok(
      directories.has(path.posix.dirname(value.path) === "." ? "" : path.posix.dirname(value.path)),
    );
    assert.notEqual(value.path, "staging/.candidate.payload.incoming");
    assert.ok(
      Number.isSafeInteger(value.mode) &&
        Number(value.mode) >= 0 &&
        Number(value.mode) <= 0o777 &&
        (Number(value.mode) & 0o022) === 0,
    );
    assert.ok(
      Number.isSafeInteger(value.bytes) &&
        Number(value.bytes) >= 0 &&
        Number(value.bytes) <= 192 * 1024 * 1024 &&
        typeof value.sha256 === "string" &&
        /^[a-f0-9]{64}$/u.test(value.sha256),
    );
    if (value.path !== "staging/candidate-installer.exe") ordinary += Number(value.bytes);
    assert.ok(ordinary <= 64 * 1024 * 1024);
    assert.ok(Array.isArray(value.chunks) && value.chunks.length <= 192);
    let total = 0;
    const hash = createHash("sha256"),
      chunks: { bytes: number; sha256: string; retained: string }[] = [];
    for (const chunk of value.chunks) {
      assert.ok(isRecord(chunk) && Object.keys(chunk).sort().join(",") === "bytes,retained,sha256");
      assert.ok(
        Number.isSafeInteger(chunk.bytes) &&
          Number(chunk.bytes) > 0 &&
          Number(chunk.bytes) <= 1024 * 1024 &&
          typeof chunk.sha256 === "string" &&
          /^[a-f0-9]{64}$/u.test(chunk.sha256),
      );
      assert.equal(chunk.retained, `../preimage-store/${chunk.sha256}.bin`);
      const retained = await rawStoreBytes(
        path.resolve(snapshotDirectory, String(chunk.retained)),
        Number(chunk.bytes),
        deadline,
      );
      assert.equal(retained.length, chunk.bytes);
      assert.equal(createHash("sha256").update(retained).digest("hex"), chunk.sha256);
      total += retained.length;
      hash.update(retained);
      chunks.push({
        bytes: Number(chunk.bytes),
        sha256: chunk.sha256,
        retained: String(chunk.retained),
      });
    }
    assert.equal(total, value.bytes);
    assert.equal(hash.digest("hex"), value.sha256);
    files.push({
      path: value.path,
      mode: Number(value.mode),
      bytes: Number(value.bytes),
      sha256: value.sha256,
      chunks,
    });
  }
  assert.equal(raw.ordinary_bytes, ordinary);
  assert.deepEqual(await readPublicUpdateFile(filename, 1024 * 1024), identity);
  await directoryAncestry(path.dirname(target));
  await mkdir(target, { mode: 0o700 }); // A retained/partial target can never be reused.
  for (const [relative] of directories)
    if (relative) await mkdir(path.join(target, relative), { mode: 0o700 });
  for (const file of files) {
    assert.ok(performance.now() < deadline);
    const output = await open(path.join(target, file.path), "wx", 0o600);
    try {
      for (const chunk of file.chunks) {
        const retained = await rawStoreBytes(
          path.resolve(snapshotDirectory, chunk.retained),
          chunk.bytes,
          deadline,
        );
        assert.equal(createHash("sha256").update(retained).digest("hex"), chunk.sha256);
        await output.writeFile(retained);
      }
      await output.sync();
      await output.chmod(file.mode);
    } finally {
      await output.close();
    }
  }
  for (const [relative, mode] of [...directories].reverse())
    await chmod(path.join(target, relative), mode);
  assert.deepEqual(await readPublicUpdateFile(filename, 1024 * 1024), identity);
  return {
    manifest_sha256: manifestSha256,
    ordinary_bytes: ordinary,
    files: files.length,
    authority: "none" as const,
    scope: "exact copied profile bytes; previous actual claim authority required separately",
  };
}
