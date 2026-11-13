import { afterEach, beforeEach, expect, it } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";
import { cleanup, render } from "vitest-browser-react";
import App from "../App";
import { desktopApi } from "../api";
import { initializeLocalization, LocalizationProvider } from "../localization";
import { installInteractiveTransport } from "../dev-scenarios/interactive/transport";
import { THEME_STORAGE_KEY, type ResolvedTheme } from "../theme";
import { browserFixture } from "../../test/browser-fixture";

let fixture: ReturnType<typeof browserFixture>;
beforeEach(() => {
  fixture = browserFixture({
    storage: true,
    attributes: ["data-theme", "lang", "dir"],
    viewport: true,
  });
  localStorage.clear();
});
afterEach(async () => {
  await fixture.dispose();
});

async function mount(theme: ResolvedTheme) {
  const transport = installInteractiveTransport("collection", (message) => {
    throw new Error(message);
  });
  fixture.defer(() => transport.dispose());
  const localization = initializeLocalization(["en"]),
    language = localization.language;
  fixture.defer(async () => {
    await localization.changeLanguage(language);
  });
  localStorage.setItem(THEME_STORAGE_KEY, theme);
  const root = document.createElement("div");
  root.id = "root";
  document.body.append(root);
  fixture.defer(() => root.remove());
  fixture.defer(() => cleanup());
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
  it(`keeps the ${theme} library toolbar together on a small desktop`, async () => {
    await page.viewport(1024, 800);
    await mount(theme);
    const search = page.getByRole("textbox", { name: "Search your library" });
    for (const query of ["", "a"]) {
      await search.fill(query);
      const toolbar = document.querySelector<HTMLElement>(".browse-toolbar")!;
      const controls = [
        toolbar.querySelector<HTMLElement>(".search")!,
        toolbar.querySelector<HTMLElement>("button[aria-controls]")!,
        toolbar.querySelector<HTMLElement>(".browse-sort")!,
        toolbar.querySelector<HTMLElement>('[aria-label="Collection view"]')!,
      ].map((control) => control.getBoundingClientRect());
      const searchBox = controls[0]!;
      expect(searchBox.width).toBeGreaterThanOrEqual(240);
      for (const box of controls) {
        expect(
          Math.abs(box.top + box.height / 2 - searchBox.top - searchBox.height / 2),
        ).toBeLessThanOrEqual(1);
      }
      expectWorkspaceFit();
      await expect.element(search).toHaveFocus();
    }
  });

  it(`uses the expanded ${theme} workspace for game columns and right-side wheel scrolling`, async () => {
    await page.viewport(1280, 800);
    await mount(theme);
    for (const view of ["library", "catalog"]) {
      if (view === "catalog") await page.getByRole("button", { name: /^Discover(?:\s|$)/ }).click();
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
      for (const frame of document.querySelectorAll<HTMLElement>(".collection-art")) {
        const art = frame.getBoundingClientRect();
        expect(art.width).toBeLessThanOrEqual(221);
        expect(art.height / art.width).toBeCloseTo(1.5, 2);
      }
      const wheelTarget = page
        .getByRole("region", {
          name: view === "library" ? "Library entries" : "Discover games",
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
