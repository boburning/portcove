import { useLayoutEffect, useState, useSyncExternalStore } from "react";

export type ObservationWindow = { observedAt: number; expiresAt: number; deadline: number };

// Clock observation is external input. Keep a cached, sticky snapshot for React;
// never read clocks or mutate a ref while React is rendering.
function expiryClock(window: ObservationWindow | undefined) {
  let expired = false;
  const listeners = new Set<() => void>();
  const monitors = new Set<() => void>();
  const check = () => {
    if (!window || expired) return;
    const now = Date.now();
    if (
      now >= window.expiresAt * 1000 ||
      now < window.observedAt * 1000 ||
      performance.now() >= window.deadline
    ) {
      expired = true;
      for (const stop of monitors) stop();
      for (const listener of listeners) listener();
    }
  };
  return {
    check,
    read: () => expired,
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      check();
      if (!window || expired)
        return () => {
          listeners.delete(listener);
        };
      const timer = setTimeout(check, Math.max(0, window.deadline - performance.now()));
      const clock = setInterval(check, 1000);
      document.addEventListener("visibilitychange", check);
      const stop = () => {
        clearTimeout(timer);
        clearInterval(clock);
        document.removeEventListener("visibilitychange", check);
        monitors.delete(stop);
      };
      monitors.add(stop);
      return () => {
        listeners.delete(listener);
        stop();
      };
    },
  };
}

export function useObservationExpired(
  identity: object | undefined,
  window: ObservationWindow | undefined,
) {
  const [binding, setBinding] = useState(() => ({ identity, clock: expiryClock(window) }));
  const current =
    binding.identity === identity ? binding : { identity, clock: expiryClock(window) };
  if (binding.identity !== identity) setBinding(current);
  const clock = current.clock;
  const expired = useSyncExternalStore(clock.subscribe, clock.read, clock.read);
  // Recheck external clock changes before paint even when another input caused
  // the render. Once invalid, a later wall-clock rewind cannot revive this window.
  useLayoutEffect(() => clock.check());
  return expired;
}
