import { afterEach, expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";
import { act } from "react";
import { cleanup, render } from "vitest-browser-react/pure";
import { PortBrowser } from "../components/PortBrowser";
import { ArtworkProvider } from "../artwork";
import { desktopApi } from "../api";
import { artworkState, portDefinition, portStatus } from "../test-fixtures";
import { install } from "../dev-scenarios/interactive/scenarios";
import type { PortStatus } from "../types";
import { useGamepadNavigation } from "../gamepad";

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
  vi.unstubAllGlobals();
  delete document.documentElement.dataset.theme;
  delete document.documentElement.dataset.inputMode;
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
    await page.screenshot({
      element: fallback,
      path: `../../../../outputs/slice5-cards/missing-art-${view}-${theme}-${width}.png`,
    });
    await page.screenshot({
      element: fallback.nextElementSibling!,
      path: `../../../../outputs/slice5-cards/missing-details-${view}-${theme}-${width}.png`,
    });
    await page.screenshot({
      element: document.querySelector(".card-content")!,
      path: `../../../../outputs/slice5-cards/ready-details-${view}-${theme}-${width}.png`,
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
    await page.screenshot({
      element: frames[99]!.nextElementSibling!,
      path: `../../../../outputs/slice5-cards/expanded-${view}-960-metadata.png`,
    });
    const metadata = frames[99]!.nextElementSibling!;
    await page.screenshot({
      element: metadata.querySelector("h2")!,
      path: `../../../../outputs/slice5-cards/expanded-${view}-960-title.png`,
    });
    await page.screenshot({
      element: metadata.lastElementChild!,
      path: `../../../../outputs/slice5-cards/expanded-${view}-960-actions.png`,
    });
  },
);

function NavigableCards({ view, onSelect }: { view: "library" | "catalog"; onSelect: () => void }) {
  useGamepadNavigation(() => {});
  const navigationPorts = ports.slice(0, 4);
  const ready = new Map(
    navigationPorts.map((port) => [
      port.id,
      {
        ...portStatus(),
        port_id: port.id,
        active: { ...install, port_id: port.id },
        readiness: { launchable: true, pending_setup: false, blockers: [] },
      },
    ]),
  );
  return (
    <main data-focus-region="workspace" style={{ padding: 24, marginInlineStart: 220 }}>
      <PortBrowser
        view={view}
        ports={navigationPorts}
        statuses={ready}
        overview={{ installed: 4, ready: 4, needsSetup: 0, staged: 0 }}
        filter="all"
        setFilter={() => {}}
        onSelect={onSelect}
        onContinue={() => {}}
        loading={false}
        favorites={{
          ids: new Set(),
          only: false,
          busy: false,
          toggle: vi.fn(async () => true),
          setOnly: vi.fn(),
          refresh: vi.fn(async () => true),
          failure: undefined,
        }}
      />
    </main>
  );
}

it.each([
  ["library", 960],
  ["catalog", 960],
  ["library", 1280],
  ["catalog", 1280],
] as const)(
  "traverses real %s portrait controls and activates once at %spx",
  async (view, width) => {
    await page.viewport(width, 640);
    const frame = async () => new Promise(requestAnimationFrame);
    const onSelect = vi.fn();
    await render(<NavigableCards view={view} onSelect={onSelect} />);
    await document.fonts.ready;
    const controls = [...document.querySelectorAll<HTMLElement>(".port-grid button")];
    expect(controls).toHaveLength(view === "library" ? 16 : 8);
    const edges = new Map<HTMLElement, Set<HTMLElement>>();
    // Exercise the real hook and its live geometry. This finite graph proves
    // reachability without prescribing cosmetic nearest-neighbor preferences.
    for (const origin of controls) {
      const targets = new Set<HTMLElement>();
      for (const key of ["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight"]) {
        await act(async () => {
          origin.focus();
          origin.dispatchEvent(
            new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true }),
          );
        });
        await frame();
        const target = document.activeElement;
        if (target instanceof HTMLElement && controls.includes(target)) targets.add(target);
        if (document.querySelector("[data-portcove-focus-scope]:not([data-closed])")) {
          await userEvent.keyboard("{Escape}");
        }
        await expect
          .poll(() => document.querySelector("[data-portcove-focus-scope]:not([data-closed])"))
          .toBeNull();
      }
      edges.set(origin, targets);
    }
    const reached = new Set<HTMLElement>([controls[0]!]);
    for (const origin of reached) for (const target of edges.get(origin) ?? []) reached.add(target);
    expect(reached.size).toBe(controls.length);
    expect(window.scrollY).toBeGreaterThan(0);
    const first = document.querySelector<HTMLElement>(
      view === "library"
        ? '[aria-label="View details for Ready game"]'
        : '[data-detail-origin="catalog:card:portrait-0"]',
    )!;
    first.focus();
    vi.spyOn(document, "hasFocus").mockReturnValue(true);
    const buttons = Array.from({ length: 17 }, () => ({
      pressed: false,
      touched: false,
      value: 0,
    }));
    vi.spyOn(navigator, "getGamepads").mockImplementation(() => [
      {
        id: "Owned injected controller",
        index: 0,
        mapping: "standard",
        axes: [0, 0],
        buttons,
      } as unknown as Gamepad,
    ]);
    await frame();
    expect(document.activeElement).toBe(first);
    buttons[0]!.pressed = true;
    buttons[0]!.value = 1;
    await frame();
    expect(onSelect).toHaveBeenCalledTimes(1);
    for (let held = 0; held < 30; held++) await frame();
    expect(onSelect).toHaveBeenCalledTimes(1);
    buttons[0]!.pressed = false;
    buttons[0]!.value = 0;
    await frame();
  },
);
