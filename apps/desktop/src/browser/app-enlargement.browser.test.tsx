import { afterEach, expect, it } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";
import {
  startInteractiveScenarios,
  stopInteractiveScenarios,
} from "../dev-scenarios/interactive/entry";
import { applyWebTheme } from "../theme";
import "../styles/index.css";

afterEach(() => {
  stopInteractiveScenarios();
  document.documentElement.style.fontSize = "";
  localStorage.clear();
  sessionStorage.clear();
  document.body.replaceChildren();
  window.history.replaceState(null, "", "/");
});

it.for(["dark", "light"] as const)(
  "keeps the real %s shell usable with doubled text at the minimum window",
  async (theme) => {
    localStorage.clear();
    await page.viewport(960, 640);
    document.documentElement.style.fontSize = "200%";
    window.history.replaceState(null, "", "/scenarios.html?mode=interactive&journey=library");
    document.body.innerHTML =
      '<select hidden id="scenario"></select><p hidden id="scenario-limitation"></p><div id="scenario-preview"></div>';
    startInteractiveScenarios();
    document.querySelector<HTMLElement>(".scenario-fixture-actions")!.hidden = true;
    await expect.element(page.getByPlaceholder("Game or port name")).toBeVisible();
    applyWebTheme(theme);
    expect(getComputedStyle(document.documentElement).fontSize).toBe("32px");
    const main = document.querySelector<HTMLElement>('main[data-focus-region="workspace"]')!;
    expect(
      main.scrollWidth,
      "workspace must reflow rather than hide horizontal overflow",
    ).toBeLessThanOrEqual(main.clientWidth + 1);
    const search = document.getElementById("port-search")!;
    const commands = document.querySelector<HTMLElement>(".command-trigger")!;
    for (const control of [search, commands]) {
      const box = control.getBoundingClientRect();
      const workspace = main.getBoundingClientRect();
      expect(box.left).toBeGreaterThanOrEqual(workspace.left);
      expect(box.right).toBeLessThanOrEqual(workspace.right);
    }
    const settings = page
      .getByRole("button", { name: "Settings", exact: true })
      .element() as HTMLElement;
    settings.scrollIntoView({ block: "nearest" });
    expect(
      settings.getBoundingClientRect().bottom,
      "Settings must remain reachable",
    ).toBeLessThanOrEqual(innerHeight + 1);
    expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(960);
    await page.screenshot({
      path: `../../../../outputs/uiux-game-titles/enlarged-shell-${theme}-960.png`,
    });
    await userEvent.click(page.getByRole("button", { name: "Settings", exact: true }));
    await page
      .getByRole("navigation", { name: "Settings categories" })
      .getByRole("button", { name: "About", exact: true })
      .click();
    await expect
      .element(page.getByRole("heading", { name: "About Portcove", exact: true }).first())
      .toBeVisible();
    expect(
      main.scrollWidth,
      "enlarged Settings must reflow within the workspace",
    ).toBeLessThanOrEqual(main.clientWidth + 1);
  },
);

it.for(["dark", "light"] as const)(
  "keeps the %s preparation review reachable with doubled text",
  async (theme) => {
    localStorage.clear();
    await page.viewport(960, 640);
    document.documentElement.style.fontSize = "200%";
    window.history.replaceState(null, "", "/scenarios.html?mode=interactive&journey=setup");
    document.body.innerHTML =
      '<select hidden id="scenario"></select><p hidden id="scenario-limitation"></p><div id="scenario-preview"></div>';
    startInteractiveScenarios();
    document.querySelector<HTMLElement>(".scenario-fixture-actions")!.hidden = true;
    await userEvent.click(
      page.getByRole("button", {
        name: "View details for Harbor Adventure Harbor Adventure",
        exact: true,
      }),
    );
    applyWebTheme(theme);
    await userEvent.click(page.getByRole("button", { name: "Review setup", exact: true }));
    await expect.element(page.getByRole("dialog")).toBeVisible();
    const dialog = page.getByRole("dialog").element() as HTMLElement;
    expect(
      dialog.scrollWidth,
      "preparation review must reflow without horizontal scrolling",
    ).toBeLessThanOrEqual(dialog.clientWidth + 1);
    const prepare = page
      .getByRole("button", { name: "Prepare game data", exact: true })
      .element() as HTMLElement;
    prepare.scrollIntoView({ block: "nearest" });
    const box = prepare.getBoundingClientRect();
    expect(box.top).toBeGreaterThanOrEqual(0);
    expect(box.bottom).toBeLessThanOrEqual(innerHeight);
    expect(box.right).toBeLessThanOrEqual(innerWidth);
    expect(box.left).toBeGreaterThanOrEqual(0);
    await page.screenshot({
      path: `../../../../outputs/uiux-game-titles/enlarged-preparation-${theme}-960.png`,
    });
    await page.getByRole("button", { name: "Prepare game data", exact: true }).click();
    const leave = page.getByRole("button", { name: "Continue browsing", exact: true });
    await expect.element(leave).toBeVisible();
    await expect
      .element(page.getByRole("heading", { name: "Prepare game data", exact: true }))
      .toHaveFocus();
    await userEvent.keyboard("{Tab}{Tab}{Tab}");
    await expect.element(leave).toHaveFocus();
    const leaveBox = leave.element().getBoundingClientRect();
    expect(leaveBox.top).toBeGreaterThanOrEqual(0);
    expect(leaveBox.bottom).toBeLessThanOrEqual(innerHeight);
    await page.screenshot({
      path: `../../../../outputs/uiux-game-titles/enlarged-preparation-running-${theme}-960.png`,
    });
    await userEvent.keyboard("{Enter}");
    await expect.element(page.getByRole("dialog")).not.toBeInTheDocument();
  },
);
