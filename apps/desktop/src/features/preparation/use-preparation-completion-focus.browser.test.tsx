import { useRef } from "react";
import { afterEach, expect, it } from "vite-plus/test";
import { page } from "vite-plus/test/browser";
import { cleanup, render } from "vitest-browser-react";
import { usePreparationCompletionFocus } from "./use-preparation-completion-focus";

afterEach(cleanup);
function Owner({
  busy,
  prepared = false,
  modal = false,
  identity = "sample:1",
}: {
  busy: boolean;
  prepared?: boolean;
  modal?: boolean;
  identity?: string;
}) {
  const owner = useRef<HTMLElement>(null);
  const heading = useRef<HTMLHeadingElement>(null);
  const completed = usePreparationCompletionFocus({ owner, nextStep: heading, identity, busy });
  return (
    <>
      <button>Another game</button>
      <section ref={owner} data-task-owner={identity}>
        <h2 ref={heading} tabIndex={-1}>
          Next step
        </h2>
        {!prepared && (
          <div className="preparation-control">
            <button onClick={completed}>Complete owned preparation</button>
          </div>
        )}
        {prepared && (
          <button data-launch-action disabled={busy}>
            Play
          </button>
        )}
      </section>
      {modal && (
        <div role="dialog" aria-modal="true" aria-labelledby="preparation-review-title">
          <h2 id="preparation-review-title">Closing preparation review</h2>
        </div>
      )}
    </>
  );
}
it("waits for readback settlement after prepared status removes the old control", async () => {
  const screen = await render(<Owner busy />);
  await page.getByRole("button", { name: "Complete owned preparation" }).click();
  await screen.rerender(<Owner busy prepared />);
  await expect.element(page.getByRole("button", { name: "Play" })).toBeDisabled();
  await screen.rerender(<Owner busy={false} prepared />);
  await expect.element(page.getByRole("button", { name: "Play" })).toHaveFocus();
});
it("waits for popup teardown instead of consuming the completion intent", async () => {
  const screen = await render(<Owner busy modal />);
  await page.getByRole("button", { name: "Complete owned preparation" }).click();
  await screen.rerender(<Owner busy={false} prepared modal />);
  await expect.element(page.getByRole("dialog")).toBeVisible();
  await screen.rerender(<Owner busy={false} prepared />);
  await expect.element(page.getByRole("button", { name: "Play" })).toHaveFocus();
});
it("retains deliberate navigation while readback settles", async () => {
  const screen = await render(<Owner busy />);
  await page.getByRole("button", { name: "Complete owned preparation" }).click();
  await screen.rerender(<Owner busy prepared />);
  await page.getByRole("button", { name: "Another game" }).click();
  await screen.rerender(<Owner busy={false} prepared />);
  await expect.element(page.getByRole("button", { name: "Another game" })).toHaveFocus();
});
it("does not hand an outgoing library's completion to its replacement", async () => {
  const screen = await render(<Owner busy />);
  await page.getByRole("button", { name: "Complete owned preparation" }).click();
  await screen.rerender(<Owner busy={false} prepared identity="sample:2" />);
  await screen.rerender(<Owner busy={false} prepared identity="sample:1" />);
  await expect.element(page.getByRole("button", { name: "Play" })).not.toHaveFocus();
});

it("cancels the pending handoff when another modal takes focus", async () => {
  const screen = await render(<Owner busy />);
  await page.getByRole("button", { name: "Complete owned preparation" }).click();
  const other = document.createElement("div");
  other.setAttribute("role", "dialog");
  other.setAttribute("aria-modal", "true");
  other.tabIndex = -1;
  other.textContent = "Another task review";
  document.body.append(other);
  other.focus();
  await expect.poll(() => document.activeElement).toBe(other);
  // Let the real focus observer process the unrelated scope before closing it.
  await new Promise(requestAnimationFrame);
  other.remove();
  await screen.rerender(<Owner busy={false} prepared />);
  await expect.element(page.getByRole("button", { name: "Play" })).not.toHaveFocus();
});
