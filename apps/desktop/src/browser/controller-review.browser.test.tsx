import { useRef, useState } from "react";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";
import { Button } from "../components/ui/button";
import { Dialog, DialogContent, DialogTitle } from "../components/ui/dialog";
import { useGamepadNavigation } from "../gamepad";
import "../styles/index.css";

const back = vi.fn();
let pressed: number[] = [];
let root: Root;
let host: HTMLDivElement;

function Fixture({ locked = false, nested = false }: { locked?: boolean; nested?: boolean }) {
  const [open, setOpen] = useState(false);
  const [innerOpen, setInnerOpen] = useState(false);
  const trigger = useRef<HTMLButtonElement>(null);
  const innerTrigger = useRef<HTMLButtonElement>(null);
  useGamepadNavigation(back);
  return (
    <main>
      <Button ref={trigger} onClick={() => setOpen(true)}>
        Review setup
      </Button>
      <Dialog
        open={open}
        onOpenChange={(next, details) => {
          if (locked && !next) details.cancel();
          else setOpen(next);
        }}
      >
        <DialogContent finalFocus={trigger} showCloseButton={false} aria-describedby={undefined}>
          <DialogTitle>Review installation</DialogTitle>
          <Button ref={innerTrigger} onClick={() => setInnerOpen(true)}>
            Review inputs
          </Button>
          {nested && (
            <Dialog open={innerOpen} onOpenChange={setInnerOpen}>
              <DialogContent
                finalFocus={innerTrigger}
                showCloseButton={false}
                aria-describedby={undefined}
              >
                <DialogTitle>Review selected inputs</DialogTitle>
                <Button onClick={() => setInnerOpen(false)}>Cancel input review</Button>
              </DialogContent>
            </Dialog>
          )}
        </DialogContent>
      </Dialog>
    </main>
  );
}

const frames = async (count: number) => {
  for (let index = 0; index < count; index++) await new Promise(requestAnimationFrame);
};
async function pressBack() {
  pressed = [1];
  await frames(2);
  pressed = [];
  await frames(2);
}

beforeEach(async () => {
  pressed = [];
  back.mockClear();
  vi.spyOn(navigator, "getGamepads").mockImplementation(() => [
    {
      id: "Owned controller review adapter",
      index: 0,
      mapping: "standard",
      axes: [0, 0],
      buttons: Array.from({ length: 16 }, (_, index) => ({
        pressed: pressed.includes(index),
        touched: pressed.includes(index),
        value: pressed.includes(index) ? 1 : 0,
      })),
    } as unknown as Gamepad,
  ]);
  host = document.body.appendChild(document.createElement("div"));
  root = createRoot(host);
  await page.viewport(960, 640);
});
afterEach(() => {
  flushSync(() => root.unmount());
  host.remove();
  delete document.documentElement.dataset.inputMode;
  vi.restoreAllMocks();
});

it("controller Back closes the actual review without also invoking workspace Back", async () => {
  flushSync(() => root.render(<Fixture />));
  const trigger = page.getByRole("button", { name: "Review setup", exact: true });
  await userEvent.click(trigger);
  await expect
    .element(page.getByRole("dialog", { name: "Review installation", exact: true }))
    .toBeVisible();
  expect(document.hasFocus()).toBe(true);
  await pressBack();
  await expect
    .element(page.getByRole("dialog", { name: "Review installation", exact: true }))
    .not.toBeInTheDocument();
  expect(back).not.toHaveBeenCalled();
  await expect.element(trigger).toHaveFocus();
  await pressBack();
  expect(back).toHaveBeenCalledOnce();
});

it("an actual controlled review which declines dismissal still owns controller Back", async () => {
  flushSync(() => root.render(<Fixture locked />));
  await userEvent.click(page.getByRole("button", { name: "Review setup", exact: true }));
  const review = page.getByRole("dialog", { name: "Review installation", exact: true });
  await expect.element(review).toBeVisible();
  await pressBack();
  await expect.element(review).toBeVisible();
  expect(back).not.toHaveBeenCalled();
});

it("controller Back dismisses only the topmost actual nested review", async () => {
  flushSync(() => root.render(<Fixture nested />));
  await userEvent.click(page.getByRole("button", { name: "Review setup", exact: true }));
  const inputTrigger = page.getByRole("button", { name: "Review inputs", exact: true });
  await userEvent.click(inputTrigger);
  await expect
    .element(page.getByRole("dialog", { name: "Review selected inputs", exact: true }))
    .toBeVisible();
  await pressBack();
  await expect
    .element(page.getByRole("dialog", { name: "Review selected inputs", exact: true }))
    .not.toBeInTheDocument();
  await expect
    .element(page.getByRole("dialog", { name: "Review installation", exact: true }))
    .toBeVisible();
  await expect.element(inputTrigger).toHaveFocus();
  expect(back).not.toHaveBeenCalled();
});
