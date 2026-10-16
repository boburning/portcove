import * as React from "react";
import { Select as SelectPrimitive } from "@base-ui/react/select";
import { cn } from "cn";
import { controlClassName, controlFocus, controlMotion, floatingMotion } from "./control-style";
import { ChevronDownIcon, CheckIcon, ChevronUpIcon } from "lucide-react";

const Select = SelectPrimitive.Root;

function SelectValue({ className, ...props }: SelectPrimitive.Value.Props) {
  return (
    <SelectPrimitive.Value
      data-slot="select-value"
      className={controlClassName(
        "min-w-0 flex flex-1 text-start whitespace-normal [overflow-wrap:anywhere]",
        className,
      )}
      {...props}
    />
  );
}

function SelectTrigger({
  className,
  size = "default",
  children,
  ...props
}: SelectPrimitive.Trigger.Props & {
  size?: "sm" | "default";
}) {
  return (
    <SelectPrimitive.Trigger
      data-slot="select-trigger"
      data-size={size}
      className={controlClassName(
        cn(
          "flex min-h-(--control-height-md) w-fit items-center justify-between gap-2 rounded-pc-md border border-pc-input bg-[var(--color-bg-inset)] px-3 py-2 text-sm whitespace-normal text-pc-foreground transition-[color,background-color,border-color] select-none hover:bg-pc-surface-muted disabled:cursor-not-allowed disabled:opacity-70 aria-invalid:border-pc-danger data-invalid:border-pc-danger data-placeholder:text-pc-muted-foreground data-[size=sm]:min-h-(--control-height-sm) [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4",
          controlFocus,
          controlMotion,
        ),
        className,
      )}
      {...props}
    >
      {children}
      <SelectPrimitive.Icon
        render={<ChevronDownIcon className="pointer-events-none size-4 text-pc-muted-foreground" />}
      />
    </SelectPrimitive.Trigger>
  );
}

function SelectContent({
  className,
  children,
  side = "bottom",
  sideOffset = 4,
  align = "center",
  alignOffset = 0,
  alignItemWithTrigger = true,
  ...props
}: SelectPrimitive.Popup.Props &
  Pick<
    SelectPrimitive.Positioner.Props,
    "align" | "alignOffset" | "side" | "sideOffset" | "alignItemWithTrigger"
  >) {
  return (
    <SelectPrimitive.Portal>
      <SelectPrimitive.Positioner
        side={side}
        sideOffset={sideOffset}
        align={align}
        alignOffset={alignOffset}
        alignItemWithTrigger={alignItemWithTrigger}
        className="isolate z-(--layer-floating)"
      >
        <SelectPrimitive.Popup
          data-slot="select-content"
          data-portcove-focus-scope
          data-align-trigger={alignItemWithTrigger}
          className={controlClassName(
            cn(
              "relative max-h-(--available-height) w-(--anchor-width) min-w-36 origin-(--transform-origin) overflow-x-hidden overflow-y-auto overscroll-contain rounded-pc-md border border-pc-border bg-pc-surface text-pc-foreground shadow-(--shadow-floating) data-[align-trigger=true]:transition-none",
              floatingMotion,
            ),
            className,
          )}
          {...props}
        >
          <SelectScrollUpButton />
          <SelectPrimitive.List>{children}</SelectPrimitive.List>
          <SelectScrollDownButton />
        </SelectPrimitive.Popup>
      </SelectPrimitive.Positioner>
    </SelectPrimitive.Portal>
  );
}

function SelectItem({ className, children, ...props }: SelectPrimitive.Item.Props) {
  return (
    <SelectPrimitive.Item
      data-slot="select-item"
      className={controlClassName(
        cn(
          "relative flex min-h-(--control-height-sm) w-full cursor-default items-center gap-2 rounded-pc-sm py-2 ps-2 pe-8 text-sm select-none data-disabled:pointer-events-none data-disabled:opacity-70 data-highlighted:bg-pc-secondary data-highlighted:text-pc-foreground data-selected:bg-pc-selection data-selected:font-medium data-selected:text-pc-selection-foreground [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4",
          controlFocus,
        ),
        className,
      )}
      {...props}
    >
      <SelectPrimitive.ItemText className="flex min-w-0 flex-1 gap-2 [overflow-wrap:anywhere] whitespace-normal">
        {children}
      </SelectPrimitive.ItemText>
      <SelectPrimitive.ItemIndicator
        render={
          <span className="pointer-events-none absolute end-2 flex size-4 items-center justify-center" />
        }
      >
        <CheckIcon className="pointer-events-none" />
      </SelectPrimitive.ItemIndicator>
    </SelectPrimitive.Item>
  );
}

function SelectScrollUpButton({
  className,
  ...props
}: React.ComponentProps<typeof SelectPrimitive.ScrollUpArrow>) {
  return (
    <SelectPrimitive.ScrollUpArrow
      data-slot="select-scroll-up-button"
      className={controlClassName(
        "top-0 z-10 flex w-full cursor-default items-center justify-center bg-pc-surface py-1 [&_svg:not([class*='size-'])]:size-4",
        className,
      )}
      {...props}
    >
      <ChevronUpIcon />
    </SelectPrimitive.ScrollUpArrow>
  );
}

function SelectScrollDownButton({
  className,
  ...props
}: React.ComponentProps<typeof SelectPrimitive.ScrollDownArrow>) {
  return (
    <SelectPrimitive.ScrollDownArrow
      data-slot="select-scroll-down-button"
      className={controlClassName(
        "bottom-0 z-10 flex w-full cursor-default items-center justify-center bg-pc-surface py-1 [&_svg:not([class*='size-'])]:size-4",
        className,
      )}
      {...props}
    >
      <ChevronDownIcon />
    </SelectPrimitive.ScrollDownArrow>
  );
}

export { Select, SelectContent, SelectItem, SelectTrigger, SelectValue };
