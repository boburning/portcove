import {
  inspectDiscoverGroups,
  mountDiscoverPort,
  inspectLibraryGroups,
  mountLibraryPort,
} from "./discover-test-helpers";
import { afterEach, expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";
import { act, useState } from "react";
import { cleanup, render } from "vitest-browser-react/pure";
import App from "../App";
import { GameHero } from "../components/GameHero";
import { PortBrowser } from "../components/PortBrowser";
import { ArtworkProvider } from "../artwork";
import { desktopApi } from "../api";
import { artworkState, portDefinition, portStatus } from "../test-fixtures";
import { install, workspace } from "../dev-scenarios/interactive/scenarios";
import { installInteractiveTransport } from "../dev-scenarios/interactive/transport";
import { initializeLocalization, LocalizationProvider } from "../localization";
import type { PortStatus, PortDefinition } from "../types";
import { useGamepadNavigation } from "../gamepad";
import { captureTargetScreenshot } from "./capture-target";
import { captureParityState } from "../../test/parity-capture";

let transport: ReturnType<typeof installInteractiveTransport> | undefined;

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
  transport?.dispose();
  transport = undefined;
  document.getElementById("root")?.remove();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  delete document.documentElement.dataset.theme;
  delete document.documentElement.dataset.inputMode;
  document.documentElement.style.removeProperty("font-size");
  localStorage.clear();
});

async function expectContainedOriginals(frame: HTMLElement, count: number) {
  await expect
    .poll(
      () =>
        [...frame.querySelectorAll("img")].filter(
          (image) => image.complete && image.naturalWidth > 0,
        ).length,
    )
    .toBe(count);
  const bounds = frame.getBoundingClientRect();
  expect(bounds.width).toBeGreaterThan(0);
  expect(bounds.height).toBeGreaterThan(0);
  for (const image of frame.querySelectorAll("img")) {
    const box = image.getBoundingClientRect();
    const evidence = JSON.stringify({
      frame: { x: bounds.x, y: bounds.y, width: bounds.width, height: bounds.height },
      image: { x: box.x, y: box.y, width: box.width, height: box.height },
    });
    expect(box.left, evidence).toBeGreaterThanOrEqual(bounds.left - 1);
    expect(box.right, evidence).toBeLessThanOrEqual(bounds.right + 1);
    expect(box.top, evidence).toBeGreaterThanOrEqual(bounds.top - 1);
    expect(box.bottom, evidence).toBeLessThanOrEqual(bounds.bottom + 1);
  }
}

it.for(["paired", "unavailable", "local"] as const)(
  "renders a combined Discover entry with %s covers",
  async (mode) => {
    const mapping = {
      game_id: 1,
      cover_id: 1,
      image_id: "firstcover",
      image_sha256: "b".repeat(64),
      game_slug: "first-cover",
      match_kind: "underlying-game" as const,
    };
    const companion = {
      ...mapping,
      game_id: 2,
      cover_id: 2,
      image_id: "secondcover",
      image_sha256: "c".repeat(64),
      game_slug: "second-cover",
    };
    const port = {
      ...ports[0]!,
      presentation: {
        ...ports[0]!.presentation,
        artwork: mapping,
        companion_cover: companion,
      },
    };
    const primaryId = "a".repeat(64);
    const choice = artworkState(port.id, "cover", 3, mode === "local");
    vi.spyOn(desktopApi, "artwork").mockResolvedValue({
      ...choice,
      availability: "available",
      resolved_source:
        mode === "local"
          ? choice.resolved_source
          : {
              kind: "igdb_cover",
              cache_id: primaryId,
              artwork: mapping,
            },
    });
    const thumbnail = (sha256: string) => {
      const canvas = document.createElement("canvas");
      canvas.width = 160;
      canvas.height = 200;
      const ink = canvas.getContext("2d")!;
      ink.fillStyle = sha256 === primaryId ? "#536a7a" : "#a43232";
      ink.fillRect(0, 0, 160, 200);
      return {
        asset_sha256: sha256,
        choice_revision: 3,
        png_base64: canvas.toDataURL("image/png").split(",")[1]!,
      };
    };
    vi.spyOn(desktopApi, "artworkThumbnail").mockResolvedValue(thumbnail(primaryId));
    const loadCompanion = vi.spyOn(desktopApi, "companionCoverThumbnail");
    if (mode === "unavailable") loadCompanion.mockRejectedValue(new Error("Offline"));
    else loadCompanion.mockResolvedValue(thumbnail(companion.image_sha256));
    await page.viewport(960, 640);
    await render(
      <ArtworkProvider generation={1}>
        <PortBrowser
          view="catalog"
          ports={[port]}
          statuses={new Map()}
          libraryCount={0}
          overview={{ installed: 0, ready: 0, needsSetup: 0, staged: 0 }}
          filter="all"
          setFilter={() => {}}
          onSelect={() => {}}
          onContinue={() => {}}
          loading={false}
        />
      </ArtworkProvider>,
    );
    const frame = document.querySelector<HTMLElement>(".collection-art")!;
    frame.scrollIntoView();
    const pictures = () => Array.from(frame.querySelectorAll("img"));
    await expect
      .poll(() => pictures().filter((image) => image.naturalWidth > 0).length)
      .toBe(mode === "paired" ? 2 : 1);
    await expect
      .poll(() => loadCompanion.mock.calls)
      .toEqual(mode === "local" ? [] : [[port.id, primaryId, companion.image_sha256, 3, 1]]);
    expect(frame.dataset.artworkSource).toBe(mode === "local" ? "local_import" : "igdb_cover");
    expect(Boolean(frame.querySelector("[data-companion-cover]"))).toBe(mode === "paired");
    const [left, right] = pictures().map((image) => image.getBoundingClientRect());
    const staggered = Boolean(
      left &&
      right &&
      left.right < right.left &&
      left.top < right.top &&
      Math.abs(left.width - right.width) < 1,
    );
    expect(staggered).toBe(mode === "paired");
    await expectContainedOriginals(frame, mode === "paired" ? 2 : 1);
  },
);

