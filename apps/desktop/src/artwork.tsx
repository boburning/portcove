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
import { ArtworkCache, type ArtworkDisplay, type ArtworkPriority } from "./artwork-cache";

import type {
  ArtworkSlot,
  ArtworkState,
  CatalogDocument,
  CatalogListingDocument,
  CatalogMediaAsset,
  IgdbArtwork,
} from "./types";

const selectedArtwork: ArtworkPriority = () => 2;

const ArtworkContext = createContext<ArtworkCache | undefined>(undefined);
const unavailable: ArtworkDisplay = { loading: false };
const noCollection: readonly ArtworkDisplay[] = [];
const CollectionCoversContext = createContext<ReadonlyMap<string, readonly IgdbArtwork[]>>(
  new Map(),
);
type CatalogArtworkEntry = readonly [id: string, ...artwork: unknown[]];
const CatalogArtworkContext = createContext<readonly (readonly CatalogArtworkEntry[])[]>([]);

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
  // Workspace reads share unchanged catalog references, so serialize only on change.
  const catalogArtwork = useMemo(
    () => [
      catalog?.ports.map(
        ({ id, presentation }) =>
          [
            id,
            presentation?.artwork,
            presentation?.companion_cover,
            presentation?.collection_covers,
            presentation?.media,
          ] as const,
      ) ?? [],
      listings?.listings.map(
        ({ id, artwork, media, collection_covers }) =>
          [id, artwork, media, collection_covers] as const,
      ) ?? [],
    ],
    [catalog, listings],
  );
  const catalogArtworkKey = useMemo(() => JSON.stringify(catalogArtwork), [catalogArtwork]);
  const cache = useMemo(
    () => new ArtworkCache(generation, catalogArtworkKey),
    [generation, catalogArtworkKey],
  );
  useEffect(() => () => cache.clearRetryTimers(), [cache]);
  const collections = useMemo(() => {
    const result = new Map<string, readonly IgdbArtwork[]>();
    for (const listing of listings?.listings ?? [])
      if (listing.collection_covers) result.set(listing.id, listing.collection_covers);
    for (const port of catalog?.ports ?? [])
      if (port.presentation?.collection_covers)
        result.set(port.id, port.presentation.collection_covers);
    return result;
  }, [catalog, listings]);
  return (
    <ArtworkContext.Provider value={cache}>
      <CatalogArtworkContext.Provider value={catalogArtwork}>
        <CollectionCoversContext.Provider value={collections}>
          {children}
        </CollectionCoversContext.Provider>
      </CatalogArtworkContext.Provider>
    </ArtworkContext.Provider>
  );
}

export function useCatalogArtworkKey(portId: string) {
  const catalogArtwork = useContext(CatalogArtworkContext);
  return useMemo(
    () => JSON.stringify(catalogArtwork.map((entries) => entries.find(([id]) => id === portId))),
    [catalogArtwork, portId],
  );
}

export function usesAutomaticArtwork(state?: ArtworkState): boolean {
  return Boolean(state && !state.choice.asset_sha256 && !state.choice.suppressed);
}

/** Collection defaults remain subordinate to every explicit local choice, even an unavailable one. */
export function useCollectionCovers(
  portId: string | undefined,
  primary: ArtworkDisplay,
  visible: boolean,
  priority: ArtworkPriority = selectedArtwork,
) {
  const cache = useContext(ArtworkContext);
  const collections = useContext(CollectionCoversContext);
  const covers = portId ? collections.get(portId) : undefined;
  const revision = primary.state?.choice.revision;
  const enabled = usesAutomaticArtwork(primary.state) && !primary.stale;
  const keys = useMemo(
    () =>
      cache && portId && enabled && revision !== undefined
        ? (covers ?? []).slice(0, 4).map((cover) => ({
            sha256: cover.image_sha256,
            key: cache.collectionKey(portId, cover.image_sha256, revision),
          }))
        : [],
    [cache, portId, enabled, revision, covers],
  );
  const read = useCallback(() => (keys.length ? (cache?.displayVersion ?? 0) : 0), [cache, keys]);
  const subscribe = useCallback(
    (listener: () => void) => {
      const stop =
        cache && visible ? keys.map(({ key }) => cache.subscribeCollection(key, listener)) : [];
      return () => {
        for (const unsubscribe of stop) unsubscribe();
      };
    },
    [cache, keys, visible],
  );
  useSyncExternalStore(subscribe, read, () => 0);
  const displays = keys.length
    ? keys.map(({ key }) => cache?.readCollection(key) ?? unavailable)
    : noCollection;
  useEffect(() => {
    let current = true;
    if (visible && !primary.loading && cache && portId && revision !== undefined)
      for (const { key, sha256 } of keys)
        cache.loadCollectionCover(key, portId, sha256, revision, () => current, priority);
    return () => {
      current = false;
    };
  }, [visible, primary.loading, cache, portId, revision, keys, priority]);
  return displays;
}

