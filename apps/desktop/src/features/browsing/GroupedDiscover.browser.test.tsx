import { page } from "vite-plus/test/browser";
import { resolvedGridColumns } from "./virtual-discover-model";
import "../../styles/index.css";
import { desktopApi } from "../../api";
import { mountCollectionDestination } from "../../collection-navigation";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";
import { initializeLocalization } from "../../localization";
import type { PortDefinition, PortStatus } from "../../types";
import { portDefinition } from "../../test-fixtures";
import { InvocationOwnerProvider } from "../operations/invocation-owner";
import { OperationPresentationProvider } from "../operations/operation-presentation";
import { useOperationState } from "../operations/use-operation-state";
import { targetInvocationContext } from "../operations/invocation-state";
import type { CatalogEntry } from "./catalog-entry";
import { GroupedDiscover } from "./GroupedDiscover";
import { prepareCaptureTarget } from "../../../test/capture-target";
import {
  observeCollectionLayoutReady,
  observeVisibleTarget,
} from "../../../scripts/browser-readiness.mts";

vi.mock("@tauri-apps/api/event", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@tauri-apps/api/event")>()),
  listen: vi.fn().mockResolvedValue(() => {}),
}));

let root: Root;
let host: HTMLDivElement;
let viewport: { width: number; height: number };
const i18n = initializeLocalization();

beforeEach(async () => {
  viewport = { width: innerWidth, height: innerHeight };
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  await i18n.changeLanguage("en");
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});

afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  await page.viewport(viewport.width, viewport.height);
  await i18n.changeLanguage("en");
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

it("reveals one complete game identity after resize restoration finishes", async () => {
  await page.viewport(1280, 900);
  host.style.cssText = "position:fixed;inset:0 auto 0 224px;width:1056px";
  const ports = ["2ship2harkinian", "zelda64-recomp"].map((id) => ({
    ...portDefinition(),
    id,
    presentation: {
      ...portDefinition().presentation,
      original_game_title: "The Legend of Zelda: Majora's Mask",
      original_game: {
        format_version: 1 as const,
        id: "the-legend-of-zelda-majoras-mask",
        evidence_urls: [],
        source_editions: [],
      },
    },
  }));
  await act(async () =>
    root.render(
      <OperationPresentationProvider generation={7} pending={new Map()}>
        <main
          data-focus-region="workspace"
          className="workspace-main"
          style={{ height: "100%", overflow: "auto" }}
        >
          <div style={{ height: 259.5 }} />
          <GroupedDiscover all={ports} matching={ports} statuses={new Map()} onSelect={vi.fn()} />
        </main>
      </OperationPresentationProvider>,
    ),
  );
  const frames = async () => {
    await act(async () => {
      await new Promise(requestAnimationFrame);
      await new Promise(requestAnimationFrame);
    });
  };
  await frames();
  const target =
    '.discover-game[data-detail-return-group="game:the-legend-of-zelda-majoras-mask"] .discover-game-identity';
  const identity = host.querySelector<HTMLElement>(target)!;
  await act(async () => identity.focus({ preventScroll: true }));
  await frames();
  await page.viewport(960, 640);
  await act(async () => {
    // The real ResizeObserver/virtualizer must finish preserving the reading
    // anchor before capture makes its single intentional reveal.
    host.style.width = "736px";
  });
  const prepared = prepareCaptureTarget({
    target,
    label: "resized-game-identity",
    ready: observeCollectionLayoutReady,
    scroll: () =>
      identity.scrollIntoView({ block: "center", inline: "nearest", behavior: "instant" }),
    observe: () => {
      const observation = observeVisibleTarget(target, "visual");
      expect(observation.visible, JSON.stringify(observation)).toBe(true);
      return observation;
    },
    settle: frames,
  });
  const result = await prepared;
  expect(result.observation.visible).toBe(true);
  expect(document.activeElement).toBe(identity);
  for (let frame = 0; frame < 3; frame++) {
    await frames();
    expect(observeVisibleTarget(target, "visual")).toEqual(result.observation);
  }
});

