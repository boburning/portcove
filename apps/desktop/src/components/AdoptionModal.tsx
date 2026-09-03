import { FolderInput, FolderOpen, ShieldCheck, X } from "lucide-react";
import { useDialogFocus } from "../dialog";
import { Icon } from "./ui";
import type { AdoptionPreview } from "../types";

export function AdoptionModal({ path, setPath, preview, busy, close, review, adopt, pickFolder }: {
  path: string; setPath: (path: string) => void; preview?: AdoptionPreview; busy?: string; close: () => void; review: () => void; adopt: () => void; pickFolder?: () => void;
}) {
  const dialog = useDialogFocus(close);
  return <div className="scrim"><section ref={dialog} className="modal" role="dialog" aria-modal="true" aria-labelledby="adopt-title" aria-describedby="adopt-description">
    <button data-focusable className="close icon-button" aria-label="Close adoption dialog" onClick={close}><Icon glyph={X} /></button>
    <span className="modal-icon"><Icon glyph={FolderInput} size="lg" /></span><p className="eyebrow">SAFE ADOPTION</p><h2 id="adopt-title">Bring an existing install into Portcove</h2>
    <p className="modal-description" id="adopt-description">Portcove previews the folder, identifies the port, and copies application files into its managed library. The original folder is never changed or deleted.</p>
    <p className="inline-assurance"><Icon glyph={ShieldCheck} /> Nothing is copied until the preview succeeds.</p>
    <label htmlFor="adopt-path">Existing installation folder</label><div className="path-entry"><input data-autofocus data-focusable id="adopt-path" value={path} onChange={event => setPath(event.target.value)} placeholder="Choose or paste the full folder path" />
      {pickFolder && <button data-focusable className="button-with-icon" type="button" onClick={pickFolder}><Icon glyph={FolderOpen} />Browse</button>}</div>
    {preview && <section className="adoption-plan" aria-label="Adoption copy plan">
      <p><strong>{preview.selected_port_id ?? (preview.detected_port_ids.join(", ") || "No port detected")}</strong></p>
      <p>{preview.copy_plan.files.length.toLocaleString()} {preview.copy_plan.files.length === 1 ? "file" : "files"} · {formatBytes(preview.copy_plan.total_bytes)} will be copied into the managed library.</p>
      {preview.copy_plan.skipped_entries.length > 0 && <details><summary>{preview.copy_plan.skipped_entries.length} skipped {preview.copy_plan.skipped_entries.length === 1 ? "entry" : "entries"}</summary><ul>
        {preview.copy_plan.skipped_entries.map(entry => <li key={entry.relative_path}><code>{entry.relative_path}</code> — {entry.reason}</li>)}
      </ul></details>}
      <p>The original folder will not be modified.</p>
    </section>}
    <div className="actions"><button data-focusable onClick={close}>Cancel</button>{preview
      ? <button data-focusable className="primary button-with-icon" disabled={Boolean(busy) || !preview.selected_port_id} onClick={adopt}><Icon glyph={FolderInput} />{busy === "adopt" ? "Adopting…" : "Copy into Portcove"}</button>
      : <button data-focusable className="primary button-with-icon" disabled={!path.trim() || Boolean(busy)} onClick={review}><Icon glyph={FolderInput} />{busy === "preview adoption" ? "Reviewing…" : "Review copy plan"}</button>}</div>
  </section></div>;
}

function formatBytes(bytes: number) {
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KiB", "MiB", "GiB", "TiB"];
  let value = bytes / 1024;
  let unit = units[0];
  for (let index = 1; index < units.length && value >= 1024; index += 1) {
    value /= 1024;
    unit = units[index];
  }
  return `${value.toFixed(value >= 10 ? 0 : 1)} ${unit}`;
}
