import { useEffect, useLayoutEffect, useRef, useState } from "react";
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
  const observing = useRef(true);
  const reviewButton = useRef<HTMLButtonElement>(null);
  const reviewTitle = useRef<HTMLHeadingElement>(null);
  const actionRegion = useRef<HTMLElement>(null);
  useLayoutEffect(() => {
    // Confirmation disappears when the running view commits. Move focus in
    // that commit, before popup focus recovery handles the removed button.
    if (pending === "prepare" && plan) reviewTitle.current?.focus();
  }, [pending, plan]);
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
    observing.current = true;
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
      // Readback may already have removed this control. The parent completion
      // owner validates its target/epoch and connected workspace before focusing.
      if (result && observing.current) onPrepared?.();
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
    <section
      ref={actionRegion}
      tabIndex={-1}
      aria-label="Prepare game data"
      className="preparation-control"
    >
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
            className="@container/preparation"
            showCloseButton={false}
            initialFocus={reviewTitle}
            finalFocus={() => {
              const fallback = focusFallback?.();
              if (!observing.current)
                return fallback?.isConnected
                  ? fallback
                  : actionRegion.current?.isConnected
                    ? actionRegion.current
                    : false;
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
              {pending === "prepare"
                ? "Preparing the reviewed installation and game files."
                : "Check the original files, installed version, space needed, and preserved data before starting setup."}
            </DialogDescription>
            {taskLabel && <p className="font-semibold [overflow-wrap:anywhere]">{taskLabel}</p>}
            {pending === "prepare" ? (
              <>
                <p role="status">{message ?? "Starting preparation…"}</p>
                <p>
                  Keep Portcove open. You can continue browsing and revisit this task in Activity.
                </p>
                {operationId && (
                  <OperationCancellation
                    key={operationId}
                    operationId={operationId}
                    label="Cancel preparation"
                  />
                )}
                <details className="mt-4">
                  <summary data-focusable className="cursor-pointer py-2">
                    Files and setup details
                  </summary>
                  <PreparationFacts plan={plan} />
                </details>
              </>
            ) : (
              <PreparationFacts plan={plan} />
            )}
            <DialogFooter className="mt-4">
              {pending === "prepare" && (
                <Button
                  data-focusable
                  variant="outline"
                  onClick={() => {
                    observing.current = false;
                    setPlan(undefined);
                  }}
                >
                  Continue browsing
                </Button>
              )}
              {pending !== "prepare" && (
                <Button
                  data-focusable
                  variant="primary"
                  disabled={disabled || Boolean(pending)}
                  onClick={() => {
                    void prepare();
                  }}
                >
                  Prepare game data
                </Button>
              )}
              {pending !== "prepare" && (
                <Button
                  data-focusable
                  variant="outline"
                  disabled={disabled}
                  onClick={dismissReview}
                >
                  Cancel review
                </Button>
              )}
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

function PreparationFacts({ plan }: { plan: PreparationPlan }) {
  return (
    <div
      className="preparation-plan mt-4 grid gap-4 [overflow-wrap:anywhere]"
      aria-label="Preparation plan"
    >
      <h3 className="m-0 text-base">Files used</h3>
      <dl className="m-0 grid gap-3 rounded-pc-md border border-pc-border bg-pc-surface p-4 @min-[30rem]/preparation:grid-cols-2">
        <div className="col-span-full">
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
      <h3 className="m-0 text-base">What changes</h3>
      <p className="m-0">
        Portcove needs at least{" "}
        {formatBytes(plan.copy.total_bytes + plan.inputs.source.storage_size)} of free space before
        the game generates output. The final amount depends on the game.
      </p>
      <p className="m-0">
        Your original files and current installation remain unchanged. The verified result becomes
        active, and your previous version remains available for rollback.
      </p>
      <h3 className="m-0 text-base">During setup</h3>
      <p className="m-0">
        You can continue browsing and revisit this task in Activity. Keep Portcove open until it
        finishes.
      </p>
      <p className="m-0">
        Cancelled or interrupted setup can leave working files for review in Activity. Starting
        again keeps earlier unfinished work.
      </p>
      <details>
        <summary data-focusable className="cursor-pointer py-2">
          If setup opens another window
        </summary>
        <p className="mt-2 mb-0">
          Finish setup and close it without launching the game. Portcove then verifies and activates
          the prepared result.
        </p>
      </details>
    </div>
  );
}
