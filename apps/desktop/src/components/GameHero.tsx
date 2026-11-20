import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
} from "react";
import {
  useArtworkVisibility,
  useGameHeroArtwork,
  usesAutomaticArtwork,
  useCollectionCovers,
  useCoverCollection,
} from "../artwork";
import {
  inspectHeroLogo,
  isHeroKeyArtSuitable,
  type HeroLogoSurface,
} from "../hero-image-suitability";
import { gameProjectLabel, gameTitle } from "../port-identity";
import {
  backgroundObjectPosition,
  type BackgroundPreviewProps,
  type HeroMediaPort,
} from "../hero-media";
import { Button } from "./ui/button";
import { ArrowRight } from "lucide-react";
import { ArtworkSource, ArtworkFrame } from "./Artwork";
import { MediaCredit } from "./CatalogMedia";
import { cn } from "cn";
import { useAppTranslation } from "../localization";

/** Shared descriptive media composition; callers retain headings, actions and eligibility. */
export function GameHero({
  port,
  variant,
  className,
  label,
  children,
  successfulLaunches,
  compact = false,
  preview,
}: {
  port: HeroMediaPort;
  variant: "detail" | "continue";
  className?: string | undefined;
  label?: string | undefined;
  children: ReactNode;
  successfulLaunches?: number | undefined;
  compact?: boolean;
  preview?: Pick<BackgroundPreviewProps, "image" | "position" | "onError"> | undefined;
}) {
  const { t } = useAppTranslation("browsing");
  const { element, visible } = useArtworkVisibility();
  const artworkVisible = visible && !compact;
  const { foreground, cover, background } = useGameHeroArtwork(
    port,
    artworkVisible,
    undefined,
    !preview,
  );
  const backgroundState = background.display.state;
  const framing =
    backgroundState?.resolved_source.kind === "local_import"
      ? backgroundState.choice.framing
      : undefined;
  const widePosition =
    preview?.position ??
    (framing?.version === "v1" ? backgroundObjectPosition(framing.wide) : undefined);
  const narrowPosition =
    preview?.position ??
    (framing?.version === "v1" ? backgroundObjectPosition(framing.narrow) : undefined);
  const backgroundPosition = {
    "--hero-background-wide-position": widePosition,
    "--hero-background-narrow-position": narrowPosition,
  } as CSSProperties;
  const backgroundImage = preview?.image ?? background.display.image;
  const collection = useCollectionCovers(port.id, cover, artworkVisible);
  const collectionElement = useRef<HTMLDivElement>(null);
  const [rejectedLogo, setRejectedLogo] = useState<string>();
  const localChoice = foreground.localLogo ? foreground.display.state?.choice : undefined;
  const localLogoIdentity = localChoice
    ? `${foreground.localLogo ? foreground.logoGeneration : undefined}:${port.id}:${localChoice.revision}:${localChoice.asset_sha256}`
    : undefined;
  const foregroundImage =
    localLogoIdentity && localLogoIdentity === rejectedLogo ? undefined : foreground.display.image;
  const showCollection = collection.length > 0 && !foregroundImage;
  const [surface, setSurface] = useState<HeroLogoSurface & { image: string }>();
  const imageElement = useRef<HTMLImageElement>(null);
  const image = foregroundImage ?? cover.image;
  const kind = foregroundImage ? foreground.role : image ? "cover" : "text";
  const identity = `${port.id}:${kind}:${image ?? "text"}`;
  const layout =
    localLogoIdentity === rejectedLogo && rejectedLogo
      ? "cover"
      : (foreground.initialRole ?? "cover");
  const rejectForeground = foreground.reject;
  const rejectCover = cover.onImageError;
  const inspect = useCallback(
    (element: HTMLImageElement) => {
      if (!element.naturalWidth || !element.naturalHeight) {
        if (foregroundImage) rejectForeground();
        else rejectCover?.();
        return;
      }
      if (kind === "key_art" && !isHeroKeyArtSuitable(element)) {
        rejectForeground();
        return;
      }
      if (kind !== "logo") return;
      const next = inspectHeroLogo(element);
      if (!next) {
        // An unsuitable player logo stays selected and remains available in Manage.
        if (localLogoIdentity) setRejectedLogo(localLogoIdentity);
        else rejectForeground();
        return;
      }
      setSurface((previous) =>
        previous?.image === identity &&
        previous.plate === next.plate &&
        previous.tone === next.tone &&
        previous.backing === next.backing
          ? previous
          : { ...next, image: identity },
      );
    },
    [kind, identity, foregroundImage, localLogoIdentity, rejectForeground, rejectCover],
  );
  useEffect(() => {
    const image = imageElement.current;
    if (
      compact ||
      (kind !== "logo" && kind !== "key_art") ||
      !image ||
      typeof ResizeObserver === "undefined"
    )
      return;
    const observer = new ResizeObserver(() => {
      if (image.complete && image.naturalWidth) inspect(image);
    });
    observer.observe(image);
    return () => observer.disconnect();
  }, [compact, identity, kind, inspect]);

  return (
    <section
      ref={element}
      className={cn("game-hero", `game-hero-${variant}`, className)}
      data-hero-compact={compact || undefined}
      data-hero-identity={compact ? "text" : kind}
      data-hero-layout={compact ? undefined : layout}
      data-successful-launches={successfulLaunches}
      aria-label={
        label ??
        (variant === "detail"
          ? t("hero.detailLabel", { title: gameTitle(port) })
          : t("hero.continueLabel", { title: gameTitle(port) }))
      }
      data-focus-group
    >
      {!compact && backgroundImage && (
        <div className="game-hero-background" aria-hidden="true" style={backgroundPosition}>
          <img
            key={backgroundImage}
            src={backgroundImage}
            alt=""
            decoding="async"
            onError={(event) => {
              event.currentTarget.style.visibility = "hidden";
              if (preview) preview.onError();
              else background.display.onImageError?.();
            }}
          />
        </div>
      )}
      <div className="game-hero-body">
        {!compact && (image || showCollection || foreground.display.loading || cover.loading) && (
          <div
            className="game-hero-foreground"
            data-artwork-source={kind === "cover" ? cover.state?.resolved_source.kind : undefined}
            aria-hidden="true"
            data-loading={!image || undefined}
          >
            {showCollection ? (
              <ArtworkFrame
                element={collectionElement}
                display={cover}
                portId={port.id}
                visible={visible}
                identityArtwork
                className="game-hero-collection"
              />
            ) : (
              image && (
                <img
                  key={identity}
                  ref={imageElement}
                  className="game-hero-image"
                  src={image}
                  alt=""
                  width={foregroundImage ? foreground.candidate?.width : undefined}
                  height={foregroundImage ? foreground.candidate?.height : undefined}
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
                    event.currentTarget.style.visibility = "hidden";
                    if (foregroundImage) {
                      if (!foreground.localLogo) foreground.display.onImageError?.();
                      foreground.reject();
                    } else cover.onImageError?.();
                  }}
                />
              )
            )}
          </div>
        )}
        <div className="game-hero-content">{children}</div>
      </div>
      {!compact && !preview && (
        <HeroCredits
          port={port}
          artwork={{ foreground, cover, background }}
          foregroundVisible={Boolean(foregroundImage)}
          coverVisible={kind === "cover" && Boolean(image)}
          collectionActive={showCollection}
          collectionLoaded={collection.some((member) => member.image)}
        />
      )}
    </section>
  );
}

