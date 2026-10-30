import { captureParityState } from "../../test/parity-capture";
import { controlledAct as act } from "../../test/controlled-react-act";
import { render as renderComponent, cleanup, type RenderResult } from "vitest-browser-react";

import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { page } from "vite-plus/test/browser";
import { desktopApi } from "../api";
import { ArtworkProvider } from "../artwork";
import { catalogEntries } from "../features/browsing/catalog-entry";
import type { Perform } from "../features/operations/use-operation-state";
import * as picker from "../file-picker";
import { artworkState, portDefinition } from "../test-fixtures";
import type { ArtworkState, PortListing } from "../types";
import { ArtworkControls, ArtworkImage } from "./Artwork";
import { ListingDetailPanel } from "./ListingDetailPanel";

let container: HTMLDivElement, root: RenderResult;

async function render(portId = "sample", generation = 7, imageId = "") {
  const port = {
    ...portDefinition(),
    id: portId,
    name: "An unusually long game title that stays separate from its cover",
  };
  const catalog = {
    schema_version: 2,
    ports: [
      {
        ...port,
        presentation: {
          installation_method: "portable-package",
          saves_and_settings: "portcove-managed",
          source_requirements: [],
          artwork: {
            game_id: 194694,
            cover_id: 287780,
            image_id: imageId,
            image_sha256: "a".repeat(64),
            game_slug: "ship-of-harkinian",
            match_kind: "port",
          },
        } satisfies NonNullable<typeof port.presentation>,
      },
    ],
  };
  await root.rerender(
    <ArtworkProvider generation={generation} catalog={catalog}>
      <h2>{port.name}</h2>
      <div style={{ display: "grid", width: 192, height: 256 }}>
        <ArtworkImage port={port} />
      </div>
      <ArtworkControls key={`${portId}:${generation}`} port={port} />
    </ArtworkProvider>,
  );
}

async function open() {
  await act(async () => {
    const details = container.querySelector<HTMLDetailsElement>(".artwork-controls")!;
    details.open = true;
    details.dispatchEvent(new Event("toggle"));
  });
}

function button(slot: "cover" | "detail", label: string) {
  const section = container.querySelector(
    `[aria-label="${slot === "cover" ? "Cover" : "Detail"} image"]`,
  )!;
  return [...section.querySelectorAll("button")].find((item) => item.textContent === label)!;
}

async function click(slot: "cover" | "detail", label: string) {
  await act(async () => button(slot, label).click());
}

function controlledArtworkVisibility() {
  let showArtwork!: () => void;
  vi.stubGlobal(
    "IntersectionObserver",
    class {
      constructor(private readonly callback: IntersectionObserverCallback) {}
      observe(target: Element) {
        showArtwork = () =>
          this.callback(
            [{ target, isIntersecting: true } as IntersectionObserverEntry],
            this as unknown as IntersectionObserver,
          );
      }
      disconnect() {}
    },
  );
  return () => showArtwork();
}

beforeEach(async () => {
  container = document.createElement("div");
  document.body.append(container);
  root = await renderComponent(null, { container: document.body.appendChild(container) });
  vi.spyOn(desktopApi, "artwork").mockImplementation(async (port, slot) =>
    artworkState(port, slot),
  );
  vi.spyOn(desktopApi, "artworkThumbnail").mockImplementation(async (_port, _slot, revision) => ({
    asset_sha256: "a".repeat(64),
    choice_revision: revision,
    png_base64:
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/l9sAAAAASUVORK5CYII=",
  }));
});

