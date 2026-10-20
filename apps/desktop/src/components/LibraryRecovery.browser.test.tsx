import { afterEach, expect, it, vi } from "vite-plus/test";
import { page } from "vite-plus/test/browser";
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
  expect(text).toContain("switches library authority");
  expect(document.querySelector('input[type="checkbox"]')).toBeNull();
  await expect
    .element(page.getByRole("button", { name: "Restore from a library copy" }))
    .toBeEnabled();
  await expect
    .element(page.getByRole("button", { name: "Move library", exact: true }))
    .toBeEnabled();
});

it("excludes duplicate export and reports only the metadata receipt, never a verified backup", async () => {
  let finish!: (value: LibraryMetadataFile | undefined) => void;
  const exportMetadata = vi.fn(
    () =>
      new Promise<LibraryMetadataFile | undefined>((resolve) => {
        finish = resolve;
      }),
  );
  await render(guide(exportMetadata).element);
  await page.getByText("Prepare a recovery copy", { exact: true }).click();
  const action = page.getByRole("button", { name: "Export metadata", exact: true });
  const button = action.element();
  if (!(button instanceof HTMLButtonElement)) throw new Error("Expected an export button");
  button.click();
  button.click();
  expect(exportMetadata).toHaveBeenCalledOnce();
  finish({ path: "E:/owned/نسخة/metadata.json", sha256: "a".repeat(64), size: 20 });
  await expect
    .element(page.getByRole("status"))
    .toHaveTextContent("Content has not been copied or verified");
  await expect.element(page.getByRole("status")).toHaveTextContent("E:/owned/نسخة/metadata.json");
  expect(document.querySelector('[role="status"] code')!.getAttribute("dir")).toBe("ltr");
});

it("recovers from export failure and treats picker cancellation as no new receipt", async () => {
  const exportMetadata = vi
    .fn()
    .mockRejectedValueOnce(new Error("Disk unavailable"))
    .mockResolvedValueOnce(undefined);
  await render(guide(exportMetadata).element);
  await page.getByText("Prepare a recovery copy", { exact: true }).click();
  await page.getByRole("button", { name: "Export metadata", exact: true }).click();
  await expect.element(page.getByRole("alert")).toHaveTextContent("Disk unavailable");
  await page.getByRole("button", { name: "Export metadata", exact: true }).click();
  await expect
    .element(page.getByRole("button", { name: "Export metadata", exact: true }))
    .toBeEnabled();
  expect(exportMetadata).toHaveBeenCalledTimes(2);
  expect(document.querySelector('[role="status"]')).toBeNull();
  expect(document.querySelector('[role="alert"]')).toBeNull();
});

it.each(["dark", "light"])(
  "keeps %s recovery content in a 240px reading flow with spacing overrides",
  async (theme) => {
    await page.viewport(240, 800);
    document.documentElement.dataset.theme = theme;
    await render(
      <main style={{ padding: 16 }}>{guide(vi.fn(async () => undefined)).element}</main>,
    );
    await page.getByText("Prepare a recovery copy", { exact: true }).click();
    const overrides = document.createElement("style");
    overrides.textContent =
      "*{line-height:1.5!important;letter-spacing:.12em!important;word-spacing:.16em!important}p{margin-bottom:2em!important}";
    document.head.append(overrides);
    try {
      expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(241);
      await expect
        .element(page.getByRole("button", { name: "Export metadata", exact: true }))
        .toBeEnabled();
    } finally {
      overrides.remove();
      delete document.documentElement.dataset.theme;
    }
  },
);
