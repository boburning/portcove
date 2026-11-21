import { describe, expect, it } from "vite-plus/test";
import {
  activeSourceHeroMediaContext,
  canCheckEditionArtwork,
  heroMediaCandidates,
  verifiedHeroMediaContext,
} from "./hero-media";
import { portDefinition, portStatus, sourceInspectionIdentityFixture } from "./test-fixtures";
import type { CatalogMediaAsset, PortStatus } from "./types";

function asset(id: string, role: CatalogMediaAsset["role"], original = false): CatalogMediaAsset {
  return {
    id,
    role,
    subject: original
      ? { kind: "original", game_id: "original", source_edition_id: "edition" }
      : { kind: "port", port_id: "sample" },
    caption: "Descriptive test media",
    url: "https://example.invalid/fixture.png",
    sha256: "a".repeat(64),
    edition_neutral: true,
    width: 400,
    height: 200,
    attribution: "Test fixture",
    source_url: "https://example.invalid/source",
    license: "CC0-1.0",
    rights_url: "https://example.invalid/rights",
    ...(role === "logo" || role === "key_art"
      ? {
          igdb: {
            game_id: 1,
            record_id: 2,
            kind: role === "logo" ? "logo" : "artwork",
            image_id: "test",
            game_slug: "test",
          },
        }
      : {}),
  };
}
function port(media: CatalogMediaAsset[]) {
  const p = portDefinition();
  return {
    ...p,
    presentation: {
      ...p.presentation!,
      media,
      original_game: {
        format_version: 1,
        id: "original",
        evidence_urls: ["https://example.invalid/game"],
        source_editions: [
          { id: "edition", title: "Edition", evidence_urls: ["https://example.invalid/edition"] },
        ],
      },
    },
  };
}
it("requires a current registered game, port and edition before displaying matched art", () => {
  const image = { ...asset("header", "header", true), edition_neutral: false };
  const p = port([image]);
  const report = sourceInspectionIdentityFixture();
  const source = report.registered!;
  const match = { port_id: p.id, original_game_id: "original", source_edition_id: "edition" };
  const checked = { ...report, original_editions: [match] };

  expect(canCheckEditionArtwork(p)).toBe(false);
  const bound = {
    ...p,
    presentation: {
      ...p.presentation,
      original_game: {
        ...p.presentation.original_game,
        source_editions: p.presentation.original_game.source_editions.map((edition) => ({
          ...edition,
          verified_sources: [{ game_id: "game", variant_id: "edition", representation_id: "raw" }],
        })),
      },
    },
  };
  expect(canCheckEditionArtwork(bound)).toBe(true);
  const context = verifiedHeroMediaContext(bound, source, checked);
  expect(heroMediaCandidates(bound, context).backgrounds).toEqual([image]);
  const readiness = {
    blockers: [],
    launchable: true,
    pending_setup: false,
    source: "not_checked" as const,
    active_game_source_profile: source.profile_id,
  };
  const active: PortStatus = {
    ...portStatus(),
    active: {
      id: "exact-install",
      port_id: bound.id,
      version: "v1",
      path: "/fixture/install",
      channel: "stable",
      installed_at: 1,
      verified: true,
      staged: false,
      artifact: { asset_name: "port.zip", sha256: "d".repeat(64), size: 1 },
      runtime: null,
      manifest_sha256: "f".repeat(64),
      selected_executable: "port",
    },
    readiness,
  };
  expect(activeSourceHeroMediaContext(bound, active, source, checked)).toEqual(context);
  expect(activeSourceHeroMediaContext(bound, active, source, undefined)).toEqual({});
  expect(
    activeSourceHeroMediaContext(
      bound,
      { ...active, readiness: { ...readiness, source: "missing" } },
      source,
      checked,
    ),
  ).toEqual({});

  expect(
    activeSourceHeroMediaContext(bound, active, { ...source, profile_id: "wrong" }, undefined),
  ).toEqual({});
  expect(
    activeSourceHeroMediaContext(bound, active, source, { ...checked, health: "changed" }),
  ).toEqual({});

  expect(
    activeSourceHeroMediaContext(bound, { ...active, readiness: null }, source, checked),
  ).toEqual({});
  expect(
    activeSourceHeroMediaContext(
      bound,
      {
        ...active,
        readiness: {
          ...readiness,
          active_game_source_profile: null,
          preparation_mode: "source_only",
        },
      },
      source,
      checked,
    ),
  ).toEqual({});
  expect(
    activeSourceHeroMediaContext(
      bound,
      {
        ...active,
        readiness: {
          ...readiness,
          active_game_source_profile: "other-active-source",
        },
      },
      source,
      checked,
    ),
  ).toEqual({});
  expect(verifiedHeroMediaContext(bound, source, report)).toEqual({});
  expect(verifiedHeroMediaContext(bound, source, checked, p.presentation.original_game)).toEqual(
    {},
  );
  const renamedTuple = {
    ...bound.presentation.original_game,
    source_editions: bound.presentation.original_game.source_editions.map((edition) => ({
      ...edition,
      verified_sources: [{ ...edition.verified_sources[0]!, representation_id: "new-layout" }],
    })),
  };
  expect(verifiedHeroMediaContext(bound, source, checked, renamedTuple)).toEqual({});
  expect(verifiedHeroMediaContext(bound, { ...source, updated_at: 2 }, checked)).toEqual({});
  expect(verifiedHeroMediaContext(bound, source, { ...checked, health: "changed" })).toEqual({});
  for (const wrong of [
    { ...match, port_id: "other-port" },
    { ...match, original_game_id: "other-game" },
    { ...match, source_edition_id: "other-edition" },
  ]) {
    const outOfScope = { ...checked, original_editions: [wrong] };
    expect(verifiedHeroMediaContext(bound, source, outOfScope)).toEqual({});
  }
  const conflicting = { ...checked, original_editions: [match, match] };
  expect(verifiedHeroMediaContext(bound, source, conflicting)).toEqual({});
});

