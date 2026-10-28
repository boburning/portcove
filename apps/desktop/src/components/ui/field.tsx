import type { ReactNode } from "react";
import { Popover } from "@base-ui/react/popover";
import { ChevronDown } from "lucide-react";
import { Button } from "./button";
import { Field as FieldPrimitive } from "@base-ui/react/field";
import { Fieldset as FieldsetPrimitive } from "@base-ui/react/fieldset";
import { controlClassName } from "./control-style";

/** Only pass fieldError for a field-specific validation result, never an operation failure. */
export function Field({
  label,
  description,
  fieldError,
  children,
  className,
  ...props
}: FieldPrimitive.Root.Props & {
  label: ReactNode;
  description?: ReactNode;
  fieldError?: string | undefined;
}) {
  return (
    <FieldPrimitive.Root
      {...props}
      invalid={Boolean(fieldError) || props.invalid}
      className={controlClassName("grid min-w-0 gap-2", className)}
    >
      <FieldPrimitive.Label className="text-sm font-semibold text-pc-foreground">
        {label}
      </FieldPrimitive.Label>
      {description && (
        <FieldPrimitive.Description className="max-w-prose text-sm text-pc-muted-foreground">
          {description}
        </FieldPrimitive.Description>
      )}
      {children}
      {fieldError && (
        <FieldPrimitive.Error match className="text-sm text-pc-danger-foreground">
          {fieldError}
        </FieldPrimitive.Error>
      )}
    </FieldPrimitive.Root>
  );
}

export function Fieldset({
  legend,
  children,
  className,
  ...props
}: FieldsetPrimitive.Root.Props & { legend: ReactNode }) {
  return (
    <FieldsetPrimitive.Root
      {...props}
      className={controlClassName("grid min-w-0 gap-3", className)}
    >
      <FieldsetPrimitive.Legend className="mb-2 text-sm font-semibold">
        {legend}
      </FieldsetPrimitive.Legend>
      {children}
    </FieldsetPrimitive.Root>
  );
}

/** Compact presentation only; the caller owns multi-selection, counts and query semantics. */
export function CompactFilterField({
  label,
  value,
  help,
  children,
}: {
  label: string;
  value: string;
  help?: string | undefined;
  children: ReactNode;
}) {
  return (
    <Popover.Root
      onOpenChange={(_open, details) => {
        if (details.reason === "escape-key") {
          details.event.stopPropagation();
          details.event.stopImmediatePropagation();
        }
      }}
    >
      <div className="compact-filter-field grid min-w-0 content-start gap-1.5">
        <span className="text-sm font-medium">{label}</span>
        <Popover.Trigger
          aria-label={`${label}: ${value}`}
          render={
            <Button
              data-focusable
              variant="outline"
              className="w-full justify-between text-start"
            />
          }
        >
          <span className="min-w-0 wrap-anywhere">{value}</span>
          <ChevronDown aria-hidden="true" />
        </Popover.Trigger>
      </div>
      <Popover.Portal>
        <Popover.Positioner
          sideOffset={6}
          align="start"
          className="z-(--layer-floating) max-w-[calc(100vw-2rem)]"
        >
          <Popover.Popup
            data-portcove-focus-scope
            className="max-h-(--available-height) w-96 max-w-full overflow-auto rounded-pc-md border border-pc-border bg-pc-surface p-3 text-pc-foreground shadow-lg"
          >
            <fieldset aria-label={label} className="m-0 grid min-w-0 gap-3 border-0 p-0">
              <legend className="mb-2 text-sm font-semibold">{label}</legend>
              {help && <p className="m-0 text-sm text-pc-muted-foreground">{help}</p>}
              <div className="grid max-h-[min(22rem,var(--available-height))] min-w-0 gap-1 overflow-auto overscroll-contain">
                {children}
              </div>
            </fieldset>
            <Popover.Close
              render={<Button variant="ghost" size="sm" className="mt-2" />}
              aria-label={`Close ${label} choices`}
            >
              Close choices
            </Popover.Close>
          </Popover.Popup>
        </Popover.Positioner>
      </Popover.Portal>
    </Popover.Root>
  );
}
