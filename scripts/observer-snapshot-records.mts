/** Bounded streaming transport of inert checkpoint records. */
import { createHash } from "node:crypto";
import { Readable, Writable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { constants, createBrotliCompress, createBrotliDecompress } from "node:zlib";
import { isRecord } from "./runtime-values.mts";

export const observerRecordMagic = Buffer.from("PORTCOVE-OBSERVER-SNAPSHOT-4\n", "ascii");
const chunkSize = 64 * 1024;
type RecordInput = { name: string; bytes: Buffer };
type Limits = { member: number; record: number; records: number; deadline: number };
function requireRecord(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`Observer snapshot records: ${message}`);
}
function remaining(limits: Limits) {
  const left = limits.deadline - Date.now();
  requireRecord(Number.isFinite(left) && left > 0 && left <= 60000, "deadline exhausted");
  return Math.max(1, Math.ceil(left));
}
export function assertObserverRecordRuntime(version = process.versions.node) {
  const [major, minor, patch] = version.split(".").map(Number);
  const floor = new Map([
    [22, [23, 4]],
    [24, [22, 1]],
    [26, [12, 1]],
  ]).get(major!);
  requireRecord(
    floor && (minor! > floor[0]! || (minor === floor[0] && patch! >= floor[1]!)),
    "patched supported Node runtime required for streaming Brotli",
  );
}
function boundedWindow(bytes: Buffer) {
  requireRecord(bytes.length > 0, "compressed stream missing");
  const first = bytes[0]!;
  // RFC7932 section9.1, least-significant bits first. Reject WBITS23/24,
  // reserved0010001 and the nonstandard large-window extension before allocation.
  requireRecord(
    (first & 1) === 0 ||
      [3, 5, 7, 9, 11].includes(first & 15) ||
      [1, 33, 49, 65, 81, 97, 113].includes(first & 127),
    "Brotli window exceeds four MiB or is invalid",
  );
}

export async function encodeObserverRecords(records: AsyncIterable<RecordInput>, limits: Limits) {
  assertObserverRecordRuntime();
  remaining(limits);
  const hash = createHash("sha256"),
    chunks: Buffer[] = [];
  let count = 0,
    logical = 0,
    transferred = 0;
  async function* input() {
    for await (const record of records) {
      remaining(limits);
      requireRecord(
        ++count <= limits.records &&
          record.bytes.length > 0 &&
          record.bytes.length <= limits.record,
        "record input envelope exceeded",
      );
      requireRecord(/^[A-Za-z0-9$./-]{1,96}$/u.test(record.name), "record name invalid");
      const header = Buffer.from(
        JSON.stringify({ name: record.name, bytes: record.bytes.length }) + "\n",
      );
      requireRecord(header.length <= 512, "record header too large");
      hash.update(header).update(record.bytes);
      logical += header.length + record.bytes.length;
      yield header;
      // Copied chunks do not retain a previous large source buffer when the
      // generator advances. Backpressure bounds queued bytes independently.
      for (let at = 0; at < record.bytes.length; at += chunkSize) {
        remaining(limits);
        yield Buffer.from(record.bytes.subarray(at, at + chunkSize));
      }
    }
  }
  const output = new Writable({
    highWaterMark: chunkSize,
    write(chunk: Buffer, _encoding, done) {
      transferred += chunk.length;
      if (transferred > limits.member - observerRecordMagic.length - 512)
        return done(
          new Error(
            "Observer snapshot records: compressed member exceeds reserved output envelope; checkpoints retained",
          ),
        );
      chunks.push(Buffer.from(chunk));
      done();
    },
  });
  await pipeline(
    Readable.from(input(), { objectMode: false, highWaterMark: chunkSize }),
    createBrotliCompress({
      chunkSize,
      params: {
        [constants.BROTLI_PARAM_MODE]: constants.BROTLI_MODE_TEXT,
        [constants.BROTLI_PARAM_QUALITY]: 6,
        [constants.BROTLI_PARAM_LGWIN]: 22,
      },
    }),
    output,
    { signal: AbortSignal.timeout(remaining(limits)) },
  );
  remaining(limits);
  const header = Buffer.from(
    JSON.stringify({
      format: 4,
      encoding: "brotli-records",
      records: count,
      logical_bytes: logical,
      sha256: hash.digest("hex"),
    }) + "\n",
  );
  requireRecord(header.length <= 512, "transfer header too large");
  const bytes = Buffer.concat([observerRecordMagic, header, ...chunks]);
  requireRecord(bytes.length <= limits.member, "complete member exceeds output envelope");
  return { bytes, logical_bytes: logical, records: count };
}

