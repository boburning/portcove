import { FolderInput, FolderOpen, ShieldCheck, X } from "lucide-react";
import { formatBytes } from "../view-model";
import { useDialogFocus } from "../dialog";
import { Icon, NavigationHints } from "./ui";
import type { AdoptionPreview } from "../types";

export function AdoptionModal({ path, setPath, preview, busy, applying = false, copyFailed, close, review, adopt, pickFolder }: {
  path: string; setPath: (path: string) => void; preview?: AdoptionPreview; busy?: string; applying?: boolean; copyFailed?: boolean; close: () => void; review: () => void; adopt: () => void; pickFolder?: () => void;
}) {
  const dismiss = () => { if (!applying) close(); };
  const dialog = useDialogFocus(dismiss);
  return <div className="scrim"><section ref={dialog} className="modal" role="dialog" aria-modal="true" aria-labelledby="adopt-title" aria-describedby="adopt-description">
    <button data-focusable className="close icon-button" aria-label="Close adoption dialog" onClick={dismiss} disabled={applying}><Icon glyph={X} /></button>
    <span className="modal-icon"><Icon glyph={FolderInput} size="lg" /></span><p className="eyebrow">SAFE ADOPTION</p><h2 id="adopt-title">Bring an existing install into Portcove</h2>
    <p className="modal-description" id="adopt-description">Portcove previews the folder, identifies the port, and copies application files into its managed library. The original folder is never changed or deleted.</p>
    <p className="inline-assurance"><Icon glyph={ShieldCheck} /> Review first, then confirm before copying.</p>
    <NavigationHints />
    <label htmlFor="adopt-path">Existing installation folder</label><div className="path-entry"><input data-autofocus data-focusable id="adopt-path" value={path} disabled={Boolean(busy) || applying} onChange={event => setPath(event.target.value)} placeholder="Choose or paste the full folder path" />
      {pickFolder && <button data-focusable className="button-with-icon" type="button" disabled={Boolean(busy) || applying} onClick={pickFolder}><Icon glyph={FolderOpen} />Browse</button>}</div>
    {preview && <section className="adoption-plan" aria-label="Adoption copy plan">
      <p><strong>{preview.selected_port_id ?? (preview.detected_port_ids.join(", ") || "No port detected")}</strong></p>
      <p>{preview.copy_plan.files.length.toLocaleString()} {preview.copy_plan.files.length === 1 ? "file" : "files"} · {formatBytes(preview.copy_plan.total_bytes)} will be copied into the managed library.</p>
      {preview.copy_plan.skipped_entries.length > 0 && <details><summary>{preview.copy_plan.skipped_entries.length} skipped {preview.copy_plan.skipped_entries.length === 1 ? "entry" : "entries"}</summary><ul>
        {preview.copy_plan.skipped_entries.map(entry => <li key={entry.relative_path}><code>{entry.relative_path}</code> — {entry.reason}</li>)}
      </ul></details>}
      <p><strong>Original folder:</strong> {preview.source}</p>
      {preview.destination && <AdoptionConsequences destination={preview.destination} />}
      <p>The original folder, registered sources, existing backups and other games remain unchanged. Skipped entries stay only in the original folder.</p>
      <p>There is no single undo action. Removing the managed copy later does not restore overwritten saved files. Create a backup first if you need those files.</p>
      <p>Stop the game before copying. Once copying starts, this dialog cannot cancel it. If interrupted, recovery may finish a verified copy; check the library and saved data before retrying.</p>
    </section>}
    {copyFailed && <p role="alert">The copy could not be confirmed. Check the library and activity history before retrying, then review the current copy plan.</p>}
    <div className="actions"><button data-focusable onClick={dismiss} disabled={applying}>Keep original setup</button>{preview
      ? <button data-focusable className="primary button-with-icon" disabled={Boolean(busy) || applying || !preview.selected_port_id || !preview.destination} onClick={adopt}><Icon glyph={FolderInput} />{applying ? "Waiting for copy…" : "Continue to copy confirmation"}</button>
      : <button data-focusable className="primary button-with-icon" disabled={!path.trim() || Boolean(busy) || applying} onClick={review}><Icon glyph={FolderInput} />{busy === "preview adoption" ? "Reviewing…" : "Review copy plan"}</button>}</div>
  </section></div>;
}

function AdoptionConsequences({ destination }: { destination: NonNullable<AdoptionPreview["destination"]> }) {
  return <>
    <p><strong>Application destination:</strong> {destination.output_location.effective_output_directory}<br />A new version folder is created here and becomes active. Existing versions remain.</p>
    {destination.active_install && <p><strong>Current active version:</strong> {destination.active_install.version}<br />{destination.active_install.path}</p>}
    <p><strong>Saved-data destination:</strong> {destination.output_location.user_data_root}<br />{destination.current_user_data_files} existing {destination.current_user_data_files === 1 ? "file" : "files"}.</p>
    {destination.imported_user_data_paths.length > 0 ? <>
      <p>These saved-data paths are merged from the original folder. Matching saved files are replaced; other saved files remain. No automatic safety backup is created.</p>
      <ul>{destination.imported_user_data_paths.map(path => <li key={path}>{path}</li>)}</ul>
    </> : <p>No catalog-selected saved-data paths will be imported from this folder.</p>}
  </>;
}
