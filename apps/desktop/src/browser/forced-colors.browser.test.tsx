import { captureParityState } from "../../test/parity-capture";
import { expectDisclosureAlignment } from "../../test/disclosure-alignment";
import { afterEach, expect, it } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";
import { cleanup, render } from "vitest-browser-react";
import { Button } from "../components/ui/button";
import { Dialog, DialogContent, DialogTitle } from "../components/ui/dialog";
import { ChoiceSelect } from "../components/ChoiceSelect";
import { Sidebar, SettingsView } from "../components/Chrome";
import { OperationProgress } from "../components/OperationProgress";
import type { OperationEvent } from "../types";

afterEach(async () => {
  await cleanup();
  document.documentElement.removeAttribute("data-theme");
});
for (const theme of ["dark", "light"]) {
  it(`keeps ${theme} operation progress visible in forced colors`, async () => {
    expect(matchMedia("(forced-colors: active)").matches).toBe(true);
    document.documentElement.dataset.theme = theme;
    for (const total of [100, null]) {
      await render(
        <OperationProgress
          busy="install"
          operation={
            {
              schema_version: 2,
              operation_id: "forced-colors-download",
              parent_operation_id: null,
              target: null,
              sequence: 1,
              timestamp_ms: 1,
              operation: "install",
              type: "progress",
              phase: "download",
              phase_id: "download",
              unit: "bytes",
              completed: 50,
              total,
            } satisfies OperationEvent
          }
        />,
      );
      const track = page.getByRole("progressbar").element();
      const fill = track.firstElementChild!;
      const background = getComputedStyle(track).backgroundColor;
      const style = getComputedStyle(fill);
      const visibleBackground =
        style.backgroundColor !== background && style.backgroundColor !== "rgba(0, 0, 0, 0)";
      const visibleBorder =
        parseFloat(style.borderTopWidth) > 0 && style.borderTopColor !== background;
      expect(visibleBackground || visibleBorder).toBe(true);
      expect(fill.getBoundingClientRect().width).toBeGreaterThan(0);
      expect(fill.getBoundingClientRect().height).toBeGreaterThan(0);
      expect(style.forcedColorAdjust).toBe("auto");
      expect(style.animationName).toBe("none");
      await captureParityState(`forced-colors-progress-${total === null ? "unknown" : "known"}`);
      await cleanup();
    }
  });
  it(`keeps ${theme} current navigation distinct from keyboard focus in forced colors`, async () => {
    expect(matchMedia("(forced-colors: active)").matches).toBe(true);
    document.documentElement.dataset.theme = theme;
    await page.viewport(1280, 800);
    await render(
      <div className="app-shell grid h-[100vh] grid-cols-[var(--layout-sidebar)_minmax(0,_1fr)]">
        <Sidebar
          view="settings"
          setView={() => {}}
          libraryCount={0}
          updateCount={0}
          activities={[]}
        />
        <main className="min-h-0 overflow-auto">
          <SettingsView category="library-storage" />
        </main>
      </div>,
    );
    const pairs = [
      [page.getByRole("navigation", { name: "Primary navigation" }), "Settings", /^Library/],
      [
        page.getByRole("navigation", { name: "Settings categories" }),
        "Library and storage",
        "Appearance",
      ],
    ] as const;
    for (const [navigation, currentName, otherName] of pairs) {
      const current = navigation.getByRole("button", { name: currentName, exact: true }).element();
      const other = navigation.getByRole("button", { name: otherName }).element();
      expect(current.getAttribute("aria-current")).toBe("page");
      const marker = getComputedStyle(current);
      expect(marker.borderInlineStartStyle).toBe("solid");
      expect(parseFloat(marker.borderInlineStartWidth)).toBeGreaterThan(
        parseFloat(getComputedStyle(other).borderInlineStartWidth),
      );
      expect(marker.borderInlineStartColor).not.toBe(marker.backgroundColor);
      other.focus();
      expect(parseFloat(getComputedStyle(current).borderInlineStartWidth)).toBe(
        parseFloat(marker.borderInlineStartWidth),
      );
      expect(current).not.toBe(document.activeElement);
    }
    await captureParityState("forced-colors-current-navigation");
  });

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
    expect(getComputedStyle(selected.element(), "::after").borderBottomStyle).toBe("solid");
    expect(
      parseFloat(getComputedStyle(selected.element(), "::after").borderBottomWidth),
    ).toBeGreaterThanOrEqual(2);
    expect(getComputedStyle(ordinary.element(), "::after").borderBottomWidth).toBe("0px");
    await userEvent.tab();
    await expect.element(selected).toHaveFocus();
    expect(getComputedStyle(selected.element()).outlineStyle).not.toBe("none");
    await captureParityState("forced-colors-selection-focus");
  });
  it(`respects actual reduced motion for ${theme} controls and portaled popups`, async () => {
    expect(matchMedia("(prefers-reduced-motion: reduce)").matches).toBe(true);
    document.documentElement.dataset.theme = theme;
    await render(
      <Dialog open>
        <DialogContent>
          <DialogTitle>Review installation</DialogTitle>
          <Button>Continue</Button>
          <details>
            <summary className="disclosure-pad-2">Additional installation checks</summary>
            <p>Review the recorded checks before continuing.</p>
          </details>
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
    const summary = page.getByText("Additional installation checks", { exact: true });
    await document.fonts.ready;
    expectDisclosureAlignment(summary.element());
    expect(getComputedStyle(summary.element(), "::before").transitionProperty).toBe("none");
    await summary.click();
    expect(summary.element().closest("details")!.open).toBe(true);
    expectDisclosureAlignment(summary.element());
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
    await captureParityState("reduced-motion-popup");
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
    await captureParityState("forced-colors-dialog");
  });
}
