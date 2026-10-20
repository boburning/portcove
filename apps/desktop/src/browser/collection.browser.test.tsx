import axe from "axe-core";
import { afterEach, expect, it, vi } from "vite-plus/test";
import { page } from "vite-plus/test/browser";
import { cleanup, render } from "vitest-browser-react";
import App from "../App";
import { desktopApi } from "../api";
import { artworkState } from "../test-fixtures";
import { initializeLocalization, LocalizationProvider } from "../localization";
import { installInteractiveTransport } from "../dev-scenarios/interactive/transport";
import { collectionLayoutKey } from "../features/browsing/use-collection-layout";
import "../styles/index.css";

let transport: ReturnType<typeof installInteractiveTransport> | undefined;
afterEach(async () => {
  await cleanup();
  transport?.dispose();
  transport = undefined;
  localStorage.clear();
  vi.restoreAllMocks();
  document.documentElement.removeAttribute("data-theme");
  document.querySelector("#collection-spacing")?.remove();
});

async function mount(theme: string) {
  transport = installInteractiveTransport("collection", (message) => {
    throw new Error(message);
  });
  initializeLocalization(["en"]);
  document.documentElement.dataset.theme = theme;
  await render(
    <LocalizationProvider api={desktopApi}>
      <App />
    </LocalizationProvider>,
  );
  await expect.element(page.getByRole("button", { name: "Covers", exact: true })).toBeVisible();
  await expect.poll(() => document.querySelectorAll(".collection-entry").length).toBe(12);
}

it("retains a session-only layout through the real details unmount and return", async () => {
  localStorage.clear();
  await page.viewport(1280, 800);
  const key = collectionLayoutKey("fixture/library");
  const write = Storage.prototype.setItem;
  vi.spyOn(Storage.prototype, "setItem").mockImplementation(function (
    this: Storage,
    keyToWrite,
    value,
  ) {
    if (keyToWrite === key) throw new Error("fixture layout storage unavailable");
    return write.call(this, keyToWrite, value);
  });
  await mount("dark");
  await page.getByRole("button", { name: "Compact rows", exact: true }).click();
  expect(localStorage.getItem(key)).toBeNull();
  await page
    .getByRole("button", { name: /^View details for Super Mario 64 Port: sm64-port$/ })
    .click();
  expect(document.querySelector(".collection-rows")).toBeNull();
  await page.getByRole("button", { name: "Back to previous workspace", exact: true }).click();
  await expect
    .element(page.getByRole("button", { name: "Compact rows", exact: true }))
    .toHaveAttribute("aria-pressed", "true");
  expect(document.querySelectorAll(".collection-row")).toHaveLength(12);
  expect(document.body.textContent).toContain(
    "This collection view is available for this session; it could not be saved.",
  );
  expect(document.activeElement?.getAttribute("data-detail-game-id")).toBe("collection-0");
});

