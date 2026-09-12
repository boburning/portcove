// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { desktopApi } from "../api";
import type {
  ApplicationUpdateNoticeSnapshot,
  ApplicationUpdatePreferences,
  ApplicationUpdateStatus,
} from "../types";
import { ApplicationUpdateSettings } from "./ApplicationUpdates";

const missingChoice: ApplicationUpdatePreferences = {
  schema_version: 1,
  revision: 0,
  choice: null,
};

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
  recovery_required: [],
};

describe("ApplicationUpdateSettings", () => {
  let root: Root;
  let host: HTMLDivElement;

  beforeEach(() => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
    vi.spyOn(desktopApi, "applicationUpdateStatus").mockResolvedValue(idleStatus);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    host.remove();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  const button = (label: string) => {
    const match = [...host.querySelectorAll<HTMLButtonElement>("button")].find((item) =>
      item.textContent?.includes(label),
    );
    expect(match, `button containing ${label}`).toBeDefined();
    return match!;
  };

  const click = async (label: string) => {
    await act(async () => button(label).click());
  };

  const render = async (automaticNotice?: ApplicationUpdateNoticeSnapshot["notice"]) => {
    await act(async () =>
      root.render(
        <ApplicationUpdateSettings
          currentVersion="0.1.0-alpha.2"
          automaticNotice={automaticNotice}
        />,
      ),
    );
  };

  it("stores an explicit draft without starting update work", async () => {
    vi.spyOn(desktopApi, "applicationUpdatePreferences").mockResolvedValue(missingChoice);
    const save = vi.spyOn(desktopApi, "setApplicationUpdatePreferences").mockResolvedValue({
      schema_version: 1,
      revision: 1,
      choice: { channel: "stable", mode: "manual", paused: true },
    });
    const reset = vi.spyOn(desktopApi, "resetApplicationUpdatePreferences");

    await render();
    expect(host.textContent).toContain("Automatic checks remain off until you save one.");
    expect(host.textContent).toContain("Current version 0.1.0-alpha.2");

    await click("Stable");
    await click("Manual");
    const pause = host.querySelector<HTMLInputElement>('input[type="checkbox"]')!;
    await act(async () => pause.click());
    expect(save).not.toHaveBeenCalled();
    expect(reset).not.toHaveBeenCalled();

    await click("Save application update settings");
    expect(save).toHaveBeenCalledExactlyOnceWith(0, {
      channel: "stable",
      mode: "manual",
      paused: true,
    });
    expect(host.querySelector('[role="status"]')?.textContent).toContain(
      "No update check, download, install, or restart was started.",
    );
    expect(button("Save application update settings").disabled).toBe(true);
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

    await click("Clear saved choice");
    expect(reset).toHaveBeenCalledOnce();
    expect(host.textContent).toContain("Saved choice cleared.");
    expect(host.textContent).toContain("Automatic application update checks remain off.");
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
    for (const control of host.querySelectorAll("button, input")) {
      expect(control.hasAttribute("data-focusable")).toBe(true);
    }
  });

  it("runs one host-owned check and reports verified staging progress", async () => {
    vi.spyOn(desktopApi, "applicationUpdatePreferences").mockResolvedValue({
      ...savedChoice,
      choice: { channel: "preview", mode: "automatic", paused: false },
    });
    const check = vi.spyOn(desktopApi, "checkApplicationUpdate").mockImplementation((onEvent) => {
      onEvent("checking");
      onEvent("acquiring-and-verifying");
      onEvent("staged");
      return Promise.resolve({
        kind: "update-available",
        candidate: { version: "0.2.0-beta.3", channel: "preview", bytes: 25 * 1024 * 1024 },
        reasons: [],
        staged: true,
      });
    });

    await render();
    await click("Check for updates");

    expect(check).toHaveBeenCalledOnce();
    expect(host.textContent).toContain("0.2.0-beta.3 is verified and staged");
    expect(host.textContent).toContain("Manual checks never use a URL supplied by this screen.");
  });

  it("downloads only the checked candidate through an explicit host-owned action", async () => {
    vi.spyOn(desktopApi, "applicationUpdatePreferences").mockResolvedValue(savedChoice);
    const candidate = {
      version: "0.2.0-beta.3",
      channel: "preview" as const,
      bytes: 25 * 1024 * 1024,
    };
    vi.spyOn(desktopApi, "checkApplicationUpdate").mockResolvedValue({
      kind: "update-available",
      candidate,
      reasons: [],
      staged: false,
    });
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

    await click("Download and verify update");

    expect(download).toHaveBeenCalledExactlyOnceWith(
      {
        expected_preference_revision: 4,
        expected_candidate: candidate,
      },
      expect.any(Function),
    );
    expect(host.textContent).toContain("0.2.0-beta.3 is verified and staged");
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
    vi.spyOn(desktopApi, "checkApplicationUpdate").mockResolvedValue({
      kind: "update-available",
      candidate: currentCandidate,
      reasons: [],
      staged: false,
    });

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

  it("requires a fresh check after the saved update choice changes", async () => {
    vi.spyOn(desktopApi, "applicationUpdatePreferences").mockResolvedValue(savedChoice);
    vi.spyOn(desktopApi, "checkApplicationUpdate").mockResolvedValue({
      kind: "update-available",
      candidate: {
        version: "0.2.0-beta.3",
        channel: "preview",
        bytes: 25 * 1024 * 1024,
      },
      reasons: [],
      staged: false,
    });
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

    expect(host.textContent).not.toContain("Download and verify update");
    expect(host.textContent).not.toContain("0.2.0-beta.3");
    expect(download).not.toHaveBeenCalled();
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

    await click("Cancel check");
    expect(cancel).toHaveBeenCalledOnce();
    await act(async () => rejectCheck({ code: "cancelled", message: "Update check cancelled" }));
    expect(host.querySelector('[role="alert"]')?.textContent).toBe("Update check cancelled");
    expect(button("Check for updates")).toBeDefined();
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
    expect(host.textContent).toContain("Preview version 0.2.0-beta.3");
    expect(host.textContent).toContain("Restart to update requested");
    expect(host.textContent).toContain("Update check history needs repair");

    await click("Repair update check history");
    expect(recover).toHaveBeenCalledExactlyOnceWith("schedule");
    expect(host.textContent).toContain("No verified application update is staged.");
    expect(host.textContent).toContain("Application update schedule state repaired.");
  });

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

    await act(async () =>
      root.render(<ApplicationUpdateSettings currentVersion="0.1.0-alpha.2" generation={17} />),
    );
    await click("Restart to update");

    expect(restart).toHaveBeenCalledExactlyOnceWith(17);
    expect(host.querySelector('[role="status"]')?.textContent).toContain("Restarting Portcove");
  });

  it.each([
    [
      "starting",
      "Update launch needs confirmation",
      "It needs to check which version is installed before it can safely launch another one.",
    ],
    [
      "started",
      "Installer process started",
      "It needs to check which version is installed before it can safely offer another update action.",
    ],
    [
      "failed",
      "Installer did not start",
      "A retry will still repeat the fresh trust, consent, ownership, compatibility and idle-state checks.",
    ],
    [
      "installer-succeeded",
      "Installer process completed",
      "still needs to confirm the installed version and application health",
    ],
    [
      "installer-failed",
      "Installer process did not complete",
      "A retry will repeat every update safety check.",
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
