import { controlledAct as act } from "../../test/controlled-react-act";
import { render as renderComponent, cleanup, type RenderResult } from "vitest-browser-react";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";
import { userEvent } from "vite-plus/test/browser";
import { desktopApi } from "../api";
import { announceReadyNoticePreferenceChange } from "../features/game-file-discovery/use-standing-setup";
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
  const found = [...document.querySelectorAll<HTMLButtonElement>("button")].find((item) => {
    const labels = item.getAttribute("aria-labelledby")?.split(" ");
    const name = labels?.map((id) => document.getElementById(id)?.textContent).join(" ");
    return (name ?? item.textContent) === label;
  });
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
  const update = button("Review update Old Game");
  const setup = button("Review setup New Game");
  expect(update.textContent).toBe("Review update");
  expect(setup.textContent).toBe("Review setup");
  await act(async () => {
    update.click();
    setup.click();
  });
  expect(open).toHaveBeenNthCalledWith(1, "old-game", update.dataset.detailOrigin, "updates");
  expect(open).toHaveBeenNthCalledWith(2, "new-game", setup.dataset.detailOrigin, "files");
  expect(update.dataset.detailOrigin).not.toBe(setup.dataset.detailOrigin);
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
    expect(button("مراجعة التحديث Old Game")).toBeDefined();
  } finally {
    await act(async () => {
      await localization.changeLanguage("en");
    });
  }
  await expect.poll(text).toContain("New Game is ready to install.");
});

function pendingAcknowledgement() {
  let confirm!: (result: null) => void;
  let reject!: (failure: Error) => void;
  const pending = new Promise<null>((resolve, refuse) => {
    confirm = resolve;
    reject = refuse;
  });
  vi.mocked(desktopApi.acknowledgePortReadiness).mockReturnValueOnce(pending);
  return { confirm: () => confirm(null), reject: () => reject(new Error("Fixture refusal")) };
}

it("keeps pending dismissal focused, excludes repeat activation and restores focus after success", async () => {
  const pending = pendingAcknowledgement();
  await root.rerender(
    <>
      <button id="notice-setting">Notice preferences</button>
      <ReadyGameNotices
        generation={1}
        ports={ports}
        onOpenPort={vi.fn()}
        fallbackFocus={() => document.getElementById("notice-setting")}
      />
    </>,
  );
  await act(async () => {});
  button("Dismiss New Game").focus();
  await userEvent.keyboard("{Enter}{Enter}");
  expect(desktopApi.acknowledgePortReadiness).toHaveBeenCalledExactlyOnceWith(
    [{ port_id: "new-game", plan_sha256: "a".repeat(64) }],
    1,
  );
  const working = button("Dismissing… New Game");
  expect(working.getAttribute("aria-busy")).toBe("true");
  expect(document.activeElement).toBe(working);

  await act(async () => pending.confirm());
  expect(document.activeElement).toBe(button("Review update Old Game"));
  button("Dismiss Old Game").focus();
  await userEvent.keyboard("{Enter}");
  await expect.poll(() => document.activeElement).toBe(button("Notice preferences"));
});

it("keeps focus on failed dismissal, explains what happened and supports retry", async () => {
  const pending = pendingAcknowledgement();
  await root.rerender(<ReadyGameNotices generation={1} ports={ports} />);
  await act(async () => {});
  const dismiss = button("Dismiss Old Game");
  dismiss.focus();
  await userEvent.keyboard("{Enter}");
  await act(async () => pending.reject());
  expect(document.activeElement).toBe(dismiss);
  expect(document.querySelector('[role="alert"]')?.textContent).toBe(
    "Couldn’t confirm dismissal. Try Dismiss again.",
  );
  expect(dismiss.getAttribute("aria-busy")).toBeNull();

  await userEvent.keyboard("{Enter}");
  await expect.poll(text).not.toContain("Old Game");
  expect(desktopApi.acknowledgePortReadiness).toHaveBeenCalledTimes(2);
});

it("keeps deliberate focus and suppresses a stale assessment resolved after dismissal", async () => {
  const pending = pendingAcknowledgement();
  await root.rerender(
    <>
      <button>Other control</button>
      <ReadyGameNotices generation={1} ports={ports} onOpenPort={vi.fn()} />
    </>,
  );
  await act(async () => {});
  button("Dismiss Old Game").focus();
  await userEvent.keyboard("{Enter}");
  const other = button("Other control");
  other.focus();
  let respond!: (result: PortIntentAssessments) => void;
  const reading = new Promise<PortIntentAssessments>((resolve) => {
    respond = resolve;
  });
  vi.mocked(desktopApi.assessPortIntents).mockReturnValueOnce(reading);
  await act(async () => announceReadyNoticePreferenceChange());
  expect(desktopApi.assessPortIntents).toHaveBeenCalledTimes(2);
  await act(async () => pending.confirm());
  expect(text()).not.toContain("Old Game");

  await act(async () => respond(assessed));
  expect(text()).not.toContain("Old Game");
  expect(document.activeElement).toBe(other);
});

