import { useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { desktopApi } from "../api";
import type { GameUpdatePlan, PortStatus, UpdatePolicy } from "../types";
import type { Perform } from "../features/operations/use-operation-state";
import { targetInvocationContext } from "../features/operations/invocation-state";
import { LatestRequestGeneration } from "../shared/concurrency-state";
import {
  errorText,
  failurePresentation,
  formatBytes,
  isCancellation,
  releaseChannelPresentation,
} from "../view-model";
import { FailureDetails } from "./FailureDetails";
import { ChoiceSelect } from "./ChoiceSelect";
import { OperationCancellation } from "./OperationCancellation";
import { installPlanActionLabel } from "../install-plan-presentation";
import { Button } from "./ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogTitle } from "./ui/dialog";

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
      <ChoiceSelect
        label="Game update behavior"
        value={draft}
        disabled={busy || pending}
        onChange={(value) => {
          setDraftState({ policy, value });
          setMessage(undefined);
        }}
        options={[
          { value: "notify", label: "Notify me" },
          { value: "stage", label: "Keep update for later" },
          { value: "automatic", label: "Install when I run updates" },
        ]}
      />
      <p>
        Saving changes does not run an update. Review a game update separately to choose what to do
        now.
      </p>
      <Button
        data-focusable
        variant="primary"
        disabled={busy || pending || draft === policy}
        onClick={() => {
          void apply();
        }}
      >
        {pending ? "Saving update settings…" : "Save update settings"}
      </Button>
      {message && <p role="status">{message}</p>}
    </section>
  );
}

