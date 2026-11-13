import { controlledAct as act } from "../../test/controlled-react-act";
import { render as renderComponent, cleanup, type RenderResult } from "vitest-browser-react";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";
import { desktopApi } from "../api";
import { portDefinition } from "../test-fixtures";
import type { PortIntentAssessments } from "../types";
import { ReadyGameNotices } from "./ReadyGameNotices";

const ports = [
  { ...portDefinition(), id: "new-game", name: "New Game" },
  { ...portDefinition(), id: "old-game", name: "Old Game" },
  { ...portDefinition(), id: "quiet-game", name: "Quiet Game" },
];

const assessed: PortIntentAssessments = {
  not_assessed: 0,
  ready_notices_enabled: true,
  assessments: [
    {
      port_id: "new-game",
      mode: "notify",
      newly_ready: true,
      readiness: { state: "ready", plan_sha256: "a".repeat(64), version: "1.0" },
    },
    {
      port_id: "old-game",
      mode: "notify",
      newly_ready: true,
      readiness: {
        state: "installed",
        install_id: "install-1",
        maintenance: {
          channel: "stable",
          update_policy: "notify",
          active_version: "1.0",
          available_version: "2.0",
          available_sha256: "b".repeat(64),
          checked_at: 1,
        },
      },
    },
    {
      // Set up automatically, so it never needs a notice.
      port_id: "quiet-game",
      mode: "set_up_when_ready",
      newly_ready: true,
      readiness: { state: "ready", plan_sha256: "c".repeat(64), version: "1.0" },
    },
  ],
};

let root: RenderResult;
const text = () => document.body.textContent ?? "";
function button(label: string) {
  const found = [...document.querySelectorAll<HTMLButtonElement>("button")].find(
    (item) => item.textContent === label,
  );
  if (!found) throw new Error(`Missing button: ${label}`);
  return found;
}

beforeEach(async () => {
  vi.spyOn(desktopApi, "assessPortIntents").mockResolvedValue(assessed);
  vi.spyOn(desktopApi, "acknowledgePortReadiness").mockResolvedValue(null);
  const host = document.createElement("div");
  document.body.append(host);
  root = await renderComponent(null, { container: host });
});
afterEach(async () => {
  await cleanup();
  document.body.replaceChildren();
  vi.restoreAllMocks();
});

it("announces ready games and available updates the player asked to hear about", async () => {
  const open = vi.fn();
  await root.rerender(<ReadyGameNotices generation={1} ports={ports} onOpenPort={open} />);
  await act(async () => {});
  expect(text()).toContain("New Game is ready to install.");
  expect(text()).toContain("Old Game has an update available: 2.0. Nothing was downloaded");
  expect(text()).not.toContain("Quiet Game");
  await act(async () => button("Review Old Game update").click());
  expect(open).toHaveBeenCalledWith("old-game", "ready-game-notices");
});

it("dismissing records the exact plan or release as seen", async () => {
  await root.rerender(<ReadyGameNotices generation={1} ports={ports} />);
  await act(async () => {});
  await act(async () => button("Dismiss Old Game").click());
  expect(desktopApi.acknowledgePortReadiness).toHaveBeenCalledWith(
    [{ port_id: "old-game", plan_sha256: "b".repeat(64) }],
    1,
  );
  expect(text()).not.toContain("Old Game");
  await act(async () => button("Dismiss New Game").click());
  expect(desktopApi.acknowledgePortReadiness).toHaveBeenLastCalledWith(
    [{ port_id: "new-game", plan_sha256: "a".repeat(64) }],
    1,
  );
});

it("renders notices in the current language with exact names and versions", async () => {
  const { initializeLocalization } = await import("../localization");
  const localization = initializeLocalization(["en-US"]);
  await root.rerender(<ReadyGameNotices generation={1} ports={ports} onOpenPort={vi.fn()} />);
  await act(async () => {});
  try {
    await act(async () => {
      await localization.changeLanguage("ar-XB");
    });
    await expect.poll(text).toContain("New Game جاهزة للتثبيت.");
    expect(text()).toContain("يتوفر تحديث لـ Old Game: 2.0.");
    expect(button("مراجعة تحديث Old Game")).toBeDefined();
  } finally {
    await act(async () => {
      await localization.changeLanguage("en");
    });
  }
  await expect.poll(text).toContain("New Game is ready to install.");
});
