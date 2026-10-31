import { SettingsRow } from "./ui/patterns";
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { desktopApi } from "../api";
import { pickGameFileFolder } from "../file-picker";
import { useSetupSource } from "../features/app-shell/use-setup-source";
import {
  useGameFileScanObserver,
  gameFileScanLimits as scanLimits,
  maxAvailableRootsPerScan,
  availableRootCount,
  type GameFileScan,
} from "../features/game-file-discovery/use-game-file-scan";
import { LatestRequestGeneration } from "../shared/concurrency-state";
import type {
  GameFileRoot,
  GameFileScanSnapshot,
  PortDefinition,
  PortStatus,
  SourceImportPlan,
  SourceProfile,
  SourceRecord,
} from "../types";
import { errorText, formatBytes, formatCountMessage, isCancellation } from "../view-model";
import { OperationCancellation } from "./OperationCancellation";
import { PreliminarySourceSelections } from "./PreliminarySourceSelections";
import {
  SourceImportReview,
  sourceDiscoveryLimitLabel,
  sourceImportNotice,
  sourceImportRefreshNotice,
} from "./SourceDiscovery";
import { Button } from "./ui/button";
import { GameFileSetupReviews } from "./GameFileSetupReviews";

const setupReturnOrigin = "game-file-libraries-setup";

function portSetupLabel(status?: PortStatus) {
  if (!status) return "Readiness unavailable; refresh the workspace";
  if (status.active || status.external_runtime) return "Already in your library";
  const install = status.port_actions?.find((action) => action.action === "install");
  const external = status.port_actions?.find((action) => action.action === "register_external");
  const action = install?.reason === "route_not_offered" ? external : install;
  if (!action) return "Readiness unavailable; refresh the workspace";
  if (action.reason === "unsupported_platform") return "Unavailable on this platform";
  if (action.reason === "missing_bios") return "BIOS file needed";
  if (action.reason === "missing_source") return "Needs game files";
  if (action.reason === "definition_ineligible") return "Setup on hold";
  if (action.availability === "allowed") return "Ready for setup review";
  if (action.action === "register_external" && action.reason === "review_required")
    return "Choose an existing installation";
  return "Review setup requirements in game details";
}

function savedRootLimitGuidance(limit: string) {
  if (limit === "file_size")
    return `Files above ${formatBytes(scanLimits.max_file_bytes)} were skipped. Check a suspected file from its game details.`;
  if (limit === "depth") return "Update a saved folder to a deeper subfolder, then search again.";
  return "Remove or update saved folders to narrower subfolders, then search again. You can also use Find required files for one game.";
}

function CandidateIdentity({
  candidate,
  profiles,
}: {
  candidate: Pick<SourceRecord, "profile_id" | "path" | "size">;
  profiles: SourceProfile[];
}) {
  return (
    <>
      <strong>
        {profiles.find((profile) => profile.id === candidate.profile_id)?.label ??
          candidate.profile_id}
      </strong>
      <code className="mt-1 block overflow-hidden bg-transparent p-0 text-ellipsis whitespace-nowrap text-pc-muted-foreground">
        {candidate.path}
      </code>
      <span>{formatBytes(candidate.size)}</span>
    </>
  );
}

function CatalogPortAssociations({
  profileId,
  ports,
}: {
  profileId: string;
  ports: PortDefinition[];
}) {
  return (
    <span className="block">
      Catalog ports using this profile:{" "}
      {ports
        .filter(
          (port) => port.source_profile === profileId || port.bios_source_profile === profileId,
        )
        .map((port) => port.name)
        .join(", ") || "No catalog port currently uses this profile"}
    </span>
  );
}

