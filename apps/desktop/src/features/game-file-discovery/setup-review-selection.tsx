import { createContext, useContext, useRef, useState, type ReactNode } from "react";
import type { ReleaseChannel } from "../../types";

export const maxSetupReviewSelection = 16;
type Selection = ReturnType<typeof useSelection>;
const SelectionContext = createContext<Selection | undefined>(undefined);

function useSelection() {
  const [selected, setSelected] = useState<string[]>([]);
  const [pendingReview, setPendingReview] = useState<{ portId: string; channel: ReleaseChannel }>();
  const pending = useRef<typeof pendingReview>(undefined);
  const requestReview = (portId: string, channel: ReleaseChannel) => {
    const request = { portId, channel };
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
  return {
    selected,
    toggle,
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
