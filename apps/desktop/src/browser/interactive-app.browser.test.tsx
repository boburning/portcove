import { openAdvancedFilters } from "../../test/filter-fields";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";
import {
  startInteractiveScenarios,
  stopInteractiveScenarios,
} from "../dev-scenarios/interactive/entry";
import { recoveryKey } from "../dev-scenarios/interactive/transport";
import "../styles/index.css";
import "../dev-scenarios/scenarios.css";
import scenarioShell from "../../scenarios.html?raw";
import axe from "axe-core";
import { THEME_STORAGE_KEY } from "../theme";
beforeEach(async () => {
  localStorage.clear();
  await page.viewport(1280, 800);
});

function mount(journey: string) {
  window.history.replaceState(null, "", `/scenarios.html?mode=interactive&journey=${journey}`);
  document.body.innerHTML = new DOMParser().parseFromString(
    scenarioShell,
    "text/html",
  ).body.innerHTML;
  startInteractiveScenarios();
}
async function settleCapture(animationTimeout = 10_000) {
  const phase = (name: string) => {
    document.documentElement.dataset.capturePhase = name;
    document.documentElement.dataset.captureVisibility = document.visibilityState;
    document.documentElement.dataset.captureFonts = document.fonts.status;
  };
  phase("fonts");
  await document.fonts.ready;
  phase("images");
  await expect.poll(() => [...document.images].every((image) => image.complete)).toBe(true);
  phase("paint");
  // Let the resized workspace and the theme owner's deferred invalidation paint.
  await new Promise<void>((resolve) =>
    requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
  );
  phase("animations");
  // Capture readiness follows the current rendered effects. A captured CSS
  // transition's finished promise can remain unresolved after a rerender.
  await expect
    .poll(
      () => {
        const animations = document
          .getAnimations()
          .filter((animation) => animation.effect?.getComputedTiming().iterations !== Infinity);
        document.documentElement.dataset.captureAnimations = JSON.stringify(
          animations.map((animation) => ({
            state: animation.playState,
            pending: animation.pending,
            rate: animation.playbackRate,
            timing: animation.effect?.getComputedTiming(),
            target:
              animation.effect instanceof KeyframeEffect &&
              animation.effect.target instanceof Element
                ? `${animation.effect.target.tagName}.${animation.effect.target.getAttribute("class") ?? ""}`
                : null,
          })),
        );
        return animations.every(
          (animation) => !animation.pending && ["finished", "idle"].includes(animation.playState),
        );
      },
      { timeout: animationTimeout, message: "Current finite capture animations remain active" },
    )
    .toBe(true);
  phase("complete");
}
afterEach(() => {
  vi.restoreAllMocks();
  for (const key of ["capturePhase", "captureVisibility", "captureFonts", "captureAnimations"])
    delete document.documentElement.dataset[key];
  stopInteractiveScenarios();
  document.documentElement.style.fontSize = "";
  sessionStorage.removeItem(recoveryKey);
  localStorage.clear();
  document.body.replaceChildren();
  window.history.replaceState(null, "", "/");
});

it("waits for current effects without awaiting obsolete transition promises", async () => {
  let finished = false;
  const obsolete = {
    playState: "running",
    pending: false,
    effect: { getComputedTiming: () => ({ iterations: 1 }) },
    finished: new Promise<void>(() => {}).then(() => {
      finished = true;
    }),
  } as unknown as Animation;
  let current = [obsolete];
  const observed = vi.spyOn(document, "getAnimations").mockImplementation(() => current);
  let settled = false;
  const waiting = settleCapture().then(() => {
    settled = true;
  });
  await expect.poll(() => observed.mock.calls.length).toBeGreaterThanOrEqual(2);
  expect(settled).toBe(false);
  current = [];
  await waiting;
  expect(finished).toBe(false);
  expect(settled).toBe(true);
});

it.each(["running", "paused", "pending"])(
  "refuses capture while a current finite effect is %s",
  async (state) => {
    vi.spyOn(document, "getAnimations").mockReturnValue([
      {
        playState: state === "pending" ? "idle" : state,
        pending: state === "pending",
        effect: { getComputedTiming: () => ({ iterations: 1 }) },
      } as unknown as Animation,
    ]);
    await expect(settleCapture(150)).rejects.toThrow(
      /Current finite capture animations remain active/,
    );
    expect(document.documentElement.dataset.capturePhase).toBe("animations");
  },
);

