import type { ReactNode } from "react";
import type { LucideIcon } from "lucide-react";

export function Icon({
  glyph: Glyph,
  label,
  size = "md",
}: {
  glyph: LucideIcon;
  label?: string;
  size?: "sm" | "md" | "lg";
}) {
  return (
    <Glyph
      className={`icon icon-${size}`}
      aria-hidden={label ? undefined : true}
      aria-label={label}
      focusable="false"
      strokeWidth={1.8}
    />
  );
}

export function BrandMotif({ label }: { label?: string }) {
  return (
    <span className="brand-motif" aria-label={label} aria-hidden={label ? undefined : true}>
      <i className="motif-red" />
      <i className="motif-blue" />
      <i className="motif-green" />
      <i className="motif-yellow" />
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
  icon?: LucideIcon;
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
        {eyebrow && <p className="eyebrow">{eyebrow}</p>}
        <h2 className="mb-2 text-lg text-pc-foreground">{title}</h2>
        <p className="m-0 max-w-[32rem] leading-[var(--leading-relaxed)]">{description}</p>
      </div>
      {action && <div className="mt-2">{action}</div>}
    </section>
  );
}

function EmptyVisual({ icon, visual }: { icon?: LucideIcon; visual?: ReactNode }) {
  if (visual) return visual;
  if (!icon) return null;
  return (
    <span className="relative grid size-12 place-items-center rounded-pc-lg border border-pc-border bg-pc-surface text-[var(--color-interactive-text)] shadow-[var(--shadow-control)]">
      <Icon glyph={icon} size="lg" />
    </span>
  );
}

export function Shortcut({ children }: { children: ReactNode }) {
  return <kbd>{children}</kbd>;
}

export function NavigationHints({
  controller,
  workspace = false,
}: {
  controller?: string;
  workspace?: boolean;
}) {
  return (
    <div className="controller-hint" role="group" aria-label="Navigation help">
      {controller && <strong>{controller}</strong>}
      <span className="keyboard-navigation-hint">Arrow keys: Move</span>
      <span className="keyboard-navigation-hint">Enter: Select</span>
      <span className="keyboard-navigation-hint">{workspace ? "Esc: Menu" : "Esc: Back"}</span>
      <span className="gamepad-navigation-hint">D-pad or stick: Move</span>
      <span className="gamepad-navigation-hint">Confirm button: Select</span>
      <span className="gamepad-navigation-hint">
        {workspace ? "Back button: Menu" : "Back button: Back"}
      </span>
      {workspace && (
        <span className="gamepad-navigation-hint">Shoulder buttons: Switch section</span>
      )}
    </div>
  );
}
