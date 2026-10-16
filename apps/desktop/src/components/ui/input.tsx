import { Input as InputPrimitive } from "@base-ui/react/input";
import { cn } from "cn";
import { controlClassName, controlFocus, controlMotion } from "./control-style";

function Input({ className, ...props }: InputPrimitive.Props) {
  return (
    <InputPrimitive
      data-slot="input"
      className={controlClassName(
        cn(
          "min-h-(--control-height-md) w-full min-w-0 rounded-pc-md border border-pc-input bg-[var(--color-bg-inset)] px-3 py-2 text-sm text-pc-foreground shadow-[inset_0_1px_2px_var(--color-bg)] transition-[color,background-color,border-color] placeholder:text-pc-muted-foreground disabled:cursor-not-allowed disabled:bg-pc-surface-muted disabled:text-pc-muted-foreground disabled:opacity-70 aria-invalid:border-pc-danger data-invalid:border-pc-danger",
          controlFocus,
          controlMotion,
        ),
        className,
      )}
      {...props}
    />
  );
}

export { Input };
