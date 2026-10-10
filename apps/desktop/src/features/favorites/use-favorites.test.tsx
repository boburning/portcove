// @vitest-environment jsdom
import { act, StrictMode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { beforeEach, afterEach, expect, it, vi } from "vitest";
import { desktopApi } from "../../api";
import { useFavorites } from "./use-favorites";
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (value: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
let root: Root;
let host: HTMLDivElement;
let state!: ReturnType<typeof useFavorites>;
function Fixture({ generation = 1 }: { generation?: number }) {
  state = useFavorites(generation);
  return null;
}
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  host = document.body.appendChild(document.createElement("div"));
  root = createRoot(host);
  vi.spyOn(desktopApi, "favoritePorts").mockResolvedValue(["absent-port"]);
  vi.spyOn(desktopApi, "setPortFavorite").mockResolvedValue();
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
it("reads durable IDs on mount/restart and acknowledges only a successful choice", async () => {
  await act(async () => root.render(<Fixture />));
  expect([...state.ids!]).toEqual(["absent-port"]);
  await act(async () => state.toggle("new-port"));
  expect(desktopApi.setPortFavorite).toHaveBeenCalledWith("new-port", true, 1);
  expect([...state.ids!]).toEqual(["absent-port", "new-port"]);
  await act(async () => state.toggle("new-port"));
  expect(desktopApi.setPortFavorite).toHaveBeenLastCalledWith("new-port", false, 1);
  expect([...state.ids!]).toEqual(["absent-port"]);
  expect(desktopApi.favoritePorts).toHaveBeenCalledTimes(1);
});
it("preserves confirmed choices on failed writes and reconciles with a retry read", async () => {
  await act(async () => root.render(<Fixture />));
  vi.mocked(desktopApi.setPortFavorite).mockRejectedValueOnce(new Error("disk full"));
  await act(async () => state.toggle("absent-port"));
  expect(state.ids?.has("absent-port")).toBe(true);
  expect(state.failure).toBe("write");
  vi.mocked(desktopApi.favoritePorts).mockResolvedValueOnce(["absent-port", "other-process-port"]);
  await act(async () => state.refresh());
  expect([...state.ids!]).toEqual(["absent-port", "other-process-port"]);
  expect(state.failure).toBeUndefined();
});
it("distinguishes unreadable preferences from an empty list without issuing a write", async () => {
  vi.mocked(desktopApi.favoritePorts).mockRejectedValueOnce(new Error("malformed"));
  await act(async () => root.render(<Fixture />));
  expect(state.ids).toBeUndefined();
  expect(state.failure).toBe("read");
  await act(async () => state.toggle("new-port"));
  expect(desktopApi.setPortFavorite).not.toHaveBeenCalled();
  vi.mocked(desktopApi.favoritePorts).mockResolvedValueOnce([]);
  await act(async () => state.refresh());
  expect(state.ids?.size).toBe(0);
  expect(state.failure).toBeUndefined();
});
it("retains last confirmed choices and the selected predicate when refresh fails", async () => {
  await act(async () => root.render(<Fixture />));
  await act(async () => state.setOnly(true));
  vi.mocked(desktopApi.favoritePorts).mockRejectedValueOnce(new Error("access"));
  await act(async () => state.refresh());
  expect(state.ids?.has("absent-port")).toBe(true);
  expect(state.only).toBe(true);
  expect(state.failure).toBe("read");
});
it("serializes mutations and reads while retaining confirmed state until completion", async () => {
  await act(async () => root.render(<Fixture />));
  const write = deferred<void>();
  vi.mocked(desktopApi.setPortFavorite).mockReturnValueOnce(write.promise);
  let pending!: Promise<boolean>;
  await act(async () => {
    pending = state.toggle("new-port");
    await state.toggle("other-port");
    await state.refresh();
  });
  expect(state.busy).toBe(true);
  expect(state.ids?.has("new-port")).toBe(false);
  expect(desktopApi.setPortFavorite).toHaveBeenCalledTimes(1);
  expect(desktopApi.favoritePorts).toHaveBeenCalledTimes(1);
  await act(async () => {
    write.resolve();
    await pending;
  });
  expect(state.ids?.has("new-port")).toBe(true);
});
it("rejects an old library's delayed write without exposing its choices to the new library", async () => {
  await act(async () => root.render(<Fixture />));
  await act(async () => state.setOnly(true));
  const write = deferred<void>();
  vi.mocked(desktopApi.setPortFavorite).mockReturnValueOnce(write.promise);
  let pending!: Promise<boolean>;
  await act(async () => {
    pending = state.toggle("new-port");
  });
  vi.mocked(desktopApi.favoritePorts).mockResolvedValueOnce(["second-library-port"]);
  await act(async () => root.render(<Fixture generation={2} />));
  expect([...state.ids!]).toEqual(["second-library-port"]);
  expect(state.only).toBe(false);
  await act(async () => {
    write.resolve();
    await pending;
  });
  expect([...state.ids!]).toEqual(["second-library-port"]);
  expect(state.busy).toBe(false);
});
it("rejects stale read completion under strict lifetime restart", async () => {
  const stale = deferred<string[]>();
  vi.mocked(desktopApi.favoritePorts)
    .mockReturnValueOnce(stale.promise)
    .mockResolvedValueOnce(["current-port"]);
  await act(async () =>
    root.render(
      <StrictMode>
        <Fixture />
      </StrictMode>,
    ),
  );
  expect([...state.ids!]).toEqual(["current-port"]);
  await act(async () => stale.resolve(["stale-port"]));
  expect([...state.ids!]).toEqual(["current-port"]);
});

it("keeps a possibly committed rejection uncertain through another successful choice until read reconciliation", async () => {
  const durable = new Set(["absent-port"]);
  vi.mocked(desktopApi.favoritePorts).mockImplementation(async () => [...durable]);
  vi.mocked(desktopApi.setPortFavorite).mockImplementation(async (id, selected) => {
    if (selected) durable.add(id);
    else durable.delete(id);
    if (id === "uncertain-port") throw new Error("reply lost after publication");
  });
  await act(async () => root.render(<Fixture />));
  await act(async () => state.toggle("uncertain-port"));
  expect(durable.has("uncertain-port")).toBe(true);
  expect(state.ids?.has("uncertain-port")).toBe(false);
  expect(state.failure).toBe("write");
  await act(async () => state.toggle("other-port"));
  expect(state.ids?.has("other-port")).toBe(true);
  expect(state.failure).toBe("write");
  await act(async () => state.refresh());
  expect(state.ids?.has("uncertain-port")).toBe(true);
  expect(state.failure).toBeUndefined();
});
