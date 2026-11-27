import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { test } from "vite-plus/test";
import {
  captureGameFirstTarget,
  readGameFirstRelationships,
  readGameFirstSourcePopulation,
  inspectGameFirstRelationships,
  gameFirstPresentationFamilies,
  observeGameFirstCaptureReadiness,
  readGameFirstObservation,
  readGameFirstCatalogProvenance,
  readGameFirstCatalogObservation,
} from "./desktop-game-first-test.mts";
import { failureReport, portStatus, installedLaunchStatus } from "../src/test-fixtures.ts";
import { transportValue } from "./transport-values.mts";
import { isRecord } from "../../../scripts/runtime-values.mts";
import { fileIdentity } from "../../../scripts/development-evidence.mts";
import type {
  GameFirstObservedDefinition,
  GameFirstObservedListing,
} from "./desktop-game-first-test.mts";
import type { ScenarioInvoke } from "./desktop-scenario-context.mts";
import type {
  PortStatus,
  OutputDesktopBootstrapStatus,
  OutputDesktopLibraryOrganization,
  OutputDesktopWorkspaceSnapshot,
  ListingDeliveryStatus,
} from "../src/transport-types.generated.d.ts";

const bootstrap: OutputDesktopBootstrapStatus = {
  ready: true,
  generation: 7,
  library_root: "E:/owned-fixture/library",
  error: null,
  selection: null,
};
const organization: OutputDesktopLibraryOrganization = {
  revision: 0,
  collections: {},
  followed_port_ids: [],
  followed_release_acknowledgments: {},
  hidden_port_ids: [],
  saved_game_ids: [],
  setup_confirmations: [],
  update_notices: {},
};
const statuses = ["2ship2harkinian", "zelda64-recomp"].map((port_id) => ({
  ...transportValue("status", portStatus()),
  port_id,
}));
const workspace: OutputDesktopWorkspaceSnapshot = {
  catalog: { schema_version: 1, ports: [] },
  sources: [],
  statuses,
  activities: {
    records: [],
    active_and_actionable_complete: true,
    attention_required_activity_ids: [],
    current_activity_ids: [],
    recovery_required_activity_ids: [],
    terminal_history_complete: true,
    terminal_history_count: 0,
    terminal_history_limit: 50,
  },
};
const success = (value: unknown) => ({ ok: true, value });
function refusal() {
  return {
    ok: false,
    error: {
      ...transportValue("desktop_desktop_error", failureReport()),
      code: "conflict",
      message: "private-message-not-for-readbacks",
      details: {
        workspace_snapshot_stale: "true",
        retryable: "true",
        private_path: "private-path",
      },
    },
  };
}

function reads(
  snapshots: unknown[],
  bootstraps: OutputDesktopBootstrapStatus[] = [],
  statusReply: unknown = success(statuses),
) {
  const calls: { command: string; args: Record<string, unknown> | undefined }[] = [];
  let bootstrapReads = 0;
  let organizationReads = 0;
  let snapshotReads = 0;
  const invoke: ScenarioInvoke = async (command, args) => {
    calls.push({ command, args });
    switch (command) {
      case "get_bootstrap_status":
        return success(bootstraps[bootstrapReads++] ?? bootstrap);
      case "get_library_organization":
        return success({ ...organization, revision: ++organizationReads });
      case "get_workspace_snapshot":
        return snapshots[snapshotReads++];
      case "get_statuses":
        return statusReply;
      default:
        return assert.fail(`Observation must not invoke a mutation or UI action: ${command}`);
    }
  };
  return { invoke, calls };
}
// The 4783 local run exhausted Vitest's 5 s limit in these three fixture/module
// cases. Allow a finite 60 s under contended filesystem/module scheduling;
// assertions, refusal retries, cleanup and all application deadlines are unchanged.
const gameFirstFixtureBudgetMs = 60_000;

const attemptCommands = [
  "get_bootstrap_status",
  "get_library_organization",
  "get_workspace_snapshot",
  "get_statuses",
  "get_bootstrap_status",
];

test("catalog provenance reads both actual definition and independently selected listing statuses", async () => {
  const catalog = {
    provenance: {
      origin: "embedded",
      catalog_sha256: "a".repeat(64),
      expires_at: null,
      fallback_reasons: [],
      key_id: null,
      sequence: null,
    },
    trusted_keys: [],
    highest_sequence: 0,
    updates_enabled: false,
    can_rollback: false,
    can_use_cached: false,
    state_sha256: "b".repeat(64),
  };
  const listing = {
    delivery_schema: 1,
    revision: 17,
    selected: true,
    anchor_sha256: "c".repeat(64),
    repository_root_sha256: "d".repeat(64),
    target_sha256: "e".repeat(64),
    expires_at: "2026-12-01T00:00:00Z",
    listing_count: 1500,
    withdrawn_ids: ["withdrawn-fixture-project"],
    fallback_reason: null,
  };
  const calls: string[] = [];
  const invoke: ScenarioInvoke = async (command) => {
    calls.push(command);
    if (command === "get_catalog_status") return success(catalog);
    assert.equal(command, "get_listing_delivery_status");
    return success(listing);
  };
  const observed = await readGameFirstCatalogProvenance(invoke);
  assert.deepEqual(calls, ["get_catalog_status", "get_listing_delivery_status"]);
  assert.equal(observed.catalog_status, catalog);
  assert.equal(observed.listing_delivery_status, listing);
  assert.equal(observed.catalog_status.provenance.origin, "embedded");
  assert.equal(observed.listing_delivery_status.selected, true);
  for (const reply of [
    undefined,
    refusal(),
    { ok: true },
    success(null),
    success({}),
    success({ ...listing, selected: "true" }),
  ]) {
    const attempts: string[] = [];
    await assert.rejects(() =>
      readGameFirstCatalogProvenance(async (command) => {
        attempts.push(command);
        if (command === "get_catalog_status") return success(catalog);
        assert.equal(command, "get_listing_delivery_status");
        return reply;
      }),
    );
    assert.deepEqual(attempts, ["get_catalog_status", "get_listing_delivery_status"]);
  }
});

