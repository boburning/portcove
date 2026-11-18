import { captureParityState } from "../../test/parity-capture";
import { page } from "vite-plus/test/browser";
import { controlledAct as act } from "../../test/controlled-react-act";
import { render as renderComponent, cleanup, type RenderResult } from "vitest-browser-react";
import { fixtureValue } from "../test-fixtures";
import { StrictMode } from "react";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";
import { desktopApi } from "../api";
import { copyText } from "../clipboard";
import type { ActivityDiagnostic as Diagnostic } from "../types";
import { failureReport } from "../test-fixtures";
import App from "../App";
import { installInteractiveTransport } from "../dev-scenarios/interactive/transport";
import { LocalizationProvider } from "../localization";
import { ActivityDiagnostic } from "./ActivityDiagnostic";

vi.mock("../clipboard", () => ({
  copyText: vi.fn().mockResolvedValue(undefined),
}));
const fixture = (): [Diagnostic[number]] => [
  {
    activity_id: "owned",
    phase: "preparation.setup",
    complete: true,
    updated_at: 1,
    stream_limit_bytes: 2 * 1024 * 1024,
    stdout: {
      text: "owned output token=[REDACTED]",
      observed_bytes: 40,
      truncated: false,
    },
    stderr: {
      text: "owned failure details",
      observed_bytes: 21,
      truncated: false,
    },
  },
];
let root: RenderResult;
let host: HTMLDivElement;
let transport: ReturnType<typeof installInteractiveTransport> | undefined;
beforeEach(async () => {
  vi.mocked(copyText).mockReset().mockResolvedValue(undefined);
  host = document.createElement("div");
  root = await renderComponent(null, { container: document.body.appendChild(host) });
});
afterEach(async () => {
  await cleanup();
  transport?.dispose();
  transport = undefined;
  host.remove();
  localStorage.clear();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  document.documentElement.removeAttribute("data-theme");
  await page.viewport(1280, 800);
});
async function open() {
  await act(async () => {
    host.querySelector("details")!.open = true;
    host.querySelector("details")!.dispatchEvent(new Event("toggle"));
  });
}
async function click(label: string) {
  await act(async () => {
    [...host.querySelectorAll("button")].find((button) => button.textContent === label)!.click();
  });
}

it("loads only on request, names complete capture and copies the retained redacted data", async () => {
  const capture = fixture();
  const read = vi.spyOn(desktopApi, "activityDiagnostic").mockResolvedValue(capture);
  await root.rerender(<ActivityDiagnostic activityId="owned" generation={12} />);
  expect(read).not.toHaveBeenCalled();
  await open();
  expect(read).toHaveBeenCalledWith("owned", 12);
  expect(host.textContent).toContain("Both output streams ended. Saved output is shown below.");
  expect(host.textContent).toContain("owned failure details");
  expect(
    [...host.querySelectorAll("pre")].every(
      (element) => element.tabIndex === 0 && element.getAttribute("aria-label"),
    ),
  ).toBe(true);
  expect(
    [...host.querySelectorAll("button")].every(
      (button) => button.dataset.variant === "outline" && button.dataset.slot === "button",
    ),
  ).toBe(true);
  await click("Copy retained log");
  expect(JSON.parse(vi.mocked(copyText).mock.calls.at(-1)![0])).toEqual(capture);
});

it("keeps interrupted and truncated output visibly distinct from a complete log", async () => {
  const capture = fixture();
  capture[0].complete = false;
  capture[0].stdout.truncated = true;
  vi.spyOn(desktopApi, "activityDiagnostic").mockResolvedValue(capture);
  await root.rerender(<ActivityDiagnostic activityId="owned" generation={1} />);
  await open();
  expect(host.textContent).toContain(
    "Only the output saved before the last observation is available. Later output may be missing.",
  );
  expect(host.textContent).toContain("Some output was omitted");
  expect(host.textContent).not.toContain("Both output streams ended. Saved output is shown below");
});

