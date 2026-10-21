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
import { PreliminarySourceSelections } from "./PreliminarySourceSelections";
import { sourceAdmissionPresentation } from "./SourceIdentity";
import { ChoiceSelect } from "./ChoiceSelect";
import { NavigationHints } from "./ui";
import { Button } from "./ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogTitle } from "./ui/dialog";
import { Input } from "./ui/input";
import { Field } from "./ui/field";

const scanLimits: SourceDiscoveryLimits = {
  max_entries: 10_000,
  max_depth: 6,
  max_file_bytes: 2 * 1024 * 1024 * 1024,
  max_hash_bytes: 16 * 1024 * 1024 * 1024,
  max_candidates: 64,
};

const importModes: Record<SourceImportMode, { label: string; explanation: string }> = {
  copy: {
    label: "Copy into Portcove",
    explanation: "Keep the original and save a checked copy in Portcove's game-file folder.",
  },
  move: {
    label: "Move into Portcove",
    explanation:
      "Move the files into Portcove's game-file folder. The original is deleted only after the copy is checked and added.",
  },
  use_current_location: {
    label: "Use current location",
    explanation: "Use the files where they are. Keep this location available.",
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
    candidates: source === "folder" ? "Result count" : "Possible matches checked",
  };
  return labels[limit] ?? "Another search safety limit";
}

export function sourceDiscoveryLimitGuidance(limit: string, source: "folder" | "inbox" = "folder") {
  if (limit === "entries")
    return source === "inbox"
      ? "Open Portcove's game-file folder and temporarily move some files outside it. Search the files left there, then swap batches and search again."
      : "Choose a smaller folder and search again.";
  if (limit === "depth")
    return source === "inbox"
      ? "Open Portcove's game-file folder and move deeply nested files closer to its root, then search again."
      : "Choose a deeper folder as the search root and search again.";
  if (limit === "file_size")
    return `This scan skips files over ${formatBytes(scanLimits.max_file_bytes)}. The result does not identify which file hit this limit; check a suspected file from its game details.`;
  if (limit === "hash_bytes")
    return source === "inbox"
      ? `This search reached its ${formatBytes(scanLimits.max_hash_bytes)} checking limit. Open Portcove's game-file folder and temporarily move some files outside it. Search the files left there, then swap batches; a single file over the limit still cannot be checked.`
      : `This scan reached its ${formatBytes(scanLimits.max_hash_bytes)} verification-work budget. Search separate subfolders; a single file over the budget still cannot be checked.`;
  if (limit === "candidates")
    return source === "inbox"
      ? "Review the possible matches shown. Open Portcove's game-file folder and temporarily move some files outside it. Search the files left there, then swap batches to check the rest."
      : "Search a smaller folder to check more exact matches and preliminary selections.";
  return "Review the search limits and try a narrower search.";
}

export function inboxStateMessage(state: SourceInboxResolution["state"]) {
  const messages: Record<SourceInboxResolution["state"], string> = {
    registered: "Required files already added.",
    exact_match: "An exact match is available.",
    approval_required: "A possible match needs your review.",
    unresolved: "No matching files found.",
    conflict: "More than one match needs review.",
    incomplete: "The search could not check every file.",
  };
  return Object.hasOwn(messages, state) ? messages[state] : "Search result unavailable.";
}

export function sourceImportModePresentation(mode: string) {
  return Object.hasOwn(importModes, mode)
    ? { ...importModes[mode as SourceImportMode], known: true }
    : {
        label: "Import method unavailable",
        explanation:
          "This way of adding files is unavailable in this version. Cancel this review before choosing another method.",
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
  onAdded?: (() => Promise<unknown>) | undefined;
}) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button
        data-focusable
        data-settings-control="discover-sources"
        variant="outline"
        disabled={disabled || profiles.length === 0}
        onClick={() => setOpen(true)}
      >
        Find required files
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
      return `Portcove's copy was added. The original remains at ${result.retained_original_path ?? "its prior location"}.`;
    case "moved":
      return "Portcove's copy was checked and added; the original was removed.";
    case "registered_current_location":
      return "Saved the original file location. Keep it available.";
    case "copied":
      return "Portcove's copy was checked and added; the original was kept.";
    case "reused_existing":
      return "The existing Portcove copy was checked and added; the original was kept.";
    default:
      return "Portcove couldn't confirm how the files were added. Check their saved location before trying again.";
  }
}

