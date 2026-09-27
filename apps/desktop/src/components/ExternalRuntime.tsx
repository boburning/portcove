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

function externalSetupReason(availability?: string, reason?: string, definitionReason?: string) {
  if (availability === "not_offered" && reason === "unsupported_platform")
    return "This installation route is unavailable on this platform.";
  if (reason === "definition_ineligible") {
    const reasons: Record<string, string> = {
      publisher_revoked: "The catalog publisher was revoked.",
      unknown_safety_semantics:
        "This definition has safety requirements Portcove cannot interpret.",
      publisher_scope_required: "This publisher is not approved for this port.",
      engine_capability_required: "This version of Portcove cannot use this route.",
      ownership_migration_required: "An existing installation needs ownership review.",
      metadata_replay: "The catalog update is older than the accepted version.",
      refresh_incomplete: "The catalog update did not finish.",
      metadata_stale: "The catalog information needs refreshing.",
      recorded_identity_changed: "The accepted file identity changed.",
      authenticated_integrity_required: "The required file integrity evidence is missing.",
      local_integrity_failed: "A required local file check failed.",
      mandatory_check_failed: "A required check failed.",
      source_identity_mismatch: "The game files do not match the required edition.",
      required_source_missing: "Required game files are missing.",
    };
    return `Setup is on hold. ${definitionReason && Object.hasOwn(reasons, definitionReason) ? reasons[definitionReason] : "Check this port's current requirements."}`;
  }
  if (reason === "already_registered") return "This installation is already in your library.";
  if (reason === "review_required") return "Choose a folder to review before using it.";
  return "This installation route is unavailable. Check the port details for current requirements.";
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
  const select = async () => {
    const path = await pickInstallFolder("");
    if (typeof path === "string") setReview({ kind: "register", path });
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
            disabled={busy}
            onClick={() => setReview({ kind: "remove" })}
          >
            Stop using this installation
          </Button>
        </div>
      ) : (
        <div>
          <p>
            Prepare the required version, then choose the folder containing the game. Portcove
            checks the required files before using the folder and at every launch. It does not copy,
            update, back up, or delete these files.
          </p>
          {port.presentation?.manual_preparation && <p>{port.presentation.manual_preparation}</p>}
          <ul>
            {Object.entries(port.release.user_prepared).map(([platform, required]) => (
              <li key={platform}>
                {platform}: Prepare {required.archive_name} version {required.version}, then choose
                the folder containing <code>{required.executable}</code>.{" "}
                <details>
                  <summary>File details</summary>Archive SHA-256:{" "}
                  <code>{required.archive_sha256}</code>
                </details>
              </li>
            ))}
          </ul>
          {!canRegister && registration?.reason && (
            <p role="status">
              {externalSetupReason(
                registration.availability,
                registration.reason,
                registration.definition?.reason,
              )}
            </p>
          )}
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
