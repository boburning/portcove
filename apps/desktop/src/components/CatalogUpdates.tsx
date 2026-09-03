import { useEffect, useState } from "react";
import { desktopApi } from "../api";
import { useDialogFocus } from "../dialog";
import { pickSignedCatalogPath } from "../file-picker";
import type { CatalogProvenance, CatalogStatus, CatalogUpdatePlan, CatalogUpdateSource } from "../types";
import { errorText, isCancellation } from "../view-model";
import { ChoiceMenu } from "./ChoiceMenu";
import { OperationCancellation } from "./OperationCancellation";
import { NavigationHints } from "./ui";

export function CatalogSettings({ provenance, disabled, onChanged }: { provenance?: CatalogProvenance; disabled: boolean; onChanged?: () => Promise<void> }) {
  const [open, setOpen] = useState(false);
  return <article className="settings-card" data-focus-group>
    <p className="eyebrow">CATALOG</p><h2>Catalog updates</h2>
    <CatalogOrigin provenance={provenance} />
    <p>Optional signed updates refresh port information and release locations. Choose a publisher you trust and review each update. The built-in catalog is always available offline.</p>
    <button data-focusable className="small-control" disabled={disabled} onClick={() => setOpen(true)}>Manage catalog updates</button>
    {open && <CatalogUpdatesDialog close={() => setOpen(false)} onChanged={onChanged} />}
  </article>;
}

function CatalogOrigin({ provenance }: { provenance?: CatalogProvenance }) {
  if (!provenance) return <p>Loading catalog information…</p>;
  return <><p>{provenance.origin === "embedded" ? "Built-in catalog" : `Signed catalog · version ${provenance.sequence}`}
    {provenance.origin === "signed_previous" && " · using the previous valid update"}</p>
    {provenance.expires_at && <p>Valid until {new Date(provenance.expires_at * 1000).toLocaleString()}.</p>}
    {provenance.fallback_reasons.map((reason, index) => <p key={`${index}:${reason}`}>Update unavailable: {reason}</p>)}</>;
}

function CatalogUpdatesDialog({ close, onChanged }: { close: () => void; onChanged?: () => Promise<void> }) {
  const [status, setStatus] = useState<CatalogStatus>();
  const [busy, setBusy] = useState("Loading catalog settings…");
  const [error, setError] = useState<string>();
  const [notice, setNotice] = useState<string>();
  const [operationId, setOperationId] = useState<string>();
  const dialog = useDialogFocus(() => { if (!busy) close(); });
  useEffect(() => {
    let current = true;
    void desktopApi.catalogStatus().then(value => { if (current) setStatus(value); })
      .catch(value => { if (current) setError(errorText(value)); }).finally(() => { if (current) setBusy(""); });
    return () => { current = false; };
  }, []);
  const run = async (label: string, task: () => Promise<void>) => {
    setBusy(label); setError(undefined); setNotice(undefined);
    try { await task(); } catch (value) {
      if (isCancellation(value)) setNotice("Catalog update cancelled."); else setError(errorText(value));
    } finally { setBusy(""); setOperationId(undefined); }
  };
  const changed = async (next: CatalogStatus | null) => {
    if (!next) return;
    setStatus(next);
    setNotice("Catalog settings saved.");
    await onChanged?.();
  };
  const actions = { busy: Boolean(busy), run, changed };
  return <div className="scrim"><section className="modal wide-modal catalog-update-dialog" ref={dialog} role="dialog" aria-modal="true" aria-labelledby="catalog-update-title">
    <p className="eyebrow">CATALOG</p><h2 id="catalog-update-title">Manage catalog updates</h2>
    <NavigationHints /><CatalogOrigin provenance={status?.provenance} />
    {status && <>
      <PublisherTrust status={status} {...actions} />
      <CatalogReview status={status} {...actions} started={setOperationId} />
      <CatalogSelection status={status} {...actions} />
    </>}
    {busy && <p role="status">{busy}</p>}
    {operationId && <OperationCancellation key={operationId} operationId={operationId} label="Cancel update" />}
    {notice && <p role="status">{notice}</p>}
    {error && <p role="alert">{error}</p>}
    <div className="actions"><button data-focusable disabled={Boolean(busy)} onClick={close}>Close</button></div>
  </section></div>;
}

interface CatalogActions {
  status: CatalogStatus;
  busy: boolean;
  run: (label: string, task: () => Promise<void>) => Promise<void>;
  changed: (status: CatalogStatus | null) => Promise<void>;
}

