import { render, cleanup } from "vitest-browser-react";
import { page } from "vite-plus/test/browser";
import { afterEach, expect, it, vi } from "vite-plus/test";
import { desktopApi } from "../api";
import { StoreInstallChoices, storeLabel } from "./StoreInstallChoices";

afterEach(async () => {
  vi.restoreAllMocks();
  await cleanup();
});

it("lists installed store games only when asked and fills the search folder", async () => {
  const list = vi.spyOn(desktopApi, "storeGameInstalls").mockResolvedValue({
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
  await expect.element(page.getByText("Some installed games may be missing")).toBeVisible();
  await expect.element(page.getByText("but not move them out of the game")).toBeVisible();
  await page.getByRole("button", { name: "Choose the Fallout 2 folder (GOG)" }).click();
  expect(choose).toHaveBeenCalledWith("C:/GOG Games/Fallout 2");
});

it("says when no store games are found and when listing fails", async () => {
  vi.spyOn(desktopApi, "storeGameInstalls").mockResolvedValueOnce({
    installs: [],
    skipped_entries: 0,
    limited: false,
  });
  await render(<StoreInstallChoices generation={1} disabled={false} onChoose={vi.fn()} />);
  await page.getByRole("button", { name: "Choose a Steam, GOG or Epic game" }).click();
  await expect
    .element(page.getByText("No games installed by Steam, GOG or Epic were found"))
    .toBeVisible();
  await cleanup();

  vi.spyOn(desktopApi, "storeGameInstalls").mockRejectedValueOnce(new Error("denied"));
  await render(<StoreInstallChoices generation={1} disabled={false} onChoose={vi.fn()} />);
  await page.getByRole("button", { name: "Choose a Steam, GOG or Epic game" }).click();
  await expect.element(page.getByRole("alert")).toHaveTextContent("couldn't list installed games");
  expect(storeLabel("other")).toBe("Another store");
});
