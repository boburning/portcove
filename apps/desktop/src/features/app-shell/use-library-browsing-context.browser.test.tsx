import { fixtureValue } from "../../test-fixtures";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";
import {
  libraryBrowsingPreferenceKey,
  useLibraryBrowsingContext,
  type LibraryBrowsingContext,
} from "./use-library-browsing-context";
import { evaluateCatalogQuery } from "../browsing/catalog-query";
import { desktopApi } from "../../api";

let root: Root;
let host: HTMLDivElement;
let browsing: ReturnType<typeof useLibraryBrowsingContext>;
let libraryRoot = "E:/first";
let initial: LibraryBrowsingContext | undefined;
let landingReady = false;
let installedCount: number | undefined;
let catalogCount: number | undefined;
let selectionReturn: "switch" | "reset" | undefined;
const remember = vi.fn<(root: string, context: LibraryBrowsingContext) => void>();
const switchLibrary = vi.fn(async (_path: string) => {});
const resetLibrary = vi.fn(async () => {});

function Fixture() {
  browsing = useLibraryBrowsingContext({
    root: libraryRoot,
    initial,
    remember,
    switchLibrary,
    resetLibrary,
    ready: landingReady,
    installedCount,
    catalogCount,
    returnToSelection: selectionReturn,
  });
  return createElement(
    "main",
    { ref: browsing.workspace, style: { height: 100, overflow: "auto" } },
    createElement("div", { style: { height: 2000 } }, createElement("input", { id: "search" })),
  );
}

async function remount() {
  await act(async () => root.unmount());
  root = createRoot(host);
  await act(async () => root.render(createElement(Fixture)));
}

beforeEach(async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("requestAnimationFrame", () => 1);
  vi.stubGlobal("cancelAnimationFrame", () => {});
  remember.mockClear();
  switchLibrary.mockClear();
  resetLibrary.mockClear();
  initial = undefined;
  libraryRoot = "E:/first";
  landingReady = false;
  installedCount = undefined;
  catalogCount = undefined;
  selectionReturn = undefined;
  window.localStorage.clear();
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  await act(async () => root.render(createElement(Fixture)));
});

afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  window.localStorage.clear();
});

it("restores independent section query/search/sort on restart without transient or backend state", async () => {
  const backend = vi.spyOn(desktopApi, "workspaceSnapshot");
  const network = vi.spyOn(globalThis, "fetch");
  expect(window.localStorage.getItem(libraryBrowsingPreferenceKey(libraryRoot))).toBeNull();
  await act(async () => {
    browsing.ui.setQuery("installed search");
    browsing.ui.setLibrarySort("recent");
    browsing.ui.setFilter("ready");
    browsing.ui.setSourcePath("private-game-path");
    browsing.ui.setBiosPath("private-bios-path");
    browsing.ui.setAdoptPath("private-adoption-path");
    browsing.ui.setAdoptOpen(true);
    browsing.ui.setSelectedId("selected-detail");
  });
  await act(async () => browsing.ui.setView("catalog"));
  const filter = {
    version: 1,
    platforms: ["windows-x86-64", "linux-x86-64"],
    channels: ["stable", "beta"],
  };
  await act(async () => {
    browsing.ui.setFilter(filter);
    browsing.ui.setQuery("catalog search");
    browsing.ui.setCatalogSort("name");
  });
  const saved = window.localStorage.getItem(libraryBrowsingPreferenceKey(libraryRoot))!;
  expect(saved).not.toMatch(/private-|selected-detail|scrollTop|focus/);
  await remount();
  expect(browsing.ui).toMatchObject({
    view: "library",
    filter: "all",
    libraryReadiness: "ready",
    librarySort: "recent",
    query: "installed search",
    catalogSort: "name",
    selectedId: undefined,
    sourcePath: "",
    biosPath: "",
    adoptPath: "",
    adoptOpen: false,
  });
  await act(async () => browsing.ui.setView("catalog"));
  expect(browsing.ui).toMatchObject({ filter, query: "catalog search", catalogSort: "name" });
  expect(backend).not.toHaveBeenCalled();
  expect(network).not.toHaveBeenCalled();
});