// CI40745384613/a1 macOS producer123018113028 reached the15s case
// deadline while these complete multi-step observations were progressing.
// Preserve every interaction, assertion, matrix row and cleanup; calibrate only
// this test-family safeguard to45s, without changing product deadlines.
it.for([
  ["library", "dark"],
  ["library", "light"],
  ["catalog", "dark"],
  ["catalog", "light"],
] as const)(
  "measures actual mixed artwork and metadata in %s/%s",
  { timeout: 45_000 },
  async ([view, theme], context) => {
    vi.spyOn(desktopApi, "artwork").mockImplementation(async (id, slot) =>
      artworkState(id, slot, 0, id !== "portrait-4"),
    );
    vi.spyOn(desktopApi, "artworkThumbnail").mockImplementation(async (id, _slot, revision) => {
      const canvas = document.createElement("canvas");
      canvas.width = id === "portrait-1" ? 600 : 200;
      canvas.height = id === "portrait-2" ? 200 : 300;
      const context = canvas.getContext("2d")!;
      // Actual source dimensions and alpha: padded square logo and transparent
      // portrait diagnostic, alongside ordinary portrait and landscape inputs.
      context.fillStyle = id === "portrait-2" ? "black" : "#536a7a";
      if (id !== "portrait-3") context.fillRect(0, 0, canvas.width, canvas.height);
      context.strokeStyle = "white";
      context.lineWidth = 8;
      if (id !== "portrait-2") context.strokeRect(4, 4, canvas.width - 8, canvas.height - 8);
      context.fillStyle = "white";
      context.font = "20px sans-serif";
      context.fillText(
        id === "portrait-2" ? "Test logo" : "Fixture artwork",
        20,
        id === "portrait-2" ? 100 : 50,
      );
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
              libraryCount={5}
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
                setPorts: vi.fn(async () => true),
                setOnly: vi.fn(),
                refresh: vi.fn(async () => true),
                failure: undefined,
              }}
            />
          </ArtworkProvider>
        </main>,
      );
      const mountedFrames = [...document.querySelectorAll<HTMLElement>(".collection-art")];
      for (const [index, frame] of mountedFrames.entries()) {
        frame.scrollIntoView({ block: "center", behavior: "instant" });
        await expect
          .poll(
            () => {
              const image = frame.querySelector("img");
              return {
                frame: index + 1,
                source: frame.dataset.artworkSource,
                complete: image?.complete,
                width: image?.naturalWidth,
                decoded: image?.complete === true && image.naturalWidth > 0,
              };
            },
            { timeout: 5_000 },
          )
          .toMatchObject(index === 4 ? { source: "generated_fallback" } : { decoded: true });
      }
      // Exercise neutral layout measurement after a card was hovered.
      if (view === "library") {
        const identity = document.querySelectorAll<HTMLElement>(".collection-identity").item(4);
        await userEvent.hover(identity);
      }
      window.scrollTo(0, 0);
      await document.fonts.ready;
      const { frames, fallback } = await assertPortraitLayout(view, theme, width, height);
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
        document.querySelector(
          view === "library" ? ".collection-identity" : ".discover-game-identity",
        )!,
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
          libraryCount={100}
          overview={{ installed: 100, ready: 0, needsSetup: 100, staged: 0 }}
          filter="all"
          setFilter={() => {}}
          onSelect={() => {}}
          loading={false}
        />
      </main>,
    );
    await userEvent.keyboard("{Tab}");
    const inspectFrame = (frame: HTMLElement) => {
      const rect = frame.getBoundingClientRect();
      expect(rect.height / rect.width).toBeCloseTo(1.5, 2);
      const identity = frame.closest<HTMLElement>(".collection-identity, .discover-game-identity")!;
      const title = identity.querySelector<HTMLElement>(".collection-title")!;
      const titleBounds = title.getBoundingClientRect();
      const horizontal = view === "library" && matchMedia("(height <= 50rem)").matches;
      expect(titleBounds.top).toBeGreaterThanOrEqual((horizontal ? rect.top : rect.bottom) - 0.5);
      expect(
        !horizontal || (titleBounds.left >= rect.right && titleBounds.top < rect.bottom),
        JSON.stringify({ horizontal, artwork: rect, title: titleBounds }),
      ).toBe(true);
      identity.focus();
      for (const text of identity.querySelectorAll<HTMLElement>(
        ".collection-title, .collection-project",
      )) {
        expect(text.scrollHeight).toBeLessThanOrEqual(text.clientHeight + 1);
      }
      identity.blur();
    };
    const inspectLibraryFrames = async () => {
      expect(document.querySelectorAll(".collection-art").length).toBeLessThan(100);
      await inspectLibraryGroups(
        many.map((port) => [port.id]),
        (card) => inspectFrame(card.querySelector<HTMLElement>(".collection-art")!),
      );
    };
    if (view === "catalog") {
      await inspectDiscoverGroups(
        many.map(({ id }) => [id]),
        (card) => inspectFrame(card.querySelector<HTMLElement>(".collection-art")!),
      );
    } else await inspectLibraryFrames();
    const lastFrame =
      view === "catalog"
        ? (await mountDiscoverPort("large-99")).querySelector<HTMLElement>(".collection-art")!
        : (await mountLibraryPort("large-99")).querySelector<HTMLElement>(".collection-art")!;
    expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(960);
    lastFrame
      .closest(".collection-identity, .discover-game-identity")!
      .querySelector<HTMLElement>(".collection-title")!
      .scrollIntoView();
    expect(window.scrollY).toBeGreaterThan(640);
    await page.screenshot({
      path: `../../../../outputs/uiux-game-titles/expanded-${view}-960.png`,
    });
    const metadata = lastFrame.closest<HTMLElement>(
      ".collection-identity, .discover-game-identity",
    )!;
    metadata.focus();
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
    const title = metadata.querySelector<HTMLElement>(".collection-title")!;
    const fullTitle = many[99]!.presentation.original_game_title;
    expect(title.textContent).toBe(fullTitle);
    await expect.element(title).toHaveAccessibleName(fullTitle);
    expect(title.scrollWidth).toBeLessThanOrEqual(title.clientWidth + 1);
    const titleOversized = title.getBoundingClientRect().height > innerHeight;
    const titleFailure = await captureTargetScreenshot(
      title,
      `../../../../outputs/uiux-game-titles/expanded-${view}-960-title.png`,
      "expanded-title",
      context,
    ).then(
      () => null,
      (error: unknown) => (error instanceof Error ? error.message : String(error)),
    );
    expect(titleFailure).toBe(
      titleOversized
        ? "Capture target exceeds viewport; capture identified title/actions instead"
        : null,
    );
    await captureTargetScreenshot(
      view === "library"
        ? metadata.closest("article")!.querySelector(".collection-actions")!
        : metadata.closest("article")!.querySelector('[data-detail-origin$=":details"]')!
            .parentElement!,
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
        libraryCount={4}
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
          setPorts: vi.fn(async () => true),
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
    // Library exposes details, More, Favorite and its primary action; Catalog
    // exposes details, Favorite, primary action and comparison in this fixture.
    // Every displayed control stays in the navigation graph, including overlays.
    expect(controls).toHaveLength(16);
    window.scrollTo(0, 0);
    await frame();
    const initialControlBottom = Math.max(
      ...controls.map((control) => control.getBoundingClientRect().bottom + window.scrollY),
    );
    const navigationScrolls: { before: number; after: number }[] = [];
    const revealedTargets: { top: number; bottom: number; height: number }[] = [];
    const edges = new Map<HTMLElement, Set<HTMLElement>>();
    // Exercise the real hook and its live geometry. This finite graph proves
    // reachability without prescribing cosmetic nearest-neighbor preferences.
    for (const origin of controls) {
      const targets = new Set<HTMLElement>();
      for (const key of ["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight"]) {
        const beforeNavigation = window.scrollY;
        await act(async () => {
          // Only application navigation may reveal the target in this probe.
          origin.focus({ preventScroll: true });
          origin.dispatchEvent(
            new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true }),
          );
        });
        await frame();
        navigationScrolls.push({ before: beforeNavigation, after: window.scrollY });
        const target = document.activeElement;
        if (target instanceof HTMLElement && controls.includes(target)) {
          targets.add(target);
          if (target !== origin) {
            const bounds = target.getBoundingClientRect();
            revealedTargets.push({ top: bounds.top, bottom: bounds.bottom, height: bounds.height });
          }
        }
        if (document.querySelector("[data-portcove-focus-scope]:not([data-closed])")) {
          await userEvent.keyboard("{Escape}");
        }
        await expect
          .poll(() => document.querySelector("[data-portcove-focus-scope]:not([data-closed])"))
          .toBeNull();
      }
      edges.set(origin, targets);
    }
    expect(
      revealedTargets.filter(({ top, bottom, height }) =>
        height <= innerHeight
          ? top < -1 || bottom > innerHeight + 1
          : bottom <= 0 || top >= innerHeight,
      ),
    ).toEqual([]);
    const reached = new Set<HTMLElement>([controls[0]!]);
    for (const origin of reached) for (const target of edges.get(origin) ?? []) reached.add(target);
    expect(reached.size).toBe(controls.length);
    // Padding can overflow while every control fits. Require scrolling when
    // controls need it, and retain earlier movement even if the last move returns home.
    expect(
      initialControlBottom <= innerHeight + 1 ||
        navigationScrolls.some(({ before, after }) => Math.abs(after - before) > 0.5),
      JSON.stringify({ initialControlBottom, viewportHeight: innerHeight, navigationScrolls }),
    ).toBe(true);
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

