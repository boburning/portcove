import { afterEach, expect, it, vi } from "vite-plus/test";
import { listenDesktopEvent } from "./desktop-events";

afterEach(() => vi.unstubAllGlobals());

function bridge() {
  let next = 10;
  const callbacks = new Map<number, (value: unknown) => void>();
  const listeners = new Map<number, number>();
  const rejection = { error: "native event registration rejected" };
  let reject = false;
  const unregisterCallback = vi.fn((id: number) => callbacks.delete(id));
  const invoke = vi.fn((command: string, args: { handler: number; eventId: number }) => {
    if (command === "plugin:event|listen") {
      if (reject) return Promise.reject(rejection);
      const id = next++;
      listeners.set(id, args.handler);
      return Promise.resolve(id);
    }
    if (command !== "plugin:event|unlisten") throw new Error("Unexpected command");
    listeners.delete(args.eventId);
    return Promise.resolve(null);
  });
  vi.stubGlobal("window", {
    __TAURI_INTERNALS__: {
      invoke,
      transformCallback(callback: (value: unknown) => void) {
        const id = next++;
        callbacks.set(id, callback);
        return id;
      },
      unregisterCallback,
    },
    __TAURI_EVENT_PLUGIN_INTERNALS__: {
      unregisterListener(_event: string, eventId: number) {
        const handler = listeners.get(eventId);
        if (handler !== undefined) unregisterCallback(handler);
      },
    },
  });
  return {
    callbacks,
    listeners,
    rejection,
    invoke,
    unregisterCallback,
    reject() {
      reject = true;
    },
  };
}

it("releases only each refused event callback and preserves the original error and live listener", async () => {
  const native = bridge();
  const unrelated = () => {};
  native.callbacks.set(1, unrelated);
  const dispose = await listenDesktopEvent("portcove://operation", vi.fn());
  const live = [...native.callbacks];
  native.reject();
  for (let attempt = 0; attempt < 3; attempt++) {
    await expect(listenDesktopEvent("portcove://operation", vi.fn())).rejects.toBe(
      native.rejection,
    );
    expect([...native.callbacks]).toEqual(live);
    expect(native.listeners.size).toBe(1);
  }
  expect(
    native.invoke.mock.calls.filter(([command]) => command === "plugin:event|unlisten"),
  ).toHaveLength(0);
  await Promise.resolve(dispose());
  expect([...native.callbacks]).toEqual([[1, unrelated]]);
  expect(native.listeners.size).toBe(0);
  expect(native.unregisterCallback).toHaveBeenCalledTimes(4);
});
