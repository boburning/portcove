import { captureParityState } from "../../test/parity-capture";
import { expectDisclosureAlignment } from "../../test/disclosure-alignment";
import { controlledAct as act } from "../../test/controlled-react-act";
import { render as renderComponent, cleanup, type RenderResult } from "vitest-browser-react";
import { StrictMode } from "react";

import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";
import { desktopApi } from "../api";
import { ArtworkProvider } from "../artwork";
import { catalogEntries } from "../features/browsing/catalog-entry";
import type { Perform } from "../features/operations/use-operation-state";
import * as picker from "../file-picker";
import { dismissActiveDialog, navigationScope } from "../focus";
import { artworkState, portDefinition } from "../test-fixtures";
import type {
  ArtworkState,
  PortListing,
  SteamGridDbCandidate,
  SteamGridDbKeyStatus,
} from "../types";
import { ArtworkControls, ArtworkImage, listingEvidenceText } from "./Artwork";
import { ListingDetailPanel } from "./ListingDetailPanel";
import { GameHero, GameHeroFramingPreview } from "./GameHero";
import { SteamGridDbPicker } from "./SteamGridDbPicker";

// Valid 1×1 PNG also used by artwork-refresh.browser.test.tsx. Decode failures
// are injected deliberately in the failure case, never by corrupt fixture bytes.
const thumbnailPng =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGMwnvn/PwAFmQLLFOU//QAAAABJRU5ErkJggg==";

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
      <ArtworkControls
        key={`${portId}:${generation}`}
        port={port}
        previewPort={{ ...port, name: "Displayed game identity" }}
        Preview={GameHeroFramingPreview}
        previewActions={{ wide: "Play", narrow: "Continue playing" }}
      />
    </ArtworkProvider>,
  );
}

async function open() {
  await page.getByRole("button", { name: "Change artwork", exact: true }).click();
}

async function closeArtwork() {
  const sheet = page.getByRole("dialog", { name: "Change artwork", exact: true });
  await sheet.getByRole("button", { name: "Close", exact: true }).click();
  await expect.element(sheet).not.toBeVisible();
  await expect.poll(() => container.querySelector('[aria-label="Cover image"]')).toBeNull();
}

const slotLabels = {
  cover: "Cover image",
  detail: "Background",
  landscape: "Wide cover",
  logo: "Logo",
} as const;

function button(slot: keyof typeof slotLabels, label: string) {
  const section = container.querySelector(`[aria-label="${slotLabels[slot]}"]`)!;
  return [...section.querySelectorAll("button")].find((item) => item.textContent === label)!;
}

async function selectSlot(slot: keyof typeof slotLabels) {
  const name = `${slotLabels[slot]}`;
  const selected = container.querySelector(
    '[aria-label="Artwork slot"] [role="tab"][aria-selected=true]',
  );
  if (selected?.textContent !== name) {
    await page.getByRole("tab", { name, exact: true }).click();
  }
}

async function click(slot: keyof typeof slotLabels, label: string) {
  await selectSlot(slot);
  await act(async () => button(slot, label).click());
}

async function confirmVisibility(
  slot: keyof typeof slotLabels,
  action: "Hide artwork" | "Use automatic",
) {
  await click(slot, action);
  await click(slot, "Apply");
}

const reviewedImage = { original_sha256: "a".repeat(64), png_base64: thumbnailPng };
const imageBinding = { preview_sha256: reviewedImage.original_sha256, framing: null };

async function applyImageReview(slot: keyof typeof slotLabels) {
  const confirmation = page.getByRole("form", { name: `Review ${slotLabels[slot]}`, exact: true });
  await confirmation.getByRole("button", { name: "Apply", exact: true }).click();
}

async function chooseAndApplyLocal(slot: "cover" | "landscape" | "logo") {
  await click(slot, "Choose local image");
  await applyImageReview(slot);
}

function expectUnmarkedPickerLists() {
  const lists = [...container.querySelectorAll<HTMLUListElement>(".steamgriddb-picker ul")];
  expect(lists).toHaveLength(1);
  for (const list of lists) {
    const style = getComputedStyle(list);
    expect(style.listStyleType).toBe("none");
    expect(parseFloat(style.paddingInlineStart)).toBe(0);
    for (const item of list.children) expect(getComputedStyle(item).listStyleType).toBe("none");
  }
}

function expectCandidateFrameRatio(author: string, ratio: number) {
  const frame = container.querySelector<HTMLElement>(
    `[aria-label^="Use image by ${author},"] > span`,
  );
  if (!frame) throw new Error("Expected the actual provider candidate preview frame");
  const bounds = frame.getBoundingClientRect();
  expect(bounds.width).toBeGreaterThan(0);
  expect(bounds.height).toBeGreaterThan(0);
  expect(bounds.width / bounds.height).toBeCloseTo(ratio, 1);
}

function expectArtworkDisclosureAlignment() {
  const visible = Array.from(
    container.querySelectorAll<HTMLElement>(".artwork-source > summary"),
  ).filter((summary) => !summary.closest("[hidden]"));
  expect(visible).toHaveLength(1);
  for (const summary of visible) expectDisclosureAlignment(summary);
}

function controlledArtworkVisibility() {
  let showArtwork: (() => void) | undefined;
  const observers = new Map<Element, () => void>();
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
        observers.set(target, showArtwork);
      }
      disconnect() {}
    },
  );
  return (target?: Element) => {
    const show = target ? observers.get(target) : showArtwork;
    if (!show) throw new Error("Artwork visibility target was not observed");
    show();
  };
}

beforeEach(async () => {
  container = document.createElement("div");
  document.body.append(container);
  root = await renderComponent(null, { container: document.body.appendChild(container) });
  vi.spyOn(desktopApi, "artwork").mockImplementation(async (port, slot) =>
    artworkState(port, slot),
  );
  vi.spyOn(desktopApi, "previewLocalArtwork").mockResolvedValue(reviewedImage);
  vi.spyOn(desktopApi, "previewSteamGridDbArtwork").mockResolvedValue(reviewedImage);
  vi.spyOn(desktopApi, "artworkThumbnail").mockImplementation(async (_port, _slot, revision) => ({
    asset_sha256: "a".repeat(64),
    choice_revision: revision,
    png_base64: thumbnailPng,
  }));
});

afterEach(async () => {
  await cleanup();
  container.remove();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  document.documentElement.removeAttribute("data-theme");
  await page.viewport(1280, 800);
});

