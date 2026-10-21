import axe from "axe-core";
import { afterEach, expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";
import { cleanup, render } from "vitest-browser-react";
import App from "../App";
import { PortBrowser } from "../components/PortBrowser";
import { desktopApi } from "../api";
import { artworkState } from "../test-fixtures";
import { initializeLocalization, LocalizationProvider } from "../localization";
import { installInteractiveTransport } from "../dev-scenarios/interactive/transport";
import { collectionLayoutKey } from "../features/browsing/use-collection-layout";
import { ApplicationUpdateNotices } from "../features/application-update/ApplicationUpdateNotices";
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

it.each(["Covers", "Compact rows"])(
  "keeps the %s launch origin focused while the same-target operation settles",
  async (layout) => {
    await page.viewport(960, 640);
    await mount("dark");
    await page.getByRole("button", { name: layout, exact: true }).click();
    let finish!: (value: Awaited<ReturnType<typeof desktopApi.launch>>) => void;
    const launch = vi.spyOn(desktopApi, "launch").mockReturnValue(
      new Promise((resolve) => {
        finish = resolve;
      }),
    );
    const play = [
      ...document.querySelectorAll<HTMLButtonElement>(".collection-actions button"),
    ].find((button) => button.textContent?.trim() === "Play")!;
    expect(play).toBeDefined();
    play.scrollIntoView({ block: "center" });
    play.focus({ preventScroll: true });
    play.click();
    await expect.poll(() => launch.mock.calls.length).toBe(1);
    await expect
      .poll(() => play.disabled || play.getAttribute("aria-disabled") === "true")
      .toBe(true);
    expect(document.activeElement).toBe(play);
    // Native foreground re-entry can occur before workspace readback settles.
    // The origin must remain a focus destination while still refusing activation.
    play.blur();
    play.focus({ preventScroll: true });
    expect(document.activeElement).toBe(play);
    // Retained focus must never permit another same-target dispatch.
    play.click();
    await userEvent.keyboard("{Enter}");
    expect(launch).toHaveBeenCalledOnce();
    finish({ processId: null, sessionId: "fixture-return-focus" });
    await expect
      .poll(() => play.disabled || play.getAttribute("aria-disabled") === "true")
      .toBe(false);
    expect(play.isConnected).toBe(true);
    expect(document.activeElement).toBe(play);
    let finishAgain!: (value: Awaited<ReturnType<typeof desktopApi.launch>>) => void;
    launch.mockReturnValueOnce(
      new Promise((resolve) => {
        finishAgain = resolve;
      }),
    );
    play.click();
    await expect.poll(() => launch.mock.calls.length).toBe(2);
    await expect.poll(() => play.getAttribute("aria-disabled")).toBe("true");
    const search = document.querySelector<HTMLInputElement>("#port-search")!;
    search.focus({ preventScroll: true });
    finishAgain({ processId: null, sessionId: "fixture-return-after-navigation" });
    await expect.poll(() => play.getAttribute("aria-disabled")).not.toBe("true");
    expect(document.activeElement).toBe(search);
  },
);

it.each([
  ["dark", 960],
  ["light", 960],
  ["dark", 320],
  ["light", 320],
] as const)(
  "prioritizes first-use actions with the update choice at %s/%ipx",
  async (theme, width) => {
    await page.viewport(width, 640);
    document.documentElement.dataset.theme = theme;
    const add = vi.fn();
    const connect = vi.fn();
    await render(
      <main style={{ width: width === 960 ? 768 : "100%", padding: 20, boxSizing: "border-box" }}>
        <h1>Your library</h1>
        <ApplicationUpdateNotices
          updateNotice={undefined}
          updateChoiceRequired
          productionTransitionRequired={false}
          productionTransitionBusy={false}
          reviewUpdate={() => {}}
          dismissUpdate={async () => {}}
          dismissUpdateChoice={() => {}}
          useStable={() => {}}
          keepPreview={() => {}}
          dismissProductionTransition={() => {}}
        />
        <PortBrowser
          view="library"
          ports={[]}
          statuses={new Map()}
          overview={{ installed: 0, ready: 0, needsSetup: 0, staged: 0 }}
          filter="all"
          setFilter={() => {}}
          setCollectionLayout={() => {}}
          onSelect={() => {}}
          onBrowseCatalog={add}
          onConnectGameFiles={connect}
          loading={false}
        />
      </main>,
    );
    expect(document.querySelector('[aria-label="Collection view"]')).toBeNull();
    expect(document.querySelector(".collection-tools")).toBeNull();
    expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(width + 1);
    const action = document.querySelector<HTMLElement>(".empty-state [data-add-games-trigger]")!;
    expect(action.getBoundingClientRect().top).toBeGreaterThan(0);
    expect(action.getBoundingClientRect().bottom).toBeLessThanOrEqual(
      width === 960 ? 640 : document.documentElement.scrollHeight,
    );
    await page.getByRole("button", { name: "Add games", exact: true }).click();
    expect(add).toHaveBeenCalledOnce();
    await page.getByRole("button", { name: "Connect game-file folder", exact: true }).click();
    expect(connect).toHaveBeenCalledOnce();
  },
);

it.each([
  ["dark", true],
  ["light", true],
  ["dark", false],
  ["light", false],
] as const)("fits the %s Library loading=%s state at 240px", async (theme, loading) => {
  await page.viewport(240, 160);
  document.documentElement.dataset.theme = theme;
  await render(
    <main style={{ padding: 16 }}>
      <PortBrowser
        view="library"
        ports={[]}
        statuses={new Map()}
        overview={{ installed: 0, ready: 0, needsSetup: 0, staged: 0 }}
        filter="all"
        setFilter={() => {}}
        onSelect={() => {}}
        onBrowseCatalog={() => {}}
        loading={loading}
      />
    </main>,
  );
  expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(
    document.documentElement.clientWidth + 1,
  );
  const state = document.querySelector<HTMLElement>(loading ? ".loading-state" : ".empty-state")!;
  expect(state.scrollWidth).toBeLessThanOrEqual(state.clientWidth + 1);
});

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
      expect(box.width).toBeLessThanOrEqual(261);
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
    expect(firstRow).toHaveLength(5);
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
    expect(
      document.querySelector(".collection-art")!.getBoundingClientRect().width,
    ).toBeLessThanOrEqual(221);
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

it("includes visible Find games card content in its accessible name when artwork fails", async () => {
  vi.spyOn(desktopApi, "artwork").mockImplementation(async (id, slot) => ({
    ...artworkState(id, slot),
    availability: "unavailable",
  }));
  await page.viewport(1280, 800);
  await mount("dark");
  await page
    .getByRole("navigation", { name: "Primary navigation" })
    .getByRole("button", { name: /^Find games/ })
    .click();
  await expect
    .poll(() => document.querySelectorAll('[data-detail-origin^="catalog:card:"]').length)
    .toBe(12);
  await expect
    .poll(() => document.querySelector(".artwork-image-note")?.textContent)
    .toContain("Image unavailable");
  const labels = await axe.run(document.querySelector("main")!, {
    runOnly: { type: "rule", values: ["label-content-name-mismatch"] },
  });
  expect(labels.violations).toEqual([]);
});
