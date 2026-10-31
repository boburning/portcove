import { page } from "vite-plus/test/browser";
import { captureParityState } from "../../../test/parity-capture";
import { controlledAct as act } from "../../../test/controlled-react-act";
import { render as renderComponent, cleanup, type RenderResult } from "vitest-browser-react";
import { useEffect } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { desktopApi } from "../../api";
import { failureReport } from "../../test-fixtures";
import type {
  ApplicationUpdateCheckResult,
  ApplicationUpdateManualCheckResult,
  ApplicationUpdateNoticeSnapshot,
  ApplicationUpdatePreferences,
  ApplicationUpdateStatus,
} from "../../types";
import { ApplicationUpdateSettings } from "./ApplicationUpdates";
import { useApplicationUpdateChoice } from "./use-application-update";
import { focusApplicationUpdateRoute } from "./focus-application-update-route";
import { useOperationState } from "../operations/use-operation-state";
import { targetInvocationContext } from "../operations/invocation-state";

vi.mock("../../desktop-events", () => ({ listenDesktopEvent: async () => () => undefined }));
let sharedOperations!: ReturnType<typeof useOperationState>;
const refreshShared = async () => {};
function OperatingSettingsFixture() {
  const preferencesState = useApplicationUpdateChoice();
  sharedOperations = useOperationState({ refresh: refreshShared, libraryGeneration: 9 });
  return (
    <ApplicationUpdateSettings
      currentVersion="0.1.0-alpha.2"
      generation={9}
      preferencesState={preferencesState}
      perform={sharedOperations.perform}
      disabled={Boolean(sharedOperations.busy)}
    />
  );
}

const missingChoice: ApplicationUpdatePreferences = {
  schema_version: 1,
  revision: 0,
  choice: null,
};

const manualCheck = (
  result: ApplicationUpdateCheckResult,
  checked_channel: "preview" | "stable" = "preview",
): ApplicationUpdateManualCheckResult => ({ checked_channel, result });

const savedChoice: ApplicationUpdatePreferences = {
  schema_version: 1,
  revision: 4,
  choice: { channel: "preview", mode: "notify-only", paused: false },
};

const idleStatus: ApplicationUpdateStatus = {
  schedule: {
    last_success_unix_seconds: null,
    consecutive_failures: 0,
    next_automatic_check_unix_seconds: null,
  },
  staged: null,
  apply: null,
  install_eligibility: "eligible",
  recovery_required: [],
};

function SettingsFixture({
  automaticNotice,
  onPreferencesChanged,
  generation,
  visible = true,
  currentVersion = "0.1.0-alpha.2",
  disabled = false,
}: {
  automaticNotice?: ApplicationUpdateNoticeSnapshot["notice"] | undefined;
  onPreferencesChanged?: ((preferences: ApplicationUpdatePreferences) => void) | undefined;
  generation?: number;
  visible?: boolean;
  currentVersion?: string;
  disabled?: boolean;
}) {
  const state = useApplicationUpdateChoice();
  useEffect(() => {
    if (state.preferences) onPreferencesChanged?.(state.preferences);
  }, [state.preferences, onPreferencesChanged]);
  return (
    <>
      <output data-preference-revision={state.preferences?.revision} />
      {visible && (
        <ApplicationUpdateSettings
          currentVersion={currentVersion}
          disabled={disabled}
          generation={generation}
          automaticNotice={automaticNotice}
          preferencesState={state}
        />
      )}
    </>
  );
}

