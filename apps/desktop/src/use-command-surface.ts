import { useCallback, useMemo, useState } from "react";
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
  recent?: RecentPort;
  installedCount: number;
  busy: boolean;
  setView: (view: View) => void;
  setAdoptOpen: (open: boolean) => void;
  setSelectedId: (portId: string) => void;
  checkAll: () => Promise<void>;
  focusSearch: () => void;
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
}: CommandSurfaceOptions): PaletteCommand[] {
  return [
    {
      id: "library",
      label: "Open library",
      description: "View installed ports and launch readiness",
      icon: Library,
      shortcut: commandShortcut("1"),
      keywords: "navigate collection",
      action: () => setView("library"),
    },
    {
      id: "catalog",
      label: "Open port catalog",
      description: "Browse native game ports",
      icon: Boxes,
      shortcut: commandShortcut("2"),
      keywords: "navigate discover",
      action: () => setView("catalog"),
    },
    {
      id: "search",
      label: "Search port catalog",
      description: "Find a port by title, installation method, or platform",
      icon: Search,
      shortcut: "/",
      action: focusSearch,
    },
    {
      id: "updates",
      label: "Go to Updates",
      description: "Review updates and recent activity",
      icon: Download,
      shortcut: commandShortcut("3"),
      keywords: "navigate activity",
      action: () => setView("updates"),
    },
    {
      id: "check",
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
      label: "Copy an existing installation",
      description: "Review and copy a supported installation into Portcove",
      icon: FolderSearch,
      keywords: "import add",
      action: () => setAdoptOpen(true),
    },
    {
      id: "settings",
      label: "Open settings",
      description: "Manage game files, GitHub, storage, and appearance",
      icon: Settings,
      shortcut: commandShortcut("4"),
      keywords: "navigate preferences",
      action: () => setView("settings"),
    },
    {
      id: "continue",
      label: "Open the last played port",
      description: recent ? `Open ${recent.port.name}` : "No successful launch is recorded yet",
      icon: Gamepad2,
      disabled: !recent,
      action: () => recent && setSelectedId(recent.port.id),
    },
  ];
}

export function useCommandSurface({
  recent,
  installedCount,
  busy,
  setView,
  setAdoptOpen,
  setSelectedId,
  checkAll,
}: {
  recent?: RecentPort;
  installedCount: number;
  busy: boolean;
  setView: (view: View) => void;
  setAdoptOpen: (open: boolean) => void;
  setSelectedId: (portId: string) => void;
  checkAll: () => Promise<void>;
}) {
  const [open, setOpen] = useState(false);
  const focusSearch = useCallback(() => {
    setView("catalog");
    window.requestAnimationFrame(() =>
      document.querySelector<HTMLInputElement>("#port-search")?.focus(),
    );
  }, [setView]);
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
      }),
    [busy, checkAll, focusSearch, installedCount, recent, setAdoptOpen, setSelectedId, setView],
  );
  useGlobalShortcuts({
    paletteOpen: open,
    setPaletteOpen: setOpen,
    setView,
    focusSearch,
  });
  return { open, setOpen, commands };
}
