import { describe, expect, it, vi } from "vite-plus/test";
import { portDefinition, portStatus } from "./test-fixtures";
import { filterCommands } from "./components/CommandPalette";
import { commandSurfaceCommands, withLibraryVisibility } from "./use-command-surface";

function commands(recent = true) {
  const actions = {
    setView: vi.fn(),
    setAdoptOpen: vi.fn(),
    setSelectedId: vi.fn(),
  };
  return {
    actions,
    commands: commandSurfaceCommands({
      recent: recent ? { port: portDefinition(), status: portStatus() } : undefined,
      installedCount: 1,
      busy: false,
      ...actions,
      checkAll: vi.fn(async () => undefined),
      focusSearch: vi.fn(),
      focusLibrarySearch: vi.fn(),
    }),
  };
}

describe("command surface player-facing copy", () => {
  it("uses the same navigation vocabulary as the destination pages", () => {
    const { actions, commands: available } = commands();
    expect(available.find(({ id }) => id === "catalog")).toMatchObject({
      description: "Browse native game ports",
    });
    expect(available.find(({ id }) => id === "updates")).toMatchObject({
      label: "Open Activity",
      description: "Review tasks, history and recovery",
    });
    expect(available.find(({ id }) => id === "settings")).toMatchObject({
      description: "Manage game files, GitHub, storage, and appearance",
    });
    available.find(({ id }) => id === "updates")?.action();
    expect(actions.setView).toHaveBeenCalledWith("updates");
  });

  it("explains why the update check is unavailable", () => {
    const make = (installedCount: number, busy: boolean) =>
      commandSurfaceCommands({
        installedCount,
        busy,
        setView: vi.fn(),
        setAdoptOpen: vi.fn(),
        setSelectedId: vi.fn(),
        checkAll: vi.fn(async () => undefined),
        focusSearch: vi.fn(),
        focusLibrarySearch: vi.fn(),
      }).find(({ id }) => id === "check");
    expect(make(0, false)).toMatchObject({
      disabled: true,
      description: "Install a port before checking for updates",
    });
    expect(make(1, true)).toMatchObject({
      disabled: true,
      description: "Wait for the current operation before checking for updates",
    });
    expect(make(1, false)).toMatchObject({
      disabled: false,
      description: "Check for updates without installing them",
    });
  });

  it("describes copying an existing installation without exposing the internal operation name", () => {
    const { actions, commands: available } = commands();
    const command = available.find(({ id }) => id === "adopt");
    expect(command).toMatchObject({
      label: "Copy an existing installation",
      description: "Review and copy a supported installation into Portcove",
    });
    expect(`${command?.label} ${command?.description}`.toLowerCase()).not.toContain("adopt");
    command?.action();
    expect(actions.setAdoptOpen).toHaveBeenCalledWith(true);
  });

  it("describes opening the last played port and keeps the unavailable state disabled", () => {
    const { actions, commands: available } = commands();
    const command = available.find(({ id }) => id === "continue");
    expect(command).toMatchObject({
      label: "Open recent game",
      description: "Open Sample",
      disabled: false,
    });
    command?.action();
    expect(actions.setSelectedId).toHaveBeenCalledWith("sample");
    expect(commands(false).commands.find(({ id }) => id === "continue")).toMatchObject({
      label: "Open recent game",
      description: "No completed launch is recorded yet",
      disabled: true,
    });
  });
});

describe("command surface game search", () => {
  it("groups library games before Discover games and opens their details", () => {
    const setSelectedId = vi.fn();
    const library = { ...portDefinition(), id: "library-game", name: "Library Game" };
    const discover = { ...portDefinition(), id: "discover-game", name: "Discover Game" };
    const games = commandSurfaceCommands({
      games: [
        { port: discover, inLibrary: false },
        { port: library, inLibrary: true },
      ],
      installedCount: 1,
      busy: false,
      setView: vi.fn(),
      setAdoptOpen: vi.fn(),
      setSelectedId,
      checkAll: vi.fn(async () => undefined),
      focusSearch: vi.fn(),
      focusLibrarySearch: vi.fn(),
    }).filter(({ id }) => id.startsWith("port:"));
    expect(games.map(({ id, group, searchOnly }) => [id, group, searchOnly])).toEqual([
      ["port:library-game", "Projects in your library", true],
      ["port:discover-game", "Projects in Discover", true],
    ]);
    games[1]!.action();
    expect(setSelectedId).toHaveBeenCalledWith("discover-game");
  });
});

describe("command surface Library visibility", () => {
  it("lists Library-hidden games only as Discover results", () => {
    const shown = { ...portDefinition(), id: "shown" };
    const hidden = { ...portDefinition(), id: "hidden" };
    const games = [
      { port: shown, inLibrary: true },
      { port: hidden, inLibrary: true },
    ];
    expect(
      withLibraryVisibility(games, ["hidden"]).map(({ port, inLibrary }) => [port.id, inLibrary]),
    ).toEqual([
      ["shown", true],
      ["hidden", false],
    ]);
    expect(withLibraryVisibility(games, undefined)).toEqual(games);
  });
});

it("shows one original-game result but preserves exact project and edition-alias search", () => {
  const selected = vi.fn();
  const game = {
    format_version: 1 as const,
    id: "shared-game",
    evidence_urls: ["https://example.test/game"],
    source_editions: [
      {
        id: "regional-edition",
        title: "Regional Alias",
        evidence_urls: ["https://example.test/edition"],
      },
    ],
  };
  const port = (id: string, name: string) => ({
    ...portDefinition(),
    id,
    name,
    presentation: { original_game_title: "Original Game", original_game: game },
  });
  const available = commandSurfaceCommands({
    games: [
      { port: port("project-alpha", "Alpha Engine"), inLibrary: false },
      { port: port("project-beta", "Beta Player"), inLibrary: true },
    ],
    installedCount: 1,
    busy: false,
    setView: vi.fn(),
    setAdoptOpen: vi.fn(),
    setSelectedId: selected,
    checkAll: vi.fn(async () => undefined),
    focusSearch: vi.fn(),
    focusLibrarySearch: vi.fn(),
  });
  const title = filterCommands(available, "Original Game");
  expect(title).toHaveLength(1);
  expect(title[0]).toMatchObject({
    id: "game:shared-game",
    label: "Original Game",
    group: "Games in your library",
  });
  title[0]!.action();
  expect(selected).toHaveBeenLastCalledWith("project-beta");
  expect(filterCommands(available, "Regional Alias").map(({ id }) => id)).toEqual([
    "game:shared-game",
  ]);
  const exact = filterCommands(available, "Alpha Engine");
  expect(exact.map(({ id }) => id)).toEqual(["option:project-alpha"]);
  exact[0]!.action();
  expect(selected).toHaveBeenLastCalledWith("project-alpha");
  expect(filterCommands(available, "project-beta").map(({ id }) => id)).toEqual([
    "option:project-beta",
  ]);
});