for (const theme of ["dark", "light"]) {
  it(`keeps distinct identities, bounded art and shared actions in ${theme} covers and rows`, async () => {
    localStorage.clear();
    await page.viewport(1600, 1000);
    await mount(theme);
    const entries = [...document.querySelectorAll<HTMLElement>(".collection-entry")];
    expect(document.querySelector('[aria-label="Search results"]')?.textContent).toBe(
      "12 library entries",
    );
    expect(entries[0]!.textContent).toContain("Super Mario 64");
    expect(entries[1]!.textContent).toContain("Super Mario 64");
    expect(entries[0]!.textContent).toContain("sm64-port");
    expect(entries[1]!.textContent).toContain("Mario modern port · Modern renderer");
    expect(entries[2]!.querySelector(".collection-title")?.textContent).toContain(
      "Complete Edition",
    );
    expect(document.querySelector("button button, button a, a button")).toBeNull();
    const labels = await axe.run(document.querySelector('[aria-label="Library entries"]')!, {
      runOnly: { type: "rule", values: ["label-content-name-mismatch"] },
    });
    expect(
      labels.violations,
      JSON.stringify(
        [...document.querySelectorAll(".collection-identity")].map((node) => ({
          name: node.getAttribute("aria-label"),
          text: node.textContent,
          visible: (node as HTMLElement).innerText,
        })),
      ),
    ).toEqual([]);
    // Speech input must be able to use the full visible identity and action label.
    for (const entry of entries) {
      const identity = entry.querySelector<HTMLButtonElement>(".collection-identity")!;
      const visibleIdentity = [".collection-title", ".collection-project"]
        .map((selector) => entry.querySelector(selector)!.textContent.trim())
        .join(" ");
      expect(identity.getAttribute("aria-label")).toContain(visibleIdentity);
      for (const action of entry.querySelectorAll<HTMLButtonElement>(
        ".collection-actions button[data-detail-origin$=':review']",
      )) {
        const visibleAction = action.textContent.trim();
        expect(visibleAction).toBe("Review game");
        expect(action.getAttribute("aria-label")).toContain(visibleAction);
      }
    }
    await expect
      .poll(() => document.querySelectorAll(".collection-art img").length)
      .toBeGreaterThan(2);
    const art = entries
      .slice(0, 4)
      .map((entry) => entry.querySelector<HTMLElement>(".collection-art")!.getBoundingClientRect());
    for (const box of art) {
      expect(box.width).toBeGreaterThanOrEqual(175);
      expect(box.width).toBeLessThanOrEqual(221);
      expect(Math.abs(box.height / box.width - 1.5)).toBeLessThan(0.02);
      expect(Math.abs(box.height - art[0]!.height)).toBeLessThan(1);
    }
    for (const image of document.querySelectorAll(".collection-art img"))
      expect(getComputedStyle(image).objectFit).toBe("contain");
    expect(entries[3]!.textContent).toContain("Review downloaded update");
    expect(entries[3]!.querySelector(".collection-actions")?.textContent).toContain("Play");
    expect(entries[4]!.textContent).toContain("Game files missing");
    expect(entries[4]!.querySelector(".collection-actions")?.textContent).toContain("Review game");
    expect(entries[0]!.textContent).not.toContain("Stable");
    const firstRow = entries.filter(
      (entry) =>
        Math.abs(entry.getBoundingClientRect().top - entries[0]!.getBoundingClientRect().top) < 1,
    );
    const actionBottom = firstRow.map(
      (entry) => entry.querySelector(".collection-actions")!.getBoundingClientRect().bottom,
    );
    expect(Math.max(...actionBottom) - Math.min(...actionBottom)).toBeLessThan(1);
    await page.getByRole("button", { name: "Compact rows", exact: true }).click();
    expect(localStorage.getItem(collectionLayoutKey("fixture/library"))).toBe("rows");
    expect(document.querySelectorAll(".collection-row")).toHaveLength(12);
    expect(entries[3]!.querySelector(".collection-actions")?.textContent).toContain("Play");
    expect(entries[4]!.querySelector(".collection-actions")?.textContent).toContain("Review game");
    await page
      .getByRole("textbox", { name: "Search your library", exact: true })
      .fill("Super Mario 64");
    await expect.poll(() => document.querySelectorAll(".collection-entry").length).toBe(2);
    await page
      .getByRole("button", { name: /^View details for Super Mario 64 Port: sm64-port$/ })
      .click();
    await page.getByRole("button", { name: "Back to previous workspace", exact: true }).click();
    await expect
      .element(page.getByRole("textbox", { name: "Search your library", exact: true }))
      .toHaveValue("Super Mario 64");
    expect(document.querySelectorAll(".collection-row")).toHaveLength(2);
    expect(document.activeElement?.getAttribute("data-detail-game-id")).toBe("collection-0");
  });

  it(`keeps ${theme} collection actions in one reading flow at actual narrow widths and spacing overrides`, async () => {
    localStorage.clear();
    await page.viewport(960, 640);
    await mount(theme);
    expect(document.querySelector(".collection-art")!.getBoundingClientRect().width).toBeCloseTo(
      112,
      0,
    );
    const spacing = document.createElement("style");
    spacing.id = "collection-spacing";
    spacing.textContent =
      "*{line-height:1.5!important;letter-spacing:.12em!important;word-spacing:.16em!important}p{margin-bottom:2em!important}";
    document.head.append(spacing);
    for (const layout of ["Covers", "Compact rows"]) {
      await page.getByRole("button", { name: layout, exact: true }).click();
      for (const width of [320, 240]) {
        await page.viewport(width, 640);
        expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(
          document.documentElement.clientWidth + 1,
        );
        for (const entry of document.querySelectorAll(".collection-entry")) {
          const box = entry.getBoundingClientRect();
          expect(box.right).toBeLessThanOrEqual(width + 1);
          expect(
            entry.querySelector(".collection-identity")!.getBoundingClientRect().bottom,
          ).toBeLessThanOrEqual(
            entry.querySelector(".collection-actions")!.getBoundingClientRect().top + 1,
          );
        }
      }
    }
  });
}

it("keeps failed artwork feedback outside the details action name", async () => {
  vi.spyOn(desktopApi, "artwork").mockImplementation(async (id, slot) => ({
    ...artworkState(id, slot),
    availability: "unavailable",
  }));
  await page.viewport(1280, 800);
  await mount("dark");
  await expect
    .poll(() => document.querySelector(".collection-state")?.textContent)
    .toContain("Image unavailable");
  const identity = document.querySelector<HTMLButtonElement>(".collection-identity")!;
  expect(identity.textContent).not.toContain("Image unavailable");
  expect(identity.querySelector(".collection-art svg")).not.toBeNull();
  const labels = await axe.run(document.querySelector('[aria-label="Library entries"]')!, {
    runOnly: { type: "rule", values: ["label-content-name-mismatch"] },
  });
  expect(labels.violations).toEqual([]);
});
