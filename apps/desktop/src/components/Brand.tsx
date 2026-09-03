const BRAND_ASSETS = {
  icon: "/brand/icons/portcove-mascot-head-256.png",
  mascot: "/brand/mascot/portcove-mascot-v2-front.png",
  wordmark: "/brand/logo/portcove-logo-v2-transparent.png",
} as const;

export function BrandAvatar({ className = "" }: { className?: string }) {
  return <img className={`brand-avatar ${className}`.trim()} src={BRAND_ASSETS.icon} alt="" aria-hidden="true" decoding="async" />;
}

export function BrandMascot({ className = "", decorative = false }: { className?: string; decorative?: boolean }) {
  return <img className={`brand-mascot ${className}`.trim()} src={BRAND_ASSETS.mascot} alt={decorative ? "" : "Portcove crab mascot"} aria-hidden={decorative || undefined} decoding="async" />;
}

export function BrandWordmark({ className = "", decorative = false }: { className?: string; decorative?: boolean }) {
  return <img className={`brand-wordmark ${className}`.trim()} src={BRAND_ASSETS.wordmark} alt={decorative ? "" : "Portcove"} aria-hidden={decorative || undefined} decoding="async" />;
}
