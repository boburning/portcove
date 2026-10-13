import { DirectionProvider } from "@base-ui/react/direction-provider";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { page, userEvent } from "vitest/browser";
import { desktopApi } from "../api";
import { copyText } from "../clipboard";
import { ActivityDiagnostic } from "../components/ActivityDiagnostic";
import { FailureDetails } from "../components/FailureDetails";
import { failureReport } from "../test-fixtures";
import type { ActivityDiagnostic as Diagnostic } from "../types";
import { failurePresentation } from "../view-model";
import "../styles.css";

vi.mock("../clipboard", () => ({ copyText: vi.fn() }));
vi.mock("../api", () => ({ desktopApi: { activityDiagnostic: vi.fn() } }));

let root: Root;
let host: HTMLDivElement;
beforeEach(() => {
  host = document.body.appendChild(document.createElement("div"));
  root = createRoot(host);
  vi.mocked(copyText).mockReset().mockResolvedValue(undefined);
  vi.mocked(desktopApi.activityDiagnostic).mockReset();
});
afterEach(() => {
  flushSync(() => root.unmount());
  host.remove();
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
  expect(field.value).toBe(vi.mocked(copyText).mock.calls[0][0]);
  await expect
    .element(page.getByText("The change was saved. Check the result before trying again."))
    .toBeVisible();
  await userEvent.click(page.getByRole("button", { name: "Copy technical details", exact: true }));
  await expect.element(page.getByRole("status")).toHaveTextContent("Technical details copied.");
  await expect.element(details).not.toBeInTheDocument();

  await userEvent.click(page.getByText("View preparation log", { exact: true }));
  await expect
    .element(page.getByRole("textbox", { name: "Preparation standard output" }))
    .toHaveValue(capture[0].stdout.text);
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
  expect(vi.mocked(copyText).mock.calls[2][0]).toBe(logField.value);
  await userEvent.click(page.getByRole("button", { name: "Copy retained log", exact: true }));
  await expect.element(page.getByText("Retained log copied.", { exact: true })).toBeVisible();
  await expect.element(log).not.toBeInTheDocument();
  expect(desktopApi.activityDiagnostic).toHaveBeenCalledTimes(1);
  expect(desktopApi.activityDiagnostic).toHaveBeenCalledWith("browser-activity", 1);
  expect(host.textContent).not.toContain("private clipboard transport failure");
});
