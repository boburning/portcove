import { isRecord } from "./runtime-values.mts";

// Shared by the executable runner and the hosted intake executor. Keep these
// bindings outside both entry modules: an entry module that another module
// imports can deadlock its own top-level await (#8417).

export const hostedIntakeMaxPasses = 12;

export interface AuditContinuation {
  request: number;
  binding: string;
}

export function assertScheduledAuditCaller(environment: NodeJS.ProcessEnv) {
  if (
    environment.GITHUB_EVENT_NAME !== "schedule" ||
    environment.GITHUB_REPOSITORY !== "boburning/portcove" ||
    environment.GITHUB_REF !== "refs/heads/main" ||
    environment.GITHUB_WORKFLOW_REF !==
      "boburning/portcove/.github/workflows/maintenance-inventory.yml@refs/heads/main"
  )
    throw new Error("Only the protected maintenance schedule may resume owner-authorized audits");
}

export function scheduledAuditRequests(environment: NodeJS.ProcessEnv): AuditContinuation[] {
  if (environment.HOSTED_INTAKE_MODE !== "resume-audits") return [];
  assertScheduledAuditCaller(environment);
  const parsed: unknown = JSON.parse(environment.HOSTED_INTAKE_AUDIT_CONTINUATIONS ?? "null");
  if (
    !Array.isArray(parsed) ||
    !parsed.length ||
    parsed.some(
      (value) =>
        !isRecord(value) ||
        !Number.isSafeInteger(value.request) ||
        Number(value.request) < 1 ||
        typeof value.binding !== "string" ||
        !/^[0-9a-f]{64}$/u.test(value.binding),
    ) ||
    new Set(parsed.map((value: AuditContinuation) => value.request)).size !== parsed.length
  )
    throw new Error("Invalid bound audit continuation selection");
  return parsed as AuditContinuation[];
}
