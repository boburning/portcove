import { afterEach, expect, it, vi } from "vite-plus/test";
import { page } from "vite-plus/test/browser";
import { cleanup, render } from "vitest-browser-react";
import axe from "axe-core";
import App from "../App";
import { desktopApi } from "../api";
import { installInteractiveTransport } from "../dev-scenarios/interactive/transport";
import { comparisonEntries } from "../dev-scenarios/interactive/comparison-scene";
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

async function mount(theme: string) {
  localStorage.clear();
  const root = document.createElement("div");
  root.id = "root";
  document.body.append(root);
  transport = installInteractiveTransport("comparison", (message) => {
    throw Error(message);
  });
  initializeLocalization(["en"]);
  await render(
    <LocalizationProvider api={desktopApi}>
      <App />
    </LocalizationProvider>,
    { container: root },
  );
  await expect.poll(() => document.querySelectorAll(".collection-entry").length).toBe(12);
  document.documentElement.dataset.theme = theme;
  await document.fonts.ready;
}
async function open(index = 0) {
  const entry = comparisonEntries[index]!;
  await page
    .getByRole("button", {
      name: `View details for ${entry.title} Port: ${entry.port}${entry.variant ? " · " + entry.variant : ""}`,
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
async function capture(name: string) {
  window.scrollTo(0, 0);
  document.querySelector<HTMLElement>("[data-focus-region=workspace]")!.scrollTop = 0;
  // Capture the viewport rectangle. The browser test document can be taller
  // than its iframe; a document screenshot otherwise pads below the viewport.
  const frame = document.createElement("div");
  frame.setAttribute("aria-hidden", "true");
  frame.style.cssText = "position:fixed;inset:0;pointer-events:none";
  document.body.append(frame);
  try {
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
      expect([cover.width, cover.height]).toEqual(height > 820 ? [240, 360] : [160, 240]);
      const play = page.getByRole("button", { name: "Play", exact: true });
      expect(play.element().getBoundingClientRect().width).toBeLessThan(160);
      await capture(`managed-${theme}-${width}`);
      for (const label of ["Overview", "Files", "Saved data", "Versions"]) {
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
    expect(document.querySelector(".detail-cover")!.getBoundingClientRect().width).toBe(160);
    await capture(`enlarged-text-${theme}`);
    document.documentElement.style.removeProperty("font-size");
    await page.viewport(320, 720);
    contained();
    const cover = document.querySelector(".detail-cover")!.getBoundingClientRect();
    expect([cover.width, cover.height]).toEqual([144, 216]);
    await capture(`long-identity-${theme}-320`);
    const spacing = document.createElement("style");
    spacing.id = "detail-text-spacing";
    spacing.textContent =
      "* { line-height: 1.5 !important; letter-spacing: .12em !important; word-spacing: .16em !important; } p { margin-bottom: 2em !important; }";
    document.head.append(spacing);
    for (const label of ["Overview", "Files", "Saved data", "Versions"]) {
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
    expect([cover.getBoundingClientRect().width, cover.getBoundingClientRect().height]).toEqual([
      240, 360,
    ]);
    await expect.poll(() => cover.querySelector("img")?.naturalWidth ?? 0).toBeGreaterThan(0);
    expect(getComputedStyle(cover.querySelector("img")!).objectFit).toBe("contain");
    await capture(`artwork-${index}-dark`);
    await page.getByRole("button", { name: "Back to previous workspace", exact: true }).click();
  }
  await open(4);
  await expect
    .element(page.getByRole("tab", { name: "Files", exact: true }))
    .toHaveAttribute("aria-selected", "true");
  expect(document.querySelector(".detail-cover img")).toBeNull();
  await capture("artwork-4-dark");
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
