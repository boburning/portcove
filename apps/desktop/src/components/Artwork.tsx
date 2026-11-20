import { cn } from "cn";
import { useAppTranslation } from "../localization";
import { gameIdentityLabel } from "../port-identity";
import { Tabs } from "@base-ui/react/tabs";
import styles from "./Artwork.module.css";
import {
  useEffect,
  useLayoutEffect,
  useId,
  useRef,
  useState,
  type ComponentType,
  type RefObject,
} from "react";
import { Gamepad2 } from "lucide-react";
import {
  useArtwork,
  useArtworkVisibility,
  useCollectionCovers,
  useCoverCollection,
  usesAutomaticArtwork,
} from "../artwork";
import { pickArtworkPath } from "../file-picker";
import { desktopApi } from "../api";
import type {
  ArtworkFraming,
  ArtworkSelectionPreview,
  ArtworkSlot,
  ArtworkState,
  PortDefinition,
  IgdbArtwork,
} from "../types";
import { errorText, formatBytes } from "../view-model";
import { Button } from "./ui/button";
import { controlFocus } from "./ui/control-style";
import { ExternalLink } from "./ExternalLink";
import { BackgroundFramingEditor } from "./BackgroundFramingEditor";
import type { BackgroundPreviewProps } from "../hero-media";
import { SteamGridDbPicker, steamGridDbErrorText } from "./SteamGridDbPicker";
import type { SteamGridDbCandidate } from "../types";

export function ArtworkImage({
  port,
  slot = "cover",
  className = "",
  quietFallback = false,
}: {
  port: Pick<PortDefinition, "id">;
  slot?: ArtworkSlot;
  className?: string;
  quietFallback?: boolean;
}) {
  const { element, visible } = useArtworkVisibility();
  const { display } = useArtwork(port.id, slot, visible);
  return (
    <ArtworkFrame
      element={element}
      display={display}
      portId={slot === "cover" ? port.id : undefined}
      visible={visible}
      className={className}
      quietFallback={quietFallback}
    />
  );
}

export function artworkDisplayNotice(display: ReturnType<typeof useArtwork>["display"]) {
  return display.stale
    ? "Previously loaded artwork"
    : display.error || display.state?.availability === "unavailable"
      ? "Image unavailable"
      : undefined;
}

/** Allows an identity control to keep artwork feedback outside its visible label. */
export function ArtworkFrame({
  element,
  display,
  className = "",
  companion,
  portId,
  visible = true,
  identityArtwork = false,
  quietFallback = false,
}: {
  element: RefObject<HTMLDivElement | null>;
  display: ReturnType<typeof useArtwork>["display"];
  className?: string;
  companion?: ReturnType<typeof useArtwork>["display"];
  portId?: string | undefined;
  visible?: boolean;
  identityArtwork?: boolean;
  quietFallback?: boolean;
}) {
  const collection = useCollectionCovers(portId, display, visible);
  const collectionImages = collection.filter((member) => member.image);
  const first = collectionImages[0] ?? display;
  const second = collectionImages.length === 2 ? collectionImages[1] : companion;
  const image = first.image;
  const tiled = collectionImages.length > 2;
  const paired = !tiled && image && second?.image && !display.stale;
  const fallback = display.state?.generated_fallback;
  const notice = artworkDisplayNotice(display);
  const palettes = [
    "[--art-color:var(--color-art-neutral)]",
    "[--art-color:var(--color-art-yellow)]",
    "[--art-color:var(--color-art-blue)]",
    "[--art-color:var(--color-art-indigo)]",
    "[--art-color:var(--color-art-green)]",
    "[--art-color:var(--color-art-red)]",
  ];
  return (
    <div
      ref={element}
      className={cn(
        "artwork-image",
        styles.image,
        className,
        identityArtwork || (quietFallback && !image)
          ? "[--art-color:var(--color-bg-subtle)]"
          : image
            ? "bg-transparent"
            : palettes[fallback?.palette_index ?? 0],
      )}
      data-artwork-source={
        collectionImages.length
          ? "igdb_cover_collection"
          : image
            ? display.state?.resolved_source.kind
            : "generated_fallback"
      }
      aria-hidden="true"
    >
      {tiled ? (
        <span className={styles.collection} data-cover-collection>
          {collectionImages.map((member) => (
            <span className={styles.tile} key={member.image}>
              <img src={member.image} alt="" decoding="async" onError={member.onImageError} />
            </span>
          ))}
        </span>
      ) : paired ? (
        <span className={styles.pair} data-companion-cover>
          <span className={styles.half}>
            <img src={image} alt="" decoding="async" onError={first.onImageError} />
          </span>
          <span className={styles.half}>
            <img src={second.image} alt="" decoding="async" onError={second.onImageError} />
          </span>
        </span>
      ) : image ? (
        <img
          className={styles.asset}
          src={image}
          alt=""
          decoding="async"
          onError={first.onImageError}
        />
      ) : quietFallback ? (
        <span className="grid max-w-full justify-items-center gap-2 p-2 text-pc-muted-foreground">
          <Gamepad2 aria-hidden="true" className="size-6 max-w-full" />
        </span>
      ) : identityArtwork ? (
        <span className={styles.illustration} data-cover-illustration>
          <Gamepad2
            className={cn(styles.illustrationController, "size-[clamp(0.875rem,27cqi,3.25rem)]")}
          />
        </span>
      ) : (
        <span className={styles.initials}>{fallback?.initials ?? "PC"}</span>
      )}
      {image && (
        <span
          className={cn(styles.backdrop, paired && styles.pairBackdropStart)}
          style={{ backgroundImage: `url(${JSON.stringify(image)})` }}
        />
      )}
      {paired && (
        <span
          className={cn(styles.backdrop, styles.pairBackdropEnd)}
          style={{ backgroundImage: `url(${JSON.stringify(second.image)})` }}
        />
      )}
      {!identityArtwork && notice && (
        <small className="artwork-image-note absolute inset-x-0 bottom-0 z-2 bg-pc-scrim p-2 text-[length:var(--text-2xs)] leading-tight text-[var(--color-art-text)]">
          {notice}
        </small>
      )}
    </div>
  );
}

