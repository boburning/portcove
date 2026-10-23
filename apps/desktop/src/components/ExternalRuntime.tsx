import { ActionReviewFailure } from "./ActionReviewFailure";
import { FolderOpen } from "lucide-react";
import { useId, useLayoutEffect, useRef, useState } from "react";
import { desktopApi } from "../api";
import {
  catalogSetupPresentation,
  removalReviewPresentation,
} from "../features/port-actions/port-action-presentation";
import { pickInstallFolder, pickHostToolExecutable } from "../file-picker";
import { LatestRequestGeneration } from "../shared/concurrency-state";
import type {
  ExternalRuntimePreview,
  PortDefinition,
  PortListingStatus,
  PortStatus,
} from "../types";
import { listingActionAssessment, type CatalogEntry } from "../features/browsing/catalog-entry";
import { useActionReview } from "../use-action-review";
import { Icon } from "./ui";
import { Button } from "./ui/button";
import { Input } from "./ui/input";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogTitle } from "./ui/dialog";
import { ExternalLink } from "./ExternalLink";
import { platformLabel } from "../view-model";
import { sharedRuntimeDisclosure } from "../shared/external-runtime-disclosure";
import { usesUserSelectedRuntime } from "../shared/external-runtime-trust";

function ReviewCancelButton({
  pending,
  dismiss,
  cancelRef,
}: {
  pending: boolean;
  dismiss: () => void;
  cancelRef: React.Ref<HTMLButtonElement>;
}) {
  return (
    <Button ref={cancelRef} data-focusable variant="outline" disabled={pending} onClick={dismiss}>
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
  if (props.status?.active) return null;
  return (
    <ExternalRuntimeContext
      key={JSON.stringify([props.port.id, props.generation, props.status?.external_runtime?.id])}
      {...props}
    />
  );
}

function AuthoredPreparationGuidance({ port }: { port: CatalogEntry }) {
  const guide = port.presentation?.manual_setup;
  return (
    <>
      {guide ? (
        <>
          {guide.warnings.length > 0 && (
            <aside
              aria-label="Before you begin"
              className="border-pc-warning rounded-pc-md border bg-pc-warning-subtle p-3 text-pc-warning-foreground"
            >
              <h4 className="font-semibold">Before you begin</h4>
              <ul className="mt-2 grid list-disc gap-2 pl-5">
                {guide.warnings.map((warning) => (
                  <li key={warning}>{warning}</li>
                ))}
              </ul>
            </aside>
          )}
          <ol className="grid list-decimal gap-4 pl-5 marker:font-semibold">
            {guide.steps.map((step, index) => (
              <li key={`${index}:${step.title}`} className="pl-1">
                <h4 className="font-semibold">{step.title}</h4>
                <p>{step.instruction}</p>
              </li>
            ))}
          </ol>
          {guide.help_url && (
            <ExternalLink href={guide.help_url}>Detailed preparation guide</ExternalLink>
          )}
          {port.presentation?.manual_preparation && (
            <details className="text-xs">
              <summary data-focusable className="cursor-pointer font-medium">
                Compatibility and technical notes
              </summary>
              <p className="mt-2">{port.presentation.manual_preparation}</p>
            </details>
          )}
        </>
      ) : port.presentation?.manual_preparation ? (
        <p>{port.presentation.manual_preparation}</p>
      ) : null}
    </>
  );
}

function ExternalPreparationRequirements({ port }: { port: PortDefinition }) {
  return (
    <section aria-label="Prepare this port" className="grid gap-4 text-sm leading-relaxed">
      <h3 className="text-base font-semibold">Set up using your own files</h3>
      <p>
        You need your own original game files; the port download does not include them. Prepare the
        required version, then choose its folder below for a checked review.
      </p>
      <AuthoredPreparationGuidance port={port} />
      <p>
        Portcove checks required files before using the folder and at every launch. You manage this
        installation and its updates. Portcove does not copy, back up, or delete these files.
      </p>
      <ul>
        {Object.entries(port.release.user_prepared).map(([platform, required]) => (
          <li key={platform}>
            {platformLabel(platform)}: Prepare {required.archive_name} version {required.version},
            then choose the folder containing <code>{required.executable}</code>.{" "}
            <details>
              <summary>File details</summary>Archive SHA-256: <code>{required.archive_sha256}</code>
            </details>
          </li>
        ))}
      </ul>
    </section>
  );
}

function ExternalRuntimeContext({
  port,
  status,
  generation,
  busy,
  onChanged,
}: ExternalRuntimeControlProps) {
  const [review, setReview] = useState<
    { kind: "register" | "relink"; path: string } | { kind: "remove" }
  >();
  const pickerRequests = useRef(new LatestRequestGeneration());
  useLayoutEffect(() => {
    const requests = pickerRequests.current;
    return () => {
      requests.begin();
    };
  }, []);
  if (usesUserSelectedRuntime(port, status)) {
    return (
      <UserSelectedRuntimeControl
        port={port}
        status={status}
        generation={generation}
        busy={busy}
        onChanged={onChanged}
      />
    );
  }
  if (port.release.provider !== "user-prepared" && !status?.external_runtime) return null;
  const registered = status?.external_runtime;
  const removal = removalReviewPresentation(status, "remove_external");
  const { registration, canRegister } = externalRegistration(status);
  const select = async (kind: "register" | "relink" = "register") => {
    const request = pickerRequests.current.begin();
    const path = await pickInstallFolder("");
    if (pickerRequests.current.isCurrent(request) && typeof path === "string")
      setReview({ kind, path });
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
            onClick={() => void select("relink")}
          >
            Change game folder…
          </Button>
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
      {(review?.kind === "register" || review?.kind === "relink") && (
        <RegisterExternalDialog
          key={`${port.id}:${review.path}:${generation}`}
          port={port}
          mode={review.kind}
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

type SelectedLaunch = { executable: string; workingDirectory: string; arguments: string[] };

type UserSelectedRuntimeProps = Omit<ExternalRuntimeControlProps, "port"> & {
  port: CatalogEntry;
  listingStatus?: PortListingStatus | undefined;
  initialDirectory?: string | undefined;
};

export function UserSelectedRuntimeControl(props: UserSelectedRuntimeProps) {
  return (
    <UserSelectedRuntimeEditor
      key={JSON.stringify([
        props.port.id,
        props.generation,
        props.status?.external_runtime,
        props.initialDirectory,
      ])}
      {...props}
    />
  );
}

function UserSelectedRuntimeEditor({
  port,
  status,
  generation,
  busy,
  onChanged,
  listingStatus,
  initialDirectory,
}: UserSelectedRuntimeProps) {
  const workingDirectoryId = useId();
  const registered = status?.external_runtime;
  const [executable, setExecutable] = useState(registered?.executable ?? "");
  const [workingDirectory, setWorkingDirectory] = useState(
    registered?.path ?? initialDirectory ?? "",
  );
  const [argumentLines, setArgumentLines] = useState(
    registered?.user_selected?.arguments.join("\n") ?? "",
  );
  const [argumentsEdited, setArgumentsEdited] = useState(false);
  const savedArguments = registered?.user_selected?.arguments ?? [];
  const preserveStructuredArguments =
    !argumentsEdited && savedArguments.some((argument) => !argument || /[\r\n]/u.test(argument));
  const [editing, setEditing] = useState(false);
  const [selected, setSelected] = useState<SelectedLaunch>();
  const [removing, setRemoving] = useState(false);
  const [pickerError, setPickerError] = useState<unknown>();
  const pickerRequests = useRef(new LatestRequestGeneration());
  useLayoutEffect(() => {
    const requests = pickerRequests.current;
    return () => {
      requests.begin();
    };
  }, []);
  const removal = removalReviewPresentation(status, "remove_external");
  const { registration, canRegister } = externalRegistration(status);
  const requestedAction = registered ? "relink-existing" : "attach-existing";
  const assessment = listingActionAssessment(listingStatus, requestedAction);
  const requiresListingAssessment = Boolean(listingStatus || !port.release);
  const canEdit = requiresListingAssessment
    ? assessment.allowed
    : registered
      ? Boolean(registered.user_selected)
      : canRegister;
  const removeAssessment = listingActionAssessment(listingStatus, "remove-registration");
  const canRemove = requiresListingAssessment ? removeAssessment.allowed : !removal.blocked;
  const chooseExecutable = async () => {
    const request = pickerRequests.current.begin();
    setPickerError(undefined);
    try {
      const path = await pickHostToolExecutable("game", executable || workingDirectory);
      if (pickerRequests.current.isCurrent(request) && typeof path === "string") {
        setExecutable(path);
        setWorkingDirectory(path.slice(0, Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"))));
      }
    } catch (value) {
      if (pickerRequests.current.isCurrent(request)) setPickerError(value);
    }
  };
  const chooseDirectory = async () => {
    const request = pickerRequests.current.begin();
    setPickerError(undefined);
    try {
      const path = await pickInstallFolder(workingDirectory);
      if (pickerRequests.current.isCurrent(request) && typeof path === "string")
        setWorkingDirectory(path);
    } catch (value) {
      if (pickerRequests.current.isCurrent(request)) setPickerError(value);
    }
  };
  return (
    <section className="grid gap-3" aria-label="Your existing installation">
      <ActionReviewFailure error={pickerError} />
      {registered && !editing ? (
        <>
          <p>
            You or the upstream launcher manage this installation and its updates. Portcove launches{" "}
            <code>{registered.executable}</code> using <code>{registered.path}</code> as its working
            directory. It does not manage its files, settings or saves.
            {registered.user_selected && " It does not authenticate it as an official package."}
          </p>
          <Button
            variant="outline"
            data-focusable
            disabled={busy || !canEdit}
            onClick={() => setEditing(true)}
          >
            Edit launch details…
          </Button>
          <Button
            variant="outline"
            data-focusable
            disabled={busy || !canRemove}
            onClick={() => setRemoving(true)}
          >
            Remove registration
          </Button>
          {!canEdit && <p role="status">{assessment.reason}</p>}
          {!canRemove && (
            <p role="status">
              {requiresListingAssessment ? removeAssessment.reason : removal.reason}
            </p>
          )}
        </>
      ) : (
        <>
          <h3 className="font-semibold">
            {registered ? "Edit launch details" : "Use your existing installation"}
          </h3>
          <p>
            Complete the upstream setup with your own game files, then choose the game executable or
            its supported native launcher. You or the upstream launcher manage setup and updates.
            Portcove only saves these launch details and starts it.
          </p>
          <AuthoredPreparationGuidance port={port} />
          <Button
            variant="outline"
            data-focusable
            disabled={busy || !canEdit}
            onClick={() => void chooseExecutable()}
          >
            Choose game executable…
          </Button>
          {executable && (
            <p className="[overflow-wrap:anywhere]">
              Executable: <code>{executable}</code>
            </p>
          )}
          <label className="grid gap-1" htmlFor={workingDirectoryId}>
            Working directory
            <Input
              id={workingDirectoryId}
              aria-label="Working directory"
              value={workingDirectory}
              disabled={busy}
              onValueChange={setWorkingDirectory}
            />
          </label>
          <p className="text-sm text-pc-muted-foreground">
            This is the folder the game starts in. Use the folder named in the upstream setup
            instructions, or keep the executable's folder when no other folder is required.
          </p>
          <Button
            variant="outline"
            data-focusable
            disabled={busy}
            onClick={() => void chooseDirectory()}
          >
            Choose working directory…
          </Button>
          <details>
            <summary data-focusable className="cursor-pointer py-2 font-medium">
              Advanced launch options
            </summary>
            {preserveStructuredArguments ? (
              <>
                <p className="text-sm">
                  Your saved arguments include empty values or line breaks. They will be kept
                  exactly when you change the executable or working directory. This editor can
                  replace the list with one argument per line.
                </p>
                <pre className="min-w-0 [overflow-wrap:anywhere] whitespace-pre-wrap">
                  {JSON.stringify(savedArguments, null, 2)}
                </pre>
                <Button
                  variant="outline"
                  disabled={busy}
                  onClick={() => {
                    setArgumentLines("");
                    setArgumentsEdited(true);
                  }}
                >
                  Replace saved arguments…
                </Button>
              </>
            ) : (
              <>
                <label className="grid gap-1">
                  Arguments (one per line, optional)
                  <textarea
                    className="rounded-pc-md border border-pc-input bg-pc-surface p-2"
                    aria-label="Launch arguments"
                    value={argumentLines}
                    disabled={busy}
                    onChange={(event) => {
                      setArgumentLines(event.target.value);
                      setArgumentsEdited(true);
                    }}
                    rows={3}
                  />
                </label>
                <p className="text-sm text-pc-muted-foreground">
                  Enter each argument on a separate line. Spaces stay within one argument, and blank
                  lines are empty arguments. Leave the entire field empty when no arguments are
                  required.
                </p>
              </>
            )}
          </details>
          <p>
            Only choose an executable you trust. Portcove has not authenticated your selected files
            as an official package. Removing this registration preserves every external file.
          </p>
          {!canEdit && (
            <p role="status">
              {requiresListingAssessment ? assessment.reason : registration?.reason}
            </p>
          )}
          <Button
            data-focusable
            disabled={busy || !canEdit || !executable || !workingDirectory}
            onClick={() =>
              setSelected({
                executable,
                workingDirectory,
                arguments: argumentsEdited
                  ? argumentLines
                    ? argumentLines.split(/\r?\n/u)
                    : []
                  : [...savedArguments],
              })
            }
          >
            Review launch details
          </Button>
          {registered && (
            <Button
              data-focusable
              variant="ghost"
              onClick={() => {
                pickerRequests.current.begin();
                setExecutable(registered.executable);
                setWorkingDirectory(registered.path);
                setArgumentLines(registered.user_selected?.arguments.join("\n") ?? "");
                setArgumentsEdited(false);
                setEditing(false);
              }}
            >
              Cancel editing
            </Button>
          )}
        </>
      )}
      {selected && (
        <SelectedRuntimeDialog
          port={port}
          generation={generation}
          selected={selected}
          relink={Boolean(registered)}
          close={() => setSelected(undefined)}
          onChanged={onChanged}
        />
      )}
      {removing && (
        <RemoveExternalDialog
          port={port}
          generation={generation}
          close={() => setRemoving(false)}
          onChanged={onChanged}
        />
      )}
    </section>
  );
}

function SelectedRuntimeDialog({
  port,
  generation,
  selected,
  relink,
  close,
  onChanged,
}: {
  port: Pick<PortDefinition, "id" | "name">;
  generation: number;
  selected: SelectedLaunch;
  relink: boolean;
  close: () => void;
  onChanged?: (() => void) | undefined;
}) {
  const cancelButton = useRef<HTMLButtonElement>(null);
  const { preview, pending, error, review, execute, dismiss } = useActionReview({
    identity: JSON.stringify([port.id, generation, selected, relink]),
    retainOnCancel: true,
    load: async () => {
      if (relink) {
        const value = await desktopApi.previewUserSelectedRuntimeRelink(
          port.id,
          selected.executable,
          selected.workingDirectory,
          selected.arguments,
          generation,
        );
        return { ...value.proposed, preview_sha256: value.preview_sha256 };
      }
      return desktopApi.previewUserSelectedRuntime(
        port.id,
        selected.executable,
        selected.workingDirectory,
        selected.arguments,
        generation,
      );
    },
    apply: async (value) => {
      const record = await (
        relink ? desktopApi.relinkUserSelectedRuntime : desktopApi.registerUserSelectedRuntime
      )(
        port.id,
        selected.executable,
        selected.workingDirectory,
        selected.arguments,
        value.preview_sha256,
        generation,
      );
      if (record) onChanged?.();
      return record ? true : "cancelled";
    },
    close,
    failureMessage:
      "Portcove couldn't register these launch details. Review the selected executable and working directory.",
  });
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) dismiss();
      }}
    >
      <DialogContent
        initialFocus={cancelButton}
        showCloseButton={false}
        aria-describedby="selected-runtime-description"
      >
        <DialogTitle>
          {relink ? "Change launch details for" : "Use this"} {port.name}
          {relink ? "?" : " installation?"}
        </DialogTitle>
        <DialogDescription id="selected-runtime-description">
          You selected this executable. Portcove has not authenticated it as an official package.
          You or the upstream launcher own setup and updates. Portcove will launch it and can remove
          its registration. It will not replace, back up, restore, roll back or delete its external
          files.
        </DialogDescription>
        <dl className="grid gap-2 [overflow-wrap:anywhere]">
          <dt>Executable</dt>
          <dd>{selected.executable}</dd>
          <dt>Working directory</dt>
          <dd>{selected.workingDirectory}</dd>
          <dt>Arguments</dt>
          <dd>
            {selected.arguments.length
              ? selected.arguments.map((argument, index) => (
                  <div key={index}>
                    <span className="text-xs text-pc-muted-foreground">Argument {index + 1}</span>
                    {argument ? (
                      <code className="block whitespace-pre-wrap">{argument}</code>
                    ) : (
                      <span className="block">Empty argument</span>
                    )}
                  </div>
                ))
              : "None"}
          </dd>
        </dl>
        {pending === "review" && <p role="status">Checking executable and paths…</p>}
        <ActionReviewFailure error={error} />
        <DialogFooter>
          <ReviewCancelButton
            cancelRef={cancelButton}
            pending={pending === "apply"}
            dismiss={dismiss}
          />
          {preview ? (
            <Button disabled={Boolean(pending)} onClick={() => void execute()}>
              {relink ? "Save launch details" : "Use this installation"}
            </Button>
          ) : (
            <Button disabled={Boolean(pending)} onClick={() => void review()}>
              Check again
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function RegisterExternalDialog({
  port,
  mode,
  path,
  generation,
  close,
  onChanged,
}: {
  port: PortDefinition;
  mode: "register" | "relink";
  path: string;
  generation: number;
  close: () => void;
  onChanged?: (() => void) | undefined;
}) {
  const cancelButton = useRef<HTMLButtonElement>(null);
  const { preview, pending, error, review, execute, dismiss } = useActionReview({
    identity: JSON.stringify([mode, port.id, path, generation]),
    retainOnCancel: true,
    load: async (): Promise<ExternalRuntimePreview & { previous_path?: string }> => {
      if (mode === "relink") {
        const relink = await desktopApi.previewExternalRuntimeRelink(port.id, path, generation);
        if (relink.proposed.shared_preferences)
          sharedRuntimeDisclosure(relink.proposed.shared_preferences);
        return {
          ...relink.proposed,
          preview_sha256: relink.preview_sha256,
          previous_path: relink.previous_path,
        };
      }
      const value = await desktopApi.previewExternalRuntime(port.id, path, generation);
      if (value.shared_preferences) sharedRuntimeDisclosure(value.shared_preferences);
      return value;
    },
    apply: async (preview) => {
      if (preview.shared_preferences) sharedRuntimeDisclosure(preview.shared_preferences);
      const record = await (
        mode === "relink" ? desktopApi.relinkExternalRuntime : desktopApi.registerExternalRuntime
      )(port.id, path, preview.preview_sha256, generation);
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
      <DialogContent
        initialFocus={cancelButton}
        showCloseButton={false}
        aria-describedby="external-register-description"
      >
        <DialogTitle>
          {mode === "relink"
            ? `Change game folder for ${port.name}?`
            : `Use this ${port.name} installation?`}
        </DialogTitle>
        <DialogDescription id="external-register-description">
          Portcove will save this location and check the required files before each launch. It will
          not copy, update, back up, or delete the external folder.
        </DialogDescription>
        {pending === "review" && <p role="status">Checking runtime files…</p>}
        {preview?.previous_path && (
          <p className="[overflow-wrap:anywhere]">
            Previous folder: <code>{preview.previous_path}</code>. Its files stay where they are.
          </p>
        )}
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
            {preview.shared_preferences && (
              <p className="col-span-2 [overflow-wrap:anywhere]">
                {sharedRuntimeDisclosure(preview.shared_preferences)}
              </p>
            )}
          </div>
        )}
        <ActionReviewFailure error={error} />
        <DialogFooter>
          <ReviewCancelButton
            cancelRef={cancelButton}
            pending={pending === "apply"}
            dismiss={dismiss}
          />
          {!preview && (
            <Button data-focusable disabled={Boolean(pending)} onClick={() => void review()}>
              Check again
            </Button>
          )}
          {preview && (
            <Button data-focusable disabled={Boolean(pending)} onClick={() => void execute()}>
              {pending === "apply"
                ? "Saving location…"
                : mode === "relink"
                  ? "Change folder"
                  : "Use this installation"}
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
  port: Pick<PortDefinition, "id" | "name">;
  generation: number;
  close: () => void;
  onChanged?: (() => void) | undefined;
}) {
  const cancelButton = useRef<HTMLButtonElement>(null);
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
      <DialogContent
        initialFocus={cancelButton}
        showCloseButton={false}
        aria-describedby="external-remove-description"
      >
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
        <ActionReviewFailure error={error} />
        <DialogFooter>
          <ReviewCancelButton
            cancelRef={cancelButton}
            pending={pending === "apply"}
            dismiss={dismiss}
          />
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

function externalRegistration(status: PortStatus | undefined) {
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
  return { registration, canRegister };
}
