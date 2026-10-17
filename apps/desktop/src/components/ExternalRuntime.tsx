import { FolderOpen } from "lucide-react";
import { useLayoutEffect, useRef, useState } from "react";
import { desktopApi } from "../api";
import {
  catalogSetupPresentation,
  removalReviewPresentation,
} from "../features/port-actions/port-action-presentation";
import { pickInstallFolder } from "../file-picker";
import { LatestRequestGeneration } from "../shared/concurrency-state";
import type { PortDefinition, PortStatus } from "../types";
import { useActionReview } from "../use-action-review";
import { Icon } from "./ui";
import { Button } from "./ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogTitle } from "./ui/dialog";

function ReviewCancelButton({ pending, dismiss }: { pending: boolean; dismiss: () => void }) {
  return (
    <Button data-autofocus data-focusable variant="outline" disabled={pending} onClick={dismiss}>
      Cancel
    </Button>
  );
}

type ExternalRuntimeControlProps = {
  port: PortDefinition;
  status?: PortStatus | undefined;
  generation: number;
  busy: boolean;
  onChanged?: (() => void) | undefined;
};

export function ExternalRuntimeControl(props: ExternalRuntimeControlProps) {
  return (
    <ExternalRuntimeContext
      key={JSON.stringify([props.port.id, props.generation, props.status?.external_runtime?.id])}
      {...props}
    />
  );
}

function ExternalPreparationRequirements({ port }: { port: PortDefinition }) {
  return (
    <>
      <p>
        Prepare the required version, then choose the folder containing the game. Portcove checks
        the required files before using the folder and at every launch. It does not copy, update,
        back up, or delete these files.
      </p>
      {port.presentation?.manual_preparation && <p>{port.presentation.manual_preparation}</p>}
      <ul>
        {Object.entries(port.release.user_prepared).map(([platform, required]) => (
          <li key={platform}>
            {platform}: Prepare {required.archive_name} version {required.version}, then choose the
            folder containing <code>{required.executable}</code>.{" "}
            <details>
              <summary>File details</summary>Archive SHA-256: <code>{required.archive_sha256}</code>
            </details>
          </li>
        ))}
      </ul>
    </>
  );
}

function ExternalRuntimeContext({
  port,
  status,
  generation,
  busy,
  onChanged,
}: ExternalRuntimeControlProps) {
  const [review, setReview] = useState<{ kind: "register"; path: string } | { kind: "remove" }>();
  const pickerRequests = useRef(new LatestRequestGeneration());
  useLayoutEffect(() => {
    const requests = pickerRequests.current;
    return () => {
      requests.begin();
    };
  }, []);
  if (port.release.provider !== "user-prepared" && !status?.external_runtime) return null;
  const registered = status?.external_runtime;
  const removal = removalReviewPresentation(status, "remove_external");
  const registration = catalogSetupPresentation(status).routes.find(
    (action) => action.action === "register_external",
  );
  // Earlier status contracts omitted this projection or serialized an empty list.
  // A missing whole status or a partial current projection is not that legacy case.
  const legacyStatus =
    status !== undefined &&
    (status.port_actions === undefined ||
      (Array.isArray(status.port_actions) && status.port_actions.length === 0));
  const canRegister = legacyStatus || registration?.availability === "waiting";
  const select = async () => {
    const request = pickerRequests.current.begin();
    const path = await pickInstallFolder("");
    if (pickerRequests.current.isCurrent(request) && typeof path === "string")
      setReview({ kind: "register", path });
  };
  return (
    <>
      {registered ? (
        <div>
          <p>
            Portcove uses version {registered.version} in place at <code>{registered.path}</code>.
            It does not copy, update, back up, or delete these files.
          </p>
          <Button
            data-focusable
            variant="outline"
            disabled={busy || removal.blocked}
            onClick={() => setReview({ kind: "remove" })}
          >
            Stop using this installation
          </Button>
          {removal.blocked && <p role="status">{removal.reason}</p>}
        </div>
      ) : (
        <div>
          <ExternalPreparationRequirements port={port} />
          {!canRegister && <p role="status">{registration?.reason}</p>}
          <Button
            data-focusable
            variant="primary"
            disabled={busy || !canRegister}
            onClick={() => void select()}
          >
            <Icon glyph={FolderOpen} />
            Choose game folder
          </Button>
        </div>
      )}
      {review?.kind === "register" && (
        <RegisterExternalDialog
          key={`${port.id}:${review.path}:${generation}`}
          port={port}
          path={review.path}
          generation={generation}
          close={() => setReview(undefined)}
          onChanged={onChanged}
        />
      )}
      {review?.kind === "remove" && (
        <RemoveExternalDialog
          key={`${port.id}:${registered?.id}:${generation}`}
          port={port}
          generation={generation}
          close={() => setReview(undefined)}
          onChanged={onChanged}
        />
      )}
    </>
  );
}

