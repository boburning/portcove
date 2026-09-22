// @vitest-environment jsdom
import { act, createElement, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useWorkspaceContinuity } from "./keyboard-shortcuts";
import type { View } from "./view-model";

let root: Root;
let navigate: (view: View) => void;
let navigateFromDetail: (view: View, scrollTop: number, focusOrigin: string) => void;
let removeLibraryTarget: () => void;
let frames: FrameRequestCallback[];

function Fixture() {
  const [view, setView] = useState<View>("library");
  const [showLibraryTarget, setShowLibraryTarget] = useState(true);
  const { switchView, workspace } = useWorkspaceContinuity(view);
  navigate = (nextView) => switchView(nextView, () => setView(nextView));
  navigateFromDetail = (nextView, scrollTop, focusOrigin) =>
    switchView(nextView, () => setView(nextView), { scrollTop, focusOrigin });
  removeLibraryTarget = () => setShowLibraryTarget(false);
  return createElement(
    "main",
    { ref: workspace, "data-focus-region": "workspace" },
    createElement("input", { id: `${view}-search`, "aria-label": `Search ${view}` }),
    view === "library" && showLibraryTarget
      ? createElement("button", { "data-detail-origin": "library:card:lighthouse" }, "Lighthouse")
      : view === "catalog"
        ? createElement("button", { id: "catalog-card-celeste" }, "Celeste")
        : null,
  );
}

async function flushFrame() {
  const callback = frames.shift();
  expect(callback).toBeDefined();
  await act(async () => callback?.(0));
}

beforeEach(async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  frames = [];
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
    frames.push(callback);
    return frames.length;
  });
  Object.defineProperty(HTMLElement.prototype, "getClientRects", {
    configurable: true,
    value: () => ({ length: 1 }),
  });
  Object.defineProperty(HTMLElement.prototype, "scrollIntoView", {
    configurable: true,
    value: vi.fn(),
  });
  Object.defineProperty(HTMLElement.prototype, "scrollTo", {
    configurable: true,
    value(this: HTMLElement, options: ScrollToOptions) {
      this.scrollTop = options.top ?? 0;
    },
  });
  const host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  await act(async () => root.render(createElement(Fixture)));
});

afterEach(async () => {
  await act(async () => root.unmount());
  document.body.replaceChildren();
  vi.unstubAllGlobals();
});

describe("workspace continuity", () => {
  it("restores each view's scroll and stable focus identity", async () => {
    const workspace = document.querySelector<HTMLElement>("main")!;
    const libraryCard = document.querySelector<HTMLButtonElement>("[data-detail-origin]")!;
    workspace.scrollTop = 120;
    libraryCard.focus();

    await act(async () => navigate("catalog"));
    await flushFrame();
    expect(workspace.scrollTop).toBe(0);

    workspace.scrollTop = 42;
    document.getElementById("catalog-card-celeste")!.focus();
    await act(async () => navigate("library"));
    await flushFrame();
    expect(workspace.scrollTop).toBe(120);
    expect(document.activeElement?.getAttribute("data-detail-origin")).toBe(
      "library:card:lighthouse",
    );

    await act(async () => navigate("catalog"));
    await flushFrame();
    expect(workspace.scrollTop).toBe(42);
    expect(document.activeElement?.id).toBe("catalog-card-celeste");
  });

  it("falls back to the returning view when the prior focus target disappeared", async () => {
    document.querySelector<HTMLButtonElement>("[data-detail-origin]")!.focus();
    await act(async () => navigate("catalog"));
    await flushFrame();
    await act(async () => removeLibraryTarget());

    await act(async () => navigate("library"));
    await flushFrame();

    expect(document.activeElement?.id).toBe("library-search");
  });

  it("retains the browser return point when navigation leaves an open detail", async () => {
    const workspace = document.querySelector<HTMLElement>("main")!;
    workspace.scrollTop = 0;

    await act(async () => navigateFromDetail("catalog", 96, "library:card:lighthouse"));
    await flushFrame();
    await act(async () => navigate("library"));
    await flushFrame();

    expect(workspace.scrollTop).toBe(96);
    expect(document.activeElement?.getAttribute("data-detail-origin")).toBe(
      "library:card:lighthouse",
    );
  });

  it("restores the browser return point when the active view is selected from detail", async () => {
    const workspace = document.querySelector<HTMLElement>("main")!;
    workspace.scrollTop = 0;

    await act(async () => navigateFromDetail("library", 88, "library:card:lighthouse"));
    await flushFrame();

    expect(workspace.scrollTop).toBe(88);
    expect(document.activeElement?.getAttribute("data-detail-origin")).toBe(
      "library:card:lighthouse",
    );
  });
});
