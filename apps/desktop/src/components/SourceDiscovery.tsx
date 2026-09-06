import { useState } from "react";
import { desktopApi } from "../api";
import { useDialogFocus } from "../dialog";
import { pickInstallFolder } from "../file-picker";
import type {
  SourceDiscoveryLimits,
  SourceDiscoveryReport,
  SourceImportMode,
  SourceImportResult,
  SourceImportPlan,
  SourceInboxResolution,
  SourceProfile,
  SourceRecord,
} from "../types";
import { errorText, formatBytes, isCancellation } from "../view-model";
import { OperationCancellation } from "./OperationCancellation";
import { ChoiceMenu } from "./ChoiceMenu";
import { NavigationHints } from "./ui";

const inboxLimits: SourceDiscoveryLimits = {
  max_entries: 10_000,
  max_depth: 6,
  max_file_bytes: 2 * 1024 * 1024 * 1024,
  max_hash_bytes: 16 * 1024 * 1024 * 1024,
  max_candidates: 64,
};

const modeLabel: Record<SourceImportMode, string> = {
  copy: "Copy to Inbox",
  move: "Move to Inbox",
  use_current_location: "Use current location",
};

export function SourceDiscoveryButton({ profiles, disabled, onAdded }: { profiles: SourceProfile[]; disabled: boolean; onAdded?: () => Promise<void> }) {
  const [open, setOpen] = useState(false);
  return <><button data-focusable className="small-control" disabled={disabled || profiles.length === 0} onClick={() => setOpen(true)}>Find source files</button>
    {open && <SourceDiscoveryDialog profiles={profiles} onAdded={onAdded} close={() => setOpen(false)} />}</>;
}

function importNotice(result: SourceImportResult) {
  switch (result.outcome) {
    case "copied_original_retained": return `Inbox copy registered. The original remains at ${result.retained_original_path ?? "its prior location"}.`;
    case "moved": return "Inbox copy verified and registered; the original was removed.";
    case "registered_current_location": return "Source registered at its current location.";
    default: return "Inbox copy verified and registered; the original was retained.";
  }
}

function useSourceDiscoveryWorkflow(onAdded?: () => Promise<void>) {
  const [root, setRoot] = useState("");
  const [profile, setProfile] = useState("");
  const [report, setReport] = useState<SourceDiscoveryReport>();
  const [inbox, setInbox] = useState<SourceInboxResolution>();
  const [plan, setPlan] = useState<SourceImportPlan>();
  const [busy, setBusy] = useState("");
  const [error, setError] = useState<string>();
  const [registered, setRegistered] = useState<string>();
  const [operationId, setOperationId] = useState<string>();
  const [notice, setNotice] = useState<string>();
  const clearResults = () => {
    setReport(undefined); setInbox(undefined); setPlan(undefined); setRegistered(undefined);
    setError(undefined); setNotice(undefined); setOperationId(undefined);
  };
  const run = async (label: string, task: () => Promise<void>) => {
    setBusy(label); setError(undefined);
    try { await task(); }
    catch (value) {
      if (isCancellation(value)) setNotice("Operation cancelled. No unverified source was registered.");
      else setError(errorText(value));
    } finally { setBusy(""); setOperationId(undefined); }
  };
  const trackStart = (event: { type: string; operation_id: string }) => {
    if (event.type === "started") setOperationId(event.operation_id);
  };
  const selectProfile = (value: string) => { setProfile(value); clearResults(); };
  const updateRoot = (value: string) => { setRoot(value); clearResults(); };
  const chooseRoot = () => run("Choosing a folder…", async () => {
    const selected = await pickInstallFolder(root);
    if (selected) updateRoot(selected);
  });
  const openInbox = () => run("Opening Source Inbox…", async () => {
    const paths = await desktopApi.openSourceInbox(profile);
    setNotice(`Opened ${paths.profile ?? paths.root}`);
  });
  const scanInbox = () => {
    clearResults();
    return run("Scanning Source Inbox…", async () => setInbox(await desktopApi.scanSourceInbox(profile, inboxLimits, trackStart)));
  };
  const search = () => {
    clearResults();
    return run("Searching your selected folder…", async () => setReport(await desktopApi.discoverSources({ roots: [root], profile_ids: [profile] }, trackStart)));
  };
  const reviewImport = (candidate: SourceRecord, mode: SourceImportMode) => run("Checking the source and destination…", async () => {
    setPlan(await desktopApi.planSourceImport(profile, candidate.path, mode));
    setNotice(undefined);
  });
  const applyImport = () => {
    if (!plan) return Promise.resolve();
    return run(`${modeLabel[plan.mode]}…`, async () => {
      const result = await desktopApi.importSource(plan.profile_id, plan.source.path, plan.mode, plan.plan_sha256, trackStart);
      if (!result) {
        setNotice("Move cancelled. The original and registration were left unchanged.");
        return;
      }
      setRegistered(result.registered.path);
      setPlan(undefined);
      setNotice(importNotice(result));
      await onAdded?.();
    });
  };
  return {
    root, profile, report, inbox, plan, busy, error, registered, operationId, notice,
    selectProfile, updateRoot, chooseRoot, openInbox, scanInbox, search, reviewImport,
    applyImport, cancelReview: () => setPlan(undefined),
  };
}

type Workflow = ReturnType<typeof useSourceDiscoveryWorkflow>;

