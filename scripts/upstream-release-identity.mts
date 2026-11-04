/** Fixed, disposable rehearsal identity. This does not activate production. */
import { upstreamRehearsalExecutionRef } from "./release-source-attestation.mts";
export const rehearsalExecutionRef = upstreamRehearsalExecutionRef;
export const rehearsalConcurrency = "application-update-production-controller";

export function rehearsalExecution(environment: NodeJS.ProcessEnv = process.env) {
  const source = environment.GITHUB_SHA ?? "";
  const run_id = environment.GITHUB_RUN_ID ?? "";
  const run_attempt = Number(environment.GITHUB_RUN_ATTEMPT);
  if (
    environment.GITHUB_REPOSITORY !== "boburning/portcove" ||
    environment.GITHUB_REPOSITORY_ID !== "1354613114" ||
    environment.GITHUB_REF !== rehearsalExecutionRef ||
    environment.GITHUB_REF_PROTECTED !== "true" ||
    environment.GITHUB_EVENT_NAME !== "workflow_dispatch" ||
    !/^[a-f0-9]{40}$/u.test(source) ||
    !/^[1-9][0-9]{0,15}$/u.test(run_id) ||
    !Number.isSafeInteger(Number(run_id)) ||
    !Number.isSafeInteger(run_attempt) ||
    run_attempt < 1 ||
    run_attempt > 3
  )
    throw new Error("rehearsal requires its appointed protected dispatch ref and exact identity");
  return { source, run_id, run_attempt };
}

/** Native failed-only reruns retain successful producer outputs. Missing or
 * future origins refuse; an executor retry cannot allocate replacement bytes. */
export function rehearsalOrigin(environment: NodeJS.ProcessEnv = process.env) {
  const execution = rehearsalExecution(environment);
  const raw = environment.PORTCOVE_REHEARSAL_ORIGIN_ATTEMPT;
  const attempt = raw === undefined ? execution.run_attempt : Number(raw);
  if (
    (raw !== undefined && !/^[1-9][0-9]{0,5}$/u.test(raw)) ||
    !Number.isSafeInteger(attempt) ||
    attempt < 1 ||
    attempt > execution.run_attempt
  )
    throw new Error("original rehearsal producer attempt is unavailable or in the future");
  return { ...execution, run_attempt: attempt };
}

export function rehearsalPublicBase(origin: { run_id: string; run_attempt: number }) {
  if (
    !/^[1-9][0-9]{0,15}$/u.test(origin.run_id) ||
    !Number.isSafeInteger(origin.run_attempt) ||
    origin.run_attempt < 1
  )
    throw new Error("exact rehearsal namespace identity required");
  return `https://boburning.github.io/portcove/rehearsal/${origin.run_id}-${origin.run_attempt}/application/`;
}