it("isolates persisted inputs between two libraries and existing Windows namespace aliases", async () => {
  libraryRoot = "E:\\first";
  await remount();
  await act(async () => browsing.ui.setQuery("first library"));
  libraryRoot = "E:\\second";
  await remount();
  expect(browsing.ui.query).toBe("");
  await act(async () => browsing.ui.setQuery("second library"));
  libraryRoot = "\\\\?\\E:\\first";
  await remount();
  expect(browsing.ui.query).toBe("first library");
  libraryRoot = "E:\\second";
  await remount();
  expect(browsing.ui.query).toBe("second library");
  expect(libraryBrowsingPreferenceKey("\\\\?\\UNC\\server\\share")).toBe(
    libraryBrowsingPreferenceKey("\\\\server\\share"),
  );
});

it("keeps in-memory browsing inputs ahead of the persisted copy", async () => {
  await act(async () => browsing.ui.setQuery("persisted"));
  initial = {
    inputs: {
      ...browsing.ui.browsingInputs,
      sections: {
        ...browsing.ui.browsingInputs.sections,
        library: { filter: "setup", query: "current memory" },
      },
    },
    positions: {},
  };
  await remount();
  expect(browsing.ui).toMatchObject({
    filter: "all",
    libraryReadiness: "setup",
    query: "current memory",
  });
});

it("keeps an unreadable preference held after switching away and returning with memory inputs", async () => {
  const key = libraryBrowsingPreferenceKey(libraryRoot);
  const unreadable = JSON.stringify({ version: 99, retained: "future preferences" });
  window.localStorage.setItem(key, unreadable);
  await remount();
  await act(async () => browsing.ui.setQuery("first library session"));
  await act(async () => browsing.switchLibraryWithContext("E:/second"));
  const firstMemory = remember.mock.lastCall![1];
  libraryRoot = "E:/second";
  initial = undefined;
  await remount();
  await act(async () => browsing.ui.setQuery("second library session"));
  libraryRoot = "E:/first";
  initial = firstMemory;
  await remount();
  expect(browsing.ui.query).toBe("first library session");
  expect(browsing.preferenceFailure).toBe("read");
  expect(window.localStorage.getItem(key)).toBe(unreadable);
  await act(async () => browsing.ui.setQuery("still held current choices"));
  expect(window.localStorage.getItem(key)).toBe(unreadable);
  await act(async () => {
    expect(browsing.saveBrowsingPreferences()).toBe(true);
  });
  expect(browsing.preferenceFailure).toBeUndefined();
  expect(window.localStorage.getItem(key)).not.toBe(unreadable);
});

it.each([
  { version: 1, channels: ["retired-channel"] },
  { version: 99, channels: ["stable"] },
  { version: 1, futurePredicate: ["selected"] },
])("keeps unsupported restored query %j unresolved until an explicit reset", async (filter) => {
  await act(async () => browsing.ui.setView("catalog"));
  await act(async () => browsing.ui.setFilter(filter));
  await remount();
  await act(async () => browsing.ui.setView("catalog"));
  expect(browsing.ui.filter).toEqual(filter);
  expect(evaluateCatalogQuery([], browsing.ui.filter).state).toBe("unresolved");
  await act(async () => browsing.ui.setFilter("all"));
  await remount();
  await act(async () => browsing.ui.setView("catalog"));
  expect(browsing.ui.filter).toBe("all");
});

it("migrates compatible legacy shortcuts and retains an unknown legacy identifier", async () => {
  await act(async () => browsing.ui.setFilter("ready"));
  await act(async () => browsing.ui.setView("catalog"));
  await act(async () => browsing.ui.setFilter("retired-channel" as never));
  await remount();
  expect(browsing.ui.libraryReadiness).toBe("ready");
  await act(async () => browsing.ui.setView("catalog"));
  expect(browsing.ui.filter).toEqual({ version: 1, channels: ["retired-channel"] });
  expect(evaluateCatalogQuery([], browsing.ui.filter).state).toBe("unresolved");
});

