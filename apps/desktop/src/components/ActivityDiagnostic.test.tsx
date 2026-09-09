// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { desktopApi } from "../api";
import { copyText } from "../clipboard";
import type { ActivityDiagnostic as Diagnostic } from "../types";
import { ActivityDiagnostic } from "./ActivityDiagnostic";

vi.mock("../clipboard", () => ({ copyText: vi.fn().mockResolvedValue(undefined) }));
const fixture = (): Diagnostic => ([{ activity_id: "owned", phase: "preparation.setup", complete: true, updated_at: 1,
  stream_limit_bytes: 2 * 1024 * 1024, stdout: { text: "owned output token=[REDACTED]", observed_bytes: 40, truncated: false },
  stderr: { text: "owned failure details", observed_bytes: 21, truncated: false } }]);
let root: Root; let host: HTMLDivElement;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  host = document.createElement("div"); root = createRoot(host);
});
afterEach(async () => { await act(async () => root.unmount()); vi.restoreAllMocks(); vi.unstubAllGlobals(); });
async function open() {
  await act(async () => { host.querySelector("details")!.open = true; host.querySelector("details")!.dispatchEvent(new Event("toggle")); });
}
async function click(label: string) {
  await act(async () => { [...host.querySelectorAll("button")].find(button => button.textContent === label)!.click(); });
}

it("loads only on request, names complete capture and copies the retained redacted data", async () => {
  const capture = fixture(); const read = vi.spyOn(desktopApi, "activityDiagnostic").mockResolvedValue(capture);
  await act(async () => root.render(<ActivityDiagnostic activityId="owned" generation={12} />));
  expect(read).not.toHaveBeenCalled();
  await open();
  expect(read).toHaveBeenCalledWith("owned", 12);
  expect(host.textContent).toContain("Capture reached the end of both output streams.");
  expect(host.textContent).toContain("owned failure details");
  expect([...host.querySelectorAll("pre")].every(element => element.tabIndex === 0 && element.getAttribute("aria-label"))).toBe(true);
  await click("Copy retained log");
  expect(JSON.parse(vi.mocked(copyText).mock.calls.at(-1)![0])).toEqual(capture);
});

it("keeps interrupted and truncated output visibly distinct from a complete log", async () => {
  const capture = fixture(); capture[0].complete = false; capture[0].stdout.truncated = true;
  vi.spyOn(desktopApi, "activityDiagnostic").mockResolvedValue(capture);
  await act(async () => root.render(<ActivityDiagnostic activityId="owned" generation={1} />));
  await open();
  expect(host.textContent).toContain("Capture is incomplete.");
  expect(host.textContent).toContain("Some output was omitted");
  expect(host.textContent).not.toContain("Capture reached the end");
});

it("keeps completed conversion output beside an interrupted setup phase", async () => {
  const conversion = fixture()[0]; conversion.phase = "preparation.extract"; conversion.stdout.text = "earlier conversion output";
  const setup = fixture()[0]; setup.complete = false;
  vi.spyOn(desktopApi, "activityDiagnostic").mockResolvedValue([conversion, setup]);
  await act(async () => root.render(<ActivityDiagnostic activityId="owned" generation={1} />));
  await open();
  const phases = [...host.querySelectorAll("section")];
  expect(phases).toHaveLength(2);
  expect(phases[0].textContent).toContain("Preparing source data");
  expect(phases[0].textContent).toContain("earlier conversion output");
  expect(phases[0].textContent).toContain("Capture reached the end");
  expect(phases[1].textContent).toContain("Running game setup");
  expect(phases[1].textContent).toContain("Capture is incomplete");
});

it("explains missing retained logs and allows a new read after a failure", async () => {
  const read = vi.spyOn(desktopApi, "activityDiagnostic").mockResolvedValueOnce([]).mockRejectedValueOnce(new Error("Read failed")).mockResolvedValueOnce(fixture());
  await act(async () => root.render(<ActivityDiagnostic activityId="owned" generation={1} />));
  await open(); expect(host.textContent).toContain("No retained diagnostic capture is available");
  await click("Refresh captured log"); expect(host.textContent).toContain("Read failed");
  await click("Refresh captured log"); expect(host.textContent).toContain("owned failure details");
  expect(read).toHaveBeenCalledTimes(3);
});

it("discards a delayed log from the previous activity and library", async () => {
  let resolve!: (value: Diagnostic) => void;
  const old = new Promise<Diagnostic>(done => { resolve = done; });
  const next = fixture(); next[0].stdout.text = "current library output";
  const read = vi.spyOn(desktopApi, "activityDiagnostic").mockReturnValueOnce(old).mockResolvedValueOnce(next);
  await act(async () => root.render(<ActivityDiagnostic activityId="old" generation={1} />));
  await open();
  await act(async () => root.render(<ActivityDiagnostic activityId="new" generation={2} />));
  await click("Refresh captured log");
  await act(async () => resolve(fixture()));
  expect(read).toHaveBeenLastCalledWith("new", 2);
  expect(host.textContent).toContain("current library output");
  expect(host.textContent).not.toContain("owned output token");
});
