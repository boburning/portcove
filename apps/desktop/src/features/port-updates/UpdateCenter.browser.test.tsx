import { controlledAct as act } from "../../../test/controlled-react-act";
import { render as renderComponent, cleanup, type RenderResult } from "vitest-browser-react";
import { fixtureValue } from "../../test-fixtures";

import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import * as clipboard from "../../clipboard";
import { UpdateCenter } from "../../components/UpdateCenter";
import { failureReport, portStatus } from "../../test-fixtures";
import type { ActivityRecord } from "../../types";

import { installRecord, updateCenterFixtures } from "../../components/rendered-test-fixtures";
import { captureParityState } from "../../../test/parity-capture";
import { page } from "vite-plus/test/browser";

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
