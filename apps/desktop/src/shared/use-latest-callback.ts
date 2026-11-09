import { useCallback, useLayoutEffect, useRef } from "react";

/**
 * A stable callback that forwards to the latest handler. Use it for props passed to
 * memoized children that may only be invoked from events or effects, never during render.
 */
export function useLatestCallback<Arguments extends unknown[], Result>(
  handler: ((...values: Arguments) => Result) | undefined,
): (...values: Arguments) => Result | undefined {
  const latest = useRef(handler);
  useLayoutEffect(() => {
    latest.current = handler;
  });
  return useCallback((...values: Arguments) => latest.current?.(...values), []);
}
