import assert from "node:assert/strict";
import test from "node:test";
import { assertStagedActionPlacement } from "./desktop-staged-layout.mts";

function checkPlacement(value: unknown) {
  Reflect.apply(assertStagedActionPlacement, undefined, [value]);
}
const valid = {
  play: { left: 20, right: 95, top: 20, bottom: 60, enabled: true, visible: true },
  activate: { left: 20, right: 223, top: 200, bottom: 240, enabled: true, visible: true },
  header: { left: 20, right: 900, top: 10, bottom: 160 },
  panel: { left: 20, right: 900, top: 180, bottom: 600 },
  versionsSelected: true,
  state: "Ready to play",
  attention: "Downloaded for later · 2.0.0-fixture",
  viewport: { width: 960, height: 640 },
  documentOverflow: false,
};
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
