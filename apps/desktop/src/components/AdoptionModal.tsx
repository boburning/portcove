import { FolderInput, FolderOpen, ShieldCheck, X } from "lucide-react";
import { useDialogFocus } from "../dialog";
import { Icon } from "./ui";

export function AdoptionModal({ path, setPath, busy, close, adopt, pickFolder }: {
  path: string; setPath: (path: string) => void; busy?: string; close: () => void; adopt: () => void; pickFolder?: () => void;
}) {
  const dialog = useDialogFocus(close);
  return <div className="scrim"><section ref={dialog} className="modal" role="dialog" aria-modal="true" aria-labelledby="adopt-title" aria-describedby="adopt-description">
    <button data-focusable className="close icon-button" aria-label="Close adoption dialog" onClick={close}><Icon glyph={X} /></button>
    <span className="modal-icon"><Icon glyph={FolderInput} size="lg" /></span><p className="eyebrow">SAFE ADOPTION</p><h2 id="adopt-title">Bring an existing install into Portcove</h2>
    <p className="modal-description" id="adopt-description">Portcove previews the folder, identifies the port, and copies application files into its managed library. The original folder is never changed or deleted.</p>
    <p className="inline-assurance"><Icon glyph={ShieldCheck} /> Nothing is copied until the preview succeeds.</p>
    <label htmlFor="adopt-path">Existing installation folder</label><div className="path-entry"><input data-autofocus data-focusable id="adopt-path" value={path} onChange={event => setPath(event.target.value)} placeholder="Choose or paste the full folder path" />
      {pickFolder && <button data-focusable className="button-with-icon" type="button" onClick={pickFolder}><Icon glyph={FolderOpen} />Browse</button>}</div>
    <div className="actions"><button data-focusable onClick={close}>Cancel</button><button data-focusable className="primary button-with-icon" disabled={!path.trim() || Boolean(busy)} onClick={adopt}><Icon glyph={FolderInput} />{busy === "adopt" ? "Adopting…" : "Preview and adopt"}</button></div>
  </section></div>;
}
