import { act, StrictMode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";
import { useObservationExpired, type ObservationWindow } from "./use-observation-expiry";

let root: Root;
let host: HTMLDivElement;
let expired: boolean;
function Fixture({ identity, window }: { identity: object; window: ObservationWindow }) {
  expired = useObservationExpired(identity, { ...window });
  return null;
}
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.useFakeTimers();
  vi.setSystemTime(10_000);
  host = document.body.appendChild(document.createElement("div"));
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
it("keeps expiry sticky across new window objects and wall-clock rewinds until a fresh observation", async () => {
  const identity = {};
  const window = { observedAt: 10, expiresAt: 20, deadline: performance.now() + 10_000 };
  const render = (observation: object) =>
    act(async () =>
      root.render(
        <StrictMode>
          <Fixture identity={observation} window={window} />
        </StrictMode>,
      ),
    );
  await render(identity);
  expect(expired).toBe(false);
  expect(vi.getTimerCount()).toBe(2);
  vi.setSystemTime(21_000);
  await act(async () => document.dispatchEvent(new Event("visibilitychange")));
  expect(expired).toBe(true);
  expect(vi.getTimerCount()).toBe(0);
  vi.setSystemTime(11_000);
  await render(identity);
  expect(expired).toBe(true);
  await render({});
  expect(expired).toBe(false);
  await act(async () => root.unmount());
  expect(vi.getTimerCount()).toBe(0);
  root = createRoot(host);
});
it("expires on the monotonic deadline even while the wall clock remains eligible", async () => {
  const monotonic = vi.spyOn(performance, "now").mockReturnValue(100);
  await act(async () =>
    root.render(
      <Fixture identity={{}} window={{ observedAt: 10, expiresAt: 20, deadline: 150 }} />,
    ),
  );
  expect(expired).toBe(false);
  monotonic.mockReturnValue(150);
  await act(async () => vi.advanceTimersByTime(50));
  expect(expired).toBe(true);
  expect(vi.getTimerCount()).toBe(0);
});
