import assert from "node:assert/strict";
import test from "node:test";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, unlinkSync, rmdirSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  createSemanticSnapshotRpc,
  inspectSemanticReaderIndex,
} from "./release-semantic-reader-core.mts";
import { isRecord } from "./runtime-values.mts";

const sha = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
const data = Buffer.from("inert fixture\n");
const oid = createHash("sha1").update(`blob ${data.length}\0`).update(data).digest("hex");
const row = { path: "fixture.txt", oid, mode: "100644" };
const index = Buffer.from(
  JSON.stringify({
    manifest: { snapshots: { source: [row], baseline: [row] } },
    bundle_sha256: "0".repeat(64),
    files: [{ name: `objects/${oid}.data`, sha256: sha(data), data: data.toString("base64") }],
  }),
);
const initialize = {
  jsonrpc: "2.0",
  id: 0,
  method: "initialize",
  params: { protocolVersion: "2025-06-18" },
};
const call = (_meta?: unknown) => ({
  jsonrpc: "2.0",
  id: 1,
  method: "tools/call",
  params: {
    name: "read_text",
    arguments: { snapshot: "source", path: "fixture.txt", offset: 0, length: 4096 },
    ...(_meta === undefined ? {} : { _meta }),
  },
});
const trace = {
  traceparent: `00-${"a".repeat(32)}-${"b".repeat(16)}-01`,
  tracestate: "portcove=inert",
  progressToken: 1,
  "openai/readOnly": true,
};

test("pinned RMCP transport metadata does not change the exact frozen read", () => {
  for (const meta of [undefined, {}, trace]) {
    const dispatch = createSemanticSnapshotRpc(inspectSemanticReaderIndex(index, sha(index)));
    dispatch(initialize);
    const result = dispatch(call(meta))!;
    assert.ok(isRecord(result.result) && Array.isArray(result.result.content));
    const content: unknown = result.result.content[0];
    assert.ok(isRecord(content) && typeof content.text === "string");
    assert.equal(JSON.parse(content.text).data, data.toString("utf8"));
  }
  for (const meta of [
    { command: "inert" },
    { "openai/readOnly": false },
    { traceparent: "invalid" },
    { tracestate: "x\ny" },
    { progressToken: "x".repeat(129) },
  ]) {
    const dispatch = createSemanticSnapshotRpc(inspectSemanticReaderIndex(index, sha(index)));
    dispatch(initialize);
    assert.throws(() => dispatch(call(meta)), /metadata/);
  }
});

test("real fixed stdio reader accepts bounded tracing and refuses extra capabilities", () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "portcove-reader-protocol-"));
  const file = path.join(directory, "index.json");
  writeFileSync(file, index, { flag: "wx" });
  try {
    const server = fileURLToPath(new URL("./release-semantic-reader-server.mts", import.meta.url));
    const run = (request: unknown) =>
      spawnSync(process.execPath, [server, file, sha(index)], {
        input: [initialize, { jsonrpc: "2.0", method: "notifications/initialized" }, request]
          .map((value) => JSON.stringify(value) + "\n")
          .join(""),
        encoding: "utf8",
        timeout: 10000,
        maxBuffer: 1024 * 1024,
        windowsHide: true,
      });
    const good = run(call(trace));
    assert.equal(good.status, 0, good.stderr);
    const response = JSON.parse(good.stdout.trim().split("\n").at(-1)!);
    assert.equal(JSON.parse(response.result.content[0].text).sha256, sha(data));
    const bad = run({ ...call(trace), params: { ...call(trace).params, name: "execute" } });
    assert.notEqual(bad.status, 0);
    assert.doesNotMatch(bad.stdout, /"id":1/);
  } finally {
    unlinkSync(file);
    rmdirSync(directory);
  }
});
