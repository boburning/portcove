import { afterEach, expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";
import { cleanup, render } from "vitest-browser-react";
import App from "../App";
import { desktopApi } from "../api";
import { installInteractiveTransport } from "../dev-scenarios/interactive/transport";
import { activities, install, workspace } from "../dev-scenarios/interactive/scenarios";
import { fixtureValue } from "../test-fixtures";
import { initializeLocalization, LocalizationProvider } from "../localization";
import { THEME_STORAGE_KEY } from "../theme";
import { scrollWorkspaceTo } from "../workspace-scroll";
import type { ActivityFeed, InstallPlan } from "../types";
import { browserFixture } from "../../test/browser-fixture";
import { controlledAct } from "../../test/controlled-react-act";
import { captureParityState } from "../../test/parity-capture";
import { mountDiscoverPort, openDiscoverPort } from "./discover-test-helpers";
import "../styles/index.css";

let transport: ReturnType<typeof installInteractiveTransport> | undefined;
afterEach(async () => {
  await cleanup();
  transport?.dispose();
  transport = undefined;
  vi.restoreAllMocks();
});

it.each([
  ["light", 960, 640],
  ["dark", 430, 780],
] as const)(
  "keeps a committed install distinct from stale detail actions through refresh/dismiss/return in %s",
  async (theme, width, height) => {
    const owner = browserFixture({
      storage: true,
      viewport: true,
      attributes: ["data-theme", "lang", "dir"],
    });
    const container = document.createElement("div");
    container.id = "root";
    document.body.append(container);
    const portId = "collection-2";
    const installed = {
      ...install,
      id: "committed-readback-install",
      port_id: portId,
      path: `fixture/library/${portId}/versions/1.2`,
    };
    const activityId = "committed-install-activity";
    const finishedActivity: ActivityFeed = {
      ...activities,
      terminal_history_count: 1,
      records: [
        {
          id: activityId,
          cancellation: null,
          failure: null,
          message: null,
          operation: "install",
          target_id: portId,
          target_kind: "port",
          status: "succeeded",
          started_at: 28,
          finished_at: 42,
        },
      ],
    };
    let committed = false;
    let allowReadback = false;
    let finishInstall!: (value: typeof installed) => void;
    const copying = new Promise<typeof installed>((resolve) => {
      finishInstall = resolve;
    });
    let releaseRead!: () => void;
    const reading = new Promise<void>((resolve) => {
      releaseRead = resolve;
    });
    const blockedRead = vi.fn();
    const snapshot = () => {
      const current = workspace("collection");
      const port = fixtureValue(
        current.catalog.ports.find((entry) => entry.id === portId),
        portId,
      );
      port.name = "Install readback fixture";
      port.presentation = {
        installation_method: "portable-package",
        saves_and_settings: "portcove-managed",
        source_requirements: [],
        original_game_title: "Install readback fixture",
      };
      const status = fixtureValue(
        current.statuses.find((entry) => entry.port_id === portId),
        portId,
      );
      status.active = committed ? installed : null;
      status.readiness = { launchable: committed, pending_setup: false, blockers: [] };
      status.port_actions = [
        {
          action: "install",
          availability: committed ? "not_offered" : "allowed",
          reason: committed ? "already_registered" : "available",
        },
        {
          action: "launch",
          availability: committed ? "allowed" : "waiting",
          reason: committed ? "available" : "not_installed",
        },
      ];
      return { ...current, activities: committed ? finishedActivity : activities };
    };
    const plan: InstallPlan = {
      bundled_runtime: null,
      port_id: portId,
      channel: "stable",
      platform: "windows-x86-64",
      action: "download",
      source_requirements: [],
      download_bytes: 1024,
      release: {
        published_at: null,
        version: installed.version,
        channel: "stable",
        asset: {
          name: "fixture.zip",
          url: "https://example.com/fixture.zip",
          size: 1024,
          sha256: "a".repeat(64),
        },
      },
      storage: {
        library_root: "fixture/library",
        volume_total_bytes: 1_000_000,
        volume_available_bytes: 1_000_000,
      },
      output_location: {
        configured_output_directory: null,
        port_id: portId,
        library_root: "fixture/library",
        default_output_directory: installed.path,
        effective_output_directory: installed.path,
        selection_source: "library_default",
        user_data_root: `fixture/library/user/${portId}`,
      },
    };
    try {
      await page.viewport(width, height);
      localStorage.clear();
      localStorage.setItem(THEME_STORAGE_KEY, theme);
      transport = installInteractiveTransport("collection", (message) => {
        throw new Error(message);
      });
      vi.spyOn(desktopApi, "workspaceSnapshot").mockImplementation(async (generation, digest) => {
        if (generation !== 1 || digest !== null)
          throw new Error("Unexpected fixture workspace binding");
        if (committed && !allowReadback) {
          blockedRead();
          await reading;
          throw new Error("Controlled workspace readback unavailable");
        }
        return snapshot();
      });
      const review = vi.spyOn(desktopApi, "plan").mockResolvedValue(plan);
      vi.spyOn(desktopApi, "activities").mockImplementation(async () =>
        committed ? finishedActivity : activities,
      );
      const copy = vi.spyOn(desktopApi, "install").mockImplementation(async (...args) => {
        const report = args[6];
        const event = {
          schema_version: 2,
          operation_id: activityId,
          parent_operation_id: null,
          target: null,
          timestamp_ms: 1,
          operation: "install",
        };
        report?.({ ...event, type: "started", sequence: 1 });
        const result = await copying;
        report?.({ ...event, type: "finished", result: "succeeded", sequence: 2 });
        return result;
      });
      const launch = vi
        .spyOn(desktopApi, "launch")
        .mockResolvedValue({ processId: null, sessionId: "unrelated-play" });
      initializeLocalization(["en"]);
      await render(
        <LocalizationProvider api={desktopApi}>
          <App />
        </LocalizationProvider>,
        { container },
      );
      await page.getByRole("button", { name: "Discover", exact: true }).click();
      await mountDiscoverPort(portId);
      await openDiscoverPort(portId);
      await page
        .getByRole("button", { name: "Install: Install readback fixture", exact: true })
        .click();
      await page
        .getByRole("dialog")
        .getByRole("button", { name: /^Install ·/ })
        .click();
      await expect.poll(() => copy.mock.calls.length).toBe(1);
      await controlledAct(async () => {
        committed = true;
        finishInstall(installed);
      });
      await expect.poll(() => blockedRead.mock.calls.length).toBeGreaterThan(0);
      const retry = page.getByRole("button", { name: "Retry refresh", exact: true });
      const readiness = () => document.querySelector("[data-detail-readiness]")?.textContent;
      await expect.poll(readiness).toContain("Installation finished");
      await expect
        .element(
          page.getByRole("button", { name: "Install: Install readback fixture", exact: true }),
        )
        .not.toBeInTheDocument();
      await expect.element(retry).not.toBeInTheDocument();
      releaseRead();
      await expect.element(retry).toBeVisible();
      const dismiss = page.getByRole("button", {
        name: "Dismiss completion for Install game",
        exact: true,
      });
      await expect.element(dismiss).toBeEnabled();
      await expect.poll(readiness).toContain("Installation finished");
      await expect
        .element(page.getByText("Available to install", { exact: true }))
        .not.toBeInTheDocument();
      await expect
        .element(
          page.getByRole("button", { name: "Install: Install readback fixture", exact: true }),
        )
        .not.toBeInTheDocument();
      await page.getByRole("tab", { name: "Game files", exact: true }).click();
      await expect
        .element(page.getByRole("button", { name: "Review installation", exact: true }))
        .not.toBeInTheDocument();
      await expect
        .element(page.getByText("Not installed", { exact: true }))
        .not.toBeInTheDocument();
      await page.getByRole("tab", { name: "Manage", exact: true }).click();
      await expect
        .element(page.getByText("No active installation", { exact: true }))
        .not.toBeInTheDocument();
      await expect
        .element(
          page.getByText("Installation finished · awaiting library refresh", { exact: true }),
        )
        .toBeVisible();
      await page.getByText("Technical details", { exact: true }).click();
      await expect
        .element(page.getByText("Recorded check identities", { exact: true }))
        .toBeVisible();
      expect(container.querySelector(".cli-continuity")).toBeNull();
      await page.getByRole("tab", { name: "Versions & updates", exact: true }).click();
      await expect
        .element(page.getByText("Not installed", { exact: true }))
        .not.toBeInTheDocument();
      await expect
        .element(
          page.getByText("Installed version will appear after the library refreshes", {
            exact: true,
          }),
        )
        .toBeVisible();
      await page.getByRole("tab", { name: "Game files", exact: true }).click();
      const main = document.querySelector<HTMLElement>('main[data-focus-region="workspace"]')!;
      scrollWorkspaceTo(main, 0);
      await expect.element(retry).toBeVisible();
      const readinessNode = document.querySelector<HTMLElement>("[data-detail-readiness]")!;
      readinessNode.scrollIntoView({ block: "nearest", behavior: "instant" });
      await expect.poll(() => readinessNode.getBoundingClientRect().top).toBeGreaterThanOrEqual(0);
      // Nearest scrolling is quantized to device pixels. Keep both the label
      // and the recovery action in the captured viewport.
      await expect
        .poll(() => Math.round(readinessNode.getBoundingClientRect().bottom))
        .toBeLessThanOrEqual(height);
      expect(retry.element().getBoundingClientRect().top).toBeGreaterThanOrEqual(0);
      await captureParityState("install-committed-refresh-needed");
      await expect
        .element(
          page.getByText(`Installed Install readback fixture · ${installed.version}`, {
            exact: true,
          }),
        )
        .toBeVisible();
      await expect
        .element(page.getByRole("button", { name: "Open game", exact: true }))
        .not.toBeInTheDocument();
      await page.getByRole("button", { name: "View in Activity", exact: true }).click();
      await expect
        .element(page.getByRole("heading", { name: "Task history", exact: true }))
        .toBeVisible();
      await expect
        .poll(() => document.activeElement?.getAttribute("data-activity-id"))
        .toBe(activityId);
      expect(launch).not.toHaveBeenCalled();
      await page.getByRole("button", { name: "Discover", exact: true }).click();
      await mountDiscoverPort("collection-3");
      await openDiscoverPort("collection-3");
      const play = document.querySelector<HTMLButtonElement>("[data-launch-action]")!;
      await expect.element(play).toBeEnabled();
      await expect
        .element(page.getByRole("button", { name: "Review update", exact: true }))
        .toBeVisible();
      play.scrollIntoView({ block: "center" });
      await captureParityState("install-refresh-unrelated-optional-update-play");
      await userEvent.click(play);
      await expect.poll(() => launch.mock.calls.length).toBe(1);
      expect(launch.mock.calls[0]?.[0]).toBe("collection-3");
      await expect.poll(() => play.getAttribute("aria-disabled")).not.toBe("true");
      await page.getByRole("button", { name: "Back to Discover", exact: true }).click();
      await mountDiscoverPort(portId);
      await openDiscoverPort(portId);
      await expect.poll(readiness).toContain("Installation finished");
      expect(review).toHaveBeenCalledOnce();
      expect(copy).toHaveBeenCalledOnce();
      allowReadback = true;
      await retry.click();
      await expect.element(retry).not.toBeInTheDocument();
      await expect.poll(readiness).toContain("Ready to play");
      await expect
        .element(document.querySelector<HTMLButtonElement>("[data-launch-action]")!)
        .toBeEnabled();
      scrollWorkspaceTo(main, 0);
      const currentReadiness = document.querySelector<HTMLElement>("[data-detail-readiness]")!;
      currentReadiness.scrollIntoView({ block: "nearest" });
      await captureParityState("install-refreshed-current-play");
      const back = page.getByRole("button", { name: "Back to Discover", exact: true });
      await back.click();
      const openInstalled = page.getByRole("button", { name: "Open game", exact: true });
      await openInstalled.click();
      await expect.poll(readiness).toContain("Ready to play");
      await back.click();
      await expect.element(openInstalled).toHaveFocus();
      await dismiss.click();
      await expect.element(openInstalled).not.toBeInTheDocument();
      expect(copy).toHaveBeenCalledExactlyOnceWith(
        portId,
        "stable",
        "",
        "",
        false,
        1,
        expect.any(Function),
      );
      expect(review).toHaveBeenCalledExactlyOnceWith(portId, "stable");
      expect(launch).toHaveBeenCalledOnce();
    } finally {
      await controlledAct(async () => {
        allowReadback = true;
        finishInstall(installed);
        releaseRead();
      });
      await cleanup();
      container.remove();
      await owner.dispose();
    }
  },
  45_000,
);
