import { useEffect, useRef } from "react";
import type { View } from "./view-model";

export type KeyboardShortcutAction = "toggle-palette" | "close-palette" | "focus-search" | View;

export function keyboardShortcutAction(input: {
  key: string;
  ctrlKey?: boolean;
  metaKey?: boolean;
  altKey?: boolean;
  targetIsField?: boolean;
  paletteOpen?: boolean;
}): KeyboardShortcutAction | undefined {
  if (input.paletteOpen && input.key === "Escape") return "close-palette";
  const commandKey = Boolean(input.ctrlKey || input.metaKey);
  if (commandKey && input.key.toLowerCase() === "k") return "toggle-palette";
  if (!input.targetIsField && !commandKey && !input.altKey && input.key === "/") return "focus-search";
  if (!commandKey || input.altKey) return undefined;
  return ({ "1": "library", "2": "catalog", "3": "updates", "4": "settings" } as const)[input.key as "1"];
}

export function useGlobalShortcuts({ paletteOpen, setPaletteOpen, setView, focusSearch }: {
  paletteOpen: boolean;
  setPaletteOpen: (value: boolean | ((current: boolean) => boolean)) => void;
  setView: (view: View) => void;
  focusSearch: () => void;
}) {
  useEffect(() => {
    const keydown = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      const action = keyboardShortcutAction({
        key: event.key,
        ctrlKey: event.ctrlKey,
        metaKey: event.metaKey,
        altKey: event.altKey,
        targetIsField: target?.matches("input, textarea, select, [contenteditable=true]"),
        paletteOpen,
      });
      if (!action) return;
      event.preventDefault();
      if (action === "close-palette") {
        event.stopImmediatePropagation();
        setPaletteOpen(false);
      } else if (action === "toggle-palette") setPaletteOpen(open => !open);
      else if (action === "focus-search") focusSearch();
      else setView(action);
    };
    window.addEventListener("keydown", keydown, true);
    return () => window.removeEventListener("keydown", keydown, true);
  }, [focusSearch, paletteOpen, setPaletteOpen, setView]);
}

export function useWorkspaceScroll(view: View) {
  const workspace = useRef<HTMLElement>(null);
  useEffect(() => { workspace.current?.scrollTo({ top: 0 }); }, [view]);
  return workspace;
}
