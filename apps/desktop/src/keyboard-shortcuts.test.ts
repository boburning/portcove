import { describe, expect, it } from "vitest";
import { keyboardShortcutAction } from "./keyboard-shortcuts";

describe("global keyboard shortcuts", () => {
  it("maps navigation, palette, and search shortcuts", () => {
    expect(keyboardShortcutAction({ key: "1", ctrlKey: true })).toBe("library");
    expect(keyboardShortcutAction({ key: "4", metaKey: true })).toBe("settings");
    expect(keyboardShortcutAction({ key: "k", ctrlKey: true })).toBe("toggle-palette");
    expect(keyboardShortcutAction({ key: "/" })).toBe("focus-search");
    expect(keyboardShortcutAction({ key: "Escape", paletteOpen: true })).toBe("close-palette");
  });

  it("does not hijack text fields or modified search keys", () => {
    expect(keyboardShortcutAction({ key: "/", targetIsField: true })).toBeUndefined();
    expect(keyboardShortcutAction({ key: "/", altKey: true })).toBeUndefined();
    expect(keyboardShortcutAction({ key: "1" })).toBeUndefined();
  });

  it("keeps workspace shortcuts behind the top modal inactive", () => {
    for (const key of ["1", "2", "3", "4", "k"]) {
      expect(keyboardShortcutAction({ key, ctrlKey: true, modalOpen: true })).toBeUndefined();
    }
    expect(keyboardShortcutAction({ key: "/", modalOpen: true })).toBeUndefined();
    expect(keyboardShortcutAction({ key: "Escape", modalOpen: true, paletteOpen: true })).toBe("close-palette");
    expect(keyboardShortcutAction({ key: "4", ctrlKey: true, modalOpen: true, paletteOpen: true })).toBeUndefined();
    expect(keyboardShortcutAction({ key: "k", ctrlKey: true, modalOpen: true, paletteOpen: true })).toBe("toggle-palette");
  });
});
