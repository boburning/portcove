import { useState } from "react";
import type { LucideIcon } from "lucide-react";
import { AlertTriangle, Check, Clipboard, ClipboardCheck, Download, History, LoaderCircle, PackageCheck, RefreshCw, ShieldCheck } from "lucide-react";
import { copyText } from "../clipboard";
import type { ActivityOperation, ActivityRecord, PortDefinition, PortStatus, ReconcileAction, UpdateCheckOutcome } from "../types";
import { EmptyState, Icon } from "./ui";

export function UpdateCenter({ ports, statuses, activities, outcomes, actions, busy, checkAll, applyPolicies, onSelect, onOpenSources }: {
  ports: PortDefinition[];
  statuses: Map<string, PortStatus>;
  activities: ActivityRecord[];
  outcomes: UpdateCheckOutcome[];
  actions: Map<string, ReconcileAction>;
  busy?: string;
  checkAll: () => void;
  applyPolicies: () => void;
  onSelect: (portId: string) => void;
  onOpenSources: () => void;
}) {
  const installed = ports.filter(port => statuses.get(port.id)?.active);
  const byPort = new Map(outcomes.map(outcome => [outcome.port_id, outcome]));
  const available = outcomes.filter(outcome => outcome.ok && outcome.result?.update_available).length;
  const failed = outcomes.filter(outcome => !outcome.ok).length;
  const staged = installed.filter(port => statuses.get(port.id)?.staged).length;
  return <section className="update-center">
    <div className="update-toolbar">
      <div className="update-stats">
        <UpdateStat label="Installed" value={installed.length} icon={PackageCheck} />
        <UpdateStat label="Available" value={available} icon={Download} accent={available > 0} />
        <UpdateStat label="Staged" value={staged} icon={ShieldCheck} accent={staged > 0} />
        <UpdateStat label="Failed" value={failed} icon={AlertTriangle} warning={failed > 0} />
      </div>
      <div className="update-buttons">
        <button data-focusable className="button-with-icon" disabled={Boolean(busy) || installed.length === 0} onClick={checkAll}><Icon glyph={RefreshCw} />{busy === "check installed" ? "Checking installed ports…" : "Check all ports"}</button>
        <button data-focusable className="primary button-with-icon" disabled={Boolean(busy) || installed.length === 0} onClick={applyPolicies}><Icon glyph={Download} />{busy === "apply policies" ? "Applying policies…" : "Apply update policies"}</button>
      </div>
    </div>
    <p className="update-explainer">Notify reports an update, Stage downloads it for later activation, and Automatic switches to the verified release while retaining rollback.</p>
    {installed.length === 0 ? <EmptyState icon={RefreshCw} eyebrow="UPDATE CENTER" title="No installed ports to check" description="Install or adopt a port first. Portcove will then track its channel, update policy, verified releases, and rollback state here." /> :
      <div className="update-list">{installed.map(port => {
        const status = statuses.get(port.id)!;
        const outcome = byPort.get(port.id);
        const action = actions.get(port.id);
        const state = updateState(status, outcome, action);
        return <button data-focusable className="update-row" key={port.id} title={outcome?.error?.message} onClick={() => onSelect(port.id)}>
          <div className={`update-mark ${state.tone}`}>{port.name.slice(0, 2).toUpperCase()}</div>
          <div className="update-title"><strong>{port.name}</strong><small>{status.channel} · {policyLabel(status.update_policy)}</small></div>
          <div className="update-version"><small>Installed</small><span>{status.active?.version}</span></div>
          <div className="update-version"><small>Latest</small><span>{outcome?.result?.release.version ?? "—"}</span></div>
          <span className={`update-state ${state.tone}`}>{state.label}</span>
          {outcome?.error && <small className="update-error">{outcome.error.message}</small>}
        </button>;
      })}</div>}
    <ActivityHistory ports={ports} activities={activities} onSelect={onSelect} onOpenSources={onOpenSources} />
  </section>;
}

function ActivityHistory({ ports, activities, onSelect, onOpenSources }: {
  ports: PortDefinition[];
  activities: ActivityRecord[];
  onSelect: (portId: string) => void;
  onOpenSources: () => void;
}) {
  const names = new Map(ports.map(port => [port.id, port.name]));
  return <section className="activity-history">
    <div className="activity-heading">
      <div><p className="eyebrow">SHARED LEDGER</p><h2>Recent activity</h2></div>
      <small>CLI and desktop operations use the same local history.</small>
    </div>
    {activities.length === 0 ? <div className="activity-empty"><Icon glyph={History} /><div><strong>No operations recorded yet</strong><span>Installs, updates, verification, rollback, adoption, and failures will appear here.</span></div></div> :
      <div className="activity-list">{activities.slice(0, 8).map(activity =>
        <ActivityRow activity={activity} names={names} onSelect={onSelect} onOpenSources={onOpenSources} key={activity.id} />
      )}</div>}
  </section>;
}