function assessedUpdate(sha: string, version: string) {
  const changed = structuredClone(assessed);
  const updated = changed.assessments.find((item) => item.port_id === "old-game")!;
  if (updated.readiness.state !== "installed" || !updated.readiness.maintenance)
    throw new Error("Expected installed update fixture");
  updated.readiness.maintenance.available_sha256 = sha.repeat(64);
  updated.readiness.maintenance.available_version = version;
  return changed;
}

it.each(["notice", "other control"] as const)(
  "keeps keyboard continuity when a read replaces a pending notice with focus on %s",
  async (focused) => {
    const pending = pendingAcknowledgement();
    await root.rerender(
      <>
        <button>Other control</button>
        <ReadyGameNotices generation={1} ports={ports} onOpenPort={vi.fn()} />
      </>,
    );
    await act(async () => {});
    button("Dismiss Old Game").focus();
    await userEvent.keyboard("{Enter}");
    const other = button("Other control");
    if (focused === "other control") other.focus();
    vi.mocked(desktopApi.assessPortIntents).mockResolvedValue(assessedUpdate("d", "3.0"));
    await act(async () => announceReadyNoticePreferenceChange());
    expect(text()).toContain("Old Game has an update available: 3.0");
    const expected = focused === "notice" ? button("Review update Old Game") : other;
    expect(document.activeElement).toBe(expected);
    await act(async () => pending.confirm());
    expect(text()).toContain("Old Game has an update available: 3.0");
    expect(document.activeElement).toBe(expected);
  },
);

it("honors Core when an acknowledged release becomes newly ready again", async () => {
  await root.rerender(<ReadyGameNotices generation={1} ports={ports} />);
  await act(async () => {});
  expect(text()).toContain("Old Game has an update available: 2.0");
  await act(async () => button("Dismiss Old Game").click());
  expect(text()).not.toContain("Old Game");

  vi.mocked(desktopApi.assessPortIntents).mockResolvedValue(assessedUpdate("d", "3.0"));
  await act(async () => announceReadyNoticePreferenceChange());
  expect(text()).toContain("Old Game has an update available: 3.0");
  await act(async () => button("Dismiss Old Game").click());
  expect(text()).not.toContain("Old Game");

  vi.mocked(desktopApi.assessPortIntents).mockResolvedValue(assessed);
  await act(async () => announceReadyNoticePreferenceChange());
  expect(text()).toContain("Old Game has an update available: 2.0");
  await act(async () => button("Dismiss Old Game").click());
  expect(text()).not.toContain("Old Game");
  expect(vi.mocked(desktopApi.acknowledgePortReadiness).mock.calls).toEqual(
    ["b", "d", "b"].map((sha) => [[{ port_id: "old-game", plan_sha256: sha.repeat(64) }], 1]),
  );
});

it("wraps exact long names and versions without expanding the settings grid", async () => {
  const longPorts = ports.map((port) => ({
    ...port,
    name: `${port.name} ${"VeryLongReleaseProjectName".repeat(6)}`,
  }));
  const version = `2026.11.17-preview+${"verylongreleasemetadata".repeat(7)}`;
  vi.mocked(desktopApi.assessPortIntents).mockResolvedValue(assessedUpdate("b", version));
  await root.rerender(
    <div id="narrow-ready-notices" className="grid" style={{ width: 320 }}>
      <ReadyGameNotices generation={1} ports={longPorts} onOpenPort={vi.fn()} />
    </div>,
  );
  await act(async () => {});
  const frame = document.getElementById("narrow-ready-notices")!;
  expect(frame.textContent).toContain(version);
  expect(frame.scrollWidth).toBeLessThanOrEqual(frame.clientWidth + 1);
});

it("keeps an out-of-page notice until another surface acknowledges its plan", async () => {
  const assess = vi.mocked(desktopApi.assessPortIntents);
  assess.mockResolvedValueOnce({
    ...assessed,
    not_assessed: 1,
    assessments: assessed.assessments.slice(0, 1),
  });
  assess.mockResolvedValue({
    ...assessed,
    not_assessed: 1,
    assessments: assessed.assessments.slice(1),
  });
  const intents = vi
    .spyOn(desktopApi, "portIntents")
    .mockResolvedValueOnce([
      { format_version: 1, port_id: "new-game", mode: "notify", updated_at: 1 },
    ])
    .mockResolvedValue([
      {
        format_version: 1,
        port_id: "new-game",
        mode: "notify",
        updated_at: 2,
        acknowledged_plan_sha256: "a".repeat(64),
      },
    ]);
  await root.rerender(<ReadyGameNotices generation={1} ports={ports} />);
  await expect.poll(text).toContain("New Game is ready to install.");
  await act(async () => announceReadyNoticePreferenceChange());
  await expect.poll(text).toContain("Old Game has an update available");
  expect(text()).toContain("New Game is ready to install.");
  await act(async () => announceReadyNoticePreferenceChange());
  await expect.poll(text).not.toContain("New Game is ready to install.");
  expect(intents).toHaveBeenCalledWith(1);
});
