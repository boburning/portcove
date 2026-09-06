import { useEffect, useRef, useState, type RefObject } from "react";
import { AlertTriangle, FolderOpen, HardDrive, RotateCcw, ShieldCheck } from "lucide-react";
import { desktopApi } from "../api";
import { pickGameOutputFolder } from "../file-picker";
import type { OutputDestinationPreview, PortOutputLocation } from "../types";
import { errorText, formatBytes } from "../view-model";
import { Icon } from "./ui";

export function OutputLocationControl({ portId, generation, busy, onChanged, onApplying }: {
  portId: string;
  generation: number;
  busy?: string;
  onChanged?: () => void;
  onApplying?: (applying: boolean) => void;
}) {
  const [location, setLocation] = useState<PortOutputLocation>();
  const [draft, setDraft] = useState("");
  const [preview, setPreview] = useState<OutputDestinationPreview>();
  const [error, setError] = useState<string>();
  const [pending, setPending] = useState<"load" | "pick" | "review" | "apply">();
  const request = useRef(0);
  const applying = useRef(false);
  const reviewButton = useRef<HTMLButtonElement>(null);
  const resetButton = useRef<HTMLButtonElement>(null);
  const applyButton = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    const currentRequest = ++request.current;
    setLocation(undefined);
    setPreview(undefined);
    setError(undefined);
    setPending("load");
    void desktopApi.outputLocation(portId, generation).then(result => {
      if (request.current !== currentRequest) return;
      setLocation(result);
      setDraft(result.configured_output_directory ?? result.effective_output_directory);
      setPending(undefined);
    }).catch(value => {
      if (request.current !== currentRequest) return;
      setError(errorText(value));
      setPending(undefined);
    });
    return () => {
      request.current += 1;
      if (applying.current) {
        applying.current = false;
        onApplying?.(false);
      }
    };
  }, [generation, portId]);

  useEffect(() => {
    if (preview) applyButton.current?.focus();
  }, [preview]);

  const invalidate = (path: string) => {
    request.current += 1;
    setDraft(path);
    setPreview(undefined);
    setError(undefined);
    setPending(undefined);
  };

  const pick = async () => {
    const currentRequest = ++request.current;
    setPending("pick");
    setError(undefined);
    try {
      const path = await pickGameOutputFolder(draft);
      if (request.current !== currentRequest) return;
      setPending(undefined);
      if (path) invalidate(path);
    } catch (value) {
      if (request.current !== currentRequest) return;
      setPending(undefined);
      setError(errorText(value));
    }
  };

  const review = async (path: string | null) => {
    const selectedPath = path?.trim() ?? null;
    if (path !== null && !selectedPath) {
      setError("Choose an absolute Export / install folder before reviewing the change.");
      return;
    }
    const currentRequest = ++request.current;
    setPreview(undefined);
    setError(undefined);
    setPending("review");
    try {
      const result = await desktopApi.previewOutputLocation(portId, selectedPath, generation);
      if (request.current !== currentRequest) return;
      setPreview(result);
      setPending(undefined);
    } catch (value) {
      if (request.current !== currentRequest) return;
      setPending(undefined);
      setError(errorText(value));
    }
  };

  const apply = async () => {
    if (!preview) return;
    const reviewed = preview;
    const currentRequest = ++request.current;
    setPending("apply");
    setError(undefined);
    applying.current = true;
    onApplying?.(true);
    try {
      const result = reviewed.reset_to_default
        ? await desktopApi.resetOutputLocation(portId, reviewed.preview_sha256, generation)
        : await desktopApi.setOutputLocation(portId, reviewed.proposed.effective_output_directory, reviewed.preview_sha256, generation);
      if (request.current !== currentRequest) return;
      setLocation(result);
      setDraft(result.configured_output_directory ?? result.effective_output_directory);
      setPreview(undefined);
      setPending(undefined);
      applying.current = false;
      onApplying?.(false);
      onChanged?.();
    } catch (value) {
      if (request.current !== currentRequest) return;
      setPending(undefined);
      setPreview(undefined);
      applying.current = false;
      onApplying?.(false);
      setError(`${errorText(value)} Review the current destination again.`);
      window.requestAnimationFrame(() => reviewButton.current?.focus());
    }
  };

  const cancelReview = () => {
    const reset = preview?.reset_to_default;
    request.current += 1;
    setPreview(undefined);
    setError(undefined);
    setPending(undefined);
    window.requestAnimationFrame(() => (reset ? resetButton : reviewButton).current?.focus());
  };

  const controlsDisabled = Boolean(busy) || pending === "load" || pending === "pick" || pending === "apply";
  const source = location?.selection_source === "port_setting" ? "Custom for this game" : "Inherited from the Portcove library";
  return <section className="output-location-control" data-focus-group aria-labelledby={`output-location-${portId}`}>
    <div className="output-location-heading">
      <div><p className="eyebrow">STORAGE LOCATION</p><h3 id={`output-location-${portId}`}><Icon glyph={HardDrive} />Export / install folder</h3></div>
      <span className={`output-location-source ${location?.selection_source === "port_setting" ? "custom" : "inherited"}`}>{source}</span>
    </div>
    <code title={location?.effective_output_directory}>{location?.effective_output_directory ?? "Loading current folder…"}</code>
    <p>Changing this folder affects future installs for this game only. Existing versions stay where Portcove recorded them; relocation is a separate reviewed action.</p>
    <label htmlFor={`output-location-path-${portId}`}>Future Export / install folder</label>
    <div className="path-entry">
      <input id={`output-location-path-${portId}`} data-focusable value={draft} disabled={!location || controlsDisabled} onChange={event => invalidate(event.target.value)} aria-describedby={`output-location-note-${portId}`} />
      <button data-focusable className="button-with-icon" type="button" disabled={!location || controlsDisabled || pending === "review"} onClick={() => { void pick(); }}><Icon glyph={FolderOpen} />Browse</button>
    </div>
    <small id={`output-location-note-${portId}`}>Review checks the resolved path, volume, capacity, ownership, markers, and affected installs without creating the folder.</small>
    <div className="button-row">
      <button ref={reviewButton} data-focusable className="small-control" disabled={!location || controlsDisabled || !draft.trim()} onClick={() => { void review(draft); }}>{pending === "review" ? "Checking folder…" : "Review future folder"}</button>
      {location?.configured_output_directory && <button ref={resetButton} data-focusable className="small-control button-with-icon" disabled={controlsDisabled || pending === "review"} onClick={() => { void review(null); }}><Icon glyph={RotateCcw} />Review library default</button>}
    </div>
    {preview && <OutputLocationReview preview={preview} pending={pending === "apply"} applyButton={applyButton} apply={() => { void apply(); }} cancel={cancelReview} />}
    {error && <p className="output-location-error" role="alert"><Icon glyph={AlertTriangle} size="sm" />{error}</p>}
  </section>;
}

