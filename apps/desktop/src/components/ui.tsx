import type { ReactNode } from "react";
import type { LucideIcon } from "lucide-react";

export function Icon({ glyph: Glyph, label, size = "md" }: { glyph: LucideIcon; label?: string; size?: "sm" | "md" | "lg" }) {
  return <Glyph className={`icon icon-${size}`} aria-hidden={label ? undefined : true} aria-label={label} focusable="false" strokeWidth={1.8} />;
}

export function BrandMotif({ label }: { label?: string }) {
  return <span className="brand-motif" aria-label={label} aria-hidden={label ? undefined : true}>
    <i className="motif-red" /><i className="motif-blue" /><i className="motif-green" /><i className="motif-yellow" />
  </span>;
}

export function EmptyState({ icon, visual, eyebrow, title, description, action }: {
  icon?: LucideIcon;
  visual?: ReactNode;
  eyebrow?: string;
  title: string;
  description: string;
  action?: ReactNode;
}) {
  return <section className="empty-state">
    <EmptyVisual icon={icon} visual={visual} />
    <div>
      {eyebrow && <p className="eyebrow">{eyebrow}</p>}
      <h2>{title}</h2>
      <p>{description}</p>
    </div>
    {action && <div className="empty-state-action">{action}</div>}
  </section>;
}

function EmptyVisual({ icon, visual }: { icon?: LucideIcon; visual?: ReactNode }) {
  if (visual) return visual;
  if (!icon) return null;
  return <span className="empty-state-icon"><Icon glyph={icon} size="lg" /></span>;
}

export function Shortcut({ children }: { children: ReactNode }) {
  return <kbd>{children}</kbd>;
}
