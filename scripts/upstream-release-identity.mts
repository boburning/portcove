/** Fixed, disposable rehearsal identity. This does not activate production. */
import { upstreamRehearsalExecutionRef } from "./release-source-attestation.mts";
export const rehearsalExecutionRef = upstreamRehearsalExecutionRef;
export const rehearsalConcurrency = "application-update-production-controller";
// One fixed continuation of an already signed and immutable public cohort.
// These identities never come from dispatch input or the new executor.
export const retainedRehearsal = Object.freeze({
  source: "7a60432ab6c3773f744af156c0512cd1795b10c1",
  run_id: "41788540335",
  run_attempt: 1,
  ref: "refs/tags/portcove-upstream-rehearsal-20261104r2",
  unsigned_artifact: 13303098854,
  release_id: 433642404,
  signed_artifact: 13303950552,
  acceptance_artifact: 13305366285,
  candidate_artifact: 13303068945,
  predecessor_artifact: 13305615469,
  manifest_sha256: "b0c7ed2a50471325ded9385e57386080aa51f61a82ee2adead1042ce9aba6c9c",
  original_deadline: "2026-11-04T09:18:43Z",
  deadline: "2026-11-04T09:48:43Z",
});
// Preserve the settled diagnostic execution separately from the product producer.
export const retainedRecovery = Object.freeze({
  source: "4aba7f0beeea4befdd4595bdbb052b8908d340af",
  run_id: "41806364323",
  run_attempt: 1,
  ref: "refs/tags/portcove-upstream-rehearsal-20261104r3",
});
export const retainedDiagnostic = Object.freeze({
  source: "22cfaab1ffd6548e1f85dff1b012d20dc1b80d78",
  run_id: "41811038103",
  run_attempt: 1,
  ref: "refs/tags/portcove-upstream-rehearsal-20261104r4",
});
export const rehearsalOriginRef = retainedRehearsal.ref;

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
    run_attempt !== 1 ||
    run_id === retainedRehearsal.run_id ||
    run_id === retainedRecovery.run_id ||
    run_id === retainedDiagnostic.run_id ||
    source === retainedDiagnostic.source ||
    source === retainedRecovery.source ||
    source === retainedRehearsal.source
  )
    throw new Error("rehearsal requires its appointed protected dispatch ref and exact identity");
  return { source, run_id, run_attempt };
}

/** The r5 repaired-harness continuation cannot allocate a fresh payload cohort. */
export function rehearsalOrigin(environment: NodeJS.ProcessEnv = process.env): {
  source: string;
  run_id: string;
  run_attempt: number;
} {
  rehearsalExecution(environment);
  const raw = environment.PORTCOVE_REHEARSAL_ORIGIN_ATTEMPT;
  if (raw !== undefined && raw !== "1")
    throw new Error("original rehearsal producer attempt is unavailable or in the future");
  return { source: retainedRehearsal.source, run_id: retainedRehearsal.run_id, run_attempt: 1 };
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
