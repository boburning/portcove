import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { desktopApi } from "../../api";

export function useFavorites(generation: number) {
  const [snapshot, setSnapshot] = useState<{
    generation: number;
    ids?: ReadonlySet<string>;
    failure?: "read" | "write";
    busy: boolean;
  }>({ generation, busy: true });
  const [only, setOnly] = useState(false);
  const [selectedGeneration, setSelectedGeneration] = useState(generation);
  if (selectedGeneration !== generation) {
    setSelectedGeneration(generation);
    setSnapshot({ generation, busy: true });
    setOnly(false);
  }
  const lifetime = useRef({ generation, request: 0, closed: false, busy: false });
  const loadFavorites = useCallback(async () => {
    const owner = lifetime.current;
    if (owner.closed || owner.generation !== generation || owner.busy) return false;
    owner.busy = true;
    const request = ++owner.request;
    return Promise.resolve()
      .then(() => desktopApi.favoritePorts(generation))
      .then((ids) => {
        if (!owner.closed && owner.request === request) {
          setSnapshot({ generation, ids: new Set(ids), busy: false });
          return true;
        }
        return false;
      })
      .catch(() => {
        if (!owner.closed && owner.request === request)
          setSnapshot((current) => ({ ...current, generation, failure: "read", busy: false }));
        return false;
      })
      .finally(() => {
        owner.busy = false;
      });
  }, [generation]);
  const refresh = useCallback(async () => {
    const owner = lifetime.current;
    if (owner.closed || owner.generation !== generation || owner.busy) return false;
    setSnapshot((current) => ({ ...current, generation, busy: true }));
    return loadFavorites();
  }, [generation, loadFavorites]);
  useEffect(() => {
    const owner = { generation, request: 0, closed: false, busy: false };
    lifetime.current = owner;
    void loadFavorites();
    return () => {
      owner.closed = true;
      owner.request++;
    };
  }, [generation, loadFavorites]);
  const ids = snapshot.generation === generation ? snapshot.ids : undefined;
  const setPorts = useCallback(
    async (portIds: readonly string[], favorite: boolean, before?: () => Promise<boolean>) => {
      const owner = lifetime.current;
      if (!ids || owner.closed || owner.generation !== generation || owner.busy) return false;
      owner.busy = true;
      const request = ++owner.request;
      const next = new Set(ids);
      setSnapshot((current) => ({ ...current, busy: true }));
      try {
        if (before && !(await before())) {
          if (!owner.closed) setSnapshot((current) => ({ ...current, busy: false }));
          return false;
        }
        for (const portId of portIds) {
          if (owner.closed) return false;
          await desktopApi.setPortFavorite(portId, favorite, generation);
          if (favorite) next.add(portId);
          else next.delete(portId);
        }
        if (!owner.closed && owner.request === request) {
          setSnapshot((current) => ({ ...current, ids: next, busy: false }));
          return true;
        }
      } catch {
        if (!owner.closed && owner.request === request)
          setSnapshot((current) => ({ ...current, ids: next, failure: "write", busy: false }));
      } finally {
        owner.busy = false;
      }
      return false;
    },
    [generation, ids],
  );
  const toggle = useCallback(
    (portId: string) => setPorts([portId], !ids?.has(portId)),
    [ids, setPorts],
  );
  const visibleOnly = snapshot.generation === generation && only;
  const busy = snapshot.generation !== generation || snapshot.busy;
  const failure = snapshot.generation === generation ? snapshot.failure : undefined;
  // A stable value lets memoized collection cards skip unrelated workspace renders.
  return useMemo(
    () => ({ ids, only: visibleOnly, setOnly, toggle, setPorts, refresh, busy, failure }),
    [ids, visibleOnly, toggle, setPorts, refresh, busy, failure],
  );
}