describe("local artwork controls", () => {
  it.each(["cover", "landscape", "logo"] as const)(
    "reviews a local %s before writing its choice",
    async (slot) => {
      vi.mocked(picker.pickArtworkPath).mockResolvedValue("E:/owned.png");
      const save = vi
        .spyOn(desktopApi, "importArtwork")
        .mockResolvedValue(artworkState("sample", slot, 1, true));
      await render();
      await open();
      await click(slot, "Choose local image");
      const review = page.getByRole("form", { name: `Review ${slotLabels[slot]}`, exact: true });
      const preview = review.getByRole("img", { name: slotLabels[slot], exact: true });
      await expect.element(preview).toBeVisible();
      expect(getComputedStyle(preview.element()).objectFit).toBe("contain");
      expect(save).not.toHaveBeenCalled();
      await review.getByRole("button", { name: "Cancel", exact: true }).click();
      expect(save).not.toHaveBeenCalled();
      await expect.element(page.elementLocator(button(slot, "Choose local image"))).toHaveFocus();
      await chooseAndApplyLocal(slot);
      expect(save).toHaveBeenCalledExactlyOnceWith(
        "sample",
        slot,
        "E:/owned.png",
        0,
        7,
        imageBinding,
      );
    },
  );

  it("keeps controller Back in the artwork sheet and returns focus to Change artwork", async () => {
    await render();
    await open();
    const sheet = page.getByRole("dialog", { name: "Change artwork", exact: true });
    expect(navigationScope()).toBe(sheet.element());
    await act(async () => {
      expect(dismissActiveDialog()).toBe(true);
    });
    await expect.element(sheet).not.toBeVisible();
    await expect
      .element(page.getByRole("button", { name: "Change artwork", exact: true }))
      .toHaveFocus();
    expect(navigationScope()).toBe(document);
  });

  it("discards a pending file pick across a close and reopen before the native close event", async () => {
    let finish!: (path: string) => void;
    vi.mocked(picker.pickArtworkPath).mockReturnValue(new Promise((resolve) => (finish = resolve)));
    const importArtwork = vi.spyOn(desktopApi, "importArtwork");
    const preview = vi.spyOn(desktopApi, "previewLocalArtwork");
    await render();
    await open();
    await click("detail", "Choose local image");
    expect(picker.pickArtworkPath).toHaveBeenCalledOnce();

    const sheet = container.querySelector<HTMLDialogElement>(".artwork-sheet")!;
    const trigger = container.querySelector<HTMLButtonElement>("[data-artwork-editor-trigger]")!;
    await act(async () => {
      sheet.close();
      trigger.click();
      finish("E:/closed-sheet.png");
    });
    expect(sheet.open).toBe(true);
    expect(importArtwork).not.toHaveBeenCalled();
    expect(preview).not.toHaveBeenCalled();
    await expect
      .element(page.getByRole("tab", { name: "Cover image", exact: true }))
      .toHaveAttribute("aria-selected", "true");
    expect(container.textContent).not.toContain("Review Background");
  });

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
    expect(container.querySelector('[aria-label="Background"]')).toBeNull();
    expect(desktopApi.artwork).toHaveBeenCalledWith(listing.id, "cover", 7);
    expect(desktopApi.artwork).toHaveBeenCalledWith(listing.id, "detail", 7);
    container.querySelector<HTMLElement>(".artwork-sheet")!.scrollIntoView({ block: "start" });
    const coverControls = button("cover", "Choose local image").getBoundingClientRect();
    expect(coverControls.top).toBeGreaterThanOrEqual(0);
    expect(coverControls.bottom).toBeLessThanOrEqual(innerHeight);
    await page.viewport(420, 740);
    const detailSlot = page.getByRole("tab", { name: "Background", exact: true });
    await detailSlot.click();
    await expect.element(detailSlot).toHaveAttribute("aria-selected", "true");
    expect(button("detail", "Choose local image")).toBeDefined();
    await expect
      .element(page.elementLocator(button("cover", "Choose local image")))
      .not.toBeVisible();
    expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(421);
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
    expect(button("cover", "Use automatic").disabled).toBe(true);
    expect(button("cover", "Refresh artwork").disabled).toBe(false);
    await selectSlot("detail");
    expect(button("detail", "Choose local image").disabled).toBe(false);
    await selectSlot("cover");
    await captureParityState("artwork-retained-refresh-error-fixture");
    await click("cover", "Refresh artwork");
    expect(container.textContent).not.toContain("Showing previously loaded artwork.");
    expect(container.querySelector('[aria-label="Cover image"] [role="alert"]')).toBeNull();
    expect(button("cover", "Choose local image").disabled).toBe(false);
    expect(button("cover", "Use automatic").disabled).toBe(false);
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
      if (kind === "import") await chooseAndApplyLocal("cover");
      else await confirmVisibility("cover", "Use automatic");
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
      expect(button("cover", "Use automatic").disabled).toBe(kind === "reset");
      expect(button("cover", "Choose local image").disabled).toBe(false);
      expect(container.textContent).toContain(
        kind === "import" ? "Local image selected." : "Automatic artwork restored.",
      );
      expect(change).toHaveBeenCalledTimes(1);
    },
  );

  it("lets players cancel a hide and refuses a staged choice after its revision changes", async () => {
    let state = artworkState("sample", "cover", 1, true);
    vi.mocked(desktopApi.artwork).mockImplementation(async (port, slot) =>
      slot === "cover" ? state : artworkState(port, slot),
    );
    const hide = vi.spyOn(desktopApi, "suppressArtwork");
    const automatic = vi.spyOn(desktopApi, "resetArtwork");
    await render("sample", 7, "old-cover");
    await open();
    await click("cover", "Hide artwork");
    const review = page.getByRole("form", { name: "Review artwork change", exact: true });
    const heading = review.getByRole("heading", { name: "Review artwork change" });
    await expect.element(heading).toHaveFocus();
    await expect
      .element(heading)
      .toHaveAccessibleDescription("Hide artwork for this role. Other roles stay as they are.");
    expect(hide).not.toHaveBeenCalled();
    await review.getByRole("button", { name: "Cancel", exact: true }).click();
    await expect.element(review).not.toBeInTheDocument();
    await expect.element(page.elementLocator(button("cover", "Hide artwork"))).toHaveFocus();
    expect(hide).not.toHaveBeenCalled();

    await click("cover", "Use automatic");
    await expect
      .element(heading)
      .toHaveAccessibleDescription("Use the default artwork for this role when available.");
    expect(automatic).not.toHaveBeenCalled();
    state = artworkState("sample", "cover", 2, true);
    await render("sample", 7, "corrected-cover");
    await expect
      .element(
        review.getByText("This artwork choice changed. Cancel and review the current choice."),
      )
      .toBeVisible();
    await expect.element(review.getByRole("button", { name: "Apply", exact: true })).toBeDisabled();
    expect(automatic).not.toHaveBeenCalled();
  });

  it("restores focus to Use automatic after Hide commits during a catalog refresh", async () => {
    let state = artworkState("sample", "cover");
    vi.mocked(desktopApi.artwork).mockImplementation(async (port, slot) =>
      slot === "cover" ? state : artworkState(port, slot),
    );
    let finish!: (value: ArtworkState) => void;
    const hide = vi
      .spyOn(desktopApi, "suppressArtwork")
      .mockReturnValue(new Promise((resolve) => (finish = resolve)));
    await render("sample", 7, "old-cover");
    await open();
    await confirmVisibility("cover", "Hide artwork");
    expect(hide).toHaveBeenCalledExactlyOnceWith("sample", "cover", 0, 7);
    await render("sample", 7, "corrected-cover");
    await expect.element(page.elementLocator(button("cover", "Use automatic"))).toBeDisabled();
    state = artworkState("sample", "cover", 1);
    state.choice.suppressed = true;
    await act(async () => finish(state));
    await expect.element(page.elementLocator(button("cover", "Use automatic"))).toHaveFocus();
    expect(button("cover", "Hide artwork").disabled).toBe(true);
    expect(hide).toHaveBeenCalledTimes(1);
  });

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
    await chooseAndApplyLocal("cover");
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
    expect(button("cover", "Use automatic").disabled).toBe(false);
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
      png_base64: thumbnailPng,
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
    await confirmVisibility("cover", "Use automatic");
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
    expect(button("cover", "Use automatic").disabled).toBe(true);
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
      container.querySelector(".artwork-sheet")!.append(focus);
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
    await chooseAndApplyLocal("cover");
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
      if (kind === "import") await chooseAndApplyLocal("cover");
      else await confirmVisibility("cover", "Use automatic");
      await render("sample", 7, "corrected-cover");
      state = artworkState("sample", "cover", 5, true);
      await act(async () => reject(new Error("Choice changed; review the current image.")));
      expect(container.textContent).toContain("Choice changed; review the current image.");
      expect(container.textContent).toContain("owned-image.png");
      expect(container.textContent).not.toContain("Local image selected.");
      await captureParityState(`artwork-${kind}-rejected-fixture`);
      expect(button("cover", "Apply").disabled).toBe(true);
      await click("cover", "Cancel");
      expect(button("cover", "Choose local image").disabled).toBe(false);
      expect(button("cover", "Use automatic").disabled).toBe(false);
      change.mockResolvedValueOnce(artworkState("sample", "cover", 6, kind === "import"));
      if (kind === "import") await chooseAndApplyLocal("cover");
      else await confirmVisibility("cover", "Use automatic");
      expect(change).toHaveBeenLastCalledWith(
        "sample",
        "cover",
        ...(kind === "import" ? ["E:/owned.png", 5, 7, imageBinding] : [5, 7]),
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
    await chooseAndApplyLocal("cover");
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
      await chooseAndApplyLocal("cover");
      expect(change).toHaveBeenCalledTimes(1);
      if (kind === "close") {
        await closeArtwork();
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
      expect(currentButtons.find((item) => item.textContent === "Use automatic")?.disabled).toBe(
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
      png_base64: thumbnailPng,
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
    expect(button("cover", "Use automatic").disabled).toBe(true);
  });

  it.each([640, 900])(
    "selects and resets independent artwork slots at %ipx height",
    async (height) => {
      await page.viewport(1280, height);
      const saved = new Map<string, ArtworkState>();
      vi.mocked(desktopApi.artwork).mockImplementation(
        async (port, slot) => saved.get(`${port}:${slot}`) ?? artworkState(port, slot),
      );
      const save = (
        port: string,
        slot: ArtworkState["choice"]["slot"],
        revision: number,
        selected = false,
      ) => {
        const state = artworkState(port, slot, revision + 1, selected);
        saved.set(`${port}:${slot}`, state);
        return state;
      };
      const choose = vi.mocked(picker.pickArtworkPath).mockResolvedValue("E:/owned.png");
      const preview = vi.spyOn(desktopApi, "previewLocalArtwork").mockResolvedValue({
        original_sha256: "a".repeat(64),
        png_base64: thumbnailPng,
      });
      const change = vi
        .spyOn(desktopApi, "importArtwork")
        .mockImplementation(async (port, slot, _path, revision) =>
          save(port, slot, revision, true),
        );
      const reset = vi
        .spyOn(desktopApi, "resetArtwork")
        .mockImplementation(async (port, slot, revision) => save(port, slot, revision));
      const steamGridDbStatus = vi.spyOn(desktopApi, "steamGridDbKeyStatus");
      const steamGridDbSearch = vi.spyOn(desktopApi, "searchSteamGridDbGames");
      await render();
      await open();
      // Opening artwork never contacts SteamGridDB; only an explicit Find does.
      expect(steamGridDbStatus).not.toHaveBeenCalled();
      expect(steamGridDbSearch).not.toHaveBeenCalled();
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
      await chooseAndApplyLocal("cover");
      expect(change).toHaveBeenLastCalledWith(
        "sample",
        "cover",
        "E:/owned.png",
        0,
        7,
        imageBinding,
      );
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
      expect(preview).toHaveBeenLastCalledWith("sample", "E:/owned.png", 7);
      expect(change).toHaveBeenCalledTimes(1);
      const review = page.getByRole("form", { name: "Review Background", exact: true });
      await expect
        .element(review.getByRole("heading", { name: "Review Background" }))
        .toHaveFocus();
      const previews = container.querySelectorAll<HTMLElement>(".game-hero-framing-preview");
      expect([...previews].map((preview) => preview.inert)).toEqual([true, true]);
      expect(previews[0]?.querySelector(".game-hero-detail .detail-title")?.textContent).toContain(
        "Displayed game identity",
      );
      expect(
        previews[1]?.querySelector(".game-hero-continue .continue-actions")?.textContent,
      ).toContain("Continue playing");
      expect(previews[1]?.querySelector(".continue-details")?.textContent).toContain(
        "Game details",
      );
      await expect
        .element(review.getByRole("button", { name: "Continue playing", exact: true }))
        .not.toBeInTheDocument();
      const horizontal = review
        .getByRole("group", { name: "Narrow crop · Continue" })
        .getByRole("slider", { name: "Horizontal" });
      (horizontal.element() as HTMLInputElement).focus();
      await userEvent.keyboard("{End}");
      await expect.element(horizontal).toHaveAttribute("aria-valuetext", "100%");
      const wideImage = previews[0]?.querySelector<HTMLImageElement>(".game-hero-background img");
      const narrowImage = previews[1]?.querySelector<HTMLImageElement>(".game-hero-background img");
      if (!wideImage || !narrowImage) throw new Error("Both hero background layers must render");
      expect(getComputedStyle(wideImage).objectPosition).toBe("50% 35%");
      expect(getComputedStyle(narrowImage).objectPosition).toBe("100% 35%");
      expect(getComputedStyle(narrowImage).maskImage).not.toBe("none");
      await captureParityState("artwork-background-composition-fixture");
      await review.getByRole("button", { name: "Cancel", exact: true }).click();
      await expect.element(review).not.toBeInTheDocument();
      expect(change).toHaveBeenCalledTimes(1);
      await expect
        .element(page.elementLocator(button("detail", "Choose local image")))
        .toHaveFocus();
      await click("detail", "Choose local image");
      await expect.element(horizontal).toBeVisible();
      (horizontal.element() as HTMLInputElement).focus();
      await userEvent.keyboard("{End}");
      await review.getByRole("button", { name: "Apply", exact: true }).click();
      await vi.waitFor(() =>
        expect(change).toHaveBeenLastCalledWith("sample", "detail", "E:/owned.png", 0, 7, {
          preview_sha256: "a".repeat(64),
          framing: { version: "v1", wide: { x: 5000, y: 3500 }, narrow: { x: 10000, y: 3500 } },
        }),
      );
      await expect.element(review).not.toBeInTheDocument();
      await confirmVisibility("cover", "Use automatic");
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
      expect(choose).toHaveBeenCalledTimes(3);
      container.querySelector<HTMLElement>(".detail-artwork")!.scrollIntoView();
      await expect.poll(() => container.querySelector(".detail-artwork img")).not.toBeNull();
      expect(button("detail", "Use automatic").disabled).toBe(false);
      container.querySelector<HTMLElement>(".artwork-sheet")!.scrollIntoView({ block: "start" });
      expect(button("cover", "Use automatic").disabled).toBe(true);
      const resetControls = button("cover", "Use automatic").getBoundingClientRect();
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
        await closeArtwork();
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
    vi.spyOn(desktopApi, "previewLocalArtwork").mockRejectedValue(
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
    expect(button("cover", "Use automatic").disabled).toBe(false);
    expect(container.querySelector("img")).toBeNull();
    await expect
      .poll(() => container.querySelector(".artwork-image > span")?.textContent)
      .toBe("SF");
  });

  it.each(["cover-first", "detail-first"] as const)(
    "uses the core fallback if a validated local thumbnail cannot render (%s)",
    async (order) => {
      const showArtwork = controlledArtworkVisibility();
      vi.mocked(desktopApi.artwork).mockImplementation(async (port, slot) =>
        artworkState(port, slot, 2, true),
      );
      await render();
      const cover = container.querySelector<HTMLElement>(".artwork-image:not(.wide-artwork)")!;
      cover.scrollIntoView({ block: "center" });
      await open();
      await expect.poll(() => container.querySelector(".wide-artwork")).not.toBeNull();
      const detail = container.querySelector<HTMLElement>(".wide-artwork")!;
      const decodedImage = async (frame: HTMLElement) => {
        await expect
          .poll(() => {
            const image = frame.querySelector<HTMLImageElement>("img");
            return (
              frame.dataset.artworkSource === "local_import" &&
              Boolean(image?.complete && image.naturalWidth > 0 && image.naturalHeight > 0)
            );
          })
          .toBe(true);
        return frame.querySelector<HTMLImageElement>("img")!;
      };
      const first = order === "detail-first" ? detail : cover;
      await act(async () => showArtwork(first));
      await decodedImage(first);
      // A ready Detail preview must not satisfy Cover readiness or receive its error.
      expect(cover.querySelector("img") === null).toBe(order === "detail-first");
      await act(async () => {
        showArtwork(cover);
        showArtwork(detail);
      });
      const image = await decodedImage(cover);
      const detailImage = await decodedImage(detail);
      await act(async () => image.dispatchEvent(new Event("error")));
      await expect.poll(() => cover.dataset.artworkSource).toBe("generated_fallback");
      expect(getComputedStyle(cover).getPropertyValue("--art-color").trim()).toBe(
        getComputedStyle(document.documentElement).getPropertyValue("--color-art-green").trim(),
      );
      expect(cover.querySelector("img")).toBeNull();
      expect(cover.querySelector("span")?.textContent).toBe("SF");
      expect(cover.dataset.artworkSource).toBe("generated_fallback");
      expect(cover.textContent).toContain("Image unavailable");
      expect(container.textContent).toContain(
        "Generated fallback; the selected local image is not currently rendered.",
      );
      expect(container.textContent).toContain("f".repeat(64));
      expect(button("cover", "Use automatic").disabled).toBe(false);
      expect(detail.querySelector("img")).toBe(detailImage);
      expect(detailImage.complete && detailImage.naturalWidth > 0).toBe(true);
      expect(detail.dataset.artworkSource).toBe("local_import");
    },
  );
});

