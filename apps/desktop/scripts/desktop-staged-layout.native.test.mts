import assert from "node:assert/strict";
import test from "node:test";
import { assertStagedActionPlacement, readStagedLayout } from "./desktop-staged-layout.mts";
import { stagedDocument, validStagedLayout as valid } from "./desktop-staged-layout-fixture.mts";

function checkPlacement(value: unknown) {
  Reflect.apply(assertStagedActionPlacement, undefined, [value]);
}
void test("staged actions retain direct header Play and activation in the selected Versions panel", () =>
  checkPlacement(valid));
for (const [name, value] of [
  ["inactive Versions", { ...valid, versionsSelected: false }],
  ["incorrect readiness", { ...valid, state: "Setup required" }],
  ["missing attention", { ...valid, attention: undefined }],
  ["missing action", { ...valid, activate: undefined }],
  ["hidden action", { ...valid, activate: { ...valid.activate, visible: false } }],
  ["disabled action", { ...valid, play: { ...valid.play, enabled: false } }],
  ["zero size", { ...valid, play: { ...valid.play, right: 20 } }],
  ["nonfinite bounds", { ...valid, activate: { ...valid.activate, left: NaN } }],
  ["outside owning panel", { ...valid, activate: { ...valid.activate, top: 160 } }],
  ["horizontal overflow", { ...valid, activate: { ...valid.activate, right: 970 } }],
  ["document overflow", { ...valid, documentOverflow: true }],
] as const)
  void test(`staged actions reject ${name}`, () => assert.throws(() => checkPlacement(value)));

void test("serialized staged layout retains action identity, state and actual placement facts", async () => {
  const fixture = stagedDocument();
  const observed = await fixture.observe();
  assert.deepEqual(observed, { ...valid, reason: "" });
  checkPlacement(observed);
  fixture.controls.reverse();
  assert.deepEqual(
    await fixture.observe(),
    observed,
    "Unrelated button order is not the action identity",
  );
  assert.equal(fixture.executions(), 2);
  fixture.play.bounds = { left: 20, right: 128, top: 20, bottom: 60 };
  fixture.activate.bounds = { left: 136, right: 339, top: 200, bottom: 240 };
  fixture.header.bounds = { left: 20, right: 900, top: 10, bottom: 150 };
  fixture.panel.bounds = { left: 20, right: 900, top: 190, bottom: 600 };
  const moved = await fixture.observe();
  assert.partialDeepStrictEqual(moved, {
    play: fixture.play.bounds,
    activate: fixture.activate.bounds,
    header: fixture.header.bounds,
    panel: fixture.panel.bounds,
  });
  checkPlacement(moved);
  const missing = await fixture.observe(readStagedLayout, "missing-version");
  assert.ok(missing && typeof missing === "object");
  assert.equal(Reflect.get(missing, "activate"), undefined);
  assert.throws(() => checkPlacement(missing));
});

for (const [name, change, expected] of [
  [
    "transparent common ancestor",
    (f: ReturnType<typeof stagedDocument>) => {
      f.detail.style.opacity = "0";
    },
    { play: { visible: false }, activate: { visible: false } },
  ],
  [
    "transparent header",
    (f: ReturnType<typeof stagedDocument>) => {
      f.header.style.opacity = "0";
    },
    { play: { visible: false }, activate: { visible: true } },
  ],
  [
    "transparent panel",
    (f: ReturnType<typeof stagedDocument>) => {
      f.panel.style.opacity = "0";
    },
    { play: { visible: true }, activate: { visible: false } },
  ],
  [
    "display-none ancestor",
    (f: ReturnType<typeof stagedDocument>) => {
      f.detail.style.display = "none";
    },
    { play: { visible: false }, activate: { visible: false } },
  ],
  [
    "hidden ancestor",
    (f: ReturnType<typeof stagedDocument>) => {
      f.detail.hidden = true;
    },
    { play: { visible: false }, activate: { visible: false } },
  ],
  [
    "inert ancestor",
    (f: ReturnType<typeof stagedDocument>) => {
      f.detail.inert = true;
    },
    { play: { visible: false }, activate: { visible: false } },
  ],
  [
    "missing client rectangles",
    (f: ReturnType<typeof stagedDocument>) => {
      f.play.shown = false;
      f.activate.shown = false;
    },
    { play: { visible: false }, activate: { visible: false } },
  ],
  [
    "hidden computed visibility",
    (f: ReturnType<typeof stagedDocument>) => {
      f.play.style.visibility = "hidden";
      f.activate.style.visibility = "hidden";
    },
    { play: { visible: false }, activate: { visible: false } },
  ],
  [
    "aria-disabled actions",
    (f: ReturnType<typeof stagedDocument>) => {
      f.play.ariaDisabled = "true";
      f.activate.ariaDisabled = "true";
    },
    { play: { enabled: false }, activate: { enabled: false } },
  ],
  [
    "native-disabled actions",
    (f: ReturnType<typeof stagedDocument>) => {
      f.play.disabled = true;
      f.activate.disabled = true;
    },
    { play: { enabled: false }, activate: { enabled: false } },
  ],
  [
    "inactive Versions tab",
    (f: ReturnType<typeof stagedDocument>) => {
      f.text.selectedTab = "Summary";
    },
    { versionsSelected: false },
  ],
  [
    "document overflow",
    (f: ReturnType<typeof stagedDocument>) => {
      f.documentElement.scrollWidth = 962;
    },
    { documentOverflow: true },
  ],
] as const)
  void test(`serialized staged layout reports ${name}`, async () => {
    const fixture = stagedDocument();
    change(fixture);
    const observed = await fixture.observe();
    assert.partialDeepStrictEqual(observed, expected);
    assert.throws(() => checkPlacement(observed));
  });
