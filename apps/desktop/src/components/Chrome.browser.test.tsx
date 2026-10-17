import { afterEach, expect, it, vi } from "vite-plus/test";
import { page } from "vite-plus/test/browser";
import { cleanup, render } from "vitest-browser-react";
import axe from "axe-core";
import { PageHeader } from "./Chrome";

afterEach(async () => {
  await cleanup();
  vi.restoreAllMocks();
});

for (const platform of ["Win32", "MacIntel"]) {
  for (const width of [960, 1280]) {
    it(`includes the visible command shortcut in the accessible name on ${platform} at ${width}px`, async () => {
      vi.spyOn(navigator, "platform", "get").mockReturnValue(platform);
      await page.viewport(width, 720);
      await render(<PageHeader view="library" query="" setQuery={() => {}} />);
      const shortcut = platform === "MacIntel" ? "Command K" : "Ctrl K";
      const button = page.getByRole("button", {
        name: `Commands ${shortcut}: open command palette`,
        exact: true,
      });
      await expect.element(button).toBeVisible();
      expect(button.element().querySelector("kbd")?.textContent).toBe(shortcut);
      const result = await axe.run(button.element(), {
        runOnly: { type: "rule", values: ["label-content-name-mismatch"] },
      });
      expect(result.violations).toEqual([]);
    });
  }
}
