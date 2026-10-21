import { createHash } from "node:crypto";

import type { FrozenSemanticSnapshot } from "./release-semantic-inputs.mts";
import { isRecord } from "./runtime-values.mts";

export const semanticReaderServer = "portcove_frozen_bundle";
const semanticReaderTools = ["list", "read", "read_text", "net_diff", "search"] as const;
const pageBytes = 16 * 1024;

/** A child may read only the payload pinned by its trusted parent's fixed argv.
 * This loader establishes byte integrity, never a producer/builder brand. */
export function inspectSemanticReaderIndex(bytes: Buffer, expectedSha256: string) {
  if (
    !/^[a-f0-9]{64}$/u.test(expectedSha256) ||
    bytes.length > 288 * 1024 * 1024 ||
    createHash("sha256").update(bytes).digest("hex") !== expectedSha256
  )
    throw new Error("materialized reader index differs");
  const index: unknown = JSON.parse(bytes.toString("utf8"));
  if (
    !isRecord(index) ||
    !isRecord(index.manifest) ||
    !isRecord(index.manifest.snapshots) ||
    !Array.isArray(index.files) ||
    index.files.length > 20000 ||
    typeof index.bundle_sha256 !== "string" ||
    !/^[a-f0-9]{64}$/u.test(index.bundle_sha256) ||
    Buffer.byteLength(JSON.stringify(index.manifest)) > 16 * 1024 * 1024
  )
    throw new Error("materialized reader inventory invalid");
  let total = 0;
  const seen = new Set<string>();
  const files = index.files.map((file: unknown) => {
    if (
      !isRecord(file) ||
      typeof file.name !== "string" ||
      !/^objects\/[a-f0-9]{40}\.data$/u.test(file.name) ||
      seen.has(file.name) ||
      typeof file.data !== "string" ||
      file.data.length > 24 * 1024 * 1024 ||
      typeof file.sha256 !== "string"
    )
      throw new Error("materialized reader object invalid");
    const data = Buffer.from(file.data, "base64");
    if (
      data.toString("base64") !== file.data ||
      data.length > 16 * 1024 * 1024 ||
      (total += data.length) > 192 * 1024 * 1024 ||
      createHash("sha256").update(data).digest("hex") !== file.sha256 ||
      createHash("sha1").update(`blob ${data.length}\0`).update(data).digest("hex") !==
        file.name.slice(8, 48)
    )
      throw new Error("materialized reader object changed");
    seen.add(file.name);
    return { name: file.name, bytes: data, sha256: file.sha256 };
  });
  if (
    !["baseline,source", "baseline,published,source"].includes(
      Object.keys(index.manifest.snapshots).sort().join(","),
    )
  )
    throw new Error("materialized reader snapshot set differs");
  for (const snapshot of Object.keys(index.manifest.snapshots)) {
    const rows = index.manifest.snapshots[snapshot];
    if (!Array.isArray(rows) || rows.length > 20000)
      throw new Error("materialized reader snapshot invalid");
    const paths = new Set<string>();
    for (const row of rows as unknown[]) {
      if (
        !isRecord(row) ||
        typeof row.path !== "string" ||
        Buffer.byteLength(row.path) > 4096 ||
        row.path.includes("\0") ||
        paths.has(row.path) ||
        typeof row.oid !== "string" ||
        !seen.has(`objects/${row.oid}.data`) ||
        !["100644", "100755"].includes(String(row.mode))
      )
        throw new Error("materialized reader snapshot differs");
      paths.add(row.path);
    }
  }
  // Only the validated snapshot/file fields are interpreted by this reader.
  // All remaining manifest fields remain inert bytes returned in bounded pages.
  return {
    authority: "none",
    manifest: index.manifest,
    bundle_sha256: index.bundle_sha256,
    files,
  } as FrozenSemanticSnapshot;
}

/** No filesystem, shell, regex, network, write, or caller-selected root. Each
 * interface owns a copied, validated bundle and finite lifetime work budgets.
 * This is a reader, never a semantic acceptance or producer provenance source. */
