import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, expect, it, vi } from "vite-plus/test";
import { page } from "vite-plus/test/browser";
import { desktopApi } from "../api";
import { JakModsBrowser } from "./JakModsBrowser";
import type { JakModsCatalog } from "../types";

const setupUrl = "https://jakmods.dev/#installation";
const catalog: JakModsCatalog = {
  port_id: "opengoal-jak1",
  game: "jak1",
  platform: "windows-x86-64",
  observed_at: 1,
  freshness: "stale",
  complete: true,
  feed_url: "https://jakmods.dev/mods.json",
  setup_url: setupUrl,
  source_url: "https://jakmods.dev/",
  projects: [
    {
      id: "bullet-hell",
      name: "Bullet Hell",
      supported_games: ["jak1"],
      kind: "open_goal_build",
      build_status: "available",
      summary: null,
      artwork_url: null,
      website_url: null,
      external_url: null,
      releases: [
        {
          version: "1.1.0",
          published_at: 1,
          builds: [{ platform: "windows-x86-64", downloads: 0 }],
        },
      ],
    },
  ],
};
let root: Root;
let host: HTMLElement;
async function mount() {
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () =>
    root.render(<JakModsBrowser portId="opengoal-jak1" generation={7} setupUrl={setupUrl} />),
  );
}
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.restoreAllMocks();
});
it("browses only on request and keeps cached release counts scoped to their file", async () => {
  const read = vi.spyOn(desktopApi, "jakModsCatalog").mockResolvedValue(catalog);
  await mount();
  expect(read).not.toHaveBeenCalled();
  await page.getByRole("button", { name: "Browse JakMods" }).click();
  await expect.element(page.getByText("Bullet Hell")).toBeVisible();
  await expect.element(page.getByText("Games: Jak and Daxter")).toBeVisible();
  await expect.element(page.getByText("Standalone OpenGOAL build")).toBeVisible();
  await expect
    .element(page.getByRole("status"))
    .toHaveTextContent("The source could not be reached. Showing saved results.");
  expect(read).toHaveBeenCalledExactlyOnceWith("opengoal-jak1", 7);
  await page.getByText("Versions and platform builds").click();
  await expect
    .element(page.getByText("Downloads for this file: 0", { exact: false }))
    .toBeVisible();
  await page.getByRole("searchbox").fill("missing");
  await expect.element(page.getByText("No matching projects in this catalog.")).toBeVisible();
});
it("opens setup without a catalog read and keeps it available through an outage", async () => {
  const read = vi.spyOn(desktopApi, "jakModsCatalog").mockRejectedValue(new Error("offline"));
  const open = vi.spyOn(desktopApi, "openJakModsResource").mockResolvedValue(undefined);
  await mount();
  const setup = page.getByRole("link", { name: "Set up JakMods in the OpenGOAL Launcher" });
  await setup.click();
  expect(open).toHaveBeenCalledExactlyOnceWith("opengoal-jak1", 7, setupUrl);
  expect(read).not.toHaveBeenCalled();
  await page.getByRole("button", { name: "Browse JakMods" }).click();
  await expect.element(page.getByRole("alert")).toHaveTextContent("offline");
  await expect.element(setup).toBeVisible();
});
