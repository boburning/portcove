import { afterEach, expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";
import { cleanup, render } from "vitest-browser-react";
import { DirectionProvider } from "@base-ui/react/direction-provider";
import { StatusLayer } from "../components/Chrome";
import { UpdateCenter } from "../components/UpdateCenter";
import { Tooltip } from "../components/ui/tooltip";
import { Button } from "../components/ui/button";
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
  const view = await render(show([first]));
  await expect
    .element(page.getByRole("status"))
    .toHaveTextContent("Save setting · Portcove: finished.");
  await view.rerender(show([first, second]));
  await expect
    .element(page.getByRole("status"))
    .toHaveTextContent("Check updates · Portcove: finished.");
  await page.getByRole("button", { name: "Dismiss completion for Check updates" }).click();
  expect(dismiss).toHaveBeenCalledExactlyOnceWith(2);
  await view.rerender(show([first]));
  await expect.element(page.getByRole("status")).not.toBeInTheDocument();
});

it("provides supplemental keyboard help in a direction-aware portal without changing the action name", async () => {
  await render(
    <DirectionProvider direction="rtl">
      <Tooltip label="Open commands">
        <Button aria-label="Commands" size="icon">
          ?
        </Button>
      </Tooltip>
    </DirectionProvider>,
  );
  await userEvent.keyboard("{Tab}");
  await expect.element(page.getByRole("button", { name: "Commands" })).toHaveFocus();
  await expect.element(page.getByRole("tooltip")).toHaveTextContent("Open commands");
  await expect.element(page.getByRole("button", { name: "Commands" })).toHaveFocus();
  await userEvent.keyboard("{Escape}");
  await expect.element(page.getByRole("tooltip")).not.toBeInTheDocument();
});
