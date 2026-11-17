import { useEffect, useRef, useSyncExternalStore } from "react";
import { desktopApi } from "../../api";
import type { ListingDeliveryStatus, OfficialCatalogAutomaticRefresh } from "../../types";

/** The first check waits until the workspace is up, so it never delays startup. */
export const firstCheckMilliseconds = 15_000;
/** About once a day while Portcove keeps running. */
export const checkIntervalMilliseconds = 24 * 60 * 60 * 1000;
/** How long to wait while another task is using the library. */
export const busyRetryMilliseconds = 60_000;
const requestSettleMilliseconds = 1_500;

/** The most recent scheduled check for one library, kept only while Portcove runs. */
export type AutomaticCatalogCheck =
  | { generation: number; at: number; kind: "result"; result: OfficialCatalogAutomaticRefresh }
  | { generation: number; at: number; kind: "failed" };

const events = new EventTarget();
let lastCheck: AutomaticCatalogCheck | undefined;

function record(check: AutomaticCatalogCheck) {
  lastCheck = check;
  events.dispatchEvent(new Event("check"));
}

function subscribe(listener: () => void) {
  events.addEventListener("check", listener);
  return () => events.removeEventListener("check", listener);
}

/** The latest scheduled check, for the catalog update settings. */
export function useLastAutomaticCatalogCheck(): AutomaticCatalogCheck | undefined {
  const read = () => lastCheck;
  // Server rendering (and its tests) reads the same in-memory snapshot.
  return useSyncExternalStore(subscribe, read, read);
}

/** Ask for a scheduled check soon, for example after the player turns updates on. */
export function requestAutomaticCatalogCheck() {
  events.dispatchEvent(new Event("request"));
}

/** A player's own successful refresh is the latest check, so status stays consistent. */
export function recordCatalogRefresh(generation: number, status: ListingDeliveryStatus) {
  record({
    generation,
    at: Date.now(),
    kind: "result",
    result: { outcome: "refreshed", serving: null, status },
  });
}

/** Test seam: forget the previous check between isolated renders. */
export function resetAutomaticCatalogCheck() {
  lastCheck = undefined;
}

/**
 * Schedules the official catalog refresh: once shortly after a library has
 * loaded, then about once a day while Portcove runs. Core owns the player's
 * choice, the trust check, one-at-a-time refresh and keeping the current
 * catalog on failure; this hook only asks for checks. Checks never overlap,
 * wait while another task is using the library, and fail quietly: the result
 * is shown in catalog update settings rather than as an error notice.
 */
export function useOfficialCatalogAutoRefresh(
  generation: number,
  ready: boolean,
  busy: boolean,
  onChanged: () => Promise<unknown>,
) {
  const changed = useRef(onChanged);
  const isBusy = useRef(busy);
  const running = useRef(false);
  useEffect(() => {
    changed.current = onChanged;
    isBusy.current = busy;
  }, [onChanged, busy]);

  useEffect(() => {
    if (!ready) return;
    const lifetime: {
      active: boolean;
      requested: boolean;
      timer?: ReturnType<typeof setTimeout>;
    } = { active: true, requested: false };
    const schedule = (delay: number) => {
      clearTimeout(lifetime.timer);
      lifetime.timer = setTimeout(() => void check(), delay);
    };
    async function check(): Promise<void> {
      if (!lifetime.active) return;
      // A check still running (possibly for the previous library) is never
      // joined or overlapped; look again shortly instead.
      if (running.current || isBusy.current) {
        schedule(busyRetryMilliseconds);
        return;
      }
      running.current = true;
      lifetime.requested = false;
      let next = checkIntervalMilliseconds;
      try {
        // Progress and outcome appear through the ordinary Activity events.
        const result = await desktopApi.refreshOfficialCatalogAutomatically(
          generation,
          () => undefined,
        );
        if (!lifetime.active) return;
        if (result.outcome === "already_running") next = busyRetryMilliseconds;
        else if (result.outcome !== "turned_off")
          record({ generation, at: Date.now(), kind: "result", result });
        if (result.outcome === "refreshed") await changed.current();
      } catch {
        // A failed check keeps the current catalog; settings shows it and the
        // next scheduled check tries again.
        if (lifetime.active) record({ generation, at: Date.now(), kind: "failed" });
      } finally {
        running.current = false;
        // A request that arrived while this check ran is answered soon, not tomorrow.
        if (lifetime.active) schedule(lifetime.requested ? requestSettleMilliseconds : next);
      }
    }
    schedule(firstCheckMilliseconds);
    const listener = () => {
      lifetime.requested = true;
      schedule(requestSettleMilliseconds);
    };
    events.addEventListener("request", listener);
    return () => {
      lifetime.active = false;
      events.removeEventListener("request", listener);
      clearTimeout(lifetime.timer);
    };
  }, [generation, ready]);
}
