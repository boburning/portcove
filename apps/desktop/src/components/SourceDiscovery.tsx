import { useRef, useState } from "react";
import { desktopApi } from "../api";
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
import { errorText, formatBytes, formatCountMessage, isCancellation } from "../view-model";
import { OperationCancellation } from "./OperationCancellation";
import { ChoiceSelect } from "./ChoiceSelect";
import { NavigationHints } from "./ui";
import { Button } from "./ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogTitle } from "./ui/dialog";

const inboxLimits: SourceDiscoveryLimits = {
  max_entries: 10_000,
  max_depth: 6,
  max_file_bytes: 2 * 1024 * 1024 * 1024,
  max_hash_bytes: 16 * 1024 * 1024 * 1024,
  max_candidates: 64,
};

const importModes: Record<SourceImportMode, { label: string; explanation: string }> = {
  copy: {
    label: "Copy to Inbox",
    explanation: "The original stays in place after the verified Inbox copy is registered.",
  },
  move: {
    label: "Move to Inbox",
    explanation: "The original is removed only after the Inbox copy is verified and registered.",
  },
  use_current_location: {
    label: "Use current location",
    explanation: "No source bytes are copied or removed.",
  },
};

export function sourceDiscoveryResultSummary(
  exactMatches: number,
  entriesExamined: number,
  hashBytes: number,
) {
  const matches = formatCountMessage(exactMatches, {
    zero: "Found no exact matches.",
    one: "Found 1 exact match.",
    other: "Found {count} exact matches.",
    unknown: "Exact match count is unavailable.",
  });
  const entries = formatCountMessage(entriesExamined, {
    zero: "Checked no files or folders",
    one: "Checked 1 file or folder",
    other: "Checked {count} files and folders",
    unknown: "File and folder count is unavailable",
  });
  return `${matches} ${entries} (${formatBytes(hashBytes)} of verification data).`;
}

export function sourceDiscoveryLimitLabel(limit: string, source: "folder" | "inbox" = "folder") {
  const labels: Record<string, string> = {
    entries: "File and folder count",
    depth: "Folder depth",
    file_size: "Individual file size",
    hash_bytes: "Verification data",
    candidates: source === "folder" ? "Exact-match count" : "Possible matches checked",
  };
  return labels[limit] ?? "Another search safety limit";
}

export function sourceImportModePresentation(mode: string) {
  return Object.hasOwn(importModes, mode)
    ? { ...importModes[mode as SourceImportMode], known: true }
    : {
        label: "Import method unavailable",
        explanation:
          "This source import method is unavailable in this version. Cancel this review before choosing another method.",
        known: false,
      };
}

export function SourceDiscoveryButton({
  profiles,
  disabled,
  onAdded,
}: {
  profiles: SourceProfile[];
  disabled: boolean;
  onAdded?: () => Promise<unknown>;
}) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button
        data-focusable
        variant="outline"
        disabled={disabled || profiles.length === 0}
        onClick={() => setOpen(true)}
      >
        Choose game files
      </Button>
      {open && (
        <SourceDiscoveryDialog profiles={profiles} onAdded={onAdded} close={() => setOpen(false)} />
      )}
    </>
  );
}

export function sourceImportNotice(result: SourceImportResult) {
  switch (result.outcome) {
    case "copied_original_retained":
      return `Inbox copy registered. The original remains at ${result.retained_original_path ?? "its prior location"}.`;
    case "moved":
      return "Inbox copy verified and registered; the original was removed.";
    case "registered_current_location":
      return "Source registered at its current location.";
    case "copied":
      return "Inbox copy verified and registered; the original was retained.";
    case "reused_existing":
      return "Existing Inbox copy verified and registered; the original was retained.";
    default:
      return "Source import outcome is unavailable in this version. Review the current registration before another attempt.";
  }
}

