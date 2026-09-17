import { useState } from "react";
import { desktopApi } from "../api";
import { useDialogFocus } from "../dialog";
import { pickInstallFolder, pickMetadataImportPath } from "../file-picker";
import type { LibraryImportPlan } from "../types";
import { errorText } from "../view-model";
import { LibraryCopySummary, transferRecoveryRoot } from "./LibraryMove";
import { NavigationHints } from "./ui";

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
      <button
        data-focusable
        className="small-control"
        disabled={disabled}
        onClick={() => setOpen(true)}
      >
        Restore library
      </button>
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
      if (transferAttempted) window.location.reload();
      else close();
    }
  };
  const dialog = useDialogFocus(dismiss);
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
    <div className="scrim">
      <section
        ref={dialog}
        className="modal wide-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="import-library-title"
      >
        <p className="eyebrow">RESTORE PORTCOVE LIBRARY</p>
        <h2 id="import-library-title">Restore your library</h2>
        <p className="modal-description">
          Restore a Portcove export and its copied library data into this empty library. Portcove
          checks the copy before opening it and does not change the export.
        </p>
        <p>
          <strong>Use an export you trust.</strong> Review its source, destination, required space,
          installed versions, saved game-file locations, and copied files before restoring it.
        </p>
        <p>
          Destination: <code>{libraryRoot}</code>
        </p>
        <NavigationHints />
        <label htmlFor="import-metadata">Portcove export file</label>
        <div className="path-entry">
          <input
            data-autofocus
            data-focusable
            id="import-metadata"
            value={metadata}
            disabled={locked}
            onChange={(event) => {
              setMetadata(event.target.value);
              setPlan(undefined);
            }}
            placeholder="Choose a Portcove library export"
          />
          <button
            data-focusable
            disabled={locked}
            onClick={() => {
              void choose("metadata");
            }}
          >
            Choose file
          </button>
        </div>
        <label htmlFor="import-content">Exported library folder</label>
        <div className="path-entry">
          <input
            data-focusable
            id="import-content"
            value={content}
            disabled={locked}
            onChange={(event) => {
              setContent(event.target.value);
              setPlan(undefined);
            }}
            placeholder="Folder containing the exported Portcove library"
          />
          <button
            data-focusable
            disabled={locked}
            onClick={() => {
              void choose("content");
            }}
          >
            Choose folder
          </button>
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
        <div className="actions">
          <button data-focusable disabled={Boolean(busy)} onClick={dismiss}>
            Close
          </button>
          {!recoveryRoot &&
            (plan ? (
              <button
                data-focusable
                className="primary"
                disabled={Boolean(busy)}
                onClick={() => {
                  void run("Copying and verifying the restored library…", async () => {
                    setTransferAttempted(true);
                    await desktopApi.importLibrary(
                      plan.metadata_file.path,
                      plan.content_root,
                      plan.plan_sha256,
                    );
                    window.location.reload();
                  });
                }}
              >
                Restore this library
              </button>
            ) : (
              <button
                data-focusable
                className="primary"
                disabled={Boolean(busy) || !metadata.trim() || !content.trim()}
                onClick={() => {
                  void run("Reviewing your restore…", async () =>
                    setPlan(await desktopApi.planLibraryImport(metadata, content)),
                  );
                }}
              >
                Review restore
              </button>
            ))}
        </div>
      </section>
    </div>
  );
}

export function LibraryImportRecovery({
  destination,
  onBusyChange,
}: {
  destination: string;
  onBusyChange?: (active: boolean) => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const recover = async () => {
    setBusy(true);
    setError(undefined);
    onBusyChange?.(true);
    try {
      await desktopApi.recoverLibraryImport(destination);
      window.location.reload();
    } catch (value) {
      setError(errorText(value));
    } finally {
      setBusy(false);
      onBusyChange?.(false);
    }
  };
  return (
    <section aria-label="Library restore recovery">
      <p>
        Resume the restore to verify and finish opening the copied library. The Portcove export
        stays unchanged. Incomplete copies remain closed until recovery succeeds.
      </p>
      <button
        data-focusable
        disabled={busy}
        onClick={() => {
          void recover();
        }}
      >
        Resume restore
      </button>
      {busy && <p role="status">Recovering the library restore…</p>}
      {error && <p role="alert">{error}</p>}
    </section>
  );
}
