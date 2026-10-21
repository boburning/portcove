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
  taskLabel,
  generation,
  disabled,
  run,
  focusFallback,
  onPrepared,
}: {
  portId: string;
  taskLabel?: string;
  generation: number;
  disabled: boolean;
  run?: RunPreparation | undefined;
  focusFallback?: () => HTMLElement | null;
  onPrepared?: () => void;
}) {
  const [plan, setPlan] = useState<PreparationPlan>();
  const [pending, setPending] = useState<"review" | "prepare">();
  const [message, setMessage] = useState<string>();
  const [error, setError] = useState<string>();
  const [operationId, setOperationId] = useState<string>();
  const request = useRef(0);
  const completed = useRef(false);
  const reviewButton = useRef<HTMLButtonElement>(null);
  const reviewTitle = useRef<HTMLHeadingElement>(null);
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
    completed.current = false;
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
      if (result) onPrepared?.();
      if (request.current === current) completed.current = Boolean(result);
      if (request.current === current)
        setMessage(
          result
            ? "Game data is prepared."
            : "Preparation did not complete. Review the current inputs before starting a new preparation.",
        );
    } catch (value) {
      if (request.current === current) {
        if (isCancellation(value))
          setMessage("Setup cancelled. Check Recent activity for unfinished work.");
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
      {taskLabel && <p className="font-semibold [overflow-wrap:anywhere]">{taskLabel}</p>}
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
            initialFocus={reviewTitle}
            finalFocus={() => {
              const fallback = focusFallback?.();
              if (focusFallback && !fallback?.isConnected) return false;
              if (completed.current && fallback?.isConnected) return fallback;
              // Popup cleanup precedes this commit's removal of the opener's
              // temporary hidden/pending state. Its owner determines availability.
              if (reviewButton.current?.isConnected && !disabled && run)
                return reviewButton.current;
              return fallback?.isConnected ? fallback : false;
            }}
            reviewSize="standard"
            aria-describedby="preparation-review-description"
          >
            <DialogTitle
              ref={reviewTitle}
              id="preparation-review-title"
              tabIndex={-1}
              data-autofocus
              className="mb-2 text-xl"
            >
              Prepare game data
            </DialogTitle>
            <DialogDescription id="preparation-review-description" className="mb-4 leading-relaxed">
              Check the original files, installed version, space needed, and preserved data before
              starting setup.
            </DialogDescription>
            {taskLabel && <p className="font-semibold [overflow-wrap:anywhere]">{taskLabel}</p>}
            <div
              className="preparation-plan mt-[16px] grid gap-4 rounded-pc-lg border border-[var(--color-interactive-border)] bg-[var(--color-interactive-subtle)] p-[14px] [overflow-wrap:anywhere]"
              aria-label="Preparation plan"
            >
              <dl className="m-0 grid gap-3">
                <div>
                  <dt className="text-pc-secondary-foreground">Installed version</dt>
                  <dd className="m-0 font-semibold">{plan.inputs.install.version}</dd>
                </div>
                <div>
                  <dt className="text-pc-secondary-foreground">Installed folder</dt>
                  <dd className="m-0">{plan.inputs.install.path}</dd>
                </div>
                <div>
                  <dt className="text-pc-secondary-foreground">Selected game files</dt>
                  <dd className="m-0">{plan.inputs.source.path}</dd>
                </div>
              </dl>
              <p className="m-0">
                Portcove needs at least{" "}
                {formatBytes(plan.copy.total_bytes + plan.inputs.source.storage_size)} of free space
                before the game generates output. The final amount depends on the game.
              </p>
              <p className="m-0">
                Your original files and current installation remain unchanged. The verified result
                becomes active, and your previous version remains available for rollback.
              </p>
              <p className="m-0">
                If preparation is cancelled or interrupted, check Recent activity for any unfinished
                setup files kept for review. Starting again uses the selected original files without
                erasing earlier unfinished work.
              </p>
              <p className="m-0">
                If setup opens a window, complete setup there, then choose its option to close
                setup. Do not launch the game from that window. Portcove will verify and activate
                the prepared result afterward.
              </p>
              {pending === "prepare" && message && (
                <p className="m-0" role="status">
                  {message}
                </p>
              )}
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