it("does not redirect a restored explicit Library choice on an empty first snapshot", async () => {
  await act(async () => browsing.ui.setQuery("explicit search"));
  expect(window.localStorage.getItem("portcove.empty-profile-landing.v1")).toBeNull();
  await remount();
  await acceptSnapshot(0, 89);
  expect(browsing.ui).toMatchObject({ view: "library", query: "explicit search" });
});

it.each([
  "{malformed",
  JSON.stringify({ version: 99 }),
  JSON.stringify({ version: 1, library: "another-library", inputs: {} }),
  "x".repeat(64 * 1024 + 1),
])("retains unreadable saved inputs and requires explicit replacement (%#)", async (serialized) => {
  const key = libraryBrowsingPreferenceKey(libraryRoot);
  window.localStorage.setItem(key, serialized);
  await remount();
  expect(browsing.preferenceFailure).toBe("read");
  await act(async () => browsing.ui.setQuery("current session"));
  expect(window.localStorage.getItem(key)).toBe(serialized);
  await act(async () => browsing.switchLibraryWithContext("E:/second"));
  expect(switchLibrary).toHaveBeenCalledWith("E:/second");
  await act(async () => {
    expect(browsing.saveBrowsingPreferences()).toBe(true);
  });
  expect(browsing.preferenceFailure).toBeUndefined();
  await remount();
  expect(browsing.ui.query).toBe("current session");
});

it("preserves the previous saved choices on quota failure and retries current inputs explicitly", async () => {
  await act(async () => browsing.ui.setQuery("previous saved"));
  const key = libraryBrowsingPreferenceKey(libraryRoot);
  const previous = window.localStorage.getItem(key);
  const write = vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
    throw new DOMException("storage full", "QuotaExceededError");
  });
  await act(async () => browsing.ui.setQuery("current unsaved"));
  expect(browsing.preferenceFailure).toBe("write");
  expect(window.localStorage.getItem(key)).toBe(previous);
  await act(async () => {
    expect(browsing.saveBrowsingPreferences()).toBe(false);
  });
  write.mockRestore();
  await act(async () => {
    expect(browsing.saveBrowsingPreferences()).toBe(true);
  });
  expect(browsing.preferenceFailure).toBeUndefined();
  await remount();
  expect(browsing.ui.query).toBe("current unsaved");
});

it("keeps browsing and library switching available when preference access is denied", async () => {
  const read = vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
    throw new DOMException("denied", "SecurityError");
  });
  const write = vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
    throw new DOMException("denied", "SecurityError");
  });
  await remount();
  expect(browsing.preferenceFailure).toBe("read");
  await act(async () => {
    browsing.ui.setQuery("session only");
    browsing.ui.setFilter("ready");
  });
  await act(async () => browsing.resetLibraryWithContext());
  expect(resetLibrary).toHaveBeenCalledOnce();
  expect(browsing.ui).toMatchObject({
    query: "session only",
    filter: "all",
    libraryReadiness: "ready",
  });
  await act(async () => {
    expect(browsing.saveBrowsingPreferences()).toBe(false);
  });
  read.mockRestore();
  write.mockRestore();
  await act(async () => {
    expect(browsing.saveBrowsingPreferences()).toBe(true);
  });
  expect(browsing.preferenceFailure).toBeUndefined();
});

it("never saves old inputs under a changed root before its workspace is remounted", async () => {
  await act(async () => browsing.ui.setQuery("first library"));
  libraryRoot = "E:/second";
  await act(async () => root.render(createElement(Fixture)));
  await act(async () => browsing.ui.setQuery("old mounted workspace"));
  expect(window.localStorage.getItem(libraryBrowsingPreferenceKey(libraryRoot))).toBeNull();
  expect(browsing.saveBrowsingPreferences()).toBe(false);
});

