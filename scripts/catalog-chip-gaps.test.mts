import { fileURLToPath } from "node:url";
import { readCatalogSource } from "./catalog-authoring.mts";
import assert from "node:assert/strict";
import test from "node:test";
import { auditChipGaps, renderChipGapSummary } from "./catalog-chip-gaps.mts";

const game = (system?: string) => ({
  format_version: 1,
  id: "zelda",
  source_editions: [{ id: "e", title: "E", ...(system ? { system } : {}) }],
});

void test("classifies each chip gap without treating unknown as wrong", () => {
  const listings = {
    listings: [
      {
        id: "reviewed",
        original_game_title: "Zelda",
        original_game: game("nintendo-64"),
        platforms: ["windows-x86-64"],
      },
      { id: "sibling", original_game_title: "ZELDA!", availability: "unknown" },
      { id: "untitled", availability: "packages", platforms: ["windows-x86-64"] },
      { id: "no-system", original_game: game(), platforms: ["linux-x86-64"] },
      { id: "managed", original_game_title: "Other", platforms: [] },
      { id: "engine", original_game_title: "Zelda", platforms: ["windows-x86-64"] },
    ],
  };
  const catalog = {
    ports: [{ id: "managed", platforms: ["windows-x86-64"], channels: [] }],
  };
  const report = auditChipGaps(listings, catalog, [
    {
      format_version: 1,
      listing: {
        id: "engine",
        name: "Engine",
        summary: "Separate games.",
        project_url: "https://example.com",
      },
      original_game_review: {
        disposition: "multi-game",
        reason: "Supports several games.",
        evidence_urls: ["https://example.com"],
      },
    },
  ]);
  const byId = new Map(report.gaps.map((gap) => [gap.id, gap]));

  assert.equal(byId.has("reviewed"), false);
  assert.equal(byId.get("sibling")?.originalSystem, "no-game-identity-with-title");
  assert.deepEqual(byId.get("sibling")?.titleMatchResearchLeads, ["nintendo-64"]);
  assert.equal(byId.get("sibling")?.platforms, "no-platforms");
  assert.equal(byId.get("untitled")?.originalSystem, "no-game-identity-no-title");
  assert.equal(byId.get("untitled")?.platforms, undefined);
  assert.equal(byId.get("no-system")?.originalSystem, "edition-without-system");
  assert.equal(byId.get("managed")?.channel, "integrated-without-channel");
  assert.equal(byId.get("engine")?.disposition, "multi-game");
  assert.equal(byId.get("engine")?.originalSystem, undefined);
  assert.equal(byId.get("engine")?.titleMatchResearchLeads, undefined);
  assert.deepEqual(report.coverage, { sourceSystems: 1, supportedOs: 5, upstreamManaged: 5 });
  assert.match(renderChipGapSummary(report), /Same-title research leads: 1/u);
});

void test("production rows preserve the reviewed game and source boundaries", () => {
  const { records, catalog, directory } = readCatalogSource(
    fileURLToPath(new URL("../crates/portcove-core/catalog", import.meta.url)),
  );
  const byId = new Map(directory.listings.map((listing) => [listing.id, listing]));
  const remake = byId.get("ajncsystem-shadowofthecolossus-pc")!;
  assert.equal(remake.original_game?.id, "shadow-of-the-colossus-2018");
  assert.deepEqual(
    remake.original_game?.source_editions.map(({ system }) => system),
    ["playstation-4", "playstation-4"],
  );
  assert.match(JSON.stringify(remake.manual_setup), /CUSA08809 EU1\.01.*CUSA08034 US1\.00/u);
  assert.equal(
    byId.get("celosia-henrykun55-shadow-of-the-colossus")?.original_game?.id,
    "shadow-of-the-colossus",
  );

  const xbla = byId.get("crazy-taxi-static-recompilation-sp00nznet-crazy-taxi-xbox-live-arcade")!;
  const ps3 = byId.get("crazy-taxi-ps3-recomp-sp00nznet-crazy-taxi")!;
  assert.equal(xbla.original_game?.id, "crazy-taxi");
  assert.equal(ps3.original_game?.id, "crazy-taxi");
  assert.deepEqual(
    xbla.original_game?.source_editions.map(({ system }) => system),
    ["xbox-360"],
  );
  assert.deepEqual(
    ps3.original_game?.source_editions.map(({ system }) => system),
    ["playstation-3"],
  );
  assert.notEqual(xbla.project_url, ps3.project_url);

  const chocolate = records.find(({ listing }) => listing.id === "chocolate-doom-family")!;
  assert.equal(chocolate.original_game_review?.disposition, "multi-game");
  assert.equal(chocolate.listing.original_game, undefined);
  for (const player of ["Doom", "Heretic", "Hexen", "Strife"]) {
    assert.match(
      JSON.stringify(chocolate.listing.manual_setup),
      new RegExp(`chocolate[- ]${player}`, "iu"),
    );
  }

  const family = directory.listings.filter(
    (listing) => listing.original_game?.id === "super-mario-64",
  );
  for (const id of [
    "ghostship",
    "render96ex",
    "super-mario-64-sm64-co-op-dx",
    "n64hub-super-mario-64-recomp",
  ]) {
    assert.ok(
      family.some((listing) => listing.id === id),
      id,
    );
  }
  const authoredGhostship = records.find(({ listing }) => listing.id === "ghostship")!;
  assert.equal(
    catalog.ports.find((port) => port.id === "ghostship")?.source_profile,
    "ghostship-source",
  );
  assert.match(JSON.stringify(authoredGhostship.listing.manual_setup), /separately prepared copy/u);
});
