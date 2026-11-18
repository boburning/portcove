import { mountCollectionDestination, hasCollectionNavigation } from "../../collection-navigation";
import { useCallback, useEffect, useRef, useState, type RefObject } from "react";
import { focusAndReveal, focusRegion, navigationScope } from "../../focus";
import { scrollWorkspaceTo, workspaceScrollTop } from "../../workspace-scroll";
import type { DetailDestination } from "../../view-model";
import type { DetailOpening } from "../game-details/detail-sections";

type DetailReturn = {
  portId: string;
  returnPortId: string;
  groupKey: string | undefined;
  originKey: string | undefined;
  ancestorOriginKey: string | undefined;
  scrollTop: number;
  viewportTop: number | undefined;
  token: number;
};

export function useDetailWorkspaceNavigation(
  workspace: RefObject<HTMLElement | null>,
  setSelectedId: (portId: string | undefined) => void,
  availablePortIds?: ReadonlySet<string>,
) {
  const sequence = useRef(0);
  const restoring = useRef(false);
  useEffect(() => {
    const cancel = () => {
      if (restoring.current) {
        ++sequence.current;
        restoring.current = false;
      }
    };
    for (const name of ["pointerdown", "keydown", "wheel", "touchstart"])
      document.addEventListener(name, cancel, true);
    return () => {
      cancel();
      for (const name of ["pointerdown", "keydown", "wheel", "touchstart"])
        document.removeEventListener(name, cancel, true);
    };
  }, []);
  const current = useRef<DetailReturn | undefined>(undefined);
  const [opening, setOpening] = useState<DetailOpening>();
  const openingToken = opening?.token;

  const open = useCallback(
    (portId: string, originKey?: string, destination?: DetailDestination) => {
      const token = ++sequence.current;
      const exactTrigger = originKey
        ? document.querySelector<HTMLElement>(`[data-detail-origin="${CSS.escape(originKey)}"]`)
        : null;
      const trigger =
        exactTrigger ??
        document.querySelector<HTMLElement>(`[data-detail-game-id="${CSS.escape(portId)}"]`);
      current.current = {
        portId,
        returnPortId: portId,
        groupKey: trigger?.closest<HTMLElement>("[data-detail-return-group]")?.dataset
          .detailReturnGroup,
        originKey,
        ancestorOriginKey:
          exactTrigger?.parentElement?.closest<HTMLElement>("[data-detail-origin]")?.dataset
            .detailOrigin,
        scrollTop: workspaceScrollTop(workspace.current),
        viewportTop: trigger?.getBoundingClientRect().top,
        token,
      };
      scrollWorkspaceTo(workspace.current, 0);
      setOpening({ token, destination, originKey });
      setSelectedId(portId);
    },
    [setSelectedId, workspace],
  );

  /** Switch the viewed implementation without replacing the browsing return point. */
  const replace = useCallback(
    (portId: string, destination?: DetailDestination) => {
      const origin = current.current;
      if (!origin) {
        open(portId, undefined, destination);
        return;
      }
      const token = ++sequence.current;
      current.current = { ...origin, portId, token };
      scrollWorkspaceTo(workspace.current, 0);
      setOpening({ token, destination, originKey: origin.originKey });
      setSelectedId(portId);
    },
    [open, setSelectedId, workspace],
  );

  const closeToken = useCallback(
    (expectedToken: number | undefined) => {
      const origin = current.current;
      if (!origin || origin.token !== expectedToken) return;
      const transition = ++sequence.current;
      current.current = undefined;
      setOpening(undefined);
      setSelectedId(undefined);
      restoring.current = true;
      const restore = async () => {
        const active = document.activeElement;
        const valid = () =>
          sequence.current === transition &&
          !current.current &&
          document.activeElement === active &&
          navigationScope() === document;
        if (!valid()) return;
        const element = workspace.current;
        if (
          element &&
          !(await mountCollectionDestination(
            element,
            {
              originKey: origin.originKey,
              portId: origin.returnPortId,
              groupKey: origin.groupKey,
              scrollTop: origin.scrollTop,
              viewportTop: origin.viewportTop,
            },
            valid,
          ))
        )
          return;
        if (!valid()) return;
        restoring.current = false;
        const target = origin.originKey
          ? document.querySelector<HTMLElement>(
              `[data-detail-origin="${CSS.escape(origin.originKey)}"]`,
            )
          : null;
        const returnTarget =
          target ??
          document.querySelector<HTMLElement>(
            `[data-detail-game-id="${CSS.escape(origin.returnPortId)}"]`,
          ) ??
          (origin.groupKey
            ? document.querySelector<HTMLElement>(
                `[data-detail-return-group="${CSS.escape(origin.groupKey)}"] [data-detail-game-id]`,
              )
            : null) ??
          (origin.ancestorOriginKey
            ? document.querySelector<HTMLElement>(
                `[data-detail-origin="${CSS.escape(origin.ancestorOriginKey)}"]`,
              )
            : null);
        // The originating control may live inside a disclosure remounted closed.
        // Restore its visibility before restoring scroll and keyboard focus.
        for (
          let disclosure = returnTarget?.parentElement?.closest("details");
          disclosure;
          disclosure = disclosure.parentElement?.closest("details")
        ) {
          disclosure.open = true;
        }
        if (!element || !hasCollectionNavigation(element))
          scrollWorkspaceTo(workspace.current, origin.scrollTop);
        if (returnTarget) focusAndReveal(returnTarget);
        else focusRegion("workspace");
      };
      window.requestAnimationFrame(() => {
        void restore();
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
    restoring.current = false;
    current.current = undefined;
    setOpening(undefined);
    return origin;
  }, []);

  return { close, invalidate, open, replace, opening };
}