async function settlePortraitPointer() {
  await userEvent.hover(document.documentElement, { position: { x: 1, y: 1 } });
  await expect
    .poll(() => {
      const frames = [...document.querySelectorAll<HTMLElement>(".collection-art")];
      return (
        frames.length > 0 &&
        !document.querySelector(".collection-identity:hover, .discover-game-identity:hover") &&
        frames.every((frame) => getComputedStyle(frame).transform === "none")
      );
    })
    .toBe(true);
}

async function assertPortraitLayout(
  view: "library" | "catalog",
  theme: string,
  width: number,
  height: number,
) {
  await settlePortraitPointer();
  const frames = [...document.querySelectorAll<HTMLElement>(".collection-art")].map((element) => {
    const rect = element.getBoundingClientRect();
    return {
      width: rect.width,
      height: rect.height,
      metadataTop: element.nextElementSibling!.getBoundingClientRect().top,
      metadataLeft: element.nextElementSibling!.getBoundingClientRect().left,
      top: rect.top,
      right: rect.right,
      bottom: rect.bottom,
    };
  });
  console.log(JSON.stringify({ view, theme, viewport: [width, height], frames }));
  for (const frame of frames) {
    expect(frame.height / frame.width).toBeCloseTo(1.5, 2);
    const horizontal = view === "library" && matchMedia("(height <= 50rem)").matches;
    expect(frame.metadataTop).toBeGreaterThanOrEqual((horizontal ? frame.top : frame.bottom) - 0.5);
    expect(
      !horizontal || (frame.metadataLeft >= frame.right && frame.metadataTop < frame.bottom),
      JSON.stringify({ horizontal, frame }),
    ).toBe(true);
  }
  expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(width);
  const projectRows = [...document.querySelectorAll<HTMLElement>(".collection-project")];
  expect(projectRows).toHaveLength(5);
  const variants = projectRows;
  const variantText = projectRows.map((row) => row.textContent).join(" | ");
  expect(variantText).toContain("Fictional edition");
  expect(variantText).toContain("Fictional prototype with a long edition label");
  await userEvent.keyboard("{Tab}");
  for (const variant of variants) {
    const identity = variant.closest<HTMLElement>(".collection-identity, .discover-game-identity")!;
    identity.focus();
    expect(variant.scrollWidth).toBeLessThanOrEqual(variant.clientWidth + 1);
    expect(variant.scrollHeight).toBeLessThanOrEqual(variant.clientHeight + 1);
    identity.blur();
  }
  window.scrollTo(0, 0);
  // Keyboard traversal can leave the inherited pointer over a poster. Compare
  // resting rows after the intentional two-pixel hover lift has settled.
  await userEvent.hover(
    page
      .getByRole("group", {
        name: view === "library" ? "Library filters" : "Favorite games",
        exact: true,
      })
      .element(),
  );
  await expect
    .poll(() =>
      [...document.querySelectorAll(".collection-art")].every(
        (art) => getComputedStyle(art).transform === "none",
      ),
    )
    .toBe(true);
  const alignmentErrors: number[] = [];
  if (view === "library" && width >= 1280) {
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
          ? row.closest("article")!.querySelector(".collection-art")!.getBoundingClientRect().bottom
          : row.getBoundingClientRect().top;
      if (!alignedRows.has(artworkTop)) alignedRows.set(artworkTop, projectTop);
      alignmentErrors.push(Math.abs(projectTop - alignedRows.get(artworkTop)!));
    }
  }
  expect(Math.max(0, ...alignmentErrors)).toBeLessThan(1);
  const identitySpacing =
    view === "catalog"
      ? projectRows.map((project) => ({
          gap:
            project.getBoundingClientRect().top -
            project.parentElement!.querySelector("h2")!.getBoundingClientRect().bottom,
          maximumGap: parseFloat(getComputedStyle(project).fontSize) * 1.5,
        }))
      : [];
  expect(identitySpacing.filter(({ gap, maximumGap }) => gap < 0 || gap > maximumGap)).toEqual([]);
  const fallback = document.querySelectorAll<HTMLElement>(".collection-art")[4]!;
  expect(fallback.querySelector("img")).toBeNull();
  const illustration = fallback.querySelector("[data-cover-illustration] svg");
  expect(illustration?.getBoundingClientRect().width ?? 0).toBeGreaterThan(0);
  const palette = getComputedStyle(fallback).getPropertyValue(
    view === "library" ? "--color-bg-raised" : "--art-color",
  );
  const control = document.createElement("div");
  control.style.backgroundColor = palette;
  document.body.append(control);
  expect(getComputedStyle(fallback).backgroundColor).toBe(
    getComputedStyle(control).backgroundColor,
  );
  control.remove();
  for (const favorite of document.querySelectorAll<HTMLElement>(
    '.collection-art-action[aria-label^="Favorite "]',
  )) {
    const card = favorite.closest("article") ?? favorite.parentElement!;
    const art = card.querySelector(".collection-art")!.getBoundingClientRect();
    const favoriteBounds = favorite.getBoundingClientRect();
    expect(favoriteBounds.top).toBeGreaterThanOrEqual(art.top);
    expect(favoriteBounds.bottom).toBeLessThanOrEqual(art.bottom);
    expect(favoriteBounds.right).toBeLessThanOrEqual(art.right);
    expect(favoriteBounds.left).toBeGreaterThanOrEqual(art.left);
    expect(favorite.closest("button button")).toBeNull();
    for (const action of card.querySelectorAll<HTMLElement>(
      ".collection-actions button, .discover-game > div button",
    )) {
      if (action === favorite) continue;
      const a = favorite.getBoundingClientRect();
      const b = action.getBoundingClientRect();
      expect(a.right <= b.left || a.left >= b.right || a.bottom <= b.top || a.top >= b.bottom).toBe(
        true,
      );
    }
  }
  return { frames, fallback };
}

