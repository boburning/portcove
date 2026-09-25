// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useAppShellState } from "./use-app-shell-state";
import type { BrowsingInputs } from "./use-app-shell-state";

let root: Root;
let host: HTMLDivElement;
let state: ReturnType<typeof useAppShellState>;
let initialInputs: BrowsingInputs | undefined;

function Fixture() {
  state = useAppShellState("library", initialInputs);
  return null;
}

beforeEach(async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  initialInputs = undefined;
  host = document.createElement("div");
  root = createRoot(host);
  await act(async () => root.render(createElement(Fixture)));
});

afterEach(async () => {
  await act(async () => root.unmount());
  vi.unstubAllGlobals();
});

describe("app shell state", () => {
  it("starts with the library and neutral transient inputs", () => {
    expect(state).toMatchObject({
      view: "library",
      filter: "all",
      query: "",
      catalogSort: "catalog",
      selectedId: undefined,
      sourcePath: "",
      biosPath: "",
      adoptOpen: false,
      adoptPath: "",
    });
  });

  it("preserves independent Library and Catalog browsing inputs", async () => {
    await act(async () => {
      state.setFilter("ready");
      state.setQuery("installed");
      state.setSelectedId("lighthouse");
    });
    expect(state.filter).toBe("ready");

    await act(async () =>
      state.setView((current) => (current === "library" ? "catalog" : current)),
    );

    expect(state.view).toBe("catalog");
    expect(state.filter).toBe("all");
    expect(state.query).toBe("");
    expect(state.selectedId).toBeUndefined();

    await act(async () => {
      state.setFilter("beta");
      state.setQuery("discover");
      state.setCatalogSort("installed-first");
      state.setView("library");
    });

    expect(state.view).toBe("library");
    expect(state.filter).toBe("ready");
    expect(state.query).toBe("installed");

    await act(async () => state.setView("catalog"));
    expect(state.filter).toBe("beta");
    expect(state.query).toBe("discover");
    expect(state.catalogSort).toBe("installed-first");
  });

  it("keeps independent shell inputs available to their owning surfaces", async () => {
    await act(async () => {
      state.setQuery("lighthouse");
      state.setSelectedId("lighthouse");
      state.setSourcePath("D:/games/source.iso");
      state.setBiosPath("D:/bios/system.bin");
      state.setAdoptOpen(true);
      state.setAdoptPath("D:/existing-port");
    });

    expect(state).toMatchObject({
      query: "lighthouse",
      selectedId: "lighthouse",
      sourcePath: "D:/games/source.iso",
      biosPath: "D:/bios/system.bin",
      adoptOpen: true,
      adoptPath: "D:/existing-port",
    });
  });

  it("restores only browsing inputs after a library generation remount", async () => {
    await act(async () => {
      state.setFilter("ready");
      state.setQuery("my ports");
      state.setSelectedId("old-detail");
      state.setAdoptOpen(true);
      state.setSourcePath("D:/old-source.iso");
      state.setView("catalog");
    });
    await act(async () => {
      state.setFilter("beta");
      state.setQuery("new ports");
      state.setCatalogSort("installed-first");
    });
    initialInputs = state.browsingInputs;
    await act(async () => root.unmount());
    root = createRoot(host);
    await act(async () => root.render(createElement(Fixture)));

    expect(state).toMatchObject({
      view: "library",
      filter: "ready",
      query: "my ports",
      selectedId: undefined,
      adoptOpen: false,
      sourcePath: "",
    });
    await act(async () => state.setView("catalog"));
    expect(state).toMatchObject({
      filter: "beta",
      query: "new ports",
      catalogSort: "installed-first",
    });
  });
});
