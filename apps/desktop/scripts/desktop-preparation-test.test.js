import assert from "node:assert/strict";
import { test } from "vitest";
import {
  assertPreparedLibrarySummary,
  waitForReviewedUpdateAction,
} from "./desktop-preparation-test.mjs";

const prepared = {
  port_id: "prepared",
  active: { id: "prepared-install" },
  readiness: { launchable: true, pending_setup: false, blockers: [] },
};

test("preparation summary accounts for installations from earlier full-profile journeys", () => {
  assertPreparedLibrarySummary("1 in library\nAll ready to play", [prepared], "prepared");
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
  assertPreparedLibrarySummary("3 in library\nAll ready to play", statuses, "prepared");
  assert.throws(() =>
    assertPreparedLibrarySummary("1 in library All ready to play", statuses, "prepared"),
  );
});

test("all-ready summary still requires the prepared fixture and native readiness of every entry", () => {
  assert.throws(() =>
    assertPreparedLibrarySummary("0 in library All ready to play", [], "prepared"),
  );
  for (const changes of [
    { readiness: { ...prepared.readiness, launchable: false } },
    { readiness: { ...prepared.readiness, pending_setup: true } },
    { readiness: { ...prepared.readiness, blockers: ["missing_source"] } },
    { staged: { id: "downloaded" } },
  ]) {
    const statuses = [prepared, { ...prepared, port_id: "earlier-install", ...changes }];
    assert.throws(() =>
      assertPreparedLibrarySummary("2 in library All ready to play", statuses, "prepared"),
    );
  }
  assert.throws(() =>
    assertPreparedLibrarySummary(
      "1 in library 0 needs attention All ready to play",
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

function observedReview(snapshots) {
  let current = snapshots[0];
  const state = { clicks: 0, bounds: [] };
  const action = {
    isDisplayed: async () => current.action_displayed,
    isEnabled: async () => current.action_enabled,
    click: async () => state.clicks++,
  };
  const version = {
    getText: async () => current.version,
    isDisplayed: async () => current.version_displayed,
  };
  const review = {
    getText: async () => current.text,
    isDisplayed: async () => current.displayed,
    findElements: async (locator) => {
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
  const browser = {
    wait: async (condition, timeout, message) => {
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
  const observation = {};
  assert.equal(
    await waitForReviewedUpdateAction(browser, review, expectedVersion, observation),
    action,
  );
  assert.deepEqual(state.bounds, [5_000]);
  assert.equal(state.clicks, 0, "Readiness itself must not apply the update");
  assert.equal(observation.review.expected_version, expectedVersion);
  assert.equal(observation.review.first.text, "");
  assert.equal(observation.review.first.displayed, false);
  assert.equal(observation.review.latest.version, expectedVersion);
  assert.equal(observation.review.latest.action_enabled, true);
  assert.equal(observation.review.polls, 2);
});

for (const [name, changes] of [
  ["merely located unopened dialog", { text: "", displayed: false, action_displayed: false }],
  ["wrong exact rendered version", { version: "v0.3.80", text: ready.text + " v0.3.80" }],
  ["missing rendered version", { version_count: 0 }],
  ["hidden release version", { version_displayed: false }],
  ["missing release confirmation", { text: expectedVersion }],
  ["missing scoped action", { action_count: 0 }],
  ["hidden scoped action", { action_displayed: false }],
  ["disabled scoped action", { action_enabled: false }],
  ["ambiguous scoped action", { action_count: 2 }],
]) {
  test(`refuses Apply admission for ${name}`, async () => {
    const { browser, review, state } = observedReview([{ ...ready, ...changes }]);
    const observation = {};
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
    assert.equal(observation.review.expected_version, expectedVersion);
    assert.ok(observation.review.first);
    assert.ok(observation.review.latest);
  });
}