it("updates shared card translations and pending actions without remounting the card", async () => {
  const port: PortDefinition = {
    ...portDefinition(),
    channels: ["beta"],
    platforms: ["linux-x86-64"],
    upstream_status: "retired",
  };
  const ports = [port];
  const statuses = new Map<string, PortStatus>();
  const onSelect = vi.fn();
  const onTask = vi.fn();
  const refresh = vi.fn().mockResolvedValue(undefined);
  let state!: ReturnType<typeof useOperationState>;
  function Fixture() {
    state = useOperationState({ refresh, libraryGeneration: 7 });
    return (
      <OperationPresentationProvider generation={7} pending={state.pendingOperations}>
        <GroupedDiscover
          all={ports}
          matching={ports}
          statuses={statuses}
          devicePlatform="windows-x86-64"
          onSelect={onSelect}
          onTask={onTask}
        />
      </OperationPresentationProvider>
    );
  }
  await act(async () =>
    root.render(
      <InvocationOwnerProvider>
        <Fixture />
      </InvocationOwnerProvider>,
    ),
  );
  const card = host.querySelector("article")!;
  const action = card.querySelector<HTMLButtonElement>(".discover-game-actions button")!;
  const idleLabel = action.textContent;
  let finish!: () => void;
  const done = new Promise<void>((resolve) => {
    finish = resolve;
  });
  let running!: Promise<unknown>;
  await act(async () => {
    running = state.perform("prepare", () => done, {
      context: {
        ...targetInvocationContext("Prepare", { kind: "port", id: port.id, label: port.name }, 7),
        activityId: "owned-task",
      },
    });
  });
  expect(action.textContent).toBe(i18n.t("discover.action.task", { ns: "browsing" }));
  const englishTask = action.textContent;
  await act(async () => {
    await i18n.changeLanguage("ar-XB");
  });
  expect(host.querySelector("article")).toBe(card);
  expect(action.textContent).not.toBe(englishTask);
  expect(action.textContent).toBe(i18n.t("discover.action.task", { ns: "browsing" }));
  expect(card.querySelector(".discover-game-metadata")?.textContent).toContain(
    i18n.t("discover.unavailableFor", { ns: "browsing", platform: "Windows" }),
  );
  expect(card.querySelector(".discover-game-metadata [title]")?.getAttribute("title")).toBe(
    i18n.t("discover.chip.channel", { ns: "browsing" }),
  );
  expect(card.querySelector(".discover-observations")?.textContent).toContain(
    i18n.t("observations.retired", { ns: "browsing" }),
  );
  await act(async () => action.click());
  expect(onTask).toHaveBeenCalledWith("owned-task");
  await act(async () => {
    finish();
    await running;
    await i18n.changeLanguage("en");
  });
  expect(host.querySelector("article")).toBe(card);
  expect(action.textContent).toBe(idleLabel);
});

