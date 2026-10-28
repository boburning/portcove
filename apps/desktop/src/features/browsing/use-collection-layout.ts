import { useMemo, useSyncExternalStore } from "react";
import { libraryBrowsingKey } from "../app-shell/use-library-browsing-context";

export type CollectionLayout = "covers" | "rows";
export function collectionLayoutKey(root: string, workspace: "library" | "catalog" = "library") {
  return `portcove.collection-layout.v1:${workspace === "catalog" ? "catalog:" : ""}${libraryBrowsingKey(root)}`;
}

function layoutPreference(root: string | null, workspace: "library" | "catalog") {
  let value: CollectionLayout = "covers";
  let failure: "read" | "write" | undefined;
  try {
    const stored =
      root && typeof window !== "undefined"
        ? window.localStorage.getItem(collectionLayoutKey(root, workspace))
        : null;
    if (stored === "covers" || stored === "rows") value = stored;
  } catch {
    failure = "read";
  }
  let snapshot: { value: CollectionLayout; failure: "read" | "write" | undefined } = {
    value,
    failure,
  };
  const listeners = new Set<() => void>();
  return {
    read: () => snapshot,
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    set: (next: CollectionLayout) => {
      let failure: "write" | undefined;
      try {
        if (root) window.localStorage.setItem(collectionLayoutKey(root, workspace), next);
      } catch {
        failure = "write";
      }
      snapshot = { value: next, failure };
      for (const listener of listeners) listener();
    },
  };
}

/** Profile-local presentation only; existing browsing envelopes and Core data are untouched. */
export function useCollectionLayout(
  root: string | null,
  workspace: "library" | "catalog" = "library",
) {
  const preference = useMemo(() => layoutPreference(root, workspace), [root, workspace]);
  const state = useSyncExternalStore(preference.subscribe, preference.read, preference.read);
  return { ...state, set: preference.set };
}
