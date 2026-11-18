import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "vite-plus/test";
import { portDefinition, installedLaunchStatus } from "../src/test-fixtures.ts";
import { mkdtemp, mkdir, readFile, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import type { OutputDesktopWorkspaceSnapshot } from "../src/transport-types.generated.d.ts";
import { transportValue } from "./transport-values.mts";
import {
  collectionArtworkScenario,
  finishCollectionArtworkObservation,
  selectCollectionInterfaceSize,
  collectionArtworkSubjects,
  collectionThumbnailIdentity,
  verifiedCollectionSurface,
} from "./desktop-collection-artwork-test.mts";

const directory = transportValue(
  "catalog_listings",
  JSON.parse(
    readFileSync(
      new URL("../../../crates/portcove-core/catalog/listings.json", import.meta.url),
      "utf8",
    ),
  ),
);
function snapshot(): OutputDesktopWorkspaceSnapshot {
  return {
    catalog: { schema_version: 1, ports: [], source_profiles: [] },
    listing_catalog: structuredClone(directory),
    statuses: [],
    sources: [],
    catalog_digest: "a".repeat(64),
    activities: {
      records: [],
      active_and_actionable_complete: true,
      attention_required_activity_ids: [],
      current_activity_ids: [],
      recovery_required_activity_ids: [],
      terminal_history_complete: true,
      terminal_history_count: 0,
      terminal_history_limit: 20,
    },
  };
}

test("collection observation selects actual listing members and refuses operational or changed inputs", () => {
  const state = snapshot();
  const targets = collectionArtworkSubjects(state);
  assert.deepEqual(
    targets.map((target) => target.members.length),
    [2, 4],
  );
  for (const change of [
    "missing",
    "membership",
    "duplicate",
    "managed",
    "installed",
    "digest",
  ] as const) {
    const value = snapshot();
    const listing = value.listing_catalog!.listings.find((entry) => entry.id === targets[0]!.id)!;
    if (change === "missing") value.listing_catalog!.listings = [];
    if (change === "membership") listing.collection_covers = [];
    if (change === "duplicate") listing.collection_covers![1] = listing.collection_covers![0]!;
    if (change === "managed")
      value.catalog!.ports = [{ ...transportValue("port", portDefinition()), id: listing.id }];
    if (change === "installed")
      value.statuses = [transportValue("status", installedLaunchStatus())];
    if (change === "digest") value.catalog_digest = null;
    assert.throws(() => collectionArtworkSubjects(value), Error, change);
  }
});

test("native collection failure survives receipt and restoration failures without starting thumbnail IPC", async () => {
  const output = await mkdtemp(path.join(os.tmpdir(), "collection-boundary-"));
  const primary = new Error("owned bootstrap failure");
  const restored: string[] = [];
  const commands: string[] = [];
  try {
    await mkdir(path.join(output, "native-collection-artwork-observations.json"));
    const browser = {
      executeScript: () =>
        Promise.resolve({
          width: 960,
          height: 640,
          device_pixel_ratio: 1,
          interface_size: "100",
          theme: "dark",
        }),
      manage: () => ({
        window: () => ({
          getRect: () => Promise.resolve({ x: 0, y: 0, width: 960, height: 640 }),
          setRect: () => {
            restored.push("window");
            throw new Error("owned restoration failure");
          },
        }),
      }),
    } as unknown as Parameters<typeof collectionArtworkScenario>[0]["browser"];
    await assert.rejects(
      collectionArtworkScenario({
        browser,
        output,
        artifacts: [],
        library: path.join(output, "library"),
        scenario: async (_id, action) => {
          await action();
        },
        invoke: (command) => {
          commands.push(command);
          return Promise.reject(primary);
        },
        setTheme: () => {
          restored.push("theme");
          return Promise.reject(new Error("owned theme restoration failure"));
        },
      }),
      (error: unknown) => error === primary,
    );
    assert.deepEqual(commands, ["get_bootstrap_status"]);
    assert.deepEqual(restored, ["window", "theme"]);
  } finally {
    await rm(output, { recursive: true, force: true });
  }
});

test("a cleanup-only failure is retained in the final collection report", async () => {
  const output = await mkdtemp(path.join(os.tmpdir(), "collection-cleanup-"));
  const failure = new Error("owned theme restoration failure");
  const order: string[] = [];
  try {
    const browser = {
      manage: () => ({
        window: () => ({
          getRect: () => Promise.resolve({ x: 0, y: 0, width: 960, height: 640 }),
          setRect: () => {
            order.push("window");
            return Promise.resolve();
          },
        }),
      }),
    } as unknown as Parameters<typeof collectionArtworkScenario>[0]["browser"];
    const result = await finishCollectionArtworkObservation(
      {
        browser,
        output,
        artifacts: [],
        setTheme: () => {
          order.push("theme");
          return Promise.reject(failure);
        },
      },
      {
        originalWindow: { x: 0, y: 0, width: 960, height: 640 },
        originalTheme: "dark",
        restoreSize: false,
        observations: [],
        failures: [],
      },
    );
    assert.equal(result, failure);
    assert.deepEqual(order, ["window", "theme"]);
    const report: unknown = JSON.parse(
      await readFile(path.join(output, "native-collection-artwork-observations.json"), "utf8"),
    );
    assert.ok(typeof report === "object" && report !== null && "failure" in report);
    assert.equal(report.failure, failure.message);
  } finally {
    await rm(output, { recursive: true, force: true });
  }
});

test("compact collection capture requires confirmed production zoom and changed native geometry", async () => {
  for (const nativeChanges of [true, false]) {
    const sizes = [100, 125, 150, 175, 200];
    let position = 0;
    let key = "";
    const keys: string[] = [];
    const actions = {
      keyDown: () => actions,
      sendKeys: (value: string) => {
        key = value;
        return actions;
      },
      keyUp: () => actions,
      perform: () => {
        keys.push(key);
        position = key === "0" ? 0 : position + 1;
        return Promise.resolve();
      },
    };
    const browser = {
      actions: () => actions,
      executeScript: () =>
        Promise.resolve({
          width: nativeChanges ? (960 * 100) / sizes[position]! : 960,
          height: nativeChanges ? (640 * 100) / sizes[position]! : 640,
          device_pixel_ratio: sizes[position]! / 100,
          interface_size: String(sizes[position]),
          theme: "dark",
        }),
      wait: async (condition: () => Promise<boolean>) => {
        assert.equal(await condition(), true, "Native geometry must confirm the preference");
      },
    } as unknown as Parameters<typeof collectionArtworkScenario>[0]["browser"];
    if (nativeChanges) {
      const result = await selectCollectionInterfaceSize(browser, 200);
      assert.equal(result.applied.width, 480);
      assert.equal(result.applied.height, 320);
      assert.equal(result.applied.interface_size, "200");
      assert.deepEqual(keys, ["0", "+", "+", "+", "+"]);
    } else {
      await assert.rejects(
        selectCollectionInterfaceSize(browser, 200),
        /Native geometry must confirm/u,
      );
    }
  }
});

const png = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=",
  "base64",
);
const sha = "b".repeat(64);
const reply = { asset_sha256: sha, choice_revision: 7, png_base64: png.toString("base64") };
test("native collection preview refuses wrong identity, revision, malformed encoding and non-PNG bytes", () => {
  const identity = collectionThumbnailIdentity(reply, sha, 7);
  assert.equal(identity.member_sha256, sha);
  assert.equal(identity.bytes, png.length);
  for (const value of [
    null,
    { ...reply, asset_sha256: "c".repeat(64) },
    { ...reply, choice_revision: 6 },
    { ...reply, png_base64: "!bad" },
    { ...reply, png_base64: Buffer.from("not a PNG").toString("base64") },
  ])
    assert.throws(() => collectionThumbnailIdentity(value, sha, 7));
});

