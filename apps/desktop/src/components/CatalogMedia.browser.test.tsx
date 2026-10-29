import { afterEach, expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";
import { cleanup, render } from "vitest-browser-react";
import { ArtworkProvider } from "../artwork";
import { desktopApi, type DesktopArtworkThumbnail } from "../api";
import type { ArtworkSlot, ArtworkState, CatalogMediaAsset, PortListing } from "../types";
import { controlledAct as act } from "../../test/controlled-react-act";
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
const headerPng =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGMwnvn/PwAFmQLLFOU//QAAAABJRU5ErkJggg==";

function automaticArtwork(port: string, slot: ArtworkSlot): ArtworkState {
  return {
    ...artworkState(port, slot),
    availability: "available",
    resolved_source: {
      kind: "igdb_cover",
      cache_id: "b".repeat(64),
      artwork: {
        game_id: 1,
        cover_id: 2,
        image_id: "owned-fixture",
        image_sha256: "c".repeat(64),
        game_slug: "owned-fixture",
        match_kind: "port",
      },
    },
  };
}

async function renderDetail(header: CatalogMediaAsset) {
  const port = {
    ...portDefinition(),
    presentation: {
      installation_method: "portable-package" as const,
      source_requirements: [],
      saves_and_settings: "portcove-managed" as const,
      media: [header],
    },
  };
  await page.viewport(1200, 900);
  return render(
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
}
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
  await render(<CatalogMediaGallery port={portDefinition()} />);
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
      <CatalogMediaGallery
        port={{
          ...portDefinition(),
          presentation: { ...portDefinition().presentation!, media: [first, second] },
        }}
      />
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
      <CatalogMediaGallery
        port={{
          ...portDefinition(),
          presentation: { ...portDefinition().presentation!, media: [first] },
        }}
      />
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
  expect(document.querySelector(".game-hero-background")).toBeNull();
});

it("prefers the admitted header over automatic artwork and credits only the image actually displayed", async () => {
  const header = {
    ...image("header"),
    role: "header" as const,
    attribution: "Declared header author",
  };
  vi.spyOn(desktopApi, "artwork").mockImplementation(async (port, slot) =>
    automaticArtwork(port, slot),
  );
  vi.spyOn(desktopApi, "artworkThumbnail").mockResolvedValue({
    asset_sha256: "b".repeat(64),
    choice_revision: 0,
    png_base64: png,
  });
  let complete: ((thumbnail: DesktopArtworkThumbnail) => void) | undefined;
  const read = vi.spyOn(desktopApi, "catalogMediaThumbnail").mockImplementation(
    () =>
      new Promise((resolve) => {
        complete = resolve;
      }),
  );
  await renderDetail(header);
  const automaticUrl = `data:image/png;base64,${png}`;
  const headerUrl = `data:image/png;base64,${headerPng}`;
  await expect.poll(() => document.querySelector(".game-hero-background img")).toBeNull();
  await expect
    .poll(
      () =>
        document.querySelector<HTMLImageElement>(
          '.game-hero[data-hero-identity="cover"] .game-hero-image',
        )?.src,
    )
    .toBe(automaticUrl);
  expect(document.querySelector(".media-credit")).toBeNull();
  await vi.waitFor(() =>
    expect(read).toHaveBeenCalledExactlyOnceWith("sample", header.id, header.sha256, 7),
  );
  if (!complete) throw new Error("Header request did not start");
  const finish = complete;
  await act(async () =>
    finish({ asset_sha256: header.sha256, choice_revision: 0, png_base64: headerPng }),
  );
  await expect
    .poll(() => document.querySelector<HTMLImageElement>(".game-hero-background img")?.src)
    .toBe(headerUrl);
  expect(
    document.querySelector<HTMLImageElement>(
      '.game-hero[data-hero-identity="cover"] .game-hero-image',
    )?.src,
  ).toBe(automaticUrl);
  expect(document.querySelector(".media-credit")?.textContent).toContain(header.attribution);
  await page.getByText("Image credits", { exact: true }).click();
  await expect
    .element(page.getByRole("link", { name: "Source", exact: true }))
    .toHaveAttribute("href", header.source_url);
  const banner = document.querySelector<HTMLImageElement>(".game-hero-background img");
  if (!banner) throw new Error("Declared banner was not rendered");
  await act(async () => {
    banner.dispatchEvent(new Event("error"));
  });
  await expect.poll(() => document.querySelector(".game-hero-background img")).toBeNull();
  expect(
    document.querySelector<HTMLImageElement>(
      '.game-hero[data-hero-identity="cover"] .game-hero-image',
    )?.src,
  ).toBe(automaticUrl);
  expect(document.querySelector(".media-credit")).toBeNull();
});

it("keeps a selected local header ahead of an admitted remote header and the automatic portrait", async () => {
  const header = { ...image("header"), role: "header" as const };
  const read = vi.spyOn(desktopApi, "catalogMediaThumbnail");
  vi.spyOn(desktopApi, "artwork").mockImplementation(async (port, slot) =>
    slot === "detail" ? artworkState(port, slot, 3, true) : automaticArtwork(port, slot),
  );
  const thumbnail = vi
    .spyOn(desktopApi, "artworkThumbnail")
    .mockImplementation(async (_port, slot, revision) => ({
      asset_sha256: (slot === "detail" ? "a" : "b").repeat(64),
      choice_revision: revision,
      png_base64: slot === "detail" ? headerPng : png,
    }));
  await renderDetail(header);
  await expect
    .poll(() => document.querySelector<HTMLImageElement>(".game-hero-background img")?.src)
    .toBe(`data:image/png;base64,${headerPng}`);
  await expect
    .poll(
      () =>
        document.querySelector<HTMLImageElement>(
          '.game-hero[data-hero-identity="cover"] .game-hero-image',
        )?.src,
    )
    .toBe(`data:image/png;base64,${png}`);
  expect(thumbnail).toHaveBeenCalledWith("sample", "detail", 3, 7);
  expect(read).not.toHaveBeenCalled();
  expect(document.querySelector(".media-credit")).toBeNull();
});
