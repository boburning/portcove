import { filterChoice } from "../../test/filter-fields";
import { afterEach, expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";
import { cleanup, render } from "vitest-browser-react";
import axe from "axe-core";
import App from "../App";
import { desktopApi } from "../api";
import { installInteractiveTransport } from "../dev-scenarios/interactive/transport";
import { comparisonEntries } from "../dev-scenarios/interactive/comparison-scene";
import type { Journey } from "../dev-scenarios/interactive/scenarios";
import { initializeLocalization, LocalizationProvider } from "../localization";
import "../styles/index.css";

let transport: ReturnType<typeof installInteractiveTransport> | undefined;
afterEach(async () => {
  await cleanup();
  document.getElementById("root")?.remove();
  document.getElementById("detail-text-spacing")?.remove();
  transport?.dispose();
  transport = undefined;
  vi.restoreAllMocks();
  localStorage.clear();
  document.documentElement.style.removeProperty("font-size");
  delete document.documentElement.dataset.theme;
});

async function mount(theme: string, journey: Journey = "comparison") {
  localStorage.clear();
  const root = document.createElement("div");
  root.id = "root";
  document.body.append(root);
  transport = installInteractiveTransport(journey, (message) => {
    throw Error(message);
  });
  initializeLocalization(["en"]);
  await render(
    <LocalizationProvider api={desktopApi}>
      <App />
    </LocalizationProvider>,
    { container: root },
  );
  await expect
    .poll(() => document.querySelectorAll(".collection-entry").length)
    .toBe(journey === "comparison" ? 12 : journey === "details" ? 6 : 2);
  document.documentElement.dataset.theme = theme;
  await document.fonts.ready;
}
async function open(index = 0) {
  const entry = comparisonEntries[index]!;
  await page
    .getByRole("button", {
      name: `View details for ${entry.title} ${entry.port}${entry.variant ? " · " + entry.variant : ""}`,
      exact: true,
    })
    .click();
  await expect.element(page.getByRole("heading", { name: entry.title, exact: true })).toHaveFocus();
}
function contained() {
  expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(innerWidth);
  const workspace = document.querySelector<HTMLElement>("[data-focus-region=workspace]")!;
  expect(workspace.scrollWidth).toBeLessThanOrEqual(workspace.clientWidth + 1);
  for (const tab of document.querySelectorAll<HTMLElement>("[role=tab]")) {
    const box = tab.getBoundingClientRect();
    expect(box.left).toBeGreaterThanOrEqual(0);
    expect(box.right).toBeLessThanOrEqual(innerWidth);
  }
}
async function capture(name: string, atTop = true) {
  if (atTop) {
    window.scrollTo(0, 0);
    document.querySelector<HTMLElement>("[data-focus-region=workspace]")!.scrollTop = 0;
  }
  // Capture the viewport rectangle. The browser test document can be taller
  // than its iframe; a document screenshot otherwise pads below the viewport.
  const frame = document.createElement("div");
  frame.setAttribute("aria-hidden", "true");
  frame.style.cssText = "position:fixed;inset:0;pointer-events:none";
  document.body.append(frame);
  try {
    await new Promise(requestAnimationFrame);
    await new Promise(requestAnimationFrame);
    await page.screenshot({ path: `../../../../outputs/detail-tabs/${name}.png`, element: frame });
  } finally {
    frame.remove();
  }
}

for (const theme of ["dark", "light"]) {
  for (const [width, height] of [
    [1366, 768],
    [1600, 1000],
    [960, 640],
  ] as const) {
    it(`renders all production tabs without overflow in ${theme} at ${width}x${height}`, async () => {
      await page.viewport(width, height);
      await mount(theme);
      await open();
      const cover = document.querySelector(".detail-cover")!.getBoundingClientRect();
      expect(cover.width).toBeGreaterThanOrEqual(72);
      expect(cover.width).toBeLessThanOrEqual(148);
      expect(cover.height).toBe(cover.width * 1.5);
      const play = page.getByRole("button", { name: "Play", exact: true });
      expect(play.element().getBoundingClientRect().width).toBeGreaterThanOrEqual(180);
      expect(play.element().getBoundingClientRect().width).toBeLessThanOrEqual(220);
      await capture(`managed-${theme}-${width}`);
      for (const label of [
        "Overview",
        "Game files",
        "Saves & backups",
        "Versions & updates",
        "Manage",
      ]) {
        await page.getByRole("tab", { name: label, exact: true }).click();
        contained();
        const detail = document.querySelector<HTMLElement>("[data-detail-workspace]")!;
        const result = await axe.run(detail, {
          runOnly: {
            type: "rule",
            values: [
              "color-contrast",
              "aria-required-children",
              "aria-required-parent",
              "aria-valid-attr-value",
            ],
          },
        });
        expect(
          result.violations.map((item) => ({
            id: item.id,
            targets: item.nodes.map((node) => node.target),
          })),
        ).toEqual([]);
      }
    });
  }
}

it.each(["dark", "light"])(
  "reflows long identity, enlarged text and text spacing in %s",
  async (theme) => {
    await page.viewport(1366, 768);
    await mount(theme);
    await open(2);
    document.documentElement.style.fontSize = "200%";
    contained();
    expect(
      document.querySelector(".detail-cover")!.getBoundingClientRect().width,
    ).toBeLessThanOrEqual(108);
    await capture(`enlarged-text-${theme}`);
    document.documentElement.style.removeProperty("font-size");
    await page.viewport(320, 720);
    contained();
    const cover = document.querySelector(".detail-cover")!.getBoundingClientRect();
    expect([cover.width, cover.height]).toEqual([96, 144]);
    await capture(`long-identity-${theme}-320`);
    const spacing = document.createElement("style");
    spacing.id = "detail-text-spacing";
    spacing.textContent =
      "* { line-height: 1.5 !important; letter-spacing: .12em !important; word-spacing: .16em !important; } p { margin-bottom: 2em !important; }";
    document.head.append(spacing);
    for (const label of [
      "Overview",
      "Game files",
      "Saves & backups",
      "Versions & updates",
      "Manage",
    ]) {
      await page.getByRole("tab", { name: label, exact: true }).click();
      contained();
    }
    await capture(`text-spacing-${theme}-320`);
  },
);

it("keeps whole-image portrait, landscape, square and missing artwork at a fixed frame size", async () => {
  await page.viewport(1600, 1000);
  await mount("dark");
  for (const index of [0, 1, 2]) {
    await open(index);
    const cover = document.querySelector<HTMLElement>(".detail-cover")!;
    const frame = cover.getBoundingClientRect();
    expect(frame.width).toBeLessThanOrEqual(148);
    expect(frame.height).toBe(frame.width * 1.5);
    await expect.poll(() => cover.querySelector("img")?.naturalWidth ?? 0).toBeGreaterThan(0);
    expect(getComputedStyle(cover.querySelector("img")!).objectFit).toBe("contain");
    await capture(`artwork-${index}-dark`);
    await page.getByRole("button", { name: /^Back to (Library|Discover)$/, exact: true }).click();
  }
  await open(4);
  await expect
    .element(page.getByRole("tab", { name: "Game files", exact: true }))
    .toHaveAttribute("aria-selected", "true");
  expect(document.querySelector(".detail-cover img")).toBeNull();
  await capture("artwork-4-dark");
});

it.each(["dark", "light"])(
  "renders staged, external, downloaded and backup-failure panels in %s",
  async (theme) => {
    await page.viewport(960, 640);
    await mount(theme, "details");
    await page.getByRole("button", { name: "Update prepared", exact: true }).click();
    await expect
      .element(page.getByRole("heading", { name: "Versions & updates", exact: true }))
      .toHaveFocus();
    await expect.element(page.getByRole("button", { name: "Play", exact: true })).toBeEnabled();
    page
      .getByRole("button", { name: "Use update · 1.3", exact: true })
      .element()
      .scrollIntoView({ block: "center" });
    contained();
    await capture(`staged-${theme}-960`, false);
    await page.getByRole("button", { name: /^Back to (Library|Discover)$/, exact: true }).click();
    await page
      .getByRole("button", {
        name: "View details for Summit Racer Harbor upstream project · external",
        exact: true,
      })
      .click();
    await page.getByRole("tab", { name: "Game files", exact: true }).click();
    page
      .getByRole("heading", { name: "Launch details", exact: true })
      .element()
      .scrollIntoView({ block: "start" });
    contained();
    await capture(`external-${theme}-960`, false);
    await page.getByRole("button", { name: /^Back to (Library|Discover)$/, exact: true }).click();
    await page
      .getByRole("button", {
        name: "View details for Summit Racer Harbor upstream project · unknown",
        exact: true,
      })
      .click();
    await expect
      .element(page.getByRole("tab", { name: "Game files", exact: true }))
      .toHaveAttribute("aria-selected", "true");
    await expect
      .element(page.getByRole("button", { name: "Play", exact: true }))
      .not.toBeInTheDocument();
    contained();
    await capture(`external-unknown-${theme}-960`);
    await page.getByRole("button", { name: /^Back to (Library|Discover)$/, exact: true }).click();
    await page
      .getByRole("button", {
        name: "View details for Moonlit Harbor Harbor upstream project · downloaded",
        exact: true,
      })
      .click();
    await page.getByRole("button", { name: "Continue setup", exact: true }).first().click();
    await expect
      .element(page.getByRole("region", { name: "Set up and launch", exact: true }))
      .toHaveFocus();
    await page
      .getByRole("textbox", { name: "Working directory", exact: true })
      .fill("fixture/disposable-retained-draft");
    await page.getByRole("tab", { name: "Versions & updates", exact: true }).click();
    await page.getByRole("tab", { name: "Game files", exact: true }).click();
    await expect
      .element(page.getByRole("textbox", { name: "Working directory", exact: true }))
      .toHaveValue("fixture/disposable-retained-draft");
    page
      .getByRole("heading", { name: "Launch details", exact: true })
      .element()
      .scrollIntoView({ block: "start" });
    contained();
    await capture(`downloaded-${theme}-960`, false);
    await page.getByRole("button", { name: /^Back to (Library|Discover)$/, exact: true }).click();
    await page
      .getByRole("button", {
        name: "View details for Orchard Quest Harbor desktop port · Backup history unavailable",
        exact: true,
      })
      .click();
    await page.getByRole("tab", { name: "Saves & backups", exact: true }).click();
    await expect
      .element(page.getByRole("button", { name: "Retry backup history", exact: true }))
      .toBeVisible();
    page
      .getByRole("button", { name: "Retry backup history", exact: true })
      .element()
      .scrollIntoView({ block: "center" });
    contained();
    await capture(`backup-error-${theme}-960`, false);
  },
);

it.each(["dark", "light"])("renders the production preparation owner in %s", async (theme) => {
  await page.viewport(960, 640);
  await mount(theme, "setup");
  await page
    .getByRole("button", {
      name: "View details for Harbor Adventure Harbor Adventure",
      exact: true,
    })
    .click();
  await expect
    .element(page.getByRole("tab", { name: "Game files", exact: true }))
    .toHaveAttribute("aria-selected", "true");
  page
    .getByRole("button", { name: "Review setup", exact: true })
    .element()
    .scrollIntoView({ block: "center" });
  contained();
  await capture(`preparation-${theme}-960`, false);
});

it.each(["dark", "light"])("preserves transparent artwork against the %s frame", async (theme) => {
  await page.viewport(960, 640);
  const canvas = document.createElement("canvas");
  canvas.width = 120;
  canvas.height = 180;
  const context = canvas.getContext("2d")!;
  context.fillStyle = "#b94738";
  context.fillRect(30, 40, 60, 100);
  const png = canvas.toDataURL("image/png").split(",")[1]!;
  vi.spyOn(desktopApi, "artworkThumbnail").mockImplementation(async (_id, _slot, revision) => ({
    asset_sha256: "1".repeat(64),
    choice_revision: revision,
    png_base64: png,
  }));
  await mount(theme);
  await open();
  await expect
    .poll(() => document.querySelector<HTMLImageElement>(".detail-cover img")?.naturalWidth ?? 0)
    .toBe(120);
  expect(getComputedStyle(document.querySelector(".detail-cover img")!).objectFit).toBe("contain");
  contained();
  await capture(`transparent-${theme}-960`);
});

it("opens and focuses the real artwork disclosure from the hero menu after Manage rows are flattened", async () => {
  await mount("dark");
  await open();
  await page.getByRole("button", { name: /^More actions for / }).click();
  await page.getByRole("menuitem", { name: "Change artwork", exact: true }).click();
  await expect
    .element(page.getByRole("tab", { name: "Manage", exact: true }))
    .toHaveAttribute("aria-selected", "true");
  const summary = page.elementLocator(
    document.querySelector<HTMLElement>(".artwork-controls > summary")!,
  );
  await expect.element(summary).toHaveFocus();
  expect(summary.element().closest("details")?.open).toBe(true);
  expect(document.activeElement?.closest("[inert], [hidden]")).toBeNull();
});

it.each(["Library", "Discover"])("names and restores the known %s origin", async (origin) => {
  await mount("dark");
  if (origin === "Discover") await page.getByRole("button", { name: /^Discover(?:\s|$)/ }).click();
  if (origin === "Discover") {
    await userEvent.click(
      document.querySelector<HTMLButtonElement>(
        '[data-detail-origin="catalog:card:comparison-0"]',
      )!,
    );
  } else await open();
  const back = page.getByRole("button", { name: `Back to ${origin}`, exact: true });
  await expect.element(back).toBeVisible();
  await back.click();
  expect(document.activeElement?.getAttribute("data-detail-origin")).toMatch(
    new RegExp(`^${origin === "Library" ? "library" : "catalog"}:`),
  );
});

it("clears search inline, returns focus and retains the declared platform constraint", async () => {
  await mount("dark");
  await page.getByRole("button", { name: "Filters (0)", exact: true }).click();
  await userEvent.click(await filterChoice("Windows (12)"));
  await userEvent.keyboard("{Escape}");
  await page.getByRole("button", { name: "Done", exact: true }).click();
  const search = page.getByRole("textbox", { name: "Search your library", exact: true });
  await search.fill("Harbor Adventure");
  await expect.poll(() => document.querySelectorAll(".collection-entry").length).toBe(2);
  await page.getByRole("button", { name: "Clear search", exact: true }).click();
  await expect.element(search).toHaveValue("");
  await expect.element(search).toHaveFocus();
  await expect
    .element(page.getByRole("button", { name: "Remove Windows filter", exact: true }))
    .toBeVisible();
  await expect.poll(() => document.querySelectorAll(".collection-entry").length).toBe(12);
});

it.each([1440, 1024, 740])(
  "keeps hero Play comfortably wide and contained at %ipx",
  async (width) => {
    await page.viewport(width, 900);
    await mount("dark");
    await open(2);
    for (const scale of [1, 1.3]) {
      document.documentElement.style.fontSize = `${16 * scale}px`;
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
      const actions = document.querySelector<HTMLElement>(".detail-header-actions")!;
      const play = [...actions.querySelectorAll<HTMLButtonElement>("button")].find(
        (button) => button.textContent?.trim() === "Play",
      )!;
      const bounds = play.getBoundingClientRect();
      expect(bounds.width).toBeGreaterThanOrEqual(Math.min(192 * scale, actions.clientWidth) - 1);
      expect(bounds.right).toBeLessThanOrEqual(actions.getBoundingClientRect().right + 1);
      expect(play.disabled).toBe(false);
      play.focus();
      await expect.element(play).toHaveFocus();
      contained();
    }
  },
);

it.each(["dark", "light"])("gives search its own full row at 740px in %s", async (theme) => {
  await page.viewport(740, 900);
  await mount(theme);
  for (const scale of [1, 1.3]) {
    document.documentElement.style.fontSize = `${16 * scale}px`;
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    const search = page
      .getByRole("textbox", { name: "Search your library", exact: true })
      .element();
    const searchRow = search.closest<HTMLElement>(".search")!;
    const toolbar = searchRow.closest<HTMLElement>(".browse-toolbar")!;
    const filter = page.getByRole("button", { name: "Filters (0)", exact: true }).element();
    expect(searchRow.getBoundingClientRect().width).toBeCloseTo(toolbar.clientWidth, 0);
    expect(filter.getBoundingClientRect().top).toBeGreaterThanOrEqual(
      searchRow.getBoundingClientRect().bottom,
    );
    contained();
  }
});
