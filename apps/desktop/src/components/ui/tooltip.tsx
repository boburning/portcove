import { useId, useState, type ReactElement, type ReactNode } from "react";
import { Tooltip as TooltipPrimitive } from "@base-ui/react/tooltip";
import { floatingMotion } from "./control-style";

/** Supplemental help only: essential instructions belong in visible content. */
export function Tooltip({
  label,
  children,
  disabled = false,
}: {
  label: ReactNode;
  children: ReactElement;
  disabled?: boolean;
}) {
  const id = useId();
  const [open, setOpen] = useState(false);
  const existingDescription = (children.props as { "aria-describedby"?: string })[
    "aria-describedby"
  ];
  const description = open
    ? [existingDescription, id].filter(Boolean).join(" ")
    : existingDescription;
  return (
    <TooltipPrimitive.Provider delay={400}>
      <TooltipPrimitive.Root disabled={disabled} onOpenChange={setOpen}>
        <TooltipPrimitive.Trigger render={children} aria-describedby={description} />
        <TooltipPrimitive.Portal>
          <TooltipPrimitive.Positioner sideOffset={6} className="z-(--layer-floating)">
            <TooltipPrimitive.Popup
              id={id}
              role="tooltip"
              className={`max-w-[min(20rem,calc(100vw-2rem))] rounded-pc-md border border-pc-border bg-pc-surface px-3 py-2 text-sm text-pc-foreground shadow-(--shadow-floating) ${floatingMotion}`}
            >
              {label}
            </TooltipPrimitive.Popup>
          </TooltipPrimitive.Positioner>
        </TooltipPrimitive.Portal>
      </TooltipPrimitive.Root>
    </TooltipPrimitive.Provider>
  );
}
