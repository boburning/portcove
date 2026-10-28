import { useEffect, useId, useLayoutEffect, useRef, useState, type RefObject } from "react";
import { desktopApi } from "../api";
import type { GameUpdateAcquisition, GameUpdatePlan, PortStatus, UpdatePolicy } from "../types";
import type { Perform } from "../features/operations/use-operation-state";
import {
  pendingInvocationConflict,
  targetInvocationContext,
} from "../features/operations/invocation-state";
import { useOperationPresentation } from "../features/operations/operation-presentation";
import { LatestRequestGeneration } from "../shared/concurrency-state";
import {
  errorText,
  failurePresentation,
  formatBytes,
  isCancellation,
  releaseChannelPresentation,
} from "../view-model";
import { FailureDetails } from "./FailureDetails";
import { gameUpdateAcquisitionLabel } from "../features/port-updates/acquisition-presentation";
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

type UpdateIntent = "install" | "download" | "prepare";
type UpdateExecution =
  | { kind: "apply" | "acquire"; plan: GameUpdatePlan }
  | { kind: "discard"; acquisition: GameUpdateAcquisition };

function updateExecutionAvailable(
  perform: Perform | undefined,
  pending: boolean,
  execution: symbol | undefined,
  busy: boolean,
  current: () => boolean,
): perform is Perform {
  return !(pending || execution || busy || !perform || !current());
}
function currentGameUpdateSelection(
  selection: UpdateExecution,
  portId: string,
  acquisition: GameUpdateAcquisition | null | undefined,
  hasRetainedArchive: boolean,
  current: () => boolean,
) {
  if (
    selection.kind !== "discard" &&
    (!current() ||
      !gameUpdateActionLabel(selection.plan, selection.kind === "acquire", hasRetainedArchive))
  )
    return false;
  if (
    selection.kind === "discard" &&
    (selection.acquisition.port_id !== portId ||
      !["acquired", "attention_required"].includes(selection.acquisition.phase) ||
      selection.acquisition.id !== acquisition?.id)
  )
    return false;
  return true;
}

function gameUpdateCompletionMessage(
  selection: UpdateExecution,
  result: unknown,
  acquired: GameUpdateAcquisition | undefined,
) {
  if (result && acquired)
    return acquired.phase === "acquired"
      ? "Last command: Archive downloaded. Review again to prepare or install it. Your current version is unchanged."
      : "Archive state recorded. Review its current state before continuing.";
  if (result && selection.kind === "discard")
    return "Last command: Archive discarded. Installed versions and saved data are unchanged.";
  if (result && selection.kind === "apply")
    return selection.plan.activate
      ? "Update installed. Your previous version remains available."
      : "Update saved for later. Your current version is unchanged.";
  return "The operation was not confirmed complete. Review the current state before retrying.";
}

async function executeReviewedGameUpdate(
  selection: UpdateExecution,
  portId: string,
  generation: number,
  receive: Parameters<typeof desktopApi.applyGameUpdate>[4],
) {
  if (selection.kind === "discard") {
    await desktopApi.discardGameUpdateAcquisition(portId, selection.acquisition.id, generation);
    return { value: true, acquired: undefined };
  }
  if (selection.kind === "acquire") {
    const acquired = await desktopApi.acquireGameUpdate(
      portId,
      selection.plan.plan_sha256,
      generation,
      receive,
    );
    return { value: acquired, acquired };
  }
  return {
    value: await desktopApi.applyGameUpdate(
      portId,
      selection.plan.activate,
      selection.plan.plan_sha256,
      generation,
      receive,
    ),
    acquired: undefined,
  };
}

type AcquisitionReceipt = { value: GameUpdateAcquisition; status: PortStatus | undefined };
type DiscardReceipt = { id: string; status: PortStatus | undefined };

