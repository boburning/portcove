import "../../styles/index.css";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";
import { PortBrowser } from "../../components/PortBrowser";
import { portDefinition } from "../../test-fixtures";
import { OperationPresentationProvider } from "../operations/operation-presentation";
import {
  captureCollectionDestination,
  mountCollectionDestination,
} from "../../collection-navigation";
import { inspectLibraryGroups, mountLibraryPort } from "../../browser/discover-test-helpers";
import { browserFixture } from "../../../test/browser-fixture";
import type { Organization } from "../organization/OrganizationControls";
import type { CollectionLayout } from "./use-collection-layout";

// These are saved memberships with no installation. Group zero has two actual
// implementations; virtual mounting must not turn either into a Play target.
const ports = Array.from({ length: 201 }, (_, index) => ({
  ...portDefinition(),
  id: `library-${index}`,
  name: `Project ${index}`,
  presentation: {
    ...portDefinition().presentation,
    original_game_title: `Game ${String(Math.max(0, index - 1)).padStart(3, "0")}`,
    original_game: {
      format_version: 1 as const,
      id: `game-${Math.max(0, index - 1)}`,
      evidence_urls: [],
      source_editions: [],
    },
  },
}));
const expected = [["library-0", "library-1"], ...ports.slice(2).map((port) => [port.id])];
const open = vi.fn();
const organizationCommit = vi.fn(async () => true);
const pending = new Map();
const organization: Organization = {
  snapshot: {
    revision: 0,
    collections: {},
    followed_port_ids: [],
    followed_release_acknowledgments: {},
    hidden_port_ids: [],
    saved_game_ids: Array.from({ length: 200 }, (_, index) => `game-game-${index}`),
    update_notices: {},
    setup_confirmations: [],
  },
  busy: false,
  failure: undefined,
  refresh: async () => true,
  commit: organizationCommit,
};
let root: Root;
let host: HTMLDivElement;
let fixture: ReturnType<typeof browserFixture>;

function Fixture({
  layout = "covers",
  generation = 1,
  query = "",
  ready = true,
  matching = ports,
  organizationState = "ready",
  trailing = false,
}: {
  layout?: CollectionLayout;
  generation?: number;
  query?: string;
  ready?: boolean;
  matching?: typeof ports;
  organizationState?: "ready" | "busy" | "unavailable";
  trailing?: boolean;
} = {}) {
  return (
    <OperationPresentationProvider generation={generation} pending={pending}>
      <main data-focus-region="workspace" style={{ height: 500, overflow: "auto" }}>
        <button id="outside-library">Outside collection</button>
        <PortBrowser
          organization={
            organizationState === "unavailable"
              ? undefined
              : organizationState === "busy"
                ? { ...organization, busy: true }
                : organization
          }
          view="library"
          ports={matching}
          catalogUniverse={ports}
          statuses={new Map()}
          overview={{ installed: 0, ready: 0, needsSetup: 0, staged: 0 }}
          filter="all"
          setFilter={() => {}}
          onSelect={open}
          loading={false}
          collectionLayout={layout}
          query={query}
          resultsReady={ready}
        />
        {trailing && (
          <div style={{ height: 1600 }}>
            <button id="after-library">After collection</button>
          </div>
        )}
      </main>
    </OperationPresentationProvider>
  );
}
const frames = async () => {
  await act(async () => {
    await new Promise(requestAnimationFrame);
    await new Promise(requestAnimationFrame);
  });
};
async function draw(props: Parameters<typeof Fixture>[0] = {}) {
  await act(async () => root.render(<Fixture {...props} />));
  await frames();
}
beforeEach(async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  fixture = browserFixture({ viewport: true });
  await page.viewport(1280, 800);
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  open.mockClear();
  organizationCommit.mockClear();
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  await fixture.dispose();
  vi.unstubAllGlobals();
});

it.each(["covers", "rows"] as const)(
  "bounds %s while retaining every logical game, implementation and expanded choice",
  async (layout) => {
    await draw({ layout });
    expect(document.querySelectorAll("[data-library-port-ids]").length).toBeLessThan(40);
    expect(document.querySelector("[data-library-port-ids]")?.getAttribute("aria-setsize")).toBe(
      "200",
    );
    expect(document.querySelector('button[aria-label^="Play "]')).toBeNull();
    const first = await mountLibraryPort("library-0");
    await act(async () => {
      await userEvent.click(first.querySelector("summary")!);
    });
    await expect.poll(() => first.querySelector("details")?.open).toBe(true);
    await act(async () => document.querySelector<HTMLButtonElement>("#outside-library")!.focus());
    await mountLibraryPort("library-200");
    await frames();
    expect(first.isConnected).toBe(false);
    const replacement = await mountLibraryPort("library-0");
    expect(replacement.querySelector("details")!.open).toBe(true);
    expect(replacement.textContent).toContain("All 2 ports");
    expect(open).not.toHaveBeenCalled();
    await inspectLibraryGroups(expected);
  },
  60_000,
);