afterEach(async () => {
  await cleanup();
  container.remove();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("local artwork controls", () => {
  it("keeps a listing's independent artwork slots and one detail preview inside Change artwork", async () => {
    const listing: PortListing = {
      id: "listing-only",
      name: "Listing Only",
      summary: "An upstream project.",
      project_url: "https://example.com/project",
      platforms: [],
      availability: "unknown",
    };
    const directory = { format_version: 1, listings: [listing] };
    const entry = catalogEntries(undefined, directory, [], [])[0]!;
    const perform: Perform = async (_name, task) => task();
    vi.mocked(desktopApi.artwork).mockImplementation(async (port, slot) =>
      artworkState(port, slot, 1, true),
    );
    await root.rerender(
      <ArtworkProvider generation={7} listings={directory}>
        <ListingDetailPanel
          entry={entry}
          generation={7}
          perform={perform}
          onChanged={() => {}}
          close={() => {}}
        />
      </ArtworkProvider>,
    );
    expect(container.querySelectorAll(".artwork-controls")).toHaveLength(1);
    expect(
      container.querySelector(".artwork-controls")?.parentElement?.closest("details"),
    ).toBeNull();
    expect(container.querySelector(".detail-artwork")).toBeNull();
    await page.getByRole("tab", { name: "Manage", exact: true }).click();
    await open();
    await expect.poll(() => container.querySelectorAll(".detail-artwork").length).toBe(1);
    expect(container.querySelector(".artwork-controls .detail-artwork")).not.toBeNull();
    expect(button("cover", "Choose local image")).toBeDefined();
    expect(button("detail", "Choose local image")).toBeDefined();
    expect(desktopApi.artwork).toHaveBeenCalledWith(listing.id, "cover", 7);
    expect(desktopApi.artwork).toHaveBeenCalledWith(listing.id, "detail", 7);
    container.querySelector<HTMLElement>(".artwork-controls")!.scrollIntoView({ block: "start" });
    const coverControls = button("cover", "Choose local image").getBoundingClientRect();
    expect(coverControls.top).toBeGreaterThanOrEqual(0);
    expect(coverControls.bottom).toBeLessThanOrEqual(innerHeight);
    await captureParityState("artwork-listing-editor-expanded-fixture");
  });
  it("uses the shared cache for listing-only covers and preserves Core's local override", async () => {
    const listing: PortListing = {
      id: "listing-only",
      name: "Listing Only",
      summary: "An upstream project.",
      project_url: "https://example.com/project",
      platforms: [],
      availability: "unknown",
      artwork: {
        game_id: 1,
        cover_id: 2,
        image_id: "covera",
        image_sha256: "c".repeat(64),
        game_slug: "listing-only",
        match_kind: "port",
      },
    };
    const local = artworkState(listing.id, "cover", 3, true);
    vi.mocked(desktopApi.artwork).mockResolvedValue(local);
    const reset = vi.spyOn(desktopApi, "resetArtwork");
    const show = (item: PortListing) =>
      root.rerender(
        <ArtworkProvider generation={7} listings={{ format_version: 1, listings: [item] }}>
          <div style={{ display: "grid", width: 192, height: 256 }}>
            <ArtworkImage port={{ id: item.id }} />
          </div>
        </ArtworkProvider>,
      );
    await show(listing);
    await vi.waitFor(() =>
      expect(desktopApi.artwork).toHaveBeenCalledExactlyOnceWith(listing.id, "cover", 7),
    );
    await show({ ...listing, summary: "Changed description" });
    expect(desktopApi.artwork).toHaveBeenCalledTimes(1);
    await show({ ...listing, artwork: { ...listing.artwork!, image_id: "coverb" } });
    await vi.waitFor(() => expect(desktopApi.artwork).toHaveBeenCalledTimes(2));
    expect(reset).not.toHaveBeenCalled();
    await vi.waitFor(() =>
      expect(
        container.querySelector("[data-artwork-source]")?.getAttribute("data-artwork-source"),
      ).toBe("local_import"),
    );
  });
  it("keeps previous artwork and provenance visible during a failed refresh, holding changes until retry", async () => {
    const selected = artworkState("sample", "cover", 1, true);
    vi.mocked(desktopApi.artwork).mockImplementation(async (port, slot) =>
      slot === "cover" ? selected : artworkState(port, slot),
    );
    const imported = vi.spyOn(desktopApi, "importArtwork");
    const reset = vi.spyOn(desktopApi, "resetArtwork");
    await render();
    await open();
    await expect.poll(() => container.querySelector(".artwork-image img")).not.toBeNull();
    const image = container.querySelector<HTMLImageElement>(".artwork-image img")!;
    const src = image.src;
    vi.mocked(desktopApi.artwork).mockRejectedValueOnce(new Error("Artwork read unavailable."));
    await click("cover", "Refresh artwork");
    expect(container.querySelector<HTMLImageElement>(".artwork-image img")?.src).toBe(src);
    expect(container.textContent).toContain("owned-image.png");
    expect(container.textContent).toContain(
      "Showing previously loaded artwork. Refresh to check the current choice.",
    );
    expect(container.querySelector('[aria-label="Cover image"] [role="alert"]')?.textContent).toBe(
      "Artwork read unavailable.",
    );
    expect(button("cover", "Choose local image").disabled).toBe(true);
    expect(button("cover", "Reset to default").disabled).toBe(true);
    expect(button("cover", "Refresh artwork").disabled).toBe(false);
    expect(button("detail", "Choose local image").disabled).toBe(false);
    await captureParityState("artwork-retained-refresh-error-fixture");
    await click("cover", "Refresh artwork");
    expect(container.textContent).not.toContain("Showing previously loaded artwork.");
    expect(container.querySelector('[aria-label="Cover image"] [role="alert"]')).toBeNull();
    expect(button("cover", "Choose local image").disabled).toBe(false);
    expect(button("cover", "Reset to default").disabled).toBe(false);
    expect(imported).not.toHaveBeenCalled();
    expect(reset).not.toHaveBeenCalled();
  });

  it("does not carry a failed-refresh display into another library generation", async () => {
    vi.mocked(desktopApi.artwork).mockResolvedValue(artworkState("sample", "cover", 1, true));
    await render();
    await open();
    await expect.poll(() => container.querySelector(".artwork-image img")).not.toBeNull();
    vi.mocked(desktopApi.artwork).mockRejectedValue(new Error("Artwork read unavailable."));
    await click("cover", "Refresh artwork");
    expect(container.querySelector(".artwork-image img")).not.toBeNull();
    await render("sample", 8);
    await open();
    expect(container.querySelector(".artwork-image:not(.wide-artwork) img")).toBeNull();
    expect(container.textContent).not.toContain("owned-image.png");
    expect(container.textContent).not.toContain("Showing previously loaded artwork.");
    expect(button("cover", "Choose local image").disabled).toBe(true);
  });

  it("refreshes artwork when the catalog mapping changes in the same library", async () => {
    await render("sample", 7, "old-cover");
    await expect.poll(() => vi.mocked(desktopApi.artwork).mock.calls.length).toBeGreaterThan(0);
    const before = vi.mocked(desktopApi.artwork).mock.calls.length;
    await render("sample", 7, "corrected-cover");
    await expect
      .poll(() => vi.mocked(desktopApi.artwork).mock.calls.length)
      .toBeGreaterThan(before);
  });

  it.each(["import", "reset"] as const)(
    "reconciles a completed %s with a replacement catalog cache",
    async (kind) => {
      let state = artworkState("sample", "cover", kind === "reset" ? 1 : 0, kind === "reset");
      vi.mocked(desktopApi.artwork).mockImplementation(async (port, slot) =>
        slot === "cover" ? state : artworkState(port, slot),
      );
      let finish!: (value: ArtworkState) => void;
      const change = vi
        .spyOn(desktopApi, kind === "import" ? "importArtwork" : "resetArtwork")
        .mockReturnValue(new Promise((resolve) => (finish = resolve)));
      vi.mocked(picker.pickArtworkPath).mockResolvedValue("E:/owned.png");
      await render("sample", 7, "old-cover");
      await open();
      await click("cover", kind === "import" ? "Choose local image" : "Reset to default");
      expect(change).toHaveBeenCalledTimes(1);
      await render("sample", 7, "corrected-cover");
      expect(button("cover", "Choose local image").disabled).toBe(true);
      state = artworkState("sample", "cover", state.choice.revision + 1, kind === "import");
      await act(async () => finish(state));
      await expect
        .poll(() => container.querySelector<HTMLElement>(".artwork-image")?.dataset.artworkSource)
        .toBe(state.resolved_source.kind);
      expect(
        container.querySelector(".artwork-image")!.getBoundingClientRect().height,
      ).toBeGreaterThan(0);
      expect(button("cover", "Reset to default").disabled).toBe(kind === "reset");
      expect(button("cover", "Choose local image").disabled).toBe(false);
      expect(container.textContent).toContain(
        kind === "import" ? "Local image selected." : "Default artwork restored.",
      );
      expect(change).toHaveBeenCalledTimes(1);
    },
  );

  it("waits for a pre-commit replacement-cache read and then reads the committed choice", async () => {
    const showArtwork = controlledArtworkVisibility();
    let state = artworkState("sample", "cover");
    let reads = 0;
    let deferReplacement = false;
    let finishRead!: (value: ArtworkState) => void;
    vi.mocked(desktopApi.artwork).mockImplementation(async (port, slot) => {
      if (slot !== "cover") return artworkState(port, slot);
      reads++;
      if (deferReplacement) {
        deferReplacement = false;
        return new Promise((resolve) => (finishRead = resolve));
      }
      return state;
    });
    let finishChange!: (value: ArtworkState) => void;
    const change = vi
      .spyOn(desktopApi, "importArtwork")
      .mockReturnValue(new Promise((resolve) => (finishChange = resolve)));
    vi.mocked(picker.pickArtworkPath).mockResolvedValue("E:/owned.png");
    await render("sample", 7, "old-cover");
    await act(async () => showArtwork());
    await expect.poll(() => container.querySelector(".artwork-image")?.textContent).toBe("SF");
    await open();
    await click("cover", "Choose local image");
    expect(change).toHaveBeenCalledTimes(1);
    const readsBefore = reads;
    deferReplacement = true;
    await render("sample", 7, "corrected-cover");
    expect(reads).toBe(readsBefore + 1);
    const preCommit = state;
    state = artworkState("sample", "cover", 1, true);
    await act(async () => finishChange(state));
    expect(button("cover", "Choose local image").disabled).toBe(true);
    expect(container.textContent).not.toContain("Local image selected.");
    await act(async () => finishRead(preCommit));
    expect(reads).toBe(readsBefore + 2);
    await expect
      .poll(() => container.querySelector<HTMLElement>(".artwork-image")?.dataset.artworkSource)
      .toBe("local_import");
    expect(
      container.querySelector(".artwork-image")!.getBoundingClientRect().height,
    ).toBeGreaterThan(0);
    expect(reads).toBe(readsBefore + 2);
    expect(button("cover", "Reset to default").disabled).toBe(false);
    expect(change).toHaveBeenCalledTimes(1);
  });

  it("resolves reset against current catalog artwork rather than copying the old change result", async () => {
    const showArtwork = controlledArtworkVisibility();
    let state: ArtworkState = artworkState("sample", "cover", 1, true);
    vi.mocked(desktopApi.artwork).mockImplementation(async (port, slot) =>
      slot === "cover" ? state : artworkState(port, slot),
    );
    vi.mocked(desktopApi.artworkThumbnail).mockImplementation(async (_port, _slot, revision) => ({
      asset_sha256: (revision === 2 ? "b" : "a").repeat(64),
      choice_revision: revision,
      png_base64:
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/l9sAAAAASUVORK5CYII=",
    }));
    let finish!: (value: ArtworkState) => void;
    vi.spyOn(desktopApi, "resetArtwork").mockReturnValue(
      new Promise((resolve) => (finish = resolve)),
    );
    await render("sample", 7, "old-cover");
    await act(async () => showArtwork());
    await expect
      .poll(() => container.querySelector<HTMLElement>(".artwork-image")?.dataset.artworkSource)
      .toBe("local_import");
    await open();
    await click("cover", "Reset to default");
    await render("sample", 7, "corrected-cover");
    state = {
      ...artworkState("sample", "cover", 2),
      availability: "available",
      resolved_source: {
        kind: "igdb_cover",
        cache_id: "b".repeat(64),
        artwork: {
          game_id: 194694,
          cover_id: 287780,
          image_id: "corrected-cover",
          image_sha256: "a".repeat(64),
          game_slug: "ship-of-harkinian",
          match_kind: "port",
        },
      },
    };
    await act(async () => finish(artworkState("sample", "cover", 2)));
    await expect
      .poll(() => container.querySelector<HTMLElement>(".artwork-image")?.dataset.artworkSource)
      .toBe("igdb_cover");
    expect(container.textContent).toContain("image corrected-cover");
    expect(button("cover", "Reset to default").disabled).toBe(true);
  });

  it.each(["select", "cancel", "reject"] as const)(
    "discards an obsolete picker %s after an A–B–A catalog change",
    async (result) => {
      let finish!: (value: string | null) => void;
      let reject!: (error: Error) => void;
      vi.mocked(picker.pickArtworkPath).mockReturnValue(
        new Promise((resolve, fail) => {
          finish = resolve;
          reject = fail;
        }),
      );
      const change = vi.spyOn(desktopApi, "importArtwork");
      await render("sample", 7, "cover-a");
      await open();
      await click("cover", "Choose local image");
      await render("sample", 7, "cover-b");
      await render("sample", 7, "cover-a");
      const focus = document.createElement("button");
      container.append(focus);
      focus.focus();
      await act(async () => {
        if (result === "reject") reject(new Error("Obsolete picker failed."));
        else finish(result === "select" ? "E:/obsolete.png" : null);
      });
      expect(change).not.toHaveBeenCalled();
      expect(container.textContent).not.toContain("Local image selected.");
      expect(container.textContent).not.toContain("Obsolete picker failed.");
      expect(button("cover", "Choose local image").disabled).toBe(false);
      expect(document.activeElement).toBe(focus);
    },
  );

  it("does not dispatch a queued choice after its catalog cache was replaced", async () => {
    let finishRead!: (value: ArtworkState) => void;
    vi.mocked(desktopApi.artwork)
      .mockResolvedValueOnce(artworkState("sample", "cover"))
      .mockReturnValueOnce(new Promise((resolve) => (finishRead = resolve)));
    vi.mocked(picker.pickArtworkPath).mockResolvedValue("E:/obsolete.png");
    const change = vi.spyOn(desktopApi, "importArtwork");
    await render("sample", 7, "old-cover");
    await open();
    await click("cover", "Choose local image");
    await render("sample", 7, "corrected-cover");
    await act(async () => finishRead(artworkState("sample", "detail")));
    expect(change).not.toHaveBeenCalled();
    expect(button("cover", "Choose local image").disabled).toBe(false);
  });

  it.each(["import", "reset"] as const)(
    "retains a rejected %s error and refreshes the current cache for retry",
    async (kind) => {
      let state = artworkState("sample", "cover", kind === "reset" ? 1 : 0, kind === "reset");
      vi.mocked(desktopApi.artwork).mockImplementation(async (port, slot) =>
        slot === "cover" ? state : artworkState(port, slot),
      );
      let reject!: (error: Error) => void;
      const change = vi
        .spyOn(desktopApi, kind === "import" ? "importArtwork" : "resetArtwork")
        .mockReturnValueOnce(new Promise((_resolve, fail) => (reject = fail)));
      vi.mocked(picker.pickArtworkPath).mockResolvedValue("E:/owned.png");
      await render("sample", 7, "old-cover");
      await open();
      await click("cover", kind === "import" ? "Choose local image" : "Reset to default");
      await render("sample", 7, "corrected-cover");
      state = artworkState("sample", "cover", 5, true);
      await act(async () => reject(new Error("Choice changed; review the current image.")));
      expect(container.textContent).toContain("Choice changed; review the current image.");
      expect(container.textContent).toContain("owned-image.png");
      expect(button("cover", "Choose local image").disabled).toBe(false);
      expect(button("cover", "Reset to default").disabled).toBe(false);
      expect(container.textContent).not.toContain("Local image selected.");
      await captureParityState(`artwork-${kind}-rejected-fixture`);
      change.mockResolvedValueOnce(artworkState("sample", "cover", 6, kind === "import"));
      await click("cover", kind === "import" ? "Choose local image" : "Reset to default");
      expect(change).toHaveBeenLastCalledWith(
        "sample",
        "cover",
        ...(kind === "import" ? ["E:/owned.png", 5, 7] : [5, 7]),
      );
      expect(container.textContent).not.toContain("Choice changed; review the current image.");
    },
  );

  it("discloses a current-cache read failure without treating the committed import as rejected", async () => {
    let finish!: (value: ArtworkState) => void;
    vi.spyOn(desktopApi, "importArtwork").mockReturnValue(
      new Promise((resolve) => (finish = resolve)),
    );
    vi.mocked(picker.pickArtworkPath).mockResolvedValue("E:/owned.png");
    await render("sample", 7, "old-cover");
    await open();
    await click("cover", "Choose local image");
    await render("sample", 7, "corrected-cover");
    vi.mocked(desktopApi.artwork).mockRejectedValue(new Error("Current artwork read failed."));
    await act(async () => finish(artworkState("sample", "cover", 1, true)));
    expect(container.textContent).toContain("Local image selected.");
    expect(container.querySelector('[aria-label="Cover image"] [role="alert"]')?.textContent).toBe(
      "Current artwork read failed.",
    );
    expect(container.textContent).toContain("Artwork information is unavailable.");
    expect(container.textContent).not.toContain("Updating artwork…");
  });

  it.each(["port", "library", "close"])(
    "ignores a dispatched mutation completion after a %s change",
    async (kind) => {
      const showArtwork = controlledArtworkVisibility();
      let finish!: (value: ArtworkState) => void;
      const change = vi
        .spyOn(desktopApi, "importArtwork")
        .mockReturnValue(new Promise((resolve) => (finish = resolve)));
      vi.mocked(picker.pickArtworkPath).mockResolvedValue("E:/owned.png");
      await render();
      // Settle the independent lazy-image read before holding the mutation.
      // Otherwise visibility can queue a legitimate read behind that mutation.
      await act(async () => showArtwork());
      await expect.poll(() => container.querySelector(".artwork-image")?.textContent).toBe("SF");
      await open();
      await click("cover", "Choose local image");
      expect(change).toHaveBeenCalledTimes(1);
      if (kind === "close") {
        await act(async () => {
          const details = container.querySelector<HTMLDetailsElement>(".artwork-controls")!;
          details.open = false;
          details.dispatchEvent(new Event("toggle"));
        });
      } else await render(kind === "port" ? "another" : "sample", kind === "library" ? 8 : 7);
      await expect.poll(() => container.querySelector('[aria-label="Cover image"]')).toBeNull();
      const reads = vi.mocked(desktopApi.artwork).mock.calls.length;
      await act(async () => finish(artworkState("sample", "cover", 1, true)));
      expect(vi.mocked(desktopApi.artwork).mock.calls.length).toBe(reads);
      expect(container.textContent).not.toContain("Local image selected.");
      if (kind !== "close") await open();
      const currentButtons = [
        ...(container.querySelector('[aria-label="Cover image"]')?.querySelectorAll("button") ??
          []),
      ];
      expect(
        currentButtons.find((item) => item.textContent === "Choose local image")?.disabled,
      ).toBe(kind === "close" ? undefined : false);
      expect(currentButtons.find((item) => item.textContent === "Reset to default")?.disabled).toBe(
        kind === "close" ? undefined : true,
      );
    },
  );

  it("renders the mapped IGDB cover and its source on a clean profile", async () => {
    vi.mocked(desktopApi.artwork).mockImplementation(async (port, slot) =>
      slot === "detail"
        ? artworkState(port, slot)
        : {
            ...artworkState(port, slot),
            availability: "available",
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
          },
    );
    vi.mocked(desktopApi.artworkThumbnail).mockImplementation(async (_port, _slot, revision) => ({
      asset_sha256: "b".repeat(64),
      choice_revision: revision,
      png_base64:
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/l9sAAAAASUVORK5CYII=",
    }));
    await render();
    await open();
    await vi.waitFor(() =>
      expect(container.querySelector<HTMLElement>(".artwork-image")?.dataset.artworkSource).toBe(
        "igdb_cover",
      ),
    );
    expect(container.querySelector(".artwork-image img")).not.toBeNull();
    expect(container.querySelector(".artwork-image img")).not.toBeNull();
    expect(getComputedStyle(container.querySelector(".artwork-image")!).backgroundColor).toBe(
      "rgba(0, 0, 0, 0)",
    );
    expect(container.querySelector(".artwork-image")?.textContent).not.toContain("IGDB");
    expect(container.querySelector<HTMLAnchorElement>(".artwork-source a")?.href).toBe(
      "https://www.igdb.com/games/ship-of-harkinian",
    );
    expect(container.textContent).toContain("Not provided with this catalog mapping");
    expect(button("cover", "Reset to default").disabled).toBe(true);
  });

  it.each([640, 900])(
    "selects and resets independent artwork slots at %ipx height",
    async (height) => {
      await page.viewport(1280, height);
      const saved = new Map<string, ArtworkState>();
      vi.mocked(desktopApi.artwork).mockImplementation(
        async (port, slot) => saved.get(`${port}:${slot}`) ?? artworkState(port, slot),
      );
      const save = (port: string, slot: "cover" | "detail", revision: number, selected = false) => {
        const state = artworkState(port, slot, revision + 1, selected);
        saved.set(`${port}:${slot}`, state);
        return state;
      };
      const choose = vi.mocked(picker.pickArtworkPath).mockResolvedValue("E:/owned.png");
      const change = vi
        .spyOn(desktopApi, "importArtwork")
        .mockImplementation(async (port, slot, _path, revision) =>
          save(port, slot, revision, true),
        );
      const reset = vi
        .spyOn(desktopApi, "resetArtwork")
        .mockImplementation(async (port, slot, revision) => save(port, slot, revision));
      await render();
      await open();
      expect(container.textContent).not.toContain("SteamGridDB");
      await expect
        .poll(() => container.querySelector(".artwork-image > span")?.textContent)
        .toBe("SF");
      expect(
        getComputedStyle(container.querySelector(".artwork-image")!)
          .getPropertyValue("--art-color")
          .trim(),
      ).toBe(
        getComputedStyle(document.documentElement).getPropertyValue("--color-art-green").trim(),
      );
      expect(container.textContent).toContain("Generated by Portcove");
      expect(container.textContent).toContain("f".repeat(64));
      await click("cover", "Choose local image");
      expect(change).toHaveBeenLastCalledWith("sample", "cover", "E:/owned.png", 0, 7);
      expect(container.querySelector("img")?.alt).toBe("");
      expect(container.querySelector(".artwork-image img")).not.toBeNull();
      expect(getComputedStyle(container.querySelector(".artwork-image")!).backgroundColor).toBe(
        "rgba(0, 0, 0, 0)",
      );
      expect(container.querySelector("h2")?.textContent).toContain("unusually long");
      expect(container.textContent).toContain("owned-image.png");
      expect(container.textContent).toContain("Not provided with this local image.");
      expect(document.activeElement).toBe(button("cover", "Choose local image"));
      await captureParityState("artwork-cover-local-selected-fixture");
      await click("detail", "Choose local image");
      expect(change).toHaveBeenLastCalledWith("sample", "detail", "E:/owned.png", 0, 7);
      await click("cover", "Reset to default");
      expect(reset).toHaveBeenCalledWith("sample", "cover", 1, 7);
      expect(container.querySelector(".artwork-image:not(.wide-artwork) img")).toBeNull();
      expect(
        getComputedStyle(container.querySelector(".artwork-image")!)
          .getPropertyValue("--art-color")
          .trim(),
      ).toBe(
        getComputedStyle(document.documentElement).getPropertyValue("--color-art-green").trim(),
      );
      expect(container.querySelector(".artwork-image:not(.wide-artwork) img")).toBeNull();
      expect(container.querySelector(".artwork-image > span")?.textContent).toBe("SF");
      expect(choose).toHaveBeenCalledTimes(2);
      container.querySelector<HTMLElement>(".detail-artwork")!.scrollIntoView();
      await expect.poll(() => container.querySelector(".detail-artwork img")).not.toBeNull();
      expect(button("detail", "Reset to default").disabled).toBe(false);
      container.querySelector<HTMLElement>(".artwork-controls")!.scrollIntoView({ block: "start" });
      expect(button("cover", "Reset to default").disabled).toBe(true);
      const resetControls = button("cover", "Reset to default").getBoundingClientRect();
      expect(resetControls.top).toBeGreaterThanOrEqual(0);
      expect(resetControls.bottom).toBeLessThanOrEqual(innerHeight);
      await captureParityState("artwork-cover-reset-detail-retained-fixture");
    },
  );

  it("cancels the native picker without changing the choice and restores focus", async () => {
    vi.mocked(picker.pickArtworkPath).mockResolvedValue(null);
    const change = vi.spyOn(desktopApi, "importArtwork");
    await render();
    await open();
    await click("cover", "Choose local image");
    expect(change).not.toHaveBeenCalled();
    expect(button("cover", "Choose local image").disabled).toBe(false);
    expect(document.activeElement).toBe(button("cover", "Choose local image"));
  });

  it.each(["port", "library", "close"])(
    "discards a picker result after a %s change",
    async (kind) => {
      let finish!: (path: string) => void;
      vi.mocked(picker.pickArtworkPath).mockReturnValue(
        new Promise((resolve) => {
          finish = resolve;
        }),
      );
      const change = vi.spyOn(desktopApi, "importArtwork");
      await render();
      await open();
      await click("cover", "Choose local image");
      if (kind === "close") {
        await act(async () => {
          const details = container.querySelector<HTMLDetailsElement>(".artwork-controls")!;
          details.open = false;
          details.dispatchEvent(new Event("toggle"));
        });
      } else await render(kind === "port" ? "another" : "sample", kind === "library" ? 8 : 7);
      await act(async () => finish("E:/stale.png"));
      expect(change).not.toHaveBeenCalled();
      expect(container.textContent).not.toContain("Local image selected.");
    },
  );

  it("keeps an unavailable preference visible and lets core refresh after a rejected change", async () => {
    vi.mocked(desktopApi.artwork).mockImplementation(async (port, slot) => ({
      ...artworkState(port, slot, 5, true),
      availability: "unavailable",
      reason: "Selected file missing. Choice retained.",
      resolved_source: { kind: "generated_fallback" },
    }));
    vi.mocked(picker.pickArtworkPath).mockResolvedValue("E:/unsupported.svg");
    vi.spyOn(desktopApi, "importArtwork").mockRejectedValue(
      new Error("Static PNG or JPEG is required."),
    );
    await render();
    await open();
    await click("cover", "Choose local image");
    expect(container.textContent).toContain("Static PNG or JPEG is required.");
    expect(container.textContent).toContain("Choice retained.");
    expect(container.textContent).toContain("owned-image.png");
    expect(container.textContent).toContain(
      "Generated fallback; the selected local image is not currently rendered.",
    );
    expect(button("cover", "Reset to default").disabled).toBe(false);
    expect(container.querySelector("img")).toBeNull();
    await expect
      .poll(() => container.querySelector(".artwork-image > span")?.textContent)
      .toBe("SF");
  });

  it("uses the core fallback if a validated local thumbnail cannot render", async () => {
    vi.mocked(desktopApi.artwork).mockImplementation(async (port, slot) =>
      artworkState(port, slot, 2, true),
    );
    await render();
    await open();
    await expect.poll(() => container.querySelector(".artwork-image img")).not.toBeNull();
    const image = container.querySelector<HTMLImageElement>(".artwork-image img")!;
    await act(async () => image.dispatchEvent(new Event("error")));
    expect(
      getComputedStyle(container.querySelector(".artwork-image")!)
        .getPropertyValue("--art-color")
        .trim(),
    ).toBe(getComputedStyle(document.documentElement).getPropertyValue("--color-art-green").trim());
    expect(container.querySelector(".artwork-image:not(.wide-artwork) img")).toBeNull();
    expect(container.querySelector(".artwork-image > span")?.textContent).toBe("SF");
    expect(container.querySelector<HTMLElement>(".artwork-image")?.dataset.artworkSource).toBe(
      "generated_fallback",
    );
    expect(container.textContent).toContain("Image unavailable");
    expect(container.textContent).toContain(
      "Generated fallback; the selected local image is not currently rendered.",
    );
    expect(container.textContent).toContain("f".repeat(64));
  });
});

vi.mock("../file-picker", { spy: true });
