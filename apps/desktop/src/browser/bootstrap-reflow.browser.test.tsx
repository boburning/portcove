import { afterEach, expect, it } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";
import { cleanup, render } from "vitest-browser-react";
import { captureParityState } from "../../test/parity-capture";
import App, { BootstrapRecovery } from "../App";
import { desktopApi } from "../api";
import { installInteractiveTransport } from "../dev-scenarios/interactive/transport";
import { initializeLocalization, LocalizationProvider } from "../localization";
import { failureReport } from "../test-fixtures";
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

it("announces the generic startup uncertainty once and keeps recovery actions available", async () => {
  await page.viewport(1028, 750);
  initializeLocalization(["en"]);
  const error = failureReport();
  error.code = "state";
  error.presentation.presentation_key = "state_unavailable";
  error.presentation.mutation_state = "unknown";
  error.presentation.summary = "The current operation state could not be confirmed.";
  error.presentation.technical_message =
    "Cannot create a file when that file already exists. (os error 183)";
  const root = document.createElement("div");
  root.id = "root";
  document.body.append(root);
  await render(
    <BootstrapRecovery
      error={error}
      switchLibrary={async () => {}}
      resetLibrary={async () => {}}
    />,
    { container: root },
  );

  const warning = "Portcove couldn't confirm whether anything changed.";
  await expect.element(page.getByRole("alert")).toHaveTextContent(warning);
  await expect.element(page.getByText(warning)).toBeVisible();
  await expect.element(page.getByText(error.presentation.summary)).not.toBeInTheDocument();
  for (const name of ["Retry startup", "Choose library", "Use platform default"]) {
    await expect.element(page.getByRole("button", { name, exact: true })).toBeEnabled();
  }
  await captureParityState("startup-recovery-unknown-outcome");

  const details = page.getByText("View technical details", { exact: true });
  await details.click();
  await expect.element(page.getByText(error.presentation.technical_message)).toBeVisible();
  await expect.element(page.getByRole("button", { name: "Copy technical details" })).toBeEnabled();
});