it("separates ended streams from omitted output without asserting operation success", async () => {
  const capture = fixture();
  capture[0].stdout.truncated = true;
  vi.spyOn(desktopApi, "activityDiagnostic").mockResolvedValue(capture);
  await root.rerender(<ActivityDiagnostic activityId="owned" generation={1} />);
  await open();
  expect(host.textContent).toContain("Both output streams ended. Saved output is shown below.");
  expect(host.textContent).toContain("Some output was omitted");
  expect(host.textContent).not.toContain("includes both output streams through their end");
  expect(host.textContent).not.toContain("Preparation completed");
});

it("keeps completed conversion output beside an interrupted setup phase", async () => {
  const conversion = fixture()[0];
  conversion.phase = "preparation.extract";
  conversion.stdout.text = "earlier conversion output";
  const setup = fixture()[0];
  setup.complete = false;
  vi.spyOn(desktopApi, "activityDiagnostic").mockResolvedValue([conversion, setup]);
  await root.rerender(<ActivityDiagnostic activityId="owned" generation={1} />);
  await open();
  const phases = [...host.querySelectorAll("section")];
  expect(phases).toHaveLength(2);
  expect(fixtureValue(phases[0], "phases[0]").textContent).toContain("Game file preparation");
  expect(fixtureValue(phases[0], "phases[0]").textContent).toContain("earlier conversion output");
  expect(fixtureValue(phases[0], "phases[0]").textContent).toContain(
    "Both output streams ended. Saved output is shown below",
  );
  expect(fixtureValue(phases[1], "phases[1]").textContent).toContain("Game setup");
  expect(fixtureValue(phases[1], "phases[1]").textContent).toContain(
    "Only the output saved before the last observation is available",
  );
});

it("explains missing retained logs and allows a new read after a failure", async () => {
  const read = vi
    .spyOn(desktopApi, "activityDiagnostic")
    .mockResolvedValueOnce([])
    .mockRejectedValueOnce(new Error("Read failed"))
    .mockResolvedValueOnce(fixture());
  await root.rerender(<ActivityDiagnostic activityId="owned" generation={1} />);
  await open();
  expect(host.textContent).toContain("No retained diagnostic capture is available");
  await click("Refresh captured log");
  expect(host.textContent).toContain("Current log availability is unknown.");
  expect(host.textContent).not.toContain("No retained diagnostic capture is available");
  expect(host.textContent).not.toContain("Read failed");
  await click("Retry log read");
  expect(host.textContent).toContain("owned failure details");
  expect(read).toHaveBeenCalledTimes(3);
});

it("labels a retained capture after failed refresh and recovers without repeating preparation", async () => {
  await page.viewport(960, 800);
  document.documentElement.dataset.theme = "dark";
  const error = failureReport();
  error.message = "unrequested private path";
  error.presentation.summary = "The retained log could not be read.";
  error.presentation.technical_message = "redacted diagnostic reason";
  error.presentation.mutation_state = "committed";
  const read = vi
    .spyOn(desktopApi, "activityDiagnostic")
    .mockResolvedValueOnce(fixture())
    .mockRejectedValueOnce(error)
    .mockResolvedValueOnce([]);
  await root.rerender(<ActivityDiagnostic activityId="owned" generation={7} />);
  await open();
  await click("Refresh captured log");
  expect(host.textContent).toContain("Showing the last loaded capture; it may have changed");
  expect(host.textContent).toContain(error.presentation.summary);
  expect(host.textContent).not.toContain(error.message);
  expect(host.textContent).not.toContain("The change was saved");
  const details = [...host.querySelectorAll("details")].find(
    (element) => element.querySelector("summary")?.textContent === "View technical details",
  );
  expect(details?.open).toBe(false);
  expect(details?.textContent).toContain(error.presentation.technical_message);
  await captureParityState("activity-retained-log-refresh-refused");
  await click("Copy retained log");
  expect(JSON.parse(vi.mocked(copyText).mock.calls.at(-1)![0])).toEqual(fixture());
  await click("Retry log read");
  expect(host.textContent).toContain("No retained diagnostic capture is available");
  expect(host.textContent).not.toContain("Current log availability is unknown");
  expect(host.querySelector("textarea")).toBeNull();
  expect(read.mock.calls).toEqual([
    ["owned", 7],
    ["owned", 7],
    ["owned", 7],
  ]);
});

