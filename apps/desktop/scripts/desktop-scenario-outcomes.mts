import { isUntrustworthyProbeError } from "./desktop-owned-ipc-probe.mts";
import { errorMessage } from "../../../scripts/runtime-values.mts";

export interface ScenarioObservation {
  outcome: "passed" | "failed";
  duration_ms: number;
  message?: string;
}

export function retainDesktopScenarioFailure(
  revision: string,
  scenario: string,
  observation: { message?: string; duration_ms?: number | null },
) {
  const message = observation.message ?? "Native scenario failed";
  console.error(
    `DESKTOP_SCENARIO_FAILURE ${JSON.stringify({
      format_version: 1,
      runner: "native-desktop",
      source: { kind: "declared-harness-revision", revision },
      platform: process.platform,
      architecture: process.arch,
      scenario,
      outcome: "failed",
      duration_ms: observation.duration_ms ?? null,
      duration_scope: "scenario-action",
      message: message.slice(0, 4096),
      message_truncated: message.length > 4096,
    })}`,
  );
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
