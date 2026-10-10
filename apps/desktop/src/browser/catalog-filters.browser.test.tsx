import { DirectionProvider } from "@base-ui/react/direction-provider";
import { useEffect, useState } from "react";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { page, userEvent } from "vitest/browser";
import { PortBrowser } from "../components/PortBrowser";
import {
  useLibraryBrowsingContext,
  libraryBrowsingPreferenceKey,
} from "../features/app-shell/use-library-browsing-context";
import { portDefinition } from "../test-fixtures";
import { filterPorts, summarizeLibrary } from "../view-model";
import "../styles.css";
const invoke = vi.hoisted(() => vi.fn(async () => null));
vi.mock("../api", () => ({ desktopApi: new Proxy({}, { get: () => invoke }) }));
const ports = [
  {
    ...portDefinition(),
    id: "windows",
    name: "Windows game",
    platforms: ["windows-x86-64"] as const,
    channels: ["stable"] as const,
  },
  {
    ...portDefinition(),
    id: "linux",
    name: "Linux game",
    platforms: ["linux-x86-64"] as const,
    channels: ["beta"] as const,
  },
  {
    ...portDefinition(),
    id: "both",
    name: "Both game",
    platforms: ["windows-x86-64", "linux-x86-64"] as const,
    channels: ["stable", "beta"] as const,
  },
].map((port) => ({ ...port, platforms: [...port.platforms], channels: [...port.channels] }));
const statuses = new Map();
const remember = () => {};
const switchLibrary = async () => {};
let host: HTMLDivElement;
let root: Root;
function Session({ library }: { library: string }) {
  const browsing = useLibraryBrowsingContext({
    root: library,
    remember,
    switchLibrary,
    resetLibrary: switchLibrary,
    ready: false,
  });
  const ui = browsing.ui;
  const [detail, setDetail] = useState(false);
  useEffect(() => {
    ui.setView("catalog");
  }, [ui.setView]);
  return (
    <main ref={browsing.workspace}>
      <label>
        Search catalog
        <input value={ui.query} onChange={(event) => ui.setQuery(event.target.value)} />
      </label>
      {detail ? (
        <button onClick={() => setDetail(false)}>Back to catalog</button>
      ) : (
        <PortBrowser
          view="catalog"
          ports={filterPorts(ports, statuses, "catalog", ui.filter, ui.query, ui.catalogSort)}
          catalogFilterCandidates={filterPorts(ports, statuses, "catalog", "all", ui.query)}
          statuses={statuses}
          overview={summarizeLibrary(ports, statuses)}
          filter={ui.filter}
          query={ui.query}
          catalogSort={ui.catalogSort}
          setCatalogSort={ui.setCatalogSort}
          setFilter={ui.setFilter}
          onSelect={() => setDetail(true)}
          clearFilters={() => {
            ui.setFilter("all");
            ui.setQuery("");
          }}
          loading={false}
        />
      )}
    </main>
  );
}
function Fixture() {
  const [library, setLibrary] = useState("/filters-library-a");
  return (
    <DirectionProvider direction="ltr">
      <button
        onClick={() =>
          setLibrary((current) =>
            current.endsWith("a") ? "/filters-library-b" : "/filters-library-a",
          )
        }
      >
        Switch library
      </button>
      <Session key={library} library={library} />
    </DirectionProvider>
  );
}
beforeEach(() => {
  localStorage.clear();
  invoke.mockClear();
  host = document.body.appendChild(document.createElement("div"));
  root = createRoot(host);
});
afterEach(() => {
  flushSync(() => root.unmount());
  host.remove();
  delete document.documentElement.dataset.theme;
  localStorage.clear();
});
const roleButton = (name: string) => page.getByRole("button", { name, exact: true });
it.each(["dark", "light"])(
  "composes Catalog constraints, keyboard return and persisted library context in %s",
  async (theme) => {
    await page.viewport(960, 720);
    document.documentElement.dataset.theme = theme;
    flushSync(() => root.render(<Fixture />));
    await userEvent.click(roleButton("Filters (0)"));
    await userEvent.click(roleButton("Windows (2)"));
    await userEvent.click(roleButton("Preview (1)"));
    await expect.element(roleButton("Linux (2)")).toBeEnabled();
    await userEvent.click(roleButton("Linux (2)"));
    await userEvent.click(roleButton("Linux (2)"));
    await userEvent.keyboard("{Escape}");
    await expect.element(page.getByRole("dialog")).not.toBeInTheDocument();
    expect(document.activeElement?.textContent).toContain("Filters (2)");
    await expect.element(roleButton("Remove Windows filter")).toBeInTheDocument();
    await expect.element(roleButton("Remove Preview filter")).toBeInTheDocument();
    await userEvent.click(page.getByRole("button", { name: /^Both game\. Setup/ }));
    await userEvent.click(roleButton("Back to catalog"));
    await expect.element(roleButton("Remove Windows filter")).toBeInTheDocument();
    flushSync(() => root.unmount());
    root = createRoot(host);
    flushSync(() => root.render(<Fixture />));
    await expect.element(roleButton("Remove Preview filter")).toBeInTheDocument();
    await userEvent.click(roleButton("Switch library"));
    await expect.element(roleButton("Filters (0)")).toBeInTheDocument();
    await userEvent.click(roleButton("Switch library"));
    await expect.element(roleButton("Filters (2)")).toBeInTheDocument();
    await userEvent.fill(page.getByRole("textbox", { name: "Search catalog" }), "no match");
    await userEvent.click(roleButton("Filters (2)"));
    await expect.element(roleButton("Windows (0)")).toBeEnabled();
    await userEvent.click(roleButton("Windows (0)"));
    await expect.element(roleButton("Preview (0)")).toBeEnabled();
    await userEvent.keyboard("{Escape}");
    const chip = document.querySelector<HTMLButtonElement>(
      'button[aria-label="Remove Preview filter"]',
    )!;
    chip.focus();
    await userEvent.keyboard("{Enter}");
    expect(document.activeElement?.textContent).toContain("Filters (0)");
    expect(invoke).not.toHaveBeenCalled();
  },
);
it("retains unsupported persisted intent until explicit reset", async () => {
  flushSync(() => root.render(<Fixture />));
  await expect.element(roleButton("Filters (0)")).toBeInTheDocument();
  const key = libraryBrowsingPreferenceKey("/filters-library-a");
  await userEvent.click(roleButton("Stable"));
  const stored = JSON.parse(localStorage.getItem(key)!);
  stored.inputs.sections.catalog.filter = { version: 999, platforms: ["future"] };
  localStorage.setItem(key, JSON.stringify(stored));
  flushSync(() => root.unmount());
  root = createRoot(host);
  flushSync(() => root.render(<Fixture />));
  await userEvent.click(roleButton("Filters (0)"));
  await expect.element(roleButton("Windows (unavailable)")).toBeDisabled();
  expect(JSON.parse(localStorage.getItem(key)!).inputs.sections.catalog.filter.version).toBe(999);
  await userEvent.click(roleButton("Reset catalog filters"));
  await expect.element(roleButton("Windows (2)")).toBeEnabled();
  await userEvent.keyboard("{Escape}");
  await expect.element(roleButton("Filters (0)")).toBeInTheDocument();
});
