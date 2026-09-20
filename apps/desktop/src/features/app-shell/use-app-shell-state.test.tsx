// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useAppShellState } from "./use-app-shell-state";

let root: Root;
let state: ReturnType<typeof useAppShellState>;

function Fixture() {
  state = useAppShellState();
  return null;
}

beforeEach(async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  root = createRoot(document.createElement("div"));
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
      selectedId: undefined,
      sourcePath: "",
      biosPath: "",
      adoptOpen: false,
      adoptPath: "",
    });
  });

  it("resets the library filter whenever the primary view changes", async () => {
    await act(async () => state.setFilter("ready"));
    expect(state.filter).toBe("ready");

    await act(async () =>
      state.setView((current) => (current === "library" ? "catalog" : current)),
    );

    expect(state.view).toBe("catalog");
    expect(state.filter).toBe("all");
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
});
