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
  type HeroMediaContext,
  type HeroMediaPort,
} from "../hero-media";
import { Button } from "./ui/button";
import { ArrowRight } from "lucide-react";
import { ArtworkSource, ArtworkFrame } from "./Artwork";
import { MediaCredit } from "./CatalogMedia";
import { cn } from "cn";
import { useAppTranslation } from "../localization";

type HeroArtwork = ReturnType<typeof useGameHeroArtwork>;
type HeroPreview = Pick<BackgroundPreviewProps, "image" | "position" | "onError">;

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
  mediaContext,
}: {
  port: HeroMediaPort;
  variant: "detail" | "continue";
  className?: string | undefined;
  label?: string | undefined;
  children: ReactNode;
  successfulLaunches?: number | undefined;
  compact?: boolean;
  preview?: HeroPreview | undefined;
  mediaContext?: HeroMediaContext | undefined;
}) {
  const { t } = useAppTranslation("browsing");
  const { element, visible } = useArtworkVisibility();
  const artworkVisible = visible && !compact;
  const { foreground, cover, background } = useGameHeroArtwork(
    port,
    artworkVisible,
    mediaContext,
    !preview,
  );
  const collection = useCollectionCovers(port.id, cover, artworkVisible);
  const selection = useHeroForeground(port.id, foreground, cover, compact);
  const showCollection = collection.length > 0 && !selection.foregroundImage;

  return (
    <section
      ref={element}
      className={cn("game-hero", `game-hero-${variant}`, className)}
      data-hero-compact={compact || undefined}
      data-hero-identity={compact ? "text" : selection.kind}
      data-hero-layout={compact ? undefined : selection.layout}
      data-successful-launches={successfulLaunches}
      aria-label={
        label ??
        (variant === "detail"
          ? t("hero.detailLabel", { title: gameTitle(port) })
          : t("hero.continueLabel", { title: gameTitle(port) }))
      }
      data-focus-group
    >
      {!compact && <HeroBackgroundLayer background={background} preview={preview} />}
      <div className="game-hero-body">
        {!compact && (
          <HeroForegroundLayer
            portId={port.id}
            foreground={foreground}
            cover={cover}
            selection={selection}
            visible={visible}
            showCollection={showCollection}
          />
        )}
        <div className="game-hero-content">{children}</div>
      </div>
      {!compact && !preview && (
        <HeroCredits
          port={port}
          artwork={{ foreground, cover, background }}
          foregroundVisible={Boolean(selection.foregroundImage)}
          coverVisible={selection.kind === "cover" && Boolean(selection.image)}
          collectionActive={showCollection}
          collectionLoaded={collection.some((member) => member.image)}
        />
      )}
    </section>
  );
}

function HeroBackgroundLayer({
  background,
  preview,
}: {
  background: HeroArtwork["background"];
  preview: HeroPreview | undefined;
}) {
  const image = preview?.image ?? background.display.image;
  if (!image) return null;
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
  return (
    <div className="game-hero-background" aria-hidden="true" style={backgroundPosition}>
      <img
        key={image}
        src={image}
        alt=""
        decoding="async"
        onError={(event) => {
          event.currentTarget.style.visibility = "hidden";
          if (preview) preview.onError();
          else background.display.onImageError?.();
        }}
      />
    </div>
  );
}

function useHeroForeground(
  portId: string,
  foreground: HeroArtwork["foreground"],
  cover: HeroArtwork["cover"],
  compact: boolean,
) {
  const [rejectedLogo, setRejectedLogo] = useState<string>();
  const localChoice = foreground.localLogo ? foreground.display.state?.choice : undefined;
  const localLogoIdentity = localChoice
    ? `${foreground.logoGeneration}:${portId}:${localChoice.revision}:${localChoice.asset_sha256}`
    : undefined;
  const foregroundImage =
    localLogoIdentity && localLogoIdentity === rejectedLogo ? undefined : foreground.display.image;
  const [surface, setSurface] = useState<HeroLogoSurface & { image: string }>();
  const imageElement = useRef<HTMLImageElement>(null);
  const image = foregroundImage ?? cover.image;
  const kind = foregroundImage ? foreground.role : image ? "cover" : "text";
  const identity = `${portId}:${kind}:${image ?? "text"}`;
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

  return {
    foregroundImage,
    image,
    kind,
    identity,
    layout,
    imageElement,
    imageSurface: surface?.image === identity ? surface : undefined,
    inspect,
  };
}

