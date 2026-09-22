// @vitest-environment jsdom
import {
  act,
  createElement,
  useState,
  type Dispatch,
  type RefObject,
  type SetStateAction,
} from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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

  it("focuses an overflow destination and returns to its exact card trigger", async () => {
    const trigger = document.createElement("button");
    trigger.dataset.detailOrigin = "library:card-more:port-a";
    const heading = document.createElement("h2");
    heading.id = "detail-saves-and-storage";
    heading.tabIndex = -1;
    document.body.append(trigger, heading);

    await act(async () => navigation.open("port-a", trigger.dataset.detailOrigin, "saves"));
    expect(document.activeElement).toBe(heading);
    expect(heading.scrollIntoView).toHaveBeenCalledWith({ block: "start" });
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
    main.scrollTop = 114;
    card.focus();

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
