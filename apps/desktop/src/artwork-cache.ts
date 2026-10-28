import { desktopApi } from "./api";
import type { DesktopArtworkThumbnail } from "./api";
import type { ArtworkSlot, ArtworkState, CatalogMediaAsset } from "./types";
import { errorText } from "./view-model";

export interface ArtworkDisplay {
  state?: ArtworkState;
  media?: CatalogMediaAsset;
  // Display snapshots explicitly clear these fields while retaining the choice.
  image?: string | undefined;
  onImageError?: (() => void) | undefined;
  error?: string | undefined;
  stale?: boolean;
  loading: boolean;
}

const empty: ArtworkDisplay = { loading: false };
const maximumEntries = 32;
const maximumPngBytes = 1024 * 1024;
const maximumRemoteRequests = 2;

interface QueuedThumbnail {
  state: ArtworkState | CatalogMediaAsset;
  stillInterested: () => boolean;
  fetch: () => Promise<void>;
}

function decodedBytes(encoded: string) {
  const padding = encoded.endsWith("==") ? 2 : Number(encoded.endsWith("="));
  return (encoded.length / 4) * 3 - padding;
}

function thumbnailUrl(thumbnail: DesktopArtworkThumbnail, state: ArtworkState) {
  const expectedId =
    state.resolved_source.kind === "local_import"
      ? state.resolved_source.asset_sha256
      : state.resolved_source.kind === "igdb_cover"
        ? state.resolved_source.cache_id
        : undefined;
  return verifiedThumbnailUrl(thumbnail, expectedId, state.choice.revision);
}

function verifiedThumbnailUrl(
  thumbnail: DesktopArtworkThumbnail,
  expectedId: string | undefined,
  revision: number,
) {
  const encoded = thumbnail.png_base64;
  if (
    !expectedId ||
    thumbnail.asset_sha256 !== expectedId ||
    thumbnail.choice_revision !== revision ||
    encoded.length === 0 ||
    encoded.length > 4 * Math.ceil(maximumPngBytes / 3) ||
    encoded.length % 4 !== 0 ||
    !/^[A-Za-z0-9+/]*={0,2}$/.test(encoded) ||
    decodedBytes(encoded) > maximumPngBytes
  )
    throw new Error("The artwork preview changed. Refresh to try again.");
  return `data:image/png;base64,${encoded}`;
}

/** Disposable display cache for one library generation. Core owns every choice. */
export class ArtworkCache {
  private entries = new Map<string, ArtworkDisplay>();
  private listeners = new Map<string, Set<() => void>>();
  private pending = new Map<string, Promise<void>>();
  private tail: Promise<unknown> = Promise.resolve();
  private remoteQueued = new Map<string, QueuedThumbnail>();
  private remoteActive = new Set<string>();

  constructor(
    readonly generation: number,
    readonly catalogArtworkKey = "",
  ) {}

  private key(portId: string, slot: ArtworkSlot) {
    return JSON.stringify([portId, slot]);
  }

  read(portId: string, slot: ArtworkSlot): ArtworkDisplay {
    return this.entries.get(this.key(portId, slot)) ?? empty;
  }

  subscribe(portId: string, slot: ArtworkSlot, listener: () => void) {
    return this.subscribeKey(this.key(portId, slot), listener);
  }

  private subscribeKey(key: string, listener: () => void) {
    const listeners = this.listeners.get(key) ?? new Set<() => void>();
    listeners.add(listener);
    this.listeners.set(key, listeners);
    return () => {
      listeners.delete(listener);
      if (!listeners.size) this.listeners.delete(key);
      this.trim();
    };
  }

  private trim() {
    const inactive = [...this.entries.keys()].filter((key) => !this.listeners.has(key));
    for (const key of inactive.slice(0, Math.max(0, inactive.length - maximumEntries))) {
      this.entries.delete(key);
      this.remoteQueued.delete(key);
    }
  }

  private publish(portId: string, slot: ArtworkSlot, value: ArtworkDisplay) {
    this.publishKey(this.key(portId, slot), value);
  }

  private publishKey(key: string, value: ArtworkDisplay) {
    this.entries.delete(key);
    this.entries.set(key, value);
    this.trim();
    this.listeners.get(key)?.forEach((listener) => listener());
  }

