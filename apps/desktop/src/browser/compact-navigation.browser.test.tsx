import axe from "axe-core";
import { afterEach, beforeEach, expect, it } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";
import { cleanup, render } from "vitest-browser-react";
import App from "../App";
import { desktopApi } from "../api";
import { initializeLocalization, LocalizationProvider } from "../localization";
import { installInteractiveTransport } from "../dev-scenarios/interactive/transport";

let transport: ReturnType<typeof installInteractiveTransport> | undefined;
beforeEach(() => localStorage.clear());
afterEach(async () => {
  await cleanup();
  transport?.dispose();
  transport = undefined;
  document.documentElement.removeAttribute("data-theme");
  await page.viewport(1280, 800);
});

for (const width of [320, 576]) {
  for (const theme of ["light", "dark"]) {
    it(`exposes games and deliberate modal navigation at ${width}px in ${theme}`, async () => {
      await page.viewport(width, 900);
      transport = installInteractiveTransport("collection", (message) => {
        throw new Error(message);
      });
      initializeLocalization(["en"]);
      document.documentElement.dataset.theme = theme;
      await render(
        <LocalizationProvider api={desktopApi}>
          <App />
        </LocalizationProvider>,
      );
      await expect.poll(() => document.querySelectorAll(".collection-entry").length).toBe(12);
      const firstArt = document.querySelector<HTMLElement>(".collection-art")!;
      expect(firstArt.getBoundingClientRect().top).toBeLessThan(650);
      expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(width + 1);
      const navigation = page.getByRole("button", { name: "Open navigation", exact: true });
      await navigation.click();
      const dialog = page.getByRole("dialog", { name: "Navigation", exact: true });
      await expect.element(dialog).toBeVisible();
      const selected = dialog.getByRole("button", { name: /^Library/ });
      await expect.element(selected).toHaveFocus();
      for (let index = 0; index < 10; index += 1) {
        await userEvent.keyboard("{Tab}");
        expect(dialog.element().contains(document.activeElement)).toBe(true);
      }
      expect((await axe.run(dialog.element())).violations).toEqual([]);
      await userEvent.keyboard("{Escape}");
      await expect.element(navigation).toHaveFocus();
      await navigation.click();
      await dialog.getByRole("button", { name: "Find games", exact: true }).click();
      await expect
        .element(page.getByRole("heading", { name: "Find games", level: 1 }))
        .toBeVisible();
      await expect.element(navigation).toHaveFocus();
      await navigation.click();
      await expect
        .element(dialog.getByRole("button", { name: "Find games", exact: true }))
        .toHaveFocus();
      await page.viewport(1280, 900);
      await expect.poll(() => document.querySelector('[role="dialog"]')).toBeNull();
      const desktopDestination = page
        .getByRole("navigation", { name: "Primary navigation" })
        .getByRole("button", { name: "Find games", exact: true });
      await expect.element(desktopDestination).toBeVisible();
      await expect.element(desktopDestination).toHaveFocus();
    });
  }
}