it.for([2, 4] as const)(
  "renders %s verified collection covers in Discover and Details",
  async (count, context) => {
    const port = { ...ports[0]!, id: "collection-preview", name: "Collection project" };
    const covers = Array.from({ length: count }, (_, index) => ({
      game_id: index + 1,
      cover_id: index + 1,
      image_id: `collection${index}`,
      image_sha256: (index + 1).toString(16).repeat(64),
      game_slug: `game-${index}`,
      match_kind: "underlying-game" as const,
    }));
    const listings = {
      format_version: 11,
      listings: [
        {
          id: port.id,
          name: port.name,
          summary: port.summary,
          project_url: port.project_url,
          platforms: [],
          availability: "packages" as const,
          collection_covers: covers,
        },
      ],
    };
    vi.spyOn(desktopApi, "artwork").mockResolvedValue(artworkState(port.id, "cover", 3));
    vi.spyOn(desktopApi, "collectionCoverThumbnail").mockImplementation(async (_id, sha256) => {
      const canvas = document.createElement("canvas");
      canvas.width = 144;
      canvas.height = 192;
      const ink = canvas.getContext("2d")!;
      ink.fillStyle = ["#a43232", "#536a7a", "#52784a", "#b48036"][
        Number.parseInt(sha256[0]!, 16) - 1
      ]!;
      ink.fillRect(0, 0, 144, 192);
      ink.fillStyle = "white";
      ink.font = "bold 18px sans-serif";
      ink.fillText(`GAME ${sha256[0]}`, 24, 70);
      return {
        asset_sha256: sha256,
        choice_revision: 3,
        png_base64: canvas.toDataURL("image/png").split(",")[1]!,
      };
    });
    const installed = new Map([
      [port.id, { ...portStatus(), port_id: port.id, active: { ...install, port_id: port.id } }],
    ]);
    function CollectionRoutes() {
      const [view, setView] = useState<"catalog" | "library" | "detail">("catalog");
      return (
        <ArtworkProvider generation={7} listings={listings}>
          <nav className="flex flex-wrap gap-2" aria-label="Collection preview routes">
            <button onClick={() => setView("catalog")}>Discover collection preview</button>
            <button onClick={() => setView("library")}>Library collection preview</button>
          </nav>
          {view === "detail" ? (
            <GameHero port={port} variant="detail">
              <h1>Collection project</h1>
            </GameHero>
          ) : (
            <PortBrowser
              view={view}
              ports={[port]}
              statuses={view === "library" ? installed : new Map<string, PortStatus>()}
              libraryCount={view === "library" ? 1 : 0}
              overview={{
                installed: view === "library" ? 1 : 0,
                ready: view === "library" ? 1 : 0,
                needsSetup: 0,
                staged: 0,
              }}
              filter="all"
              setFilter={() => {}}
              onSelect={() => setView("detail")}
              onContinue={() => {}}
              loading={false}
            />
          )}
        </ArtworkProvider>
      );
    }
    await page.viewport(960, 720);
    // App renders one workspace route at a time. Keep its shared artwork cache,
    // without stacking two virtual document scrollers above a separate Details.
    await render(<CollectionRoutes />);
    let frame = document.querySelector<HTMLElement>(".collection-art")!;
    frame.scrollIntoView();
    await expect.poll(() => frame.querySelectorAll("img").length).toBe(count);
    await expectContainedOriginals(frame, count);
    await page.getByRole("button", { name: "View port", exact: true }).click();
    await expect.poll(() => document.querySelector(".game-hero-detail")).not.toBeNull();
    await expect
      .poll(() => document.querySelectorAll(".game-hero-detail .game-hero-collection img").length)
      .toBe(count);
    await expectContainedOriginals(
      document.querySelector<HTMLElement>(".game-hero-detail .game-hero-collection")!,
      count,
    );
    await page.getByRole("button", { name: "Library collection preview", exact: true }).click();
    await expect
      .poll(() => document.querySelector("[data-virtual-collection=library]"))
      .not.toBeNull();
    await expect
      .poll(() => document.querySelectorAll(".port-card-library .collection-art img").length)
      .toBe(count);
    await expectContainedOriginals(
      document.querySelector<HTMLElement>(".port-card-library .collection-art")!,
      count,
    );
    await page.getByRole("button", { name: "Discover collection preview", exact: true }).click();
    await expect
      .poll(() => document.querySelector("[data-virtual-collection=catalog]"))
      .not.toBeNull();
    frame = document.querySelector<HTMLElement>(".collection-art")!;
    await expect.poll(() => frame.querySelectorAll("img").length).toBe(count);
    for (const img of frame.querySelectorAll("img")) {
      await expect.poll(() => img.naturalWidth).toBeGreaterThan(0);
      expect(getComputedStyle(img).objectFit).toBe("contain");
    }
    await expectContainedOriginals(frame, count);
    expect(frame.dataset.artworkSource).toBe("igdb_cover_collection");
    expect(desktopApi.collectionCoverThumbnail).toHaveBeenCalledTimes(count);
    for (const cover of covers)
      expect(desktopApi.collectionCoverThumbnail).toHaveBeenCalledWith(
        port.id,
        cover.image_sha256,
        3,
        7,
      );
    await settlePortraitPointer();
    await captureTargetScreenshot(
      frame,
      `../../../../outputs/uiux-game-titles/collection-${count}-wide.png`,
      `collection-${count}-wide`,
      context,
    );
    await page.viewport(390, 844);
    expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(390);
    await settlePortraitPointer();
    // Responsive virtual rows may replace the wide card. Capture its current
    // rendered artwork, after the same node survives the resize render frames.
    await expect
      .poll(async () => {
        const current = document.querySelector<HTMLElement>(".discover-game .collection-art");
        if (!current) return false;
        await act(async () => {
          await new Promise(requestAnimationFrame);
          await new Promise(requestAnimationFrame);
        });
        if (
          !current.isConnected ||
          current !== document.querySelector(".discover-game .collection-art")
        )
          return false;
        frame = current;
        return true;
      })
      .toBe(true);
    await expect.poll(() => frame.querySelectorAll("img").length).toBe(count);
    for (const img of frame.querySelectorAll("img")) {
      await expect.poll(() => img.naturalWidth).toBeGreaterThan(0);
      expect(getComputedStyle(img).objectFit).toBe("contain");
    }
    expect(frame.dataset.artworkSource).toBe("igdb_cover_collection");
    expect(desktopApi.collectionCoverThumbnail).toHaveBeenCalledTimes(count);
    await expectContainedOriginals(frame, count);
    await captureTargetScreenshot(
      frame,
      `../../../../outputs/uiux-game-titles/collection-${count}-narrow.png`,
      `collection-${count}-narrow`,
      context,
    );
    // The other narrow consumers must be observed while their route is active.
    await page.getByRole("button", { name: "View port", exact: true }).click();
    await expect
      .poll(() => document.querySelector(".game-hero-detail .game-hero-collection"))
      .not.toBeNull();
    const hero = document.querySelector<HTMLElement>(".game-hero-detail .game-hero-collection")!;
    await expectContainedOriginals(hero, count);
    await captureTargetScreenshot(
      hero,
      `../../../../outputs/uiux-game-titles/collection-${count}-narrow-hero.png`,
      `collection-${count}-narrow-hero`,
      context,
    );
    await page.getByRole("button", { name: "Library collection preview", exact: true }).click();
    await expect
      .poll(() => document.querySelector("[data-virtual-collection=library]"))
      .not.toBeNull();
    const library = document.querySelector<HTMLElement>(".port-card-library .collection-art")!;
    await expectContainedOriginals(library, count);
    expect(desktopApi.collectionCoverThumbnail).toHaveBeenCalledTimes(count);
    expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(390);
  },
);