function CandidateAction({
  candidate,
  registeredSources,
  statuses,
  ports,
  onOpenPort,
  busy,
  registrationConfirmed,
  workspaceRefreshFailed,
  stale = false,
  review,
  reviewLabel,
}: {
  candidate: Pick<SourceRecord, "profile_id" | "path" | "sha256">;
  registeredSources: SourceRecord[];
  statuses: ReadonlyMap<string, PortStatus>;
  ports: PortDefinition[];
  onOpenPort?: ((portId: string, originKey: string) => void) | undefined;
  busy: boolean;
  registrationConfirmed: boolean;
  workspaceRefreshFailed: boolean;
  stale?: boolean;
  review: () => void;
  reviewLabel: string;
}) {
  const alreadyAdded = registeredSources.some(
    (source) =>
      source.profile_id === candidate.profile_id &&
      source.path === candidate.path &&
      source.sha256 === candidate.sha256,
  );
  if (alreadyAdded) {
    const status = workspaceRefreshFailed
      ? "An earlier library view listed these game files. Refresh the workspace before continuing."
      : registrationConfirmed
        ? "Already added. Review game requirements in details."
        : "Already added. Refresh the library before continuing to a game.";
    const matchingPorts = ports.filter(
      (port) =>
        port.source_profile === candidate.profile_id ||
        port.bios_source_profile === candidate.profile_id,
    );
    return (
      <div className="source-candidate-actions flex min-w-0 flex-wrap justify-end gap-2 max-[55rem]:justify-start">
        <span className="basis-full text-end text-pc-muted-foreground max-[55rem]:text-start">
          {status}
        </span>
        {registrationConfirmed &&
          !workspaceRefreshFailed &&
          matchingPorts.map((port) => (
            <span
              className="basis-full text-end text-pc-muted-foreground max-[55rem]:text-start"
              key={`${port.id}-readiness`}
            >
              {port.name}: {portSetupLabel(statuses.get(port.id))}
            </span>
          ))}
        {onOpenPort &&
          matchingPorts.map((port) => (
            <Button
              key={port.id}
              data-focusable
              className="source-candidate-action h-auto min-h-(--control-height-md) max-w-full text-center [overflow-wrap:anywhere] whitespace-normal"
              variant="outline"
              disabled={busy || stale || !registrationConfirmed}
              onClick={() => onOpenPort(port.id, setupReturnOrigin)}
            >
              View {port.name} details
            </Button>
          ))}
        <Button
          data-focusable
          data-candidate-review
          className="source-candidate-action h-auto min-h-(--control-height-md) max-w-full text-center [overflow-wrap:anywhere] whitespace-normal"
          variant="outline"
          disabled={busy || stale}
          onClick={review}
        >
          {reviewLabel}
        </Button>
      </div>
    );
  }
  return (
    <Button
      data-focusable
      data-candidate-review
      variant="outline"
      disabled={busy || stale}
      onClick={review}
    >
      {reviewLabel}
    </Button>
  );
}

function ContinueToGame({
  registeredSource,
  sourceVisible,
  busy,
  retryRefresh,
  ports,
  onOpenPort,
}: {
  registeredSource?: SourceRecord | undefined;
  sourceVisible: boolean;
  busy: boolean;
  retryRefresh?: (() => void) | undefined;
  ports: PortDefinition[];
  onOpenPort?: ((portId: string, originKey: string) => void) | undefined;
}) {
  if (!registeredSource || !onOpenPort) return null;
  const matchingPorts = ports.filter(
    (port) =>
      port.source_profile === registeredSource.profile_id ||
      port.bios_source_profile === registeredSource.profile_id,
  );
  if (matchingPorts.length === 0) return null;
  return (
    <section className="source-discovery-results" aria-label="Continue to a game">
      <h3>Continue with a game</h3>
      <p>
        {sourceVisible
          ? "The game-file location is saved. Open a game to review its remaining requirements and setup options."
          : "The game files were added, but this view has not refreshed. Use Retry refresh before continuing to a game."}
      </p>
      {!sourceVisible && retryRefresh && (
        <Button data-focusable variant="outline" disabled={busy} onClick={retryRefresh}>
          Retry refresh
        </Button>
      )}
      <div className="actions flex flex-wrap gap-2">
        {matchingPorts.map((port) => (
          <Button
            key={port.id}
            data-focusable
            variant="outline"
            disabled={!sourceVisible}
            onClick={() => onOpenPort(port.id, setupReturnOrigin)}
          >
            Open {port.name} details
          </Button>
        ))}
      </div>
    </section>
  );
}

function useContinuationSource(
  registeredSources: SourceRecord[],
  setupSource?: SourceRecord,
  setSetupSource?: (source?: SourceRecord) => void,
) {
  const [localSource, setLocalSource] = useSetupSource(registeredSources);
  return setSetupSource
    ? ([setupSource, setSetupSource] as const)
    : ([localSource, setLocalSource] as const);
}

function savedScanAction(
  snapshot: GameFileScanSnapshot | null | undefined,
  readConfirmed: boolean,
) {
  if (!readConfirmed) return "Scan saved folders";
  if (snapshot?.coverage?.restart_required) return "Start new scan";
  if (snapshot?.freshness !== "inputs_match") return "Scan saved folders";
  if (snapshot.coverage?.can_resume) return "Continue scan";
  return "Scan saved folders";
}

