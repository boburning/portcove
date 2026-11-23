import { captureParityState } from "../../test/parity-capture";
import { afterEach, expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";
import { cleanup, render } from "vitest-browser-react";
import { LibraryRecovery } from "./LibraryRecovery";
import { portDefinition, portStatus } from "../test-fixtures";
import { install } from "../dev-scenarios/interactive/scenarios";
import type { LibraryMetadataFile } from "../types";
import "../styles/index.css";

afterEach(cleanup);

function guide(exportMetadata: () => Promise<LibraryMetadataFile | undefined>) {
  const port = portDefinition();
  const onOpenActivity = vi.fn();
  const onReviewSaves = vi.fn();
  return {
    onOpenActivity,
    onReviewSaves,
    element: (
      <LibraryRecovery
        generation={1}
        libraryRoot="E:/owned/library"
        ports={[port]}
        statuses={
          new Map([[port.id, { ...portStatus(), active: { ...install, port_id: port.id } }]])
        }
        exportMetadata={exportMetadata}
        onOpenActivity={onOpenActivity}
        onReviewSaves={onReviewSaves}
      />
    ),
  };
}

function expectSeparatedRecoverySteps() {
  const steps = Array.from(document.querySelectorAll(".library-recovery details > section"));
  expect(steps).toHaveLength(3);
  for (const step of steps) {
    const previous = step.previousElementSibling;
    expect(previous).not.toBeNull();
    expect(
      step.getBoundingClientRect().top - previous!.getBoundingClientRect().bottom,
    ).toBeGreaterThanOrEqual(23);
    const children = Array.from(step.children);
    for (let index = 1; index < children.length; index++) {
      expect(
        children[index]!.getBoundingClientRect().top -
          children[index - 1]!.getBoundingClientRect().bottom,
      ).toBeGreaterThanOrEqual(11);
    }
  }
}

it("keeps manual preparation distinct from checked restore and authority-changing Move", async () => {
  const fixture = guide(vi.fn(async () => undefined));
  await render(fixture.element);
  await page.getByText("Prepare a recovery copy", { exact: true }).click();
  await page.getByRole("button", { name: "Review tasks & history" }).click();
  expect(fixture.onOpenActivity).toHaveBeenCalledOnce();
  await page.getByRole("button", { name: /^Review saves for/ }).click();
  expect(fixture.onReviewSaves).toHaveBeenCalledExactlyOnceWith(
    portDefinition().id,
    `settings:recovery:saves:${portDefinition().id}`,
  );
  const text = document.querySelector(".library-recovery")!.textContent;
  for (const name of ["versions", "user", "source-inbox", "backups", "toolchains", "artwork"])
    expect(text).toContain(name);
  expect(text).toContain("A manual copy is unverified");
  expect(text).toContain("External game saves");
  expect(text).toContain("then opens the new copy");
  expect(text).toContain("retroachievements.credentials");
  expect(text).toContain("Checked restore and location changes refuse these files");
  expect(text).toContain("If Portcove names a remaining sign-in file");
  expect(document.querySelector('input[type="checkbox"]')).toBeNull();
  await expect
    .element(page.getByRole("button", { name: "Restore from a library copy" }))
    .toBeEnabled();
  await expect
    .element(page.getByRole("button", { name: "Change library location", exact: true }))
    .toBeEnabled();
  expectSeparatedRecoverySteps();
  await captureParityState("library-recovery-guide");
});

it("excludes duplicate export and reports only the metadata receipt, never a backup", async () => {
  let finish!: (value: LibraryMetadataFile | undefined) => void;
  const exportMetadata = vi.fn(
    () =>
      new Promise<LibraryMetadataFile | undefined>((resolve) => {
        finish = resolve;
      }),
  );
  await render(guide(exportMetadata).element);
  await page.getByText("Prepare a recovery copy", { exact: true }).click();
  const action = page.getByRole("button", { name: "Export library information", exact: true });
  const button = action.element();
  if (!(button instanceof HTMLButtonElement)) throw new Error("Expected an export button");
  button.focus();
  button.click();
  button.click();
  const pending = page.getByRole("button", { name: "Exporting library information…", exact: true });
  await expect.element(pending).toHaveFocus();
  await expect.element(pending).toHaveAttribute("aria-busy", "true");
  await userEvent.keyboard("{Enter}");
  expect(exportMetadata).toHaveBeenCalledOnce();
  finish({ path: "E:/owned/نسخة/metadata.json", sha256: "a".repeat(64), size: 20 });
  await expect
    .element(page.getByRole("status"))
    .toMatchTextContent("Content has not been copied or verified");
  await expect.element(page.getByRole("status")).toMatchTextContent("E:/owned/نسخة/metadata.json");
  expect(document.querySelector('[role="status"] code')!.getAttribute("dir")).toBe("ltr");
  await expect.element(action).toHaveFocus();
});

it("recovers from export failure and treats picker cancellation as no new receipt", async () => {
  let cancel!: (value: undefined) => void;
  const selection = new Promise<undefined>((resolve) => {
    cancel = resolve;
  });
  const exportMetadata = vi
    .fn()
    .mockRejectedValueOnce(new Error("Disk unavailable"))
    .mockReturnValueOnce(selection);
  await render(guide(exportMetadata).element);
  await page.getByText("Prepare a recovery copy", { exact: true }).click();
  const action = page.getByRole("button", { name: "Export library information", exact: true });
  const feedback = page.getByText("Library information export did not finish: Disk unavailable");
  await action.click();
  await expect.element(feedback).toBeVisible();
  await expect.element(action).toHaveFocus();
  expect(action.element().getAttribute("aria-describedby")).toBe(feedback.element().id);
  expectSeparatedRecoverySteps();
  await captureParityState("library-metadata-export-failure");
  await userEvent.keyboard("{Enter}");
  await expect
    .element(page.getByRole("button", { name: "Exporting library information…", exact: true }))
    .toHaveFocus();
  cancel(undefined);
  await expect.element(action).toHaveFocus();
  await expect.element(action).toBeEnabled();
  expect(exportMetadata).toHaveBeenCalledTimes(2);
  await expect.element(page.getByRole("status")).not.toBeInTheDocument();
  await expect.element(feedback).not.toBeInTheDocument();
});

it.each(["dark", "light"])(
  "keeps %s recovery content in a 240px reading flow with spacing overrides",
  async (theme) => {
    await page.viewport(240, 800);
    document.documentElement.dataset.theme = theme;
    const longPath = `E:/owned/${"x".repeat(160)}/نسخة/metadata.json`;
    await render(
      <main style={{ padding: 16 }}>
        {guide(async () => ({ path: longPath, sha256: "a".repeat(64), size: 20 })).element}
      </main>,
    );
    await page.getByText("Prepare a recovery copy", { exact: true }).click();
    const overrides = document.createElement("style");
    overrides.textContent =
      "*{line-height:1.5!important;letter-spacing:.12em!important;word-spacing:.16em!important}p{margin-bottom:2em!important}";
    document.head.append(overrides);
    try {
      expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(241);
      expectSeparatedRecoverySteps();
      const exportButton = page.getByRole("button", {
        name: "Export library information",
        exact: true,
      });
      await expect.element(exportButton).toBeEnabled();
      await exportButton.click();
      await expect.element(page.getByRole("status")).toMatchTextContent(longPath);
      expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(241);
    } finally {
      overrides.remove();
      delete document.documentElement.dataset.theme;
    }
  },
);