it.each(["control", "origin"] as const)(
  "returns comparison focus to the current deep card after column regrouping: %s identity",
  async (identity) => {
    vi.spyOn(desktopApi, "compareGamePorts").mockRejectedValue(new Error("Unavailable fixture"));
    await page.viewport(1280, 800);
    host.style.width = "1000px";
    const ports: CatalogEntry[] = Array.from({ length: 1540 }, (_, index) => ({
      ...portDefinition(),
      id: `comparison-game-${index}`,
    }));
    const target = ports[1200]!;
    if (identity === "origin") {
      const grouped = {
        ...target,
        presentation: {
          ...target.presentation,
          original_game: {
            format_version: 1,
            id: "comparison-group",
            evidence_urls: [],
            source_editions: [],
          },
        },
      };
      ports[1200] = grouped;
      ports.push({ ...grouped, id: "comparison-alternative" });
    }
    await act(async () =>
      root.render(
        <OperationPresentationProvider generation={7} pending={new Map()}>
          <main data-focus-region="workspace" style={{ height: 500, overflow: "auto" }}>
            <GroupedDiscover all={ports} matching={ports} statuses={new Map()} onSelect={vi.fn()} />
          </main>
        </OperationPresentationProvider>,
      ),
    );
    const frames = async () => {
      await act(async () => {
        await new Promise(requestAnimationFrame);
        await new Promise(requestAnimationFrame);
      });
    };
    await frames();
    const workspace = host.querySelector("main")!;
    let pending!: Promise<boolean>;
    await act(async () => {
      pending = mountCollectionDestination(workspace, { portId: target.id }, () => true);
    });
    let mounted = false;
    void pending.then(
      () => {
        mounted = true;
      },
      () => {
        mounted = true;
      },
    );
    await expect
      .poll(async () => {
        await frames();
        return mounted;
      })
      .toBe(true);
    expect(await pending).toBe(true);
    const groupKey = identity === "origin" ? "game:comparison-group" : `port:${target.id}`;
    const currentTrigger = () =>
      host.querySelector<HTMLButtonElement>(
        `[data-detail-return-group="${groupKey}"] ${
          identity === "origin"
            ? `[data-detail-origin="catalog:card:${target.id}:details"]`
            : '[data-collection-control="compare-evidence"]'
        }`,
      );
    const columns = () =>
      resolvedGridColumns(
        getComputedStyle(host.querySelector(".virtual-discover-probe")!).gridTemplateColumns,
      );
    const beforeColumns = columns();
    expect(beforeColumns).toBeGreaterThan(2);
    const trigger = currentTrigger()!;
    await act(async () => {
      trigger.focus();
      trigger.click();
    });
    await expect.poll(() => document.activeElement?.closest('[role="dialog"]')).not.toBeNull();
    await page.viewport(760, 800);
    host.style.width = "420px";
    await expect
      .poll(async () => {
        await frames();
        return columns();
      })
      .toBeLessThan(beforeColumns);
    await expect
      .poll(async () => {
        await frames();
        return trigger.isConnected;
      })
      .toBe(false);
    const replacement = currentTrigger()!;
    expect(replacement).not.toBeNull();
    expect(replacement).not.toBe(trigger);
    const close = document.querySelector<HTMLButtonElement>(
      '[role="dialog"] [data-slot="dialog-close"]',
    )!;
    await act(async () => close.click());
    await expect
      .poll(async () => {
        await frames();
        return document.activeElement;
      })
      .toBe(replacement);
    expect(replacement.isConnected).toBe(true);
    await expect.poll(() => document.querySelector('[role="dialog"]')).toBeNull();
    const bounds = workspace.getBoundingClientRect();
    await expect
      .poll(async () => {
        await frames();
        const rect = replacement.getBoundingClientRect();
        return rect.top >= bounds.top && rect.bottom <= bounds.bottom;
      })
      .toBe(true);
  },
);

it.each(["query", "generation"] as const)(
  "cancels a comparison return when its %s owner changes",
  async (change) => {
    vi.spyOn(desktopApi, "compareGamePorts").mockRejectedValue(new Error("Unavailable fixture"));
    const ports = [portDefinition()];
    const statuses = new Map<string, PortStatus>();
    const onSelect = vi.fn();
    const render = async (generation: number, queryKey: string) => {
      await act(async () =>
        root.render(
          <OperationPresentationProvider generation={generation} pending={new Map()}>
            <main data-focus-region="workspace">
              <GroupedDiscover
                all={ports}
                matching={ports}
                statuses={statuses}
                queryKey={queryKey}
                onSelect={onSelect}
              />
            </main>
          </OperationPresentationProvider>,
        ),
      );
    };
    await render(7, "original");
    const trigger = host.querySelector<HTMLButtonElement>(
      '[data-collection-control="compare-evidence"]',
    )!;
    expect(trigger).not.toBeNull();
    await act(async () => {
      trigger.focus();
      trigger.click();
    });
    await expect.poll(() => document.activeElement?.closest('[role="dialog"]')).not.toBeNull();
    await render(change === "generation" ? 8 : 7, change === "query" ? "replacement" : "original");
    await expect.poll(() => document.querySelector('[role="dialog"]')).toBeNull();
    expect(document.activeElement).not.toBe(trigger);
    // Returning to an old query must not resurrect its dismissed comparison.
    await render(7, "original");
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    expect(onSelect).not.toHaveBeenCalled();
  },
);
