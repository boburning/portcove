import { useEffect, useRef, useState, type RefObject } from "react";
import {
  AlertTriangle,
  FolderOpen,
  HardDrive,
  RotateCcw,
  ShieldCheck,
} from "lucide-react";
import { desktopApi } from "../api";
import { pickGameOutputFolder } from "../file-picker";
import type {
  OutputDestinationPreview,
  OutputRelocationPlan,
  OutputRelocationResult,
  OutputRelocationStatus,
  PortOutputLocation,
} from "../types";
import { errorText, formatBytes, formatCountMessage } from "../view-model";
import { Icon } from "./ui";

export function OutputLocationControl({
  portId,
  generation,
  busy,
  onChanged,
  onApplying,
}: {
  portId: string;
  generation: number;
  busy?: string;
  onChanged?: () => void;
  onApplying?: (applying: boolean) => void;
}) {
  const [location, setLocation] = useState<PortOutputLocation>();
  const [draft, setDraft] = useState("");
  const [preview, setPreview] = useState<OutputDestinationPreview>();
  const [relocation, setRelocation] = useState<OutputRelocationPlan>();
  const [relocationStatus, setRelocationStatus] =
    useState<OutputRelocationStatus>();
  const [relocationResult, setRelocationResult] =
    useState<OutputRelocationResult>();
  const [error, setError] = useState<string>();
  const [pending, setPending] = useState<
    "load" | "pick" | "review" | "apply"
  >();
  const request = useRef(0);
  const applying = useRef(false);
  const reviewButton = useRef<HTMLButtonElement>(null);
  const resetButton = useRef<HTMLButtonElement>(null);
  const applyButton = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    const currentRequest = ++request.current;
    setLocation(undefined);
    setPreview(undefined);
    setRelocation(undefined);
    setRelocationResult(undefined);
    setRelocationStatus(undefined);
    setError(undefined);
    setPending("load");
    void Promise.all([
      desktopApi.outputLocation(portId, generation),
      desktopApi.outputRelocationStatus(portId, generation),
    ])
      .then(([result, status]) => {
        if (request.current !== currentRequest) return;
        setLocation(result);
        setRelocationStatus(status ?? undefined);
        setDraft(
          result.configured_output_directory ??
            result.effective_output_directory,
        );
        setPending(undefined);
      })
      .catch((value) => {
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
  }, [generation, onApplying, portId]);

  useEffect(() => {
    if (preview || relocation) applyButton.current?.focus();
  }, [preview, relocation]);

  const invalidate = (path: string) => {
    request.current += 1;
    setDraft(path);
    setPreview(undefined);
    setRelocation(undefined);
    setRelocationResult(undefined);
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
      setError(
        "Choose an absolute Export / install folder before reviewing the change.",
      );
      return;
    }
    const currentRequest = ++request.current;
    setPreview(undefined);
    setRelocation(undefined);
    setError(undefined);
    setPending("review");
    try {
      const result = await desktopApi.previewOutputLocation(
        portId,
        selectedPath,
        generation,
      );
      if (request.current !== currentRequest) return;
      setPreview(result);
      setPending(undefined);
    } catch (value) {
      if (request.current !== currentRequest) return;
      setPending(undefined);
      setError(errorText(value));
    }
  };

  const reviewRelocation = async () => {
    if (!preview) return;
    const reviewedDestination = preview.proposed.effective_output_directory;
    const currentRequest = ++request.current;
    setPending("review");
    setError(undefined);
    try {
      const result = await desktopApi.planOutputRelocation(
        portId,
        reviewedDestination,
        generation,
      );
      if (request.current !== currentRequest) return;
      setRelocation(result);
      setPending(undefined);
    } catch (value) {
      if (request.current !== currentRequest) return;
      setPending(undefined);
      setPreview(undefined);
      setError(`${errorText(value)} Review the current destination again.`);
    }
  };

  const applyRelocation = async () => {
    if (!relocation) return;
    const reviewed = relocation;
    const currentRequest = ++request.current;
    setPending("apply");
    setError(undefined);
    applying.current = true;
    onApplying?.(true);
    try {
      const result = await desktopApi.relocateOutput(
        portId,
        reviewed.destination_root,
        reviewed.plan_sha256,
        generation,
      );
      if (request.current !== currentRequest) return;
      setLocation(result.output_location);
      setDraft(
        result.output_location.configured_output_directory ??
          result.output_location.effective_output_directory,
      );
      setRelocationResult(result);
      setRelocationStatus(undefined);
      setRelocation(undefined);
      setPreview(undefined);
      setPending(undefined);
      applying.current = false;
      onApplying?.(false);
      onChanged?.();
    } catch (value) {
      if (request.current !== currentRequest) return;
      setPending(undefined);
      setRelocation(undefined);
      setPreview(undefined);
      applying.current = false;
      onApplying?.(false);
      setError(`${errorText(value)} Review the current destination again.`);
      window.requestAnimationFrame(() => reviewButton.current?.focus());
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
        ? await desktopApi.resetOutputLocation(
            portId,
            reviewed.preview_sha256,
            generation,
          )
        : await desktopApi.setOutputLocation(
            portId,
            reviewed.proposed.effective_output_directory,
            reviewed.preview_sha256,
            generation,
          );
      if (request.current !== currentRequest) return;
      setLocation(result);
      setDraft(
        result.configured_output_directory ?? result.effective_output_directory,
      );
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
    setRelocation(undefined);
    setError(undefined);
    setPending(undefined);
    window.requestAnimationFrame(() =>
      (reset ? resetButton : reviewButton).current?.focus(),
    );
  };

  const controlsDisabled =
    Boolean(busy) ||
    pending === "load" ||
    pending === "pick" ||
    pending === "apply";
  const source = location
    ? outputSourceLabel(location.selection_source)
    : "Location not loaded";
  return (
    <section
      className="output-location-control"
      data-focus-group
      aria-labelledby={`output-location-${portId}`}
    >
      <div className="output-location-heading">
        <div>
          <p className="eyebrow">STORAGE LOCATION</p>
          <h3 id={`output-location-${portId}`}>
            <Icon glyph={HardDrive} />
            Export / install folder
          </h3>
        </div>
        <span
          className={`output-location-source ${location?.selection_source === "port_setting" ? "custom" : "inherited"}`}
        >
          {source}
        </span>
      </div>
      <code title={location?.effective_output_directory}>
        {location?.effective_output_directory ?? "Loading current folder…"}
      </code>
      <p>
        Changing this folder affects future installs for this game only.
        Existing versions stay where Portcove recorded them; relocation is a
        separate reviewed action.
      </p>
      <label htmlFor={`output-location-path-${portId}`}>
        Future Export / install folder
      </label>
      <div className="path-entry">
        <input
          id={`output-location-path-${portId}`}
          data-focusable
          value={draft}
          disabled={!location || controlsDisabled}
          onChange={(event) => invalidate(event.target.value)}
          aria-describedby={`output-location-note-${portId}`}
        />
        <button
          data-focusable
          className="button-with-icon"
          type="button"
          disabled={!location || controlsDisabled || pending === "review"}
          onClick={() => {
            void pick();
          }}
        >
          <Icon glyph={FolderOpen} />
          Browse
        </button>
      </div>
      <small id={`output-location-note-${portId}`}>
        Review checks the resolved path, volume, capacity, ownership, markers,
        and affected installs without creating the folder.
      </small>
      <div className="button-row">
        <button
          ref={reviewButton}
          data-focusable
          className="small-control"
          disabled={!location || controlsDisabled || !draft.trim()}
          onClick={() => {
            void review(draft);
          }}
        >
          {pending === "review" ? "Checking folder…" : "Review future folder"}
        </button>
        {location?.configured_output_directory && (
          <button
            ref={resetButton}
            data-focusable
            className="small-control button-with-icon"
            disabled={controlsDisabled || pending === "review"}
            onClick={() => {
              void review(null);
            }}
          >
            <Icon glyph={RotateCcw} />
            Review library default
          </button>
        )}
      </div>
      {preview && (
        <OutputLocationReview
          preview={preview}
          relocation={relocation}
          pending={pending}
          applyButton={applyButton}
          apply={() => {
            void apply();
          }}
          reviewRelocation={() => {
            void reviewRelocation();
          }}
          applyRelocation={() => {
            void applyRelocation();
          }}
          cancel={cancelReview}
        />
      )}
      {relocationResult && (
        <p className="output-location-success" role="status">
          <Icon glyph={ShieldCheck} size="sm" />
          {relocationResult.cleanup_pending
            ? formatCountMessage(
                relocationResult.old_paths_retained.length,
                retainedFolderMessages,
              )
            : formatCountMessage(
                relocationResult.relocated_installs.length,
                movedVersionMessages,
              )}
        </p>
      )}
      {relocationStatus && (
        <p className="output-location-error" role="status">
          <Icon glyph={AlertTriangle} size="sm" />
          {formatCountMessage(
            relocationStatus.cleanup_pending_paths.length,
            pendingCleanupMessages,
          )}
        </p>
      )}
      {error && (
        <p className="output-location-error" role="alert">
          <Icon glyph={AlertTriangle} size="sm" />
          {error}
        </p>
      )}
    </section>
  );
}