vi.mock("../file-picker", { spy: true });

describe("SteamGridDB picker", () => {
  function deferredStatus() {
    let resolve!: (value: SteamGridDbKeyStatus) => void;
    let reject!: (error: unknown) => void;
    const promise = new Promise<SteamGridDbKeyStatus>((accept, refuse) => {
      resolve = accept;
      reject = refuse;
    });
    return { promise, resolve, reject };
  }
  const candidate = (id: number) => ({
    id,
    role: "portrait_cover" as const,
    url: `https://cdn2.steamgriddb.com/grid/${id}.png`,
    thumb: `https://cdn2.steamgriddb.com/thumb/${id}.png`,
    mime: "image/png",
    width: 600,
    height: 900,
    style: "alternate",
    score: 1,
    author: { name: `Artist ${id}`, steam64: null },
  });
  const pixel = thumbnailPng;

  it.each([
    { theme: "dark", width: 960, height: 800, configured: true },
    { theme: "light", width: 430, height: 780, configured: false },
  ] as const)(
    "recovers unknown provider setup in actual $theme artwork controls at $width pixels",
    async ({ theme, width, height, configured }) => {
      await page.viewport(width, height);
      document.documentElement.dataset.theme = theme;
      const first = deferredStatus();
      const retry = deferredStatus();
      const read = vi
        .spyOn(desktopApi, "steamGridDbKeyStatus")
        .mockReturnValueOnce(first.promise)
        .mockReturnValueOnce(retry.promise);
      const search = vi.spyOn(desktopApi, "searchSteamGridDbGames");
      const list = vi.spyOn(desktopApi, "steamGridDbCandidates");
      const preview = vi.spyOn(desktopApi, "steamGridDbPreview");
      const choose = vi.spyOn(desktopApi, "chooseSteamGridDbArtwork");
      const diagnostic = `Controlled device setup read refused: C:\\Synthetic\\${"x".repeat(200)}\\store`;
      try {
        await render();
        await open();
        await click("cover", "Find on SteamGridDB");
        const panel = container.querySelector<HTMLElement>(".steamgriddb-picker")!;
        panel.scrollIntoView({ block: "center", inline: "nearest" });
        await expect.element(page.elementLocator(panel)).toHaveAttribute("aria-busy", "true");
        expect(panel.textContent).toContain("Checking SteamGridDB setup…");
        expect(panel.querySelector("form")).toBeNull();
        await captureParityState("steamgriddb-picker-setup-reading");
        await act(async () => first.reject(new Error(diagnostic)));
        await expect.element(page.elementLocator(panel)).toHaveAttribute("aria-busy", "false");
        expect(panel.textContent).toContain("Couldn't check SteamGridDB setup.");
        expect(panel.textContent).not.toContain("Checking SteamGridDB setup…");
        expect(panel.querySelector('[role="alert"]')?.textContent).toBe(diagnostic);
        expect(panel.querySelector("form")).toBeNull();
        const recovery = button("cover", "Check setup again");
        recovery.scrollIntoView({ block: "center", inline: "nearest" });
        const expectContainedRecovery = () => {
          const bounds = recovery.getBoundingClientRect();
          expect(bounds.top).toBeGreaterThanOrEqual(0);
          expect(bounds.bottom).toBeLessThanOrEqual(innerHeight);
          expect(panel.scrollWidth).toBeLessThanOrEqual(panel.clientWidth + 1);
          expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(innerWidth + 1);
        };
        expectContainedRecovery();
        await captureParityState("steamgriddb-picker-setup-refused");
        recovery.focus();
        await act(async () => {
          recovery.click();
          recovery.click();
        });
        expect(read.mock.calls).toEqual([[], []]);
        await expect.element(page.elementLocator(panel)).toHaveAttribute("aria-busy", "true");
        await expect.element(page.elementLocator(recovery)).toHaveAttribute("aria-busy", "true");
        expect(recovery.textContent).toBe("Check setup again");
        expect(panel.textContent?.split("Checking SteamGridDB setup…")).toHaveLength(2);
        expect(document.activeElement).toBe(recovery);
        expect(panel.querySelector("form")).toBeNull();
        expectContainedRecovery();
        await captureParityState("steamgriddb-picker-setup-retrying");
        await act(async () => retry.resolve({ configured }));
        await vi.waitFor(() =>
          expect(container.querySelector('.steamgriddb-picker[aria-busy="true"]')).toBeNull(),
        );
        const target = configured
          ? container.querySelector<HTMLInputElement>("#steamgriddb-search-cover")
          : container.querySelector<HTMLParagraphElement>('p[tabindex="-1"]');
        expect(target).not.toBeNull();
        await vi.waitFor(() => expect(document.activeElement).toBe(target));
        expect(container.querySelector('.steamgriddb-picker [role="alert"]')).toBeNull();
        expect(container.querySelectorAll("#steamgriddb-search-cover")).toHaveLength(
          configured ? 1 : 0,
        );
        expect(search).not.toHaveBeenCalled();
        expect(list).not.toHaveBeenCalled();
        expect(preview).not.toHaveBeenCalled();
        expect(choose).not.toHaveBeenCalled();
        target!.scrollIntoView({ block: "center", inline: "nearest" });
        expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(innerWidth + 1);
        await captureParityState("steamgriddb-picker-setup-recovered");
      } finally {
        first.resolve({ configured: false });
        retry.resolve({ configured: false });
      }
    },
  );

  it("keeps the current status read when StrictMode retires an older read", async () => {
    const retired = deferredStatus();
    const current = deferredStatus();
    const read = vi
      .spyOn(desktopApi, "steamGridDbKeyStatus")
      .mockReturnValueOnce(retired.promise)
      .mockReturnValueOnce(current.promise);
    const search = vi.spyOn(desktopApi, "searchSteamGridDbGames");
    try {
      await root.rerender(
        <StrictMode>
          <SteamGridDbPicker
            slot="cover"
            initialTerm="Replay Game"
            disabled={false}
            choose={vi.fn()}
          />
        </StrictMode>,
      );
      expect(read).toHaveBeenCalledTimes(2);
      await act(async () => current.resolve({ configured: true }));
      await vi.waitFor(() =>
        expect(container.querySelector("#steamgriddb-search-cover")).not.toBeNull(),
      );
      await act(async () => retired.reject(new Error("Retired key status refusal.")));
      expect(container.querySelector('[role="alert"]')).toBeNull();
      expect(container.querySelector<HTMLInputElement>("#steamgriddb-search-cover")?.value).toBe(
        "Replay Game",
      );
      expect(search).not.toHaveBeenCalled();
    } finally {
      retired.resolve({ configured: false });
      current.resolve({ configured: false });
    }
  });

  it("ignores an old status reply after its picker is replaced", async () => {
    const retired = deferredStatus();
    vi.spyOn(desktopApi, "steamGridDbKeyStatus")
      .mockReturnValueOnce(retired.promise)
      .mockResolvedValueOnce({ configured: false });
    try {
      await root.rerender(
        <SteamGridDbPicker slot="cover" initialTerm="Old Game" disabled={false} choose={vi.fn()} />,
      );
      await root.rerender(null);
      await root.rerender(
        <SteamGridDbPicker
          slot="cover"
          initialTerm="Current Game"
          disabled={false}
          choose={vi.fn()}
        />,
      );
      await vi.waitFor(() =>
        expect(container.textContent).toContain("add your own SteamGridDB API key"),
      );
      await act(async () => retired.resolve({ configured: true }));
      expect(container.querySelector("#steamgriddb-search-cover")).toBeNull();
      expect(container.querySelector('[role="alert"]')).toBeNull();
    } finally {
      retired.resolve({ configured: false });
    }
  });

  it("explains setup when no player key is saved and makes no lookup", async () => {
    vi.spyOn(desktopApi, "steamGridDbKeyStatus").mockResolvedValue({ configured: false });
    const search = vi.spyOn(desktopApi, "searchSteamGridDbGames");
    await render();
    await open();
    await click("cover", "Find on SteamGridDB");
    await vi.waitFor(() => expect(container.textContent).toContain("under Integrations"));
    expect(search).not.toHaveBeenCalled();
  });

  it("searches, previews locally, chooses by revision and credits the artist", async () => {
    await page.viewport(960, 800);
    document.documentElement.dataset.theme = "dark";
    vi.spyOn(desktopApi, "steamGridDbKeyStatus").mockResolvedValue({ configured: true });
    const search = vi
      .spyOn(desktopApi, "searchSteamGridDbGames")
      .mockResolvedValue([{ id: 42, name: "Example Game", verified: true }]);
    let deliverCandidates!: (images: SteamGridDbCandidate[]) => void;
    const pendingCandidates = new Promise<SteamGridDbCandidate[]>((resolve) => {
      deliverCandidates = resolve;
    });
    const list = vi.spyOn(desktopApi, "steamGridDbCandidates").mockReturnValue(pendingCandidates);
    const preview = vi
      .spyOn(desktopApi, "steamGridDbPreview")
      .mockResolvedValue({ png_base64: pixel });
    const chosen: ArtworkState = {
      ...artworkState("sample", "cover", 1, true),
      attribution: [
        {
          provider: "steamgriddb",
          asset_id: 3,
          game_id: 42,
          role: "portrait_cover",
          author_name: "Artist 3",
          author_steam64: null,
          source_url: "https://cdn2.steamgriddb.com/grid/3.png",
          fetched_at: 1789038047,
        },
      ],
    };
    const choose = vi.spyOn(desktopApi, "chooseSteamGridDbArtwork").mockResolvedValue(chosen);
    try {
      await render();
      await open();
      await click("cover", "Find on SteamGridDB");
      const input = await vi.waitFor(() => {
        const element = container.querySelector<HTMLInputElement>("#steamgriddb-search-cover");
        expect(element).not.toBeNull();
        return element!;
      });
      // The search starts from the port name.
      expect(input.value).toContain("unusually long game title");
      await click("cover", "Search");
      expect(search).toHaveBeenCalledWith(input.value);
      await vi.waitFor(() => expect(container.textContent).toContain("Example Game (verified)"));
      expectUnmarkedPickerLists();
      expectArtworkDisclosureAlignment();
      container.querySelector(".steamgriddb-picker")!.scrollIntoView({ block: "start" });
      await captureParityState("steamgriddb-game-matches");
      await click("cover", "Example Game (verified)");
      expect(list).toHaveBeenCalledWith(42, "portrait_cover");
      // Choosing a match removes the list; focus moves to the way back.
      await vi.waitFor(() => expect(document.activeElement?.textContent).toBe("Back to matches"));
      await expect
        .element(page.getByText("Contacting SteamGridDB…", { exact: true }))
        .toBeVisible();
      await captureParityState("steamgriddb-candidates-pending");
      await act(async () =>
        deliverCandidates(Array.from({ length: 14 }, (_, index) => candidate(index + 1))),
      );
      await vi.waitFor(() =>
        expect(container.querySelectorAll('[aria-label^="Use image by"]').length).toBe(12),
      );
      // Previews are local data URLs from Core, never remote image URLs.
      await vi.waitFor(() =>
        expect(container.querySelector<HTMLImageElement>(".steamgriddb-picker img")?.src).toMatch(
          /^data:image\/png;base64,/,
        ),
      );
      expect(preview).toHaveBeenCalledWith("https://cdn2.steamgriddb.com/thumb/1.png");
      expectUnmarkedPickerLists();
      expectCandidateFrameRatio("Artist 1", 2 / 3);
      container.querySelector(".steamgriddb-picker")!.scrollIntoView({ block: "start" });
      await captureParityState("steamgriddb-cover-candidates");
      await click("cover", "Show more images");
      expect(container.querySelectorAll('[aria-label^="Use image by"]').length).toBe(14);
      container
        .querySelector('[aria-label^="Use image by Artist 14,"]')!
        .scrollIntoView({ block: "nearest" });
      await captureParityState("steamgriddb-more-cover-candidates");
      vi.mocked(desktopApi.artwork).mockResolvedValue(chosen);
      await act(async () =>
        container
          .querySelector<HTMLButtonElement>('[aria-label^="Use image by Artist 3,"]')!
          .click(),
      );
      expect(choose).not.toHaveBeenCalled();
      await applyImageReview("cover");
      await vi.waitFor(() => expect(container.textContent).toContain("Image by Artist 3"));
      expect(choose).toHaveBeenCalledWith("sample", "cover", 42, 3, 0, 7, imageBinding);
      expect(container.querySelector(".steamgriddb-picker")).toBeNull();
      await vi.waitFor(() => expect(container.textContent).toContain("SteamGridDB image 3"));
      expect(
        [...container.querySelectorAll<HTMLAnchorElement>(".artwork-source a")].some(
          (link) => link.href === "https://www.steamgriddb.com/grid/3",
        ),
      ).toBe(true);
    } finally {
      deliverCandidates([]);
    }
  });

  it("keeps the current art and offers a retry when SteamGridDB slows Portcove down", async () => {
    await page.viewport(960, 800);
    document.documentElement.dataset.theme = "light";
    vi.spyOn(desktopApi, "steamGridDbKeyStatus").mockResolvedValue({ configured: true });
    const search = vi.spyOn(desktopApi, "searchSteamGridDbGames").mockRejectedValueOnce({
      code: "network",
      message: "SteamGridDB asked Portcove to slow down",
      details: { retry_after_seconds: "30" },
    });
    const choose = vi.spyOn(desktopApi, "chooseSteamGridDbArtwork");
    await render();
    await open();
    await click("cover", "Find on SteamGridDB");
    await vi.waitFor(() =>
      expect(container.querySelector("#steamgriddb-search-cover")).not.toBeNull(),
    );
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    try {
      await click("cover", "Search");
      await vi.waitFor(() => expect(container.textContent).toContain("Try again in 30 seconds."));
      expect(choose).not.toHaveBeenCalled();
      // SteamGridDB's retry guidance holds both Search and Try again.
      expect(button("cover", "Try again").disabled).toBe(true);
      expect(button("cover", "Search").disabled).toBe(true);
      await act(async () => {
        vi.advanceTimersByTime(30_001);
      });
      expect(button("cover", "Try again").disabled).toBe(false);
      expect(container.textContent).not.toContain("Try again in 30 seconds.");
      expect(container.querySelector('.steamgriddb-picker [role="alert"]')?.textContent).toBe(
        "SteamGridDB asked Portcove to slow down",
      );
    } finally {
      vi.useRealTimers();
    }
    container.querySelector(".steamgriddb-picker")!.scrollIntoView({ block: "start" });
    await captureParityState("steamgriddb-rate-limit-retry-available");
    search.mockResolvedValueOnce([]);
    await click("cover", "Try again");
    await vi.waitFor(() => expect(container.textContent).toContain("No SteamGridDB games matched"));
    await captureParityState("steamgriddb-no-matches");
  });

  it("keeps the provider pause through Back and resumes matching after the wait", async () => {
    await page.viewport(960, 800);
    document.documentElement.dataset.theme = "dark";
    vi.spyOn(desktopApi, "steamGridDbKeyStatus").mockResolvedValue({ configured: true });
    const search = vi.spyOn(desktopApi, "searchSteamGridDbGames").mockResolvedValue([
      { id: 83, name: "Paused Game", verified: false },
      { id: 84, name: "Other Game", verified: false },
    ]);
    const list = vi
      .spyOn(desktopApi, "steamGridDbCandidates")
      .mockRejectedValueOnce({
        code: "network",
        message: "SteamGridDB asked Portcove to slow down",
        details: { retry_after_seconds: "30" },
      })
      .mockResolvedValueOnce([candidate(831)]);
    vi.spyOn(desktopApi, "steamGridDbPreview").mockResolvedValue({ png_base64: pixel });
    const choose = vi.spyOn(desktopApi, "chooseSteamGridDbArtwork");
    await render();
    await open();
    await click("cover", "Find on SteamGridDB");
    await vi.waitFor(() =>
      expect(container.querySelector("#steamgriddb-search-cover")).not.toBeNull(),
    );
    await click("cover", "Search");
    await vi.waitFor(() => expect(button("cover", "Paused Game")).toBeDefined());
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    try {
      await click("cover", "Paused Game");
      await vi.waitFor(() => expect(container.textContent).toContain("Try again in 30 seconds."));
      await click("cover", "Back to matches");
      expect(document.activeElement).toBe(button("cover", "Paused Game"));
      expect(container.textContent).toContain("Try again in 30 seconds.");
      expect(button("cover", "Paused Game").getAttribute("aria-disabled")).toBe("true");
      expect(button("cover", "Other Game").getAttribute("aria-disabled")).toBe("true");
      expect(button("cover", "Search").disabled).toBe(true);
      expect(button("cover", "Try again").disabled).toBe(true);
      await click("cover", "Paused Game");
      await click("cover", "Other Game");
      await act(async () => {
        container
          .querySelector(".steamgriddb-picker form")!
          .dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
      });
      expect(search).toHaveBeenCalledTimes(1);
      expect(list.mock.calls).toEqual([[83, "portrait_cover"]]);
      await act(async () => {
        vi.advanceTimersByTime(15_000);
      });
      expect(button("cover", "Other Game").getAttribute("aria-disabled")).toBe("true");
      await act(async () => {
        vi.advanceTimersByTime(15_001);
      });
      expect(container.textContent).not.toContain("Try again in 30 seconds.");
      expect(button("cover", "Paused Game").disabled).toBe(false);
      expect(button("cover", "Other Game").disabled).toBe(false);
      expect(button("cover", "Search").disabled).toBe(false);
    } finally {
      vi.useRealTimers();
    }
    container.querySelector(".steamgriddb-picker")!.scrollIntoView({ block: "start" });
    await captureParityState("steamgriddb-rate-limit-back-resumed");
    await click("cover", "Other Game");
    await vi.waitFor(() =>
      expect(container.querySelector('[aria-label^="Use image by Artist 831,"]')).not.toBeNull(),
    );
    expect(list.mock.calls).toEqual([
      [83, "portrait_cover"],
      [84, "portrait_cover"],
    ]);
    expect(choose).not.toHaveBeenCalled();
  });

  it("does not refetch a failed preview when the same images are shown again", async () => {
    await page.viewport(430, 780);
    document.documentElement.dataset.theme = "light";
    vi.spyOn(desktopApi, "steamGridDbKeyStatus").mockResolvedValue({ configured: true });
    vi.spyOn(desktopApi, "searchSteamGridDbGames").mockResolvedValue([
      { id: 77, name: "Preview Game", verified: false },
    ]);
    vi.spyOn(desktopApi, "steamGridDbCandidates").mockResolvedValue([
      { ...candidate(901), thumb: "https://cdn2.steamgriddb.com/thumb/901-failing.png" },
    ]);
    const preview = vi
      .spyOn(desktopApi, "steamGridDbPreview")
      .mockRejectedValue({ code: "not_found", message: "this preview is no longer available" });
    await render();
    await open();
    await click("cover", "Find on SteamGridDB");
    await vi.waitFor(() =>
      expect(container.querySelector("#steamgriddb-search-cover")).not.toBeNull(),
    );
    await click("cover", "Search");
    await vi.waitFor(() => expect(container.textContent).toContain("Preview Game"));
    await click("cover", "Preview Game");
    await vi.waitFor(() => expect(container.textContent).toContain("Preview unavailable"));
    expect(preview).toHaveBeenCalledTimes(1);
    expectUnmarkedPickerLists();
    expectArtworkDisclosureAlignment();
    const oldDirection = document.documentElement.dir;
    const oldFontSize = document.documentElement.style.fontSize;
    try {
      document.documentElement.dir = "rtl";
      document.documentElement.style.fontSize = "20px";
      expectArtworkDisclosureAlignment();
    } finally {
      document.documentElement.dir = oldDirection;
      document.documentElement.style.fontSize = oldFontSize;
    }
    container.querySelector(".steamgriddb-picker")!.scrollIntoView({ block: "start" });
    expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(innerWidth + 1);
    await captureParityState("steamgriddb-preview-unavailable");
    await click("cover", "Back to matches");
    await vi.waitFor(() => expect(document.activeElement?.textContent).toBe("Preview Game"));
    await captureParityState("steamgriddb-return-to-matches");
    await click("cover", "Preview Game");
    await vi.waitFor(() => expect(container.textContent).toContain("Preview unavailable"));
    expect(preview).toHaveBeenCalledTimes(1);
  });

  it.each(["landscape", "detail"] as const)(
    "lists wide images for the %s slot in their own preview frames",
    async (slot) => {
      await page.viewport(960, 800);
      document.documentElement.dataset.theme = "dark";
      vi.spyOn(desktopApi, "steamGridDbKeyStatus").mockResolvedValue({ configured: true });
      vi.spyOn(desktopApi, "searchSteamGridDbGames").mockResolvedValue([
        { id: 55, name: "Wide Game", verified: false },
      ]);
      const list = vi.spyOn(desktopApi, "steamGridDbCandidates").mockResolvedValue([
        {
          ...candidate(701),
          role: slot === "landscape" ? "landscape_cover" : "hero_banner",
          width: slot === "landscape" ? 920 : 1920,
          height: slot === "landscape" ? 430 : 620,
          thumb: "https://cdn2.steamgriddb.com/thumb/701-wide.png",
        },
      ]);
      vi.spyOn(desktopApi, "steamGridDbPreview").mockResolvedValue({ png_base64: pixel });
      await render();
      await open();
      await page.getByRole("tab", { name: slotLabels[slot], exact: true }).click();
      expect(container.querySelector(`[aria-label="${slotLabels[slot]}"]`)?.textContent).toContain(
        slot === "landscape"
          ? "Steam uses it for the game's library capsule"
          : "Optional background for Overview and Continue",
      );
      await click(slot, "Find on SteamGridDB");
      await vi.waitFor(() =>
        expect(container.querySelector(`#steamgriddb-search-${slot}`)).not.toBeNull(),
      );
      await click(slot, "Search");
      await vi.waitFor(() => expect(container.textContent).toContain("Wide Game"));
      await click(slot, "Wide Game");
      expect(list).toHaveBeenCalledWith(
        55,
        slot === "landscape" ? "landscape_cover" : "hero_banner",
      );
      await vi.waitFor(() =>
        expect(
          container.querySelector('[aria-label^="Use image by Artist 701"] span')?.className,
        ).toContain(slot === "landscape" ? "aspect-[92/43]" : "aspect-[96/31]"),
      );
      expectUnmarkedPickerLists();
      expectCandidateFrameRatio("Artist 701", slot === "landscape" ? 92 / 43 : 96 / 31);
      container.querySelector(".steamgriddb-picker")!.scrollIntoView({ block: "start" });
      await captureParityState(`steamgriddb-${slot}-candidates`);
    },
  );
  it("returns to SteamGridDB results when cancelling Background review", async () => {
    vi.spyOn(desktopApi, "steamGridDbKeyStatus").mockResolvedValue({ configured: true });
    vi.spyOn(desktopApi, "searchSteamGridDbGames").mockResolvedValue([
      { id: 55, name: "Wide Game", verified: false },
    ]);
    vi.spyOn(desktopApi, "steamGridDbCandidates").mockResolvedValue([
      { ...candidate(701), role: "hero_banner", width: 920, height: 430 },
    ]);
    vi.spyOn(desktopApi, "steamGridDbPreview").mockResolvedValue({ png_base64: pixel });
    await render();
    await open();
    await click("detail", "Find on SteamGridDB");
    await click("detail", "Search");
    await click("detail", "Wide Game");
    let completePreview:
      | ((value: { original_sha256: string; png_base64: string }) => void)
      | undefined;
    const preview = vi.spyOn(desktopApi, "previewSteamGridDbArtwork").mockImplementation(
      () =>
        new Promise((resolve) => {
          completePreview = resolve;
        }),
    );
    const choose = vi.spyOn(desktopApi, "chooseSteamGridDbArtwork");
    const candidateControl = page.getByRole("button", { name: /^Use image by Artist 701/ });
    await candidateControl.click();
    await expect.element(page.getByRole("button", { name: "Search", exact: true })).toBeDisabled();
    await expect
      .element(page.getByRole("button", { name: "Back to matches", exact: true }))
      .toBeDisabled();
    if (!completePreview) throw new Error("Background preview did not start");
    const finishPreview = completePreview;
    await act(async () => finishPreview({ original_sha256: "b".repeat(64), png_base64: pixel }));
    const review = page.getByRole("form", { name: "Review Background", exact: true });
    await expect.element(review.getByText("SteamGridDB image by Artist 701")).toBeVisible();
    expect(preview).toHaveBeenCalledWith("sample", "detail", 55, 701, 7);
    expect(choose).not.toHaveBeenCalled();
    await review.getByRole("button", { name: "Cancel", exact: true }).click();
    await expect.element(review).not.toBeInTheDocument();
    expect(choose).not.toHaveBeenCalled();
    await expect.element(candidateControl).toBeVisible();
    await expect.element(candidateControl).toHaveFocus();

    preview.mockResolvedValue({ original_sha256: "b".repeat(64), png_base64: pixel });
    choose.mockResolvedValue(artworkState("sample", "detail", 1, true));
    await candidateControl.click();
    await review.getByRole("button", { name: "Apply", exact: true }).click();
    await vi.waitFor(() =>
      expect(choose).toHaveBeenCalledExactlyOnceWith("sample", "detail", 55, 701, 0, 7, {
        preview_sha256: "b".repeat(64),
        framing: null,
      }),
    );
    await expect.element(review).not.toBeInTheDocument();
  });
});

