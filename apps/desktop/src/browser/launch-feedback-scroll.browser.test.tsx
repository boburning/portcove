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
import { scrollWorkspaceTo, workspaceScrollTop } from "../workspace-scroll";
import "../styles/index.css";

let transport: ReturnType<typeof installInteractiveTransport> | undefined;
let root: HTMLDivElement | undefined;
afterEach(async () => {
  await cleanup();
  root?.remove();
  root = undefined;
  transport?.dispose();
  transport = undefined;
  vi.restoreAllMocks();
  localStorage.clear();
  document.documentElement.removeAttribute("data-theme");
  await page.viewport(1280, 800);
});
const frame = () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
async function painted() {
  await frame();
  await frame();
}
function workspace() {
  const workspace = document.querySelector<HTMLElement>('main[data-focus-region="workspace"]');
  if (!workspace) throw new Error("Actual App workspace is missing");
  return workspace;
}
function owner() {
  const main = workspace();
  return getComputedStyle(main).overflowY === "visible"
    ? (document.scrollingElement ?? document.documentElement)
    : main;
}
function point(origin: HTMLButtonElement) {
  const scroll = owner();
  const rectangle = origin.getBoundingClientRect();
  return {
    scroll: workspaceScrollTop(workspace()),
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
async function reconcileSnapshotConflict(
  origin: HTMLButtonElement,
  pending: ReturnType<typeof point>,
  allowCurrentRead: () => void,
) {
  const notice = page
    .getByRole("alert")
    .filter({ hasText: "Library information could not be refreshed" });
  await expect.element(notice).toBeVisible();
  await painted();
  const replacement = point(origin);
  // Measure the actual contribution, without prescribing notice dimensions.
  expect(Math.abs(replacement.originDocumentTop - pending.originDocumentTop)).toBeGreaterThan(1);
  const invocations = document.querySelectorAll('[data-invocation-id][aria-label^="Launch · "]');
  expect(invocations).toHaveLength(1);
  const invocation = invocations[0]!;
  const announcement = document.querySelector(
    `[data-announcement-invocation-id="${invocation.getAttribute("data-invocation-id")}"]`,
  );
  expect(announcement?.parentElement).toBe(
    document.querySelector("[data-invocation-announcements]"),
  );
  expect(announcement?.textContent).toContain(`${invocation.getAttribute("aria-label")}: finished`);
  allowCurrentRead();
  await controlledAct(async () => {
    window.dispatchEvent(new Event("focus"));
    await painted();
  });
  await expect.element(notice).not.toBeInTheDocument();
}

for (const layout of ["Covers", "Compact rows"] as const) {
  for (const activation of ["pointer", "Space"] as const) {
    for (const position of ["bottom", "middle"] as const) {
      for (const withConflict of [false, true]) {
        it(`preserves ${layout}/${position}/${activation} reading position through launch${withConflict ? " and a stale snapshot notice" : " success"}`, async () => {
          await page.viewport(720, 560);
          localStorage.clear();
          transport = installInteractiveTransport("collection", (message) => {
            throw new Error(message);
          });
          initializeLocalization(["en"]);
          document.documentElement.dataset.theme = "dark";
          // Match main.tsx so main has the production definite viewport height.
          root = document.createElement("div");
          root.id = "root";
          document.body.append(root);
          await render(
            <LocalizationProvider api={desktopApi}>
              <App />
            </LocalizationProvider>,
            { container: root },
          );
          await expect
            .element(page.getByRole("button", { name: layout, exact: true }))
            .toBeVisible();
          await page.getByRole("button", { name: layout, exact: true }).click();
          await expect.poll(() => document.querySelectorAll(".collection-entry").length).toBe(12);
          // A dismissed first-use choice is not part of this controlled transition.
          const notNow = page.getByRole("button", { name: "Not now", exact: true });
          if (notNow.query()) await notNow.click();
          await painted();
          const candidates = [
            ...document.querySelectorAll<HTMLButtonElement>(".collection-actions button"),
          ].filter(
            (button) =>
              button.textContent?.trim() === "Play" &&
              !button.disabled &&
              button.getAttribute("aria-disabled") !== "true",
          );
          const origin =
            candidates[
              position === "bottom" ? candidates.length - 1 : Math.floor(candidates.length / 2)
            ];
          expect(origin).toBeDefined();
          if (!origin)
            throw new Error("Fixture must expose a launchable original collection control");
          origin.scrollIntoView({ block: position === "bottom" ? "end" : "center" });
          if (position === "bottom") scrollWorkspaceTo(workspace(), owner().scrollHeight);
          origin.focus({ preventScroll: true });
          await painted();
          const before = point(origin);
          expect(before.scroll).toBeGreaterThan(0);
          expect(
            position === "bottom"
              ? Math.abs(before.maximum - before.scroll) <= 1
              : before.scroll < before.maximum - 2,
          ).toBe(true);
          let finish!: (value: Awaited<ReturnType<typeof desktopApi.launch>>) => void;
          const launch = vi.spyOn(desktopApi, "launch").mockReturnValue(
            new Promise((resolve) => {
              finish = resolve;
            }),
          );
          if (activation === "Space") await userEvent.keyboard(" ");
          else await userEvent.click(origin);
          await expect.poll(() => launch.mock.calls.length).toBe(1);
          await expect.poll(() => origin.getAttribute("aria-disabled")).toBe("true");
          await painted();
          const pending = point(origin);
          expect(pending.focused).toBe(true);
          const originalSnapshot = desktopApi.workspaceSnapshot.bind(desktopApi);
          const snapshot = vi.spyOn(desktopApi, "workspaceSnapshot");
          // App operations use retryRefresh: a read conflict is a distinct visible
          // workspace outcome, while the successful invocation becomes sr-only.
          let rejectRead = withConflict;
          snapshot.mockImplementation(async (generation) => {
            if (rejectRead) return Promise.reject(staleSnapshot());
            return originalSnapshot(generation);
          });
          await controlledAct(async () => {
            finish({ processId: null, sessionId: "controlled-feedback-return" });
            await painted();
          });
          await expect.poll(() => origin.getAttribute("aria-disabled")).not.toBe("true");
          if (withConflict) {
            await reconcileSnapshotConflict(origin, pending, () => {
              rejectRead = false;
            });
          }
          await painted();
          const returned = point(origin);
          const facts = JSON.stringify({
            layout,
            position,
            withConflict,
            before,
            pending,
            returned,
          });
          expect(returned.originConnected, facts).toBe(true);
          expect(returned.focused, facts).toBe(true);
          expect(returned.query, facts).toBe(before.query);
          expect(returned.filter, facts).toBe(before.filter);
          // Completion keeps visible feedback above the collection. Compensate
          // its document offset while retaining the same visible pixels.
          const contentShift = returned.originDocumentTop - before.originDocumentTop;
          expect(
            Math.abs(returned.scroll - before.scroll - contentShift),
            facts,
          ).toBeLessThanOrEqual(2);
          expect(Math.abs(returned.originTop - before.originTop), facts).toBeLessThanOrEqual(2);
          expect(launch).toHaveBeenCalledOnce();
        });
      }
    }
  }
}
