import { ArrowLeft, ArrowRight, Expand } from "lucide-react";
import { useRef, useState } from "react";
import { Trans } from "react-i18next";
import { useArtworkVisibility, useCatalogMedia } from "../artwork";
import { useAppTranslation } from "../localization";
import { heroMediaCandidates, type HeroMediaPort, type HeroMediaContext } from "../hero-media";
import type { CatalogMediaAsset } from "../types";
import { ExternalLink } from "./ExternalLink";
import { Icon } from "./ui";
import { Button } from "./ui/button";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "./ui/dialog";

export function MediaCredit({ media, port }: { media: CatalogMediaAsset; port?: HeroMediaPort }) {
  const { t } = useAppTranslation("browsing");
  const edition =
    media.subject.kind === "original"
      ? port?.presentation?.original_game?.source_editions.find(
          (edition) =>
            media.subject.kind === "original" && edition.id === media.subject.source_edition_id,
        )?.title
      : undefined;
  return (
    <div className="media-credit flex min-w-0 flex-wrap gap-x-3 gap-y-1 text-xs [overflow-wrap:anywhere] text-pc-muted-foreground">
      <span>
        {media.subject.kind === "original" ? (
          <Trans
            t={t}
            i18nKey="media.creditOriginal"
            components={{
              edition: <bdi>{edition ?? media.subject.source_edition_id}</bdi>,
              credit: <bdi>{media.attribution}</bdi>,
            }}
          />
        ) : (
          <Trans
            t={t}
            i18nKey="media.creditPort"
            components={{ credit: <bdi>{media.attribution}</bdi> }}
          />
        )}
      </span>
      <ExternalLink href={media.source_url}>{t("media.source")}</ExternalLink>
      <ExternalLink href={media.rights_url}>
        {media.license === "LicenseRef-IGDB-Terms" ? t("media.igdbTerms") : media.license}
      </ExternalLink>
    </div>
  );
}

function MediaPreview({
  portId,
  media,
  visible,
}: {
  portId: string;
  media: CatalogMediaAsset;
  visible: boolean;
}) {
  const { t } = useAppTranslation("browsing");
  const { display, retry } = useCatalogMedia(portId, media, visible);
  return display.image ? (
    <img
      src={display.image}
      alt={media.caption}
      width={media.width}
      height={media.height}
      loading="lazy"
      decoding="async"
      onError={display.onImageError}
    />
  ) : (
    <div className="media-preview-message grid place-items-center gap-2 p-4 text-sm">
      <span>{display.error ? t("media.unavailable") : t("media.loading")}</span>
      {display.error && (
        <Button size="sm" variant="outline" onClick={retry}>
          {t("media.retry")}
        </Button>
      )}
    </div>
  );
}

function Screenshot({
  portId,
  media,
  index,
  onOpen,
}: {
  portId: string;
  media: CatalogMediaAsset;
  index: number;
  onOpen: (element: HTMLButtonElement) => void;
}) {
  const { t } = useAppTranslation("browsing");
  const { element, visible } = useArtworkVisibility();
  const { display, retry } = useCatalogMedia(portId, media, visible);
  return (
    <figure ref={element} className="m-0 min-w-0">
      {display.error ? (
        <div className="grid gap-2 rounded-pc-md border border-pc-border p-3 text-sm">
          <span>
            <Trans
              t={t}
              i18nKey="media.captionUnavailable"
              components={{ caption: <bdi>{media.caption}</bdi> }}
            />
          </span>
          <Button size="sm" variant="outline" onClick={retry}>
            {t("media.retryScreenshot", { number: index + 1 })}
          </Button>
        </div>
      ) : (
        <Button
          variant="ghost"
          className="media-thumbnail relative block w-full overflow-hidden rounded-pc-md border border-pc-border p-0"
          disabled={!display.image}
          aria-label={t("media.enlarge", { number: index + 1, caption: media.caption })}
          onClick={(event) => onOpen(event.currentTarget)}
        >
          {display.image ? (
            <img
              src={display.image}
              alt=""
              width={media.width}
              height={media.height}
              loading="lazy"
              decoding="async"
              onError={display.onImageError}
            />
          ) : (
            <span className="block p-6 text-sm">{t("media.loadingScreenshot")}</span>
          )}
          <span
            className="media-expand absolute end-2 bottom-2 rounded-pc-sm bg-pc-surface p-1"
            aria-hidden="true"
          >
            <Icon glyph={Expand} size="sm" />
          </span>
        </Button>
      )}
      <figcaption className="mt-2 grid gap-1 text-xs">
        <span>{media.caption}</span>
        <MediaCredit media={media} />
      </figcaption>
    </figure>
  );
}

