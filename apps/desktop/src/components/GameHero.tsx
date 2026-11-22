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
  useCollectionCovers,
  useCoverCollection,
} from "../artwork";
import {
  inspectHeroLogo,
  isHeroKeyArtSuitable,
  type HeroLogoSurface,
} from "../hero-image-suitability";
import { gameTitle } from "../port-identity";
import type { HeroMediaContext, HeroMediaPort } from "../hero-media";
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
  mediaContext,
}: {
  port: HeroMediaPort;
  variant: "detail" | "continue";
  className?: string | undefined;
  label?: string | undefined;
  children: ReactNode;
  successfulLaunches?: number | undefined;
  compact?: boolean;
  mediaContext?: HeroMediaContext | undefined;
}) {
  const { t } = useAppTranslation("browsing");
  const { element, visible } = useArtworkVisibility();
  const artworkVisible = visible && !compact;
  const { foreground, cover, background } = useGameHeroArtwork(port, artworkVisible, mediaContext);
  const collection = useCollectionCovers(port.id, cover, artworkVisible);
  const collectionElement = useRef<HTMLDivElement>(null);
  const showCollection = collection.length > 0 && !foreground.display.image;
  const [surface, setSurface] = useState<HeroLogoSurface & { image: string }>();
  const imageElement = useRef<HTMLImageElement>(null);
  const media = foreground.display.image ? foreground.display : cover;
  const image = media.image;
  const kind = foreground.display.image ? foreground.candidate?.role : image ? "cover" : "text";
  const identity = `${port.id}:${image ?? "text"}`;
  const layout = foreground.initialRole ?? "cover";
  const foregroundImage = foreground.display.image;
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
        rejectForeground();
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
    [kind, identity, foregroundImage, rejectForeground, rejectCover],
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
      {!compact && background.display.image && (
        <div className="game-hero-background" aria-hidden="true">
          <img
            key={background.display.image}
            src={background.display.image}
            alt=""
            decoding="async"
            onError={(event) => {
              event.currentTarget.style.visibility = "hidden";
              background.display.onImageError?.();
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
                    event.currentTarget.style.visibility = "hidden";
                    if (foreground.display.image) {
                      foreground.display.onImageError?.();
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
      {!compact && (
        <HeroCredits
          port={port}
          artwork={{ foreground, cover, background }}
          coverVisible={kind === "cover" && Boolean(image)}
          collectionActive={showCollection}
          collectionLoaded={collection.some((member) => member.image)}
        />
      )}
    </section>
  );
}

function HeroCredits({
  port,
  artwork,
  coverVisible,
  collectionActive,
  collectionLoaded,
}: {
  port: HeroMediaPort;
  artwork: Pick<ReturnType<typeof useGameHeroArtwork>, "foreground" | "cover" | "background">;
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
    Boolean(collection?.length && cover.state && !cover.state.choice.asset_sha256 && !cover.stale);
  const foregroundMedia = foreground.display.image ? foreground.candidate : undefined;
  const coverState = coverVisible ? cover.state : undefined;
  const backgroundState =
    background.display.image && !background.catalogMedia && background.display.image !== cover.image
      ? background.display.state
      : undefined;
  const visible =
    foregroundMedia ||
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
