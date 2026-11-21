import assert from "node:assert/strict";
import test from "node:test";
import vm from "node:vm";
import {
  observeCompletionResultFocus,
  observeSetupReviewFocus,
} from "./desktop-completion-focus.mts";
import { isRecord } from "../../../scripts/runtime-values.mts";

// Native Node erases types before toString(), just as the actual driver does.
void test("serialized completion result focus needs only its owned browser context", () => {
  for (const mode of [
    "ready",
    "other-port",
    "review-open",
    "outside",
    "disabled",
    "hidden",
    "zero-rect",
    "invisible",
    "missing-control",
    "unactionable",
  ] as const) {
    const control = {
      isConnected: true,
      matches: (selector: string) =>
        selector.startsWith(":disabled") ? mode === "disabled" : mode !== "unactionable",
      closest: () => (mode === "hidden" ? {} : null),
      getClientRects: () => (mode === "zero-rect" ? [] : [{}]),
      tagName: "BUTTON",
      id: "play",
      textContent: "Play",
      getAttribute: () => null,
    };
    const document = {
      activeElement: mode === "missing-control" ? null : control,
      querySelector: (selector: string) => {
        if (selector === "[data-detail-workspace]") return { contains: () => mode !== "outside" };
        if (selector === "#port-detail-title")
          return { textContent: mode === "other-port" ? "Other port" : "Owned port" };
        return mode === "review-open" ? {} : null;
      },
    };
    const result: unknown = vm.runInNewContext(
      `(${observeCompletionResultFocus.toString()})("Owned port")`,
      {
        document,
        getComputedStyle: () => ({ visibility: mode === "invisible" ? "hidden" : "visible" }),
      },
      { timeout: 1000 },
    );
    if (mode === "ready") {
      assert.ok(isRecord(result));
      assert.equal(result.tag, "BUTTON");
      assert.equal(result.id, "play");
      assert.equal(result.text, "Play");
      assert.equal(result.ariaLabel, null);
    } else assert.equal(result, false, mode);
  }
});

void test("serialized setup review focus requires the owned visible current control", () => {
  for (const mode of [
    "ready",
    "outside",
    "hidden",
    "disabled",
    "offscreen",
    "clipped",
    "missing",
  ] as const) {
    const bounds = {
      top: mode === "offscreen" ? -10 : 20,
      bottom: 50,
      left: 10,
      right: 100,
      width: 90,
      height: 30,
    };
    const parent = {
      parentElement: null,
      clientTop: 0,
      clientHeight: 40,
      getBoundingClientRect: () => ({ top: 0 }),
    };
    const control = {
      isConnected: true,
      matches: () => mode === "disabled",
      closest: () => (mode === "hidden" ? {} : null),
      getClientRects: () => [{}],
      getBoundingClientRect: () => bounds,
      parentElement: mode === "clipped" ? parent : null,
      tagName: "BUTTON",
      textContent: "Cancel",
    };
    const result: unknown = vm.runInNewContext(
      `(${observeSetupReviewFocus.toString()})("[aria-label=Review]")`,
      {
        document: {
          querySelector: () => ({ isConnected: true, contains: () => mode !== "outside" }),
          activeElement: mode === "missing" ? null : control,
        },
        getComputedStyle: (element: unknown) => ({
          visibility: "visible",
          overflowY: element === parent ? "auto" : "visible",
        }),
        innerHeight: 800,
        innerWidth: 1200,
      },
      { timeout: 1000 },
    );
    if (mode === "ready") {
      assert.ok(isRecord(result));
      assert.equal(result.tag, "BUTTON");
      assert.equal(result.text, "Cancel");
    } else assert.equal(result, false, mode);
  }
});
