import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from "react";
import { ArtworkCache, type ArtworkDisplay } from "./artwork-cache";
import type { ArtworkSlot } from "./types";

const ArtworkContext = createContext<ArtworkCache | undefined>(undefined);
const unavailable: ArtworkDisplay = { loading: false };

export function ArtworkProvider({
  generation,
  children,
}: {
  generation: number;
  children: ReactNode;
}) {
  const cache = useMemo(() => new ArtworkCache(generation), [generation]);
  return <ArtworkContext.Provider value={cache}>{children}</ArtworkContext.Provider>;
}

export function useArtwork(portId: string, slot: ArtworkSlot, visible = true) {
  const cache = useContext(ArtworkContext);
  const subscribe = useCallback(
    (listener: () => void) => {
      if (cache && visible) return cache.subscribe(portId, slot, listener);
      return () => {};
    },
    [cache, portId, slot, visible],
  );
  const read = useCallback(
    () => (visible ? (cache?.read(portId, slot) ?? unavailable) : unavailable),
    [cache, portId, slot, visible],
  );
  const display = useSyncExternalStore(subscribe, read, () => unavailable);
  useEffect(() => {
    let current = true;
    if (visible) void cache?.load(portId, slot, true, () => current);
    return () => {
      current = false;
    };
  }, [cache, portId, slot, visible]);
  return { cache, display };
}

export function useArtworkVisibility() {
  const element = useRef<HTMLDivElement>(null);
  const [visible, setVisible] = useState(() => typeof IntersectionObserver === "undefined");
  useEffect(() => {
    if (!element.current) return;
    if (typeof IntersectionObserver === "undefined") return;
    const observer = new IntersectionObserver(
      (entries) => setVisible(entries.some((entry) => entry.isIntersecting)),
      { rootMargin: "200px" },
    );
    observer.observe(element.current);
    return () => observer.disconnect();
  }, []);
  return { element, visible };
}