export function sourceImportRefreshNotice(result: SourceImportResult) {
  if (
    ![
      "copied_original_retained",
      "moved",
      "registered_current_location",
      "copied",
      "reused_existing",
    ].includes(result.outcome)
  )
    return "Portcove couldn't confirm how the files were added, and the view couldn't refresh. Use Retry refresh to check the saved location before trying again.";
  return `${sourceImportNotice(result)} The view couldn't refresh. Use Retry refresh to check the current state; the files were already added.`;
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
    run("Opening Portcove game-file folder…", async () => {
      const paths = await desktopApi.openSourceInbox(profile);
      setNotice(`Opened ${paths.profile ?? paths.root}`);
    });
  const scanInbox = () => {
    clearResults();
    return run("Searching Portcove game-file folder…", async () =>
      setInbox(await desktopApi.scanSourceInbox(profile, scanLimits, trackStart)),
    );
  };
  const search = () => {
    clearResults();
    return run("Searching your selected folder…", async () =>
      setReport(
        await desktopApi.discoverSources(
          { roots: [root], profile_ids: [profile], limits: scanLimits },
          trackStart,
        ),
      ),
    );
  };
  const reviewImport = (
    candidate: Pick<SourceRecord, "profile_id" | "path">,
    mode: SourceImportMode,
  ) =>
    run("Checking the selected file and destination…", async () => {
      setPlan(await desktopApi.planSourceImport(candidate.profile_id, candidate.path, mode));
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
        setNotice("Move cancelled. The original files and saved location were left unchanged.");
        return;
      }
      setRegistered(result.registered.path);
      setPlan(undefined);
      setNotice(sourceImportNotice(result));
      try {
        await onAdded?.();
      } catch {
        setNotice(sourceImportRefreshNotice(result));
      }
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

function DiscoveryResults({
  workflow,
  profiles,
}: {
  workflow: Workflow;
  profiles: SourceProfile[];
}) {
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
    <section className="source-discovery-results" aria-label="File search results">
      {limits.length > 0 && (
        <>
          <p>Some files weren't checked because this scan reached a limit.</p>
          <details>
            <summary data-focusable>Search limits</summary>
            <ul>
              {limits.map((limit) => (
                <li key={limit}>
                  <strong>{sourceDiscoveryLimitLabel(limit, limitSource)}</strong> ·{" "}
                  {sourceDiscoveryLimitGuidance(limit, limitSource)}
                </li>
              ))}
            </ul>
          </details>
        </>
      )}
      {candidates.map((candidate) => (
        <div
          className="source-health-row grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-3 gap-y-1 rounded-pc-md border border-pc-border bg-[var(--color-bg-inset)] p-3"
          key={`${candidate.profile_id}:${candidate.path}`}
        >
          <div className="min-w-0">
            <code className="mt-1 block overflow-hidden bg-transparent p-0 [overflow-wrap:anywhere] text-ellipsis whitespace-normal text-pc-muted-foreground">
              {candidate.path}
            </code>
            <span>{formatBytes(candidate.size)}</span>
          </div>
          <div className="actions mt-[24px] flex flex-wrap gap-[8px] [&.compact]:mt-[14px]">
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
      <PreliminarySourceSelections
        selections={report?.preliminary_selections}
        profiles={profiles}
        disabled={Boolean(busy)}
        onReview={(candidate) => {
          void reviewImport(candidate, "use_current_location");
        }}
      />
      {issues.map((issue, index) => (
        <p key={`${issue.profile_id ?? issue.path}:${index}`}>
          {issue.message}
          {issue.path && (
            <>
              {" "}
              <code className="[overflow-wrap:anywhere] whitespace-normal">{issue.path}</code>
            </>
          )}
        </p>
      ))}
    </section>
  );
}

export function SourceImportReview({
  plan,
  profiles = [],
  busy,
  onCancel,
  onApply,
}: {
  plan?: SourceImportPlan | undefined;
  profiles?: Pick<SourceProfile, "id" | "label">[];
  busy: boolean;
  onCancel: () => void;
  onApply: () => Promise<void>;
}) {
  if (!plan) return null;
  const presentation = sourceImportModePresentation(plan.mode);
  const admission = sourceAdmissionPresentation(plan.admission_mode);
  const profile = profiles.find((candidate) => candidate.id === plan.profile_id);
  return (
    <section className="source-discovery-results" aria-label="Source import review">
      <h3>{presentation.label}</h3>
      <p>{presentation.explanation}</p>
      <p>
        File requirement: <strong>{profile?.label ?? plan.profile_id}</strong>
      </p>
      <p role={admission.known ? undefined : "alert"}>
        <strong>Source check: {admission.label}.</strong> {admission.explanation}
      </p>
      <p>
        Selected location:{" "}
        <code className="[overflow-wrap:anywhere] whitespace-normal">{plan.source.path}</code>
      </p>
      <p>
        {plan.mode === "use_current_location" ? "Saved file location" : "Portcove game-file folder"}
        : <code className="[overflow-wrap:anywhere] whitespace-normal">{plan.destination}</code>
      </p>
      {presentation.known && (
        <>
          {plan.mode !== "use_current_location" && plan.reuse_existing && (
            <p>
              An existing Portcove copy will be checked and reused. No new file copy is planned.
            </p>
          )}
          <p>Additional file data planned: {formatBytes(plan.required_bytes)}.</p>
        </>
      )}
      {plan.existing_registration && (
        <>
          <p>
            Currently saved location:{" "}
            <code className="[overflow-wrap:anywhere] whitespace-normal">
              {plan.existing_registration.path}
            </code>
          </p>
          <p>This updates the saved location after Portcove checks the expected files again.</p>
        </>
      )}
      <div className="actions mt-[24px] flex flex-wrap gap-[8px] [&.compact]:mt-[14px]">
        <Button data-focusable variant="outline" disabled={busy} onClick={onCancel}>
          Cancel review
        </Button>
        {presentation.known && admission.known && (
          <Button
            data-focusable
            variant={plan.mode === "move" ? "destructive" : "primary"}
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
  onAdded?: (() => Promise<unknown>) | undefined;
  close: () => void;
}) {
  const heading = useRef<HTMLHeadingElement>(null);
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
    { value: "", label: "Choose the required files" },
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
        initialFocus={heading}
        showCloseButton={false}
        reviewSize="wide"
        aria-describedby="source-discovery-description"
      >
        <p className="eyebrow mb-[6px] text-[length:var(--text-xs)] font-bold tracking-[0.16em] text-[var(--color-primary-text)]">
          REQUIRED FILES
        </p>
        <DialogTitle
          ref={heading}
          tabIndex={-1}
          id="source-discovery-title"
          className="mb-2 text-xl"
        >
          Find required files
        </DialogTitle>
        <DialogDescription id="source-discovery-description" className="mb-2 leading-relaxed">
          Searching does not upload or move your files. After finding a match, choose whether to use
          it where it is, copy it into Portcove, or move it.
        </DialogDescription>
        <p className="mb-4 text-sm leading-relaxed text-pc-muted-foreground">
          Portcove's game-file folder can hold files you choose to copy or move into your library.
        </p>
        <NavigationHints />
        <ChoiceSelect
          triggerId="source-profile-select"
          label="Required files"
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
        <div className="actions source-inbox-actions mt-[24px] flex flex-wrap gap-[8px] [&.compact]:mt-[14px]">
          <Button
            data-focusable
            variant="outline"
            disabled={Boolean(busy) || !profile}
            onClick={() => {
              void workflow.openInbox();
            }}
          >
            Open game-file folder
          </Button>
          <Button
            data-focusable
            variant="outline"
            disabled={Boolean(busy) || !profile}
            onClick={() => {
              void workflow.scanInbox();
            }}
          >
            Search game-file folder
          </Button>
        </div>
        <Field label="Search folder">
          <div className="grid min-w-0 gap-2 sm:grid-cols-[minmax(0,1fr)_auto] [&_input]:min-w-0">
            <Input
              data-focusable
              id="source-search-root"
              value={root}
              disabled={Boolean(busy)}
              onChange={(event) => workflow.updateRoot(event.target.value)}
              placeholder="Folder containing the required files"
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
        </Field>
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
          <section aria-label="Game-file folder search result">
            <p>
              {inboxStateMessage(inbox.state)}{" "}
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
                Saved file location: <code>{inbox.selected.path}</code>
              </p>
            )}
          </section>
        )}
        <DiscoveryResults workflow={workflow} profiles={profiles} />
        <SourceImportReview
          plan={plan}
          profiles={profiles}
          busy={Boolean(busy)}
          onCancel={workflow.cancelReview}
          onApply={workflow.applyImport}
        />
        {registered && (
          <p role="status">
            File location saved: <code>{registered}</code>
          </p>
        )}
        {error && <p role="alert">{error}</p>}
        <DialogFooter className="mt-4">
          <Button data-focusable variant="outline" disabled={Boolean(busy)} onClick={dismiss}>
            Close
          </Button>
          <Button
            data-focusable
            variant="primary"
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
