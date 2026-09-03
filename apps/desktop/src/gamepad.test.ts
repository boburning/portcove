import { describe, expect, it } from "vitest";
import { keyboardNavigationAction, navigationDirection, pressedButtons, spatialTargetIndex } from "./gamepad";

const button = (pressed = false) => ({ pressed, touched: pressed, value: pressed ? 1 : 0 }) as GamepadButton;
const pad = (axes: number[], pressed: number[] = []) => ({
  axes, buttons: Array.from({ length: 16 }, (_, index) => button(pressed.includes(index))),
}) as unknown as Gamepad;

describe("gamepad focus movement", () => {
  it("extracts newly pressed buttons", () => {
    expect([...pressedButtons([button(), button(true), button()])]).toEqual([1]);
  });

  it("maps keyboard arrows and Escape to the controller navigation contract", () => {
    expect(keyboardNavigationAction("ArrowLeft")).toBe("left");
    expect(keyboardNavigationAction("Escape")).toBe("back");
    expect(keyboardNavigationAction("Enter")).toBeUndefined();
  });

  it.each([
    [pad([0, 0], [12]), "up"], [pad([0, 0], [13]), "down"], [pad([0, 0], [14]), "left"], [pad([0, 0], [15]), "right"],
    [pad([0, -0.8]), "up"], [pad([0, 0.8]), "down"], [pad([-0.8, 0]), "left"], [pad([0.8, 0]), "right"], [pad([0, 0]), undefined],
  ])("maps directional controller state to focus movement", (gamepad, expected) => {
    expect(navigationDirection(gamepad)).toBe(expected);
  });

  it("moves spatially through a two-dimensional card grid", () => {
    const rects = [
      { left: 0, top: 0, width: 100, height: 100 }, { left: 120, top: 0, width: 100, height: 100 },
      { left: 0, top: 120, width: 100, height: 100 }, { left: 120, top: 120, width: 100, height: 100 },
    ];
    expect(spatialTargetIndex(rects, 0, "right")).toBe(1);
    expect(spatialTargetIndex(rects, 0, "down")).toBe(2);
    expect(spatialTargetIndex(rects, 3, "left")).toBe(2);
    expect(spatialTargetIndex(rects, 3, "up")).toBe(1);
    expect(spatialTargetIndex(rects, 0, "up")).toBe(-1);
    expect(spatialTargetIndex([], 0, "up")).toBe(-1);
  });

  it("visits short filter rows before large cards and enters each group at its first control", () => {
    const rects = [
      { left: 730, top: 24, width: 280, height: 42 }, // Search
      { left: 1020, top: 24, width: 180, height: 42 }, // Commands
      { left: 280, top: 150, width: 60, height: 30 }, // All
      { left: 350, top: 150, width: 75, height: 30 }, // Stable
      { left: 435, top: 150, width: 60, height: 30 }, // Beta
      { left: 505, top: 150, width: 80, height: 30 }, // Rolling
      { left: 280, top: 200, width: 440, height: 350 }, // Ship
      { left: 740, top: 200, width: 440, height: 350 }, // 2Ship
    ];
    const groups = ["header", "header", "filters", "filters", "filters", "filters", "cards", "cards"];
    for (const header of [0, 1]) expect(spatialTargetIndex(rects, header, "down", groups)).toBe(2);
    expect(spatialTargetIndex(rects, 2, "right", groups)).toBe(3);
    expect(spatialTargetIndex(rects, 3, "right", groups)).toBe(4);
    expect(spatialTargetIndex(rects, 4, "right", groups)).toBe(5);
    expect(spatialTargetIndex(rects, 5, "down", groups)).toBe(6);
    expect(spatialTargetIndex(rects, 6, "right", groups)).toBe(7);
    expect(spatialTargetIndex(rects, 7, "up", groups)).toBe(2);
  });

  it("reaches GitHub actions before the more closely aligned theme options", () => {
    const rects = [
      { left: 1020, top: 24, width: 180, height: 42 },
      { left: 300, top: 290, width: 100, height: 36 },
      { left: 410, top: 290, width: 130, height: 36 },
      { left: 900, top: 700, width: 80, height: 36 },
      { left: 1080, top: 700, width: 80, height: 36 },
    ];
    const groups = ["header", "github", "github", "theme", "theme"];
    expect(spatialTargetIndex(rects, 0, "down", groups)).toBe(1);
    expect(spatialTargetIndex(rects, 1, "right", groups)).toBe(2);
    expect(spatialTargetIndex(rects, 2, "down", groups)).toBe(3);
    expect(spatialTargetIndex(rects, 3, "up", groups)).toBe(1);
  });

  it("visits the update actions before the first installed port", () => {
    const rects = [
      { left: 1000, top: 20, width: 180, height: 42 },
      { left: 700, top: 150, width: 200, height: 36 },
      { left: 920, top: 150, width: 250, height: 36 },
      { left: 280, top: 250, width: 900, height: 85 },
    ];
    const groups = ["header", "actions", "actions", "ports"];
    expect(spatialTargetIndex(rects, 0, "down", groups)).toBe(1);
    expect(spatialTargetIndex(rects, 1, "right", groups)).toBe(2);
    expect(spatialTargetIndex(rects, 2, "down", groups)).toBe(3);
  });
});
