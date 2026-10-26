import { afterEach, expect, it, vi } from "vite-plus/test";
import { page } from "vite-plus/test/browser";
import { cleanup, render } from "vitest-browser-react";
import App from "../App";
import { desktopApi } from "../api";
import { installInteractiveTransport } from "../dev-scenarios/interactive/transport";
import { doctor, preparation } from "../dev-scenarios/interactive/scenarios";
import { initializeLocalization, LocalizationProvider } from "../localization";
import type { PreparationCleanupPreview } from "../types";
import { navigateTo } from "../../test/primary-navigation";
import "../styles/index.css";

let transport: ReturnType<typeof installInteractiveTransport> | undefined;
afterEach(async () => {
  await cleanup();
  document.getElementById("root")?.remove();
  transport?.dispose();
  transport = undefined;
  vi.restoreAllMocks();
  localStorage.clear();
  document.documentElement.style.removeProperty("font-size");
});

// macOS qualification 40344060360/a1 exhausted 15s during the final navigation.
it("keeps another port's retained cleanup identity through cancelled review and a separate completed preparation", async () => {
  await page.viewport(1366, 768);
  localStorage.clear();
  transport = installInteractiveTransport("setup", (message) => {
    throw Error(message);
  });
  const retained: PreparationCleanupPreview = {
    format_version: 1,
    operation_id: "retained-orchard-operation",
    port_id: "orchard",
    retained_path: "fixture/library/staging/retained-orchard-operation",
    retained: {
      directories: ["payload"],
      files: [{ relative_path: "payload/game.dat", sha256: "a".repeat(64), size: 128 }],
      skipped_entries: [],
      total_bytes: 128,
    },
    original_install_path: "fixture/library/orchard/versions/original",
    source_path: "fixture/originals/orchard.iso",
    persistent_data_path: "fixture/library/user/orchard",
    backup_path: "fixture/library/backups/orchard",
    logs_path: "fixture/library/logs/orchard-operation",
    cleanup_is_irreversible: true,
    interrupted_cleanup_will_retry: true,
    preview_sha256: "b".repeat(64),
  };
  const recorded = JSON.stringify(retained);
  vi.spyOn(desktopApi, "doctor").mockResolvedValue({
    ...doctor,
    repair: {
      generated_at: 1,
      items: [
        {
          kind: "retained_preparation",
          port_id: retained.port_id,
          operation_id: retained.operation_id,
          path: retained.retained_path,
          message: "",
          proposed_action: "Review the unfinished setup files.",
        },
      ],
    },
  });
  const preview = vi.spyOn(desktopApi, "previewPreparationCleanup").mockResolvedValue(retained);
  const remove = vi.spyOn(desktopApi, "cleanupPreparation").mockResolvedValue(retained);
  const review = vi.spyOn(desktopApi, "planPreparation").mockResolvedValue(preparation);
  let finish!: () => void;
  const prepare = vi
    .spyOn(desktopApi, "prepare")
    .mockImplementation(async (_target, _fingerprint, _generation, onEvent) => {
      onEvent({
        schema_version: 2,
        operation_id: "new-sample-operation",
        parent_operation_id: null,
        target: null,
        sequence: 0,
        timestamp_ms: 2,
        operation: "prepare",
        type: "started",
      });
      return new Promise((resolve) => {
        finish = () => resolve(preparation.inputs.install);
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
  await document.fonts.ready;
  document.documentElement.dataset.theme = "dark";
  const capture = (name: string) =>
    page.screenshot({
      element: document.documentElement,
      path: `../../../../outputs/uiux-task-isolation/${name}.png`,
    });
  const facts = [
    retained.port_id,
    retained.retained_path,
    retained.original_install_path,
    retained.source_path,
    retained.persistent_data_path,
    retained.backup_path,
    retained.logs_path,
  ];
  const openRetained = async () => {
    await navigateTo("Activity");
    const summary = page.getByText("Orchard Quest · Unfinished setup files", { exact: true });
    if (!summary.element().closest("details")?.open) await summary.click();
    expect(
      document.querySelector(`[data-recovery-operation="${retained.operation_id}"]`)?.textContent,
    ).toContain(retained.operation_id);
    await page.getByRole("button", { name: "Review unfinished setup files", exact: true }).click();
    const account = page.getByRole("dialog", {
      name: "Files left by unfinished setup",
      exact: true,
    });
    await expect.element(account).toBeVisible();
    const locations = account.element().querySelector("details")!;
    expect(locations.open).toBe(false);
    expect(account.element().textContent).toContain("What you can do now");
    await page.getByText("Installation, source, saves, backups and logs", { exact: true }).click();
    expect(locations.open).toBe(true);
    for (const fact of facts) expect(account.element().textContent).toContain(fact);
    expect(remove).not.toHaveBeenCalled();
    await page.getByRole("button", { name: "Review cleanup…", exact: true }).click();
    const dialog = page.getByRole("dialog", {
      name: "Delete files left by unfinished setup?",
      exact: true,
    });
    await expect.element(dialog).toBeVisible();
    expect(
      [...dialog.element().querySelectorAll("dd")]
        .find((node) => node.textContent === retained.source_path)
        ?.closest("details"),
    ).toBeNull();
    for (const fact of facts) expect(dialog.element().textContent).toContain(fact);
    expect(dialog.element().textContent).toContain("1 file · 128 B");
    expect(preview.mock.lastCall).toEqual([retained.operation_id, 1]);
    expect(remove).not.toHaveBeenCalled();
    return dialog;
  };
  const openOther = async () => {
    await navigateTo("Library");
    await page
      .getByRole("button", {
        name: "View details for Harbor Adventure Harbor Adventure",
        exact: true,
      })
      .click();
    await page.getByRole("button", { name: "Review game preparation", exact: true }).click();
    expect(review.mock.lastCall).toEqual(["sample", 1]);
    expect(page.getByRole("dialog").element().textContent).toContain(
      preparation.inputs.source.path,
    );
  };
  await openRetained();
  await capture("recovery-before-dark");
  await page.getByRole("button", { name: "Keep files", exact: true }).click();
  await openOther();
  await page.getByRole("button", { name: "Cancel review", exact: true }).click();
  await openRetained();
  await page.getByRole("button", { name: "Keep files", exact: true }).click();
  await openOther();
  await page.getByRole("button", { name: "Prepare game data", exact: true }).click();
  await expect.poll(() => prepare.mock.calls.length).toBe(1);
  expect(prepare.mock.calls[0]?.slice(0, 3)).toEqual(["sample", preparation.plan_sha256, 1]);
  finish();
  await expect.poll(() => document.querySelector('[role="dialog"]')).toBeNull();
  await openRetained();
  expect(JSON.stringify(retained)).toBe(recorded);
  expect(preview.mock.calls).toEqual(Array.from({ length: 6 }, () => [retained.operation_id, 1]));
  await capture("recovery-after-dark");
  await page.getByRole("button", { name: "Keep files", exact: true }).click();
  expect(remove).not.toHaveBeenCalled();
  expect(
    document.querySelector(`[data-recovery-operation="${retained.operation_id}"]`),
  ).not.toBeNull();
  for (const layout of [
    { name: "enlarged-light", width: 1366, height: 768, fontSize: "32px" },
    { name: "narrow-light", width: 320, height: 640, fontSize: "16px" },
  ]) {
    await page.viewport(layout.width, layout.height);
    document.documentElement.dataset.theme = "light";
    document.documentElement.style.fontSize = layout.fontSize;
    await document.fonts.ready;
    await new Promise<void>((resolve) =>
      requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
    );
    const recovery = document.querySelector<HTMLElement>(".recovery-review")!;
    recovery.scrollIntoView({ block: "start" });
    expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(layout.width);
    await capture(`activity-${layout.name}`);
    const dialog = await openRetained();
    dialog.element().scrollTop = 0;
    await capture(`recovery-${layout.name}-facts`);
    const keep = page.getByRole("button", { name: "Keep files", exact: true });
    // The popup initially focuses Keep files. After inspecting the top by
    // scrolling, give it a fresh focus event so the browser reveals it again.
    keep.element().blur();
    keep.element().focus();
    await expect.element(keep).toHaveFocus();
    const action = keep.element().getBoundingClientRect();
    expect(action.top).toBeGreaterThanOrEqual(0);
    expect(action.bottom).toBeLessThanOrEqual(layout.height);
    expect(dialog.element().scrollWidth).toBeLessThanOrEqual(dialog.element().clientWidth + 1);
    await capture(`recovery-${layout.name}-actions`);
    await keep.click();
    expect(remove).not.toHaveBeenCalled();
  }
}, 30_000);
