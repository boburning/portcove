import { useCallback, useEffect, useRef, useState } from "react";
import { desktopApi } from "../../api";
import type { LibraryOrganization, OrganizationChange } from "../../types";

/** Host-persisted display choices. Nothing here changes Core action eligibility. */
export function useOrganization(generation: number) {
  const [state, setState] = useState<{
    generation: number;
    snapshot?: LibraryOrganization;
    busy: boolean;
    failure?: "read" | "write";
  }>({ generation, busy: true });
  const lifetime = useRef({ generation, closed: false, busy: false });
  const load = useCallback(async () => {
    const owner = lifetime.current;
    if (owner.closed || owner.generation !== generation || owner.busy) return false;
    owner.busy = true;
    try {
      const snapshot = await desktopApi.organizationPreferences(generation);
      if (owner.closed) return false;
      setState({ generation, snapshot, busy: false });
      return true;
    } catch {
      if (!owner.closed)
        setState((current) =>
          current.generation === generation
            ? { ...current, failure: "read", busy: false }
            : { generation, failure: "read", busy: false },
        );
      return false;
    } finally {
      owner.busy = false;
    }
  }, [generation]);
  useEffect(() => {
    const owner = { generation, closed: false, busy: false };
    lifetime.current = owner;
    void Promise.resolve().then(load);
    return () => {
      owner.closed = true;
    };
  }, [generation, load]);
  const refresh = useCallback(async () => {
    const owner = lifetime.current;
    if (owner.closed || owner.generation !== generation || owner.busy) return false;
    setState((current) => ({ ...current, busy: true }));
    return load();
  }, [generation, load]);
  const snapshot = state.generation === generation ? state.snapshot : undefined;
  const commit = useCallback(
    async (change: OrganizationChange) => {
      const owner = lifetime.current;
      if (!snapshot || owner.closed || owner.generation !== generation || owner.busy) return false;
      owner.busy = true;
      setState((current) => ({ ...current, busy: true }));
      try {
        const next = await desktopApi.changeOrganization(snapshot.revision, change, generation);
        if (owner.closed) return false;
        setState({ generation, snapshot: next, busy: false });
        return true;
      } catch {
        if (!owner.closed) setState((current) => ({ ...current, failure: "write", busy: false }));
        return false;
      } finally {
        owner.busy = false;
      }
    },
    [generation, snapshot],
  );
  return {
    snapshot,
    commit,
    refresh,
    busy: state.generation !== generation || state.busy,
    failure: state.generation === generation ? state.failure : undefined,
  };
}