function DetailArtwork({ port }: { port: Pick<PortDefinition, "id"> }) {
  const { display } = useArtwork(port.id, "detail");
  if (!display.state?.selection) return null;
  return (
    <div className="detail-artwork my-5">
      <ArtworkImage
        port={port}
        slot="detail"
        className="wide-artwork aspect-video w-full rounded-pc-md"
      />
      {(display.state.reason || display.error) && (
        <p className="artwork-notice text-[length:var(--text-sm)] text-[var(--color-text-muted)]">
          {display.state.reason ??
            "The selected image cannot be displayed. Your choice is retained."}
        </p>
      )}
    </div>
  );
}

/** Every slot's player copy; a new slot must be described here to compile. */
const slotCopy: Record<ArtworkSlot, { label: string; description: string }> = {
  cover: { label: "Cover image", description: "Portrait cover · other shapes are letterboxed." },
  detail: { label: "Background", description: "Optional background for Overview and Continue." },
  landscape: {
    label: "Wide cover",
    description:
      "Optional wide cover. Steam uses it for the game's library capsule. Separate from the detail image.",
  },
  logo: { label: "Logo", description: "Shown with the game title in Overview and Continue." },
};

const artworkSlots = Object.keys(slotCopy) as ArtworkSlot[];

type ArtworkControlsProps = {
  port: BackgroundPreviewProps["port"];
  previewPort?: BackgroundPreviewProps["port"] | undefined;
  Preview: ComponentType<BackgroundPreviewProps>;
  previewActions?: Partial<Record<BackgroundPreviewProps["layout"], string>> | undefined;
};

export function ArtworkControls(props: ArtworkControlsProps) {
  const { t } = useAppTranslation("detail");
  const { t: common } = useAppTranslation("common");
  const sheet = useRef<HTMLDialogElement>(null);
  const latestOpening = useRef(0);
  const id = useId();
  const [opening, setOpening] = useState<number>();
  const identity = props.previewPort?.id === props.port.id ? props.previewPort : props.port;
  return (
    <div className="artwork-controls">
      <Button
        type="button"
        data-focusable
        data-artwork-editor-trigger
        aria-haspopup="dialog"
        aria-controls={id}
        variant="outline"
        onClick={(event) => {
          const target = sheet.current;
          if (!target || target.open) return;
          event.currentTarget.focus({ preventScroll: true });
          target.showModal();
          latestOpening.current += 1;
          setOpening(latestOpening.current);
        }}
      >
        {t("actions.artwork")}
      </Button>
      <dialog
        ref={sheet}
        id={id}
        data-portcove-native-modal
        className={cn(styles.sheet, "artwork-sheet")}
        aria-labelledby={`${id}-title`}
        aria-describedby={`${id}-identity ${id}-scope`}
        onClose={(event) => {
          if (!event.currentTarget.open) setOpening(undefined);
        }}
      >
        <header className={styles.sheetHeader}>
          <div className="min-w-0 wrap-anywhere">
            <h2 id={`${id}-title`} className="m-0 text-xl font-semibold">
              {t("actions.artwork")}
            </h2>
            <p id={`${id}-identity`} className="m-0 text-sm text-pc-muted-foreground">
              {gameIdentityLabel(identity)}
            </p>
            <p id={`${id}-scope`} className="m-0 text-sm text-pc-muted-foreground">
              {t("artwork.scopeCurrentPort")}
            </p>
          </div>
          <form method="dialog" className="m-0">
            <Button type="submit" data-focusable data-artwork-editor-close variant="outline">
              {common("close")}
            </Button>
          </form>
        </header>
        {opening !== undefined && (
          <div className={styles.sheetBody}>
            <ArtworkSheetContents
              key={opening}
              {...props}
              isCurrentOpening={() =>
                latestOpening.current === opening && sheet.current?.open === true
              }
            />
          </div>
        )}
      </dialog>
    </div>
  );
}

