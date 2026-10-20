import assert from "node:assert/strict";
import path from "node:path";
import process from "node:process";
import { test } from "vite-plus/test";
import type {
  ReviewElement,
  ReviewObservation,
  ReviewSnapshot,
  ReviewWaiter,
} from "./desktop-preparation-test.mts";
import { By } from "selenium-webdriver";
import {
  assertPreparedLibrarySummary,
  rollbackWitnessWithinLibrary,
  waitForReviewedUpdateAction,
} from "./desktop-preparation-test.mts";

test("accepts owned rollback witnesses across ordinary and namespaced library paths", () => {
  const library = path.resolve("work", "owned-rollback-library");
  const witness = path.join(library, "versions", "previous", ".portcove-manifest.json");
  assert.equal(rollbackWitnessWithinLibrary(library, path.toNamespacedPath(witness)), true);
  assert.equal(rollbackWitnessWithinLibrary(path.toNamespacedPath(library), witness), true);
});

test("refuses root, parent, sibling, relative and different-drive rollback witnesses", () => {
  const library = path.resolve("work", "owned-rollback-library");
  for (const outside of [
    library,
    path.resolve(library, "..", "outside.bin"),
    path.join(`${library}-sibling`, "witness.bin"),
    "relative-witness.bin",
  ])
    assert.equal(rollbackWitnessWithinLibrary(library, outside), false);
  assert.equal(
    rollbackWitnessWithinLibrary("relative-library", path.join(library, "witness.bin")),
    false,
  );
  if (process.platform === "win32") {
    const otherDrive = path.parse(library).root.toLowerCase().startsWith("c:") ? "E:" : "C:";
    assert.equal(rollbackWitnessWithinLibrary(library, `${otherDrive}\\outside.bin`), false);
  }
});

const prepared = {
  port_id: "prepared",
  active: { id: "prepared-install" },
  readiness: { launchable: true, pending_setup: false, blockers: [] },
};

test("preparation summary accounts for installations from earlier full-profile journeys", () => {
  assertPreparedLibrarySummary("1 library entry\nAll can launch", [prepared], "prepared");
  const statuses = [
    { ...prepared, port_id: "earlier-install" },
    {
      ...prepared,
      port_id: "earlier-external",
      active: null,
      external_runtime: { id: "external" },
    },
    prepared,
    { port_id: "available", active: null, external_runtime: null },
  ];
  assertPreparedLibrarySummary("3 library entries\nAll can launch", statuses, "prepared");
  assert.throws(() =>
    assertPreparedLibrarySummary("1 library entry All can launch", statuses, "prepared"),
  );
});

test("all-ready summary still requires the prepared fixture and native readiness of every entry", () => {
  assert.throws(() =>
    assertPreparedLibrarySummary("0 library entries All can launch", [], "prepared"),
  );
  for (const changes of [
    { readiness: { ...prepared.readiness, launchable: false } },
    { readiness: { ...prepared.readiness, pending_setup: true } },
    { readiness: { ...prepared.readiness, blockers: ["missing_source"] } },
    { staged: { id: "downloaded" } },
  ]) {
    const statuses = [prepared, { ...prepared, port_id: "earlier-install", ...changes }];
    assert.throws(() =>
      assertPreparedLibrarySummary("2 library entries All can launch", statuses, "prepared"),
    );
  }
  assert.throws(() =>
    assertPreparedLibrarySummary(
      "1 library entry 0 needs attention All can launch",
      [prepared],
      "prepared",
    ),
  );
});

const expectedVersion = "v0.3.8";
const ready = {
  text: "Confirm the release and what happens to your active version before updating. v0.3.8",
  displayed: true,
  version: expectedVersion,
  version_count: 1,
  version_displayed: true,
  action_count: 1,
  action_displayed: true,
  action_enabled: true,
};