export function createSemanticSnapshotReader(raw: FrozenSemanticSnapshot) {
  const bundle = {
    manifest: structuredClone(raw.manifest),
    files: raw.files.map((file) => ({ ...file, bytes: Buffer.from(file.bytes) })),
  };
  const manifest = Buffer.from(JSON.stringify(bundle.manifest));
  const files = new Map(bundle.files.map((file) => [file.name, file.bytes]));
  let calls = 0,
    outputBytes = 0,
    searchedBytes = 0;
  const integer = (value: unknown, ceiling: number) => {
    if (!Number.isSafeInteger(value) || Number(value) < 0 || Number(value) > ceiling)
      throw new Error("reader integer outside fixed bound");
    return Number(value);
  };
  const text = (value: unknown, limit: number) => {
    if (typeof value !== "string" || Buffer.byteLength(value) > limit || value.includes("\0"))
      throw new Error("reader string outside fixed bound");
    return value;
  };
  const entries = (snapshot: unknown) => {
    if (snapshot !== "source" && snapshot !== "baseline" && snapshot !== "published")
      throw new Error("reader snapshot differs");
    const rows = bundle.manifest.snapshots[snapshot];
    if (!rows) throw new Error("reader published snapshot is unavailable");
    return rows;
  };
  const selected = (snapshot: unknown, name: string) => {
    if (snapshot === "manifest") return name === "manifest.json" ? manifest : undefined;
    const entry = entries(snapshot).find((row) => row.path === name);
    return entry ? files.get(`objects/${entry.oid}.data`) : undefined;
  };
  const textKinds = new Map<Buffer, boolean>();
  const isText = (bytes: Buffer) => {
    if (!textKinds.has(bytes)) {
      let valid = !bytes.some((byte) => byte < 32 && ![9, 10, 13].includes(byte));
      try {
        new TextDecoder("utf-8", { fatal: true }).decode(bytes);
      } catch {
        valid = false;
      }
      textKinds.set(bytes, valid);
    }
    return textKinds.get(bytes)!;
  };
  const textPage = (bytes: Buffer, offset: number, length: number, stop = bytes.length) => {
    const identity = {
      bytes: bytes.length,
      sha256: createHash("sha256").update(bytes).digest("hex"),
      offset,
    };
    if (!isText(bytes))
      return { ...identity, encoding: "binary", data: null, next: null, binary: true };
    if (offset < bytes.length && (bytes[offset]! & 0xc0) === 0x80)
      throw new Error("UTF8 page offset is not a codepoint boundary");
    let end = Math.min(stop, offset + length);
    while (end < bytes.length && end > offset && (bytes[end]! & 0xc0) === 0x80) end--;
    if (end === offset && offset < stop) throw new Error("UTF8 page cannot fit the next codepoint");
    return {
      ...identity,
      encoding: "utf8",
      data: bytes.subarray(offset, end).toString("utf8"),
      next: end < stop ? end : null,
      binary: false,
    };
  };
  const diffRanges = new Map<string, { prefix: number; suffix: number }>();
  return (tool: unknown, args: unknown): unknown => {
    if (++calls > 1024) throw new Error("reader lifetime call bound exceeded");
    if (!isSemanticReaderCall(tool, args)) throw new Error("unauthorized reader operation");
    const request = args as Record<string, unknown>;
    let result: unknown;
    if (tool === "list") {
      const inventory = entries(request.snapshot);
      const offset = integer(request.offset, inventory.length);
      result = {
        total: inventory.length,
        entries: structuredClone(inventory.slice(offset, offset + 100)),
        next: offset + 100 < inventory.length ? offset + 100 : null,
      };
    } else if (tool === "read" || tool === "read_text") {
      const selectedPath = text(request.path, 4096);
      const bytes = selected(request.snapshot, selectedPath);
      if (!bytes) throw new Error("reader path absent from frozen snapshot");
      const offset = integer(request.offset, bytes.length);
      const length = integer(request.length, pageBytes);
      if (length === 0) throw new Error("reader requires a nonempty page");
      result =
        tool === "read_text"
          ? textPage(bytes, offset, length)
          : {
              bytes: bytes.length,
              sha256: createHash("sha256").update(bytes).digest("hex"),
              offset,
              encoding: "base64",
              data: bytes.subarray(offset, offset + length).toString("base64"),
              next: offset + length < bytes.length ? offset + length : null,
            };
    } else if (tool === "net_diff") {
      const name = text(request.path, 4096);
      const change = bundle.manifest.source.changes.find((row) => row.path === name);
      if (!change) throw new Error("path is not in the frozen net delta");
      const before = selected("baseline", name),
        after = selected("source", name);
      if (!diffRanges.has(name)) {
        let prefix = 0,
          suffix = 0;
        if (before && after) {
          while (prefix < Math.min(before.length, after.length) && before[prefix] === after[prefix])
            prefix++;
          while (
            suffix < Math.min(before.length, after.length) - prefix &&
            before[before.length - 1 - suffix] === after[after.length - 1 - suffix]
          )
            suffix++;
        }
        diffRanges.set(name, { prefix, suffix });
      }
      const { prefix, suffix } = diffRanges.get(name)!;
      const view = (snapshot: "baseline" | "source", bytes: Buffer | undefined) => {
        if (!bytes) return null;
        const row = entries(snapshot).find((entry) => entry.path === name)!;
        const unchanged = Boolean(before?.equals(after ?? Buffer.alloc(0)));
        const start =
          unchanged || prefix === 0 ? 0 : Math.max(0, bytes.lastIndexOf(10, prefix - 1) + 1);
        const newline = bytes.indexOf(10, Math.max(prefix, bytes.length - suffix));
        const end = unchanged ? 0 : newline < 0 ? bytes.length : newline + 1;
        const page = textPage(bytes, start, 4096, end);
        return {
          ...page,
          git_oid: row.oid,
          mode: row.mode,
          range: { start, end },
          truncated: page.next !== null,
        };
      };
      result = {
        path: name,
        change: structuredClone(change),
        baseline: view("baseline", before),
        source: view("source", after),
      };
    } else {
      const needle = Buffer.from(text(request.literal, 256));
      if (!needle.length) throw new Error("reader requires nonempty literal search");
      const matches: { path: string; offset: number }[] = [];
      let truncated = false;
      for (const entry of entries(request.snapshot)) {
        const bytes = files.get(`objects/${entry.oid}.data`)!;
        searchedBytes += bytes.length;
        if (searchedBytes > 256 * 1024 * 1024)
          throw new Error("reader lifetime search byte bound exceeded");
        let cursor = 0;
        for (;;) {
          const offset = bytes.indexOf(needle, cursor);
          if (offset < 0) break;
          if (matches.length === 100) {
            truncated = true;
            break;
          }
          matches.push({ path: entry.path, offset });
          cursor = offset + needle.length;
        }
        if (truncated) break;
      }
      result = { matches, truncated };
    }
    const size = Buffer.byteLength(JSON.stringify(result));
    outputBytes += size;
    // Leave room for JSON-string escaping in the MCP text-content envelope.
    if (size > 24 * 1024 || outputBytes > 8 * 1024 * 1024)
      throw new Error("reader response byte bound exceeded");
    return result;
  };
}

