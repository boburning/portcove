import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import type {
  PortStatus,
  ReleaseChannel,
  SourceRecord,
  SourceRegistrationReference,
} from "../../types";

/** Matches the largest batch Core reviews and installs at once. */
export const maxSetupReviewSelection = 512;
type Selection = ReturnType<typeof useSelection>;
const SelectionContext = createContext<Selection | undefined>(undefined);

interface SetupInputs {
  generation: number;
  game: SourceRecord | undefined;
  bios: SourceRecord | undefined;
}

function useSelection() {
  const [selected, setSelected] = useState<string[]>([]);
  const [pendingReview, setPendingReview] = useState<{
    portId: string;
    channel: ReleaseChannel;
    sourceReference?: SourceRegistrationReference;
    inputs?: SetupInputs;
  }>();
  const pending = useRef<typeof pendingReview>(undefined);
  const requestReview = (
    portId: string,
    channel: ReleaseChannel,
    sourceReference?: SourceRegistrationReference,
    inputs?: SetupInputs,
  ) => {
    const request = {
      portId,
      channel,
      ...(sourceReference ? { sourceReference } : {}),
      ...(inputs ? { inputs } : {}),
    };
    pending.current = request;
    setPendingReview(request);
  };
  const takeReview = (request: NonNullable<typeof pendingReview>) => {
    if (pending.current !== request) return false;
    pending.current = undefined;
    setPendingReview(undefined);
    return true;
  };
  const toggle = (id: string) =>
    setSelected((previous) =>
      previous.includes(id)
        ? previous.filter((item) => item !== id)
        : previous.length < maxSetupReviewSelection
          ? [...previous, id]
          : previous,
    );
  /** Adds every given game not already selected, up to the limit. */
  const selectAll = (ids: string[]) =>
    setSelected((previous) => {
      const added = ids.filter((id) => !previous.includes(id));
      return [...previous, ...added].slice(0, maxSetupReviewSelection);
    });
  return {
    selected,
    toggle,
    selectAll,
    clear: () => setSelected([]),
    pendingReview,
    requestReview,
    takeReview,
  };
}

// Selection survives details/back within this library workspace, but grants no
// registration, installation, durable intent or automatic execution authority.
export function SetupReviewSelectionProvider({ children }: { children: ReactNode }) {
  const selection = useSelection();
  return <SelectionContext.Provider value={selection}>{children}</SelectionContext.Provider>;
}

export function useSetupReviewSelection() {
  const shared = useContext(SelectionContext);
  const local = useSelection();
  return shared ?? local;
}

export function usePendingSetupReview(
  selection: ReturnType<typeof useSetupReviewSelection>,
  selectedId: string | undefined,
  portId: string | undefined,
  status: PortStatus | undefined,
  refreshFailure: unknown,
  reviewInstallation: (reference?: SourceRegistrationReference) => Promise<void>,
  sourcePath: string,
  clearSourcePath: (path: string) => void,
  currentInputs?: SetupInputs,
) {
  const { pendingReview, takeReview } = selection;
  useEffect(() => {
    const request = pendingReview;
    if (!request) return;
    // Consume once, including StrictMode replay, and never plan a different detail.
    const matches =
      selectedId === request.portId &&
      portId === request.portId &&
      status?.channel === request.channel &&
      !refreshFailure &&
      !status.active &&
      !status.external_runtime &&
      (!request.inputs || JSON.stringify(request.inputs) === JSON.stringify(currentInputs)) &&
      status.port_actions?.some(
        (action) => action.action === "install" && action.availability === "allowed",
      );
    // Normalize the draft in a committed render before consuming the choice.
    // Otherwise clearing it invalidates the review begun by this old closure.
    if (matches && request.sourceReference && sourcePath) {
      clearSourcePath("");
      return;
    }
    if (takeReview(request) && matches) void reviewInstallation(request.sourceReference);
  }, [
    pendingReview,
    takeReview,
    selectedId,
    portId,
    status,
    refreshFailure,
    reviewInstallation,
    sourcePath,
    clearSourcePath,
    currentInputs,
  ]);
}
