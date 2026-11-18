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

it("keeps a matching project name from repeating the game title", () => {
  const selfNamed = {
    ...first,
    name: "Endless Sky",
    presentation: {
      ...first.presentation!,
      original_game_title: " Endless Sky ",
      variant_label: null,
    },
  };
  expect(gameProjectLabel(selfNamed)).toBeUndefined();
  expect(gameProjectLabel({ name: " Endless Sky " })).toBeUndefined();
  expect(gameIdentityLabel(selfNamed)).toBe("Endless Sky");
  expect(
    gameIdentityLabel({
      ...selfNamed,
      presentation: { ...selfNamed.presentation, variant_label: "Portable edition" },
    }),
  ).toBe("Endless Sky · Portable edition");

  const html = renderToStaticMarkup(
    <PortBrowser
      view="catalog"
      ports={[selfNamed]}
      statuses={new Map()}
      overview={{ installed: 0, ready: 0, needsSetup: 0, staged: 0 }}
      filter="all"
      setFilter={vi.fn()}
      onSelect={vi.fn()}
      loading={false}
    />,
  );
  expect(html).toContain('aria-label="Endless Sky.');
  expect(html).not.toContain("Endless Sky Endless Sky");
  expect(html).not.toContain("Endless Sky · Endless Sky");
  expect(html).not.toContain("collection-project");
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

it.each([
  ["A Familiar Adventure — Cobalt Project", "Cobalt Project"],
  ["A Familiar Adventure — A Familiar Adventure — Cobalt Project", "Cobalt Project"],
  ["A Familiar Adventure — A Familiar Adventure", undefined],
  ["A Familiar Adventure — ", undefined],
  ["A Familiar Adventure Recompiled", "A Familiar Adventure Recompiled"],
  ["A Familiar Adventure: Second Voyage", "A Familiar Adventure: Second Voyage"],
  ["A Familiar Adventure—Cobalt Project", "A Familiar Adventure—Cobalt Project"],
  ["A Familiar Adventure - Cobalt Project", "A Familiar Adventure - Cobalt Project"],
  ["A Familiar Adventures — Cobalt Project", "A Familiar Adventures — Cobalt Project"],
])("removes only separated exact leading titles from %s", (name, expected) => {
  const port = { ...first, name, presentation: { ...first.presentation!, variant_label: null } };
  expect(gameProjectLabel(port)).toBe(expected);
  expect(port.name).toBe(name);
  expect(gameProjectLabel({ name })).toBeUndefined();
});

it("keeps variants and raw catalog search after removing a repeated project prefix", () => {
  const port = { ...first, name: "A Familiar Adventure — Cobalt Project" };
  expect(gameProjectLabel(port)).toBe("Cobalt Project · US edition");
  expect(gameIdentityLabel(port)).toBe("A Familiar Adventure · Cobalt Project · US edition");
  for (const query of [port.name, port.id, "us edition", "cobalt"]) {
    expect(filterPorts([port], new Map(), "catalog", "all", query)).toEqual([port]);
  }
  const html = renderToStaticMarkup(
    <PortBrowser
      view="catalog"
      ports={[port]}
      statuses={new Map()}
      overview={{ installed: 0, ready: 0, needsSetup: 0, staged: 0 }}
      filter="all"
      setFilter={vi.fn()}
      onSelect={vi.fn()}
      loading={false}
    />,
  );
  expect(html).toContain("Cobalt Project · US edition");
  expect(html).toContain('aria-label="A Familiar Adventure Cobalt Project · US edition.');
  expect(html).toContain('data-detail-origin="catalog:card:project-one"');
  expect(html).not.toContain("A Familiar Adventure —");
});

it("keeps a variant when the separated title has no remaining project", () => {
  const port = { ...first, name: "A Familiar Adventure — " };
  expect(gameProjectLabel(port)).toBe("US edition");
  expect(gameIdentityLabel(port)).toBe("A Familiar Adventure · US edition");
  expect(gameProjectLabel({ name: "" })).toBeUndefined();
  expect(
    gameProjectLabel({ name: "", presentation: { original_game_title: "A Familiar Adventure" } }),
  ).toBe("");
});

it("renders distinct game-led cards with full project and variant identity", () => {
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
  expect(html).toContain("Cobalt Project · US edition");
  expect(html).toContain("Amber Recompiled");
  const cards = [
    ...html.matchAll(
      /<button[^>]*data-detail-origin="catalog:card:(?:project-one|project-two)"[^>]*>[\s\S]*?<\/button>/gu,
    ),
  ];
  expect(cards).toHaveLength(2);
  expect(cards[0]![0]).toContain("Cobalt Project");
  expect(cards[0]![0]).toContain("US edition");
  expect(cards[1]![0]).toContain("Amber Recompiled");
  expect(cards[0]![0]).toContain('aria-label="A Familiar Adventure Cobalt Project · US edition.');
  expect(cards[1]![0]).toContain('aria-label="A Familiar Adventure Amber Recompiled.');
  for (const [card] of cards) {
    expect(card).toMatch(/<h2[^>]*>A Familiar Adventure<\/h2>/u);
    expect(card).toMatch(/<p[^>]*class="collection-project [^"]*"/u);
    expect(card).not.toContain(" disabled=");
  }
  expect(html).toContain('data-discover-port-ids="[&quot;project-one&quot;]"');
  expect(html).toContain('data-discover-port-ids="[&quot;project-two&quot;]"');
  expect(cards[0]![0]).toContain('data-detail-origin="catalog:card:project-one"');
  expect(cards[1]![0]).toContain('data-detail-origin="catalog:card:project-two"');
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
