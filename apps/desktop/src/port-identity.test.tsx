import { renderToStaticMarkup } from "react-dom/server";
import { expect, it, vi } from "vite-plus/test";
import { PortBrowser } from "./components/PortBrowser";
import { gameTitle, gameProjectLabel, gameIdentityLabel } from "./port-identity";
import { portDefinition } from "./test-fixtures";
import { filterPorts } from "./view-model";
import type { PortDefinition } from "./types";

const first: PortDefinition = {
  ...portDefinition(),
  id: "project-one",
  name: "Cobalt Project",
  presentation: {
    original_game_title: "A Familiar Adventure",
    variant_label: "US edition",
    installation_method: "portable-package",
    source_requirements: [],
    saves_and_settings: "portcove-managed",
  },
};
const second: PortDefinition = {
  ...first,
  id: "project-two",
  name: "Amber Recompiled",
  presentation: { ...first.presentation!, variant_label: null },
};

it("retains the project fallback for older catalogs and keeps distinct implementations", () => {
  const old = portDefinition();
  expect(gameTitle(old)).toBe(old.name);
  expect(gameProjectLabel(old)).toBeUndefined();
  expect(gameIdentityLabel(old)).toBe(old.name);
  expect(gameTitle(first)).toBe(gameTitle(second));
  expect(gameIdentityLabel(first)).toBe("A Familiar Adventure · Cobalt Project · US edition");
  expect(gameIdentityLabel(second)).toBe("A Familiar Adventure · Amber Recompiled");
  expect(first.id).not.toBe(second.id);
});

it("finds the known game, port project and variant without grouping results", () => {
  for (const query of ["familiar adventure", "cobalt", "us edition", "project-one"]) {
    const found = filterPorts([first, second], new Map(), "catalog", "all", query);
    expect(found.map((port) => port.id)).toEqual(
      query === "familiar adventure" ? [first.id, second.id] : [first.id],
    );
  }
  const laterGame = {
    ...second,
    presentation: { ...second.presentation!, original_game_title: "Zebra Adventure" },
  };
  const sorted = filterPorts([first, laterGame], new Map(), "catalog", "all", "", "name");
  expect(sorted.map((port) => port.id)).toEqual([first.id, second.id]);
});

it("renders game-led cards with separate full project and variant labels", () => {
  const html = renderToStaticMarkup(
    <PortBrowser
      view="catalog"
      ports={[first, second]}
      statuses={new Map()}
      overview={{ installed: 0, ready: 0, needsSetup: 0, staged: 0 }}
      filter="all"
      setFilter={vi.fn()}
      onSelect={vi.fn()}
      loading={false}
    />,
  );
  expect(html).toContain("A Familiar Adventure");
  expect(html).toContain('title="Cobalt Project"');
  expect(html).toContain(">US edition</span>");
  expect(html).toContain('title="Amber Recompiled"');
  const cards = [
    ...html.matchAll(
      /<button[^>]*data-detail-origin="catalog:card:[^"]+"[^>]*>[\s\S]*?<\/button>/gu,
    ),
  ];
  expect(cards).toHaveLength(2);
  expect(cards[0]![0]).toContain("Cobalt Project");
  expect(cards[0]![0]).toContain("US edition");
  expect(cards[1]![0]).toContain("Amber Recompiled");
  for (const [card] of cards) {
    expect(card).toContain("A Familiar Adventure");
    expect(card).not.toContain("aria-label=");
  }
});

it("finds Pokémon Red using ordinary ASCII spelling without changing the display", () => {
  const red = {
    ...first,
    id: "gen1recomp",
    name: "Gen1Recomp",
    summary: "Native recreation",
    presentation: { ...first.presentation!, original_game_title: "Pokémon Red" },
  };
  for (const query of ["pokemon", "pokemon red", "POKÉMON RED", "Pokémon"]) {
    expect(filterPorts([red], new Map(), "catalog", "all", query).map((port) => port.id)).toEqual([
      "gen1recomp",
    ]);
  }
  expect(gameTitle(red)).toBe("Pokémon Red");
});
