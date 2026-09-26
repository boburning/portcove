import { useEffect, useRef, useState } from "react";
import { desktopApi } from "../api";
import { pickInstallFolder } from "../file-picker";
import type {
  GameFileRoot,
  GameFileScanSnapshot,
  PortDefinition,
  SourceImportPlan,
  SourceProfile,
  SourceRecord,
} from "../types";
import { errorText, formatBytes, formatCountMessage, isCancellation } from "../view-model";
import { OperationCancellation } from "./OperationCancellation";
import {
  SourceImportReview,
  sourceDiscoveryLimitLabel,
  sourceImportNotice,
} from "./SourceDiscovery";
import { Button } from "./ui/button";

const scanLimits = {
  max_entries: 10_000,
  max_depth: 6,
  max_file_bytes: 2 * 1024 * 1024 * 1024,
  max_hash_bytes: 16 * 1024 * 1024 * 1024,
  max_candidates: 64,
};
const maxSavedRootsPerScan = 8;
const setupReturnOrigin = "game-file-libraries-setup";

function savedRootLimitGuidance(limit: string) {
  if (limit === "file_size")
    return `Files above ${formatBytes(scanLimits.max_file_bytes)} were skipped. Check a suspected file from its game details.`;
  if (limit === "depth") return "Relink a saved folder to a deeper subfolder, then scan again.";
  return "Remove or relink saved folders to narrower subfolders, then scan again. You can also use Choose game files for one game.";
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
      <code>{candidate.path}</code>
      <span>{formatBytes(candidate.size)}</span>
    </>
  );
}

function useRegisteredContinuation(registeredSources: SourceRecord[]) {
  const [registeredSource, setRegisteredSource] = useState<SourceRecord>();
  const observedRegistration = useRef(false);
  useEffect(() => {
    if (!registeredSource) {
      observedRegistration.current = false;
      return;
    }
    if (
      registeredSources.some(
        (source) =>
          source.profile_id === registeredSource.profile_id &&
          source.path === registeredSource.path &&
          source.sha256 === registeredSource.sha256,
      )
    )
      observedRegistration.current = true;
    else if (observedRegistration.current) setRegisteredSource(undefined);
  }, [registeredSource, registeredSources]);
  return [registeredSource, setRegisteredSource] as const;
}

function ContinueToGame({
  registeredSource,
  ports,
  onOpenPort,
}: {
  registeredSource?: SourceRecord;
  ports: PortDefinition[];
  onOpenPort?: (portId: string, originKey: string) => void;
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
        The selected source is saved. Open a game to review its remaining requirements and available
        setup actions.
      </p>
      <div className="actions">
        {matchingPorts.map((port) => (
          <Button
            key={port.id}
            data-focusable
            variant="outline"
            onClick={() => onOpenPort(port.id, setupReturnOrigin)}
          >
            Open {port.name} details
          </Button>
        ))}
      </div>
    </section>
  );
}