function observedReview(snapshots: readonly ReviewSnapshot[]) {
  const initial = snapshots[0];
  assert.ok(initial);
  let current = initial;
  const state: { clicks: number; bounds: number[] } = { clicks: 0, bounds: [] };
  const action: ReviewElement = {
    getText: async () => assert.fail("Action text is not part of readiness"),
    isDisplayed: async () => current.action_displayed,
    isEnabled: async () => current.action_enabled,
    click: async () => {
      state.clicks++;
    },
  };
  const version: ReviewElement = {
    click: async () => assert.fail("Readiness must not click the release version"),
    isEnabled: async () => assert.fail("Version enabled state is not part of readiness"),
    getText: async () => {
      assert.ok(current.version !== null);
      return current.version;
    },
    isDisplayed: async () => current.version_displayed,
  };
  const review = {
    getText: async () => current.text,
    isDisplayed: async () => current.displayed,
    findElements: async (locator: import("selenium-webdriver").Locator) => {
      assert.ok(locator instanceof By);
      if (locator.using === "css selector") {
        assert.equal(locator.value, ".install-plan > p:first-child strong");
        return Array.from({ length: current.version_count }, () => version);
      }
      assert.equal(locator.using, "xpath");
      assert.equal(locator.value, './/button[normalize-space(.)="Keep saved update for later"]');
      return Array.from({ length: current.action_count }, () => action);
    },
    findElement: async () => action,
  };
  const browser: ReviewWaiter = {
    wait: async <Value>(condition: () => Promise<Value>, timeout: number, message: string) => {
      state.bounds.push(timeout);
      for (const snapshot of snapshots) {
        current = snapshot;
        const result = await condition();
        if (result) return result;
      }
      throw new Error(message);
    },
  };
  return { browser, review, state, action };
}

test("waits for semantic review readiness and records actual first/latest observations", async () => {
  const opening = { ...ready, text: "", displayed: false, version: "", action_displayed: false };
  const { browser, review, state, action } = observedReview([opening, ready]);
  const observation: ReviewObservation = {};
  assert.equal(
    await waitForReviewedUpdateAction(browser, review, expectedVersion, observation),
    action,
  );
  assert.deepEqual(state.bounds, [5_000]);
  assert.equal(state.clicks, 0, "Readiness itself must not apply the update");
  assert.ok(observation.review);
  assert.ok(observation.review.first);
  assert.ok(observation.review.latest);
  assert.equal(observation.review.expected_version, expectedVersion);
  assert.equal(observation.review.first.text, "");
  assert.equal(observation.review.first.displayed, false);
  assert.equal(observation.review.latest.version, expectedVersion);
  assert.equal(observation.review.latest.action_enabled, true);
  assert.equal(observation.review.polls, 2);
});

const refusedReviews: readonly (readonly [string, Partial<ReviewSnapshot>])[] = [
  ["merely located unopened dialog", { text: "", displayed: false, action_displayed: false }],
  ["wrong exact rendered version", { version: "v0.3.80", text: ready.text + " v0.3.80" }],
  ["missing rendered version", { version_count: 0 }],
  ["hidden release version", { version_displayed: false }],
  ["missing release confirmation", { text: expectedVersion }],
  ["missing scoped action", { action_count: 0 }],
  ["hidden scoped action", { action_displayed: false }],
  ["disabled scoped action", { action_enabled: false }],
  ["ambiguous scoped action", { action_count: 2 }],
];
for (const [name, changes] of refusedReviews) {
  test(`refuses Apply admission for ${name}`, async () => {
    const { browser, review, state } = observedReview([{ ...ready, ...changes }]);
    const observation: ReviewObservation = {};
    await assert.rejects(async () => {
      const action = await waitForReviewedUpdateAction(
        browser,
        review,
        expectedVersion,
        observation,
      );
      await action.click();
    }, /The controlled review must show its exact release and available action/);
    assert.deepEqual(state.bounds, [5_000]);
    assert.equal(state.clicks, 0);
    assert.ok(observation.review);
    assert.ok(observation.review.first);
    assert.ok(observation.review.latest);
    assert.equal(observation.review.expected_version, expectedVersion);
    assert.ok(observation.review.first);
    assert.ok(observation.review.latest);
  });
}
