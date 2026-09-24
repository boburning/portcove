import { useEffect, useRef, useState } from "react";
import { desktopApi } from "../api";
import type { InstallRecord, OperationEvent, PreparationPlan } from "../types";
import { errorText, formatBytes, isCancellation } from "../view-model";
import { OperationCancellation } from "./OperationCancellation";
import { Button } from "./ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogTitle } from "./ui/dialog";

export type RunPreparation = (
  expectedPlan: string,
  onEvent: (event: OperationEvent) => void,
) => Promise<InstallRecord | undefined>;

export function PreparationControl({
  portId,
  generation,
  disabled,
  run,
}: {
  portId: string;
  generation: number;
  disabled: boolean;
  run?: RunPreparation;
}) {
  const [plan, setPlan] = useState<PreparationPlan>();
  const [pending, setPending] = useState<"review" | "prepare">();
  const [message, setMessage] = useState<string>();
  const [error, setError] = useState<string>();
  const [operationId, setOperationId] = useState<string>();
  const request = useRef(0);
  const reviewButton = useRef<HTMLButtonElement>(null);
  useEffect(
    () => () => {
      request.current += 1;
    },
    [],
  );
  const dismissReview = () => {
    setPlan(undefined);
  };
  const review = async () => {
    const current = ++request.current;
    setPending("review");
    setError(undefined);
    setPlan(undefined);
    setMessage(undefined);
    try {
      const value = await desktopApi.planPreparation(portId, generation);
      if (request.current === current) setPlan(value);
    } catch (value) {
      if (request.current === current) setError(errorText(value));
    } finally {
      if (request.current === current) setPending(undefined);
    }
  };
  const prepare = async () => {
    if (!plan || !run) return;
    const current = ++request.current;
    setPending("prepare");
    setError(undefined);
    setMessage("Starting preparation…");
    try {
      const result = await run(plan.plan_sha256, (event) => {
        if (request.current !== current) return;
        if (event.type === "started") setOperationId(event.operation_id);
        if (event.type === "message") setMessage(event.message);
      });
      if (request.current === current)
        setMessage(
          result
            ? "Game data is prepared. You can now play."
            : "Preparation did not complete. Review the current inputs before starting a new preparation.",
        );
    } catch (value) {
      if (request.current === current) {
        if (isCancellation(value))
          setMessage("Preparation cancelled. Review its retained outcome in Recent activity.");
        else setError(errorText(value));
      }
    } finally {
      if (request.current === current) {
        setPending(undefined);
        setOperationId(undefined);
        setPlan(undefined);
      }
    }
  };
  return (
    <section aria-label="Prepare game data" className="preparation-control">
      <p>
        Portcove will use your selected original files to prepare this installed version. Your
        current installation and saved data will stay in place.
      </p>
      <Button
        ref={reviewButton}
        hidden={Boolean(plan)}
        data-focusable
        className={plan ? "hidden" : "wide"}
        variant="primary"
        size="lg"
        disabled={disabled || Boolean(pending) || !run}
        onClick={() => {
          void review();
        }}
      >
        {pending === "review" ? "Checking preparation inputs…" : "Review game preparation"}
      </Button>
      {plan && (
        <Dialog
          open
          onOpenChange={(nextOpen) => {
            if (!nextOpen && pending !== "prepare") dismissReview();
          }}
        >
          <DialogContent
            showCloseButton={false}
            finalFocus={reviewButton}
            className="max-h-[calc(100dvh-var(--space-8))] w-[min(680px,90vw)] max-w-none gap-0 overflow-y-auto overscroll-contain p-8 [scroll-padding-block:var(--space-4)] sm:max-w-none"
            aria-describedby="preparation-review-description"
          >
            <DialogTitle id="preparation-review-title" className="mb-2 text-xl">
              Prepare game data
            </DialogTitle>
            <DialogDescription id="preparation-review-description" className="mb-4 leading-relaxed">
              Check the original files, installed version, space needed, and preserved data before
              starting setup.
            </DialogDescription>
            <div className="preparation-plan" aria-label="Preparation plan">
              <p>
                <strong>Installed version · {plan.inputs.install.version}</strong>
              </p>
              <p>Selected original files: {plan.inputs.source.path}</p>
              <p>
                Portcove needs at least{" "}
                {formatBytes(plan.copy.total_bytes + plan.inputs.source.storage_size)} of free space
                before the game generates output. The final amount depends on the game.
              </p>
              <p>
                Your original files and current installation remain unchanged. The verified result
                becomes active, and your previous version remains available for rollback.
              </p>
              <p>
                If preparation is cancelled or interrupted, check Recent activity for any unfinished
                setup files kept for review. Starting again uses the selected original files without
                erasing earlier unfinished work.
              </p>
              <p>
                If setup opens a window, complete setup there, then choose its option to close
                setup. Do not launch the game from that window. Portcove will verify and activate
                the prepared result afterward.
              </p>
              {pending === "prepare" && message && <p role="status">{message}</p>}
              {operationId && (
                <OperationCancellation
                  key={operationId}
                  operationId={operationId}
                  label="Cancel preparation"
                />
              )}
            </div>
            <DialogFooter className="mt-4">
              <Button
                data-focusable
                data-autofocus
                variant="primary"
                disabled={disabled || Boolean(pending)}
                onClick={() => {
                  void prepare();
                }}
              >
                {pending === "prepare" ? "Preparing game data…" : "Prepare game data"}
              </Button>
              <Button
                data-focusable
                variant="outline"
                disabled={disabled || pending === "prepare"}
                onClick={dismissReview}
              >
                Cancel review
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      )}
      {!plan && message && <p role="status">{message}</p>}
      {!plan && operationId && (
        <OperationCancellation
          key={operationId}
          operationId={operationId}
          label="Cancel preparation"
        />
      )}
      {error && <p role="alert">{error}</p>}
    </section>
  );
}
