import { crc32, inflateRawSync } from "node:zlib";
import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  readSync,
  readdirSync,
  realpathSync,
} from "node:fs";
import path from "node:path";
import { inspectBoundedZip } from "../../../scripts/bounded-zip.mts";
import { isRecord } from "../../../scripts/runtime-values.mts";

export const probeName = "retains an intentional browser UI failure trace";
export const probeFailure = "PORTCOVE_EXPECTED_BROWSER_TRACE_FAILURE";

/** Bind fresh output custody before launch; a redirected or replaced run cannot
 * supply artifacts. Reads keep their byte bound even if a file changes. */
export function createProbeArtifactReader(directory: string) {
  const physical = realpathSync(directory);
  const original = lstatSync(directory, { bigint: true });
  if (!original.isDirectory() || original.isSymbolicLink())
    throw new Error("Invalid browser probe run root");
  const verify = () => {
    const current = lstatSync(directory, { bigint: true });
    if (
      !current.isDirectory() ||
      current.isSymbolicLink() ||
      current.dev !== original.dev ||
      current.ino !== original.ino ||
      realpathSync(directory) !== physical
    )
      throw new Error("Browser probe run root changed identity");
  };
  return {
    list: () => {
      verify();
      return readdirSync(directory, { recursive: true, withFileTypes: true });
    },
    read: (file: string, limit: number) => {
      verify();
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > 16 * 1024 * 1024)
        throw new Error("Invalid browser probe read limit");
      const expected = lstatSync(file, { bigint: true });
      const relative = path.relative(physical, realpathSync(file));
      if (
        !expected.isFile() ||
        expected.size < 1n ||
        expected.size > BigInt(limit) ||
        path.isAbsolute(relative) ||
        relative === ".." ||
        relative.startsWith(`..${path.sep}`)
      )
        throw new Error("Browser probe artifact is empty, oversized or outside its run");
      const handle = openSync(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
      try {
        const opened = fstatSync(handle, { bigint: true });
        if (
          !opened.isFile() ||
          opened.dev !== expected.dev ||
          opened.ino !== expected.ino ||
          opened.size !== expected.size
        )
          throw new Error("Browser probe artifact changed before read");
        const bytes = Buffer.allocUnsafe(limit + 1);
        let length = 0;
        while (length < bytes.length) {
          const count = readSync(handle, bytes, length, bytes.length - length, null);
          if (!count) break;
          length += count;
        }
        const after = fstatSync(handle, { bigint: true });
        verify();
        if (
          length !== Number(opened.size) ||
          length > limit ||
          after.size !== opened.size ||
          after.mtimeNs !== opened.mtimeNs
        )
          throw new Error("Browser probe artifact changed during bounded read");
        return bytes.subarray(0, length);
      } finally {
        closeSync(handle);
      }
    },
  };
}

/** Pinned Vitest records swallowed teardown errors through process.exitCode. */
export async function closeProbeRunner(runner: { close(): Promise<unknown> }) {
  const testStatus = process.exitCode;
  process.exitCode = 0;
  let closeStatus: typeof process.exitCode;
  try {
    await runner.close();
  } finally {
    closeStatus = process.exitCode;
    process.exitCode = testStatus || closeStatus;
  }
  if (Number(closeStatus ?? 0) !== 0) throw new Error("Browser probe runner shutdown failed");
}

