import { afterEach, expect, it } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";
import { cleanup, render } from "vitest-browser-react";
import App from "../App";
import { desktopApi } from "../api";
import { initializeLocalization, LocalizationProvider } from "../localization";
import { installInteractiveTransport } from "../dev-scenarios/interactive/transport";

let transport: ReturnType<typeof installInteractiveTransport> | undefined;
afterEach(async () => {
  await cleanup();
  transport?.dispose();
  localStorage.clear();
});

async function mount(width: number) {
  localStorage.clear();
  await page.viewport(width, 640);
  transport = installInteractiveTransport("collection", (message) => {
    throw new Error(message);
  });
  initializeLocalization(["en"]);
  await render(
    <LocalizationProvider api={desktopApi}>
      <App />
    </LocalizationProvider>,
  );
  await expect.poll(() => document.querySelectorAll(".collection-entry").length).toBe(12);
  return page.getByRole("group", { name: "Library filters" }).element();
}

function readinessClosed(id: string) {
  const list = document.getElementById(id);
  if (!list) return true;
  const popup = list.closest('[data-slot="select-content"]');
  const shield = popup?.parentElement?.previousElementSibling;
  const blocked =
    shield?.hasAttribute("data-base-ui-inert") &&
    !shield.hasAttribute("inert") &&
    shield.getClientRects().length > 0 &&
    getComputedStyle(shield).pointerEvents !== "none";
  return Boolean(
    popup?.hasAttribute("data-closed") && list.getClientRects().length === 0 && !blocked,
  );
}

async function openDetails() {
  await page
    .getByRole("button", { name: /^View details for/ })
    .first()
    .click();
  await expect
    .element(page.getByRole("button", { name: "Back to previous workspace" }))
    .toBeVisible();
}

for (const width of [640, 1600]) {
  it(`uses the named readiness picker and reaches details after selection at ${width}px`, async () => {
    await mount(width);
    const picker = page.getByRole("combobox", { name: /^Readiness / });
    await expect.element(picker).toBeVisible();
    await picker.click();
    const listId = picker.element().getAttribute("aria-controls")!;
    await page.getByRole("option", { name: /^Ready \(/ }).click();
    await expect.element(picker).toHaveAttribute("aria-expanded", "false");
    await expect.poll(() => readinessClosed(listId)).toBe(true);
    expect(document.querySelectorAll(".collection-entry").length).toBeLessThan(12);
    await openDetails();
    await page.getByRole("button", { name: "Back to previous workspace" }).click();
    await expect.element(picker).toHaveTextContent("Ready (");
    picker.element().focus();
    await expect.element(picker).toHaveFocus();
    await userEvent.keyboard("{Enter}");
    await expect.element(page.getByRole("option", { name: /^All \(/ })).toBeVisible();
    await userEvent.keyboard("{Escape}");
    await expect.element(picker).toHaveFocus();
  });
}