/** The current library's artwork cache, when one is provided. */
export function useArtworkCache() {
  return useContext(ArtworkContext);
}

export function useCoverCollection(portId: string) {
  return useContext(CollectionCoversContext).get(portId);
}

export function useArtwork(
  portId: string,
  slot: ArtworkSlot,
  visible = true,
  priority: ArtworkPriority = selectedArtwork,
) {
  const cache = useContext(ArtworkContext);
  const subscribe = useCallback(
    (listener: () => void) => {
      if (cache && visible) return cache.subscribe(portId, slot, listener);
      return () => {};
    },
    [cache, portId, slot, visible],
  );
  const read = useCallback(
    // A retained image stays mounted after its card scrolls away, so scrolling back
    // does not re-decode it. Only loading and live updates need visibility.
    () => cache?.read(portId, slot) ?? unavailable,
    [cache, portId, slot],
  );
  const display = useSyncExternalStore(subscribe, read, () => unavailable);
  useEffect(() => {
    let current = true;
    if (visible) {
      // A loaded, current image is kept; a missing or stale one is read again.
      const shown = cache?.read(portId, slot);
      void cache?.load(
        portId,
        slot,
        !shown?.image || Boolean(shown.stale),
        () => current,
        priority,
      );
    }
    return () => {
      current = false;
    };
  }, [cache, portId, slot, visible, priority]);
  return { cache, display };
}

export function useCompanionCover(
  portId: string,
  sha256: string | undefined,
  primary: ArtworkDisplay,
  visible: boolean,
  priority: ArtworkPriority = selectedArtwork,
) {
  const cache = useContext(ArtworkContext);
  const source = primary.state?.resolved_source;
  const primaryCacheId = source?.kind === "igdb_cover" ? source.cache_id : undefined;
  const revision = primary.state?.choice.revision;
  const key =
    primaryCacheId && sha256 && revision !== undefined
      ? cache?.companionKey(portId, primaryCacheId, sha256, revision)
      : undefined;
  const subscribe = useCallback(
    (listener: () => void) =>
      cache && key && visible ? cache.subscribeCompanion(key, listener) : () => {},
    [cache, key, visible],
  );
  const read = useCallback(
    () => (key ? cache?.readCompanion(key) : undefined) ?? unavailable,
    [cache, key],
  );
  const display = useSyncExternalStore(subscribe, read, () => unavailable);
  useEffect(() => {
    let current = true;
    if (visible && key && sha256 && primaryCacheId && revision !== undefined)
      cache?.loadCompanion(key, portId, primaryCacheId, sha256, revision, () => current, priority);
    return () => {
      current = false;
    };
  }, [cache, key, portId, primaryCacheId, revision, sha256, visible, priority]);
  return display;
}

let viewportObserver: IntersectionObserver | undefined;
const viewportListeners = new WeakMap<Element, (visible: boolean) => void>();

