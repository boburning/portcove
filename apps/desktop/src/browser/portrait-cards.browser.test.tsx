import { afterEach, expect, it, vi } from "vite-plus/test";
import { page } from "vite-plus/test/browser";
import { cleanup, render } from "vitest-browser-react/pure";
import { PortBrowser } from "../components/PortBrowser";
import { ArtworkProvider } from "../artwork";
import { desktopApi } from "../api";
import { artworkState, portDefinition, portStatus } from "../test-fixtures";
import { install } from "../dev-scenarios/interactive/scenarios";
import type { PortStatus } from "../types";

const names = [
  "Ready game",
  "Needs game files",
  "Held installation",
  "An unusually long game title with an extended edition name",
  "Missing artwork",
];
const ports = names.map((name, i) => ({ ...portDefinition(), id: `portrait-${i}`, name }));
const statuses = new Map<string, PortStatus>(
  ports.map((port, i) => [
    port.id,
    {
      ...portStatus(),
      port_id: port.id,
      active: { ...install, port_id: port.id },
      readiness: {
        launchable: i !== 1 && i !== 2,
        pending_setup: false,
        blockers: i === 1 ? ["missing_source"] : i === 2 ? ["invalid_installation"] : [],
      },
    },
  ]),
);

afterEach(async () => {
  await cleanup();
  vi.restoreAllMocks();
  delete document.documentElement.dataset.theme;
  document.documentElement.style.removeProperty("font-size");
});

it.each([
  ["library", "dark"],
  ["library", "light"],
  ["catalog", "dark"],
  ["catalog", "light"],
] as const)("measures actual mixed artwork and metadata in %s/%s", async (view, theme) => {
  vi.spyOn(desktopApi, "artwork").mockImplementation(async (id, slot) =>
    artworkState(id, slot, 0, id !== "portrait-4"),
  );
  vi.spyOn(desktopApi, "artworkThumbnail").mockImplementation(async (id, _slot, revision) => {
    const canvas = document.createElement("canvas");
    canvas.width = id === "portrait-1" ? 600 : 200;
    canvas.height = id === "portrait-2" ? 200 : 300;
    const context = canvas.getContext("2d")!;
    context.fillStyle = "#536a7a";
    context.fillRect(0, 0, canvas.width, canvas.height);
    context.strokeStyle = "white";
    context.lineWidth = 8;
    context.strokeRect(4, 4, canvas.width - 8, canvas.height - 8);
    context.fillStyle = "white";
    context.font = "20px sans-serif";
    context.fillText("Fixture artwork", 20, 50);
    return {
      asset_sha256: "a".repeat(64),
      choice_revision: revision,
      png_base64: canvas.toDataURL("image/png").split(",")[1]!,
    };
  });
  document.documentElement.dataset.theme = theme;
  for (const [width, height] of [
    [960, 640],
    [1280, 800],
    [1600, 1000],
  ] as const) {
    await page.viewport(width, height);
    const screen = await render(
      <main style={{ padding: 24, marginInlineStart: 220 }}>
        <ArtworkProvider generation={1}>
          <PortBrowser
            view={view}
            ports={ports}
            statuses={statuses}
            overview={{ installed: 5, ready: 3, needsSetup: 2, staged: 0 }}
            filter="all"
            setFilter={() => {}}
            onSelect={() => {}}
            onContinue={() => {}}
            loading={false}
            favorites={{
              ids: new Set(["portrait-0"]),
              only: false,
              busy: false,
              toggle: vi.fn(async () => true),
              setOnly: vi.fn(),
              refresh: vi.fn(async () => true),
              failure: undefined,
            }}
          />
        </ArtworkProvider>
      </main>,
    );
    for (const frame of document.querySelectorAll<HTMLElement>(".card-art")) {
      frame.scrollIntoView();
      const imageExpected = frame !== document.querySelectorAll(".card-art")[4];
      await expect
        .poll(() =>
          imageExpected
            ? frame.querySelector("img")?.complete === true &&
              frame.querySelector("img")!.naturalWidth > 0
            : frame.dataset.artworkSource === "generated_fallback",
        )
        .toBe(true);
    }
    window.scrollTo(0, 0);
    await document.fonts.ready;
    const frames = [...document.querySelectorAll<HTMLElement>(".card-art")].map((element) => {
      const rect = element.getBoundingClientRect();
      return {
        width: rect.width,
        height: rect.height,
        metadataTop: element.nextElementSibling!.getBoundingClientRect().top,
        bottom: rect.bottom,
      };
    });
    console.log(JSON.stringify({ view, theme, viewport: [width, height], frames }));
    for (const frame of frames) {
      expect(frame.height / frame.width).toBeCloseTo(1.5, 2);
      expect(frame.metadataTop).toBeGreaterThanOrEqual(frame.bottom - 0.5);
    }
    expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(width);
    const fallback = document.querySelectorAll<HTMLElement>(".card-art")[4]!;
    expect(fallback.querySelector("img")).toBeNull();
    const palette = getComputedStyle(fallback).getPropertyValue("--art-color");
    const control = document.createElement("div");
    control.style.backgroundColor = palette;
    document.body.append(control);
    expect(getComputedStyle(fallback).backgroundColor).toBe(
      getComputedStyle(control).backgroundColor,
    );
    control.remove();
    for (const favorite of document.querySelectorAll<HTMLElement>('[aria-label^="Favorite "]')) {
      const card = favorite.closest("article") ?? favorite.parentElement!;
      expect(favorite.getBoundingClientRect().top).toBeGreaterThanOrEqual(
        card.querySelector(".card-art")!.getBoundingClientRect().bottom,
      );
      expect(favorite.closest("button button")).toBeNull();
      for (const action of card.querySelectorAll<HTMLElement>(".card-content button")) {
        const a = favorite.getBoundingClientRect();
        const b = action.getBoundingClientRect();
        expect(
          a.right <= b.left || a.left >= b.right || a.bottom <= b.top || a.top >= b.bottom,
        ).toBe(true);
      }
    }
    await page.screenshot({
      path: `../../../../outputs/slice5-cards/after-${view}-${theme}-${width}-${frames[0]!.width}x${frames[0]!.height}-top.png`,
    });
    fallback.scrollIntoView({ block: "end" });
    await page.screenshot({
      path: `../../../../outputs/slice5-cards/after-${view}-${theme}-${width}-bottom.png`,
    });
    await screen.unmount();
  }
});

