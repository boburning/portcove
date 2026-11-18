import "../../styles/index.css";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { beforeEach, afterEach, expect, it, vi } from "vite-plus/test";
import {
  mountCollectionDestination,
  captureCollectionDestination,
  prepareCollectionMove,
  collectionMovementCandidates,
  type CollectionDestination,
} from "../../collection-navigation";
import { portDefinition } from "../../test-fixtures";
import { groupCatalog } from "./original-game";
import { VirtualCollectionRows } from "./VirtualCollectionRows";

let root: Root;
let host: HTMLDivElement;
let workspace: HTMLElement;
const groups = groupCatalog(
  Array.from({ length: 1540 }, (_, index) => ({ ...portDefinition(), id: `game-${index}` })),
);
const frames = async () => {
  await act(async () => {
    await new Promise(requestAnimationFrame);
    await new Promise(requestAnimationFrame);
  });
};

// Mount acknowledgment depends on a committed measured row. Flush each scheduled
// render/frame without holding an act callback open on that acknowledgment.
async function settleMount(pending: Promise<boolean>) {
  let settled = false;
  void pending.then(
    () => {
      settled = true;
    },
    () => {
      settled = true;
    },
  );
  await expect
    .poll(async () => {
      await frames();
      return settled;
    })
    .toBe(true);
  return pending;
}
async function mountDestination(destination: CollectionDestination) {
  let pending!: Promise<boolean>;
  await act(async () => {
    pending = mountCollectionDestination(workspace, destination, () => true);
  });
  return settleMount(pending);
}

function Fixture({
  layout = "covers",
  matching = groups,
  comparisonPin,
  documentFlow = false,
  ready = true,
  queryKey = "",
}: {
  layout?: "covers" | "rows";
  matching?: typeof groups;
  comparisonPin?: string;
  documentFlow?: boolean;
  ready?: boolean;
  queryKey?: string;
} = {}) {
  return (
    <main
      data-focus-region="workspace"
      style={{
        height: documentFlow ? "auto" : 500,
        width: "100%",
        overflow: documentFlow ? "visible" : "auto",
      }}
    >
      <button id="before-collection">Before</button>
      <VirtualCollectionRows
        ready={ready}
        queryKey={queryKey}
        groups={matching}
        layout={layout}
        generation={7}
        overlayPin={comparisonPin}
        label="Games"
      >
        {(group, index) => (
          <article className="discover-game" data-detail-return-group={group.id}>
            <button
              style={{ height: 180 }}
              data-detail-origin={`catalog:card:${group.ports[0]!.id}`}
            >
              Game {index}
            </button>
            <div style={{ height: index % 2 ? 30 : 50 }}>Metadata</div>
            <div>Observation</div>
            <button data-detail-origin={`catalog:card:${group.ports[0]!.id}:details`}>
              Details
            </button>
          </article>
        )}
      </VirtualCollectionRows>
      <button id="after-collection">After</button>
    </main>
  );
}

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  host = document.createElement("div");
  host.style.width = "1000px";
  document.body.append(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
});

async function render(layout: "covers" | "rows" = "covers") {
  await act(async () => root.render(<Fixture layout={layout} />));
  workspace = host.querySelector("main")!;
  await frames();
}
const card = (index: number) =>
  host.querySelector<HTMLElement>(`[data-detail-return-group="port:game-${index}"]`);
const details = (index: number) =>
  card(index)?.querySelector<HTMLButtonElement>("button:last-child");

it.each(["covers", "rows"] as const)(
  "bounds mounted %s rows and mounts exact deep destinations",
  async (layout) => {
    await render(layout);
    expect(host.querySelectorAll("article").length).toBeLessThan(100);
    expect(await mountDestination({ portId: "game-1200" })).toBe(true);
    await act(async () => details(1200)!.focus());
    expect(document.activeElement).toBe(details(1200));
    expect(host.querySelectorAll("article").length).toBeLessThan(100);
    expect(host.querySelector("[data-collection-row] [data-focus-group]")).toBeNull();
  },
);

it("keeps the four shared tracks aligned within a covers row", async () => {
  await render();
  const firstRow = host.querySelector("[data-collection-row]")!;
  const actions = [...firstRow.querySelectorAll<HTMLElement>("article > button:last-child")];
  expect(actions.length).toBeGreaterThan(1);
  const tops = actions.map((button) => button.getBoundingClientRect().top);
  expect(Math.max(...tops) - Math.min(...tops)).toBeLessThan(1);
});

it("traverses the logical Tab neighbor across a gap caused by a distant focused row", async () => {
  await render("rows");
  await act(async () => details(0)!.focus());
  await act(async () => {
    workspace.scrollTop = workspace.scrollHeight;
    workspace.dispatchEvent(new Event("scroll"));
  });
  await frames();
  expect(card(0)).not.toBeNull();
  expect(card(1)).toBeNull();
  const origin = details(0)!;
  const event = new KeyboardEvent("keydown", { key: "Tab", bubbles: true, cancelable: true });
  await act(async () => {
    origin.dispatchEvent(event);
  });
  expect(event.defaultPrevented).toBe(true);
  await expect
    .poll(() => document.activeElement?.getAttribute("data-detail-origin"))
    .toBe("catalog:card:game-1");
  expect(host.querySelectorAll("article").length).toBeLessThan(100);
});

