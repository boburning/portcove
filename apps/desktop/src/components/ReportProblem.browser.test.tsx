import type { ComponentProps } from "react";
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
      <ReportProblem
        portId="zelda64-recomp"
        generation={4}
        problemOnly
        preview={preview}
        open={open}
      />,
    );
  });
  return preview;
}

it("previews the exact text for the chosen game and library generation before anything opens", async () => {
  const open = vi.fn();
  const preview = await mount(open);
  await click("Report a problem");
  expect(preview).toHaveBeenCalledWith("zelda64-recomp", 4, "problem");
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
  expect(open.mock.calls[0]?.slice(1)).toEqual(["problem", false]);
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
    await root.rerender(
      <ReportProblem generation={1} problemOnly preview={preview} open={vi.fn()} />,
    );
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
  const readOnly = document.body.querySelector("textarea[readonly]");
  expect(readOnly instanceof HTMLTextAreaElement ? readOnly.value : undefined).toBe(
    "full report text",
  );
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
    await root.rerender(
      <ReportProblem generation={1} problemOnly preview={preview} open={vi.fn()} />,
    );
  });
  await click("Report a problem");
  await act(async () => {
    await root.unmount();
  });
  await act(async () => finish(draft));
  expect(document.body.textContent).not.toContain("Crash in <home>/game");
});

it("re-renders the preparation-failure fallback in the current language", async () => {
  const { initializeLocalization } = await import("../localization");
  const localization = initializeLocalization(["en-US"]);
  await act(async () => {
    await root.rerender(
      <ReportProblem
        generation={4}
        problemOnly
        preview={vi.fn().mockRejectedValue(new Error("unstructured"))}
        open={vi.fn()}
      />,
    );
  });
  await click("Report a problem");
  const alert = () => document.body.querySelector('[role="alert"]')?.textContent ?? "";
  expect(alert()).toBe("The report could not be prepared. Try again.");
  try {
    await act(async () => {
      await localization.changeLanguage("ar-XB");
    });
    await expect.poll(alert).toBe("تعذر إعداد التقرير. حاول مرة أخرى.");
  } finally {
    await act(async () => {
      await localization.changeLanguage("en");
    });
  }
  await expect.poll(alert).toBe("The report could not be prepared. Try again.");
});

const feedbackDraft = {
  fields: [
    { id: "version", label: "Portcove version", value: "0.1.0" },
    { id: "platform", label: "Platform", value: "Windows" },
    { id: "game", label: "Game, if it was about one", value: "zelda64-recomp" },
    { id: "happened", label: "What happened?", value: "" },
    { id: "expected", label: "What did you expect or want instead?", value: "" },
    { id: "context", label: "Portcove details", value: "Installed games: 2" },
  ],
} as BugReportDraft;

async function mountChoice(open: NonNullable<ComponentProps<typeof ReportProblem>["open"]>) {
  const preview = vi.fn((_port: string | undefined, _generation: number, kind: string) =>
    Promise.resolve(kind === "feedback" ? feedbackDraft : draft),
  );
  await act(async () => {
    await root.rerender(
      <ReportProblem portId="zelda64-recomp" generation={4} preview={preview} open={open} />,
    );
  });
  return preview;
}

it("asks whether something broke or was hard before preparing anything", async () => {
  const preview = await mountChoice(vi.fn());
  await click("Report a problem or send feedback");
  expect(preview).not.toHaveBeenCalled();
  expect(document.body.textContent).toContain("Choose what you want to tell us");
  await click("Something broke or didn't work as it should");
  expect(preview).toHaveBeenCalledWith("zelda64-recomp", 4, "problem");
  expect(document.body.textContent).toContain("Crash in <home>/game");
});

it("prepares feedback for the player to describe and opens the feedback form", async () => {
  const open = vi.fn().mockResolvedValue({ url: "https://github.com/x", clipboard_text: "t" });
  const preview = await mountChoice(open);
  await click("Report a problem or send feedback");
  await click("Something was hard or confusing, or I have an idea");
  expect(preview).toHaveBeenCalledWith("zelda64-recomp", 4, "feedback");
  expect(document.body.textContent).toContain("Send feedback");
  const happened = [...document.body.querySelectorAll("label")]
    .find((label) => label.textContent?.startsWith("What happened?"))
    ?.querySelector("textarea");
  expect(happened?.value).toBe("");
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set;
    setter?.call(happened, "Setup asked twice");
    happened?.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await click("Open on GitHub");
  expect(open.mock.calls[0]?.slice(1)).toEqual(["feedback", false]);
  const sent = open.mock.calls[0]?.[0] as BugReportDraft["fields"];
  expect(sent.find((f) => f.id === "happened")?.value).toBe("Setup asked twice");
  expect(button("Open on GitHub")).toBeUndefined();
});

it("copies the reviewed text without opening GitHub when the player asks", async () => {
  const { copyText } = await import("../clipboard");
  const open = vi
    .fn()
    .mockResolvedValue({ url: "https://github.com/x", clipboard_text: "copy me" });
  await mountChoice(open);
  await click("Report a problem or send feedback");
  await click("Something was hard or confusing, or I have an idea");
  await click("Copy text");
  expect(open.mock.calls[0]?.slice(1)).toEqual(["feedback", true]);
  expect(copyText).toHaveBeenCalledWith("copy me");
  expect(document.body.querySelector("[role=status]")?.textContent).toContain(
    "send it to the Portcove team another way",
  );
});
