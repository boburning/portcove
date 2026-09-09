import { useState } from "react";
import { desktopApi } from "../api";
import { useDialogFocus } from "../dialog";
import type { PortDefinition, SourceRecord, SourceRemovalPreview } from "../types";
import { useActionReview } from "../use-action-review";

export function SourceRemovalControl({ source, generation, ports, disabled, onRemoved }: {
  source: SourceRecord; generation: number; ports: PortDefinition[]; disabled: boolean; onRemoved?: () => Promise<void>;
}) {
  const [open, setOpen] = useState(false);
  const [refreshError, setRefreshError] = useState(false);
  const completed = async () => {
    try { await onRemoved?.(); }
    catch { setRefreshError(true); }
  };
  return <><button data-focusable className="small-control danger" disabled={disabled} onClick={() => setOpen(true)}>Remove reference</button>
    {refreshError && <p role="status">The reference was removed. Refresh Settings to see the current source list.</p>}
    {open && <SourceRemovalDialog profileId={source.profile_id} generation={generation} ports={ports} close={() => setOpen(false)} onRemoved={completed} />}</>;
}

export function SourceRemovalDialog({ profileId, generation, ports, close, onRemoved }: {
  profileId: string; generation: number; ports: PortDefinition[]; close: () => void; onRemoved: () => Promise<void>;
}) {
  const { preview, pending, error, review, execute, dismiss } = useActionReview({
    identity: `${profileId}:${generation}`,
    load: () => desktopApi.previewSourceRemoval(profileId, generation),
    apply: async preview => {
      const result = await desktopApi.removeSource(profileId, preview.preview_sha256, generation);
      if (result === null) return "cancelled";
      await onRemoved();
      return true;
    },
    close, failureMessage: "The reference was not removed. Review the current source and affected games before trying again.",
  });
  const dialog = useDialogFocus(dismiss);
  return <div className="scrim"><section ref={dialog} className="modal" role="dialog" aria-modal="true" aria-labelledby="source-removal-title" aria-describedby="source-removal-description">
    <h2 id="source-removal-title">Review source-reference removal</h2>
    <p id="source-removal-description">Remove Portcove's saved reference to these game files. The files themselves will stay where they are.</p>
    {pending === "review" && <p role="status">Checking the source and affected games…</p>}
    {preview && <SourceRemovalDetails preview={preview} ports={ports} />}
    {error && <p role="alert">{error}</p>}
    <div className="actions"><button data-autofocus data-focusable disabled={pending === "apply"} onClick={dismiss}>Keep source reference</button>
      {!preview && <button data-focusable disabled={Boolean(pending)} onClick={() => { void review(); }}>Review source removal again</button>}
      {preview && <button data-focusable className="danger" disabled={Boolean(pending)} onClick={() => { void execute(); }}>{pending === "apply" ? "Waiting for source removal…" : "Continue to removal confirmation"}</button>}
    </div>
  </section></div>;
}

function SourceRemovalDetails({ preview, ports }: { preview: SourceRemovalPreview; ports: PortDefinition[] }) {
  const name = (id: string) => ports.find(port => port.id === id)?.name ?? id;
  return <section className="source-removal-details" aria-label="Affected games and preserved files">
    <p><strong>Reference removed:</strong> {preview.source.profile_id}</p><p>{preview.source.path}</p>
    <p>The registered file or folder, its contents, installed game versions, saves, backups and other source references are preserved. Only this library's reference is removed.</p>
    <h3>Installed games affected</h3>
    {preview.installed_dependent_port_ids.length ? <ul>{preview.installed_dependent_port_ids.map(id => <li key={id}>{name(id)}</li>)}</ul> : <p>No installed game currently depends on this reference.</p>}
    <p>These installed games lose this source reference. Actions that need the original files may require registering them again.</p>
    <details><summary>All catalog games using this source ({preview.dependent_port_ids.length})</summary><ul>{preview.dependent_port_ids.map(id => <li key={id}>{name(id)}</li>)}</ul></details>
    <p>To use these files again, add them and pass the current source checks. There is no one-click undo or automatic re-registration.</p>
    <p>If interrupted, reopen Settings and check whether the reference remains before trying again. Removing a reference never schedules deletion of the original files.</p>
  </section>;
}
