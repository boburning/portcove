import { useCallback, useEffect, useState, type RefObject } from "react";
import { focusAndReveal } from "../../focus";

type Trigger = "switch" | "reset";

export function useLibrarySelectionReturn(
  generation: number | undefined,
  switchLibrary: (path: string) => Promise<void>,
  resetLibrary: () => Promise<void>,
) {
  const [pending, setPending] = useState<
    { generation: number | undefined; trigger: Trigger } | undefined
  >();
  const run = async (trigger: Trigger, operation: () => Promise<void>) => {
    setPending({ generation, trigger });
    try {
      await operation();
    } catch (error) {
      setPending(undefined);
      throw error;
    }
  };
  const switchFromSettings = (path: string) => run("switch", () => switchLibrary(path));
  const resetFromSettings = () => run("reset", resetLibrary);
  const consume = useCallback(() => {
    setPending(undefined);
  }, []);
  const returnToSelection =
    pending && pending.generation !== generation ? pending.trigger : undefined;
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