function catalogWitnessFixture() {
  const catalog = {
    provenance: {
      origin: "embedded",
      catalog_sha256: "a".repeat(64),
      expires_at: null,
      fallback_reasons: [],
      key_id: null,
      sequence: null,
    },
    trusted_keys: [],
    highest_sequence: 0,
    updates_enabled: false,
    can_rollback: false,
    can_use_cached: false,
    state_sha256: "b".repeat(64),
  };
  const listing: ListingDeliveryStatus = {
    delivery_schema: 1,
    revision: 17,
    selected: true,
    anchor_sha256: "c".repeat(64),
    repository_root_sha256: "d".repeat(64),
    target_sha256: "e".repeat(64),
    expires_at: "2026-12-01T00:00:00Z",
    listing_count: 1500,
    withdrawn_ids: [],
    fallback_reason: null,
  };
  const catalogs: [typeof catalog, typeof catalog] = [catalog, structuredClone(catalog)];
  const listings: [ListingDeliveryStatus, ListingDeliveryStatus] = [
    listing,
    structuredClone(listing),
  ];
  const bootstraps: [
    OutputDesktopBootstrapStatus,
    OutputDesktopBootstrapStatus,
    OutputDesktopBootstrapStatus,
    OutputDesktopBootstrapStatus,
  ] = [{ ...bootstrap }, { ...bootstrap }, { ...bootstrap }, { ...bootstrap }];
  const snapshot = { ...workspace, catalog_digest: "f".repeat(64) };
  const fixture = reads([success(snapshot)], bootstraps);
  const calls: string[] = [];
  let catalogReads = 0;
  let listingReads = 0;
  const invoke: ScenarioInvoke = async (command, args) => {
    calls.push(command);
    if (command === "get_catalog_status") return success(catalogs[catalogReads++]);
    if (command === "get_listing_delivery_status") return success(listings[listingReads++]);
    return fixture.invoke(command, args);
  };
  return { invoke, calls, catalogs, listings, bootstraps, snapshot };
}

test("live catalog readback binds selected or embedded data without requiring a network update", async () => {
  for (const selected of [false, true]) {
    const fixture = catalogWitnessFixture();
    for (const listing of fixture.listings) {
      listing.selected = selected;
      if (!selected) {
        listing.revision = null;
        listing.target_sha256 = null;
        listing.listing_count = 0;
      }
    }
    const readbacks: unknown[] = [];
    const observed = await readGameFirstCatalogObservation(fixture.invoke, readbacks);
    assert.equal(observed.catalog_digest, fixture.snapshot.catalog_digest);
    assert.equal(observed.listing_delivery_status.selected, selected);
    assert.equal(observed.listing_delivery_status.target_sha256, selected ? "e".repeat(64) : null);
    assert.equal(observed.bootstrap.library_root, bootstrap.library_root);
    const bracket = readbacks.find(
      (value) => isRecord(value) && value.phase === "catalog-provenance-bracket",
    );
    assert.ok(isRecord(bracket));
    assert.equal(bracket.coherent, true);
    assert.deepEqual(bracket.snapshot, {
      generation: bootstrap.generation,
      library_root: bootstrap.library_root,
      catalog_digest: fixture.snapshot.catalog_digest,
    });
    assert.ok(fixture.calls.every((command) => command.startsWith("get_")));
  }
});

test("a refused live catalog bracket retains both observed target identities", async () => {
  const fixture = catalogWitnessFixture();
  fixture.listings[1].target_sha256 = "0".repeat(64);
  const readbacks: unknown[] = [];
  await assert.rejects(() => readGameFirstCatalogObservation(fixture.invoke, readbacks));
  const bracket = readbacks.find(
    (value) => isRecord(value) && value.phase === "catalog-provenance-bracket",
  );
  assert.ok(isRecord(bracket));
  assert.equal(bracket.coherent, false);
  assert.ok(isRecord(bracket.before) && isRecord(bracket.after));
  assert.ok(isRecord(bracket.before.listing_delivery_status));
  assert.ok(isRecord(bracket.after.listing_delivery_status));
  assert.equal(bracket.before.listing_delivery_status.target_sha256, "e".repeat(64));
  assert.equal(bracket.after.listing_delivery_status.target_sha256, "0".repeat(64));
});

test("live catalog readback refuses changed selection, library scope or a missing digest", async () => {
  const mutations = [
    (fixture: ReturnType<typeof catalogWitnessFixture>) => {
      fixture.listings[1].target_sha256 = "0".repeat(64);
    },
    (fixture: ReturnType<typeof catalogWitnessFixture>) => {
      fixture.catalogs[1].provenance.catalog_sha256 = "0".repeat(64);
    },
    (fixture: ReturnType<typeof catalogWitnessFixture>) => {
      fixture.bootstraps[1].generation++;
    },
    (fixture: ReturnType<typeof catalogWitnessFixture>) => {
      fixture.bootstraps[3].library_root = "E:/other-library";
    },
    (fixture: ReturnType<typeof catalogWitnessFixture>) => {
      fixture.snapshot.catalog_digest = "";
    },
  ];
  for (const mutate of mutations) {
    const fixture = catalogWitnessFixture();
    mutate(fixture);
    await assert.rejects(() => readGameFirstCatalogObservation(fixture.invoke, []));
    assert.ok(fixture.calls.every((command) => command.startsWith("get_")));
  }
});