function ScreenshotChoice({
  portId,
  media,
  index,
  selected,
  onSelect,
}: {
  portId: string;
  media: CatalogMediaAsset;
  index: number;
  selected: boolean;
  onSelect: () => void;
}) {
  const { t } = useAppTranslation("browsing");
  const { display } = useCatalogMedia(portId, media, true);
  return (
    <Button
      variant="ghost"
      className="rounded-md border-2 p-0.5 aria-pressed:border-pc-interactive forced-colors:aria-pressed:border-[Highlight]"
      aria-label={t("media.show", { number: index + 1, caption: media.caption })}
      aria-pressed={selected}
      onClick={onSelect}
    >
      {display.image && (
        <img src={display.image} alt="" decoding="async" onError={display.onImageError} />
      )}
      <span aria-hidden="true">{index + 1}</span>
    </Button>
  );
}

/** Only explicitly admitted exact-port or exact-edition images reach this gallery. */
export function CatalogMediaGallery({
  port,
  context = {},
}: {
  port: HeroMediaPort;
  context?: HeroMediaContext;
}) {
  const { t } = useAppTranslation("browsing");
  const portId = port.id;
  const shots = heroMediaCandidates(port, context).screenshots;
  const [selected, setSelected] = useState<string>();
  const origin = useRef<HTMLButtonElement | null>(null);
  const heading = useRef<HTMLHeadingElement>(null);
  const index = shots.findIndex((asset) => asset.id === selected);
  const active = shots[index];
  if (!shots.length) return null;
  const change = (delta: number) =>
    setSelected(shots[(index + delta + shots.length) % shots.length]!.id);
  return (
    <section
      className="catalog-media mb-7 min-w-0 [overflow-wrap:anywhere]"
      aria-label={t("media.screenshots")}
    >
      <h3 className="mb-4 text-base">{t("media.screenshots")}</h3>
      <div className="media-gallery-grid grid gap-4">
        {shots.map((asset, position) => (
          <Screenshot
            key={`${asset.id}:${asset.sha256}`}
            portId={portId}
            media={asset}
            index={position}
            onOpen={(element) => {
              origin.current = element;
              setSelected(asset.id);
            }}
          />
        ))}
      </div>
      <Dialog
        open={Boolean(active)}
        onOpenChange={(open) => {
          if (!open) setSelected(undefined);
        }}
      >
        <DialogContent
          reviewSize="large"
          initialFocus={heading}
          finalFocus={() =>
            origin.current?.isConnected && !origin.current.closest("[hidden], [inert]")
              ? origin.current
              : undefined
          }
          onKeyDown={(event) => {
            if (event.key === "ArrowRight" || event.key === "ArrowLeft") {
              event.preventDefault();
              change(event.key === "ArrowRight" ? 1 : -1);
            }
          }}
        >
          {active && (
            <>
              <DialogTitle ref={heading} tabIndex={-1}>
                {active.caption}
              </DialogTitle>
              <DialogDescription>
                {t("media.position", { number: index + 1, total: shots.length })}
              </DialogDescription>
              <div className="media-viewer-stage mt-4">
                <MediaPreview portId={portId} media={active} visible />
              </div>
              <div className="media-filmstrip" role="group" aria-label={t("media.choose")}>
                {shots.map((asset, position) => (
                  <ScreenshotChoice
                    key={`${asset.id}:${asset.sha256}`}
                    portId={portId}
                    media={asset}
                    index={position}
                    selected={position === index}
                    onSelect={() => setSelected(asset.id)}
                  />
                ))}
              </div>
              <div className="mt-4">
                <MediaCredit media={active} />
              </div>
              <p className="mt-3 text-xs text-pc-muted-foreground">
                {active.subject.kind === "original"
                  ? t("media.fromOriginal")
                  : t("media.exactPort")}
              </p>
              <div className="mt-4 flex flex-wrap items-center justify-between gap-2">
                <Button variant="outline" disabled={shots.length < 2} onClick={() => change(-1)}>
                  <Icon glyph={ArrowLeft} />
                  {t("media.previous")}
                </Button>
                <ExternalLink href={active.url}>{t("media.openOriginal")}</ExternalLink>
                <Button variant="outline" disabled={shots.length < 2} onClick={() => change(1)}>
                  {t("media.next")}
                  <Icon glyph={ArrowRight} />
                </Button>
              </div>
            </>
          )}
        </DialogContent>
      </Dialog>
    </section>
  );
}
