import { useEffect, useRef } from "react";
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

/** Tell views that the player turned ready notices on or off, so they reassess. */
export function announceReadyNoticePreferenceChange() {
  events.dispatchEvent(new Event("notices"));
}

/** Runs `listener` after the ready-notice setting changes. */
export function onReadyNoticePreferenceChange(listener: () => void) {
  events.addEventListener("notices", listener);
  return () => events.removeEventListener("notices", listener);
}

/** Identity of the registered files, so a refresh that changed none triggers no pass. */
export function sourcesKey(sources: readonly { profile_id: string; sha256: string }[]) {
  return sources.map((source) => `${source.profile_id}:${source.sha256}`).join("\n");
}

const settleMilliseconds = 1500;
const busyRetryMilliseconds = 30_000;
const recheckMilliseconds = 15 * 60_000;

/**
 * Request the shared Core pass while Desktop is open. Core reads the standing
 * choices for game setup and provider updates from the library.
 */
export function useStandingSetupCatchUp(
  generation: number,
  ready: boolean,
  catalog: unknown,
  sources: unknown,
  onChanged: () => Promise<unknown>,
) {
  const changed = useRef(onChanged);
  const schedule = useRef<() => void>(undefined);
  useEffect(() => {
    changed.current = onChanged;
  }, [onChanged]);

  useEffect(() => {
    if (!ready) return;
    let active = true;
    let running = false;
    let requested = false;
    let retried = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const queue = (delay: number) => {
      clearTimeout(timer);
      timer = setTimeout(() => void run(), delay);
    };
    const run = async () => {
      running = true;
      let deferred = false;
      try {
        const result = await desktopApi.runStandingSetup(generation, () => undefined);
        if (!active) return;
        deferred =
          result.already_running ||
          (result.mod_updates ?? []).some((update) => update.outcome === "deferred");
        const updated = (result.mod_updates ?? []).some((update) => update.outcome === "applied");
        if (result.batches.length || updated) await changed.current();
      } catch {
        // A later pass can try again after a transient library or host failure.
      } finally {
        running = false;
        if (active) {
          if (requested) {
            requested = false;
            queue(settleMilliseconds);
          } else if (deferred && !retried) {
            retried = true;
            queue(busyRetryMilliseconds);
          } else {
            retried = false;
            queue(recheckMilliseconds);
          }
          events.dispatchEvent(new Event("pass"));
        }
      }
    };
    const request = () => {
      retried = false;
      if (running) requested = true;
      else queue(settleMilliseconds);
    };
    schedule.current = request;
    events.addEventListener("request", request);
    return () => {
      // oxlint-disable-next-line react/immutability -- oxc#28401: effect-local binding.
      active = false;
      events.removeEventListener("request", request);
      clearTimeout(timer);
      schedule.current = undefined;
    };
  }, [generation, ready]);

  useEffect(() => {
    schedule.current?.();
  }, [generation, ready, catalog, sources]);
}
