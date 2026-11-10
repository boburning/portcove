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

async function show(load: () => Promise<LaunchSessionView | null>, status?: PortStatus) {
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
  await show(load, { previous: null } as PortStatus);
  expect(document.body.textContent).toContain("most likely missing");
  expect(document.body.textContent).toContain("0xC0000135");
  expect(buttons()).toEqual(["Copy exit code"]);
  await show(load, withRollback("allowed", "available"));
  expect(buttons()).toEqual(["Copy exit code", "Restore previous version"]);
});

it("withholds rollback while Core reports it unavailable", async () => {
  const load = vi.fn().mockResolvedValue(failure(true));
  await show(load, withRollback("not_offered", "not_installed"));
  expect(buttons()).toEqual(["Copy exit code"]);
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
