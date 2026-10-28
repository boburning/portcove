import { afterEach, beforeEach, expect, it } from "vite-plus/test";
import { page } from "vite-plus/test/browser";
import { cleanup, render } from "vitest-browser-react";
import App from "../App";
import { desktopApi } from "../api";
import { initializeLocalization, LocalizationProvider } from "../localization";
import { installInteractiveTransport } from "../dev-scenarios/interactive/transport";
import { scrollWorkspaceTo, workspaceScrollTop } from "../workspace-scroll";

let transport: ReturnType<typeof installInteractiveTransport> | undefined;
let root: HTMLDivElement | undefined;
beforeEach(() => localStorage.clear());
afterEach(async () => {
  await cleanup();
  root?.remove();
  root = undefined;
  transport?.dispose();
  transport = undefined;
  document.documentElement.style.removeProperty("font-size");
  document.documentElement.removeAttribute("data-theme");
  await page.viewport(1280, 800);
});

for (const textSize of [100, 200]) {
  it(`returns the current Settings category heading below its sticky navigation at 730px with ${textSize}% text`, async () => {
    await page.viewport(730, 844);
    transport = installInteractiveTransport("collection", (message) => {
      throw new Error(message);
    });
    initializeLocalization(["en"]);
    document.documentElement.style.fontSize = `${textSize}%`;
    // Match main.tsx and the existing actual-App composition fixtures: the
    // production #root receives the stylesheet's definite viewport height.
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
    await page.getByRole("button", { name: "Settings", exact: true }).click();
    const categories = page.getByRole("navigation", { name: "Settings categories", exact: true });
    const main = document.querySelector<HTMLElement>('main[data-focus-region="workspace"]')!;
    expect(getComputedStyle(categories.element()).position).toBe("sticky");

    // This real recovery guide includes the installed games and stays long
    // while its selected category is activated again to return to the heading.
    await categories.getByRole("button", { name: "Library and storage", exact: true }).click();
    await page.getByText("Prepare a recovery copy", { exact: true }).click();
    const mainScrolls =
      getComputedStyle(main).overflowY !== "visible" && main.scrollHeight > main.clientHeight;
    const scroll = mainScrolls ? main : (document.scrollingElement ?? document.documentElement);
    expect(scroll.scrollHeight - scroll.clientHeight).toBeGreaterThanOrEqual(300);
    const heading = page.getByRole("heading", { name: "Library and storage", exact: true });
    const viewportTop = mainScrolls ? main.getBoundingClientRect().top : 0;
    const readingPosition = Math.max(
      360,
      scroll.scrollTop + heading.element().getBoundingClientRect().bottom - viewportTop + 32,
    );
    if (mainScrolls) scrollWorkspaceTo(main, readingPosition);
    else scroll.scrollTo({ top: readingPosition });
    await expect
      .poll(() => (mainScrolls ? workspaceScrollTop(main) : scroll.scrollTop))
      .toBeGreaterThanOrEqual(300);
    expect(categories.element().getBoundingClientRect().top).toBeCloseTo(
      mainScrolls ? main.getBoundingClientRect().top : 0,
      0,
    );

    expect(heading.element().getBoundingClientRect().bottom).toBeLessThanOrEqual(viewportTop);
    const currentCategory = categories.getByRole("button", {
      name: "Library and storage",
      exact: true,
    });
    expect(currentCategory.element().getAttribute("aria-current")).toBe("page");
    await currentCategory.click();
    await expect.element(heading).toHaveFocus();
    await expect
      .poll(() => {
        const target = heading.element();
        const style = getComputedStyle(target);
        const outlineRoom =
          Math.max(0, Number.parseFloat(style.outlineWidth)) +
          Math.max(0, Number.parseFloat(style.outlineOffset));
        return (
          target.getBoundingClientRect().top -
          categories.element().getBoundingClientRect().bottom -
          outlineRoom
        );
      })
      .toBeGreaterThanOrEqual(-1);
    expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(731);
  }, 45_000);
}
