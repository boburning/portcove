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

  const publish = useCallback((next: ApplicationUpdatePreferences) => {
    if (!active.current) return current.current ?? next;
    accepted.current += 1;
    const previous = current.current;
    if (
      !previous ||
      previous.schema_version !== next.schema_version ||
      previous.revision !== next.revision ||
      previous.choice?.channel !== next.choice?.channel ||
      previous.choice?.mode !== next.choice?.mode ||
      previous.choice?.paused !== next.choice?.paused
    ) {
      current.current = next;
    }
    setPreferences(current.current);
    setFailure(undefined);
    return current.current!;
  }, []);

  const accept = useCallback(
    (next: ApplicationUpdatePreferences) => {
      return publish(
        current.current && next.revision < current.current.revision ? current.current : next,
      );
    },
    [publish],
  );

  const acceptRecovered = useCallback(
    (next: ApplicationUpdatePreferences) => {
      if (!active.current) return current.current ?? next;
      // A successful explicit host recovery can restart the revision at one.
      // Requests issued before that recovery cannot republish their old identity.
      pending.current = undefined;
      setLoading(false);
      return publish(next);
    },
    [publish],
  );

  const refresh = useCallback(() => {
    if (pending.current) return pending.current;
    const version = accepted.current;
    setLoading(true);
    setFailure(undefined);
    const request = desktopApi
      .applicationUpdatePreferences()
      .then(
        (next) => {
          if (!active.current || pending.current !== request || accepted.current !== version) {
            return current.current ?? next;
          }
          // A fresh host read can observe external recovery, even at a lower or
          // equal revision. Only a result racing newer accepted state is stale.
          return publish(next);
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
  }, [publish]);

  return { preferences, failure, loading, accept, acceptRecovered, refresh };
}

export type ApplicationUpdatePreferencesState = ReturnType<typeof useApplicationUpdatePreferences>;
