import { useState } from "react";
import { reloadWorkspace } from "../reload-workspace";
import { join } from "@tauri-apps/api/path";
import { desktopApi } from "../api";
import { pickInstallFolder } from "../file-picker";
import type { LibraryMovePlan } from "../types";
import { errorText, formatBytes, formatCountMessage } from "../view-model";
import { NavigationHints } from "./ui";
import { Button } from "./ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogTitle } from "./ui/dialog";
import { Input } from "./ui/input";

export function LibraryMoveButton({ disabled }: { disabled: boolean }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button
        data-focusable
        data-settings-control="move-library"
        variant="outline"
        size="sm"
        disabled={disabled}
        onClick={() => setOpen(true)}
      >
        Move library
      </Button>
      {open && <LibraryMoveDialog close={() => setOpen(false)} />}
    </>
  );
}

function LibraryMoveDialog({ close }: { close: () => void }) {
  const [destination, setDestination] = useState("");
  const [plan, setPlan] = useState<LibraryMovePlan>();
  const [busy, setBusy] = useState("");
  const [error, setError] = useState<unknown>();
  const [transferAttempted, setTransferAttempted] = useState(false);
  const dismiss = () => {
    if (!busy) {
      if (transferAttempted) reloadWorkspace();
      else close();
    }
  };
  const recoveryRoot = transferRecoveryRoot(error);
  const canKeepOriginal = transferRecoveryCanKeepOriginal(error);
  const run = async (label: string, operation: () => Promise<void>) => {
    setBusy(label);
    setError(undefined);
    try {
      await operation();
    } catch (value) {
      setError(value);
      setPlan(undefined);
    } finally {
      setBusy("");
    }
  };
  const browse = () =>
    run("Choosing a destination…", async () => {
      const parent = await pickInstallFolder("");
      if (parent) {
        setDestination(await join(parent, "Portcove Library"));
        setPlan(undefined);
      }
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
        reviewSize="wide"
        aria-describedby="move-library-description"
      >
        <p className="eyebrow mb-[6px] text-[length:var(--text-xs)] font-bold tracking-[0.16em] text-[var(--color-primary-text)]">
          LIBRARY STORAGE
        </p>
        <DialogTitle id="move-library-title" className="mb-2 text-xl">
          Move your library
        </DialogTitle>
        <DialogDescription id="move-library-description" className="mb-4 leading-relaxed">
          Portcove copies the library to the new location, verifies application versions, saves,
          backups, and toolchains, then opens that copy. The old folder is kept, so this does not
          free space on its drive. Original game files stay at their saved locations; keep those
          locations available.
        </DialogDescription>
        <NavigationHints />
        <label htmlFor="library-destination">New library folder</label>
        <div className="flex items-stretch gap-2 [&_input]:min-w-0">
          <Input
            data-autofocus
            data-focusable
            id="library-destination"
            value={destination}
            disabled={Boolean(busy) || Boolean(recoveryRoot)}
            onChange={(event) => {
              setDestination(event.target.value);
              setPlan(undefined);
            }}
            placeholder="Full path to a new folder"
          />
          <Button
            data-focusable
            variant="outline"
            disabled={Boolean(busy) || Boolean(recoveryRoot)}
            onClick={() => {
              void browse();
            }}
          >
            Choose parent folder
          </Button>
        </div>
        {plan && (
          <LibraryCopySummary plan={plan} source={plan.source_root} label="Library move plan" />
        )}
        {busy && <p role="status">{busy} Keep Portcove open until this finishes.</p>}
        {error != null && <p role="alert">{errorText(error)}</p>}
        {transferAttempted && !busy && (
          <p>Closing this review refreshes the library before you continue.</p>
        )}
        {recoveryRoot && (
          <LibraryMoveRecovery
            source={recoveryRoot}
            canKeepOriginal={canKeepOriginal}
            onBusyChange={(active) => setBusy(active ? "Recovering your library…" : "")}
          />
        )}
        <DialogFooter className="mt-4">
          <Button data-focusable variant="outline" disabled={Boolean(busy)} onClick={dismiss}>
            Close
          </Button>
          {!recoveryRoot &&
            (plan ? (
              <Button
                data-focusable
                variant="primary"
                disabled={Boolean(busy)}
                onClick={() => {
                  void run("Copying and verifying your library…", async () => {
                    setTransferAttempted(true);
                    await desktopApi.moveLibrary(plan.destination_root, plan.plan_sha256);
                    reloadWorkspace();
                  });
                }}
              >
                Move to this folder
              </Button>
            ) : (
              <Button
                data-focusable
                disabled={Boolean(busy) || !destination.trim()}
                onClick={() => {
                  void run("Reviewing your library…", async () =>
                    setPlan(await desktopApi.planLibraryMove(destination)),
                  );
                }}
              >
                Review move
              </Button>
            ))}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export function LibraryMoveRecovery({
  source,
  canKeepOriginal,
  onBusyChange,
  disabled = false,
}: {
  source: string;
  canKeepOriginal: boolean;
  onBusyChange?: (active: boolean) => void;
  disabled?: boolean;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const recover = async (abort: boolean) => {
    if (busy || disabled) return;
    setBusy(true);
    setError(undefined);
    onBusyChange?.(true);
    try {
      await desktopApi.recoverLibraryMove(source, abort);
      reloadWorkspace();
    } catch (value) {
      setError(errorText(value));
    } finally {
      setBusy(false);
      onBusyChange?.(false);
    }
  };
  return (
    <section aria-label="Library move recovery">
      <h2 className="text-base">Finish the interrupted library move</h2>
      <p className="[overflow-wrap:anywhere] [unicode-bidi:plaintext]">
        Original library: {source}
      </p>
      <p>Resume the move to check the new copy and finish switching libraries.</p>
      {canKeepOriginal ? (
        <p>Keep using the original library before the new copy is activated.</p>
      ) : (
        <p>The new copy is already activated, so recovery can only resume the move.</p>
      )}
      <p>Neither option deletes the copied files.</p>
      <div className="actions mt-[24px] flex flex-wrap gap-[8px] [&.compact]:mt-[14px]">
        <Button
          data-focusable
          variant="primary"
          disabled={busy || disabled}
          onClick={() => {
            void recover(false);
          }}
        >
          Resume move
        </Button>
        {canKeepOriginal && (
          <Button
            data-focusable
            variant="outline"
            disabled={busy || disabled}
            onClick={() => {
              void recover(true);
            }}
          >
            Keep using original library
          </Button>
        )}
      </div>
      {busy && <p role="status">Recovering the library move…</p>}
      {error && <p role="alert">{error}</p>}
    </section>
  );
}

export function transferRecoveryRoot(
  error: unknown,
  key: "retained_source" | "import_destination" = "retained_source",
): string | undefined {
  if (
    typeof error !== "object" ||
    !error ||
    !("details" in error) ||
    typeof error.details !== "object" ||
    !error.details
  )
    return undefined;
  const details = error.details as Record<string, unknown>;
  return (details.transfer_id || details.recovery_action) && typeof details[key] === "string"
    ? details[key]
    : undefined;
}

export function transferRecoveryCanKeepOriginal(error: unknown): boolean {
  if (
    typeof error !== "object" ||
    !error ||
    !("details" in error) ||
    typeof error.details !== "object" ||
    !error.details
  )
    return false;
  return (error.details as Record<string, unknown>).move_abort_available === "true";
}

export function LibraryCopySummary({
  plan,
  source,
  label,
}: {
  plan: Pick<
    LibraryMovePlan,
    "content" | "metadata" | "destination_root" | "required_bytes" | "available_bytes"
  >;
  source: string;
  label: string;
}) {
  return (
    <section
      className="adoption-plan adoption-review m-[var(--space-4)_0] max-h-[none] overflow-visible rounded-pc-md border border-[var(--color-border)] bg-[var(--color-bg-inset)] p-4 [overflow-wrap:anywhere]"
      aria-label={label}
    >
      <p className="m-[0_0_var(--space-2)] text-[var(--color-text-secondary)]">
        From <code>{source}</code>
        <br />
        To <code>{plan.destination_root}</code>
      </p>
      <p className="m-[0_0_var(--space-2)] text-[var(--color-text-secondary)]">
        {formatBytes(plan.required_bytes)} required, including working space.{" "}
        {formatBytes(plan.available_bytes)} available.
      </p>
      <h3>Included installations</h3>
      {plan.metadata.application_versions.length > 0 ? (
        <>
          <p className="m-[0_0_var(--space-2)] text-[var(--color-text-secondary)]">
            Current, previous, and saved-for-later versions keep their identities. These
            installation paths are relative to the library folder.
          </p>
          <ul className="ps-5">
            {plan.metadata.application_versions.map((install) => (
              <li key={install.id}>
                <strong>{install.port_id}</strong> · {install.version}
                <br />
                <code>{install.path}</code>
              </li>
            ))}
          </ul>
        </>
      ) : (
        <p className="m-[0_0_var(--space-2)] text-[var(--color-text-secondary)]">
          No installed versions are recorded in this plan.
        </p>
      )}
      <h3>Copied folders and files</h3>
      <p className="m-[0_0_var(--space-2)] text-[var(--color-text-secondary)]">
        Open a folder to inspect the recorded paths. Each folder is copied from the source location
        to the same relative path at the destination.
      </p>
      {plan.content.map((tree) => (
        <LibraryCopyTree key={tree.relative_path} tree={tree} />
      ))}
      <h3>Saved file locations</h3>
      <p className="m-[0_0_var(--space-2)] text-[var(--color-text-secondary)]">
        {formatCountMessage(plan.metadata.source_references.length, {
          zero: "No saved file locations are included.",
          one: "1 saved file location will stay unchanged.",
          other: "{count} saved file locations will stay unchanged.",
          unknown: "Saved file location count is unavailable.",
        })}
      </p>
      {plan.metadata.source_references.length > 0 && (
        <details>
          <summary className="cursor-pointer text-[var(--color-warning-text)]" data-focusable>
            Saved game-file locations
          </summary>
          <ul className="ps-5">
            {plan.metadata.source_references.map((reference) => (
              <li key={reference.profile_id}>
                {reference.profile_id}
                <br />
                <code>{reference.path}</code>
              </li>
            ))}
          </ul>
        </details>
      )}
      <p className="m-[0_0_var(--space-2)] text-[var(--color-text-secondary)]">
        Copying Portcove game-file folder contents does not redirect these saved locations. Keep the
        original game files available until you explicitly add another location.
      </p>
      <p className="m-[0_0_var(--space-2)] text-[var(--color-text-secondary)]">
        Original game files, saves, backups and artwork remain in place. Later saves and settings
        belong to the library you use; changes are not synchronized between the two locations. There
        is no single undo action that merges later changes back into the original.
      </p>
      <p className="m-[0_0_var(--space-2)] mb-0 text-[var(--color-text-secondary)]">
        Once copying starts, this dialog cannot cancel it. If interrupted, use the recorded move or
        import recovery before another transfer. Keep both locations until the result is confirmed.
      </p>
    </section>
  );
}

function LibraryCopyTree({ tree }: { tree: LibraryMovePlan["content"][number] }) {
  const [expanded, setExpanded] = useState(false);
  const labels: Record<typeof tree.kind, string> = {
    application_versions: "Game versions",
    user_data: "Saved data",
    source_inbox: "Portcove game-file folder",
    backups: "Backups",
    toolchains: "Preparation tools",
    local_artwork: "Local artwork",
  };
  return (
    <details onToggle={(event) => setExpanded(event.currentTarget.open)}>
      <summary data-focusable>
        {Object.hasOwn(labels, tree.kind) ? labels[tree.kind] : "Other recorded content"} ·{" "}
        {formatBytes(tree.copy.total_bytes)}
      </summary>
      {expanded && (
        <>
          <p>
            Folder within both locations: <code>{tree.relative_path}</code>
          </p>
          <p>
            {formatCountMessage(tree.copy.files.length, {
              zero: "No files are recorded in this folder.",
              one: "1 file will be copied.",
              other: "{count} files will be copied.",
              unknown: "File count is unavailable.",
            })}
          </p>
          {tree.copy.files.length > 0 && (
            <ul aria-label={`Files in ${tree.relative_path}`}>
              {tree.copy.files.map((file) => (
                <li key={file.relative_path}>
                  <code>{file.relative_path}</code> · {formatBytes(file.size)}
                </li>
              ))}
            </ul>
          )}
          {tree.copy.directories.length > 0 && (
            <>
              <p>Included subfolders, including empty folders:</p>
              <ul aria-label={`Subfolders in ${tree.relative_path}`}>
                {tree.copy.directories.map((directory) => (
                  <li key={directory}>
                    <code>{directory}</code>
                  </li>
                ))}
              </ul>
            </>
          )}
        </>
      )}
    </details>
  );
}
