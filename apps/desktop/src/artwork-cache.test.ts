import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { desktopApi } from "./api";
import type { DesktopArtworkThumbnail } from "./api";
import {
  ArtworkCache,
  maximumConcurrentArtworkReads,
  maximumInactiveArtworkEntries,
  maximumInactiveArtworkImageLength,
} from "./artwork-cache";
import { artworkState } from "./test-fixtures";
import type { ArtworkState, CatalogMediaAsset } from "./types";

afterEach(() => vi.restoreAllMocks());

function catalogImage(id = "scene", sha256 = "a".repeat(64)): CatalogMediaAsset {
  return {
    id,
    role: "screenshot",
    subject: { kind: "port", port_id: "sample" },
    caption: "Synthetic owned image",
    url: `https://raw.githubusercontent.com/owner/project/${"b".repeat(40)}/scene.png`,
    sha256,
    width: 1,
    height: 1,
    attribution: "Portcove test fixture",
    source_url: "https://github.com/owner/project",
    license: "CC0-1.0",
    rights_url: "https://github.com/owner/project/blob/main/LICENSE",
  };
}

function mappedArtwork(port: string, revision = 0): ArtworkState {
  return {
    ...artworkState(port, "cover", revision),
    resolved_source: {
      kind: "igdb_cover",
      cache_id: "b".repeat(64),
      artwork: {
        game_id: 1,
        cover_id: 2,
        image_id: "fixture",
        image_sha256: "c".repeat(64),
        game_slug: "fixture",
        match_kind: "port",
      },
    },
  };
}

function mappedThumbnail(revision = 0): DesktopArtworkThumbnail {
  return { asset_sha256: "b".repeat(64), choice_revision: revision, png_base64: "iVBORw==" };
}