const retainedFolderMessages = {
  zero: "Move completed. Cleanup remains pending.",
  one: "Move completed. {count} old folder contains changed files and remains for safe cleanup.",
  other:
    "Move completed. {count} old folders contain changed files and remain for safe cleanup.",
  unknown:
    "Move completed. The number of old folders needing cleanup is unavailable.",
};
const movedVersionMessages = {
  zero: "Move completed. No recorded versions needed relocation.",
  one: "Moved {count} recorded version and verified the new location.",
  other: "Moved {count} recorded versions and verified the new location.",
  unknown: "Move completed. The number of relocated versions is unavailable.",
};
const pendingCleanupMessages = {
  zero: "Relocation cleanup is pending. Portcove will retry only when the reviewed contents are unchanged.",
  one: "Relocation cleanup is pending for {count} old folder. Portcove will retry only when its reviewed contents are unchanged.",
  other:
    "Relocation cleanup is pending for {count} old folders. Portcove will retry only when their reviewed contents are unchanged.",
  unknown:
    "Relocation cleanup is pending. The number of old folders is unavailable. Portcove will retry only when the reviewed contents are unchanged.",
};

function OutputLocationReview({
  preview,
  relocation,
  pending,
  applyButton,
  apply,
  reviewRelocation,
  applyRelocation,
  cancel,
}: {
  preview: OutputDestinationPreview;
  relocation?: OutputRelocationPlan;
  pending?: "load" | "pick" | "review" | "apply";
  applyButton: RefObject<HTMLButtonElement | null>;
  apply: () => void;
  reviewRelocation: () => void;
  applyRelocation: () => void;
  cancel: () => void;
}) {
  const safe =
    preview.availability === "available" &&
    preview.validation_errors.length === 0 &&
    ["library_default", "unclaimed", "owned_by_port"].includes(
      preview.ownership,
    );
  const availabilityLabels = {
    full: "Full · no free space",
    available: "Available",
    unavailable: "Unavailable",
  };
  const availability = Object.hasOwn(availabilityLabels, preview.availability)
    ? availabilityLabels[preview.availability]
    : "Availability result unavailable";
  const capacity =
    preview.available_bytes == null
      ? "Capacity unavailable"
      : preview.total_bytes == null
        ? `${formatBytes(preview.available_bytes)} available`
        : `${formatBytes(preview.available_bytes)} available of ${formatBytes(preview.total_bytes)}`;
  const ownership = outputOwnershipLabel(preview.ownership);
  const action = preview.reset_to_default
    ? "Use library default for future installs"
    : "Use this folder for future installs";
  if (relocation)
    return (
      <OutputRelocationReview
        plan={relocation}
        pending={pending === "apply"}
        applyButton={applyButton}
        apply={applyRelocation}
        cancel={cancel}
      />
    );
  return (
    <div
      className={`output-location-review ${safe ? "safe" : "blocked"}`}
      role="group"
      aria-label="Output destination review"
    >
      <div className="output-review-title" aria-live="polite">
        <strong>
          {preview.reset_to_default
            ? "Review library default"
            : "Review future folder"}
        </strong>
        <span>{availability}</span>
      </div>
      <code title={preview.proposed.effective_output_directory}>
        {preview.proposed.effective_output_directory}
      </code>
      <dl>
        <div>
          <dt>Source</dt>
          <dd>{outputSourceLabel(preview.proposed.selection_source)}</dd>
        </div>
        <div>
          <dt>Capacity</dt>
          <dd>{capacity}</dd>
        </div>
        <div>
          <dt>Ownership</dt>
          <dd>{ownership}</dd>
        </div>
        <div>
          <dt>Existing installs</dt>
          <dd>
            {preview.affected_installs.length === 0
              ? "None"
              : `${preview.affected_installs.length} remain at their recorded locations`}
          </dd>
        </div>
      </dl>
      <p>
        <Icon glyph={ShieldCheck} size="sm" />
        Future placement only; this review does not move an existing
        installation.
      </p>
      {preview.validation_errors.length > 0 && (
        <ul
          className="output-validation-errors"
          aria-label="Destination problems"
        >
          {preview.validation_errors.map((message) => (
            <li key={message}>{message}</li>
          ))}
        </ul>
      )}
      <div className="button-row">
        <button
          ref={applyButton}
          data-focusable
          data-autofocus
          className="small-control"
          disabled={!safe || Boolean(pending)}
          onClick={apply}
        >
          {pending === "apply" ? "Saving…" : action}
        </button>
        {preview.affected_installs.length > 0 && (
          <button
            data-focusable
            className="small-control"
            disabled={!safe || Boolean(pending)}
            onClick={reviewRelocation}
          >
            {pending === "review"
              ? "Checking versions…"
              : "Review moving existing versions"}
          </button>
        )}
        <button
          data-focusable
          className="small-control"
          disabled={Boolean(pending)}
          onClick={cancel}
        >
          Cancel review
        </button>
      </div>
    </div>
  );
}