test(
  "a stale workspace refusal retries the full read and returns fresh organization/status joins",
  async () => {
    const fixture = reads([refusal(), success(workspace)]);
    const readbacks: unknown[] = [];
    const result = await readGameFirstObservation(fixture.invoke, readbacks);
    assert.equal(
      result.organization.revision,
      2,
      "Do not reuse the refused attempt's organization",
    );
    assert.deepEqual(result.statuses, workspace.statuses);
    assert.deepEqual(
      fixture.calls.map((call) => call.command),
      [...attemptCommands, ...attemptCommands],
    );
    for (const call of fixture.calls)
      assert.deepEqual(
        call.args,
        ["get_library_organization", "get_workspace_snapshot"].includes(call.command)
          ? { generation: 7 }
          : undefined,
      );
    assert.deepEqual(readbacks, [
      {
        phase: "workspace-snapshot-refusal",
        attempt: 1,
        generation: 7,
        code: "conflict",
        workspace_snapshot_stale: "true",
        retryable: "true",
      },
    ]);
    assert.ok(!JSON.stringify(readbacks).includes("private-"));
  },
  gameFirstFixtureBudgetMs,
);

test("a confirmed write between independent workspace and status reads repeats the full observation", async () => {
  const changed = statuses.map((row) => ({ ...row, successful_launches: 1 }));
  const updated = { ...workspace, statuses: changed };
  const fixture = reads(
    [success(workspace), success(updated), success(updated)],
    [],
    success(changed),
  );
  const readbacks: unknown[] = [];
  const value = await readGameFirstObservation(fixture.invoke, readbacks);
  assert.equal(
    value.organization.revision,
    2,
    "Repeat organization too; do not return a mixed observation",
  );
  assert.deepEqual(value.statuses, changed);
  assert.deepEqual(value.workspace.statuses, changed);
  assert.deepEqual(
    fixture.calls.map((call) => call.command),
    [...attemptCommands, "get_workspace_snapshot", "get_bootstrap_status", ...attemptCommands],
  );
  assert.deepEqual(readbacks, [
    {
      phase: "workspace-observation-transition",
      attempt: 1,
      generation: 7,
      port_ids: ["2ship2harkinian", "zelda64-recomp"],
    },
  ]);
});

test("sustained explicit workspace refusals remain fatal after exactly three full observations", async () => {
  const fixture = reads([refusal(), refusal(), refusal(), success(workspace)]);
  const readbacks: unknown[] = [];
  await assert.rejects(
    readGameFirstObservation(fixture.invoke, readbacks),
    /did not settle after 3 full read observations/u,
  );
  assert.deepEqual(
    fixture.calls.map((call) => call.command),
    Array.from({ length: 3 }, () => attemptCommands).flat(),
  );
  assert.deepEqual(
    readbacks.map((row) => (row as { attempt: number }).attempt),
    [1, 2, 3],
  );
  assert.ok(!JSON.stringify(readbacks).includes("private-"));
});

test("unrelated conflicts, malformed flags and invalid reply shapes never retry", async () => {
  const rejected = refusal();
  for (const snapshot of [
    { ...rejected, error: { ...rejected.error, code: "state" } },
    { ...rejected, error: { ...rejected.error, details: { retryable: "true" } } },
    {
      ...rejected,
      error: {
        ...rejected.error,
        details: { workspace_snapshot_stale: "true", retryable: "false" },
      },
    },
    {
      ...rejected,
      error: { ...rejected.error, details: { workspace_snapshot_stale: true, retryable: "true" } },
    },
    {
      ...rejected,
      error: { ...rejected.error, details: { workspace_snapshot_stale: "true", retryable: true } },
    },
    { ...rejected, error: { code: "conflict", details: rejected.error.details } },
    { ...rejected, ok: "false" },
    { ok: false, error: "invalid" },
    success({}),
  ]) {
    const fixture = reads([snapshot, success(workspace)]);
    const readbacks: unknown[] = [];
    await assert.rejects(readGameFirstObservation(fixture.invoke, readbacks));
    assert.deepEqual(
      fixture.calls.map((call) => call.command),
      attemptCommands.slice(0, 3),
    );
    assert.deepEqual(readbacks, []);
  }
});

test("generation and root changes fail both at the refusal boundary and before a retry", async () => {
  for (const changed of [
    { ...bootstrap, generation: 8 },
    { ...bootstrap, library_root: "E:/other-library" },
  ]) {
    for (const atRetryStart of [false, true]) {
      const fixture = reads(
        [refusal(), success(workspace)],
        atRetryStart ? [bootstrap, bootstrap, changed] : [bootstrap, changed],
      );
      const readbacks: unknown[] = [];
      await assert.rejects(readGameFirstObservation(fixture.invoke, readbacks));
      assert.deepEqual(
        fixture.calls.map((call) => call.command),
        atRetryStart ? [...attemptCommands, "get_bootstrap_status"] : attemptCommands,
      );
      assert.equal(readbacks.length, 1);
      assert.equal((readbacks[0] as { generation: number }).generation, 7);
    }
  }
});