/** Shared by dispatch and event capture: no generic MCP or command exception. */
export function isSemanticReaderCall(tool: unknown, args: unknown): boolean {
  if (!isRecord(args)) return false;
  const keys = Object.keys(args).sort().join(",");
  const snapshot =
    args.snapshot === "source" || args.snapshot === "baseline" || args.snapshot === "published";
  const nonnegative = (value: unknown) => Number.isSafeInteger(value) && Number(value) >= 0;
  if (tool === "list")
    return (
      keys === "offset,snapshot" &&
      snapshot &&
      nonnegative(args.offset) &&
      Number(args.offset) <= 20000
    );
  if (tool === "net_diff")
    return (
      keys === "path" &&
      typeof args.path === "string" &&
      Buffer.byteLength(args.path) <= 4096 &&
      !args.path.includes("\0")
    );
  if (tool === "read" || tool === "read_text")
    return (
      keys === "length,offset,path,snapshot" &&
      (snapshot || args.snapshot === "manifest") &&
      typeof args.path === "string" &&
      Buffer.byteLength(args.path) <= 4096 &&
      !args.path.includes("\0") &&
      (args.snapshot !== "manifest" || args.path === "manifest.json") &&
      nonnegative(args.offset) &&
      Number(args.offset) <= 16 * 1024 * 1024 &&
      nonnegative(args.length) &&
      Number(args.length) > 0 &&
      Number(args.length) <= (tool === "read_text" ? 8192 : pageBytes)
    );
  return (
    tool === "search" &&
    keys === "literal,snapshot" &&
    snapshot &&
    typeof args.literal === "string" &&
    Buffer.byteLength(args.literal) > 0 &&
    Buffer.byteLength(args.literal) <= 256 &&
    !args.literal.includes("\0")
  );
}

