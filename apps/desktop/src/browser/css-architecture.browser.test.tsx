import { createRef, useState } from "react";
import { afterEach, expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";
import { cleanup, render } from "vitest-browser-react/pure";
import { DirectionProvider } from "@base-ui/react/direction-provider";
import { Field } from "@base-ui/react/field";
import { Button } from "../components/ui/button";
import { Input } from "../components/ui/input";
import { Dialog, DialogContent, DialogTitle, DialogTrigger } from "../components/ui/dialog";
import { ChoiceSelect } from "../components/ChoiceSelect";
import { StatusLayer } from "../components/Chrome";
import { Notice } from "../components/ui/patterns";
import { DesignCompatibilityFixture } from "../design-compatibility/DesignCompatibilityFixture";

// The current-build guard rejects this if test source discovery leaks into shipping CSS.
const discoverySentinel = <span className="w-[12345px]" />;

it("lets a distinct Escape close the fixture dialog while its nested select is still exiting", async () => {
  const style = document.createElement("style");
  style.textContent = '[data-slot="select-content"] { transition: opacity 2s linear !important; }';
  const paused: Animation[] = [];
  let popup: HTMLElement | null = null;
  const pauseClosing = (event: TransitionEvent) => {
    if (
      event.target !== popup ||
      event.propertyName !== "opacity" ||
      !popup?.hasAttribute("data-ending-style")
    )
      return;
    for (const animation of popup.getAnimations()) {
      animation.pause();
      paused.push(animation);
    }
  };
  document.addEventListener("transitionrun", pauseClosing);
  try {
    await render(<DesignCompatibilityFixture />);
    const opener = page.getByRole("button", { name: "Review install", exact: true });
    await opener.click();
    const trigger = page.getByRole("combobox", { name: "Release channel", exact: true });
    await trigger.click();
    popup = document.querySelector<HTMLElement>('[data-slot="select-content"]')!;
    await expect.poll(() => getComputedStyle(popup!).opacity).toBe("1");
    document.head.appendChild(style);
    expect(getComputedStyle(popup).transitionProperty).toBe("opacity");
    await userEvent.keyboard("{Escape}");
    await expect.poll(() => paused.length).toBeGreaterThan(0);
    const fixture = document.querySelector<HTMLElement>(".design-compatibility-fixture")!;
    expect(fixture.dataset.selectOpen).toBe("false");
    expect(fixture.dataset.dialogOpen).toBe("true");
    expect(popup.isConnected).toBe(true);
    expect(popup.hasAttribute("data-ending-style")).toBe(true);
    expect(paused.every((animation) => animation.playState === "paused")).toBe(true);
    // Isolate a distinct key event while completion is pending; this does not claim natural focus return.
    trigger.element().focus();
    await expect.element(trigger).toHaveFocus();
    await userEvent.keyboard("{Escape}");
    await expect.poll(() => fixture.dataset.dialogOpen).toBe("false");
    await expect.element(opener).toHaveFocus();
  } finally {
    document.removeEventListener("transitionrun", pauseClosing);
    for (const animation of paused) animation.cancel();
    style.remove();
  }
});

it("keeps measured progress stationary and reserves the sweep for unknown progress", async () => {
  const screen = await render(
    <StatusLayer
      busy="install"
      clearError={() => {}}
      operation={{
        schema_version: 2,
        parent_operation_id: null,
        target: null,
        operation_id: "css-progress",
        sequence: 1,
        timestamp_ms: 1,
        operation: "install",
        type: "progress",
        phase: "install",
        completed: 1,
        total: 2,
      }}
    />,
  );
  const track = page.getByRole("progressbar").element();
  const fill = track.querySelector("i")!;
  expect(getComputedStyle(fill).animationName).toBe("none");
  expect(fill.getBoundingClientRect().width / track.clientWidth).toBeCloseTo(0.5, 1);
  await screen.rerender(<StatusLayer busy="install" clearError={() => {}} />);
  expect(
    getComputedStyle(page.getByRole("progressbar").element().querySelector("i")!).animationName,
  ).toBe("pc-progress");
});

it.each([320, 196])(
  "wraps notice actions within %spx without stealing the body column",
  async (width) => {
    await render(
      <div style={{ width }}>
        <Notice intent="info">
          <span data-slot="notice-icon">!</span>
          <div data-slot="notice-body">A useful update description with enough room to read.</div>
          <div data-slot="notice-actions">
            <Button>Review options</Button>
            <Button>Dismiss</Button>
          </div>
        </Notice>
      </div>,
    );
    const notice = document.querySelector<HTMLElement>('[data-slot="notice"]')!;
    const body = notice.querySelector<HTMLElement>('[data-slot="notice-body"]')!;
    const actions = notice.querySelector<HTMLElement>('[data-slot="notice-actions"]')!;
    expect(body.clientWidth).toBeGreaterThan(width - 100);
    expect(actions.getBoundingClientRect().top).toBeGreaterThan(body.getBoundingClientRect().top);
    expect(notice.scrollWidth).toBeLessThanOrEqual(notice.clientWidth);
  },
);

afterEach(async () => {
  await cleanup();
  document.documentElement.removeAttribute("data-theme");
  document.documentElement.removeAttribute("dir");
});

it("reverses a closing dialog when controlled application state reopens it", async () => {
  const interrupted: string[] = [];
  let armed = true;
  function Review() {
    const [open, setOpen] = useState(false);
    return (
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogTrigger render={<Button />}>Review again</DialogTrigger>
        <DialogContent
          onTransitionRun={(event) => {
            if (!open && armed && event.nativeEvent.propertyName === "opacity") {
              armed = false;
              interrupted.push(getComputedStyle(event.currentTarget).opacity);
              setOpen(true);
            }
          }}
        >
          <DialogTitle>Interrupted review</DialogTitle>
          <Button onClick={() => setOpen(false)}>Close and reopen</Button>
        </DialogContent>
      </Dialog>
    );
  }
  await render(<Review />);
  const trigger = page.getByRole("button", { name: "Review again", exact: true });
  await trigger.click();
  await expect.element(page.getByRole("dialog", { name: "Interrupted review" })).toBeVisible();
  await expect
    .poll(
      () =>
        getComputedStyle(page.getByRole("dialog", { name: "Interrupted review" }).element())
          .opacity,
    )
    .toBe("1");
  const motionStyle = getComputedStyle(
    page.getByRole("dialog", { name: "Interrupted review" }).element(),
  );
  expect(motionStyle.transitionProperty).toContain("opacity");
  expect(Number.parseFloat(motionStyle.transitionDuration)).toBeGreaterThan(0);
  await page.getByRole("button", { name: "Close and reopen", exact: true }).click();
  await expect.poll(() => interrupted.length).toBe(1);
  expect(Number(interrupted[0])).toBeGreaterThan(0);
  const popup = page.getByRole("dialog", { name: "Interrupted review" });
  await expect.element(popup).toBeVisible();
  await expect.poll(() => getComputedStyle(popup.element()).opacity).toBe("1");
  await userEvent.keyboard("{Escape}");
  await expect.element(trigger).toHaveFocus();
});

it("preserves Base UI class callbacks, render composition, refs and inert pending actions", async () => {
  const activate = vi.fn();
  const ref = createRef<HTMLButtonElement>();
  const screen = await render(
    <>
      {discoverySentinel}
      <Button
        ref={ref}
        onClick={activate}
        className={(state) => (state.disabled ? "resolved-disabled" : "resolved-enabled")}
        render={(props, state) => <button {...props} data-resolved-disabled={state.disabled} />}
      >
        Compose
      </Button>
    </>,
  );
  const button = page.getByRole("button", { name: "Compose" });
  expect(ref.current).toBe(button.element());
  await expect.element(button).toHaveClass("resolved-enabled");
  await button.click();
  expect(activate).toHaveBeenCalledOnce();
  await screen.rerender(
    <Button
      aria-busy
      onClick={activate}
      className={(state) => (state.disabled ? "resolved-disabled" : undefined)}
    >
      Saving
    </Button>,
  );
  const pending = page.getByRole("button", { name: "Saving" });
  await expect.element(pending).toBeDisabled();
  await expect.element(pending).toHaveClass("resolved-disabled");
  expect(getComputedStyle(pending.element()).minHeight).toBe("40px");
});

it("receives Field invalid state and preserves caller input refs and handlers", async () => {
  const change = vi.fn();
  const ref = createRef<HTMLInputElement>();
  await render(
    <Field.Root invalid>
      <Field.Label>Install folder</Field.Label>
      <Input
        ref={ref}
        className={(state) => (state.valid === false ? "resolved-invalid" : undefined)}
        onChange={change}
      />
      <Field.Error match>Choose a writable folder.</Field.Error>
    </Field.Root>,
  );
  const input = page.getByRole("textbox", { name: "Install folder" });
  await expect.element(input).toHaveAttribute("aria-invalid", "true");
  await expect.element(input).toHaveClass("resolved-invalid");
  expect(ref.current).toBe(input.element());
  await userEvent.fill(input, "E:\\Games\\A long folder");
  expect(change).toHaveBeenCalled();
  const style = getComputedStyle(input.element());
  expect(style.outlineStyle).not.toBe("none");
  expect(Number.parseFloat(style.outlineWidth)).toBeGreaterThanOrEqual(3);
});

for (const theme of ["dark", "light"] as const)
  for (const direction of ["ltr", "rtl"] as const) {
    it(`keeps actual ${theme}/${direction} nested portals above their parent and returns focus in order`, async () => {
      document.documentElement.dataset.theme = theme;
      document.documentElement.dir = direction;
      await page.viewport(960, 640);
      function Review() {
        const [choice, setChoice] = useState("stable");
        return (
          <DirectionProvider direction={direction}>
            <Dialog>
              <DialogTrigger render={<Button />}>Review installation</DialogTrigger>
              <DialogContent>
                <DialogTitle>Install Harbor Adventure</DialogTitle>
                <Dialog>
                  <DialogTrigger render={<Button />}>Review source</DialogTrigger>
                  <DialogContent>
                    <DialogTitle>Choose source</DialogTitle>
                    <ChoiceSelect
                      label="Release"
                      value={choice}
                      onChange={setChoice}
                      options={[
                        { value: "stable", label: "Stable" },
                        {
                          value: "beta",
                          label: "Preview with a complete decision-critical source qualifier",
                        },
                      ]}
                    />
                  </DialogContent>
                </Dialog>
              </DialogContent>
            </Dialog>
          </DirectionProvider>
        );
      }
      await render(<Review />);
      const outer = page.getByRole("button", { name: "Review installation", exact: true });
      await outer.click();
      const inner = page.getByRole("button", { name: "Review source", exact: true });
      await inner.click();
      const trigger = page.getByRole("combobox", { name: "Release Stable", exact: true });
      await trigger.click();
      const option = page.getByRole("option", {
        name: "Preview with a complete decision-critical source qualifier",
        exact: true,
      });
      await expect.element(option).toBeVisible();
      const bounds = option.element().getBoundingClientRect();
      expect(
        document
          .elementFromPoint(bounds.left + bounds.width / 2, bounds.top + bounds.height / 2)
          ?.closest('[data-slot="select-content"]'),
      ).not.toBeNull();
      expect(getComputedStyle(option.element()).direction).toBe(direction);
      await userEvent.keyboard("{Escape}");
      await expect.element(trigger).toHaveFocus();
      await expect
        .element(page.getByRole("dialog", { name: "Choose source", exact: true }))
        .toBeVisible();
      await userEvent.keyboard("{Escape}");
      await expect.element(inner).toHaveFocus();
      await userEvent.keyboard("{Escape}");
      await expect.element(outer).toHaveFocus();
    });
  }
