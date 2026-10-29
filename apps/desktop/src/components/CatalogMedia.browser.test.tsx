import { afterEach, expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";
import { cleanup, render } from "vitest-browser-react";
import { ArtworkProvider } from "../artwork";
import { desktopApi, type DesktopArtworkThumbnail } from "../api";
import type { ArtworkSlot, ArtworkState, CatalogMediaAsset, PortListing } from "../types";
import { controlledAct as act } from "../../test/controlled-react-act";
import { artworkState, portDefinition } from "../test-fixtures";
import { GameHero } from "./GameHero";
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
        context={{ originalEditionId: "usa-v1" }}
        port={{
          ...portDefinition(),
          presentation: {
            ...portDefinition().presentation!,
            media: [first, second],
            original_game: {
              format_version: 1,
              id: "original",
              evidence_urls: ["https://example.com/original"],
              source_editions: [
                {
                  id: "usa-v1",
                  title: "US release",
                  evidence_urls: ["https://example.com/original/us"],
                },
              ],
            },
          },
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
  await expect
    .element(page.getByRole("dialog").getByText(/Original release · usa-v1/))
    .toBeVisible();
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

function controlledHeroMedia(compactLogo = false) {
  const keyArt: CatalogMediaAsset = {
    ...image("controlled-key-art"),
    role: "key_art",
    sha256: "c".repeat(64),
    width: 400,
    height: 225,
  };
  const logo: CatalogMediaAsset = {
    ...image("controlled-logo"),
    role: "logo",
    sha256: "d".repeat(64),
    width: compactLogo ? 160 : 400,
    height: compactLogo ? 160 : 100,
  };
  for (const asset of [keyArt, logo]) {
    const imageId = asset.role === "logo" ? "fixturelogo" : "fixturekeyart";
    asset.url = `https://images.igdb.com/igdb/image/upload/t_${asset.role === "logo" ? "logo_med_2x" : "720p"}/${imageId}.png`;
    asset.source_url = "https://www.igdb.com/games/controlled-fixture";
    asset.igdb = {
      game_id: 7,
      record_id: asset.role === "logo" ? 1 : 2,
      kind: asset.role === "logo" ? "logo" : "artwork",
      image_id: imageId,
      game_slug: "controlled-fixture",
      ...(asset.role === "key_art"
        ? { image_type: 991, image_type_name: "Key art with logo" }
        : {}),
    };
  }
  const port = {
    ...portDefinition(),
    presentation: { ...portDefinition().presentation!, media: [keyArt, logo] },
  };
  const canvas = document.createElement("canvas");
  canvas.width = logo.width;
  canvas.height = logo.height;
  const drawing = canvas.getContext("2d");
  if (!drawing) throw new Error("Fixture canvas unavailable");
  drawing.fillStyle = "white";
  drawing.font = compactLogo ? "bold 112px sans-serif" : "bold 64px sans-serif";
  drawing.fillText(compactLogo ? "PC" : "TEST LOGO", 5, compactLogo ? 128 : 75);
  const logoBytes = canvas.toDataURL("image/png").split(",")[1]!;
  return { keyArt, logo, port, logoBytes };
}

function controlledKeyArt(width: number, height: number) {
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const drawing = canvas.getContext("2d");
  if (!drawing) throw new Error("Fixture canvas unavailable");
  drawing.fillStyle = "#5845aa";
  drawing.fillRect(0, 0, width, height);
  return canvas.toDataURL("image/png").split(",")[1]!;
}

it.each(["unavailable", "tiny", "thin", "tall"] as const)(
  "ignores %s key art and keeps identity and focus through logo and cover failures",
  async (keyArtState) => {
    const { keyArt, logo, port, logoBytes } = controlledHeroMedia();
    if (keyArtState !== "unavailable") {
      const dimensions = { tiny: [1, 1], thin: [960, 8], tall: [8, 720] } as const;
      [keyArt.width, keyArt.height] = dimensions[keyArtState];
    }
    vi.spyOn(desktopApi, "artwork").mockImplementation(async (id, slot) =>
      automaticArtwork(id, slot),
    );
    vi.spyOn(desktopApi, "artworkThumbnail").mockResolvedValue({
      asset_sha256: "b".repeat(64),
      choice_revision: 0,
      png_base64: png,
    });
    const media = vi
      .spyOn(desktopApi, "catalogMediaThumbnail")
      .mockImplementation(async (_id, mediaId, hash) => {
        if (mediaId === keyArt.id) {
          if (keyArtState === "unavailable")
            throw new Error("Controlled unavailable cached key art");
          const { width, height } = keyArt;
          return {
            asset_sha256: hash,
            choice_revision: 0,
            png_base64: controlledKeyArt(width, height),
          };
        }
        return { asset_sha256: hash, choice_revision: 0, png_base64: logoBytes };
      });
    await page.viewport(1200, 900);
    await render(
      <ArtworkProvider generation={7} catalog={{ schema_version: 2, ports: [port] }}>
        <GameHero port={port} variant="detail">
          <h1>Sample</h1>
          <button>Play controlled game</button>
        </GameHero>
      </ArtworkProvider>,
    );
    await expect
      .poll(() => document.querySelector(".game-hero")?.getAttribute("data-hero-identity"))
      .toBe("logo");
    const play = page.getByRole("button", { name: "Play controlled game", exact: true });
    await play.click();
    const action = document.activeElement;
    const logoElement = document.querySelector<HTMLImageElement>(".game-hero-image");
    if (!logoElement) throw new Error("Logo did not render");
    await act(async () => {
      logoElement.dispatchEvent(new Event("error"));
    });
    await expect
      .poll(() => document.querySelector(".game-hero")?.getAttribute("data-hero-identity"))
      .toBe("cover");
    expect(document.activeElement).toBe(action);
    const cover = document.querySelector<HTMLImageElement>(".game-hero-image");
    if (!cover) throw new Error("Cover fallback did not render");
    await page.getByText("Image credits", { exact: true }).click();
    await expect.element(page.getByText("Image credits", { exact: true })).toHaveFocus();
    await act(async () => {
      cover.dispatchEvent(new Event("error"));
    });
    await expect
      .poll(() => document.querySelector(".game-hero")?.getAttribute("data-hero-identity"))
      .toBe("text");
    await expect.element(page.getByRole("heading", { name: "Sample", exact: true })).toBeVisible();
    expect(document.activeElement).toBe(action);
    expect(media.mock.calls.map((call) => call[1])).toEqual([logo.id]);
    expect(document.querySelector(".game-hero-background")).toBeNull();
  },
);

it("keeps a legible logo ahead of key art when the Continue footprint shrinks", async () => {
  const { keyArt, logo, port, logoBytes } = controlledHeroMedia(true);
  keyArt.width = 960;
  keyArt.height = 240;
  vi.spyOn(desktopApi, "artwork").mockImplementation(async (id, slot) =>
    automaticArtwork(id, slot),
  );
  const media = vi
    .spyOn(desktopApi, "catalogMediaThumbnail")
    .mockImplementation(async (_id, mediaId, hash) => ({
      asset_sha256: hash,
      choice_revision: 0,
      png_base64: mediaId === keyArt.id ? controlledKeyArt(960, 240) : logoBytes,
    }));
  await page.viewport(1200, 900);
  await render(
    <div
      data-testid="continue-width"
      style={{ width: "900px", containerType: "inline-size", containerName: "library-query" }}
    >
      <ArtworkProvider generation={7} catalog={{ schema_version: 2, ports: [port] }}>
        <GameHero port={port} variant="continue">
          <h2>Sample</h2>
          <button>Continue controlled game</button>
        </GameHero>
      </ArtworkProvider>
    </div>,
  );
  await expect
    .poll(() => {
      const image = document.querySelector<HTMLImageElement>(".game-hero-image");
      return image?.complete && image.naturalWidth === logo.width;
    })
    .toBe(true);
  expect(document.querySelector(".game-hero")?.getAttribute("data-hero-identity")).toBe("logo");
  await page.getByRole("button", { name: "Continue controlled game", exact: true }).click();
  const action = document.activeElement;
  await act(async () => {
    const container = document.querySelector<HTMLElement>('[data-testid="continue-width"]');
    if (!container) throw new Error("Continue fixture missing");
    container.style.width = "240px";
  });
  await expect
    .poll(() => document.querySelector(".game-hero")?.getAttribute("data-hero-identity"))
    .toBe("logo");
  await expect.element(page.getByRole("heading", { name: "Sample", exact: true })).toBeVisible();
  expect(document.activeElement).toBe(action);
  expect(media.mock.calls.map((call) => call[1])).toEqual([logo.id]);
});

it.each(
  (["detail", "continue"] as const).flatMap((variant) =>
    (["readable", "blank", "padded", "sliver"] as const).map((ink) => ({ variant, ink })),
  ),
)("measures $ink opaque logo ink rather than its matte in $variant", async ({ variant, ink }) => {
  const { logo, port } = controlledHeroMedia(true);
  port.presentation.media = [logo];
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = 160;
  const drawing = canvas.getContext("2d");
  if (!drawing) throw new Error("Fixture canvas unavailable");
  drawing.fillStyle = "white";
  drawing.fillRect(0, 0, 160, 160);
  drawing.fillStyle = "black";
  if (ink === "readable" || ink === "padded") {
    drawing.font = ink === "readable" ? "bold 112px sans-serif" : "12px sans-serif";
    drawing.fillText("PC", ink === "readable" ? 5 : 70, ink === "readable" ? 128 : 80);
  } else if (ink === "sliver") drawing.fillRect(78, 0, 4, 160);
  const logoBytes = canvas.toDataURL("image/png").split(",")[1]!;
  vi.spyOn(desktopApi, "artwork").mockImplementation(async (id, slot) =>
    automaticArtwork(id, slot),
  );
  vi.spyOn(desktopApi, "artworkThumbnail").mockResolvedValue({
    asset_sha256: "b".repeat(64),
    choice_revision: 0,
    png_base64: png,
  });
  const media = vi
    .spyOn(desktopApi, "catalogMediaThumbnail")
    .mockImplementation(async (_id, _media, hash) => ({
      asset_sha256: hash,
      choice_revision: 0,
      png_base64: logoBytes,
    }));
  await page.viewport(1200, 900);
  await render(
    <ArtworkProvider generation={7} catalog={{ schema_version: 2, ports: [port] }}>
      <GameHero port={port} variant={variant}>
        <h1>Opaque controlled game</h1>
        <button>Play opaque controlled game</button>
      </GameHero>
    </ArtworkProvider>,
  );
  const readable = ink === "readable";
  await expect
    .poll(() => document.querySelector(".game-hero")?.getAttribute("data-hero-identity"))
    .toBe(readable ? "logo" : "cover");
  await expect
    .poll(() => document.querySelector(".game-hero-image")?.getAttribute("data-plate") ?? null)
    .toBe(readable ? "true" : null);
  await expect
    .poll(() => {
      const image = document.querySelector<HTMLImageElement>(".game-hero-image");
      return image?.complete && image.naturalWidth > 0;
    })
    .toBe(true);
  expect(document.querySelector(".game-hero-image")?.getAttribute("src")).toBe(
    `data:image/png;base64,${readable ? logoBytes : png}`,
  );
  await expect
    .element(page.getByRole("heading", { name: "Opaque controlled game", exact: true }))
    .toBeVisible();
  await expect
    .element(page.getByRole("button", { name: "Play opaque controlled game", exact: true }))
    .toBeVisible();
  expect(media.mock.calls.map((call) => call[1])).toEqual([logo.id]);
});
