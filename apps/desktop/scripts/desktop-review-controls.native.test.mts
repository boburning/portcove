import assert from "node:assert/strict";
import test from "node:test";
import { decodeDiscoverPortIds } from "./desktop-review-presentation.mts";
import { copyFile, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { toolCachePaths } from "../../../scripts/tool-cache.mts";

void test("native Discover observations preserve separate exact ports without grouping by display title", () => {
  assert.deepEqual(decodeDiscoverPortIds('["render96ex","super-mario-64-sm64-co-op-dx"]'), [
    "render96ex",
    "super-mario-64-sm64-co-op-dx",
  ]);
  for (const invalid of [
    null,
    "{}",
    '"render96ex"',
    '["render96ex",null]',
    '["render96ex","render96ex"]',
    '[""]',
  ])
    assert.throws(() => decodeDiscoverPortIds(invalid));
});

void test("native Discover observation contracts run before desktop dependencies are installed", async (t) => {
  // Keep the consumer outside installed workspace ancestry, including when
  // storage guards redirect the process temporary directory into the checkout.
  const isolation = path.join(toolCachePaths().sharedRoot, "node-contracts");
  await mkdir(isolation, { recursive: true });
  const directory = await mkdtemp(path.join(isolation, "discover-observation-import-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  for (const name of ["desktop-review-presentation.mts", "browser-script.mts"])
    await copyFile(new URL(name, import.meta.url), path.join(directory, name));
  const consumer = path.join(directory, "consumer.mjs");
  await writeFile(
    consumer,
    `import assert from "node:assert/strict";
    for (const name of ["axe-core", "selenium-webdriver"])
      assert.throws(() => import.meta.resolve(name), { code: "ERR_MODULE_NOT_FOUND" });
    const { decodeDiscoverPortIds } = await import("./desktop-review-presentation.mts");
    assert.deepEqual(decodeDiscoverPortIds('["render96ex","super-mario-64-sm64-co-op-dx"]'),
      ["render96ex", "super-mario-64-sm64-co-op-dx"]);
    assert.throws(() => decodeDiscoverPortIds('["render96ex","render96ex"]'));
    console.log("Dependency-free native Discover observations passed");`,
  );
  const result = spawnSync(process.execPath, [consumer], {
    cwd: directory,
    encoding: "utf8",
    timeout: 5000,
    windowsHide: true,
  });
  assert.equal(result.error, undefined);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Dependency-free native Discover observations passed/);
});
