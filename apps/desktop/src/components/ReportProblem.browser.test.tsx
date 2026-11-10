import { controlledAct as act } from "../../test/controlled-react-act";
import { render as renderComponent, cleanup, type RenderResult } from "vitest-browser-react";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";
import type { BugReportDraft, BugReportLink } from "../types";
import { ReportProblem } from "./ReportProblem";

const draft = {
  fields: [
    { id: "version", label: "Portcove version or commit", value: "0.1.0" },
    { id: "platform", label: "Platform", value: "Windows" },
    { id: "observed", label: "Observed behavior", value: "Crash in <home>/game" },
    { id: "evidence", label: "Logs and diagnostics", value: "Installed games: 2" },
  ],
} as BugReportDraft;

vi.mock("../clipboard", () => ({ copyText: vi.fn().mockResolvedValue(undefined) }));

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

const button = (label: string) =>
  [...document.body.querySelectorAll("button")].find((b) => b.textContent === label);
async function click(label: string) {
  const target = button(label);
  expect(target, label).toBeDefined();
  await act(async () => target?.click());
}
async function mount(open: (fields: BugReportDraft["fields"]) => Promise<BugReportLink>) {
  const preview = vi.fn().mockResolvedValue(draft);
  await act(async () => {
    await root.rerender(
      <ReportProblem portId="zelda64-recomp" generation={4} preview={preview} open={open} />,
    );
  });
  return preview;
}

it("previews the exact text for the chosen game and library generation before anything opens", async () => {
  const open = vi.fn();
  const preview = await mount(open);
  await click("Report a problem");
  expect(preview).toHaveBeenCalledWith("zelda64-recomp", 4);
  expect(document.body.textContent).toContain("Crash in <home>/game");
  expect(document.body.textContent).toContain("Windows");
  expect(open).not.toHaveBeenCalled();
});

it("opens the player's edited text and closes when a link was opened", async () => {
  const open = vi.fn().mockResolvedValue({ url: "https://github.com/x", clipboard_text: "t" });
  await mount(open);
  await click("Report a problem");
  const observed = document.body.querySelector("textarea");
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set;
    setter?.call(observed, "Edited by the player");
    observed?.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await click("Open on GitHub");
  const sent = open.mock.calls[0]?.[0] as BugReportDraft["fields"];
  expect(sent.find((f) => f.id === "observed")?.value).toBe("Edited by the player");
  expect(document.body.textContent).not.toContain("Open on GitHub");
});

it("explains the clipboard fallback when the report is too long for a link", async () => {
  const { copyText } = await import("../clipboard");
  const open = vi.fn().mockResolvedValue({ url: null, clipboard_text: "full report" });
  await mount(open);
  await click("Report a problem");
  await click("Open on GitHub");
  expect(copyText).toHaveBeenCalledWith("full report");
  expect(document.body.textContent).toContain("too long for a link");
});

it("shows a failed preview instead of an empty dialog", async () => {
  const preview = vi.fn().mockRejectedValue(new Error("down"));
  await act(async () => {
    await root.rerender(<ReportProblem generation={1} preview={preview} open={vi.fn()} />);
  });
  await click("Report a problem");
  expect(document.body.querySelector("[role=alert]")).not.toBeNull();
  expect(button("Open on GitHub")).toBeUndefined();
});

it("keeps the report on screen for manual copying when the clipboard fails", async () => {
  const { copyText } = await import("../clipboard");
  vi.mocked(copyText).mockRejectedValueOnce(new Error("denied"));
  const open = vi.fn().mockResolvedValue({ url: null, clipboard_text: "full report text" });
  await mount(open);
  await click("Report a problem");
  await click("Open on GitHub");
  const readOnly = document.body.querySelector("textarea[readonly]") as HTMLTextAreaElement | null;
  expect(readOnly?.value).toBe("full report text");
  expect(document.body.querySelector("[role=alert]")?.textContent).toContain("copy the text");
});

it("ignores a preview that finishes after the dialog was closed", async () => {
  let finish: (value: BugReportDraft) => void = () => undefined;
  const preview = vi.fn().mockReturnValue(
    new Promise<BugReportDraft>((resolve) => {
      finish = resolve;
    }),
  );
  await act(async () => {
    await root.rerender(<ReportProblem generation={1} preview={preview} open={vi.fn()} />);
  });
  await click("Report a problem");
  await act(async () => {
    await root.unmount();
  });
  await act(async () => finish(draft));
  expect(document.body.textContent).not.toContain("Crash in <home>/game");
});
