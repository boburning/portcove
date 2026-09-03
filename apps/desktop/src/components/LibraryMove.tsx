import { useState } from "react";
import { join } from "@tauri-apps/api/path";
import { desktopApi } from "../api";
import { useDialogFocus } from "../dialog";
import { pickInstallFolder } from "../file-picker";
import type { LibraryMovePlan } from "../types";
import { errorText, formatBytes } from "../view-model";
import { NavigationHints } from "./ui";

export function LibraryMoveButton({ disabled }: { disabled: boolean }) {
  const [open, setOpen] = useState(false);
  return <><button data-focusable className="small-control" disabled={disabled} onClick={() => setOpen(true)}>Move library</button>
    {open && <LibraryMoveDialog close={() => setOpen(false)} />}</>;
}

function LibraryMoveDialog({ close }: { close: () => void }) {
  const [destination, setDestination] = useState("");
  const [plan, setPlan] = useState<LibraryMovePlan>();
  const [busy, setBusy] = useState("");
  const [error, setError] = useState<unknown>();
  const dismiss = () => { if (!busy) close(); };
  const dialog = useDialogFocus(dismiss);
  const recoveryRoot = transferRecoveryRoot(error);
  const run = async (label: string, operation: () => Promise<void>) => {
    setBusy(label); setError(undefined);
    try { await operation(); } catch (value) { setError(value); setPlan(undefined); } finally { setBusy(""); }
  };
  const browse = () => run("Choosing a destination…", async () => {
    const parent = await pickInstallFolder("");
    if (parent) { setDestination(await join(parent, "Portcove Library")); setPlan(undefined); }
  });
  return <div className="scrim"><section ref={dialog} className="modal" role="dialog" aria-modal="true" aria-labelledby="move-library-title">
    <p className="eyebrow">LIBRARY STORAGE</p><h2 id="move-library-title">Move your library</h2>
    <p className="modal-description">Copy and verify application versions, saves, backups, and toolchains before switching to the new folder. The original folder stays available for recovery. Original game sources stay at their current paths.</p>
    <NavigationHints />
    <label htmlFor="library-destination">New library folder</label><div className="path-entry">
      <input data-autofocus data-focusable id="library-destination" value={destination} disabled={Boolean(busy) || Boolean(recoveryRoot)} onChange={event => { setDestination(event.target.value); setPlan(undefined); }} placeholder="Full path to a new folder" />
      <button data-focusable disabled={Boolean(busy) || Boolean(recoveryRoot)} onClick={() => { void browse(); }}>Choose parent folder</button>
    </div>
    {plan && <LibraryCopySummary plan={plan} source={plan.source_root} label="Library move plan" />}
    {busy && <p role="status">{busy} Keep Portcove open until this finishes.</p>}
    {error != null && <p role="alert">{errorText(error)}</p>}
    {recoveryRoot && <LibraryMoveRecovery source={recoveryRoot} onBusyChange={active => setBusy(active ? "Recovering your library…" : "")} />}
    <div className="actions"><button data-focusable disabled={Boolean(busy)} onClick={dismiss}>Close</button>
      {!recoveryRoot && (plan
        ? <button data-focusable className="primary" disabled={Boolean(busy)} onClick={() => { void run("Copying and verifying your library…", async () => { await desktopApi.moveLibrary(plan.destination_root, plan.plan_sha256); window.location.reload(); }); }}>Move to this folder</button>
        : <button data-focusable className="primary" disabled={Boolean(busy) || !destination.trim()} onClick={() => { void run("Reviewing your library…", async () => setPlan(await desktopApi.planLibraryMove(destination))); }}>Review move</button>)}
    </div>
  </section></div>;
}

export function LibraryMoveRecovery({ source, onBusyChange }: { source: string; onBusyChange?: (active: boolean) => void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const recover = async (abort: boolean) => {
    setBusy(true); setError(undefined); onBusyChange?.(true);
    try { await desktopApi.recoverLibraryMove(source, abort); window.location.reload(); }
    catch (value) { setError(errorText(value)); } finally { setBusy(false); onBusyChange?.(false); }
  };
  return <section aria-label="Library move recovery">
    <p>A library move needs recovery. Resume verifies the copy before finishing. Abort returns to the original only while the new copy has not been activated. Both choices retain all copied files.</p>
    <div className="actions"><button data-focusable disabled={busy} onClick={() => { void recover(false); }}>Resume move</button>
      <button data-focusable disabled={busy} onClick={() => { void recover(true); }}>Abort move</button></div>
    {busy && <p role="status">Recovering the library move…</p>}{error && <p role="alert">{error}</p>}
  </section>;
}

export function transferRecoveryRoot(error: unknown, key: "retained_source" | "import_destination" = "retained_source"): string | undefined {
  if (typeof error !== "object" || !error || !("details" in error) || typeof error.details !== "object" || !error.details) return undefined;
  const details = error.details as Record<string, unknown>;
  return (details.transfer_id || details.recovery_action) && typeof details[key] === "string" ? details[key] : undefined;
}

export function LibraryCopySummary({ plan, source, label }: { plan: Pick<LibraryMovePlan, "content" | "metadata" | "destination_root" | "required_bytes" | "available_bytes">; source: string; label: string }) {
  return <section className="adoption-plan" aria-label={label}>
    <p>From <code>{source}</code><br />To <code>{plan.destination_root}</code></p>
    <ul>{plan.content.map(tree => <li key={tree.kind}>{tree.kind.replaceAll("_", " ")}: {tree.copy.files.length.toLocaleString()} files, {formatBytes(tree.copy.total_bytes)}</li>)}</ul>
    <p>{formatBytes(plan.required_bytes)} required, including working space. {formatBytes(plan.available_bytes)} available.</p>
    <p>Active, previous, and staged versions keep their identities. {plan.metadata.source_references.length} source references keep their existing paths.</p>
  </section>;
}