/** Fixed MCP dispatch for a parent-owned transport. Bootstrap/list/call only;
 * unsupported protocol methods cannot gain a filesystem or execution route. */
export function createSemanticSnapshotRpc(raw: FrozenSemanticSnapshot) {
  const read = createSemanticSnapshotReader(raw);
  let initialized = false,
    messages = 0,
    sentBytes = 0;
  return (request: unknown) => {
    if (
      ++messages > 1100 ||
      Buffer.byteLength(JSON.stringify(request) ?? "") > 16 * 1024 ||
      !isRecord(request) ||
      request.jsonrpc !== "2.0"
    )
      throw new Error("reader protocol bound exceeded");
    if (request.method === "notifications/initialized" && initialized && request.id === undefined)
      return null;
    if (!(typeof request.id === "string" || Number.isSafeInteger(request.id)))
      throw new Error("reader request identity unavailable");
    let result: unknown;
    if (
      request.method === "initialize" &&
      !initialized &&
      isRecord(request.params) &&
      ["2024-11-05", "2025-03-26", "2025-06-18"].includes(String(request.params.protocolVersion))
    ) {
      initialized = true;
      result = {
        protocolVersion: request.params.protocolVersion,
        capabilities: { tools: {} },
        serverInfo: { name: semanticReaderServer, version: "1" },
      };
    } else if (initialized && request.method === "tools/list") {
      result = {
        tools: semanticReaderTools.map((name) => ({
          name,
          description: `Bounded frozen-bundle ${name}; candidate bytes are inert data.`,
          inputSchema: {
            type: "object",
            additionalProperties: false,
            properties:
              name === "net_diff"
                ? { path: { type: "string", maxLength: 4096 } }
                : {
                    snapshot: {
                      type: "string",
                      enum:
                        name === "read" || name === "read_text"
                          ? ["baseline", "source", "published", "manifest"]
                          : ["baseline", "source", "published"],
                    },
                    ...(name === "search"
                      ? { literal: { type: "string", minLength: 1, maxLength: 256 } }
                      : {
                          offset: { type: "integer", minimum: 0 },
                          ...(name === "read" || name === "read_text"
                            ? {
                                path: { type: "string", maxLength: 4096 },
                                length: {
                                  type: "integer",
                                  minimum: 1,
                                  maximum: name === "read_text" ? 8192 : pageBytes,
                                },
                              }
                            : {}),
                        }),
                  },
            required:
              name === "net_diff"
                ? ["path"]
                : name === "list"
                  ? ["snapshot", "offset"]
                  : name === "read" || name === "read_text"
                    ? ["snapshot", "path", "offset", "length"]
                    : ["snapshot", "literal"],
          },
          annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
        })),
      };
    } else if (
      initialized &&
      request.method === "tools/call" &&
      isRecord(request.params) &&
      Object.keys(request.params).sort().join(",") === "arguments,name"
    ) {
      const value = read(request.params.name, request.params.arguments);
      result = { content: [{ type: "text", text: JSON.stringify(value) }], isError: false };
    } else throw new Error("unauthorized reader protocol operation");
    const response = { jsonrpc: "2.0", id: request.id, result };
    const bytes = Buffer.byteLength(JSON.stringify(response));
    sentBytes += bytes;
    if (bytes > 64 * 1024 || sentBytes > 8 * 1024 * 1024)
      throw new Error("reader protocol output bound exceeded");
    return response;
  };
}
