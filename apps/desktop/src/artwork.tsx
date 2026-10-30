import { heroMediaCandidates, type HeroMediaContext, type HeroMediaPort } from "./hero-media";
import type { PortIdentity } from "./port-identity";
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
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

/** A bounded per-surface fallback chain. Rejections are ephemeral, not asset choices. */
function useCatalogMediaChain(
  portId: string,
  candidates: readonly CatalogMediaAsset[],
  visible: boolean,
) {
  const cache = useContext(ArtworkContext);
  const key = JSON.stringify([
    portId,
    candidates.map((asset) => [asset.id, asset.sha256, asset.role]),
  ]);
  const active = useRef({ cache, key });
  useLayoutEffect(() => {
    active.current = { cache, key };
  }, [cache, key]);
  const [choice, setChoice] = useState<{ cache: typeof cache; key: string; rejected: string[] }>({
    cache,
    key,
    rejected: [],
  });
  const rejected = choice.cache === cache && choice.key === key ? choice.rejected : [];
  const candidate = candidates.find((asset) => !rejected.includes(`${asset.id}:${asset.sha256}`));
  const { display } = useCatalogMedia(portId, candidate, visible);
  const reject = useCallback(() => {
    if (!candidate || active.current.cache !== cache || active.current.key !== key) return;
    const id = `${candidate.id}:${candidate.sha256}`;
    setChoice((previous) => {
      const current = previous.cache === cache && previous.key === key ? previous.rejected : [];
      return current.includes(id) ? previous : { cache, key, rejected: [...current, id] };
    });
  }, [cache, key, candidate]);
  useEffect(() => {
    if (visible && display.error) reject();
  }, [visible, display.error, reject]);
  return { candidate, display, reject, exhausted: !candidate };
}

/** Shared hero selection preserves local Detail choices and independent background media. */
function useHeaderArtwork(
  port: PortIdentity & { id: string },
  visible: boolean,
  context: HeroMediaContext = {},
) {
  const { display: local } = useArtwork(port.id, "detail", visible);
  const allowCatalog = Boolean(local.state && !local.state.choice.asset_sha256);
  const candidates = heroMediaCandidates(port, context).backgrounds;
  const catalog = useCatalogMediaChain(port.id, candidates, visible && allowCatalog);
  const usingCatalog = Boolean(allowCatalog && catalog.display.image);
  return {
    // The automatic cover is a portrait identity, never a manufactured banner.
    display: usingCatalog
      ? catalog.display
      : local.state?.resolved_source.kind === "igdb_cover"
        ? unavailable
        : local,
    catalogMedia: usingCatalog ? catalog.candidate : undefined,
  };
}

/** One ordering for details and Continue; a foreground failure never gates other roles. */
export function useGameHeroArtwork(
  port: HeroMediaPort,
  visible: boolean,
  context: HeroMediaContext = {},
) {
  const candidates = heroMediaCandidates(port, context);
  const foreground = useCatalogMediaChain(port.id, candidates.foreground, visible);
  const { display: cover } = useArtwork(port.id, "cover", visible);
  const background = useHeaderArtwork(port, visible, context);
  return {
    foreground: { ...foreground, initialRole: candidates.foreground[0]?.role },
    cover,
    background,
  };
}
