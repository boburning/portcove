import { controlledAct as act } from "../../test/controlled-react-act";
import { render as renderComponent, cleanup, type RenderResult } from "vitest-browser-react";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";
import type { LaunchSessionView, PortStatus } from "../types";
import { LaunchFailureNotice } from "./LaunchFailureNotice";

function failure(explained: boolean): LaunchSessionView {
  return {
    id: "r",
    install_id: "i1",
    exit_code: -1073741515,
    outcome: "failed",
    ...(explained
      ? {
          exit_explanation: {
            table_version: 1,
            key: "dll_not_found",
            raw_code: "0xC0000135",
            explanation: "A required DLL or runtime is most likely missing.",
            next_action: "Install the runtime, then try again.",
          },
        }
      : {}),
  } as LaunchSessionView;
}

const rollback = vi.fn();
// Core's rollback assessment gates the action exactly as the maintenance control does.
function withRollback(availability: string, reason: string): PortStatus {
  return {
    active: { id: "i1" },
    previous: { id: "old" },
    port_actions: [{ action: "rollback", availability, reason }],
  } as unknown as PortStatus;
}
let root: RenderResult;
let container: HTMLDivElement;
beforeEach(async () => {
  container = document.createElement("div");
  document.body.append(container);
  root = await renderComponent(null, { container: document.body.appendChild(container) });
});
afterEach(async () => {
  await cleanup();
  container.remove();
  vi.restoreAllMocks();
});

async function show(
  load: (portId: string, generation: number) => Promise<LaunchSessionView | null>,
  status?: PortStatus,
) {
  await act(async () => {
    await root.rerender(
      <LaunchFailureNotice
        portId="p"
        generation={1}
        status={status}
        rollback={rollback}
        load={load}
      />,
    );
  });
}
const buttons = () => [...document.body.querySelectorAll("button")].map((b) => b.textContent);

it("shows the explanation and raw code, offering rollback only with a retained version", async () => {
  const load = vi.fn().mockResolvedValue(failure(true));
  await show(load, { active: { id: "i1" }, previous: null } as unknown as PortStatus);
  expect(document.body.textContent).toContain("most likely missing");
  expect(document.body.textContent).toContain("0xC0000135");
  expect(buttons()).toEqual(["Copy exit code", "Report a problem"]);
  await show(load, withRollback("allowed", "available"));
  expect(buttons()).toEqual(["Copy exit code", "Report a problem", "Restore previous version"]);
});

it("withholds rollback while Core reports it unavailable", async () => {
  const load = vi.fn().mockResolvedValue(failure(true));
  await show(load, withRollback("not_offered", "not_installed"));
  expect(buttons()).toEqual(["Copy exit code", "Report a problem"]);
});

it.each([
  ["no failed launch", () => Promise.resolve(null)],
  ["an unexplained session", () => Promise.resolve(failure(false))],
  ["a failed read", () => Promise.reject(new Error("down"))],
])("shows nothing for %s", async (_name, load) => {
  await show(load);
  expect(document.body.querySelector("[data-launch-failure]")).toBeNull();
});

it("hides a failure that belongs to an installation that is no longer active", async () => {
  const load = vi.fn().mockResolvedValue(failure(true));
  await show(load, { active: { id: "i2" }, previous: { id: "i1" } } as unknown as PortStatus);
  expect(document.body.querySelector("[data-launch-failure]")).toBeNull();
  await show(load, { active: { id: "i1" }, previous: null } as unknown as PortStatus);
  expect(document.body.querySelector("[data-launch-failure]")).not.toBeNull();
});

it("follows an external registration and hides the failure once nothing is installed", async () => {
  const load = vi.fn().mockResolvedValue(failure(true));
  await show(load, { external_runtime: { id: "i1" } } as unknown as PortStatus);
  expect(document.body.querySelector("[data-launch-failure]")).not.toBeNull();
  await show(load, { active: null, previous: null } as unknown as PortStatus);
  expect(document.body.querySelector("[data-launch-failure]")).toBeNull();
  await show(load, undefined);
  expect(document.body.querySelector("[data-launch-failure]")).toBeNull();
});

it("offers Open Activity only when the host can open it, and calls it", async () => {
  const load = vi.fn().mockResolvedValue(failure(true));
  const status = { active: { id: "i1" }, previous: null } as unknown as PortStatus;
  await show(load, status);
  expect(buttons()).not.toContain("Open Activity");

  const openActivity = vi.fn();
  await act(async () => {
    await root.rerender(
      <LaunchFailureNotice
        portId="p"
        generation={1}
        status={status}
        rollback={rollback}
        load={load}
        openActivity={openActivity}
      />,
    );
  });
  expect(buttons()).toEqual(["Copy exit code", "Report a problem", "Open Activity"]);
  const open = [...document.body.querySelectorAll("button")].find(
    (button) => button.textContent === "Open Activity",
  );
  await act(async () => open?.click());
  expect(openActivity).toHaveBeenCalledOnce();
});

it("ignores an unfinished notice read from the previously selected game", async () => {
  let finishFirstRead!: (value: LaunchSessionView) => void;
  const firstRead = new Promise<LaunchSessionView>((resolve) => {
    finishFirstRead = resolve;
  });
  const load = vi.fn((portId: string) => (portId === "p" ? firstRead : Promise.resolve(null)));
  const status = { active: { id: "i1" } } as PortStatus;
  await show(load, status);
  expect(load).toHaveBeenCalledWith("p", 1);

  await act(async () => {
    await root.rerender(
      <LaunchFailureNotice
        portId="other"
        generation={1}
        status={status}
        rollback={rollback}
        load={load}
      />,
    );
  });
  expect(load).toHaveBeenCalledWith("other", 1);
  await act(async () => finishFirstRead(failure(true)));
  expect(document.body.querySelector("[data-launch-failure]")).toBeNull();
});

it("renders the notice chrome in the current language and keeps the exit code verbatim", async () => {
  const { initializeLocalization } = await import("../localization");
  const localization = initializeLocalization(["en-US"]);
  await show(() => Promise.resolve(failure(true)), withRollback("available", ""));
  const notice = () => container.querySelector('[role="status"]');
  expect(notice()?.textContent).toContain("Exit code 0xC0000135");
  try {
    await act(async () => {
      await localization.changeLanguage("ar-XB");
    });
    await expect.poll(() => notice()?.getAttribute("aria-label")).toBe("آخر تشغيل");
    expect(notice()?.textContent).toContain("رمز الخروج 0xC0000135");
    expect(notice()?.querySelector("code")?.getAttribute("dir")).toBe("ltr");
  } finally {
    await act(async () => {
      await localization.changeLanguage("en");
    });
  }
  await expect.poll(() => notice()?.getAttribute("aria-label")).toBe("Last launch");
});
