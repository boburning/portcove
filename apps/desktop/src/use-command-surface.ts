import { useCallback, useMemo, useState } from "react";
import { gameIdentityLabel, gameTitle } from "./port-identity";
import {
  Boxes,
  Download,
  FolderSearch,
  Gamepad2,
  Library,
  RefreshCw,
  Search,
  Settings,
} from "lucide-react";
import type { PaletteCommand } from "./components/CommandPalette";
import { commandShortcut, useGlobalShortcuts } from "./keyboard-shortcuts";
import {
  groupCatalog,
  gameGroupPresentationPort,
  gameGroupTitle,
  originalGame,
} from "./features/browsing/original-game";
import type { CatalogEntry } from "./features/browsing/catalog-entry";
import type { RecentPort, View } from "./view-model";

interface CommandSurfaceOptions {
  recent?: RecentPort | undefined;
  games?: readonly SearchableGame[];
  preferredPortByGame?: Readonly<Record<string, string>> | undefined;
  installedCount: number;
  busy: boolean;
  setView: (view: View) => void;
  setAdoptOpen: (open: boolean) => void;
  setSelectedId: (portId: string) => void;
  checkAll: () => Promise<void>;
  focusSearch: () => void;
  focusLibrarySearch: () => void;
  openUpdates?: () => void;
}

export interface SearchableGame {
  port: CatalogEntry;
  inLibrary: boolean;
}

/** Library-hidden games stay searchable, but only as Discover results (DESIGN-SYSTEM). */
export function withLibraryVisibility(
  games: readonly SearchableGame[],
  hiddenPortIds: readonly string[] | undefined,
): SearchableGame[] {
  if (!hiddenPortIds?.length) return [...games];
  const hidden = new Set(hiddenPortIds);
  return games.map((game) =>
    game.inLibrary && hidden.has(game.port.id) ? { ...game, inLibrary: false } : game,
  );
}

export function commandSurfaceCommands({
  recent,
  games = [],
  preferredPortByGame,
  installedCount,
  busy,
  setView,
  setAdoptOpen,
  setSelectedId,
  checkAll,
  focusSearch,
  focusLibrarySearch,
  openUpdates,
}: CommandSurfaceOptions): PaletteCommand[] {
  return [
    {
      id: "library",
      group: "Navigation",
      label: "Open library",
      description: "View installed ports and launch readiness",
      icon: Library,
      shortcut: commandShortcut("1"),
      keywords: "navigate collection",
      action: () => setView("library"),
    },
    {
      id: "catalog",
      group: "Navigation",
      label: "Open Discover",
      description: "Browse native game ports",
      icon: Boxes,
      shortcut: commandShortcut("2"),
      keywords: "navigate discover",
      action: () => setView("catalog"),
    },
    {
      id: "search-library",
      group: "Navigation",
      label: "Search library",
      description: "Find a game or port in your library",
      icon: Search,
      action: focusLibrarySearch,
    },
    {
      id: "search",
      group: "Navigation",
      label: "Search Discover",
      description: "Find a port by title, installation method, or platform",
      icon: Search,
      action: focusSearch,
    },
    {
      id: "updates",
      group: "Navigation",
      label: "Open Activity",
      description: "Review tasks, history and recovery",
      icon: Download,
      shortcut: commandShortcut("3"),
      keywords: "navigate activity",
      action: () => setView("updates"),
    },
    {
      id: "game-updates",
      group: "Navigation",
      label: "Review game updates",
      description: "Open the Updates section in Activity",
      icon: Download,
      keywords: "installed versions update",
      action: openUpdates ?? (() => setView("updates")),
    },
    {
      id: "check",
      group: "Library actions",
      label: "Check installed ports for updates",
      description:
        installedCount === 0
          ? "Install a port before checking for updates"
          : busy
            ? "Wait for the current operation before checking for updates"
            : "Check for updates without installing them",
      icon: RefreshCw,
      keywords: "update all",
      disabled: busy || installedCount === 0,
      action: () => {
        void checkAll();
      },
    },
    {
      id: "adopt",
      group: "Library actions",
      label: "Copy an existing installation",
      description: "Review and copy a supported installation into Portcove",
      icon: FolderSearch,
      keywords: "import add",
      action: () => setAdoptOpen(true),
    },
    {
      id: "settings",
      group: "Preferences",
      label: "Open settings",
      description: "Manage game files, GitHub, storage, and appearance",
      icon: Settings,
      shortcut: commandShortcut("4"),
      keywords: "navigate preferences",
      action: () => setView("settings"),
    },
    {
      id: "continue",
      group: "Recent game",
      label: "Open recent game",
      description: recent
        ? `Open ${gameIdentityLabel(recent.port)}`
        : "No completed launch is recorded yet",
      icon: Gamepad2,
      disabled: !recent,
      action: () => recent && setSelectedId(recent.port.id),
    },
    ...gameSearchCommands(games, setSelectedId, preferredPortByGame),
  ];
}

