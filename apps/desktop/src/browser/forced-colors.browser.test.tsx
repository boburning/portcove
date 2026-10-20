import { afterEach, expect, it } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";
import { cleanup, render } from "vitest-browser-react";
import { Button } from "../components/ui/button";
import { Dialog, DialogContent, DialogTitle } from "../components/ui/dialog";
import { ChoiceSelect } from "../components/ChoiceSelect";

afterEach(async () => {
  await cleanup();
  document.documentElement.removeAttribute("data-theme");
});
for (const theme of ["dark", "light"]) {
  it(`distinguishes ${theme} selection from focus in forced colors`, async () => {
    document.documentElement.dataset.theme = theme;
    await render(
      <>
        <Button variant="selected" aria-pressed>
          All
        </Button>
        <Button variant="outline" aria-pressed={false}>
          Ready
        </Button>
      </>,
    );
    const selected = page.getByRole("button", { name: "All", exact: true });
    const ordinary = page.getByRole("button", { name: "Ready", exact: true });
    expect(getComputedStyle(selected.element(), "::after").borderTopStyle).toBe("double");
    expect(
      parseFloat(getComputedStyle(selected.element(), "::after").borderTopWidth),
    ).toBeGreaterThanOrEqual(3);
    expect(getComputedStyle(ordinary.element(), "::after").borderTopStyle).not.toBe("double");
    await userEvent.tab();
    await expect.element(selected).toHaveFocus();
    expect(getComputedStyle(selected.element()).outlineStyle).not.toBe("none");
  });
  it(`respects actual reduced motion for ${theme} controls and portaled popups`, async () => {
    expect(matchMedia("(prefers-reduced-motion: reduce)").matches).toBe(true);
    document.documentElement.dataset.theme = theme;
    await render(
      <Dialog open>
        <DialogContent>
          <DialogTitle>Review installation</DialogTitle>
          <Button>Continue</Button>
          <ChoiceSelect
            label="Release"
            value="stable"
            onChange={() => {}}
            options={[
              { value: "stable", label: "Stable" },
              { value: "beta", label: "Preview" },
            ]}
          />
        </DialogContent>
      </Dialog>,
    );
    await expect.element(page.getByRole("dialog")).toBeVisible();
    for (const element of [
      page.getByRole("dialog").element(),
      page.getByRole("button", { name: "Continue", exact: true }).element(),
    ])
      expect(getComputedStyle(element).transitionProperty).toBe("none");
    await page.getByRole("combobox", { name: "Release Stable" }).click();
    await expect.element(page.getByRole("option", { name: "Preview", exact: true })).toBeVisible();
    expect(
      getComputedStyle(document.querySelector('[data-slot="select-content"]')!).transitionProperty,
    ).toBe("none");
    await userEvent.keyboard("{Escape}");
    await expect.element(page.getByRole("combobox", { name: "Release Stable" })).toHaveFocus();
  });
  it(`keeps ${theme} keyboard focus visible in actual forced colors`, async () => {
    expect(matchMedia("(forced-colors: active)").matches).toBe(true);
    document.documentElement.dataset.theme = theme;
    await render(<Button variant="destructive">Remove</Button>);
    await userEvent.tab();
    const button = page.getByRole("button", { name: "Remove" });
    await expect.element(button).toHaveFocus();
    const style = getComputedStyle(button.element());
    expect(style.outlineStyle).not.toBe("none");
    expect(parseFloat(style.outlineWidth)).toBeGreaterThanOrEqual(2);
    expect(style.outlineColor).not.toBe(style.backgroundColor);
    await cleanup();
    await render(
      <Dialog open>
        <DialogContent>
          <DialogTitle>Review removal</DialogTitle>
        </DialogContent>
      </Dialog>,
    );
    const dialogStyle = getComputedStyle(page.getByRole("dialog").element());
    expect(dialogStyle.outlineStyle).not.toBe("none");
    expect(parseFloat(dialogStyle.outlineWidth)).toBeGreaterThanOrEqual(1);
  });
}
