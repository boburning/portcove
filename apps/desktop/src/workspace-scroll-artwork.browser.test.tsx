import { act, createElement, useRef, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it } from "vite-plus/test";
import { useWorkspaceReflow } from "./workspace-scroll";

let root: Root;
let showNotice: () => void;
let setMenu: (open: boolean) => void;

function Fixture() {
  const workspace = useRef<HTMLElement>(null);
  const [notice, updateNotice] = useState(false);
  const [menu, updateMenu] = useState(false);
  showNotice = () => updateNotice(true);
  setMenu = updateMenu;
  useWorkspaceReflow(workspace);
  return (
    <>
      <main
        ref={workspace}
        data-focus-region="workspace"
        style={{ height: 180, width: 420, overflow: "auto" }}
      >
        <h1>Library</h1>
        <div style={{ height: 500 }} />
        <article className="collection-entry" style={{ padding: 12 }}>
          <div style={{ height: 80 }}>Artwork</div>
          <h2>Game and port</h2>
          {notice && <p style={{ height: 96 }}>Image unavailable</p>}
          <button type="button" data-detail-origin="library:card-more:owned" style={{ height: 36 }}>
            More actions
          </button>
        </article>
        <div style={{ height: 500 }} />
      </main>
      {menu && (
        <section data-portcove-focus-scope style={{ position: "fixed", top: 0 }}>
          <button type="button" id="menu-item">
            View details
          </button>
        </section>
      )}
    </>
  );
}

async function settle() {
  await act(async () => {
    await new Promise(requestAnimationFrame);
    await new Promise(requestAnimationFrame);
    await new Promise(requestAnimationFrame);
  });
}

function controls() {
  return {
    workspace: document.querySelector<HTMLElement>("main")!,
    more: document.querySelector<HTMLButtonElement>("[data-detail-origin]")!,
  };
}

function expectVisible() {
  const { workspace, more } = controls();
  const viewport = workspace.getBoundingClientRect();
  const action = more.getBoundingClientRect();
  expect(action.top).toBeGreaterThanOrEqual(viewport.top);
  expect(action.bottom).toBeLessThanOrEqual(viewport.bottom + 1);
  expect(document.activeElement).toBe(more);
}

beforeEach(async () => {
  const host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  await act(async () => root.render(createElement(Fixture)));
  const { more } = controls();
  more.scrollIntoView({ block: "end" });
  more.focus({ preventScroll: true });
  await settle();
  expectVisible();
});

afterEach(async () => {
  await act(async () => root.unmount());
  document.body.replaceChildren();
});

it("reveals the same focused Library action when late artwork feedback grows its card", async () => {
  const { workspace } = controls();
  const before = workspace.scrollTop;
  await act(async () => showNotice());
  await settle();
  expectVisible();
  expect(workspace.scrollTop).toBeGreaterThan(before);
});

it("preserves overlay focus and reveals the exact action on menu return after feedback", async () => {
  const { workspace, more } = controls();
  await act(async () => setMenu(true));
  const menu = document.getElementById("menu-item")!;
  menu.focus();
  const before = workspace.scrollTop;
  await act(async () => showNotice());
  await settle();
  expect(document.activeElement).toBe(menu);
  expect(workspace.scrollTop).toBe(before);
  await act(async () => setMenu(false));
  more.focus({ preventScroll: true });
  await settle();
  expectVisible();
});

it("does not pull an intentionally scrolled-away focused action back after artwork feedback", async () => {
  const { workspace, more } = controls();
  workspace.dispatchEvent(new WheelEvent("wheel", { bubbles: true, deltaY: -500 }));
  workspace.scrollTo({ top: 0 });
  await settle();
  expect(more.getBoundingClientRect().top).toBeGreaterThan(
    workspace.getBoundingClientRect().bottom,
  );
  await act(async () => showNotice());
  await settle();
  expect(workspace.scrollTop).toBe(0);
  expect(document.activeElement).toBe(more);
});
