import { useId, useState } from "react";
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
  disabled?: boolean;
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
      onValueChange={(nextValue) => {
        if (
          nextValue &&
          nextValue !== value &&
          options.some((option) => option.value === nextValue)
        )
          onChange(nextValue);
      }}
    >
      <SelectTrigger
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
