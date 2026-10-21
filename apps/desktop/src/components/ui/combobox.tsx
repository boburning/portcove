import { Combobox as ComboboxPrimitive } from "@base-ui/react/combobox";
import { Check, ChevronsUpDown } from "lucide-react";
import { Field } from "./field";
import { controlFocus } from "./control-style";

export interface SearchChoiceOption {
  id: string;
  label: string;
  description?: string;
}

/** Search text is ephemeral; only an explicit item selection changes the chosen identity. */
export function SearchChoice({
  label,
  options,
  value,
  query,
  onQueryChange,
  onChange,
  disabled = false,
  id,
}: {
  label: string;
  options: SearchChoiceOption[];
  value: string;
  query: string;
  onQueryChange: (query: string) => void;
  onChange: (id: string) => void;
  disabled?: boolean;
  id?: string | undefined;
}) {
  return (
    <Field label={label} disabled={disabled}>
      <ComboboxPrimitive.Root
        items={options}
        value={options.find((option) => option.id === value) ?? null}
        inputValue={query}
        onInputValueChange={(nextQuery, details) => {
          // Base UI restores the selected label (none), or clears an unselected
          // query (input-clear), after closing. A workspace draft survives both.
          if (details.reason === "input-change" || details.reason === "item-press")
            onQueryChange(nextQuery);
          else details.cancel();
        }}
        onValueChange={(option, details) => {
          if (option && details.reason === "item-press") onChange(option.id);
          else details.cancel();
        }}
        itemToStringLabel={(option) => option.label}
        itemToStringValue={(option) => option.id}
        isItemEqualToValue={(a, b) => a.id === b.id}
        disabled={disabled}
        onOpenChange={(_open, details) => {
          if (details.reason === "escape-key") {
            details.event.stopPropagation();
            details.event.stopImmediatePropagation();
          }
        }}
      >
        <div className="relative min-w-0">
          <ComboboxPrimitive.Input
            id={id}
            data-focusable
            data-controller-combobox
            placeholder="Search games and port projects…"
            className={`min-h-(--control-height-md) w-full min-w-0 rounded-pc-md border border-pc-input bg-[var(--color-bg-inset)] py-2 ps-3 pe-10 text-sm text-pc-foreground placeholder:text-pc-muted-foreground ${controlFocus}`}
          />
          <ComboboxPrimitive.Trigger
            aria-label="Show games and ports"
            className={`absolute inset-y-0 end-0 flex w-10 items-center justify-center rounded-pc-sm text-pc-muted-foreground ${controlFocus}`}
          >
            <ChevronsUpDown className="size-4" />
          </ComboboxPrimitive.Trigger>
        </div>
        <ComboboxPrimitive.Portal>
          <ComboboxPrimitive.Positioner
            sideOffset={6}
            align="start"
            className="z-50 max-w-[calc(100vw-2rem)]"
          >
            <ComboboxPrimitive.Popup
              data-portcove-focus-scope
              className="w-(--anchor-width) max-w-full rounded-pc-md border border-pc-border bg-pc-surface p-1 text-pc-foreground shadow-lg"
            >
              <ComboboxPrimitive.Empty className="px-3 py-4 text-sm text-pc-muted-foreground">
                No game or port matches this search.
              </ComboboxPrimitive.Empty>
              <ComboboxPrimitive.List className="max-h-[min(20rem,var(--available-height))] overflow-auto overscroll-contain">
                {(option: SearchChoiceOption) => (
                  <ComboboxPrimitive.Item
                    key={option.id}
                    value={option}
                    className="relative flex cursor-default items-start gap-2 rounded-pc-sm px-3 py-2 text-sm outline-none data-highlighted:outline-2 data-highlighted:outline-offset-[-2px] data-highlighted:outline-[var(--color-focus)] data-selected:bg-pc-selection data-selected:text-pc-selection-foreground"
                  >
                    <span className="min-w-0 flex-1 break-words">
                      <span className="block font-semibold">{option.label}</span>
                      {option.description && (
                        <span className="block text-sm text-pc-muted-foreground">
                          {option.description}
                        </span>
                      )}
                    </span>
                    <ComboboxPrimitive.ItemIndicator>
                      <Check className="size-4" />
                    </ComboboxPrimitive.ItemIndicator>
                  </ComboboxPrimitive.Item>
                )}
              </ComboboxPrimitive.List>
            </ComboboxPrimitive.Popup>
          </ComboboxPrimitive.Positioner>
        </ComboboxPrimitive.Portal>
      </ComboboxPrimitive.Root>
    </Field>
  );
}
