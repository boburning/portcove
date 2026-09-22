import { useCallback, useRef, useState, type RefObject } from "react";
import { focusRegion } from "../../focus";

type DetailReturn = {
  originKey?: string;
  scrollTop: number;
  token: number;
};

export function useDetailWorkspaceNavigation(
  workspace: RefObject<HTMLElement | null>,
  setSelectedId: (portId: string | undefined) => void,
) {
  const sequence = useRef(0);
  const current = useRef<DetailReturn | undefined>(undefined);
  const [openingToken, setOpeningToken] = useState<number>();

  const open = useCallback(
    (portId: string, originKey?: string) => {
      const token = ++sequence.current;
      current.current = {
        originKey,
        scrollTop: workspace.current?.scrollTop ?? 0,
        token,
      };
      setOpeningToken(token);
      setSelectedId(portId);
      window.requestAnimationFrame(() => {
        if (current.current?.token !== token) return;
        workspace.current?.scrollTo({ top: 0 });
        document.querySelector<HTMLElement>(".detail-back")?.focus({ preventScroll: true });
      });
    },
    [setSelectedId, workspace],
  );

  const closeToken = useCallback(
    (expectedToken: number | undefined) => {
      const origin = current.current;
      if (!origin || origin.token !== expectedToken) return;
      const transition = ++sequence.current;
      current.current = undefined;
      setOpeningToken(undefined);
      setSelectedId(undefined);
      window.requestAnimationFrame(() => {
        if (sequence.current !== transition || current.current) return;
        workspace.current?.scrollTo({ top: origin.scrollTop });
        const target = origin.originKey
          ? document.querySelector<HTMLElement>(
              `[data-detail-origin="${CSS.escape(origin.originKey)}"]`,
            )
          : null;
        if (target) target.focus({ preventScroll: true });
        else focusRegion("workspace");
      });
    },
    [setSelectedId, workspace],
  );

  const close = useCallback(() => closeToken(openingToken), [closeToken, openingToken]);

  const invalidate = useCallback(() => {
    const origin = current.current;
    ++sequence.current;
    current.current = undefined;
    setOpeningToken(undefined);
    return origin;
  }, []);

  return { close, invalidate, open };
}