/** An arbitrary runner failure must never be accepted as the diagnostic result. */
export function verifyProbeResult(status: number | null, report: unknown, outcome: unknown) {
  if (!isRecord(outcome) || outcome.reason !== "failed" || outcome.unhandled_errors !== 0)
    throw new Error("Browser probe has no completed failure or has unhandled errors");
  if (
    status !== 1 ||
    !isRecord(report) ||
    report.success !== false ||
    report.numFailedTests !== 1 ||
    report.numPassedTests !== 0 ||
    report.numPendingTests !== 0 ||
    report.numTotalTests !== 1 ||
    !Array.isArray(report.testResults) ||
    report.testResults.length !== 1
  )
    throw new Error("Browser probe did not produce exactly one expected failure");
  const suite: unknown = report.testResults[0];
  if (
    !isRecord(suite) ||
    typeof suite.name !== "string" ||
    !suite.name.replaceAll("\\", "/").endsWith("/src/browser/failure-probe.browser.test.tsx") ||
    suite.status !== "failed" ||
    !Array.isArray(suite.assertionResults) ||
    suite.assertionResults.length !== 1
  )
    throw new Error("Browser probe suite identity differs");
  const assertion: unknown = suite.assertionResults[0];
  if (
    !isRecord(assertion) ||
    assertion.fullName !== probeName ||
    assertion.status !== "failed" ||
    !Array.isArray(assertion.failureMessages) ||
    assertion.failureMessages.length !== 1 ||
    typeof assertion.failureMessages[0] !== "string" ||
    assertion.failureMessages[0].split(/\r?\n/u)[0] !== `AssertionError: ${probeFailure}` ||
    (Array.isArray(report.unhandledErrors) && report.unhandledErrors.length !== 0)
  )
    throw new Error("Browser probe assertion differs or has unhandled errors");
}

/** Enumerate only bounded ZIP32 directory names before the maintained full
 * preflight. No extraction, parser-owned expansion or writes take place here. */
export function inspectProbeTrace(bytes: Buffer) {
  if (bytes.length < 22 || bytes.length > 16 * 1024 * 1024)
    throw new Error("Browser probe trace size exceeds diagnostic bounds");
  let end = -1;
  for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 65557); i--)
    if (
      bytes.readUInt32LE(i) === 0x06054b50 &&
      i + 22 + bytes.readUInt16LE(i + 20) === bytes.length
    ) {
      end = i;
      break;
    }
  if (end < 0) throw new Error("Browser probe trace has no terminal directory");
  const count = bytes.readUInt16LE(end + 10);
  let offset = bytes.readUInt32LE(end + 16);
  if (count < 1 || count > 64 || offset + bytes.readUInt32LE(end + 12) !== end)
    throw new Error("Browser probe trace directory exceeds diagnostic bounds");
  const paths = new Set<string>();
  for (let i = 0; i < count; i++) {
    if (offset + 46 > end || bytes.readUInt32LE(offset) !== 0x02014b50)
      throw new Error("Browser probe trace directory is truncated");
    const length = bytes.readUInt16LE(offset + 28);
    const next =
      offset + 46 + length + bytes.readUInt16LE(offset + 30) + bytes.readUInt16LE(offset + 32);
    if (length < 1 || length > 256 || next > end)
      throw new Error("Browser probe trace metadata exceeds diagnostic bounds");
    const name = bytes.subarray(offset + 46, offset + 46 + length).toString("utf8");
    if (
      !/^(?:trace\.(?:trace|network|stacks)|resources\/[a-f0-9]{40}(?:\.[a-z0-9]+)?|screencast\/page@[a-f0-9]+-\d+\.jpeg|src\/[a-f0-9]{40}\.[a-z]+)$/u.test(
        name,
      )
    )
      throw new Error("Browser probe trace has an unexpected member");
    paths.add(name);
    offset = next;
  }
  const { archive, entries } = inspectBoundedZip(bytes, {
    compressedBytes: 16 * 1024 * 1024,
    expandedBytes: 64 * 1024 * 1024,
    files: 64,
    nameBytes: 256,
    allowedPaths: paths,
  });
  let events = 0;
  for (const entry of entries) {
    const compressed = archive.subarray(entry.data, entry.dataEnd);
    const body =
      entry.method === 0
        ? compressed
        : inflateRawSync(compressed, { maxOutputLength: Math.max(1, entry.bytes) });
    if (body.length !== entry.bytes || crc32(body) !== entry.crc)
      throw new Error("Browser probe trace payload is corrupt");
    if (entry.name === "trace.trace") {
      for (const line of body.toString("utf8").trim().split("\n")) {
        const event: unknown = JSON.parse(line);
        if (!isRecord(event) || typeof event.type !== "string")
          throw new Error("Browser probe trace event is unreadable");
        events++;
      }
    }
  }
  if (!events || !paths.has("trace.network")) throw new Error("Browser probe trace is incomplete");
  return { members: entries.length, events };
}