export function GameHeroFramingPreview({
  port,
  layout,
  image,
  position,
  actionLabel,
  onError,
}: BackgroundPreviewProps) {
  const variant = layout === "wide" ? "detail" : "continue";
  const project = gameProjectLabel(port);
  const action = actionLabel && (
    <Button type="button" variant="primary" size={variant === "detail" ? "lg" : "default"}>
      {actionLabel}
    </Button>
  );
  return (
    <div
      className={cn("game-hero-framing-preview", `game-hero-framing-preview-${variant}`)}
      inert
      aria-hidden="true"
    >
      <GameHero
        port={port}
        variant={variant}
        className={variant === "detail" ? "detail-hero" : "continue-card"}
        preview={{ image, position, onError }}
      >
        {variant === "detail" ? (
          <div className="detail-identity min-w-0 wrap-anywhere">
            <p className="detail-title">{gameTitle(port)}</p>
            {project && <p className="detail-project">{project}</p>}
            {action && <div className="detail-header-actions mt-4">{action}</div>}
          </div>
        ) : (
          <>
            <div className="continue-identity">
              <p className="continue-title">{gameTitle(port)}</p>
              {project && <p className="mt-1 text-xs text-pc-muted-foreground">{project}</p>}
            </div>
            <div className="continue-actions min-w-0">
              {action}
              <Button type="button" variant="ghost" className="continue-details">
                Game details
                <ArrowRight aria-hidden="true" />
              </Button>
            </div>
          </>
        )}
      </GameHero>
    </div>
  );
}

