import { useId, useRef, useState } from "react";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "./ui/select";

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
}) {
  const [internalOpen, setInternalOpen] = useState(false);
  const open = controlledOpen ?? internalOpen;
  const labelId = useId();
  const valueId = useId();
  const typeahead = useRef(false);
  const selected = options.find((option) => option.value === value);

  return (
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
        // so retain its synchronous character-key interaction explicitly.
        if (details.reason === "none" && details.event.type === "base-ui" && !typeahead.current) {
          details.cancel();
          return;
        }
        typeahead.current = false;
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
            !event.nativeEvent.isComposing;
        }}
        onKeyUpCapture={() => {
          typeahead.current = false;
        }}
        onBlur={() => {
          typeahead.current = false;
        }}
        onPointerDownCapture={() => {
          typeahead.current = false;
        }}
        id={triggerId}
        data-focusable
        aria-labelledby={`${labelId} ${valueId}`}
        className="w-full gap-3"
      >
        <span id={labelId} className="text-pc-secondary-foreground">
          {label}
        </span>
        <SelectValue id={valueId} className="justify-end text-right font-semibold">
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
  );
}
