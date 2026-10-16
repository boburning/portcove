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

// The current-build guard rejects this if test source discovery leaks into shipping CSS.
const discoverySentinel = <span className="w-[12345px]" />;

afterEach(async () => {
  await cleanup();
  document.documentElement.removeAttribute("data-theme");
  document.documentElement.removeAttribute("dir");
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
  expect(getComputedStyle(pending.element()).minHeight).toBe("36px");
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
