import { useCallback, useEffect, useId, useRef, useState } from "react";

export function useFilterPanel() {
  const [open, setOpen] = useState(false);
  const panelId = useId();
  const trigger = useRef<HTMLButtonElement>(null);
  const heading = useRef<HTMLHeadingElement>(null);
  const panel = useRef<HTMLElement>(null);
  const close = useCallback(() => {
    setOpen(false);
    trigger.current?.focus();
  }, []);
  useEffect(() => {
    if (!open) return;
    heading.current?.focus();
    const escape = (event: KeyboardEvent) => {
      if (
        event.key !== "Escape" ||
        event.defaultPrevented ||
        !(event.target instanceof Node) ||
        !panel.current?.contains(event.target)
      )
        return;
      event.preventDefault();
      event.stopPropagation();
      close();
    };
    document.addEventListener("keydown", escape);
    return () => document.removeEventListener("keydown", escape);
  }, [open, close]);
  return { open, setOpen, panelId, trigger, heading, panel, close };
}