function OutputLocationReview({ preview, pending, applyButton, apply, cancel }: {
  preview: OutputDestinationPreview;
  pending: boolean;
  applyButton: RefObject<HTMLButtonElement | null>;
  apply: () => void;
  cancel: () => void;
}) {
  const safe = preview.availability === "available" && preview.validation_errors.length === 0
    && !["owned_by_another_port", "unrelated_content", "invalid", "unknown"].includes(preview.ownership);
  const availability = preview.availability === "full" ? "Full · no free space" : preview.availability === "unavailable" ? "Unavailable" : "Available";
  const capacity = preview.available_bytes == null
    ? "Capacity unavailable"
    : preview.total_bytes == null
      ? `${formatBytes(preview.available_bytes)} available`
      : `${formatBytes(preview.available_bytes)} available of ${formatBytes(preview.total_bytes)}`;
  const ownership = outputOwnershipLabel(preview.ownership);
  const action = preview.reset_to_default ? "Use library default for future installs" : "Use this folder for future installs";
  return <div className={`output-location-review ${safe ? "safe" : "blocked"}`} role="group" aria-label="Output destination review">
    <div className="output-review-title" aria-live="polite"><strong>{preview.reset_to_default ? "Review library default" : "Review future folder"}</strong><span>{availability}</span></div>
    <code title={preview.proposed.effective_output_directory}>{preview.proposed.effective_output_directory}</code>
    <dl>
      <div><dt>Source</dt><dd>{outputSourceLabel(preview.proposed.selection_source)}</dd></div>
      <div><dt>Capacity</dt><dd>{capacity}</dd></div>
      <div><dt>Ownership</dt><dd>{ownership}</dd></div>
      <div><dt>Existing installs</dt><dd>{preview.affected_installs.length === 0 ? "None" : `${preview.affected_installs.length} remain at their recorded locations`}</dd></div>
    </dl>
    <p><Icon glyph={ShieldCheck} size="sm" />Future placement only; this review does not move an existing installation.</p>
    {preview.validation_errors.length > 0 && <ul className="output-validation-errors" aria-label="Destination problems">{preview.validation_errors.map(message => <li key={message}>{message}</li>)}</ul>}
    <div className="button-row">
      <button ref={applyButton} data-focusable data-autofocus className="small-control" disabled={!safe || pending} onClick={apply}>{pending ? "Saving…" : action}</button>
      <button data-focusable className="small-control" disabled={pending} onClick={cancel}>Cancel review</button>
    </div>
  </div>;
}

function outputOwnershipLabel(value: OutputDestinationPreview["ownership"]) {
  const labels: Record<OutputDestinationPreview["ownership"], string> = {
    library_default: "Portcove library default",
    unclaimed: "Empty or not yet created",
    owned_by_port: "Owned by this game",
    owned_by_another_port: "Owned by another game",
    unrelated_content: "Contains unrelated content",
    invalid: "Invalid destination",
    unknown: "Unknown",
  };
  return labels[value];
}

function outputSourceLabel(value: OutputDestinationPreview["proposed"]["selection_source"]) {
  if (value === "request_override") return "Selected for this game";
  if (value === "port_setting") return "Custom for this game";
  return "Inherited from library";
}