it("moves focus to the Logo tab without starting its read until activation", async () => {
  await render();
  await open();
  const cover = page.getByRole("tab", { name: "Cover image", exact: true });
  const logo = page.getByRole("tab", { name: "Logo", exact: true });
  await cover.click();
  const panelId = logo.element().getAttribute("aria-controls");
  expect(panelId && document.getElementById(panelId)?.getAttribute("role")).toBe("tabpanel");
  await userEvent.keyboard("{End}");
  await expect.element(logo).toHaveFocus();
  await expect.element(cover).toHaveAttribute("aria-selected", "true");
  expect(desktopApi.artwork).not.toHaveBeenCalledWith("sample", "logo", 7);
  await userEvent.keyboard("{Enter}");
  await expect.element(logo).toHaveAttribute("aria-selected", "true");
  await expect
    .poll(() => vi.mocked(desktopApi.artwork).mock.calls)
    .toContainEqual(["sample", "logo", 7]);
});

it("shows and resets a local Logo in Continue without changing the cover", async () => {
  const port = portDefinition();
  const cover = artworkState(port.id, "cover", 4, true);
  const canvas = document.createElement("canvas");
  canvas.width = 400;
  canvas.height = 100;
  const logoContext = canvas.getContext("2d")!;
  logoContext.fillStyle = "white";
  logoContext.font = "bold 64px sans-serif";
  logoContext.fillText("TEST LOGO", 8, 75);
  const logoBytes = canvas.toDataURL("image/png").split(",")[1]!;
  vi.mocked(desktopApi.artworkThumbnail).mockImplementation(async (_port, slot, revision) => ({
    asset_sha256: "a".repeat(64),
    choice_revision: revision,
    png_base64: slot === "logo" ? logoBytes : thumbnailPng,
  }));
  let logo = artworkState(port.id, "logo");
  vi.mocked(desktopApi.artwork).mockImplementation(async (id, slot) => {
    if (slot === "logo") return logo;
    if (slot === "cover") return cover;
    return artworkState(id, slot);
  });
  const choose = vi.spyOn(desktopApi, "importArtwork").mockImplementation(async () => {
    logo = artworkState(port.id, "logo", 1, true);
    return logo;
  });
  const reset = vi.spyOn(desktopApi, "resetArtwork").mockImplementation(async () => {
    logo = artworkState(port.id, "logo", 2);
    return logo;
  });
  vi.mocked(picker.pickArtworkPath).mockResolvedValue("D:/sample-logo.png");

  await root.rerender(
    <ArtworkProvider generation={7}>
      <GameHero port={port} variant="continue">
        <h1>{port.name}</h1>
      </GameHero>
      <ArtworkControls port={port} Preview={GameHeroFramingPreview} />
    </ArtworkProvider>,
  );
  await open();
  await page.getByRole("tab", { name: "Logo", exact: true }).click();
  await expect
    .element(page.getByRole("tab", { name: "Logo", exact: true }))
    .toHaveAttribute("aria-selected", "true");
  await vi.waitFor(() => expect(button("logo", "Choose local image").disabled).toBe(false));
  await chooseAndApplyLocal("logo");
  expect(choose).toHaveBeenCalledExactlyOnceWith(
    port.id,
    "logo",
    "D:/sample-logo.png",
    0,
    7,
    imageBinding,
  );
  await expect.element(page.getByRole("img", { name: "Selected logo preview" })).toBeVisible();
  await expect
    .poll(() => container.querySelector(".game-hero")?.getAttribute("data-hero-identity"))
    .toBe("logo");
  expect(container.querySelector(".game-hero h1")?.textContent).toBe(port.name);
  expect(container.querySelector('[aria-label="Logo"].artwork-slot')?.textContent).not.toContain(
    "not wider than tall",
  );

  await confirmVisibility("logo", "Use automatic");
  expect(reset).toHaveBeenCalledExactlyOnceWith(port.id, "logo", 1, 7);
  await expect
    .poll(() => container.querySelector(".game-hero")?.getAttribute("data-hero-identity"))
    .toBe("cover");
  await expect
    .element(page.getByRole("img", { name: "Selected logo preview" }))
    .not.toBeInTheDocument();
});

