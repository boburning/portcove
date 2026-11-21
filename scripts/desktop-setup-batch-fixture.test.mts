import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { fixtureObject as object } from "../apps/desktop/scripts/desktop-scenario-state.mts";
import {
  createInstallFixture,
  prepareReviewedSetupBatchFixture,
} from "../apps/desktop/scripts/desktop-install-fixture.mts";

const root = fileURLToPath(new URL("..", import.meta.url));
const revision = execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim();

void test("reviewed batch has two portable contracts for one original, preserving the PS1 review default", async () => {
  const output = await mkdtemp(path.join(os.tmpdir(), "portcove-batch-contract-"));
  const fixture = await createInstallFixture({ root, output, revision, sourceJourney: true });
  try {
    const originalPort = structuredClone(fixture.port);
    assert.equal(fixture.refreshPort.adapter, "psx-recomp-managed");
    assert.equal(fixture.refreshPort.bios_source_profile, fixture.sourceJourney?.profiles[1]);
    await prepareReviewedSetupBatchFixture(fixture);
    const catalog = object(JSON.parse(await readFile(fixture.catalogPath, "utf8")));
    assert.ok(Array.isArray(catalog.ports));
    const ports = catalog.ports
      .map((port: unknown) => object(port))
      .filter((port) => port.id === fixture.port.id || port.id === fixture.refreshPort.id);
    assert.equal(ports.length, 2);
    assert.equal(new Set(ports.map((port) => port.id)).size, 2);
    for (const port of ports) {
      assert.equal(port.adapter, "libultraship-portable");
      assert.equal(port.source_profile, fixture.sourceJourney?.profiles[0]);
      assert.equal(port.bios_source_profile, undefined);
      assert.deepEqual(port.release, originalPort.release);
      assert.deepEqual(port.executable_hints, originalPort.executable_hints);
      const requirements = object(port.presentation).source_requirements;
      assert.ok(Array.isArray(requirements));
      assert.deepEqual(
        requirements.map((item: unknown) => object(item).role),
        ["game"],
      );
      const sourceContracts = object(catalog.source_catalog).contracts;
      assert.ok(Array.isArray(sourceContracts));
      const contracts = sourceContracts
        .map((contract: unknown) => object(contract))
        .filter((contract) => contract.port_id === port.id);
      assert.equal(contracts.length, 1);
      const contract = contracts[0];
      assert.ok(contract);
      assert.equal(contract.role, "game");
      assert.equal(contract.profile_id, port.source_profile);
      assert.equal(contract.admission_mode, "enforced");
      if (port.id === fixture.refreshPort.id) assert.deepEqual(port, fixture.refreshPort);
    }
    assert.deepEqual(fixture.port, originalPort);
    assert.ok(fixture.sourceJourney);
    assert.deepEqual(await readFile(fixture.sourceJourney.gamePath), fixture.sourceJourney.game);
    assert.deepEqual(await readFile(fixture.sourceJourney.biosPath), fixture.sourceJourney.bios);
    assert.deepEqual(fixture.requests, []);
    const beforeRepeat = await readFile(fixture.catalogPath);
    await assert.rejects(() => prepareReviewedSetupBatchFixture(fixture));
    assert.deepEqual(await readFile(fixture.catalogPath), beforeRepeat);
  } finally {
    await fixture.close();
    await rm(output, { recursive: true, force: true });
  }
});

void test("ordinary install fixtures cannot be converted into a source-bound batch", async () => {
  const output = await mkdtemp(path.join(os.tmpdir(), "portcove-batch-refusal-"));
  const fixture = await createInstallFixture({ root, output });
  try {
    const before = await readFile(fixture.catalogPath);
    await assert.rejects(() => prepareReviewedSetupBatchFixture(fixture));
    assert.deepEqual(await readFile(fixture.catalogPath), before);
  } finally {
    await fixture.close();
    await rm(output, { recursive: true, force: true });
  }
});