it("contains both staggered originals in an actual narrow App hero and Library", async () => {
  const previousViewport = { width: innerWidth, height: innerHeight };
  try {
    await page.viewport(430, 780);
    initializeLocalization(["en"]);
    const snapshot = workspace("collection");
    const port = snapshot.catalog.ports[0]!;
    const covers = [1, 2].map((index) => ({
      game_id: index,
      cover_id: index,
      image_id: `paired-fixture-${index}`,
      image_sha256: index.toString().repeat(64),
      game_slug: `paired-fixture-${index}`,
      match_kind: "underlying-game" as const,
    }));
    port.presentation = { ...port.presentation!, collection_covers: covers };
    transport = installInteractiveTransport("collection", (message) => {
      throw new Error(message);
    });
    vi.spyOn(desktopApi, "workspaceSnapshot").mockResolvedValue(snapshot);
    vi.spyOn(desktopApi, "artwork").mockImplementation(async (id, slot) =>
      artworkState(id, slot, 3),
    );
    const thumbnails = vi
      .spyOn(desktopApi, "collectionCoverThumbnail")
      .mockImplementation(async (_id, digest) => {
        const canvas = document.createElement("canvas");
        canvas.width = 160;
        canvas.height = 240;
        const ink = canvas.getContext("2d")!;
        ink.fillStyle = digest === covers[0]!.image_sha256 ? "#9e443f" : "#536a7a";
        ink.fillRect(0, 0, canvas.width, canvas.height);
        ink.strokeStyle = "white";
        ink.lineWidth = 6;
        ink.strokeRect(4, 4, canvas.width - 8, canvas.height - 8);
        ink.fillStyle = "white";
        ink.font = "bold 16px sans-serif";
        ink.fillText("SYNTHETIC", 12, 105);
        ink.fillText(`MEMBER ${digest[0]}`, 12, 130);
        return {
          asset_sha256: digest,
          choice_revision: 3,
          png_base64: canvas.toDataURL("image/png").split(",")[1]!,
        };
      });
    const root = document.createElement("div");
    root.id = "root";
    document.body.append(root);
    await render(
      <LocalizationProvider api={desktopApi}>
        <App />
      </LocalizationProvider>,
      { container: root },
    );
    document.documentElement.dataset.theme = "dark";
    await expect
      .poll(() => document.querySelector("[data-virtual-collection=library]"))
      .not.toBeNull();
    // This exact title can begin outside the narrow Library's mounted window.
    await mountLibraryPort(port.id);
    const identity = document.querySelector<HTMLButtonElement>(
      `.collection-entry button[data-detail-game-id="${port.id}"]`,
    )!;
    const card = identity.closest<HTMLElement>(".collection-entry")!;
    const library = card.querySelector<HTMLElement>(".collection-art")!;
    library.scrollIntoView({ block: "center" });
    await expectContainedOriginals(library, 2);
    document.documentElement.dataset.theme = "dark";
    await captureParityState("paired-originals-narrow-library");
    await page.elementLocator(identity).click();
    await expect
      .poll(() => document.querySelector(".game-hero-detail .game-hero-collection"))
      .not.toBeNull();
    const hero = document.querySelector<HTMLElement>(".game-hero-detail .game-hero-collection")!;
    hero.scrollIntoView({ block: "center", inline: "nearest" });
    await expectContainedOriginals(hero, 2);
    const bounds = hero.getBoundingClientRect();
    expect(bounds.width).toBeCloseTo(288, 0);
    expect(bounds.height).toBeCloseTo(144, 0);
    expect(bounds.top).toBeGreaterThanOrEqual(0);
    expect(bounds.bottom).toBeLessThanOrEqual(innerHeight);
    expect(bounds.left).toBeGreaterThanOrEqual(0);
    expect(bounds.right).toBeLessThanOrEqual(innerWidth);
    const [first, second] = [...hero.querySelectorAll("img")].map((image) => {
      const box = image.getBoundingClientRect();
      expect(box.width / box.height).toBeCloseTo(image.naturalWidth / image.naturalHeight, 2);
      return box;
    });
    expect(first!.top).toBeLessThan(second!.top);
    expect(first!.right).toBeLessThan(second!.left);
    for (const cover of covers)
      expect(thumbnails).toHaveBeenCalledWith(port.id, cover.image_sha256, 3, 1);
    expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(innerWidth + 1);
    document.documentElement.dataset.theme = "dark";
    await captureParityState("paired-originals-narrow-app-hero");
    const credits = document.querySelector<HTMLElement>(".game-hero-detail .game-hero-credits")!;
    const summary = credits.querySelector("summary")!;
    await userEvent.keyboard("{Tab}");
    summary.focus();
    await userEvent.keyboard("{Enter}");
    await expect.poll(() => summary.matches(":focus-visible")).toBe(true);
    const firstCredit = credits.querySelector("dt")!;
    expect(firstCredit.textContent).toBe("Source");
    for (const [width, height] of [
      [430, 780],
      [960, 640],
    ] as const) {
      await page.viewport(width, height);
      credits.scrollIntoView({ block: "center" });
      const focus = getComputedStyle(summary);
      const outlineEnd =
        summary.getBoundingClientRect().bottom +
        Number.parseFloat(focus.outlineOffset) +
        Number.parseFloat(focus.outlineWidth);
      expect(focus.outlineStyle).toBe("solid");
      expect(firstCredit.getBoundingClientRect().top - outlineEnd).toBeGreaterThanOrEqual(2);
      await captureParityState("paired-originals-focused-image-credits");
    }
  } finally {
    await page.viewport(previousViewport.width, previousViewport.height);
  }
});

