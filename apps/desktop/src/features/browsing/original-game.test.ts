import { expect, it } from "vite-plus/test";
import { portDefinition } from "../../test-fixtures";
import type { CatalogEntry } from "./catalog-entry";
import { gameGroupId, groupCatalog, groupCountLabel, originalSystems } from "./original-game";

function entry(id: string, gameId?: string, systems: (string | undefined)[] = []): CatalogEntry {
  const base = portDefinition();
  return {
    ...base,
    id,
    name: "The same display title",
    presentation: {
      original_game_title: "The same display title",
      ...(gameId
        ? {
            original_game: {
              format_version: 1,
              id: gameId,
              evidence_urls: ["https://example.org/source"],
              source_editions: systems.map((system, index) => ({
                id: `edition-${index}`,
                title: `Edition ${index}`,
                evidence_urls: ["https://example.org/source"],
                ...(system ? { system } : {}),
              })),
            },
          }
        : {}),
    },
  };
}

it("groups only explicit stable game identities and never merges equal unknown titles", () => {
  const first = entry("first-port", "original-game");
  const renamed = { ...entry("second-port", "original-game"), name: "A renamed port project" };
  const anotherEdition = entry("another-game", "explicit-different-game");
  const unknownOne = entry("unknown-one");
  const unknownTwo = entry("unknown-two");
  expect(
    groupCatalog([first, renamed, anotherEdition, unknownOne, unknownTwo]).map((group) => [
      group.id,
      group.ports.map((port) => port.id),
    ]),
  ).toEqual([
    ["game:original-game", ["first-port", "second-port"]],
    ["game:explicit-different-game", ["another-game"]],
    ["port:unknown-one", ["unknown-one"]],
    ["port:unknown-two", ["unknown-two"]],
  ]);
  expect(gameGroupId({ ...first, name: "Changed again" })).toBe(gameGroupId(first));
});

it("retains total distinct ports when filters leave one match and ignores duplicate input rows", () => {
  const first = entry("first-port", "original-game");
  const second = entry("second-port", "original-game");
  const groups = groupCatalog([first, first, second], [second, second]);
  expect(groups).toHaveLength(1);
  expect(groups[0]?.ports.map((port) => port.id)).toEqual(["first-port", "second-port"]);
  expect(groups[0]?.matchingPorts.map((port) => port.id)).toEqual(["second-port"]);
});

it("reports every explicit source system independently of target OS and retains unknown editions", () => {
  const multiple = entry("many-editions", "original", [
    "nintendo-64",
    "nintendo-64dd",
    "nintendo-64",
    undefined,
  ]);
  expect(originalSystems(multiple)).toEqual(["nintendo-64", "nintendo-64dd", "not-specified"]);
  expect(originalSystems(entry("empty-editions", "original"))).toEqual(["not-specified"]);
  expect(originalSystems(entry("unknown"))).toEqual(["not-specified"]);
  const listingIdentity = multiple.presentation!.original_game!;
  expect(
    originalSystems({
      id: "listing",
      name: "Listing",
      summary: "",
      platforms: ["linux-x86-64"],
      listing: {
        id: "listing",
        name: "Listing",
        summary: "",
        project_url: "https://example.org/source",
        availability: "unknown",
        platforms: [],
        original_game: listingIdentity,
      },
    }),
  ).toEqual(originalSystems(multiple));
});

it("does not label unknown project identities as verified unique games", () => {
  expect(groupCountLabel(groupCatalog([entry("unknown-one"), entry("unknown-two")]))).toBe(
    "2 ungrouped projects",
  );
  expect(groupCountLabel(groupCatalog([entry("known", "game"), entry("unknown")]))).toBe(
    "1 game + 1 ungrouped project",
  );
});
