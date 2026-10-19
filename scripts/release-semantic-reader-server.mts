import { openSync, fstatSync, readFileSync, closeSync, writeSync } from "node:fs";
import path from "node:path";
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
    const response = dispatch(JSON.parse(line.toString("utf8")) as unknown);
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
