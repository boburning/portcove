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

function matches(filters: Element, expression: string) {
  const result = document.evaluate(
    expression,
    filters,
    null,
    XPathResult.ORDERED_NODE_SNAPSHOT_TYPE,
  );
  return Array.from(
    { length: result.snapshotLength },
    (_, index) => result.snapshotItem(index) as HTMLButtonElement,
  );
}

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

it("distinguishes the compact Select trigger from native wide choices and reaches details after selection", async () => {
  const filters = await mount(640);
  const oldCandidates = matches(filters, './/button[starts-with(normalize-space(.),"All (")]');
  const wideCandidates = matches(
    filters,
    './/button[not(@role="combobox")][starts-with(normalize-space(.),"All (")]',
  );
  expect(
    oldCandidates.some(
      (candidate) =>
        candidate.getAttribute("role") === "combobox" && candidate.getClientRects().length > 0,
    ),
  ).toBe(true);
  expect(wideCandidates.some((candidate) => candidate.getClientRects().length > 0)).toBe(false);
  const picker = page.getByRole("combobox", { name: /^Readiness / });
  await picker.click();
  const listId = picker.element().getAttribute("aria-controls")!;
  await page.getByRole("option", { name: /^All \(/ }).click();
  await expect.element(picker).toHaveAttribute("aria-expanded", "false");
  await expect.poll(() => readinessClosed(listId)).toBe(true);
  await openDetails();
});

it("uses the actual wide readiness button and reaches game details at desktop size", async () => {
  const filters = await mount(1600);
  const candidates = matches(
    filters,
    './/button[not(@role="combobox")][starts-with(normalize-space(.),"All (")]',
  );
  const visible = candidates.filter((candidate) => candidate.getClientRects().length > 0);
  expect(visible).toHaveLength(1);
  expect(visible[0]!.getAttribute("role")).not.toBe("combobox");
  await userEvent.click(visible[0]!);
  await openDetails();
});
