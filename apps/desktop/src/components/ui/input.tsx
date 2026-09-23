import { Input as InputPrimitive } from "@base-ui/react/input";
import { cn } from "cn";

function Input({ className, ...props }: InputPrimitive.Props) {
  return (
    <InputPrimitive
      data-slot="input"
      className={cn(
        "h-(--control-height-md) w-full min-w-0 rounded-md border border-pc-input bg-[var(--color-bg-inset)] px-3 py-2 text-sm text-pc-foreground shadow-[inset_0_1px_2px_var(--color-bg)] outline-none transition-[color,background-color,border-color,box-shadow] placeholder:text-pc-muted-foreground focus-visible:border-pc-ring focus-visible:ring-3 focus-visible:ring-pc-ring/50 disabled:cursor-not-allowed disabled:bg-pc-surface-muted disabled:text-pc-muted-foreground disabled:opacity-70 forced-colors:focus-visible:outline-2 forced-colors:focus-visible:outline-offset-2",
        className,
      )}
      {...props}
    />
  );
}

export { Input };
