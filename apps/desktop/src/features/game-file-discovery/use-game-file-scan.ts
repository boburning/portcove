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
import type { GameFileRoot, GameFileScanSnapshot, SourceRecord } from "../../types";
import { errorText, isCancellation } from "../../view-model";

export const gameFileScanLimits = {
  max_entries: 10_000,
  max_depth: 6,
  max_file_bytes: 2 * 1024 * 1024 * 1024,
  max_hash_bytes: 16 * 1024 * 1024 * 1024,
  max_candidates: 64,
};
export const maxAvailableRootsPerScan = 8;
export function availableRootCount(roots: readonly GameFileRoot[]) {
  return roots.filter((root) => root.availability === "available").length;
}

type ScanState = {
  scanning: boolean;
  operationId?: string;
  candidates: Pick<SourceRecord, "profile_id" | "path" | "sha256" | "size">[];
  completion: number;
  result?: GameFileScanSnapshot;
  error?: string;
  notice?: string;
};

// Owned by the current Workspace, rather than the temporarily visible Settings view.
// Disposing this observer does not cancel core's operation or grant another library its state.
export function useGameFileScan() {
  const [state, setState] = useState<ScanState>({ scanning: false, candidates: [], completion: 0 });
  const owner = useRef<{ active?: object; disposed: boolean }>({ disposed: false });
  useEffect(() => {
    const current = owner.current;
    current.disposed = false;
    return () => {
      current.disposed = true;
      current.active = undefined;
    };
  }, []);
  const start = async (readRoots = desktopApi.gameFileRoots) => {
    const current = owner.current;
    if (current.active || current.disposed) return;
    const token = {};
    current.active = token;
    const accepts = () => !current.disposed && current.active === token;
    setState((previous) => ({ scanning: true, candidates: [], completion: previous.completion }));
    let result: GameFileScanSnapshot | undefined;
    let error: string | undefined;
    let notice: string | undefined;
    try {
      const roots = await readRoots();
      if (!accepts()) return;
      if (availableRootCount(roots) > maxAvailableRootsPerScan) {
        notice =
          "A scan supports at most eight available folders. Remove an available folder and scan again.";
      } else if (!availableRootCount(roots)) {
        notice = "No saved folder is available. Reconnect or relink one, then scan again.";
      } else {
        let acceptingEvents = true;
        result = await desktopApi
          .scanGameFileRoots(gameFileScanLimits, (event) => {
            if (!acceptingEvents || !accepts()) return;
            if (event.type === "started") {
              setState((previous) => ({ ...previous, operationId: event.operation_id }));
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
                    ].slice(0, gameFileScanLimits.max_candidates),
              }));
            }
          })
          .finally(() => {
            acceptingEvents = false;
          });
      }
    } catch (value) {
      if (isCancellation(value)) notice = "Scan cancelled. The previous results were kept.";
      else error = errorText(value);
    } finally {
      if (accepts()) {
        current.active = undefined;
        setState((previous) => ({
          scanning: false,
          candidates: [],
          completion: previous.completion + 1,
          result,
          error,
          notice,
        }));
      }
    }
  };
  const clearFeedback = () =>
    setState((previous) => ({ ...previous, error: undefined, notice: undefined }));
  return { ...state, start, clearFeedback };
}

export type GameFileScan = ReturnType<typeof useGameFileScan>;

const GameFileScanContext = createContext<GameFileScan | undefined>(undefined);

export function GameFileScanProvider({ children }: { children: ReactNode }) {
  const scan = useGameFileScan();
  return createElement(GameFileScanContext.Provider, { value: scan }, children);
}

export function useGameFileScanObserver() {
  const workspace = useContext(GameFileScanContext);
  const standalone = useGameFileScan();
  return workspace ?? standalone;
}
