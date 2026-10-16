import { afterEach, expect, it } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";
import { cleanup, render } from "vitest-browser-react";
import { Button } from "../components/ui/button";
import { Dialog, DialogContent, DialogTitle } from "../components/ui/dialog";

afterEach(async () => {
  await cleanup();
  document.documentElement.removeAttribute("data-theme");
});
for (const theme of ["dark", "light"]) {
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
