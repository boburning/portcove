import { useEffect, useRef, useState } from "react";
import { useArtwork, useArtworkVisibility } from "../artwork";
import { pickArtworkPath } from "../file-picker";
import type { ArtworkSlot, ArtworkState, PortDefinition } from "../types";
import { errorText, formatBytes } from "../view-model";

export function ArtworkImage({ port, slot = "cover", className = "" }: { port: Pick<PortDefinition, "id" | "name">; slot?: ArtworkSlot; className?: string }) {
  const { element, visible } = useArtworkVisibility();
  const { display } = useArtwork(port.id, slot, visible);
  const [failedImage, setFailedImage] = useState<string>();
  const image = display.image !== failedImage ? display.image : undefined;
  return <div ref={element} className={`artwork-image ${className}`} aria-hidden="true">
    {image ? <img src={image} alt="" decoding="async" onError={() => setFailedImage(image)} /> : <span>{port.name.slice(0, 2).toUpperCase()}</span>}
  </div>;
}

export function DetailArtwork({ port }: { port: PortDefinition }) {
  const { display } = useArtwork(port.id, "detail");
  if (!display.state?.selection) return null;
  return <div className="detail-artwork"><ArtworkImage port={port} slot="detail" className="wide-artwork" />
    {(display.state.reason || display.error) && <p className="artwork-notice">{display.state.reason ?? "The selected image cannot be displayed. Your choice is retained."}</p>}
  </div>;
}

export function ArtworkControls({ port }: { port: PortDefinition }) {
  const [open, setOpen] = useState(false);
  return <details className="artwork-controls" onToggle={event => setOpen(event.currentTarget.open)}>
    <summary data-focusable>Change artwork</summary>
    {open && <div className="artwork-slots">
      <ArtworkSlotControl key={`${port.id}:cover`} port={port} slot="cover" />
      <ArtworkSlotControl key={`${port.id}:detail`} port={port} slot="detail" />
    </div>}
  </details>;
}

function ArtworkSlotControl({ port, slot }: { port: PortDefinition; slot: ArtworkSlot }) {
  const { cache, display } = useArtwork(port.id, slot);
  const [pending, setPending] = useState(false);
  const [message, setMessage] = useState<string>();
  const [error, setError] = useState<string>();
  const mounted = useRef(false);
  const busy = useRef(false);
  const pickerButton = useRef<HTMLButtonElement>(null);
  const resetButton = useRef<HTMLButtonElement>(null);
  const identity = `${cache?.generation}:${port.id}:${slot}`;
  const currentIdentity = useRef(identity);
  currentIdentity.current = identity;
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);

  const change = async (pick: boolean) => {
    if (!cache || !display.state || busy.current) return;
    const revision = display.state.choice.revision;
    const stillCurrent = () => mounted.current && currentIdentity.current === identity;
    busy.current = true; setPending(true); setMessage(undefined); setError(undefined);
    try {
      const path = pick ? await pickArtworkPath() : null;
      if (!stillCurrent() || (pick && !path)) return;
      const result = await cache.change(port.id, slot, revision, path, stillCurrent);
      if (stillCurrent() && result) setMessage(pick ? "Local image selected." : "Default artwork restored. The imported image remains in your library.");
    } catch (value) {
      if (stillCurrent()) { setError(errorText(value)); void cache.load(port.id, slot, true); }
    } finally {
      busy.current = false;
      if (stillCurrent()) {
        setPending(false);
        // Return focus after React reenables the invoking control.
        requestAnimationFrame(() => { if (stillCurrent()) (pick ? pickerButton : resetButton).current?.focus(); });
      }
    }
  };

  const label = slot === "cover" ? "Cover image" : "Detail image";
  return <section className="artwork-slot" aria-label={label} aria-busy={pending}>
    <h3>{label}</h3>
    <p>{slot === "cover" ? "Portrait cover · other shapes are letterboxed." : "Optional wide image for this game's details."}</p>
    <div className="artwork-actions">
      <button ref={pickerButton} data-focusable disabled={pending || !display.state} onClick={() => void change(true)}>Choose local image</button>
      <button ref={resetButton} data-focusable disabled={pending || !display.state?.selection} onClick={() => void change(false)}>Reset to default</button>
      <button data-focusable disabled={pending || display.loading} onClick={() => { void cache?.load(port.id, slot, true); }}>Refresh artwork</button>
    </div>
    <p className="artwork-notice">Static PNG or JPEG, up to 16 MiB. Portcove keeps a local copy.</p>
    {display.state?.reason && <p className="artwork-notice">{display.state.reason}</p>}
    <p role="status">{pending ? "Updating artwork…" : message ?? (display.loading ? "Loading artwork…" : "")}</p>
    {(error || display.error) && <p role="alert">{error ?? display.error}</p>}
    <details className="artwork-source"><summary data-focusable>View source / author information</summary><ArtworkSource state={display.state} /></details>
  </section>;
}

function ArtworkSource({ state }: { state?: ArtworkState }) {
  const asset = state?.selection;
  if (!asset) return <p>{state ? "Default fallback. No local image is selected." : "Artwork information is unavailable. Refresh to try again."}</p>;
  return <dl>
    <dt>Source</dt><dd>Local import: {asset.original_name}</dd>
    <dt>Image</dt><dd>{asset.width} × {asset.height} · {asset.format.toUpperCase()} · {formatBytes(asset.byte_size)}</dd>
    <dt>Imported</dt><dd>{new Date(asset.imported_at * 1000).toLocaleString()}</dd>
    <dt>Author and license</dt><dd>Not provided with this local image.</dd>
  </dl>;
}