function PublisherTrust({ status, busy, run, changed }: CatalogActions) {
  const [publicKey, setPublicKey] = useState("");
  return <><h3>Trusted publishers</h3>
      <p>Use a publisher’s public key that you have verified with them. Trust allows that publisher to change release download locations.</p>
      {status.trusted_keys.length === 0 && <p>No publishers configured.</p>}
      {status.trusted_keys.map(key => <div className="source-health-row" key={key.key_id}>
        <div><span>Publisher fingerprint</span><code>{key.key_id}</code></div>
        <button data-focusable disabled={Boolean(busy)} onClick={() => { void run("Removing publisher…", async () => changed(await desktopApi.revokeCatalogKey(key.key_id, status.state_sha256))); }}>Remove trust</button>
      </div>)}
      <label htmlFor="catalog-public-key">Publisher public key (64 hex characters)</label>
      <div className="path-entry"><input data-focusable data-autofocus={status.trusted_keys.length === 0 || undefined} id="catalog-public-key" autoComplete="off" value={publicKey} disabled={Boolean(busy)} onChange={event => setPublicKey(event.target.value)} />
        <button data-focusable disabled={Boolean(busy) || !publicKey.trim()} onClick={() => { void run("Confirming publisher…", async () => { await changed(await desktopApi.trustCatalogKey(publicKey.trim())); }); }}>Trust publisher</button></div></>;
}

function CatalogReview({ status, busy, run, changed, started }: CatalogActions & { started: (id: string) => void }) {
  const [kind, setKind] = useState<CatalogUpdateSource["kind"]>("file");
  const [location, setLocation] = useState("");
  const [plan, setPlan] = useState<CatalogUpdatePlan>();
  useEffect(() => setPlan(undefined), [status.state_sha256]);
  return <><h3>Review an update</h3>
      <ChoiceMenu label="Update source" value={kind} options={[{ value: "file", label: "Local file" }, { value: "https", label: "HTTPS address" }]} disabled={Boolean(busy)} onChange={value => { setKind(value as CatalogUpdateSource["kind"]); setLocation(""); setPlan(undefined); }} />
      <label htmlFor="catalog-update-location">{kind === "file" ? "Signed catalog file" : "Signed catalog HTTPS address"}</label>
      <div className="path-entry"><input data-focusable data-autofocus={status.trusted_keys.length > 0 || undefined} id="catalog-update-location" value={location} disabled={Boolean(busy)} onChange={event => { setLocation(event.target.value); setPlan(undefined); }} />
        {kind === "file" && <button data-focusable disabled={Boolean(busy)} onClick={() => { void run("Choosing a catalog…", async () => { const path = await pickSignedCatalogPath(); if (path) { setLocation(path); setPlan(undefined); } }); }}>Choose file</button>}</div>
      <button data-focusable disabled={Boolean(busy) || !location.trim()} onClick={() => { void run("Verifying catalog…", async () => { setPlan(await desktopApi.planCatalogUpdate({ kind, value: location.trim() })); }); }}>Review update</button>
      {plan && <section aria-label="Catalog update review">
        <h3>Verified version {plan.sequence}</h3>
        <p>{plan.changed_port_ids.length} ports change. Valid until {new Date(plan.expires_at * 1000).toLocaleString()}.</p>
        <p>Publisher fingerprint: <code>{plan.key_id}</code></p>
        <p>{plan.changed_port_ids.join(", ") || "No port metadata changes."}</p>
        <button data-focusable className="primary" disabled={Boolean(busy)} onClick={() => { const reviewed = plan; setPlan(undefined); void run("Applying catalog update…", async () => {
          await changed(await desktopApi.applyCatalogUpdate(reviewed.source, reviewed.plan_sha256, event => { if (event.type === "started") started(event.operation_id); }));
        }); }}>Apply reviewed update</button>
      </section>}</>;
}

function CatalogSelection({ status, busy, run, changed }: CatalogActions) {
  return <div className="actions compact">
        <button data-focusable disabled={Boolean(busy) || !status.can_rollback} onClick={() => { void run("Restoring previous catalog…", async () => changed(await desktopApi.rollbackCatalog(status.state_sha256))); }}>Restore previous catalog</button>
        <button data-focusable disabled={Boolean(busy) || status.updates_enabled || !status.can_use_cached} onClick={() => { void run("Selecting cached catalog…", async () => changed(await desktopApi.useCachedCatalog(status.state_sha256))); }}>Use cached signed catalog</button>
        <button data-focusable disabled={Boolean(busy) || !status.updates_enabled} onClick={() => { void run("Selecting built-in catalog…", async () => changed(await desktopApi.useEmbeddedCatalog(status.state_sha256))); }}>Use built-in catalog</button>
      </div>;
}
