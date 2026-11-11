import { useCallback, useEffect, useRef } from "react";
import { desktopApi } from "../../api";

const events = new EventTarget();

/** Ask for a standing-setup pass soon, for example after a choice is saved. */
export function requestStandingSetup() {
  events.dispatchEvent(new Event("request"));
}

/** Runs `listener` after each standing-setup pass, so views can reassess. */
export function onStandingSetupPass(listener: () => void) {
  events.addEventListener("pass", listener);
  return () => events.removeEventListener("pass", listener);
}

const settleMilliseconds = 1500;

/**
 * Catch-up for the player's standing set-up-when-ready choices: once a
 * library has loaded, whenever the catalog or registered files change, and
 * whenever a choice is saved. Core decides which games are ready, re-plans and
 * authorizes each one, allows one pass at a time and never launches a game;
 * this hook only asks for passes. Progress appears through the ordinary
 * activity events.
 */
export function useStandingSetupCatchUp(
  generation: number,
  ready: boolean,
  catalog: unknown,
  sources: unknown,
  onChanged: () => Promise<unknown>,
) {
  const changed = useRef(onChanged);
  const running = useRef(false);
  const again = useRef(false);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const current = useRef(generation);
  useEffect(() => {
    changed.current = onChanged;
    current.current = generation;
  }, [onChanged, generation]);

  const run = useCallback(async () => {
    if (running.current) {
      again.current = true;
      return;
    }
    running.current = true;
    const expected = generation;
    try {
      const intents = await desktopApi.portIntents(expected);
      if (intents.some((intent) => intent.mode === "set_up_when_ready")) {
        const result = await desktopApi.runStandingSetup(expected, () => undefined);
        if (result.batches.length && current.current === expected) await changed.current();
      }
    } catch {
      // Each game's outcome is recorded by Core and shown in Activity and on
      // the game's details; the next change or start tries again.
    } finally {
      running.current = false;
      events.dispatchEvent(new Event("pass"));
      if (again.current) {
        again.current = false;
        requestStandingSetup();
      }
    }
  }, [generation]);

  const schedule = useCallback(() => {
    clearTimeout(timer.current);
    timer.current = setTimeout(() => void run(), settleMilliseconds);
  }, [run]);

  useEffect(() => {
    if (ready) schedule();
  }, [ready, catalog, sources, schedule]);

  useEffect(() => {
    if (!ready) return;
    const listener = () => schedule();
    events.addEventListener("request", listener);
    return () => {
      events.removeEventListener("request", listener);
      clearTimeout(timer.current);
    };
  }, [ready, schedule]);
}
