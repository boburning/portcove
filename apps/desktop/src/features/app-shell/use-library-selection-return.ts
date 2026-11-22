import { useCallback, useEffect, useState, type RefObject } from "react";
import { focusAndReveal } from "../../focus";

type Trigger = "switch" | "reset";
type LibrarySelectionAccepted = (generation: number) => void;

export function useLibrarySelectionReturn(
  generation: number | undefined,
  switchLibrary: (
    path: string,
    accepted: LibrarySelectionAccepted,
    review?: string,
  ) => Promise<void>,
  resetLibrary: (accepted: LibrarySelectionAccepted, review?: string) => Promise<void>,
) {
  const [pending, setPending] = useState<{ generation: number; trigger: Trigger }>();
  const recordDestination = (trigger: Trigger) => (destination: number) => {
    if (destination !== generation) setPending({ generation: destination, trigger });
  };
  const switchFromSettings = (path: string, review?: string) =>
    switchLibrary(path, recordDestination("switch"), review);
  const resetFromSettings = (review?: string) => resetLibrary(recordDestination("reset"), review);
  const consume = useCallback(() => {
    setPending(undefined);
  }, []);
  const returnToSelection = pending?.generation === generation ? pending?.trigger : undefined;
  return { switchFromSettings, resetFromSettings, returnToSelection, consume };
}

export function useLibrarySelectionLanding(
  trigger: Trigger | undefined,
  workspace: RefObject<HTMLElement | null>,
  consume: () => void,
) {
  useEffect(() => {
    if (!trigger) return;
    const target = document.querySelector<HTMLElement>(
      `[data-library-selection-trigger="${trigger}"]`,
    );
    focusAndReveal(target ?? workspace.current);
    consume();
  }, [consume, trigger, workspace]);
}
