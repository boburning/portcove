/** Bounded raw guest capture custody. This parser never establishes acceptance. */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { open, mkdir, lstat } from "node:fs/promises";
import path from "node:path";
import { isRecord } from "./runtime-values.mts";
import { assertOwnedUnlinkedPath } from "./release-path-safety.mts";

const maximumWire = 272 * 1024 * 1024;
const identity = (s: {
  dev: number;
  ino: number;
  size: number;
  mtimeMs: number;
  ctimeMs: number;
}) => JSON.stringify([s.dev, s.ino, s.size, s.mtimeMs, s.ctimeMs]);
export function inspectNativeCaptureWirePath(raw: unknown): string {
  assert.ok(typeof raw === "string" && raw.length <= 512);
  const parts = raw.split("/");
  assert.ok(
    parts.length <= 8 &&
      parts.every(
        (part, index) =>
          (index === parts.length - 1 && /^\.outer-json-[a-f0-9]{32}$/u.test(part)) ||
          (/^[A-Za-z0-9][A-Za-z0-9._-]*$/u.test(part) &&
            !part.endsWith(".") &&
            !/^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/iu.test(part)),
      ),
  );
  return raw;
}
export async function hashRetainedNativeCaptureFile(
  root: string,
  name: string,
  maximum: number,
  expectedBytes?: number,
  deadline?: number,
) {
  const active = () => {
    if (deadline !== undefined)
      assert.ok(
        Number.isFinite(deadline) && performance.now() < deadline,
        "original capture hash budget exhausted",
      );
  };
  active();
  assert.ok(Number.isSafeInteger(maximum) && maximum >= 0 && maximum <= maximumWire);
  const filename = await assertOwnedUnlinkedPath(root, path.join(root, name), "native capture");
  const before = await lstat(filename);
  assert.ok(before.isFile() && before.nlink === 1 && before.size <= maximum);
  if (expectedBytes !== undefined) assert.equal(before.size, expectedBytes);
  const input = await open(filename, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  const hash = createHash("sha256");
  let total = 0;
  try {
    assert.equal(identity(await input.stat()), identity(before));
    const buffer = Buffer.alloc(65536);
    for (;;) {
      active();
      const { bytesRead } = await input.read(buffer, 0, buffer.length, null);
      active();
      if (!bytesRead) break;
      total += bytesRead;
      assert.ok(total <= maximum);
      hash.update(buffer.subarray(0, bytesRead));
    }
    assert.equal(total, before.size);
    assert.equal(identity(await input.stat()), identity(before));
    assert.equal(identity(await lstat(filename)), identity(before));
    active();
    return hash.digest("hex");
  } finally {
    await input.close();
  }
}
export async function retainNativeCaptureWire(
  wire: string,
  output: string,
  invocation: string,
  expectedSha: string,
  deadline?: number,
) {
  const active = () => {
    if (deadline !== undefined)
      assert.ok(
        Number.isFinite(deadline) && performance.now() < deadline,
        "original capture read budget exhausted",
      );
  };
  active();
  assert.match(invocation, /^[a-f0-9]{64}$/u);
  assert.match(expectedSha, /^[a-f0-9]{64}$/u);
  const before = await lstat(wire);
  assert.ok(
    before.isFile() &&
      !before.isSymbolicLink() &&
      before.nlink === 1 &&
      before.size > 0 &&
      before.size <= maximumWire,
  );
  const input = await open(wire, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  const digest = createHash("sha256");
  let pending = Buffer.alloc(0),
    consumed = 0,
    eof = false;
  async function fill() {
    active();
    if (eof) return;
    const buffer = Buffer.alloc(65536),
      { bytesRead } = await input.read(buffer, 0, buffer.length, null);
    if (!bytesRead) {
      eof = true;
      return;
    }
    consumed += bytesRead;
    assert.ok(consumed <= maximumWire);
    const bytes = buffer.subarray(0, bytesRead);
    digest.update(bytes);
    pending = pending.length ? Buffer.concat([pending, bytes]) : bytes;
  }
  async function header() {
    for (;;) {
      active();
      const end = pending.indexOf(10);
      if (end >= 0) {
        assert.ok(end > 0 && end <= 2048, "guest capture header exceeds bound");
        const line = pending.subarray(0, end);
        pending = pending.subarray(end + 1);
        const text = new TextDecoder("utf-8", { fatal: true }).decode(line);
        const raw: unknown = JSON.parse(text);
        assert.equal(
          JSON.stringify(raw),
          text,
          "guest capture header must be exact canonical JSON",
        );
        return raw;
      }
      assert.ok(pending.length <= 2048 && !eof, "guest capture header is oversized or truncated");
      await fill();
    }
  }
  const entries: { path: string; bytes: number; sha256: string }[] = [],
    seen = new Set<string>(),
    directories = new Set<string>(),
    spellings = new Map<string, string>();
  let total = 0,
    last = "";
  try {
    assert.equal(identity(await input.stat()), identity(before));
    active();
    await mkdir(output, { mode: 0o700 }); // Exact CreateNew boundary; partial files remain on refusal.
    for (;;) {
      active();
      const raw = await header();
      assert.ok(isRecord(raw) && raw.schema_version === 1 && raw.invocation_id === invocation);
      if ("complete" in raw) {
        assert.equal(
          Object.keys(raw).sort().join(","),
          "authority,complete,count,invocation_id,schema_version",
        );
        assert.equal(raw.complete, true);
        assert.equal(raw.authority, "none");
        assert.equal(raw.count, entries.length);
        assert.equal(pending.length, 0, "guest capture has trailing bytes");
        await fill();
        assert.ok(eof && pending.length === 0, "guest capture has trailing bytes");
        break;
      }
      assert.equal(
        Object.keys(raw).sort().join(","),
        "bytes,invocation_id,path,schema_version,sha256",
      );
      const name = inspectNativeCaptureWirePath(raw.path);
      assert.ok(
        name > last && !seen.has(name.toLowerCase()),
        "guest capture paths repeat or reorder",
      );
      last = name;
      seen.add(name.toLowerCase());
      const parts = name.split("/");
      for (let count = 1; count <= parts.length; count++) {
        const prefix = parts.slice(0, count).join("/"),
          lower = prefix.toLowerCase();
        assert.ok(
          !spellings.has(lower) || spellings.get(lower) === prefix,
          "guest capture directory case collision",
        );
        spellings.set(lower, prefix);
        if (count < parts.length) {
          directories.add(prefix);
          assert.ok(directories.size <= 512, "guest capture directory inventory exceeds bound");
        }
      }
      assert.ok(
        Number.isSafeInteger(raw.bytes) &&
          Number(raw.bytes) >= 0 &&
          Number(raw.bytes) <= 32 * 1024 * 1024,
      );
      assert.ok(typeof raw.sha256 === "string" && /^[a-f0-9]{64}$/u.test(raw.sha256));
      total += Number(raw.bytes);
      assert.ok(total <= 256 * 1024 * 1024 && entries.length < 512);
      const target = path.join(output, ...name.split("/"));
      await mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
      active();
      const file = await open(
        target,
        constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0),
        0o600,
      );
      const hash = createHash("sha256");
      let remaining = Number(raw.bytes);
      try {
        while (remaining) {
          active();
          if (!pending.length) {
            await fill();
            assert.ok(pending.length, "guest capture body is truncated");
          }
          const chunk = pending.subarray(0, Math.min(remaining, pending.length));
          pending = pending.subarray(chunk.length);
          hash.update(chunk);
          await file.writeFile(chunk);
          remaining -= chunk.length;
        }
        assert.equal(hash.digest("hex"), raw.sha256, "guest capture file digest differs");
      } finally {
        await file.close();
      }
      entries.push(Object.freeze({ path: name, bytes: Number(raw.bytes), sha256: raw.sha256 }));
    }
    assert.equal(consumed, before.size);
    active();
    assert.equal(digest.digest("hex"), expectedSha, "original guest capture wire differs");
    assert.equal(identity(await input.stat()), identity(before));
    assert.equal(identity(await lstat(wire)), identity(before));
    return Object.freeze({
      invocation_id: invocation,
      wire_sha256: expectedSha,
      directory: output,
      entries: Object.freeze(entries),
      authority: "none" as const,
    });
  } finally {
    await input.close();
  }
}
