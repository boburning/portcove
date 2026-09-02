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
});
