// @vitest-environment jsdom
import { act, createElement, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useWorkspaceContinuity } from "./keyboard-shortcuts";
import type { WorkspaceBrowsingPositions } from "./keyboard-shortcuts";
import type { View } from "./view-model";

let root: Root;
let navigate: (view: View) => void;
let navigateFromDetail: (view: View, scrollTop: number, focusOrigin: string) => void;
let removeLibraryTarget: () => void;
let frames: FrameRequestCallback[];
let initialPositions: WorkspaceBrowsingPositions | undefined;
let capturePositions: () => WorkspaceBrowsingPositions;
let showLibraryTargetInitially: boolean;
let readyInitially: boolean;
let setReady: (ready: boolean) => void;

function Fixture() {
  const [view, setView] = useState<View>("library");
  const [showLibraryTarget, setShowLibraryTarget] = useState(showLibraryTargetInitially);
  const [ready, updateReady] = useState(readyInitially);
  setReady = updateReady;
  const { browsingPositions, switchView, workspace } = useWorkspaceContinuity(
    view,
    initialPositions,
    true,
    ready,
  );
  capturePositions = browsingPositions;
  navigate = (nextView) => switchView(nextView, () => setView(nextView));
  navigateFromDetail = (nextView, scrollTop, focusOrigin) =>
    switchView(nextView, () => setView(nextView), { scrollTop, focusOrigin });
  removeLibraryTarget = () => setShowLibraryTarget(false);
  return createElement(
    "div",
    null,
    createElement("nav", null, createElement("button", { id: "sidebar-settings" }, "Settings")),
    createElement(
      "main",
      { ref: workspace, "data-focus-region": "workspace" },
      createElement("input", { id: `${view}-search`, "aria-label": `Search ${view}` }),
      view === "library" && showLibraryTarget
        ? createElement("button", { "data-detail-origin": "library:card:lighthouse" }, "Lighthouse")
        : view === "catalog" && ready
          ? createElement("button", { id: "catalog-card-celeste" }, "Celeste")
          : null,
    ),
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
  initialPositions = undefined;
  showLibraryTargetInitially = true;
  readyInitially = true;
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

  it("restores per-section position after a library remount and falls back if its card vanished", async () => {
    const workspace = document.querySelector<HTMLElement>("main")!;
    const libraryCard = document.querySelector<HTMLButtonElement>("[data-detail-origin]")!;
    workspace.scrollTop = 120;
    libraryCard.focus();
    await act(async () => navigate("catalog"));
    await flushFrame();
    workspace.scrollTop = 42;
    document.getElementById("catalog-card-celeste")!.focus();
    initialPositions = capturePositions();

    const host = document.body.firstElementChild!;
    await act(async () => root.unmount());
    root = createRoot(host);
    showLibraryTargetInitially = false;
    await act(async () => root.render(createElement(Fixture)));
    await flushFrame();
    await act(async () => navigate("catalog"));
    await flushFrame();
    expect(document.querySelector<HTMLElement>("main")?.scrollTop).toBe(42);
    expect(document.activeElement?.id).toBe("catalog-card-celeste");

    await act(async () => navigate("library"));
    await flushFrame();
    expect(document.querySelector<HTMLElement>("main")?.scrollTop).toBe(120);
    expect(document.activeElement?.id).toBe("library-search");
  });

  it("waits for saved catalog cards before restoring their focus and scroll", async () => {
    const host = document.body.firstElementChild!;
    await act(async () => root.unmount());
    root = createRoot(host);
    readyInitially = false;
    initialPositions = {
      catalog: { scrollTop: 84, focus: { kind: "id", value: "catalog-card-celeste" } },
    };
    await act(async () => root.render(createElement(Fixture)));
    await act(async () => navigate("catalog"));
    await flushFrame();
    expect(document.getElementById("catalog-card-celeste")).toBeNull();
    expect(document.querySelector<HTMLElement>("main")?.scrollTop).toBe(0);

    await act(async () => setReady(true));
    await flushFrame();
    expect(document.querySelector<HTMLElement>("main")?.scrollTop).toBe(84);
    expect(document.activeElement?.id).toBe("catalog-card-celeste");
  });

  it("does not override a user's focus while saved catalog cards load", async () => {
    const host = document.body.firstElementChild!;
    await act(async () => root.unmount());
    root = createRoot(host);
    readyInitially = false;
    initialPositions = {
      catalog: { scrollTop: 84, focus: { kind: "id", value: "catalog-card-celeste" } },
    };
    await act(async () => root.render(createElement(Fixture)));
    await act(async () => navigate("catalog"));
    await flushFrame();
    document.getElementById("catalog-search")!.focus();

    await act(async () => setReady(true));
    expect(document.activeElement?.id).toBe("catalog-search");
    expect(document.querySelector<HTMLElement>("main")?.scrollTop).toBe(0);
  });

  it("cancels a pending restore when focus moves to the sidebar while cards load", async () => {
    const host = document.body.firstElementChild!;
    await act(async () => root.unmount());
    root = createRoot(host);
    readyInitially = false;
    initialPositions = {
      catalog: { scrollTop: 84, focus: { kind: "id", value: "catalog-card-celeste" } },
    };
    await act(async () => root.render(createElement(Fixture)));
    document.getElementById("library-search")!.focus();
    await act(async () => navigate("catalog"));
    await flushFrame();
    document.getElementById("sidebar-settings")!.focus();

    await act(async () => setReady(true));
    expect(document.activeElement?.id).toBe("sidebar-settings");
    expect(document.querySelector<HTMLElement>("main")?.scrollTop).toBe(0);
  });

  it("cancels a pending restore when focus moves after data is ready but before the frame", async () => {
    const host = document.body.firstElementChild!;
    await act(async () => root.unmount());
    root = createRoot(host);
    readyInitially = false;
    initialPositions = {
      catalog: { scrollTop: 84, focus: { kind: "id", value: "catalog-card-celeste" } },
    };
    await act(async () => root.render(createElement(Fixture)));
    document.getElementById("library-search")!.focus();
    await act(async () => navigate("catalog"));
    await flushFrame();
    await act(async () => setReady(true));
    document.getElementById("sidebar-settings")!.focus();
    await flushFrame();

    expect(document.activeElement?.id).toBe("sidebar-settings");
    expect(document.querySelector<HTMLElement>("main")?.scrollTop).toBe(0);
  });
});
