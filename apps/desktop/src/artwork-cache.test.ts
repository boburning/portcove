import { afterEach, describe, expect, it, vi } from "vitest";
import { desktopApi } from "./api";
import { ArtworkCache } from "./artwork-cache";
import { artworkState } from "./test-fixtures";
import type { ArtworkState } from "./types";

afterEach(() => vi.restoreAllMocks());

describe("disposable artwork display cache", () => {
  it("updates subscribed views for their slot and stops notifying a closed view", async () => {
    vi.spyOn(desktopApi, "artwork").mockImplementation(async (port, slot) => artworkState(port, slot));
    const cache = new ArtworkCache(7);
    const card = vi.fn(), editor = vi.fn(), detail = vi.fn();
    const closeCard = cache.subscribe("sample", "cover", card);
    const closeEditor = cache.subscribe("sample", "cover", editor);
    const closeDetail = cache.subscribe("sample", "detail", detail);
    await cache.load("sample", "cover");
    expect(card).toHaveBeenCalled(); expect(editor).toHaveBeenCalled(); expect(detail).not.toHaveBeenCalled();
    closeCard(); card.mockClear(); editor.mockClear();
    await cache.load("sample", "cover", true);
    expect(card).not.toHaveBeenCalled(); expect(editor).toHaveBeenCalled();
    closeEditor(); closeDetail();
  });

  it("deduplicates requests and serializes slots without making a second choice authority", async () => {
    let active = 0, maximum = 0;
    const read = vi.spyOn(desktopApi, "artwork").mockImplementation(async (port, slot) => {
      maximum = Math.max(maximum, ++active); await Promise.resolve(); active--;
      return artworkState(port, slot);
    });
    const cache = new ArtworkCache(7);
    await Promise.all([cache.load("sample", "cover"), cache.load("sample", "cover"), cache.load("sample", "detail")]);
    expect(read).toHaveBeenCalledTimes(2); expect(maximum).toBe(1);
    expect(cache.read("sample", "detail").state?.choice.slot).toBe("detail");
    await cache.load("sample", "cover");
    expect(read).toHaveBeenCalledTimes(2);
  });

  it("shows cached bytes immediately and rejects a mismatched refreshed thumbnail", async () => {
    vi.spyOn(desktopApi, "artwork").mockResolvedValue(artworkState("sample", "cover", 1, true));
    const thumbnail = vi.spyOn(desktopApi, "artworkThumbnail").mockResolvedValue({ asset_sha256: "a".repeat(64), choice_revision: 1, png: [137, 80, 78, 71] });
    const cache = new ArtworkCache(7);
    await cache.load("sample", "cover");
    const image = cache.read("sample", "cover").image;
    expect(image).toMatch(/^data:image\/png;base64,/);
    thumbnail.mockResolvedValue({ asset_sha256: "b".repeat(64), choice_revision: 1, png: [137] });
    const refresh = cache.load("sample", "cover", true);
    expect(cache.read("sample", "cover").image).toBe(image);
    await refresh;
    expect(cache.read("sample", "cover").image).toBeUndefined();
    expect(cache.read("sample", "cover").state?.choice.revision).toBe(1);
    expect(cache.read("sample", "cover").error).toContain("preview changed");
  });

  it("keeps a successful selection when thumbnail loading fails and refreshes missing originals", async () => {
    const selected = artworkState("sample", "cover", 1, true);
    vi.spyOn(desktopApi, "importArtwork").mockResolvedValue(selected);
    const thumbnails = vi.spyOn(desktopApi, "artworkThumbnail").mockRejectedValue(new Error("cache unavailable"));
    const cache = new ArtworkCache(7);
    expect(await cache.change("sample", "cover", 0, "owned.png", () => true)).toEqual(selected);
    expect(cache.read("sample", "cover").state?.selection).toEqual(selected.selection);
    vi.spyOn(desktopApi, "artwork").mockResolvedValue({ ...selected, availability: "unavailable", reason: "Selected image missing; choice retained." });
    await cache.load("sample", "cover", true);
    expect(cache.read("sample", "cover").state?.reason).toContain("choice retained");
    expect(thumbnails).toHaveBeenCalledTimes(1);
  });

  it("checks picker ownership again when a queued mutation reaches core", async () => {
    let finish!: (value: ArtworkState) => void;
    vi.spyOn(desktopApi, "artwork").mockReturnValue(new Promise(resolve => { finish = resolve; }));
    const change = vi.spyOn(desktopApi, "importArtwork");
    const cache = new ArtworkCache(7);
    const load = cache.load("sample", "detail");
    let current = true;
    const mutation = cache.change("sample", "cover", 0, "old-picker.png", () => current);
    current = false; finish(artworkState("sample", "detail"));
    await load; expect(await mutation).toBeUndefined(); expect(change).not.toHaveBeenCalled();
  });

  it("binds reset to the selected slot revision and library generation", async () => {
    const reset = vi.spyOn(desktopApi, "resetArtwork").mockResolvedValue(artworkState("sample", "detail", 4));
    const cache = new ArtworkCache(9);
    await cache.change("sample", "detail", 3, null, () => true);
    expect(reset).toHaveBeenCalledWith("sample", "detail", 3, 9);
    expect(cache.read("sample", "detail").state?.choice.revision).toBe(4);
    expect(cache.read("sample", "detail").image).toBeUndefined();
  });

  it("bounds display entries and queued requests during rapid browsing", async () => {
    const read = vi.spyOn(desktopApi, "artwork").mockImplementation(async (port, slot) => artworkState(port, slot));
    const cache = new ArtworkCache(1);
    await Promise.all(Array.from({ length: 80 }, (_, index) => cache.load(`port-${index}`, "cover")));
    expect(read).toHaveBeenCalledTimes(32);
    await cache.load("last", "cover");
    expect(cache.read("port-0", "cover").state).toBeUndefined();
    expect(cache.read("last", "cover").state?.choice.port_id).toBe("last");
  });

  it("refuses oversized previews and isolates library generations", async () => {
    vi.spyOn(desktopApi, "artwork").mockImplementation(async (_port, _slot, generation) => artworkState("sample", "cover", generation, true));
    vi.spyOn(desktopApi, "artworkThumbnail").mockImplementation(async (_port, _slot, revision) => ({ asset_sha256: "a".repeat(64), choice_revision: revision, png: new Array(1024 * 1024 + 1).fill(0) }));
    const first = new ArtworkCache(1), second = new ArtworkCache(2);
    await Promise.all([first.load("sample", "cover"), second.load("sample", "cover")]);
    expect(first.read("sample", "cover").state?.choice.revision).toBe(1);
    expect(second.read("sample", "cover").state?.choice.revision).toBe(2);
    expect(second.read("sample", "cover").image).toBeUndefined();
    expect(second.read("sample", "cover").error).toContain("preview changed");
  });
});