function CandidateRow({
  candidate,
  profiles,
  ports,
  completed,
  children,
}: {
  candidate: Pick<SourceRecord, "profile_id" | "path" | "size">;
  profiles: SourceProfile[];
  ports: PortDefinition[];
  completed: boolean;
  children: import("react").ReactNode;
}) {
  return (
    <div
      className="source-health-row grid grid-cols-[minmax(0,1fr)_minmax(0,18rem)] items-center gap-x-3 gap-y-1 border-b border-pc-border py-4 max-[55rem]:grid-cols-[minmax(0,1fr)]"
      data-candidate-row
      data-completed-candidate={completed || undefined}
      data-live-candidate={!completed || undefined}
      data-profile-id={candidate.profile_id}
      data-path={candidate.path}
    >
      <div className="min-w-0">
        <CandidateIdentity candidate={candidate} profiles={profiles} />
        <CatalogPortAssociations profileId={candidate.profile_id} ports={ports} />
      </div>
      {children}
    </div>
  );
}

function CompletedScan({
  snapshot,
  readConfirmed,
  roots,
  ports,
  profiles,
  registeredSources,
  statuses,
  registrationConfirmed,
  workspaceRefreshFailed,
  onOpenPort,
  busy,
  review,
}: {
  snapshot?: GameFileScanSnapshot | null | undefined;
  readConfirmed: boolean;
  roots?: GameFileRoot[] | undefined;
  ports: PortDefinition[];
  profiles: SourceProfile[];
  registeredSources: SourceRecord[];
  statuses: ReadonlyMap<string, PortStatus>;
  registrationConfirmed: boolean;
  workspaceRefreshFailed: boolean;
  onOpenPort?: ((portId: string, originKey: string) => void) | undefined;
  busy: boolean;
  review: (candidate: Pick<SourceRecord, "profile_id" | "path">) => void;
}) {
  const report = snapshot?.report;
  if (!snapshot || !report) return null;
  const coverage = snapshot.coverage;
  const canContinue = savedScanAction(snapshot, readConfirmed) === "Continue scan";
  return (
    <section className="source-discovery-results" aria-label="Saved folder scan results">
      <h3>Last completed scan</h3>
      <p>
        {!readConfirmed
          ? "This saved-folder view needs a refresh before using scan results. Use Refresh folders to check the current state."
          : snapshot.freshness === "inputs_match"
            ? "Saved roots and catalog match this snapshot. Files may have changed since the scan."
            : "Saved roots, availability, catalog, or search rules changed. Scan again before using these results."}
      </p>
      {coverage && (
        <p>
          {formatCountMessage(coverage.batches, {
            zero: "No scan batches were recorded.",
            one: "These totals cover 1 scan batch.",
            other: "These totals cover {count} scan batches.",
            unknown: "The number of scan batches is unavailable.",
          })}{" "}
          {coverage.restart_required
            ? "The saved scan cannot continue. Start a new scan to check the current folders."
            : coverage.frontier_exhausted
              ? "No more entries remain in this scan's folder list. Skipped files and search limits still apply."
              : coverage.remaining_entries === null
                ? "The number of remaining entries is unknown."
                : formatCountMessage(coverage.remaining_entries, {
                    zero: "No remaining entries were reported.",
                    one: "1 entry remains to be checked.",
                    other: "{count} entries remain to be checked.",
                    unknown: "The number of remaining entries is unknown.",
                  })}{" "}
          {canContinue &&
            "Continue the scan to check another bounded batch without moving your files."}
        </p>
      )}
      <p>
        Checked {report.entries_examined} entries in {report.searched_roots.length} available
        folders.{" "}
        {formatCountMessage(report.candidates.length, {
          zero: "Found no exact matches.",
          one: "Found 1 exact match.",
          other: "Found {count} exact matches.",
          unknown: "Exact match count is unavailable.",
        })}{" "}
        This scan does not assess every source format or establish gameplay support.
      </p>
      {roots?.some((root) => root.availability === "unavailable") && (
        <p>Unavailable saved folders were not searched.</p>
      )}
      {report.limits_reached.length > 0 && (
        <ul>
          {report.limits_reached.map((limit) => (
            <li key={limit}>
              {sourceDiscoveryLimitLabel(limit)}:{" "}
              {(limit === "entries" || limit === "hash_bytes") && canContinue
                ? "Continue the scan to check the next batch. Earlier matches were kept."
                : savedRootLimitGuidance(limit)}
            </li>
          ))}
        </ul>
      )}
      {report.candidates.map((candidate) => (
        <CandidateRow
          candidate={candidate}
          profiles={profiles}
          ports={ports}
          completed={true}
          key={`${candidate.profile_id}:${candidate.path}`}
        >
          <CandidateAction
            candidate={candidate}
            registeredSources={registeredSources}
            statuses={statuses}
            registrationConfirmed={registrationConfirmed}
            workspaceRefreshFailed={workspaceRefreshFailed}
            ports={ports}
            onOpenPort={onOpenPort}
            busy={busy}
            stale={!readConfirmed || snapshot.freshness !== "inputs_match"}
            review={() => review(candidate)}
            reviewLabel="Review game files"
          />
        </CandidateRow>
      ))}
      <PreliminarySourceSelections
        headingLevel={4}
        selections={report.preliminary_selections}
        profiles={profiles}
        disabled={busy || !readConfirmed || snapshot.freshness !== "inputs_match"}
        onReview={review}
        renderActions={(candidate) => (
          <>
            <CatalogPortAssociations profileId={candidate.profile_id} ports={ports} />
            <CandidateAction
              candidate={candidate}
              registeredSources={registeredSources}
              statuses={statuses}
              registrationConfirmed={registrationConfirmed}
              workspaceRefreshFailed={workspaceRefreshFailed}
              ports={ports}
              onOpenPort={onOpenPort}
              busy={busy}
              stale={!readConfirmed || snapshot.freshness !== "inputs_match"}
              review={() => review(candidate)}
              reviewLabel="Review preliminary selection"
            />
          </>
        )}
      />
      {report.issues.map((issue, index) => (
        <p key={`${issue.path}:${index}`}>
          {issue.message}{" "}
          {issue.path && (
            <code className="[overflow-wrap:anywhere] whitespace-normal">{issue.path}</code>
          )}
        </p>
      ))}
      {report.issues_omitted > 0 && <p>{report.issues_omitted} more scan issues were omitted.</p>}
    </section>
  );
}

