import { useCallback, useMemo, useState } from "react";
import { gameIdentityLabel } from "./port-identity";
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
import type { RecentPort, View } from "./view-model";

interface CommandSurfaceOptions {
  recent?: RecentPort | undefined;
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

export function commandSurfaceCommands({
  recent,
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
      label: "Open Find games",
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
      label: "Search Find games",
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
  ];
}

export function useCommandSurface({
  view,
  recent,
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
    document.querySelector<HTMLInputElement>("#port-search")?.focus();
  }, []);
  const commands = useMemo<PaletteCommand[]>(
    () =>
      commandSurfaceCommands({
        recent,
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
    searchAvailable: view === "library" || view === "catalog",
  });
  return { open, setOpen, commands };
}
