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
export type WorkspaceBrowsingPositions = Partial<Record<View, WorkspaceSnapshot>>;
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

function restoreWorkspaceSnapshot(workspace: HTMLElement, snapshot: WorkspaceSnapshot) {
  workspace.scrollTo({ top: snapshot.scrollTop });
  if (!snapshot.focus) return;
  const target = resolveWorkspaceFocus(workspace, snapshot.focus);
  if (target && !target.matches(":disabled, [aria-disabled=true]"))
    target.focus({ preventScroll: true });
  else focusRegion("workspace");
}

export function useWorkspaceContinuity(
  view: View,
  initial?: WorkspaceBrowsingPositions,
  restoreInitial = true,
  ready = true,
) {
  const workspace = useRef<HTMLElement>(null);
  const snapshots = useRef<WorkspaceBrowsingPositions>({ ...initial });
  const initialRestore = useRef(restoreInitial ? initial?.[view] : undefined);
  const pending = useRef<
    | { view: View; snapshot: WorkspaceSnapshot; anchor: Element | null; scrollTop: number }
    | undefined
  >(undefined);
  useEffect(() => {
    const snapshot = initialRestore.current;
    if (!snapshot) return;
    initialRestore.current = undefined;
    if (!ready) {
      pending.current = {
        view,
        snapshot,
        anchor: document.activeElement,
        scrollTop: workspace.current?.scrollTop ?? 0,
      };
      return;
    }
    const frame = window.requestAnimationFrame(() => {
      const targetWorkspace = workspace.current;
      if (!targetWorkspace) return;
      restoreWorkspaceSnapshot(targetWorkspace, snapshot);
    });
    return () => window.cancelAnimationFrame(frame);
  }, [ready, view]);
  useEffect(() => {
    const restore = pending.current;
    if (!ready || !restore || restore.view !== view) return;
    const frame = window.requestAnimationFrame(() => {
      if (pending.current !== restore) return;
      pending.current = undefined;
      const targetWorkspace = workspace.current;
      if (!targetWorkspace || targetWorkspace.scrollTop !== restore.scrollTop) return;
      if (restore.anchor) {
        if (document.activeElement !== restore.anchor) return;
      } else if (targetWorkspace.contains(document.activeElement)) return;
      restoreWorkspaceSnapshot(targetWorkspace, restore.snapshot);
    });
    return () => window.cancelAnimationFrame(frame);
  }, [ready, view]);
  useEffect(() => {
    if (pending.current?.view !== view) return;
    const cancel = () => {
      pending.current = undefined;
    };
    document.addEventListener("focusin", cancel, true);
    document.addEventListener("pointerdown", cancel, true);
    document.addEventListener("keydown", cancel, true);
    return () => {
      document.removeEventListener("focusin", cancel, true);
      document.removeEventListener("pointerdown", cancel, true);
      document.removeEventListener("keydown", cancel, true);
    };
  }, [ready, view]);
  const browsingPositions = useCallback((): WorkspaceBrowsingPositions => {
    const active = document.activeElement;
    const currentWorkspace = workspace.current;
    return {
      ...snapshots.current,
      [view]: {
        scrollTop: currentWorkspace?.scrollTop ?? 0,
        focus:
          currentWorkspace && active instanceof HTMLElement
            ? workspaceFocus(active, currentWorkspace)
            : undefined,
      },
    };
  }, [view]);
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
      pending.current = undefined;
      const nextSnapshot = snapshots.current[nextView];
      if (!ready && nextSnapshot) {
        pending.current = {
          view: nextView,
          snapshot: nextSnapshot,
          anchor: active instanceof Element && !currentWorkspace?.contains(active) ? active : null,
          scrollTop: 0,
        };
      }
      commit();
      window.requestAnimationFrame(() => {
        const nextWorkspace = workspace.current;
        if (!nextWorkspace) return;
        if (!ready) {
          nextWorkspace.scrollTo({ top: 0 });
          return;
        }
        if (nextSnapshot) restoreWorkspaceSnapshot(nextWorkspace, nextSnapshot);
        else nextWorkspace.scrollTo({ top: 0 });
      });
    },
    [ready, view],
  );
  return { browsingPositions, switchView, workspace };
}
