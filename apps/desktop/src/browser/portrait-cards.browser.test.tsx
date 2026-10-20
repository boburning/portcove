import { afterEach, expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";
import { act } from "react";
import { cleanup, render } from "vitest-browser-react/pure";
import { PortBrowser } from "../components/PortBrowser";
import { ArtworkProvider } from "../artwork";
import { desktopApi } from "../api";
import { artworkState, portDefinition, portStatus } from "../test-fixtures";
import { install } from "../dev-scenarios/interactive/scenarios";
import type { PortStatus, PortDefinition } from "../types";
import { useGamepadNavigation } from "../gamepad";
import { captureTargetScreenshot } from "./capture-target";

const names = [
  "Ready game",
  "Needs game files",
  "Held installation",
  "An unusually long game title with an extended edition name",
  "Missing artwork",
];
function presentation(
  title: string,
  variant?: string,
): NonNullable<PortDefinition["presentation"]> {
  return {
    original_game_title: title,
    ...(variant ? { variant_label: variant } : {}),
    installation_method: "portable-package",
    source_requirements: [],
    saves_and_settings: "portcove-managed",
  };
}
const ports = names.map((title, i) => ({
  ...portDefinition(),
  id: `portrait-${i}`,
  name:
    i === 3
      ? "A deliberately long fictional port project with a full descriptive name"
      : `Fictional Project ${i}`,
  presentation: presentation(
    title,
    i === 1
      ? "Fictional edition"
      : i === 3
        ? "Fictional prototype with a long edition label"
        : undefined,
  ),
}));
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

it.for([
  ["library", "dark"],
  ["library", "light"],
  ["catalog", "dark"],
  ["catalog", "light"],
] as const)(
  "measures actual mixed artwork and metadata in %s/%s",
  async ([view, theme], context) => {
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
      const projectRows = [
        ...document.querySelectorAll<HTMLElement>(
          view === "library" ? ".collection-project" : ".card-content > p[title]",
        ),
      ];
      expect(projectRows).toHaveLength(5);
      const variants = [...document.querySelectorAll<HTMLElement>(".card-variant")];
      const variantText =
        view === "catalog"
          ? variants.map((variant) => variant.textContent).join(" | ")
          : projectRows.map((row) => row.textContent).join(" | ");
      expect(variantText).toContain("Fictional edition");
      expect(variantText).toContain("Fictional prototype with a long edition label");
      for (const variant of variants) {
        expect(variant.scrollWidth).toBeLessThanOrEqual(variant.clientWidth + 1);
        expect(variant.scrollHeight).toBeLessThanOrEqual(variant.clientHeight + 1);
      }
      const alignmentErrors: number[] = [];
      if (width >= 1280) {
        const alignedRows = new Map<number, number>();
        for (const row of projectRows) {
          const artworkTop = Math.round(
            (view === "library"
              ? row.closest("article")!
              : row.parentElement!.previousElementSibling!
            ).getBoundingClientRect().top,
          );
          const projectTop =
            view === "library"
              ? row
                  .closest("article")!
                  .querySelector(".collection-actions")!
                  .getBoundingClientRect().bottom
              : row.getBoundingClientRect().top;
          if (!alignedRows.has(artworkTop)) alignedRows.set(artworkTop, projectTop);
          alignmentErrors.push(Math.abs(projectTop - alignedRows.get(artworkTop)!));
        }
      }
      expect(Math.max(0, ...alignmentErrors)).toBeLessThan(1);
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
        for (const action of card.querySelectorAll<HTMLElement>(
          ".collection-actions button, .card-content button",
        )) {
          if (action === favorite) continue;
          const a = favorite.getBoundingClientRect();
          const b = action.getBoundingClientRect();
          expect(
            a.right <= b.left || a.left >= b.right || a.bottom <= b.top || a.top >= b.bottom,
          ).toBe(true);
        }
      }
      await page.screenshot({
        path: `../../../../outputs/uiux-game-titles/after-${view}-${theme}-${width}-${frames[0]!.width}x${frames[0]!.height}-top.png`,
      });
      fallback.scrollIntoView({ block: "end" });
      await page.screenshot({
        path: `../../../../outputs/uiux-game-titles/after-${view}-${theme}-${width}-bottom.png`,
      });
      await captureTargetScreenshot(
        fallback,
        `../../../../outputs/uiux-game-titles/missing-art-${view}-${theme}-${width}.png`,
        "missing-art",
        context,
      );
      await captureTargetScreenshot(
        fallback.nextElementSibling!,
        `../../../../outputs/uiux-game-titles/missing-details-${view}-${theme}-${width}.png`,
        "missing-details",
        context,
      );
      await captureTargetScreenshot(
        document.querySelector(view === "library" ? ".collection-identity" : ".card-content")!,
        `../../../../outputs/uiux-game-titles/ready-details-${view}-${theme}-${width}.png`,
        "ready-details",
        context,
      );
      await screen.unmount();
    }
  },
);

