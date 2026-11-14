import { render, cleanup } from "vitest-browser-react";
import { page } from "vite-plus/test/browser";
import { afterEach, expect, it, vi } from "vite-plus/test";
import { desktopApi } from "../api";
import { StoreInstallChoices, storeInstallsSummary, storeLabel } from "./StoreInstallChoices";

afterEach(async () => {
  vi.restoreAllMocks();
  await cleanup();
});

const all = ["steam", "gog", "epic"] as const;

it("lists installed store games only when asked and fills the search folder", async () => {
  const list = vi.spyOn(desktopApi, "storeGameInstalls").mockResolvedValue({
    checked_stores: [...all],
    installs: [
      {
        store: "steam",
        title: "Dark Forces",
        path: "C:/Steam/steamapps/common/Dark Forces",
        saved_root_id: null,
      },
      { store: "gog", title: "Fallout 2", path: "C:/GOG Games/Fallout 2", saved_root_id: "root" },
    ],
    skipped_entries: 1,
    limited: false,
  });
  const choose = vi.fn();
  await render(<StoreInstallChoices generation={7} disabled={false} onChoose={choose} />);
  expect(list).not.toHaveBeenCalled();

  await page.getByRole("button", { name: "Choose a Steam, GOG or Epic game" }).click();
  expect(list).toHaveBeenCalledWith(7);
  await expect
    .element(page.getByText("Some installed games may be missing from this list."))
    .toBeVisible();
  await expect.element(page.getByText(/but not move them out of the game\.$/u)).toBeVisible();
  await page.getByRole("button", { name: "Choose the Fallout 2 folder (GOG)" }).click();
  expect(choose).toHaveBeenCalledWith("C:/GOG Games/Fallout 2");

  await page.getByRole("button", { name: "Check installed games again" }).click();
  expect(list).toHaveBeenCalledTimes(2);
});

it("reports a failed listing and offers to check again", async () => {
  const list = vi.spyOn(desktopApi, "storeGameInstalls").mockRejectedValueOnce(new Error("denied"));
  await render(<StoreInstallChoices generation={1} disabled={false} onChoose={vi.fn()} />);
  await page.getByRole("button", { name: "Choose a Steam, GOG or Epic game" }).click();
  await expect.element(page.getByText(/^Portcove couldn't list installed games\./u)).toBeVisible();
  list.mockResolvedValueOnce({
    checked_stores: [...all],
    installs: [],
    skipped_entries: 0,
    limited: false,
  });
  await page.getByRole("button", { name: "Check installed games again" }).click();
  await expect
    .element(
      page.getByText("No games installed by Steam, GOG or Epic were found on this computer."),
    )
    .toBeVisible();
});

it("keeps stores that were not checked distinct from stores with no games", () => {
  const empty = { installs: [], skipped_entries: 0, limited: false };
  expect(storeInstallsSummary({ ...empty, checked_stores: ["steam"] })).toBe(
    "No games installed by Steam were found on this computer. Portcove can't check GOG or Epic games on this system.",
  );
  expect(storeInstallsSummary({ ...empty, checked_stores: [] })).toBe(
    "Portcove can't check Steam, GOG or Epic games on this system.",
  );
  expect(storeLabel("other")).toBe("Another store");
});
