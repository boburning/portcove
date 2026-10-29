import { useState, type CSSProperties, type ReactNode } from "react";
import { useArtworkVisibility, useGameHeroArtwork } from "../artwork";
import { gameTitle } from "../port-identity";
import type { HeroMediaPort } from "../hero-media";
import { ArtworkSource } from "./Artwork";
import { MediaCredit } from "./CatalogMedia";
import { cn } from "cn";

/** Shared descriptive media composition; callers retain headings, actions and eligibility. */
export function GameHero({
  port,
  variant,
  className,
  label,
  children,
  successfulLaunches,
}: {
  port: HeroMediaPort;
  variant: "detail" | "continue";
  className?: string | undefined;
  label?: string | undefined;
  children: ReactNode;
  successfulLaunches?: number | undefined;
}) {
  const { element, visible } = useArtworkVisibility();
  const { foreground, cover, background } = useGameHeroArtwork(port, visible);
  const [surface, setSurface] = useState<{
    image: string;
    plate: boolean;
    backing: string;
    tone: "dark" | "light" | "mixed" | "opaque";
  }>();
  const media = foreground.display.image ? foreground.display : cover;
  const image = media.image;
  const kind = foreground.display.image ? foreground.candidate?.role : image ? "cover" : "text";
  const identity = `${port.id}:${image ?? "text"}`;
  const layout = foreground.initialRole ?? "cover";
  const inspect = (element: HTMLImageElement) => {
    if (!element.naturalWidth || !element.naturalHeight) {
      if (foreground.display.image) foreground.reject();
      else cover.onImageError?.();
      return;
    }
    if (kind !== "logo") return;
    // Inspect decoded pixels, not the provider's alpha hint. No brand pixels are changed.
    const canvas = document.createElement("canvas");
    canvas.width = canvas.height = 24;
    const context = canvas.getContext("2d", { willReadFrequently: true });
    if (!context) return;
    context.drawImage(element, 0, 0, 24, 24);
    let pixels: Uint8ClampedArray;
    try {
      pixels = context.getImageData(0, 0, 24, 24).data;
    } catch {
      foreground.reject();
      return;
    }
    let opaque = true;
    for (let index = 3; index < pixels.length; index += 4) {
      if (pixels[index]! < 245) {
        opaque = false;
        break;
      }
    }
    let red = 0,
      green = 0,
      blue = 0,
      samples = 0;
    for (let y = 0; y < 24; y++)
      for (let x = 0; x < 24; x++) {
        if (x !== 0 && y !== 0 && x !== 23 && y !== 23) continue;
        const index = (y * 24 + x) * 4;
        red += pixels[index]!;
        green += pixels[index + 1]!;
        blue += pixels[index + 2]!;
        samples++;
      }
    let backing = `rgb(${Math.round(red / samples)} ${Math.round(green / samples)} ${Math.round(blue / samples)})`;
    let alpha = 0,
      light = 0,
      firstY = 24,
      lastY = -1;
    const luminance = (r: number, g: number, b: number) =>
      [r, g, b]
        .map((value) => {
          const channel = value / 255;
          return channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
        })
        .reduce((sum, channel, index) => sum + channel * [0.2126, 0.7152, 0.0722][index]!, 0);
    for (let index = 0; index < pixels.length; index += 4) {
      const weight = pixels[index + 3]! / 255;
      if (weight < 0.2) continue;
      alpha += weight;
      light += luminance(pixels[index]!, pixels[index + 1]!, pixels[index + 2]!) * weight;
      firstY = Math.min(firstY, Math.floor(index / 4 / 24));
      lastY = Math.max(lastY, Math.floor(index / 4 / 24));
    }
    const bounds = element.getBoundingClientRect();
    const computed = getComputedStyle(element);
    const height =
      bounds.height - parseFloat(computed.paddingTop) - parseFloat(computed.paddingBottom);
    const width =
      bounds.width - parseFloat(computed.paddingLeft) - parseFloat(computed.paddingRight);
    if (!alpha || (height * (lastY - firstY + 1)) / 24 < 18 || width < 36) {
      foreground.reject();
      return;
    }
    const imageLight = light / alpha;
    const tone = opaque
      ? "opaque"
      : imageLight < 0.2
        ? "dark"
        : imageLight > 0.28
          ? "light"
          : "mixed";
    setSurface({ image: identity, plate: opaque, backing, tone });
  };
  return (
    <section
      ref={element}
      className={cn("game-hero", `game-hero-${variant}`, className)}
      data-hero-identity={kind}
      data-hero-layout={layout}
      data-successful-launches={successfulLaunches}
      aria-label={
        label ?? `${gameTitle(port)} ${variant === "detail" ? "game details" : "recently played"}`
      }
      data-focus-group
    >
      {background.display.image && (
        <div className="game-hero-background" aria-hidden="true">
          <img
            src={background.display.image}
            alt=""
            decoding="async"
            onError={background.display.onImageError}
          />
        </div>
      )}
      <div className="game-hero-body">
        {(image || foreground.display.loading || cover.loading) && (
          <div
            className="game-hero-foreground"
            aria-hidden="true"
            data-loading={!image || undefined}
          >
            {image && (
              <img
                key={identity}
                className="game-hero-image"
                src={image}
                alt=""
                width={foreground.display.image ? foreground.candidate?.width : undefined}
                height={foreground.display.image ? foreground.candidate?.height : undefined}
                decoding="async"
                style={
                  surface?.image === identity && surface.plate
                    ? ({ "--hero-image-backplate": surface.backing } as CSSProperties)
                    : undefined
                }
                data-plate={(surface?.image === identity && surface.plate) || undefined}
                data-logo-tone={surface?.image === identity ? surface.tone : undefined}
                onLoad={(event) => inspect(event.currentTarget)}
                onError={(event) => {
                  event.currentTarget.hidden = true;
                  if (foreground.display.image) {
                    foreground.display.onImageError?.();
                    foreground.reject();
                  } else cover.onImageError?.();
                }}
              />
            )}
          </div>
        )}
        <div className="game-hero-content">{children}</div>
      </div>
      <div className="game-hero-credits-slot">
        {((foreground.candidate && foreground.display.image) ||
          background.catalogMedia ||
          (image && cover.state)) && (
          <details className="game-hero-credits">
            <summary data-focusable>Image credits</summary>
            {foreground.candidate && foreground.display.image && (
              <MediaCredit media={foreground.candidate} port={port} />
            )}
            {background.catalogMedia && <MediaCredit media={background.catalogMedia} port={port} />}
            {kind === "cover" && image && cover.state && (
              <ArtworkSource
                state={cover.state}
                renderedSource={cover.state.resolved_source.kind}
              />
            )}
          </details>
        )}
      </div>
    </section>
  );
}
