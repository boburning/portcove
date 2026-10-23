import { openSync, fstatSync, readFileSync, closeSync, writeSync } from "node:fs";
import path from "node:path";
import { isRecord } from "./runtime-values.mts";
import {
  createSemanticSnapshotRpc,
  inspectSemanticReaderIndex,
} from "./release-semantic-reader-core.mts";

// Fixed stdio child. No caller-selected tools, paths, URLs, imports or commands.
// Parent supplies one protected payload path and its independently held hash.
if (process.argv.length !== 4 || !path.isAbsolute(process.argv[2]!))
  throw new Error("fixed reader payload identity required");
const descriptor = openSync(process.argv[2]!, "r");
let bytes: Buffer;
try {
  const stat = fstatSync(descriptor);
  if (!stat.isFile() || stat.nlink !== 1 || stat.size > 288 * 1024 * 1024)
    throw new Error("reader payload outside finite bound");
  bytes = readFileSync(descriptor);
} finally {
  closeSync(descriptor);
}
const dispatch = createSemanticSnapshotRpc(inspectSemanticReaderIndex(bytes, process.argv[3]!));
// Refuse a bounded individual request without dropping its transport. Only
// fixed public reasons are returned; lifetime/resource failures remain terminal.
const requestRefusals = new Set([
  "unauthorized reader operation",
  "reader path absent from frozen snapshot",
  "path is not in the frozen net delta",
  "unsupported frozen-reader transport metadata",
  "unauthorized reader protocol operation",
]);
let pending = Buffer.alloc(0),
  outputBytes = 0;
for await (const chunk of process.stdin) {
  const data = Buffer.concat([pending, Buffer.from(chunk as Uint8Array)]);
  let cursor = 0;
  for (;;) {
    const end = data.indexOf(10, cursor);
    if (end < 0) break;
    const line = data.subarray(cursor, end);
    if (line.length > 16 * 1024 || !Buffer.from(line.toString("utf8")).equals(line))
      throw new Error("reader protocol line exceeds bound or invalid UTF8");
    const request: unknown = JSON.parse(line.toString("utf8"));
    let response: unknown;
    try {
      response = dispatch(request);
    } catch (error) {
      if (
        !(error instanceof Error) ||
        !requestRefusals.has(error.message) ||
        !isRecord(request) ||
        !(typeof request.id === "string" || Number.isSafeInteger(request.id))
      )
        throw error;
      response = {
        jsonrpc: "2.0",
        id: request.id,
        error: { code: -32602, message: error.message },
      };
    }
    if (response !== null) {
      const output = Buffer.from(JSON.stringify(response) + "\n");
      outputBytes += output.length;
      if (output.length > 64 * 1024 || outputBytes > 8 * 1024 * 1024)
        throw new Error("reader stdio output exceeds bound");
      let written = 0;
      while (written < output.length) written += writeSync(1, output, written);
    }
    cursor = end + 1;
  }
  pending = Buffer.from(data.subarray(cursor));
  if (pending.length > 16 * 1024) throw new Error("reader protocol partial line exceeds bound");
}
if (pending.length) throw new Error("reader protocol ended incompletely");
