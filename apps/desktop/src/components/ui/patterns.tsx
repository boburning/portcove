import type { ComponentProps, ReactNode, RefObject } from "react";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "cn";

// These patterns serve Settings, recovery, browsing and update compositions.
export function SettingsRow({ className, ...props }: ComponentProps<"article">) {
  return (
    <article
      data-slot="settings-row"
      className={cn("settings-row @container/row", className)}
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
  return (
    <dl
      className={cn(
        "m-0 grid min-w-0 grid-cols-1 gap-3 sm:grid-cols-2 [&_dd]:min-w-0 [&_dd]:break-words [&_dt]:text-sm [&_dt]:text-pc-muted-foreground",
        className,
      )}
      {...props}
    />
  );
}

export function ActionRow({ className, ...props }: ComponentProps<"div">) {
  return <div className={cn("flex min-w-0 flex-wrap items-center gap-2", className)} {...props} />;
}

/** A current observation with caller-owned facts/actions; never derives product state. */
export function CurrentStateSummary({
  title,
  children,
  action,
  headingRef,
  className,
}: {
  title: ReactNode;
  children?: ReactNode;
  action?: ReactNode;
  headingRef?: RefObject<HTMLHeadingElement | null> | undefined;
  className?: string;
}) {
  return (
    <section
      data-slot="current-state-summary"
      className={cn(
        "flex min-w-0 flex-wrap items-start gap-4 rounded-pc-md border border-pc-border bg-pc-surface p-4",
        className,
      )}
    >
      <div className="grid min-w-0 flex-[1_1_16rem] gap-2">
        <h3
          ref={headingRef}
          tabIndex={headingRef ? -1 : undefined}
          className="m-0 text-base font-semibold"
        >
          {title}
        </h3>
        {children}
      </div>
      {action && <ActionRow className="ms-auto justify-end">{action}</ActionRow>}
    </section>
  );
}

/** Scannable management layout; operation/review owners remain mounted as children. */
export function ManagementRow({
  title,
  targetId,
  description,
  children,
}: {
  title: string;
  targetId?: string;
  description?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section
      data-slot="management-row"
      id={targetId}
      tabIndex={targetId ? -1 : undefined}
      aria-label={title}
      className="flex min-w-0 flex-wrap items-start gap-4 border-b border-pc-border py-4 last:border-b-0"
    >
      <div className="min-w-0 flex-[1_1_16rem]">
        <h3 className="m-0 text-base font-semibold">{title}</h3>
        {description && (
          <div className="mt-1 text-sm wrap-anywhere text-pc-muted-foreground">{description}</div>
        )}
      </div>
      <ActionRow className="ms-auto max-w-full justify-end">{children}</ActionRow>
    </section>
  );
}