it.for(["library", "catalog"] as const)(
  "reflows expanded and unbroken text in a large %s without shrinking artwork",
  async (view, context) => {
    await page.viewport(960, 640);
    document.documentElement.style.fontSize = "200%";
    const many = Array.from({ length: 100 }, (_, index) => ({
      ...portDefinition(),
      id: `large-${index}`,
      name: `Port${index}-${"LongUnbrokenEdition".repeat(8)}`,
      presentation: presentation(
        `Fictional Game ${index}-${"LongUnbrokenTitle".repeat(8)}`,
        "Fictional edition",
      ),
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
      for (const text of frame.nextElementSibling!.querySelectorAll<HTMLElement>(
        "h2 span, p[title] > span",
      )) {
        expect(text.scrollHeight).toBeLessThanOrEqual(text.clientHeight + 1);
      }
    }
    expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(960);
    (view === "library"
      ? frames[99]!.parentElement!.querySelector<HTMLElement>(".collection-title")!
      : frames[99]!.nextElementSibling!.querySelector<HTMLElement>("h2")!
    ).scrollIntoView();
    expect(window.scrollY).toBeGreaterThan(640);
    await page.screenshot({
      path: `../../../../outputs/uiux-game-titles/expanded-${view}-960.png`,
    });
    const metadata =
      view === "library" ? frames[99]!.parentElement! : frames[99]!.nextElementSibling!;
    const complete = () =>
      captureTargetScreenshot(
        metadata,
        `../../../../outputs/uiux-game-titles/expanded-${view}-960-metadata.png`,
        "expanded-metadata",
        context,
      );
    const oversized = metadata.getBoundingClientRect().height > innerHeight;
    const failure = await complete().then(
      () => null,
      (error: unknown) => (error instanceof Error ? error.message : String(error)),
    );
    expect(failure).toBe(
      oversized
        ? "Capture target exceeds viewport; capture identified title/actions instead"
        : null,
    );
    await captureTargetScreenshot(
      metadata.querySelector(view === "library" ? ".collection-title" : "h2")!,
      `../../../../outputs/uiux-game-titles/expanded-${view}-960-title.png`,
      "expanded-title",
      context,
    );
    await captureTargetScreenshot(
      view === "library"
        ? metadata.closest("article")!.querySelector(".collection-actions")!
        : metadata.lastElementChild!,
      `../../../../outputs/uiux-game-titles/expanded-${view}-960-actions.png`,
      "expanded-actions",
      context,
    );
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
    // At 1280px the shorter covers may keep all controls in view.
    // When they extend below the viewport, navigation must actually scroll.
    expect(document.documentElement.scrollHeight <= innerHeight || window.scrollY > 0).toBe(true);
    const first = document.querySelector<HTMLElement>(
      view === "library"
        ? '[data-detail-game-id="portrait-0"]'
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