it.each(["library", "catalog"] as const)(
  "reflows expanded and unbroken text in a large %s without shrinking artwork",
  async (view) => {
    await page.viewport(960, 640);
    document.documentElement.style.fontSize = "200%";
    const many = Array.from({ length: 100 }, (_, index) => ({
      ...portDefinition(),
      id: `large-${index}`,
      name: `Port${index}-${"LongUnbrokenEdition".repeat(8)}`,
    }));
    await render(
      <main style={{ padding: 24, marginInlineStart: 220 }}>
        <PortBrowser
          view={view}
          ports={many}
          statuses={new Map()}
          overview={{ installed: 100, ready: 0, needsSetup: 100, staged: 0 }}
          filter="all"
          setFilter={() => {}}
          onSelect={() => {}}
          loading={false}
        />
      </main>,
    );
    const frames = [...document.querySelectorAll<HTMLElement>(".card-art")];
    expect(frames).toHaveLength(100);
    for (const frame of frames) {
      const rect = frame.getBoundingClientRect();
      expect(rect.height / rect.width).toBeCloseTo(1.5, 2);
      expect(frame.nextElementSibling!.getBoundingClientRect().top).toBeGreaterThanOrEqual(
        rect.bottom - 0.5,
      );
    }
    expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(960);
    frames[99]!
      .nextElementSibling!.querySelector<HTMLElement>(view === "library" ? "button" : "h2")!
      .scrollIntoView();
    expect(window.scrollY).toBeGreaterThan(640);
    await page.screenshot({ path: `../../../../outputs/slice5-cards/expanded-${view}-960.png` });
  },
);