function SavedRootRows({
  roots,
  busy,
  scanning,
  removingId,
  setRemovingId,
  relink,
  remove,
}: {
  roots?: GameFileRoot[] | undefined;
  busy: boolean;
  scanning: boolean;
  removingId?: string | undefined;
  setRemovingId: (id?: string) => void;
  relink: (root: GameFileRoot) => void;
  remove: (root: GameFileRoot) => void;
}) {
  if (roots === undefined) return <p role="status">Loading saved folders…</p>;
  if (roots.length === 0) return <p>No folders saved yet.</p>;
  return (
    <div className="source-health-list my-4 grid gap-2">
      {roots.map((root) => (
        <div
          className="source-health-row grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-3 gap-y-1 border-b border-pc-border py-4 max-[55rem]:grid-cols-[minmax(0,1fr)]"
          key={root.id}
          data-game-file-root={root.id}
        >
          <div className="min-w-0">
            <code className="mt-1 block overflow-hidden bg-transparent p-0 text-ellipsis whitespace-nowrap text-pc-muted-foreground">
              {root.path}
            </code>
            <span>
              {root.availability === "available"
                ? "Available"
                : "Unavailable — reconnect or relink this folder"}
            </span>
          </div>
          <div className="actions flex flex-wrap gap-2">
            <Button
              data-focusable
              variant="outline"
              disabled={busy || scanning}
              onClick={() => relink(root)}
            >
              Relink
            </Button>
            {removingId === root.id ? (
              <>
                <Button
                  data-focusable
                  variant="destructive"
                  disabled={busy || scanning}
                  onClick={() => remove(root)}
                >
                  Remove saved folder
                </Button>
                <Button data-focusable variant="outline" onClick={() => setRemovingId(undefined)}>
                  Keep folder
                </Button>
              </>
            ) : (
              <Button
                data-focusable
                variant="outline"
                disabled={busy || scanning}
                onClick={() => setRemovingId(root.id)}
              >
                Remove
              </Button>
            )}
          </div>
        </div>
      ))}
    </div>
  );
}

function LiveScanResults({
  candidates,
  profiles,
  registeredSources,
  statuses,
  registrationConfirmed,
  workspaceRefreshFailed,
  ports,
  onOpenPort,
  busy,
  review,
}: {
  candidates: Pick<SourceRecord, "profile_id" | "path" | "sha256" | "size">[];
  profiles: SourceProfile[];
  registeredSources: SourceRecord[];
  statuses: ReadonlyMap<string, PortStatus>;
  registrationConfirmed: boolean;
  workspaceRefreshFailed: boolean;
  ports: PortDefinition[];
  onOpenPort?: ((portId: string, originKey: string) => void) | undefined;
  busy: boolean;
  review: (candidate: Pick<SourceRecord, "profile_id" | "path">) => void;
}) {
  if (candidates.length === 0) return null;
  return (
    <section className="source-discovery-results" aria-label="Matches found during scan">
      <h3>Matches found so far</h3>
      <p>
        These exact file matches are provisional while the scan continues. You can review one now;
        Portcove checks its current files again before adding it as a source.
      </p>
      {candidates.map((candidate) => (
        <CandidateRow
          candidate={candidate}
          profiles={profiles}
          ports={ports}
          completed={false}
          key={`${candidate.profile_id}:${candidate.path}`}
        >
          <CandidateAction
            candidate={candidate}
            registeredSources={registeredSources}
            statuses={statuses}
            registrationConfirmed={registrationConfirmed}
            workspaceRefreshFailed={workspaceRefreshFailed}
            ports={ports}
            onOpenPort={onOpenPort}
            busy={busy}
            review={() => review(candidate)}
            reviewLabel="Review game files now"
          />
        </CandidateRow>
      ))}
    </section>
  );
}