function ActivityRow({ activity, names, onSelect, onOpenSources }: {
  activity: ActivityRecord;
  names: ReadonlyMap<string, string>;
  onSelect: (portId: string) => void;
  onOpenSources: () => void;
}) {
  const target = activityTarget(activity, names);
  const presentation = activityPresentation(activity);
  const title = activity.message ?? (presentation.state === "unfinished" ? "No completion was recorded. Review the source or port before retrying." : undefined);
  return <div className={`activity-row ${presentation.state}`} title={title}>
    <span className="activity-indicator" aria-hidden="true"><Icon glyph={presentation.icon} size="sm" /></span>
    <div className="activity-main"><strong>{operationLabel(activity.operation)}</strong>
      <ActivityTargetLink activity={activity} target={target} onSelect={onSelect} onOpenSources={onOpenSources} />
    </div>
    <span className="activity-time">{presentation.time}</span>
    <span className="activity-status">{presentation.label}</span>
    {activity.message && <ActivityDetails message={activity.message} />}
  </div>;
}

function ActivityDetails({ message }: { message: string }) {
  const [copied, setCopied] = useState(false);
  return <details className="activity-details"><summary data-focusable>View technical details</summary><div><code>{message}</code><button data-focusable className="icon-button" aria-label="Copy technical details" onClick={() => { void copyText(message).then(() => { setCopied(true); window.setTimeout(() => setCopied(false), 1600); }).catch(() => setCopied(false)); }}><Icon glyph={copied ? ClipboardCheck : Clipboard} /></button></div></details>;
}

function ActivityTargetLink({ activity, target, onSelect, onOpenSources }: {
  activity: ActivityRecord;
  target: ReturnType<typeof activityTarget>;
  onSelect: (portId: string) => void;
  onOpenSources: () => void;
}) {
  if (target.portId) return <button data-focusable onClick={() => onSelect(target.portId!)}>{target.label}</button>;
  if (activity.target_kind === "source" && activity.target_id) return <button data-focusable onClick={onOpenSources}>{target.label}</button>;
  return <span>{target.label}</span>;
}

function activityTarget(activity: ActivityRecord, names: ReadonlyMap<string, string>) {
  const targetId = activity.target_id;
  const portId = activity.target_kind === "port" && targetId && names.has(targetId) ? targetId : undefined;
  return { portId, label: (portId && names.get(portId)) ?? targetId ?? "Portcove library" };
}

function operationLabel(operation: ActivityOperation) {
  const labels: Record<ActivityOperation, string> = {
    launch: "Launched port",
    check_update: "Checked for update",
    backup: "Backed up data",
    restore: "Restored data backup",
    delete_backup: "Deleted data backup",
    install: "Installed port",
    update: "Updated port",
    reconcile: "Applied update policy",
    verify_install: "Verified installation",
    activate: "Activated staged release",
    rollback: "Rolled back release",
    adopt: "Adopted installation",
    remove: "Removed managed files",
    remove_source: "Removed source reference",
    register_source: "Registered source",
    verify_source: "Verified source",
  };
  return labels[operation];
}

function formatActivityTime(timestamp: number) {
  return new Date(timestamp * 1000).toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

const unfinishedAfterSeconds = 24 * 60 * 60;

function activityPresentation(activity: ActivityRecord) {
  if (activity.status !== "running") return {
    state: activity.status,
    label: activity.status,
    time: formatActivityTime(activity.finished_at ?? activity.started_at),
    icon: activity.status === "succeeded" ? Check : AlertTriangle,
  };
  if (Date.now() / 1000 - activity.started_at >= unfinishedAfterSeconds) return {
    state: "unfinished",
    label: "unfinished",
    time: "No completion recorded",
    icon: AlertTriangle,
  };
  return { state: "running", label: "running", time: "In progress", icon: LoaderCircle };
}

function UpdateStat({ label, value, icon, accent, warning }: { label: string; value: number; icon: LucideIcon; accent?: boolean; warning?: boolean }) {
  return <div className={warning ? "update-stat warning" : accent ? "update-stat accent" : "update-stat"}><Icon glyph={icon} /><strong>{value}</strong><span>{label}</span></div>;
}

function policyLabel(policy: PortStatus["update_policy"]) {
  return policy === "automatic" ? "Automatic" : policy === "stage" ? "Stage" : "Notify";
}

function updateState(status: PortStatus, outcome?: UpdateCheckOutcome, action?: ReconcileAction) {
  if (!outcome) return status.staged ? { label: "Staged", tone: "staged" } : { label: "Not checked", tone: "muted" };
  if (!outcome.ok) return { label: "Check failed", tone: "failed" };
  if (action === "activated") return { label: "Updated", tone: "current" };
  if (action === "staged" || status.staged) return { label: "Staged", tone: "staged" };
  if (outcome.result?.update_available) return { label: "Available", tone: "available" };
  return { label: "Current", tone: "current" };
}
