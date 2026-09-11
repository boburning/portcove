import { desktopApi } from "./api";
import type { ArtworkSlot, ArtworkState, ArtworkThumbnail } from "./types";
import { errorText } from "./view-model";

export interface ArtworkDisplay {
  state?: ArtworkState;
  image?: string;
  error?: string;
  loading: boolean;
}

const empty: ArtworkDisplay = { loading: false };
const maximumEntries = 32;

function thumbnailUrl(thumbnail: ArtworkThumbnail, state: ArtworkState) {
  if (
    thumbnail.asset_sha256 !== state.choice.asset_sha256 ||
    thumbnail.choice_revision !== state.choice.revision ||
    thumbnail.png.length === 0 ||
    thumbnail.png.length > 1024 * 1024
  )
    throw new Error("The artwork preview changed. Refresh to try again.");
  let binary = "";
  for (let offset = 0; offset < thumbnail.png.length; offset += 8192)
    binary += String.fromCharCode(...thumbnail.png.slice(offset, offset + 8192));
  return `data:image/png;base64,${btoa(binary)}`;
}

/** Disposable display cache for one library generation. Core owns every choice. */
export class ArtworkCache {
  private entries = new Map<string, ArtworkDisplay>();
  private listeners = new Map<string, Set<() => void>>();
  private pending = new Map<string, Promise<void>>();
  private tail: Promise<unknown> = Promise.resolve();

  constructor(readonly generation: number) {}

  private key(portId: string, slot: ArtworkSlot) {
    return JSON.stringify([portId, slot]);
  }

  read(portId: string, slot: ArtworkSlot): ArtworkDisplay {
    return this.entries.get(this.key(portId, slot)) ?? empty;
  }

  subscribe(portId: string, slot: ArtworkSlot, listener: () => void) {
    const key = this.key(portId, slot);
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
    for (const key of inactive.slice(0, Math.max(0, inactive.length - maximumEntries)))
      this.entries.delete(key);
  }

  private publish(portId: string, slot: ArtworkSlot, value: ArtworkDisplay) {
    const key = this.key(portId, slot);
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

  private async display(portId: string, slot: ArtworkSlot, state: ArtworkState) {
    const previous = this.read(portId, slot);
    const image =
      state.availability === "available" &&
      previous.state?.choice.asset_sha256 === state.choice.asset_sha256 &&
      previous.state.choice.revision === state.choice.revision
        ? previous.image
        : undefined;
    this.publish(portId, slot, {
      state,
      image,
      loading: state.availability === "available",
    });
    if (state.availability !== "available") return;
    try {
      const thumbnail = await desktopApi.artworkThumbnail(
        portId,
        slot,
        state.choice.revision,
        this.generation,
      );
      this.publish(portId, slot, {
        state,
        image: thumbnailUrl(thumbnail, state),
        loading: false,
      });
    } catch (error) {
      this.publish(portId, slot, {
        state,
        error: errorText(error),
        loading: false,
      });
    }
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
        if (!this.entries.has(key) && stillInterested())
          return this.load(portId, slot, refresh, stillInterested);
      });
    if (!refresh && this.entries.has(key)) return Promise.resolve();
    const result = this.enqueue(async () => {
      if (!stillInterested() && !this.listeners.has(key)) return;
      this.publish(portId, slot, {
        ...this.read(portId, slot),
        loading: true,
        error: undefined,
      });
      try {
        const state = await desktopApi.artwork(portId, slot, this.generation);
        if (stillInterested() || this.listeners.has(key)) await this.display(portId, slot, state);
        else this.entries.delete(key);
      } catch (error) {
        this.publish(portId, slot, { error: errorText(error), loading: false });
      }
    });
    this.pending.set(key, result);
    void result.then(
      () => this.pending.delete(key),
      () => this.pending.delete(key),
    );
    return result;
  }

  change(
    portId: string,
    slot: ArtworkSlot,
    revision: number,
    path: string | null,
    stillCurrent: () => boolean,
  ) {
    return this.enqueue(async () => {
      if (!stillCurrent()) return undefined;
      const state =
        path === null
          ? await desktopApi.resetArtwork(portId, slot, revision, this.generation)
          : await desktopApi.importArtwork(portId, slot, path, revision, this.generation);
      await this.display(portId, slot, state);
      return state;
    });
  }
}
