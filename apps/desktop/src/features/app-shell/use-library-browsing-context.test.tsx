// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  libraryBrowsingKey,
  libraryBrowsingPreferenceKey,
  useLibraryBrowsingContext,
  type LibraryBrowsingContext,
} from "./use-library-browsing-context";
import { evaluateCatalogQuery } from "../browsing/catalog-query";
import { desktopApi } from "../../api";

it("uses one browsing key for regular and namespaced Windows paths", () => {
  expect(libraryBrowsingKey("E:\\Library")).toBe("E:\\Library");
  expect(libraryBrowsingKey("\\\\?\\E:\\Library")).toBe("E:\\Library");
  expect(libraryBrowsingKey("\\\\?\\UNC\\server\\share")).toBe("\\\\server\\share");
});

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
    { ref: browsing.workspace },
    createElement("input", { id: "search" }),
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
    browsing.ui.setFilter("ready");
    browsing.ui.setSourcePath("private-game-path");
    browsing.ui.setBiosPath("private-bios-path");
    browsing.ui.setAdoptPath("private-adoption-path");
    browsing.ui.setAdoptOpen(true);
    browsing.ui.setSelectedId("selected-detail");
  });
  await act(async () => browsing.ui.setView("catalog"));
  const filter = { version: 1, channels: ["stable", "beta"] };
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
    filter: "ready",
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
  expect(browsing.ui).toMatchObject({ filter: "setup", query: "current memory" });
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
  expect(browsing.ui.filter).toBe("ready");
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
  expect(browsing.ui).toMatchObject({ query: "session only", filter: "ready" });
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
  expect(remember.mock.calls[0][0]).toBe("E:/first");
  const saved = remember.mock.calls[0][1];
  expect(saved.inputs.sections.library).toEqual({ filter: "ready", query: "saved search" });
  expect(saved.positions.library).toEqual({ focus: undefined, scrollTop: 72 });
  libraryRoot = "E:/second";
  await remount();
  expect(browsing.ui).toMatchObject({ query: "", selectedId: undefined, adoptOpen: false });

  libraryRoot = "E:/first";
  initial = saved;
  await remount();
  expect(browsing.ui).toMatchObject({
    query: "saved search",
    filter: "ready",
    selectedId: undefined,
    adoptOpen: false,
  });
  await act(async () => browsing.resetLibraryWithContext());
  expect(resetLibrary).toHaveBeenCalledTimes(1);
  expect(remember.mock.lastCall?.[0]).toBe("E:/first");
});
