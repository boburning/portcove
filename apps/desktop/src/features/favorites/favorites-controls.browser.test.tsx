import { controlledAct as act } from "../../../test/controlled-react-act";
import { render as renderComponent, cleanup, type RenderResult } from "vitest-browser-react";
import { fixtureValue } from "../../test-fixtures";
import type { PortDefinition } from "../../types";

import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";
import { PortBrowser } from "../../components/PortBrowser";
import { filterPorts } from "../../view-model";
import { portDefinition } from "../../test-fixtures";
import type { useFavorites } from "./use-favorites";
let host: HTMLDivElement;
let root: RenderResult;
beforeEach(async () => {
  host = document.body.appendChild(document.createElement("div"));
  root = await renderComponent(null, { container: document.body.appendChild(host) });
});
afterEach(async () => {
  await cleanup();
  host.remove();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
const ports: PortDefinition[] = [
  { ...portDefinition(), id: "first", name: "Keep first", channels: ["stable"] },
  { ...portDefinition(), id: "second", name: "Keep second", channels: ["stable"] },
  { ...portDefinition(), id: "third", name: "Other", channels: ["beta"] },
];
function favorites(
  overrides: Partial<ReturnType<typeof useFavorites>> = {},
): ReturnType<typeof useFavorites> {
  return {
    ids: new Set(["first", "third", "absent"]),
    only: false,
    setOnly: vi.fn(),
    toggle: vi.fn(async () => true),
    refresh: vi.fn(async () => true),
    busy: false,
    failure: undefined,
    ...overrides,
  };
}
it("counts favorites within actual composed search/channel results and reset preserves stored choices", async () => {
  const saved = favorites({ only: true });
  const clear = vi.fn();
  const narrowed = filterPorts(
    ports,
    new Map(),
    "catalog",
    { version: 1, channels: ["stable"] },
    "Keep",
  );
  await root.rerender(
    <PortBrowser
      view="catalog"
      ports={narrowed}
      statuses={new Map()}
      overview={{ installed: 0, ready: 0, needsSetup: 0, staged: 0 }}
      filter={{ version: 1, channels: ["stable"] }}
      query="Keep"
      setFilter={vi.fn()}
      onSelect={vi.fn()}
      loading={false}
      favorites={saved}
      clearFilters={clear}
    />,
  );
  expect(host.querySelector('button[aria-label="Favorites (1)"]')).not.toBeNull();
  expect(host.textContent).toContain("1 ungrouped project · 1 matching port");
  expect(host.querySelector('button[aria-label="Favorite Keep first"]')).not.toBeNull();
  expect(host.querySelector('button[aria-label="Favorite Keep second"]')).toBeNull();
  const reset = [...host.querySelectorAll<HTMLButtonElement>("button")].find(
    (x) => x.textContent === "Reset view",
  )!;
  await act(async () => reset.click());
  expect(saved.setOnly).toHaveBeenCalledWith(false);
  expect(clear).toHaveBeenCalled();
  expect([...saved.ids!]).toEqual(["first", "third", "absent"]);
});
it("unavailable favorites expose actionable retry while ordinary details remain available", async () => {
  const saved = favorites({ ids: undefined, failure: "read" });
  const select = vi.fn();
  await root.rerender(
    <PortBrowser
      view="catalog"
      ports={[fixtureValue(ports[0], "ports[0]")]}
      statuses={new Map()}
      overview={{ installed: 0, ready: 0, needsSetup: 0, staged: 0 }}
      filter="all"
      setFilter={vi.fn()}
      onSelect={select}
      loading={false}
      favorites={saved}
    />,
  );
  expect(host.querySelector('[role="alert"]')?.textContent).toContain("keep browsing and playing");
  const button = host.querySelector<HTMLButtonElement>('button[aria-label="Favorite Keep first"]')!;
  expect(button.disabled).toBe(true);
  const retry = [...host.querySelectorAll<HTMLButtonElement>("button")].find(
    (x) => x.textContent === "Retry favorites",
  )!;
  await act(async () => retry.click());
  expect(saved.refresh).toHaveBeenCalled();
  const detail = host.querySelector<HTMLButtonElement>(
    'button[data-detail-origin="catalog:card:first"]',
  )!;
  await act(async () => detail.click());
  expect(select).toHaveBeenCalledWith("first", "catalog:card:first");
  expect(saved.toggle).not.toHaveBeenCalled();
});
it("keeps an unknown existing query unresolved instead of treating it as an empty favorite set", async () => {
  const unsupported = { version: 2, channels: ["future"] };
  const saved = favorites({ only: true });
  const narrowed = filterPorts(ports, new Map(), "catalog", unsupported, "");
  expect(narrowed).toEqual([]);
  await root.rerender(
    <PortBrowser
      view="catalog"
      ports={narrowed}
      statuses={new Map()}
      overview={{ installed: 0, ready: 0, needsSetup: 0, staged: 0 }}
      filter={unsupported}
      setFilter={vi.fn()}
      onSelect={vi.fn()}
      loading={false}
      favorites={saved}
    />,
  );
  expect(host.querySelector('[role="alert"]')?.textContent).toContain("not supported");
  expect(saved.ids?.size).toBe(3);
  expect(saved.toggle).not.toHaveBeenCalled();
});