it("keeps an open menu's exact trigger mounted through scrolling, regrouping and dismissal", async () => {
  await draw();
  const first = await mountLibraryPort("library-2");
  const origin = "library:card-more:library-2";
  await act(async () => {
    await userEvent.click(first.querySelector(`[data-detail-origin="${origin}"]`)!);
  });
  await expect.element(page.getByRole("menu")).toBeVisible();
  await mountLibraryPort("library-200");
  expect(first.isConnected).toBe(true);
  await page.viewport(760, 800);
  await frames();
  await expect.element(page.getByRole("menu")).toBeVisible();
  await act(async () => {
    await userEvent.keyboard("{Escape}");
  });
  await expect.element(page.getByRole("menu")).not.toBeInTheDocument();
  await expect
    .poll(() => (document.activeElement as HTMLElement)?.dataset.detailOrigin)
    .toBe(origin);
  const workspace = document.querySelector<HTMLElement>("main")!.getBoundingClientRect();
  const trigger = document.activeElement!.getBoundingClientRect();
  expect(trigger.top).toBeGreaterThanOrEqual(workspace.top);
  expect(trigger.bottom).toBeLessThanOrEqual(workspace.bottom);
});

it("mounts exact alternative returns and cancels obsolete query and generation work", async () => {
  await draw({ layout: "rows" });
  await mountLibraryPort("library-200");
  const workspace = document.querySelector<HTMLElement>("main")!;
  let returning!: Promise<boolean>;
  await act(async () => {
    returning = mountCollectionDestination(
      workspace,
      { originKey: "library:alternative:library-1" },
      () => true,
    );
  });
  let settled = false;
  void returning.then(() => {
    settled = true;
  });
  await expect
    .poll(async () => {
      await frames();
      return settled;
    })
    .toBe(true);
  expect(await returning).toBe(true);
  const alternative = document.querySelector<HTMLElement>(
    '[data-detail-origin="library:alternative:library-1"]',
  )!;
  expect(alternative.closest("details")!.open).toBe(true);
  await act(async () => alternative.focus());
  expect(captureCollectionDestination(workspace)?.groupKey).toBe("game:game-0");
  await act(async () => {
    await userEvent.click(alternative);
  });
  expect(open).toHaveBeenCalledExactlyOnceWith("library-1", "library:alternative:library-1");
  for (const replacement of [
    { query: "new", generation: 1 },
    { query: "saved", generation: 2 },
  ]) {
    await draw({ layout: "rows", ready: false, query: "saved" });
    let obsolete!: Promise<boolean>;
    await act(async () => {
      obsolete = mountCollectionDestination(workspace, { portId: "library-200" }, () => true);
    });
    await draw({ layout: "rows", ...replacement, matching: ports.slice(2, 3) });
    expect(await obsolete).toBe(false);
    expect(document.querySelectorAll("[data-library-port-ids]")).toHaveLength(1);
    expect(document.querySelector("[data-library-port-ids]")!.getAttribute("aria-setsize")).toBe(
      "1",
    );
  }
});

it.each(["covers", "rows"] as const)(
  "retains the exact focused %s origin and reading position across accepted reorder",
  async (layout) => {
    await draw({ layout });
    const card = await mountLibraryPort("library-180");
    const origin = "library:card:library-180";
    const control = card.querySelector<HTMLButtonElement>(`[data-detail-origin="${origin}"]`)!;
    await act(async () => control.focus());
    await frames();
    const before = control.getBoundingClientRect().top;
    // Keep the destination away from either scroll boundary so equal offsets are attainable.
    const reordered = [...ports.slice(150), ...ports.slice(0, 150)];
    await draw({ layout, matching: reordered });
    await expect
      .poll(async () => {
        await frames();
        const active = document.activeElement as HTMLElement;
        return (
          active?.dataset.detailOrigin === origin &&
          Math.abs(active.getBoundingClientRect().top - before) <= 1
        );
      })
      .toBe(true);
    expect(
      Math.abs(document.activeElement!.getBoundingClientRect().top - before),
    ).toBeLessThanOrEqual(1);
    expect(document.querySelectorAll("[data-library-port-ids]").length).toBeLessThan(40);
  },
);

