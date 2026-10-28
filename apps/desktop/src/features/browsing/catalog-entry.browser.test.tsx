import { useState } from "react";
import { afterEach, expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";
import { cleanup, render } from "vitest-browser-react";
import { desktopApi } from "../../api";
import { ArtworkProvider } from "../../artwork";
import { openDiscoverPort } from "../../browser/discover-test-helpers";
import { DetailLayout } from "../../components/DetailLayout";
import { PortBrowser } from "../../components/PortBrowser";
import { artworkState, portDefinition } from "../../test-fixtures";
import type { CatalogMediaAsset, OriginalGameIdentity } from "../../types";
import { catalogEntries, type CatalogEntry } from "./catalog-entry";
import "../../styles/index.css";

afterEach(async () => {
  await cleanup();
  vi.restoreAllMocks();
});

const original: OriginalGameIdentity = {
  format_version: 1,
  id: "reviewed-original",
  evidence_urls: ["https://example.com/original"],
  source_editions: [
    {
      id: "reviewed-edition",
      title: "Reviewed original edition",
      system: "nintendo-64",
      evidence_urls: ["https://example.com/original/edition"],
    },
  ],
};
const screenshot: CatalogMediaAsset = {
  id: "original-scene",
  role: "screenshot",
  subject: {
    kind: "original",
    game_id: original.id,
    source_edition_id: original.source_editions[0]!.id,
  },
  caption: "Synthetic original scene",
  url: `https://raw.githubusercontent.com/example/fixture/${"a".repeat(40)}/scene.png`,
  sha256: "a".repeat(64),
  width: 1,
  height: 1,
  attribution: "Synthetic test fixture",
  source_url: "https://example.com/original/scene",
  license: "CC0-1.0",
  rights_url: "https://example.com/original/rights",
};
const header: CatalogMediaAsset = { ...screenshot, id: "original-header", role: "header" };
const png =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/l9sAAAAASUVORK5CYII=";

function Fixture({ clearMedia }: { clearMedia: boolean }) {
  const [selected, setSelected] = useState<CatalogEntry>();
  const definitions = ["first-project", "second-project"].map((id) => ({
    ...portDefinition(),
    id,
    name: id,
    presentation: {
      original_game_title: "Original Game",
      installation_method: "portable-package" as const,
      source_requirements: [],
      saves_and_settings: "portcove-managed" as const,
      ...(clearMedia ? { media: [] } : {}),
    },
  }));
  const catalog = { schema_version: 2, ports: definitions };
  const listings = {
    format_version: 3,
    listings: definitions.map(({ id, name, summary, project_url, platforms }) => ({
      id,
      name,
      summary,
      project_url,
      platforms,
      availability: "unknown" as const,
      original_game: original,
      media: [header, screenshot],
    })),
  };
  const entries = catalogEntries(catalog, listings, [], []);
  return (
    <ArtworkProvider generation={7} catalog={catalog} listings={listings}>
      {selected ? (
        <DetailLayout
          port={selected}
          initialSection="overview"
          readiness="Not installed"
          installation="Not installed"
          action={() => null}
          close={() => setSelected(undefined)}
        >
          {() => ({ overview: null, files: null, saves: null, versions: null })}
        </DetailLayout>
      ) : (
        <PortBrowser
          view="catalog"
          ports={entries}
          statuses={new Map()}
          overview={{ installed: 0, ready: 0, needsSetup: 0, staged: 0 }}
          filter="all"
          setFilter={vi.fn()}
          onSelect={(id) => setSelected(entries.find((entry) => entry.id === id))}
          loading={false}
        />
      )}
    </ArtworkProvider>
  );
}

async function openProjectedDetail(clearMedia: boolean) {
  await page.viewport(1280, 900);
  vi.spyOn(desktopApi, "artwork").mockImplementation(async (port, slot) =>
    artworkState(port, slot),
  );
  const read = vi
    .spyOn(desktopApi, "catalogMediaThumbnail")
    .mockImplementation(async (_port, _id, sha256) => ({
      asset_sha256: sha256,
      choice_revision: 0,
      png_base64: png,
    }));
  await render(<Fixture clearMedia={clearMedia} />);
  expect(document.querySelectorAll("[data-discover-port-ids]")).toHaveLength(1);
  expect(
    JSON.parse(
      document.querySelector<HTMLElement>("[data-discover-port-ids]")!.dataset.discoverPortIds!,
    ),
  ).toEqual(["first-project", "second-project"]);
  await openDiscoverPort("first-project");
  await expect
    .element(page.getByRole("heading", { name: "Original Game", exact: true }))
    .toBeVisible();
  const identity = page.getByRole("group", { name: "Game and port identity", exact: true });
  await expect.element(identity.getByText("Nintendo 64", { exact: true })).toBeVisible();
  await expect
    .element(identity.getByText("Not specified", { exact: true }))
    .not.toBeInTheDocument();
  return read;
}

it("carries reviewed listing identity and media from grouped old definitions into details", async () => {
  const read = await openProjectedDetail(false);
  await expect
    .poll(
      () =>
        document.querySelector<HTMLImageElement>(".detail-header-artwork img")?.naturalWidth ?? 0,
    )
    .toBeGreaterThan(0);
  expect(read).toHaveBeenCalledWith("first-project", header.id, header.sha256, 7);
  page.getByRole("region", { name: "Screenshots", exact: true }).element().scrollIntoView();
  const enlarge = page.getByRole("button", {
    name: "Enlarge screenshot 1: Synthetic original scene",
    exact: true,
  });
  await expect.element(enlarge).toBeEnabled();
  await enlarge.click();
  const viewer = page.getByRole("dialog");
  await expect.element(viewer.getByText(/Edition: reviewed-edition/)).toBeVisible();
  await expect
    .element(viewer.getByRole("link", { name: "CC0-1.0", exact: true }))
    .toHaveAttribute("href", screenshot.rights_url);
  expect(read).toHaveBeenCalledWith("first-project", screenshot.id, screenshot.sha256, 7);
  await userEvent.keyboard("{Escape}");
  await expect.element(enlarge).toHaveFocus();
});

it("retains grouping and source edition identity while explicit strict media clears the listing gallery", async () => {
  const read = await openProjectedDetail(true);
  expect(document.querySelector(".detail-header-artwork")).toBeNull();
  await expect
    .element(page.getByRole("region", { name: "Screenshots", exact: true }))
    .not.toBeInTheDocument();
  expect(read).not.toHaveBeenCalled();
});
