import { afterEach, expect, it, vi } from "vite-plus/test";
import { page } from "vite-plus/test/browser";
import { cleanup, render } from "vitest-browser-react";
import axe from "axe-core";
import { PageHeader, Sidebar } from "./Chrome";
import { observeVisibleTarget } from "../../scripts/browser-readiness.mts";
import { prepareCaptureTarget } from "../../test/capture-target";

afterEach(async () => {
  await cleanup();
  vi.restoreAllMocks();
  delete document.documentElement.dataset.theme;
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
      expect(button.element().textContent).toContain(shortcut);
      const result = await axe.run(button.element(), {
        runOnly: { type: "rule", values: ["label-content-name-mismatch"] },
      });
      expect(result.violations).toEqual([]);
    });
  }
}

it.for([
  [960, "dark"],
  [960, "light"],
  [1280, "dark"],
  [1280, "light"],
] as const)(
  "keeps primary destinations reachable without task tools competing in the sidebar at %spx in %s",
  async ([width, theme]) => {
    await page.viewport(width, 640);
    document.documentElement.dataset.theme = theme;
    const setView = vi.fn();
    await render(
      <Sidebar
        view="library"
        setView={setView}
        installedCount={3}
        updateCount={0}
        activities={[]}
      />,
    );
    expect(document.querySelector(".sidebar-footer")?.textContent ?? "").not.toContain(
      "Copy existing installation",
    );
    for (const label of ["Library", "Find games", "Activity", "Settings"])
      await expect
        .element(page.getByRole("button", { name: new RegExp(`^${label}`) }))
        .toBeVisible();
    await page.getByRole("button", { name: "Settings", exact: true }).click();
    expect(setView).toHaveBeenCalledWith("settings");
  },
);

it("visual capture accepts decorative art, rejects hidden and clipped ancestors, and reveals nested targets", async () => {
  await page.viewport(960, 640);
  const host = document.createElement("div");
  host.style.cssText =
    "position:fixed;left:200px;top:100px;width:220.25px;height:120.25px;overflow:auto;border:1px solid black;box-sizing:content-box";
  host.innerHTML =
    '<div style="height:400px;padding-top:250px"><div data-visual-fixture aria-hidden="true" style="width:100px;height:40px;background:red"></div></div>';
  document.body.append(host);
  const element = host.querySelector<HTMLElement>("[data-visual-fixture]")!;
  const target = "[data-visual-fixture]";
  const prepare = () =>
    prepareCaptureTarget({
      target,
      label: "nested-visual-fixture",
      scroll: () => element.scrollIntoView({ block: "center", behavior: "instant" }),
      observe: () => observeVisibleTarget(target, "visual"),
    });
  try {
    expect(observeVisibleTarget(target, "visual").visible).toBe(false);
    const result = await prepare();
    expect(result.observation.visible).toBe(true);
    expect(host.scrollTop).toBeGreaterThan(0);
    expect(observeVisibleTarget(target).visible).toBe(false);
    host.hidden = true;
    await expect(prepare()).rejects.toThrow("Capture target geometry must be finite and nonzero");
    host.hidden = false;
    host.style.opacity = "0";
    await expect(prepare()).rejects.toThrow("Capture requires one identified visible target");
    host.style.opacity = "1";
    element.style.height = "180px";
    await expect(prepare()).rejects.toThrow("Capture requires one identified visible target");
  } finally {
    host.remove();
  }
});
