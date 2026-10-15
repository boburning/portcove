import { fixtureValue } from "./test-fixtures";
// @vitest-environment jsdom
import type { DragDropEvent } from "@tauri-apps/api/webview";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import {
  createNativeSourceDropCoordinator,
  sourceDropTargetAt,
  useNativeSourceDrop,
  type NativeSourceDragState,
} from "./native-source-drop";

const nativeEvents = vi.hoisted(() => ({
  current: vi.fn(),
  register:
    vi.fn<
      (callback: (event: { payload: DragDropEvent }) => void) => Promise<() => void | Promise<void>>
    >(),
}));
vi.mock("@tauri-apps/api/webview", () => ({ getCurrentWebview: nativeEvents.current }));

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  nativeEvents.current.mockReset().mockReturnValue({ onDragDropEvent: nativeEvents.register });
  nativeEvents.register.mockReset();
});

let mountedRoot: Root | undefined;
afterEach(async () => {
  await act(async () => mountedRoot?.unmount());
  mountedRoot = undefined;
  vi.unstubAllGlobals();
});

async function mountSourceDrop(accept = vi.fn()) {
  let state: NativeSourceDragState;
  function Probe() {
    state = useNativeSourceDrop(accept);
    return null;
  }
  const root = createRoot(document.createElement("div"));
  mountedRoot = root;
  await act(async () => root.render(createElement(Probe)));
  return {
    unmount() {
      act(() => root.unmount());
      mountedRoot = undefined;
    },
    result: {
      get current() {
        return state;
      },
    },
  };
}

const position = { x: 20, y: 40 };
const native = (event: object) => event as DragDropEvent;

describe("native source listener lifetime", () => {
  it("invokes awaitable cleanup during synchronous effect teardown", async () => {
    const remove = vi.fn(async () => {});
    nativeEvents.register.mockResolvedValue(remove);
    const hook = await mountSourceDrop();
    await act(async () => {});

    hook.unmount();
    expect(remove).toHaveBeenCalledTimes(1);
    await act(async () => {});
  });

  it("cleans up registration that resolves after disposal", async () => {
    const remove = vi.fn(async () => {});
    let resolveRegistration!: (cleanup: typeof remove) => void;
    nativeEvents.register.mockReturnValue(
      new Promise<typeof remove>((resolve) => (resolveRegistration = resolve)),
    );
    const hook = await mountSourceDrop();
    await act(async () => {});
    hook.unmount();
    expect(remove).not.toHaveBeenCalled();

    await act(async () => resolveRegistration(remove));
    expect(remove).toHaveBeenCalledTimes(1);
  });

  it.each(["normal teardown", "late registration"])(
    "handles rejected cleanup after %s without an unhandled promise",
    async (path) => {
      const remove = vi.fn(async () => {
        throw new Error("webview was destroyed");
      });
      let resolveRegistration!: (cleanup: typeof remove) => void;
      nativeEvents.register.mockReturnValue(
        new Promise<typeof remove>((resolve) => (resolveRegistration = resolve)),
      );
      const hook = await mountSourceDrop();
      await act(async () => {});
      if (path === "normal teardown") {
        await act(async () => resolveRegistration(remove));
        hook.unmount();
      } else {
        hook.unmount();
        await act(async () => resolveRegistration(remove));
      }
      await act(async () => {});
      expect(remove).toHaveBeenCalledTimes(1);
    },
  );

  it("ignores native callbacks after disposal", async () => {
    const remove = vi.fn();
    nativeEvents.register.mockResolvedValue(remove);
    const accept = vi.fn();
    const hook = await mountSourceDrop(accept);
    await act(async () => {});
    hook.unmount();
    const payload = native({ type: "drop", paths: ["D:/Game.z64"], position });
    Object.defineProperty(payload, "position", {
      get: () => {
        throw new Error("disposed event must not reach the coordinator");
      },
    });

    expect(() =>
      fixtureValue(nativeEvents.register.mock.calls[0], "nativeEvents.register.mock.calls[0]")[0]({
        payload,
      }),
    ).not.toThrow();
    expect(accept).not.toHaveBeenCalled();
  });

  it("keeps browser-only operation quiet when native registration throws", async () => {
    nativeEvents.current.mockImplementation(() => {
      throw new Error("no native webview");
    });
    const hook = await mountSourceDrop();
    await act(async () => {});
    expect(hook.result.current).toEqual({ active: false, pathCount: 0 });
    hook.unmount();
  });
});

describe("native source drag coordination", () => {
  it("reveals targets only for native enter/over and clears them on leave", () => {
    const states: object[] = [];
    const accept = vi.fn();
    const handle = createNativeSourceDropCoordinator(
      (state) => states.push(state),
      accept,
      () => ({ portId: "port", profileId: "source" }),
    );

    handle(native({ type: "enter", paths: ["D:/Game.z64"], position }));
    handle(native({ type: "over", position }));
    handle(native({ type: "leave" }));

    expect(states).toEqual([
      { active: true, pathCount: 1, targetPortId: "port" },
      { active: true, pathCount: 1, targetPortId: "port" },
      { active: false, pathCount: 0 },
    ]);
    expect(accept).not.toHaveBeenCalled();
  });

  it("passes the exact external paths only after a native drop over an eligible card", () => {
    const accept = vi.fn();
    const handle = createNativeSourceDropCoordinator(vi.fn(), accept, (point) =>
      point.x === 20 ? { portId: "port", profileId: "source" } : undefined,
    );

    handle(
      native({
        type: "drop",
        paths: ["D:/Disc 1.chd", "D:/Disc 2.chd"],
        position,
      }),
    );
    handle(
      native({
        type: "drop",
        paths: ["D:/Ignored.z64"],
        position: { x: 0, y: 0 },
      }),
    );

    expect(accept).toHaveBeenCalledTimes(1);
    expect(accept).toHaveBeenCalledWith({
      portId: "port",
      profileId: "source",
      paths: ["D:/Disc 1.chd", "D:/Disc 2.chd"],
    });
  });

  it("omits target identity while a native drag is outside eligible cards", () => {
    const states: object[] = [];
    const handle = createNativeSourceDropCoordinator(
      (state) => states.push(state),
      vi.fn(),
      () => undefined,
    );

    handle(native({ type: "enter", paths: ["D:/Game.z64"], position }));

    expect(states).toEqual([{ active: true, pathCount: 1 }]);
  });

  it("maps physical native coordinates to the card data contract", () => {
    const card = document.createElement("button");
    card.dataset.sourceDropPortId = "port";
    card.dataset.sourceDropProfileId = "source";
    const child = document.createElement("span");
    card.append(child);
    const elementAt = vi.fn(() => child);

    expect(sourceDropTargetAt(position, elementAt, 2)).toEqual({
      portId: "port",
      profileId: "source",
    });
    expect(elementAt).toHaveBeenCalledWith(10, 20);
  });
});
