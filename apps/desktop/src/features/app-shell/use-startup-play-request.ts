import { useEffect, useRef, useState } from "react";
import { desktopApi } from "../../api";
import { listenDesktopEvent } from "../../desktop-events";
import type { PortStatus } from "../../types";
import { directlyPlayable } from "../../view-model";
import type { CatalogEntry } from "../browsing/catalog-entry";

export type StartupPlayAction =
  | { kind: "play"; port: CatalogEntry }
  | { kind: "details"; port: CatalogEntry };

/**
 * What a jump-list play request does in the current library. A game that can
 * play directly uses the ordinary Play action; one that needs attention opens
 * its details instead. An unknown game opens nothing.
 */
export function startupPlayAction(
  portId: string,
  entries: readonly CatalogEntry[],
  statuses: ReadonlyMap<string, PortStatus>,
): StartupPlayAction | undefined {
  const port = entries.find((entry) => entry.id === portId);
  if (!port) return undefined;
  return directlyPlayable(port, statuses.get(port.id))
    ? { kind: "play", port }
    : { kind: "details", port };
}

/**
 * Takes the host's one-shot startup play request once the workspace has its
 * catalog and statuses, then routes it through the existing actions. The host
 * keeps no other copy, so a reload or library switch never repeats it. When the
 * installed application forwards a later jump-list launch, the host announces a
 * new request and it is taken the same way.
 */
export function useStartupPlayRequest({
  ready,
  entries,
  statuses,
  play,
  openDetails,
}: {
  ready: boolean;
  entries: readonly CatalogEntry[];
  statuses: ReadonlyMap<string, PortStatus>;
  play: (port: CatalogEntry) => void;
  openDetails: (portId: string) => void;
}) {
  const [forwarded, setForwarded] = useState(0);
  const handled = useRef(-1);
  const latest = useRef({ entries, statuses, play, openDetails });
  useEffect(() => {
    latest.current = { entries, statuses, play, openDetails };
  });
  useEffect(() => {
    let closed = false;
    let stop: (() => void) | undefined;
    void listenDesktopEvent("portcove://play-request", () => setForwarded((count) => count + 1))
      .then((unlisten) => {
        if (closed) unlisten();
        else stop = unlisten;
      })
      .catch(() => {
        // Without forwarding a later launch still brings the window forward.
      });
    return () => {
      closed = true;
      stop?.();
    };
  }, []);
  useEffect(() => {
    if (!ready || handled.current === forwarded) return;
    handled.current = forwarded;
    void desktopApi
      .takeStartupPlayRequest()
      .then((portId) => {
        if (!portId) return;
        const current = latest.current;
        const action = startupPlayAction(portId, current.entries, current.statuses);
        if (action?.kind === "play") current.play(action.port);
        else if (action?.kind === "details") current.openDetails(action.port.id);
      })
      .catch(() => {
        // Without a request the app simply opens; nothing else depends on it.
      });
  }, [ready, forwarded]);
}