export async function decodeObserverRecords(
  bytes: Buffer,
  limits: Limits,
  consume: (name: string, bytes: Buffer, index: number) => void,
  admit?: (name: string, length: number, index: number, total: number) => void,
) {
  assertObserverRecordRuntime();
  remaining(limits);
  requireRecord(
    bytes.length <= limits.member &&
      bytes.subarray(0, observerRecordMagic.length).equals(observerRecordMagic),
    "transfer envelope differs",
  );
  const end = bytes.indexOf(10, observerRecordMagic.length);
  requireRecord(
    end > observerRecordMagic.length && end - observerRecordMagic.length <= 512,
    "transfer header invalid",
  );
  const header: unknown = JSON.parse(
    new TextDecoder("utf-8", { fatal: true }).decode(
      bytes.subarray(observerRecordMagic.length, end),
    ),
  );
  requireRecord(
    isRecord(header) &&
      Object.keys(header).sort().join(",") === "encoding,format,logical_bytes,records,sha256" &&
      header.format === 4 &&
      header.encoding === "brotli-records" &&
      Number.isSafeInteger(header.records) &&
      Number(header.records) > 0 &&
      Number(header.records) <= limits.records &&
      Number.isSafeInteger(header.logical_bytes) &&
      Number(header.logical_bytes) > 0 &&
      Number(header.logical_bytes) <= Number(header.records) * (limits.record + 512) &&
      typeof header.sha256 === "string" &&
      /^[a-f0-9]{64}$/u.test(header.sha256),
    "transfer fields invalid",
  );
  const compressed = bytes.subarray(end + 1);
  boundedWindow(compressed);
  const decoder = createBrotliDecompress({
    chunkSize,
    params: { [constants.BROTLI_DECODER_PARAM_LARGE_WINDOW]: 0 },
  });
  const timer = setTimeout(
    () => decoder.destroy(new Error("Observer snapshot records: decode deadline exhausted")),
    remaining(limits),
  );
  const hash = createHash("sha256");
  let logical = 0,
    count = 0,
    line = Buffer.alloc(0),
    name = "",
    payload: Buffer | null = null,
    offset = 0;
  try {
    // Input is capped at four MiB, and split to keep both stream queues bounded.
    const input = Readable.from(
      (function* () {
        for (let at = 0; at < compressed.length; at += chunkSize)
          yield compressed.subarray(at, at + chunkSize);
      })(),
      { objectMode: false, highWaterMark: chunkSize },
    );
    input.on("error", (error) => decoder.destroy(error));
    decoder.on("close", () => input.destroy());
    input.pipe(decoder);
    for await (const part of decoder) {
      const chunk = Buffer.from(part as Uint8Array);
      remaining(limits);
      logical += chunk.length;
      requireRecord(logical <= Number(header.logical_bytes), "logical transfer length exceeded");
      hash.update(chunk);
      let at = 0;
      while (at < chunk.length) {
        remaining(limits);
        if (payload === null) {
          requireRecord(count < Number(header.records), "trailing records");
          const newline = chunk.indexOf(10, at);
          const stop = newline < 0 ? chunk.length : newline;
          requireRecord(line.length + stop - at <= 512, "record header exceeded");
          line = Buffer.concat([line, chunk.subarray(at, stop)]);
          at = stop;
          if (newline < 0) continue;
          const record: unknown = JSON.parse(
            new TextDecoder("utf-8", { fatal: true }).decode(line),
          );
          requireRecord(
            isRecord(record) &&
              Object.keys(record).sort().join(",") === "bytes,name" &&
              typeof record.name === "string" &&
              /^[A-Za-z0-9$./-]{1,96}$/u.test(record.name) &&
              Number.isSafeInteger(record.bytes) &&
              Number(record.bytes) > 0 &&
              Number(record.bytes) <= limits.record,
            "record fields invalid",
          );
          name = record.name;
          admit?.(name, Number(record.bytes), count, Number(header.records));
          payload = Buffer.alloc(Number(record.bytes));
          offset = 0;
          line = Buffer.alloc(0);
          at++;
        } else {
          const length = Math.min(payload.length - offset, chunk.length - at);
          chunk.copy(payload, offset, at, at + length);
          offset += length;
          at += length;
          if (offset === payload.length) {
            consume(name, payload, count++);
            payload = null;
          }
        }
      }
    }
    requireRecord(
      decoder.bytesWritten === compressed.length &&
        payload === null &&
        line.length === 0 &&
        count === header.records &&
        logical === header.logical_bytes &&
        hash.digest("hex") === header.sha256,
      "record stream incomplete or changed",
    );
    remaining(limits);
    return { records: count, logical_bytes: logical };
  } finally {
    clearTimeout(timer);
    decoder.destroy();
  }
}
