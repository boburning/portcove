import { afterEach, expect, it } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";
import { cleanup, render } from "vitest-browser-react";
import App from "../App";
import { desktopApi } from "../api";
import { installInteractiveTransport } from "../dev-scenarios/interactive/transport";
import { initializeLocalization, LocalizationProvider } from "../localization";
import "../styles/index.css";

let transport: ReturnType<typeof installInteractiveTransport> | undefined;
afterEach(async () => {
  await cleanup();
  transport?.dispose();
  document.getElementById("root")?.remove();
  document.documentElement.style.removeProperty("font-size");
  localStorage.clear();
});

it.each([
  [320, 800, "100%"],
  [960, 640, "200%"],
] as const)(
  "keeps startup recovery and its final actions reachable at %s×%s with %s text",
  async (width, height, scale) => {
    await page.viewport(width, height);
    localStorage.clear();
    document.documentElement.style.fontSize = scale;
    transport = installInteractiveTransport("recovery", (message) => {
      throw Error(message);
    });
    initializeLocalization(["en"]);
    const root = document.createElement("div");
    root.id = "root";
    document.body.append(root);
    await render(
      <LocalizationProvider api={desktopApi}>
        <App />
      </LocalizationProvider>,
      { container: root },
    );
    await expect
      .element(page.getByRole("heading", { name: "Portcove couldn’t start", exact: true }))
      .toBeVisible();
    const main = document.querySelector<HTMLElement>(".bootstrap-error")!;
    expect(main.scrollHeight).toBeGreaterThan(main.clientHeight);
    expect(main.scrollWidth).toBeLessThanOrEqual(main.clientWidth + 1);
    const actions = [...main.querySelectorAll<HTMLButtonElement>("button")].filter(
      (button) => !button.disabled && button.checkVisibility(),
    );
    expect(actions.length).toBeGreaterThan(4);
    for (const action of actions) {
      action.focus();
      await expect.poll(() => document.activeElement).toBe(action);
      await expect.poll(() => action.getBoundingClientRect().top).toBeGreaterThanOrEqual(0);
      await expect
        .poll(() => action.getBoundingClientRect().bottom)
        .toBeLessThanOrEqual(height + 1);
    }
    expect(main.scrollTop).toBeGreaterThan(0);
    actions[0]!.focus();
    await userEvent.tab();
    expect(main.contains(document.activeElement)).toBe(true);
    expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(width + 1);
  },
);
