import { useCallback, useEffect, useRef } from "react";
import type { View } from "./view-model";
import { focusRegion, navigationScope } from "./focus";
import { recordKeyboardInput } from "./gamepad";

export type KeyboardShortcutAction = "toggle-palette" | "close-palette" | "focus-search" | View;

export function commandShortcut(key: string, platform = globalThis.navigator?.platform ?? "") {
  return `${/Mac/i.test(platform) ? "Command" : "Ctrl"} ${key}`;
}

export function keyboardShortcutAction(input: {
  key: string;
  ctrlKey?: boolean;
  metaKey?: boolean;
  altKey?: boolean;
  targetIsField?: boolean;
  paletteOpen?: boolean;
  modalOpen?: boolean;
}): KeyboardShortcutAction | undefined {
  if (input.paletteOpen && input.key === "Escape") return "close-palette";
  const commandKey = Boolean(input.ctrlKey || input.metaKey);
  if (input.modalOpen || input.paletteOpen) {
    return input.paletteOpen && commandKey && !input.altKey && input.key.toLowerCase() === "k"
      ? "toggle-palette"
      : undefined;
  }
  if (commandKey && !input.altKey && input.key.toLowerCase() === "k") return "toggle-palette";
  if (!input.targetIsField && !commandKey && !input.altKey && input.key === "/")
    return "focus-search";
  if (!commandKey || input.altKey) return undefined;
  return ({ "1": "library", "2": "catalog", "3": "updates", "4": "settings" } as const)[
    input.key as "1"
  ];
}

export function useGlobalShortcuts({
  paletteOpen,
  setPaletteOpen,
  setView,
  focusSearch,
}: {
  paletteOpen: boolean;
  setPaletteOpen: (value: boolean | ((current: boolean) => boolean)) => void;
  setView: (view: View) => void;
  focusSearch: () => void;
}) {
  useEffect(() => {
    const keydown = (event: KeyboardEvent) => {
      recordKeyboardInput();
      if (event.defaultPrevented || event.isComposing) return;
      const target = event.target as HTMLElement | null;
      const action = keyboardShortcutAction({
        key: event.key,
        ctrlKey: event.ctrlKey,
        metaKey: event.metaKey,
        altKey: event.altKey,
        targetIsField: target?.matches("input, textarea, select, [contenteditable=true]") ?? false,
        paletteOpen,
        modalOpen: navigationScope() !== document,
      });
      if (!action) return;
      event.preventDefault();
      if (action === "close-palette") {
        event.stopImmediatePropagation();
        setPaletteOpen(false);
      } else if (action === "toggle-palette") setPaletteOpen((open) => !open);
      else if (action === "focus-search") focusSearch();
      else setView(action);
    };
    window.addEventListener("keydown", keydown, true);
    return () => window.removeEventListener("keydown", keydown, true);
  }, [focusSearch, paletteOpen, setPaletteOpen, setView]);
}

type WorkspaceFocus = { kind: "id" | "detail-origin"; value: string };
type WorkspaceSnapshot = { focus: WorkspaceFocus | undefined; scrollTop: number };
type DetailReturn = { focusOrigin: string | undefined; scrollTop: number };

function workspaceFocus(element: HTMLElement, workspace: HTMLElement): WorkspaceFocus | undefined {
  if (!workspace.contains(element)) return undefined;
  if (element.dataset.detailOrigin)
    return { kind: "detail-origin", value: element.dataset.detailOrigin };
  return element.id ? { kind: "id", value: element.id } : undefined;
}

function resolveWorkspaceFocus(workspace: HTMLElement, focus: WorkspaceFocus) {
  if (focus.kind === "id")
    return Array.from(workspace.querySelectorAll<HTMLElement>("[id]")).find(
      (candidate) => candidate.id === focus.value,
    );
  return Array.from(workspace.querySelectorAll<HTMLElement>("[data-detail-origin]")).find(
    (candidate) => candidate.dataset.detailOrigin === focus.value,
  );
}

export function useWorkspaceContinuity(view: View) {
  const workspace = useRef<HTMLElement>(null);
  const snapshots = useRef<Partial<Record<View, WorkspaceSnapshot>>>({});
  const switchView = useCallback(
    (nextView: View, commit: () => void, detailReturn?: DetailReturn) => {
      const currentWorkspace = workspace.current;
      const active = document.activeElement;
      const snapshot: WorkspaceSnapshot = detailReturn
        ? {
            scrollTop: detailReturn.scrollTop,
            focus: detailReturn.focusOrigin
              ? { kind: "detail-origin", value: detailReturn.focusOrigin }
              : undefined,
          }
        : {
            scrollTop: currentWorkspace?.scrollTop ?? 0,
            focus:
              currentWorkspace && active instanceof HTMLElement
                ? workspaceFocus(active, currentWorkspace)
                : undefined,
          };
      if (nextView === view && !detailReturn) {
        commit();
        return;
      }
      snapshots.current[view] = snapshot;
      commit();
      window.requestAnimationFrame(() => {
        const nextWorkspace = workspace.current;
        if (!nextWorkspace) return;
        const snapshot = snapshots.current[nextView];
        nextWorkspace.scrollTo({ top: snapshot?.scrollTop ?? 0 });
        if (!snapshot?.focus) return;
        const target = resolveWorkspaceFocus(nextWorkspace, snapshot.focus);
        if (target && !target.matches(":disabled, [aria-disabled=true]"))
          target.focus({ preventScroll: true });
        else focusRegion("workspace");
      });
    },
    [view],
  );
  return { switchView, workspace };
}
