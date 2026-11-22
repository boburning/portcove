import {
  createContext,
  createElement,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { desktopApi } from "../../api";
import type { GameFileRoot, GameFileScanSnapshot, OperationEvent, SourceRecord } from "../../types";
import { errorText, isCancellation } from "../../view-model";

export const gameFileScanLimits = {
  max_entries: 10_000,
  max_depth: 6,
  max_file_bytes: 2 * 1024 * 1024 * 1024,
  max_hash_bytes: 16 * 1024 * 1024 * 1024,
  max_candidates: 64,
};
export function availableRootCount(roots: readonly GameFileRoot[]) {
  return roots.filter((root) => root.availability === "available").length;
}

export type ScanResultRequest = { sequence: number; expected?: string };

export function savedScanResultIdentity(snapshot: GameFileScanSnapshot | null | undefined) {
  if (!snapshot?.matches?.scan_id) return undefined;
  return JSON.stringify([
    snapshot.matches.scan_id,
    snapshot.catalog_sha256,
    snapshot.completed_at,
    snapshot.coverage?.batches,
  ]);
}

export function matchesSavedScanResult(
  snapshot: GameFileScanSnapshot | null | undefined,
  expected: string,
) {
  return snapshot?.freshness === "inputs_match" && savedScanResultIdentity(snapshot) === expected;
}

export async function isCurrentSavedScanResult(expected: string, generation: number) {
  return matchesSavedScanResult(await desktopApi.gameFileScanSnapshot(generation), expected);
}

type ScanState = {
  scanning: boolean;
  operationId?: string;
  completedBatches?: number;
  candidates: Pick<SourceRecord, "profile_id" | "path" | "sha256" | "size">[];
  completion: number;
  receipt?: { snapshot: GameFileScanSnapshot; completion: number };
  error?: string;
  notice?: string;
};

// Owned by the current Workspace, rather than the temporarily visible Settings view.
// Disposing this observer does not cancel core's operation or grant another library its state.
export function useGameFileScan(generation: number) {
  const [state, setState] = useState<ScanState>({ scanning: false, candidates: [], completion: 0 });
  const owner = useRef<{ active?: object; disposed: boolean }>({ disposed: false });
  useEffect(() => {
    const current = owner.current;
    current.disposed = false;
    return () => {
      current.disposed = true;
      delete current.active;
    };
  }, []);
  const start = async (
    readRoots = () => desktopApi.gameFileRoots(generation),
    finishScanId?: string,
  ) => {
    const current = owner.current;
    if (current.active || current.disposed) return;
    const token = {};
    current.active = token;
    const accepts = () => !current.disposed && current.active === token;
    setState((previous) => ({
      scanning: true,
      candidates: [],
      completion: previous.completion,
      ...(previous.receipt ? { receipt: previous.receipt } : {}),
    }));
    let result: GameFileScanSnapshot | undefined;
    let error: string | undefined;
    let notice: string | undefined;
    try {
      const roots = await readRoots();
      if (!accepts()) return;
      if (!availableRootCount(roots)) {
        notice = "No saved folder is available. Reconnect or relink one, then scan again.";
      } else {
        // A corrupt old observation must not prevent Core's explicit fresh-scan recovery.
        const snapshot = await desktopApi.gameFileScanSnapshot(generation).catch(() => null);
        if (!accepts()) return;
        const continuingScan = () =>
          snapshot?.freshness === "inputs_match" &&
          snapshot.coverage?.can_resume &&
          !snapshot.coverage.restart_required &&
          snapshot.limits
            ? snapshot
            : undefined;
        const continuing = continuingScan();
        if (finishScanId !== undefined && continuing?.matches?.scan_id !== finishScanId) {
          throw new Error("This saved scan changed. Refresh folders before trying to finish it.");
        }
        const limits = continuing?.limits ?? gameFileScanLimits;
        if (
          Object.entries(gameFileScanLimits).some(
            ([name, cap]) => limits[name as keyof typeof limits] > cap,
          )
        ) {
          throw new Error(
            "The saved scan exceeds Desktop's scan budgets. Continue it with the CLI or select narrower saved folders.",
          );
        }
        if (continuing) {
          // Core carries prior matches without re-emitting them in the next batch.
          // Only the fresh resumable checkpoint can keep those review choices live.
          setState((previous) => ({
            ...previous,
            candidates: continuing.report.candidates.slice(0, limits.max_candidates),
          }));
        }
        let acceptingEvents = true;
        const receive = (event: OperationEvent) => {
          if (!acceptingEvents || !accepts()) return;
          if (event.type === "started") {
            setState((previous) => ({ ...previous, operationId: event.operation_id }));
          }
          if (event.type === "progress" && event.phase_id === "saved_folder_scan_checkpoints") {
            setState((previous) => ({ ...previous, completedBatches: event.completed }));
          }
          if (event.schema_version === 3 && event.type === "source_candidate") {
            setState((previous) => ({
              ...previous,
              candidates: previous.candidates.some(
                (candidate) =>
                  candidate.profile_id === event.profile_id && candidate.path === event.path,
              )
                ? previous.candidates
                : [
                    ...previous.candidates,
                    {
                      profile_id: event.profile_id,
                      path: event.path,
                      sha256: event.sha256,
                      size: event.size,
                    },
                  ].slice(0, limits.max_candidates),
            }));
          }
        };
        const scanRequest =
          finishScanId === undefined
            ? desktopApi.scanGameFileRoots(limits, generation, receive)
            : desktopApi.scanGameFileRoots(limits, generation, receive, finishScanId);
        result = await scanRequest.finally(() => {
          // oxlint-disable-next-line react/immutability -- oxc#28401: invocation-local binding.
          acceptingEvents = false;
        });
      }
    } catch (value) {
      if (isCancellation(value))
        notice = "Scan cancelled. Results from completed batches were kept.";
      else error = errorText(value);
    } finally {
      if (accepts()) {
        delete current.active;
        setState((previous) => ({
          scanning: false,
          candidates: [],
          completion: previous.completion + 1,
          ...(result !== undefined
            ? { receipt: { snapshot: result, completion: previous.completion + 1 } }
            : previous.receipt
              ? { receipt: previous.receipt }
              : {}),
          ...(error === undefined ? {} : { error }),
          ...(notice === undefined ? {} : { notice }),
        }));
      }
    }
  };
  const clearFeedback = () =>
    setState((previous) => {
      const next = { ...previous };
      delete next.error;
      delete next.notice;
      return next;
    });
  return { ...state, start, clearFeedback };
}

export type GameFileScan = ReturnType<typeof useGameFileScan>;

const GameFileScanContext = createContext<GameFileScan | undefined>(undefined);

export function GameFileScanProvider({
  children,
  generation,
}: {
  children: ReactNode;
  generation: number;
}) {
  const scan = useGameFileScan(generation);
  return createElement(GameFileScanContext.Provider, { value: scan }, children);
}

export function useGameFileScanObserver(generation: number) {
  const workspace = useContext(GameFileScanContext);
  const standalone = useGameFileScan(generation);
  return workspace ?? standalone;
}