function OutputRelocationReview({
  plan,
  pending,
  applyButton,
  apply,
  cancel,
}: {
  plan: OutputRelocationPlan;
  pending: boolean;
  applyButton: RefObject<HTMLButtonElement | null>;
  apply: () => void;
  cancel: () => void;
}) {
  const safe =
    plan.availability === "available" &&
    plan.validation_errors.length === 0 &&
    ["library_default", "unclaimed", "owned_by_port"].includes(
      plan.ownership,
    ) &&
    !plan.sources_will_move &&
    !plan.user_data_will_move &&
    !plan.backups_will_move;
  return (
    <div
      className={`output-location-review ${safe ? "safe" : "blocked"}`}
      role="group"
      aria-label="Existing version relocation review"
    >
      <div className="output-review-title" aria-live="polite">
        <strong>Review moving existing versions</strong>
        <span>
          {plan.installs.length} version{plan.installs.length === 1 ? "" : "s"}
        </span>
      </div>
      <code title={plan.destination_root}>{plan.destination_root}</code>
      <dl>
        <div>
          <dt>Copy required</dt>
          <dd>{formatBytes(plan.required_bytes)}</dd>
        </div>
        <div>
          <dt>Capacity</dt>
          <dd>
            {plan.available_bytes == null
              ? "Capacity unavailable"
              : `${formatBytes(plan.available_bytes)} available`}
          </dd>
        </div>
        <div>
          <dt>Ownership</dt>
          <dd>{outputOwnershipLabel(plan.ownership)}</dd>
        </div>
        <div>
          <dt>Sources</dt>
          <dd>
            {plan.sources_will_move
              ? "Unexpected move requested"
              : "Stay in the central source library"}
          </dd>
        </div>
        <div>
          <dt>Saves and backups</dt>
          <dd>
            {plan.user_data_will_move || plan.backups_will_move
              ? "Unexpected move requested"
              : "Stay in their current folders"}
          </dd>
        </div>
      </dl>
      <ul className="output-relocation-installs" aria-label="Versions to move">
        {plan.installs.map((item) => (
          <li key={item.install.id}>
            <strong>{item.install.version}</strong>
            <span>
              {[
                item.active && "active",
                item.previous && "previous",
                item.staged && "staged",
                item.retained && "retained",
              ]
                .filter(Boolean)
                .join(" · ")}
            </span>
            <code title={item.install.path}>{item.install.path}</code>
          </li>
        ))}
      </ul>
      <p>
        <Icon glyph={ShieldCheck} size="sm" />
        Portcove copies and verifies every recorded version before atomically
        changing its records. Old folders are removed only when their reviewed
        contents are unchanged.
      </p>
      {plan.validation_errors.length > 0 && (
        <ul
          className="output-validation-errors"
          aria-label="Relocation problems"
        >
          {plan.validation_errors.map((message) => (
            <li key={message}>{message}</li>
          ))}
        </ul>
      )}
      <div className="button-row">
        <button
          ref={applyButton}
          data-focusable
          data-autofocus
          className="small-control"
          disabled={!safe || pending}
          onClick={apply}
        >
          {pending ? "Moving and verifying…" : "Move existing versions"}
        </button>
        <button
          data-focusable
          className="small-control"
          disabled={pending}
          onClick={cancel}
        >
          Cancel review
        </button>
      </div>
    </div>
  );
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
  return Object.hasOwn(labels, value)
    ? labels[value]
    : "Ownership result unavailable";
}

function outputSourceLabel(
  value: OutputDestinationPreview["proposed"]["selection_source"],
) {
  if (value === "request_override") return "Selected for this game";
  if (value === "port_setting") return "Custom for this game";
  return value === "library_default"
    ? "Inherited from the Portcove library"
    : "Location origin unavailable";
}