it.each(["focus", "pointer"] as const)(
  "yields pending structural restoration to a new %s owner and scroll intent",
  async (intent) => {
    await draw();
    const card = await mountLibraryPort("library-180");
    await act(async () => card.querySelector<HTMLButtonElement>(".collection-identity")!.focus());
    await frames();
    await act(async () => root.render(<Fixture matching={[...ports].reverse()} />));
    const outside = document.querySelector<HTMLButtonElement>("#outside-library")!;
    const workspace = document.querySelector<HTMLElement>("main")!;
    await act(async () => {
      if (intent === "pointer")
        outside.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }));
      outside.focus({ preventScroll: true });
      workspace.scrollTop = 0;
    });
    await frames();
    await frames();
    expect(document.activeElement).toBe(outside);
    expect(workspace.scrollTop).toBe(0);
  },
);

it("does not restore an offscreen collection over the current reading owner on resize", async () => {
  await draw({ layout: "rows", trailing: true });
  await mountLibraryPort("library-2");
  const after = document.querySelector<HTMLButtonElement>("#after-library")!;
  const workspace = document.querySelector<HTMLElement>("main")!;
  const collection = document.querySelector<HTMLElement>('[data-virtual-collection="library"]')!;
  await act(async () => {
    after.scrollIntoView({ block: "start" });
    after.focus({ preventScroll: true });
  });
  await frames();
  await frames();
  const outsideViewport = () =>
    collection.getBoundingClientRect().bottom <= workspace.getBoundingClientRect().top + 1;
  expect(outsideViewport()).toBe(true);
  await act(async () => {
    workspace.style.width = "760px";
    window.dispatchEvent(new Event("resize"));
  });
  await frames();
  await frames();
  expect(document.activeElement).toBe(after);
  expect(outsideViewport()).toBe(true);
});

it("distinguishes a narrowed Library match from all alternatives in its logical game", async () => {
  await draw({ matching: ports.slice(1, 2), query: "narrowed" });
  await inspectLibraryGroups([["library-0", "library-1"]], () => {}, [["library-1"]]);
  const group = await mountLibraryPort("library-1");
  expect(group.querySelector('[data-detail-origin="library:card:library-0"]')).toBeNull();
  expect(group.querySelectorAll(".collection-actions button")).toHaveLength(1);
});

it.each(["resize", "reorder"] as const)(
  "retains a non-first keyboard menu action when %s replaces its trigger",
  async (transition) => {
    await draw();
    const group = await mountLibraryPort("library-2");
    const origin = "library:card-more:library-2";
    const trigger = group.querySelector<HTMLButtonElement>(`[data-detail-origin="${origin}"]`)!;
    await act(async () => trigger.focus());
    await act(async () => {
      await userEvent.keyboard("{Enter}");
    });
    await expect.element(page.getByRole("menu")).toBeVisible();
    const enabled = [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].filter(
      (item) => !item.matches('[aria-disabled="true"],[data-disabled],:disabled'),
    );
    expect(enabled.length).toBeGreaterThan(1);
    await expect.poll(() => document.activeElement).toBe(enabled[0]);
    const first = enabled[0];
    await act(async () => {
      await userEvent.keyboard("{ArrowDown}");
    });
    const selected = document.activeElement as HTMLElement;
    expect(selected).not.toBe(first);
    expect(selected.getAttribute("role")).toBe("menuitem");
    expect(selected.hasAttribute("data-highlighted")).toBe(true);
    const name = selected.textContent.trim();
    if (transition === "resize") await page.viewport(760, 800);
    else await draw({ matching: [ports[0]!, ports[1]!, ports[3]!, ports[2]!, ...ports.slice(4)] });
    await frames();
    await expect.poll(() => trigger.isConnected).toBe(false);
    await expect.element(page.getByRole("menu")).toBeVisible();
    await expect
      .poll(async () => {
        await frames();
        const active = document.activeElement as HTMLElement;
        return active.getAttribute("role") === "menuitem" && active.hasAttribute("data-highlighted")
          ? active.textContent.trim()
          : undefined;
      })
      .toBe(name);
    expect(open).not.toHaveBeenCalled();
    expect(organizationCommit).not.toHaveBeenCalled();
    // A newer keyboard choice wins over still-finishing open callbacks.
    await act(async () => {
      await userEvent.keyboard("{ArrowDown}");
    });
    const newer = document.activeElement as HTMLElement;
    expect(newer.textContent.trim()).not.toBe(name);
    const newerName = newer.textContent.trim();
    await Promise.all(
      page
        .getByRole("menu")
        .element()
        .getAnimations({ subtree: true })
        .map((animation) => animation.finished),
    );
    await frames();
    expect((document.activeElement as HTMLElement).textContent.trim()).toBe(newerName);
    expect((document.activeElement as HTMLElement).hasAttribute("data-highlighted")).toBe(true);
    expect(open).not.toHaveBeenCalled();
    await act(async () => {
      await userEvent.keyboard("{Escape}");
    });
    await expect.element(page.getByRole("menu")).not.toBeInTheDocument();
    await expect
      .poll(() => (document.activeElement as HTMLElement)?.dataset.detailOrigin)
      .toBe(origin);
    expect(document.activeElement).toBe(document.querySelector(`[data-detail-origin="${origin}"]`));
    expect(document.activeElement).not.toBe(trigger);
  },
);

