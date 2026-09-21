import { Button as ButtonPrimitive } from "@base-ui/react/button";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "cn";

const buttonVariants = cva(
  "group/button inline-flex shrink-0 items-center justify-center rounded-lg border border-transparent bg-clip-padding text-sm font-medium whitespace-nowrap transition-all outline-none select-none focus-visible:border-pc-ring focus-visible:ring-3 focus-visible:ring-pc-ring/50 active:not-aria-[haspopup]:translate-y-px disabled:pointer-events-none disabled:opacity-50 aria-invalid:border-pc-danger aria-invalid:ring-3 aria-invalid:ring-pc-danger/20 dark:aria-invalid:border-pc-danger/50 dark:aria-invalid:ring-pc-danger/40 [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4",
  {
    variants: {
      variant: {
        default: "bg-pc-primary text-pc-primary-foreground hover:bg-pc-primary-hover",
        outline:
          "border-pc-border bg-pc-background hover:bg-pc-surface-muted hover:text-pc-foreground aria-expanded:bg-pc-surface-muted aria-expanded:text-pc-foreground dark:border-pc-input dark:bg-pc-surface-muted/30 dark:hover:bg-pc-surface-muted/50",
        secondary:
          "bg-pc-secondary text-pc-secondary-foreground hover:bg-pc-surface-muted aria-expanded:bg-pc-secondary aria-expanded:text-pc-secondary-foreground",
        ghost:
          "hover:bg-pc-surface-muted hover:text-pc-foreground aria-expanded:bg-pc-surface-muted aria-expanded:text-pc-foreground dark:hover:bg-pc-surface-muted/50",
        destructive:
          "bg-pc-danger-subtle text-pc-danger hover:bg-pc-danger/20 focus-visible:border-pc-danger/40 focus-visible:ring-pc-danger/20 dark:bg-pc-danger/20 dark:hover:bg-pc-danger/30 dark:focus-visible:ring-pc-danger/40",
        link: "text-pc-primary underline-offset-4 hover:underline",
      },
      size: {
        default:
          "h-8 gap-1.5 px-2.5 has-data-[icon=inline-end]:pr-2 has-data-[icon=inline-start]:pl-2",
        xs: "h-6 gap-1 rounded-[min(var(--radius-md),10px)] px-2 text-xs in-data-[slot=button-group]:rounded-lg has-data-[icon=inline-end]:pr-1.5 has-data-[icon=inline-start]:pl-1.5 [&_svg:not([class*='size-'])]:size-3",
        sm: "h-7 gap-1 rounded-[min(var(--radius-md),12px)] px-2.5 text-[0.8rem] in-data-[slot=button-group]:rounded-lg has-data-[icon=inline-end]:pr-1.5 has-data-[icon=inline-start]:pl-1.5 [&_svg:not([class*='size-'])]:size-3.5",
        lg: "h-9 gap-1.5 px-2.5 has-data-[icon=inline-end]:pr-2 has-data-[icon=inline-start]:pl-2",
        icon: "size-8",
        "icon-xs":
          "size-6 rounded-[min(var(--radius-md),10px)] in-data-[slot=button-group]:rounded-lg [&_svg:not([class*='size-'])]:size-3",
        "icon-sm":
          "size-7 rounded-[min(var(--radius-md),12px)] in-data-[slot=button-group]:rounded-lg",
        "icon-lg": "size-9",
      },
    },
    defaultVariants: {
      variant: "default",
      size: "default",
    },
  },
);

function Button({
  className,
  variant = "default",
  size = "default",
  ...props
}: ButtonPrimitive.Props & VariantProps<typeof buttonVariants>) {
  return (
    <ButtonPrimitive
      data-slot="button"
      data-variant={variant}
      className={cn(buttonVariants({ variant, size, className }))}
      {...props}
    />
  );
}

export { Button };