function ArtworkSheetContents({
  port,
  previewPort,
  Preview,
  previewActions,
  isCurrentOpening,
}: ArtworkControlsProps & { isCurrentOpening: () => boolean }) {
  const [selected, setSelected] = useState<ArtworkSlot>("cover");
  const [visited, setVisited] = useState<ArtworkSlot[]>(["cover"]);
  return (
    <Tabs.Root
      value={selected}
      onValueChange={(value) => {
        const next = artworkSlots.find((slot) => value === slot);
        if (!next) return;
        setSelected(next);
        setVisited((current) => (current.includes(next) ? current : [...current, next]));
      }}
      className="artwork-slots grid min-w-0 gap-5"
    >
      <Tabs.List
        activateOnFocus={false}
        aria-label="Artwork slot"
        className="flex gap-2 overflow-x-auto px-1 py-1"
      >
        {artworkSlots.map((slot) => (
          <Tabs.Tab
            key={slot}
            value={slot}
            type="button"
            data-focusable
            className={`${controlFocus} hover:bg-pc-subtle shrink-0 border-b-2 border-transparent px-3 py-2 text-sm font-semibold whitespace-nowrap text-pc-muted-foreground data-active:border-current data-active:text-pc-selection-foreground`}
          >
            {slotCopy[slot].label}
          </Tabs.Tab>
        ))}
      </Tabs.List>
      {artworkSlots.map((slot) => (
        <Tabs.Panel
          key={slot}
          value={slot}
          keepMounted
          className="min-w-0"
          hidden={selected !== slot}
          inert={selected !== slot}
        >
          {visited.includes(slot) && (
            <ArtworkSlotControl
              port={port}
              previewPort={previewPort?.id === port.id ? previewPort : port}
              slot={slot}
              Preview={Preview}
              previewActions={previewActions}
              isCurrentOpening={isCurrentOpening}
            />
          )}
        </Tabs.Panel>
      ))}
      <DetailArtwork port={port} />
    </Tabs.Root>
  );
}

type ArtworkReviewTarget = {
  portId: string;
  generation: number;
  revision: number;
};

type ArtworkVisibilityReview = ArtworkReviewTarget & { action: "hide" | "automatic" };

type BackgroundDraft = ArtworkReviewTarget & {
  originalSha256: string;
  image: string;
  framing: ArtworkFraming | null;
  source:
    | { kind: "selected" }
    | { kind: "local"; path: string }
    | {
        kind: "provider";
        gameId: number;
        candidate: SteamGridDbCandidate;
        trigger: HTMLButtonElement | null;
      };
};

