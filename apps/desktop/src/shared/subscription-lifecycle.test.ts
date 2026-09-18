import { describe, expect, it, vi } from "vitest";
import { startManagedSubscription } from "./subscription-lifecycle";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((accept) => {
    resolve = accept;
  });
  return { promise, resolve };
}

describe("managed desktop subscriptions", () => {
  it("reports rejected setup without an unhandled rejection", async () => {
    const error = new Error("event bridge unavailable");
    const onFailure = vi.fn();
    const subscription = startManagedSubscription({
      register: () => Promise.reject(error),
      onEvent: vi.fn(),
      onFailure,
    });
    await expect(subscription.ready).resolves.toBe(false);
    expect(onFailure).toHaveBeenCalledWith(error);
  });

  it("reports synchronous setup failure through the same path", async () => {
    const error = new Error("bridge setup threw");
    const onFailure = vi.fn();
    const subscription = startManagedSubscription<string>({
      register: () => {
        throw error;
      },
      onEvent: vi.fn(),
      onFailure,
    });
    await expect(subscription.ready).resolves.toBe(false);
    expect(onFailure).toHaveBeenCalledWith(error);
  });

  it("disposes a registration that resolves after cleanup and ignores late events", async () => {
    const registration = deferred<() => void>();
    const dispose = vi.fn();
    const onEvent = vi.fn();
    let accept!: (payload: string) => void;
    const subscription = startManagedSubscription({
      register: (handler) => {
        accept = handler;
        return registration.promise;
      },
      onEvent,
    });
    subscription.stop();
    registration.resolve(dispose);
    await expect(subscription.ready).resolves.toBe(false);
    accept("late");
    expect(dispose).toHaveBeenCalledOnce();
    expect(onEvent).not.toHaveBeenCalled();
  });

  it("contains asynchronous disposal failures", async () => {
    const dispose = vi.fn().mockRejectedValue(new Error("closed bridge"));
    const subscription = startManagedSubscription({
      register: () => Promise.resolve(dispose),
      onEvent: vi.fn(),
    });
    await expect(subscription.ready).resolves.toBe(true);
    subscription.stop();
    await Promise.resolve();
    expect(dispose).toHaveBeenCalledOnce();
  });
});
