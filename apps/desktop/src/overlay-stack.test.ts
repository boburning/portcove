import { describe, expect, it } from "vitest";
import { overlayBackAction } from "./overlay-stack";

describe("overlay back stack", () => {
  it("closes only the topmost modal layer", () => {
    expect(overlayBackAction({ paletteOpen: true, adoptionOpen: true, detailOpen: true })).toBe("close-palette");
    expect(overlayBackAction({ paletteOpen: false, adoptionOpen: true, detailOpen: true })).toBe("close-adoption");
    expect(overlayBackAction({ paletteOpen: false, adoptionOpen: false, detailOpen: true })).toBe("close-detail");
    expect(overlayBackAction({ paletteOpen: false, adoptionOpen: false, detailOpen: false })).toBeUndefined();
  });
});
