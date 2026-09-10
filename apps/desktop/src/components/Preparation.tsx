import { useEffect, useRef, useState } from "react";
import { desktopApi } from "../api";
import type { InstallRecord, OperationEvent, PreparationPlan } from "../types";
import { errorText, formatBytes, isCancellation } from "../view-model";
import { OperationCancellation } from "./OperationCancellation";

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
  const applyButton = useRef<HTMLButtonElement>(null);
  useEffect(
    () => () => {
      request.current += 1;
    },
    [],
  );
  useEffect(() => {
    if (plan) applyButton.current?.focus();
  }, [plan]);

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
          setMessage(
            "Preparation cancelled. Review its retained outcome in Recent activity.",
          );
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
        Prepare and verify the original game data before playing. Your current
        installation and saves are preserved.
      </p>
      {!plan && (
        <button
          data-focusable
          className="primary wide"
          disabled={disabled || Boolean(pending) || !run}
          onClick={() => {
            void review();
          }}
        >
          {pending === "review"
            ? "Checking preparation inputs…"
            : "Review game preparation"}
        </button>
      )}
      {plan && (
        <>
          <p>
            <strong>Default setup · {plan.inputs.install.version}</strong>
          </p>
          <p>Original source: {plan.inputs.source.path}</p>
          <p>
            A private copy needs at least{" "}
            {formatBytes(
              plan.copy.total_bytes + plan.inputs.source.storage_size,
            )}{" "}
            before generated output. The final space needed depends on the game.
          </p>
          <p>
            The verified result becomes active. Your previous version remains
            available for rollback.
          </p>
          <p>
            Each attempt starts from the reviewed inputs in a new private copy
            and retains earlier partial work.
          </p>
          <button
            ref={applyButton}
            data-focusable
            className="primary wide"
            disabled={disabled || Boolean(pending)}
            onClick={() => {
              void prepare();
            }}
          >
            Start new preparation
          </button>
        </>
      )}
      {message && <p role="status">{message}</p>}
      {operationId && (
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
