import { Button as ButtonPrimitive } from "@base-ui/react/button";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "cn";

const buttonVariants = cva(
  "group/button inline-flex shrink-0 items-center justify-center rounded-lg border border-transparent bg-clip-padding text-sm font-medium whitespace-nowrap transition-[color,background-color,border-color,box-shadow,transform] outline-none select-none focus-visible:border-pc-ring focus-visible:ring-3 focus-visible:ring-pc-ring/50 active:not-aria-[haspopup]:translate-y-px aria-busy:pointer-events-none aria-busy:opacity-70 disabled:pointer-events-none disabled:border-pc-border disabled:bg-pc-surface-muted disabled:text-pc-muted-foreground disabled:shadow-none disabled:opacity-70 aria-invalid:border-pc-danger aria-invalid:ring-3 aria-invalid:ring-pc-danger/20 dark:aria-invalid:border-pc-danger/50 dark:aria-invalid:ring-pc-danger/40 forced-colors:focus-visible:outline-2 forced-colors:focus-visible:outline-offset-2 [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4",
  {
    variants: {
      variant: {
        default:
          "border-pc-border bg-pc-secondary text-pc-secondary-foreground shadow-sm hover:border-pc-primary hover:bg-pc-surface-muted",
        primary:
          "border-pc-signature bg-pc-signature text-pc-primary-foreground shadow-sm hover:border-pc-signature-hover hover:bg-pc-signature-hover active:border-pc-signature-active active:bg-pc-signature-active",
        selected:
          "border-pc-primary bg-pc-accent text-pc-accent-foreground shadow-sm hover:bg-pc-accent hover:text-pc-accent-foreground",
        outline:
          "border-pc-border bg-pc-background text-pc-accent-foreground hover:bg-pc-surface-muted hover:text-pc-foreground aria-expanded:bg-pc-surface-muted aria-expanded:text-pc-foreground dark:border-pc-input dark:bg-pc-surface-muted/30 dark:hover:bg-pc-surface-muted/50",
        secondary:
          "bg-pc-secondary text-pc-secondary-foreground hover:bg-pc-surface-muted aria-expanded:bg-pc-secondary aria-expanded:text-pc-secondary-foreground",
        ghost:
          "hover:bg-pc-surface-muted hover:text-pc-foreground aria-expanded:bg-pc-surface-muted aria-expanded:text-pc-foreground dark:hover:bg-pc-surface-muted/50",
        destructive:
          "border-pc-danger bg-pc-danger-subtle text-pc-danger hover:border-pc-danger-surface hover:bg-pc-danger-surface hover:text-pc-primary-foreground dark:bg-pc-danger/20",
        link: "text-pc-primary underline-offset-4 hover:underline",
      },
      size: {
        default:
          "h-(--control-height-md) gap-1.5 px-2.5 has-data-[icon=inline-end]:pe-2 has-data-[icon=inline-start]:ps-2",
        xs: "h-(--control-height-sm) gap-1 rounded-[min(var(--radius-md),10px)] px-2 text-xs in-data-[slot=button-group]:rounded-lg has-data-[icon=inline-end]:pe-1.5 has-data-[icon=inline-start]:ps-1.5 [&_svg:not([class*='size-'])]:size-3",
        sm: "h-(--control-height-sm) gap-1 rounded-[min(var(--radius-md),12px)] px-2.5 text-[0.8rem] in-data-[slot=button-group]:rounded-lg has-data-[icon=inline-end]:pe-1.5 has-data-[icon=inline-start]:ps-1.5 [&_svg:not([class*='size-'])]:size-3.5",
        lg: "h-(--control-height-lg) gap-1.5 px-2.5 has-data-[icon=inline-end]:pe-2 has-data-[icon=inline-start]:ps-2",
        icon: "size-(--control-height-md)",
        "icon-xs":
          "size-(--control-height-sm) rounded-[min(var(--radius-md),10px)] in-data-[slot=button-group]:rounded-lg [&_svg:not([class*='size-'])]:size-3",
        "icon-sm":
          "size-(--control-height-sm) rounded-[min(var(--radius-md),12px)] in-data-[slot=button-group]:rounded-lg",
        "icon-lg": "size-(--control-height-lg)",
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