  private enqueue<T>(action: () => Promise<T>): Promise<T> {
    const next = this.tail.then(action);
    this.tail = next.catch(() => undefined);
    return next;
  }

  private drainRemote() {
    for (const [key, request] of this.remoteQueued) {
      if (this.remoteActive.size >= maximumRemoteRequests) break;
      if (this.remoteActive.has(key)) continue;
      this.remoteQueued.delete(key);
      const display = this.entries.get(key);
      if ((display?.state ?? display?.media) !== request.state) continue;
      if (!request.stillInterested() && !this.listeners.has(key)) {
        // Do not retain a loading entry whose request was discarded: a later
        // visit must be able to load it again without an explicit refresh.
        this.entries.delete(key);
        continue;
      }
      this.remoteActive.add(key);
      void request.fetch().finally(() => {
        this.remoteActive.delete(key);
        this.drainRemote();
      });
    }
  }

  private refreshQueuedInterest(key: string, stillInterested: () => boolean) {
    const queued = this.remoteQueued.get(key);
    if (queued) queued.stillInterested = stillInterested;
    this.drainRemote();
  }

  private mediaKey(portId: string, media: CatalogMediaAsset) {
    return JSON.stringify([portId, "catalog-media", media.id, media.sha256]);
  }

  readMedia(portId: string, media: CatalogMediaAsset): ArtworkDisplay {
    return this.entries.get(this.mediaKey(portId, media)) ?? empty;
  }

  subscribeMedia(portId: string, media: CatalogMediaAsset, listener: () => void) {
    return this.subscribeKey(this.mediaKey(portId, media), listener);
  }

  /** Catalog media shares the cover cache's visibility queue and bounded retained entries. */
  loadMedia(
    portId: string,
    media: CatalogMediaAsset,
    stillInterested: () => boolean,
    refresh = false,
  ) {
    const key = this.mediaKey(portId, media);
    if (!refresh && this.entries.has(key)) {
      this.refreshQueuedInterest(key, stillInterested);
      return;
    }
    if (!stillInterested() && !this.listeners.has(key)) return;
    if (this.remoteActive.has(key)) return;
    this.publishKey(key, { media, loading: true });
    this.remoteQueued.set(key, {
      state: media,
      stillInterested,
      fetch: async () => {
        try {
          const thumbnail = await desktopApi.catalogMediaThumbnail(
            portId,
            media.id,
            media.sha256,
            this.generation,
          );
          const image = verifiedThumbnailUrl(thumbnail, media.sha256, 0);
          if (this.entries.get(key)?.media !== media) return;
          this.publishKey(key, {
            media,
            image,
            loading: false,
            onImageError: () => {
              if (this.entries.get(key)?.image !== image) return;
              this.publishKey(key, {
                media,
                loading: false,
                error: "This catalog image cannot be displayed.",
              });
            },
          });
        } catch (error) {
          if (this.entries.get(key)?.media === media)
            this.publishKey(key, { media, loading: false, error: errorText(error) });
        }
      },
    });
    this.drainRemote();
  }

