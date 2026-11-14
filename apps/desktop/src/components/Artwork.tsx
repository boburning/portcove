import { cn } from "cn";
import styles from "./Artwork.module.css";
import { useEffect, useLayoutEffect, useRef, useState, type RefObject } from "react";
import { Gamepad2 } from "lucide-react";
import { useArtwork, useArtworkVisibility } from "../artwork";
import { pickArtworkPath } from "../file-picker";
import type { ArtworkSlot, ArtworkState, PortDefinition } from "../types";
import { errorText, formatBytes } from "../view-model";
import { Button } from "./ui/button";
import { ExternalLink } from "./ExternalLink";
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
  identityArtwork = false,
  quietFallback = false,
}: {
  element: RefObject<HTMLDivElement | null>;
  display: ReturnType<typeof useArtwork>["display"];
  className?: string;
  identityArtwork?: boolean;
  quietFallback?: boolean;
}) {
  const image = display.image;
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
      data-artwork-source={image ? display.state?.resolved_source.kind : "generated_fallback"}
      aria-hidden="true"
    >
      {image ? (
        <img
          className={styles.asset}
          src={image}
          alt=""
          decoding="async"
          onError={display.onImageError}
        />
      ) : identityArtwork || quietFallback ? (
        <span className="grid max-w-full justify-items-center gap-2 p-2 text-pc-muted-foreground">
          <Gamepad2 aria-hidden="true" className="size-6 max-w-full" />
        </span>
      ) : (
        <span className={styles.initials}>{fallback?.initials ?? "PC"}</span>
      )}
      {image && (
        <span
          className={styles.backdrop}
          style={{ backgroundImage: `url(${JSON.stringify(image)})` }}
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
  detail: { label: "Detail image", description: "Optional wide image for this game's details." },
  landscape: {
    label: "Landscape image",
    description:
      "Optional wide cover. Steam uses it for the game's library capsule. Separate from the detail image.",
  },
};

export function ArtworkControls({
  port,
}: {
  port: Pick<PortDefinition, "id"> & { name?: string };
}) {
  const [open, setOpen] = useState(false);
  return (
    <details className="artwork-controls" onToggle={(event) => setOpen(event.currentTarget.open)}>
      <summary className="cursor-pointer py-3" data-focusable>
        Change artwork
      </summary>
      {open && (
        <div className="artwork-slots grid gap-5">
          <ArtworkSlotControl key={`${port.id}:cover`} port={port} slot="cover" />
          <ArtworkSlotControl key={`${port.id}:detail`} port={port} slot="detail" />
          <ArtworkSlotControl key={`${port.id}:landscape`} port={port} slot="landscape" />
          <DetailArtwork port={port} />
        </div>
      )}
    </details>
  );
}

function ArtworkSlotControl({
  port,
  slot,
}: {
  port: Pick<PortDefinition, "id"> & { name?: string };
  slot: ArtworkSlot;
}) {
  const [findOpen, setFindOpen] = useState(false);
  const { cache, display } = useArtwork(port.id, slot);
  const [pending, setPending] = useState(false);
  const [message, setMessage] = useState<string>();
  const [error, setError] = useState<string>();
  const mounted = useRef(false);
  const busy = useRef(false);
  const pickerButton = useRef<HTMLButtonElement>(null);
  const resetButton = useRef<HTMLButtonElement>(null);
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
  useEffect(() => {
    if (pending || !returnFocus.current) return;
    const { target, cache: owner } = returnFocus.current;
    returnFocus.current = null;
    if (currentIdentity.current.cache === owner)
      (target?.disabled ? pickerButton.current : target)?.focus();
  }, [pending]);

  const stillInView = () =>
    mounted.current &&
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
  const finishChange = (pick: boolean) => {
    busy.current = false;
    if (!mounted.current) return;
    if (stillCurrent())
      returnFocus.current = { target: (pick ? pickerButton : resetButton).current, cache };
    setPending(false);
  };

  const change = async (pick: boolean) => {
    if (!cache || !display.state || busy.current) return;
    const revision = display.state.choice.revision;
    let changeRequested = false;
    busy.current = true;
    returnFocus.current = null;
    setPending(true);
    setMessage(undefined);
    setError(undefined);
    try {
      const path = pick ? await pickArtworkPath() : null;
      if (!stillCurrent() || (pick && !path)) return;
      changeRequested = true;
      const result = await cache.change(port.id, slot, revision, path, stillCurrent);
      if (result && stillInView()) {
        if (currentIdentity.current.cache !== cache) await refreshCurrent(result.choice.revision);
        if (!stillInView()) return;
        setMessage(
          pick
            ? "Local image selected."
            : "Default artwork restored. The imported image remains in your library.",
        );
      }
    } catch (value) {
      if (stillInView() && (changeRequested || stillCurrent())) {
        setError(errorText(value));
        await refreshCurrent();
      }
    } finally {
      finishChange(pick);
    }
  };

  const chooseSteamGridDb = async (gameId: number, candidate: SteamGridDbCandidate) => {
    if (!cache || !display.state || busy.current) return;
    const revision = display.state.choice.revision;
    busy.current = true;
    returnFocus.current = null;
    setPending(true);
    setMessage(undefined);
    setError(undefined);
    try {
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
      finishChange(true);
    }
  };

  const { label, description } = slotCopy[slot];
  const selection = display.state?.selection;
  const notWide =
    slot !== "cover" && selection !== null && selection !== undefined
      ? selection.width <= selection.height
      : false;
  return (
    <section
      className="artwork-slot min-w-0 rounded-pc-md border border-[var(--color-border)] p-4"
      aria-label={label}
      aria-busy={pending}
    >
      <h3 className="m-0">{label}</h3>
      <p>{description}</p>
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
          disabled={pending || !display.state || display.stale}
          onClick={() => void change(true)}
        >
          Choose local image
        </Button>
        <Button
          ref={resetButton}
          data-focusable
          variant="outline"
          disabled={pending || !display.state?.selection || display.stale}
          onClick={() => void change(false)}
        >
          Reset to default
        </Button>
        <Button
          data-focusable
          variant="outline"
          aria-expanded={findOpen}
          disabled={pending || !display.state || display.stale}
          onClick={() => setFindOpen((open) => !open)}
        >
          Find on SteamGridDB
        </Button>
        <Button
          data-focusable
          variant="outline"
          disabled={pending || display.loading}
          onClick={() => {
            void cache?.load(port.id, slot, true);
          }}
        >
          Refresh artwork
        </Button>
      </div>
      {findOpen && (
        <SteamGridDbPicker
          slot={slot}
          initialTerm={port.name ?? ""}
          disabled={pending || !display.state || Boolean(display.stale)}
          choose={(gameId, candidate) => void chooseSteamGridDb(gameId, candidate)}
        />
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
        <summary className="cursor-pointer py-3" data-focusable>
          View source / author information
        </summary>
        <ArtworkSource
          state={display.state}
          renderedSource={
            display.image ? display.state?.resolved_source.kind : "generated_fallback"
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
}: {
  state?: ArtworkState | undefined;
  renderedSource: "local_import" | "igdb_cover" | "generated_fallback" | undefined;
}) {
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
                href={`https://www.steamgriddb.com/${credit.role === "hero_banner" ? "hero" : "grid"}/${credit.asset_id}`}
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
