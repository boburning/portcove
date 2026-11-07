import { afterEach, expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";
import { cleanup, render } from "vitest-browser-react";
import { DirectionProvider } from "@base-ui/react/direction-provider";
import { StatusLayer } from "../components/Chrome";
import { UpdateCenter } from "../components/UpdateCenter";
import { act } from "react";
import { Dialog, DialogContent, DialogTitle } from "../components/ui/dialog";
import { Tooltip, TooltipProvider } from "../components/ui/tooltip";
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

it("coordinates initial hover delay and adjacent tooltips through one shared provider", async () => {
  // Park the real pointer before mounting either trigger so an earlier test
  // cannot start a hover on the real clock while this fixture is rendering.
  const restingArea = <div>Pointer resting area</div>;
  const view = await render(<main>{restingArea}</main>);
  await userEvent.hover(page.getByText("Pointer resting area").element());

  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  try {
    await view.rerender(
      <main>
        {restingArea}
        <TooltipProvider>
          <Tooltip label="First help">
            <Button>First action</Button>
          </Tooltip>
          <Tooltip label="Second help">
            <Button>Second action</Button>
          </Tooltip>
        </TooltipProvider>
      </main>,
    );
    const firstTrigger = page.getByRole("button", { name: "First action" }).element();
    const secondTrigger = page.getByRole("button", { name: "Second action" }).element();

    // Vitest advances fake timers while Playwright actions are pending. Dispatch
    // hover events in the browser so only the explicit advances move the clock.
    function enterTrigger(trigger: Element, from: Element | null) {
      trigger.dispatchEvent(
        new PointerEvent("pointerover", {
          bubbles: true,
          pointerType: "mouse",
          relatedTarget: from,
        }),
      );
      trigger.dispatchEvent(new MouseEvent("mouseenter", { relatedTarget: from }));
      trigger.dispatchEvent(new MouseEvent("mousemove", { bubbles: true, relatedTarget: from }));
    }

    await act(async () => enterTrigger(firstTrigger, null));
    expect(document.querySelector('[role="tooltip"]')).toBeNull();
    await act(async () => vi.advanceTimersByTimeAsync(399));
    expect(document.querySelector('[role="tooltip"]')).toBeNull();
    await act(async () => vi.advanceTimersByTimeAsync(1));
    expect(document.querySelector('[role="tooltip"]')?.textContent).toBe("First help");
    await act(async () => {
      firstTrigger.dispatchEvent(new MouseEvent("mouseleave", { relatedTarget: secondTrigger }));
      enterTrigger(secondTrigger, firstTrigger);
    });
    await act(async () => vi.advanceTimersByTimeAsync(0));
    expect(
      [...document.querySelectorAll('[role="tooltip"]')].some(
        (node) => node.textContent === "Second help",
      ),
    ).toBe(true);
  } finally {
    vi.useRealTimers();
  }
});

it("retains the shared provider across a modal portal and preserves existing descriptions", async () => {
  await render(
    <TooltipProvider>
      <Dialog open>
        <DialogContent>
          <DialogTitle>Tooltip modal</DialogTitle>
          <p id="existing-help">Existing instructions</p>
          <Tooltip label="Modal supplemental help">
            <Button aria-describedby="existing-help">Modal action</Button>
          </Tooltip>
        </DialogContent>
      </Dialog>
    </TooltipProvider>,
  );
  const trigger = page.getByRole("button", { name: "Modal action" });
  await expect.element(trigger).toHaveFocus();
  const tooltip = page.getByRole("tooltip");
  await expect.element(tooltip).toBeVisible();
  expect(tooltip.element().closest('[role="dialog"]')).toBe(page.getByRole("dialog").element());
  await expect
    .element(trigger)
    .toHaveAccessibleDescription("Existing instructions Modal supplemental help");
  expect(trigger.element().getAttribute("aria-describedby")?.split(" ")).toEqual(
    expect.arrayContaining(["existing-help", tooltip.element().id]),
  );
  await userEvent.keyboard("{Escape}");
  await expect.element(tooltip).not.toBeInTheDocument();
  await expect.element(trigger).toHaveAccessibleDescription("Existing instructions");
});