it("keeps a first cancelled log read neutral without claiming a missing capture", async () => {
  const error = failureReport();
  error.code = "cancelled";
  error.presentation.tone = "neutral";
  vi.spyOn(desktopApi, "activityDiagnostic").mockRejectedValue(error);
  await root.rerender(<ActivityDiagnostic activityId="owned" generation={1} />);
  await open();
  expect(host.querySelector('[role="alert"]')).toBeNull();
  expect(host.querySelector('[role="status"]')?.textContent).toContain("Log read cancelled");
  expect(host.textContent).toContain("Current log availability is unknown");
  expect(host.textContent).not.toContain("No retained diagnostic capture is available");
});

it("opens first-read technical details without implicitly retrying the read", async () => {
  const error = failureReport();
  error.presentation.technical_message = "retained redacted failure reason";
  const read = vi.spyOn(desktopApi, "activityDiagnostic").mockRejectedValue(error);
  await root.rerender(
    <StrictMode>
      <ActivityDiagnostic activityId="owned" generation={1} />
    </StrictMode>,
  );
  await open();
  const details = [...host.querySelectorAll("details")].find(
    (element) => element.querySelector("summary")?.textContent === "View technical details",
  )!;
  await act(async () => {
    details.open = true;
    details.dispatchEvent(new Event("toggle", { bubbles: true }));
  });
  expect(details.open).toBe(true);
  expect(host.contains(details)).toBe(true);
  expect(details.textContent).toContain(error.presentation.technical_message);
  expect(read).toHaveBeenCalledTimes(1);
  expect(host.textContent).toContain("Retry log read");
});

it("coalesces same-tick reads and labels the prior capture while pending", async () => {
  let resolve!: (value: Diagnostic) => void;
  const pending = new Promise<Diagnostic>((done) => {
    resolve = done;
  });
  const read = vi
    .spyOn(desktopApi, "activityDiagnostic")
    .mockResolvedValueOnce(fixture())
    .mockReturnValueOnce(pending);
  await root.rerender(<ActivityDiagnostic activityId="owned" generation={1} />);
  await open();
  await act(async () => {
    const button = [...host.querySelectorAll("button")].find(
      (value) => value.textContent === "Refresh captured log",
    )!;
    button.click();
    button.click();
  });
  expect(read).toHaveBeenCalledTimes(2);
  expect(host.textContent).toContain(
    "Showing the last loaded capture while the current log is checked",
  );
  await act(async () => resolve(fixture()));
  expect(host.textContent).not.toContain("while the current log is checked");
});

it("rejects a late failed read after the selected activity and library change", async () => {
  let reject!: (value: Error) => void;
  const old = new Promise<Diagnostic>((_, fail) => {
    reject = fail;
  });
  vi.spyOn(desktopApi, "activityDiagnostic")
    .mockReturnValueOnce(old)
    .mockResolvedValueOnce(fixture());
  await root.rerender(<ActivityDiagnostic activityId="old" generation={1} />);
  await open();
  await root.rerender(<ActivityDiagnostic activityId="new" generation={2} />);
  await click("Refresh captured log");
  await act(async () => reject(new Error("old failure")));
  expect(host.querySelector('[role="alert"]')).toBeNull();
  expect(host.textContent).not.toContain("Current log availability is unknown");
  expect(host.querySelector("textarea")?.value).toContain("owned output");
});

it("keeps an unfamiliar phase neutral and preserves its exact copied log", async () => {
  const capture = fixture();
  capture[0].phase = "preparation.future-phase";
  vi.spyOn(desktopApi, "activityDiagnostic").mockResolvedValue(capture);
  await root.rerender(<ActivityDiagnostic activityId="owned" generation={1} />);
  await open();
  expect(host.querySelector("h4")?.textContent).toBe("Preparation log");
  expect(host.textContent).not.toContain("Game setup");
  await click("Copy retained log");
  expect(JSON.parse(vi.mocked(copyText).mock.calls.at(-1)![0])).toEqual(capture);
});

