import { useCallback, useEffect, useRef } from "react";

/** Restore a completed selection only while the original focus intent survives. */
export function useSelectReturnFocus(triggerId: string, pending: boolean, popupClosed: boolean) {
  const intended = useRef(false);
  const popup = useRef<Element | null>(null);
  useEffect(() => {
    const cancelOnMovedFocus = (event: FocusEvent) => {
      const target = event.target;
      if (
        target instanceof Element &&
        target !== document.body &&
        target.id !== triggerId &&
        !popup.current?.contains(target)
      )
        intended.current = false;
    };
    document.addEventListener("focusin", cancelOnMovedFocus, true);
    return () => {
      intended.current = false;
      document.removeEventListener("focusin", cancelOnMovedFocus, true);
    };
  }, [triggerId]);
  useEffect(() => {
    if (pending || !popupClosed || !intended.current) return;
    const trigger = document.getElementById(triggerId);
    if (!(trigger instanceof HTMLButtonElement)) return;
    const restore = () => {
      if (!intended.current || !trigger.isConnected || trigger.disabled) return;
      if (
        document.activeElement === document.body ||
        (document.activeElement && popup.current?.contains(document.activeElement))
      )
        trigger.focus();
      intended.current = false;
      observer.disconnect();
    };
    // The child select store can commit disabled after its parent. Preserve
    // intent until the actual trigger is enabled and close completion arrived.
    const observer = new MutationObserver(restore);
    observer.observe(trigger, { attributes: true, attributeFilter: ["disabled"] });
    restore();
    return () => observer.disconnect();
  }, [pending, popupClosed, triggerId]);
  return useCallback(() => {
    popup.current = document.activeElement?.closest('[data-slot="select-content"]') ?? null;
    intended.current = true;
  }, []);
}