test("status schema failures and stable workspace/status disagreement remain fatal without retries", async () => {
  for (const [reply, snapshots, expectedReads] of [
    [success([{}]), [success(workspace)], 1],
    [
      success(statuses.map((row) => ({ ...row, successful_launches: 1 }))),
      [success(workspace), success(workspace)],
      2,
    ],
  ] as const) {
    const fixture = reads([...snapshots], [], reply);
    const readbacks: unknown[] = [];
    await assert.rejects(readGameFirstObservation(fixture.invoke, readbacks));
    assert.equal(
      fixture.calls.filter((call) => call.command === "get_workspace_snapshot").length,
      expectedReads,
    );
    assert.equal(
      fixture.calls.filter((call) => call.command === "get_library_organization").length,
      1,
    );
    assert.deepEqual(readbacks, []);
  }
});

test("confirmed read transitions are bounded and cannot cross a library generation or root", async () => {
  const changed = statuses.map((row) => ({ ...row, successful_launches: 1 }));
  const updated = { ...workspace, statuses: changed };
  const fixture = reads(
    Array.from({ length: 3 }, () => [success(workspace), success(updated)]).flat(),
    [],
    success(changed),
  );
  const readbacks: unknown[] = [];
  await assert.rejects(
    readGameFirstObservation(fixture.invoke, readbacks),
    /did not settle after 3 full read observations/u,
  );
  assert.equal(
    fixture.calls.filter((call) => call.command === "get_library_organization").length,
    3,
  );
  assert.equal(readbacks.length, 3);
  for (const identity of [
    { ...bootstrap, generation: 8 },
    { ...bootstrap, library_root: "E:/other-library" },
  ]) {
    const moved = reads(
      [success(workspace), success(updated)],
      [bootstrap, bootstrap, identity],
      success(changed),
    );
    await assert.rejects(readGameFirstObservation(moved.invoke, []));
    assert.equal(
      moved.calls.filter((call) => call.command === "get_library_organization").length,
      1,
    );
  }
});

test("confirmation failures preserve strict explicit-refusal flags and never turn malformed reads into retries", async () => {
  const changed = statuses.map((row) => ({ ...row, successful_launches: 1 }));
  for (const bad of [
    success({}),
    { ...refusal(), error: { ...refusal().error, code: "state" } },
    {
      ...refusal(),
      error: { ...refusal().error, details: { workspace_snapshot_stale: true, retryable: "true" } },
    },
  ]) {
    const fixture = reads([success(workspace), bad], [], success(changed));
    const readbacks: unknown[] = [];
    await assert.rejects(readGameFirstObservation(fixture.invoke, readbacks));
    assert.equal(
      fixture.calls.filter((call) => call.command === "get_library_organization").length,
      1,
    );
    assert.deepEqual(readbacks, []);
  }
  const updated = { ...workspace, statuses: changed };
  const fixture = reads([success(workspace), refusal(), success(updated)], [], success(changed));
  const readbacks: unknown[] = [];
  assert.deepEqual((await readGameFirstObservation(fixture.invoke, readbacks)).statuses, changed);
  assert.equal(
    fixture.calls.filter((call) => call.command === "get_library_organization").length,
    2,
  );
  assert.equal(readbacks.length, 1);
});

test("game-first capture settles later complete geometry and still refuses movement during the screenshot", async () => {
  const { mkdtemp, readFile, rm } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const path = await import("node:path");
  const { observeCollectionLayoutReady, observeVisibleTarget } =
    await import("./browser-readiness.mts");
  type Driver = import("selenium-webdriver").WebDriver;
  type ElementHandle = import("selenium-webdriver").WebElement;
  const output = await mkdtemp(path.join(tmpdir(), "pcv-game-first-capture-"));
  try {
    for (const moveDuringScreenshot of [false, true]) {
      let observations = 0,
        screenshots = 0;
      const element = {} as ElementHandle;
      let layoutObserved = false;
      const browser = {
        findElements: async () => {
          assert.equal(layoutObserved, true, "Resolve the current target after layout readiness");
          return [element];
        },
        executeScript: async (script: unknown, ...args: unknown[]) => {
          if (script === observeCollectionLayoutReady) {
            layoutObserved = true;
            return true;
          }
          if (script !== observeVisibleTarget) {
            assert.equal(args[0], element, "Only the explicit preflight scroll is permitted");
            return;
          }
          const index = observations++;
          return {
            target: "#choice",
            target_count: 1,
            visible: true,
            clipping: [],
            rect: {
              x: 20,
              y: index < 2 ? 100 : screenshots && moveDuringScreenshot ? 140 : 120,
              width: 100,
              height: 40,
            },
            viewport: { width: 1280, height: 900, device_pixel_ratio: 1 },
            application_state: { document_ready: "complete", loading: 0 },
          };
        },
        takeScreenshot: async () => {
          assert.ok(
            observations >= 4,
            "Wait for two matching observations after the preflight geometry changed",
          );
          screenshots++;
          return Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).toString("base64");
        },
      } as unknown as Driver;
      const name = moveDuringScreenshot ? "changed" : "settled";
      const capture = captureGameFirstTarget({
        browser,
        output,
        name,
        scenario: "owned-game-first",
        target: "#choice",
        readiness: async () => ({ ready: true }),
      });
      if (moveDuringScreenshot) {
        await assert.rejects(capture, /Application state changed during capture/);
        await assert.rejects(readFile(path.join(output, name + "-capture.json")), {
          code: "ENOENT",
        });
        const failure: unknown = JSON.parse(
          await readFile(path.join(output, name + "-capture-failure.json"), "utf8"),
        );
        assert.ok(isRecord(failure));
        assert.equal(failure.acceptance, false);
      } else {
        const result = await capture;
        assert.equal(result.observation.state.rect?.y, 120);
        assert.equal(result.outcome, "captured");
      }
      assert.equal(screenshots, 1);
    }
  } finally {
    await rm(output, { recursive: true, force: true });
  }
});

