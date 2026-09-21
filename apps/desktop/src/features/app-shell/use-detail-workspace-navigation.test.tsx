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
let navigation: ReturnType<typeof useDetailWorkspaceNavigation>;
let workspace: RefObject<HTMLElement | null>;

function Fixture() {
  const [selection, setSelection] = useState<string>();
  selectedId = selection;
  select = setSelection;
  navigation = useDetailWorkspaceNavigation(workspace, setSelection);
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
});