export function GameFileLibraries({
  ports,
  profiles,
  registeredSources = [],
  onAdded,
  onOpenPort,
}: {
  ports: PortDefinition[];
  profiles: SourceProfile[];
  registeredSources?: SourceRecord[];
  onAdded?: () => Promise<unknown>;
  onOpenPort?: (portId: string, originKey: string) => void;
}) {
  const [roots, setRoots] = useState<GameFileRoot[]>();
  const [snapshot, setSnapshot] = useState<GameFileScanSnapshot | null>();
  const [busy, setBusy] = useState("");
  const [scanning, setScanning] = useState(false);
  const [error, setError] = useState<string>();
  const [notice, setNotice] = useState<string>();
  const [operationId, setOperationId] = useState<string>();
  const [removingId, setRemovingId] = useState<string>();
  const [plan, setPlan] = useState<SourceImportPlan>();
  const [registeredSource, setRegisteredSource] = useRegisteredContinuation(registeredSources);
  const [liveCandidates, setLiveCandidates] = useState<
    { profile_id: string; path: string; sha256: string; size: number }[]
  >([]);
  const heading = useRef<HTMLHeadingElement>(null);
  const focusAfterScan = useRef<{ profile_id: string; path: string } | undefined>(undefined);
  const reviewedCandidate = useRef<{ profile_id: string; path: string } | undefined>(undefined);
  const focusAfterReview = useRef(false);
  const focusToSetup = useRef(false);
  useEffect(() => {
    let active = true;
    void Promise.all([desktopApi.gameFileRoots(), desktopApi.gameFileScanSnapshot()])
      .then(([savedRoots, savedSnapshot]) => {
        if (!active) return;
        setRoots(savedRoots);
        setSnapshot(savedSnapshot);
      })
      .catch((value: unknown) => {
        if (active) setError(errorText(value));
      });
    return () => {
      active = false;
    };
  }, []);
  useEffect(() => {
    if (scanning || !focusAfterScan.current) return;
    const candidate = focusAfterScan.current;
    focusAfterScan.current = undefined;
    if (document.activeElement !== document.body) return;
    const row = [...document.querySelectorAll<HTMLElement>("[data-completed-candidate]")].find(
      (element) =>
        element.dataset.profileId === candidate.profile_id &&
        element.dataset.path === candidate.path,
    );
    (row?.querySelector<HTMLButtonElement>("button:not(:disabled)") ?? heading.current)?.focus();
  }, [scanning, snapshot]);
  useEffect(() => {
    if (!plan || busy) return;
    document
      .querySelector<HTMLButtonElement>('[aria-label="Source import review"] button:not(:disabled)')
      ?.focus();
  }, [plan, busy]);
  useEffect(() => {
    if (plan || busy || !focusAfterReview.current) return;
    focusAfterReview.current = false;
    if (focusToSetup.current) {
      focusToSetup.current = false;
      const setup = document.querySelector<HTMLButtonElement>(
        '[aria-label="Continue to a game"] button:not(:disabled)',
      );
      if (setup) {
        setup.focus();
        return;
      }
    }
    const candidate = reviewedCandidate.current;
    const rows = document.querySelectorAll<HTMLElement>(
      scanning ? "[data-live-candidate]" : "[data-completed-candidate]",
    );
    const row = [...rows].find(
      (element) =>
        element.dataset.profileId === candidate?.profile_id &&
        element.dataset.path === candidate?.path,
    );
    (row?.querySelector<HTMLButtonElement>("button:not(:disabled)") ?? heading.current)?.focus();
  }, [plan, busy, scanning, snapshot]);
  const run = (label: string, task: () => Promise<void>) => {
    setBusy(label);
    setError(undefined);
    setNotice(undefined);
    return task()
      .catch((value: unknown) => {
        if (isCancellation(value)) setNotice("Scan cancelled. The previous results were kept.");
        else setError(errorText(value));
      })
      .finally(() => {
        setBusy("");
      });
  };
  const refresh = async () => {
    const [savedRoots, savedSnapshot] = await Promise.all([
      desktopApi.gameFileRoots(),
      desktopApi.gameFileScanSnapshot(),
    ]);
    setRoots(savedRoots);
    setSnapshot(savedSnapshot);
    return savedRoots;
  };
  const add = () =>
    run("Choosing folder…", async () => {
      const path = await pickInstallFolder("");
      if (!path) return;
      if ((await refresh()).length >= maxSavedRootsPerScan) {
        setNotice("A scan supports at most eight saved folders. Remove one before adding another.");
        return;
      }
      await desktopApi.addGameFileRoot(path);
      setPlan(undefined);
      await refresh();
    });
  const relink = (root: GameFileRoot) =>
    run("Choosing replacement…", async () => {
      const path = await pickInstallFolder(root.path);
      if (!path) return;
      await desktopApi.relinkGameFileRoot(root.id, path);
      setPlan(undefined);
      await refresh();
    });
  const remove = (root: GameFileRoot) =>
    run("Removing folder…", async () => {
      await desktopApi.removeGameFileRoot(root.id);
      setRemovingId(undefined);
      setPlan(undefined);
      await refresh();
    });
  const scan = () =>
    (async () => {
      setScanning(true);
      setError(undefined);
      setNotice(undefined);
      setLiveCandidates([]);
      try {
        const currentRoots = await refresh();
        if (currentRoots.length > maxSavedRootsPerScan) {
          setNotice("A scan supports at most eight saved folders. Remove a folder and scan again.");
          return;
        }
        if (!currentRoots.some((root) => root.availability === "available")) {
          setNotice("No saved folder is available. Reconnect or relink one, then scan again.");
          return;
        }
        let acceptingEvents = true;
        const scanned = await desktopApi
          .scanGameFileRoots(scanLimits, (event) => {
            if (!acceptingEvents) return;
            if (event.type === "started") setOperationId(event.operation_id);
            if (event.schema_version === 3 && event.type === "source_candidate") {
              setLiveCandidates((current) =>
                current.some(
                  (candidate) =>
                    candidate.profile_id === event.profile_id && candidate.path === event.path,
                )
                  ? current
                  : [
                      ...current,
                      {
                        profile_id: event.profile_id,
                        path: event.path,
                        sha256: event.sha256,
                        size: event.size,
                      },
                    ].slice(0, scanLimits.max_candidates),
              );
            }
          })
          .finally(() => {
            acceptingEvents = false;
          });
        setSnapshot(scanned);
        await refresh();
      } catch (value) {
        if (isCancellation(value)) setNotice("Scan cancelled. The previous results were kept.");
        else setError(errorText(value));
      } finally {
        const focusedRow = document.activeElement?.closest<HTMLElement>("[data-live-candidate]");
        if (focusedRow?.dataset.profileId && focusedRow.dataset.path) {
          focusAfterScan.current = {
            profile_id: focusedRow.dataset.profileId,
            path: focusedRow.dataset.path,
          };
        }
        setScanning(false);
        setOperationId(undefined);
        setLiveCandidates([]);
      }
    })();
  const review = (candidate: Pick<SourceRecord, "profile_id" | "path">) =>
    run("Checking the source…", async () => {
      reviewedCandidate.current = candidate;
      setRegisteredSource(undefined);
      setPlan(undefined);
      setPlan(
        await desktopApi.planSourceImport(
          candidate.profile_id,
          candidate.path,
          "use_current_location",
        ),
      );
    });
  const apply = () =>
    run("Adding selected source…", async () => {
      if (!plan) return;
      const result = await desktopApi.importSource(
        plan.profile_id,
        plan.source.path,
        plan.mode,
        plan.plan_sha256,
      );
      if (!result) return;
      focusAfterReview.current = true;
      setPlan(undefined);
      setNotice(sourceImportNotice(result));
      await onAdded?.();
      setRegisteredSource(result.registered);
      focusToSetup.current = true;
    });
  const report = snapshot?.report;
  return (
    <article
      className="settings-row source-health"
      data-focus-group
      data-detail-origin={setupReturnOrigin}
      aria-labelledby="game-file-libraries-heading"
      tabIndex={-1}
    >
      <p className="eyebrow">SAVED FOLDERS</p>
      <div className="settings-title">
        <h2 ref={heading} id="game-file-libraries-heading" tabIndex={-1}>
          Game-file libraries
        </h2>
        <Button
          data-focusable
          data-settings-control="add-game-file-root"
          variant="outline"
          size="sm"
          disabled={
            Boolean(busy) || scanning || roots === undefined || roots.length >= maxSavedRootsPerScan
          }
          onClick={() => void add()}
        >
          Add folder
        </Button>
      </div>
      <p>
        Choose folders on this PC, a mounted network share, or a removable drive. Portcove searches
        only saved folders. Scanning does not change the original files or add them as sources.
      </p>
      {roots && roots.length >= maxSavedRootsPerScan && (
        <p>A scan supports at most eight saved folders. Remove one before adding another.</p>
      )}
      {roots === undefined ? (
        <p role="status">Loading saved folders…</p>
      ) : roots.length === 0 ? (
        <p>No folders saved yet.</p>
      ) : (
        <div className="source-health-list">
          {roots.map((root) => (
            <div className="source-health-row" key={root.id}>
              <div>
                <code>{root.path}</code>
                <span>
                  {root.availability === "available"
                    ? "Available"
                    : "Unavailable — reconnect or relink this folder"}
                </span>
              </div>
              <div className="actions">
                <Button
                  data-focusable
                  variant="outline"
                  disabled={Boolean(busy) || scanning}
                  onClick={() => void relink(root)}
                >
                  Relink
                </Button>
                {removingId === root.id ? (
                  <>
                    <Button
                      data-focusable
                      variant="destructive"
                      disabled={Boolean(busy) || scanning}
                      onClick={() => void remove(root)}
                    >
                      Remove saved folder
                    </Button>
                    <Button
                      data-focusable
                      variant="outline"
                      onClick={() => setRemovingId(undefined)}
                    >
                      Keep folder
                    </Button>
                  </>
                ) : (
                  <Button
                    data-focusable
                    variant="outline"
                    disabled={Boolean(busy) || scanning}
                    onClick={() => setRemovingId(root.id)}
                  >
                    Remove
                  </Button>
                )}
              </div>
            </div>
          ))}
        </div>
      )}
      <div className="actions">
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
            Boolean(busy) || scanning || !roots?.length || roots.length > maxSavedRootsPerScan
          }
          onClick={() => void scan()}
        >
          Scan saved folders
        </Button>
      </div>
      {busy && <p role="status">{busy}</p>}
      {scanning && <p role="status">Scanning selected folders…</p>}
      {operationId && <OperationCancellation operationId={operationId} label="Cancel scan" />}
      {scanning && liveCandidates.length > 0 && (
        <section className="source-discovery-results" aria-label="Matches found during scan">
          <h3>Matches found so far</h3>
          <p>
            These exact file matches are provisional while the scan continues. You can review one
            now; Portcove checks its current files again before adding it as a source.
          </p>
          {liveCandidates.map((candidate) => (
            <div
              className="source-health-row"
              key={`${candidate.profile_id}:${candidate.path}`}
              data-live-candidate
              data-profile-id={candidate.profile_id}
              data-path={candidate.path}
            >
              <div>
                <CandidateIdentity candidate={candidate} profiles={profiles} />
              </div>
              <Button
                data-focusable
                variant="outline"
                disabled={Boolean(busy)}
                onClick={() => void review(candidate)}
              >
                Review source now
              </Button>
            </div>
          ))}
        </section>
      )}
      {error && <p role="alert">{error}</p>}
      {notice && <p role="status">{notice}</p>}
      {snapshot && report && (
        <section className="source-discovery-results" aria-label="Saved folder scan results">
          <h3>Last completed scan</h3>
          <p>
            {snapshot.freshness === "inputs_match"
              ? "Saved roots and catalog match this snapshot. Files may have changed since the scan."
              : "Saved roots, availability, or catalog changed. Scan again before using these results."}
          </p>
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
                  {sourceDiscoveryLimitLabel(limit)}: {savedRootLimitGuidance(limit)}
                </li>
              ))}
            </ul>
          )}
          {report.candidates.map((candidate) => (
            <div
              className="source-health-row"
              key={`${candidate.profile_id}:${candidate.path}`}
              data-completed-candidate
              data-profile-id={candidate.profile_id}
              data-path={candidate.path}
            >
              <div>
                <CandidateIdentity candidate={candidate} profiles={profiles} />
                <span>
                  Catalog ports using this profile:{" "}
                  {ports
                    .filter(
                      (port) =>
                        port.source_profile === candidate.profile_id ||
                        port.bios_source_profile === candidate.profile_id,
                    )
                    .map((port) => port.name)
                    .join(", ") || "No catalog port currently uses this profile"}
                </span>
              </div>
              <Button
                data-focusable
                variant="outline"
                disabled={Boolean(busy) || snapshot.freshness !== "inputs_match"}
                onClick={() => void review(candidate)}
              >
                Review source
              </Button>
            </div>
          ))}
          {report.issues.map((issue, index) => (
            <p key={`${issue.path}:${index}`}>
              {issue.message} {issue.path && <code>{issue.path}</code>}
            </p>
          ))}
          {report.issues_omitted > 0 && (
            <p>{report.issues_omitted} more scan issues were omitted.</p>
          )}
        </section>
      )}
      <SourceImportReview
        plan={plan}
        busy={Boolean(busy)}
        onCancel={() => {
          focusAfterReview.current = true;
          setPlan(undefined);
        }}
        onApply={apply}
      />
      <ContinueToGame registeredSource={registeredSource} ports={ports} onOpenPort={onOpenPort} />
    </article>
  );
}
