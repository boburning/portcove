import { useEffect, useRef } from "react";
import { useAppShellState, type BrowsingInputs } from "./use-app-shell-state";
import { useWorkspaceContinuity, type WorkspaceBrowsingPositions } from "../../keyboard-shortcuts";

export type LibraryBrowsingContext = {
  inputs: BrowsingInputs;
  positions: WorkspaceBrowsingPositions;
};

const emptyProfileLandingKey = "portcove.empty-profile-landing.v1";

export function libraryBrowsingKey(root: string): string {
  if (root.startsWith("\\\\?\\UNC\\")) return `\\\\${root.slice(8)}`;
  return root.startsWith("\\\\?\\") ? root.slice(4) : root;
}

export function useLibraryBrowsingContext({
  root,
  initial,
  returnToSelection,
  remember,
  switchLibrary,
  resetLibrary,
  ready = true,
  installedCount,
  catalogCount,
}: {
  root: string | null;
  initial?: LibraryBrowsingContext;
  returnToSelection?: "switch" | "reset";
  remember: (root: string, context: LibraryBrowsingContext) => void;
  switchLibrary: (path: string) => Promise<void>;
  resetLibrary: () => Promise<void>;
  ready?: boolean;
  installedCount?: number;
  catalogCount?: number;
}) {
  const ui = useAppShellState(returnToSelection ? "settings" : "library", initial?.inputs);
  const { view, setView } = ui;
  const interactedBeforeReady = useRef(false);
  useEffect(() => {
    if (ready) return;
    const markInteraction = () => {
      interactedBeforeReady.current = true;
    };
    document.addEventListener("pointerdown", markInteraction);
    document.addEventListener("keydown", markInteraction);
    return () => {
      document.removeEventListener("pointerdown", markInteraction);
      document.removeEventListener("keydown", markInteraction);
    };
  }, [ready]);
  useEffect(() => {
    if (
      !ready ||
      catalogCount === undefined ||
      catalogCount === 0 ||
      installedCount !== 0 ||
      initial ||
      returnToSelection
    )
      return;
    try {
      const storage = window.localStorage;
      if (storage.getItem(emptyProfileLandingKey)) return;
      const autoLanding = view === "library" && !interactedBeforeReady.current;
      storage.setItem(emptyProfileLandingKey, autoLanding ? "catalog" : "dismissed");
      if (autoLanding) setView("catalog");
    } catch {
      // Browsing still works when the host denies optional view-preference storage.
    }
  }, [ready, catalogCount, installedCount, initial, returnToSelection, view, setView]);
  const { browsingPositions, switchView, workspace } = useWorkspaceContinuity(
    ui.view,
    initial?.positions,
    !returnToSelection,
    ready,
  );
  const save = () => {
    if (root)
      remember(root, {
        inputs: ui.browsingInputs,
        positions: browsingPositions(),
      });
  };
  const switchLibraryWithContext = async (path: string) => {
    save();
    await switchLibrary(path);
  };
  const resetLibraryWithContext = async () => {
    save();
    await resetLibrary();
  };
  return { ui, switchView, workspace, switchLibraryWithContext, resetLibraryWithContext };
}
