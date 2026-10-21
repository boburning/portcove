import { cn } from "cn";
import type { ReactNode } from "react";
import type { LucideIcon } from "lucide-react";

export function Icon({
  glyph: Glyph,
  label,
  size = "md",
  className,
}: {
  glyph: LucideIcon;
  label?: string;
  size?: "sm" | "md" | "lg";
  className?: string;
}) {
  return (
    <Glyph
      className={cn(
        "icon flex-none",
        { sm: "size-3", md: "size-4", lg: "size-5" }[size],
        className,
      )}
      aria-hidden={label ? undefined : true}
      aria-label={label}
      focusable="false"
      strokeWidth={1.8}
    />
  );
}

export function BrandMotif({ label, className }: { label?: string; className?: string }) {
  return (
    <span
      className={cn(
        "brand-motif inline-grid h-[0.3rem] w-[1.2rem] grid-cols-4 gap-[0.08rem]",
        className,
      )}
      aria-label={label}
      aria-hidden={label ? undefined : true}
    >
      <i className="block -skew-x-12 bg-[var(--color-motif-red)]" />
      <i className="block -skew-x-12 bg-[var(--color-motif-blue)]" />
      <i className="block -skew-x-12 bg-[var(--color-motif-green)]" />
      <i className="block -skew-x-12 bg-[var(--color-motif-yellow)]" />
    </span>
  );
}

export function EmptyState({
  icon,
  visual,
  eyebrow,
  title,
  description,
  action,
}: {
  icon?: LucideIcon | undefined;
  visual?: ReactNode;
  eyebrow?: string;
  title: string;
  description: string;
  action?: ReactNode;
}) {
  return (
    <section className="empty-state flex min-h-[18.75rem] flex-col items-center justify-center gap-4 rounded-pc-lg border border-dashed border-[var(--color-border-strong)] bg-[var(--color-bg-subtle)] p-10 text-center text-pc-muted-foreground">
      <EmptyVisual icon={icon} visual={visual} />
      <div>
        {eyebrow && (
          <p className="eyebrow mb-[6px] text-[length:var(--text-xs)] font-bold tracking-[0.16em] text-[var(--color-primary-text)]">
            {eyebrow}
          </p>
        )}
        <h2 className="mb-2 text-lg text-pc-foreground">{title}</h2>
        <p className="m-0 max-w-[32rem] leading-[var(--leading-relaxed)]">{description}</p>
      </div>
      {action && <div className="mt-2">{action}</div>}
    </section>
  );
}

function EmptyVisual({ icon, visual }: { icon?: LucideIcon | undefined; visual?: ReactNode }) {
  if (visual) return visual;
  if (!icon) return null;
  return (
    <span className="relative grid size-12 place-items-center rounded-pc-lg border border-pc-border bg-pc-surface text-[var(--color-interactive-text)] shadow-[var(--shadow-control)]">
      <Icon glyph={icon} size="lg" />
    </span>
  );
}

export function Shortcut({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <kbd
      className={cn(
        "inline-flex min-w-[1.35rem] items-center justify-center rounded-pc-sm border border-[var(--color-border-strong)] bg-[var(--color-bg-inset)] px-1 py-0.5 font-mono text-[length:var(--text-2xs)] leading-tight font-medium whitespace-nowrap text-pc-muted-foreground shadow-[inset_0_-1px_var(--color-bg-active)]",
        className,
      )}
    >
      {children}
    </kbd>
  );
}

export function NavigationHints({
  controller,
  workspace = false,
  className,
}: {
  controller?: string | undefined;
  workspace?: boolean;
  className?: string;
}) {
  return (
    <details
      className={cn(
        "controller-hint mt-4 text-[length:var(--text-xs)] text-[var(--color-text-muted)]",
        className,
      )}
      open={controller ? true : undefined}
    >
      <summary data-focusable className="cursor-pointer py-2">
        Navigation help
      </summary>
      <div role="group" aria-label="Navigation shortcuts" className="flex flex-wrap gap-3 py-2">
        {controller && <strong>{controller}</strong>}
        <span className="keyboard-navigation-hint in-data-[input-mode=controller]:hidden">
          Arrow keys: Move
        </span>
        <span className="keyboard-navigation-hint in-data-[input-mode=controller]:hidden">
          Enter: Select
        </span>
        <span className="keyboard-navigation-hint in-data-[input-mode=controller]:hidden">
          {workspace ? "Esc: Menu" : "Esc: Back"}
        </span>
        <span className="gamepad-navigation-hint hidden in-data-[input-mode=controller]:inline">
          D-pad or stick: Move
        </span>
        <span className="gamepad-navigation-hint hidden in-data-[input-mode=controller]:inline">
          Confirm button: Select
        </span>
        <span className="gamepad-navigation-hint hidden in-data-[input-mode=controller]:inline">
          {workspace ? "Back button: Menu" : "Back button: Back"}
        </span>
        {workspace && (
          <span className="gamepad-navigation-hint hidden in-data-[input-mode=controller]:inline">
            Shoulder buttons: Switch section
          </span>
        )}
      </div>
    </details>
  );
}
