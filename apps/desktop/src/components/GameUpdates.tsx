import { useEffect, useRef, useState, type RefObject } from "react";
import { desktopApi } from "../api";
import type { GameUpdatePlan, PortStatus, UpdatePolicy } from "../types";
import type { Perform } from "../use-portcove";
import { errorText, formatBytes } from "../view-model";
import { ChoiceMenu } from "./ChoiceMenu";
import { OperationCancellation } from "./OperationCancellation";
import { installPlanActionLabel } from "../install-plan-presentation";

export function UpdatePolicyControl({
  policy,
  busy,
  save,
}: {
  policy: UpdatePolicy;
  busy: boolean;
  save: (policy: UpdatePolicy) => Promise<PortStatus | undefined>;
}) {
  const [draftState, setDraftState] = useState({ policy, value: policy });
  const draft = draftState.policy === policy ? draftState.value : policy;
  const [message, setMessage] = useState<string>();
  const [pending, setPending] = useState(false);
  const apply = async () => {
    setPending(true);
    setMessage(undefined);
    try {
      const result = await save(draft);
      setMessage(
        result
          ? "Update settings saved. No update was run."
          : "Settings were not confirmed saved. Check the current setting before retrying.",
      );
    } catch (error) {
      setMessage(errorText(error));
    } finally {
      setPending(false);
    }
  };
  return (
    <section aria-label="Game update settings">
      <ChoiceMenu
        label="Saved update policy"
        value={draft}
        disabled={busy || pending}
        onChange={(value) => {
          setDraftState({ policy, value });
          setMessage(undefined);
        }}
        options={[
          { value: "notify", label: "Notify me" },
          { value: "stage", label: "Download for later" },
          { value: "automatic", label: "Install when running updates" },
        ]}
      />
      <p>
        Saving changes does not run an update. Review a game update separately to choose what to do
        now.
      </p>
      <button
        data-focusable
        disabled={busy || pending || draft === policy}
        onClick={() => {
          void apply();
        }}
      >
        {pending ? "Saving update settings…" : "Save update settings"}
      </button>
      {message && <p role="status">{message}</p>}
    </section>
  );
}

export function GameUpdateControl({
  portId,
  generation,
  policy,
  busy,
  perform,
}: {
  portId: string;
  generation: number;
  policy: UpdatePolicy;
  busy: boolean;
  perform?: Perform;
}) {
  const [activate, setActivate] = useState(policy === "automatic");
  const [plan, setPlan] = useState<GameUpdatePlan>();
  const [pending, setPending] = useState(false);
  const [message, setMessage] = useState<string>();
  const [error, setError] = useState<string>();
  const [operation, setOperation] = useState<string>();
  const request = useRef(0);
  const confirm = useRef<HTMLButtonElement>(null);
  useEffect(
    () => () => {
      request.current += 1;
    },
    [],
  );
  useEffect(() => {
    if (plan) confirm.current?.focus();
  }, [plan]);
  const review = async () => {
    const current = ++request.current;
    setPending(true);
    setPlan(undefined);
    setError(undefined);
    setMessage(undefined);
    try {
      const value = await desktopApi.planGameUpdate(portId, activate, generation);
      if (current === request.current) setPlan(value);
    } catch (error) {
      if (current === request.current) setError(errorText(error));
    } finally {
      if (current === request.current) setPending(false);
    }
  };
  const apply = async () => {
    if (!plan || !perform || !gameUpdateActionLabel(plan)) return;
    const current = ++request.current;
    setPending(true);
    setError(undefined);
    try {
      const result = await perform("run reviewed game update", () =>
        desktopApi.applyGameUpdate(portId, plan.activate, plan.plan_sha256, generation, (event) => {
          if (current !== request.current) return;
          if (event.type === "started") setOperation(event.operation_id);
          if (event.type === "message") setMessage(event.message);
        }),
      );
      if (current === request.current)
        setMessage(
          result
            ? plan.activate
              ? "Update installed. Your previous version remains available."
              : "Update downloaded for later. Your active version is unchanged."
            : "Update did not complete. Review the current state before retrying.",
        );
    } catch (error) {
      if (current === request.current) setError(errorText(error));
    } finally {
      if (current === request.current) {
        setPending(false);
        setPlan(undefined);
        setOperation(undefined);
      }
    }
  };
  return (
    <section aria-label="Review game update">
      <h3>Game update</h3>
      <ChoiceMenu
        label="This update"
        value={activate ? "activate" : "stage"}
        disabled={busy || pending}
        onChange={(value) => {
          setActivate(value === "activate");
          setPlan(undefined);
          setMessage(undefined);
        }}
        options={[
          { value: "stage", label: "Download for later" },
          { value: "activate", label: "Install after download" },
        ]}
      />
      {!plan && (
        <button
          data-focusable
          disabled={busy || pending || !perform}
          onClick={() => {
            void review();
          }}
        >
          {pending ? "Checking update…" : "Review game update"}
        </button>
      )}
      {plan && (
        <GameUpdateReview
          plan={plan}
          disabled={busy || pending || !perform}
          pending={pending}
          confirm={confirm}
          review={() => {
            void review();
          }}
          apply={() => {
            void apply();
          }}
        />
      )}
      {operation && (
        <OperationCancellation key={operation} operationId={operation} label="Cancel game update" />
      )}
      {message && <p role="status">{message}</p>}
      {error && <p role="alert">{error}</p>}
    </section>
  );
}

