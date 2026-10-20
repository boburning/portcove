import {
  createContext,
  useCallback,
  useContext,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import type { InvocationRecord } from "./invocation-state";

function useLocalInvocationOwner() {
  const [invocations, setInvocations] = useState<ReadonlyMap<number, InvocationRecord>>(new Map());
  const currentInvocations = useRef(invocations);
  const nextPendingId = useRef(0);
  const nextId = useCallback(() => ++nextPendingId.current, []);
  const active = useRef(true);
  useLayoutEffect(() => {
    active.current = true;
    return () => {
      active.current = false;
    };
  }, []);
  // Claim synchronously, before React commits, so duplicate same-turn intent
  // cannot pass exclusion. This map is never persisted or used to schedule work.
  const updateInvocations = useCallback(
    (
      update: (
        current: ReadonlyMap<number, InvocationRecord>,
      ) => ReadonlyMap<number, InvocationRecord>,
    ) => {
      if (!active.current) return;
      const next = update(currentInvocations.current);
      currentInvocations.current = next;
      setInvocations(next);
    },
    [],
  );
  return { invocations, currentInvocations, nextId, active, updateInvocations };
}

const InvocationOwner = createContext<ReturnType<typeof useLocalInvocationOwner> | null>(null);

/** Application lifetime: library-keyed descendants may retire their own app task after unmount. */
export function InvocationOwnerProvider({ children }: { children: ReactNode }) {
  const owner = useLocalInvocationOwner();
  return <InvocationOwner value={owner}>{children}</InvocationOwner>;
}

export function useInvocationOwner() {
  const shared = useContext(InvocationOwner);
  const local = useLocalInvocationOwner();
  return shared ?? local;
}