it.each(["dark", "light"])(
  "keeps enlarged %s rows readable and checks the changed controls",
  async (theme) => {
    await page.viewport(1366, 768);
    localStorage.setItem(THEME_STORAGE_KEY, theme);
    mount("collection");
    document.documentElement.style.fontSize = "200%";
    await page.getByRole("button", { name: "Compact rows", exact: true }).click();
    await settleCapture();
    const row = document.querySelector<HTMLElement>(".collection-row")!;
    const state = row.querySelector<HTMLElement>(".collection-state")!;
    const identity = row.querySelector<HTMLElement>(".collection-identity")!;
    expect(
      parseFloat(getComputedStyle(identity.querySelector(".collection-title")!).fontSize),
    ).toBeGreaterThanOrEqual(28);
    expect(document.documentElement.dataset.theme).toBe(theme);
    const statusBounds = state.querySelector(".readiness")!.getBoundingClientRect();
    const identityBounds = identity.getBoundingClientRect();
    const titleLeft = identity.querySelector(".collection-title")!.getBoundingClientRect().left;
    expect(
      statusBounds.left >= identityBounds.right - 1 ||
        (statusBounds.top >= identityBounds.bottom - 1 &&
          Math.abs(statusBounds.left - titleLeft) <= 1),
    ).toBe(true);
    expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(1366);
    await page.screenshot({ path: `../../../../outputs/ui-refinement/rows-text-200-${theme}.png` });
    const result = await axe.run(document.querySelector<HTMLElement>("#scenario-preview")!, {
      runOnly: { type: "tag", values: ["wcag2a", "wcag2aa", "wcag21aa", "wcag22aa"] },
    });
    expect(
      result.violations.map(
        (item) => `${item.id}: ${item.nodes.map((node) => node.target.join(" ")).join(", ")}`,
      ),
    ).toEqual([]);
    await page.viewport(1920, 1080);
    await settleCapture();
    expect(state.getBoundingClientRect().left).toBeGreaterThanOrEqual(
      identity.getBoundingClientRect().right,
    );
    const readiness = state.querySelector<HTMLElement>(".readiness")!;
    expect(readiness.getBoundingClientRect().height).toBeLessThanOrEqual(
      parseFloat(getComputedStyle(readiness).lineHeight) + 1,
    );
    const play = [...row.querySelectorAll<HTMLButtonElement>("button")].find(
      (button) => button.textContent === "Play",
    )!;
    expect(play.dataset.variant).toBe("outline");
    expect(play.textContent).toBe("Play");
    play.focus();
    await expect.element(play).toHaveFocus();
    await settleCapture();
    await page.screenshot({
      path: `../../../../outputs/ui-refinement/rows-text-200-wide-${theme}.png`,
    });
  },
  45_000,
);

it("keeps enlarged review facts and cancellation reachable", async () => {
  await page.viewport(1366, 768);
  document.documentElement.style.fontSize = "200%";
  mount("setup");
  await page
    .getByRole("button", {
      name: "View details for Harbor Adventure Harbor Adventure",
      exact: true,
    })
    .click();
  await page.getByRole("button", { name: "Review setup", exact: true }).click();
  const dialog = page.getByRole("dialog");
  await expect.element(dialog.getByText("fixture/owned.iso", { exact: true })).toBeVisible();
  expect(dialog.element().scrollWidth).toBeLessThanOrEqual(dialog.element().clientWidth + 1);
  await page.screenshot({ path: "../../../../outputs/ui-refinement/preparation-text-200.png" });
  await page.viewport(320, 900);
  expect(dialog.element().scrollWidth).toBeLessThanOrEqual(dialog.element().clientWidth + 1);
  await page.getByRole("button", { name: "Cancel review", exact: true }).click();
  await expect.element(dialog).not.toBeInTheDocument();
  await expect
    .element(page.getByRole("button", { name: "Review setup", exact: true }))
    .toHaveFocus();
});

