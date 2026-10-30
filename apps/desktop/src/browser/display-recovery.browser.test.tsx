import { captureParityState } from "../../test/parity-capture";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";
import { cleanup, render } from "vitest-browser-react";
import { AppErrorBoundary } from "../ErrorBoundary";
import { browserFixture } from "../../test/browser-fixture";
import "../styles/index.css";

let fixture: ReturnType<typeof browserFixture>;
beforeEach(() => {
  fixture = browserFixture({ styles: ["font-size"], viewport: true });
  fixture.defer(() => {
    vi.restoreAllMocks();
  });
});
afterEach(async () => {
  await fixture.dispose();
});

function BrokenPanel({ message }: { message: string }): never {
  throw new Error(message);
}

it.each([
  { width: 1280, enlarged: false, long: false },
  { width: 1280, enlarged: false, long: true },
  { width: 576, enlarged: false, long: true },
  { width: 320, enlarged: false, long: true },
  { width: 320, enlarged: true, long: true },
])(
  "keeps recovery reachable at $width pixels (enlarged $enlarged, long $long)",
  async ({ width, enlarged, long }) => {
    await page.viewport(width, 800);
    if (enlarged) document.documentElement.style.fontSize = "200%";
    vi.spyOn(console, "error").mockImplementation(() => {});
    const report = vi.fn();
    const message = long
      ? `Diagnostic identity 42\n${"Long detail ".repeat(3000)}`
      : "Diagnostic identity 42";
    const root = document.createElement("div");
    root.id = "root";
    document.body.append(root);
    fixture.defer(() => root.remove());
    fixture.defer(() => cleanup());
    await render(
      <AppErrorBoundary report={report}>
        <BrokenPanel message={message} />
      </AppErrorBoundary>,
      { container: root },
    );
    expect(report).toHaveBeenCalled();
    const recovery = document.querySelector<HTMLElement>(".bootstrap-recovery")!;
    const reload = page.getByRole("button", { name: "Reload Portcove" });
    const button = recovery.querySelector<HTMLButtonElement>("button")!;
    expect(recovery.querySelector('[role="alert"]')!.contains(button)).toBe(false);
    expect(
      recovery.querySelector('[role="alert"]')!.contains(recovery.querySelector("details")),
    ).toBe(false);
    expect(recovery.scrollWidth).toBeLessThanOrEqual(recovery.clientWidth + 1);
    // The action precedes the bounded diagnostic disclosure, even for enormous errors.
    expect(button.getBoundingClientRect().bottom).toBeLessThan(800);
    const box = button.getBoundingClientRect();
    expect(
      button.contains(document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2)),
    ).toBe(true);
    button.focus();
    await expect.element(reload).toHaveFocus();
    await userEvent.keyboard("{Tab}");
    await expect.element(page.getByText("Display error details", { exact: true })).toHaveFocus();
    await userEvent.keyboard("{Enter}");
    const diagnostics = recovery.querySelector<HTMLTextAreaElement>("textarea")!;
    expect(diagnostics.value).toBe(message);
    await userEvent.keyboard("{Tab}");
    expect(document.activeElement).toBe(diagnostics);
    expect(diagnostics.scrollHeight - diagnostics.clientHeight).toBeGreaterThan(long ? 0 : -1);
    await captureParityState(`error-boundary-${long ? "long" : "short"}-${enlarged ? "200" : "100"}`);
    const endOfDetails = /Mac/u.test(navigator.platform)
      ? "{Meta>}{ArrowDown}{/Meta}"
      : "{Control>}{End}{/Control}";
    await userEvent.keyboard(endOfDetails);
    await expect.poll(() => diagnostics.scrollTop).toBeGreaterThan(long ? 0 : -1);
    await expect
      .poll(() => diagnostics.scrollTop + diagnostics.clientHeight)
      .toBeGreaterThanOrEqual(diagnostics.scrollHeight - 1);
    await userEvent.keyboard("{Shift>}{Tab}{Tab}{/Shift}");
    await expect.element(reload).toHaveFocus();
    expect(button.getBoundingClientRect().bottom).toBeLessThan(800);
  },
);
