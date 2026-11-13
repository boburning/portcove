import {
  act,
  createElement,
  useState,
  type Dispatch,
  type RefObject,
  type SetStateAction,
} from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { useDetailWorkspaceNavigation } from "./use-detail-workspace-navigation";

let root: Root | undefined;
let selectedId: string | undefined;
let select: Dispatch<SetStateAction<string | undefined>>;
let setAvailablePortIds: Dispatch<SetStateAction<ReadonlySet<string> | undefined>>;
let navigation: ReturnType<typeof useDetailWorkspaceNavigation>;
let workspace: RefObject<HTMLElement | null>;

function Fixture() {
  const [selection, setSelection] = useState<string>();
  const [available, setAvailable] = useState<ReadonlySet<string> | undefined>(
    new Set(["port-a", "port-b"]),
  );
  selectedId = selection;
  select = setSelection;
  setAvailablePortIds = setAvailable;
  navigation = useDetailWorkspaceNavigation(workspace, setSelection, available);
  return null;
}

beforeEach(async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
    callback(0);
    return 1;
  });
  Object.defineProperty(HTMLElement.prototype, "scrollTo", {
    configurable: true,
    value: vi.fn(),
  });
  HTMLElement.prototype.scrollIntoView = vi.fn();
  workspace = { current: document.createElement("main") };
  vi.stubGlobal("CSS", { escape: (value: string) => value });
  const testRoot = createRoot(document.createElement("div"));
  root = testRoot;
  await act(async () => testRoot.render(createElement(Fixture)));
});

