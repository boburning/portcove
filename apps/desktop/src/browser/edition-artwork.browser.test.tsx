import { afterEach, expect, it, vi } from "vite-plus/test";
import { page } from "vite-plus/test/browser";
import { cleanup, render } from "vitest-browser-react";
import App from "../App";
import { desktopApi } from "../api";
import { workspace } from "../dev-scenarios/interactive/scenarios";
import { installInteractiveTransport } from "../dev-scenarios/interactive/transport";
import { initializeLocalization, LocalizationProvider } from "../localization";
import { artworkState, sourceInspectionIdentityFixture, sourceProfile } from "../test-fixtures";
import type { CatalogMediaAsset, OriginalGameIdentity } from "../types";
import "../styles/index.css";

const edition = "tomba-playstation";
const identity = {
  game_id: "tomba-psx",
  variant_id: "legacy-accepted",
  representation_id: "normalized-track-set",
};
// The signed revision 63 edition and Header coordinates, with inert fixture pixels.
const original: OriginalGameIdentity = {
  format_version: 1,
  id: "tomba",
  evidence_urls: ["https://github.com/mstan/TombaRecomp"],
  source_editions: [
    {
      id: edition,
      title: "Tomba! (PlayStation)",
      system: "playstation",
      evidence_urls: ["https://github.com/mstan/TombaRecomp"],
      verified_sources: [identity],
    },
  ],
};
const header: CatalogMediaAsset = {
  id: "igdb-header-original-257106",
  role: "header",
  subject: { kind: "original", game_id: original.id, source_edition_id: edition },
  caption: "Game background",
  url: "https://images.igdb.com/igdb/image/upload/t_720p/ar5idu.png",
  sha256: "3a252820abb58b74b3c6489bfae12e781a5e86fe6dfd4a1de67cde7ac038f752",
  width: 1280,
  height: 413,
  attribution: "Game artwork via IGDB",
  source_url: "https://www.igdb.com/games/tomba",
  license: "LicenseRef-IGDB-Terms",
  rights_url: "https://www.twitch.tv/p/en/legal/developer-agreement/",
  igdb: {
    game_id: 4097,
    record_id: 257106,
    kind: "artwork",
    image_id: "ar5idu",
    game_slug: "tomba",
    alpha_channel: false,
    image_type: 2,
    image_type_name: "Key art without logo",
  },
};

afterEach(async () => {
  await cleanup();
  vi.restoreAllMocks();
  localStorage.clear();
});

type Scene = "current" | "stale" | "wrong edition" | "withdrawn" | "offline" | "local override";

function sceneSnapshot(scene: Scene) {
  const snapshot = workspace("collection");
  const port = snapshot.catalog.ports[0]!;
  const status = snapshot.statuses[0]!;
  const report = sourceInspectionIdentityFixture();
  const source = report.registered!;
  const inspection = report.inspection!;

  port.name = "Tomba!: Recompiled";
  port.source_profile = source.profile_id;
  port.presentation = { ...port.presentation!, original_game_title: "Tomba!" };
  status.last_launched_at = 1;
  status.successful_launches = 1;
  status.readiness = {
    ...status.readiness!,
    source: "current",
    active_game_source_profile: source.profile_id,
  };
  snapshot.catalog.source_profiles = [{ ...sourceProfile(), id: source.profile_id }];
  snapshot.sources = [source];
  snapshot.listing_catalog = {
    format_version: 15,
    listings:
      scene === "withdrawn"
        ? []
        : [
            {
              id: port.id,
              name: port.name,
              summary: port.summary,
              project_url: port.project_url,
              platforms: port.platforms,
              availability: "unknown",
              original_game_title: "Tomba!",
              original_game: original,
              media: [header],
            },
          ],
  };
  inspection.assessment.classification = {
    state: "recognized",
    identity: scene === "wrong edition" ? { ...identity, variant_id: "other-release" } : identity,
  };
  report.original_editions = [
    { port_id: port.id, original_game_id: original.id, source_edition_id: edition },
  ];
  if (scene === "stale") report.registered = { ...source, updated_at: source.updated_at - 1 };
  return { snapshot, port, report };
}

