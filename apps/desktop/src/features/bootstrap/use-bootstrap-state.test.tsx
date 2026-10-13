// @vitest-environment jsdom
import { act, createElement, StrictMode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, assert, beforeEach, describe, expect, it, vi } from "vitest";
import { desktopApi } from "../../api";
import { BootstrapRecovery } from "../../App";
import { failureReport } from "../../test-fixtures";
import type { BootstrapStatus } from "../../types";
import { useBootstrapState } from "./use-bootstrap-state";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

const ready = (generation: number) => ({ ready: true, generation }) as BootstrapStatus;
let root: Root;
let host: HTMLDivElement;
let state: ReturnType<typeof useBootstrapState>;
const getGamepads = vi.fn((): Gamepad[] => []);
let gamepadsDescriptor: PropertyDescriptor | undefined;
let originalRequestFrame: typeof requestAnimationFrame;
let originalCancelFrame: typeof cancelAnimationFrame;
let frames: Map<number, FrameRequestCallback>;
let frameId: number;
let timestamp: number;

function Fixture({
  chooseFolder = async () => null,
}: {
  chooseFolder?: () => Promise<string | null>;
}) {
  state = useBootstrapState(chooseFolder);
  return state.bootstrapError
    ? createElement(BootstrapRecovery, {
        error: state.bootstrapError,
        recoveryPending: state.recoveryPending,
        chooseLibrary: state.chooseLibrary,
        resetLibrary: state.resetLibrary,
      })
    : createElement("output", { "data-generation": state.bootstrap?.generation });
}

async function render(chooseFolder?: () => Promise<string | null>) {
  await act(async () => root.render(createElement(Fixture, { chooseFolder })));
}

async function frame() {
  timestamp += 16;
  await act(async () => {
    // Advance only this frame's snapshot; polling can queue the next frame.
    for (const [id, callback] of [...frames.entries()]) {
      frames.delete(id);
      callback(timestamp);
    }
  });
}

beforeEach(() => {
  frames = new Map();
  frameId = 0;
  timestamp = 0;
  getGamepads.mockClear();
  gamepadsDescriptor = Object.getOwnPropertyDescriptor(navigator, "getGamepads");
  Object.defineProperty(navigator, "getGamepads", {
    configurable: true,
    writable: true,
    value: getGamepads,
  });
  originalRequestFrame = requestAnimationFrame;
  originalCancelFrame = cancelAnimationFrame;
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
    frames.set(++frameId, callback);
    return frameId;
  });
  vi.stubGlobal("cancelAnimationFrame", (id: number) => {
    frames.delete(id);
  });
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});

afterEach(async () => {
  try {
    await act(async () => root.unmount());
    assert.strictEqual(frames.size, 0, "root disposal must cancel every owned frame");
    assert.strictEqual(
      navigator.getGamepads,
      getGamepads,
      "fixture API must outlive root disposal",
    );
  } finally {
    host.remove();
    if (gamepadsDescriptor) Object.defineProperty(navigator, "getGamepads", gamepadsDescriptor);
    else Reflect.deleteProperty(navigator, "getGamepads");
    frames.clear();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  }
  assert.deepEqual(Object.getOwnPropertyDescriptor(navigator, "getGamepads"), gamepadsDescriptor);
  assert.strictEqual(requestAnimationFrame, originalRequestFrame);
  assert.strictEqual(cancelAnimationFrame, originalCancelFrame);
});

