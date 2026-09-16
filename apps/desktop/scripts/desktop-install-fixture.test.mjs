import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "vitest";
import {
  createInstallFixture,
  INSTALL_FIXTURE_PORT_ID,
  INSTALL_REFRESH_FIXTURE_PORT_ID,
} from "./desktop-install-fixture.mjs";
import { installScenarios } from "./desktop-install-test.mjs";

const root = fileURLToPath(new URL("../../..", import.meta.url));

async function waitFor(predicate, message) {
  const deadline = Date.now() + 5_000;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error(message);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

test("install fixture is isolated, pinned, interruptible, and retryable", async () => {
  const output = await mkdtemp(path.join(tmpdir(), "portcove-install-fixture-"));
  const fixture = await createInstallFixture({ root, output });
  try {
    const catalog = JSON.parse(await readFile(fixture.catalogPath, "utf8"));
    const port = catalog.ports.find((item) => item.id === INSTALL_FIXTURE_PORT_ID);
    const refreshPort = catalog.ports.find((item) => item.id === INSTALL_REFRESH_FIXTURE_PORT_ID);
    assert.ok(port);
    assert.ok(refreshPort);
    assert.notEqual(port.id, refreshPort.id);
    assert.notEqual(port.name, refreshPort.name);
    assert.equal(port.release.provider, "direct-manifest");
    assert.equal(port.release.direct[port.platforms[0]].url, fixture.url);
    assert.equal(refreshPort.release.direct[refreshPort.platforms[0]].url, fixture.url);
    assert.equal(
      refreshPort.release.direct[refreshPort.platforms[0]].sha256,
      port.release.direct[port.platforms[0]].sha256,
    );
    assert.equal(port.source_profile, undefined);
    assert.equal(refreshPort.source_profile, undefined);

    const controller = new AbortController();
    const first = await fetch(fixture.url, { signal: controller.signal });
    const reader = first.body.getReader();
    await reader.read();
    controller.abort();
    await reader.cancel().catch(() => {});
    await waitFor(
      () => fixture.requests[0]?.connection_closed,
      "cancelled fixture connection did not close",
    );
    assert.equal(fixture.requests[0].completed, false);
    assert.ok(fixture.requests[0].bytes_sent < fixture.artifact.length);

    const retry = Buffer.from(await (await fetch(fixture.url)).arrayBuffer());
    assert.equal(
      createHash("sha256").update(retry).digest("hex"),
      port.release.direct[port.platforms[0]].sha256,
    );
    assert.equal(fixture.requests[1].completed, true);
    assert.equal(fixture.requests[1].bytes_sent, fixture.artifact.length);

    const published = await fixture.publishRelease(INSTALL_FIXTURE_PORT_ID, {
      version: "2.0.0-fixture",
      publishedAt: "2026-09-16T02:00:00Z",
      seed: 0x24300002,
    });
    const updatedCatalog = JSON.parse(await readFile(fixture.catalogPath, "utf8"));
    const updatedPort = updatedCatalog.ports.find((item) => item.id === INSTALL_FIXTURE_PORT_ID);
    const updatedRelease = updatedPort.release.direct[updatedPort.platforms[0]];
    assert.equal(updatedRelease.version, published.version);
    assert.equal(updatedRelease.url, published.url);
    assert.equal(updatedRelease.sha256, published.sha256);
    assert.notEqual(updatedRelease.sha256, port.release.direct[port.platforms[0]].sha256);
    assert.equal(
      createHash("sha256")
        .update(await readFile(fixture.artifactPath))
        .digest("hex"),
      published.sha256,
    );
    const upgraded = Buffer.from(await (await fetch(published.url)).arrayBuffer());
    assert.equal(createHash("sha256").update(upgraded).digest("hex"), published.sha256);
    assert.equal(fixture.requests[2].completed, true);
    const original = Buffer.from(await (await fetch(fixture.url)).arrayBuffer());
    assert.equal(
      createHash("sha256").update(original).digest("hex"),
      refreshPort.release.direct[refreshPort.platforms[0]].sha256,
    );
    assert.equal(fixture.requests[3].completed, true);
  } finally {
    await fixture.close();
  }
});

test("unselected install scenarios do not require an initialized fixture", async () => {
  const registered = [];
  await installScenarios({
    scenario: async (id) => registered.push(id),
  });
  assert.deepEqual(registered, [
    "install-progress-cancellation",
    "install-commit-refresh-recovery",
  ]);
});