function HeroForegroundLayer({
  portId,
  foreground,
  cover,
  selection,
  visible,
  showCollection,
}: {
  portId: string;
  foreground: HeroArtwork["foreground"];
  cover: HeroArtwork["cover"];
  selection: ReturnType<typeof useHeroForeground>;
  visible: boolean;
  showCollection: boolean;
}) {
  const collectionElement = useRef<HTMLDivElement>(null);
  const { image, kind, foregroundImage, identity, imageElement, imageSurface, inspect } = selection;
  if (!image && !showCollection && !foreground.display.loading && !cover.loading) return null;
  const foregroundSize = foregroundImage ? foreground.candidate : undefined;

  return (
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
          portId={portId}
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
            width={foregroundSize?.width}
            height={foregroundSize?.height}
            decoding="async"
            style={
              imageSurface?.plate
                ? ({ "--hero-image-backplate": imageSurface.backing } as CSSProperties)
                : undefined
            }
            data-plate={imageSurface?.plate || undefined}
            data-logo-tone={imageSurface?.tone}
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
  );
}

export function GameHeroFramingPreview({
  port,
  layout,
  image,
  position,
  actionLabel,
  mediaContext,
  onError,
}: BackgroundPreviewProps) {
  const { t } = useAppTranslation("browsing");
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
        mediaContext={mediaContext}
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
                {t("hero.openDetails")}
                <ArrowRight aria-hidden="true" />
              </Button>
            </div>
          </>
        )}
      </GameHero>
    </div>
  );
}

type HeroCreditProps = {
  port: HeroMediaPort;
  artwork: Pick<ReturnType<typeof useGameHeroArtwork>, "foreground" | "cover" | "background">;
  foregroundVisible: boolean;
  coverVisible: boolean;
  collectionActive: boolean;
  collectionLoaded: boolean;
};

function artworkCredit(key: string, state: HeroCreditProps["artwork"]["cover"]["state"]) {
  return (
    state && <ArtworkSource key={key} state={state} renderedSource={state.resolved_source.kind} />
  );
}

function mediaCredit(
  key: string,
  media: HeroCreditProps["artwork"]["foreground"]["candidate"],
  port: HeroMediaPort,
) {
  return media && <MediaCredit key={key} media={media} port={port} />;
}

function backgroundArtworkCredit({ background, cover }: HeroCreditProps["artwork"]) {
  const image = background.display.image;
  if (!image || background.catalogMedia || image === cover.image) return;
  return artworkCredit("background-artwork", background.display.state);
}

function collectionArtworkCredit(
  { artwork: { cover }, collectionActive, collectionLoaded }: HeroCreditProps,
  collection: ReturnType<typeof useCoverCollection>,
) {
  if (!collectionActive || !collection?.length || !usesAutomaticArtwork(cover.state) || cover.stale)
    return;
  return (
    <ArtworkSource
      key="collection"
      state={cover.state}
      renderedSource={collectionLoaded ? "igdb_cover_collection" : "generated_fallback"}
      collectionCovers={collection}
    />
  );
}

function heroCreditEntries(
  props: HeroCreditProps,
  collection: ReturnType<typeof useCoverCollection>,
) {
  const { port, artwork, foregroundVisible, coverVisible } = props;
  const { foreground, cover, background } = artwork;
  return [
    mediaCredit("foreground-media", foregroundVisible ? foreground.candidate : undefined, port),
    artworkCredit(
      "logo",
      foreground.localLogo && foregroundVisible ? foreground.display.state : undefined,
    ),
    mediaCredit("background-media", background.catalogMedia, port),
    artworkCredit("cover", coverVisible ? cover.state : undefined),
    collectionArtworkCredit(props, collection),
    backgroundArtworkCredit(artwork),
  ].filter(Boolean);
}

function HeroCredits(props: HeroCreditProps) {
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
  const collection = useCoverCollection(props.port.id);
  const credits = heroCreditEntries(props, collection);
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
      {credits.length > 0 && (
        <details className="game-hero-credits">
          <summary data-focusable>{t("hero.credits")}</summary>
          {credits}
        </details>
      )}
    </div>
  );
}
