import { afterEach, beforeEach, expect, it } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";
import {
  startInteractiveScenarios,
  stopInteractiveScenarios,
} from "../dev-scenarios/interactive/entry";
import { recoveryKey } from "../dev-scenarios/interactive/transport";
import "../styles/index.css";
beforeEach(async () => {
  localStorage.clear();
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
  document.documentElement.style.fontSize = "";
  sessionStorage.removeItem(recoveryKey);
  localStorage.clear();
  document.body.replaceChildren();
  window.history.replaceState(null, "", "/");
});

it("uses a named compact readiness choice at narrow and enlarged widths without losing its filter", async () => {
  await page.viewport(320, 900);
  mount("library");
  const readiness = page.getByRole("combobox", { name: /^Readiness/ });
  await expect.element(readiness).toBeVisible();
  await readiness.click();
  await page.getByRole("option", { name: "Ready (1)", exact: true }).click();
  await expect.element(readiness).toHaveTextContent("Ready (1)");
  expect(document.querySelectorAll(".collection-entry")).toHaveLength(1);
  expect(document.querySelector(".collection-entry")?.textContent).toContain("Harbor Adventure");
  await page.viewport(1280, 800);
  await expect.element(page.getByRole("button", { name: "Ready (1)", exact: true })).toBeVisible();
  await expect
    .element(page.getByRole("button", { name: "Ready (1)", exact: true }))
    .toHaveAttribute("aria-pressed", "true");
  await expect.element(readiness).not.toBeVisible();
  await page.viewport(1366, 768);
  document.documentElement.style.fontSize = "200%";
  await expect.element(readiness).toBeVisible();
  await readiness.click();
  await page.getByRole("option", { name: "All (2)", exact: true }).click();
  await expect.element(readiness).toHaveTextContent("All (2)");
  expect(document.querySelectorAll(".collection-entry")).toHaveLength(2);
  expect(document.querySelector<HTMLElement>(".collection-readiness-wide")?.checkVisibility()).toBe(
    false,
  );
});

it("uses real App search, readiness filters, chips, artwork fallback, and details/back navigation", async () => {
  mount("library");
  await expect
    .element(
      page.getByRole("button", {
        name: "View details for Harbor Adventure Port: Harbor Adventure",
        exact: true,
      }),
    )
    .toBeVisible();
  await expect
    .element(
      page.getByRole("button", {
        name: "View details for Orchard Quest Port: Orchard Quest",
        exact: true,
      }),
    )
    .toBeVisible();
  await userEvent.fill(page.getByPlaceholder("Game or port name"), "Harbor");
  await expect
    .element(
      page.getByRole("button", {
        name: "View details for Orchard Quest Port: Orchard Quest",
        exact: true,
      }),
    )
    .not.toBeInTheDocument();
  await userEvent.click(page.getByRole("button", { name: "Ready (1)", exact: true }));
  await expect
    .element(page.getByRole("button", { name: "Ready (1)", exact: true }))
    .toHaveAttribute("aria-pressed", "true");
  await expect
    .element(
      page.getByRole("button", {
        name: "View details for Harbor Adventure Port: Harbor Adventure",
        exact: true,
      }),
    )
    .toBeVisible();
  await userEvent.click(
    page.getByRole("button", {
      name: "View details for Harbor Adventure Port: Harbor Adventure",
      exact: true,
    }),
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
  await expect.element(page.getByPlaceholder("Game or port name")).toHaveValue("Harbor");
  await userEvent.click(page.getByRole("button", { name: "Reset journey", exact: true }));
  // Reset remounts the renderer fixture; private browsing preferences still restore.
  await expect.element(page.getByPlaceholder("Game or port name")).toHaveValue("Harbor");
  await userEvent.fill(page.getByPlaceholder("Game or port name"), "");
  await expect.element(page.getByPlaceholder("Game or port name")).toHaveValue("");
  await expect
    .element(
      page.getByRole("button", {
        name: "View details for Orchard Quest Port: Orchard Quest",
        exact: true,
      }),
    )
    .toBeVisible();
});

it("reviews preparation through desktopApi, waits for progress, cancels, fails and completes a fresh review", async () => {
  mount("setup");
  await userEvent.click(
    page.getByRole("button", {
      name: "View details for Harbor Adventure Port: Harbor Adventure",
      exact: true,
    }),
  );
  await expect
    .element(page.getByRole("button", { name: "Prepare game data first", exact: true }))
    .not.toBeInTheDocument();
  const next = page.getByRole("region", { name: "Game actions", exact: true });
  await expect
    .element(next.getByRole("button", { name: "Review game preparation", exact: true }))
    .toBeEnabled();
  expect(next.element().textContent).toContain("Harbor Adventure");
  await userEvent.click(page.getByRole("button", { name: "Review game preparation", exact: true }));
  await expect.element(page.getByText("Selected game files", { exact: true })).toBeVisible();
  await expect.element(page.getByText("fixture/owned.iso", { exact: true })).toBeVisible();
  await userEvent.click(page.getByRole("button", { name: "Prepare game data", exact: true }));
  await expect
    .element(
      page
        .getByRole("dialog")
        .getByText("Fixture preparation is waiting. Complete, fail, or cancel it.", {
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
  await expect.element(page.getByRole("button", { name: "Play", exact: true })).toHaveFocus();
});

it("renders recovery choices, returns to Library via the actual bootstrap hook, and resets", async () => {
  mount("recovery");
  await expect
    .element(page.getByRole("button", { name: "Continue location change", exact: true }))
    .toBeVisible();
  expect(
    page
      .getByRole("button", { name: "Continue location change", exact: true })
      .element()
      .getBoundingClientRect().top,
  ).toBeLessThan(
    page
      .getByRole("button", { name: "Retry startup", exact: true })
      .element()
      .getBoundingClientRect().top,
  );
  await expect
    .element(page.getByRole("button", { name: "Keep using original library", exact: true }))
    .toBeVisible();
  await userEvent.click(page.getByRole("button", { name: "Use platform default", exact: true }));
  await expect.element(page.getByPlaceholder("Game or port name")).toBeVisible();
  await userEvent.click(page.getByRole("button", { name: "Reset journey", exact: true }));
  await expect
    .element(page.getByRole("button", { name: "Continue location change", exact: true }))
    .toBeVisible();
});
