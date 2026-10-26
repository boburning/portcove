import { afterEach, expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";
import { cleanup, render } from "vitest-browser-react";
import { ArtworkProvider } from "../artwork";
import { desktopApi } from "../api";
import type { CatalogMediaAsset, PortListing } from "../types";
import { artworkState, portDefinition } from "../test-fixtures";
import { CatalogMediaGallery } from "./CatalogMedia";
import { DetailLayout } from "./DetailLayout";
import "../styles/index.css";

afterEach(async () => {
  await cleanup();
  vi.restoreAllMocks();
});

const png =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/l9sAAAAASUVORK5CYII=";
function image(id: string): CatalogMediaAsset {
  return {
    id,
    role: "screenshot",
    subject: { kind: "port", port_id: "sample" },
    caption: id === "first" ? "Owned first scene" : "Owned second scene",
    url: `https://raw.githubusercontent.com/owner/project/${"a".repeat(40)}/${id}.png`,
    sha256: "a".repeat(64),
    width: 1,
    height: 1,
    attribution: "Portcove synthetic fixture",
    source_url: "https://github.com/owner/project",
    license: "CC0-1.0",
    rights_url: "https://github.com/owner/project/blob/main/LICENSE",
  };
}
function directory(media: CatalogMediaAsset[]) {
  const listing: PortListing = {
    id: "sample",
    name: "Sample",
    summary: "Synthetic gallery fixture",
    project_url: "https://example.com",
    platforms: [],
    availability: "unknown",
    media,
  };
  return { format_version: 3, listings: [listing] };
}

it("reserves no gallery for absent media", async () => {
  const read = vi.spyOn(desktopApi, "catalogMediaThumbnail");
  await render(<CatalogMediaGallery portId="sample" />);
  await expect
    .element(page.getByRole("region", { name: "Screenshots", exact: true }))
    .not.toBeInTheDocument();
  expect(read).not.toHaveBeenCalled();
});

it("shows source and edition attribution, navigates previews and returns focus to the same screenshot", async () => {
  const first = image("first"),
    second = {
      ...image("second"),
      subject: { kind: "original" as const, game_id: "original", source_edition_id: "usa-v1" },
    };
  vi.spyOn(desktopApi, "catalogMediaThumbnail").mockImplementation(async (_port, _id, sha256) => ({
    asset_sha256: sha256,
    choice_revision: 0,
    png_base64: png,
  }));
  await render(
    <ArtworkProvider generation={7} listings={directory([first, second])}>
      <CatalogMediaGallery portId="sample" media={[first, second]} />
    </ArtworkProvider>,
  );
  const origin = page.getByRole("button", {
    name: "Enlarge screenshot 1: Owned first scene",
    exact: true,
  });
  await expect.element(origin).toBeEnabled();
  await origin.click();
  await expect
    .element(page.getByRole("heading", { name: "Owned first scene", exact: true }))
    .toHaveFocus();
  await userEvent.keyboard("{ArrowRight}");
  await expect
    .element(page.getByRole("heading", { name: "Owned second scene", exact: true }))
    .toBeVisible();
  await expect.element(page.getByRole("dialog").getByText(/Edition: usa-v1/)).toBeVisible();
  await expect
    .element(page.getByRole("dialog").getByRole("link", { name: "CC0-1.0", exact: true }))
    .toHaveAttribute("href", second.rights_url);
  await userEvent.keyboard("{Escape}");
  await expect.element(origin).toHaveFocus();
});

it("keeps unavailable screenshot feedback compact and offers an explicit retry", async () => {
  const first = image("first");
  const read = vi
    .spyOn(desktopApi, "catalogMediaThumbnail")
    .mockRejectedValue(new Error("Image unavailable"));
  await render(
    <ArtworkProvider generation={7} listings={directory([first])}>
      <CatalogMediaGallery portId="sample" media={[first]} />
    </ArtworkProvider>,
  );
  const retry = page.getByRole("button", { name: "Retry screenshot 1", exact: true });
  await expect.element(retry).toBeVisible();
  read.mockResolvedValue({ asset_sha256: first.sha256, choice_revision: 0, png_base64: png });
  await retry.click();
  await expect
    .element(
      page.getByRole("button", { name: "Enlarge screenshot 1: Owned first scene", exact: true }),
    )
    .toBeEnabled();
});

it("does not replace an unavailable selected local header with catalog imagery", async () => {
  const header = { ...image("first"), role: "header" as const };
  const read = vi.spyOn(desktopApi, "catalogMediaThumbnail");
  vi.spyOn(desktopApi, "artwork").mockImplementation(async (port, slot) => ({
    ...artworkState(port, slot, 1, true),
    availability: "unavailable",
    resolved_source: { kind: "generated_fallback" },
  }));
  const port = {
    ...portDefinition(),
    presentation: {
      installation_method: "portable-package" as const,
      source_requirements: [],
      saves_and_settings: "portcove-managed" as const,
      media: [header],
    },
  };
  await render(
    <ArtworkProvider generation={7} catalog={{ schema_version: 2, ports: [port] }}>
      <DetailLayout
        port={port}
        initialSection="overview"
        readiness="Ready"
        installation="Managed"
        action={() => null}
        close={vi.fn()}
      >
        {() => ({ overview: null, files: null, saves: null, versions: null })}
      </DetailLayout>
    </ArtworkProvider>,
  );
  await vi.waitFor(() => expect(desktopApi.artwork).toHaveBeenCalledWith("sample", "detail", 7));
  expect(read).not.toHaveBeenCalled();
  expect(document.querySelector(".detail-header-artwork")).toBeNull();
});