function useGameUpdateControl({
  portId,
  generation,
  busy,
  perform,
  compact = false,
  gameName,
  reviewScope,
}: {
  portId: string;
  generation: number;
  policy: UpdatePolicy;
  busy: boolean;
  perform?: Perform | undefined;
  compact?: boolean;
  primary?: boolean;
  gameName?: string;
  currentVersion?: string | undefined;
  reviewScope?: { active: boolean; claim: () => void; current: () => boolean };
}) {
  const [activate, setActivate] = useState(true);
  const [reviewedPlan, setPlan] = useState<GameUpdatePlan>();
  const plan = reviewScope?.active === false ? undefined : reviewedPlan;
  const [pendingState, setPending] = useState(false);
  const pending = pendingState && reviewScope?.active !== false;
  const [applying, setApplying] = useState(false);
  const [message, setMessage] = useState<string>();
  const [error, setError] = useState<string>();
  const [failure, setFailure] = useState<{ value: unknown }>();
  const [operation, setOperation] = useState<string>();
  const requests = useRef(new LatestRequestGeneration());
  const pendingRequest = useRef(false);
  // A row's execution outlives its review scope. Another row taking the review
  // must retire old review responses without preventing this execution settling.
  const executionRequest = useRef<symbol | undefined>(undefined);
  const reviewButton = useRef<HTMLButtonElement>(null);
  const titleId = useId();
  const descriptionId = useId();
  useLayoutEffect(() => {
    if (reviewScope?.active !== false) return;
    requests.current.begin();
    pendingRequest.current = false;
  }, [reviewScope?.active]);
  useEffect(
    () => () => {
      requests.current.begin();
      executionRequest.current = undefined;
    },
    [],
  );
  const dismissReview = () => setPlan(undefined);
  const review = async (useNow = activate) => {
    if (pendingRequest.current || executionRequest.current || busy) return;
    if (reviewScope && !reviewScope.current()) setPlan(undefined);
    reviewScope?.claim();
    pendingRequest.current = true;
    const current = requests.current.begin();
    setActivate(useNow);
    setPending(true);
    setError(undefined);
    setFailure(undefined);
    setMessage(undefined);
    try {
      const value = await desktopApi.planGameUpdate(portId, useNow, generation);
      if (requests.current.isCurrent(current) && (reviewScope?.current() ?? true)) setPlan(value);
    } catch (error) {
      if (requests.current.isCurrent(current) && (reviewScope?.current() ?? true)) {
        setPlan(undefined);
        setError(errorText(error));
      }
    } finally {
      if (requests.current.isCurrent(current)) {
        pendingRequest.current = false;
        setPending(false);
      }
    }
  };
  const apply = async () => {
    if (
      pendingRequest.current ||
      executionRequest.current ||
      !(reviewScope?.current() ?? true) ||
      !plan ||
      !perform ||
      !gameUpdateActionLabel(plan)
    )
      return;
    pendingRequest.current = true;
    const current = requests.current.begin();
    const execution = Symbol();
    executionRequest.current = execution;
    setPending(true);
    setApplying(true);
    setError(undefined);
    setFailure(undefined);
    let failed = false;
    let acceptingEvents = true;
    try {
      const result = await perform(
        "run reviewed game update",
        async (reportEvent) => {
          try {
            return await desktopApi.applyGameUpdate(
              portId,
              plan.activate,
              plan.plan_sha256,
              generation,
              (event) => {
                reportEvent?.(event);
                if (!acceptingEvents || !requests.current.isCurrent(current)) return;
                if (event.type === "started") setOperation(event.operation_id);
                if (event.type === "message") setMessage(event.message);
              },
            );
          } catch (value) {
            failed = true;
            if (requests.current.isCurrent(current)) {
              setMessage(undefined);
              const mutation = failurePresentation(value)?.mutation_state;
              if (
                isCancellation(value) &&
                (mutation === "not_started" || mutation === "no_changes")
              )
                setFailure({ value });
            }
            // The shared operation owner presents execution failures once.
            throw value;
          } finally {
            acceptingEvents = false;
            if (requests.current.isCurrent(current)) setOperation(undefined);
          }
        },
        {
          context: targetInvocationContext(
            "Update game",
            { kind: "port", id: portId, label: gameName ?? portId },
            generation,
          ),
        },
      );
      if (requests.current.isCurrent(current) && !failed)
        setMessage(
          result
            ? plan.activate
              ? "Update installed. Your previous version remains available."
              : "Update saved for later. Your current version is unchanged."
            : "Update did not complete. Review the current state before retrying.",
        );
    } catch (value) {
      if (requests.current.isCurrent(current)) {
        setFailure({ value });
        setMessage(undefined);
      }
    } finally {
      if (executionRequest.current === execution) {
        executionRequest.current = undefined;
        pendingRequest.current = false;
        setPending(false);
        setApplying(false);
        setPlan(undefined);
        setOperation(undefined);
      }
    }
  };
  return {
    activate,
    setActivate,
    compact,
    gameName,
    reviewScope,
    busy,
    perform,
    plan,
    pending,
    applying,
    message,
    error,
    failure,
    operation,
    reviewButton,
    titleId,
    descriptionId,
    dismissReview,
    review,
    apply,
  };
}

