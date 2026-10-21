// Uses actual App/StatusLayer/WorkspaceRefreshNotice with mocked transport only.
import { afterEach, expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";
import { cleanup, render } from "vitest-browser-react";
import App from "../App";
import { desktopApi } from "../api";
import { failureReport } from "../test-fixtures";
import { initializeLocalization, LocalizationProvider } from "../localization";
import { installInteractiveTransport } from "../dev-scenarios/interactive/transport";
import { controlledAct } from "../../test/controlled-react-act";
import "../styles/index.css";

let transport: ReturnType<typeof installInteractiveTransport> | undefined;
afterEach(async () => {
  await cleanup();
  transport?.dispose();
  transport = undefined;
  vi.restoreAllMocks();
  localStorage.clear();
  document.documentElement.removeAttribute("data-theme");
});
const frame = () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
async function painted() {
  await frame();
  await frame();
}
function owner() {
  const workspace = document.querySelector<HTMLElement>('main[data-focus-region="workspace"]');
  if (!workspace) throw new Error("Actual App workspace is missing");
  return getComputedStyle(workspace).overflowY === "visible"
    ? (document.scrollingElement ?? document.documentElement)
    : workspace;
}
function point(origin: HTMLButtonElement) {
  const scroll = owner();
  const rectangle = origin.getBoundingClientRect();
  return {
    scroll: scroll.scrollTop,
    maximum: scroll.scrollHeight - scroll.clientHeight,
    originTop: rectangle.top,
    originDocumentTop: rectangle.top + scroll.scrollTop,
    originConnected: origin.isConnected,
    focused: document.activeElement === origin,
    query: document.querySelector<HTMLInputElement>("#port-search")?.value,
    filter: document.querySelector('[aria-label="Library filters"] [aria-pressed="true"]')
      ?.textContent,
  };
}
function staleSnapshot() {
  const previous = failureReport();
  const message =
    "the library changed while its workspace snapshot was being assembled; retry the read";
  const context = { retryable: "true", workspace_snapshot_stale: "true" };
  return {
    ...previous,
    code: "conflict" as const,
    message,
    details: context,
    presentation: {
      ...previous.presentation,
      // Controlled fixture key; no claim that this invents a Core key.
      presentation_key: "fixture_workspace_snapshot_stale",
      summary: "The selection changed or another operation is using it. Review its current state.",
      technical_message: message,
      technical_context: context,
    },
  };
}
async function startControlledLaunch(layout: "Covers" | "Compact rows" = "Covers") {
  await page.viewport(720, 560);
  transport = installInteractiveTransport("collection", (message) => {
    throw new Error(message);
  });
  initializeLocalization(["en"]);
  document.documentElement.dataset.theme = "dark";
  await render(
    <LocalizationProvider api={desktopApi}>
      <App />
    </LocalizationProvider>,
  );
  await expect.element(page.getByRole("button", { name: layout, exact: true })).toBeVisible();
  await page.getByRole("button", { name: layout, exact: true }).click();
  await expect.poll(() => document.querySelectorAll(".collection-entry").length).toBe(12);
  const notNow = page.getByRole("button", { name: "Not now", exact: true });
  if (notNow.query()) await notNow.click();
  const origins = [
    ...document.querySelectorAll<HTMLButtonElement>(".collection-actions button"),
  ].filter((button) => button.textContent?.trim() === "Play" && !button.disabled);
  const origin = origins.at(-1);
  if (!origin) throw new Error("Fixture requires a final launchable collection control");
  origin.scrollIntoView({ block: "end" });
  owner().scrollTo({ top: owner().scrollHeight });
  origin.focus({ preventScroll: true });
  await painted();
  const originalPosition = point(origin);
  let finish!: (value: Awaited<ReturnType<typeof desktopApi.launch>>) => void;
  const launch = vi.spyOn(desktopApi, "launch").mockReturnValue(
    new Promise((resolve) => {
      finish = resolve;
    }),
  );
  await userEvent.click(origin);
  await expect.poll(() => launch.mock.calls.length).toBe(1);
  await expect.poll(() => origin.getAttribute("aria-disabled")).toBe("true");
  const originalSnapshot = desktopApi.workspaceSnapshot.bind(desktopApi);
  let conflict = false;
  vi.spyOn(desktopApi, "workspaceSnapshot").mockImplementation(async (generation) => {
    if (conflict) return Promise.reject(staleSnapshot());
    return originalSnapshot(generation);
  });
  const notice = page
    .getByRole("alert")
    .filter({ hasText: "Library information could not be refreshed" });
  return {
    origin,
    launch,
    originalPosition,
    notice,
    async completeWithNotice() {
      conflict = true;
      await controlledAct(async () => {
        finish({ processId: null, sessionId: "intentional-movement-return" });
        await painted();
      });
      await expect.poll(() => origin.getAttribute("aria-disabled")).not.toBe("true");
      await expect.element(notice).toBeVisible();
    },
    async removeNotice() {
      conflict = false;
      await controlledAct(async () => {
        window.dispatchEvent(new Event("focus"));
        await painted();
      });
      await expect.element(notice).not.toBeInTheDocument();
      await painted();
    },
    finishWithNotice() {
      conflict = true;
      finish({ processId: null, sessionId: "concurrent-resize-return" });
    },
  };
}

for (const when of ["pending", "notice visible"] as const) {
  it(`honors intentional search focus and a new reading position while ${when}`, async () => {
    const running = await startControlledLaunch("Compact rows");
    if (when === "notice visible") await running.completeWithNotice();
    const search = page
      .getByRole("textbox", { name: "Search your library", exact: true })
      .element();
    // A deliberate user reading/focus choice, distinct from the old bottom baseline.
    owner().scrollTo({
      top: owner().scrollTop + search.getBoundingClientRect().top - innerHeight / 2,
    });
    await userEvent.click(search);
    await painted();
    const searchBounds = search.getBoundingClientRect();
    expect(searchBounds.top).toBeGreaterThanOrEqual(0);
    expect(searchBounds.bottom).toBeLessThanOrEqual(innerHeight);
    const userPosition = {
      scroll: owner().scrollTop,
      top: searchBounds.top,
      documentTop: searchBounds.top + owner().scrollTop,
    };
    // The below-feedback search needs removable leading scroll range. A
    // position requiring negative scroll after feedback clears is unreachable.
    const feedbackHeight = document
      .querySelector("[data-workspace-feedback]")!
      .getBoundingClientRect().height;
    expect(feedbackHeight).toBeGreaterThan(0);
    expect(userPosition.scroll).toBeGreaterThan(feedbackHeight);
    expect(Math.abs(userPosition.scroll - running.originalPosition.scroll)).toBeGreaterThan(2);
    if (when === "pending") await running.completeWithNotice();
    await running.removeNotice();
    expect(document.activeElement).toBe(search);
    const returnedTop = search.getBoundingClientRect().top;
    const returnedDocumentTop = returnedTop + owner().scrollTop;
    expect(
      Math.abs(
        owner().scrollTop - userPosition.scroll - (returnedDocumentTop - userPosition.documentTop),
      ),
    ).toBeLessThanOrEqual(2);
    expect(Math.abs(returnedTop - userPosition.top)).toBeLessThanOrEqual(2);
    expect(Math.abs(owner().scrollTop - running.originalPosition.scroll)).toBeGreaterThan(2);
    expect(running.origin.isConnected).toBe(true);
    expect(running.launch).toHaveBeenCalledOnce();
  });
}

it("does not revive a departed Library anchor after a route change with connected shared header", async () => {
  const running = await startControlledLaunch();
  const workspaceHeader = document.querySelector('main[data-focus-region="workspace"] header');
  expect(workspaceHeader).not.toBeNull();
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await expect
    .element(page.getByRole("heading", { name: "Interface size", exact: true }))
    .toBeVisible();
  // This is an explicit fixture precondition: if the shared header is replaced,
  // this case no longer proves the still-connected-header navigation hazard.
  expect(workspaceHeader?.isConnected).toBe(true);
  const settingsHeading = page
    .getByRole("button", { name: "Reset to 100%", exact: true })
    .element();
  settingsHeading.scrollIntoView({ block: "center" });
  await userEvent.click(settingsHeading);
  await painted();
  const settingsBounds = settingsHeading.getBoundingClientRect();
  expect(settingsBounds.top).toBeGreaterThanOrEqual(0);
  expect(settingsBounds.bottom).toBeLessThanOrEqual(innerHeight);
  const current = {
    scroll: owner().scrollTop,
    top: settingsBounds.top,
    documentTop: settingsBounds.top + owner().scrollTop,
  };
  // Origin is legitimately disconnected by navigation: finish the same owned
  // operation without requiring a stale launch-control DOM handle to reappear.
  running.finishWithNotice();
  await expect.element(running.notice).toBeVisible();
  await running.removeNotice();
  expect(document.activeElement).toBe(settingsHeading);
  const returnedTop = settingsHeading.getBoundingClientRect().top;
  const returnedDocumentTop = returnedTop + owner().scrollTop;
  expect(
    Math.abs(owner().scrollTop - current.scroll - (returnedDocumentTop - current.documentTop)),
  ).toBeLessThanOrEqual(2);
  expect(Math.abs(returnedTop - current.top)).toBeLessThanOrEqual(2);
  expect(Math.abs(owner().scrollTop - running.originalPosition.scroll)).toBeGreaterThan(2);
  expect(running.launch).toHaveBeenCalledOnce();
});

it("keeps the command dialog in control while background feedback changes", async () => {
  const running = await startControlledLaunch();
  await userEvent.keyboard("{Control>}k{/Control}");
  const commands = page.getByRole("combobox", { name: "Search commands", exact: true });
  await expect.element(commands).toBeVisible();
  await commands.fill("library");
  await painted();
  const dialog = commands.element().closest('[role="dialog"]');
  expect(dialog).not.toBeNull();
  const modalPosition = commands.element().getBoundingClientRect().top;
  // Raw background offsets can change through native browser anchoring or scroll lock;
  // this case asserts modal focus/visual ownership, not a forced-scroll caller.
  await controlledAct(async () => {
    running.finishWithNotice();
    await painted();
  });
  // A modal makes background semantics inert; read the known fixture DOM rather
  // than expecting an accessible background alert through the modal boundary.
  const backgroundNoticePresent = () =>
    [...document.querySelectorAll('.error-banner[role="alert"] strong')].some(
      (heading) => heading.textContent === "Library information could not be refreshed",
    );
  await expect.poll(backgroundNoticePresent).toBe(true);
  await running.removeNotice();
  await expect.poll(backgroundNoticePresent).toBe(false);
  await expect.element(commands).toHaveFocus();
  await expect.element(commands).toHaveValue("library");
  expect(commands.element().closest('[role="dialog"]')).toBe(dialog);
  expect(
    Math.abs(commands.element().getBoundingClientRect().top - modalPosition),
  ).toBeLessThanOrEqual(2);

  expect(running.launch).toHaveBeenCalledOnce();
});

it("preserves the current target through concurrent feedback and document-to-workspace owner transfer", async () => {
  const running = await startControlledLaunch("Compact rows");
  // Concurrent requests exercise both triggers without claiming a particular
  // same-frame browser schedule or adding an artificial timer delay.
  await Promise.all([
    page.viewport(960, 640),
    controlledAct(async () => {
      running.finishWithNotice();
      await painted();
    }),
  ]);
  await expect.poll(() => running.origin.getAttribute("aria-disabled")).not.toBe("true");
  await expect.element(running.notice).toBeVisible();
  await painted();
  const workspace = document.querySelector<HTMLElement>('main[data-focus-region="workspace"]')!;
  expect(getComputedStyle(workspace).overflowY).toBe("auto");
  expect(owner()).toBe(workspace);
  const current = point(running.origin);
  expect(current.focused).toBe(true);
  const bounds = running.origin.getBoundingClientRect();
  const viewport = workspace.getBoundingClientRect();
  expect(bounds.top).toBeGreaterThanOrEqual(Math.max(0, viewport.top) - 1);
  expect(bounds.bottom).toBeLessThanOrEqual(Math.min(innerHeight, viewport.bottom) + 1);
  await running.removeNotice();
  const returned = point(running.origin);
  expect(returned.focused).toBe(true);
  // The Notice removal changes document coordinates and may require scroll.
  // Preserve the user's physical target, not the obsolete with-Notice number.
  expect(
    Math.abs(
      returned.scroll - current.scroll - (returned.originDocumentTop - current.originDocumentTop),
    ),
  ).toBeLessThanOrEqual(2);
  expect(Math.abs(returned.originTop - current.originTop)).toBeLessThanOrEqual(2);
  expect(running.launch).toHaveBeenCalledOnce();
});
