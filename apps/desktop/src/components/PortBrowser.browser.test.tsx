import { act, useState } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { portDefinition, installedLaunchStatus } from "../test-fixtures";
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
      "Saves & backups",
    ]);
    const updates = [...document.body.querySelectorAll<HTMLElement>('[role="menuitem"]')].find(
      (item) => item.textContent === "Updates and activity",
    )!;
    expect(updates).toBeDefined();
    await act(async () => updates.click());
    expect(onSelect).toHaveBeenCalledWith(port.id, `library:card-more:${port.id}`, "updates");

    await act(async () => more.click());
    const saves = [...document.body.querySelectorAll<HTMLElement>('[role="menuitem"]')].find(
      (item) => item.textContent === "Saves & backups",
    )!;
    await act(async () => saves.click());
    expect(onSelect).toHaveBeenCalledWith(port.id, `library:card-more:${port.id}`, "saves");
  });

  it("routes a recorded input blocker directly to file review without launching", async () => {
    const port = portDefinition();
    const status = installedLaunchStatus({
      launchable: false,
      pending_setup: false,
      blockers: ["changed_source"],
      source: "changed",
    });
    const select = vi.fn();
    const launch = vi.fn();
    await act(async () =>
      root.render(
        <PortBrowser
          view="library"
          ports={[port]}
          statuses={new Map([[port.id, status]])}
          overview={{ installed: 1, ready: 0, needsSetup: 1, staged: 0 }}
          filter="all"
          setFilter={vi.fn()}
          onSelect={select}
          onContinue={launch}
          loading={false}
        />,
      ),
    );
    const review = [...host.querySelectorAll<HTMLButtonElement>("button")].find((button) =>
      button.getAttribute("aria-label")?.startsWith("Set up:"),
    );
    expect(review).toBeDefined();
    await act(async () => review!.click());
    expect(select).toHaveBeenCalledExactlyOnceWith(
      port.id,
      `library:card:${port.id}:review`,
      "files",
    );
    expect(launch).not.toHaveBeenCalled();
  });
});

describe("Library empty browsing context", () => {
  let host: HTMLDivElement;
  let root: ReturnType<typeof createRoot>;

  it("returns reset focus to search without losing restored results", async () => {
    function ResetContext() {
      const [query, setQuery] = useState("missing");
      return (
        <>
          <input
            id="port-search"
            aria-label="Search library"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
          />
          <PortBrowser
            view="library"
            ports={query ? [] : [portDefinition()]}
            statuses={new Map()}
            overview={{ installed: 1, ready: 0, needsSetup: 1, staged: 0 }}
            filter="all"
            query={query}
            setFilter={vi.fn()}
            onSelect={vi.fn()}
            clearFilters={() => setQuery("")}
            loading={false}
          />
        </>
      );
    }
    await act(async () => root.render(<ResetContext />));
    const clear = [...host.querySelectorAll("button")].find((button) =>
      button.textContent?.includes("Reset view"),
    )!;
    await act(async () => {
      clear.focus();
      clear.click();
    });
    await act(async () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve())));
    expect(document.activeElement).toBe(host.querySelector("#port-search"));
    expect(host.textContent).toContain(portDefinition().name);
  });

  beforeEach(() => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    host.remove();
    vi.unstubAllGlobals();
  });

  it("offers optional folder connection on the initial catalog without hiding browsing", async () => {
    const connect = vi.fn();
    const select = vi.fn();
    const port = portDefinition();
    const render = async (installed: number, loading = false) =>
      act(async () =>
        root.render(
          <PortBrowser
            view="catalog"
            ports={[port]}
            statuses={new Map()}
            overview={{ installed, ready: 0, needsSetup: 0, staged: 0 }}
            filter="all"
            setFilter={vi.fn()}
            onSelect={select}
            onConnectGameFiles={connect}
            loading={loading}
          />,
        ),
      );
    await render(0);
    const introduction = host.querySelector('[aria-label="Connect your game files"]')!;
    expect(introduction.textContent).toContain("Your originals stay in place");
    await act(async () => introduction.querySelector<HTMLButtonElement>("button")!.click());
    expect(connect).toHaveBeenCalledOnce();
    expect(select).not.toHaveBeenCalled();
    expect(host.textContent).toContain(port.name);
    await render(1);
    expect(host.querySelector('[aria-label="Connect your game files"]')).toBeNull();
    await render(0, true);
    expect(host.querySelector('[aria-label="Connect your game files"]')).toBeNull();
  });

  it("offers clear filters for an empty library with an active search or filter", async () => {
    const clearFilters = vi.fn();
    const connectGameFiles = vi.fn();
    const render = async (filter: "all" | "ready", query: string) => {
      await act(async () =>
        root.render(
          <PortBrowser
            view="library"
            ports={[]}
            statuses={new Map()}
            overview={{ installed: 0, ready: 0, needsSetup: 0, staged: 0 }}
            filter={filter}
            query={query}
            setFilter={vi.fn()}
            onSelect={vi.fn()}
            clearFilters={clearFilters}
            onConnectGameFiles={connectGameFiles}
            loading={false}
          />,
        ),
      );
    };

    await render("all", "unmatched title");
    const resultStatus = host.querySelector('[role="status"]');
    expect(resultStatus?.textContent).toBe("0 library entries");
    expect(host.querySelector('[aria-label="Library readiness"]')).toBeNull();
    expect(host.textContent).toContain("No matching library entries");
    expect(host.textContent).toContain(
      "No library entries match “unmatched title” with the current view.",
    );
    expect(host.textContent).not.toContain("Your installed ports are still in this library");
    await act(async () =>
      [...host.querySelectorAll("button")]
        .find((button) => button.textContent?.includes("Reset view"))!
        .click(),
    );
    expect(clearFilters).toHaveBeenCalledOnce();

    await render("ready", "");
    expect(host.textContent).toContain("No matching library entries");

    await render("all", "   ");
    expect(host.querySelector('[role="status"]')).toBe(resultStatus);
    expect(resultStatus?.textContent).toBe("Your library is empty.");
    expect(host.querySelector('[aria-label="Library readiness"]')).toBeNull();
    expect(host.textContent).toContain("Your library is empty");
    expect(host.textContent).toContain("Connect game-file folder");
    await act(async () =>
      [...host.querySelectorAll("button")]
        .find((button) => button.textContent?.includes("Connect game-file folder"))!
        .click(),
    );
    expect(connectGameFiles).toHaveBeenCalledOnce();
    expect(host.textContent).toContain("copy a supported installation");
    expect(host.textContent).not.toContain("Reset view");
  });
});
