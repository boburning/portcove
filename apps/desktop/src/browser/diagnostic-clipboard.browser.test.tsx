import { fixtureValue } from "../test-fixtures";
import { DirectionProvider } from "@base-ui/react/direction-provider";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";
import { desktopApi } from "../api";
import { copyText } from "../clipboard";
import { ActivityDiagnostic } from "../components/ActivityDiagnostic";
import { FailureDetails } from "../components/FailureDetails";
import { failureReport } from "../test-fixtures";
import type { ActivityDiagnostic as Diagnostic } from "../types";
import { failurePresentation } from "../view-model";
import "../styles/index.css";

vi.mock("../clipboard", () => ({ copyText: vi.fn() }));
vi.mock("../api", () => ({ desktopApi: { activityDiagnostic: vi.fn() } }));

let root: Root;
let host: HTMLDivElement;
beforeEach(async () => {
  await page.viewport(1280, 800);
  host = document.body.appendChild(document.createElement("div"));
  root = createRoot(host);
  vi.mocked(copyText).mockReset().mockResolvedValue(undefined);
  vi.mocked(desktopApi.activityDiagnostic).mockReset();
});
afterEach(() => {
  flushSync(() => root.unmount());
  host.remove();
  document.documentElement.removeAttribute("data-theme");
  document.querySelector("#diagnostic-spacing-override")?.remove();
});

it("announces diagnostic copy outcomes and offers exact selectable fallback without another read", async () => {
  const presentation = failurePresentation(failureReport())!;
  presentation.mutation_state = "committed";
  const capture: Diagnostic = [
    {
      activity_id: "browser-activity",
      phase: "preparation.setup",
      complete: false,
      updated_at: 1,
      stream_limit_bytes: 1024,
      stdout: { text: "retained redacted output", observed_bytes: 24, truncated: false },
      stderr: { text: "retained safe reason", observed_bytes: 20, truncated: false },
    },
  ];
  vi.mocked(desktopApi.activityDiagnostic).mockResolvedValue(capture);
  vi.mocked(copyText)
    .mockRejectedValueOnce(new Error("private clipboard transport failure"))
    .mockResolvedValueOnce(undefined)
    .mockRejectedValueOnce(new Error("private clipboard transport failure"));
  flushSync(() =>
    root.render(
      <DirectionProvider direction="ltr">
        <FailureDetails
          presentation={presentation}
          code="conflict"
          contextLabel={() => "Context"}
        />
        <ActivityDiagnostic activityId="browser-activity" generation={1} />
      </DirectionProvider>,
    ),
  );
  await userEvent.click(page.getByText("View technical details", { exact: true }));
  await userEvent.click(page.getByRole("button", { name: "Copy technical details", exact: true }));
  await expect
    .element(page.getByRole("alert"))
    .toHaveTextContent("Clipboard unavailable. Select and copy the technical details below.");
  const details = page.getByRole("textbox", { name: "Technical details for manual copy" });
  await expect.element(details).toBeVisible();
  const field = details.element() as HTMLTextAreaElement;
  expect(field.readOnly).toBe(true);
  field.focus();
  field.select();
  expect(field.selectionStart).toBe(0);
  expect(field.selectionEnd).toBe(field.value.length);
  expect(field.value).toBe(
    fixtureValue(vi.mocked(copyText).mock.calls[0], "vi.mocked(copyText).mock.calls[0]")[0],
  );
  await expect
    .element(page.getByText("The change was saved. Check the result before trying again."))
    .toBeVisible();
  await userEvent.click(page.getByRole("button", { name: "Copy technical details", exact: true }));
  await expect.element(page.getByRole("status")).toHaveTextContent("Technical details copied.");
  await expect.element(details).not.toBeInTheDocument();

  await userEvent.click(page.getByText("View preparation log", { exact: true }));
  await expect
    .element(page.getByRole("textbox", { name: "Preparation standard output" }))
    .toHaveValue(fixtureValue(capture[0], "capture[0]").stdout.text);
  await userEvent.click(page.getByRole("button", { name: "Copy retained log", exact: true }));
  await expect
    .element(page.getByRole("alert"))
    .toHaveTextContent("Clipboard unavailable. Select and copy the retained log below.");
  const log = page.getByRole("textbox", { name: "Retained log for manual copy" });
  await expect.element(log).toHaveValue(JSON.stringify(capture, null, 2));
  const logField = log.element() as HTMLTextAreaElement;
  expect(logField.readOnly).toBe(true);
  logField.focus();
  logField.select();
  expect(logField.selectionEnd - logField.selectionStart).toBe(logField.value.length);
  expect(
    fixtureValue(vi.mocked(copyText).mock.calls[2], "vi.mocked(copyText).mock.calls[2]")[0],
  ).toBe(logField.value);
  await userEvent.click(page.getByRole("button", { name: "Copy retained log", exact: true }));
  await expect.element(page.getByText("Retained log copied.", { exact: true })).toBeVisible();
  await expect.element(log).not.toBeInTheDocument();
  expect(desktopApi.activityDiagnostic).toHaveBeenCalledTimes(1);
  expect(desktopApi.activityDiagnostic).toHaveBeenCalledWith("browser-activity", 1);
  expect(host.textContent).not.toContain("private clipboard transport failure");
});