function retainedUpdateArchiveState(
  status: PortStatus | undefined,
  acquisitionReceipt: AcquisitionReceipt | undefined,
  discardReceipt: DiscardReceipt | undefined,
  plan: GameUpdatePlan | undefined,
) {
  const lastAcquisition =
    acquisitionReceipt?.status === status ? acquisitionReceipt?.value : undefined;
  const discardedId = discardReceipt?.status === status ? discardReceipt?.id : undefined;
  const observedAcquisition = status?.acquisition;
  const acquisition = observedAcquisition?.id === discardedId ? undefined : observedAcquisition;
  return {
    acquisition,
    hasRetainedArchive: Boolean(acquisition || lastAcquisition || plan?.acquisition),
    completionNeedsRefresh: Boolean(
      lastAcquisition || (discardReceipt && discardReceipt.status === status),
    ),
  };
}
function selectedGameUpdateIntent(
  plan: GameUpdatePlan | undefined,
  pending: boolean,
  hasRetainedArchive: boolean,
  intent: UpdateIntent,
): UpdateIntent {
  return !plan && !pending && hasRetainedArchive && intent === "download" ? "prepare" : intent;
}
function updateInvocationBusy(
  owner: ReturnType<typeof useOperationPresentation>,
  context: Parameters<typeof pendingInvocationConflict>[1],
  fallbackBusy: boolean,
) {
  return owner ? Boolean(pendingInvocationConflict(owner.pending, context)) : fallbackBusy;
}