export function GameUpdateControl(props: Parameters<typeof useGameUpdateControl>[0]) {
  const actionRegion = useRef<HTMLElement>(null);
  const {
    activate,
    setActivate,
    compact,
    gameName,
    reviewScope,
    busy,
    perform,
    plan,
    pending,
    applying,
    message,
    error,
    failure,
    operation,
    reviewButton,
    titleId,
    descriptionId,
    dismissReview,
    review,
    apply,
  } = useGameUpdateControl(props);
  const renderReviewActions = (plan: GameUpdatePlan) => (
    <DialogFooter className="mt-4">
      {applying && (
        <Button data-focusable variant="outline" onClick={dismissReview}>
          Continue browsing
        </Button>
      )}
      {installPlanActionLabel(plan.plan.action) ? (
        gameUpdateActionLabel(plan) ? (
          <Button
            data-focusable
            data-autofocus
            variant="primary"
            disabled={busy || pending || !perform}
            onClick={() => void apply()}
          >
            {pending ? (applying ? "Updating…" : "Checking update…") : gameUpdateActionLabel(plan)}
          </Button>
        ) : null
      ) : (
        <Button
          data-focusable
          data-autofocus
          variant="primary"
          disabled={busy || pending}
          onClick={() => void review()}
        >
          Review game update again
        </Button>
      )}
      <Button
        data-focusable
        variant="outline"
        hidden={!gameUpdateActionLabel(plan)}
        disabled={busy || pending}
        onClick={() => void review(!plan.activate)}
      >
        {plan.activate ? "Review download for later" : "Review install now"}
      </Button>
      <Button data-focusable variant="outline" disabled={busy || pending} onClick={dismissReview}>
        Cancel review
      </Button>
    </DialogFooter>
  );
  const renderReviewDialog = () =>
    plan &&
    reviewScope?.active !== false && (
      <Dialog
        open
        onOpenChange={(nextOpen) => {
          if (!nextOpen && !busy && !pending) dismissReview();
        }}
      >
        <DialogContent
          showCloseButton={false}
          finalFocus={() => {
            if (applying && actionRegion.current?.isConnected) return actionRegion.current;
            if (reviewButton.current?.isConnected && !reviewButton.current.disabled)
              return reviewButton.current;
            return false;
          }}
          reviewSize="standard"
          data-game-update-review
          aria-describedby={descriptionId}
        >
          <DialogTitle id={titleId} className="mb-2 text-xl">
            {gameName ? `${gameName} update` : "Review game update"}
          </DialogTitle>
          <DialogDescription id={descriptionId} className="mb-4 leading-relaxed">
            Confirm the release and what happens to your active version before updating.
          </DialogDescription>
          <GameUpdateReview plan={plan} currentVersion={props.currentVersion} />
          {operation && (
            <OperationCancellation
              key={operation}
              operationId={operation}
              label="Cancel game update"
            />
          )}
          {message && <p role="status">{message}</p>}
          {error && <p role="alert">{error}</p>}
          {renderReviewActions(plan)}
        </DialogContent>
      </Dialog>
    );

  return (
    <section ref={actionRegion} tabIndex={-1} aria-label="Review game update">
      {!compact && <h3>Game update</h3>}
      {!plan && (
        <ChoiceSelect
          label="What would you like to do?"
          value={activate ? "install" : "download"}
          disabled={busy || pending}
          onChange={(value) => setActivate(value === "install")}
          options={[
            { value: "install", label: "Install update" },
            { value: "download", label: "Download for later" },
          ]}
        />
      )}
      <Button
        ref={reviewButton}
        data-focusable
        className={plan ? "hidden" : undefined}
        hidden={Boolean(plan)}
        variant={compact || props.primary === false ? "outline" : "primary"}
        disabled={busy || pending || !perform}
        onClick={() => {
          void review();
        }}
      >
        {pending ? "Checking update…" : "Review game update"}
      </Button>
      {renderReviewDialog()}

      {!plan && operation && (
        <OperationCancellation key={operation} operationId={operation} label="Cancel game update" />
      )}
      {!plan && message && <p role="status">{message}</p>}
      {!plan && error && <p role="alert">{error}</p>}
      {!plan && failure && <GameUpdateFailure value={failure.value} />}
    </section>
  );
}

function GameUpdateFailure({ value }: { value: unknown }) {
  const presentation = failurePresentation(value);
  const neutral = presentation?.tone === "neutral" && presentation.mutation_state !== "committed";
  const code =
    typeof value === "object" && value && "code" in value ? String(value.code) : undefined;
  return (
    <div data-game-update-outcome role={neutral ? "status" : "alert"}>
      <p>{errorText(value)}</p>
      {presentation && <FailureDetails presentation={presentation} code={code} />}
    </div>
  );
}

