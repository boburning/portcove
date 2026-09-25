// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  libraryBrowsingKey,
  useLibraryBrowsingContext,
  type LibraryBrowsingContext,
} from "./use-library-browsing-context";

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
  vi.unstubAllGlobals();
  window.localStorage.clear();
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