function fixtureImage(color: string) {
  const canvas = document.createElement("canvas");
  canvas.width = header.width;
  canvas.height = header.height;
  const context = canvas.getContext("2d")!;
  context.fillStyle = color;
  context.fillRect(0, 0, canvas.width, canvas.height);
  return canvas.toDataURL("image/png");
}

const scenes: readonly Scene[] = [
  "current",
  "stale",
  "wrong edition",
  "withdrawn",
  "offline",
  "local override",
];

it.each(scenes)("renders %s edition artwork safely in Continue and Overview", async (scene) => {
  await page.viewport(1366, 900);
  const { snapshot, port, report } = sceneSnapshot(scene);
  const automaticImage = fixtureImage("#dcb4cc");
  const localImage = fixtureImage("#657962");
  const transport = installInteractiveTransport("collection", (message) => {
    throw new Error(message);
  });
  try {
    vi.spyOn(desktopApi, "workspaceSnapshot").mockResolvedValue(snapshot);
    const inspect = vi.spyOn(desktopApi, "inspectSource").mockResolvedValue(report);
    vi.spyOn(desktopApi, "artwork").mockImplementation(async (id, slot) =>
      artworkState(id, slot, 0, id === port.id && slot === "detail" && scene === "local override"),
    );
    vi.spyOn(desktopApi, "artworkThumbnail").mockResolvedValue({
      asset_sha256: artworkState(port.id, "detail", 0, true).choice.asset_sha256!,
      choice_revision: 0,
      png_base64: localImage.split(",")[1]!,
    });
    const thumbnail = vi
      .spyOn(desktopApi, "catalogMediaThumbnail")
      .mockImplementation(async (_port, _id, digest) => {
        if (scene === "offline") throw new Error("Fixture provider unavailable");
        return {
          asset_sha256: digest,
          choice_revision: 0,
          png_base64: automaticImage.split(",")[1]!,
        };
      });
    initializeLocalization(["en"]);
    await render(
      <LocalizationProvider api={desktopApi}>
        <App />
      </LocalizationProvider>,
    );
    const details = page.getByRole("button", { name: "Game details", exact: true });
    await expect.element(details).toBeVisible();

    const expectedImage =
      scene === "current" ? automaticImage : scene === "local override" ? localImage : undefined;
    const expectedInspection = scene === "withdrawn" ? undefined : [report.profile_id, 1];
    const expectedThumbnail =
      scene === "current" || scene === "offline"
        ? [port.id, header.id, header.sha256, 1]
        : undefined;
    const verifyHero = async () => {
      await expect.poll(() => inspect.mock.calls[0]).toEqual(expectedInspection);
      // Give the completed source read and any thumbnail effect a chance to paint.
      await new Promise<void>((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
      );
      await expect.poll(() => thumbnail.mock.calls[0]).toEqual(expectedThumbnail);
      await expect
        .poll(() => {
          const hero = document.querySelector(".game-hero");
          const image = hero?.querySelector<HTMLImageElement>(".game-hero-background img");
          return [hero?.getAttribute("data-hero-identity"), image?.src, image?.naturalWidth];
        })
        .toEqual(["text", expectedImage, expectedImage ? header.width : undefined]);
    };
    await verifyHero();
    if (scene === "current") thumbnail.mockRejectedValue(new Error("Fixture went offline"));
    await details.click();
    await expect.element(page.getByRole("tab", { name: "Overview", exact: true })).toBeVisible();
    await expect.element(page.getByRole("heading", { name: "Tomba!", exact: true })).toBeVisible();
    await verifyHero();

    const expectedReads =
      scene === "offline"
        ? thumbnail.mock.calls.map(() => expectedThumbnail)
        : expectedThumbnail
          ? [expectedThumbnail]
          : [];
    expect(thumbnail.mock.calls).toEqual(expectedReads);
  } finally {
    await cleanup();
    transport.dispose();
  }
});
