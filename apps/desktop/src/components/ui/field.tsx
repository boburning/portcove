import type { ReactNode } from "react";
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
  fieldError?: string;
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
