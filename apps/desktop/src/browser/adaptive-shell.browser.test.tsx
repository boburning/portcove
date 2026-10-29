import { afterEach, beforeEach, expect, it } from "vite-plus/test";
import { page } from "vite-plus/test/browser";
import { cleanup, render } from "vitest-browser-react";
import App from "../App";
import { desktopApi } from "../api";
import { initializeLocalization, LocalizationProvider } from "../localization";
import { installInteractiveTransport } from "../dev-scenarios/interactive/transport";
import { INTERFACE_SIZE_KEY } from "../interface-size-controller";

let transport: ReturnType<typeof installInteractiveTransport> | undefined;
let spacing: HTMLStyleElement | undefined;
beforeEach(() => localStorage.clear());
afterEach(async () => {
  await cleanup();
  transport?.dispose();
  transport = undefined;
  document.documentElement.removeAttribute("data-theme");
  document.documentElement.style.removeProperty("font-size");
  spacing?.remove();
  spacing = undefined;
  await page.viewport(1280, 800);
});

for (const theme of ["dark", "light"]) {
  it(`keeps complete ${theme} navigation and theme words at enlarged effective widths`, async () => {
    transport = installInteractiveTransport("library", (message) => {
      throw new Error(message);
    });
    initializeLocalization(["en"]);
    document.documentElement.dataset.theme = theme;
    await page.viewport(548, 366);
    await render(
      <LocalizationProvider api={desktopApi}>
        <App />
      </LocalizationProvider>,
    );
    await page.getByRole("button", { name: "Open navigation", exact: true }).click();
    const library = page.getByRole("button", { name: /^Library/ }).element();
    const label = [...library.querySelectorAll("span")].find(
      (item) => item.textContent === "Library",
    )!;
    const libraryRange = document.createRange();
    libraryRange.selectNodeContents(
      document.createTreeWalker(label, NodeFilter.SHOW_TEXT).nextNode()!,
    );
    expect(libraryRange.getClientRects()).toHaveLength(1);
    await page.getByRole("button", { name: "Settings", exact: true }).click();
    await page.viewport(240, 160);
    for (const name of ["Follow system", "Dark", "Light"]) {
      const button = page
        .getByRole("radiogroup", { name: "Color theme", exact: true })
        .getByRole("radio", { name, exact: true });
      const text = document.createTreeWalker(button.element(), NodeFilter.SHOW_TEXT).nextNode()!;
      const range = document.createRange();
      range.selectNodeContents(text);
      expect(range.getClientRects()).toHaveLength(1);
    }
  });
  it(`restores a ${theme} detail origin and reading position in document flow`, async () => {
    localStorage.removeItem(INTERFACE_SIZE_KEY);
    transport = installInteractiveTransport("library", (message) => {
      throw new Error(message);
    });
    initializeLocalization(["en"]);
    document.documentElement.dataset.theme = theme;
    await page.viewport(320, 640);
    await render(
      <LocalizationProvider api={desktopApi}>
        <App />
      </LocalizationProvider>,
    );
    const origin = page.getByRole("button", {
      name: "View details for Orchard Quest Orchard Quest",
      exact: true,
    });
    await expect.element(origin).toBeVisible();
    origin.element().scrollIntoView({ block: "center" });
    const top = document.scrollingElement!.scrollTop;
    expect(top).toBeGreaterThan(0);
    await origin.click();
    const back = page.getByRole("button", { name: /^Back to (Library|Discover)$/, exact: true });
    await expect
      .element(page.getByRole("heading", { name: "Orchard Quest", level: 1 }))
      .toHaveFocus();
    expect(back.element().getBoundingClientRect().top).toBeGreaterThanOrEqual(0);
    await back.click();
    await expect.element(origin).toHaveFocus();
    expect(Math.abs(document.scrollingElement!.scrollTop - top)).toBeLessThanOrEqual(2);
    expect(origin.element().getBoundingClientRect().top).toBeGreaterThanOrEqual(0);
    expect(origin.element().getBoundingClientRect().bottom).toBeLessThanOrEqual(innerHeight + 1);
    for (const width of [1280, 320]) {
      await page.viewport(width, 640);
      await expect.element(origin).toHaveFocus();
      await expect
        .poll(() => origin.element().getBoundingClientRect().top)
        .toBeGreaterThanOrEqual(0);
      await expect
        .poll(() => origin.element().getBoundingClientRect().bottom)
        .toBeLessThanOrEqual(innerHeight + 1);
    }
  });
  it(`preserves search and focus through actual 320px and 240px ${theme} reflow`, async () => {
    localStorage.removeItem(INTERFACE_SIZE_KEY);
    transport = installInteractiveTransport("library", (message) => {
      throw new Error(message);
    });
    initializeLocalization(["en"]);
    document.documentElement.dataset.theme = theme;
    await page.viewport(960, 640);
    await render(
      <LocalizationProvider api={desktopApi}>
        <App />
      </LocalizationProvider>,
    );
    const search = page.getByRole("textbox", { name: "Search your library" });
    await search.fill("a retained search draft");
    for (const [width, height] of [
      [320, 800],
      [240, 160],
      [1280, 800],
      [1366, 768],
      [1600, 1000],
      [1920, 1080],
      [960, 640],
    ]) {
      await page.viewport(width!, height!);
      expect(innerWidth).toBe(width);
      await expect.element(search).toHaveValue("a retained search draft");
      await expect.element(search).toHaveFocus();
      expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(
        document.documentElement.clientWidth + 1,
      );
      const sidebar = document.querySelector<HTMLElement>(".app-shell > .sidebar")!;
      const workspace = document.querySelector<HTMLElement>(".app-shell > main")!;
      const vertical = width! < 768;
      const navigationEnd = vertical
        ? sidebar.getBoundingClientRect().bottom
        : sidebar.getBoundingClientRect().right;
      const workspaceStart = vertical
        ? workspace.getBoundingClientRect().top
        : workspace.getBoundingClientRect().left;
      expect(navigationEnd).toBeLessThanOrEqual(workspaceStart + 1);
      expect(getComputedStyle(workspace).overflowY).toBe(vertical ? "visible" : "auto");
    }
    await page.getByRole("button", { name: /^Activity/ }).click();
    await expect.element(page.getByRole("heading", { name: "Activity", level: 1 })).toBeVisible();
    await page.getByRole("tab", { name: "Game updates", exact: true }).click();
    await expect.poll(() => document.querySelectorAll(".update-row").length).toBeGreaterThan(0);
    for (const width of [320, 240]) {
      await page.viewport(width, 800);
      const overflowing = [...document.querySelectorAll<HTMLElement>("main *")]
        .filter((element) => element.getBoundingClientRect().right > innerWidth + 1)
        .map((element) => `${element.tagName}.${element.className}: ${element.textContent}`);
      expect(document.documentElement.scrollWidth, overflowing.join("\n")).toBeLessThanOrEqual(
        document.documentElement.clientWidth + 1,
      );
    }
  });
  for (const mode of ["spacing overrides", "200% authored text"]) {
    it(`keeps ${theme} Settings usable at 320px with ${mode}`, async () => {
      localStorage.removeItem(INTERFACE_SIZE_KEY);
      transport = installInteractiveTransport("library", (message) => {
        throw new Error(message);
      });
      initializeLocalization(["en"]);
      document.documentElement.dataset.theme = theme;
      await page.viewport(320, 800);
      await render(
        <LocalizationProvider api={desktopApi}>
          <App />
        </LocalizationProvider>,
      );
      await page.getByRole("button", { name: "Open navigation", exact: true }).click();
      await page.getByRole("button", { name: "Settings", exact: true }).click();
      await expect
        .element(page.getByRole("heading", { name: "Interface size", exact: true }))
        .toBeVisible();
      if (mode === "spacing overrides") {
        spacing = document.createElement("style");
        spacing.textContent =
          "* {line-height:1.5!important;letter-spacing:.12em!important;word-spacing:.16em!important} p {margin-bottom:2em!important}";
        document.head.append(spacing);
      } else document.documentElement.style.fontSize = "32px";
      expect(getComputedStyle(document.querySelector(".settings-section-index")!).position).toBe(
        "static",
      );
      expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(
        document.documentElement.clientWidth + 1,
      );
      await expect
        .element(page.getByRole("combobox", { name: "Interface size 100%" }))
        .toBeVisible();
      await expect
        .element(page.getByRole("button", { name: "Reset to 100%", exact: true }))
        .toBeEnabled();
    });
  }
}
