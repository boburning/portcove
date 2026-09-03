import { useState } from "react";
import { desktopApi } from "../api";
import { useDialogFocus } from "../dialog";
import { pickInstallFolder, pickMetadataImportPath } from "../file-picker";
import type { LibraryImportPlan } from "../types";
import { errorText } from "../view-model";
import { LibraryCopySummary, transferRecoveryRoot } from "./LibraryMove";
import { NavigationHints } from "./ui";

export function LibraryImportButton({ disabled, libraryRoot }: { disabled: boolean; libraryRoot: string }) {
  const [open, setOpen] = useState(false);
  return <><button data-focusable className="small-control" disabled={disabled} onClick={() => setOpen(true)}>Import library</button>
    {open && <LibraryImportDialog libraryRoot={libraryRoot} close={() => setOpen(false)} />}</>;
}

function LibraryImportDialog({ libraryRoot, close }: { libraryRoot: string; close: () => void }) {
  const [metadata, setMetadata] = useState("");
  const [content, setContent] = useState("");
  const [plan, setPlan] = useState<LibraryImportPlan>();
  const [busy, setBusy] = useState("");
  const [error, setError] = useState<unknown>();
  const dismiss = () => { if (!busy) close(); };
  const dialog = useDialogFocus(dismiss);
  const recoveryRoot = transferRecoveryRoot(error, "import_destination");
  const run = async (label: string, operation: () => Promise<void>) => {
    setBusy(label); setError(undefined);
    try { await operation(); } catch (value) { setError(value); setPlan(undefined); } finally { setBusy(""); }
  };
  const choose = (field: "metadata" | "content") => run("Choosing your backup…", async () => {
    const path = field === "metadata" ? await pickMetadataImportPath() : await pickInstallFolder(content);
    if (path) { (field === "metadata" ? setMetadata : setContent)(path); setPlan(undefined); }
  });
  const locked = Boolean(busy) || Boolean(recoveryRoot);
  return <div className="scrim"><section ref={dialog} className="modal wide-modal" role="dialog" aria-modal="true" aria-labelledby="import-library-title">
    <p className="eyebrow">LIBRARY BACKUP</p><h2 id="import-library-title">Import your library</h2>
    <p className="modal-description">Restore a trusted metadata export and its copied application, save, backup, and toolchain folders into this empty library. Portcove verifies the copy before opening it and keeps the backup files unchanged.</p>
    <p>Destination: <code>{libraryRoot}</code></p><NavigationHints />
    <label htmlFor="import-metadata">Metadata export</label><div className="path-entry">
      <input data-autofocus data-focusable id="import-metadata" value={metadata} disabled={locked} onChange={event => { setMetadata(event.target.value); setPlan(undefined); }} placeholder="portcove-library.json" />
      <button data-focusable disabled={locked} onClick={() => { void choose("metadata"); }}>Choose file</button>
    </div>
    <label htmlFor="import-content">Copied library folder</label><div className="path-entry">
      <input data-focusable id="import-content" value={content} disabled={locked} onChange={event => { setContent(event.target.value); setPlan(undefined); }} placeholder="Folder containing versions, user, backups, and toolchains" />
      <button data-focusable disabled={locked} onClick={() => { void choose("content"); }}>Choose folder</button>
    </div>
    {plan && <LibraryCopySummary plan={plan} source={plan.content_root} label="Library import plan" />}
    {busy && <p role="status">{busy} Keep Portcove open until this finishes.</p>}
    {error != null && <p role="alert">{errorText(error)}</p>}
    {recoveryRoot && <LibraryImportRecovery destination={recoveryRoot} onBusyChange={active => setBusy(active ? "Recovering your import…" : "")} />}
    <div className="actions"><button data-focusable disabled={Boolean(busy)} onClick={dismiss}>Close</button>
      {!recoveryRoot && (plan
        ? <button data-focusable className="primary" disabled={Boolean(busy)} onClick={() => { void run("Copying and verifying your backup…", async () => { await desktopApi.importLibrary(plan.metadata_file.path, plan.content_root, plan.plan_sha256); window.location.reload(); }); }}>Import this backup</button>
        : <button data-focusable className="primary" disabled={Boolean(busy) || !metadata.trim() || !content.trim()} onClick={() => { void run("Reviewing your backup…", async () => setPlan(await desktopApi.planLibraryImport(metadata, content))); }}>Review import</button>)}
    </div>
  </section></div>;
}

export function LibraryImportRecovery({ destination, onBusyChange }: { destination: string; onBusyChange?: (active: boolean) => void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const recover = async () => {
    setBusy(true); setError(undefined); onBusyChange?.(true);
    try { await desktopApi.recoverLibraryImport(destination); window.location.reload(); }
    catch (value) { setError(errorText(value)); } finally { setBusy(false); onBusyChange?.(false); }
  };
  return <section aria-label="Library import recovery">
    <p>Resume the import to verify and finish the restored copy. The original backup stays unchanged. Incomplete copies remain closed until recovery succeeds.</p>
    <button data-focusable disabled={busy} onClick={() => { void recover(); }}>Resume import</button>
    {busy && <p role="status">Recovering the library import…</p>}{error && <p role="alert">{error}</p>}
  </section>;
}
