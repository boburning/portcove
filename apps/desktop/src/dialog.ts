import { useEffect, useRef } from "react";

const focusableSelector = [
  "button:not([disabled])",
  "[href]",
  "input:not([disabled])",
  "select:not([disabled])",
  "textarea:not([disabled])",
  "[tabindex]:not([tabindex='-1'])",
].join(",");

export function useDialogFocus(close: () => void, active = true) {
  const root = useRef<HTMLElement>(null);
  const closeRef = useRef(close);
  closeRef.current = close;
  useEffect(() => {
    if (!active) return undefined;
    const previous = document.activeElement as HTMLElement | null;
    const dialog = root.current;
    if (!dialog) return undefined;
    const focusables = () => [...dialog.querySelectorAll<HTMLElement>(focusableSelector)].filter(item => item.getClientRects().length > 0);
    window.requestAnimationFrame(() => (dialog.querySelector<HTMLElement>("[data-autofocus]") ?? focusables()[0])?.focus());
    const keydown = (event: KeyboardEvent) => {
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
      items[next]?.focus();
    };
    dialog.addEventListener("keydown", keydown);
    return () => {
      dialog.removeEventListener("keydown", keydown);
      previous?.focus();
    };
  }, [active]);
  return root;
}