function useSourceDiscoveryWorkflow(onAdded?: () => Promise<unknown>) {
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
    setReport(undefined);
    setInbox(undefined);
    setPlan(undefined);
    setRegistered(undefined);
    setError(undefined);
    setNotice(undefined);
    setOperationId(undefined);
  };
  const run = async (label: string, task: () => Promise<void>) => {
    setBusy(label);
    setError(undefined);
    try {
      await task();
    } catch (value) {
      if (isCancellation(value))
        setNotice("Operation cancelled. No unverified source was registered.");
      else setError(errorText(value));
    } finally {
      setBusy("");
      setOperationId(undefined);
    }
  };
  const trackStart = (event: { type: string; operation_id: string }) => {
    if (event.type === "started") setOperationId(event.operation_id);
  };
  const selectProfile = (value: string) => {
    setProfile(value);
    clearResults();
  };
  const updateRoot = (value: string) => {
    setRoot(value);
    clearResults();
  };
  const chooseRoot = () =>
    run("Choosing a folder…", async () => {
      const selected = await pickInstallFolder(root);
      if (selected) updateRoot(selected);
    });
  const openInbox = () =>
    run("Opening Source Inbox…", async () => {
      const paths = await desktopApi.openSourceInbox(profile);
      setNotice(`Opened ${paths.profile ?? paths.root}`);
    });
  const scanInbox = () => {
    clearResults();
    return run("Scanning Source Inbox…", async () =>
      setInbox(await desktopApi.scanSourceInbox(profile, inboxLimits, trackStart)),
    );
  };
  const search = () => {
    clearResults();
    return run("Searching your selected folder…", async () =>
      setReport(
        await desktopApi.discoverSources({ roots: [root], profile_ids: [profile] }, trackStart),
      ),
    );
  };
  const reviewImport = (candidate: SourceRecord, mode: SourceImportMode) =>
    run("Checking the source and destination…", async () => {
      setPlan(await desktopApi.planSourceImport(profile, candidate.path, mode));
      setNotice(undefined);
    });
  const applyImport = () => {
    if (!plan) return Promise.resolve();
    const presentation = sourceImportModePresentation(plan.mode);
    if (!presentation.known) {
      setError(presentation.explanation);
      return Promise.resolve();
    }
    return run(`${presentation.label}…`, async () => {
      const result = await desktopApi.importSource(
        plan.profile_id,
        plan.source.path,
        plan.mode,
        plan.plan_sha256,
        trackStart,
      );
      if (!result) {
        setNotice("Move cancelled. The original and registration were left unchanged.");
        return;
      }
      setRegistered(result.registered.path);
      setPlan(undefined);
      setNotice(sourceImportNotice(result));
      await onAdded?.();
    });
  };
  return {
    root,
    profile,
    report,
    inbox,
    plan,
    busy,
    error,
    registered,
    operationId,
    notice,
    selectProfile,
    updateRoot,
    chooseRoot,
    openInbox,
    scanInbox,
    search,
    reviewImport,
    applyImport,
    cancelReview: () => setPlan(undefined),
  };
}

type Workflow = ReturnType<typeof useSourceDiscoveryWorkflow>;

function DiscoveryResults({ workflow }: { workflow: Workflow }) {
  const { report, inbox, busy, registered, reviewImport } = workflow;
  const candidates =
    report?.candidates ??
    inbox?.candidates.flatMap((candidate) =>
      candidate.inspection.record ? [candidate.inspection.record] : [],
    ) ??
    [];
  const limits = [
    ...new Set([...(report?.limits_reached ?? []), ...(inbox?.stats.limits_reached ?? [])]),
  ];
  const issues = [...(report?.issues ?? []), ...(inbox?.stats.issues ?? [])];
  const limitSource = report ? "folder" : "inbox";
  if (!report && !inbox) return null;
  return (
    <section className="source-discovery-results" aria-label="Source search results">
      {limits.length > 0 && (
        <>
          <p>Search limits prevented every possible match from being checked.</p>
          <details>
            <summary data-focusable>Search limits</summary>
            <ul>
              {limits.map((limit) => (
                <li key={limit}>{sourceDiscoveryLimitLabel(limit, limitSource)}</li>
              ))}
            </ul>
          </details>
        </>
      )}
      {candidates.map((candidate) => (
        <div className="source-health-row" key={`${candidate.profile_id}:${candidate.path}`}>
          <div>
            <code>{candidate.path}</code>
            <span>{formatBytes(candidate.size)}</span>
          </div>
          <div className="actions">
            <Button
              data-focusable
              variant="outline"
              disabled={Boolean(busy) || registered === candidate.path}
              onClick={() => {
                void reviewImport(candidate, "copy");
              }}
            >
              Review copy
            </Button>
            <Button
              data-focusable
              variant="outline"
              disabled={Boolean(busy) || registered === candidate.path}
              onClick={() => {
                void reviewImport(candidate, "move");
              }}
            >
              Review move
            </Button>
            <Button
              data-focusable
              variant="outline"
              disabled={Boolean(busy) || registered === candidate.path}
              onClick={() => {
                void reviewImport(candidate, "use_current_location");
              }}
            >
              Review current location
            </Button>
          </div>
        </div>
      ))}
      {issues.map((issue, index) => (
        <p key={`${issue.profile_id ?? issue.path}:${index}`}>
          {issue.message}
          {issue.path && (
            <>
              {" "}
              <code>{issue.path}</code>
            </>
          )}
        </p>
      ))}
    </section>
  );
}

