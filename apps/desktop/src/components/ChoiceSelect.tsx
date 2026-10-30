import { useId, useRef, useState } from "react";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "./ui/select";
import { Field } from "./ui/field";

export function ChoiceSelect<T extends string>({
  label,
  value,
  options,
  disabled,
  onChange,
  open: controlledOpen,
  onOpenChange,
  onOpenChangeComplete,
  triggerId,
  description,
  inline = false,
  showInlineLabel = true,
}: {
  label: string;
  value: T;
  options: readonly { value: T; label: string }[];
  disabled?: boolean | undefined;
  onChange: (value: T) => void;
  open?: boolean;
  onOpenChange?: (open: boolean, reason: string) => void;
  onOpenChangeComplete?: (open: boolean) => void;
  triggerId?: string;
  description?: string;
  inline?: boolean;
  showInlineLabel?: boolean;
}) {
  const [internalOpen, setInternalOpen] = useState(false);
  const open = controlledOpen ?? internalOpen;
  const labelId = useId();
  const valueId = useId();
  const typeahead = useRef<{ value: T; options: typeof options } | null>(null);
  const selected = options.find((option) => option.value === value);

  return (
    <Field
      label={
        <span id={labelId} className={inline ? "sr-only" : undefined}>
          {label}
        </span>
      }
      description={description}
      disabled={disabled}
      className={inline ? "w-full max-w-sm gap-0" : "w-full max-w-sm"}
    >
      <Select
        open={open}
        onOpenChange={(nextOpen, eventDetails) => {
          if (!nextOpen && eventDetails.reason === "escape-key") {
            eventDetails.event.stopPropagation();
            eventDetails.event.stopImmediatePropagation();
          }
          if (controlledOpen === undefined) setInternalOpen(nextOpen);
          onOpenChange?.(nextOpen, eventDetails.reason);
        }}
        onOpenChangeComplete={onOpenChangeComplete}
        value={value}
        disabled={disabled}
        onValueChange={(nextValue, details) => {
          // Base UI 1.9 can emit a synthetic fallback while its item collection
          // catches up with a controlled value/options commit. That is not a
          // preference change. Closed-trigger typeahead uses the same reason,
          // so retain its character-key interaction against the original controlled
          // collection. A held key must not authorize a later collection fallback.
          const interaction = typeahead.current;
          if (
            details.reason === "none" &&
            details.event.type === "base-ui" &&
            (!interaction || interaction.value !== value || interaction.options !== options)
          ) {
            details.cancel();
            return;
          }
          typeahead.current = null;
          if (
            nextValue &&
            nextValue !== value &&
            options.some((option) => option.value === nextValue)
          )
            onChange(nextValue);
        }}
      >
        <SelectTrigger
          onKeyDownCapture={(event) => {
            typeahead.current =
              !open &&
              !disabled &&
              event.currentTarget === document.activeElement &&
              event.key.length === 1 &&
              !event.ctrlKey &&
              !event.altKey &&
              !event.metaKey &&
              !event.nativeEvent.isComposing
                ? { value, options }
                : null;
          }}
          onKeyUpCapture={() => {
            typeahead.current = null;
          }}
          onBlur={() => {
            typeahead.current = null;
          }}
          onPointerDownCapture={() => {
            typeahead.current = null;
          }}
          id={triggerId}
          data-focusable
          aria-labelledby={`${labelId} ${valueId}`}
          className="w-full gap-3"
        >
          {inline && showInlineLabel && (
            <span aria-hidden="true" className="text-pc-muted-foreground">
              {label}
            </span>
          )}
          <SelectValue id={valueId} className="text-start font-medium">
            {selected?.label ?? "Unavailable"}
          </SelectValue>
        </SelectTrigger>
        <SelectContent align="start">
          {options.map((option) => (
            <SelectItem key={option.value} value={option.value}>
              {option.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </Field>
  );
}
