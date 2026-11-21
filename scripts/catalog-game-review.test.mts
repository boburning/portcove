import assert from "node:assert/strict";
import test from "node:test";
import {
  checkOriginalGameConsistency,
  requireOriginalGameDecision,
} from "./catalog-game-review.mts";
import { checkedAuthoredPort, projectAuthoredPort } from "./catalog-authoring.mts";

const record = (id: string, game?: string) =>
  checkedAuthoredPort({
    format_version: 1,
    listing: {
      id,
      name: "Same Game",
      summary: "An independently maintained implementation.",
      project_url: `https://github.com/example/${id}`,
      original_game_title: "Same Game",
      ...(game
        ? {
            original_game: {
              format_version: 1,
              id: game,
              evidence_urls: ["https://example.org/review"],
              source_editions: [],
            },
          }
        : {}),
    },
  });

void test("new preparation needs a reviewed grouping decision; an older unresolved record stays readable", () => {
  const legacy = record("legacy");
  assert.equal(projectAuthoredPort(legacy), undefined);
  assert.throws(() => requireOriginalGameDecision(legacy), /review original-game grouping/u);
  assert.doesNotThrow(() =>
    requireOriginalGameDecision({
      ...legacy,
      original_game_review: {
        disposition: "multi-game",
        reason: "The upstream engine supports several separately named original games.",
        evidence_urls: ["https://example.org/supported-games"],
      },
    }),
  );
});

void test("candidate known families cannot acquire false uniqueness without reviewed separation", () => {
  const known = record("known", "original-game");
  const newPort = record("new-port", "new-port");
  assert.throws(() => requireOriginalGameDecision(newPort, [known]), /known family/u);
  assert.doesNotThrow(() =>
    requireOriginalGameDecision(
      {
        ...newPort,
        original_game_review: {
          disposition: "separate",
          reason:
            "This implementation targets the separately developed remake, rather than the earlier same-name game.",
          evidence_urls: ["https://example.org/remake"],
        },
      },
      [known],
    ),
  );
});

void test("same edition accepts naming/provenance aliases but refuses contradictory original systems", () => {
  const a = record("a", "shared"),
    b = record("b", "shared");
  a.listing.original_game!.source_editions = [
    {
      id: "retail",
      title: "US retail",
      system: "nintendo-64",
      evidence_urls: ["https://example.org/a"],
    },
  ];
  b.listing.original_game!.source_editions = [
    {
      id: "retail",
      title: "USA cartridge",
      system: "nintendo-64",
      evidence_urls: ["https://example.org/b"],
    },
  ];
  assert.doesNotThrow(() => checkOriginalGameConsistency([a, b]));
  b.listing.original_game!.source_editions[0]!.system = "playstation";
  assert.throws(() => checkOriginalGameConsistency([a, b]), /contradicts/u);
});

void test("a non-single-game disposition cannot mask a conflicting single-game mapping", () => {
  const known = record("known", "original-game");
  for (const disposition of ["unresolved", "multi-game", "helper", "framework"] as const) {
    const reviewed = {
      ...known,
      original_game_review: {
        disposition,
        reason: "Specific multi-game or missing-source scope.",
        evidence_urls: ["https://example.org/scope"],
      },
    };
    assert.throws(() => checkedAuthoredPort(reviewed), /cannot also assign/u);
    assert.throws(() => requireOriginalGameDecision(reviewed), /contradicts/u);
  }
});