async function acceptSnapshot(active: number, available: number) {
  landingReady = true;
  installedCount = active;
  catalogCount = available;
  await act(async () => root.render(createElement(Fixture)));
}

it("shows the populated catalog once for a fresh empty profile and keeps later Library choices", async () => {
  await acceptSnapshot(0, 76);
  expect(browsing.ui.view).toBe("catalog");
  await act(async () => browsing.ui.setView("library"));
  await remount();
  expect(browsing.ui.view).toBe("library");
});

it("keeps an installed library and an explicit early destination", async () => {
  await acceptSnapshot(1, 76);
  expect(browsing.ui.view).toBe("library");

  window.localStorage.clear();
  landingReady = false;
  await remount();
  await act(async () => browsing.ui.setView("settings"));
  await acceptSnapshot(0, 76);
  expect(browsing.ui.view).toBe("settings");
});

it("does not redirect an interacted Library when its first snapshot arrives late", async () => {
  document.dispatchEvent(new KeyboardEvent("keydown", { key: "s", bubbles: true }));
  await act(async () => browsing.ui.setQuery("ship"));
  await acceptSnapshot(0, 76);
  expect(browsing.ui.view).toBe("library");
  expect(browsing.ui.query).toBe("ship");
  await remount();
  expect(browsing.ui.view).toBe("library");
});

it("does not consume the first empty-profile landing during a library-selection return", async () => {
  selectionReturn = "switch";
  await remount();
  await acceptSnapshot(0, 76);
  expect(browsing.ui.view).toBe("settings");

  selectionReturn = undefined;
  await remount();
  expect(browsing.ui.view).toBe("catalog");
});

it("captures browsing context for its own library and resets transient UI on another library", async () => {
  await act(async () => {
    browsing.ui.setQuery("saved search");
    browsing.ui.setFilter("ready");
    browsing.ui.setSelectedId("old-detail");
    browsing.ui.setAdoptOpen(true);
  });
  const workspace = host.querySelector<HTMLElement>("main")!;
  workspace.scrollTop = 72;
  await act(async () => browsing.switchLibraryWithContext("E:/second"));
  expect(switchLibrary).toHaveBeenCalledWith("E:/second");
  expect(remember).toHaveBeenCalledTimes(1);
  expect(fixtureValue(remember.mock.calls[0], "remember.mock.calls[0]")[0]).toBe("E:/first");
  const saved = fixtureValue(remember.mock.calls[0], "remember.mock.calls[0]")[1];
  expect(saved.inputs.sections.library).toEqual({
    filter: "all",
    readiness: "ready",
    query: "saved search",
  });
  expect(saved.positions.library).toEqual({ focus: undefined, scrollTop: 72 });
  libraryRoot = "E:/second";
  await remount();
  expect(browsing.ui).toMatchObject({ query: "", selectedId: undefined, adoptOpen: false });

  libraryRoot = "E:/first";
  initial = saved;
  await remount();
  expect(browsing.ui).toMatchObject({
    query: "saved search",
    filter: "all",
    libraryReadiness: "ready",
    selectedId: undefined,
    adoptOpen: false,
  });
  await act(async () => browsing.resetLibraryWithContext());
  expect(resetLibrary).toHaveBeenCalledTimes(1);
  expect(remember.mock.lastCall?.[0]).toBe("E:/first");
});

it.each(["ready", "setup"])(
  "migrates v1 Library %s without losing other section intent",
  async (readiness) => {
    const key = libraryBrowsingPreferenceKey(libraryRoot);
    const inputs = browsing.ui.browsingInputs;
    inputs.sections.library = { filter: readiness as "ready" | "setup", query: "kept search" };
    inputs.sections.catalog = { filter: "beta", query: "other search" };
    localStorage.setItem(key, JSON.stringify({ version: 1, library: libraryRoot, inputs }));
    await remount();
    expect(browsing.ui).toMatchObject({
      filter: "all",
      libraryReadiness: readiness,
      query: "kept search",
    });
    await act(async () => browsing.ui.setFilter({ version: 1, platforms: ["linux-x86-64"] }));
    await remount();
    expect(browsing.ui).toMatchObject({
      libraryReadiness: readiness,
      filter: { version: 1, platforms: ["linux-x86-64"] },
    });
    const saved = JSON.parse(localStorage.getItem(key)!) as {
      version: unknown;
      inputs: { sections: { catalog: unknown } };
    };
    expect(saved.version).toBe(2);
    expect(saved.inputs.sections.catalog).toEqual({ filter: "beta", query: "other search" });
  },
);

