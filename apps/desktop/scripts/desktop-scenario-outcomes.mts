import { isUntrustworthyProbeError } from "./desktop-owned-ipc-probe.mts";
import { errorMessage } from "../../../scripts/runtime-values.mts";

export interface ScenarioObservation {
  outcome: "passed" | "failed";
  duration_ms: number;
  message?: string;
}

export async function observeDesktopScenario(
  action: () => unknown,
  effects: {
    record: (observation: ScenarioObservation) => void;
    diagnostics: () => Promise<void>;
    screenshot: () => Promise<void>;
  },
  clock = () => performance.now(),
) {
  const started = clock();
  let failed = false;
  let failure: unknown;
  try {
    await action();
  } catch (error) {
    failed = true;
    failure = error;
  }
  const duration_ms = clock() - started;
  const untrustworthy = failed && isUntrustworthyProbeError(failure);
  try {
    effects.record({
      outcome: failed ? "failed" : "passed",
      duration_ms,
      ...(failed ? { message: errorMessage(failure) } : {}),
    });
    if (failed) await effects.diagnostics();
    if (!untrustworthy) await effects.screenshot();
  } catch (error) {
    throw failed ? failure : error;
  }
  if (untrustworthy) throw failure;
}
