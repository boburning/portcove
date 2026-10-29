import { Button as ButtonPrimitive } from "@base-ui/react/button";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "cn";
import { controlClassName, controlFocus, controlMotion } from "./control-style";

const buttonVariants = cva(
  cn(
    "group/button inline-flex max-w-full shrink-0 items-center justify-center rounded-pc-md border border-transparent bg-clip-padding text-sm font-normal [overflow-wrap:anywhere] whitespace-normal transition-[color,background-color,border-color,box-shadow,transform] select-none active:bg-[var(--color-bg-active)] active:shadow-(--shadow-pressed) active:not-aria-[haspopup]:translate-y-px disabled:pointer-events-none disabled:border-pc-border disabled:bg-pc-surface-muted disabled:text-pc-muted-foreground disabled:opacity-70 disabled:shadow-none aria-busy:pointer-events-none aria-busy:opacity-70 aria-invalid:border-pc-danger [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4",
    controlFocus,
    controlMotion,
  ),
  {
    variants: {
      variant: {
        default:
          "border-pc-border bg-pc-secondary text-pc-secondary-foreground shadow-sm hover:border-pc-interactive hover:bg-pc-surface-muted",
        primary:
          "border-pc-primary bg-pc-primary font-medium text-pc-action-foreground shadow-sm hover:border-pc-primary-hover hover:bg-pc-primary-hover active:border-pc-primary-active active:bg-pc-primary-active",
        selected:
          "relative border-transparent bg-pc-selection text-pc-selection-foreground after:pointer-events-none after:absolute after:inset-x-2 after:bottom-0 after:border-b-2 after:border-current hover:bg-pc-selection hover:text-pc-selection-foreground active:bg-[var(--color-interactive-active)] active:text-pc-action-foreground",
        outline:
          "border-pc-border bg-pc-background text-pc-selection-foreground hover:bg-pc-surface-muted hover:text-pc-foreground aria-expanded:bg-pc-surface-muted aria-expanded:text-pc-foreground dark:border-pc-border dark:bg-pc-surface/70 dark:hover:bg-pc-surface-muted/50",
        secondary:
          "bg-pc-secondary text-pc-secondary-foreground hover:bg-pc-surface-muted aria-expanded:bg-pc-secondary aria-expanded:text-pc-secondary-foreground",
        ghost:
          "bg-transparent hover:bg-pc-surface-muted hover:text-pc-foreground aria-expanded:bg-pc-surface-muted aria-expanded:text-pc-foreground dark:hover:bg-pc-surface-muted/50",
        destructive:
          "border-pc-danger bg-pc-danger-subtle font-medium text-pc-danger-strong hover:border-pc-danger-surface hover:bg-pc-danger-surface hover:text-pc-action-foreground dark:bg-pc-danger/20",
        link: "bg-transparent text-pc-interactive-foreground underline-offset-4 hover:underline",
      },
      size: {
        default:
          "min-h-(--control-height-md) gap-1.5 px-2.5 has-data-[icon=inline-end]:pe-2 has-data-[icon=inline-start]:ps-2",
        xs: "min-h-(--control-height-xs) gap-1 rounded-pc-sm px-2 text-xs has-data-[icon=inline-end]:pe-1.5 has-data-[icon=inline-start]:ps-1.5 [&_svg:not([class*='size-'])]:size-3",
        sm: "min-h-(--control-height-sm) gap-1 rounded-pc-sm px-2.5 text-xs has-data-[icon=inline-end]:pe-1.5 has-data-[icon=inline-start]:ps-1.5 [&_svg:not([class*='size-'])]:size-3.5",
        lg: "min-h-(--control-height-lg) gap-1.5 px-2.5 has-data-[icon=inline-end]:pe-2 has-data-[icon=inline-start]:ps-2",
        icon: "size-(--control-height-md)",
        "icon-xs": "size-(--control-height-xs) rounded-pc-sm [&_svg:not([class*='size-'])]:size-3",
        "icon-sm":
          "size-(--control-height-sm) rounded-pc-sm in-data-[slot=button-group]:rounded-lg",
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
      className={controlClassName(buttonVariants({ variant, size }), className)}
      {...props}
      disabled={props.disabled || props["aria-busy"] === true || props["aria-busy"] === "true"}
    />
  );
}

export { Button };
