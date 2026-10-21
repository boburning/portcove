import { Checkbox as CheckboxPrimitive } from "@base-ui/react/checkbox";
import { Check, Minus } from "lucide-react";
import { cn } from "cn";
import { controlClassName, controlFocus } from "./control-style";

export function Checkbox({ className, ...props }: CheckboxPrimitive.Root.Props) {
  return (
    <CheckboxPrimitive.Root
      {...props}
      data-slot="checkbox"
      className={controlClassName(
        cn(
          "group/checkbox inline-flex size-5 shrink-0 items-center justify-center rounded-pc-sm border border-pc-input bg-pc-surface text-pc-foreground disabled:opacity-60 data-checked:border-pc-selection-foreground data-checked:bg-pc-selection data-checked:text-pc-selection-foreground",
          controlFocus,
        ),
        className,
      )}
    >
      <CheckboxPrimitive.Indicator className="flex items-center justify-center">
        {props.indeterminate ? <Minus className="size-3.5" /> : <Check className="size-3.5" />}
      </CheckboxPrimitive.Indicator>
    </CheckboxPrimitive.Root>
  );
}
