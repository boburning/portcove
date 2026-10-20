import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";
import { page } from "vite-plus/test/browser";
import { cleanup, render } from "vitest-browser-react";
import App from "../App";
import { desktopApi } from "../api";
import * as picker from "../file-picker";
import { initializeLocalization, LocalizationProvider } from "../localization";
import { installInteractiveTransport } from "../dev-scenarios/interactive/transport";
import { workspace } from "../dev-scenarios/interactive/scenarios";
import { sourceProfile } from "../test-fixtures";

let transport: ReturnType<typeof installInteractiveTransport> | undefined;
beforeEach(() => localStorage.clear());
afterEach(async () => {
  await cleanup();
  transport?.dispose();
  vi.restoreAllMocks();
  delete document.documentElement.dataset.theme;
});
async function mount() {
  transport = installInteractiveTransport("library", () => {});
  initializeLocalization(["en"]);
  await render(
    <LocalizationProvider api={desktopApi}>
      <App />
    </LocalizationProvider>,
  );
  await page.getByRole("button", { name: "Add games", exact: true }).click();
  await expect.element(page.getByRole("heading", { name: "Add games", level: 1 })).toHaveFocus();
}
it("retains the selected game and search through details, navigation and closing the workspace", async () => {
  await mount();
  await page.getByRole("button", { name: "Choose game files", exact: true }).click();
  await page.getByRole("textbox", { name: "Find a game or port" }).fill("Harbor");
  await page.getByRole("combobox", { name: "Game and port" }).selectOptions("sample");
  await page.getByRole("button", { name: "Review setup for Harbor Adventure" }).click();
  await expect
    .element(page.getByRole("button", { name: "Back to previous workspace" }))
    .toHaveFocus();
  await page.getByRole("button", { name: "Back to previous workspace" }).click();
  await expect
    .element(page.getByRole("button", { name: "Review setup for Harbor Adventure" }))
    .toHaveFocus();
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await page.getByRole("button", { name: /^Library/ }).click();
  await expect
    .element(page.getByRole("textbox", { name: "Find a game or port" }))
    .toHaveValue("Harbor");
  await expect.element(page.getByRole("combobox", { name: "Game and port" })).toHaveValue("sample");
  await page.getByRole("button", { name: "Back to library", exact: true }).click();
  await expect.element(page.getByRole("button", { name: "Add games", exact: true })).toHaveFocus();
  await page.getByRole("button", { name: "Add games", exact: true }).click();
  await expect
    .element(page.getByRole("textbox", { name: "Find a game or port" }))
    .toHaveValue("Harbor");
});
it("uses the selected profile's existing inspection, preserves failures and restores its real opener", async () => {
  const snapshot = workspace("library");
  const profile = sourceProfile();
  snapshot.catalog.source_profiles = [profile];
  snapshot.catalog.ports[0]!.source_profile = profile.id;
  vi.spyOn(desktopApi, "workspaceSnapshot").mockResolvedValue(snapshot);
  const choose = vi.spyOn(picker, "pickSourcePath").mockResolvedValue("E:/owned/未知.iso");
  const inspect = vi
    .spyOn(desktopApi, "inspectSourceIntake")
    .mockRejectedValue(new Error("Unsupported owned input"));
  await mount();
  await page.getByRole("button", { name: "Choose game files", exact: true }).click();
  await page.getByRole("combobox", { name: "Game and port" }).selectOptions("sample");
  await page.getByRole("button", { name: "Choose files to check…" }).click();
  await page.getByRole("button", { name: "Choose game files to check", exact: true }).click();
  await expect.element(page.getByRole("alert")).toMatchTextContent("Unsupported owned input");
  expect(choose).toHaveBeenCalledWith(profile, "", "game");
  expect(inspect).toHaveBeenCalledExactlyOnceWith(profile.id, ["E:/owned/未知.iso"]);
  await page.getByRole("button", { name: "Close", exact: true }).click();
  await expect.element(page.getByRole("button", { name: "Choose files to check…" })).toHaveFocus();
});
it.each(["dark", "light"])(
  "keeps the %s chooser readable at 240px and exposes no duplicated search IDs",
  async (theme) => {
    document.documentElement.dataset.theme = theme;
    await page.viewport(240, 800);
    await mount();
    await page.getByRole("button", { name: "Choose game files", exact: true }).click();
    expect(document.querySelectorAll("#port-search")).toHaveLength(1);
    expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(241);
    await page.getByRole("textbox", { name: "Find a game or port" }).fill("not a catalog entry");
    await expect
      .element(page.getByRole("status").filter({ hasText: "No game or port matches" }))
      .toBeVisible();
  },
);
