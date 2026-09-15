import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "vitest";
import { createInstallFixture, INSTALL_FIXTURE_PORT_ID } from "./desktop-install-fixture.mjs";

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
    assert.ok(port);
    assert.equal(port.release.provider, "direct-manifest");
    assert.equal(port.release.direct[port.platforms[0]].url, fixture.url);
    assert.equal(port.source_profile, undefined);

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
  } finally {
    await fixture.close();
  }
});
