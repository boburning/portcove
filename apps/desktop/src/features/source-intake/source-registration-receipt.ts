import { desktopApi } from "../../api";
import { errorText, isCancellation } from "../../view-model";
import type { OperationEvent, SourceImportPlan } from "../../types";
import {
  mutationNeedsReadback,
  sourceImportRecoveryGuidance,
  targetInvocationContext,
} from "../operations/invocation-state";
import type { Perform } from "../operations/use-operation-state";

export function sourceImportCancelledWithoutChanges(value: unknown) {
  return isCancellation(value) && !mutationNeedsReadback(value);
}

export function sourceImportApplyError(value: unknown) {
  const detail = errorText(value);
  return mutationNeedsReadback(value) && detail !== sourceImportRecoveryGuidance
    ? detail + " " + sourceImportRecoveryGuidance
    : detail;
}

export async function applyReviewedSourceImport({
  perform,
  plan,
  action,
  label,
  generation,
  refresh,
  onEvent,
}: {
  perform?: Perform | undefined;
  plan: SourceImportPlan;
  action: string;
  label: string;
  generation: number;
  refresh?: (() => Promise<unknown>) | undefined;
  onEvent?: ((event: OperationEvent) => void) | undefined;
}) {
  let refreshFailed = false;
  const readback = async () => {
    try {
      await refresh?.();
    } catch (value) {
      refreshFailed = true;
      throw value;
    }
  };
  const task = async (report?: (event: OperationEvent) => void) => {
    const result = await desktopApi.importSource(
      plan.profile_id,
      plan.source.path,
      plan.mode,
      plan.plan_sha256,
      generation,
      ...(report || onEvent
        ? [
            (event: OperationEvent) => {
              report?.(event);
              onEvent?.(event);
            },
          ]
        : []),
    );
    if (
      result !== null &&
      (!result?.registered?.path ||
        result.profile_id !== plan.profile_id ||
        result.registered.profile_id !== plan.profile_id)
    )
      throw new Error("Portcove couldn’t confirm the saved file location. Refresh the library.");
    return result;
  };
  if (!perform) {
    const result = await task();
    if (result) await readback().catch(() => {});
    return { result, refreshFailed };
  }
  const result = await perform(action, task, {
    context: {
      ...targetInvocationContext(
        action,
        { kind: "source", id: plan.profile_id, label },
        generation,
      ),
      operation: "import_source",
    },
    sourceRegistrationResult: (result) => result?.registered,
    refresh: async (result) => {
      if (result) await readback();
    },
    invalidateDiagnostics: !refresh,
    cancelledResult: (result) => result === null,
    propagateFailure: true,
  });
  return { result, refreshFailed };
}