function ArtworkSlotControl({
  port,
  previewPort,
  slot,
  Preview,
  previewActions,
  isCurrentOpening,
}: {
  port: BackgroundPreviewProps["port"];
  previewPort: BackgroundPreviewProps["port"];
  isCurrentOpening: () => boolean;
  slot: ArtworkSlot;
  Preview: ComponentType<BackgroundPreviewProps>;
  previewActions?: Partial<Record<BackgroundPreviewProps["layout"], string>> | undefined;
}) {
  const [findOpen, setFindOpen] = useState(false);
  const { t } = useAppTranslation("detail");
  const [draft, setDraft] = useState<BackgroundDraft>();
  const [visibilityReview, setVisibilityReview] = useState<ArtworkVisibilityReview>();
  const visibilityReviewId = useId();
  const visibilityHeading = useRef<HTMLHeadingElement>(null);
  const visibilityCancel = useRef<HTMLButtonElement>(null);
  const slotPanel = useRef<HTMLElement>(null);
  const refreshButton = useRef<HTMLButtonElement>(null);
  const frameButton = useRef<HTMLButtonElement>(null);
  const findButton = useRef<HTMLButtonElement>(null);
  const { cache, display } = useArtwork(port.id, slot);
  const collectionCovers = useCoverCollection(port.id);
  const collection = useCollectionCovers(slot === "cover" ? port.id : undefined, display, true);
  const [pending, setPending] = useState(false);
  const [message, setMessage] = useState<string>();
  const [error, setError] = useState<string>();
  const mounted = useRef(false);
  const busy = useRef(false);
  const pickerButton = useRef<HTMLButtonElement>(null);
  const resetButton = useRef<HTMLButtonElement>(null);
  const hideButton = useRef<HTMLButtonElement>(null);
  const returnFocus = useRef<{
    target: HTMLButtonElement | null;
    cache: typeof cache;
  } | null>(null);
  const currentIdentity = useRef({ cache, portId: port.id, slot });
  useLayoutEffect(() => {
    currentIdentity.current = { cache, portId: port.id, slot };
  }, [cache, port.id, slot]);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  useLayoutEffect(() => {
    if (visibilityReview) visibilityHeading.current?.focus();
  }, [visibilityReview]);
  useEffect(() => {
    if (pending || !returnFocus.current || !isCurrentOpening()) return;
    const { target, cache: owner } = returnFocus.current;
    returnFocus.current = null;
    const panel = slotPanel.current;
    if (!panel || currentIdentity.current.cache !== owner || panel.closest("[hidden], [inert]"))
      return;
    const focus =
      [target, pickerButton.current, refreshButton.current].find(
        (control) =>
          control?.isConnected && !control.disabled && !control.closest("[hidden], [inert]"),
      ) ?? panel.closest("dialog")?.querySelector<HTMLElement>("[data-artwork-editor-close]");
    focus?.focus();
  }, [draft, visibilityReview, pending, isCurrentOpening]);

  const stillInView = () =>
    mounted.current &&
    isCurrentOpening() &&
    currentIdentity.current.portId === port.id &&
    currentIdentity.current.slot === slot &&
    currentIdentity.current.cache?.generation === cache?.generation;
  const stillCurrent = () => stillInView() && currentIdentity.current.cache === cache;
  const refreshCurrent = async (committedRevision?: number) => {
    const current = currentIdentity.current.cache;
    if (!stillInView() || !current) return;
    await current.refreshAfterChange(
      port.id,
      slot,
      () => stillInView() && currentIdentity.current.cache === current,
      committedRevision,
    );
  };
  const focusDraftTrigger = (review: BackgroundDraft, cancelled = false) => {
    const target =
      review.source.kind === "selected"
        ? frameButton.current
        : review.source.kind === "provider"
          ? cancelled && review.source.trigger?.isConnected
            ? review.source.trigger
            : findButton.current
          : pickerButton.current;
    returnFocus.current = { target, cache };
  };
  const draftIsCurrent = (review: ArtworkReviewTarget) =>
    review.portId === port.id &&
    review.generation === cache?.generation &&
    review.revision === display.state?.choice.revision &&
    !display.stale;

  const stageBackground = (
    source: BackgroundDraft["source"],
    revision: number,
    preview: ArtworkSelectionPreview,
  ) => {
    if (!cache || !stillCurrent()) return;
    const choice = display.state?.choice;
    setDraft({
      portId: port.id,
      generation: cache.generation,
      revision,
      originalSha256: preview.original_sha256,
      image: `data:image/png;base64,${preview.png_base64}`,
      framing:
        choice && choice.asset_sha256 === preview.original_sha256 ? (choice.framing ?? null) : null,
      source,
    });
  };

  const finishChange = (target: HTMLButtonElement | null, restoreFocus = true, owner = cache) => {
    busy.current = false;
    if (!mounted.current) return;
    if (restoreFocus && stillInView() && currentIdentity.current.cache === owner)
      returnFocus.current = { target, cache: owner };
    setPending(false);
  };

  const chooseLocal = async () => {
    if (!cache || !display.state || busy.current) return;
    const revision = display.state.choice.revision;
    let changeRequested = false;
    let staged = false;
    let focusOwner = cache;
    busy.current = true;
    returnFocus.current = null;
    setPending(true);
    setMessage(undefined);
    setError(undefined);
    try {
      const path = await pickArtworkPath();
      if (!stillCurrent() || !path) return;
      if (slot === "detail") {
        const preview = await desktopApi.previewLocalBackground(port.id, path, cache.generation);
        if (!stillCurrent()) return;
        stageBackground({ kind: "local", path }, revision, preview);
        staged = true;
        return;
      }
      changeRequested = true;
      const result = await cache.change(port.id, slot, revision, path, stillCurrent);
      if (!result || !stillInView()) return;
      if (currentIdentity.current.cache !== cache) await refreshCurrent(result.choice.revision);
      if (!stillInView()) return;
      focusOwner = currentIdentity.current.cache ?? cache;
      setMessage("Local image selected.");
    } catch (value) {
      if (stillInView() && (changeRequested || stillCurrent())) {
        setError(errorText(value));
        await refreshCurrent();
      }
    } finally {
      finishChange(pickerButton.current, !staged, focusOwner);
    }
  };

  const visibilityTrigger = (action: ArtworkVisibilityReview["action"]) =>
    action === "hide" ? hideButton.current : resetButton.current;

  const stageVisibility = (action: ArtworkVisibilityReview["action"]) => {
    if (!canChange || !cache || !display.state || !stillCurrent() || busy.current) return;
    setError(undefined);
    setMessage(undefined);
    setVisibilityReview({
      action,
      portId: port.id,
      generation: cache.generation,
      revision: display.state.choice.revision,
    });
  };

  const applyVisibility = async (review: ArtworkVisibilityReview) => {
    if (!cache || busy.current || !stillCurrent() || !draftIsCurrent(review)) return;
    let focusOwner = cache;
    let focusTarget = visibilityCancel.current;
    busy.current = true;
    returnFocus.current = null;
    setPending(true);
    setError(undefined);
    try {
      const result =
        review.action === "hide"
          ? await cache.suppress(port.id, slot, review.revision, stillCurrent)
          : await cache.change(port.id, slot, review.revision, null, stillCurrent);
      if (!result || !stillInView()) return;
      if (currentIdentity.current.cache !== cache) await refreshCurrent(result.choice.revision);
      if (!stillInView()) return;
      focusOwner = currentIdentity.current.cache ?? cache;
      focusTarget = visibilityTrigger(review.action === "hide" ? "automatic" : "hide");
      setVisibilityReview(undefined);
      setMessage(
        review.action === "hide" ? "Artwork hidden for this port." : "Automatic artwork restored.",
      );
    } catch (value) {
      if (stillInView()) {
        setError(errorText(value));
        await refreshCurrent();
        focusOwner = currentIdentity.current.cache ?? cache;
      }
    } finally {
      finishChange(focusTarget, true, focusOwner);
    }
  };

  const chooseSteamGridDb = async (gameId: number, candidate: SteamGridDbCandidate) => {
    if (!cache || !display.state || busy.current) return;
    const revision = display.state.choice.revision;
    let staged = false;
    const trigger =
      document.activeElement instanceof HTMLButtonElement ? document.activeElement : null;
    busy.current = true;
    returnFocus.current = null;
    setPending(true);
    setMessage(undefined);
    setError(undefined);
    try {
      if (slot === "detail") {
        const preview = await desktopApi.previewSteamGridDbBackground(
          port.id,
          gameId,
          candidate.id,
          cache.generation,
        );
        if (!stillCurrent()) return;
        stageBackground({ kind: "provider", gameId, candidate, trigger }, revision, preview);
        staged = true;
        return;
      }
      const result = await cache.chooseSteamGridDb(
        port.id,
        slot,
        revision,
        gameId,
        candidate.id,
        stillCurrent,
      );
      if (result && stillInView()) {
        if (currentIdentity.current.cache !== cache) await refreshCurrent(result.choice.revision);
        if (!stillInView()) return;
        setFindOpen(false);
        setMessage(
          `SteamGridDB image chosen. Image by ${candidate.author.name}; Portcove keeps a local copy.`,
        );
      }
    } catch (value) {
      if (stillInView()) {
        setError(steamGridDbErrorText(value));
        await refreshCurrent();
      }
    } finally {
      finishChange(pickerButton.current, !staged);
    }
  };

  const editBackground = () => {
    if (!cache || !display.image || !display.state || !stillCurrent()) return;
    const choice = display.state.choice;
    if (!choice.asset_sha256 || display.state.resolved_source.kind !== "local_import") return;
    setError(undefined);
    setMessage(undefined);
    setDraft({
      portId: port.id,
      generation: cache.generation,
      revision: choice.revision,
      originalSha256: choice.asset_sha256,
      image: display.image,
      framing: choice.framing ?? null,
      source: { kind: "selected" },
    });
  };

  const applyBackground = async (review: BackgroundDraft, framing: ArtworkFraming | null) => {
    if (!cache || !stillCurrent() || !draftIsCurrent(review) || busy.current) return;
    busy.current = true;
    returnFocus.current = null;
    setPending(true);
    setError(undefined);
    try {
      const edit = { preview_sha256: review.originalSha256, framing };
      const source = review.source;
      const result =
        source.kind === "local"
          ? await cache.change(port.id, "detail", review.revision, source.path, stillCurrent, edit)
          : source.kind === "provider"
            ? await cache.chooseSteamGridDb(
                port.id,
                "detail",
                review.revision,
                source.gameId,
                source.candidate.id,
                stillCurrent,
                edit,
              )
            : await cache.setBackgroundFraming(port.id, review.revision, framing, stillCurrent);
      if (!result || !stillInView()) return;
      if (currentIdentity.current.cache !== cache) await refreshCurrent(result.choice.revision);
      if (!stillInView()) return;
      focusDraftTrigger(review);
      setDraft(undefined);
      setFindOpen(false);
      setMessage("Background saved.");
    } catch (value) {
      if (stillInView()) {
        setError(
          review.source.kind === "provider" ? steamGridDbErrorText(value) : errorText(value),
        );
        await refreshCurrent();
      }
    } finally {
      busy.current = false;
      if (mounted.current) setPending(false);
    }
  };

  const { label, description } = slotCopy[slot];
  const selection = display.state?.selection;
  const hidden = display.state?.choice.suppressed === true;
  const hasReview = Boolean(draft || visibilityReview);
  const canChange = !pending && !hasReview && Boolean(display.state) && !display.stale;
  const notWide =
    (slot === "detail" || slot === "landscape") &&
    selection != null &&
    selection.width <= selection.height;
  return (
    <section
      ref={slotPanel}
      className="artwork-slot min-w-0 rounded-pc-md border border-[var(--color-border)] p-4"
      aria-label={label}
      aria-busy={pending}
    >
      <h3 className="m-0">{label}</h3>
      <p>{description}</p>
      {hidden && (
        <p className="artwork-notice text-[length:var(--text-sm)] text-[var(--color-text-muted)]">
          Hidden for this port. Use automatic to show the default again.
        </p>
      )}
      {slot === "logo" && display.image && (
        <div className="bg-pc-subtle my-4 grid min-h-20 place-items-center rounded-pc-sm p-3">
          <img
            key={display.image}
            src={display.image}
            alt="Selected logo preview"
            className="max-h-28 max-w-full object-contain"
            onError={() => display.onImageError?.()}
          />
        </div>
      )}
      {notWide && (
        <p className="artwork-notice text-[length:var(--text-sm)] text-[var(--color-text-muted)]">
          This image is not wider than tall, so it is not offered where a wide image is needed, such
          as Steam.
        </p>
      )}
      <div className="artwork-actions flex flex-wrap gap-3">
        <Button
          ref={pickerButton}
          data-focusable
          variant="outline"
          disabled={!canChange}
          onClick={() => void chooseLocal()}
        >
          Choose local image
        </Button>
        <Button
          ref={resetButton}
          data-focusable
          variant="outline"
          disabled={!canChange || usesAutomaticArtwork(display.state)}
          onClick={() => stageVisibility("automatic")}
        >
          Use automatic
        </Button>
        <Button
          ref={hideButton}
          data-focusable
          variant="outline"
          disabled={!canChange || hidden}
          onClick={() => stageVisibility("hide")}
        >
          Hide artwork
        </Button>
        <Button
          ref={findButton}
          data-focusable
          variant="outline"
          aria-expanded={findOpen && !hasReview}
          disabled={!canChange}
          onClick={() => setFindOpen((open) => !open)}
        >
          Find on SteamGridDB
        </Button>
        {slot === "detail" &&
          display.state?.resolved_source.kind === "local_import" &&
          display.image && (
            <Button
              ref={frameButton}
              data-focusable
              variant="outline"
              disabled={!canChange}
              onClick={editBackground}
            >
              Adjust framing
            </Button>
          )}
        <Button
          ref={refreshButton}
          data-focusable
          variant="outline"
          disabled={pending || hasReview || display.loading}
          onClick={() => {
            void cache?.load(port.id, slot, true);
          }}
        >
          Refresh artwork
        </Button>
      </div>
      {visibilityReview && (
        <form
          aria-labelledby={visibilityReviewId}
          className="mt-4 grid gap-3 border-t border-pc-border pt-4"
          onSubmit={(event) => {
            event.preventDefault();
            void applyVisibility(visibilityReview);
          }}
        >
          <h4
            id={visibilityReviewId}
            ref={visibilityHeading}
            tabIndex={-1}
            className="m-0 font-semibold"
          >
            {t("artwork.reviewChange")}
          </h4>
          <p className="m-0">
            {t(
              visibilityReview.action === "hide" ? "artwork.reviewHide" : "artwork.reviewAutomatic",
            )}
          </p>
          {!draftIsCurrent(visibilityReview) && (
            <p role="status" className="m-0 text-pc-warning-foreground">
              {t("artwork.reviewStale")}
            </p>
          )}
          <div className="flex flex-wrap gap-2">
            <Button
              type="submit"
              data-focusable
              variant="primary"
              disabled={pending || !draftIsCurrent(visibilityReview)}
            >
              {t("artwork.apply")}
            </Button>
            <Button
              ref={visibilityCancel}
              type="button"
              data-focusable
              variant="outline"
              disabled={pending}
              onClick={() => {
                returnFocus.current = { target: visibilityTrigger(visibilityReview.action), cache };
                setVisibilityReview(undefined);
                setError(undefined);
              }}
            >
              {t("artwork.cancel")}
            </Button>
          </div>
        </form>
      )}
      {draft && (
        <BackgroundFramingEditor
          image={draft.image}
          port={previewPort}
          Preview={Preview}
          previewActions={previewActions}
          sourceLabel={
            draft.source.kind === "provider"
              ? `SteamGridDB image by ${draft.source.candidate.author.name}`
              : undefined
          }
          initialFraming={draft.framing}
          pending={pending}
          stale={!draftIsCurrent(draft)}
          onApply={(framing) => void applyBackground(draft, framing)}
          onCancel={() => {
            focusDraftTrigger(draft, true);
            setError(undefined);
            setDraft(undefined);
          }}
        />
      )}
      {findOpen && (
        <div hidden={hasReview} inert={hasReview}>
          <SteamGridDbPicker
            slot={slot}
            initialTerm={port.name ?? ""}
            disabled={pending || !display.state || Boolean(display.stale)}
            selectionPending={pending}
            choose={(gameId, candidate) => void chooseSteamGridDb(gameId, candidate)}
          />
        </div>
      )}
      <p className="artwork-notice text-[length:var(--text-sm)] text-[var(--color-text-muted)]">
        Static PNG or JPEG, up to 16 MiB. Portcove keeps a local copy.
      </p>
      {display.state?.reason && (
        <p className="artwork-notice text-[length:var(--text-sm)] text-[var(--color-text-muted)]">
          {display.state.reason}
        </p>
      )}
      <p role="status">
        {pending ? "Updating artwork…" : (message ?? (display.loading ? "Loading artwork…" : ""))}
      </p>
      {display.stale && (
        <p role="status">Showing previously loaded artwork. Refresh to check the current choice.</p>
      )}
      {(error || display.error) && <p role="alert">{error ?? display.error}</p>}
      <details className="artwork-source">
        <summary className="disclosure-pad-3 cursor-pointer" data-focusable>
          View source / author information
        </summary>
        <ArtworkSource
          state={display.state}
          collectionCovers={slot === "cover" ? collectionCovers : undefined}
          renderedSource={
            collection.some((member) => member.image)
              ? "igdb_cover_collection"
              : display.image
                ? display.state?.resolved_source.kind
                : "generated_fallback"
          }
        />
      </details>
    </section>
  );
}

