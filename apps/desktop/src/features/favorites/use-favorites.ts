import { useCallback, useEffect, useRef, useState } from "react";
import { desktopApi } from "../../api";

export function useFavorites(generation: number) {
  const [snapshot, setSnapshot] = useState<{
    generation: number;
    ids?: ReadonlySet<string>;
    failure?: "read" | "write";
    busy: boolean;
  }>({ generation, busy: true });
  const [only, setOnly] = useState(false);
  const lifetime = useRef({ generation, request: 0, closed: false, busy: false });
  const refresh = useCallback(async () => {
    const owner = lifetime.current;
    if (owner.closed || owner.generation !== generation || owner.busy) return false;
    owner.busy = true;
    const request = ++owner.request;
    setSnapshot((current) => ({ ...current, generation, busy: true }));
    try {
      const ids = await desktopApi.favoritePorts(generation);
      if (!owner.closed && owner.request === request) {
        setSnapshot({ generation, ids: new Set(ids), busy: false });
        return true;
      }
    } catch {
      if (!owner.closed && owner.request === request)
        setSnapshot((current) => ({ ...current, generation, failure: "read", busy: false }));
    } finally {
      owner.busy = false;
    }
    return false;
  }, [generation]);
  useEffect(() => {
    const owner = { generation, request: 0, closed: false, busy: false };
    lifetime.current = owner;
    setSnapshot({ generation, busy: true });
    setOnly(false);
    void refresh();
    return () => {
      owner.closed = true;
      owner.request++;
    };
  }, [generation, refresh]);
  const ids = snapshot.generation === generation ? snapshot.ids : undefined;
  const toggle = useCallback(
    async (portId: string) => {
      const owner = lifetime.current;
      if (!ids || owner.closed || owner.generation !== generation || owner.busy) return false;
      owner.busy = true;
      const request = ++owner.request;
      const favorite = !ids.has(portId);
      setSnapshot((current) => ({ ...current, busy: true }));
      try {
        await desktopApi.setPortFavorite(portId, favorite, generation);
        if (!owner.closed && owner.request === request) {
          setSnapshot((current) => {
            const next = new Set(current.ids);
            if (favorite) next.add(portId);
            else next.delete(portId);
            return { generation, ids: next, busy: false, failure: current.failure };
          });
          return true;
        }
      } catch {
        if (!owner.closed && owner.request === request)
          setSnapshot((current) => ({ ...current, failure: "write", busy: false }));
      } finally {
        owner.busy = false;
      }
      return false;
    },
    [generation, ids],
  );
  return {
    ids,
    only: snapshot.generation === generation && only,
    setOnly,
    toggle,
    refresh,
    busy: snapshot.generation !== generation || snapshot.busy,
    failure: snapshot.generation === generation ? snapshot.failure : undefined,
  };
}
