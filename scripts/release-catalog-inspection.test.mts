import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile, link, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import test from "node:test";
import {
  inspectCatalogCoreReport,
  readCatalogPublicationBundle,
  requireActualCatalogInspection,
  readCatalogCoreMachineEnvelope,
} from "./release-catalog-inspection.mts";
const hash = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");

void test("shared Core machine reader pins current84 and refuses old/future schemas, malformed envelopes and reflected authority", async () => {
  const core = await readFile(
    new URL("../crates/portcove-core/src/lib.rs", import.meta.url),
    "utf8",
  );
  const declarations = [...core.matchAll(/^pub const API_SCHEMA_VERSION: u32 = ([0-9]+);\r?$/gmu)];
  assert.deepEqual(
    declarations.map((match) => Number(match[1])),
    [84],
  );
  const index = Buffer.from('{"index_schema":1,"definitions":[],"contents":[]}');
  const files = new Map([["definitions/index.json", index]]);
  const report = {
    publication_schema: 1,
    authority: "none",
    index_sha256: hash(index),
    files: [{ target: "definitions/index.json", bytes: index.length, sha256: hash(index) }],
    definitions: [],
    scope: "inert-managed-definition-publication-inspection",
  };
  const envelope = {
    schema_version: Number(declarations[0]![1]),
    command: "catalog.inspect-definition-publication",
    ok: true,
    error: null,
    data: report,
  };
  assert.deepEqual(readCatalogCoreMachineEnvelope(JSON.stringify(envelope), "", files), report);
  for (const change of [
    { schema_version: 79 },
    { schema_version: 80 },
    { schema_version: 81 },
    { schema_version: 82 },
    { schema_version: 83 },
    { schema_version: 85 },
    { schema_version: "84" },
    { command: "catalog.list" },
    { ok: false },
    { ok: "true" },
    { error: { code: "refused" } },
    { authority: "accepted" },
    { data: { ...report, authority: "publisher" } },
    { data: { ...report, accepted: true } },
  ])
    assert.throws(() =>
      readCatalogCoreMachineEnvelope(JSON.stringify({ ...envelope, ...change }), "", files),
    );
  const missing: Record<string, unknown> = { ...envelope };
  delete missing.error;
  for (const raw of [
    "",
    "not-json",
    "null",
    "[]",
    JSON.stringify(missing),
    " ".repeat(4 * 1024 ** 2 + 1),
    JSON.stringify(envelope) + "\ud800",
  ])
    assert.throws(() => readCatalogCoreMachineEnvelope(raw, "", files));
  assert.throws(() => readCatalogCoreMachineEnvelope(JSON.stringify(envelope), "warning", files));
  assert.throws(() =>
    readCatalogCoreMachineEnvelope(
      JSON.stringify(envelope),
      "",
      new Map([["definitions/index.json", Buffer.from("{}")]]),
    ),
  );
  const copied = {
    ...readCatalogCoreMachineEnvelope(JSON.stringify(envelope), "", files),
    kind: "actual-catalog-core-inspection" as const,
  };
  await assert.rejects(
    requireActualCatalogInspection(copied, performance.now() + 1000),
    /same-process/,
  );
  const fixture = await readFile(
    new URL("./qualify-controller-tool-build.mts", import.meta.url),
    "utf8",
  );
  const actual = await readFile(
    new URL("./release-catalog-inspection.mts", import.meta.url),
    "utf8",
  );
  assert.match(
    fixture,
    /readCatalogCoreMachineEnvelope\(\s*inspected\.stdout,\s*inspected\.stderr,/u,
  );
  assert.match(
    actual,
    /const report = readCatalogCoreMachineEnvelope\(result\.stdout, result\.stderr, original\)/u,
  );
});

void test("inert Core report binds full bytes; changed, extra and authority reports refuse", () => {
  const index = Buffer.from('{"index_schema":1,"definitions":[],"contents":[]}');
  const files = new Map([["definitions/index.json", index]]);
  const report = {
    publication_schema: 1,
    authority: "none",
    index_sha256: hash(index),
    files: [{ target: "definitions/index.json", bytes: index.length, sha256: hash(index) }],
    definitions: [],
    scope: "inert-managed-definition-publication-inspection",
  };
  assert.deepEqual(inspectCatalogCoreReport(report, files), report);
  assert.throws(() => inspectCatalogCoreReport({ ...report, authority: "publisher" }, files));
  assert.throws(() =>
    inspectCatalogCoreReport(report, new Map([["definitions/index.json", Buffer.from("{}")]])),
  );
  assert.throws(() =>
    inspectCatalogCoreReport(report, new Map([...files, ["sha256/extra.json", Buffer.from("{}")]])),
  );
});

void test("catalog bundle refuses unreferenced paths, hardlinks and expired deadlines", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "catalog-inspection-"));
  const deadline = () => performance.now() + 10000;
  try {
    await mkdir(path.join(root, "definitions"));
    const index = path.join(root, "definitions/index.json");
    await writeFile(index, '{"index_schema":1,"definitions":[],"contents":[]}');
    assert.equal((await readCatalogPublicationBundle(root, deadline())).size, 1);
    await assert.rejects(readCatalogPublicationBundle(root, performance.now() - 1), /deadline/);
    await writeFile(path.join(root, "extra.json"), "{}");
    await assert.rejects(readCatalogPublicationBundle(root, deadline()), /identity/);
    await rm(path.join(root, "extra.json"));
    const alias = path.join(root, "alias.json");
    await link(index, alias);
    await assert.rejects(readCatalogPublicationBundle(root, deadline()), /identity/);
    await rm(alias);
    await mkdir(path.join(root, "unreferenced"));
    await assert.rejects(readCatalogPublicationBundle(root, deadline()), /unreferenced/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

void test("imported or copied Core receipt cannot mint actual inspection capability", async () => {
  await assert.rejects(
    requireActualCatalogInspection(
      { kind: "actual-catalog-core-inspection" },
      performance.now() + 1000,
    ),
    /same-process/,
  );
});

void test("listing publication requires capable exact inspection and binds every descriptive byte", () => {
  const index = Buffer.from('{"index_schema":1,"definitions":[],"contents":[]}');
  const target = "policy/official/catalog.listings.json";
  const bytes = Buffer.from(
    '{"listing_delivery_schema":1,"revision":1,"withdrawn_ids":[],"directory":{"format_version":1,"listings":[]}}',
  );
  const files = new Map([
    ["definitions/index.json", index],
    [target, bytes],
  ]);
  const report = {
    publication_schema: 2,
    authority: "none",
    index_sha256: hash(index),
    files: [...files]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([target, bytes]) => ({ target, bytes: bytes.length, sha256: hash(bytes) })),
    definitions: [],
    scope: "inert-catalog-publication-inspection",
    listings: {
      target,
      revision: 1,
      sha256: hash(bytes),
      listing_count: 0,
      withdrawn_count: 0,
    },
  };
  assert.deepEqual(inspectCatalogCoreReport(report, files), report);
  assert.throws(() => inspectCatalogCoreReport({ ...report, publication_schema: 1 }, files));
  assert.throws(() =>
    inspectCatalogCoreReport(
      { ...report, listings: { ...report.listings, sha256: "f".repeat(64) } },
      files,
    ),
  );
  assert.throws(() =>
    inspectCatalogCoreReport(
      { ...report, listings: { ...report.listings, operations: ["install"] } },
      files,
    ),
  );
  assert.throws(() => inspectCatalogCoreReport({ ...report, publication_schema: 3 }, files));
});
