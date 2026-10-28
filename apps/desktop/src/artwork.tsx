import type { PortIdentity } from "./port-identity";
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
import type {
  ArtworkSlot,
  CatalogDocument,
  CatalogListingDocument,
  CatalogMediaAsset,
} from "./types";

const ArtworkContext = createContext<ArtworkCache | undefined>(undefined);
const unavailable: ArtworkDisplay = { loading: false };

export function ArtworkProvider({
  generation,
  catalog,
  listings,
  children,
}: {
  generation: number;
  catalog?: CatalogDocument | null | undefined;
  listings?: CatalogListingDocument | undefined;
  children: ReactNode;
}) {
  const catalogArtworkKey = JSON.stringify([
    catalog?.ports.map(({ id, presentation }) => [
      id,
      presentation?.artwork,
      presentation?.media,
    ]) ?? [],
    listings?.listings.map(({ id, artwork, media }) => [id, artwork, media]) ?? [],
  ]);
  const cache = useMemo(
    () => new ArtworkCache(generation, catalogArtworkKey),
    [generation, catalogArtworkKey],
  );
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

export function useCatalogMedia(
  portId: string,
  media: CatalogMediaAsset | undefined,
  visible: boolean,
) {
  const cache = useContext(ArtworkContext);
  const interest = useRef<CatalogMediaAsset | undefined>(undefined);
  const subscribe = useCallback(
    (listener: () => void) =>
      cache && media && visible ? cache.subscribeMedia(portId, media, listener) : () => {},
    [cache, portId, media, visible],
  );
  const read = useCallback(
    () => (media && visible ? (cache?.readMedia(portId, media) ?? unavailable) : unavailable),
    [cache, portId, media, visible],
  );
  const display = useSyncExternalStore(subscribe, read, () => unavailable);
  useEffect(() => {
    let current = true;
    interest.current = visible ? media : undefined;
    if (media && visible) cache?.loadMedia(portId, media, () => current);
    return () => {
      current = false;
      interest.current = undefined;
    };
  }, [cache, portId, media, visible]);
  const retry = () => {
    if (media && visible) cache?.loadMedia(portId, media, () => interest.current === media, true);
  };
  return { display, retry };
}

/** Shared hero selection preserves local artwork precedence and catalog media attribution. */
export function useHeaderArtwork(port: PortIdentity & { id: string }, visible: boolean) {
  const { display: local } = useArtwork(port.id, "detail", visible);
  const header = port.presentation?.media?.find((asset) => asset.role === "header");
  const allowCatalog = Boolean(local.state && !local.state.choice.asset_sha256);
  const { display: catalog } = useCatalogMedia(port.id, header, visible && allowCatalog);
  const usingCatalog = Boolean(allowCatalog && catalog.image);
  return {
    display: usingCatalog ? catalog : local,
    catalogMedia: usingCatalog ? catalog.media : undefined,
  };
}
