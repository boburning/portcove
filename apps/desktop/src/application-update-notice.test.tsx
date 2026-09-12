// @vitest-environment jsdom
import { act, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { listen } from "@tauri-apps/api/event";
import { desktopApi } from "./api";
import { StatusLayer } from "./components/Chrome";
import type { ApplicationUpdateNoticeSnapshot, ApplicationUpdatePreferences } from "./types";
import {
  useApplicationUpdateChoice,
  useApplicationUpdateNotice,
  useApplicationUpdateProductionTransition,
} from "./use-portcove";

vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn().mockResolvedValue(() => {}),
}));

const notice = (revision: number, version: string): ApplicationUpdateNoticeSnapshot => ({
  revision,
  notice: {
    preference_revision: 4,
    result: {
      kind: "update-available",
      candidate: { version, channel: "preview", bytes: 25 * 1024 * 1024 },
      reasons: [],
      staged: false,
    },
  },
});

describe("application update notice", () => {
  let root: Root;
  let host: HTMLDivElement;

  beforeEach(() => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    host.remove();
    vi.restoreAllMocks();
    vi.clearAllMocks();
    vi.unstubAllGlobals();
  });

  it("keeps the newest host snapshot and dismisses that exact revision", async () => {
    let resolveInitial!: (value: ApplicationUpdateNoticeSnapshot) => void;
    vi.spyOn(desktopApi, "applicationUpdateNotice").mockReturnValue(
      new Promise((resolve) => {
        resolveInitial = resolve;
      }),
    );
    let current!: ReturnType<typeof useApplicationUpdateNotice>;
    function Fixture() {
      current = useApplicationUpdateNotice();
      return null;
    }

    await act(async () => root.render(<Fixture />));
    const receive = vi
      .mocked(listen)
      .mock.calls.find(([event]) => event === "portcove://application-update-notice")![1];
    await act(async () =>
      receive({
        event: "portcove://application-update-notice",
        id: 1,
        payload: notice(2, "0.3.0-beta.1"),
      }),
    );
    await act(async () => resolveInitial(notice(1, "0.2.0-beta.3")));
    expect(current.notice?.result.candidate?.version).toBe("0.3.0-beta.1");

    const dismiss = vi.spyOn(desktopApi, "dismissApplicationUpdateNotice").mockResolvedValue({
      revision: 3,
      notice: null,
    });
    await act(async () => current.dismiss());
    expect(dismiss).toHaveBeenCalledExactlyOnceWith(2);
    expect(current.notice).toBeNull();
  });

  it("announces the available version and exposes keyboard-focusable actions", async () => {
    const review = vi.fn();
    const dismiss = vi.fn().mockResolvedValue(undefined);
    await act(async () =>
      root.render(
        <StatusLayer
          clearError={() => {}}
          updateNotice={notice(1, "0.2.0-beta.3").notice}
          reviewUpdate={review}
          dismissUpdate={dismiss}
        />,
      ),
    );

    const status = host.querySelector<HTMLElement>('[role="status"]')!;
    expect(status.getAttribute("aria-live")).toBe("polite");
    expect(status.textContent).toContain("Portcove 0.2.0-beta.3 is available");
    expect(status.textContent).toContain("Preview update found (25.0 MiB)");
    const buttons = [...host.querySelectorAll<HTMLButtonElement>("button")];
    expect(buttons.every((button) => button.hasAttribute("data-focusable"))).toBe(true);
    await act(async () =>
      buttons.find((button) => button.textContent === "Review update")!.click(),
    );
    await act(async () =>
      buttons.find((button) => button.getAttribute("aria-label")?.startsWith("Dismiss"))!.click(),
    );
    expect(review).toHaveBeenCalledOnce();
    expect(dismiss).toHaveBeenCalledOnce();
  });

  it("reports dismissal failures without dropping the notice", async () => {
    vi.spyOn(desktopApi, "applicationUpdateNotice").mockResolvedValue(notice(1, "0.2.0-beta.3"));
    vi.spyOn(desktopApi, "dismissApplicationUpdateNotice").mockRejectedValue(
      new Error("dismiss failed"),
    );
    const reportError = vi.fn();
    let current!: ReturnType<typeof useApplicationUpdateNotice>;
    function Fixture() {
      current = useApplicationUpdateNotice(reportError);
      return null;
    }

    await act(async () => root.render(<Fixture />));
    await act(async () => {});
    await act(async () => current.dismiss());

    expect(reportError).toHaveBeenCalledExactlyOnceWith(new Error("dismiss failed"));
    expect(current.notice?.result.candidate?.version).toBe("0.2.0-beta.3");
  });

  it("defers an unrecorded choice only for its current session revision", async () => {
    vi.spyOn(desktopApi, "applicationUpdatePreferences").mockResolvedValue({
      schema_version: 1,
      revision: 0,
      choice: null,
    });
    let current!: ReturnType<typeof useApplicationUpdateChoice>;
    function Fixture() {
      current = useApplicationUpdateChoice();
      return null;
    }

    await act(async () => root.render(<Fixture />));
    await act(async () => {});
    expect(current.choiceRequired).toBe(true);

    await act(async () => current.dismiss());
    expect(current.choiceRequired).toBe(false);
    await act(async () => current.accept({ schema_version: 1, revision: 1, choice: null }));
    expect(current.choiceRequired).toBe(true);
    await act(async () =>
      current.accept({
        schema_version: 1,
        revision: 2,
        choice: { channel: "preview", mode: "automatic", paused: false },
      }),
    );
    expect(current.choiceRequired).toBe(false);
  });

  it("announces the update-choice prompt with explicit accessible actions", async () => {
    const review = vi.fn();
    const dismiss = vi.fn();
    await act(async () =>
      root.render(
        <StatusLayer
          clearError={() => {}}
          updateChoiceRequired
          reviewUpdate={review}
          dismissUpdateChoice={dismiss}
        />,
      ),
    );

    const status = host.querySelector<HTMLElement>('[role="status"]')!;
    expect(status.getAttribute("aria-live")).toBe("polite");
    expect(status.textContent).toContain("Choose how Portcove updates");
    expect(status.textContent).toContain("Automatic updates are recommended");
    const buttons = [...status.querySelectorAll<HTMLButtonElement>("button")];
    expect(buttons.map((button) => button.textContent)).toEqual(["Review options", "Not now"]);
    expect(buttons.every((button) => button.hasAttribute("data-focusable"))).toBe(true);
    await act(async () => buttons[0].click());
    await act(async () => buttons[1].click());
    expect(review).toHaveBeenCalledOnce();
    expect(dismiss).toHaveBeenCalledOnce();
  });

  it("completes the production transition against the exact preference revision", async () => {
    const preview: ApplicationUpdatePreferences = {
      schema_version: 1,
      revision: 4,
      choice: { channel: "preview", mode: "notify-only", paused: true },
    };
    const stable: ApplicationUpdatePreferences = {
      ...preview,
      revision: 5,
      choice: { channel: "stable", mode: "notify-only", paused: true },
    };
    vi.spyOn(desktopApi, "applicationUpdateProductionTransition")
      .mockResolvedValueOnce({ schema_version: 1, preference_revision: 4, offer_required: true })
      .mockResolvedValue({ schema_version: 1, preference_revision: 5, offer_required: false });
    const complete = vi
      .spyOn(desktopApi, "completeApplicationUpdateProductionTransition")
      .mockResolvedValue({
        preferences: stable,
        transition: { schema_version: 1, preference_revision: 5, offer_required: false },
      });
    let current!: ReturnType<typeof useApplicationUpdateProductionTransition>;
    let currentPreferences!: ApplicationUpdatePreferences;
    function Fixture() {
      const [preferences, setPreferences] = useState(preview);
      currentPreferences = preferences;
      current = useApplicationUpdateProductionTransition({
        preferences,
        acceptPreferences: setPreferences,
      });
      return null;
    }

    await act(async () => root.render(<Fixture />));
    await act(async () => {});
    expect(current.offerRequired).toBe(true);
    await act(async () => current.complete("use-stable"));
    expect(complete).toHaveBeenCalledExactlyOnceWith(4, "use-stable");
    expect(currentPreferences).toEqual(stable);
    expect(current.offerRequired).toBe(false);
    expect(current.busy).toBe(false);
  });

  it("refreshes transition state after a stale production choice", async () => {
    const preview: ApplicationUpdatePreferences = {
      schema_version: 1,
      revision: 4,
      choice: { channel: "preview", mode: "automatic", paused: false },
    };
    const currentPreferences: ApplicationUpdatePreferences = {
      ...preview,
      revision: 6,
      choice: { channel: "stable", mode: "automatic", paused: false },
    };
    vi.spyOn(desktopApi, "applicationUpdateProductionTransition").mockResolvedValue({
      schema_version: 1,
      preference_revision: 4,
      offer_required: true,
    });
    vi.spyOn(desktopApi, "completeApplicationUpdateProductionTransition").mockRejectedValue(
      new Error("preference changed"),
    );
    vi.spyOn(desktopApi, "applicationUpdatePreferences").mockResolvedValue(currentPreferences);
    const reportError = vi.fn();
    const acceptPreferences = vi.fn();
    let current!: ReturnType<typeof useApplicationUpdateProductionTransition>;
    function Fixture() {
      current = useApplicationUpdateProductionTransition({
        preferences: preview,
        acceptPreferences,
        reportError,
      });
      return null;
    }

    await act(async () => root.render(<Fixture />));
    await act(async () => {});
    await act(async () => current.complete("keep-preview"));
    expect(reportError).toHaveBeenCalledExactlyOnceWith(new Error("preference changed"));
    expect(acceptPreferences).toHaveBeenCalledWith(currentPreferences);
  });

  it("offers the production channels once with accessible explicit actions", async () => {
    const useStable = vi.fn();
    const keepPreview = vi.fn();
    const dismiss = vi.fn();
    await act(async () =>
      root.render(
        <StatusLayer
          clearError={() => {}}
          productionTransitionRequired
          useStable={useStable}
          keepPreview={keepPreview}
          dismissProductionTransition={dismiss}
        />,
      ),
    );

    const status = host.querySelector<HTMLElement>('[role="status"]')!;
    expect(status.getAttribute("aria-live")).toBe("polite");
    expect(status.textContent).toContain("Choose your production channel");
    expect(status.textContent).toContain("it never downgrades Portcove");
    expect(status.textContent).toContain("update mode and pause setting stay unchanged");
    const buttons = [...status.querySelectorAll<HTMLButtonElement>("button")];
    expect(buttons.map((button) => button.textContent)).toEqual([
      "Use Stable",
      "Keep Preview",
      "Not now",
    ]);
    expect(buttons.every((button) => button.hasAttribute("data-focusable"))).toBe(true);
    await act(async () => buttons.forEach((button) => button.click()));
    expect(useStable).toHaveBeenCalledOnce();
    expect(keepPreview).toHaveBeenCalledOnce();
    expect(dismiss).toHaveBeenCalledOnce();
  });

  it("keeps a current update notice ahead of the production transition offer", async () => {
    await act(async () =>
      root.render(
        <StatusLayer
          clearError={() => {}}
          updateNotice={notice(2, "1.0.1").notice}
          productionTransitionRequired
        />,
      ),
    );
    expect(host.textContent).toContain("Portcove 1.0.1 is available");
    expect(host.textContent).not.toContain("Choose your production channel");
  });
});
