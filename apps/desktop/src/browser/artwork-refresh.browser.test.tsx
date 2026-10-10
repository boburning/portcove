import { DirectionProvider } from "@base-ui/react/direction-provider";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { page, userEvent } from "vitest/browser";
import { desktopApi } from "../api";
import { ArtworkProvider } from "../artwork";
import { ArtworkControls, ArtworkImage } from "../components/Artwork";
import { artworkState, portDefinition } from "../test-fixtures";
import "../styles.css";

vi.mock("../api", () => ({
  desktopApi: {
    artwork: vi.fn(),
    artworkThumbnail: vi.fn(),
    importArtwork: vi.fn(),
    resetArtwork: vi.fn(),
  },
}));

let root: Root;
let host: HTMLDivElement;
beforeEach(() => {
  host = document.body.appendChild(document.createElement("div"));
  root = createRoot(host);
  vi.resetAllMocks();
});
afterEach(() => {
  flushSync(() => root.unmount());
  host.remove();
});

it("retains a decoded cover with truthful stale feedback and read-only recovery", async () => {
  const port = portDefinition();
  const selected = artworkState(port.id, "cover", 1, true);
  vi.mocked(desktopApi.artwork).mockImplementation(async (id, slot) =>
    slot === "cover" ? selected : artworkState(id, slot),
  );
  vi.mocked(desktopApi.artworkThumbnail).mockResolvedValue({
    asset_sha256: "a".repeat(64),
    choice_revision: 1,
    png_base64:
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGMwnvn/PwAFmQLLFOU//QAAAABJRU5ErkJggg==",
  });
  flushSync(() =>
    root.render(
      <DirectionProvider direction="ltr">
        <ArtworkProvider generation={7}>
          <h2>{port.name}</h2>
          <ArtworkImage port={port} />
          <ArtworkControls port={port} />
        </ArtworkProvider>
      </DirectionProvider>,
    ),
  );
  await expect.poll(() => host.querySelector<HTMLImageElement>("img")?.naturalWidth).toBe(1);
  await userEvent.click(page.getByText("Change artwork", { exact: true }));
  const cover = page.getByRole("region", { name: "Cover image", exact: true });
  const detail = page.getByRole("region", { name: "Detail image", exact: true });
  await expect.element(cover.getByRole("button", { name: "Reset to default" })).toBeEnabled();
  const src = host.querySelector<HTMLImageElement>("img")!.src;
  const reads = vi.mocked(desktopApi.artwork).mock.calls.length;
  vi.mocked(desktopApi.artwork).mockRejectedValueOnce(new Error("Artwork read unavailable."));
  await userEvent.click(cover.getByRole("button", { name: "Refresh artwork" }));
  await expect.element(cover.getByRole("alert")).toHaveTextContent("Artwork read unavailable.");
  await expect
    .element(
      cover.getByText("Showing previously loaded artwork. Refresh to check the current choice."),
    )
    .toBeVisible();
  await expect.element(page.getByText("Previously loaded artwork", { exact: true })).toBeVisible();
  expect(host.querySelector<HTMLImageElement>("img")?.src).toBe(src);
  expect(host.querySelector<HTMLImageElement>("img")?.naturalWidth).toBe(1);
  await expect.element(cover.getByRole("button", { name: "Choose local image" })).toBeDisabled();
  await expect.element(cover.getByRole("button", { name: "Reset to default" })).toBeDisabled();
  await expect.element(detail.getByRole("button", { name: "Choose local image" })).toBeEnabled();
  await userEvent.click(cover.getByRole("button", { name: "Refresh artwork" }));
  await expect.element(cover.getByRole("button", { name: "Reset to default" })).toBeEnabled();
  await expect.element(cover.getByRole("alert")).not.toBeInTheDocument();
  expect(host.textContent).not.toContain("Showing previously loaded artwork.");
  expect(vi.mocked(desktopApi.artwork).mock.calls.length).toBe(reads + 2);
  expect(desktopApi.importArtwork).not.toHaveBeenCalled();
  expect(desktopApi.resetArtwork).not.toHaveBeenCalled();
});
