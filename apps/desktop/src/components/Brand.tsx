import { cn } from "cn";
const BRAND_ASSETS = {
  icon: "/brand/icons/portcove-mascot-head-256.png",
  mascot: "/brand/mascot/portcove-mascot-v2-front.png",
  wordmark: "/brand/logo/portcove-logo-v2-transparent.png",
} as const;

export function BrandAvatar({ className = "" }: { className?: string }) {
  return (
    <img
      className={cn(
        "brand-avatar block size-10 flex-none rounded-pc-lg border border-[var(--color-border-strong)] bg-[var(--color-brand-stage)] object-cover shadow-(--shadow-raised)",
        className,
      )}
      src={BRAND_ASSETS.icon}
      alt=""
      aria-hidden="true"
      decoding="async"
    />
  );
}

export function BrandMascot({
  className = "",
  decorative = false,
}: {
  className?: string;
  decorative?: boolean;
}) {
  return (
    <img
      className={cn(
        `brand-mascot ${className}`.trim(),
        "block max-w-[100%] bg-[var(--color-brand-stage)] object-contain",
      )}
      src={BRAND_ASSETS.mascot}
      alt={decorative ? "" : "Portcove crab mascot"}
      aria-hidden={decorative || undefined}
      decoding="async"
    />
  );
}

export function BrandWordmark({
  className = "",
  decorative = false,
}: {
  className?: string;
  decorative?: boolean;
}) {
  return (
    <img
      className={cn(
        `brand-wordmark ${className}`.trim(),
        "block max-w-[100%] bg-[var(--color-brand-stage)] object-contain",
      )}
      src={BRAND_ASSETS.wordmark}
      alt={decorative ? "" : "Portcove"}
      aria-hidden={decorative || undefined}
      decoding="async"
    />
  );
}