function gameUpdateActionLabel(plan: GameUpdatePlan) {
  if (
    plan.assessment?.action !== "update" ||
    plan.assessment.availability !== "allowed" ||
    plan.assessment.reason !== "available" ||
    plan.assessment.definition != null
  )
    return undefined;
  const labels: Record<GameUpdatePlan["plan"]["action"], string | undefined> = {
    download: plan.activate ? "Download and install update" : "Download update for later",
    use_staged: plan.activate ? "Use saved update" : "Keep saved update for later",
    reuse_retained: plan.activate ? "Use saved update" : "Keep saved update for later",
    already_active: undefined,
    blocked_unverified: undefined,
  };
  return Object.hasOwn(labels, plan.plan.action) ? labels[plan.plan.action] : undefined;
}

function GameUpdateReview({
  plan,
  currentVersion,
}: {
  plan: GameUpdatePlan;
  currentVersion?: string | undefined;
}) {
  const label = gameUpdateActionLabel(plan);
  if (!installPlanActionLabel(plan.plan.action))
    return (
      <div className="install-plan mt-[16px] grid grid-cols-[1fr_auto] [align-items:end] gap-[18px] rounded-pc-lg border border-pc-border bg-pc-surface p-[14px]">
        <p className="mb-[5px]" role="alert">
          This version of Portcove cannot display this update plan. Review it again, or update
          Portcove if this continues.
        </p>
      </div>
    );
  return (
    <div className="install-plan mt-[16px] grid grid-cols-[1fr_auto] [align-items:end] gap-[18px] rounded-pc-lg border border-pc-border bg-pc-surface p-[14px]">
      <p className="mb-[5px]">
        <span className="mb-2 block text-pc-muted-foreground">
          Current version: {currentVersion ?? "Unavailable"}
        </span>
        <strong className="block text-[length:var(--text-sm)]">
          Update: {plan.plan.release.version}
        </strong>{" "}
        · {releaseChannelPresentation(plan.plan.channel).label}
      </p>
      <p className="mb-[5px]">
        {plan.plan.action === "download"
          ? `${formatBytes(plan.plan.download_bytes)} to download`
          : plan.plan.action === "blocked_unverified"
            ? "The local copy has not been verified."
            : "No download; use the verified local release."}
      </p>
      {label && (
        <p className="mb-[5px]">
          {plan.activate
            ? "The verified update becomes active and the current version remains available for rollback."
            : "This keeps the verified update for later. Your current version stays unchanged."}{" "}
          Saved update settings are unchanged.
        </p>
      )}
      {!label ? (
        <p className="mb-[5px]" role="status">
          {gameUpdateHoldReason(plan)}
        </p>
      ) : null}
      {plan.plan.preservation_notices?.map((notice) => (
        <p key={notice} className="col-span-full text-[length:var(--text-sm)]">
          {notice}
        </p>
      ))}
      {plan.plan.shared_preferences && (
        <p className="col-span-full text-[length:var(--text-sm)]">
          This update requires acceptance of ReGaiden's shared Windows preferences at{" "}
          <bdi dir="ltr">{plan.plan.shared_preferences.binding.path}</bdi>. The game may rewrite
          that file and affect other copies. Portcove does not own or back up the shared file; the
          local fallback at <bdi dir="ltr">{plan.plan.shared_preferences.local_fallback_path}</bdi>{" "}
          remains managed installation data.
        </p>
      )}
    </div>
  );
}

function gameUpdateHoldReason(plan: GameUpdatePlan) {
  const assessment = plan.assessment;
  if (assessment?.action !== "update" || assessment.definition != null)
    return "Current update availability is unavailable. Review it again before continuing.";
  if (assessment.availability === "not_offered" && assessment.reason === "already_registered")
    return "This verified release is already active.";
  if (assessment.availability === "waiting" && assessment.reason === "missing_source")
    return "Add the required game files before running this update.";
  if (assessment.availability === "waiting" && assessment.reason === "missing_bios")
    return "Add the required BIOS before running this update.";
  if (assessment.availability === "held" && assessment.reason === "invalid_installation")
    return "An unverified local copy blocks this update. Verify or repair it first.";
  return "Current update availability is unavailable. Review it again before continuing.";
}
