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
  callId: "inert-call-id",
  threadId: "inert-thread-id",
  sessionId: "inert-session-id",
  windowId: "inert-window-id",
  itemId: "inert-item-id",
  codex_bridge_mcp_call_id: "inert-bridge-id",
  "x-codex-turn-metadata": { codex_version: "0.162.0", source: "inert" },
  traceparent: `00-${"a".repeat(32)}-${"b".repeat(16)}-01`,
  tracestate: "portcove=inert",
  progressToken: 1,
  "openai/readOnly": true,
};

function responsePage(raw: unknown) {
  assert.ok(isRecord(raw) && isRecord(raw.result) && Array.isArray(raw.result.content));
  const content: unknown = raw.result.content[0];
  assert.ok(isRecord(content) && typeof content.text === "string");
  const page: unknown = JSON.parse(content.text);
  assert.ok(isRecord(page));
  return page;
}

await test("pinned RMCP transport metadata does not change the exact frozen read", () => {
  for (const meta of [undefined, {}, trace]) {
    const dispatch = createSemanticSnapshotRpc(inspectSemanticReaderIndex(index, sha(index)));
    dispatch(initialize);
    const result = dispatch(call(meta))!;
    assert.equal(responsePage(result).data, data.toString("utf8"));
  }
  for (const meta of [
    { callId: "" },
    { "x-codex-turn-metadata": { data: "x".repeat(4096) } },
    { command: "inert" },
    { "openai/readOnly": false },
    { traceparent: "invalid" },
    { tracestate: "x\ny" },
    { progressToken: "x".repeat(129) },
    ...["threadId", "sessionId", "windowId", "itemId", "codex_bridge_mcp_call_id"].flatMap(
      (key) => [{ [key]: 1 }, { [key]: "x".repeat(257) }, { [key]: "x\0" }],
    ),
  ]) {
    const dispatch = createSemanticSnapshotRpc(inspectSemanticReaderIndex(index, sha(index)));
    dispatch(initialize);
    assert.throws(() => dispatch(call(meta)), /metadata/);
  }
});

await test("real fixed stdio reader accepts bounded tracing and refuses extra capabilities", () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "portcove-reader-protocol-"));
  const file = path.join(directory, "index.json");
  writeFileSync(file, index, { flag: "wx" });
  try {
    const server = fileURLToPath(new URL("./release-semantic-reader-server.mts", import.meta.url));
    const run = (request: unknown, after: unknown[] = []) =>
      spawnSync(process.execPath, [server, file, sha(index)], {
        input: [
          initialize,
          { jsonrpc: "2.0", method: "notifications/initialized" },
          request,
          ...after,
        ]
          .map((value) => JSON.stringify(value) + "\n")
          .join(""),
        encoding: "utf8",
        timeout: 10000,
        maxBuffer: 1024 * 1024,
        windowsHide: true,
      });
    const good = run(call(trace));
    assert.equal(good.status, 0, good.stderr);
    const response: unknown = JSON.parse(good.stdout.trim().split("\n").at(-1)!);
    assert.equal(responsePage(response).sha256, sha(data));
    const bad = run(
      { ...call(trace), params: { ...call(trace).params, name: "execute-secret-fixture" } },
      [{ ...call(trace), id: 2 }],
    );
    assert.equal(bad.status, 0, bad.stderr);
    assert.match(bad.stdout, /"error":\{"code":-32602,"message":"unauthorized reader operation"\}/);
    assert.doesNotMatch(bad.stdout + bad.stderr, /execute-secret-fixture/);
    const afterRefusal: unknown = JSON.parse(bad.stdout.trim().split("\n").at(-1)!);
    assert.equal(responsePage(afterRefusal).sha256, sha(data));
    const metadata = run(call({ privateFixture: "must-not-be-reflected" }), [
      { ...call(trace), id: 2 },
    ]);
    assert.equal(metadata.status, 0, metadata.stderr);
    assert.match(metadata.stdout, /unsupported frozen-reader transport metadata/);
    assert.doesNotMatch(metadata.stdout + metadata.stderr, /privateFixture|must-not-be-reflected/);
    const afterMetadata: unknown = JSON.parse(metadata.stdout.trim().split("\n").at(-1)!);
    assert.equal(responsePage(afterMetadata).sha256, sha(data));
    const exhausted = run(
      call(trace),
      Array.from({ length: 1100 }, () => call(trace)),
    );
    assert.notEqual(exhausted.status, 0);
    assert.match(exhausted.stderr, /reader lifetime call bound exceeded/);
  } finally {
    unlinkSync(file);
    rmdirSync(directory);
  }
});