it("mounts a logical arrow neighbor and excludes a distant pin from spatial candidates", async () => {
  await render("rows");
  await act(async () => details(0)!.focus());
  await act(async () => {
    workspace.scrollTop = workspace.scrollHeight;
    workspace.dispatchEvent(new Event("scroll"));
  });
  await frames();
  let pending!: Promise<boolean>;
  await act(async () => {
    pending = prepareCollectionMove(details(0)!, "down", () => true)!;
  });
  expect(await settleMount(pending)).toBe(true);
  expect(card(1)).not.toBeNull();
  const candidates = [...host.querySelectorAll<HTMLButtonElement>("article button")];
  expect(collectionMovementCandidates(candidates, details(0)!)).not.toContain(details(1539));
});

it("cancels delayed mounting after explicit user intent or accepted query replacement", async () => {
  await render("rows");
  let pending!: Promise<boolean>;
  await act(async () => {
    pending = mountCollectionDestination(workspace, { portId: "game-1200" }, () => true);
    workspace.dispatchEvent(new WheelEvent("wheel", { bubbles: true }));
  });
  expect(await settleMount(pending)).toBe(false);
  await act(async () => {
    pending = mountCollectionDestination(workspace, { portId: "game-900" }, () => true);
    root.render(<Fixture layout="rows" matching={groups.slice(0, 2)} />);
  });
  expect(await settleMount(pending)).toBe(false);
  expect(card(900)).toBeNull();
});

it("restores the exact control through a responsive column regroup", async () => {
  await render();
  await act(async () => details(3)!.focus());
  host.style.width = "420px";
  await frames();
  await expect
    .poll(() => document.activeElement?.getAttribute("data-detail-origin"))
    .toBe("catalog:card:game-3:details");
});

it("keeps independent focus and comparison pins while mounting a third destination", async () => {
  await act(async () => root.render(<Fixture layout="rows" comparisonPin={groups[300]!.id} />));
  workspace = host.querySelector("main")!;
  await frames();
  await act(async () => details(0)!.focus());
  await mountDestination({ portId: "game-1200" });
  expect(card(0)).not.toBeNull();
  expect(card(300)).not.toBeNull();
  expect(card(1200)).not.toBeNull();
  expect(host.querySelectorAll("article").length).toBeLessThan(100);
  await act(async () => root.render(<Fixture layout="rows" />));
  await frames();
  expect(card(0)).not.toBeNull();
  expect(card(300)).toBeNull();
});

it("uses document scrolling when the workspace is in narrow flow", async () => {
  await act(async () => root.render(<Fixture layout="rows" documentFlow />));
  workspace = host.querySelector("main")!;
  await frames();
  await mountDestination({ portId: "game-1200" });
  expect(window.scrollY).toBeGreaterThan(0);
  expect(card(1200)).not.toBeNull();
  expect(host.querySelectorAll("article").length).toBeLessThan(100);
  window.scrollTo(0, 0);
});

it("restores a reading game's viewport offset across a fresh measurement cache", async () => {
  await render("rows");
  await mountDestination({ portId: "game-1200" });
  await act(async () => details(1200)!.focus());
  const anchor = captureCollectionDestination(workspace)!;
  const top = card(1200)!.getBoundingClientRect().top;
  const scrollTop = workspace.scrollTop;
  await act(async () => root.render(<Fixture key="new-measurements" layout="rows" />));
  workspace = host.querySelector("main")!;
  await frames();
  expect(await mountDestination({ ...anchor, scrollTop })).toBe(true);
  expect(Math.abs(card(1200)!.getBoundingClientRect().top - top)).toBeLessThan(1);
  await frames();
  expect(Math.abs(card(1200)!.getBoundingClientRect().top - top)).toBeLessThan(1);
});

it("waits for the accepted deferred query before mounting a restored destination", async () => {
  await act(async () =>
    root.render(<Fixture layout="rows" ready={false} queryKey="saved narrow query" />),
  );
  workspace = host.querySelector("main")!;
  await frames();
  expect(host.querySelectorAll("article")).toHaveLength(0);
  let pending!: Promise<boolean>;
  await act(async () => {
    pending = mountCollectionDestination(workspace, { portId: "game-900" }, () => true);
    root.render(
      <Fixture
        layout="rows"
        ready
        queryKey="saved narrow query"
        matching={groups.slice(900, 902)}
      />,
    );
  });
  expect(await settleMount(pending)).toBe(true);
  expect(card(900)).not.toBeNull();
  expect(host.querySelectorAll("article")).toHaveLength(2);
});
