import { useAppShellState, type BrowsingInputs } from "./use-app-shell-state";
import { useWorkspaceContinuity, type WorkspaceBrowsingPositions } from "../../keyboard-shortcuts";

export type LibraryBrowsingContext = {
  inputs: BrowsingInputs;
  positions: WorkspaceBrowsingPositions;
};

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
}: {
  root: string | null;
  initial?: LibraryBrowsingContext;
  returnToSelection?: "switch" | "reset";
  remember: (root: string, context: LibraryBrowsingContext) => void;
  switchLibrary: (path: string) => Promise<void>;
  resetLibrary: () => Promise<void>;
  ready?: boolean;
}) {
  const ui = useAppShellState(returnToSelection ? "settings" : "library", initial?.inputs);
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
