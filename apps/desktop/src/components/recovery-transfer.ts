import { useRef, useState } from "react";
import { desktopApi } from "../api";
import type { OperationEvent } from "../types";
import { errorText } from "../view-model";

type TransferScope = { generation: number; libraryRoot: string };
type TransferWork<T> = (
  generation: number,
  onProgress: (event: OperationEvent) => void,
) => Promise<T>;
type TransferReview = {
  onStart: () => void;
  onComplete: () => void;
  onInterrupted: (error: unknown) => void;
};

/** The dialog can be hidden while this exact transfer still owns the copy. */
export function useRecoveryTransfer({ generation, libraryRoot }: TransferScope) {
  const attempted = useRef(false);
  const active = useRef<symbol>(undefined);
  const cancelling = useRef(false);
  const [event, setEvent] = useState<OperationEvent>();
  const [cancelRequested, setCancelRequested] = useState(false);
  const [cancelFailure, setCancelFailure] = useState<unknown>();

  function resetProgress() {
    cancelling.current = false;
    setCancelRequested(false);
    setCancelFailure(undefined);
    setEvent(undefined);
  }

  async function transfer<T>(work: TransferWork<T>, review: TransferReview): Promise<T> {
    const current = attempted.current ? await desktopApi.bootstrapStatus() : undefined;
    if (current && !current.ready)
      throw new Error(
        current.error ? errorText(current.error) : "Open your library and try again.",
      );
    if (current && current.library_root !== libraryRoot)
      throw new Error("Open the library used for this recovery operation and try again.");

    attempted.current = true;
    review.onStart();
    const invocation = Symbol();
    active.current = invocation;
    try {
      const result = await work(current?.generation ?? generation, (progress) => {
        if (active.current !== invocation) return;
        setEvent((previous) =>
          previous &&
          previous.operation_id === progress.operation_id &&
          previous.sequence >= progress.sequence
            ? previous
            : progress,
        );
      });
      review.onComplete();
      return result;
    } catch (failure) {
      review.onInterrupted(failure);
      throw failure;
    } finally {
      active.current = undefined;
    }
  }

  const copying =
    event?.type === "progress" && event.phase === "Copying recovery data" ? event : undefined;

  async function cancelCopy() {
    const invocation = active.current;
    if (!copying || !invocation || cancelling.current) return;
    const isCurrent = () => active.current === invocation;
    cancelling.current = true;
    setCancelRequested(true);
    setCancelFailure(undefined);
    try {
      const receipt = await desktopApi.cancelOperation(copying.operation_id);
      if (!receipt.requested && isCurrent()) setCancelRequested(false);
    } catch (failure) {
      if (isCurrent()) {
        setCancelFailure(failure);
        setCancelRequested(false);
      }
    } finally {
      if (isCurrent()) cancelling.current = false;
    }
  }

  return {
    attempted,
    event,
    copying,
    verifying: event?.type === "progress" && !copying,
    cancelRequested,
    cancelFailure,
    cancelCopy,
    resetProgress,
    transfer,
  };
}
