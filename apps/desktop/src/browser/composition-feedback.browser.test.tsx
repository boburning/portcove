import { afterEach, expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";
import { cleanup, render } from "vitest-browser-react";
import { DirectionProvider } from "@base-ui/react/direction-provider";
import { StatusLayer } from "../components/Chrome";
import { UpdateCenter } from "../components/UpdateCenter";
import { Tooltip } from "../components/ui/tooltip";
import { Button } from "../components/ui/button";
import axe from "axe-core";
import { portDefinition } from "../test-fixtures";
import type { ActivityRecord } from "../types";
import type { InvocationRecord } from "../features/operations/invocation-state";

afterEach(async () => {
  await cleanup();
  await page.viewport(1280, 800);
});

it.each([320, 576, 1024])(
  "keeps populated Activity timestamps visible at %i and retains mounted panel state",
  async (width) => {
    await page.viewport(width, 900);
    const activity: ActivityRecord = {
      id: "finished-backup",
      operation: "backup",
      target_kind: "port",
      target_id: "sample",
      status: "succeeded",
      started_at: 1792580400,
      finished_at: 1792580460,
      message: null,
      failure: null,
      cancellation: null,
    };
    await render(
      <UpdateCenter
        generation={1}
        ports={[portDefinition()]}
        statuses={new Map()}
        activities={[activity]}
        outcomes={[]}
        diagnosticsRefreshing={false}
        diagnosticsStale={false}
        refreshDiagnostics={vi.fn()}
        checkAll={vi.fn()}
        onSelect={vi.fn()}
        onOpenSettings={vi.fn()}
      />,
    );
    await page.getByRole("tab", { name: "History", exact: true }).click();
    const time = document.querySelector<HTMLElement>(".activity-time")!;
    expect(time.textContent?.length).toBeGreaterThan(0);
    expect(getComputedStyle(time).display).not.toBe("none");
    expect(time.getBoundingClientRect().width).toBeGreaterThan(0);
    expect(time.getBoundingClientRect().right).toBeLessThanOrEqual(width);
    const tab = page.getByRole("tab", { name: "Tasks", exact: true });
    await tab.click();
    await userEvent.keyboard("{ArrowRight}{Enter}");
    await expect
      .element(page.getByRole("tab", { name: "Game updates", exact: true }))
      .toHaveAttribute("aria-selected", "true");
    expect(time.isConnected).toBe(true);
    await userEvent.keyboard("{ArrowLeft}{Enter}");
    await expect.element(tab).toHaveAttribute("aria-selected", "true");
    expect(time.isConnected).toBe(true);
    await page.getByRole("tab", { name: "History", exact: true }).click();
    await expect.element(time).toBeVisible();
    expect(document.querySelector(".activity-time")).toBe(time);
  },
);

it("shows one identity-bound completion without replaying old success after dismissal", async () => {
  const first: InvocationRecord = {
    id: 1,
    name: "save",
    context: {
      action: "Save setting",
      target: { kind: "application", id: "settings", label: "Portcove" },
      libraryGeneration: 1,
      exclusionScope: "application",
    },
    phase: "settled",
    outcome: "succeeded",
  };
  const second = { ...first, id: 2, context: { ...first.context, action: "Check updates" } };
  const dismiss = vi.fn();
  const show = (records: InvocationRecord[]) => (
    <StatusLayer
      clearError={vi.fn()}
      invocations={new Map(records.map((record) => [record.id, record]))}
      dismissInvocation={dismiss}
    />
  );
  const view = await render(show([]));
  const announcements = page.getByRole("status", { name: "Task updates" }).element();
  expect(announcements.textContent).toBe("");
  const visibleCompletions = () =>
    document.querySelectorAll('[data-invocation-id] [data-slot="notice-body"]');
  await view.rerender(show([first]));
  expect(visibleCompletions()).toHaveLength(1);
  expect(visibleCompletions()[0]?.textContent).toBe("Save setting · Portcove: finished.");
  const firstMessage = announcements.querySelector('[data-announcement-invocation-id="1"]');
  expect(firstMessage?.textContent).toBe("Save setting · Portcove: finished.");
  await view.rerender(show([first, second]));
  expect(visibleCompletions()).toHaveLength(1);
  expect(visibleCompletions()[0]?.textContent).toBe("Check updates · Portcove: finished.");
  expect(announcements.querySelector('[data-announcement-invocation-id="1"]')).toBe(firstMessage);
  expect(announcements.querySelector('[data-announcement-invocation-id="2"]')?.textContent).toBe(
    "Check updates · Portcove: finished.",
  );
  await page.getByRole("button", { name: "Dismiss completion for Check updates" }).click();
  expect(dismiss).toHaveBeenCalledExactlyOnceWith(2);
  await view.rerender(show([first]));
  expect(visibleCompletions()).toHaveLength(0);
  expect(page.getByRole("status", { name: "Task updates" }).element()).toBe(announcements);
  expect(announcements.querySelector('[data-announcement-invocation-id="1"]')).toBe(firstMessage);
  expect(announcements.querySelector('[data-announcement-invocation-id="2"]')).toBeNull();
});

it("provides supplemental keyboard help in a direction-aware portal without changing the action name", async () => {
  await render(
    <main>
      <DirectionProvider direction="rtl">
        <Tooltip label="Open commands">
          <Button aria-label="Commands" size="icon">
            ?
          </Button>
        </Tooltip>
      </DirectionProvider>
    </main>,
  );
  await userEvent.keyboard("{Tab}");
  await expect.element(page.getByRole("button", { name: "Commands" })).toHaveFocus();
  await expect.element(page.getByRole("tooltip")).toHaveTextContent("Open commands");
  const landmarks = await axe.run(document.body, { runOnly: ["region"] });
  expect(landmarks.violations).toEqual([]);
  expect(landmarks.incomplete).toEqual([]);
  await expect.element(page.getByRole("button", { name: "Commands" })).toHaveFocus();
  await userEvent.keyboard("{Escape}");
  await expect.element(page.getByRole("tooltip")).not.toBeInTheDocument();
});

it.each(["main", "aside", "header"] as const)(
  "keeps a tooltip visible at a scrollable %s edge",
  async (owner) => {
    await page.viewport(320, 600);
    const Owner = owner;
    await render(
      <Owner
        aria-label="Tooltip host"
        style={{ width: "100%", height: 160, overflow: "auto", position: "relative" }}
      >
        <div style={{ height: 320 }} />
        <Tooltip label="Additional actions">
          <Button>Actions</Button>
        </Tooltip>
      </Owner>,
    );
    await userEvent.keyboard("{Tab}");
    const trigger = page.getByRole("button", { name: "Actions", exact: true });
    await expect.element(trigger).toHaveFocus();
    const popup = page.getByRole("tooltip");
    await expect.element(popup).toBeVisible();
    const element = popup.element();
    const host = document.querySelector(owner)!;
    expect(element.closest(owner)).toBe(host);
    expect(host.scrollTop).toBeGreaterThan(0);
    const box = element.getBoundingClientRect();
    expect(box.left).toBeGreaterThanOrEqual(0);
    expect(box.right).toBeLessThanOrEqual(320);
    expect(box.top).toBeGreaterThanOrEqual(0);
    expect(box.bottom).toBeLessThanOrEqual(600);
    const landmarks = await axe.run(document.body, { runOnly: ["region"] });
    expect(landmarks.violations).toEqual([]);
    expect(landmarks.incomplete).toEqual([]);
  },
);
