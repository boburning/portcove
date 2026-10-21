import { afterEach, beforeEach, expect, it } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";
import { cleanup, render } from "vitest-browser-react";
import App from "../App";
import { desktopApi } from "../api";
import { initializeLocalization, LocalizationProvider } from "../localization";
import { installInteractiveTransport } from "../dev-scenarios/interactive/transport";
import { THEME_STORAGE_KEY, type ResolvedTheme } from "../theme";

let transport: ReturnType<typeof installInteractiveTransport> | undefined;
let root: HTMLDivElement | undefined;
beforeEach(() => localStorage.clear());
afterEach(async () => {
  await cleanup();
  root?.remove();
  root = undefined;
  transport?.dispose();
  transport = undefined;
  document.documentElement.removeAttribute("data-theme");
  await page.viewport(1280, 800);
});

async function mount(theme: ResolvedTheme) {
  transport = installInteractiveTransport("collection", (message) => {
    throw new Error(message);
  });
  initializeLocalization(["en"]);
  localStorage.setItem(THEME_STORAGE_KEY, theme);
  root = document.createElement("div");
  root.id = "root";
  document.body.append(root);
  await render(
    <LocalizationProvider api={desktopApi}>
      <App />
    </LocalizationProvider>,
    { container: root },
  );
  await expect.poll(() => document.querySelectorAll(".collection-entry").length).toBe(12);
  expect(document.documentElement.dataset.theme).toBe(theme);
}

function workspace() {
  return document.querySelector<HTMLElement>(".app-shell > main")!;
}

function expectWorkspaceFit() {
  const main = workspace();
  const shell = document.querySelector<HTMLElement>(".app-shell")!;
  expect(
    Math.abs(main.getBoundingClientRect().right - shell.getBoundingClientRect().right),
  ).toBeLessThanOrEqual(1);
  expect(main.scrollWidth).toBeLessThanOrEqual(main.clientWidth + 1);
  expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(
    document.documentElement.clientWidth + 1,
  );
}

function columns() {
  return getComputedStyle(document.querySelector(".port-grid")!).gridTemplateColumns.split(" ")
    .length;
}

for (const theme of ["dark", "light"] as const) {
  it(`uses the expanded ${theme} workspace for game columns and right-side wheel scrolling`, async () => {
    await page.viewport(1280, 800);
    await mount(theme);
    for (const view of ["library", "catalog"]) {
      if (view === "catalog")
        await page.getByRole("button", { name: /^Find games(?:\s|$)/ }).click();
      await page.viewport(1280, 800);
      const ordinaryColumns = columns();
      await page.viewport(2560, 800);
      expectWorkspaceFit();
      expect(columns()).toBeGreaterThan(ordinaryColumns);
      const main = workspace();
      main.scrollTop = 0;
      expect(main.scrollHeight).toBeGreaterThan(main.clientHeight);
      const cards = [...document.querySelectorAll<HTMLElement>(".port-grid > *")];
      const firstRowTop = cards[0]!.getBoundingClientRect().top;
      const rightmost = cards
        .filter((card) => Math.abs(card.getBoundingClientRect().top - firstRowTop) < 1)
        .at(-1)!;
      const box = rightmost.getBoundingClientRect();
      expect(box.left + box.width / 2).toBeGreaterThan(innerWidth * 0.75);
      for (const frame of document.querySelectorAll<HTMLElement>(".card-art")) {
        const art = frame.getBoundingClientRect();
        expect(art.width).toBeLessThanOrEqual(221);
        expect(art.height / art.width).toBeCloseTo(1.5, 2);
      }
      const wheelTarget = page
        .getByRole("region", {
          name: view === "library" ? "Library entries" : "Find games entries",
        })
        .getByRole("heading")
        .nth(cards.indexOf(rightmost));
      await userEvent.hover(wheelTarget);
      const beforeWheel = main.scrollTop;
      expect(beforeWheel).toBeLessThan(main.scrollHeight - main.clientHeight);
      await userEvent.wheel(wheelTarget, { delta: { y: 400 } });
      await expect.poll(() => main.scrollTop).toBeGreaterThan(beforeWheel);
      expect(document.scrollingElement!.scrollTop).toBe(0);
    }
  });

  it(`preserves the ${theme} search and focus through grow, shrink and restore`, async () => {
    await page.viewport(1280, 800);
    await mount(theme);
    const search = page.getByRole("textbox", { name: "Search your library" });
    await search.fill("a");
    for (const [width, height] of [
      [2560, 1440],
      [960, 640],
      [320, 800],
      [1920, 1080],
      [3440, 1440],
      [1280, 800],
    ] as const) {
      await page.viewport(width, height);
      expectWorkspaceFit();
      await expect.element(search).toHaveValue("a");
      await expect.element(search).toHaveFocus();
      expect(getComputedStyle(workspace()).overflowY).toBe(width < 768 ? "visible" : "auto");
    }
  });

  it(`keeps ${theme} settings readable inside the full-width scrolling workspace`, async () => {
    await page.viewport(2560, 800);
    await mount(theme);
    await page.getByRole("button", { name: /^Settings(?:\s|$)/ }).click();
    expectWorkspaceFit();
    const settings = document.querySelector<HTMLElement>(".settings-grid")!;
    expect(settings.getBoundingClientRect().width).toBeLessThanOrEqual(1600);
    expect(settings.getBoundingClientRect().right).toBeLessThan(
      workspace().getBoundingClientRect().right - 100,
    );
  });
}