test("game-first capture retains the rejected preflight target without taking a screenshot", async () => {
  const path = await import("node:path");
  type WebDriver = import("selenium-webdriver").WebDriver;
  type WebElement = import("selenium-webdriver").WebElement;
  const { mkdtemp, rm } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const output = await mkdtemp(path.join(tmpdir(), "pcv-game-first-rejected-capture-"));
  const observed = {
    target: "#choice",
    target_count: 1,
    visible: false,
    clipping: [{ element: "DIV.scroll-owner", axis: "y", edge: 240, limit: 200 }],
    rect: { x: 20, y: 180, width: 100, height: 60 },
    viewport: { width: 480, height: 320, device_pixel_ratio: 2 },
  };
  let screenshots = 0;
  const browser = {
    findElements: async () => [{} as WebElement],
    executeScript: async (script: unknown) => {
      const { observeCollectionLayoutReady, observeVisibleTarget } =
        await import("./browser-readiness.mts");
      if (script === observeCollectionLayoutReady) return true;
      return script === observeVisibleTarget ? observed : undefined;
    },
    takeScreenshot: async () => {
      screenshots++;
      return "";
    },
  } as unknown as WebDriver;
  try {
    await assert.rejects(
      captureGameFirstTarget({
        browser,
        output,
        name: "rejected",
        scenario: "owned-game-first",
        target: "#choice",
        readiness: async () => ({ ready: true }),
      }),
      /Capture requires one identified visible target/,
    );
    const failure: unknown = JSON.parse(
      await readFile(path.join(output, "rejected-capture-failure.json"), "utf8"),
    );
    assert.ok(isRecord(failure));
    assert.equal(failure.acceptance, false);
    assert.equal(failure.phase, "target-preflight");
    assert.deepEqual(failure.observation, observed);
    assert.equal(screenshots, 0);
  } finally {
    await rm(output, { recursive: true, force: true });
  }
});

test("capture waits for the layout owner before one reveal and refuses an unsettled owner", async () => {
  const { prepareCaptureTarget } = await import("../test/capture-target.ts");
  let pending = true,
    settles = 0,
    scrolls = 0;
  const state = {
    target: "#choice",
    target_count: 1,
    visible: true,
    rect: { x: 20, y: 100, width: 100, height: 40 },
    viewport: { width: 480, height: 320 },
  };
  await prepareCaptureTarget({
    target: "#choice",
    label: "responsive-choice",
    ready: () => !pending,
    settle: async () => {
      if (++settles === 2) pending = false;
    },
    scroll: () => {
      assert.equal(pending, false);
      scrolls++;
    },
    observe: () => state,
  });
  assert.equal(scrolls, 1);
  await assert.rejects(
    prepareCaptureTarget({
      target: "#choice",
      label: "unfinished-choice",
      ready: () => false,
      settle: async () => {},
      scroll: () => {
        scrolls++;
      },
      observe: () => state,
    }),
    /Capture layout did not settle within 20 samples/,
  );
  assert.equal(scrolls, 1, "Never reveal or capture while the owner remains unsettled");
});

test("capture waits for pending optional comparison but permits its failed result", async () => {
  const { runInNewContext } = await import("node:vm");
  let pending = false;
  const alerts = [{ textContent: "Optional comparison is unavailable." }];
  const document = {
    fonts: { status: "loaded" },
    body: { textContent: "Interface size 100%." },
    documentElement: { scrollWidth: 1280, clientWidth: 1280 },
    querySelectorAll: (selector: string) => {
      if (selector === '[role="alert"]') return alerts;
      assert.equal(selector, ".comparison-context-heading button:disabled");
      return pending ? [{}] : [];
    },
  };
  const observe = () => {
    const result: unknown = runInNewContext(
      `(${observeGameFirstCaptureReadiness.toString()})(100)`,
      {
        document,
        innerWidth: 1280,
        innerHeight: 900,
        devicePixelRatio: 1,
      },
    );
    assert.ok(isRecord(result));
    return result;
  };
  assert.equal(observe().ready, true);
  pending = true;
  assert.equal(
    observe().ready,
    false,
    "Pending optional rows must settle before the one candidate image",
  );
  pending = false;
  const failed = observe();
  assert.equal(
    failed.ready,
    true,
    "An unavailable comparison must not block capture or ordinary choice",
  );
  assert.deepEqual(Array.from(failed.alerts as unknown[]), ["Optional comparison is unavailable."]);
});

