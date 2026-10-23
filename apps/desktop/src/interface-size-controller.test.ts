import { expect, it, vi } from "vite-plus/test";
import {
  InterfaceSizeController,
  INTERFACE_SIZE_KEY,
  readInterfaceSize,
} from "./interface-size-controller";

function deferred() {
  let resolve!: () => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<void>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

it("defaults invalid or unavailable profile storage to 100%", () => {
  for (const value of [null, "", "225", "NaN", "401", "-100"])
    expect(readInterfaceSize(() => ({ getItem: () => value, setItem: vi.fn() }))).toBe(100);
  expect(
    readInterfaceSize(() => {
      throw new Error("blocked");
    }),
  ).toBe(100);
});

it("restores the profile preference once and persists only after native success", async () => {
  const call = deferred();
  const apply = vi.fn(() => call.promise);
  const setItem = vi.fn();
  const controller = new InterfaceSizeController(apply, () => ({ getItem: () => "250", setItem }));
  controller.start();
  controller.start();
  expect(apply).toHaveBeenCalledExactlyOnceWith(2.5);
  expect(setItem).not.toHaveBeenCalled();
  call.resolve();
  await vi.waitFor(() => expect(controller.getSnapshot().pending).toBe(false));
  expect(setItem).toHaveBeenCalledExactlyOnceWith(INTERFACE_SIZE_KEY, "250");
  expect(controller.getSnapshot().applied).toBe(250);
});

it("explicitly reapplies the default after a missing preference instead of assuming native zoom reset", async () => {
  const apply = vi.fn(async () => {});
  const controller = new InterfaceSizeController(apply, () => ({
    getItem: () => null,
    setItem: vi.fn(),
  }));
  controller.start();
  await vi.waitFor(() => expect(controller.getSnapshot().pending).toBe(false));
  expect(apply).toHaveBeenCalledExactlyOnceWith(1);
  expect(controller.getSnapshot().applied).toBe(100);
});

it("serializes and coalesces rapid choices while following the latest intent", async () => {
  const first = deferred();
  const second = deferred();
  const apply = vi.fn().mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
  const setItem = vi.fn();
  const controller = new InterfaceSizeController(apply, () => ({ getItem: () => null, setItem }));
  controller.request(125);
  controller.step(1);
  controller.step(1);
  controller.request(400);
  expect(apply).toHaveBeenCalledExactlyOnceWith(1.25);
  expect(controller.getSnapshot().requested).toBe(400);
  first.resolve();
  await vi.waitFor(() => expect(apply).toHaveBeenCalledTimes(2));
  expect(apply).toHaveBeenLastCalledWith(4);
  expect(setItem.mock.calls).toEqual([[INTERFACE_SIZE_KEY, "125"]]);
  expect(controller.getSnapshot().pending).toBe(true);
  second.resolve();
  await vi.waitFor(() => expect(controller.getSnapshot().pending).toBe(false));
  expect(controller.getSnapshot().applied).toBe(400);
  expect(setItem.mock.calls).toEqual([
    [INTERFACE_SIZE_KEY, "125"],
    [INTERFACE_SIZE_KEY, "400"],
  ]);
});

it("retains the applied size and preference after failure, then permits reset", async () => {
  const apply = vi
    .fn()
    .mockResolvedValueOnce(undefined)
    .mockRejectedValueOnce(new Error("native failure"))
    .mockResolvedValueOnce(undefined);
  const setItem = vi.fn();
  const controller = new InterfaceSizeController(apply, () => ({ getItem: () => null, setItem }));
  controller.request(150);
  await vi.waitFor(() => expect(controller.getSnapshot().applied).toBe(150));
  controller.request(400);
  await vi.waitFor(() =>
    expect(controller.getSnapshot().error).toContain("could not be confirmed"),
  );
  expect(controller.getSnapshot()).toMatchObject({ applied: 150, requested: 150, pending: false });
  expect(setItem.mock.calls).toEqual([[INTERFACE_SIZE_KEY, "150"]]);
  controller.request(100);
  await vi.waitFor(() => expect(controller.getSnapshot().applied).toBe(100));
  expect(controller.getSnapshot().error).toBeUndefined();
});

it("keeps successful enlargement usable for the session when storage is blocked", async () => {
  const controller = new InterfaceSizeController(
    async () => {},
    () => {
      throw new Error("blocked");
    },
  );
  controller.request(200);
  await vi.waitFor(() => expect(controller.getSnapshot().pending).toBe(false));
  expect(controller.getSnapshot()).toMatchObject({
    applied: 200,
    requested: 200,
    sessionOnly: true,
    error: undefined,
  });
});

it("still applies queued reset after a failed in-flight enlargement", async () => {
  const first = deferred();
  const apply = vi.fn().mockReturnValueOnce(first.promise).mockResolvedValueOnce(undefined);
  const controller = new InterfaceSizeController(apply, () => ({
    getItem: () => null,
    setItem: vi.fn(),
  }));
  controller.request(400);
  controller.request(100);
  first.reject(new Error("native failure"));
  await vi.waitFor(() => expect(controller.getSnapshot().pending).toBe(false));
  expect(apply.mock.calls).toEqual([[4], [1]]);
  expect(controller.getSnapshot()).toMatchObject({
    applied: 100,
    requested: 100,
    error: undefined,
  });
});

it("notifies independent subscribers with stable prior snapshots and honors unsubscribe", async () => {
  const first = deferred();
  const apply = vi.fn().mockReturnValueOnce(first.promise).mockResolvedValue(undefined);
  const controller = new InterfaceSizeController(apply, () => ({
    getItem: () => null,
    setItem: vi.fn(),
  }));
  const initial = controller.getSnapshot();
  const snapshots: ReturnType<InterfaceSizeController["getSnapshot"]>[] = [];
  const remaining = vi.fn();
  const unsubscribe = controller.subscribe(() => snapshots.push(controller.getSnapshot()));
  const unsubscribeRemaining = controller.subscribe(remaining);
  try {
    controller.request(125);
    const pending = snapshots[0]!;
    expect(pending).toMatchObject({ applied: 100, requested: 125, pending: true });
    expect(pending).not.toBe(initial);
    first.resolve();
    await vi.waitFor(() => expect(controller.getSnapshot().pending).toBe(false));
    expect(controller.getSnapshot().applied).toBe(125);
    expect(initial).toMatchObject({ applied: 100, requested: 100, pending: false });
    expect(pending).toMatchObject({ applied: 100, requested: 125, pending: true });
    unsubscribe();
    const detachedCount = snapshots.length;
    remaining.mockClear();
    controller.request(200);
    await vi.waitFor(() => expect(controller.getSnapshot().pending).toBe(false));
    expect(controller.getSnapshot().applied).toBe(200);
    expect(snapshots).toHaveLength(detachedCount);
    expect(remaining).toHaveBeenCalled();
    expect(apply.mock.calls).toEqual([[1.25], [2]]);
  } finally {
    first.resolve();
    unsubscribe();
    unsubscribeRemaining();
  }
});

it("dismissing a native error preserves the applied preference without retrying zoom", async () => {
  const apply = vi.fn().mockRejectedValue(new Error("native refusal"));
  const setItem = vi.fn();
  const controller = new InterfaceSizeController(apply, () => ({ getItem: () => null, setItem }));
  controller.request(250);
  await vi.waitFor(() => expect(controller.getSnapshot().pending).toBe(false));
  const failed = controller.getSnapshot();
  expect(failed.error).toContain("could not be confirmed");
  const listener = vi.fn();
  const unsubscribe = controller.subscribe(listener);
  try {
    controller.dismissError();
    expect(controller.getSnapshot()).toEqual({ ...failed, error: undefined });
    expect(controller.getSnapshot()).not.toBe(failed);
    expect(failed.error).toContain("could not be confirmed");
    expect(listener).toHaveBeenCalled();
    expect(apply).toHaveBeenCalledExactlyOnceWith(2.5);
    expect(setItem).not.toHaveBeenCalled();
  } finally {
    unsubscribe();
  }
});