it.for(["local", "unavailable-local", "partial"] as const)(
  "preserves collection precedence and degradation: %s",
  async (mode) => {
    const port = { ...ports[0]!, id: "collection-choice", name: "Collection choice" };
    const covers = [1, 2, 3, 4].map((index) => ({
      game_id: index,
      cover_id: index,
      image_id: `choice${index}`,
      image_sha256: index.toString(16).repeat(64),
      game_slug: `choice-${index}`,
      match_kind: "underlying-game" as const,
    }));
    const listings = {
      format_version: 11,
      listings: [
        {
          id: port.id,
          name: port.name,
          summary: port.summary,
          project_url: port.project_url,
          platforms: [],
          availability: "packages" as const,
          collection_covers: covers,
        },
      ],
    };
    const primary = artworkState(port.id, "cover", 3, mode !== "partial");
    if (mode === "unavailable-local") primary.availability = "unavailable";
    vi.spyOn(desktopApi, "artwork").mockResolvedValue(primary);
    const canvas = document.createElement("canvas");
    canvas.width = 144;
    canvas.height = 192;
    const ink = canvas.getContext("2d")!;
    ink.fillStyle = "#a43232";
    ink.fillRect(0, 0, 144, 192);
    const thumbnail = (sha: string) => ({
      asset_sha256: sha,
      choice_revision: 3,
      png_base64: canvas.toDataURL("image/png").split(",")[1]!,
    });
    const local = vi.spyOn(desktopApi, "artworkThumbnail");
    if (mode === "unavailable-local") local.mockRejectedValue(new Error("Selected image missing"));
    else local.mockResolvedValue(thumbnail("a".repeat(64)));
    const load = vi
      .spyOn(desktopApi, "collectionCoverThumbnail")
      .mockImplementation(async (_id, sha) => {
        if (sha === covers[1]!.image_sha256) throw new Error("Offline");
        return thumbnail(sha);
      });
    await render(
      <ArtworkProvider generation={1} listings={listings}>
        <PortBrowser
          view="catalog"
          ports={[port]}
          statuses={new Map()}
          libraryCount={0}
          overview={{ installed: 0, ready: 0, needsSetup: 0, staged: 0 }}
          filter="all"
          setFilter={() => {}}
          onSelect={() => {}}
          onContinue={() => {}}
          loading={false}
        />
      </ArtworkProvider>,
    );
    const frame = document.querySelector<HTMLElement>(".collection-art")!;
    frame.scrollIntoView();
    await expect
      .poll(() => frame.querySelectorAll("img").length)
      .toBe(mode === "partial" ? 3 : mode === "local" ? 1 : 0);
    await expect
      .poll(() => document.body.textContent?.includes("Image unavailable") ?? false)
      .toBe(mode === "unavailable-local");
    expect(load).toHaveBeenCalledTimes(mode === "partial" ? 4 : 0);
  },
);

