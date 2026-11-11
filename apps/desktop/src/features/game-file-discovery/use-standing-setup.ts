import { useEffect, useRef } from "react";
import { desktopApi } from "../../api";

/**
 * Startup and library-change catch-up for the player's standing
 * set-up-when-ready choices. Core decides which games are ready, re-plans and
 * authorizes each one, and never launches a game; this hook only starts one
 * pass per library generation once the workspace has loaded. Progress appears
 * through the ordinary activity events.
 */
export function useStandingSetupCatchUp(
  generation: number,
  ready: boolean,
  onChanged: () => Promise<unknown>,
) {
  const started = useRef<number | undefined>(undefined);
  const changed = useRef(onChanged);
  useEffect(() => {
    changed.current = onChanged;
  }, [onChanged]);
  useEffect(() => {
    if (!ready || started.current === generation) return;
    started.current = generation;
    void (async () => {
      try {
        const assessed = await desktopApi.assessPortIntents(generation);
        const eligible = assessed.assessments.some(
          (item) =>
            item.mode === "set_up_when_ready" &&
            item.readiness.state === "ready" &&
            !item.suppressed,
        );
        if (!eligible) return;
        const result = await desktopApi.runStandingSetup(generation, () => undefined);
        if (result.batches.length) await changed.current();
      } catch {
        // Each game's outcome is recorded by Core and shown in Activity and on
        // the game's details; the next start or refresh tries again.
      }
    })();
  }, [generation, ready]);
}
