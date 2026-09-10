import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import { ArtworkCache, type ArtworkDisplay } from "./artwork-cache";
import type { ArtworkSlot } from "./types";

const ArtworkContext = createContext<ArtworkCache | undefined>(undefined);
const unavailable: ArtworkDisplay = { loading: false };

export function ArtworkProvider({ generation, children }: { generation: number; children: ReactNode }) {
  const cache = useMemo(() => new ArtworkCache(generation), [generation]);
  return <ArtworkContext.Provider value={cache}>{children}</ArtworkContext.Provider>;
}

export function useArtwork(portId: string, slot: ArtworkSlot, visible = true) {
  const cache = useContext(ArtworkContext);
  const subscribe = useCallback((listener: () => void) => {
    if (cache) return cache.subscribe(portId, slot, listener);
    return () => {};
  }, [cache, portId, slot]);
  const read = useCallback(() => cache?.read(portId, slot) ?? unavailable, [cache, portId, slot]);
  const display = useSyncExternalStore(subscribe, read, () => unavailable);
  useEffect(() => { if (visible) void cache?.load(portId, slot, true); }, [cache, portId, slot, visible]);
  return { cache, display };
}

export function useArtworkVisibility() {
  const element = useRef<HTMLDivElement>(null);
  const [visible, setVisible] = useState(false);
  useEffect(() => {
    if (!element.current) return;
    if (typeof IntersectionObserver === "undefined") { setVisible(true); return; }
    const observer = new IntersectionObserver(entries => setVisible(entries.some(entry => entry.isIntersecting)), { rootMargin: "200px" });
    observer.observe(element.current);
    return () => observer.disconnect();
  }, []);
  return { element, visible };
}