it("keeps a transparent Logo choice in Manage while Continue uses the cover", async () => {
  const port = portDefinition();
  const blank = document.createElement("canvas").toDataURL("image/png").split(",")[1]!;
  vi.mocked(desktopApi.artwork).mockImplementation(async (id, slot) =>
    artworkState(id, slot, 3, slot === "cover" || slot === "logo"),
  );
  vi.mocked(desktopApi.artworkThumbnail).mockImplementation(async (_port, slot, revision) => ({
    asset_sha256: "a".repeat(64),
    choice_revision: revision,
    png_base64: slot === "logo" ? blank : thumbnailPng,
  }));
  await root.rerender(
    <ArtworkProvider generation={7}>
      <GameHero port={port} variant="continue">
        <h1>{port.name}</h1>
      </GameHero>
      <ArtworkControls port={port} Preview={GameHeroFramingPreview} />
    </ArtworkProvider>,
  );
  await open();
  await page.getByRole("tab", { name: "Logo", exact: true }).click();
  await expect.element(page.getByRole("img", { name: "Selected logo preview" })).toBeVisible();
  await expect
    .poll(() => container.querySelector(".game-hero")?.getAttribute("data-hero-identity"))
    .toBe("cover");
  await expect.element(page.elementLocator(button("logo", "Use automatic"))).toBeEnabled();
});

