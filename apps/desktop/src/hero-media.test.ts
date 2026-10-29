import { describe, expect, it } from "vite-plus/test";
import { heroMediaCandidates } from "./hero-media";
import { portDefinition } from "./test-fixtures";
import type { CatalogMediaAsset } from "./types";

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
describe("shared hero media roles", () => {
  it("prefers key art before logos and exact ports before originals within each role", () => {
    const media = [
      asset("original-logo", "logo", true),
      asset("port-logo", "logo"),
      asset("original-key", "key_art", true),
      asset("port-key", "key_art"),
    ];
    expect(heroMediaCandidates(port(media)).foreground.map((item) => item.id)).toEqual([
      "port-key",
      "original-key",
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
    expect(applicable.foreground).toHaveLength(2);
    expect(applicable.backgrounds).toHaveLength(1);
    expect(applicable.screenshots).toHaveLength(1);
    media.forEach((image) => {
      image.edition_neutral = true;
    });
    expect(heroMediaCandidates(port(media))).toEqual(applicable);
  });
});
