import "../../styles/index.css";
import { controlledAct as act } from "../../../test/controlled-react-act";
import { render as renderComponent, cleanup, type RenderResult } from "vitest-browser-react";
import { fixtureValue } from "../../test-fixtures";

import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import * as clipboard from "../../clipboard";
import { UpdateCenter } from "../../components/UpdateCenter";
import { failureReport, portStatus } from "../../test-fixtures";
import type { ActivityRecord, ActivityDiagnostic as Diagnostic } from "../../types";
import { desktopApi } from "../../api";
import { Sidebar } from "../../components/Chrome";

import { installRecord, updateCenterFixtures } from "../../components/rendered-test-fixtures";
import { captureParityState } from "../../../test/parity-capture";
import { expectDisclosureAlignment } from "../../../test/disclosure-alignment";
import { page, userEvent } from "vite-plus/test/browser";

const { port, priorResult } = updateCenterFixtures();

describe("individual update failure interaction", () => {
  let root: RenderResult;
  let container: HTMLDivElement;
  let onSelect: ReturnType<typeof vi.fn<(portId: string, originKey?: string) => void>>;
  let checkAll: ReturnType<typeof vi.fn<() => void>>;

  function view(error = failureReport()) {
    const healthy = { ...port, id: "healthy", name: "Healthy Port" };
    return (
      <UpdateCenter
        section="updates"
        generation={1}
        ports={[port, healthy]}
        statuses={
          new Map([
            [port.id, { ...portStatus(), active: installRecord() }],
            [
              healthy.id,
              {
                ...portStatus(),
                port_id: healthy.id,
                active: installRecord({ port_id: healthy.id }),
              },
            ],
          ])
        }
        activities={[]}
        outcomes={[
          { port_id: port.id, ok: false, result: null, error },
          {
            port_id: healthy.id,
            ok: true,
            error: null,
            result: { ...priorResult, port_id: healthy.id, update_available: false },
          },
        ]}
        batchRead={{ status: "current", hasResults: true }}
        diagnosticsRefreshing={false}
        diagnosticsStale={false}
        refreshDiagnostics={vi.fn()}
        checkAll={checkAll}
        onSelect={onSelect}
        onOpenSettings={vi.fn()}
      />
    );
  }

  beforeEach(async () => {
    container = document.createElement("div");
    document.body.append(container);
    root = await renderComponent(null, { container: document.body.appendChild(container) });
    onSelect = vi.fn<(portId: string, originKey?: string) => void>();
    checkAll = vi.fn<() => void>();
    vi.mocked(clipboard.copyText).mockResolvedValue();
  });

  afterEach(async () => {
    await cleanup();
    container.remove();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it.each(["dark", "light"] as const)(
    "keeps the actual Activity update-check disclosure aligned in %s",
    async (theme) => {
      const oldTheme = document.documentElement.dataset.theme;
      const oldViewport = { width: innerWidth, height: innerHeight };
      await page.viewport(960, 640);
      document.documentElement.dataset.theme = theme;
      try {
        await root.rerender(view());
        const summary = page.getByText("About update checks", { exact: true });
        await expect.element(summary).toBeVisible();
        summary.element().scrollIntoView({ block: "center" });
        await document.fonts.ready;
        expectDisclosureAlignment(summary.element());
        summary.element().focus();
        await userEvent.keyboard("{Enter}");
        expect(summary.element().closest("details")!.open).toBe(true);
        expectDisclosureAlignment(summary.element());
        await expect.element(page.getByText("Update statistics", { exact: true })).toBeVisible();
        await userEvent.keyboard("{Enter}");
        expect(summary.element().closest("details")!.open).toBe(false);
        expect(document.activeElement).toBe(summary.element());
        const bounds = summary.element().getBoundingClientRect();
        expect(bounds.top).toBeGreaterThanOrEqual(0);
        expect(bounds.bottom).toBeLessThanOrEqual(innerHeight);
        await captureParityState("activity-update-check-disclosure-aligned");
        expect(checkAll).not.toHaveBeenCalled();
      } finally {
        if (oldTheme === undefined) delete document.documentElement.dataset.theme;
        else document.documentElement.dataset.theme = oldTheme;
        await page.viewport(oldViewport.width, oldViewport.height);
      }
    },
  );

  it("opens and copies only the failed game's supplied diagnostics without navigating or running a check", async () => {
    const error = failureReport();
    error.message = "raw-secret";
    error.details = { token: "raw-secret" };
    await root.rerender(view(error));
    const region = container.querySelector<HTMLElement>(
      '[aria-label="Update check failure for Sample Port"]',
    );
    expect(region).not.toBeNull();
    expect(
      container.querySelector('[aria-label="Update check failure for Healthy Port"]'),
    ).toBeNull();
    expect(region!.closest("button")).toBeNull();
    const details = region!.querySelector("details")!;
    expect(details.open).toBe(false);
    await act(async () => details.querySelector("summary")!.click());
    expect(details.open).toBe(true);
    await act(async () => region!.querySelector<HTMLButtonElement>("button")!.click());
    expect(
      JSON.parse(
        fixtureValue(
          vi.mocked(clipboard.copyText).mock.calls[0],
          "vi.mocked(clipboard.copyText).mock.calls[0]",
        )[0],
      ),
    ).toEqual({
      code: error.code,
      mutation_state: error.presentation.mutation_state,
      phase: error.presentation.phase,
      message: error.presentation.technical_message,
      context: error.presentation.technical_context,
    });
    expect(
      fixtureValue(
        vi.mocked(clipboard.copyText).mock.calls[0],
        "vi.mocked(clipboard.copyText).mock.calls[0]",
      )[0],
    ).not.toContain("raw-secret");
    expect(onSelect).not.toHaveBeenCalled();
    expect(checkAll).not.toHaveBeenCalled();
    await act(async () =>
      container
        .querySelector<HTMLButtonElement>(`[data-detail-origin="updates:installed:${port.id}"]`)!
        .click(),
    );
    expect(onSelect).toHaveBeenCalledExactlyOnceWith(port.id, `updates:installed:${port.id}`);
  });

  it("does not attach an old copy acknowledgement to a replacement failure report", async () => {
    let finish!: () => void;
    vi.mocked(clipboard.copyText).mockReturnValueOnce(
      new Promise<void>((resolve) => {
        finish = resolve;
      }),
    );
    await root.rerender(view());
    const selector = '[aria-label="Update check failure for Sample Port"] button';
    const old = container.querySelector<HTMLButtonElement>(selector);
    expect(old).not.toBeNull();
    await act(async () => old!.click());
    const replacement = failureReport();
    replacement.presentation.summary = "A different check failed.";
    replacement.presentation.technical_context = { request: "replacement" };
    await root.rerender(view(replacement));
    await act(async () => finish());
    expect(container.querySelector(selector)?.textContent).toBe("Copy technical details");
    expect(onSelect).not.toHaveBeenCalled();
    expect(checkAll).not.toHaveBeenCalled();
  });
});

vi.mock("../../clipboard", { spy: true });

describe("retained task recovery navigation", () => {
  const interrupted = (): ActivityRecord => {
    const failure = failureReport();
    failure.presentation.presentation_key = "operation_interrupted";
    failure.presentation.summary = "Portcove stopped before this task finished.";
    failure.presentation.mutation_state = "unknown";
    failure.presentation.recovery_actions = ["review_current_state", "view_technical_details"];
    return {
      id: "interrupted-update",
      operation: "update",
      target_kind: "port",
      target_id: port.id,
      status: "failed",
      started_at: 1,
      finished_at: 2,
      message: "private-worker-message",
      failure,
      cancellation: null,
    };
  };

  async function renderTask(activity: ActivityRecord) {
    const onSelect = vi.fn();
    const result = await renderComponent(
      <UpdateCenter
        section="tasks"
        generation={1}
        ports={[port]}
        statuses={new Map()}
        activities={[activity]}
        activityFeed={{
          records: [activity],
          current_activity_ids: [],
          attention_required_activity_ids: [activity.id],
          recovery_required_activity_ids: [],
          active_and_actionable_complete: true,
          terminal_history_complete: true,
          terminal_history_count: 1,
          terminal_history_limit: 20,
        }}
        outcomes={[]}
        diagnosticsRefreshing={false}
        diagnosticsStale={false}
        refreshDiagnostics={vi.fn()}
        checkAll={vi.fn()}
        onSelect={onSelect}
        onOpenSettings={vi.fn()}
      />,
    );
    return { result, onSelect };
  }

  it("opens only the failed task's resolved game through its offered review action", async () => {
    const { result, onSelect } = await renderTask(interrupted());
    try {
      await expect
        .element(page.getByText("Portcove stopped before this task finished."))
        .toBeVisible();
      expect(document.body.textContent).not.toContain("private-worker-message");
      expect(onSelect).not.toHaveBeenCalled();
      await page.getByRole("button", { name: /^Review game: / }).click();
      expect(onSelect).toHaveBeenCalledExactlyOnceWith(
        port.id,
        "updates:activity:interrupted-update:review",
      );
    } finally {
      await result.unmount();
    }
  });

  it("keeps setup review ahead of the generic game review", async () => {
    const activity = interrupted();
    activity.failure!.presentation.recovery_actions.unshift("review_preparation");
    const { result, onSelect } = await renderTask(activity);
    try {
      await expect.element(page.getByRole("button", { name: /^Review setup: / })).toBeVisible();
      await expect
        .element(page.getByRole("button", { name: /^Review game: / }))
        .not.toBeInTheDocument();
      await page.getByRole("button", { name: /^Review setup: / }).click();
      expect(onSelect).toHaveBeenCalledExactlyOnceWith(
        port.id,
        "updates:activity:interrupted-update:review",
      );
    } finally {
      await result.unmount();
    }
  });

  it.each(["missing-port", "library"])(
    "offers no game review for unresolved %s targets",
    async (target) => {
      const activity = interrupted();
      if (target === "library") activity.target_kind = "library";
      else activity.target_id = target;
      const { result, onSelect } = await renderTask(activity);
      try {
        await expect
          .element(page.getByRole("button", { name: /^Review game: / }))
          .not.toBeInTheDocument();
        expect(onSelect).not.toHaveBeenCalled();
      } finally {
        await result.unmount();
      }
    },
  );
});

it("reveals a task shown from elsewhere while Activity is open, but not a retained one on mount", async () => {
  const record: ActivityRecord = {
    id: "shown-task",
    operation: "install",
    target_kind: "port",
    target_id: port.id,
    status: "running",
    started_at: 1,
    finished_at: null,
    message: null,
    failure: null,
    cancellation: null,
  };
  const renderTasks = (reviewedActivityId: string | undefined, reviewedActivityRequest = 0) => (
    <UpdateCenter
      section="tasks"
      generation={1}
      ports={[port]}
      statuses={new Map()}
      activities={[record]}
      activityFeed={{
        records: [record],
        current_activity_ids: [record.id],
        attention_required_activity_ids: [],
        recovery_required_activity_ids: [],
        active_and_actionable_complete: true,
        terminal_history_complete: true,
        terminal_history_count: 0,
        terminal_history_limit: 20,
      }}
      reviewedActivityId={reviewedActivityId}
      reviewedActivityRequest={reviewedActivityRequest}
      onReviewActivity={vi.fn()}
      outcomes={[]}
      diagnosticsRefreshing={false}
      diagnosticsStale={false}
      refreshDiagnostics={vi.fn()}
      checkAll={vi.fn()}
      onSelect={vi.fn()}
      onOpenSettings={vi.fn()}
    />
  );
  const host = document.body.appendChild(document.createElement("div"));
  const outside = document.body.appendChild(document.createElement("button"));
  outside.focus();
  const result = await renderComponent(renderTasks("shown-task"), { container: host });
  try {
    const row = () => host.querySelector<HTMLElement>('[data-activity-id="shown-task"]')!;
    await new Promise((resolve) => requestAnimationFrame(resolve));
    expect(row().contains(document.activeElement)).toBe(false);
    await result.rerender(renderTasks(undefined));
    await result.rerender(renderTasks("shown-task"));
    await expect.poll(() => row().contains(document.activeElement)).toBe(true);
    // A repeated "Show task" for the same task reveals it again.
    outside.focus();
    await result.rerender(renderTasks("shown-task", 1));
    await expect.poll(() => row().contains(document.activeElement)).toBe(true);
  } finally {
    await result.unmount();
    host.remove();
    outside.remove();
  }
});

it("keeps the focused task and expanded diagnostics mounted through Activity regrouping", async () => {
  const record: ActivityRecord = {
    id: "settling-task",
    operation: "install",
    target_kind: "port",
    target_id: port.id,
    status: "running",
    started_at: 1,
    finished_at: null,
    message: null,
    failure: null,
    cancellation: null,
  };
  const renderHistory = (activity: ActivityRecord, attention: boolean) => (
    <UpdateCenter
      generation={1}
      ports={[port]}
      statuses={new Map()}
      activities={[activity]}
      activityFeed={{
        records: [activity],
        current_activity_ids: activity.status === "running" ? [activity.id] : [],
        attention_required_activity_ids: attention ? [activity.id] : [],
        recovery_required_activity_ids: [],
        active_and_actionable_complete: true,
        terminal_history_complete: true,
        terminal_history_count: activity.status === "running" ? 0 : 1,
        terminal_history_limit: 20,
      }}
      outcomes={[]}
      diagnosticsRefreshing={false}
      diagnosticsStale={false}
      refreshDiagnostics={vi.fn()}
      checkAll={vi.fn()}
      onSelect={vi.fn()}
      onOpenSettings={vi.fn()}
    />
  );
  const host = document.body.appendChild(document.createElement("div"));
  const result = await renderComponent(renderHistory(record, false), { container: host });
  try {
    const link = host.querySelector<HTMLButtonElement>(
      '[data-activity-id="settling-task"] button',
    )!;
    link.focus();
    const failed = {
      ...record,
      status: "failed" as const,
      finished_at: 2,
      failure: failureReport(),
    };
    await result.rerender(renderHistory(failed, true));
    expect(document.activeElement).toBe(link);
    expect(host.querySelector('[data-activity-id="settling-task"] button')).toBe(link);
    const summary = host.querySelector<HTMLElement>(
      '[data-activity-id="settling-task"] details summary',
    )!;
    await act(async () => summary.click());
    summary.focus();
    await result.rerender(renderHistory(failed, false));
    expect(document.activeElement).toBe(summary);
    expect(summary.closest("details")?.open).toBe(true);
    expect(host.textContent).toContain("Recent");
    expect(host.textContent).not.toContain("Needs attention");
    await captureParityState("activity-regrouped-expanded-diagnostics");
  } finally {
    await result.unmount();
    host.remove();
  }
});

it.each(["partial", "unavailable", "stale"] as const)(
  "renders qualified update counts for the %s fixture",
  async (state) => {
    await page.viewport(1024, 800);
    const second = { ...port, id: "second-game", name: "Second game" };
    const status = { ...portStatus(), active: installRecord() };
    const result = await renderComponent(
      <UpdateCenter
        section="updates"
        generation={1}
        ports={[port, second]}
        statuses={
          new Map([
            [port.id, status],
            [second.id, { ...status, port_id: second.id }],
          ])
        }
        activities={[]}
        outcomes={
          state === "unavailable"
            ? []
            : [
                {
                  port_id: port.id,
                  ok: true,
                  error: null,
                  result: { ...priorResult, update_available: true },
                },
              ]
        }
        batchRead={{
          status: state === "stale" ? "failed" : "current",
          hasResults: state !== "unavailable",
        }}
        diagnosticsRefreshing={false}
        diagnosticsStale={state === "stale"}
        refreshDiagnostics={vi.fn()}
        checkAll={vi.fn()}
        onSelect={vi.fn()}
        onOpenSettings={vi.fn()}
      />,
    );
    try {
      await expect
        .element(
          page.getByText(
            `${state === "stale" ? "Earlier update" : "Update"} results cover ${state === "unavailable" ? 0 : 1} of 2 installed ports.`,
            { exact: false },
          ),
        )
        .toBeVisible();
      await captureParityState(`activity-update-count-${state}-synthetic`);
    } finally {
      await result.unmount();
      await page.viewport(1280, 800);
    }
  },
);

it.each([true, false])("renders an empty Activity feed with completeness %s", async (complete) => {
  await page.viewport(1024, 800);
  const result = await renderComponent(
    <UpdateCenter
      section="tasks"
      generation={1}
      ports={[]}
      statuses={new Map()}
      activities={[]}
      outcomes={[]}
      activityFeed={{
        records: [],
        current_activity_ids: [],
        attention_required_activity_ids: [],
        recovery_required_activity_ids: [],
        active_and_actionable_complete: complete,
        terminal_history_complete: complete,
        terminal_history_count: 0,
        terminal_history_limit: 20,
      }}
      diagnosticsRefreshing={false}
      diagnosticsStale={!complete}
      refreshDiagnostics={vi.fn()}
      checkAll={vi.fn()}
      onSelect={vi.fn()}
      onOpenSettings={vi.fn()}
    />,
  );
  try {
    await expect
      .element(
        page.getByRole("heading", { name: "No current tasks in these records", exact: true }),
      )
      .toBeVisible();
    expect(
      document.body.textContent?.includes("Current work and attention coverage is incomplete."),
    ).toBe(!complete);
    await captureParityState(`activity-empty-${complete ? "complete" : "partial"}-synthetic`);
  } finally {
    await result.unmount();
    await page.viewport(1280, 800);
  }
});

it.each(
  (["dark", "light"] as const).flatMap((theme) => [
    { theme, width: 960, display: "grid", sidebarWidth: 192, pageScrolls: false },
    { theme, width: 430, display: "flex", sidebarWidth: 60, pageScrolls: true },
  ]),
)(
  "separates the retained preparation log focus outline from surrounding task information in $theme at $width",
  async ({ theme, width, display, sidebarWidth, pageScrolls }) => {
    const previousTheme = document.documentElement.dataset.theme;
    const previousViewport = { width: innerWidth, height: innerHeight };
    const activity: ActivityRecord = {
      id: "d4a164c6-9af0-40d9-a99a-ee95e510ba07",
      operation: "prepare",
      target_kind: "port",
      target_id: port.id,
      status: "failed",
      started_at: 1,
      finished_at: 2,
      message: null,
      failure: failureReport(),
      cancellation: null,
    };
    const stdout = "owned conversion began password=[REDACTED]";
    const stderr = "owned conversion diagnostic on stderr";
    const diagnostic: Diagnostic = [
      {
        activity_id: activity.id,
        phase: "preparation.setup",
        complete: true,
        updated_at: 2,
        stream_limit_bytes: 2 * 1024 * 1024,
        stdout: { text: stdout, observed_bytes: stdout.length, truncated: false },
        stderr: { text: stderr, observed_bytes: stderr.length, truncated: false },
      },
    ];
    const read = vi.spyOn(desktopApi, "activityDiagnostic").mockResolvedValue(diagnostic);
    const select = vi.fn();
    const check = vi.fn();
    const host = document.body.appendChild(document.createElement("div"));
    host.className = "h-dvh";
    let rendered: RenderResult | undefined;
    try {
      await page.viewport(width, 780);
      document.documentElement.dataset.theme = theme;
      rendered = await renderComponent(
        <div className="interface-root flex h-full min-h-0 flex-col">
          <div className="interface-workspace min-h-0 flex-1">
            <div className="app-shell grid h-[100vh] grid-cols-[var(--layout-sidebar)_minmax(0,_1fr)] bg-[var(--color-bg)]">
              <Sidebar
                view="updates"
                setView={vi.fn()}
                installedCount={1}
                updateCount={0}
                activities={[activity]}
              />
              <main className="workspace-main min-h-0 w-full min-w-0 overflow-auto pb-12 max-[75rem]:pb-10">
                <UpdateCenter
                  section="tasks"
                  generation={7}
                  ports={[port]}
                  statuses={new Map()}
                  activities={[activity]}
                  activityFeed={{
                    records: [activity],
                    current_activity_ids: [],
                    attention_required_activity_ids: [activity.id],
                    recovery_required_activity_ids: [],
                    active_and_actionable_complete: true,
                    terminal_history_complete: true,
                    terminal_history_count: 1,
                    terminal_history_limit: 20,
                  }}
                  outcomes={[]}
                  diagnosticsRefreshing={false}
                  diagnosticsStale={false}
                  refreshDiagnostics={vi.fn()}
                  checkAll={check}
                  onSelect={select}
                  onOpenSettings={vi.fn()}
                />
              </main>
            </div>
          </div>
        </div>,
        { container: host },
      );
      const appShell = fixtureValue(host.querySelector<HTMLElement>(".app-shell"), "app shell");
      const sidebar = fixtureValue(appShell.querySelector<HTMLElement>(".sidebar"), "sidebar");
      expect(getComputedStyle(appShell).display).toBe(display);
      expect(sidebar.getBoundingClientRect().width).toBe(sidebarWidth);
      const taskDetails = page.getByText("Task details", { exact: true });
      await expect.element(taskDetails).toBeVisible();
      taskDetails.element().focus();
      await userEvent.keyboard("{Enter}");
      const log = page.getByText("View preparation log", { exact: true });
      await expect.element(log).toBeVisible();
      await userEvent.tab({ shift: true });
      expect(document.activeElement).toBe(log.element());
      await userEvent.keyboard("{Enter}");
      await expect.poll(() => read.mock.calls.length).toBe(1);
      expect(read).toHaveBeenCalledExactlyOnceWith(activity.id, 7);
      await expect
        .element(page.getByRole("textbox", { name: "Preparation standard output", exact: true }))
        .toBeVisible();
      expect(document.activeElement).toBe(log.element());
      const summary = log.element();
      summary.scrollIntoView({ block: "center", behavior: "instant" });
      await document.fonts.ready;
      const taskContainer = fixtureValue(taskDetails.element().closest("details"), "task details");
      const operationId = fixtureValue(
        taskContainer.querySelector<HTMLElement>(":scope > dl > dd"),
        "operation ID",
      );
      expect(operationId.textContent?.trim()).toBe(activity.id);
      const logDetails = fixtureValue(summary.closest("details"), "preparation log");
      const logOwner = fixtureValue(logDetails.parentElement, "preparation log grid owner");
      expect(logOwner.nextElementSibling).toBe(taskContainer);
      const preceding = fixtureValue(logOwner.previousElementSibling, "preceding task failure");
      expect(preceding.matches(".activity-details")).toBe(true);
      expect(preceding.textContent).toContain(
        fixtureValue(activity.failure, "preparation failure").presentation.summary,
      );
      expect(preceding.checkVisibility()).toBe(true);
      const precedingBounds = preceding.getBoundingClientRect();
      expect(precedingBounds.width).toBeGreaterThan(0);
      expect(precedingBounds.height).toBeGreaterThan(0);
      expect(precedingBounds.top).toBeGreaterThanOrEqual(0);
      expect(precedingBounds.bottom).toBeLessThanOrEqual(innerHeight);
      expect(precedingBounds.left).toBeGreaterThanOrEqual(0);
      expect(precedingBounds.right).toBeLessThanOrEqual(innerWidth);
      const summaryBounds = summary.getBoundingClientRect();
      const style = getComputedStyle(summary);
      const outlineExtent =
        parseFloat(style.outlineWidth) + Math.max(0, parseFloat(style.outlineOffset));
      expect(style.outlineStyle).not.toBe("none");
      expect(outlineExtent).toBeGreaterThan(0);
      expect(summaryBounds.top - outlineExtent).toBeGreaterThanOrEqual(precedingBounds.bottom + 4);
      expect(summaryBounds.top - outlineExtent).toBeGreaterThanOrEqual(0);
      expect(summaryBounds.left - outlineExtent).toBeGreaterThanOrEqual(0);
      expect(summaryBounds.right + outlineExtent).toBeLessThanOrEqual(innerWidth);
      expect(summaryBounds.bottom + outlineExtent).toBeLessThanOrEqual(innerHeight);
      expect(
        host.querySelector<HTMLTextAreaElement>(
          'textarea[aria-label="Preparation standard output"]',
        )?.value,
      ).toBe(stdout);
      expect(
        host.querySelector<HTMLTextAreaElement>('textarea[aria-label="Preparation standard error"]')
          ?.value,
      ).toBe(stderr);
      expect(host.textContent).toContain("Both output streams ended. Saved output is shown below.");
      const stationaryScrollContainer = pageScrolls
        ? host.querySelector(".workspace-main")
        : document.scrollingElement;
      expect(stationaryScrollContainer?.scrollTop).toBe(0);
      const navigation = page
        .getByRole("navigation", { name: "Primary navigation", exact: true })
        .element();
      expect(navigation.checkVisibility()).toBe(true);
      const navigationBounds = navigation.getBoundingClientRect();
      expect(navigationBounds.top).toBeGreaterThanOrEqual(0);
      expect(navigationBounds.bottom).toBeLessThanOrEqual(innerHeight);
      expect(navigationBounds.left).toBeGreaterThanOrEqual(0);
      expect(navigationBounds.right).toBeLessThanOrEqual(innerWidth);
      await captureParityState("activity-retained-preparation-log-spacing");
      expect(select).not.toHaveBeenCalled();
      expect(check).not.toHaveBeenCalled();
    } finally {
      await rendered?.unmount();
      host.remove();
      read.mockRestore();
      if (previousTheme === undefined) delete document.documentElement.dataset.theme;
      else document.documentElement.dataset.theme = previousTheme;
      await page.viewport(previousViewport.width, previousViewport.height);
    }
  },
);