it.each(["query", "generation"] as const)(
  "clears menu continuity when the %s owner changes",
  async (replacement) => {
    await draw();
    const group = await mountLibraryPort("library-2");
    const origin = "library:card-more:library-2";
    await act(async () =>
      group.querySelector<HTMLButtonElement>(`[data-detail-origin="${origin}"]`)!.focus(),
    );
    await act(async () => {
      await userEvent.keyboard("{Enter}");
    });
    await expect.element(page.getByRole("menu")).toBeVisible();
    await act(async () => {
      await userEvent.keyboard("{ArrowDown}");
    });
    await draw(replacement === "query" ? { query: "replacement" } : { generation: 2 });
    await expect.element(page.getByRole("menu")).not.toBeInTheDocument();
    // Returning to an earlier owner must not resurrect its canceled popup.
    await draw();
    await expect.element(page.getByRole("menu")).not.toBeInTheDocument();
    const outside = document.querySelector<HTMLButtonElement>("#outside-library")!;
    await act(async () => outside.focus());
    await frames();
    expect(document.activeElement).toBe(outside);
  },
);

it.each(["busy", "unavailable"] as const)(
  "retains normal menu focus and dispatch rules when the remembered action becomes %s",
  async (organizationState) => {
    await draw();
    const group = await mountLibraryPort("library-2");
    const origin = "library:card-more:library-2";
    const trigger = group.querySelector<HTMLButtonElement>(`[data-detail-origin="${origin}"]`)!;
    await act(async () => trigger.focus());
    await act(async () => {
      await userEvent.keyboard("{Enter}");
    });
    await expect.element(page.getByRole("menu")).toBeVisible();
    await act(async () => {
      await userEvent.keyboard("{End}{Home}");
    });
    expect((document.activeElement as HTMLElement).dataset.collectionControl).toBe("visibility");
    await draw({
      organizationState,
      matching: [ports[0]!, ports[1]!, ports[3]!, ports[2]!, ...ports.slice(4)],
    });
    await expect.poll(() => trigger.isConnected).toBe(false);
    await expect.element(page.getByRole("menu")).toBeVisible();
    const unavailable = document.querySelector<HTMLElement>(
      '[role="menu"] [data-collection-control="visibility"]',
    );
    expect(Boolean(unavailable)).toBe(organizationState === "busy");
    expect(unavailable?.getAttribute("aria-disabled") ?? null).toBe(
      organizationState === "busy" ? "true" : null,
    );
    await expect
      .poll(() =>
        organizationState === "busy"
          ? (document.activeElement as HTMLElement).dataset.collectionControl === "visibility" &&
            (document.activeElement as HTMLElement).hasAttribute("data-highlighted")
          : page.getByRole("menu").element().contains(document.activeElement),
      )
      .toBe(true);
    if (organizationState === "busy") {
      await act(async () => {
        await userEvent.keyboard("{Enter}");
      });
    }
    expect(organizationCommit).not.toHaveBeenCalled();
    expect(open).not.toHaveBeenCalled();
    // Base UI deliberately permits focusing disabled menu items. Its normal End
    // navigation still reaches the enabled final action in either owner state.
    await act(async () => {
      await userEvent.keyboard("{End}");
    });
    await expect
      .poll(() => (document.activeElement as HTMLElement).dataset.collectionControl)
      .toBe("saves");
    expect((document.activeElement as HTMLElement).hasAttribute("data-highlighted")).toBe(true);
    expect(open).not.toHaveBeenCalled();
  },
);
