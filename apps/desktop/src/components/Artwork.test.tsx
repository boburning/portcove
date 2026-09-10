// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { desktopApi } from "../api";
import { ArtworkProvider } from "../artwork";
import * as picker from "../file-picker";
import { artworkState, portDefinition } from "../test-fixtures";
import { ArtworkControls, ArtworkImage } from "./Artwork";

let container: HTMLDivElement, root: Root;

async function render(portId = "sample", generation = 7) {
  const port = {
    ...portDefinition(),
    id: portId,
    name: "An unusually long game title that stays separate from its cover",
  };
  await act(async () =>
    root.render(
      <ArtworkProvider generation={generation}>
        <h2>{port.name}</h2>
        <ArtworkImage port={port} />
        <ArtworkControls key={`${portId}:${generation}`} port={port} />
      </ArtworkProvider>,
    ),
  );
}

async function open() {
  await act(async () => {
    const details =
      container.querySelector<HTMLDetailsElement>(".artwork-controls")!;
    details.open = true;
    details.dispatchEvent(new Event("toggle"));
  });
}

function button(slot: "cover" | "detail", label: string) {
  const section = container.querySelector(
    `[aria-label="${slot === "cover" ? "Cover" : "Detail"} image"]`,
  )!;
  return [...section.querySelectorAll("button")].find(
    (item) => item.textContent === label,
  )!;
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
  vi.spyOn(desktopApi, "artworkThumbnail").mockImplementation(
    async (_port, _slot, revision) => ({
      asset_sha256: "a".repeat(64),
      choice_revision: revision,
      png: [137, 80, 78, 71],
    }),
  );
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("local artwork controls", () => {
  it("selects and resets each slot through core and exposes local source information", async () => {
    const choose = vi
      .spyOn(picker, "pickArtworkPath")
      .mockResolvedValue("E:/owned.png");
    const change = vi
      .spyOn(desktopApi, "importArtwork")
      .mockImplementation(async (port, slot, _path, revision) =>
        artworkState(port, slot, revision + 1, true),
      );
    const reset = vi
      .spyOn(desktopApi, "resetArtwork")
      .mockImplementation(async (port, slot, revision) =>
        artworkState(port, slot, revision + 1),
      );
    await render();
    await open();
    expect(container.textContent).not.toContain("SteamGridDB");
    await click("cover", "Choose local image");
    expect(change).toHaveBeenLastCalledWith(
      "sample",
      "cover",
      "E:/owned.png",
      0,
      7,
    );
    expect(container.querySelector("img")?.alt).toBe("");
    expect(container.querySelector("h2")?.textContent).toContain(
      "unusually long",
    );
    expect(container.textContent).toContain("owned-image.png");
    expect(container.textContent).toContain(
      "Not provided with this local image.",
    );
    expect(document.activeElement).toBe(button("cover", "Choose local image"));
    await click("detail", "Choose local image");
    expect(change).toHaveBeenLastCalledWith(
      "sample",
      "detail",
      "E:/owned.png",
      0,
      7,
    );
    await click("cover", "Reset to default");
    expect(reset).toHaveBeenCalledWith("sample", "cover", 1, 7);
    expect(container.querySelector("img")).toBeNull();
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
          const details =
            container.querySelector<HTMLDetailsElement>(".artwork-controls")!;
          details.open = false;
          details.dispatchEvent(new Event("toggle"));
        });
      } else
        await render(
          kind === "port" ? "another" : "sample",
          kind === "library" ? 8 : 7,
        );
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
    expect(button("cover", "Reset to default").disabled).toBe(false);
    expect(container.querySelector("img")).toBeNull();
  });
});