function HeroCredits({
  port,
  artwork,
  foregroundVisible,
  coverVisible,
  collectionActive,
  collectionLoaded,
}: {
  port: HeroMediaPort;
  artwork: Pick<ReturnType<typeof useGameHeroArtwork>, "foreground" | "cover" | "background">;
  foregroundVisible: boolean;
  coverVisible: boolean;
  collectionActive: boolean;
  collectionLoaded: boolean;
}) {
  const { t } = useAppTranslation("browsing");
  const slot = useRef<HTMLDivElement>(null);
  const focusedCredit = useRef<HTMLElement>(null);
  useLayoutEffect(() => {
    const previous = focusedCredit.current;
    if (previous && !previous.isConnected && document.activeElement === document.body) {
      const content = slot.current?.closest("section")?.querySelector(".game-hero-content");
      const target = content?.querySelector<HTMLElement>("button:not([disabled]), [tabindex='-1']");
      target?.focus();
      focusedCredit.current = null;
    }
  });
  const { foreground, cover, background } = artwork;
  const collection = useCoverCollection(port.id);
  const collectionVisible =
    collectionActive &&
    Boolean(collection?.length && usesAutomaticArtwork(cover.state) && !cover.stale);
  const foregroundMedia = foregroundVisible ? foreground.candidate : undefined;
  const logoState =
    foreground.localLogo && foregroundVisible ? foreground.display.state : undefined;
  const coverState = coverVisible ? cover.state : undefined;
  const backgroundState =
    background.display.image && !background.catalogMedia && background.display.image !== cover.image
      ? background.display.state
      : undefined;
  const visible =
    foregroundMedia ||
    logoState ||
    background.catalogMedia ||
    coverState ||
    backgroundState ||
    collectionVisible;
  return (
    <div
      ref={slot}
      className="game-hero-credits-slot"
      onFocusCapture={(event) => {
        if (event.target instanceof HTMLElement) focusedCredit.current = event.target;
      }}
      onBlurCapture={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget)) focusedCredit.current = null;
      }}
    >
      {visible && (
        <details className="game-hero-credits">
          <summary data-focusable>{t("hero.credits")}</summary>
          {foregroundMedia && <MediaCredit media={foregroundMedia} port={port} />}
          {logoState && (
            <ArtworkSource state={logoState} renderedSource={logoState.resolved_source.kind} />
          )}
          {background.catalogMedia && <MediaCredit media={background.catalogMedia} port={port} />}
          {coverState && (
            <ArtworkSource state={coverState} renderedSource={coverState.resolved_source.kind} />
          )}
          {collectionVisible && (
            <ArtworkSource
              state={cover.state}
              renderedSource={collectionLoaded ? "igdb_cover_collection" : "generated_fallback"}
              collectionCovers={collection}
            />
          )}
          {backgroundState && (
            <ArtworkSource
              state={backgroundState}
              renderedSource={backgroundState.resolved_source.kind}
            />
          )}
        </details>
      )}
    </div>
  );
}