function RegisterExternalDialog({
  port,
  path,
  generation,
  close,
  onChanged,
}: {
  port: PortDefinition;
  path: string;
  generation: number;
  close: () => void;
  onChanged?: (() => void) | undefined;
}) {
  const { preview, pending, error, review, execute, dismiss } = useActionReview({
    identity: `${port.id}:${path}:${generation}`,
    load: () => desktopApi.previewExternalRuntime(port.id, path, generation),
    apply: async (preview) => {
      const record = await desktopApi.registerExternalRuntime(
        port.id,
        path,
        preview.preview_sha256,
        generation,
      );
      if (record) onChanged?.();
      return record ? true : "cancelled";
    },
    close,
    failureMessage:
      "Portcove couldn't use this installation. Check the folder before trying again.",
  });
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) dismiss();
      }}
    >
      <DialogContent showCloseButton={false} aria-describedby="external-register-description">
        <DialogTitle>Use this {port.name} installation?</DialogTitle>
        <DialogDescription id="external-register-description">
          Portcove will save this location and check the required files before each launch. It will
          not copy, update, back up, or delete the external folder.
        </DialogDescription>
        {pending === "review" && <p role="status">Checking runtime files…</p>}
        {preview && (
          <div
            className="metadata grid grid-cols-[1fr_1fr] gap-[10px]"
            aria-label="External runtime review"
          >
            <span className="min-w-0 rounded-pc-md bg-[var(--color-bg-subtle)] p-[12px] text-[length:var(--text-xs)] [overflow-wrap:anywhere] text-[var(--color-text-secondary)]">
              <small className="mb-[5px] block text-[var(--color-text-muted)]">Version</small>
              {preview.version}
            </span>
            <span className="min-w-0 rounded-pc-md bg-[var(--color-bg-subtle)] p-[12px] text-[length:var(--text-xs)] [overflow-wrap:anywhere] text-[var(--color-text-secondary)]">
              <small className="mb-[5px] block text-[var(--color-text-muted)]">Folder</small>
              {preview.path}
            </span>
            <span className="min-w-0 rounded-pc-md bg-[var(--color-bg-subtle)] p-[12px] text-[length:var(--text-xs)] [overflow-wrap:anywhere] text-[var(--color-text-secondary)]">
              <small className="mb-[5px] block text-[var(--color-text-muted)]">Executable</small>
              {preview.executable}
            </span>
            <span className="min-w-0 rounded-pc-md bg-[var(--color-bg-subtle)] p-[12px] text-[length:var(--text-xs)] [overflow-wrap:anywhere] text-[var(--color-text-secondary)]">
              <small className="mb-[5px] block text-[var(--color-text-muted)]">Checked files</small>
              {preview.immutable_file_count}
            </span>
          </div>
        )}
        {error && <p role="alert">{error}</p>}
        <DialogFooter>
          <ReviewCancelButton pending={pending === "apply"} dismiss={dismiss} />
          {!preview && (
            <Button data-focusable disabled={Boolean(pending)} onClick={() => void review()}>
              Check again
            </Button>
          )}
          {preview && (
            <Button data-focusable disabled={Boolean(pending)} onClick={() => void execute()}>
              {pending === "apply" ? "Saving location…" : "Use this installation"}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function RemoveExternalDialog({
  port,
  generation,
  close,
  onChanged,
}: {
  port: PortDefinition;
  generation: number;
  close: () => void;
  onChanged?: (() => void) | undefined;
}) {
  const { preview, pending, error, review, execute, dismiss } = useActionReview({
    identity: `${port.id}:${generation}`,
    load: () => desktopApi.previewExternalRemoval(port.id, generation),
    apply: async (preview) => {
      const record = await desktopApi.removeExternalRuntime(
        port.id,
        preview.preview_sha256,
        generation,
      );
      if (record) onChanged?.();
      return record ? true : "cancelled";
    },
    close,
    failureMessage:
      "Portcove couldn't stop using this installation. Check its current state before trying again.",
  });
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) dismiss();
      }}
    >
      <DialogContent showCloseButton={false} aria-describedby="external-remove-description">
        <DialogTitle>Stop using this {port.name} installation?</DialogTitle>
        <DialogDescription id="external-remove-description">
          This removes only Portcove's saved location. The files stay where they are, including
          settings and saves.
        </DialogDescription>
        {pending === "review" && <p role="status">Checking saved location…</p>}
        {preview && (
          <p>
            Files will stay in: <code>{preview.path}</code>
          </p>
        )}
        {error && <p role="alert">{error}</p>}
        <DialogFooter>
          <ReviewCancelButton pending={pending === "apply"} dismiss={dismiss} />
          {!preview && (
            <Button data-focusable disabled={Boolean(pending)} onClick={() => void review()}>
              Check again
            </Button>
          )}
          {preview && (
            <Button
              data-focusable
              variant="destructive"
              disabled={Boolean(pending) || !preview.external_files_will_be_preserved}
              onClick={() => void execute()}
            >
              {pending === "apply" ? "Removing saved location…" : "Stop using this installation"}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