it("discards a delayed log from the previous activity and library", async () => {
  let resolve!: (value: Diagnostic) => void;
  const old = new Promise<Diagnostic>((done) => {
    resolve = done;
  });
  const next = fixture();
  next[0].stdout.text = "current library output";
  const read = vi
    .spyOn(desktopApi, "activityDiagnostic")
    .mockReturnValueOnce(old)
    .mockResolvedValueOnce(next);
  await root.rerender(<ActivityDiagnostic activityId="old" generation={1} />);
  await open();
  await root.rerender(<ActivityDiagnostic activityId="new" generation={2} />);
  await click("Refresh captured log");
  await act(async () => resolve(fixture()));
  expect(read).toHaveBeenLastCalledWith("new", 2);
  expect(host.textContent).toContain("current library output");
  expect(host.textContent).not.toContain("owned output token");
});

it("announces clipboard failure with an exact fallback without reading or changing the log", async () => {
  await page.viewport(430, 780);
  document.documentElement.dataset.theme = "light";
  const capture = fixture();
  const read = vi.spyOn(desktopApi, "activityDiagnostic").mockResolvedValue(capture);
  vi.mocked(copyText).mockRejectedValueOnce(new Error("private clipboard detail"));
  await root.rerender(<ActivityDiagnostic activityId="owned" generation={1} />);
  await open();
  const streams = [...host.querySelectorAll<HTMLTextAreaElement>("section textarea")].map(
    (field) => field.value,
  );
  await click("Copy retained log");
  expect(host.querySelector('[role="alert"]')?.textContent).toBe(
    "Clipboard unavailable. Select and copy the retained log below.",
  );
  const fallback = host.querySelector<HTMLTextAreaElement>(
    '[aria-label="Retained log for manual copy"]',
  )!;
  expect(fallback.readOnly).toBe(true);
  expect(fallback.value).toBe(JSON.stringify(capture, null, 2));
  fallback.scrollIntoView({ block: "center", inline: "nearest" });
  const fallbackBounds = fallback.getBoundingClientRect();
  expect(fallbackBounds.top).toBeGreaterThanOrEqual(0);
  expect(fallbackBounds.bottom).toBeLessThanOrEqual(innerHeight);
  expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(innerWidth + 1);
  await captureParityState("activity-retained-log-manual-copy");
  expect(copyText).toHaveBeenLastCalledWith(fallback.value);
  expect(host.textContent).not.toContain("private clipboard detail");
  expect(
    [...host.querySelectorAll<HTMLTextAreaElement>("section textarea")].map((field) => field.value),
  ).toEqual(streams);
  await click("Copy retained log");
  expect(host.querySelector('[role="status"]')?.textContent).toBe("Retained log copied.");
  expect(host.querySelector('[role="alert"]')).toBeNull();
  expect(host.querySelector('[aria-label="Retained log for manual copy"]')).toBeNull();
  expect(read).toHaveBeenCalledTimes(1);
});

it.each(["success", "failure"])(
  "ignores an older copy %s after a newer attempt",
  async (outcome) => {
    let resolve!: () => void;
    let reject!: (error: Error) => void;
    vi.mocked(copyText).mockReturnValueOnce(
      new Promise<void>((done, fail) => {
        resolve = done;
        reject = fail;
      }),
    );
    const read = vi.spyOn(desktopApi, "activityDiagnostic").mockResolvedValue(fixture());
    await root.rerender(<ActivityDiagnostic activityId="owned" generation={1} />);
    await open();
    await click("Copy retained log");
    await click("Copy retained log");
    await act(async () => {
      if (outcome === "success") resolve();
      else reject(new Error("old failure"));
    });
    expect(host.querySelector('[role="status"]')?.textContent).toBe("Retained log copied.");
    expect(host.querySelector('[role="alert"]')).toBeNull();
    expect(read).toHaveBeenCalledTimes(1);
  },
);

