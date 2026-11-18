import { afterEach, expect, it, vi } from "vite-plus/test";
import { desktopApi } from "../../api";
import type { ModSetupsView } from "../../types";
import { readModSetupInventory } from "./read-mod-setup-inventory";

afterEach(() => vi.restoreAllMocks());

function deferred() {
  let resolve!: (value: ModSetupsView) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<ModSetupsView>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

function view(portId = "shipwright") {
  return { port_id: portId, supported: false } as ModSetupsView;
}

it("fans one same-turn native result out to every requesting consumer", async () => {
  const inventory = view();
  const read = vi.spyOn(desktopApi, "modSetups").mockResolvedValue(inventory);
  const first = readModSetupInventory("shipwright", 101);
  const second = readModSetupInventory("shipwright", 101);
  expect(await first).toBe(inventory);
  expect(await second).toBe(inventory);
  expect(read).toHaveBeenCalledTimes(1);
  await readModSetupInventory("shipwright", 101);
  expect(read).toHaveBeenCalledTimes(2);
});

it("runs a single newer read after the active one and returns its result to every refresh", async () => {
  const first = deferred();
  const second = deferred();
  const read = vi
    .spyOn(desktopApi, "modSetups")
    .mockReturnValueOnce(first.promise)
    .mockReturnValueOnce(second.promise);
  const initial = readModSetupInventory("shipwright", 102);
  await Promise.resolve();
  const refresh = readModSetupInventory("shipwright", 102);
  const standingPass = readModSetupInventory("shipwright", 102);
  expect(read).toHaveBeenCalledTimes(1);
  const before = view();
  first.resolve(before);
  expect(await initial).toBe(before);
  expect(read).toHaveBeenCalledTimes(2);
  const after = view();
  second.resolve(after);
  expect(await refresh).toBe(after);
  expect(await standingPass).toBe(after);
});

it("drains a queued refresh after failure and retires the lane after all waiters settle", async () => {
  const first = deferred();
  const recovered = view();
  const read = vi
    .spyOn(desktopApi, "modSetups")
    .mockReturnValueOnce(first.promise)
    .mockResolvedValue(recovered);
  const initial = readModSetupInventory("shipwright", 103);
  const failure = initial.catch((error: unknown) => error);
  await Promise.resolve();
  const retry = readModSetupInventory("shipwright", 103);
  first.reject(new Error("unavailable"));
  expect(await failure).toEqual(new Error("unavailable"));
  expect(await retry).toBe(recovered);
  expect(read).toHaveBeenCalledTimes(2);
  await readModSetupInventory("shipwright", 103);
  expect(read).toHaveBeenCalledTimes(3);
});

it("keeps ports and replacement library generations independent", async () => {
  const retired = deferred();
  const read = vi
    .spyOn(desktopApi, "modSetups")
    .mockReturnValueOnce(retired.promise)
    .mockResolvedValueOnce(view())
    .mockResolvedValueOnce(view("starship"));
  const old = readModSetupInventory("shipwright", 104);
  const current = readModSetupInventory("shipwright", 105);
  const other = readModSetupInventory("starship", 104);
  await expect(current).resolves.toMatchObject({ port_id: "shipwright" });
  await expect(other).resolves.toMatchObject({ port_id: "starship" });
  expect(read).toHaveBeenCalledTimes(3);
  retired.resolve(view());
  await old;
});