it("uses the Logo provider role and restores focus to the saved logo control", async () => {
  const pngCandidate = {
    id: 818,
    role: "logo" as const,
    url: "https://cdn2.steamgriddb.com/logo/logo818.png",
    thumb: "https://cdn2.steamgriddb.com/thumb/logo818.png",
    mime: "image/png",
    width: 320,
    height: 155,
    style: "custom",
    score: 3,
    author: { name: "Logo artist", steam64: null },
  };
  vi.spyOn(desktopApi, "steamGridDbKeyStatus").mockResolvedValue({ configured: true });
  vi.spyOn(desktopApi, "searchSteamGridDbGames").mockResolvedValue([
    { id: 55, name: "Logo game", verified: true },
  ]);
  const candidates = vi
    .spyOn(desktopApi, "steamGridDbCandidates")
    .mockResolvedValue([pngCandidate]);
  vi.spyOn(desktopApi, "steamGridDbPreview").mockResolvedValue({ png_base64: thumbnailPng });
  const choose = vi
    .spyOn(desktopApi, "chooseSteamGridDbArtwork")
    .mockResolvedValue(artworkState("sample", "logo", 1, true));
  await render();
  await open();
  await page.getByRole("tab", { name: "Logo", exact: true }).click();
  await vi.waitFor(() => expect(button("logo", "Find on SteamGridDB").disabled).toBe(false));
  await click("logo", "Find on SteamGridDB");
  await vi.waitFor(() => expect(button("logo", "Search")).toBeDefined());
  await click("logo", "Search");
  await vi.waitFor(() => expect(button("logo", "Logo game")).toBeDefined());
  await click("logo", "Logo game");
  expect(candidates).toHaveBeenCalledExactlyOnceWith(55, "logo");
  await page.getByRole("button", { name: /^Use image by Logo artist/ }).click();
  expect(choose).not.toHaveBeenCalled();
  await applyImageReview("logo");
  expect(choose).toHaveBeenCalledExactlyOnceWith("sample", "logo", 55, 818, 0, 7, imageBinding);
  await expect.element(page.elementLocator(button("logo", "Choose local image"))).toHaveFocus();
});

