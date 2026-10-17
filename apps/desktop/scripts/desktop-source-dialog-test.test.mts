import assert from "node:assert/strict";
import { it } from "vite-plus/test";
import { selectedSetupScanCompleted, sourceProfileLabel } from "./desktop-source-dialog-test.mts";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createInstallFixture } from "./desktop-install-fixture.mts";

it("waits for the native scan control before reading newly completed activity", async () => {
  let release: ((enabled: boolean) => void) | undefined;
  let activityReads = 0;
  const enabled = new Promise<boolean>((resolve) => {
    release = resolve;
  });
  const pending = selectedSetupScanCompleted(
    () => enabled,
    () => {
      activityReads++;
      return [{ id: "new", operation: "discover_sources", status: "succeeded" }];
    },
    new Set(),
  );
  await Promise.resolve();
  assert.equal(activityReads, 0, "a pending WebDriver result cannot count as enabled");
  assert.ok(release);
  release(false);
  assert.equal(await pending, false);
  assert.equal(activityReads, 0, "disabled scan controls must continue waiting");
});

it("requires a new successful discovery after the control becomes enabled", async () => {
  const previous = new Set(["old"]);
  for (const record of [
    { id: "old", operation: "discover_sources", status: "succeeded" },
    { id: "new", operation: "discover_sources", status: "running" },
    { id: "new", operation: "register_source", status: "succeeded" },
  ] as const) {
    assert.equal(
      await selectedSetupScanCompleted(
        async () => true,
        () => [record],
        previous,
      ),
      false,
    );
  }
  assert.equal(
    await selectedSetupScanCompleted(
      async () => true,
      () => [{ id: "new", operation: "discover_sources", status: "succeeded" }],
      previous,
    ),
    true,
  );
});

it("preserves driver and activity failures rather than treating them as completion", async () => {
  const failure = new Error("owned scan failure");
  await assert.rejects(
    selectedSetupScanCompleted(
      async () => {
        throw failure;
      },
      () => assert.fail("driver refusal must short circuit activity reads"),
      new Set(),
    ),
    (error: unknown) => error === failure,
  );
  await assert.rejects(
    selectedSetupScanCompleted(
      async () => true,
      () => {
        throw failure;
      },
      new Set(),
    ),
    (error: unknown) => error === failure,
  );
});

it("reads the real raw qualification catalog label before Core fills output defaults", async () => {
  const output = await mkdtemp(path.join(tmpdir(), "portcove-raw-source-label-"));
  let fixture: Awaited<ReturnType<typeof createInstallFixture>> | undefined;
  try {
    fixture = await createInstallFixture({
      root: fileURLToPath(new URL("../../../", import.meta.url)),
      output,
      sourceJourney: true,
      preliminaryJourney: true,
      revision: "a".repeat(40),
    });
    assert.ok(fixture.preliminaryJourney);
    const text = await readFile(fixture.catalogPath, "utf8");
    const catalog: unknown = JSON.parse(text);
    assert.ok(sourceProfileLabel(catalog, fixture.preliminaryJourney.profile).length > 0);
    assert.equal(
      await readFile(fixture.catalogPath, "utf8"),
      text,
      "label lookup must not fill or rewrite defaults",
    );
    for (const malformed of [
      null,
      {},
      { source_catalog: { identities: null } },
      { source_catalog: { identities: [null] } },
      { source_catalog: { identities: [{ id: "owned", label: ["coercible"] }] } },
    ]) {
      assert.throws(() => sourceProfileLabel(malformed, "owned"));
    }
    assert.throws(() => sourceProfileLabel(catalog, "missing-profile"));
  } finally {
    await fixture?.close();
    assert.equal(path.dirname(output), tmpdir());
    await rm(output, { recursive: true, force: true });
  }
});
