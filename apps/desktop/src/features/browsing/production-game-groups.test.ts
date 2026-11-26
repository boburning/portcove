import { expect, it, vi } from "vite-plus/test";
import expected from "../../../../../scripts/fixtures/game-first-catalog-relationships.json";
import embedded from "../../../../../crates/portcove-core/catalog/catalog.json";
import directory from "../../../../../crates/portcove-core/catalog/listings.json";
import definitionIndex from "../../../../../release/catalog-publication/bundle/definitions/index.json";
import type { CatalogDocument, CatalogListingDocument, PortDefinition } from "../../types";
import { catalogEntries } from "./catalog-entry";
import { commandSurfaceCommands } from "../../use-command-surface";
import { filterCommands } from "../../components/CommandPalette";
import { gameGroupId, gameGroupTitle, groupCatalog } from "./original-game";

const canonicalDefinitions = embedded as unknown as CatalogDocument;
const canonicalDirectory = directory as unknown as CatalogListingDocument;
const entries = catalogEntries(canonicalDefinitions, canonicalDirectory, [], []);
const groups = groupCatalog(entries);
// Frozen independently reviewed relationships, never generated from the tested output.
const reviewed = expected.families;
const auditedPortIds = new Set(expected.audited_port_ids);

function auditedMembers(ids: readonly string[], selected?: string) {
  return ids.filter((id) => auditedPortIds.has(id) || id === selected).sort();
}

function declaredGroups(ports: readonly PortDefinition[]) {
  const declarations = new Map(canonicalDirectory.listings.map((row) => [row.id, row]));
  const definitions = new Map(ports.map((row) => [row.id, row]));
  const expectedGroups = new Map<string, string[]>();
  for (const id of new Set([...declarations.keys(), ...definitions.keys()])) {
    const listing = declarations.get(id);
    const original = definitions.get(id)?.presentation?.original_game ?? listing?.original_game;
    const key = original ? `game:${original.id}` : `port:${id}`;
    const members = expectedGroups.get(key) ?? [];
    members.push(id);
    expectedGroups.set(key, members);
  }
  return [...expectedGroups]
    .map(([id, members]) => ({ id, members: members.sort() }))
    .sort((left, right) => left.id.localeCompare(right.id));
}

function projectedGroups(actual: typeof groups) {
  return actual
    .map((group) => ({ id: group.id, members: group.ports.map(({ id }) => id).sort() }))
    .sort((left, right) => left.id.localeCompare(right.id));
}

it("projects the full current catalog by its declared original-game identities", () => {
  expect(projectedGroups(groups)).toEqual(declaredGroups(canonicalDefinitions.ports));
});

const stagedLeaves = import.meta.glob<{ port: PortDefinition }>(
  "../../../../../release/catalog-publication/bundle/sha256/*.json",
  { eager: true, import: "default" },
);

it.each(definitionIndex.definitions.map((row) => [row.stable_id, row.target] as const))(
  "presents indexed strict metadata while preserving exact route targets for %s",
  (id, target) => {
    const port = stagedLeaves[`../../../../../release/catalog-publication/bundle/${target}`]!.port;
    expect(port.id).toBe(id);
    const selectedExtra = Object.entries(expected.selected_definition_entries).find(
      ([key]) => key === id,
    )?.[1];
    const canonical = entries.find((entry) => entry.id === id);
    const game = selectedExtra?.game_id ?? canonical?.presentation?.original_game?.id;
    const title = selectedExtra?.game_title ?? canonical?.presentation?.original_game_title;
    const reviewedFamily = Object.entries(reviewed).find(([key]) => key === game)?.[1];
    const selectedDefinitions = {
      ...canonicalDefinitions,
      ports: [...canonicalDefinitions.ports.filter((entry) => entry.id !== id), port],
    };
    const projected = catalogEntries(selectedDefinitions, canonicalDirectory, [], []);
    const selectedGroups = groupCatalog(projected);
    expect(projectedGroups(selectedGroups)).toEqual(declaredGroups(selectedDefinitions.ports));
    const selected = projected.find((entry) => entry.id === id);
    expect(selected?.definition).toBe(port);
    expect(selected?.source_profile).toBe(port.source_profile);
    const reviewedProject = Object.hasOwn(expected.project_entries, id);
    expect(game === undefined).toBe(reviewedProject);
    const groupId = reviewedProject ? "port:" + id : "game:" + game;
    const group = selectedGroups.find((entry) => entry.id === groupId);
    const expectedPortIds = reviewedProject
      ? [id]
      : (selectedExtra?.family_port_ids ?? reviewedFamily ?? [id]);
    expect(auditedMembers(group?.ports.map((entry) => entry.id) ?? [], id)).toEqual(
      [...expectedPortIds].sort(),
    );
    expect(title).toBeDefined();
    expect(group && gameGroupTitle(group)).toBe(title);
    const original = selected?.presentation?.original_game;
    expect(original === undefined).toBe(reviewedProject);
    expect(original?.id).toBe(game);
    expect(projected).toHaveLength(entries.length + (canonical ? 0 : 1));
    expect(selectedGroups).toHaveLength(groups.length);
    expect(
      projected
        .filter((entry) => entry.id === "chameleon-twist-jp-recompiled")
        .map((entry) => entry.source_profile),
    ).toEqual(selectedExtra ? ["chameleon-twist-jp"] : []);
    expect(
      projected.find((entry) => entry.id === "chameleon-twist-recompiled")?.definition,
    ).toBeUndefined();
  },
);

