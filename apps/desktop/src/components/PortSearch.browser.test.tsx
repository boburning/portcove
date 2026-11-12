import { controlledAct as act } from "../../test/controlled-react-act";
import { render as renderComponent, cleanup, type RenderResult } from "vitest-browser-react";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";
import { PortSearch } from "./PortSearch";

let root: RenderResult;
let container: HTMLDivElement;
beforeEach(async () => {
  container = document.createElement("div");
  document.body.append(container);
  root = await renderComponent(null, { container: document.body.appendChild(container) });
});
afterEach(async () => {
  await cleanup();
  container.remove();
  vi.restoreAllMocks();
});

it("labels the search field for its scope in the current language", async () => {
  const { initializeLocalization } = await import("../localization");
  const localization = initializeLocalization(["en-US"]);
  await act(async () => {
    await root.rerender(<PortSearch query="zelda" setQuery={vi.fn()} library />);
  });
  const input = () => container.querySelector<HTMLInputElement>("#port-search");
  const clear = () => container.querySelector("button")?.getAttribute("aria-label");
  expect(input()?.getAttribute("aria-label")).toBe("Search your library");
  expect(input()?.placeholder).toBe("Game or port name");
  expect(clear()).toBe("Clear search");
  try {
    await act(async () => {
      await localization.changeLanguage("ar-XB");
    });
    await expect.poll(() => input()?.getAttribute("aria-label")).toBe("البحث في مكتبتك");
    expect(input()?.placeholder).toBe("اسم اللعبة أو المنفذ");
    expect(clear()).toBe("مسح البحث");
    expect(input()?.value).toBe("zelda");
  } finally {
    await act(async () => {
      await localization.changeLanguage("en");
    });
  }
  await act(async () => {
    await root.rerender(<PortSearch query="" setQuery={vi.fn()} />);
  });
  expect(input()?.getAttribute("aria-label")).toBe("Search Discover");
});
