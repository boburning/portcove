import { afterEach, beforeEach, expect, it } from "vitest";
import { page, userEvent } from "vitest/browser";
import {
  startInteractiveScenarios,
  stopInteractiveScenarios,
} from "../dev-scenarios/interactive/entry";
import { recoveryKey } from "../dev-scenarios/interactive/transport";
import "../styles.css";
beforeEach(async () => {
  await page.viewport(1280, 800);
});

function mount(journey: string) {
  window.history.replaceState(null, "", `/scenarios.html?mode=interactive&journey=${journey}`);
  document.body.innerHTML =
    '<select id="scenario" aria-label="Journey"></select><p id="scenario-limitation"></p><div id="scenario-preview"></div>';
  startInteractiveScenarios();
}
afterEach(() => {
  stopInteractiveScenarios();
  sessionStorage.removeItem(recoveryKey);
  document.body.replaceChildren();
  window.history.replaceState(null, "", "/");
});

it("uses real App search, readiness filters, chips, artwork fallback, and details/back navigation", async () => {
  mount("library");
  await expect
    .element(page.getByRole("button", { name: "View details for Harbor Adventure", exact: true }))
    .toBeVisible();
  await expect
    .element(page.getByRole("button", { name: "View details for Orchard Quest", exact: true }))
    .toBeVisible();
  await userEvent.fill(page.getByPlaceholder("Search ports"), "Harbor");
  await expect
    .element(page.getByRole("button", { name: "View details for Orchard Quest", exact: true }))
    .not.toBeInTheDocument();
  await userEvent.click(page.getByRole("button", { name: "Ready", exact: true }));
  await expect
    .element(page.getByRole("button", { name: "Ready", exact: true }))
    .toHaveAttribute("aria-pressed", "true");
  await expect
    .element(page.getByRole("button", { name: "View details for Harbor Adventure", exact: true }))
    .toBeVisible();
  await userEvent.click(
    page.getByRole("button", { name: "View details for Harbor Adventure", exact: true }),
  );
  await expect
    .element(page.getByRole("button", { name: "Back to previous workspace", exact: true }))
    .toBeVisible();
  expect(document.querySelector('[aria-labelledby="port-detail-title"]')?.textContent).toContain(
    "Harbor Adventure",
  );
  expect(document.querySelector('[data-artwork-source="generated_fallback"]')).not.toBeNull();
  await userEvent.click(
    page.getByRole("button", { name: "Back to previous workspace", exact: true }),
  );
  await expect.element(page.getByPlaceholder("Search ports")).toHaveValue("Harbor");
  await userEvent.click(page.getByRole("button", { name: "Reset journey", exact: true }));
  await expect.element(page.getByPlaceholder("Search ports")).toHaveValue("");
  await expect
    .element(page.getByRole("button", { name: "View details for Orchard Quest", exact: true }))
    .toBeVisible();
});

it("reviews preparation through desktopApi, waits for progress, cancels, fails and completes a fresh review", async () => {
  mount("setup");
  await userEvent.click(
    page.getByRole("button", { name: "View details for Harbor Adventure", exact: true }),
  );
  await userEvent.click(page.getByRole("button", { name: "Review game preparation", exact: true }));
  await expect
    .element(page.getByText("Selected game files: fixture/owned.iso", { exact: true }))
    .toBeVisible();
  await userEvent.click(page.getByRole("button", { name: "Prepare game data", exact: true }));
  await expect
    .element(
      page.getByText("Fixture preparation is waiting. Complete, fail, or cancel it.", {
        exact: true,
      }),
    )
    .toBeVisible();
  await userEvent.click(page.getByRole("button", { name: "Cancel preparation", exact: true }));
  await expect.element(page.getByRole("dialog")).not.toBeInTheDocument();
  await userEvent.click(page.getByRole("button", { name: "Review game preparation", exact: true }));
  await userEvent.click(page.getByRole("button", { name: "Prepare game data", exact: true }));
  await userEvent.keyboard("{Alt>}{Shift>}F{/Shift}{/Alt}");
  await expect.element(page.getByRole("dialog")).not.toBeInTheDocument();
  await expect
    .element(page.getByText("Controlled fixture preparation failure", { exact: false }).first())
    .toBeVisible();
  await userEvent.click(page.getByRole("button", { name: "Review game preparation", exact: true }));
  await userEvent.click(page.getByRole("button", { name: "Prepare game data", exact: true }));
  await userEvent.keyboard("{Alt>}{Shift>}{Enter}{/Shift}{/Alt}");
  await expect.element(page.getByRole("dialog")).not.toBeInTheDocument();
  await expect
    .element(page.getByRole("button", { name: "Review game preparation", exact: true }))
    .not.toBeInTheDocument();
  await expect
    .poll(() => document.querySelector('[aria-labelledby="port-detail-title"]')?.textContent)
    .toContain("Ready to play");
});

it("renders recovery choices, returns to Library via the actual bootstrap hook, and resets", async () => {
  mount("recovery");
  await expect
    .element(page.getByRole("button", { name: "Resume move", exact: true }))
    .toBeVisible();
  await expect
    .element(page.getByRole("button", { name: "Keep using original library", exact: true }))
    .toBeVisible();
  await userEvent.click(page.getByRole("button", { name: "Use platform default", exact: true }));
  await expect.element(page.getByPlaceholder("Search ports")).toBeVisible();
  await userEvent.click(page.getByRole("button", { name: "Reset journey", exact: true }));
  await expect
    .element(page.getByRole("button", { name: "Resume move", exact: true }))
    .toBeVisible();
});