function observeArtworkViewport(element: Element, listener: (visible: boolean) => void) {
  if (!(viewportObserver instanceof IntersectionObserver)) {
    viewportObserver = new IntersectionObserver((entries) => {
      for (const entry of entries) viewportListeners.get(entry.target)?.(entry.isIntersecting);
    });
  }
  const observer = viewportObserver;
  viewportListeners.set(element, listener);
  observer.observe(element);
  return () => {
    viewportListeners.delete(element);
    observer.unobserve(element);
  };
}

export function useArtworkVisibility() {
  const cache = useContext(ArtworkContext);
  const element = useRef<HTMLDivElement>(null);
  const inViewport = useRef(typeof IntersectionObserver === "undefined");
  const [visible, setVisible] = useState(() => typeof IntersectionObserver === "undefined");
  const priority = useCallback(() => (inViewport.current ? 1 : 0), []);
  useEffect(() => {
    if (!element.current || typeof IntersectionObserver === "undefined") return;
    const stopViewport = observeArtworkViewport(element.current, (visible) => {
      inViewport.current = visible;
      cache?.reprioritize();
    });
    const nearby = new IntersectionObserver(
      (entries) => setVisible(entries.some((entry) => entry.isIntersecting)),
      { rootMargin: "800px 200px" },
    );
    nearby.observe(element.current);
    return () => {
      stopViewport();
      nearby.disconnect();
      inViewport.current = false;
    };
  }, [cache]);
  return { element, visible, priority };
}

export function useCatalogMedia(
  portId: string,
  media: CatalogMediaAsset | undefined,
  visible: boolean,
  priority: ArtworkPriority = selectedArtwork,
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
    if (media && visible) cache?.loadMedia(portId, media, () => current, false, priority);
    return () => {
      // oxlint-disable-next-line react/immutability -- oxc#28401: effect-local binding.
      current = false;
      interest.current = undefined;
    };
  }, [cache, portId, media, visible, priority]);
  const retry = () => {
    if (media && visible)
      cache?.loadMedia(portId, media, () => interest.current === media, true, priority);
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
    if (visible && display.error && !display.image && !display.retrying) reject();
  }, [visible, display.error, display.image, display.retrying, reject]);
  return { candidate, display, reject, exhausted: !candidate };
}

/** Shared hero selection preserves local Detail choices and independent background media. */
function useHeaderArtwork(
  port: PortIdentity & { id: string },
  visible: boolean,
  context: HeroMediaContext = {},
) {
  const { display: local } = useArtwork(port.id, "detail", visible);
  const allowCatalog = usesAutomaticArtwork(local.state);
  const candidates = heroMediaCandidates(port, context).backgrounds;
  const catalog = useCatalogMediaChain(port.id, candidates, visible && allowCatalog);
  const usingCatalog = Boolean(allowCatalog && catalog.display.image);
  return {
    // The automatic cover is a portrait identity, never a manufactured banner.
    display: usingCatalog
      ? catalog.display
      : local.state?.choice.suppressed || local.state?.resolved_source.kind === "igdb_cover"
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
  showBackground = true,
) {
  const candidates = heroMediaCandidates(port, context);
  const { cache: logoCache, display: logo } = useArtwork(port.id, "logo", visible);
  const hasLogoChoice = Boolean(logo.state?.choice.asset_sha256);
  const onLogoImageError = logo.onImageError;
  const rejectLogo = useCallback(() => onLogoImageError?.(), [onLogoImageError]);
  const foregroundCandidates = usesAutomaticArtwork(logo.state) ? candidates.foreground : [];
  const catalogForeground = useCatalogMediaChain(port.id, foregroundCandidates, visible);
  const foreground = hasLogoChoice
    ? {
        display: logo,
        role: "logo" as const,
        initialRole: "logo" as const,
        candidate: undefined,
        localLogo: true,
        logoGeneration: logoCache?.generation,
        reject: rejectLogo,
      }
    : {
        ...catalogForeground,
        role: catalogForeground.candidate?.role,
        initialRole: foregroundCandidates[0]?.role,
        localLogo: false,
      };
  const { display: cover } = useArtwork(port.id, "cover", visible);
  const background = useHeaderArtwork(port, visible && showBackground, context);
  return {
    foreground,
    cover,
    background,
  };
}
