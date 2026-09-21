import { useState } from "react";
import { desktopApi } from "../api";
import type { PortDefinition, SourceRecord, SourceRemovalPreview } from "../types";
import { useActionReview } from "../use-action-review";
import { Button } from "./ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogTitle } from "./ui/dialog";

export function SourceRemovalControl({
  source,
  generation,
  ports,
  disabled,
  onRemoved,
}: {
  source: SourceRecord;
  generation: number;
  ports: PortDefinition[];
  disabled: boolean;
  onRemoved?: () => Promise<unknown>;
}) {
  const [open, setOpen] = useState(false);
  const [refreshError, setRefreshError] = useState(false);
  const completed = async () => {
    try {
      await onRemoved?.();
      setRefreshError(false);
    } catch {
      setRefreshError(true);
    }
  };
  return (
    <>
      <Button
        data-focusable
        variant="destructive"
        size="sm"
        disabled={disabled}
        onClick={() => setOpen(true)}
      >
        Remove reference
      </Button>
      {refreshError && (
        <div>
          <p role="status">
            The reference was removed. Refresh the list to see the current sources.
          </p>
          <Button
            data-focusable
            variant="outline"
            size="sm"
            onClick={() => {
              void completed();
            }}
          >
            Refresh source list
          </Button>
        </div>
      )}
      {open && (
        <SourceRemovalDialog
          profileId={source.profile_id}
          generation={generation}
          ports={ports}
          close={() => setOpen(false)}
          onRemoved={completed}
        />
      )}
    </>
  );
}

export function SourceRemovalDialog({
  profileId,
  generation,
  ports,
  close,
  onRemoved,
}: {
  profileId: string;
  generation: number;
  ports: PortDefinition[];
  close: () => void;
  onRemoved: () => Promise<unknown>;
}) {
  const { preview, pending, error, review, execute, dismiss } = useActionReview({
    identity: `${profileId}:${generation}`,
    load: () => desktopApi.previewSourceRemoval(profileId, generation),
    apply: async (preview) => {
      const result = await desktopApi.removeSource(profileId, preview.preview_sha256, generation);
      if (result === null) return "cancelled";
      await onRemoved();
      return true;
    },
    close,
    failureMessage:
      "The reference was not removed. Review the current source and affected games before trying again.",
  });
  return (
    <Dialog
      open
      onOpenChange={(nextOpen) => {
        if (!nextOpen) dismiss();
      }}
    >
      <DialogContent
        showCloseButton={false}
        className="max-h-[calc(100dvh-var(--space-8))] w-[min(680px,90vw)] max-w-none gap-0 overflow-y-auto overscroll-contain p-8 [scroll-padding-block:var(--space-4)] sm:max-w-none"
        aria-describedby="source-removal-description"
      >
        <DialogTitle id="source-removal-title" className="mb-2 text-xl">
          Review source-reference removal
        </DialogTitle>
        <DialogDescription id="source-removal-description" className="mb-4 leading-relaxed">
          Remove Portcove's saved reference to these game files. The files themselves will stay
          where they are.
        </DialogDescription>
        {pending === "review" && <p role="status">Checking the source and affected games…</p>}
        {preview && <SourceRemovalDetails preview={preview} ports={ports} />}
        {error && <p role="alert">{error}</p>}
        <DialogFooter className="mt-4">
          <Button
            data-autofocus
            data-focusable
            variant="outline"
            disabled={pending === "apply"}
            onClick={dismiss}
          >
            Keep source reference
          </Button>
          {!preview && (
            <Button
              data-focusable
              disabled={Boolean(pending)}
              onClick={() => {
                void review();
              }}
            >
              Review source removal again
            </Button>
          )}
          {preview && (
            <Button
              data-focusable
              variant="destructive"
              disabled={Boolean(pending)}
              onClick={() => {
                void execute();
              }}
            >
              {pending === "apply"
                ? "Waiting for source removal…"
                : "Continue to removal confirmation"}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function SourceRemovalDetails({
  preview,
  ports,
}: {
  preview: SourceRemovalPreview;
  ports: PortDefinition[];
}) {
  const name = (id: string) => ports.find((port) => port.id === id)?.name ?? id;
  return (
    <section className="source-removal-details" aria-label="Affected games and preserved files">
      <p>
        <strong>Reference to remove:</strong> {preview.source.profile_id}
      </p>
      <p>{preview.source.path}</p>
      <p>
        The registered file or folder, its contents, installed game versions, saves, backups and
        other source references are preserved. Only this library's reference is removed.
      </p>
      <h3>Installed games affected</h3>
      {preview.installed_dependent_port_ids.length ? (
        <ul>
          {preview.installed_dependent_port_ids.map((id) => (
            <li key={id}>{name(id)}</li>
          ))}
        </ul>
      ) : (
        <p>No installed game currently depends on this reference.</p>
      )}
      <p>Actions that need these original files may require registering them again.</p>
      <details>
        <summary>All catalog games using this source ({preview.dependent_port_ids.length})</summary>
        <ul>
          {preview.dependent_port_ids.map((id) => (
            <li key={id}>{name(id)}</li>
          ))}
        </ul>
      </details>
      <p>
        To use these files again, add them and pass the current source checks. There is no one-click
        undo or automatic re-registration.
      </p>
      <p>
        If interrupted, reopen Settings and check whether the reference remains before trying again.
        Removing a reference never schedules deletion of the original files.
      </p>
    </section>
  );
}