test("collection geometry refuses cropped, foreign and duplicate images while retaining honest fallback", () => {
  const identity = collectionThumbnailIdentity(reply, sha, 7);
  const surface = {
    source: "igdb_cover_collection",
    layout: "single-or-fallback",
    rect: { x: 10, y: 20, width: 200, height: 300 },
    images: [
      {
        src: `data:image/png;base64,${reply.png_base64}`,
        complete: true,
        natural_width: 1,
        natural_height: 1,
        object_fit: "contain",
        rect: { x: 20, y: 30, width: 100, height: 150 },
      },
    ],
    viewport: { width: 960, height: 640 },
    scroll_width: 960,
    client_width: 960,
    theme: "dark",
  };
  assert.equal(verifiedCollectionSurface(surface, [identity]).images[0]!.member_sha256, sha);
  const fallback = verifiedCollectionSurface(
    { ...surface, source: "generated_fallback", images: [] },
    [],
  );
  assert.equal(
    fallback.images.length,
    0,
    "A fallback observation must not invent successful members",
  );
  assert.throws(() => verifiedCollectionSurface(surface, []));
  assert.throws(() =>
    verifiedCollectionSurface({ ...surface, images: [...surface.images, ...surface.images] }, [
      identity,
    ]),
  );
  assert.throws(() =>
    verifiedCollectionSurface(
      { ...surface, images: [{ ...surface.images[0]!, object_fit: "cover" }] },
      [identity],
    ),
  );
  assert.throws(() =>
    verifiedCollectionSurface(
      {
        ...surface,
        images: [{ ...surface.images[0]!, rect: { ...surface.images[0]!.rect, x: -20 } }],
      },
      [identity],
    ),
  );
  assert.throws(() => verifiedCollectionSurface({ ...surface, scroll_width: 1000 }, [identity]));
});