it("states recorded SteamGridDB listing evidence, withdrawals and removals with their dates", () => {
  const at = (seconds: number) => new Date(seconds * 1000).toLocaleString();
  const evidence = (
    last_result: ArtworkState["provider_listing"][number]["last_result"],
    not_listed_since: number | null,
    withdrawn_at: number | null = null,
  ): ArtworkState["provider_listing"][number] => ({
    provider: "steamgriddb" as const,
    asset_id: 3,
    last_checked_at: 2_000_000,
    last_result,
    not_listed_since,
    withdrawn_at,
    withdrawal_signal: withdrawn_at === null ? null : "gone",
  });
  const next =
    "If SteamGridDB's image server reports it gone, or a check at least a day later still finds it missing, Portcove removes its copy unless you imported this image yourself. Your choice and the credit are kept.";
  expect(listingEvidenceText(evidence({ status: "listed" }, null), false)).toBe(
    `Listed when last checked (${at(2_000_000)}).`,
  );
  expect(listingEvidenceText(evidence({ status: "not_listed" }, 1_000_000), false)).toBe(
    `Not in SteamGridDB's list when last checked (${at(2_000_000)}). First noticed ${at(1_000_000)}. ${next}`,
  );
  expect(
    listingEvidenceText(evidence({ status: "unknown", reason: "unavailable" }, 1_000_000), false),
  ).toBe(
    `Not confirmed when last checked (${at(2_000_000)}). First noticed missing ${at(1_000_000)}. ${next}`,
  );
  expect(
    listingEvidenceText(evidence({ status: "unknown", reason: "empty_listing" }, null), false),
  ).toBe(`Not confirmed when last checked (${at(2_000_000)}).`);
  expect(listingEvidenceText(evidence({ status: "not_listed" }, 1_000_000, 1_500_000), true)).toBe(
    `Removed from SteamGridDB (confirmed ${at(1_500_000)}). Portcove removed its copy; the credit is kept.`,
  );
  expect(listingEvidenceText(evidence({ status: "not_listed" }, 1_000_000, 1_500_000), false)).toBe(
    `Removed from SteamGridDB (confirmed ${at(1_500_000)}). Portcove kept its copy, because you imported this image yourself or another credit still lists it.`,
  );
  expect(listingEvidenceText(evidence({ status: "listed" }, null), true)).toBe(
    `Listed again when last checked (${at(2_000_000)}). Choose it again to restore Portcove's copy.`,
  );
});
