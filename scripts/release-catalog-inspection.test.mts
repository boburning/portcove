import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile, link } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import test from "node:test";
import {
  inspectCatalogCoreReport,
  readCatalogPublicationBundle,
  requireActualCatalogInspection,
} from "./release-catalog-inspection.mts";
const hash = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");

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
