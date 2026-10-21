import { afterEach, expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";
import { cleanup, render } from "vitest-browser-react";
import App from "../App";
import { desktopApi } from "../api";
import { installInteractiveTransport } from "../dev-scenarios/interactive/transport";
import { activities, preparation, workspace } from "../dev-scenarios/interactive/scenarios";
import type { ActivityRecord } from "../types";
import { initializeLocalization, LocalizationProvider } from "../localization";
import { fixtureValue } from "../test-fixtures";
import "../styles/index.css";

let transport: ReturnType<typeof installInteractiveTransport> | undefined;
afterEach(async () => {
  await cleanup();
  document.getElementById("root")?.remove();
  transport?.dispose();
  transport = undefined;
  vi.restoreAllMocks();
  localStorage.clear();
});

it.each(["orchard", "summit"])(
  "retains %s's reviewed preparation identity through running, completion and its actual App Play action",
  async (portId) => {
    await page.viewport(960, 640);
    localStorage.clear();
    transport = installInteractiveTransport("setup", (message) => {
      throw Error(message);
    });
    let prepared = false;
    const install = {
      ...preparation.inputs.install,
      id: `installed-${portId}`,
      port_id: portId,
      path: `fixture/library/ports/${portId}/versions/1.2`,
    };
    const plan = {
      ...preparation,
      port_id: portId,
      plan_sha256: `reviewed-${portId}`,
      inputs: {
        ...preparation.inputs,
        install,
        source: { ...preparation.inputs.source, path: `fixture/originals/${portId}.iso` },
      },
    };
    vi.spyOn(desktopApi, "workspaceSnapshot").mockImplementation(async () => {
      const snapshot = workspace("setup");
      const port = fixtureValue(
        snapshot.catalog.ports.find((item) => item.id === portId),
        portId,
      );
      port.adapter = "upstream-managed-setup";
      port.setup_output_paths = ["game.dat"];
      const status = fixtureValue(
        snapshot.statuses.find((item) => item.port_id === portId),
        portId,
      );
      status.active = install;
      status.readiness = { launchable: prepared, pending_setup: !prepared, blockers: [] };
      return snapshot;
    });
    const review = vi.spyOn(desktopApi, "planPreparation").mockResolvedValue(plan);
    let finish!: () => void;
    const prepare = vi
      .spyOn(desktopApi, "prepare")
      .mockImplementation(async (_target, _expectedPlan, _generation, onEvent) => {
        onEvent({
          schema_version: 2,
          operation_id: `preparing-${portId}`,
          parent_operation_id: null,
          target: null,
          sequence: 0,
          timestamp_ms: 1,
          operation: "prepare",
          type: "started",
        });
        return new Promise((resolve) => {
          finish = () => {
            prepared = true;
            resolve(install);
          };
        });
      });
    const launch = vi.spyOn(desktopApi, "launch").mockResolvedValue({
      processId: null,
      sessionId: `simulated-launch-${portId}`,
    });
    const root = document.createElement("div");
    root.id = "root";
    document.body.append(root);
    initializeLocalization(["en"]);
    await render(
      <LocalizationProvider api={desktopApi}>
        <App />
      </LocalizationProvider>,
      { container: root },
    );
    const title = portId === "orchard" ? "Orchard Quest" : "Summit Racer";
    await page
      .getByRole("button", { name: `View details for ${title} Port: ${title}`, exact: true })
      .click();
    await page.getByRole("button", { name: "Review game preparation", exact: true }).click();
    expect(review).toHaveBeenCalledWith(portId, 1);
    const dialog = page.getByRole("dialog", { name: "Prepare game data", exact: true });
    for (const fact of [title, install.path, plan.inputs.source.path, install.version])
      expect(dialog.element().textContent).toContain(fact);
    await page.getByRole("button", { name: "Prepare game data", exact: true }).click();
    await expect.poll(() => prepare.mock.calls.length).toBe(1);
    expect(prepare.mock.calls[0]?.slice(0, 3)).toEqual([portId, plan.plan_sha256, 1]);
    for (const fact of [title, install.path, plan.inputs.source.path])
      expect(dialog.element().textContent).toContain(fact);
    await userEvent.keyboard("{Escape}");
    await expect.element(dialog).toBeVisible();
    finish();
    await expect.poll(() => document.querySelector('[role="dialog"]')).toBeNull();
    expect(
      document.querySelector("[data-detail-port-id]")?.getAttribute("data-detail-port-id"),
    ).toBe(portId);
    await page.getByRole("button", { name: "Play", exact: true }).click();
    await expect.poll(() => launch.mock.calls[0]).toEqual([portId, "", 1]);
    expect(document.body.textContent).not.toContain("You can now play");
  },
);

it("leaves preparation, visits another entry, and revisits the original task without completion taking focus", async () => {
  await page.viewport(1366, 768);
  transport = installInteractiveTransport("setup", (message) => {
    throw Error(message);
  });
  let started = false;
  let settled = false;
  const record = (): ActivityRecord => ({
    id: "owned-harbor-preparation",
    operation: "prepare",
    target_kind: "port",
    target_id: "sample",
    started_at: Math.floor(Date.now() / 1000),
    finished_at: settled ? Math.floor(Date.now() / 1000) : null,
    status: settled ? "succeeded" : "running",
    cancellation: null,
    failure: null,
    message: null,
  });
  vi.spyOn(desktopApi, "activities").mockImplementation(async () => ({
    ...activities,
    records: started ? [record()] : [],
    current_activity_ids: started && !settled ? [record().id] : [],
  }));
  vi.spyOn(desktopApi, "planPreparation").mockResolvedValue(preparation);
  vi.spyOn(desktopApi, "activityDiagnostic").mockResolvedValue([]);
  const cancel = vi.spyOn(desktopApi, "cancelOperation");
  let finish!: () => void;
  vi.spyOn(desktopApi, "prepare").mockImplementation(async (_id, _plan, _generation, onEvent) => {
    started = true;
    onEvent({
      schema_version: 2,
      type: "started",
      operation: "prepare",
      operation_id: record().id,
      parent_operation_id: null,
      target: null,
      sequence: 1,
      timestamp_ms: Date.now(),
    });
    return new Promise((resolve) => {
      finish = () => {
        settled = true;
        resolve(preparation.inputs.install);
      };
    });
  });
  const root = document.createElement("div");
  root.id = "root";
  document.body.append(root);
  initializeLocalization(["en"]);
  await render(
    <LocalizationProvider api={desktopApi}>
      <App />
    </LocalizationProvider>,
    { container: root },
  );
  await page
    .getByRole("button", {
      name: "View details for Harbor Adventure Port: Harbor Adventure",
      exact: true,
    })
    .click();
  await page.getByRole("button", { name: "Review game preparation", exact: true }).click();
  await page.getByRole("button", { name: "Prepare game data", exact: true }).click();
  await page.getByRole("button", { name: "Continue browsing", exact: true }).click();
  await expect.poll(() => document.querySelector('[role="dialog"]')).toBeNull();
  expect(cancel).not.toHaveBeenCalled();
  await page.getByRole("button", { name: /^Library/ }).click();
  await page
    .getByRole("button", {
      name: "View details for Orchard Quest Port: Orchard Quest",
      exact: true,
    })
    .click();
  const invocation = page.getByRole("group", {
    name: "Prepare game data · Harbor Adventure",
    exact: true,
  });
  await expect.element(invocation).toBeVisible();
  await invocation.getByRole("button", { name: "View task in Activity", exact: true }).click();
  await expect
    .poll(
      () => document.querySelector('[data-activity-id="owned-harbor-preparation"]')?.textContent,
    )
    .toContain("Harbor Adventure");
  const task = document.querySelector<HTMLElement>(
    '[data-activity-id="owned-harbor-preparation"]',
  )!;
  expect(task?.textContent).not.toContain("Orchard Quest");
  const settings = page.getByRole("button", { name: "Settings", exact: true });
  await settings.click();
  const focus = document.activeElement;
  finish();
  await expect
    .poll(() => document.querySelector("[data-invocation-id]")?.textContent)
    .toContain("finished");
  expect(document.activeElement).toBe(focus);
  expect(document.body.textContent).toContain("Appearance");
  expect(cancel).not.toHaveBeenCalled();
});