function useSavedFolderView(generation: number, setError: (error: string) => void) {
  const [roots, setRoots] = useState<GameFileRoot[]>();
  const [snapshot, setSnapshot] = useState<GameFileScanSnapshot | null>();
  const [readConfirmed, setReadConfirmed] = useState(false);
  const requests = useRef(new LatestRequestGeneration());
  const refreshRoots = useCallback(async () => {
    const savedRoots = await desktopApi.gameFileRoots(generation);
    return savedRoots;
  }, [generation]);
  const refresh = useCallback(
    async (reportErrors = false) => {
      const request = requests.current.begin();
      setReadConfirmed(false);
      const [rootResult, snapshotResult] = await Promise.allSettled([
        refreshRoots().then((savedRoots) => {
          if (requests.current.isCurrent(request)) setRoots(savedRoots);
          return savedRoots;
        }),
        desktopApi.gameFileScanSnapshot(generation),
      ]);
      if (requests.current.isCurrent(request)) {
        if (rootResult.status === "fulfilled") setRoots(rootResult.value);
        if (snapshotResult.status === "fulfilled") setSnapshot(snapshotResult.value);
        setReadConfirmed(
          rootResult.status === "fulfilled" && snapshotResult.status === "fulfilled",
        );
      }
      const failure =
        rootResult.status === "rejected"
          ? rootResult
          : snapshotResult.status === "rejected"
            ? snapshotResult
            : undefined;
      if (failure) {
        if (reportErrors && requests.current.isCurrent(request))
          setError(errorText(failure.reason));
        throw failure.reason;
      }
      if (rootResult.status === "rejected") throw rootResult.reason;
      return rootResult.value;
    },
    [generation, refreshRoots, setError],
  );
  useEffect(() => {
    const reads = requests.current;
    let observing = true;
    void Promise.resolve()
      .then(() => {
        if (observing) return refresh(true);
      })
      .catch(() => {});
    return () => {
      observing = false;
      reads.begin();
    };
  }, [refresh, setError]);
  return {
    roots,
    snapshot,
    setSnapshot,
    readConfirmed,
    refresh,
    refreshRoots,
    acceptRootPreflight: (savedRoots: GameFileRoot[]) => {
      setRoots(savedRoots);
      setReadConfirmed(false);
    },
  };
}

function useCompletedScanView(
  scanState: GameFileScan,
  { refresh, setSnapshot }: ReturnType<typeof useSavedFolderView>,
  setError: (error: string) => void,
) {
  const [viewCompletion, setViewCompletion] = useState(0);
  useEffect(() => {
    if (!scanState.completion || scanState.scanning) return;
    let observing = true;
    if (scanState.result) setSnapshot(scanState.result);
    void refresh()
      .catch((value: unknown) => {
        if (observing) setError(errorText(value));
      })
      .finally(() => {
        if (observing) setViewCompletion(scanState.completion);
      });
    return () => {
      observing = false;
    };
  }, [scanState.completion, scanState.result, scanState.scanning, refresh, setSnapshot, setError]);
  return viewCompletion;
}

