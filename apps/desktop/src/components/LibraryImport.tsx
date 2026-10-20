import { reloadWorkspace } from "../reload-workspace";
import { useState } from "react";
import { desktopApi } from "../api";
import { pickInstallFolder, pickMetadataImportPath } from "../file-picker";
import type { LibraryImportPlan } from "../types";
import { errorText } from "../view-model";
import { LibraryCopySummary, transferRecoveryRoot } from "./LibraryMove";
import { NavigationHints } from "./ui";
import { Button } from "./ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogTitle } from "./ui/dialog";
import { Input } from "./ui/input";

export function LibraryImportButton({
  disabled,
  libraryRoot,
}: {
  disabled: boolean;
  libraryRoot: string;
}) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button
        data-focusable
        data-settings-control="import-library"
        variant="outline"
        size="sm"
        disabled={disabled}
        onClick={() => setOpen(true)}
      >
        Restore from a library copy
      </Button>
      {open && <LibraryImportDialog libraryRoot={libraryRoot} close={() => setOpen(false)} />}
    </>
  );
}

function LibraryImportDialog({ libraryRoot, close }: { libraryRoot: string; close: () => void }) {
  const [metadata, setMetadata] = useState("");
  const [content, setContent] = useState("");
  const [plan, setPlan] = useState<LibraryImportPlan>();
  const [busy, setBusy] = useState("");
  const [error, setError] = useState<unknown>();
  const [transferAttempted, setTransferAttempted] = useState(false);
  const dismiss = () => {
    if (!busy) {
      if (transferAttempted) reloadWorkspace();
      else close();
    }
  };
  const recoveryRoot = transferRecoveryRoot(error, "import_destination");
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
  const choose = (field: "metadata" | "content") =>
    run("Choosing your export…", async () => {
      const path =
        field === "metadata" ? await pickMetadataImportPath() : await pickInstallFolder(content);
      if (path) {
        (field === "metadata" ? setMetadata : setContent)(path);
        setPlan(undefined);
      }
    });
  const locked = Boolean(busy) || Boolean(recoveryRoot);
  return (
    <Dialog
      open
      onOpenChange={(nextOpen) => {
        if (!nextOpen) dismiss();
      }}
    >
      <DialogContent
        showCloseButton={false}
        reviewSize="large"
        aria-describedby="import-library-description"
      >
        <p className="eyebrow mb-[6px] text-[length:var(--text-xs)] font-bold tracking-[0.16em] text-[var(--color-primary-text)]">
          RESTORE PORTCOVE LIBRARY
        </p>
        <DialogTitle id="import-library-title" className="mb-2 text-xl">
          Restore from a library copy
        </DialogTitle>
        <DialogDescription id="import-library-description" className="mb-4 leading-relaxed">
          You need a library metadata file and a separate copy of the original library folder.
          Restore into a new or empty library. Review the destination and copied files first.
          Portcove copies and verifies the restored content before opening the library. A review
          alone does not verify a complete recovery copy. The originals stay where they are.
        </DialogDescription>
        <p>
          <strong>Use an export you trust.</strong> Review its source, destination, required space,
          installed versions, saved file locations, and copied files before restoring it.
        </p>
        <p>
          Destination: <code>{libraryRoot}</code>
        </p>
        <NavigationHints />
        <label htmlFor="import-metadata">Library metadata file</label>
        <div className="grid min-w-0 gap-2 min-[48rem]:grid-cols-[minmax(0,1fr)_auto] [&_input]:min-w-0">
          <Input
            data-autofocus
            data-focusable
            id="import-metadata"
            value={metadata}
            disabled={locked}
            onChange={(event) => {
              setMetadata(event.target.value);
              setPlan(undefined);
            }}
            placeholder="Choose the library metadata file"
          />
          <Button
            data-focusable
            variant="outline"
            disabled={locked}
            onClick={() => {
              void choose("metadata");
            }}
          >
            Choose file
          </Button>
        </div>
        <label htmlFor="import-content">Copy of the original library folder</label>
        <div className="grid min-w-0 gap-2 min-[48rem]:grid-cols-[minmax(0,1fr)_auto] [&_input]:min-w-0">
          <Input
            data-focusable
            id="import-content"
            value={content}
            disabled={locked}
            onChange={(event) => {
              setContent(event.target.value);
              setPlan(undefined);
            }}
            placeholder="Choose the copied library folder"
          />
          <Button
            data-focusable
            variant="outline"
            disabled={locked}
            onClick={() => {
              void choose("content");
            }}
          >
            Choose folder
          </Button>
        </div>
        {plan && (
          <LibraryCopySummary plan={plan} source={plan.content_root} label="Library restore plan" />
        )}
        {busy && <p role="status">{busy} Keep Portcove open until this finishes.</p>}
        {error != null && <p role="alert">{errorText(error)}</p>}
        {transferAttempted && !busy && (
          <p>Closing this restore review refreshes the library before you continue.</p>
        )}
        {recoveryRoot && (
          <LibraryImportRecovery
            destination={recoveryRoot}
            onBusyChange={(active) => setBusy(active ? "Recovering your restore…" : "")}
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
                  void run("Copying and verifying the restored library…", async () => {
                    setTransferAttempted(true);
                    await desktopApi.importLibrary(
                      plan.metadata_file.path,
                      plan.content_root,
                      plan.plan_sha256,
                    );
                    reloadWorkspace();
                  });
                }}
              >
                Restore this library
              </Button>
            ) : (
              <Button
                data-focusable
                disabled={Boolean(busy) || !metadata.trim() || !content.trim()}
                onClick={() => {
                  void run("Reviewing your restore…", async () =>
                    setPlan(await desktopApi.planLibraryImport(metadata, content)),
                  );
                }}
              >
                Review restore
              </Button>
            ))}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export function LibraryImportRecovery({
  destination,
  onBusyChange,
  disabled = false,
}: {
  destination: string;
  onBusyChange?: (active: boolean) => void;
  disabled?: boolean;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const recover = async () => {
    if (busy || disabled) return;
    setBusy(true);
    setError(undefined);
    onBusyChange?.(true);
    try {
      await desktopApi.recoverLibraryImport(destination);
      reloadWorkspace();
    } catch (value) {
      setError(errorText(value));
    } finally {
      setBusy(false);
      onBusyChange?.(false);
    }
  };
  return (
    <section aria-label="Library restore recovery">
      <h2 className="text-base">Finish the interrupted library restore</h2>
      <p className="[overflow-wrap:anywhere] [unicode-bidi:plaintext]">
        Restore destination: {destination}
      </p>
      <p>
        Resume the restore to verify and finish opening the copied library. The Portcove export
        stays unchanged. Incomplete copies remain closed until recovery succeeds.
      </p>
      <Button
        data-focusable
        variant="primary"
        disabled={busy || disabled}
        onClick={() => {
          void recover();
        }}
      >
        Resume restore
      </Button>
      {busy && <p role="status">Recovering the library restore…</p>}
      {error && <p role="alert">{error}</p>}
    </section>
  );
}
