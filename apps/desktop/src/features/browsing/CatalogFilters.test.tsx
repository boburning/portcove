// @vitest-environment jsdom
import { act, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { CatalogFilters } from "./CatalogFilters";
import type { CatalogQuery } from "./catalog-query";
import { portDefinition } from "../../test-fixtures";
import { filterPorts, type Filter } from "../../view-model";

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
let host: HTMLDivElement;
let root: Root;
let current: Filter | CatalogQuery;
let setQuery: (value: string) => void;
let setFavoritesOnly: (value: boolean) => void;
function Fixture({ initial = "all" }: { initial?: Filter | CatalogQuery }) {
  const [filter, setFilter] = useState(initial);
  const [search, searchSetter] = useState("");
  const [favoriteOnly, favoriteSetter] = useState(false);
  current = filter;
  setQuery = searchSetter;
  setFavoritesOnly = favoriteSetter;
  const candidates = filterPorts(ports, new Map(), "catalog", "all", search).filter(
    (port) => !favoriteOnly || port.id === "both",
  );
  return <CatalogFilters candidates={candidates} filter={filter} setFilter={setFilter} />;
}
function button(name: string) {
  const result = [...document.querySelectorAll<HTMLButtonElement>("button")].find(
    (item) => item.getAttribute("aria-label") === name || item.textContent?.trim() === name,
  );
  expect(result).toBeDefined();
  return result!;
}
async function click(name: string) {
  await act(async () => button(name).click());
}
async function render(initial?: Filter | CatalogQuery) {
  await act(async () => root.render(<Fixture initial={initial} />));
}
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  HTMLElement.prototype.scrollIntoView = vi.fn();
  host = document.body.appendChild(document.createElement("div"));
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
});
it("uses distinct self-excluding counts and functional OR/AND selections", async () => {
  await render();
  await click("Filters (0)");
  await click("Windows (2)");
  expect(button("Preview (1)").getAttribute("aria-pressed")).toBe("false");
  await click("Preview (1)");
  expect(filterPorts(ports, new Map(), "catalog", current, "").map((port) => port.id)).toEqual([
    "both",
  ]);
  expect(button("Linux (2)")).toBeDefined();
  await click("Linux (2)");
  expect(filterPorts(ports, new Map(), "catalog", current, "").map((port) => port.id)).toEqual([
    "linux",
    "both",
  ]);
  await act(async () => {
    button("Stable (2)").click();
    button("Stable (2)").click();
  });
  expect((current as CatalogQuery).channels).toEqual(["beta"]);
  await act(async () => setFavoritesOnly(true));
  expect(button("Windows (1)")).toBeDefined();
  expect(button("Linux (1)")).toBeDefined();
  await act(async () => setQuery("no matching title"));
  expect(button("Windows (0)").disabled).toBe(false);
  expect(button("Preview (0)").disabled).toBe(false);
  await click("Preview (0)");
  expect((current as CatalogQuery).channels).toEqual([]);
});
it("keeps zero selections removable and returns focused chip to the trigger", async () => {
  await render({ version: 1, platforms: ["macos-aarch64"] });
  const chip = button("Remove Apple silicon filter");
  chip.focus();
  await act(async () => {
    chip.click();
    chip.click();
  });
  expect(document.activeElement).toBe(button("Filters (0)"));
  await click("Filters (0)");
  await click("Apple silicon (0)");
  expect(button("Apple silicon (0)").getAttribute("aria-pressed")).toBe("true");
  await click("Apple silicon (0)");
  expect((current as CatalogQuery).platforms).toEqual([]);
});
it.each([
  { version: 2, platforms: ["windows-x86-64"] },
  { version: 1, platforms: 42 },
  { version: 1, channels: ["future"] },
  { version: 1, membership: ["in-library"] },
])("holds restored query %j until explicit reset", async (initial) => {
  await render(initial as unknown as CatalogQuery);
  await click("Filters (0)");
  expect(button("Windows (unavailable)").disabled).toBe(true);
  expect(current).toEqual(initial);
  await click("Reset catalog filters");
  expect(current).toBe("all");
  expect(button("Windows (2)").disabled).toBe(false);
});
it("preserves established extra predicates visibly on edit and clears only query on reset", async () => {
  const method = "portable-package";
  for (const port of ports)
    port.presentation = { installation_method: method } as NonNullable<typeof port.presentation>;
  await render({ version: 1, installationMethods: [method] });
  await click("Filters (1)");
  expect(document.body.textContent).toContain("Additional restored filters remain active");
  await click("Windows (2)");
  expect((current as CatalogQuery).installationMethods).toEqual([method]);
  await act(async () => {
    setQuery("Both");
    setFavoritesOnly(true);
  });
  await click("Reset catalog filters");
  expect(button("Windows (1)")).toBeDefined();
  expect(button("Linux (1)")).toBeDefined();
});