it.each(["success", "failure"])(
  "ignores a copy %s from the capture displayed during refresh",
  async (outcome) => {
    let finishRead!: (value: Diagnostic) => void;
    let resolve!: () => void;
    let reject!: (error: Error) => void;
    const next = fixture();
    next[0].stdout.text = "refreshed output";
    const read = vi
      .spyOn(desktopApi, "activityDiagnostic")
      .mockResolvedValueOnce(fixture())
      .mockReturnValueOnce(
        new Promise<Diagnostic>((done) => {
          finishRead = done;
        }),
      );
    vi.mocked(copyText).mockReturnValueOnce(
      new Promise<void>((done, fail) => {
        resolve = done;
        reject = fail;
      }),
    );
    await root.rerender(<ActivityDiagnostic activityId="owned" generation={1} />);
    await open();
    await click("Refresh captured log");
    await click("Copy retained log");
    await act(async () => finishRead(next));
    await act(async () => {
      if (outcome === "success") resolve();
      else reject(new Error("old failure"));
    });
    expect(host.querySelector('[role="status"], [role="alert"]')).toBeNull();
    expect(host.querySelector("textarea")?.value).toBe("refreshed output");
    await click("Copy retained log");
    expect(copyText).toHaveBeenLastCalledWith(JSON.stringify(next, null, 2));
    expect(read).toHaveBeenCalledTimes(2);
  },
);

it.each(["success", "failure"])(
  "ignores a copy %s after the selected activity changes",
  async (outcome) => {
    let resolve!: () => void;
    let reject!: (error: Error) => void;
    vi.mocked(copyText).mockReturnValueOnce(
      new Promise<void>((done, fail) => {
        resolve = done;
        reject = fail;
      }),
    );
    const read = vi.spyOn(desktopApi, "activityDiagnostic").mockResolvedValue(fixture());
    await root.rerender(<ActivityDiagnostic activityId="old" generation={1} />);
    await open();
    await click("Copy retained log");
    await root.rerender(<ActivityDiagnostic activityId="new" generation={2} />);
    await click("Refresh captured log");
    await act(async () => {
      if (outcome === "success") resolve();
      else reject(new Error("old failure"));
    });
    expect(host.querySelector('[role="status"], [role="alert"]')).toBeNull();
    expect(read.mock.calls).toEqual([
      ["old", 1],
      ["new", 2],
    ]);
  },
);

it("shows the preparation log in the current language and keeps captured output verbatim", async () => {
  const { initializeLocalization } = await import("../localization");
  const localization = initializeLocalization(["en-US"]);
  try {
    await localization.changeLanguage("ar-XB");
    const capture = fixture();
    capture[0].stdout = { text: "", observed_bytes: 0, truncated: true };
    capture[0].stderr.text = "{{limit}} literal stderr";
    vi.spyOn(desktopApi, "activityDiagnostic").mockResolvedValue(capture);
    await root.rerender(<ActivityDiagnostic activityId="owned" generation={1} />);
    expect(host.querySelector("summary")?.textContent).toBe("عرض سجل التحضير");
    await open();
    await expect.poll(() => host.querySelector("h4")?.textContent).toBe("إعداد اللعبة");
    expect(host.textContent).toContain("حُذف بعض الإخراج لأنه تجاوز حد الالتقاط البالغ");
    const fields = [...host.querySelectorAll<HTMLTextAreaElement>("textarea")];
    expect(fields.map((field) => field.value)).toEqual([
      "لم يُلتقط أي إخراج قياسي.",
      "{{limit}} literal stderr",
    ]);
    expect([...host.querySelectorAll("button")].map((button) => button.textContent)).toEqual([
      "نسخ السجل المحفوظ",
      "تحديث السجل الملتقط",
    ]);
  } finally {
    await localization.changeLanguage("en");
  }
});

