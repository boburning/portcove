import { afterEach, expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";
import { render, cleanup } from "vitest-browser-react";
import { Button } from "../components/ui/button";
import { Dialog, DialogContent, DialogTitle } from "../components/ui/dialog";

// Let the browser resolve CSS colors (including color-mix), rather than
// duplicating a CSS color parser in the repository.
function rgba(color: string) {
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = 1;
  const context = canvas.getContext("2d")!;
  context.fillStyle = color;
  context.fillRect(0, 0, 1, 1);
  return [...context.getImageData(0, 0, 1, 1).data];
}
function luminance(color: number[]) {
  const [red, green, blue] = color.slice(0, 3).map((value) => {
    const channel = value / 255;
    return channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * red! + 0.7152 * green! + 0.0722 * blue!;
}
function paintedColor(element: Element, foreground?: string) {
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = 1;
  const context = canvas.getContext("2d")!;
  context.fillStyle = "white";
  context.fillRect(0, 0, 1, 1);
  const ancestors: Element[] = [];
  for (let current: Element | null = element; current; current = current.parentElement)
    ancestors.unshift(current);
  for (const ancestor of ancestors) {
    context.fillStyle = getComputedStyle(ancestor).backgroundColor;
    context.fillRect(0, 0, 1, 1);
  }
  if (foreground) {
    context.fillStyle = foreground;
    context.fillRect(0, 0, 1, 1);
  }
  return [...context.getImageData(0, 0, 1, 1).data];
}
function controlFailures(button: Element) {
  const style = getComputedStyle(button);
  const foreground = luminance(paintedColor(button, style.color));
  const background = luminance(paintedColor(button));
  const contrast =
    (Math.max(foreground, background) + 0.05) / (Math.min(foreground, background) + 0.05);
  const focus = rgba(style.getPropertyValue("--color-focus"));
  const outline = rgba(style.outlineColor);
  return [
    ...(contrast >= 4.5 ? [] : ["control text contrast"]),
    ...(JSON.stringify(outline) === JSON.stringify(focus) ? [] : ["semantic focus color"]),
    ...(style.outlineStyle !== "none" &&
    Number.parseFloat(style.outlineWidth) >= 3 &&
    Number.parseFloat(style.outlineOffset) >= 3
      ? []
      : ["visible focus geometry"]),
  ];
}
function overlayFailures(overlay: Element) {
  const style = getComputedStyle(overlay);
  return [
    ...(style.backdropFilter === "none" ? [] : ["backdrop blur"]),
    ...(style.backgroundImage === "none" &&
    JSON.stringify(rgba(style.backgroundColor)) ===
      JSON.stringify(rgba(style.getPropertyValue("--color-bg-overlay")))
      ? []
      : ["semantic scrim"]),
  ];
}

afterEach(async () => {
  await cleanup();
  document.documentElement.removeAttribute("data-theme");
  document.documentElement.removeAttribute("dir");
});
for (const theme of ["dark", "light"] as const) {
  it(`retains the ${theme} bundled font, bounded transitions and pressed action feedback`, async () => {
    document.documentElement.dataset.theme = theme;
    await render(
      <>
        <Button variant="primary">Play</Button>
        <Button variant="ghost">Neutral</Button>
        <Button variant="selected">Selected</Button>
      </>,
    );
    await document.fonts.ready;
    const play = page.getByRole("button", { name: "Play", exact: true }).element();
    expect(getComputedStyle(play).fontFamily.split(",")[0]?.replaceAll('"', "")).toBe(
      "Geist Variable",
    );
    expect(document.fonts.check('14px "Geist Variable"')).toBe(true);
    const transitions = getComputedStyle(play)
      .transitionProperty.split(",")
      .map((value) => value.trim());
    expect(transitions).not.toContain("all");
    for (const property of ["color", "background-color", "border-color", "box-shadow", "transform"])
      expect(transitions).toContain(property);
    for (const [name, token] of [
      ["Play", "--color-primary-active"],
      ["Neutral", "--color-bg-active"],
      ["Selected", "--color-interactive-active"],
    ] as const) {
      const action = page.getByRole("button", { name, exact: true });
      await userEvent.tab();
      await expect.element(action).toHaveFocus();
      await userEvent.keyboard("{Space>}");
      try {
        await expect
          .poll(() => rgba(getComputedStyle(action.element()).backgroundColor))
          .toEqual(rgba(getComputedStyle(action.element()).getPropertyValue(token)));
        await expect
          .poll(() => {
            const style = getComputedStyle(action.element());
            return (
              (Number.parseFloat(style.translate.split(" ")[1] ?? "0") || 0) +
              new DOMMatrixReadOnly(style.transform === "none" ? undefined : style.transform).m42
            );
          })
          .toBe(1);
      } finally {
        await userEvent.keyboard("{/Space}");
      }
    }
  });
  it(`renders ${theme} semantic controls with keyboard focus and inert pending/disabled actions`, async () => {
    document.documentElement.dataset.theme = theme;
    const activate = vi.fn();
    await render(
      <>
        <Button variant="primary">Play</Button>
        <Button variant="destructive">Remove</Button>
        <Button disabled onClick={activate}>
          Unavailable
        </Button>
        <Button aria-busy="true" onClick={activate}>
          Saving
        </Button>
      </>,
    );
    const play = document.querySelector<HTMLButtonElement>('button[data-variant="primary"]')!;
    const remove = document.querySelector<HTMLButtonElement>('button[data-variant="destructive"]')!;
    const pending = page.getByRole("button", { name: "Saving" });
    expect(getComputedStyle(play).backgroundColor).not.toBe("rgba(0, 0, 0, 0)");
    expect(getComputedStyle(remove).color).not.toBe(getComputedStyle(remove).backgroundColor);
    await userEvent.tab();
    await expect.element(page.getByRole("button", { name: "Play", exact: true })).toHaveFocus();
    await expect.poll(() => controlFailures(play)).toEqual([]);
    await userEvent.tab();
    await expect.element(page.getByRole("button", { name: "Remove", exact: true })).toHaveFocus();
    await expect.poll(() => controlFailures(remove)).toEqual([]);
    remove.style.transition = "none";
    remove.style.outlineColor = "red";
    remove.style.outlineWidth = "0px";
    expect(controlFailures(remove)).toContain("semantic focus color");
    expect(controlFailures(remove)).toContain("visible focus geometry");
    remove.style.color = getComputedStyle(remove).backgroundColor;
    expect(controlFailures(remove)).toContain("control text contrast");
    remove.removeAttribute("style");
    await expect.element(page.getByRole("button", { name: "Unavailable" })).toBeDisabled();
    expect(getComputedStyle(pending.element()).pointerEvents).toBe("none");
    expect(activate).not.toHaveBeenCalled();
  });
  it(`keeps a long ${theme} dialog inside the viewport with logical close positioning`, async () => {
    document.documentElement.dataset.theme = theme;
    document.documentElement.dir = "rtl";
    await page.viewport(960, 640);
    await render(
      <Dialog open>
        <DialogContent>
          <DialogTitle>A long reviewed change</DialogTitle>
          <div style={{ height: 2000 }}>Long review content</div>
        </DialogContent>
      </Dialog>,
    );
    const dialog = page.getByRole("dialog").element();
    const overlay = document.querySelector('[data-slot="dialog-overlay"]')!;
    expect(overlayFailures(overlay)).toEqual([]);
    const previousOverlayStyle = overlay.getAttribute("style");
    (overlay as HTMLElement).style.transition = "none";
    (overlay as HTMLElement).style.backdropFilter = "blur(4px)";
    expect(overlayFailures(overlay)).toContain("backdrop blur");
    (overlay as HTMLElement).style.setProperty("background-color", "red", "important");
    expect(overlayFailures(overlay)).toContain("semantic scrim");
    if (previousOverlayStyle === null) overlay.removeAttribute("style");
    else overlay.setAttribute("style", previousOverlayStyle);
    await expect.poll(() => dialog.getBoundingClientRect().height).toBeLessThanOrEqual(608);
    expect(getComputedStyle(dialog).overflowY).toBe("auto");
    expect(dialog.scrollHeight).toBeGreaterThan(dialog.clientHeight);
    const close = page.getByRole("button", { name: "Close", exact: true }).element();
    expect(close.getBoundingClientRect().left).toBeLessThan(
      dialog.getBoundingClientRect().left + dialog.clientWidth / 2,
    );
  });
}