for (const theme of ["dark", "light"]) {
  it(`keeps long ${theme} diagnostics selectable at 320px with text spacing`, async () => {
    await page.viewport(320, 800);
    document.documentElement.dataset.theme = theme;
    const spacing = document.createElement("style");
    spacing.id = "diagnostic-spacing-override";
    spacing.textContent =
      "*{line-height:1.5!important;letter-spacing:.12em!important;word-spacing:.16em!important}p{margin-bottom:2em!important}";
    document.head.append(spacing);
    const text = `C:\\Owned files\\保存\\${"long-unbroken-value".repeat(32)}\n${"retained output\n".repeat(50)}`;
    const capture: Diagnostic = [
      {
        activity_id: "narrow-diagnostic",
        phase: "preparation.setup",
        complete: false,
        updated_at: 1,
        stream_limit_bytes: 16384,
        stdout: { text, observed_bytes: text.length, truncated: false },
        stderr: { text: "Retained error", observed_bytes: 14, truncated: false },
      },
    ];
    vi.mocked(desktopApi.activityDiagnostic).mockResolvedValue(capture);
    vi.mocked(copyText).mockRejectedValue(new Error("clipboard unavailable"));
    flushSync(() =>
      root.render(
        <DirectionProvider direction="ltr">
          <FailureDetails presentation={failurePresentation(failureReport())!} />
          <ActivityDiagnostic activityId="narrow-diagnostic" generation={1} />
        </DirectionProvider>,
      ),
    );
    await userEvent.click(page.getByText("View technical details", { exact: true }));
    await userEvent.click(
      page.getByRole("button", { name: "Copy technical details", exact: true }),
    );
    await userEvent.click(page.getByText("View preparation log", { exact: true }));
    await expect
      .element(page.getByRole("textbox", { name: "Preparation standard output", exact: true }))
      .toHaveValue(text);
    await userEvent.click(page.getByRole("button", { name: "Copy retained log", exact: true }));
    for (const label of [
      "Technical details for manual copy",
      "Preparation standard output",
      "Preparation standard error",
      "Retained log for manual copy",
    ]) {
      const field = page.getByRole("textbox", { name: label, exact: true });
      const element = field.element() as HTMLTextAreaElement;
      element.focus();
      await userEvent.keyboard("{Control>}a{/Control}");
      await expect.element(field).toHaveFocus();
      expect(element.selectionEnd - element.selectionStart).toBe(element.value.length);
      expect(element.readOnly).toBe(true);
      expect(element.scrollWidth).toBeLessThanOrEqual(element.clientWidth + 1);
      expect(element.getBoundingClientRect().right).toBeLessThanOrEqual(innerWidth);
      expect(getComputedStyle(element).outlineStyle).not.toBe("none");
      expect(getComputedStyle(element).overflowY).toBe("auto");
    }
    expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(innerWidth);
    expect(desktopApi.activityDiagnostic).toHaveBeenCalledTimes(1);
    expect(
      (
        page
          .getByRole("textbox", { name: "Preparation standard output" })
          .element() as HTMLTextAreaElement
      ).value,
    ).toBe(text);
  });
}
