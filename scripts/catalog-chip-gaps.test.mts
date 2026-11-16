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
    ],
  };
  const catalog = {
    ports: [{ id: "managed", platforms: ["windows-x86-64"], channels: [] }],
  };
  const report = auditChipGaps(listings, catalog);
  const byId = new Map(report.gaps.map((gap) => [gap.id, gap]));

  assert.equal(byId.has("reviewed"), false);
  assert.equal(byId.get("sibling")?.originalSystem, "no-game-identity-with-title");
  assert.deepEqual(byId.get("sibling")?.candidateSystems, ["nintendo-64"]);
  assert.equal(byId.get("sibling")?.platforms, "no-platforms");
  assert.equal(byId.get("untitled")?.originalSystem, "no-game-identity-no-title");
  assert.equal(byId.get("untitled")?.platforms, undefined);
  assert.equal(byId.get("no-system")?.originalSystem, "edition-without-system");
  assert.equal(byId.get("managed")?.channel, "integrated-without-channel");
  assert.equal(report.counts["channel:listing-only-not-applicable"], 4);
  assert.match(renderChipGapSummary(report), /candidate systems from reviewed siblings: 1/u);
});