it("keeps one named readiness choice across narrow, desktop and enlarged widths", async () => {
  await page.viewport(320, 900);
  mount("library");
  await openAdvancedFilters();
  const readiness = page.getByRole("combobox", { name: /^Readiness/ });
  await expect.element(readiness).toBeVisible();
  await readiness.click();
  await page.getByRole("option", { name: "Ready (2)", exact: true }).click();
  await expect.poll(() => readiness.element().textContent).toContain("Ready (2)");
  await userEvent.fill(page.getByPlaceholder("Game or port name"), "Harbor");
  await expect.poll(() => readiness.element().textContent).toContain("Ready (1)");
  expect(document.querySelectorAll(".collection-entry")).toHaveLength(1);
  expect(document.querySelector(".collection-entry")?.textContent).toContain("Harbor Adventure");
  await page.viewport(1280, 800);
  await expect.element(readiness).toBeVisible();
  await expect.element(readiness).toHaveAccessibleName("Readiness Ready (1)");
  await page.viewport(1366, 768);
  document.documentElement.style.fontSize = "200%";
  await expect.element(readiness).toBeVisible();
  await readiness.click();
  await page.getByRole("option", { name: "All (1)", exact: true }).click();
  await expect.poll(() => readiness.element().textContent).toContain("All (1)");
  await userEvent.fill(page.getByPlaceholder("Game or port name"), "");
  await expect.poll(() => readiness.element().textContent).toContain("All (2)");
  expect(document.querySelectorAll(".collection-entry")).toHaveLength(2);
  expect(document.querySelector(".collection-readiness-wide")).toBeNull();
});

it("uses real App search, readiness filters, chips, artwork fallback, and details/back navigation", async () => {
  mount("library");
  await expect
    .element(
      page.getByRole("button", {
        name: "View details for Harbor Adventure Harbor Adventure",
        exact: true,
      }),
    )
    .toBeVisible();
  await expect
    .element(
      page.getByRole("button", {
        name: "View details for Orchard Quest Orchard Quest",
        exact: true,
      }),
    )
    .toBeVisible();
  await userEvent.fill(page.getByPlaceholder("Game or port name"), "Harbor");
  await expect
    .element(
      page.getByRole("button", {
        name: "View details for Orchard Quest Orchard Quest",
        exact: true,
      }),
    )
    .not.toBeInTheDocument();
  await openAdvancedFilters();
  await page.getByRole("combobox", { name: /^Readiness / }).click();
  await page.getByRole("option", { name: "Ready (1)", exact: true }).click();
  await expect
    .element(page.getByRole("combobox", { name: /^Readiness / }))
    .toHaveAccessibleName("Readiness Ready (1)");
  await expect
    .element(
      page.getByRole("button", {
        name: "View details for Harbor Adventure Harbor Adventure",
        exact: true,
      }),
    )
    .toBeVisible();
  await userEvent.click(
    page.getByRole("button", {
      name: "View details for Harbor Adventure Harbor Adventure",
      exact: true,
    }),
  );
  await expect
    .element(page.getByRole("button", { name: /^Back to (Library|Discover)$/, exact: true }))
    .toBeVisible();
  expect(document.querySelector('[aria-labelledby="port-detail-title"]')?.textContent).toContain(
    "Harbor Adventure",
  );
  expect(document.querySelector('.game-hero[data-hero-identity="text"]')).not.toBeNull();
  expect(document.querySelector(".game-hero-image")).toBeNull();
  await expect
    .element(page.getByRole("heading", { name: "Harbor Adventure", exact: true }))
    .toBeVisible();
  await userEvent.click(
    page.getByRole("button", { name: /^Back to (Library|Discover)$/, exact: true }),
  );
  await expect.element(page.getByPlaceholder("Game or port name")).toHaveValue("Harbor");
  await page.getByText("Demo library · simulated files — review controls", { exact: true }).click();
  await userEvent.click(page.getByRole("button", { name: "Reset journey", exact: true }));
  // Reset remounts the renderer fixture; private browsing preferences still restore.
  await expect.element(page.getByPlaceholder("Game or port name")).toHaveValue("Harbor");
  await userEvent.fill(page.getByPlaceholder("Game or port name"), "");
  await expect.element(page.getByPlaceholder("Game or port name")).toHaveValue("");
  await expect
    .element(
      page.getByRole("button", {
        name: "View details for Orchard Quest Orchard Quest",
        exact: true,
      }),
    )
    .toBeVisible();
});