it("keeps retained log recovery and manual copy in the actual Activity task details", async () => {
  await page.viewport(960, 800);
  document.documentElement.dataset.theme = "dark";
  host.id = "root";
  transport = installInteractiveTransport("activity", (message) => {
    throw new Error(message);
  });
  let rejectRefresh!: (value: unknown) => void;
  let resolveRefresh!: (value: Diagnostic) => void;
  const refresh = new Promise<Diagnostic>((resolve, reject) => {
    resolveRefresh = resolve;
    rejectRefresh = reject;
  });
  const capture = fixture();
  capture[0].activity_id = "fixture-retained-harbor";
  const read = vi
    .spyOn(desktopApi, "activityDiagnostic")
    .mockResolvedValueOnce(capture)
    .mockReturnValueOnce(refresh);
  vi.mocked(copyText).mockRejectedValueOnce(new Error("Controlled clipboard refusal."));
  try {
    await root.rerender(
      <LocalizationProvider api={desktopApi}>
        <App />
      </LocalizationProvider>,
    );
    await page
      .getByRole("navigation", { name: "Primary navigation", exact: true })
      .getByRole("button", { name: /^Activity/ })
      .click();
    await expect
      .poll(() => document.querySelector('[data-activity-id="fixture-retained-harbor"]'))
      .not.toBeNull();
    const row = page.elementLocator(
      document.querySelector('[data-activity-id="fixture-retained-harbor"]')!,
    );
    await row.getByText("View preparation log", { exact: true }).click();
    await expect
      .element(row.getByRole("textbox", { name: "Preparation standard output", exact: true }))
      .toHaveValue(capture[0].stdout.text);
    await expect
      .element(row.getByRole("heading", { name: "Game setup", level: 4, exact: true }))
      .toBeVisible();
    await expect
      .element(row.getByRole("heading", { name: "Standard output", level: 5, exact: true }))
      .toBeVisible();
    await expect
      .element(row.getByRole("heading", { name: "Standard error", level: 5, exact: true }))
      .toBeVisible();
    expect(row.element().textContent).toContain("Both output streams ended.");
    expect(row.element().textContent).not.toContain("Running game setup");
    await row.getByRole("button", { name: "Refresh captured log", exact: true }).click();
    await expect
      .element(row.getByRole("button", { name: "Refresh captured log", exact: true }))
      .toBeDisabled();
    const pending = row.getByText(
      "Reading the retained log… Showing the last loaded capture while the current log is checked.",
      { exact: true },
    );
    await expect.element(pending).toBeVisible();
    pending.element().scrollIntoView({ block: "center", inline: "nearest" });
    await captureParityState("activity-app-retained-log-refresh-pending");
    const error = failureReport();
    error.presentation.summary = "The retained log could not be read.";
    await act(async () => rejectRefresh(error));
    const refusal = row.getByText(error.presentation.summary, { exact: true });
    await expect.element(refusal).toBeVisible();
    refusal.element().scrollIntoView({ block: "center", inline: "nearest" });
    await captureParityState("activity-app-retained-log-refresh-refused");
    await page.viewport(430, 780);
    document.documentElement.dataset.theme = "light";
    await row.getByRole("button", { name: "Copy retained log", exact: true }).click();
    const manual = row.getByRole("textbox", { name: "Retained log for manual copy", exact: true });
    await expect.element(manual).toHaveValue(JSON.stringify(capture, null, 2));
    const field = manual.element();
    field.scrollIntoView({ block: "center", inline: "nearest" });
    const bounds = field.getBoundingClientRect();
    expect(bounds.top).toBeGreaterThanOrEqual(0);
    expect(bounds.bottom).toBeLessThanOrEqual(innerHeight);
    expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(innerWidth + 1);
    expect(read.mock.calls).toEqual([
      ["fixture-retained-harbor", 1],
      ["fixture-retained-harbor", 1],
    ]);
    await captureParityState("activity-app-retained-log-manual-copy");
  } finally {
    await act(async () => resolveRefresh(capture));
  }
});