afterEach(async () => {
  if (root) await act(async () => root?.unmount());
  root = undefined;
  document.body.replaceChildren();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("detail workspace navigation", () => {
  it("switches implementations without losing the original group return and browsing scroll", async () => {
    const main = workspace.current!;
    main.style.cssText = "height:100px;overflow:auto";
    const spacer = document.createElement("div");
    spacer.style.height = "2000px";
    const group = document.createElement("section");
    group.dataset.detailReturnGroup = "game:original";
    const trigger = document.createElement("button");
    trigger.dataset.detailOrigin = "catalog:card:port-a";
    trigger.dataset.detailGameId = "port-a";
    group.append(trigger);
    main.append(group, spacer);
    document.body.append(main);
    main.scrollTop = 114;
    expect(main.scrollTop).toBe(114);
    await act(async () => navigation.open("port-a", trigger.dataset.detailOrigin));
    const staleClose = navigation.close;
    main.scrollTop = 700;
    expect(main.scrollTop).toBe(700);
    await act(async () => navigation.replace("port-b"));
    expect(selectedId).toBe("port-b");
    await act(async () => staleClose());
    expect(selectedId).toBe("port-b");
    // The preferred implementation changed while details were open, replacing
    // the original card control. The stable game group is still the return point.
    trigger.remove();
    const replacement = document.createElement("button");
    replacement.dataset.detailGameId = "port-b";
    group.append(replacement);
    await act(async () => navigation.close());
    expect(document.activeElement).toBe(replacement);
    expect(main.scrollTo).toHaveBeenLastCalledWith({ top: 114 });
    expect(selectedId).toBeUndefined();
  });

  it("checks disappearance of the currently viewed alternative rather than its original return target", async () => {
    await act(async () => navigation.open("port-a", "library:card:port-a"));
    await act(async () => navigation.replace("port-b"));
    await act(async () => setAvailablePortIds(new Set(["port-b"])));
    expect(selectedId).toBe("port-b");
    await act(async () => setAvailablePortIds(new Set(["port-a"])));
    expect(selectedId).toBeUndefined();
  });

  it("ignores a retained completion callback after another detail opening replaces it", async () => {
    await act(async () => navigation.open("port-a", "library:card:port-a"));
    const deferredRemovalClose = navigation.close;

    await act(async () => navigation.open("port-b", "library:card:port-b"));
    await act(async () => deferredRemovalClose());

    expect(selectedId).toBe("port-b");
  });

  it("restores the exact initiating control when the same port has several origins", async () => {
    const first = document.createElement("button");
    first.dataset.detailOrigin = "updates:installed:port-a";
    const initiating = document.createElement("button");
    initiating.dataset.detailOrigin = "updates:activity:job-7:target";
    document.body.append(first, initiating);

    await act(async () => navigation.open("port-a", initiating.dataset.detailOrigin));
    await act(async () => navigation.close());

    expect(document.activeElement).toBe(initiating);
    expect(selectedId).toBeUndefined();
  });

  it("restores the stable command trigger after a command opens details", async () => {
    const commandTrigger = document.createElement("button");
    commandTrigger.dataset.detailOrigin = "command-trigger:library";
    document.body.append(commandTrigger);

    await act(async () => navigation.open("port-a", "command-trigger:library"));
    await act(async () => navigation.close());

    expect(document.activeElement).toBe(commandTrigger);
  });

  it("returns to the same game title if repair replaces the review opener", async () => {
    const unrelated = document.createElement("button");
    unrelated.dataset.detailGameId = "port-b";
    const title = document.createElement("button");
    title.dataset.detailGameId = "port-a";
    const review = document.createElement("button");
    review.dataset.detailOrigin = "library:card:port-a:review";
    document.body.append(unrelated, title, review);
    await act(async () => navigation.open("port-a", review.dataset.detailOrigin));
    review.remove();
    await act(async () => navigation.close());
    expect(document.activeElement).toBe(title);
  });

  it("carries an overflow destination to the rendered owner and returns to its exact card trigger", async () => {
    const trigger = document.createElement("button");
    trigger.dataset.detailOrigin = "library:card-more:port-a";
    const heading = document.createElement("h2");
    heading.id = "detail-saves-and-storage";
    heading.tabIndex = -1;
    document.body.append(trigger, heading);

    await act(async () => navigation.open("port-a", trigger.dataset.detailOrigin, "saves"));
    expect(navigation.opening).toEqual({
      token: 1,
      destination: "saves",
      originKey: trigger.dataset.detailOrigin,
    });
    expect(document.activeElement).not.toBe(heading);
    await act(async () => navigation.close());
    expect(document.activeElement).toBe(trigger);
  });

  it("ignores a retained completion callback after primary navigation invalidates the opening", async () => {
    await act(async () => navigation.open("port-a", "library:card:port-a"));
    const deferredRemovalClose = navigation.close;

    await act(async () => {
      navigation.invalidate();
      select(undefined);
    });
    await act(async () => deferredRemovalClose());

    expect(selectedId).toBeUndefined();
  });

  it("returns to browsing when the selected catalog entry disappears", async () => {
    vi.spyOn(HTMLElement.prototype, "getClientRects").mockImplementation(
      () => [new DOMRect(0, 0, 100, 20)] as unknown as DOMRectList,
    );
    const main = workspace.current!;
    main.dataset.focusRegion = "workspace";
    const search = document.createElement("input");
    search.id = "port-search";
    const card = document.createElement("button");
    card.dataset.detailOrigin = "library:card:port-a";
    main.append(search, card);
    document.body.append(main);
    main.style.cssText = "height:100px;overflow:auto";
    const spacer = document.createElement("div");
    spacer.style.height = "2000px";
    main.append(spacer);
    main.scrollTop = 114;
    card.focus({ preventScroll: true });

    await act(async () => navigation.open("port-a", card.dataset.detailOrigin));
    await act(async () => setAvailablePortIds(undefined));
    expect(selectedId).toBe("port-a");

    card.remove();
    await act(async () => setAvailablePortIds(new Set(["port-b"])));

    expect(selectedId).toBeUndefined();
    expect(document.activeElement).toBe(search);
    expect(main.scrollTo).toHaveBeenLastCalledWith({ top: 114 });
  });
});