it("reviews preparation through desktopApi, waits for progress, cancels, fails and completes a fresh review", async () => {
  mount("setup");
  await userEvent.click(
    page.getByRole("button", {
      name: "View details for Harbor Adventure Harbor Adventure",
      exact: true,
    }),
  );
  await expect
    .element(page.getByRole("button", { name: "Prepare game data first", exact: true }))
    .not.toBeInTheDocument();
  const next = page.getByRole("region", { name: "Game actions", exact: true });
  await expect
    .element(next.getByRole("button", { name: "Review setup", exact: true }))
    .toBeEnabled();
  expect(next.element().textContent).toContain("Harbor Adventure");
  await userEvent.click(page.getByRole("button", { name: "Review setup", exact: true }));
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
  await expect
    .element(page.getByRole("button", { name: "Cancellation requested", exact: true }))
    .toBeVisible();
  await userEvent.keyboard("{Alt>}{Shift>}C{/Shift}{/Alt}");
  await expect.element(page.getByRole("dialog")).not.toBeInTheDocument();
  await userEvent.click(page.getByRole("button", { name: "Review setup", exact: true }));
  await userEvent.click(page.getByRole("button", { name: "Prepare game data", exact: true }));
  await userEvent.keyboard("{Alt>}{Shift>}F{/Shift}{/Alt}");
  await expect.element(page.getByRole("dialog")).not.toBeInTheDocument();
  await expect
    .element(page.getByText("The demo setup did not finish.", { exact: false }).first())
    .toBeVisible();
  await userEvent.click(page.getByRole("button", { name: "Review setup", exact: true }));
  await userEvent.click(page.getByRole("button", { name: "Prepare game data", exact: true }));
  await userEvent.keyboard("{Alt>}{Shift>}{Enter}{/Shift}{/Alt}");
  await expect.element(page.getByRole("dialog")).not.toBeInTheDocument();
  await expect
    .element(page.getByRole("button", { name: "Review setup", exact: true }))
    .not.toBeInTheDocument();
  await expect
    .poll(() => document.querySelector('[aria-labelledby="port-detail-title"]')?.textContent)
    .toContain("Ready to play");
  await expect.element(page.getByRole("button", { name: "Play", exact: true })).toHaveFocus();
}, 45_000);

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
  await page.getByText("Demo library · simulated files — review controls", { exact: true }).click();
  await userEvent.click(page.getByRole("button", { name: "Reset journey", exact: true }));
  await expect
    .element(page.getByRole("button", { name: "Continue location change", exact: true }))
    .toBeVisible();
});

it("keeps actual App update entries and their independent Play actions reachable at enlarged and narrow widths", async () => {
  await page.viewport(960, 640);
  document.documentElement.style.fontSize = "200%";
  mount("collection");
  await expect
    .element(page.getByRole("button", { name: /^View details for Super Mario 64/ }).first())
    .toBeVisible();
  await page.getByRole("button", { name: "Activity", exact: true }).click();
  await page.getByRole("tab", { name: "Game updates", exact: true }).click();
  const main = document.querySelector<HTMLElement>('main[data-focus-region="workspace"]')!;
  expect(main.scrollWidth).toBeLessThanOrEqual(main.clientWidth + 1);
  const play = page
    .getByRole("button", { name: "Play", exact: true })
    .first()
    .element() as HTMLElement;
  play.focus();
  expect(document.activeElement).toBe(play);
  let bounds = play.getBoundingClientRect();
  expect(bounds.left).toBeGreaterThanOrEqual(0);
  expect(bounds.right).toBeLessThanOrEqual(innerWidth);
  expect(bounds.bottom).toBeLessThanOrEqual(innerHeight + 1);
  await page.screenshot({ path: "../../../../outputs/uiux-game-titles/enlarged-updates-960.png" });
  document.documentElement.style.fontSize = "";
  await page.viewport(320, 900);
  play.scrollIntoView({ block: "nearest" });
  expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(320);
  expect(main.scrollWidth).toBeLessThanOrEqual(main.clientWidth + 1);
  expect(document.activeElement).toBe(play);
  bounds = play.getBoundingClientRect();
  expect(bounds.right).toBeLessThanOrEqual(innerWidth);
  expect(bounds.bottom).toBeLessThanOrEqual(innerHeight + 1);
  await page.screenshot({ path: "../../../../outputs/uiux-game-titles/narrow-updates-320.png" });
});