function useGameUpdateControl({
  portId,
  generation,
  busy: fallbackBusy,
  perform,
  compact = false,
  gameName,
  reviewScope,
  status,
  archiveOnly: requestedArchiveOnly = false,
}: {
  portId: string;
  generation: number;
  policy: UpdatePolicy;
  busy: boolean;
  perform?: Perform | undefined;
  compact?: boolean;
  primary?: boolean;
  gameName?: string | undefined;
  currentVersion?: string | undefined;
  status?: PortStatus | undefined;
  archiveOnly?: boolean;
  reviewScope?: { active: boolean; claim: () => void; current: () => boolean };
}) {
  const archiveOnly = requestedArchiveOnly || Boolean(status && !status.active);
  const owner = useOperationPresentation();
  const target = { kind: "port" as const, id: portId, label: gameName ?? portId };
  const applyContext = targetInvocationContext("Update game", target, generation);
  const acquireContext = {
    ...targetInvocationContext("Download update archive", target, generation),
    operation: "acquire_game_update" as const,
  };
  const discardContext = targetInvocationContext("Discard update archive", target, generation);
  const exclusiveBusy = updateInvocationBusy(owner, applyContext, fallbackBusy);
  const acquireBusy = updateInvocationBusy(owner, acquireContext, fallbackBusy);
  const [intent, setIntent] = useState<UpdateIntent>("install");
  // A returned plan and its reviewed intent are one snapshot. Changing the
  // requested intent cannot reinterpret the previous preview during a read.
  const [reviewedPlan, setPlan] = useState<{ plan: GameUpdatePlan; intent: UpdateIntent }>();
  const reviewSnapshot = reviewScope?.active === false ? undefined : reviewedPlan;
  const plan = reviewSnapshot?.plan;
  const [pendingState, setPending] = useState(false);
  const pending = pendingState && reviewScope?.active !== false;
  const [applying, setApplying] = useState(false);
  const [message, setMessage] = useState<string>();
  const [error, setError] = useState<string>();
  const [failure, setFailure] = useState<{ value: unknown }>();
  const [operation, setOperation] = useState<string>();
  // Receipts explain confirmed commands through failed refreshes. Only an
  // observed Core status or a fresh plan supplies current action authority.
  const [acquisitionReceipt, setAcquisitionReceipt] = useState<AcquisitionReceipt>();
  const [discardReceipt, setDiscardReceipt] = useState<DiscardReceipt>();
  const { acquisition, hasRetainedArchive, completionNeedsRefresh } = retainedUpdateArchiveState(
    status,
    acquisitionReceipt,
    discardReceipt,
    plan,
  );
  const [discardReview, setDiscardReview] = useState<GameUpdateAcquisition>();
  const selectedIntent = selectedGameUpdateIntent(plan, pending, hasRetainedArchive, intent);
  const downloadOnly = (reviewSnapshot?.intent ?? intent) === "download";
  const busy = downloadOnly ? acquireBusy : exclusiveBusy;
  const requests = useRef(new LatestRequestGeneration());
  const pendingRequest = useRef(false);
  // Execution outlives its review scope. Another row may retire review responses
  // without preventing this exact execution from settling through its owner.
  const executionRequest = useRef<symbol | undefined>(undefined);
  const reviewButton = useRef<HTMLButtonElement>(null);
  const discardButton = useRef<HTMLButtonElement>(null);
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
  const review = async (nextIntent: UpdateIntent = selectedIntent) => {
    if (archiveOnly) return;
    if (
      pendingRequest.current ||
      executionRequest.current ||
      (nextIntent === "download" ? acquireBusy : exclusiveBusy)
    )
      return;
    if (nextIntent === "download" && hasRetainedArchive) {
      setError(
        "An update archive is already retained. Review preparing or installing it, or discard it before another download.",
      );
      return;
    }
    if (reviewScope && !reviewScope.current()) setPlan(undefined);
    reviewScope?.claim();
    pendingRequest.current = true;
    const current = requests.current.begin();
    setIntent(nextIntent);
    setPending(true);
    setError(undefined);
    setFailure(undefined);
    setMessage(undefined);
    try {
      const value =
        nextIntent === "download"
          ? await desktopApi.planGameUpdateAcquisition(portId, generation)
          : await desktopApi.planGameUpdate(portId, nextIntent === "install", generation);
      if (requests.current.isCurrent(current) && (reviewScope?.current() ?? true)) {
        setPlan({ plan: value, intent: nextIntent });
      }
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
  const retainCompletion = (
    selection: UpdateExecution,
    result: unknown,
    acquired: GameUpdateAcquisition | undefined,
  ) => {
    if (result && acquired) {
      setAcquisitionReceipt({ value: acquired, status });
    } else if (result && selection.kind === "discard") {
      setDiscardReceipt({ id: selection.acquisition.id, status });
      setAcquisitionReceipt(undefined);
    }
    setMessage(gameUpdateCompletionMessage(selection, result, acquired));
  };
  const execute = async (selection: UpdateExecution) => {
    if (archiveOnly && selection.kind !== "discard") return;
    const acquiring = selection.kind === "acquire";
    const executionBusy = acquiring ? acquireBusy : exclusiveBusy;
    if (
      !updateExecutionAvailable(
        perform,
        pendingRequest.current,
        executionRequest.current,
        executionBusy,
        () => reviewScope?.current() ?? true,
      )
    )
      return;
    if (
      !currentGameUpdateSelection(
        selection,
        portId,
        acquisition,
        hasRetainedArchive,
        () => reviewScope?.current() ?? true,
      )
    )
      return;
    if (selection.kind === "discard") reviewScope?.claim();
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
    let acquired: GameUpdateAcquisition | undefined;
    try {
      const result = await perform(
        acquiring
          ? "acquire_game_update"
          : selection.kind === "discard"
            ? "discard_game_update_acquisition"
            : "run reviewed game update",
        async (reportEvent) => {
          const receive: Parameters<typeof desktopApi.applyGameUpdate>[4] = (event) => {
            reportEvent?.(event);
            if (!acceptingEvents || !requests.current.isCurrent(current)) return;
            if (event.type === "started") setOperation(event.operation_id);
            if (event.type === "message") setMessage(event.message);
          };
          try {
            const command = await executeReviewedGameUpdate(selection, portId, generation, receive);
            acquired = command.acquired;
            return command.value;
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
            // Shared operation feedback presents execution failures once.
            throw value;
          } finally {
            acceptingEvents = false;
            if (requests.current.isCurrent(current)) setOperation(undefined);
          }
        },
        {
          context: acquiring
            ? acquireContext
            : selection.kind === "discard"
              ? discardContext
              : applyContext,
        },
      );
      if (requests.current.isCurrent(current) && !failed) {
        retainCompletion(selection, result, acquired);
      }
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
        setDiscardReview(undefined);
        setOperation(undefined);
      }
    }
  };
  return {
    archiveOnly,
    intent,
    selectedIntent,
    setIntent,
    compact,
    gameName,
    reviewScope,
    busy,
    exclusiveBusy,
    acquireBusy,
    perform,
    plan,
    pending,
    applying,
    message,
    error,
    failure,
    operation,
    reviewButton,
    discardButton,
    titleId,
    descriptionId,
    dismissReview,
    review,
    downloadOnly,
    acquisition,
    hasRetainedArchive,
    completionNeedsRefresh,
    discardReview,
    setDiscardReview,
    reviewDiscard: (record: GameUpdateAcquisition) => {
      if (
        pendingRequest.current ||
        executionRequest.current ||
        exclusiveBusy ||
        record.id !== acquisition?.id
      )
        return;
      reviewScope?.claim();
      setDiscardReview(record);
      setError(undefined);
      setFailure(undefined);
      setMessage(undefined);
    },
    apply: () => plan && execute({ kind: downloadOnly ? "acquire" : "apply", plan }),
    discard: () => discardReview && execute({ kind: "discard", acquisition: discardReview }),
  };
}

export function GameUpdateControl(props: Parameters<typeof useGameUpdateControl>[0]) {
  const heading = useRef<HTMLHeadingElement>(null);
  const discardHeading = useRef<HTMLHeadingElement>(null);
  const actionRegion = useRef<HTMLElement>(null);
  const control = useGameUpdateControl(props);
  const {
    archiveOnly,
    plan,
    pending,
    applying,
    downloadOnly,
    hasRetainedArchive: existingArchive,
    reviewButton,
    perform,
    review,
    exclusiveBusy,
    acquireBusy,
    compact,
    completionNeedsRefresh,
    selectedIntent,
    setIntent,
    reviewScope,
    gameName,
    operation,
    message,
    error,
    discardReview,
    failure,
  } = control;
  const finalFocus = () => {
    if ((applying || pending) && actionRegion.current?.isConnected) return actionRegion.current;
    if (reviewButton.current?.isConnected && !reviewButton.current.disabled)
      return reviewButton.current;
    return false;
  };
  return (
    <section
      ref={actionRegion}
      tabIndex={-1}
      aria-label={
        archiveOnly ? `Manage archive for ${gameName ?? props.portId}` : "Review game update"
      }
    >
      {!compact && <h3>{archiveOnly ? "Update archive" : "Game update"}</h3>}
      {completionNeedsRefresh && (
        <p role="status" className="my-3 text-xs text-pc-muted-foreground">
          The operation finished, but library status could not be refreshed. Refresh status before
          continuing.
        </p>
      )}
      <RetainedUpdateArchive control={control} portId={props.portId} />
      {!archiveOnly && !plan && (
        <div className="grid gap-2">
          <ChoiceSelect<UpdateIntent>
            label="What would you like to do?"
            value={selectedIntent}
            disabled={pending || (exclusiveBusy && acquireBusy)}
            onChange={setIntent}
            options={[
              { value: "install", label: "Update now" },
              ...(selectedIntent === "prepare"
                ? [{ value: "prepare" as const, label: "Prepare for later" }]
                : []),
              ...(!existingArchive
                ? [{ value: "download" as const, label: "Download for later" }]
                : []),
            ]}
          />
          <details>
            <summary data-focusable>Advanced update choice</summary>
            <Button
              data-focusable
              variant="outline"
              disabled={pending || (exclusiveBusy && acquireBusy)}
              onClick={() => setIntent("prepare")}
            >
              Prepare for later
            </Button>
            <p>
              Prepare verified staged content without activating it. A downloaded archive still
              needs preparation.
            </p>
          </details>
        </div>
      )}
      {!archiveOnly && (
        <Button
          ref={reviewButton}
          data-focusable
          className={plan ? "hidden" : undefined}
          hidden={Boolean(plan)}
          variant={compact || props.primary === false ? "outline" : "primary"}
          disabled={
            (selectedIntent === "download" ? acquireBusy : exclusiveBusy) || pending || !perform
          }
          onClick={() => void review()}
        >
          {pending ? "Checking update…" : "Review game update"}
        </Button>
      )}
      {!archiveOnly && plan && reviewScope?.active !== false && (
        <GameUpdatePlanDialog
          control={control}
          currentVersion={props.currentVersion}
          heading={heading}
          finalFocus={finalFocus}
        />
      )}
      {discardReview && reviewScope?.active !== false && (
        <GameUpdateDiscardDialog
          control={control}
          portId={props.portId}
          discardHeading={discardHeading}
          actionRegion={actionRegion}
        />
      )}
      {!plan && operation && (
        <OperationCancellation
          key={operation}
          operationId={operation}
          label={downloadOnly ? "Cancel archive download" : "Cancel game update"}
        />
      )}
      {!plan && message && <p role="status">{message}</p>}
      {!plan && error && <p role="alert">{error}</p>}
      {!plan && failure && <GameUpdateFailure value={failure.value} />}
    </section>
  );
}

function GameUpdateReviewActions({
  control,
  reviewed,
  actionLabel,
}: {
  control: ReturnType<typeof useGameUpdateControl>;
  reviewed: GameUpdatePlan;
  actionLabel: string | undefined;
}) {
  const { applying, dismissReview, busy, pending, perform, apply, downloadOnly, review } = control;
  return (
    <DialogFooter className="mt-4">
      {applying && (
        <Button data-focusable variant="outline" onClick={dismissReview}>
          Continue browsing
        </Button>
      )}
      {installPlanActionLabel(reviewed.plan.action) ? (
        actionLabel ? (
          <Button
            data-focusable
            variant="primary"
            disabled={busy || pending || !perform}
            onClick={() => void apply()}
          >
            {updateActionProgressLabel(pending, applying, downloadOnly, actionLabel)}
          </Button>
        ) : null
      ) : (
        <Button
          data-focusable
          variant="primary"
          disabled={busy || pending}
          onClick={() => void review()}
        >
          Review game update again
        </Button>
      )}
      {installPlanActionLabel(reviewed.plan.action) && (
        <GameUpdateAlternativeActions control={control} reviewed={reviewed} />
      )}
      <Button data-focusable variant="outline" disabled={busy || pending} onClick={dismissReview}>
        Cancel review
      </Button>
    </DialogFooter>
  );
}

function GameUpdateAlternativeActions({
  control,
  reviewed,
}: {
  control: ReturnType<typeof useGameUpdateControl>;
  reviewed: GameUpdatePlan;
}) {
  const {
    exclusiveBusy,
    pending,
    review,
    downloadOnly,
    hasRetainedArchive: existingArchive,
    acquireBusy,
  } = control;
  return (
    <>
      {!reviewed.activate && (
        <Button
          data-focusable
          variant="outline"
          disabled={exclusiveBusy || pending}
          onClick={() => void review("install")}
        >
          Update now
        </Button>
      )}
      {reviewed.activate && reviewed.plan.action !== "download" && (
        <Button
          data-focusable
          variant="outline"
          disabled={exclusiveBusy || pending}
          onClick={() => void review("prepare")}
        >
          Keep for later
        </Button>
      )}
      {reviewed.plan.action === "download" && (downloadOnly || reviewed.activate) && (
        <Button
          data-focusable
          variant="outline"
          disabled={exclusiveBusy || pending}
          onClick={() => void review("prepare")}
        >
          Prepare for later
        </Button>
      )}
      {reviewed.plan.action === "download" &&
        !downloadOnly &&
        !existingArchive &&
        !reviewed.acquisition && (
          <Button
            data-focusable
            variant="outline"
            disabled={acquireBusy || pending}
            onClick={() => void review("download")}
          >
            Download for later
          </Button>
        )}
    </>
  );
}

function RetainedUpdateArchive({
  control,
  portId,
}: {
  control: ReturnType<typeof useGameUpdateControl>;
  portId: string;
}) {
  const { acquisition, exclusiveBusy, pending, discardButton, reviewDiscard } = control;
  if (!acquisition) return null;
  return (
    <section
      className="my-3 rounded-pc-md border border-pc-border p-3"
      aria-label="Retained update archive"
    >
      <h4 className="text-sm">
        {acquisition.port_id === portId
          ? gameUpdateAcquisitionLabel(acquisition.phase)
          : "Archive identity unavailable"}
      </h4>
      <p className="mt-2 text-sm">
        {acquisition.release.version} ·{" "}
        {releaseChannelPresentation(acquisition.release.channel).label}
      </p>
      <p className="mt-2 text-xs text-pc-muted-foreground">
        An archive is separate from a prepared update. Downloading it does not prepare game files,
        write saved data or change the current version.
      </p>
      <details className="mt-2 text-xs">
        <summary data-focusable className="cursor-pointer py-1">
          Archive details
        </summary>
        <dl className="mt-2 grid gap-2 [overflow-wrap:anywhere]">
          <div>
            <dt>Acquisition ID</dt>
            <dd>{acquisition.id}</dd>
          </div>
          <div>
            <dt>Archive</dt>
            <dd>{acquisition.release.asset.name}</dd>
          </div>
          <div>
            <dt>SHA-256</dt>
            <dd>
              <code>{acquisition.release.asset.sha256}</code>
            </dd>
          </div>
        </dl>
      </details>
      {acquisition.port_id === portId &&
        ["acquired", "attention_required"].includes(acquisition.phase) && (
          <Button
            ref={discardButton}
            data-focusable
            variant="outline"
            size="sm"
            className="mt-3"
            disabled={exclusiveBusy || pending}
            onClick={() => reviewDiscard(acquisition)}
          >
            Discard archive…
          </Button>
        )}
    </section>
  );
}

function GameUpdatePlanDialog({
  control,
  currentVersion,
  heading,
  finalFocus,
}: {
  control: ReturnType<typeof useGameUpdateControl>;
  currentVersion: string | undefined;
  heading: RefObject<HTMLHeadingElement | null>;
  finalFocus: () => HTMLElement | false;
}) {
  const {
    plan,
    downloadOnly,
    hasRetainedArchive: existingArchive,
    applying,
    busy,
    pending,
    dismissReview,
    descriptionId,
    titleId,
    gameName,
    operation,
    message,
    error,
  } = control;
  if (!plan) return null;
  const actionLabel = gameUpdateActionLabel(plan, downloadOnly, existingArchive && !applying);
  return (
    <Dialog
      open
      onOpenChange={(nextOpen) => {
        if (!nextOpen && !busy && !pending) dismissReview();
      }}
    >
      <DialogContent
        initialFocus={heading}
        className="@container/update-review"
        showCloseButton={false}
        finalFocus={finalFocus}
        reviewSize="standard"
        data-game-update-review
        aria-describedby={descriptionId}
      >
        <DialogTitle ref={heading} tabIndex={-1} id={titleId} className="mb-2 text-xl">
          {gameName ? `${gameName} update` : "Review game update"}
        </DialogTitle>
        <DialogDescription id={descriptionId} className="mb-4 leading-relaxed">
          {downloadOnly
            ? "Review the exact archive to download. Preparation and activation require another review."
            : "Confirm the release and what happens to your active version before updating."}
        </DialogDescription>
        <GameUpdateReview
          plan={plan}
          downloadOnly={downloadOnly}
          existingArchive={existingArchive && !applying}
          currentVersion={currentVersion}
        />
        {operation && (
          <OperationCancellation
            key={operation}
            operationId={operation}
            label={downloadOnly ? "Cancel archive download" : "Cancel game update"}
          />
        )}
        {message && <p role="status">{message}</p>}
        {error && <p role="alert">{error}</p>}
        <GameUpdateReviewActions control={control} reviewed={plan} actionLabel={actionLabel} />
      </DialogContent>
    </Dialog>
  );
}

function GameUpdateDiscardDialog({
  control,
  portId,
  discardHeading,
  actionRegion,
}: {
  control: ReturnType<typeof useGameUpdateControl>;
  portId: string;
  discardHeading: RefObject<HTMLHeadingElement | null>;
  actionRegion: RefObject<HTMLElement | null>;
}) {
  const {
    discardReview,
    setDiscardReview,
    pending,
    applying,
    discardButton,
    reviewButton,
    gameName,
    acquisition,
    exclusiveBusy,
    perform,
    discard,
  } = control;
  if (!discardReview) return null;
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !pending) setDiscardReview(undefined);
      }}
    >
      <DialogContent
        initialFocus={discardHeading}
        showCloseButton={false}
        reviewSize="standard"
        data-game-update-discard-review
        finalFocus={() => {
          if (applying) return actionRegion.current;
          if (discardButton.current?.isConnected && !discardButton.current.disabled)
            return discardButton.current;
          if (reviewButton.current?.isConnected && !reviewButton.current.disabled)
            return reviewButton.current;
          return actionRegion.current;
        }}
      >
        <DialogTitle ref={discardHeading} tabIndex={-1}>
          Discard update archive?
        </DialogTitle>
        <DialogDescription>
          Discard only this retained archive. Installed versions, prepared updates and saved data
          are unchanged.
        </DialogDescription>
        <dl className="my-4 grid gap-3 [overflow-wrap:anywhere]">
          <div>
            <dt>Game</dt>
            <dd>{gameName ?? portId}</dd>
          </div>
          <div>
            <dt>Version</dt>
            <dd>{discardReview.release.version}</dd>
          </div>
          <div>
            <dt>Acquisition ID</dt>
            <dd>
              <code>{discardReview.id}</code>
            </dd>
          </div>
          <div>
            <dt>Archive SHA-256</dt>
            <dd>
              <code>{discardReview.release.asset.sha256}</code>
            </dd>
          </div>
        </dl>
        {discardReview.id !== acquisition?.id && (
          <p role="status">
            The retained archive changed. Keep this review closed and review the current archive
            before discarding it.
          </p>
        )}
        <DialogFooter>
          <Button
            data-focusable
            variant="destructive"
            disabled={exclusiveBusy || pending || !perform || discardReview.id !== acquisition?.id}
            onClick={() => void discard()}
          >
            {pending ? "Discarding archive…" : "Discard archive"}
          </Button>
          <Button
            data-focusable
            variant="outline"
            disabled={pending}
            onClick={() => setDiscardReview(undefined)}
          >
            Keep archive
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function updateActionProgressLabel(
  pending: boolean,
  applying: boolean,
  downloadOnly: boolean,
  actionLabel: string | undefined,
) {
  if (!pending) return actionLabel;
  if (!applying) return "Checking update…";
  return downloadOnly ? "Downloading archive…" : "Updating…";
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

function gameUpdateActionLabel(
  plan: GameUpdatePlan,
  downloadOnly = false,
  existingArchive = false,
) {
  if (
    plan.assessment?.action !== "update" ||
    plan.assessment.availability !== "allowed" ||
    plan.assessment.reason !== "available" ||
    plan.assessment.definition != null
  )
    return undefined;
  if (downloadOnly)
    return !plan.activate &&
      plan.plan.action === "download" &&
      !plan.acquisition &&
      !existingArchive
      ? "Download archive for later"
      : undefined;
  const labels: Record<GameUpdatePlan["plan"]["action"], string | undefined> = {
    download: plan.activate
      ? plan.acquisition
        ? "Update now"
        : "Download and install update"
      : "Prepare update for later",
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
  downloadOnly,
  existingArchive,
}: {
  plan: GameUpdatePlan;
  currentVersion?: string | undefined;
  downloadOnly: boolean;
  existingArchive: boolean;
}) {
  const label = gameUpdateActionLabel(plan, downloadOnly, existingArchive);
  if (!installPlanActionLabel(plan.plan.action))
    return (
      <div className="install-plan mt-[16px] grid grid-cols-1 [align-items:end] gap-[18px] rounded-pc-lg border border-pc-border bg-pc-surface p-[14px] @min-[32rem]/update-review:grid-cols-2">
        <p className="mb-[5px]" role="alert">
          This version of Portcove cannot display this update plan. Review it again, or update
          Portcove if this continues.
        </p>
      </div>
    );
  return (
    <div className="install-plan mt-[16px] grid grid-cols-1 [align-items:end] gap-[18px] rounded-pc-lg border border-pc-border bg-pc-surface p-[14px] @min-[32rem]/update-review:grid-cols-2">
      <p className="mb-[5px]">
        <span className="mb-2 block text-pc-muted-foreground">
          Current version: {currentVersion ?? "Unavailable"}
        </span>
        <span className="block text-pc-muted-foreground">Update candidate</span>
        <strong className="block text-[length:var(--text-sm)]">
          {plan.plan.release.version}
        </strong>{" "}
        · {releaseChannelPresentation(plan.plan.channel).label}
      </p>
      <p className="mb-[5px]">
        {plan.acquisition
          ? "Use the retained archive after verifying its identity again. No new archive download is planned."
          : plan.plan.action === "download"
            ? `${formatBytes(plan.plan.download_bytes)} to download`
            : plan.plan.action === "blocked_unverified"
              ? "The local copy has not been verified."
              : "No download; use the verified local release."}
      </p>
      {label && (
        <p className="col-span-full mb-[5px]">
          {downloadOnly
            ? "Download only the immutable archive. Game files, installation folders, saved data and the active version stay unchanged. Preparing or installing requires a fresh review."
            : plan.activate
              ? "The verified update becomes active and the current version remains available for rollback."
              : "This keeps the prepared update for later. Your current version stays unchanged."}{" "}
          Saved update settings are unchanged.
        </p>
      )}
      {!label ? (
        <p className="mb-[5px]" role="status">
          {downloadOnly && (existingArchive || plan.acquisition)
            ? "An archive is already retained. Review preparing or installing it, or discard it before another download."
            : gameUpdateHoldReason(plan)}
        </p>
      ) : null}
      {plan.plan.preservation_notices?.map((notice) => (
        <p key={notice} className="col-span-full text-[length:var(--text-sm)]">
          {notice}
        </p>
      ))}
      {plan.acquisition && (
        <p className="col-span-full text-xs [overflow-wrap:anywhere]">
          Selected archive: <code>{plan.acquisition.id}</code> · SHA-256{" "}
          <code>{plan.acquisition.release.asset.sha256}</code>. This archive does not authorize
          installation.
        </p>
      )}
      {label && !downloadOnly && plan.activate && (
        <div className="col-span-full border-t border-pc-border pt-3 [overflow-wrap:anywhere]">
          <span className="block text-pc-muted-foreground">Saves and settings folder</span>
          <bdi dir="ltr" className="block">
            {plan.plan.output_location.user_data_root}
          </bdi>
          <p className="mt-2 mb-0">
            Keeping the previous game version is separate from backing up saved data. Save
            compatibility between versions is not checked here. Review backup options in Saves and
            storage.
          </p>
        </div>
      )}
      {!downloadOnly && plan.plan.shared_preferences && (
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