describe("shared hero media roles", () => {
  it("prefers exact-port logos then applicable original logos, leaving cover fallback to the hero", () => {
    const media = [
      asset("original-logo", "logo", true),
      asset("port-logo", "logo"),
      asset("original-key", "key_art", true),
      asset("port-key", "key_art"),
    ];
    expect(heroMediaCandidates(port(media)).foreground.map((item) => item.id)).toEqual([
      "port-logo",
      "original-logo",
    ]);
    expect(media[0]!.id).toBe("original-logo");
  });
  it("does not turn an offered edition into an applicable installation identity", () => {
    const image = asset("edition-logo", "logo", true);
    image.edition_neutral = false;
    const p = port([image]);
    expect(heroMediaCandidates(p).foreground).toEqual([]);
    expect(heroMediaCandidates(p, { originalEditionId: "another-edition" }).foreground).toEqual([]);
    expect(heroMediaCandidates(p, { originalEditionId: "edition" }).foreground).toEqual([image]);
  });
  it.each(["logo", "header"] as const)(
    "orders automatic %s by exact port, applicable edition, then neutral fallback",
    (role) => {
      const neutral = asset("neutral", role, true);
      const applicable = { ...asset("applicable", role, true), edition_neutral: false };
      const direct = asset("direct", role);
      const candidates = role === "logo" ? "foreground" : "backgrounds";
      const context = { originalEditionId: "edition" };

      expect(heroMediaCandidates(port([neutral, applicable, direct]), context)[candidates]).toEqual(
        [direct, applicable],
      );
      expect(heroMediaCandidates(port([neutral, applicable]), context)[candidates]).toEqual([
        applicable,
        neutral,
      ]);
      expect(heroMediaCandidates(port([neutral, applicable]))[candidates]).toEqual([neutral]);
    },
  );

  it("keeps background and gallery available without any foreground candidate", () => {
    const header = asset("background", "header");
    const screenshot = asset("screen", "screenshot");
    const result = heroMediaCandidates(port([screenshot, header]));
    expect(result.foreground).toEqual([]);
    expect(result.backgrounds).toEqual([header]);
    expect(result.screenshots).toEqual([screenshot]);
  });
  it("refuses unrelated ports and original editions even when image labels look the same", () => {
    const foreign = asset("foreign", "logo");
    foreign.subject = { kind: "port", port_id: "other-port" };
    const edition = asset("wrong-edition", "key_art", true);
    edition.subject = { kind: "original", game_id: "original", source_edition_id: "not-offered" };
    expect(heroMediaCandidates(port([foreign, edition])).foreground).toEqual([]);
  });
  it("requires actual edition applicability or reviewed neutrality for every media role", () => {
    const media = (["key_art", "logo", "header", "screenshot"] as const).map((role) => {
      const image = asset(`original-${role}`, role, true);
      image.edition_neutral = false;
      return image;
    });
    expect(heroMediaCandidates(port(media))).toEqual({
      foreground: [],
      backgrounds: [],
      screenshots: [],
    });
    const applicable = heroMediaCandidates(port(media), { originalEditionId: "edition" });
    expect(applicable.foreground).toHaveLength(1);
    expect(applicable.backgrounds).toHaveLength(1);
    expect(applicable.screenshots).toHaveLength(1);
    media.forEach((image) => {
      image.edition_neutral = true;
    });
    expect(heroMediaCandidates(port(media))).toEqual(applicable);
  });
});
