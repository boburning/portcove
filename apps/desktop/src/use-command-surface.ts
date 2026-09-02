import { useCallback, useMemo, useState } from "react";
import { Boxes, Download, FolderSearch, Gamepad2, Library, RefreshCw, Search, Settings } from "lucide-react";
import type { PaletteCommand } from "./components/CommandPalette";
import { useGlobalShortcuts } from "./keyboard-shortcuts";
import type { RecentPort, View } from "./view-model";

export function useCommandSurface({ recent, installedCount, busy, setView, setAdoptOpen, setSelectedId, checkAll }: {
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
    window.requestAnimationFrame(() => document.querySelector<HTMLInputElement>("#port-search")?.focus());
  }, [setView]);
  const commands = useMemo<PaletteCommand[]>(() => [
    { id: "library", label: "Open library", description: "View installed ports and launch readiness", icon: Library, shortcut: "Ctrl 1", keywords: "navigate collection", action: () => setView("library") },
    { id: "catalog", label: "Open port catalog", description: "Browse supported decomps and recompilations", icon: Boxes, shortcut: "Ctrl 2", keywords: "navigate discover", action: () => setView("catalog") },
    { id: "search", label: "Search port catalog", description: "Find a port by title, adapter, or platform", icon: Search, shortcut: "/", action: focusSearch },
    { id: "updates", label: "Open update center", description: "Review versions, policies, and operation history", icon: Download, shortcut: "Ctrl 3", keywords: "navigate activity", action: () => setView("updates") },
    { id: "check", label: "Check installed ports for updates", description: "Run a read-only release check for every installed port", icon: RefreshCw, keywords: "update all", disabled: busy || installedCount === 0, action: () => { void checkAll(); } },
    { id: "adopt", label: "Adopt an existing install", description: "Preview and copy an existing native port into Portcove", icon: FolderSearch, keywords: "import", action: () => setAdoptOpen(true) },
    { id: "settings", label: "Open settings", description: "Manage sources, GitHub, storage, and appearance", icon: Settings, shortcut: "Ctrl 4", keywords: "navigate preferences", action: () => setView("settings") },
    { id: "continue", label: "Return to the last played port", description: recent ? `Open ${recent.port.name}` : "No successful launch is recorded yet", icon: Gamepad2, disabled: !recent, action: () => recent && setSelectedId(recent.port.id) },
  ], [busy, checkAll, focusSearch, installedCount, recent, setAdoptOpen, setSelectedId, setView]);
  useGlobalShortcuts({ paletteOpen: open, setPaletteOpen: setOpen, setView, focusSearch });
  return { open, setOpen, commands };
}
