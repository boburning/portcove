import { useEffect, useRef } from "react";
import { focusAndReveal, focusableControls, navigationScope, visibleControl } from "./focus";

export function useDialogFocus(close: () => void, active = true) {
  const root = useRef<HTMLElement>(null);
  const closeRef = useRef(close);
  closeRef.current = close;
  useEffect(() => {
    if (!active) return undefined;
    const previous = document.activeElement as HTMLElement | null;
    const dialog = root.current;
    if (!dialog) return undefined;
    dialog.tabIndex = -1;
    const focusables = () => focusableControls(dialog);
    const initialFocus = () => focusAndReveal(focusables().find(item => item.hasAttribute("data-autofocus")) ?? focusables()[0] ?? dialog);
    const frame = window.requestAnimationFrame(() => { if (navigationScope() === dialog) initialFocus(); });
    const containFocus = () => {
      if (navigationScope() === dialog && !dialog.contains(document.activeElement)) initialFocus();
    };
    const keydown = (event: KeyboardEvent) => {
      if (navigationScope() !== dialog || event.defaultPrevented || event.isComposing) return;
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        closeRef.current();
        return;
      }
      if (event.key !== "Tab") return;
      const items = focusables();
      if (items.length === 0) {
        event.preventDefault();
        return;
      }
      const current = items.indexOf(document.activeElement as HTMLElement);
      const next = event.shiftKey ? (current <= 0 ? items.length - 1 : current - 1) : (current + 1) % items.length;
      event.preventDefault();
      focusAndReveal(items[next]);
    };
    dialog.addEventListener("keydown", keydown);
    document.addEventListener("focusin", containFocus);
    return () => {
      window.cancelAnimationFrame(frame);
      dialog.removeEventListener("keydown", keydown);
      document.removeEventListener("focusin", containFocus);
      if (previous?.isConnected && visibleControl(previous)) focusAndReveal(previous);
      else focusAndReveal(focusableControls().find(item => !dialog.contains(item)));
    };
  }, [active]);
  return root;
}
