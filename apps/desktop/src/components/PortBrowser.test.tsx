// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { portDefinition } from "../test-fixtures";
import { focusableControls } from "../focus";
import { PortBrowser } from "./PortBrowser";

describe("Library card overflow", () => {
  let host: HTMLDivElement;
  let root: ReturnType<typeof createRoot>;

  beforeEach(() => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    HTMLElement.prototype.scrollIntoView = vi.fn();
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    host.remove();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("offers bounded update and save destinations without nesting card controls", async () => {
    const port = portDefinition();
    const onSelect = vi.fn();
    await act(async () =>
      root.render(
        <PortBrowser
          view="library"
          ports={[port]}
          statuses={new Map()}
          overview={{ installed: 1, ready: 0, needsSetup: 1, staged: 0 }}
          filter="all"
          setFilter={vi.fn()}
          onSelect={onSelect}
          loading={false}
        />,
      ),
    );
    const more = document.body.querySelector<HTMLButtonElement>(
      `button[aria-label="More actions for ${port.name}"]`,
    )!;
    expect(more.closest("button button, button a, a button")).toBeNull();
    expect(more.dataset.detailOrigin).toBe(`library:card-more:${port.id}`);

    await act(async () => more.click());
    const menu = document.body.querySelector('[role="menu"]');
    expect(menu).not.toBeNull();
    vi.spyOn(HTMLElement.prototype, "getClientRects").mockImplementation(
      () => [new DOMRect(0, 0, 100, 20)] as unknown as DOMRectList,
    );
    expect(focusableControls(menu as HTMLElement).map((item) => item.textContent)).toEqual([
      "Updates and activity",
      "Saves and storage",
    ]);
    const updates = [...document.body.querySelectorAll<HTMLElement>('[role="menuitem"]')].find(
      (item) => item.textContent === "Updates and activity",
    )!;
    expect(updates).toBeDefined();
    await act(async () => updates.click());
    expect(onSelect).toHaveBeenCalledWith(port.id, `library:card-more:${port.id}`, "updates");

    await act(async () => more.click());
    const saves = [...document.body.querySelectorAll<HTMLElement>('[role="menuitem"]')].find(
      (item) => item.textContent === "Saves and storage",
    )!;
    await act(async () => saves.click());
    expect(onSelect).toHaveBeenCalledWith(port.id, `library:card-more:${port.id}`, "saves");
  });
});
