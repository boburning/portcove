import { describe, expect, it } from "vite-plus/test";
import { portDefinition } from "../../test-fixtures";
import type { PortDefinition } from "../../types";
import {
  activeLibraryQuickView,
  libraryQuickViewCounts,
  withUpdatesQuickView,
  withoutUpdatesQuickView,
} from "./library-quick-views";

const port = (id: string, overrides: Partial<PortDefinition> = {}): PortDefinition => ({
  ...portDefinition(),
  id,
  ...overrides,
});

describe("Library quick views", () => {
  it("selects exactly one view and reports combined constraints as no single view", () => {
    const updates = withUpdatesQuickView({ version: 1 });
    expect(activeLibraryQuickView({ favoritesOnly: false, readiness: "all", filter: "all" })).toBe(
      "all",
    );
    expect(activeLibraryQuickView({ favoritesOnly: true, readiness: "all", filter: "all" })).toBe(
      "favorites",
    );
    expect(
      activeLibraryQuickView({ favoritesOnly: false, readiness: "setup", filter: "all" }),
    ).toBe("attention");
    expect(
      activeLibraryQuickView({ favoritesOnly: false, readiness: "all", filter: updates }),
    ).toBe("updates");
    expect(
      activeLibraryQuickView({ favoritesOnly: true, readiness: "all", filter: updates }),
    ).toBeUndefined();
    expect(
      activeLibraryQuickView({ favoritesOnly: false, readiness: "ready", filter: "all" }),
    ).toBeUndefined();
    expect(
      activeLibraryQuickView({ favoritesOnly: false, readiness: "ready", filter: updates }),
    ).toBeUndefined();
  });

  it("keeps custom update filters while switching away from the Updates view", () => {
    const custom = { version: 1, updates: ["available"] };
    expect(withoutUpdatesQuickView(custom)).toBe(custom);
    expect(activeLibraryQuickView({ favoritesOnly: false, readiness: "all", filter: custom })).toBe(
      "all",
    );
    expect(withoutUpdatesQuickView(withUpdatesQuickView(custom))).toEqual({
      version: 1,
      updates: [],
    });
  });

  it("counts every view from the same base instead of the active view's result", () => {
    const base = [
      port("windows-a", { platforms: ["windows-x86-64"] }),
      port("windows-b", { platforms: ["windows-x86-64"] }),
      port("linux", { platforms: ["linux-x86-64"] }),
    ];
    const counts = (filter: Parameters<typeof libraryQuickViewCounts>[0]["filter"]) =>
      libraryQuickViewCounts({
        base,
        filter,
        favoriteIds: new Set(["windows-a", "linux"]),
        statuses: new Map(),
        context: {},
        scope: (ports) => ports,
      });
    const declared = { version: 1, platforms: ["windows-x86-64"] };
    const plain = counts(declared);
    expect(plain.all).toBe(2);
    expect(plain.favorites).toBe(1);
    // Selecting Updates must not shrink All or Favorites to the Updates result.
    const selected = counts(withUpdatesQuickView(declared));
    expect(selected.all).toBe(plain.all);
    expect(selected.favorites).toBe(plain.favorites);
    expect(selected.updates).toBe(plain.updates);
  });

  it("applies the selected collection scope to every count", () => {
    const base = [port("a"), port("b"), port("c")];
    const result = libraryQuickViewCounts({
      base,
      filter: "all",
      favoriteIds: undefined,
      statuses: new Map(),
      context: {},
      scope: (ports) => ports.filter(({ id }) => id !== "c"),
    });
    expect(result.all).toBe(2);
    expect(result.favorites).toBe("unavailable");
  });

  it("reports unavailable counts rather than zero when the base is unknown", () => {
    expect(
      libraryQuickViewCounts({
        base: undefined,
        filter: "all",
        favoriteIds: new Set(),
        statuses: new Map(),
        context: {},
        scope: (ports) => ports,
      }),
    ).toEqual({
      all: "unavailable",
      favorites: "unavailable",
      attention: "unavailable",
      updates: "unavailable",
    });
  });
});
