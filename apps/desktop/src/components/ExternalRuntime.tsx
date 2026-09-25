import { FolderOpen } from "lucide-react";
import { useState } from "react";
import { desktopApi } from "../api";
import { pickInstallFolder } from "../file-picker";
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

export function ExternalRuntimeControl({
  port,
  status,
  generation,
  busy,
  onChanged,
}: {
  port: PortDefinition;
  status?: PortStatus;
  generation: number;
  busy: boolean;
  onChanged?: () => void;
}) {
  const [review, setReview] = useState<{ kind: "register"; path: string } | { kind: "remove" }>();
  if (port.release.provider !== "user-prepared" && !status?.external_runtime) return null;
  const registered = status?.external_runtime;
  const registration = status?.port_actions?.find(
    (action) => action.action === "register_external",
  );
  const canRegister =
    !registration ||
    (registration.availability === "waiting" && registration.reason === "review_required");
  const registrationReason = registration?.definition?.reason ?? registration?.reason;
  const select = async () => {
    const path = await pickInstallFolder("");
    if (typeof path === "string") setReview({ kind: "register", path });
  };
  return (
    <>
      {registered ? (
        <div>
          <p>
            Version {registered.version} is registered at <code>{registered.path}</code>. Portcove
            launches it without owning or managing the external files.
          </p>
          <Button
            data-focusable
            variant="outline"
            disabled={busy}
            onClick={() => setReview({ kind: "remove" })}
          >
            Remove registration
          </Button>
        </div>
      ) : (
        <div>
          <p>
            Prepare the accepted runtime yourself, then choose its extracted folder. Portcove checks
            its exact files before registration and every launch. The folder and game-owned data
            stay yours.
          </p>
          {port.presentation?.manual_preparation && <p>{port.presentation.manual_preparation}</p>}
          <ul>
            {Object.entries(port.release.user_prepared).map(([platform, required]) => (
              <li key={platform}>
                {platform}: {required.archive_name} version {required.version}; archive SHA-256{" "}
                <code>{required.archive_sha256}</code>. Choose the folder containing{" "}
                <code>{required.executable}</code> after your own preparation.
              </li>
            ))}
          </ul>
          {!canRegister && registrationReason && (
            <p role="status">
              Registration {registration?.availability.replaceAll("_", " ")}:{" "}
              {registrationReason.replaceAll("_", " ")}.
            </p>
          )}
          <Button
            data-focusable
            variant="primary"
            disabled={busy || !canRegister}
            onClick={() => void select()}
          >
            <Icon glyph={FolderOpen} />
            Choose existing runtime
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
  onChanged?: () => void;
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
    failureMessage: "Registration did not complete. Review the current runtime before retrying.",
  });
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) dismiss();
      }}
    >
      <DialogContent showCloseButton={false} aria-describedby="external-register-description">
        <DialogTitle>Register {port.name} runtime?</DialogTitle>
        <DialogDescription id="external-register-description">
          Portcove will save this location and launch only the accepted runtime. It will not copy,
          replace, clean up, back up, or delete the external folder.
        </DialogDescription>
        {pending === "review" && <p role="status">Checking runtime files…</p>}
        {preview && (
          <div className="metadata" aria-label="External runtime review">
            <span>
              <small>Version</small>
              {preview.version}
            </span>
            <span>
              <small>Folder</small>
              {preview.path}
            </span>
            <span>
              <small>Executable</small>
              {preview.executable}
            </span>
            <span>
              <small>Checked files</small>
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
              {pending === "apply" ? "Registering…" : "Register runtime"}
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
  onChanged?: () => void;
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
    failureMessage: "Registration removal did not complete. Review it again before retrying.",
  });
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) dismiss();
      }}
    >
      <DialogContent showCloseButton={false} aria-describedby="external-remove-description">
        <DialogTitle>Remove {port.name} registration?</DialogTitle>
        <DialogDescription id="external-remove-description">
          This removes only Portcove's saved reference. Every external game, setting, and save file
          remains in place.
        </DialogDescription>
        {pending === "review" && <p role="status">Checking registration…</p>}
        {preview && (
          <p>
            External folder preserved: <code>{preview.path}</code>
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
              {pending === "apply" ? "Removing…" : "Remove registration"}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