it.each(Object.entries(reviewed))(
  "projects reviewed real %s members into one production group",
  (id, expected) => {
    const matches = groups.filter((group) => group.id === `game:${id}`);
    expect(matches).toHaveLength(1);
    expect(auditedMembers(matches[0]!.ports.map((port) => port.id))).toEqual([...expected].sort());
    for (const member of expected)
      expect(entries.filter((entry) => entry.id === member)).toHaveLength(1);
  },
);

it("projects authored managed identities through strict definitions as well as listings", () => {
  for (const expected of Object.values(reviewed).flat()) {
    const port = embedded.ports.find(({ id }) => id === expected);
    const listing = directory.listings.find(({ id }) => id === expected);
    expect(listing?.original_game).toBeDefined();
    expect(port?.presentation?.original_game ?? listing!.original_game).toEqual(
      listing!.original_game,
    );
  }
});

it("keeps the exact real perfect-dark port reference distinct from its original-game title", () => {
  const selected = vi.fn();
  const alternate = "n64hub-perfect-dark-recomp";
  const commands = commandSurfaceCommands({
    games: entries.map((port) => ({ port, inLibrary: false })),
    preferredPortByGame: { "perfect-dark": alternate },
    installedCount: 0,
    busy: false,
    setView: vi.fn(),
    setAdoptOpen: vi.fn(),
    setSelectedId: selected,
    checkAll: vi.fn(async () => undefined),
    focusSearch: vi.fn(),
    focusLibrarySearch: vi.fn(),
  });
  const exact = filterCommands(commands, "perfect-dark");
  expect(exact.map(({ id }) => id)).toEqual(["option:perfect-dark"]);
  exact[0]!.action();
  expect(selected).toHaveBeenLastCalledWith("perfect-dark");
  const title = filterCommands(commands, "Perfect Dark");
  const original = title.filter(({ id }) => id === "game:perfect-dark");
  expect(original).toHaveLength(1);
  expect(title.some(({ id }) => id === "option:perfect-dark")).toBe(false);
  original[0]!.action();
  expect(selected).toHaveBeenLastCalledWith(alternate);
});

it("keeps deliberate original-game boundaries and non-single-game entries explicit in production", () => {
  for (const [id, game] of Object.entries(expected.intentionally_separate))
    expect(gameGroupId(entries.find((entry) => entry.id === id)!)).toBe(`game:${game}`);
  for (const id of Object.keys(expected.project_entries))
    expect(gameGroupId(entries.find((entry) => entry.id === id)!)).toBe(`port:${id}`);
  expect(expected.audited_port_ids.every((id) => entries.some((entry) => entry.id === id))).toBe(
    true,
  );
});

it("uses stable game presentation for every reviewed family regardless of order and filters", () => {
  for (const [id, members] of Object.entries(reviewed)) {
    const all = members.map((member) => entries.find((entry) => entry.id === member)!);
    const forward = groupCatalog(all)[0]!;
    const filtered = groupCatalog([...all].reverse(), [all[all.length - 1]!])[0]!;
    expect(forward.id).toBe(`game:${id}`);
    expect(gameGroupTitle(filtered)).toBe(gameGroupTitle(forward));
    expect(filtered.ports.map(({ id }) => id).sort()).toEqual([...members].sort());
  }
});

it.each(["Roll Away", "KulaQuest"])(
  "finds the original game and all options by regional alias %s",
  (query) => {
    const commands = commandSurfaceCommands({
      games: entries.map((port) => ({ port, inLibrary: false })),
      installedCount: 0,
      busy: false,
      setView: vi.fn(),
      setAdoptOpen: vi.fn(),
      setSelectedId: vi.fn(),
      checkAll: vi.fn(async () => undefined),
      focusSearch: vi.fn(),
      focusLibrarySearch: vi.fn(),
    });
    expect(filterCommands(commands, query).map(({ id }) => id)).toEqual(["game:kula-world"]);
    expect(
      auditedMembers(groups.find(({ id }) => id === "game:kula-world")!.ports.map(({ id }) => id)),
    ).toEqual([...reviewed["kula-world"]].sort());
  },
);
