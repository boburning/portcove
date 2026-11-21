import { page } from "vite-plus/test/browser";
import { cleanup, render } from "vitest-browser-react";
import { afterEach, expect, it, vi } from "vite-plus/test";
import { desktopApi } from "../api";
import { ExternalModPortals } from "./ExternalModPortals";

const port = "quake-vkquake";
afterEach(cleanup);

it.each([
  { port, engine: "vk_quake" },
  { port: "quake-ironwail", engine: "ironwail" },
] as const)(
  "guides $engine and distinguishes cached from confirmed empty",
  async ({ port, engine }) => {
    const url = "https://www.quaddicted.com/db/v2/";
    const base = {
      value: {
        attribution: "Quaddicted",
        source_url: url,
        engine,
        page: 0,
        entries: [],
        unreadable_rows: 0,
        may_have_more: false,
      },
      observed_at: 1_798_000_000,
    };
    const browse = vi
      .spyOn(desktopApi, "quaddictedCatalog")
      .mockResolvedValueOnce({ ...base, freshness: "stale" })
      .mockResolvedValueOnce({ ...base, freshness: "fresh" });

    try {
      await render(
        <ExternalModPortals
          port={port}
          generation={2}
          portals={[{ source: "quaddicted", url, browse_available: true }]}
        />,
      );
      await expect.element(page.getByText(/supports your Quake engine/)).toBeVisible();
      expect(browse).not.toHaveBeenCalled();
      await page.getByRole("button", { name: "Show newest on Quaddicted" }).click();
      await expect.element(page.getByText(/Showing earlier results/)).toBeVisible();
      expect(page.getByText("The source returned no results.").query()).toBeNull();

      await page.getByRole("textbox", { name: "Filename" }).fill("ad_v1");
      await page.getByRole("button", { name: "Search Quaddicted" }).click();
      await expect.element(page.getByText("The source returned no results.")).toBeVisible();
      expect(browse).toHaveBeenNthCalledWith(1, port, 2, 0, undefined);
      expect(browse).toHaveBeenNthCalledWith(2, port, 2, 0, "ad_v1");
    } finally {
      browse.mockRestore();
    }
  },
);

it("opens a Mod DB file notice through the scoped verifier and labels a refusal", async () => {
  const url = "https://www.moddb.com/mods/arcane-dimensions/downloads";
  const notice = url + "/arcane-dimensions-180-with-patch-1";
  const browse = vi.spyOn(desktopApi, "modDbFileNotices").mockResolvedValue({
    value: {
      port_id: port,
      platform: "linux-x86-64",
      attribution: "Mod DB - Game Development",
      source_url: url,
      notices: [
        {
          source_id: "downloads100",
          title: "Arcane Dimensions",
          page_url: notice,
          published_at: null,
        },
      ],
    },
    observed_at: 1_798_000_000,
    freshness: "fresh",
  });
  const open = vi
    .spyOn(desktopApi, "openUpstreamModNotice")
    .mockRejectedValue(new Error("changed"));
  try {
    await render(
      <ExternalModPortals
        port={port}
        generation={3}
        portals={[{ source: "mod-db-arcane-dimensions", url, browse_available: true }]}
      />,
    );
    await page.getByRole("button", { name: "Show Arcane Dimensions file notices" }).click();
    await expect.element(page.getByText(/Mod DB - Game Development/)).toBeVisible();
    await page.getByRole("button", { name: "View on Mod DB" }).click();
    expect(open).toHaveBeenCalledWith(port, 3, "mod-db-arcane-dimensions", notice);
    await expect
      .element(page.getByRole("alert"))
      .toHaveTextContent("This link is no longer confirmed.");
  } finally {
    browse.mockRestore();
    open.mockRestore();
  }
});
