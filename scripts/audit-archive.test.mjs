import assert from "node:assert/strict";
import { createAuditZip as archive } from "./fixtures/audit-zip-fixture.mjs";
import test from "node:test";
import { parseAuditArchive } from "./audit-archive.mjs";

test("bounded ZIP decodes regular allowlisted files with verified CRCs", () => {
  const bytes = archive([
    ["manifest.json", "{}"],
    ["inputs.json", '{"original":true}', { method: 0 }],
    ["receipts/rust.json", "{}"],
  ]);
  const files = parseAuditArchive(bytes);
  assert.equal(files.get("inputs.json").toString(), '{"original":true}');
  assert.equal(files.size, 3);
});

test("metadata rejects huge counts, declared sizes, ZIP64 and multipart before inflation", () => {
  for (const mutate of [
    (b) => {
      b.writeUInt16LE(65535, b.length - 14);
      b.writeUInt16LE(65535, b.length - 12);
    },
    (b) => {
      const central = b.readUInt32LE(b.length - 6);
      b.writeUInt32LE(0xffffffff, central + 24);
    },
    (b) => {
      const central = b.readUInt32LE(b.length - 6);
      b.writeUInt16LE(45, central + 6);
    },
    (b) => b.writeUInt16LE(1, b.length - 18),
  ]) {
    const bytes = archive([["inputs.json", "{}"]]);
    mutate(bytes);
    let inflations = 0;
    assert.throws(() =>
      parseAuditArchive(bytes, {
        inflate: () => {
          inflations++;
          return Buffer.from("{}");
        },
      }),
    );
    assert.equal(inflations, 0);
  }
});

test("paths, links, duplicate names, mismatched headers and overlaps refuse before inflation", () => {
  const bad = [
    archive([["../inputs.json", "{}"]]),
    archive([["inputs.json", "{}", { attributes: 0xa1ff0000 }]]),
    archive([
      ["inputs.json", "{}"],
      ["inputs.json", "{}"],
    ]),
    archive([["Inputs.json", "{}"]]),
  ];
  const mismatch = archive([["inputs.json", "{}"]]);
  mismatch[30] = 0x78;
  bad.push(mismatch);
  const overlap = archive([
    ["manifest.json", "{}"],
    ["inputs.json", "{}"],
  ]);
  const start = overlap.readUInt32LE(overlap.length - 6);
  const second = start + 46 + Buffer.byteLength("manifest.json");
  overlap.writeUInt32LE(0, second + 42);
  bad.push(overlap);
  for (const bytes of bad) {
    let count = 0;
    assert.throws(() =>
      parseAuditArchive(bytes, {
        inflate: () => {
          count++;
          return Buffer.from("{}");
        },
      }),
    );
    assert.equal(count, 0);
  }
});

test("actual inflated output and checksums cannot exceed declared admission", () => {
  const bytes = archive([["inputs.json", "{}"]]);
  assert.throws(() => parseAuditArchive(bytes, { inflate: () => Buffer.from("too large") }));
  const stored = archive([["inputs.json", "{}", { method: 0 }]]);
  stored[30 + Buffer.byteLength("inputs.json")] = 0x78;
  assert.throws(() => parseAuditArchive(stored), /CRC/);
});

test("valid expanded boundary works while cumulative excess refuses before inflate", () => {
  const data = Buffer.alloc(32 * 1024 * 1024, 0x20);
  const good = archive([["inputs.json", data]]);
  assert.equal(parseAuditArchive(good).get("inputs.json").length, data.length);
  const bad = archive([
    ["inputs.json", data],
    ["manifest.json", "x"],
  ]);
  let count = 0;
  assert.throws(() =>
    parseAuditArchive(bad, {
      inflate: () => {
        count++;
        return Buffer.alloc(0);
      },
    }),
  );
  assert.equal(count, 0);
});
