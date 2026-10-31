import { cn } from "cn";
const BRAND_ASSETS = {
  mascot: "/brand/mascot/portcove-mascot-v2-front.png",
  transparentMascot: "/brand/icons/portcove-mascot-transparent.png",
  wordmark: "/brand/logo/portcove-logo-v2-transparent.png",
} as const;

export function BrandAvatar({ className = "" }: { className?: string }) {
  return (
    <img
      className={cn("brand-avatar block size-10 flex-none object-contain", className)}
      src={BRAND_ASSETS.transparentMascot}
      alt=""
      aria-hidden="true"
      decoding="async"
    />
  );
}

export function BrandMascot({
  className = "",
  decorative = false,
  transparent = false,
}: {
  className?: string;
  decorative?: boolean;
  transparent?: boolean;
}) {
  return (
    <img
      className={cn(
        "brand-mascot block max-w-[100%] object-contain",
        transparent ? "bg-transparent" : "bg-[var(--color-brand-stage)]",
        className,
      )}
      src={transparent ? BRAND_ASSETS.transparentMascot : BRAND_ASSETS.mascot}
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
