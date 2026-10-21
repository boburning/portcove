import type { ComponentProps } from "react";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "cn";

// These patterns serve Settings, recovery, browsing and update compositions.
export function SettingsRow({ className, ...props }: ComponentProps<"article">) {
  return (
    <article
      data-slot="settings-row"
      className={cn(
        "settings-row @container/row grid min-w-0 gap-3 border-t border-pc-border px-6 py-5 first:border-t-0 [&>h2]:text-base [&>h2]:leading-normal",
        className,
      )}
      {...props}
    />
  );
}

const noticeVariants = cva(
  "error-banner @container/notice mb-4 flex min-w-0 flex-wrap items-start gap-3 rounded-pc-md border p-3 text-xs [overflow-wrap:anywhere] [&>[data-slot=notice-actions]]:ml-auto [&>[data-slot=notice-actions]]:flex [&>[data-slot=notice-actions]]:flex-wrap [&>[data-slot=notice-actions]]:gap-1 [&>[data-slot=notice-body]]:min-w-0 [&>[data-slot=notice-body]]:flex-[1_1_16rem] [&>[data-slot=notice-icon]]:flex-none",
  {
    variants: {
      intent: {
        danger: "border-[var(--color-danger-border)] bg-pc-danger-subtle text-pc-danger-strong",
        neutral: "border-pc-border bg-pc-surface text-pc-foreground",
        success:
          "border-[var(--color-success-border)] bg-pc-success-subtle text-pc-success-foreground",
        info: "border-pc-info bg-pc-info-subtle text-pc-info-foreground",
        warning:
          "border-[var(--color-warning-border)] bg-pc-warning-subtle text-pc-warning-foreground",
      },
    },
    defaultVariants: { intent: "danger" },
  },
);
export function Notice({
  intent,
  className,
  ...props
}: ComponentProps<"section"> & VariantProps<typeof noticeVariants>) {
  return (
    <section data-slot="notice" className={noticeVariants({ intent, className })} {...props} />
  );
}

/** Two-column facts; feature-specific breakpoints and item surfaces remain with their owner. */
export function MetadataGrid({ className, ...props }: ComponentProps<"dl">) {
  return <dl className={cn("m-0 grid grid-cols-2 gap-2", className)} {...props} />;
}
