// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { desktopApi } from "../api";
import { ArtworkProvider } from "../artwork";
import * as picker from "../file-picker";
import { artworkState, portDefinition } from "../test-fixtures";
import type { ArtworkState } from "../types";
import { ArtworkControls, ArtworkImage } from "./Artwork";

let container: HTMLDivElement, root: Root;

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
          artwork: {
            game_id: 194694,
            cover_id: 287780,
            image_id: imageId,
            image_sha256: "a".repeat(64),
            game_slug: "ship-of-harkinian",
            match_kind: "port",
          },
        } as typeof port.presentation,
      },
    ],
  };
  await act(async () =>
    root.render(
      <ArtworkProvider generation={generation} catalog={catalog}>
        <h2>{port.name}</h2>
        <ArtworkImage port={port} />
        <ArtworkControls key={`${portId}:${generation}`} port={port} />
      </ArtworkProvider>,
    ),
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

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  vi.spyOn(desktopApi, "artwork").mockImplementation(async (port, slot) =>
    artworkState(port, slot),
  );
  vi.spyOn(desktopApi, "artworkThumbnail").mockImplementation(async (_port, _slot, revision) => ({
    asset_sha256: "a".repeat(64),
    choice_revision: revision,
    png_base64: "iVBORw==",
  }));
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("local artwork controls", () => {
  it("keeps previous artwork and provenance visible during a failed refresh, holding changes until retry", async () => {
    const selected = artworkState("sample", "cover", 1, true);
    vi.mocked(desktopApi.artwork).mockImplementation(async (port, slot) =>
      slot === "cover" ? selected : artworkState(port, slot),
    );
    const imported = vi.spyOn(desktopApi, "importArtwork");
    const reset = vi.spyOn(desktopApi, "resetArtwork");
    await render();
    await open();
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
    vi.mocked(desktopApi.artwork).mockRejectedValue(new Error("Artwork read unavailable."));
    await click("cover", "Refresh artwork");
    expect(container.querySelector(".artwork-image img")).not.toBeNull();
    await render("sample", 8);
    await open();
    expect(container.querySelector(".artwork-image img")).toBeNull();
    expect(container.textContent).not.toContain("owned-image.png");
    expect(container.textContent).not.toContain("Showing previously loaded artwork.");
    expect(button("cover", "Choose local image").disabled).toBe(true);
  });

  it("refreshes artwork when the catalog mapping changes in the same library", async () => {
    await render("sample", 7, "old-cover");
    const before = vi.mocked(desktopApi.artwork).mock.calls.length;
    await render("sample", 7, "corrected-cover");
    expect(vi.mocked(desktopApi.artwork).mock.calls.length).toBeGreaterThan(before);
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
      vi.spyOn(picker, "pickArtworkPath").mockResolvedValue("E:/owned.png");
      await render("sample", 7, "old-cover");
      await open();
      await click("cover", kind === "import" ? "Choose local image" : "Reset to default");
      expect(change).toHaveBeenCalledTimes(1);
      await render("sample", 7, "corrected-cover");
      expect(button("cover", "Choose local image").disabled).toBe(true);
      state = artworkState("sample", "cover", state.choice.revision + 1, kind === "import");
      await act(async () => finish(state));
      expect(container.querySelector<HTMLElement>(".artwork-image")?.dataset.artworkSource).toBe(
        state.resolved_source.kind,
      );
      expect(button("cover", "Reset to default").disabled).toBe(kind === "reset");
      expect(button("cover", "Choose local image").disabled).toBe(false);
      expect(container.textContent).toContain(
        kind === "import" ? "Local image selected." : "Default artwork restored.",
      );
      expect(change).toHaveBeenCalledTimes(1);
    },
  );

  it("waits for a pre-commit replacement-cache read and then reads the committed choice", async () => {
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
    vi.spyOn(picker, "pickArtworkPath").mockResolvedValue("E:/owned.png");
    await render("sample", 7, "old-cover");
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
    expect(container.querySelector<HTMLElement>(".artwork-image")?.dataset.artworkSource).toBe(
      "local_import",
    );
    expect(button("cover", "Reset to default").disabled).toBe(false);
    expect(change).toHaveBeenCalledTimes(1);
  });

  it("resolves reset against current catalog artwork rather than copying the old change result", async () => {
    let state: ArtworkState = artworkState("sample", "cover", 1, true);
    vi.mocked(desktopApi.artwork).mockImplementation(async (port, slot) =>
      slot === "cover" ? state : artworkState(port, slot),
    );
    vi.mocked(desktopApi.artworkThumbnail).mockImplementation(async (_port, _slot, revision) => ({
      asset_sha256: (revision === 2 ? "b" : "a").repeat(64),
      choice_revision: revision,
      png_base64: "iVBORw==",
    }));
    let finish!: (value: ArtworkState) => void;
    vi.spyOn(desktopApi, "resetArtwork").mockReturnValue(
      new Promise((resolve) => (finish = resolve)),
    );
    await render("sample", 7, "old-cover");
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
    expect(container.querySelector<HTMLElement>(".artwork-image")?.dataset.artworkSource).toBe(
      "igdb_cover",
    );
    expect(container.textContent).toContain("image corrected-cover");
    expect(button("cover", "Reset to default").disabled).toBe(true);
  });

  it.each(["select", "cancel", "reject"] as const)(
    "discards an obsolete picker %s after an A–B–A catalog change",
    async (result) => {
      let finish!: (value: string | null) => void;
      let reject!: (error: Error) => void;
      vi.spyOn(picker, "pickArtworkPath").mockReturnValue(
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
    vi.spyOn(picker, "pickArtworkPath").mockResolvedValue("E:/obsolete.png");
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
      vi.spyOn(picker, "pickArtworkPath").mockResolvedValue("E:/owned.png");
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
    vi.spyOn(picker, "pickArtworkPath").mockResolvedValue("E:/owned.png");
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
      let finish!: (value: ArtworkState) => void;
      const change = vi
        .spyOn(desktopApi, "importArtwork")
        .mockReturnValue(new Promise((resolve) => (finish = resolve)));
      vi.spyOn(picker, "pickArtworkPath").mockResolvedValue("E:/owned.png");
      await render();
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
      png_base64: "iVBORw==",
    }));
    await render();
    await open();
    await vi.waitFor(() =>
      expect(container.querySelector<HTMLElement>(".artwork-image")?.dataset.artworkSource).toBe(
        "igdb_cover",
      ),
    );
    expect(container.querySelector(".artwork-image img")).not.toBeNull();
    expect(container.querySelector(".artwork-image")?.classList).toContain(
      "artwork-image-resolved",
    );
    expect(container.querySelector(".artwork-image")?.className).not.toMatch(/palette-\d/);
    expect(container.querySelector(".artwork-image")?.textContent).not.toContain("IGDB");
    expect(container.querySelector<HTMLAnchorElement>(".artwork-source a")?.href).toBe(
      "https://www.igdb.com/games/ship-of-harkinian",
    );
    expect(container.textContent).toContain("Not provided with this catalog mapping");
    expect(button("cover", "Reset to default").disabled).toBe(true);
  });

  it("selects and resets each slot through core and exposes local source information", async () => {
    const choose = vi.spyOn(picker, "pickArtworkPath").mockResolvedValue("E:/owned.png");
    const change = vi
      .spyOn(desktopApi, "importArtwork")
      .mockImplementation(async (port, slot, _path, revision) =>
        artworkState(port, slot, revision + 1, true),
      );
    const reset = vi
      .spyOn(desktopApi, "resetArtwork")
      .mockImplementation(async (port, slot, revision) => artworkState(port, slot, revision + 1));
    await render();
    await open();
    expect(container.textContent).not.toContain("SteamGridDB");
    expect(container.querySelector(".artwork-image > span")?.textContent).toBe("SF");
    expect(container.querySelector(".artwork-image")?.classList).toContain("palette-4");
    expect(container.textContent).toContain("Generated by Portcove");
    expect(container.textContent).toContain("f".repeat(64));
    await click("cover", "Choose local image");
    expect(change).toHaveBeenLastCalledWith("sample", "cover", "E:/owned.png", 0, 7);
    expect(container.querySelector("img")?.alt).toBe("");
    expect(container.querySelector(".artwork-image")?.classList).toContain(
      "artwork-image-resolved",
    );
    expect(container.querySelector(".artwork-image")?.className).not.toMatch(/palette-\d/);
    expect(container.querySelector("h2")?.textContent).toContain("unusually long");
    expect(container.textContent).toContain("owned-image.png");
    expect(container.textContent).toContain("Not provided with this local image.");
    expect(document.activeElement).toBe(button("cover", "Choose local image"));
    await click("detail", "Choose local image");
    expect(change).toHaveBeenLastCalledWith("sample", "detail", "E:/owned.png", 0, 7);
    await click("cover", "Reset to default");
    expect(reset).toHaveBeenCalledWith("sample", "cover", 1, 7);
    expect(container.querySelector("img")).toBeNull();
    expect(container.querySelector(".artwork-image")?.classList).toContain("palette-4");
    expect(container.querySelector(".artwork-image")?.classList).not.toContain(
      "artwork-image-resolved",
    );
    expect(container.querySelector(".artwork-image > span")?.textContent).toBe("SF");
    expect(button("detail", "Reset to default").disabled).toBe(false);
    expect(choose).toHaveBeenCalledTimes(2);
  });

  it("cancels the native picker without changing the choice and restores focus", async () => {
    vi.spyOn(picker, "pickArtworkPath").mockResolvedValue(null);
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
      vi.spyOn(picker, "pickArtworkPath").mockReturnValue(
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
    vi.spyOn(picker, "pickArtworkPath").mockResolvedValue("E:/unsupported.svg");
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
    expect(container.querySelector(".artwork-image > span")?.textContent).toBe("SF");
  });

  it("uses the core fallback if a validated local thumbnail cannot render", async () => {
    vi.mocked(desktopApi.artwork).mockResolvedValue(artworkState("sample", "cover", 2, true));
    await render();
    await open();
    const image = container.querySelector<HTMLImageElement>(".artwork-image img")!;
    await act(async () => image.dispatchEvent(new Event("error")));
    expect(container.querySelector(".artwork-image")?.classList).toContain("palette-4");
    expect(container.querySelector(".artwork-image")?.classList).not.toContain(
      "artwork-image-resolved",
    );
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
