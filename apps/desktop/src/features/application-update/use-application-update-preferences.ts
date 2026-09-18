import { useCallback, useEffect, useRef, useState } from "react";
import { desktopApi } from "../../api";
import type { ApplicationUpdatePreferences } from "../../types";

// App-session read state only. Every mutation remains revision-checked by the host.
export function useApplicationUpdatePreferences() {
  const current = useRef<ApplicationUpdatePreferences | undefined>(undefined);
  const active = useRef(true);
  const accepted = useRef(0);
  const pending = useRef<Promise<ApplicationUpdatePreferences> | undefined>(undefined);
  const [preferences, setPreferences] = useState<ApplicationUpdatePreferences>();
  const [failure, setFailure] = useState<unknown>();
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    active.current = true;
    return () => {
      active.current = false;
      pending.current = undefined;
    };
  }, []);

  const accept = useCallback((next: ApplicationUpdatePreferences) => {
    if (!active.current) return current.current ?? next;
    accepted.current += 1;
    if (!current.current || next.revision > current.current.revision) current.current = next;
    setPreferences(current.current);
    setFailure(undefined);
    return current.current;
  }, []);

  const refresh = useCallback(() => {
    if (pending.current) return pending.current;
    const version = accepted.current;
    setLoading(true);
    setFailure(undefined);
    const request = desktopApi
      .applicationUpdatePreferences()
      .then(
        (next) => {
          if (!active.current || pending.current !== request) return next;
          return accept(next);
        },
        (error: unknown) => {
          if (active.current && pending.current === request && accepted.current === version) {
            setFailure(error);
            setPreferences(undefined);
          }
          throw error;
        },
      )
      .finally(() => {
        if (active.current && pending.current === request) {
          pending.current = undefined;
          setLoading(false);
        }
      });
    pending.current = request;
    return request;
  }, [accept]);

  return { preferences, failure, loading, accept, refresh };
}

export type ApplicationUpdatePreferencesState = ReturnType<typeof useApplicationUpdatePreferences>;
