// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { listen } from "@tauri-apps/api/event";
import { desktopApi } from "./api";
import { StatusLayer } from "./components/Chrome";
import type { ApplicationUpdateNoticeSnapshot } from "./types";
import { useApplicationUpdateNotice } from "./use-portcove";

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
});