/**
 * Recorded evidence with its dates. `evicted` says whether Portcove removed its
 * copy of the selected image.
 */
export function listingEvidenceText(
  evidence: ArtworkState["provider_listing"][number],
  evicted: boolean,
): string {
  const at = (seconds: number) => new Date(seconds * 1000).toLocaleString();
  const checked = at(evidence.last_checked_at);
  const since = evidence.not_listed_since === null ? undefined : at(evidence.not_listed_since);
  if (evidence.withdrawn_at !== null && evidence.withdrawn_at !== undefined)
    return evicted
      ? `Removed from SteamGridDB (confirmed ${at(evidence.withdrawn_at)}). Portcove removed its copy; the credit is kept.`
      : `Removed from SteamGridDB (confirmed ${at(evidence.withdrawn_at)}). Portcove kept its copy, because you imported this image yourself or another credit still lists it.`;
  if (evidence.last_result.status === "listed")
    return evicted
      ? `Listed again when last checked (${checked}). Choose it again to restore Portcove's copy.`
      : `Listed when last checked (${checked}).`;
  const next =
    "If SteamGridDB's image server reports it gone, or a check at least a day later still finds it missing, Portcove removes its copy unless you imported this image yourself. Your choice and the credit are kept.";
  if (evidence.last_result.status === "not_listed")
    return `Not in SteamGridDB's list when last checked (${checked}). First noticed ${since ?? checked}. ${next}`;
  return since
    ? `Not confirmed when last checked (${checked}). First noticed missing ${since}. ${next}`
    : `Not confirmed when last checked (${checked}).`;
}

