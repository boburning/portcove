export const browserTraceProbe = {
  name: "retains an intentional browser UI failure trace",
  failure: "PORTCOVE_EXPECTED_BROWSER_TRACE_FAILURE",
  environment: "VITE_PORTCOVE_BROWSER_TRACE_PROBE",
  reason: "Intentional browser failure diagnostic is disabled outside its probe",
  intendedRoute:
    ".github/workflows/browser-artifact-custody.yml: browser:trace-probe (expected failure)",
} as const;