describe("bootstrap state", () => {
  it("publishes the initial bootstrap status", async () => {
    const pending = deferred<BootstrapStatus>();
    vi.spyOn(desktopApi, "bootstrapStatus").mockReturnValue(pending.promise);
    await render();
    expect(state.bootstrap).toBeUndefined();

    await act(async () => pending.resolve(ready(1)));

    expect(state.bootstrap).toEqual(ready(1));
    expect(state.bootstrapError).toBeUndefined();
  });

  it("normalizes an unstructured bootstrap failure", async () => {
    vi.spyOn(desktopApi, "bootstrapStatus").mockRejectedValue(new Error("offline"));
    await render();

    expect(state.bootstrap).toBeUndefined();
    expect(state.bootstrapError).toEqual({ code: "state", message: "offline", details: {} });
  });

  it("does not switch libraries when folder selection is cancelled", async () => {
    vi.spyOn(desktopApi, "bootstrapStatus").mockResolvedValue(ready(1));
    const setDefault = vi.spyOn(desktopApi, "setDefaultLibrary");
    const chooseFolder = vi.fn().mockResolvedValue(null);
    await render(chooseFolder);

    await act(async () => state.chooseLibrary("D:/current"));

    expect(chooseFolder).toHaveBeenCalledWith("D:/current");
    expect(setDefault).not.toHaveBeenCalled();
    expect(state.bootstrap).toEqual(ready(1));
  });

  it("publishes successful library switches and resets", async () => {
    vi.spyOn(desktopApi, "bootstrapStatus").mockRejectedValue(new Error("offline"));
    vi.spyOn(desktopApi, "setDefaultLibrary").mockResolvedValue(ready(2));
    vi.spyOn(desktopApi, "resetDefaultLibrary").mockResolvedValue(ready(3));
    const chooseFolder = vi.fn().mockResolvedValue("E:/library");
    await render(chooseFolder);
    expect(state.bootstrapError).toBeDefined();

    await act(async () => state.chooseLibrary());
    expect(desktopApi.setDefaultLibrary).toHaveBeenCalledWith("E:/library");
    expect(state.bootstrap).toEqual(ready(2));
    expect(state.bootstrapError).toBeUndefined();

    await act(async () => state.resetLibrary());
    expect(desktopApi.resetDefaultLibrary).toHaveBeenCalledOnce();
    expect(state.bootstrap).toEqual(ready(3));
  });

  it("keeps actual recovery controls pending until selection IPC settles", async () => {
    const selection = deferred<BootstrapStatus>();
    vi.spyOn(desktopApi, "bootstrapStatus").mockRejectedValue(new Error("offline"));
    const setDefault = vi.spyOn(desktopApi, "setDefaultLibrary").mockReturnValue(selection.promise);
    const reset = vi.spyOn(desktopApi, "resetDefaultLibrary");
    await render(async () => "/fixture/library");
    const buttons = [...host.querySelectorAll("button")];
    const choose = buttons.find((button) => button.textContent === "Choose library")!;
    const useDefault = buttons.find((button) => button.textContent === "Use platform default")!;
    await act(async () => choose.click());
    expect(setDefault).toHaveBeenCalledExactlyOnceWith("/fixture/library");
    expect(state.recoveryPending).toBe(true);
    expect(choose.disabled).toBe(true);
    expect(useDefault.disabled).toBe(true);
    expect(choose.parentElement?.getAttribute("aria-busy")).toBe("true");
    await act(async () => useDefault.click());
    expect(reset).not.toHaveBeenCalled();
    await frame();
    expect(getGamepads).toHaveBeenCalledOnce();
    expect(frames.size).toBe(1);
    await act(async () => selection.resolve(ready(2)));
    expect(state.bootstrap).toEqual(ready(2));
    expect(state.bootstrapError).toBeUndefined();
    expect(state.recoveryPending).toBe(false);
    expect(frames.size).toBe(0);
    await frame();
    expect(getGamepads).toHaveBeenCalledOnce();
  });

  it("guards overlapping commands synchronously before React rerenders", async () => {
    const selection = deferred<BootstrapStatus>();
    vi.spyOn(desktopApi, "bootstrapStatus").mockResolvedValue(ready(1));
    const setDefault = vi.spyOn(desktopApi, "setDefaultLibrary").mockReturnValue(selection.promise);
    const reset = vi.spyOn(desktopApi, "resetDefaultLibrary");
    await render();
    let first!: Promise<void>;
    await act(async () => {
      first = state.switchLibrary("/fixture/first");
      await state.resetLibrary();
      await state.switchLibrary("/fixture/second");
    });
    expect(setDefault).toHaveBeenCalledExactlyOnceWith("/fixture/first");
    expect(reset).not.toHaveBeenCalled();
    await act(async () => {
      selection.resolve(ready(2));
      await first;
    });
    expect(state.recoveryPending).toBe(false);
  });

  it("releases a cancelled picker so default recovery remains available", async () => {
    const picker = deferred<string | null>();
    vi.spyOn(desktopApi, "bootstrapStatus").mockRejectedValue(new Error("offline"));
    const setDefault = vi.spyOn(desktopApi, "setDefaultLibrary");
    const reset = vi.spyOn(desktopApi, "resetDefaultLibrary").mockResolvedValue(ready(2));
    await render(() => picker.promise);
    let choosing!: Promise<void>;
    await act(async () => {
      choosing = state.chooseLibrary();
    });
    expect(state.recoveryPending).toBe(true);
    await act(async () => state.resetLibrary());
    expect(reset).not.toHaveBeenCalled();
    await act(async () => {
      picker.resolve(null);
      await choosing;
    });
    expect(setDefault).not.toHaveBeenCalled();
    expect(state.recoveryPending).toBe(false);
    expect(state.bootstrapError?.message).toBe("offline");
    await act(async () => state.resetLibrary());
    expect(reset).toHaveBeenCalledOnce();
    expect(state.bootstrap).toEqual(ready(2));
  });

  it("settles a reset failure and permits a later successful switch", async () => {
    vi.spyOn(desktopApi, "bootstrapStatus").mockRejectedValue(new Error("offline"));
    vi.spyOn(desktopApi, "resetDefaultLibrary").mockRejectedValue(new Error("reset refused"));
    vi.spyOn(desktopApi, "setDefaultLibrary").mockResolvedValue(ready(2));
    await render();
    await act(async () => {
      await expect(state.resetLibrary()).rejects.toThrow("reset refused");
    });
    expect(state.recoveryPending).toBe(false);
    expect(state.bootstrapError?.message).toBe("offline");
    await act(async () => state.switchLibrary("/fixture/recovered"));
    expect(state.bootstrap).toEqual(ready(2));
    expect(state.bootstrapError).toBeUndefined();
  });

  it("settles a picker failure without dispatching a selection", async () => {
    vi.spyOn(desktopApi, "bootstrapStatus").mockResolvedValue(ready(1));
    const setDefault = vi.spyOn(desktopApi, "setDefaultLibrary");
    await render(async () => {
      throw new Error("picker unavailable");
    });
    await act(async () => {
      await expect(state.chooseLibrary()).rejects.toThrow("picker unavailable");
    });
    expect(setDefault).not.toHaveBeenCalled();
    expect(state.recoveryPending).toBe(false);
    expect(state.bootstrap).toEqual(ready(1));
  });

  it("preserves typed startup and current selection failures", async () => {
    const failure = failureReport();
    vi.spyOn(desktopApi, "bootstrapStatus").mockRejectedValue(failure);
    vi.spyOn(desktopApi, "resetDefaultLibrary").mockRejectedValue(failure);
    await render();
    expect(state.bootstrapError).toBe(failure);
    await act(async () => {
      await expect(state.resetLibrary()).rejects.toBe(failure);
    });
    expect(state.bootstrapError).toBe(failure);
    expect(state.recoveryPending).toBe(false);
  });

  it("shows a current reset failure and enables the actual recovery control again", async () => {
    vi.spyOn(desktopApi, "bootstrapStatus").mockRejectedValue(new Error("offline"));
    const reset = vi
      .spyOn(desktopApi, "resetDefaultLibrary")
      .mockRejectedValueOnce(new Error("reset refused"))
      .mockResolvedValueOnce(ready(2));
    await render();
    const useDefault = [...host.querySelectorAll("button")].find(
      (button) => button.textContent === "Use platform default",
    )!;
    await act(async () => useDefault.click());
    expect([...host.querySelectorAll('[role="alert"]')].map((alert) => alert.textContent)).toEqual([
      "offline",
      "reset refused",
    ]);
    expect(useDefault.disabled).toBe(false);
    expect(state.recoveryPending).toBe(false);
    await act(async () => useDefault.click());
    expect(reset).toHaveBeenCalledTimes(2);
    expect(state.bootstrap).toEqual(ready(2));
    expect(host.querySelector("p[role=alert]")).toBeNull();
  });

  it("does not regress the host generation in a selection reply", async () => {
    vi.spyOn(desktopApi, "bootstrapStatus").mockResolvedValue(ready(3));
    vi.spyOn(desktopApi, "resetDefaultLibrary").mockResolvedValue(ready(2));
    await render();
    await act(async () => state.resetLibrary());
    expect(state.bootstrap).toEqual(ready(3));
    expect(state.recoveryPending).toBe(false);
  });

  it.each(["snapshot", "error"])(
    "ignores an obsolete StrictMode startup %s after recovery",
    async (outcome) => {
      const obsolete = deferred<BootstrapStatus>();
      const current = deferred<BootstrapStatus>();
      vi.spyOn(desktopApi, "bootstrapStatus")
        .mockReturnValueOnce(obsolete.promise)
        .mockReturnValueOnce(current.promise);
      vi.spyOn(desktopApi, "resetDefaultLibrary").mockResolvedValue(ready(2));
      await act(async () => root.render(createElement(StrictMode, null, createElement(Fixture))));
      expect(desktopApi.bootstrapStatus).toHaveBeenCalledTimes(2);
      await act(async () => current.reject(new Error("offline")));
      await act(async () => state.resetLibrary());
      await act(async () => {
        if (outcome === "snapshot") obsolete.resolve(ready(1));
        else obsolete.reject(new Error("obsolete startup error"));
      });
      expect(state.bootstrap).toEqual(ready(2));
      expect(state.bootstrapError).toBeUndefined();
    },
  );

  it("does not dispatch a disposed picker completion or retained callback", async () => {
    const picker = deferred<string | null>();
    vi.spyOn(desktopApi, "bootstrapStatus").mockResolvedValue(ready(1));
    const setDefault = vi.spyOn(desktopApi, "setDefaultLibrary");
    const reset = vi.spyOn(desktopApi, "resetDefaultLibrary");
    await render(() => picker.promise);
    const retainedReset = state.resetLibrary;
    let choosing!: Promise<void>;
    await act(async () => {
      choosing = state.chooseLibrary();
    });
    await act(async () => root.unmount());
    await act(async () => {
      picker.resolve("/fixture/obsolete");
      await choosing;
      await retainedReset();
    });
    expect(setDefault).not.toHaveBeenCalled();
    expect(reset).not.toHaveBeenCalled();
  });

  it.each(["snapshot", "error"])(
    "keeps a replacement owner unaffected by a disposed selection %s",
    async (outcome) => {
      const selection = deferred<BootstrapStatus>();
      vi.spyOn(desktopApi, "bootstrapStatus").mockResolvedValue(ready(1));
      vi.spyOn(desktopApi, "setDefaultLibrary").mockReturnValue(selection.promise);
      await render();
      let switching!: Promise<void>;
      await act(async () => {
        switching = state.switchLibrary("/fixture/old-owner");
      });
      await act(async () => root.unmount());
      root = createRoot(host);
      vi.spyOn(desktopApi, "bootstrapStatus").mockResolvedValue(ready(3));
      await render();
      await act(async () => {
        if (outcome === "snapshot") selection.resolve(ready(2));
        else selection.reject(new Error("obsolete selection failure"));
        await switching;
      });
      expect(state.bootstrap).toEqual(ready(3));
      expect(state.bootstrapError).toBeUndefined();
      expect(state.recoveryPending).toBe(false);
    },
  );
});