function DiscoveryResults({ workflow }: { workflow: Workflow }) {
  const { report, inbox, busy, registered, reviewImport } = workflow;
  const candidates = report?.candidates ?? inbox?.candidates.flatMap(candidate => candidate.inspection.record ? [candidate.inspection.record] : []) ?? [];
  const limits = [...(report?.limits_reached ?? []), ...(inbox?.stats.limits_reached ?? [])];
  const issues = [...(report?.issues ?? []), ...(inbox?.stats.issues ?? [])];
  if (!report && !inbox) return null;
  return <section className="source-discovery-results" aria-label="Source search results">
    {limits.length > 0 && <p>Search limits were reached. Choose a more specific folder to finish checking candidates.</p>}
    {candidates.map(candidate => <div className="source-health-row" key={`${candidate.profile_id}:${candidate.path}`}>
      <div><code>{candidate.path}</code><span>{formatBytes(candidate.size)}</span></div>
      <div className="actions">
        <button data-focusable disabled={Boolean(busy) || registered === candidate.path} onClick={() => { void reviewImport(candidate, "copy"); }}>Review copy</button>
        <button data-focusable disabled={Boolean(busy) || registered === candidate.path} onClick={() => { void reviewImport(candidate, "move"); }}>Review move</button>
        <button data-focusable disabled={Boolean(busy) || registered === candidate.path} onClick={() => { void reviewImport(candidate, "use_current_location"); }}>Review current location</button>
      </div>
    </div>)}
    {issues.map((issue, index) => <p key={`${issue.profile_id ?? issue.path}:${index}`}>{issue.message}{issue.path && <> <code>{issue.path}</code></>}</p>)}
  </section>;
}

function ImportReview({ plan, busy, onCancel, onApply }: { plan?: SourceImportPlan; busy: boolean; onCancel: () => void; onApply: () => Promise<void> }) {
  if (!plan) return null;
  const explanation = plan.mode === "move"
    ? "The original is removed only after the Inbox copy is verified and registered."
    : plan.mode === "copy" ? "The original stays in place after the verified Inbox copy is registered." : "No source bytes are copied or removed.";
  return <section className="source-discovery-results" aria-label="Source import review">
    <h3>{modeLabel[plan.mode]}</h3><p>{explanation}</p>
    <p>Source: <code>{plan.source.path}</code></p><p>Registration: <code>{plan.destination}</code></p>
    {plan.existing_registration && <p>This replaces the current registration after the selected source is rechecked.</p>}
    <div className="actions"><button data-focusable disabled={busy} onClick={onCancel}>Cancel review</button><button data-focusable className="primary" disabled={busy} onClick={() => { void onApply(); }}>{modeLabel[plan.mode]}</button></div>
  </section>;
}

function SourceDiscoveryDialog({ profiles, onAdded, close }: { profiles: SourceProfile[]; onAdded?: () => Promise<void>; close: () => void }) {
  const workflow = useSourceDiscoveryWorkflow(onAdded);
  const { root, profile, report, inbox, plan, busy, error, registered, operationId, notice } = workflow;
  const dismiss = () => { if (!busy) close(); };
  const dialog = useDialogFocus(dismiss);
  const choices = [{ value: "", label: "Choose a source profile" }, ...[...profiles].sort((left, right) => left.label.localeCompare(right.label)).map(item => ({ value: item.id, label: item.label }))];
  return <div className="scrim"><section className="modal wide-modal" ref={dialog} role="dialog" aria-modal="true" aria-labelledby="source-discovery-title">
    <p className="eyebrow">LOCAL SOURCES</p><h2 id="source-discovery-title">Find source files</h2>
    <p className="modal-description">Choose the source you need. Portcove can scan its private Inbox or a folder you select, then review a safe copy, an explicit move, or registration at the current location. Source contents stay local.</p>
    <NavigationHints />
    <ChoiceMenu label="Source profile" value={profile} options={choices} disabled={Boolean(busy)} onChange={workflow.selectProfile} />
    <div className="actions source-inbox-actions">
      <button data-focusable disabled={Boolean(busy) || !profile} onClick={() => { void workflow.openInbox(); }}>Open Source Inbox</button>
      <button data-focusable disabled={Boolean(busy) || !profile} onClick={() => { void workflow.scanInbox(); }}>Scan Source Inbox</button>
    </div>
    <label htmlFor="source-search-root">Search folder</label><div className="path-entry">
      <input data-focusable id="source-search-root" value={root} disabled={Boolean(busy)} onChange={event => workflow.updateRoot(event.target.value)} placeholder="Folder containing your original game files" />
      <button data-focusable disabled={Boolean(busy)} onClick={() => { void workflow.chooseRoot(); }}>Choose folder</button>
    </div>
    {busy && <p role="status">{busy}</p>}{notice && <p role="status">{notice}</p>}
    {operationId && <OperationCancellation key={operationId} operationId={operationId} label="Cancel operation" />}
    {report && <p>{report.candidates.length} validated {report.candidates.length === 1 ? "match" : "matches"}. Checked {report.entries_examined.toLocaleString()} entries and hashed {formatBytes(report.hash_bytes)}.</p>}
    {inbox && <section aria-label="Source Inbox scan result"><p>Inbox state: {inbox.state.replaceAll("_", " ")}. Checked {inbox.stats.entries_examined.toLocaleString()} entries and hashed {formatBytes(inbox.stats.hash_bytes)}.</p>{inbox.selected && <p>Registered source: <code>{inbox.selected.path}</code></p>}</section>}
    <DiscoveryResults workflow={workflow} />
    <ImportReview plan={plan} busy={Boolean(busy)} onCancel={workflow.cancelReview} onApply={workflow.applyImport} />
    {registered && <p role="status">Source registered: <code>{registered}</code></p>}{error && <p role="alert">{error}</p>}
    <div className="actions"><button data-focusable disabled={Boolean(busy)} onClick={dismiss}>Close</button><button data-focusable className="primary" disabled={Boolean(busy) || !profile || !root.trim()} onClick={() => { void workflow.search(); }}>Search this folder</button></div>
  </section></div>;
}