  private async display(
    portId: string,
    slot: ArtworkSlot,
    state: ArtworkState,
    stillInterested: () => boolean,
  ) {
    const key = this.key(portId, slot);
    this.remoteQueued.delete(key);
    const previous = this.read(portId, slot);
    const sourceId =
      state.resolved_source.kind === "local_import"
        ? state.resolved_source.asset_sha256
        : state.resolved_source.kind === "igdb_cover"
          ? state.resolved_source.cache_id
          : undefined;
    const previousId =
      previous.state?.resolved_source.kind === "local_import"
        ? previous.state.resolved_source.asset_sha256
        : previous.state?.resolved_source.kind === "igdb_cover"
          ? previous.state.resolved_source.cache_id
          : undefined;
    const image =
      sourceId &&
      previousId === sourceId &&
      previous.state?.choice.revision === state.choice.revision
        ? previous.image
        : undefined;
    this.publish(portId, slot, {
      state,
      image,
      onImageError: image ? previous.onImageError : undefined,
      loading: Boolean(sourceId),
    });
    if (!sourceId) return;
    const fetchThumbnail = async () => {
      try {
        const thumbnail = await desktopApi.artworkThumbnail(
          portId,
          slot,
          state.choice.revision,
          this.generation,
        );
        const image = thumbnailUrl(thumbnail, state);
        if (this.read(portId, slot).state !== state) return;
        const current = this.read(portId, slot);
        this.publish(portId, slot, {
          ...current,
          state,
          image,
          error: current.stale ? current.error : undefined,
          onImageError: () => {
            const current = this.read(portId, slot);
            if (current.state !== state || current.image !== image) return;
            this.publish(portId, slot, {
              ...current,
              image: undefined,
              onImageError: undefined,
              error:
                state.resolved_source.kind === "igdb_cover"
                  ? "The catalog cover cannot be displayed right now."
                  : "The selected image cannot be displayed. Your choice is retained.",
              loading: false,
            });
          },
          loading: false,
        });
      } catch (error) {
        if (this.read(portId, slot).state !== state) return;
        const current = this.read(portId, slot);
        this.publish(portId, slot, {
          ...current,
          state,
          image: undefined,
          onImageError: undefined,
          error: current.stale ? current.error : errorText(error),
          loading: false,
        });
      }
    };
    if (state.resolved_source.kind === "igdb_cover") {
      // Keep remote work separate from the local-choice tail. Only current
      // viewport requests reach IPC; newer state replaces an undispatched one.
      this.remoteQueued.set(key, { state, stillInterested, fetch: fetchThumbnail });
      this.drainRemote();
      return;
    }
    await fetchThumbnail();
  }

  load(
    portId: string,
    slot: ArtworkSlot,
    refresh = false,
    stillInterested: () => boolean = () => true,
  ): Promise<void> {
    const key = this.key(portId, slot);
    const pending = this.pending.get(key);
    if (pending)
      return pending.then(() => {
        this.refreshQueuedInterest(key, stillInterested);
        if (!this.entries.has(key) && (stillInterested() || this.listeners.has(key)))
          return this.load(portId, slot, refresh, stillInterested);
      });
    if (!refresh && this.entries.has(key)) {
      this.refreshQueuedInterest(key, stillInterested);
      return Promise.resolve();
    }
    const result = this.enqueue(async () => {
      if (!stillInterested() && !this.listeners.has(key)) return;
      this.publish(portId, slot, {
        ...this.read(portId, slot),
        loading: true,
        error: undefined,
      });
      try {
        const state = await desktopApi.artwork(portId, slot, this.generation);
        if (stillInterested() || this.listeners.has(key))
          await this.display(portId, slot, state, stillInterested);
        else {
          this.entries.delete(key);
          this.remoteQueued.delete(key);
        }
      } catch (error) {
        const previous = this.read(portId, slot);
        this.publish(portId, slot, {
          ...previous,
          error: errorText(error),
          stale: Boolean(previous.state),
          loading: false,
        });
      }
    });
    this.pending.set(key, result);
    void result.then(
      () => this.pending.delete(key),
      () => this.pending.delete(key),
    );
    return result;
  }

  async refreshAfterChange(
    portId: string,
    slot: ArtworkSlot,
    stillInterested: () => boolean = () => true,
    committedRevision?: number,
  ): Promise<void> {
    // A replacement cache may already be reading the choice from before the commit.
    await this.pending.get(this.key(portId, slot));
    if (!stillInterested()) return;
    if (
      committedRevision !== undefined &&
      (this.read(portId, slot).state?.choice.revision ?? -1) < committedRevision
    )
      this.publish(portId, slot, { loading: true });
    await this.load(portId, slot, true, stillInterested);
  }

  change(
    portId: string,
    slot: ArtworkSlot,
    revision: number,
    path: string | null,
    stillCurrent: () => boolean,
  ) {
    return this.enqueue(async () => {
      if (!stillCurrent() || this.read(portId, slot).stale) return undefined;
      const state =
        path === null
          ? await desktopApi.resetArtwork(portId, slot, revision, this.generation)
          : await desktopApi.importArtwork(portId, slot, path, revision, this.generation);
      await this.display(portId, slot, state, stillCurrent);
      return state;
    });
  }
}