describe("ApplicationUpdateSettings", () => {
  let root: RenderResult;
  let host: HTMLDivElement;

  beforeEach(async () => {
    host = document.createElement("div");
    document.body.append(host);
    root = await renderComponent(null, { container: document.body.appendChild(host) });
    vi.spyOn(desktopApi, "applicationUpdateStatus").mockResolvedValue(idleStatus);
  });

  afterEach(async () => {
    await cleanup();
    host.remove();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  const button = (label: string) => {
    const scope =
      label === "Stable" || label === "Preview"
        ? host.querySelector('[aria-label="Application update channel"]')!
        : host;
    const match = [...scope.querySelectorAll<HTMLButtonElement>("button")].find((item) =>
      item.textContent?.includes(label),
    );
    expect(match, `button containing ${label}`).toBeDefined();
    return match!;
  };

  const click = async (label: string) => {
    await act(async () => button(label).click());
  };

  const render = async (
    automaticNotice?: ApplicationUpdateNoticeSnapshot["notice"],
    onPreferencesChanged?: (preferences: ApplicationUpdatePreferences) => void,
  ) => {
    await root.rerender(
      <SettingsFixture
        automaticNotice={automaticNotice}
        onPreferencesChanged={onPreferencesChanged}
      />,
    );
  };

  it.each([true, false])(
    "enters available update choices only while their pending heading still owns focus: %s",
    async (retainHeadingFocus) => {
      vi.spyOn(desktopApi, "applicationUpdatePreferences").mockResolvedValue(missingChoice);
      await root.rerender(<SettingsFixture disabled />);
      focusApplicationUpdateRoute("choice");
      expect(document.activeElement?.id).toBe("application-preferences-title");
      const other = document.createElement("button");
      other.textContent = "Another destination";
      host.append(other);
      if (!retainHeadingFocus) other.focus();

      await root.rerender(<SettingsFixture disabled={false} />);

      expect(document.activeElement).toBe(retainHeadingFocus ? button("Preview") : other);
    },
  );

  it("stores an explicit draft without starting update work", async () => {
    vi.spyOn(desktopApi, "applicationUpdatePreferences").mockResolvedValue(missingChoice);
    const save = vi.spyOn(desktopApi, "setApplicationUpdatePreferences").mockResolvedValue({
      schema_version: 1,
      revision: 1,
      choice: { channel: "stable", mode: "manual", paused: true },
    });
    const reset = vi.spyOn(desktopApi, "resetApplicationUpdatePreferences");

    const changed = vi.fn();
    await render(undefined, changed);
    expect(changed).toHaveBeenLastCalledWith(missingChoice);
    expect(host.textContent).toContain("Automatic checks remain off until you save one.");
    expect(host.textContent).toContain("Current version 0.1.0-alpha.2");
    expect(button("Preview").getAttribute("data-variant")).toBe("selected");
    expect(button("Stable").getAttribute("data-variant")).toBe("ghost");
    expect(button("Automatic").getAttribute("data-variant")).toBe("selected");
    expect(button("Notify only").getAttribute("data-variant")).toBe("ghost");
    expect(button("Manual").getAttribute("data-variant")).toBe("ghost");

    await click("Stable");
    await click("Manual");
    const pause = host.querySelector<HTMLInputElement>('input[type="checkbox"]')!;
    await act(async () => pause.click());
    expect(save).not.toHaveBeenCalled();
    expect(reset).not.toHaveBeenCalled();
    await captureParityState("application-update-unsaved-draft-fixture");

    await click("Save application update settings");
    expect(save).toHaveBeenCalledExactlyOnceWith(0, {
      channel: "stable",
      mode: "manual",
      paused: true,
    });
    expect(changed).toHaveBeenLastCalledWith({
      schema_version: 1,
      revision: 1,
      choice: { channel: "stable", mode: "manual", paused: true },
    });
    expect(host.querySelector('[role="status"]')?.textContent).toContain(
      "Saving these settings does not start an update.",
    );
    expect(button("Save application update settings").disabled).toBe(true);
    expect(button("Save application update settings").getAttribute("data-variant")).toBe("primary");
    expect(button("Discard changes").getAttribute("data-variant")).toBe("outline");
    expect(button("Reset update preferences").getAttribute("data-variant")).toBe("destructive");
  });

  it("shares the startup read with Settings and publishes saves to the global owner", async () => {
    const read = vi
      .spyOn(desktopApi, "applicationUpdatePreferences")
      .mockResolvedValue(savedChoice);
    vi.spyOn(desktopApi, "setApplicationUpdatePreferences").mockResolvedValue({
      ...savedChoice,
      revision: 5,
      choice: { channel: "stable", mode: "manual", paused: false },
    });
    await render();
    expect(read).toHaveBeenCalledTimes(1);
    expect(host.querySelector("output")?.getAttribute("data-preference-revision")).toBe("4");
    await click("Stable");
    expect(button("Check for updates").disabled).toBe(false);
    await click("Save application update settings");
    expect(read).toHaveBeenCalledTimes(1);
    expect(host.querySelector("output")?.getAttribute("data-preference-revision")).toBe("5");
  });

  it("refreshes external changes on Settings re-entry through the same owner", async () => {
    const read = vi
      .spyOn(desktopApi, "applicationUpdatePreferences")
      .mockResolvedValueOnce(savedChoice)
      .mockResolvedValueOnce({
        ...savedChoice,
        revision: 6,
        choice: { channel: "stable", mode: "manual", paused: false },
      });
    await render();
    await root.rerender(<SettingsFixture visible={false} />);
    expect(read).toHaveBeenCalledTimes(1);
    await render();
    expect(read).toHaveBeenCalledTimes(2);
    expect(host.querySelector("output")?.getAttribute("data-preference-revision")).toBe("6");
    expect(button("Stable").getAttribute("aria-pressed")).toBe("true");
    expect(button("Manual").getAttribute("aria-pressed")).toBe("true");
  });

  it("replaces cached consent after malformed-state recovery restarts the revision", async () => {
    vi.spyOn(desktopApi, "applicationUpdatePreferences")
      .mockResolvedValueOnce(savedChoice)
      .mockRejectedValueOnce({ code: "state", message: "Malformed preferences" });
    const recover = vi
      .spyOn(desktopApi, "recoverApplicationUpdatePreferences")
      .mockResolvedValue({ ...missingChoice, revision: 1 });
    const save = vi.spyOn(desktopApi, "setApplicationUpdatePreferences").mockResolvedValue({
      ...savedChoice,
      revision: 2,
    });
    await render();
    await root.rerender(<SettingsFixture visible={false} />);
    await render();
    await click("Reset update settings");
    expect(recover).toHaveBeenCalledOnce();
    expect(host.querySelector("output")?.getAttribute("data-preference-revision")).toBe("1");
    expect(host.textContent).toContain("Automatic checks remain off until you save one.");
    await click("Manual");
    await click("Save application update settings");
    expect(save).toHaveBeenCalledExactlyOnceWith(1, {
      channel: "preview",
      mode: "manual",
      paused: false,
    });
  });

  it("discards unsaved changes and clears consent only through explicit actions", async () => {
    vi.spyOn(desktopApi, "applicationUpdatePreferences").mockResolvedValue(savedChoice);
    const save = vi.spyOn(desktopApi, "setApplicationUpdatePreferences");
    const reset = vi
      .spyOn(desktopApi, "resetApplicationUpdatePreferences")
      .mockResolvedValue({ ...missingChoice, revision: 5 });

    await render();
    await click("Stable");
    await click("Automatic");
    await click("Discard changes");
    expect(save).not.toHaveBeenCalled();
    expect(
      host.querySelector<HTMLButtonElement>(
        '[aria-label="Application update channel"] button[aria-pressed="true"]',
      )?.textContent,
    ).toBe("Preview");
    expect(
      host.querySelector<HTMLButtonElement>(
        '[aria-label="Application update mode"] button[aria-pressed="true"]',
      )?.textContent,
    ).toBe("Notify only");

    await click("Reset update preferences");
    expect(reset).toHaveBeenCalledOnce();
    expect(host.textContent).toContain("Update preferences reset.");
    expect(host.textContent).toContain("Automatic checks remain off until you save a new choice.");
  });

  it("refreshes a conflicting revision before another save", async () => {
    const current: ApplicationUpdatePreferences = {
      schema_version: 1,
      revision: 7,
      choice: { channel: "stable", mode: "manual", paused: true },
    };
    vi.spyOn(desktopApi, "applicationUpdatePreferences")
      .mockResolvedValueOnce(savedChoice)
      .mockResolvedValueOnce(current);
    const save = vi
      .spyOn(desktopApi, "setApplicationUpdatePreferences")
      .mockRejectedValueOnce({
        code: "conflict",
        message: "Application update preferences changed from revision 4 to 7",
      })
      .mockResolvedValue({
        ...current,
        revision: 8,
        choice: { channel: "preview", mode: "manual", paused: true },
      });

    await render();
    await click("Stable");
    await click("Save application update settings");
    expect(host.querySelector('[role="alert"]')?.textContent).toContain(
      "Current settings were refreshed; review them before saving again.",
    );
    expect(
      host.querySelector<HTMLButtonElement>(
        '[aria-label="Application update mode"] button[aria-pressed="true"]',
      )?.textContent,
    ).toBe("Manual");
    await captureParityState("application-update-preference-conflict-fixture");

    await click("Preview");
    await click("Save application update settings");
    expect(save).toHaveBeenLastCalledWith(7, {
      channel: "preview",
      mode: "manual",
      paused: true,
    });
  });

  it("offers an accessible retry after an offline load failure", async () => {
    vi.spyOn(desktopApi, "applicationUpdatePreferences")
      .mockRejectedValueOnce({ code: "offline", message: "Update settings are unavailable" })
      .mockResolvedValueOnce(savedChoice);

    await render();
    expect(host.querySelector('[role="alert"]')?.textContent).toBe(
      "Update settings are unavailable",
    );
    const retry = button("Retry loading settings");
    expect(retry.hasAttribute("data-focusable")).toBe(true);
    expect(host.textContent).not.toContain("Reset update settings");

    await click("Retry loading settings");
    expect(host.querySelector('[role="alert"]')).toBeNull();
    expect(host.querySelector('[aria-label="Application update channel"]')).not.toBeNull();
    // Base UI's hidden form inputs never enter the application focus inventory.
    for (const control of host.querySelectorAll<HTMLInputElement>('input[aria-hidden="true"]')) {
      expect(control.tabIndex).toBe(-1);
    }
    const controls = [
      ...host.querySelectorAll<HTMLElement>('button, input, [role="checkbox"]'),
    ].filter((control) => !control.matches('input[aria-hidden="true"]'));
    for (const control of controls) {
      expect(control.hasAttribute("data-focusable")).toBe(true);
    }
    for (const control of controls.filter(
      (item) => !item.matches(':disabled, [aria-disabled="true"]'),
    )) {
      expect(control.tabIndex).toBeGreaterThanOrEqual(0);
      control.focus();
      expect(document.activeElement).toBe(control);
    }
  });

  it("checks metadata without downloading under saved automatic settings", async () => {
    vi.spyOn(desktopApi, "applicationUpdatePreferences").mockResolvedValue({
      ...savedChoice,
      choice: { channel: "preview", mode: "automatic", paused: false },
    });
    const check = vi.spyOn(desktopApi, "checkApplicationUpdate").mockImplementation((onEvent) => {
      onEvent("checking");
      onEvent("complete");
      return Promise.resolve(
        manualCheck({
          kind: "update-available",
          candidate: { version: "0.2.0-beta.3", channel: "preview", bytes: 25 * 1024 * 1024 },
          reasons: [],
          staged: false,
        }),
      );
    });

    await render();
    await click("Check for updates");

    expect(check).toHaveBeenCalledExactlyOnceWith(expect.any(Function), { channel: "preview" });
    expect(host.textContent).toContain("Its download has not started.");
    expect(host.textContent).not.toContain("has been downloaded and checked");
    const checkPanel = host.querySelector('[aria-labelledby="application-check-title"]');
    expect(checkPanel?.textContent).toMatch(/trusted release metadata/iu);
    expect(checkPanel?.textContent).toContain("does not download or install Portcove");
    expect(desktopApi.applicationUpdateStatus).toHaveBeenCalledTimes(1);
  });

  it.each([
    missingChoice,
    {
      ...savedChoice,
      choice: { channel: "preview" as const, mode: "automatic" as const, paused: true },
    },
  ])("checks a one-time channel without saving missing or paused choices", async (preferences) => {
    vi.spyOn(desktopApi, "applicationUpdatePreferences").mockResolvedValue(preferences);
    const save = vi.spyOn(desktopApi, "setApplicationUpdatePreferences");
    const download = vi.spyOn(desktopApi, "downloadApplicationUpdate");
    const check = vi
      .spyOn(desktopApi, "checkApplicationUpdate")
      .mockImplementation(async (_onEvent, request) => {
        const channel = request?.channel ?? "preview";
        return manualCheck(
          {
            kind: "update-available",
            candidate: { version: "1.0.0", channel, bytes: 42 },
            reasons: [],
            staged: false,
          },
          channel,
        );
      });
    await render();
    await click("Stable"); // An unsaved automatic-update draft is independent.
    const selector = host.querySelector('[aria-label="One-time update channel"]')!;
    expect(selector.querySelector('[aria-pressed="true"]')?.textContent).toContain("Preview");
    await act(async () =>
      [...selector.querySelectorAll("button")]
        .find((item) => item.textContent?.includes("Stable"))!
        .click(),
    );
    expect(button("Check for updates").disabled).toBe(false);
    await click("Check for updates");
    expect(check).toHaveBeenCalledExactlyOnceWith(expect.any(Function), { channel: "stable" });
    expect(host.textContent).toContain("One-time check · Stable");
    expect(button("Download and verify update").disabled).toBe(true);
    expect(save).not.toHaveBeenCalled();
    expect(download).not.toHaveBeenCalled();
  });

  it("invalidates a one-time result when its selector changes away and back", async () => {
    vi.spyOn(desktopApi, "applicationUpdatePreferences").mockResolvedValue(savedChoice);
    const check = vi.spyOn(desktopApi, "checkApplicationUpdate").mockResolvedValue(
      manualCheck({
        kind: "update-available",
        candidate: { version: "0.2.0-beta.9", channel: "preview", bytes: 42 },
        reasons: [],
        staged: false,
      }),
    );
    await render();
    await click("Check for updates");
    expect(host.textContent).toContain("0.2.0-beta.9");
    const selector = host.querySelector('[aria-label="One-time update channel"]')!;
    for (const label of ["Stable", "Preview"]) {
      await act(async () =>
        [...selector.querySelectorAll("button")]
          .find((item) => item.textContent?.includes(label))!
          .click(),
      );
      expect(host.textContent).not.toContain("0.2.0-beta.9");
    }
    expect(check).toHaveBeenCalledOnce();
  });

  it.each([
    ["stable", "preview", false, "returned a different channel"],
    ["preview", "stable", false, "returned a different channel"],
    ["preview", "preview", true, "unexpected download result"],
  ] as const)(
    "rejects inconsistent one-time result %s/%s/staged:%s",
    async (checkedChannel, candidateChannel, staged, message) => {
      vi.spyOn(desktopApi, "applicationUpdatePreferences").mockResolvedValue(savedChoice);
      vi.spyOn(desktopApi, "checkApplicationUpdate").mockResolvedValue(
        manualCheck(
          {
            kind: "update-available",
            candidate: { version: "1.0.0", channel: candidateChannel, bytes: 42 },
            reasons: [],
            staged,
          },
          checkedChannel,
        ),
      );
      const download = vi.spyOn(desktopApi, "downloadApplicationUpdate");
      await render();
      await click("Check for updates");
      expect(host.textContent).toContain(message);
      expect(host.textContent).not.toContain("Download and verify update");
      expect(download).not.toHaveBeenCalled();
    },
  );

  it("defaults the one-time selector to Stable for a production build", async () => {
    vi.spyOn(desktopApi, "applicationUpdatePreferences").mockResolvedValue(missingChoice);
    await root.rerender(<SettingsFixture currentVersion="1.0.0" />);
    const selector = host.querySelector('[aria-label="One-time update channel"]')!;
    expect(selector.querySelector('[aria-pressed="true"]')?.textContent).toContain("Stable");
  });

  it("can check metadata while saved preferences are still loading", async () => {
    let resolvePreferences!: (preferences: ApplicationUpdatePreferences) => void;
    vi.spyOn(desktopApi, "applicationUpdatePreferences").mockImplementation(
      () =>
        new Promise((resolve) => {
          resolvePreferences = resolve;
        }),
    );
    const check = vi
      .spyOn(desktopApi, "checkApplicationUpdate")
      .mockResolvedValue(
        manualCheck({ kind: "no-candidate", candidate: null, reasons: [], staged: false }),
      );
    await render();
    expect(button("Check for updates").disabled).toBe(false);
    await click("Check for updates");
    expect(check).toHaveBeenCalledExactlyOnceWith(expect.any(Function), { channel: "preview" });
    expect(host.textContent).toContain("No eligible release");
    await act(async () => resolvePreferences(savedChoice));
  });

  it.each([
    ["consent-required", "Automatic updates are off", "You can still check once."],
    ["offline", "Couldn't check for updates", "Connect to the internet and try again."],
    ["paused", "Automatic update checks are paused", "Manual checks remain available."],
    ["manual-mode", "Automatic update checks are off", "Use Check for updates"],
    ["metered", "Waiting to check for updates", "unmetered connection"],
    ["metered-state-unknown", "Waiting to check for updates", "cannot confirm"],
    ["startup-delay", "Next automatic check is scheduled for later", "check manually now"],
    ["cadence", "Next automatic check is scheduled for later", "check manually now"],
    ["superseded", "Update check not completed", "choice changed"],
    ["current", "Update check complete", "Portcove is current"],
    ["held", "Update check complete", "No update can be offered on this channel"],
    ["incompatible", "Update check complete", "not compatible"],
    ["no-candidate", "Update check complete", "No eligible release"],
  ] as const)(
    "presents %s without claiming an unperformed check completed",
    async (kind, title, description) => {
      vi.spyOn(desktopApi, "applicationUpdatePreferences").mockResolvedValue(savedChoice);
      const result: ApplicationUpdateCheckResult = {
        kind,
        candidate: null,
        reasons: [],
        staged: false,
      };
      await render({ preference_revision: savedChoice.revision, result });
      const check = host.querySelector('.application-update-status-item[role="status"]');
      expect(check?.querySelector("strong")?.textContent).toBe(title);
      expect(check?.textContent).toContain(description);
    },
  );

  it("does not call an older held candidate eligible or policy-blocked", async () => {
    vi.spyOn(desktopApi, "applicationUpdatePreferences").mockResolvedValue(savedChoice);
    const result: ApplicationUpdateCheckResult = {
      kind: "held",
      candidate: { version: "0.1.0-alpha.1", channel: "stable", bytes: 25 * 1024 * 1024 },
      reasons: ["channel has no compatible non-older version"],
      staged: false,
    };
    await render({ preference_revision: savedChoice.revision, result });
    const check = host.querySelector('.application-update-status-item[role="status"]');
    expect(check?.textContent).toContain("No update can be offered on this channel.");
    expect(check?.textContent).toContain("channel has no compatible non-older version");
    expect(check?.textContent).not.toContain("eligible update");
    expect(check?.textContent).not.toContain("signed release policy");
  });

  it("downloads only the checked candidate through an explicit host-owned action", async () => {
    vi.spyOn(desktopApi, "applicationUpdatePreferences").mockResolvedValue(savedChoice);
    const candidate = {
      version: "0.2.0-beta.3",
      channel: "preview" as const,
      bytes: 25 * 1024 * 1024,
    };
    vi.spyOn(desktopApi, "checkApplicationUpdate").mockResolvedValue(
      manualCheck({
        kind: "update-available",
        candidate,
        reasons: [],
        staged: false,
      }),
    );
    const download = vi
      .spyOn(desktopApi, "downloadApplicationUpdate")
      .mockImplementation((_request, onEvent) => {
        onEvent("checking");
        onEvent("acquiring-and-verifying");
        onEvent("staged");
        return Promise.resolve({
          kind: "update-available",
          candidate,
          reasons: [],
          staged: true,
        });
      });

    await render();
    await click("Check for updates");
    expect(host.textContent).toContain("Its download has not started.");
    await captureParityState("application-update-download-consent-fixture");

    await click("Download and verify update");

    expect(download).toHaveBeenCalledExactlyOnceWith(
      {
        expected_preference_revision: 4,
        expected_candidate: candidate,
      },
      expect.any(Function),
    );
    expect(host.textContent).toContain("Portcove 0.2.0-beta.3 has been downloaded and checked");
    await captureParityState("application-update-download-receipt-fixture");
  });

  it("uses a revision-bound automatic result without repeating its check", async () => {
    vi.spyOn(desktopApi, "applicationUpdatePreferences").mockResolvedValue(savedChoice);
    const check = vi.spyOn(desktopApi, "checkApplicationUpdate");
    const candidate = {
      version: "0.2.0-beta.3",
      channel: "preview" as const,
      bytes: 25 * 1024 * 1024,
    };
    const download = vi.spyOn(desktopApi, "downloadApplicationUpdate").mockResolvedValue({
      kind: "update-available",
      candidate,
      reasons: [],
      staged: true,
    });

    await render({
      preference_revision: 4,
      result: { kind: "update-available", candidate, reasons: [], staged: false },
    });
    expect(host.textContent).toContain("Its download has not started.");
    expect(check).not.toHaveBeenCalled();

    await click("Download and verify update");
    expect(download).toHaveBeenCalledExactlyOnceWith(
      {
        expected_preference_revision: 4,
        expected_candidate: candidate,
      },
      expect.any(Function),
    );
  });

  it("does not let a stale automatic result hide a current manual result", async () => {
    vi.spyOn(desktopApi, "applicationUpdatePreferences").mockResolvedValue(savedChoice);
    const currentCandidate = {
      version: "0.2.0-beta.4",
      channel: "preview" as const,
      bytes: 26 * 1024 * 1024,
    };
    vi.spyOn(desktopApi, "checkApplicationUpdate").mockResolvedValue(
      manualCheck({
        kind: "update-available",
        candidate: currentCandidate,
        reasons: [],
        staged: false,
      }),
    );

    await render({
      preference_revision: 3,
      result: {
        kind: "update-available",
        candidate: { ...currentCandidate, version: "0.2.0-beta.2" },
        reasons: [],
        staged: false,
      },
    });
    expect(host.textContent).not.toContain("0.2.0-beta.2");

    await click("Check for updates");
    expect(host.textContent).toContain("0.2.0-beta.4");
    expect(button("Download and verify update")).toBeDefined();
  });

  it("retains a one-time result but refuses a cross-channel download after settings change", async () => {
    vi.spyOn(desktopApi, "applicationUpdatePreferences").mockResolvedValue(savedChoice);
    vi.spyOn(desktopApi, "checkApplicationUpdate").mockResolvedValue(
      manualCheck({
        kind: "update-available",
        candidate: {
          version: "0.2.0-beta.3",
          channel: "preview",
          bytes: 25 * 1024 * 1024,
        },
        reasons: [],
        staged: false,
      }),
    );
    vi.spyOn(desktopApi, "setApplicationUpdatePreferences").mockResolvedValue({
      ...savedChoice,
      revision: 5,
      choice: { channel: "stable", mode: "notify-only", paused: false },
    });
    const download = vi.spyOn(desktopApi, "downloadApplicationUpdate");

    await render();
    await click("Check for updates");
    expect(button("Download and verify update")).toBeDefined();

    await click("Stable");
    await click("Save application update settings");

    expect(button("Download and verify update").disabled).toBe(true);
    expect(host.textContent).toContain("0.2.0-beta.3");
    expect(host.textContent).toContain(
      "Save Preview as your update channel before downloading this result.",
    );
    expect(download).not.toHaveBeenCalled();
  });

  it("keeps Save disabled when the ordinary Stable Manual choice is already saved", async () => {
    vi.spyOn(desktopApi, "applicationUpdatePreferences").mockResolvedValue({
      ...savedChoice,
      choice: { channel: "stable", mode: "manual", paused: false },
    });
    const save = vi.spyOn(desktopApi, "setApplicationUpdatePreferences");
    await root.rerender(<OperatingSettingsFixture />);
    expect(button("Save application update settings").disabled).toBe(true);
    await click("Stable");
    await click("Manual");
    expect(button("Save application update settings").disabled).toBe(true);
    expect(save).not.toHaveBeenCalled();
  });

  it("retains the backend reachability failure through shared task settlement and retries normally", async () => {
    vi.spyOn(desktopApi, "applicationUpdatePreferences").mockResolvedValue(savedChoice);
    const failure = failureReport();
    failure.code = "network";
    failure.message =
      "The application update service could not be reached. Check the connection and try again.";
    failure.presentation = {
      ...failure.presentation,
      presentation_key: "connection_failed",
      summary: "The online request could not be completed.",
      technical_message: failure.message,
    };
    const check = vi
      .spyOn(desktopApi, "checkApplicationUpdate")
      .mockRejectedValueOnce(failure)
      .mockResolvedValueOnce(
        manualCheck({ kind: "no-candidate", candidate: null, reasons: [], staged: false }),
      );
    const save = vi.spyOn(desktopApi, "setApplicationUpdatePreferences");
    await root.rerender(<OperatingSettingsFixture />);
    await click("Check for updates");
    expect(
      host.querySelector('[aria-labelledby="application-check-title"] [role="alert"]')?.textContent,
    ).toBe(failure.presentation.summary);
    const failed = [...sharedOperations.invocations.values()].at(-1)!;
    expect(failed.phase).toBe("settled");
    expect(failed.outcome).toBe("failed");
    expect(failed.failure).toBe(failure);
    expect(host.textContent).not.toContain("The request did not complete");
    await captureParityState("application-update-offline-fixture");
    await click("Check for updates");
    expect(check).toHaveBeenCalledTimes(2);
    expect(host.textContent).toContain(
      "No eligible release is published for the selected channel.",
    );
    expect([...sharedOperations.invocations.values()].at(-1)?.outcome).toBe("succeeded");
    expect(save).not.toHaveBeenCalled();
  });

  it("offers cancellation while a check is active", async () => {
    vi.spyOn(desktopApi, "applicationUpdatePreferences").mockResolvedValue(savedChoice);
    let rejectCheck!: (reason: unknown) => void;
    vi.spyOn(desktopApi, "checkApplicationUpdate").mockImplementation(
      () =>
        new Promise((_resolve, reject) => {
          rejectCheck = reject;
        }),
    );
    const cancel = vi.spyOn(desktopApi, "cancelApplicationUpdateCheck").mockResolvedValue(true);

    await render();
    await act(async () => button("Check for updates").click());
    expect(button("Cancel check").hasAttribute("data-focusable")).toBe(true);
    await captureParityState("application-update-checking-fixture");
    for (const control of host.querySelectorAll<HTMLButtonElement>(
      '[aria-label="One-time update channel"] button',
    )) {
      expect(control.disabled).toBe(true);
    }

    await click("Cancel check");
    expect(cancel).toHaveBeenCalledOnce();
    await act(async () => rejectCheck({ code: "cancelled", message: "Update check cancelled" }));
    expect(host.querySelector('[role="alert"]')?.textContent).toBe("Update check cancelled");
    expect(button("Check for updates")).toBeDefined();
  });

  it("keeps application maintenance exclusive until settlement while cancellation stays available", async () => {
    vi.spyOn(desktopApi, "applicationUpdatePreferences").mockResolvedValue(savedChoice);
    let finish!: (value: ApplicationUpdateManualCheckResult) => void;
    vi.spyOn(desktopApi, "checkApplicationUpdate").mockImplementation(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const cancel = vi.spyOn(desktopApi, "cancelApplicationUpdateCheck").mockResolvedValue(true);
    const gameTask = vi.fn().mockResolvedValue("checked");
    await root.rerender(<OperatingSettingsFixture />);
    await click("Check for updates");
    expect([...sharedOperations.pendingOperations.values()][0]?.context.exclusionScope).toBe(
      "application",
    );
    await act(async () => {
      await sharedOperations.perform("Check game", gameTask, {
        context: targetInvocationContext(
          "Check game",
          { kind: "port", id: "A", label: "Game A" },
          9,
        ),
      });
    });
    expect(gameTask).not.toHaveBeenCalled();
    await click("Cancel check");
    expect(cancel).toHaveBeenCalledOnce();
    expect(sharedOperations.pendingOperations.size).toBe(1);
    await captureParityState("application-update-exclusive-cancellation-fixture");
    await act(async () =>
      finish(manualCheck({ kind: "no-candidate", candidate: null, reasons: [], staged: false })),
    );
    expect(sharedOperations.pendingOperations.size).toBe(0);
    await act(async () => {
      await sharedOperations.perform("Check game", gameTask, {
        context: targetInvocationContext(
          "Check game",
          { kind: "port", id: "A", label: "Game A" },
          9,
        ),
      });
    });
    expect(gameTask).toHaveBeenCalledOnce();
  });

  it("repairs corrupt preferences only through the explicit reset action", async () => {
    vi.spyOn(desktopApi, "applicationUpdatePreferences").mockRejectedValue({
      code: "state",
      message: "Update settings are damaged",
    });
    const reset = vi
      .spyOn(desktopApi, "recoverApplicationUpdatePreferences")
      .mockResolvedValue({ ...missingChoice, revision: 9 });

    await render();
    expect(host.querySelector('[role="alert"]')?.textContent).toBe("Update settings are damaged");
    await click("Reset update settings");

    expect(reset).toHaveBeenCalledOnce();
    expect(host.textContent).toContain("Damaged update settings reset.");
    expect(host.textContent).toContain("automatic application update checks remain off.");
  });

  it("shows sanitized recovery states and repairs only the selected host store", async () => {
    vi.spyOn(desktopApi, "applicationUpdatePreferences").mockResolvedValue(savedChoice);
    vi.mocked(desktopApi.applicationUpdateStatus).mockResolvedValueOnce({
      schedule: null,
      staged: {
        version: "0.2.0-beta.3",
        channel: "preview",
        bytes: 25 * 1024 * 1024,
      },
      apply: {
        revision: 4,
        request: "restart-to-apply",
        termination: null,
        native_launch: null,
      },
      install_eligibility: "eligible",
      recovery_required: [
        {
          area: "schedule",
        },
      ],
    });
    const recover = vi
      .spyOn(desktopApi, "recoverApplicationUpdateState")
      .mockResolvedValue(idleStatus);

    await render();
    expect(host.textContent).toContain("Portcove 0.2.0-beta.3 (Preview");
    expect(host.textContent).toContain("Restart request saved");
    expect(host.textContent).toContain("Update check history needs repair");

    await click("Reset update-check history");
    expect(recover).toHaveBeenCalledExactlyOnceWith("schedule");
    expect(host.textContent).toContain("No verified application update is staged.");
    expect(host.textContent).toContain("Update-check history reset.");
  });

  it.each([
    [
      "staging",
      "Delete damaged update download",
      "Damaged update download deleted. Download the update again.",
    ],
    [
      "apply",
      "Clear pending update request",
      "Pending update request cleared. The verified download remains available.",
    ],
  ] as const)("explains and repairs only %s state", async (area, action, notice) => {
    vi.spyOn(desktopApi, "applicationUpdatePreferences").mockResolvedValue(savedChoice);
    const staged =
      area === "apply"
        ? { version: "0.2.0-beta.3", channel: "preview" as const, bytes: 25 * 1024 * 1024 }
        : null;
    vi.mocked(desktopApi.applicationUpdateStatus).mockResolvedValueOnce({
      ...idleStatus,
      staged,
      recovery_required: [{ area }],
    });
    const recover = vi.spyOn(desktopApi, "recoverApplicationUpdateState").mockResolvedValue({
      ...idleStatus,
      staged,
    });
    await render();
    await click(action);
    expect(recover).toHaveBeenCalledExactlyOnceWith(area);
    expect(host.textContent).toContain(notice);
    expect(host.textContent?.includes("Portcove 0.2.0-beta.3")).toBe(area === "apply");
  });

  it("does not claim a retained download when clearing an empty apply request", async () => {
    vi.spyOn(desktopApi, "applicationUpdatePreferences").mockResolvedValue(savedChoice);
    vi.mocked(desktopApi.applicationUpdateStatus).mockResolvedValueOnce({
      ...idleStatus,
      recovery_required: [{ area: "apply" }],
    });
    vi.spyOn(desktopApi, "recoverApplicationUpdateState").mockResolvedValue(idleStatus);
    await render();
    await click("Clear pending update request");
    expect(host.textContent).toContain("No verified download is currently available.");
    expect(host.textContent).not.toContain("The verified download remains available.");
  });

  it.each([
    ["unavailable", "Use a supported package or the documented manual recovery path."],
    ["not-configured", "Use the documented manual recovery path."],
    ["package-managed-deb", "Update it through the same package source."],
    ["package-managed-rpm", "Update it through the same package source."],
  ] as const)(
    "explains %s ownership before any update is staged",
    async (eligibility, guidance) => {
      vi.spyOn(desktopApi, "applicationUpdatePreferences").mockResolvedValue(savedChoice);
      vi.mocked(desktopApi.applicationUpdateStatus).mockResolvedValue({
        ...idleStatus,
        install_eligibility: eligibility,
      });
      const restart = vi.spyOn(desktopApi, "restartToApplyApplicationUpdate");
      await render();
      expect(host.textContent).toContain(guidance);
      expect(host.textContent).toContain("No verified application update is staged.");
      expect(host.textContent).not.toContain("Restart to update");
      expect(restart).not.toHaveBeenCalled();
    },
  );

  it("restarts only through the explicit staged-update action bound to the current library", async () => {
    vi.spyOn(desktopApi, "applicationUpdatePreferences").mockResolvedValue(savedChoice);
    vi.mocked(desktopApi.applicationUpdateStatus).mockResolvedValueOnce({
      ...idleStatus,
      staged: {
        version: "0.2.0-beta.3",
        channel: "preview",
        bytes: 25 * 1024 * 1024,
      },
    });
    const restart = vi
      .spyOn(desktopApi, "restartToApplyApplicationUpdate")
      .mockResolvedValue(undefined);

    await root.rerender(<SettingsFixture generation={17} />);
    expect(host.textContent).toContain("Update ready to install");
    await captureParityState("application-update-ready-restart-fixture");
    const ready = page.getByText("Update ready to install", { exact: true });
    ready.element().scrollIntoView({ block: "center" });
    await expect.element(ready).toBeVisible();
    const restartButton = button("Restart to update");
    await expect
      .poll(() =>
        [ready.element(), restartButton].every((element) => {
          const bounds = element.getBoundingClientRect();
          return (
            bounds.top >= 0 &&
            bounds.bottom <= innerHeight &&
            bounds.left >= 0 &&
            bounds.right <= innerWidth
          );
        }),
      )
      .toBe(true);
    await captureParityState("application-update-ready-restart-lower-fixture");
    await click("Restart to update");

    expect(restart).toHaveBeenCalledExactlyOnceWith(17);
    expect(host.querySelector('[role="status"]')?.textContent).toContain("Restarting Portcove");
  });

  it("holds a verified download until an update choice is saved", async () => {
    vi.spyOn(desktopApi, "applicationUpdatePreferences").mockResolvedValue(missingChoice);
    vi.mocked(desktopApi.applicationUpdateStatus).mockResolvedValueOnce({
      ...idleStatus,
      staged: { version: "0.2.0-beta.3", channel: "preview", bytes: 25 * 1024 * 1024 },
    });
    await render();
    expect(host.textContent).toContain("Verified update downloaded");
    expect(host.textContent).toContain("Save your update settings before restarting to update.");
    expect(button("Restart to update").disabled).toBe(true);
    await captureParityState("application-update-choice-required-fixture");
    expect(host.textContent).not.toContain("Update ready to install");
  });

  it.each([
    ["package-managed-deb", "DEB installation is managed by its package manager"],
    ["package-managed-rpm", "RPM installation is managed by its package manager"],
    ["not-configured", "Application updating is not configured in this build"],
    ["unavailable", "cannot use Portcove's built-in updater"],
  ] as const)(
    "keeps %s package restrictions visible without offering restart",
    async (install_eligibility, guidance) => {
      vi.spyOn(desktopApi, "applicationUpdatePreferences").mockResolvedValue(savedChoice);
      vi.mocked(desktopApi.applicationUpdateStatus).mockResolvedValueOnce({
        ...idleStatus,
        install_eligibility,
        staged: { version: "0.2.0-beta.3", channel: "preview", bytes: 25 * 1024 * 1024 },
      });
      await render();
      expect(host.textContent).toContain("Verified update downloaded");
      expect(host.textContent).toContain(guidance);
      expect(host.textContent).not.toContain("Update ready to install");
      expect(
        [...host.querySelectorAll("button")].some((item) =>
          item.textContent?.includes("Restart to update"),
        ),
      ).toBe(false);
    },
  );

  it.each(["failed", "installer-failed"] as const)(
    "offers an actual retry for a verified %s installer outcome",
    async (native_launch) => {
      vi.spyOn(desktopApi, "applicationUpdatePreferences").mockResolvedValue(savedChoice);
      vi.mocked(desktopApi.applicationUpdateStatus).mockResolvedValueOnce({
        ...idleStatus,
        staged: { version: "0.2.0-beta.3", channel: "preview", bytes: 25 * 1024 * 1024 },
        apply: {
          revision: 7,
          request: "restart-to-apply",
          termination: "restart-to-apply",
          native_launch,
        },
      });
      await render();
      expect(host.textContent).toContain("Try Restart to update again.");
      expect(button("Retry restart to update").disabled).toBe(false);
    },
  );

  it.each([
    ["starting", "Installer start is unconfirmed", "cannot confirm whether the installer started"],
    ["started", "Installer started", "Portcove has not confirmed the update"],
    [
      "failed",
      "Installer didn't start",
      "Refresh update status to review the next available action.",
    ],
    [
      "installer-succeeded",
      "Installer reported success",
      "Reopen Portcove to confirm the installed version and application health",
    ],
    [
      "installer-failed",
      "Installer did not complete",
      "Refresh update status to review the next available action.",
    ],
  ] as const)("explains the %s native launch state", async (native_launch, title, detail) => {
    vi.spyOn(desktopApi, "applicationUpdatePreferences").mockResolvedValue(savedChoice);
    vi.mocked(desktopApi.applicationUpdateStatus).mockResolvedValueOnce({
      ...idleStatus,
      apply: {
        revision: 7,
        request: "restart-to-apply",
        termination: "restart-to-apply",
        native_launch,
      },
    });

    await render();

    expect(host.textContent).toContain(title);
    expect(host.textContent).toContain(detail);
  });
});