export function GameFileLibraries({
  instanceId = "game-file-libraries",
  generation,
  ports,
  profiles,
  registeredSources = [],
  statuses = new Map(),
  workspaceRefreshFailed = false,
  onAdded,
  onOpenPort,
  setupSource,
  setSetupSource,
}: {
  instanceId?: string;
  generation: number;
  ports: PortDefinition[];
  profiles: SourceProfile[];
  registeredSources?: SourceRecord[];
  statuses?: ReadonlyMap<string, PortStatus>;
  workspaceRefreshFailed?: boolean;
  onAdded?: (() => Promise<unknown>) | undefined;
  onOpenPort?: ((portId: string, originKey: string) => void) | undefined;
  setupSource?: SourceRecord | undefined;
  setSetupSource?: ((source?: SourceRecord) => void) | undefined;
}) {
  const headingId = `${instanceId}-heading`;
  const returnOrigin = `${instanceId}-setup`;
  const openPort = onOpenPort ? (id: string) => onOpenPort(id, returnOrigin) : undefined;
  const [busy, setBusy] = useState("");
  const scanState = useGameFileScanObserver(generation);
  const { scanning, operationId, candidates: liveCandidates } = scanState;
  const [error, setError] = useState<string>();
  const view = useSavedFolderView(generation, setError);
  const { roots, snapshot, readConfirmed, refresh, refreshRoots, acceptRootPreflight } = view;
  const owner = useRef<number | undefined>(undefined);
  useLayoutEffect(() => {
    owner.current = generation;
    return () => {
      owner.current = undefined;
    };
  }, [generation]);
  const accepts = () => owner.current === generation;
  const viewCompletion = useCompletedScanView(scanState, view, setError);
  const [notice, setNotice] = useState<string>();
  const [removingId, setRemovingId] = useState<string>();
  const [plan, setPlan] = useState<SourceImportPlan>();
  const [registeredSource, setRegisteredSource] = useContinuationSource(
    registeredSources,
    setupSource,
    setSetupSource,
  );
  const [refreshConfirmed, setRefreshConfirmed] = useState(true);
  const sourceVisible = Boolean(
    refreshConfirmed &&
    !workspaceRefreshFailed &&
    registeredSource &&
    registeredSources.some(
      (source) =>
        source.profile_id === registeredSource.profile_id &&
        source.path === registeredSource.path &&
        source.sha256 === registeredSource.sha256,
    ),
  );
  const heading = useRef<HTMLHeadingElement>(null);
  const focusAfterScan = useRef<{ profile_id: string; path: string } | undefined>(undefined);
  const reviewedCandidate = useRef<{ profile_id: string; path: string } | undefined>(undefined);
  const focusAfterReview = useRef(false);
  const focusToSetup = useRef(false);
  useEffect(() => {
    if (scanning || viewCompletion !== scanState.completion || !focusAfterScan.current) return;
    const candidate = focusAfterScan.current;
    focusAfterScan.current = undefined;
    const scope = heading.current?.closest<HTMLElement>("[data-saved-folders-workspace]");
    if (document.activeElement !== document.body || !scope?.getClientRects().length) return;
    const row = [...scope.querySelectorAll<HTMLElement>("[data-completed-candidate]")].find(
      (element) =>
        element.dataset.profileId === candidate.profile_id &&
        element.dataset.path === candidate.path,
    );
    (
      row?.querySelector<HTMLButtonElement>("[data-candidate-review]:not(:disabled)") ??
      heading.current
    )?.focus();
  }, [scanning, snapshot, viewCompletion, scanState.completion]);
  useEffect(() => {
    if (!plan || busy) return;
    const scope = heading.current?.closest<HTMLElement>("[data-saved-folders-workspace]");
    if (!scope?.getClientRects().length) return;
    scope
      .querySelector<HTMLButtonElement>('[aria-label="Source import review"] button:not(:disabled)')
      ?.focus();
  }, [plan, busy]);
  useEffect(() => {
    if (plan || busy || !focusAfterReview.current) return;
    const scope = heading.current?.closest<HTMLElement>("[data-saved-folders-workspace]");
    if (!scope?.getClientRects().length) return;
    focusAfterReview.current = false;
    if (focusToSetup.current) {
      focusToSetup.current = false;
      const setup = scope.querySelector<HTMLButtonElement>(
        '[aria-label="Continue to a game"] button:not(:disabled)',
      );
      if (setup) {
        setup.focus();
        return;
      }
    }
    const candidate = reviewedCandidate.current;
    const rows = scope.querySelectorAll<HTMLElement>(
      scanning
        ? "[data-live-candidate], [data-preliminary-selection]"
        : "[data-completed-candidate], [data-preliminary-selection]",
    );
    const row = [...rows].find(
      (element) =>
        element.dataset.profileId === candidate?.profile_id &&
        element.dataset.path === candidate?.path,
    );
    (
      row?.querySelector<HTMLButtonElement>("[data-candidate-review]:not(:disabled)") ??
      heading.current
    )?.focus();
  }, [plan, busy, scanning, snapshot]);
  const run = (
    label: string,
    task: () => Promise<void>,
    cancellationNotice = "Action cancelled. Refresh folders to confirm the current state.",
  ) => {
    setBusy(label);
    scanState.clearFeedback();
    setError(undefined);
    setNotice(undefined);
    return task()
      .catch((value: unknown) => {
        if (!accepts()) return;
        if (isCancellation(value)) setNotice(cancellationNotice);
        else setError(errorText(value));
      })
      .finally(() => {
        if (!accepts()) return;
        setBusy("");
      });
  };
  const refreshAfterRootChange = async (message: string) => {
    setNotice(message);
    try {
      await refresh();
    } catch {
      setNotice(
        `${message} The saved-folder view couldn't refresh. Use Refresh folders to check the current state.`,
      );
    }
  };
  const add = () =>
    run("Choosing folder…", async () => {
      const path = await pickGameFileFolder("");
      if (!path || !accepts()) return;
      const currentRoots = await refreshRoots();
      if (!accepts()) return;
      acceptRootPreflight(currentRoots);
      if (availableRootCount(currentRoots) >= maxAvailableRootsPerScan) {
        setNotice(
          "A scan supports at most eight available folders. Remove an available folder before adding another.",
        );
        return;
      }
      await desktopApi.addGameFileRoot(path, generation);
      if (!accepts()) return;
      setPlan(undefined);
      await refreshAfterRootChange("Folder saved.");
    });
  const relink = (root: GameFileRoot) =>
    run("Choosing replacement…", async () => {
      const path = await pickGameFileFolder(root.path);
      if (!path || !accepts()) return;
      await desktopApi.relinkGameFileRoot(root.id, path, generation);
      if (!accepts()) return;
      setPlan(undefined);
      await refreshAfterRootChange("Saved folder location updated.");
    });
  const remove = (root: GameFileRoot) =>
    run("Removing folder…", async () => {
      const removed = await desktopApi.removeGameFileRoot(root.id, generation);
      if (!accepts()) return;
      setRemovingId(undefined);
      setPlan(undefined);
      await refreshAfterRootChange(
        removed
          ? "Saved folder removed. The game files were kept."
          : "The folder was already absent from saved folders.",
      );
    });
  const scan = () => {
    setError(undefined);
    setNotice(undefined);
    return scanState.start(refreshRoots);
  };
  const review = (candidate: Pick<SourceRecord, "profile_id" | "path">) =>
    run(
      "Checking game files…",
      async () => {
        reviewedCandidate.current = candidate;
        setRegisteredSource(undefined);
        setPlan(undefined);
        const reviewed = await desktopApi.planSourceImport(
          candidate.profile_id,
          candidate.path,
          "use_current_location",
        );
        if (accepts()) setPlan(reviewed);
      },
      "Game-file check cancelled. No location was saved.",
    );
  const apply = () =>
    run(
      "Saving game-file location…",
      async () => {
        if (!plan) return;
        const result = await desktopApi.importSource(
          plan.profile_id,
          plan.source.path,
          plan.mode,
          plan.plan_sha256,
        );
        if (!accepts()) return;
        if (!result) {
          setNotice(
            "Adding game files was cancelled. Check the current state before trying again.",
          );
          return;
        }
        focusAfterReview.current = true;
        setPlan(undefined);
        setNotice(sourceImportNotice(result));
        setRefreshConfirmed(false);
        setRegisteredSource(result.registered);
        try {
          await onAdded?.();
          setRefreshConfirmed(true);
          focusToSetup.current = true;
        } catch {
          setNotice(sourceImportRefreshNotice(result));
        }
      },
      "Adding game files was cancelled. Refresh the workspace to confirm the current state.",
    );
  const retryRefresh = () =>
    run("Refreshing library…", async () => {
      try {
        await onAdded?.();
        setRefreshConfirmed(true);
        setNotice("Library view refreshed. The game files were already added.");
      } catch {
        setNotice(
          "The game files were added, but the view still couldn't refresh. Try again later.",
        );
      }
    });
  const renderHeading = () => (
    <div className="settings-title flex items-center justify-between gap-[12px]">
      <h2 className="m-0 flex items-center gap-2" ref={heading} id={headingId} tabIndex={-1}>
        Game-file libraries
      </h2>
      <Button
        data-focusable
        data-settings-control="add-game-file-root"
        variant="outline"
        size="sm"
        disabled={
          Boolean(busy) ||
          scanning ||
          roots === undefined ||
          availableRootCount(roots) >= maxAvailableRootsPerScan
        }
        onClick={() => void add()}
      >
        Add folder
      </Button>
    </div>
  );
  const renderScanActions = () => (
    <div className="actions flex flex-wrap gap-2">
      <Button
        data-focusable
        variant="outline"
        disabled={Boolean(busy) || scanning}
        onClick={() =>
          void run("Refreshing folders…", async () => {
            await refresh();
          })
        }
      >
        Refresh folders
      </Button>
      <Button
        data-focusable
        variant="outline"
        disabled={
          Boolean(busy) ||
          scanning ||
          !roots?.length ||
          availableRootCount(roots) > maxAvailableRootsPerScan
        }
        onClick={() => void scan()}
      >
        {savedScanAction(snapshot, readConfirmed)}
      </Button>
    </div>
  );
  const renderLiveResults = () =>
    scanning && (
      <LiveScanResults
        candidates={liveCandidates}
        profiles={profiles}
        registeredSources={registeredSources}
        statuses={statuses}
        registrationConfirmed={refreshConfirmed && !workspaceRefreshFailed}
        workspaceRefreshFailed={workspaceRefreshFailed}
        ports={ports}
        onOpenPort={onOpenPort}
        busy={Boolean(busy)}
        review={(candidate) => void review(candidate)}
      />
    );
  const renderCompletedScan = () => (
    <CompletedScan
      snapshot={snapshot}
      readConfirmed={readConfirmed}
      roots={roots}
      ports={ports}
      profiles={profiles}
      registeredSources={registeredSources}
      statuses={statuses}
      registrationConfirmed={refreshConfirmed && !workspaceRefreshFailed}
      workspaceRefreshFailed={workspaceRefreshFailed}
      onOpenPort={openPort}
      busy={Boolean(busy)}
      review={(candidate) => void review(candidate)}
    />
  );
  const renderSetupReviews = () => (
    <GameFileSetupReviews
      ports={ports}
      statuses={statuses}
      candidates={scanning ? liveCandidates : (snapshot?.report.candidates ?? [])}
      preliminarySelections={scanning ? [] : snapshot?.report.preliminary_selections}
      registeredSources={registeredSources}
      current={
        refreshConfirmed &&
        !workspaceRefreshFailed &&
        (scanning || (readConfirmed && snapshot?.freshness === "inputs_match"))
      }
      busy={Boolean(busy) || Boolean(plan)}
      onOpenPort={openPort}
      focusFallback={() => heading.current}
    />
  );
  const renderSourceReview = () => (
    <SourceImportReview
      plan={plan}
      profiles={profiles}
      busy={Boolean(busy)}
      onCancel={() => {
        focusAfterReview.current = true;
        setPlan(undefined);
      }}
      onApply={apply}
    />
  );
  const renderContinue = () => (
    <ContinueToGame
      registeredSource={registeredSource}
      sourceVisible={sourceVisible}
      busy={Boolean(busy)}
      retryRefresh={onAdded ? () => void retryRefresh() : undefined}
      ports={ports}
      onOpenPort={openPort}
    />
  );
  return (
    <SettingsRow
      className="source-health col-span-full min-h-0"
      data-focus-group
      data-saved-folders-workspace
      data-detail-origin={returnOrigin}
      aria-labelledby={headingId}
      tabIndex={-1}
      onFocusCapture={(event) => {
        const row = event.target.closest<HTMLElement>("[data-live-candidate]");
        if (row?.dataset.profileId && row.dataset.path) {
          focusAfterScan.current = { profile_id: row.dataset.profileId, path: row.dataset.path };
        }
      }}
    >
      <p className="mb-1.5 text-xs text-pc-muted-foreground">Saved folders</p>
      {renderHeading()}
      <p>
        Choose folders on this PC, a mounted network share, or a removable drive. Portcove searches
        only saved folders. Searching does not change the game files or save their locations.
      </p>
      {roots && availableRootCount(roots) >= maxAvailableRootsPerScan && (
        <p>
          A scan supports at most eight available folders. Remove an available folder before adding
          another.
        </p>
      )}
      <SavedRootRows
        roots={roots}
        busy={Boolean(busy)}
        scanning={scanning}
        removingId={removingId}
        setRemovingId={setRemovingId}
        relink={(root) => void relink(root)}
        remove={(root) => void remove(root)}
      />
      {renderScanActions()}
      {busy && <p role="status">{busy}</p>}
      {scanning && <p role="status">Scanning selected folders…</p>}
      {operationId && <OperationCancellation operationId={operationId} label="Cancel scan" />}
      {renderLiveResults()}
      {scanState.error && <p role="alert">{scanState.error}</p>}
      {scanState.notice && <p role="status">{scanState.notice}</p>}
      {error && <p role="alert">{error}</p>}
      {notice && <p role="status">{notice}</p>}
      {renderCompletedScan()}
      {renderSetupReviews()}
      {renderSourceReview()}
      {renderContinue()}
    </SettingsRow>
  );
}