it("retains unknown readiness and unsupported declared predicates across restart until separate corrections", async () => {
  await act(async () => {
    browsing.ui.setLibraryReadiness("future-readiness");
    browsing.ui.setFilter({ version: 99, platforms: ["future-platform"] });
  });
  await remount();
  expect(browsing.ui).toMatchObject({
    libraryReadiness: "future-readiness",
    filter: { version: 99, platforms: ["future-platform"] },
  });
  await act(async () => browsing.ui.setLibraryReadiness("all"));
  expect(browsing.ui.filter).toEqual({ version: 99, platforms: ["future-platform"] });
  await act(async () => browsing.ui.setFilter("all"));
  expect(browsing.ui.libraryReadiness).toBe("all");
});

it("holds malformed query objects with conversion-shaped keys without coercing or throwing", async () => {
  const filter = { version: 1, toString: 42, platforms: ["linux-x86-64"] };
  await act(async () => browsing.ui.setFilter(filter));
  await remount();
  expect(browsing.ui.filter).toEqual(filter);
  expect(evaluateCatalogQuery([], browsing.ui.filter).state).toBe("unresolved");
  expect(browsing.preferenceFailure).toBeUndefined();
  await act(async () => browsing.ui.setFilter("all"));
  expect(browsing.ui.filter).toBe("all");
});

it("restores membership in its section/library without losing legacy or unsupported intent", async () => {
  await act(async () => browsing.ui.setView("catalog"));
  await act(async () => {
    browsing.ui.setFilter({
      version: 1,
      membership: ["not-in-library"],
      platforms: ["linux-x86-64"],
    });
    browsing.ui.setQuery("kept search");
    browsing.ui.setCatalogSort("name");
  });
  await act(async () => browsing.ui.setView("library"));
  await act(async () => browsing.ui.setFilter({ version: 1, membership: ["in-library"] }));
  await remount();
  expect(browsing.ui.filter).toEqual({ version: 1, membership: ["in-library"] });
  await act(async () => browsing.ui.setView("catalog"));
  expect(browsing.ui).toMatchObject({
    query: "kept search",
    catalogSort: "name",
    filter: { version: 1, membership: ["not-in-library"], platforms: ["linux-x86-64"] },
  });
  libraryRoot = "E:/other";
  await remount();
  expect(browsing.ui.filter).toBe("all");
  libraryRoot = "E:/first";
  await remount();
  await act(async () => browsing.ui.setView("catalog"));
  expect(browsing.ui.filter).toMatchObject({ membership: ["not-in-library"] });
  const key = libraryBrowsingPreferenceKey(libraryRoot);
  const stored = JSON.parse(localStorage.getItem(key)!) as {
    version: number;
    inputs: { sections: Record<string, { query?: string; filter: unknown }> };
  };
  stored.version = 1;
  stored.inputs.sections.library = { query: "legacy", filter: "setup" };
  fixtureValue(stored.inputs.sections.catalog, "stored catalog section").filter = {
    version: 1,
    membership: ["future-membership"],
  };
  localStorage.setItem(key, JSON.stringify(stored));
  await remount();
  await act(async () => browsing.ui.setView("catalog"));
  expect(evaluateCatalogQuery([], browsing.ui.filter).state).toBe("unresolved");
  expect(browsing.ui.filter).toMatchObject({ membership: ["future-membership"] });
  await act(async () => browsing.ui.setView("library"));
  expect(browsing.ui.libraryReadiness).toBe("setup");
  expect(browsing.ui.query).toBe("legacy");
});

