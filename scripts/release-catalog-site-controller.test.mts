import assert from "node:assert/strict";
import test from "node:test";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";
import {
  runFixedCatalogSiteConfiguration,
  runCatalogSitePublicationController,
  recoverActualCatalogSitePublication,
} from "./release-catalog-site-controller.mts";
import {
  prepareCatalogSiteDeploymentFromActualRepository,
  prepareCatalogSiteHandoffFromActualRepository,
  readBackSiteDeployment,
} from "./release-site-deployment.mts";
import {
  recoverOwnedPublishedCatalogMetadata,
  recoverOwnedPublishedMetadata,
} from "./release-capacity-executor.mts";

void test("imported catalog assemblies, deployments and executors cannot reach provider or filesystem work", async () => {
  const raw = {
    repository: "uncreated",
    checkpoint: "uncreated",
    output_parent: "uncreated",
    deadline: performance.now() + 10000,
  };
  for (const prepare of [
    prepareCatalogSiteDeploymentFromActualRepository,
    prepareCatalogSiteHandoffFromActualRepository,
  ])
    await assert.rejects(
      prepare({ kind: "actual-catalog-keyless-assembly" }, raw),
      /actual keyless catalog assembly/,
    );
  await assert.rejects(
    runCatalogSitePublicationController({}, {}, "uncreated", raw.deadline),
    /actual keyless catalog assembly/,
  );
  await assert.rejects(
    readBackSiteDeployment({ kind: "prepared-catalog-site-deployment" }),
    /imported deployment/,
  );
  let reads = 0;
  for (const recover of [recoverOwnedPublishedMetadata, recoverOwnedPublishedCatalogMetadata])
    await assert.rejects(
      recover(
        { kind: "authenticated-capacity-executor" },
        { repository: "uncreated", checkpoint: "uncreated", remote_configuration: {} },
        async () => {
          reads++;
        },
      ),
      /actual authenticated executor/,
    );
  await assert.rejects(
    recoverActualCatalogSitePublication({}, {} as never, { ...raw, remote_configuration: {} }),
    /actual keyless catalog assembly/,
  );
  assert.equal(reads, 0);
});
void test("catalog fixed invocation never reinterprets application roles or arbitrary schemas", async () => {
  for (const value of [
    null,
    {},
    { mode: "metadata" },
    { mode: "catalog", roles: Array(5).fill({}) },
    { mode: "catalog", context: {}, identity: {}, roles: [], tools: {}, acceptance: true },
  ])
    await assert.rejects(
      runFixedCatalogSiteConfiguration(value, "uncreated"),
      /fixed catalog site invocation/,
    );
});
void test(
  "controlled actual-module wiring composes catalog archive and uses sole Pages path plus atomic cursor",
  { timeout: 30000 },
  async () => {
    const { stdout } = await promisify(execFile)(
      process.execPath,
      [
        "--experimental-test-module-mocks",
        fileURLToPath(new URL("./fixtures/release-catalog-site-fixture.mts", import.meta.url)),
      ],
      { timeout: 25000, maxBuffer: 512 * 1024, windowsHide: true },
    );
    assert.match(stdout, /sole-pages\/atomic-cursor PASS; no actual authority/u);
  },
);