export function SourceImportReview({
  plan,
  busy,
  onCancel,
  onApply,
}: {
  plan?: SourceImportPlan;
  busy: boolean;
  onCancel: () => void;
  onApply: () => Promise<void>;
}) {
  if (!plan) return null;
  const presentation = sourceImportModePresentation(plan.mode);
  return (
    <section className="source-discovery-results" aria-label="Source import review">
      <h3>{presentation.label}</h3>
      <p>{presentation.explanation}</p>
      <p>
        Source: <code>{plan.source.path}</code>
      </p>
      <p>
        Registration: <code>{plan.destination}</code>
      </p>
      {plan.existing_registration && (
        <p>This replaces the current registration after the selected source is rechecked.</p>
      )}
      <div className="actions">
        <Button data-focusable variant="outline" disabled={busy} onClick={onCancel}>
          Cancel review
        </Button>
        {presentation.known && (
          <Button
            data-focusable
            variant={plan.mode === "move" ? "destructive" : "default"}
            disabled={busy}
            onClick={() => {
              void onApply();
            }}
          >
            {presentation.label}
          </Button>
        )}
      </div>
    </section>
  );
}

function SourceDiscoveryDialog({
  profiles,
  onAdded,
  close,
}: {
  profiles: SourceProfile[];
  onAdded?: () => Promise<unknown>;
  close: () => void;
}) {
  const workflow = useSourceDiscoveryWorkflow(onAdded);
  const [profileSelectOpen, setProfileSelectOpen] = useState(false);
  const profileSelectOpenRef = useRef(false);
  const profileSelectDismissal = useRef(false);
  const { root, profile, report, inbox, plan, busy, error, registered, operationId, notice } =
    workflow;
  const dismiss = () => {
    if (!busy) close();
  };
  const choices = [
    { value: "", label: "Choose the game files you need" },
    ...[...profiles]
      .sort((left, right) => left.label.localeCompare(right.label))
      .map((item) => ({ value: item.id, label: item.label })),
  ];
  return (
    <Dialog
      open
      onOpenChange={(nextOpen, eventDetails) => {
        const nestedEscape =
          eventDetails.reason === "escape-key" &&
          (profileSelectOpenRef.current || profileSelectDismissal.current);
        if (!nextOpen && nestedEscape) {
          profileSelectOpenRef.current = false;
          profileSelectDismissal.current = false;
          setProfileSelectOpen(false);
          eventDetails.cancel();
          requestAnimationFrame(() =>
            document.querySelector<HTMLElement>("#source-profile-select")?.focus(),
          );
          return;
        }
        profileSelectOpenRef.current = false;
        profileSelectDismissal.current = false;
        if (!nextOpen) dismiss();
      }}
    >
      <DialogContent
        showCloseButton={false}
        className="max-h-[calc(100dvh-var(--space-8))] w-[min(760px,90vw)] max-w-none gap-0 overflow-y-auto overscroll-contain p-8 [scroll-padding-block:var(--space-4)] sm:max-w-none"
        aria-describedby="source-discovery-description"
      >
        <p className="eyebrow">LOCAL SOURCES</p>
        <DialogTitle id="source-discovery-title" className="mb-2 text-xl">
          Choose game files
        </DialogTitle>
        <DialogDescription id="source-discovery-description" className="mb-2 leading-relaxed">
          Portcove searches only the folders you choose, checks possible matches, and lets you add
          an exact match. Nothing is uploaded or moved.
        </DialogDescription>
        <p className="mb-4 text-sm leading-relaxed text-pc-muted-foreground">
          After a match is found, review whether to copy it to Source Inbox, move it there, or use
          its current location.
        </p>
        <NavigationHints />
        <ChoiceSelect
          triggerId="source-profile-select"
          label="Required game files"
          value={profile}
          options={choices}
          disabled={Boolean(busy)}
          onChange={workflow.selectProfile}
          open={profileSelectOpen}
          onOpenChange={(nextOpen, reason) => {
            if (nextOpen) profileSelectOpenRef.current = true;
            if (!nextOpen && reason === "escape-key") profileSelectDismissal.current = true;
            setProfileSelectOpen(nextOpen);
          }}
          onOpenChangeComplete={(nextOpen) => {
            if (!nextOpen) {
              // Base UI may finish the Select dismissal before the parent Dialog
              // observes the same native Escape event. Keep the ownership marker
              // through that event turn so the Dialog can cancel its dismissal.
              setTimeout(() => {
                profileSelectOpenRef.current = false;
                profileSelectDismissal.current = false;
              }, 0);
            }
          }}
        />
        <div className="actions source-inbox-actions">
          <Button
            data-focusable
            variant="outline"
            disabled={Boolean(busy) || !profile}
            onClick={() => {
              void workflow.openInbox();
            }}
          >
            Open Source Inbox
          </Button>
          <Button
            data-focusable
            variant="outline"
            disabled={Boolean(busy) || !profile}
            onClick={() => {
              void workflow.scanInbox();
            }}
          >
            Scan Source Inbox
          </Button>
        </div>
        <label
          className="mb-2 block text-xs font-bold text-pc-muted-foreground"
          htmlFor="source-search-root"
        >
          Search folder
        </label>
        <div className="path-entry">
          <input
            data-focusable
            id="source-search-root"
            className="w-full rounded-[var(--radius-md)] border border-pc-input bg-[var(--color-bg-inset)] p-[11px] text-pc-foreground shadow-[inset_0_1px_2px_var(--color-bg)] outline-none focus-visible:border-pc-ring focus-visible:ring-3 focus-visible:ring-pc-ring/50"
            value={root}
            disabled={Boolean(busy)}
            onChange={(event) => workflow.updateRoot(event.target.value)}
            placeholder="Folder containing your original game files"
          />
          <Button
            data-focusable
            variant="outline"
            disabled={Boolean(busy)}
            onClick={() => {
              void workflow.chooseRoot();
            }}
          >
            Choose folder
          </Button>
        </div>
        {busy && <p role="status">{busy}</p>}
        {notice && <p role="status">{notice}</p>}
        {operationId && (
          <OperationCancellation
            key={operationId}
            operationId={operationId}
            label="Cancel operation"
          />
        )}
        {report && (
          <p>
            {sourceDiscoveryResultSummary(
              report.candidates.length,
              report.entries_examined,
              report.hash_bytes,
            )}
          </p>
        )}
        {inbox && (
          <section aria-label="Source Inbox scan result">
            <p>
              Inbox state: {inbox.state.replaceAll("_", " ")}.{" "}
              {formatCountMessage(inbox.stats.entries_examined, {
                zero: "Checked no files or folders",
                one: "Checked 1 file or folder",
                other: "Checked {count} files and folders",
                unknown: "File and folder count is unavailable",
              })}{" "}
              ({formatBytes(inbox.stats.hash_bytes)} of verification data).
            </p>
            {inbox.selected && (
              <p>
                Registered source: <code>{inbox.selected.path}</code>
              </p>
            )}
          </section>
        )}
        <DiscoveryResults workflow={workflow} />
        <SourceImportReview
          plan={plan}
          busy={Boolean(busy)}
          onCancel={workflow.cancelReview}
          onApply={workflow.applyImport}
        />
        {registered && (
          <p role="status">
            Source registered: <code>{registered}</code>
          </p>
        )}
        {error && <p role="alert">{error}</p>}
        <DialogFooter className="mt-4">
          <Button data-focusable variant="outline" disabled={Boolean(busy)} onClick={dismiss}>
            Close
          </Button>
          <Button
            data-focusable
            disabled={Boolean(busy) || !profile || !root.trim()}
            onClick={() => {
              void workflow.search();
            }}
          >
            Search this folder
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