export function ArtworkSource({
  state,
  renderedSource,
  collectionCovers,
}: {
  state?: ArtworkState | undefined;
  renderedSource:
    | "local_import"
    | "igdb_cover"
    | "igdb_cover_collection"
    | "generated_fallback"
    | undefined;
  collectionCovers?: readonly IgdbArtwork[] | undefined;
}) {
  if (state?.choice.suppressed) return <p>Artwork is hidden for this port.</p>;
  if (collectionCovers?.length && usesAutomaticArtwork(state)) {
    return (
      <dl>
        <dt>Source</dt>
        <dd>IGDB covers of games represented by this project.</dd>
        {collectionCovers.map((cover) => (
          <div key={cover.image_sha256}>
            <dt>
              <ExternalLink href={`https://www.igdb.com/games/${cover.game_slug}`}>
                IGDB game {cover.game_id}
              </ExternalLink>
            </dt>
            <dd>
              Cover {cover.cover_id} · image {cover.image_id}
            </dd>
          </div>
        ))}
        {renderedSource === "generated_fallback" && (
          <>
            <dt>Displayed artwork</dt>
            <dd>Fallback artwork while collection images are unavailable.</dd>
          </>
        )}
        <dt>Author and license</dt>
        <dd>See each linked source.</dd>
      </dl>
    );
  }
  if (state?.resolved_source.kind === "igdb_cover") {
    const mapping = state.resolved_source.artwork;
    return (
      <dl>
        <dt>Source</dt>
        <dd>
          <ExternalLink href={`https://www.igdb.com/games/${mapping.game_slug}`}>
            IGDB game and cover
          </ExternalLink>
          {mapping.match_kind === "underlying-game" ? " · underlying game" : " · port"}
        </dd>
        <dt>IGDB IDs</dt>
        <dd>
          Game {mapping.game_id} · cover {mapping.cover_id} · image {mapping.image_id}
        </dd>
        <dt>Author and license</dt>
        <dd>Not provided with this catalog mapping; see the linked source.</dd>
        {renderedSource === "generated_fallback" && (
          <>
            <dt>Displayed artwork</dt>
            <dd>Generated fallback; the IGDB cover is unavailable.</dd>
          </>
        )}
      </dl>
    );
  }
  const asset = state?.selection;
  if (!asset)
    return state ? (
      <FallbackSource state={state} />
    ) : (
      <p>Artwork information is unavailable. Refresh to try again.</p>
    );
  const credits = state.attribution;
  if (credits.length > 0)
    return (
      <dl>
        <dt>Source</dt>
        <dd>
          {credits.map((credit) => (
            <span key={`${credit.provider}:${credit.asset_id}`} className="block">
              <ExternalLink
                href={`https://www.steamgriddb.com/${credit.role === "logo" ? "logo" : credit.role === "hero_banner" ? "hero" : "grid"}/${credit.asset_id}`}
              >
                SteamGridDB image {credit.asset_id}
              </ExternalLink>{" "}
              by {credit.author_name}
            </span>
          ))}
        </dd>
        {state.provider_listing.length > 0 && (
          <>
            <dt>SteamGridDB listing</dt>
            <dd>
              {state.provider_listing.map((evidence) => (
                <span key={`${evidence.provider}:${evidence.asset_id}`} className="block">
                  {listingEvidenceText(evidence, state.evicted_at !== null)}
                </span>
              ))}
            </dd>
          </>
        )}
        <dt>Image</dt>
        <dd>
          {asset.width} × {asset.height} · {asset.format.toUpperCase()} ·{" "}
          {formatBytes(asset.byte_size)} ·{" "}
          {state.evicted_at === null ? "local copy" : "copy removed"}
        </dd>
        <dt>Chosen</dt>
        <dd>{new Date((credits[0]?.fetched_at ?? asset.imported_at) * 1000).toLocaleString()}</dd>
        <dt>Author and license</dt>
        <dd>
          Made by the credited SteamGridDB artist. Use it under SteamGridDB's terms; Portcove does
          not grant permission to share it.
        </dd>
        {renderedSource === "generated_fallback" && (
          <>
            <dt>Displayed artwork</dt>
            <dd>Generated fallback; the chosen image is not currently rendered.</dd>
          </>
        )}
      </dl>
    );
  return (
    <dl>
      <dt>Source</dt>
      <dd>Local import: {asset.original_name}</dd>
      <dt>Image</dt>
      <dd>
        {asset.width} × {asset.height} · {asset.format.toUpperCase()} ·{" "}
        {formatBytes(asset.byte_size)}
      </dd>
      <dt>Imported</dt>
      <dd>{new Date(asset.imported_at * 1000).toLocaleString()}</dd>
      <dt>Author and license</dt>
      <dd>Not provided with this local image.</dd>
      {renderedSource === "generated_fallback" && (
        <>
          <dt>Displayed artwork</dt>
          <dd>Generated fallback; the selected local image is not currently rendered.</dd>
          <dt>Fallback identity</dt>
          <dd>{state.generated_fallback.identity}</dd>
        </>
      )}
    </dl>
  );
}

function FallbackSource({ state }: { state: ArtworkState }) {
  return (
    <dl>
      <dt>Source</dt>
      <dd>Generated by Portcove; no external image asset is used.</dd>
      <dt>Style</dt>
      <dd>Fallback style {state.generated_fallback.style_version}</dd>
      <dt>Identity</dt>
      <dd>{state.generated_fallback.identity}</dd>
    </dl>
  );
}