function gameUpdateActionLabel(plan: GameUpdatePlan) {
  const labels: Record<GameUpdatePlan["plan"]["action"], string | undefined> = {
    download: plan.activate ? "Download and install update" : "Download update for later",
    use_staged: plan.activate ? "Install verified update" : "Stage verified update for later",
    reuse_retained: plan.activate ? "Install verified update" : "Stage verified update for later",
    already_active: undefined,
    blocked_unverified: undefined,
  };
  return Object.hasOwn(labels, plan.plan.action) ? labels[plan.plan.action] : undefined;
}

function GameUpdateReview({
  plan,
  disabled,
  pending,
  confirm,
  review,
  apply,
}: {
  plan: GameUpdatePlan;
  disabled: boolean;
  pending: boolean;
  confirm: RefObject<HTMLButtonElement | null>;
  review: () => void;
  apply: () => void;
}) {
  const label = gameUpdateActionLabel(plan);
  if (!installPlanActionLabel(plan.plan.action))
    return (
      <div className="install-plan">
        <p role="alert">
          This version of Portcove cannot display this update plan. Review it again, or update
          Portcove if this continues.
        </p>
        <button ref={confirm} data-focusable disabled={disabled} onClick={review}>
          Review game update again
        </button>
      </div>
    );
  return (
    <div className="install-plan">
      <p>
        <strong>{plan.plan.release.version}</strong> · {plan.plan.channel}
      </p>
      <p>
        {plan.plan.action === "download"
          ? `${formatBytes(plan.plan.download_bytes)} to download`
          : plan.plan.action === "blocked_unverified"
            ? "The local copy has not been verified."
            : "No download; use the verified local release."}
      </p>
      {label && (
        <p>
          {plan.activate
            ? "The verified update becomes active and the current version remains available for rollback."
            : "The update is staged for later. Your active version stays unchanged."}{" "}
          Saved update settings are unchanged.
        </p>
      )}
      {!label ? (
        <p role="status">
          {plan.plan.action === "already_active"
            ? "This verified release is already active."
            : "An unverified local copy blocks this update. Verify or repair it first."}
        </p>
      ) : (
        <button
          ref={confirm}
          data-focusable
          className="primary"
          disabled={disabled}
          onClick={apply}
        >
          {pending ? "Updating…" : label}
        </button>
      )}
    </div>
  );
}