test(
  "retained runtime inventory selects before reading executable content and preserves data guards",
  async () => {
    const { userDataInventory } = await import("./desktop-game-first-installed-test.mts");
    const { mkdtemp, mkdir, writeFile, open, rm, symlink } = await import("node:fs/promises");
    const { tmpdir } = await import("node:os");
    const path = await import("node:path");
    const root = await mkdtemp(path.join(tmpdir(), "pcv-retained-selection-"));
    try {
      await mkdir(path.join(root, "assets"));
      await writeFile(path.join(root, "assets", "save.bin"), "inert retained bytes");
      const executable = await open(path.join(root, "tmc_pc.exe"), "wx");
      await executable.truncate(64 * 1024 ** 2 + 1);
      await executable.close();
      await assert.rejects(userDataInventory(root));
      const selected = await userDataInventory(root, ["assets"]);
      assert.equal(selected.length, 1);
      assert.equal(selected[0]?.name, path.join("assets", "save.bin"));
      assert.equal(selected[0]?.bytes, Buffer.byteLength("inert retained bytes"));
      for (const names of [
        [],
        ["missing"],
        ["assets", "assets"],
        ["../assets"],
        ["assets/save.bin"],
      ])
        await assert.rejects(userDataInventory(root, names));
      const tooLarge = await open(path.join(root, "assets", "large.dat"), "wx");
      await tooLarge.truncate(64 * 1024 ** 2 + 1);
      await tooLarge.close();
      await assert.rejects(userDataInventory(root, ["assets"]));
      await rm(path.join(root, "assets", "large.dat"));
      // Windows junctions exercise the same no-follow guard without requiring
      // the host privilege needed to create a file symlink.
      const linkTarget = path.join(
        root,
        process.platform === "win32" ? "linked-target" : "tmc_pc.exe",
      );
      if (process.platform === "win32") await mkdir(linkTarget);
      await symlink(
        linkTarget,
        path.join(root, "assets", "linked.dat"),
        process.platform === "win32" ? "junction" : "file",
      );
      await assert.rejects(userDataInventory(root, ["assets"]));
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
  gameFirstFixtureBudgetMs,
);

test(
  "installation source reuse permits only forward verification-time refresh",
  async () => {
    const { requireReusedSource } = await import("./desktop-game-first-installed-mm-test.mts");
    const source = {
      profile_id: "majoras-mask",
      path: "E:/owned/majoras-mask.z64",
      sha256: "a".repeat(64),
      size: 33554432,
      storage_sha256: "a".repeat(64),
      storage_size: 33554432,
      updated_at: 100,
      observed_identity: null,
      future_identity: { value: "preserved" },
    };
    assert.deepEqual(requireReusedSource([source], source), source);
    const refreshed = { ...source, updated_at: 101 };
    assert.deepEqual(requireReusedSource([refreshed], source), refreshed);
    for (const change of [
      { path: "E:/other/majoras-mask.z64" },
      { profile_id: "other-profile" },
      { sha256: "b".repeat(64) },
      { size: 1 },
      { storage_sha256: "b".repeat(64) },
      { storage_size: 1 },
      { observed_identity: { schema_version: 1, digests: [] } },
      { future_identity: { value: "changed" } },
      { updated_at: 99 },
      { updated_at: Number.NaN },
      { updated_at: Infinity },
      { updated_at: 100.5 },
    ])
      assert.throws(() => requireReusedSource([{ ...source, ...change }], source));
    assert.throws(() => requireReusedSource([], source));
    assert.throws(() => requireReusedSource([source, source], source));
    assert.throws(
      () => requireReusedSource([source], refreshed),
      "A later integration must not move observation time backwards",
    );
  },
  gameFirstFixtureBudgetMs,
);

test("normal installed launch captions retain Core permission and unknown compatibility", async () => {
  const { requireDirectLaunchLabel } = await import("./desktop-game-first-installed-mm-test.mts");
  const readiness = {
    launchable: true,
    pending_setup: false,
    blockers: [],
    source: "not_checked",
  } as const;
  const installed = transportValue("status", installedLaunchStatus({ ...readiness, blockers: [] }));
  const launchAction = { action: "launch", availability: "allowed", reason: "available" } as const;
  const status: PortStatus = { ...installed, port_actions: [launchAction] };
  assert.ok(status.active);
  const active = status.active;
  for (const label of ["Play", "Try launch"])
    assert.equal(requireDirectLaunchLabel(label, status), label);
  for (const label of ["", "Use Zelda64", "Review launch", "Start setup", "Continue playing"])
    assert.throws(() => requireDirectLaunchLabel(label, status));
  for (const refused of [
    { ...status, active: null },
    { ...status, active: { ...active, port_id: "wrong-port" } },
    { ...status, readiness: { ...readiness, blockers: [], launchable: false } },
    { ...status, readiness: { ...readiness, blockers: [], pending_setup: true } },
    { ...status, readiness: { ...readiness, blockers: ["missing_source"] } },
    { ...status, port_actions: [] },
    {
      ...status,
      port_actions: [{ action: "launch", availability: "held", reason: "assessment_incomplete" }],
    },
    { ...status, port_actions: [launchAction, launchAction] },
  ] satisfies PortStatus[])
    assert.throws(() => requireDirectLaunchLabel("Try launch", refused));
});

/** Generated authored inputs omit serde defaults. Validate only this oracle's
 * consumed fields; these test projections are deliberately not runtime IPC DTOs. */
function authoredIdentity(value: unknown) {
  if (value === undefined || value === null) return value;
  assert.ok(isRecord(value) && typeof value.id === "string");
  return { ...value, id: value.id };
}
function authoredTitle(value: unknown) {
  assert.ok(value === undefined || value === null || typeof value === "string");
  return value;
}
function authoredListing(value: unknown): GameFirstObservedListing {
  assert.ok(isRecord(value) && typeof value.id === "string" && typeof value.name === "string");
  const identity = authoredIdentity(value.original_game);
  const title = authoredTitle(value.original_game_title);
  return {
    id: value.id,
    name: value.name,
    ...(identity !== undefined ? { original_game: identity } : {}),
    ...(title !== undefined ? { original_game_title: title } : {}),
  };
}
function authoredDefinition(value: unknown): GameFirstObservedDefinition {
  assert.ok(isRecord(value) && typeof value.id === "string" && typeof value.name === "string");
  assert.ok(
    value.source_profile === undefined ||
      value.source_profile === null ||
      typeof value.source_profile === "string",
  );
  assert.ok(isRecord(value.release), "Authored operational release object must be retained intact");
  const presentation = value.presentation;
  assert.ok(presentation === undefined || presentation === null || isRecord(presentation));
  const identity = authoredIdentity(presentation?.original_game);
  const title = authoredTitle(presentation?.original_game_title);
  return {
    id: value.id,
    name: value.name,
    release: value.release,
    ...(value.source_profile !== undefined ? { source_profile: value.source_profile } : {}),
    ...(presentation !== undefined
      ? {
          presentation:
            presentation === null
              ? null
              : {
                  ...(identity !== undefined ? { original_game: identity } : {}),
                  ...(title !== undefined ? { original_game_title: title } : {}),
                },
        }
      : {}),
  };
}
async function productionWorkspace(fullCatalog = false) {
  const catalog: unknown = JSON.parse(
    await readFile(
      new URL("../../../crates/portcove-core/catalog/catalog.json", import.meta.url),
      "utf8",
    ),
  );
  const listings: unknown = JSON.parse(
    await readFile(
      new URL("../../../crates/portcove-core/catalog/listings.json", import.meta.url),
      "utf8",
    ),
  );
  assert.ok(isRecord(catalog) && Array.isArray(catalog.ports));
  assert.ok(isRecord(listings) && Array.isArray(listings.listings));
  const ports: unknown[] = catalog.ports;
  const directory: unknown[] = listings.listings;
  // This native-verifier fixture exercises its exact reviewed audit cohort.
  // Current-catalog browser projection has a separate full-universe assertion.
  const { expected } = await readGameFirstRelationships();
  const audited = new Set(expected.audited_port_ids);
  return {
    catalog: {
      ports: ports.map(authoredDefinition).filter(({ id }) => fullCatalog || audited.has(id)),
    },
    listing_catalog: {
      listings: directory.map(authoredListing).filter(({ id }) => fullCatalog || audited.has(id)),
    },
  };
}

test("native package qualification binds newly admitted identities to the complete source population", async () => {
  const { expected } = await readGameFirstRelationships();
  const actual = await productionWorkspace(true);
  const inputs = await Promise.all(
    ["catalog.json", "listings.json"].map((file) =>
      fileIdentity(
        fileURLToPath(new URL(`../../../crates/portcove-core/catalog/${file}`, import.meta.url)),
      ),
    ),
  );
  const source = await readGameFirstSourcePopulation(inputs);
  await assert.rejects(
    readGameFirstSourcePopulation([{ ...inputs[0]!, sha256: "0".repeat(64) }, inputs[1]!]),
    /Source population input changed: catalog.json/u,
  );
  assert.match(source.definitions.sha256, /^[a-f0-9]{64}$/u);
  assert.match(source.listings.sha256, /^[a-f0-9]{64}$/u);
  const observed = inspectGameFirstRelationships(actual, expected, { origin: "embedded" }, source);
  const loadedIds = new Set([...source.definitions.games.keys(), ...source.listings.games.keys()]);
  assert.equal(observed.provenance.length, loadedIds.size);
  assert.equal(observed.audited_records, expected.audited_port_ids.length);
  assert.ok(observed.provenance.length > observed.audited_records);

  const audited = new Set(expected.audited_port_ids);
  const extra = actual.listing_catalog.listings.find((row) => !audited.has(row.id))!;
  const wrong = structuredClone(actual);
  wrong.listing_catalog.listings.find((row) => row.id === extra.id)!.original_game = {
    id: "unrelated-original-game",
  };
  assert.throws(
    () => inspectGameFirstRelationships(wrong, expected, { origin: "embedded" }, source),
    /source listing game/u,
  );
  const dualId = "2ship2harkinian";
  const masked = structuredClone(actual);
  const maskedDefinition = masked.catalog.ports.find((row) => row.id === dualId)!;
  const maskedListing = masked.listing_catalog.listings.find((row) => row.id === dualId)!;
  assert.equal(maskedDefinition.presentation?.original_game?.id, maskedListing.original_game?.id);
  maskedDefinition.presentation!.original_game = null;
  assert.throws(
    () => inspectGameFirstRelationships(masked, expected, { origin: "embedded" }, source),
    /2ship2harkinian: source definition game/u,
  );
  maskedDefinition.presentation!.original_game = actual.catalog.ports.find(
    (row) => row.id === dualId,
  )!.presentation!.original_game!;
  maskedListing.original_game = { id: "masked-by-definition" };
  assert.throws(
    () => inspectGameFirstRelationships(masked, expected, { origin: "embedded" }, source),
    /2ship2harkinian: source listing game/u,
  );
  actual.listing_catalog.listings = actual.listing_catalog.listings.filter(
    (row) => row.id !== extra.id,
  );
  assert.throws(
    () => inspectGameFirstRelationships(actual, expected, { origin: "embedded" }, source),
    /Complete source revision listing population/u,
  );
});

test("native relationship observation checks every independent reviewed family against real production documents", async () => {
  const { expected, sha256 } = await readGameFirstRelationships();
  assert.match(sha256, /^[a-f0-9]{64}$/u);
  const actual = await productionWorkspace();
  const observed = inspectGameFirstRelationships(actual, expected);
  assert.equal(observed.provenance.length, 1649);
  assert.equal(new Set(observed.provenance.map((row) => row.port_id)).size, 1649);
  assert.ok(observed.provenance.some((row) => row.definition && row.listing));
  assert.ok(observed.provenance.some((row) => !row.definition && row.listing));
  for (const id of gameFirstPresentationFamilies)
    assert.ok((expected.families[id]?.length ?? 0) >= 2);
  assert.equal(expected.families["the-legend-of-zelda-majoras-mask"]!.length, 4);
  assert.equal(expected.families["perfect-dark"]!.length, 6);
  assert.equal(expected.families["the-legend-of-zelda-the-wind-waker"]!.length, 6);
});

test("native relationship observation refuses missing, contaminated and falsely grouped actual entries", async () => {
  const { expected } = await readGameFirstRelationships();
  const original = await productionWorkspace();
  const missing = structuredClone(original);
  const removed = expected.families["banjo-kazooie"]![0];
  missing.catalog.ports = missing.catalog.ports.filter((row) => row.id !== removed);
  missing.listing_catalog.listings = missing.listing_catalog.listings.filter(
    (row) => row.id !== removed,
  );
  assert.throws(() => inspectGameFirstRelationships(missing, expected));
  for (const portId of [
    Object.keys(expected.project_entries)[0],
    "ajncsystem-shadowofthecolossus-pc",
  ]) {
    const changed = structuredClone(original);
    const identity = original.listing_catalog.listings.find(
      (row) => row.id === "2ship2harkinian",
    )!.original_game!;
    const definition = changed.catalog.ports.find((row) => row.id === portId);
    if (definition) {
      assert.ok(definition.presentation);
      definition.presentation.original_game = identity;
    }
    changed.listing_catalog.listings.find((row) => row.id === portId)!.original_game = identity;
    assert.throws(
      () => inspectGameFirstRelationships(changed, expected),
      /Complete reviewed family/u,
    );
  }
});

test("native readback keeps definition authority when accepted listing descriptive identity disagrees", async () => {
  const { expected } = await readGameFirstRelationships();
  const actual = await productionWorkspace();
  const definition = actual.catalog.ports.find((row) => row.id === "2ship2harkinian")!;
  const listing = actual.listing_catalog.listings.find((row) => row.id === definition.id)!;
  listing.original_game = { ...listing.original_game!, id: "untrusted-listing-collision" };
  const observed = inspectGameFirstRelationships(actual, expected);
  const entry = observed.entries.find((row) => row.id === definition.id)!;
  assert.equal(entry.presentation?.original_game?.id, "the-legend-of-zelda-majoras-mask");
  assert.equal(entry.source_profile, definition.source_profile);
  assert.equal(entry.release, definition.release);
});

async function stagedDefinitions() {
  const base = new URL("../../../release/catalog-publication/bundle/", import.meta.url);
  const index: unknown = JSON.parse(
    await readFile(new URL("definitions/index.json", base), "utf8"),
  );
  assert.ok(isRecord(index) && Array.isArray(index.definitions));
  return Promise.all(
    index.definitions.map(async (row: unknown) => {
      assert.ok(
        isRecord(row) && typeof row.stable_id === "string" && typeof row.target === "string",
      );
      assert.match(row.target, /^sha256\/[a-f0-9]{64}\.json$/u);
      const definition: unknown = JSON.parse(await readFile(new URL(row.target, base), "utf8"));
      assert.ok(isRecord(definition));
      const port = authoredDefinition(definition.port);
      assert.equal(port.id, row.stable_id);
      return port;
    }),
  );
}

test("every staged official definition retains reviewed game identity through strict precedence", async () => {
  const { expected } = await readGameFirstRelationships();
  const actual = await productionWorkspace();
  for (const definition of await stagedDefinitions()) {
    const index = actual.catalog.ports.findIndex((port) => port.id === definition.id);
    if (index >= 0) {
      const canonical = actual.catalog.ports[index]!;
      assert.equal(
        definition.presentation?.original_game?.id,
        canonical.presentation?.original_game?.id,
      );
      assert.equal(
        definition.presentation?.original_game_title,
        canonical.presentation?.original_game_title,
      );
      actual.catalog.ports[index] = definition;
    } else {
      assert.ok(
        Object.hasOwn(expected.selected_definition_entries, definition.id),
        `${definition.id}: staged extra requires an independent reviewed disposition`,
      );
      actual.catalog.ports.push(definition);
    }
  }
  const observed = inspectGameFirstRelationships(actual, expected, {
    origin: "definition_selected",
  });
  assert.equal(observed.provenance.length, 1650);
  assert.equal(observed.reviewed_families, 258);
  assert.deepEqual(
    observed.groups
      .find((group) => group.id === "game:chameleon-twist")
      ?.ports.map((port) => port.id)
      .sort(),
    ["chameleon-twist-jp-recompiled", "chameleon-twist-recompiled"],
  );
  const selected = observed.entries.find((port) => port.id === "chameleon-twist-jp-recompiled")!;
  assert.equal(selected.source_profile, "chameleon-twist-jp");
});

test("loaded universe refuses arbitrary extras and requires selected provenance for the reviewed JP route", async () => {
  const { expected } = await readGameFirstRelationships();
  const actual = await productionWorkspace();
  const selected = (await stagedDefinitions()).find(
    (port) => port.id === "chameleon-twist-jp-recompiled",
  )!;
  actual.catalog.ports.push(selected);
  assert.throws(
    () => inspectGameFirstRelationships(actual, expected),
    /selected definition provenance required/u,
  );
  assert.throws(
    () => inspectGameFirstRelationships(actual, expected, { origin: "embedded" }),
    /selected definition provenance required/u,
  );
  const wrong = structuredClone(actual);
  wrong.catalog.ports.find((port) => port.id === selected.id)!.presentation!.original_game = {
    id: "different-game",
  };
  assert.throws(
    () => inspectGameFirstRelationships(wrong, expected, { origin: "definition_selected" }),
    /reviewed selected game identity/u,
  );
  const unknown = await productionWorkspace();
  unknown.catalog.ports.push({ ...selected, id: "unreviewed-extra" });
  assert.throws(
    () => inspectGameFirstRelationships(unknown, expected, { origin: "definition_selected" }),
    /Complete reviewed loaded catalog universe/u,
  );
});
