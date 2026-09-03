import { useState } from "react";
import { desktopApi } from "../api";
import { useDialogFocus } from "../dialog";
import { pickInstallFolder } from "../file-picker";
import type { SourceDiscoveryReport, SourceProfile, SourceRecord } from "../types";
import { errorText, formatBytes, isCancellation } from "../view-model";
import { OperationCancellation } from "./OperationCancellation";
import { ChoiceMenu } from "./ChoiceMenu";
import { NavigationHints } from "./ui";

export function SourceDiscoveryButton({ profiles, disabled, onAdded }: { profiles: SourceProfile[]; disabled: boolean; onAdded?: () => Promise<void> }) {
  const [open, setOpen] = useState(false);
  return <><button data-focusable className="small-control" disabled={disabled || profiles.length === 0} onClick={() => setOpen(true)}>Find source files</button>
    {open && <SourceDiscoveryDialog profiles={profiles} onAdded={onAdded} close={() => setOpen(false)} />}</>;
}

function SourceDiscoveryDialog({ profiles, onAdded, close }: { profiles: SourceProfile[]; onAdded?: () => Promise<void>; close: () => void }) {
  const [root, setRoot] = useState("");
  const [profile, setProfile] = useState("");
  const [report, setReport] = useState<SourceDiscoveryReport>();
  const [busy, setBusy] = useState("");
  const [error, setError] = useState<string>();
  const [registered, setRegistered] = useState<string>();
  const [searchId, setSearchId] = useState<string>();
  const [notice, setNotice] = useState<string>();
  const dismiss = () => { if (!busy) close(); };
  const dialog = useDialogFocus(dismiss);
  const clear = () => { setReport(undefined); setRegistered(undefined); setError(undefined); setNotice(undefined); };
  const run = async (label: string, task: () => Promise<void>) => {
    setBusy(label); setError(undefined);
    try { await task(); } catch (value) { if (isCancellation(value)) setNotice("Search cancelled. No sources were registered."); else setError(errorText(value)); } finally { setBusy(""); setSearchId(undefined); }
  };
  const accept = (candidate: SourceRecord) => run("Validating the selected source…", async () => {
    await desktopApi.addSource(candidate.profile_id, candidate.path, candidate.sha256);
    setRegistered(candidate.path);
    await onAdded?.();
  });
  const choices = [{ value: "", label: "Choose a source profile" }, ...[...profiles].sort((left, right) => left.label.localeCompare(right.label)).map(item => ({ value: item.id, label: item.label }))];
  return <div className="scrim"><section className="modal wide-modal" ref={dialog} role="dialog" aria-modal="true" aria-labelledby="source-discovery-title">
    <p className="eyebrow">LOCAL SOURCES</p><h2 id="source-discovery-title">Find source files</h2>
    <p className="modal-description">Choose the source you need and a folder you own. Portcove searches only that folder, checks plausible files against the source profile, and lets you choose which validated file to register. Nothing is uploaded or moved.</p>
    <NavigationHints />
    <ChoiceMenu label="Source profile" value={profile} options={choices} disabled={Boolean(busy)} onChange={value => { setProfile(value); clear(); }} />
    <label htmlFor="source-search-root">Search folder</label><div className="path-entry">
      <input data-focusable id="source-search-root" value={root} disabled={Boolean(busy)} onChange={event => { setRoot(event.target.value); clear(); }} placeholder="Folder containing your original game files" />
      <button data-focusable disabled={Boolean(busy)} onClick={() => { void run("Choosing a folder…", async () => { const selected = await pickInstallFolder(root); if (selected) { setRoot(selected); clear(); } }); }}>Choose folder</button>
    </div>
    {busy && <p role="status">{busy}</p>}
    {notice && <p role="status">{notice}</p>}
    {searchId && <OperationCancellation key={searchId} operationId={searchId} label="Cancel search" />}
    {report && <section className="source-discovery-results" aria-label="Source search results">
      <p>{report.candidates.length} validated {report.candidates.length === 1 ? "match" : "matches"}. Checked {report.entries_examined.toLocaleString()} entries and hashed {formatBytes(report.hash_bytes)}.</p>
      {report.limits_reached.length > 0 && <p>Search limits reached ({report.limits_reached.map(limit => limit.replaceAll("_", " ")).join(", ")}). Choose a more specific folder to search further. You can also select a source file directly from the game’s details.</p>}
      {report.candidates.map(candidate => <div className="source-health-row" key={`${candidate.profile_id}:${candidate.path}`}>
        <div><code>{candidate.path}</code><span>{formatBytes(candidate.size)}</span></div>
        <button data-focusable disabled={Boolean(busy) || registered === candidate.path} onClick={() => { void accept(candidate); }}>{registered === candidate.path ? "Registered" : "Use this file"}</button>
      </div>)}
      {report.issues.map((issue, index) => <p key={`${issue.profile_id ?? issue.path}:${index}`}>{issue.message}{issue.path && <> <code>{issue.path}</code></>}</p>)}
      {report.issues_omitted > 0 && <p>{report.issues_omitted} additional issues were omitted.</p>}
    </section>}
    {registered && <p role="status">Source registered: <code>{registered}</code></p>}
    {error && <p role="alert">{error}</p>}
    <div className="actions"><button data-focusable disabled={Boolean(busy)} onClick={dismiss}>Close</button>
      <button data-focusable className="primary" disabled={Boolean(busy) || !profile || !root.trim()} onClick={() => { clear(); void run("Searching your selected folder…", async () => setReport(await desktopApi.discoverSources({ roots: [root], profile_ids: [profile] }, event => { if (event.type === "started") setSearchId(event.operation_id); }))); }}>Search this folder</button>
    </div>
  </section></div>;
}
