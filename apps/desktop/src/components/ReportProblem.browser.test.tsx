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
    { id: "reproduce", label: "What were you doing when it happened?", value: "" },
    { id: "evidence", label: "Logs and diagnostics", value: "Installed games: 2" },
  ],
  choices: [],
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
  choices: [
    {
      id: "journey",
      label: "What were you trying to do?",
      options: ["Install a game", "Play a game"],
    },
    { id: "outcome", label: "How far did you get?", options: ["I couldn't finish"] },
  ],
} as BugReportDraft;

const signedOut = () => Promise.reject(new Error("not signed in"));

type Props = ComponentProps<typeof ReportProblem>;

async function mountChoice(open: NonNullable<Props["open"]>, extra: Partial<Props> = {}) {
  const preview = vi.fn((_port: string | undefined, _generation: number, kind: string) =>
    Promise.resolve(kind === "feedback" ? feedbackDraft : draft),
  );
  await act(async () => {
    await root.rerender(
      <ReportProblem
        portId="zelda64-recomp"
        generation={4}
        preview={preview}
        open={open}
        authStatus={signedOut}
        {...extra}
      />,
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

it("keeps a failed feedback preview titled as feedback", async () => {
  const preview = vi.fn().mockRejectedValue(new Error("down"));
  await act(async () => {
    await root.rerender(<ReportProblem generation={1} preview={preview} open={vi.fn()} />);
  });
  await click("Report a problem or send feedback");
  await click("Something was hard or confusing, or I have an idea");
  expect(document.body.querySelector("[role=alert]")).not.toBeNull();
  expect(document.body.textContent).toContain("Send feedback");
  expect(document.body.textContent).not.toContain("Choose what you want to tell us");
});

it("keeps the player's text when the form cannot be opened", async () => {
  const open = vi.fn().mockRejectedValue(new Error("no browser"));
  await mountChoice(open);
  await click("Report a problem or send feedback");
  await click("Something was hard or confusing, or I have an idea");
  const happened = () =>
    [...document.body.querySelectorAll("label")]
      .find((label) => label.textContent?.startsWith("What happened?"))
      ?.querySelector("textarea");
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set;
    setter?.call(happened(), "Long story");
    happened()?.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await click("Open on GitHub");
  expect(document.body.querySelector("[role=alert]")?.textContent).toContain(
    "Your text is still here",
  );
  expect(happened()?.value).toBe("Long story");
  expect(button("Copy text")).toBeDefined();
});

it("shows the text for manual copying when an asked copy fails", async () => {
  const { copyText } = await import("../clipboard");
  vi.mocked(copyText).mockRejectedValueOnce(new Error("denied"));
  const open = vi
    .fn()
    .mockResolvedValue({ url: "https://github.com/x", clipboard_text: "by hand" });
  await mountChoice(open);
  await click("Report a problem or send feedback");
  await click("Something broke or didn't work as it should");
  await click("Copy text");
  const readOnly = document.body.querySelector("textarea[readonly]");
  expect(readOnly instanceof HTMLTextAreaElement ? readOnly.value : undefined).toBe("by hand");
  expect(document.body.querySelector("[role=alert]")?.textContent).toContain(
    "could not be copied automatically",
  );
});

const signedIn = () =>
  Promise.resolve({
    source: "credential_store",
    authenticated: true,
    login: "octo",
    rate_limit: null,
    device_login_available: true,
  } as Awaited<ReturnType<NonNullable<Props["authStatus"]>>>);

async function type(label: string, text: string) {
  const area = [...document.body.querySelectorAll("label")]
    .find((element) => element.textContent?.startsWith(label))
    ?.querySelector("textarea");
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set;
    setter?.call(area, text);
    area?.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

async function pick(label: string, option: string) {
  const select = [...document.body.querySelectorAll("label")]
    .find((element) => element.textContent?.startsWith(label))
    ?.querySelector("select");
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value")?.set;
    setter?.call(select, option);
    select?.dispatchEvent(new Event("change", { bubbles: true }));
  });
}

it("offers no Submit when the player is not signed in", async () => {
  await mountChoice(vi.fn());
  await click("Report a problem or send feedback");
  await click("Something was hard or confusing, or I have an idea");
  expect(document.body.querySelector("select")).not.toBeNull();
  expect(
    [...document.body.querySelectorAll("button")].some((b) => b.textContent?.startsWith("Submit")),
  ).toBe(false);
  expect(button("Open on GitHub")).toBeDefined();
});

it("submits the answered feedback from the signed-in account and links the issue", async () => {
  const submitReport = vi.fn().mockResolvedValue({
    number: 12,
    url: "https://github.com/boburning/portcove/issues/12",
  });
  const openIssue = vi.fn().mockResolvedValue(undefined);
  await mountChoice(vi.fn(), { authStatus: signedIn, submitReport, openIssue });
  await click("Report a problem or send feedback");
  await click("Something was hard or confusing, or I have an idea");
  await expect.poll(() => button("Submit as octo")).toBeDefined();
  expect(button("Submit as octo")?.disabled).toBe(true);
  expect(document.body.textContent).toContain("answer each question");
  await pick("What were you trying to do?", "Install a game");
  await pick("How far did you get?", "I couldn't finish");
  await type("What happened?", "Setup asked twice");
  expect(button("Submit as octo")?.disabled).toBe(false);
  await click("Submit as octo");
  expect(submitReport.mock.calls[0]?.[1]).toBe("feedback");
  const sent = submitReport.mock.calls[0]?.[0] as BugReportDraft["fields"];
  expect(sent.find((f) => f.id === "journey")?.value).toBe("Install a game");
  expect(sent.find((f) => f.id === "outcome")?.value).toBe("I couldn't finish");
  expect(sent.find((f) => f.id === "happened")?.value).toBe("Setup asked twice");
  expect(document.body.querySelector("[role=status]")?.textContent).toContain("issue #12");
  await click("View on GitHub");
  expect(openIssue).toHaveBeenCalledWith("https://github.com/boburning/portcove/issues/12");
});

it("keeps the answers and text when submitting fails", async () => {
  const submitReport = vi.fn().mockRejectedValue(new Error("refused"));
  await mountChoice(vi.fn(), { authStatus: signedIn, submitReport });
  await click("Report a problem or send feedback");
  await click("Something was hard or confusing, or I have an idea");
  await expect.poll(() => button("Submit as octo")).toBeDefined();
  await pick("What were you trying to do?", "Play a game");
  await pick("How far did you get?", "I couldn't finish");
  await type("What happened?", "Kept my words");
  await click("Submit as octo");
  expect(document.body.querySelector("[role=alert]")?.textContent).toContain(
    "Check GitHub for your new issue before trying again",
  );
  const kept = [...document.body.querySelectorAll("label")]
    .find((element) => element.textContent?.startsWith("What happened?"))
    ?.querySelector("textarea");
  expect(kept?.value).toBe("Kept my words");
  expect(button("Open on GitHub")).toBeDefined();
});

it("lets the player say what they were doing in a bug report", async () => {
  const submitReport = vi.fn().mockResolvedValue({ number: 3, url: "https://github.com/x/3" });
  await mountChoice(vi.fn(), { authStatus: signedIn, submitReport });
  await click("Report a problem or send feedback");
  await click("Something broke or didn't work as it should");
  await expect.poll(() => button("Submit as octo")).toBeDefined();
  await type("What were you doing when it happened?", "Launching after an update");
  await click("Submit as octo");
  const sent = submitReport.mock.calls[0]?.[0] as BugReportDraft["fields"];
  expect(sent.find((f) => f.id === "reproduce")?.value).toBe("Launching after an update");
  expect(submitReport.mock.calls[0]?.[1]).toBe("problem");
});