describe("disposable artwork display cache", () => {
  it("binds catalog previews to admitted image identity and shares the two-request visibility queue", async () => {
    const pending: ((thumbnail: DesktopArtworkThumbnail) => void)[] = [];
    const read = vi.spyOn(desktopApi, "catalogMediaThumbnail").mockImplementation(
      () =>
        new Promise((resolve) => {
          pending.push(resolve);
        }),
    );
    const cache = new ArtworkCache(7);
    const first = catalogImage("first"),
      second = catalogImage("second"),
      third = catalogImage("third");
    let thirdVisible = true;
    cache.loadMedia("sample", first, () => true);
    cache.loadMedia("sample", second, () => true);
    cache.loadMedia("sample", third, () => thirdVisible);
    expect(read).toHaveBeenCalledTimes(2);
    expect(read).toHaveBeenCalledWith("sample", first.id, first.sha256, 7);
    thirdVisible = false;
    pending[0]!({ asset_sha256: first.sha256, choice_revision: 0, png_base64: "iVBORw==" });
    pending[1]!({ asset_sha256: "foreign", choice_revision: 0, png_base64: "iVBORw==" });
    await vi.waitFor(() => expect(cache.readMedia("sample", first).image).toBeDefined());
    await vi.waitFor(() =>
      expect(cache.readMedia("sample", second).error).toContain("preview changed"),
    );
    expect(read).toHaveBeenCalledTimes(2);
    expect(cache.readMedia("sample", third).media).toBeUndefined();
    expect(cache.read("sample", "cover").state).toBeUndefined();
  });

  it("retains only the existing bounded cache window for unseen catalog media", async () => {
    vi.spyOn(desktopApi, "catalogMediaThumbnail").mockImplementation(
      async (_port, _id, sha256) => ({
        asset_sha256: sha256,
        choice_revision: 0,
        png_base64: "iVBORw==",
      }),
    );
    const cache = new ArtworkCache(1);
    const visible = catalogImage("visible");
    const leave = cache.subscribeMedia("sample", visible, () => {});
    cache.loadMedia("sample", visible, () => true);
    await vi.waitFor(() => expect(cache.readMedia("sample", visible).loading).toBe(false));
    for (let index = 0; index < maximumInactiveArtworkEntries + 8; index++) {
      const image = catalogImage(`image-${index}`);
      cache.loadMedia("sample", image, () => true);
      await new Promise((resolve) => setTimeout(resolve));
      expect(cache.readMedia("sample", image).loading).toBe(false);
    }
    expect(cache.readMedia("sample", catalogImage("image-0")).media).toBeUndefined();
    expect(cache.readMedia("sample", catalogImage("image-8")).image).toBeDefined();
    expect(cache.readMedia("sample", visible).image).toBeDefined();
    leave();
    expect(cache.readMedia("sample", visible).media).toBeUndefined();
  });
  it("re-reads shown slots whose image a listing check removed and drops hidden ones", async () => {
    const selected = artworkState("sample", "cover", 1, true);
    const removed: ArtworkState = {
      ...selected,
      availability: "unavailable",
      reason: "SteamGridDB no longer lists this image, so Portcove removed its copy.",
      resolved_source: { kind: "generated_fallback" },
      evicted_at: 5,
    };
    const read = vi.spyOn(desktopApi, "artwork").mockResolvedValue(selected);
    vi.spyOn(desktopApi, "artworkThumbnail").mockResolvedValue({
      asset_sha256: "a".repeat(64),
      choice_revision: 1,
      png_base64: "iVBORw==",
    });
    const cache = new ArtworkCache(7);
    const unsubscribe = cache.subscribe("sample", "cover", () => undefined);
    await cache.load("sample", "cover");
    await cache.load("hidden", "cover");
    read.mockResolvedValueOnce(artworkState("other", "detail"));
    await cache.load("other", "detail");
    expect(cache.read("sample", "cover").image).toBeDefined();
    read.mockClear();
    read.mockResolvedValue(removed);
    cache.refreshAfterListingCheck(new Set(["a".repeat(64)]));
    await vi.waitFor(() => expect(cache.read("sample", "cover").state).toBe(removed));
    // The shown slot keeps its key and shows the fallback with the reason.
    expect(cache.read("sample", "cover").image).toBeUndefined();
    expect(read).toHaveBeenCalledTimes(1);
    // A hidden slot with the same image is dropped; an unrelated one stays.
    expect(cache.read("hidden", "cover").state).toBeUndefined();
    expect(cache.read("other", "detail").state).toBeDefined();
    unsubscribe();
  });

  it("retains a slot's usable display after metadata refresh fails, then accepts current replacement", async () => {
    const selected = artworkState("sample", "cover", 1, true);
    const read = vi.spyOn(desktopApi, "artwork").mockResolvedValue(selected);
    vi.spyOn(desktopApi, "artworkThumbnail").mockResolvedValue({
      asset_sha256: "a".repeat(64),
      choice_revision: 1,
      png_base64: "iVBORw==",
    });
    const cache = new ArtworkCache(7);
    await cache.load("sample", "cover");
    const previous = cache.read("sample", "cover");
    read.mockRejectedValueOnce(new Error("Artwork read unavailable."));
    await cache.load("sample", "cover", true);
    expect(cache.read("sample", "cover")).toMatchObject({
      state: selected,
      image: previous.image,
      stale: true,
      loading: false,
      error: "Artwork read unavailable.",
    });
    const mutation = vi.spyOn(desktopApi, "resetArtwork");
    expect(await cache.change("sample", "cover", 1, null, () => true)).toBeUndefined();
    expect(mutation).not.toHaveBeenCalled();
    const replacement = artworkState("sample", "cover", 2);
    read.mockResolvedValueOnce(replacement);
    await cache.load("sample", "cover", true);
    expect(cache.read("sample", "cover")).toMatchObject({ state: replacement, loading: false });
    expect(cache.read("sample", "cover").image).toBeUndefined();
    expect(cache.read("sample", "cover").stale).toBeUndefined();
    expect(cache.read("sample", "cover").error).toBeUndefined();
  });

  it("holds a queued mutation after a failing read and keeps the other slot independent", async () => {
    const read = vi
      .spyOn(desktopApi, "artwork")
      .mockImplementation(async (port, slot) => artworkState(port, slot));
    const change = vi
      .spyOn(desktopApi, "importArtwork")
      .mockResolvedValue(artworkState("sample", "detail", 1, true));
    vi.spyOn(desktopApi, "artworkThumbnail").mockResolvedValue({
      asset_sha256: "a".repeat(64),
      choice_revision: 1,
      png_base64: "iVBORw==",
    });
    const cache = new ArtworkCache(7);
    await cache.load("sample", "cover");
    await cache.load("sample", "detail");
    let reject!: (error: Error) => void;
    read.mockReturnValueOnce(
      new Promise((_resolve, fail) => {
        reject = fail;
      }),
    );
    const refresh = cache.load("sample", "cover", true);
    await vi.waitFor(() => expect(read).toHaveBeenCalledTimes(3));
    const queued = cache.change("sample", "cover", 0, "owned.png", () => true);
    reject(new Error("Read failed."));
    await refresh;
    expect(await queued).toBeUndefined();
    expect(change).not.toHaveBeenCalled();
    expect(await cache.change("sample", "detail", 0, "owned.png", () => true)).toBeDefined();
    expect(change).toHaveBeenCalledExactlyOnceWith("sample", "detail", "owned.png", 0, 7);
    expect(cache.read("sample", "cover").stale).toBe(true);
  });

  it("does not invent prior state on cold failure or restore a renderer-rejected image", async () => {
    const read = vi.spyOn(desktopApi, "artwork").mockRejectedValueOnce(new Error("Unavailable."));
    vi.spyOn(desktopApi, "artworkThumbnail").mockResolvedValue({
      asset_sha256: "a".repeat(64),
      choice_revision: 1,
      png_base64: "iVBORw==",
    });
    const cache = new ArtworkCache(7);
    await cache.load("sample", "cover");
    expect(cache.read("sample", "cover").state).toBeUndefined();
    expect(cache.read("sample", "cover").image).toBeUndefined();
    read.mockResolvedValueOnce(artworkState("sample", "cover", 1, true));
    await cache.load("sample", "cover", true);
    cache.read("sample", "cover").onImageError?.();
    read.mockRejectedValueOnce(new Error("Unavailable."));
    await cache.load("sample", "cover", true);
    expect(cache.read("sample", "cover").image).toBeUndefined();
    expect(cache.read("sample", "cover").stale).toBe(true);
  });

  it("does not let a pending thumbnail erase metadata uncertainty", async () => {
    const local = artworkState("sample", "cover", 1, true);
    const state: ArtworkState = {
      ...local,
      selection: null,
      resolved_source: {
        kind: "igdb_cover",
        cache_id: "b".repeat(64),
        artwork: {
          game_id: 1,
          cover_id: 2,
          image_id: "image",
          image_sha256: "a".repeat(64),
          game_slug: "game",
          match_kind: "port",
        },
      },
    };
    const read = vi
      .spyOn(desktopApi, "artwork")
      .mockResolvedValueOnce(state)
      .mockRejectedValueOnce(new Error("Read failed."));
    let finish!: (value: {
      asset_sha256: string;
      choice_revision: number;
      png_base64: string;
    }) => void;
    vi.spyOn(desktopApi, "artworkThumbnail").mockReturnValue(
      new Promise((resolve) => {
        finish = resolve;
      }),
    );
    const cache = new ArtworkCache(7);
    await cache.load("sample", "cover");
    await cache.load("sample", "cover", true);
    finish({ asset_sha256: "b".repeat(64), choice_revision: 1, png_base64: "iVBORw==" });
    await vi.waitFor(() => expect(cache.read("sample", "cover").image).toBeDefined());
    expect(cache.read("sample", "cover")).toMatchObject({
      stale: true,
      error: "Read failed.",
      loading: false,
    });
    expect(read).toHaveBeenCalledTimes(2);
  });

  it("discards a choice known obsolete after commit when its readback fails", async () => {
    const read = vi
      .spyOn(desktopApi, "artwork")
      .mockResolvedValueOnce(artworkState("sample", "cover", 1, true))
      .mockRejectedValueOnce(new Error("Readback unavailable."));
    vi.spyOn(desktopApi, "artworkThumbnail").mockResolvedValue({
      asset_sha256: "a".repeat(64),
      choice_revision: 1,
      png_base64: "iVBORw==",
    });
    const cache = new ArtworkCache(7);
    await cache.load("sample", "cover");
    await cache.refreshAfterChange("sample", "cover", () => true, 2);
    expect(cache.read("sample", "cover").state).toBeUndefined();
    expect(cache.read("sample", "cover").image).toBeUndefined();
    expect(cache.read("sample", "cover").error).toBe("Readback unavailable.");
    expect(read).toHaveBeenCalledTimes(2);
  });

  it("preserves a newer authoritative choice when delayed commit readback fails", async () => {
    const newer = artworkState("sample", "cover", 3, true);
    const read = vi
      .spyOn(desktopApi, "artwork")
      .mockResolvedValueOnce(newer)
      .mockRejectedValueOnce(new Error("Readback unavailable."));
    vi.spyOn(desktopApi, "artworkThumbnail").mockResolvedValue({
      asset_sha256: "a".repeat(64),
      choice_revision: 3,
      png_base64: "iVBORw==",
    });
    const cache = new ArtworkCache(7);
    await cache.load("sample", "cover");
    const image = cache.read("sample", "cover").image;
    await cache.refreshAfterChange("sample", "cover", () => true, 2);
    expect(cache.read("sample", "cover")).toMatchObject({
      state: newer,
      image,
      stale: true,
      loading: false,
      error: "Readback unavailable.",
    });
    expect(image).toBeDefined();
    expect(read).toHaveBeenCalledTimes(2);
  });

  it("reads post-change state after an earlier pending read completes", async () => {
    let finish!: (value: ArtworkState) => void;
    const selected = artworkState("sample", "cover", 1, true);
    const read = vi
      .spyOn(desktopApi, "artwork")
      .mockReturnValueOnce(new Promise((resolve) => (finish = resolve)))
      .mockResolvedValue(selected);
    vi.spyOn(desktopApi, "artworkThumbnail").mockResolvedValue({
      asset_sha256: "a".repeat(64),
      choice_revision: 1,
      png_base64: "iVBORw==",
    });
    const cache = new ArtworkCache(7);
    const initial = cache.load("sample", "cover");
    await vi.waitFor(() => expect(read).toHaveBeenCalledTimes(1));
    const reconciliation = cache.refreshAfterChange("sample", "cover");
    finish(artworkState("sample", "cover"));
    await Promise.all([initial, reconciliation]);
    expect(read).toHaveBeenCalledTimes(2);
    expect(cache.read("sample", "cover").state).toBe(selected);
    expect(cache.read("sample", "cover").image).toMatch(/^data:image\/png;base64,/);
  });

  it("does not reconcile a cache that loses its current view while an earlier read is pending", async () => {
    let finish!: (value: ArtworkState) => void;
    let interested = true;
    const read = vi
      .spyOn(desktopApi, "artwork")
      .mockReturnValueOnce(new Promise((resolve) => (finish = resolve)));
    const cache = new ArtworkCache(7);
    const initial = cache.load("sample", "cover");
    await vi.waitFor(() => expect(read).toHaveBeenCalledTimes(1));
    const reconciliation = cache.refreshAfterChange("sample", "cover", () => interested);
    interested = false;
    finish(artworkState("sample", "cover"));
    await Promise.all([initial, reconciliation]);
    expect(read).toHaveBeenCalledTimes(1);
  });

  it("binds mapped cover thumbnails to the current catalog image identity", async () => {
    const mapped = {
      ...artworkState("sample", "cover"),
      resolved_source: {
        kind: "igdb_cover" as const,
        cache_id: "b".repeat(64),
        artwork: {
          game_id: 194694,
          cover_id: 287780,
          image_id: "co661w",
          image_sha256: "4".repeat(64),
          game_slug: "ship-of-harkinian",
          match_kind: "port" as const,
        },
      },
    };
    vi.spyOn(desktopApi, "artwork").mockResolvedValue(mapped);
    const thumbnail = vi.spyOn(desktopApi, "artworkThumbnail").mockResolvedValue({
      asset_sha256: "b".repeat(64),
      choice_revision: 0,
      png_base64: "iVBORw==",
    });
    const cache = new ArtworkCache(7);
    await cache.load("sample", "cover");
    await vi.waitFor(() =>
      expect(cache.read("sample", "cover").image).toMatch(/^data:image\/png;base64,/),
    );
    thumbnail.mockResolvedValueOnce({
      asset_sha256: "c".repeat(64),
      choice_revision: 0,
      png_base64: "iVBORw==",
    });
    await cache.load("sample", "cover", true);
    await vi.waitFor(() => {
      expect(cache.read("sample", "cover").image).toBeUndefined();
      expect(cache.read("sample", "cover").error).toContain("preview changed");
    });
  });

  it("lets other cards and local changes proceed while a mapped cover waits on the CDN", async () => {
    const mapped: ArtworkState = {
      ...artworkState("sample", "cover"),
      resolved_source: {
        kind: "igdb_cover",
        cache_id: "b".repeat(64),
        artwork: {
          game_id: 194694,
          cover_id: 287780,
          image_id: "co661w",
          image_sha256: "4".repeat(64),
          game_slug: "ship-of-harkinian",
          match_kind: "port",
        },
      },
    };
    vi.spyOn(desktopApi, "artwork").mockImplementation(async (port, slot) =>
      port === "sample" ? mapped : artworkState(port, slot),
    );
    let finishCover!: (value: {
      asset_sha256: string;
      choice_revision: number;
      png_base64: string;
    }) => void;
    vi.spyOn(desktopApi, "artworkThumbnail")
      .mockReturnValueOnce(new Promise((resolve) => (finishCover = resolve)))
      .mockResolvedValue({
        asset_sha256: "a".repeat(64),
        choice_revision: 1,
        png_base64: "iVBORw==",
      });
    const local = artworkState("sample", "cover", 1, true);
    vi.spyOn(desktopApi, "importArtwork").mockResolvedValue(local);
    const cache = new ArtworkCache(7);
    await cache.load("sample", "cover");
    await cache.load("other", "detail");
    expect(cache.read("other", "detail").state?.choice.port_id).toBe("other");
    await cache.change("sample", "cover", 0, "owned.png", () => true);
    expect(cache.read("sample", "cover").state?.resolved_source.kind).toBe("local_import");
    finishCover({
      asset_sha256: "b".repeat(64),
      choice_revision: 0,
      png_base64: "iVBORw==",
    });
    await Promise.resolve();
    expect(cache.read("sample", "cover").state?.resolved_source.kind).toBe("local_import");
    expect(cache.read("sample", "cover").image).toMatch(/^data:image\/png;base64,/);
  });

  it("drops offscreen queued covers before IPC while current covers and local choices proceed", async () => {
    vi.spyOn(desktopApi, "artwork").mockImplementation(async (port) => mappedArtwork(port));
    const finish = new Map<string, (thumbnail: DesktopArtworkThumbnail) => void>();
    const thumbnails = vi
      .spyOn(desktopApi, "artworkThumbnail")
      .mockImplementation((port, _slot, revision) => {
        if (port === "local")
          return Promise.resolve({
            asset_sha256: "a".repeat(64),
            choice_revision: revision,
            png_base64: "iVBORw==",
          });
        return new Promise((resolve) => finish.set(port, resolve));
      });
    const imported = artworkState("local", "cover", 1, true);
    const importArtwork = vi.spyOn(desktopApi, "importArtwork").mockResolvedValue(imported);
    const resetArtwork = vi
      .spyOn(desktopApi, "resetArtwork")
      .mockResolvedValue(artworkState("local", "cover", 2));
    const cache = new ArtworkCache(7);
    let oldInterested = true;
    await Promise.all(
      Array.from({ length: 20 }, (_, index) =>
        cache.load(`old-${index}`, "cover", false, () => oldInterested),
      ),
    );
    expect(thumbnails.mock.calls.map(([port]) => port)).toEqual(["old-0", "old-1"]);
    oldInterested = false;
    await cache.load("current", "cover");

    expect(await cache.change("local", "cover", 0, "owned.png", () => true)).toBe(imported);
    await cache.change("local", "cover", 1, null, () => true);
    expect(importArtwork).toHaveBeenCalledExactlyOnceWith("local", "cover", "owned.png", 0, 7);
    expect(resetArtwork).toHaveBeenCalledExactlyOnceWith("local", "cover", 1, 7);

    finish.get("old-0")?.(mappedThumbnail());
    await vi.waitFor(() => expect(finish.has("current")).toBe(true));
    expect(thumbnails.mock.calls.map(([port]) => port)).toEqual([
      "old-0",
      "old-1",
      "local",
      "current",
    ]);
    expect(cache.read("old-2", "cover").state).toBeUndefined();
    finish.get("old-1")?.(mappedThumbnail());
    finish.get("current")?.(mappedThumbnail());
    await vi.waitFor(() => expect(cache.read("current", "cover").loading).toBe(false));
    await cache.load("old-2", "cover");
    await vi.waitFor(() => expect(finish.has("old-2")).toBe(true));
    finish.get("old-2")?.(mappedThumbnail());
    await vi.waitFor(() => expect(cache.read("old-2", "cover").loading).toBe(false));
  });

  it("bounds remote queue retention with the same inactive preview limit", async () => {
    vi.spyOn(desktopApi, "artwork").mockImplementation(async (port) => mappedArtwork(port));
    const finish = new Map<string, (thumbnail: DesktopArtworkThumbnail) => void>();
    let completeRemaining = false;
    const thumbnails = vi
      .spyOn(desktopApi, "artworkThumbnail")
      .mockImplementation((port) =>
        completeRemaining
          ? Promise.resolve(mappedThumbnail())
          : new Promise((resolve) => finish.set(port, resolve)),
      );
    const cache = new ArtworkCache(7);
    const count = maximumInactiveArtworkEntries + 48;
    const firstRetained = `port-${count - maximumInactiveArtworkEntries}`;
    await Promise.all(
      Array.from({ length: count }, (_, index) => cache.load(`port-${index}`, "cover")),
    );
    expect(thumbnails).toHaveBeenCalledTimes(2);
    expect(
      cache.read(`port-${count - maximumInactiveArtworkEntries - 1}`, "cover").state,
    ).toBeUndefined();
    expect(cache.read(firstRetained, "cover").state).toBeDefined();
    finish.get("port-0")?.(mappedThumbnail());
    await vi.waitFor(() => expect(finish.has(firstRetained)).toBe(true));
    expect(thumbnails.mock.calls.map(([port]) => port)).toEqual([
      "port-0",
      "port-1",
      firstRetained,
    ]);
    completeRemaining = true;
    finish.get("port-1")?.(mappedThumbnail());
    finish.get(firstRetained)?.(mappedThumbnail());
    await vi.waitFor(() => expect(cache.read(`port-${count - 1}`, "cover").loading).toBe(false));
    expect(thumbnails).toHaveBeenCalledTimes(maximumInactiveArtworkEntries + 2);
  });

  it("updates a queued cover's interest when a new view revisits the cached entry", async () => {
    const reads = vi
      .spyOn(desktopApi, "artwork")
      .mockImplementation(async (port) => mappedArtwork(port));
    const finish = new Map<string, (thumbnail: DesktopArtworkThumbnail) => void>();
    const thumbnails = vi
      .spyOn(desktopApi, "artworkThumbnail")
      .mockImplementation((port) => new Promise((resolve) => finish.set(port, resolve)));
    const cache = new ArtworkCache(7);
    await Promise.all([cache.load("first", "cover"), cache.load("second", "cover")]);
    let oldInterested = true;
    await cache.load("revisited", "cover", false, () => oldInterested);
    oldInterested = false;
    await cache.load("revisited", "cover");
    finish.get("first")?.(mappedThumbnail());
    await vi.waitFor(() => expect(finish.has("revisited")).toBe(true));
    expect(reads).toHaveBeenCalledTimes(3);
    expect(thumbnails.mock.calls.map(([port]) => port)).toEqual(["first", "second", "revisited"]);
    finish.get("second")?.(mappedThumbnail());
    finish.get("revisited")?.(mappedThumbnail());
    await vi.waitFor(() => expect(cache.read("revisited", "cover").loading).toBe(false));
  });

  it("replaces an undispatched cover with its refreshed revision and discards a queued local override", async () => {
    let revision = 0;
    vi.spyOn(desktopApi, "artwork").mockImplementation(async (port) =>
      mappedArtwork(port, revision),
    );
    const finish = new Map<string, (thumbnail: DesktopArtworkThumbnail) => void>();
    const thumbnails = vi
      .spyOn(desktopApi, "artworkThumbnail")
      .mockImplementation((port, _slot, selectedRevision) => {
        if (port === "overridden")
          return Promise.resolve({
            asset_sha256: "a".repeat(64),
            choice_revision: selectedRevision,
            png_base64: "iVBORw==",
          });
        return new Promise((resolve) => finish.set(port, resolve));
      });
    vi.spyOn(desktopApi, "importArtwork").mockResolvedValue(
      artworkState("overridden", "cover", 1, true),
    );
    const cache = new ArtworkCache(7);
    await Promise.all([cache.load("first", "cover"), cache.load("second", "cover")]);
    await cache.load("refreshed", "cover");
    await cache.load("overridden", "cover");
    revision = 2;
    await cache.load("refreshed", "cover", true);
    await cache.change("overridden", "cover", 0, "owned.png", () => true);
    finish.get("first")?.(mappedThumbnail());
    await vi.waitFor(() => expect(finish.has("refreshed")).toBe(true));
    expect(thumbnails).toHaveBeenCalledWith("refreshed", "cover", 2, 7);
    expect(thumbnails.mock.calls.filter(([port]) => port === "refreshed")).toHaveLength(1);
    expect(thumbnails.mock.calls.filter(([port]) => port === "overridden")).toHaveLength(1);
    finish.get("second")?.(mappedThumbnail());
    finish.get("refreshed")?.(mappedThumbnail(2));
    await vi.waitFor(() => expect(cache.read("refreshed", "cover").loading).toBe(false));
    expect(cache.read("overridden", "cover").state?.resolved_source.kind).toBe("local_import");
  });

  it("updates subscribed views for their slot and stops notifying a closed view", async () => {
    vi.spyOn(desktopApi, "artwork").mockImplementation(async (port, slot) =>
      artworkState(port, slot),
    );
    const cache = new ArtworkCache(7);
    const card = vi.fn(),
      editor = vi.fn(),
      detail = vi.fn();
    const closeCard = cache.subscribe("sample", "cover", card);
    const closeEditor = cache.subscribe("sample", "cover", editor);
    const closeDetail = cache.subscribe("sample", "detail", detail);
    await cache.load("sample", "cover");
    expect(card).toHaveBeenCalled();
    expect(editor).toHaveBeenCalled();
    expect(detail).not.toHaveBeenCalled();
    closeCard();
    card.mockClear();
    editor.mockClear();
    await cache.load("sample", "cover", true);
    expect(card).not.toHaveBeenCalled();
    expect(editor).toHaveBeenCalled();
    closeEditor();
    closeDetail();
  });

  it("deduplicates requests and serializes slots without making a second choice authority", async () => {
    let active = 0,
      maximum = 0;
    const read = vi.spyOn(desktopApi, "artwork").mockImplementation(async (port, slot) => {
      maximum = Math.max(maximum, ++active);
      await Promise.resolve();
      active--;
      return artworkState(port, slot);
    });
    const cache = new ArtworkCache(7);
    await Promise.all([
      cache.load("sample", "cover"),
      cache.load("sample", "cover"),
      cache.load("sample", "detail"),
    ]);
    expect(read).toHaveBeenCalledTimes(2);
    expect(maximum).toBe(1);
    expect(cache.read("sample", "detail").state?.choice.slot).toBe("detail");
    await cache.load("sample", "cover");
    expect(read).toHaveBeenCalledTimes(2);
  });

  it("shows cached bytes immediately and rejects a mismatched refreshed thumbnail", async () => {
    vi.spyOn(desktopApi, "artwork").mockResolvedValue(artworkState("sample", "cover", 1, true));
    const thumbnail = vi.spyOn(desktopApi, "artworkThumbnail").mockResolvedValue({
      asset_sha256: "a".repeat(64),
      choice_revision: 1,
      png_base64: "iVBORw==",
    });
    const cache = new ArtworkCache(7);
    await cache.load("sample", "cover");
    const image = cache.read("sample", "cover").image;
    expect(image).toMatch(/^data:image\/png;base64,/);
    thumbnail.mockResolvedValue({
      asset_sha256: "b".repeat(64),
      choice_revision: 1,
      png_base64: "iQ==",
    });
    const refresh = cache.load("sample", "cover", true);
    expect(cache.read("sample", "cover").image).toBe(image);
    await refresh;
    expect(cache.read("sample", "cover").image).toBeUndefined();
    expect(cache.read("sample", "cover").state?.choice.revision).toBe(1);
    expect(cache.read("sample", "cover").error).toContain("preview changed");
  });

  it("keeps cached image rejection live while a matching refresh thumbnail is pending", async () => {
    vi.spyOn(desktopApi, "artwork").mockResolvedValue(artworkState("sample", "cover", 1, true));
    let finishRefresh!: (value: {
      asset_sha256: string;
      choice_revision: number;
      png_base64: string;
    }) => void;
    const thumbnail = vi
      .spyOn(desktopApi, "artworkThumbnail")
      .mockResolvedValueOnce({
        asset_sha256: "a".repeat(64),
        choice_revision: 1,
        png_base64: "iVBORw==",
      })
      .mockReturnValueOnce(
        new Promise((resolve) => {
          finishRefresh = resolve;
        }),
      );
    const cache = new ArtworkCache(7);
    await cache.load("sample", "cover");
    const image = cache.read("sample", "cover").image;

    const refresh = cache.load("sample", "cover", true);
    await vi.waitFor(() => expect(thumbnail).toHaveBeenCalledTimes(2));
    expect(cache.read("sample", "cover").image).toBe(image);
    cache.read("sample", "cover").onImageError?.();
    expect(cache.read("sample", "cover").image).toBeUndefined();
    expect(cache.read("sample", "cover").error).toContain("choice is retained");

    finishRefresh({
      asset_sha256: "a".repeat(64),
      choice_revision: 1,
      png_base64: "iVBORw==",
    });
    await refresh;
    expect(cache.read("sample", "cover").image).toMatch(/^data:image\/png;base64,/);
  });

  it("keeps a successful selection when thumbnail loading fails and refreshes missing originals", async () => {
    const selected = artworkState("sample", "cover", 1, true);
    vi.spyOn(desktopApi, "importArtwork").mockResolvedValue(selected);
    const thumbnails = vi
      .spyOn(desktopApi, "artworkThumbnail")
      .mockRejectedValue(new Error("cache unavailable"));
    const cache = new ArtworkCache(7);
    expect(await cache.change("sample", "cover", 0, "owned.png", () => true)).toEqual(selected);
    expect(cache.read("sample", "cover").state?.selection).toEqual(selected.selection);
    vi.spyOn(desktopApi, "artwork").mockResolvedValue({
      ...selected,
      availability: "unavailable",
      reason: "Selected image missing; choice retained.",
      resolved_source: { kind: "generated_fallback" },
    });
    await cache.load("sample", "cover", true);
    expect(cache.read("sample", "cover").state?.reason).toContain("choice retained");
    expect(cache.read("sample", "cover").state?.generated_fallback.initials).toBe("SF");
    expect(cache.read("sample", "cover").image).toBeUndefined();
    expect(thumbnails).toHaveBeenCalledTimes(1);
  });

  it("checks picker ownership again when a queued mutation reaches core", async () => {
    let finish!: (value: ArtworkState) => void;
    vi.spyOn(desktopApi, "artwork").mockReturnValue(
      new Promise((resolve) => {
        finish = resolve;
      }),
    );
    const change = vi.spyOn(desktopApi, "importArtwork");
    const cache = new ArtworkCache(7);
    const load = cache.load("sample", "detail");
    let current = true;
    const mutation = cache.change("sample", "cover", 0, "old-picker.png", () => current);
    current = false;
    finish(artworkState("sample", "detail"));
    await load;
    expect(await mutation).toBeUndefined();
    expect(change).not.toHaveBeenCalled();
  });

  it("binds reset to the selected slot revision and library generation", async () => {
    const reset = vi
      .spyOn(desktopApi, "resetArtwork")
      .mockResolvedValue(artworkState("sample", "detail", 4));
    const cache = new ArtworkCache(9);
    await cache.change("sample", "detail", 3, null, () => true);
    expect(reset).toHaveBeenCalledWith("sample", "detail", 3, 9);
    expect(cache.read("sample", "detail").state?.choice.revision).toBe(4);
    expect(cache.read("sample", "detail").image).toBeUndefined();
  });

  it("bounds inactive previews and discards queued reads after rapid browsing", async () => {
    const read = vi
      .spyOn(desktopApi, "artwork")
      .mockImplementation(async (port, slot) => artworkState(port, slot));
    const cache = new ArtworkCache(1);
    const retained = maximumInactiveArtworkEntries;
    await Promise.all(
      Array.from({ length: retained + 48 }, (_, index) =>
        cache.load(`port-${index}`, "cover", false, () => index >= 48),
      ),
    );
    expect(read).toHaveBeenCalledTimes(retained);
    await cache.load("last", "cover");
    expect(cache.read("port-48", "cover").state).toBeUndefined();
    expect(cache.read("port-49", "cover").state?.choice.port_id).toBe("port-49");
    expect(cache.read("last", "cover").state?.choice.port_id).toBe("last");
  });

  it("overlaps a bounded number of local reads for different ports", async () => {
    let active = 0,
      maximum = 0;
    const releases: (() => void)[] = [];
    vi.spyOn(desktopApi, "artwork").mockImplementation(async (port, slot) => {
      maximum = Math.max(maximum, ++active);
      await new Promise<void>((resolve) => releases.push(resolve));
      active--;
      return artworkState(port, slot);
    });
    const cache = new ArtworkCache(1);
    const loads = Array.from({ length: maximumConcurrentArtworkReads * 2 }, (_, index) =>
      cache.load(`port-${index}`, "cover"),
    );
    await vi.waitFor(() => expect(releases).toHaveLength(maximumConcurrentArtworkReads));
    while (releases.length) {
      releases.shift()!();
      await new Promise((resolve) => setTimeout(resolve));
    }
    await Promise.all(loads);
    expect(maximum).toBe(maximumConcurrentArtworkReads);
    expect(cache.read("port-7", "cover").state?.choice.port_id).toBe("port-7");
  });

  it("keeps local thumbnail decoding serial while choice reads overlap", async () => {
    let readsActive = 0,
      readMaximum = 0,
      thumbnailsActive = 0,
      thumbnailMaximum = 0;
    vi.spyOn(desktopApi, "artwork").mockImplementation(async (port, slot) => {
      readMaximum = Math.max(readMaximum, ++readsActive);
      await new Promise((resolve) => setTimeout(resolve));
      readsActive--;
      return artworkState(port, slot, 1, true);
    });
    vi.spyOn(desktopApi, "artworkThumbnail").mockImplementation(async () => {
      thumbnailMaximum = Math.max(thumbnailMaximum, ++thumbnailsActive);
      await new Promise((resolve) => setTimeout(resolve));
      thumbnailsActive--;
      return { asset_sha256: "a".repeat(64), choice_revision: 1, png_base64: "iVBORw==" };
    });
    const cache = new ArtworkCache(1);
    await Promise.all(
      Array.from({ length: maximumConcurrentArtworkReads * 2 }, (_, index) =>
        cache.load(`port-${index}`, "cover"),
      ),
    );
    expect(readMaximum).toBeGreaterThan(1);
    expect(thumbnailMaximum).toBe(1);
    expect(cache.read("port-7", "cover").image).toBeDefined();
  });

  it("runs a mutation alone after earlier reads and before later ones", async () => {
    const order: string[] = [];
    const releases: (() => void)[] = [];
    vi.spyOn(desktopApi, "artwork").mockImplementation(async (port, slot) => {
      order.push(`read:${port}`);
      await new Promise<void>((resolve) => releases.push(resolve));
      order.push(`read-done:${port}`);
      return artworkState(port, slot);
    });
    vi.spyOn(desktopApi, "resetArtwork").mockImplementation(async (port, slot, revision) => {
      order.push(`change:${port}`);
      return artworkState(port, slot, revision + 1);
    });
    const cache = new ArtworkCache(1);
    const before = [cache.load("a", "cover"), cache.load("b", "cover")];
    const change = cache.change("c", "cover", 0, null, () => true);
    const after = cache.load("d", "cover");
    await vi.waitFor(() => expect(releases).toHaveLength(2));
    expect(order).toEqual(["read:a", "read:b"]);
    releases.shift()!();
    releases.shift()!();
    await Promise.all([...before, change]);
    await vi.waitFor(() => expect(releases).toHaveLength(1));
    releases.shift()!();
    await after;
    expect(order).toEqual([
      "read:a",
      "read:b",
      "read-done:a",
      "read-done:b",
      "change:c",
      "read:d",
      "read-done:d",
    ]);
  });

  it("evicts inactive previews by retained image size as well as count", async () => {
    const large = "A".repeat(4 * Math.ceil((1024 * 1024) / 3) - 4) + "AA==";
    vi.spyOn(desktopApi, "artwork").mockImplementation(async (port, slot) =>
      artworkState(port, slot, 1, true),
    );
    vi.spyOn(desktopApi, "artworkThumbnail").mockResolvedValue({
      asset_sha256: "a".repeat(64),
      choice_revision: 1,
      png_base64: large,
    });
    const cache = new ArtworkCache(1);
    const imageLength = `data:image/png;base64,${large}`.length;
    const fit = Math.floor(maximumInactiveArtworkImageLength / imageLength);
    expect(fit).toBeLessThan(maximumInactiveArtworkEntries);
    for (let index = 0; index <= fit; index++) await cache.load(`port-${index}`, "cover");
    expect(cache.read("port-0", "cover").state).toBeUndefined();
    expect(cache.read("port-1", "cover").image).toBeDefined();
    expect(cache.read(`port-${fit}`, "cover").image).toBeDefined();
  });

  it("does not evict an on-screen cover as other catalog entries load", async () => {
    vi.spyOn(desktopApi, "artwork").mockImplementation(async (port, slot) =>
      artworkState(port, slot),
    );
    const cache = new ArtworkCache(1);
    const leave = cache.subscribe("visible", "cover", () => {});
    await cache.load("visible", "cover");
    for (let index = 0; index < maximumInactiveArtworkEntries + 8; index++)
      await cache.load(`other-${index}`, "cover");
    expect(cache.read("visible", "cover").state?.choice.port_id).toBe("visible");
    leave();
    expect(cache.read("visible", "cover").state).toBeUndefined();
  });

  it("loads a newly interested view even when its earlier queued read was abandoned", async () => {
    const read = vi
      .spyOn(desktopApi, "artwork")
      .mockImplementation(async (port, slot) => artworkState(port, slot));
    const cache = new ArtworkCache(1);
    const abandoned = cache.load("sample", "cover", false, () => false);
    const current = cache.load("sample", "cover");
    await Promise.all([abandoned, current]);
    expect(read).toHaveBeenCalledTimes(1);
    expect(cache.read("sample", "cover").state?.choice.port_id).toBe("sample");
  });

  it("refuses oversized previews and isolates library generations", async () => {
    vi.spyOn(desktopApi, "artwork").mockImplementation(async (_port, _slot, generation) =>
      artworkState("sample", "cover", generation, true),
    );
    vi.spyOn(desktopApi, "artworkThumbnail").mockImplementation(async (_port, _slot, revision) => ({
      asset_sha256: "a".repeat(64),
      choice_revision: revision,
      png_base64: "A".repeat(4 * Math.ceil((1024 * 1024) / 3) + 4),
    }));
    const first = new ArtworkCache(1),
      second = new ArtworkCache(2);
    await Promise.all([first.load("sample", "cover"), second.load("sample", "cover")]);
    expect(first.read("sample", "cover").state?.choice.revision).toBe(1);
    expect(second.read("sample", "cover").state?.choice.revision).toBe(2);
    expect(second.read("sample", "cover").image).toBeUndefined();
    expect(second.read("sample", "cover").error).toContain("preview changed");
  });

  it.each([
    "",
    "iVBORw=",
    "iVBORw!#",
    "A".repeat(4 * Math.ceil((1024 * 1024) / 3) + 4),
    `${"A".repeat(4 * Math.floor((1024 * 1024) / 3) + 3)}=`,
  ])("rejects malformed or oversized encoded preview payloads", async (png_base64) => {
    vi.spyOn(desktopApi, "artwork").mockResolvedValue(artworkState("sample", "cover", 1, true));
    vi.spyOn(desktopApi, "artworkThumbnail").mockResolvedValue({
      asset_sha256: "a".repeat(64),
      choice_revision: 1,
      png_base64,
    });
    const cache = new ArtworkCache(7);
    await cache.load("sample", "cover");
    expect(cache.read("sample", "cover").image).toBeUndefined();
    expect(cache.read("sample", "cover").error).toContain("preview changed");
  });
});
