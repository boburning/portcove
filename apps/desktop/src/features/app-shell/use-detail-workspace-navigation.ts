import { useCallback, useEffect, useRef, useState, type RefObject } from "react";
import { focusAndReveal, focusRegion } from "../../focus";
import { scrollWorkspaceTo, workspaceScrollTop } from "../../workspace-scroll";
import type { DetailDestination } from "../../view-model";
import type { DetailOpening } from "../game-details/detail-sections";

type DetailReturn = {
  portId: string;
  originKey: string | undefined;
  scrollTop: number;
  token: number;
};

export function useDetailWorkspaceNavigation(
  workspace: RefObject<HTMLElement | null>,
  setSelectedId: (portId: string | undefined) => void,
  availablePortIds?: ReadonlySet<string>,
) {
  const sequence = useRef(0);
  const current = useRef<DetailReturn | undefined>(undefined);
  const [opening, setOpening] = useState<DetailOpening>();
  const openingToken = opening?.token;

  const open = useCallback(
    (portId: string, originKey?: string, destination?: DetailDestination) => {
      const token = ++sequence.current;
      current.current = {
        portId,
        originKey,
        scrollTop: workspaceScrollTop(workspace.current),
        token,
      };
      scrollWorkspaceTo(workspace.current, 0);
      setOpening({ token, destination, originKey });
      setSelectedId(portId);
    },
    [setSelectedId, workspace],
  );

  const closeToken = useCallback(
    (expectedToken: number | undefined) => {
      const origin = current.current;
      if (!origin || origin.token !== expectedToken) return;
      const transition = ++sequence.current;
      current.current = undefined;
      setOpening(undefined);
      setSelectedId(undefined);
      window.requestAnimationFrame(() => {
        if (sequence.current !== transition || current.current) return;
        const target = origin.originKey
          ? document.querySelector<HTMLElement>(
              `[data-detail-origin="${CSS.escape(origin.originKey)}"]`,
            )
          : null;
        const sameGame =
          target ??
          document.querySelector<HTMLElement>(
            `[data-detail-game-id="${CSS.escape(origin.portId)}"]`,
          );
        // The originating control may live inside a disclosure remounted closed.
        // Restore its visibility before restoring scroll and keyboard focus.
        for (
          let disclosure = sameGame?.parentElement?.closest("details");
          disclosure;
          disclosure = disclosure.parentElement?.closest("details")
        ) {
          disclosure.open = true;
        }
        scrollWorkspaceTo(workspace.current, origin.scrollTop);
        if (sameGame) focusAndReveal(sameGame);
        else focusRegion("workspace");
      });
    },
    [setSelectedId, workspace],
  );

  const close = useCallback(() => closeToken(openingToken), [closeToken, openingToken]);

  useEffect(() => {
    const origin = current.current;
    if (origin && availablePortIds && !availablePortIds.has(origin.portId))
      closeToken(origin.token);
  }, [availablePortIds, closeToken]);

  const invalidate = useCallback(() => {
    const origin = current.current;
    ++sequence.current;
    current.current = undefined;
    setOpening(undefined);
    return origin;
  }, []);

  return { close, invalidate, open, opening };
}
