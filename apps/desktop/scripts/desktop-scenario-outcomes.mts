import type { EvidenceCheck } from "../../../scripts/development-evidence.mts";
import { isUntrustworthyProbeError } from "./desktop-owned-ipc-probe.mts";
import { errorMessage } from "../../../scripts/runtime-values.mts";

export interface ScenarioObservation {
  outcome: "passed" | "failed";
  duration_ms: number;
  message?: string;
}

export function recordDesktopCheck(
  records: EvidenceCheck[],
  revision: string,
  check: EvidenceCheck,
) {
  records.push(check);
  if (check.outcome !== "failed") return;
  const message = check.message ?? "Native harness failed";
  console.error(
    `DESKTOP_FAILURE ${JSON.stringify({
      format_version: 1,
      runner: "native-desktop",
      source: { kind: "declared-harness-revision", revision },
      platform: process.platform,
      architecture: process.arch,
      scenario: check.scenario,
      outcome: "failed",
      duration_ms: check.duration_ms ?? null,
      duration_scope: check.duration_scope ?? "harness",
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
