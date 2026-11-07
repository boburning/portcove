/** Closed public observations, never raw compiler output or private error text. */
export function gtkQualificationObservation(
  phase: string,
  execution?: { status: number | null; signal: string | null; output: string },
) {
  const phases = new Set([
    "source",
    "output",
    "provenance",
    "control",
    "patched-execution",
    "patched-observation",
    "unpatched-execution",
    "unpatched-observation",
    "result",
    "complete",
  ]);
  const signals = new Set([
    "SIGTERM",
    "SIGKILL",
    "SIGABRT",
    "SIGSEGV",
    "SIGBUS",
    "SIGILL",
    "SIGINT",
  ]);
  const rustErrors = new Set<string>();
  if (execution) {
    for (const match of execution.output.matchAll(/\berror\[(E[0-9]{4})\]/gu)) {
      if (match[1]) rustErrors.add(match[1]);
      if (rustErrors.size === 8) break;
    }
  }
  return {
    phase: phases.has(phase) ? phase : "unknown",
    status:
      execution &&
      Number.isSafeInteger(execution.status) &&
      execution.status !== null &&
      execution.status >= 0 &&
      execution.status <= 255
        ? execution.status
        : null,
    signal: execution?.signal && signals.has(execution.signal) ? execution.signal : null,
    constructor_marker: execution ? execution.output.includes("PORTCOVE_RFD_TEXT_PROBE") : null,
    rust_errors: [...rustErrors].sort((left, right) => left.localeCompare(right)),
  };
}