it("invalidates in-flight collection previews when only a member mapping changes", async () => {
  const port = { ...ports[0]!, id: "collection-change", name: "Changing collection" };
  const cover = (index: number) => ({
    game_id: index,
    cover_id: index,
    image_id: `changed${index}`,
    image_sha256: index.toString(16).repeat(64),
    game_slug: `changed-${index}`,
    match_kind: "underlying-game" as const,
  });
  const colours = ["#a43232", "#536a7a", "#52784a"];
  const previews = colours.map((colour) => {
    const canvas = document.createElement("canvas");
    canvas.width = 144;
    canvas.height = 192;
    const ink = canvas.getContext("2d")!;
    ink.fillStyle = colour;
    ink.fillRect(0, 0, 144, 192);
    return canvas.toDataURL("image/png");
  });
  const seen = new Set<string>();
  const release: (() => void)[] = [];
  vi.spyOn(desktopApi, "artwork").mockResolvedValue(artworkState(port.id, "cover", 3));
  const load = vi
    .spyOn(desktopApi, "collectionCoverThumbnail")
    .mockImplementation(async (_id, sha) => {
      const index = Number.parseInt(sha[0]!, 16) - 1;
      if (!seen.has(sha) && index < 2) {
        seen.add(sha);
        await new Promise<void>((resolve) => release.push(resolve));
      }
      return { asset_sha256: sha, choice_revision: 3, png_base64: previews[index]!.split(",")[1]! };
    });
  function Harness() {
    const [changed, setChanged] = useState(false);
    const listings = {
      format_version: 11,
      listings: [
        {
          id: port.id,
          name: port.name,
          summary: port.summary,
          project_url: port.project_url,
          platforms: [],
          availability: "packages" as const,
          collection_covers: [cover(1), cover(changed ? 3 : 2)],
        },
      ],
    };
    return (
      <ArtworkProvider generation={1} listings={listings}>
        <button onClick={() => setChanged(true)}>Change collection</button>
        <PortBrowser
          view="catalog"
          ports={[port]}
          statuses={new Map()}
          libraryCount={0}
          overview={{ installed: 0, ready: 0, needsSetup: 0, staged: 0 }}
          filter="all"
          setFilter={() => {}}
          onSelect={() => {}}
          onContinue={() => {}}
          loading={false}
        />
      </ArtworkProvider>
    );
  }
  await render(<Harness />);
  const frame = document.querySelector<HTMLElement>(".collection-art")!;
  frame.scrollIntoView();
  await expect.poll(() => load.mock.calls.length).toBe(2);
  await page.getByRole("button", { name: "Change collection" }).click();
  await expect
    .poll(() => Array.from(frame.querySelectorAll("img")).map((img) => img.src))
    .toEqual([previews[0], previews[2]]);
  await act(async () => {
    for (const finish of release) finish();
    await new Promise((resolve) => setTimeout(resolve));
  });
  expect(Array.from(frame.querySelectorAll("img")).map((img) => img.src)).toEqual([
    previews[0],
    previews[2],
  ]);
  expect(load).toHaveBeenCalledTimes(4);
});