/** A title query shows one game; a project query retains its exact detail target. */
function gameSearchCommands(
  games: readonly SearchableGame[],
  setSelectedId: (portId: string) => void,
  preferences: Readonly<Record<string, string>> | undefined,
): PaletteCommand[] {
  const library = new Set(games.filter((game) => game.inLibrary).map(({ port }) => port.id));
  return groupCatalog(games.map(({ port }) => port))
    .map((group): PaletteCommand => {
      const identified = group.id.startsWith("game:");
      const installed = group.ports.filter((port) => library.has(port.id));
      // Opening details grants no choice or action; all alternatives stay visible there.
      const gameId = originalGame(group.ports[0]!)?.id;
      const preferred =
        gameId && preferences && Object.hasOwn(preferences, gameId)
          ? group.ports.find((port) => port.id === preferences[gameId])
          : undefined;
      const representative =
        preferred ?? (installed.length === 1 ? installed[0]! : gameGroupPresentationPort(group));
      const inLibrary = installed.length > 0;
      return {
        id: group.id,
        ...(identified ? {} : { exactQueries: [representative.id] }),
        group: identified
          ? inLibrary
            ? "Games in your library"
            : "Games in Discover"
          : inLibrary
            ? "Projects in your library"
            : "Projects in Discover",
        label: identified ? gameGroupTitle(group) : gameIdentityLabel(representative),
        description:
          group.ports.length > 1
            ? `${group.ports.length} options · Open game details and options`
            : "Open details",
        icon: Gamepad2,
        keywords: identified
          ? group.ports
              .flatMap((port) => [
                gameTitle(port),
                ...(originalGame(port)?.source_editions.map((edition) => edition.title) ?? []),
              ])
              .join(" ")
          : `${representative.id} ${representative.name}`,
        searchOnly: true,
        matchDescription: false,
        action: () => setSelectedId(representative.id),
        ...(identified
          ? {
              searchAlternatives: group.ports.map((port): PaletteCommand => ({
                id: `option:${port.id}`,
                exactQueries: [port.id],
                group: library.has(port.id)
                  ? "Port options in your library"
                  : "Port options in Discover",
                label: gameIdentityLabel(port),
                description: "Open this port’s details and setup options",
                icon: Gamepad2,
                keywords: `${port.id} ${port.name}`,
                searchOnly: true,
                matchDescription: false,
                action: () => setSelectedId(port.id),
              })),
            }
          : {}),
      };
    })
    .sort(
      (left, right) =>
        Number(!left.group?.includes("your library")) -
          Number(!right.group?.includes("your library")) ||
        (left.group ?? "").localeCompare(right.group ?? ""),
    );
}

function activeModSearch() {
  return document.querySelector<HTMLInputElement>("[data-active-mod-search] input[type=search]");
}

export function useCommandSurface({
  view,
  recent,
  games,
  preferredPortByGame,
  installedCount,
  busy,
  setView,
  setAdoptOpen,
  setSelectedId,
  checkAll,
  openUpdates,
}: {
  view: View;
  recent?: RecentPort | undefined;
  games?: readonly SearchableGame[];
  preferredPortByGame?: Readonly<Record<string, string>> | undefined;
  installedCount: number;
  busy: boolean;
  setView: (view: View) => void;
  setAdoptOpen: (open: boolean) => void;
  setSelectedId: (portId: string) => void;
  checkAll: () => Promise<void>;
  openUpdates?: () => void;
}) {
  const [open, setOpen] = useState(false);
  const openSearch = useCallback(
    (destination: View) => {
      setView(destination);
      window.requestAnimationFrame(() =>
        document.querySelector<HTMLInputElement>("#port-search")?.focus(),
      );
    },
    [setView],
  );
  const focusSearch = useCallback(() => openSearch("catalog"), [openSearch]);
  const focusLibrarySearch = useCallback(() => openSearch("library"), [openSearch]);
  const focusCurrentSearch = useCallback(() => {
    (activeModSearch() ?? document.querySelector<HTMLInputElement>("#port-search"))?.focus();
  }, []);
  const searchAvailable = useCallback(
    () => view === "library" || view === "catalog" || activeModSearch() !== null,
    [view],
  );
  const commands = useMemo<PaletteCommand[]>(
    () =>
      commandSurfaceCommands({
        recent,
        ...(games ? { games } : {}),
        preferredPortByGame,
        installedCount,
        busy,
        setView,
        setAdoptOpen,
        setSelectedId,
        checkAll,
        focusSearch,
        focusLibrarySearch,
        ...(openUpdates ? { openUpdates } : {}),
      }),
    [
      busy,
      checkAll,
      focusLibrarySearch,
      focusSearch,
      games,
      preferredPortByGame,
      installedCount,
      openUpdates,
      recent,
      setAdoptOpen,
      setSelectedId,
      setView,
    ],
  );
  useGlobalShortcuts({
    paletteOpen: open,
    setPaletteOpen: setOpen,
    setView,
    focusSearch: focusCurrentSearch,
    searchAvailable,
  });
  return { open, setOpen, commands };
}
