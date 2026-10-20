import { afterEach, expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";
import { cleanup, render } from "vitest-browser-react";
import { InterfaceSizeProvider, InterfaceSizeSettings } from "./InterfaceSize";
import { InterfaceSizeController } from "./interface-size-controller";
import { Dialog, DialogContent, DialogFooter, DialogTitle } from "./components/ui/dialog";
import { Button } from "./components/ui/button";
import { StatusLayer } from "./components/Chrome";

afterEach(async () => {
  await cleanup();
  document.documentElement.removeAttribute("data-theme");
  await page.viewport(1280, 800);
});

for (const theme of ["dark", "light"]) {
  it(`keeps the complete ${theme} percentage on one line at 240px`, async () => {
    document.documentElement.dataset.theme = theme;
    await page.viewport(240, 160);
    const owner = new InterfaceSizeController(
      async () => {},
      () => ({
        getItem: () => "400",
        setItem: () => {},
      }),
    );
    await render(
      <InterfaceSizeProvider controller={owner}>
        <InterfaceSizeSettings />
      </InterfaceSizeProvider>,
    );
    const picker = page.getByRole("combobox", { name: "Interface size 400%", exact: true });
    await expect.element(picker).toBeEnabled();
    const value = picker.element().querySelector('[data-slot="select-value"]')!;
    const text = document.createTreeWalker(value, NodeFilter.SHOW_TEXT).nextNode()!;
    const range = document.createRange();
    range.selectNodeContents(text);
    expect(range.getClientRects()).toHaveLength(1);
    expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(
      document.documentElement.clientWidth + 1,
    );
  });
  it(`keeps ${theme} task progress readable at 240px`, async () => {
    document.documentElement.dataset.theme = theme;
    await page.viewport(240, 160);
    await render(
      <StatusLayer
        clearError={vi.fn()}
        busy="install"
        operation={{
          schema_version: 2,
          parent_operation_id: null,
          target: null,
          operation_id: "install-1",
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
    await expect.element(page.getByRole("progressbar")).toHaveAttribute("aria-valuenow", "1");
    expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(
      document.documentElement.clientWidth + 1,
    );
  });
  it(`keeps ${theme} review actions in a scrolling 240 by 160 viewport`, async () => {
    document.documentElement.dataset.theme = theme;
    await page.viewport(240, 160);
    const review = vi.fn();
    await render(
      <Dialog open>
        <DialogContent reviewSize="standard">
          <DialogTitle>Review game-file preparation</DialogTitle>
          <p>
            Your original game files stay in place. Check the selected source and destination before
            preparing this game.
          </p>
          <input
            aria-label="Game-file location"
            defaultValue="D:/Игры/日本語/Original game files"
          />
          <DialogFooter className="sticky bottom-0">
            <Button onClick={review}>Prepare this game</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>,
    );
    const popup = page.getByRole("dialog").element();
    const bounds = popup.getBoundingClientRect();
    expect(bounds.top).toBeGreaterThanOrEqual(0);
    expect(bounds.bottom).toBeLessThanOrEqual(innerHeight + 1);
    expect(bounds.right).toBeLessThanOrEqual(document.documentElement.clientWidth + 1);
    expect(getComputedStyle(document.querySelector('[data-slot="dialog-footer"]')!).position).toBe(
      "static",
    );
    await page.getByRole("button", { name: "Prepare this game", exact: true }).click();
    expect(review).toHaveBeenCalledOnce();
    await expect
      .element(page.getByRole("textbox", { name: "Game-file location" }))
      .toHaveValue("D:/Игры/日本語/Original game files");
  });
}

it("uses one owner for the picker, repeated enlargement and reset", async () => {
  const apply = vi.fn(async () => {});
  const owner = new InterfaceSizeController(apply, () => ({
    getItem: () => null,
    setItem: vi.fn(),
  }));
  await render(
    <InterfaceSizeProvider controller={owner}>
      <InterfaceSizeSettings />
    </InterfaceSizeProvider>,
  );
  await page.getByRole("combobox", { name: "Interface size 100%" }).click();
  await page.getByRole("option", { name: "400%", exact: true }).click();
  await expect.element(page.getByRole("combobox", { name: "Interface size 400%" })).toBeVisible();
  expect(apply).toHaveBeenLastCalledWith(4);
  await userEvent.keyboard("{Control>}0{/Control}");
  await expect.element(page.getByRole("combobox", { name: "Interface size 100%" })).toBeVisible();
  await userEvent.keyboard("{Control>}={/Control}");
  await expect.element(page.getByRole("combobox", { name: "Interface size 125%" })).toBeVisible();
  await userEvent.keyboard("{Control>}-{/Control}");
  await expect.element(page.getByRole("combobox", { name: "Interface size 100%" })).toBeVisible();
});

it("keeps failure recovery reachable and preserves a dialog draft during keyboard reset", async () => {
  const apply = vi
    .fn()
    .mockResolvedValueOnce(undefined)
    .mockRejectedValueOnce(new Error("native unavailable"))
    .mockResolvedValue(undefined);
  const owner = new InterfaceSizeController(apply, () => ({
    getItem: () => null,
    setItem: vi.fn(),
  }));
  await render(
    <InterfaceSizeProvider controller={owner}>
      <Dialog open>
        <DialogContent>
          <DialogTitle>Review game files</DialogTitle>
          <input aria-label="Source draft" defaultValue="D:/Games/Original" />
        </DialogContent>
      </Dialog>
    </InterfaceSizeProvider>,
  );
  const draft = page.getByRole("textbox", { name: "Source draft" });
  await draft.click();
  await userEvent.keyboard("{Control>}={/Control}");
  await vi.waitFor(() => expect(owner.getSnapshot().error).toBeDefined());
  await userEvent.keyboard("{Control>}0{/Control}");
  await vi.waitFor(() => expect(owner.getSnapshot().error).toBeUndefined());
  await expect.element(draft).toHaveFocus();
  await expect.element(draft).toHaveValue("D:/Games/Original");
  await expect.element(page.getByRole("dialog")).toBeVisible();
  expect(apply.mock.calls).toEqual([[1], [1.25], [1]]);
});