it("persists attention independently by section/library and retains future reasons for correction", async () => {
  await act(async () =>
    browsing.ui.setFilter({ version: 1, attention: ["finish-setup"], channels: ["beta"] }),
  );
  await act(async () => browsing.ui.setLibraryReadiness("ready"));
  await act(async () => browsing.ui.setQuery("attention search"));
  await act(async () => browsing.ui.setView("catalog"));
  await act(async () => browsing.ui.setFilter({ version: 1, attention: ["missing-bios"] }));
  await remount();
  await act(async () => browsing.ui.setView("library"));
  expect(browsing.ui).toMatchObject({
    libraryReadiness: "ready",
    query: "attention search",
    filter: { attention: ["finish-setup"], channels: ["beta"] },
  });
  libraryRoot = "E:/other";
  await remount();
  expect(browsing.ui.filter).toBe("all");
  libraryRoot = "E:/first";
  await remount();
  await act(async () => browsing.ui.setView("catalog"));
  expect(browsing.ui.filter).toMatchObject({ attention: ["missing-bios"] });
  await act(async () => browsing.ui.setFilter({ version: 1, attention: ["future-reason"] }));
  await remount();
  await act(async () => browsing.ui.setView("catalog"));
  expect(evaluateCatalogQuery([], browsing.ui.filter).state).toBe("unresolved");
  expect(browsing.ui.filter).toMatchObject({ attention: ["future-reason"] });
  await act(async () => browsing.ui.setFilter("all"));
  expect(browsing.ui.filter).toBe("all");
});

it("persists version1 update choices by section/library and retains unknown candidates", async () => {
  await act(async () =>
    browsing.ui.setFilter({ version: 1, updates: ["staged"], attention: ["finish-setup"] }),
  );
  await act(async () => browsing.ui.setLibraryReadiness("ready"));
  await act(async () => browsing.ui.setView("catalog"));
  await act(async () =>
    browsing.ui.setFilter({ version: 1, updates: ["available"], channels: ["beta"] }),
  );
  await remount();
  await act(async () => browsing.ui.setView("library"));
  expect(browsing.ui).toMatchObject({
    libraryReadiness: "ready",
    filter: { updates: ["staged"], attention: ["finish-setup"] },
  });
  libraryRoot = "E:/other";
  await remount();
  expect(browsing.ui.filter).toBe("all");
  libraryRoot = "E:/first";
  await remount();
  await act(async () => browsing.ui.setView("catalog"));
  expect(browsing.ui.filter).toMatchObject({ updates: ["available"], channels: ["beta"] });
  await act(async () => browsing.ui.setFilter({ version: 1, updates: ["future-candidate"] }));
  await remount();
  await act(async () => browsing.ui.setView("catalog"));
  expect(evaluateCatalogQuery([], browsing.ui.filter).state).toBe("unresolved");
  expect(browsing.ui.filter).toMatchObject({ updates: ["future-candidate"] });
  await act(async () => browsing.ui.setFilter("all"));
  expect(browsing.ui.filter).toBe("all");
});

it.each([{ sort: ["recent"] }, { sort: { value: "recent" } }, { sort: 1 }])(
  "preserves malformed Library sort preferences for explicit recovery (%#)",
  async ({ sort }) => {
    const key = libraryBrowsingPreferenceKey(libraryRoot);
    const serialized = JSON.stringify({
      version: 2,
      library: libraryRoot,
      inputs: {
        ...browsing.ui.browsingInputs,
        sections: {
          ...browsing.ui.browsingInputs.sections,
          library: { query: "retained search", filter: "all", sort },
        },
      },
    });
    localStorage.setItem(key, serialized);
    await remount();
    expect(browsing.preferenceFailure).toBe("read");
    expect(localStorage.getItem(key)).toBe(serialized);
    expect(browsing.ui.librarySort).toBe("catalog");
  },
);
