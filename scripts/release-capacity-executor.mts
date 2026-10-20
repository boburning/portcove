import { performance } from "node:perf_hooks";
import {
  inspectAssemblerIdentityExpectation,
  requestAssemblerToken,
  verifyCapacityExecutorJobIdentity,
} from "./assembler-job-identity.mts";
import type { CapacityExecutorRole } from "./assembler-job-identity.mts";
import { capacityDigest } from "./release-capacity.mts";

export interface CapacityExecutorIdentity {
  controller_revision: string;
  execution_ref: string;
  workflow: string;
  run_id: string;
  run_attempt: number;
  job_id: number;
  check_run_id: string;
  actor_id: string;
  role: CapacityExecutorRole;
}
interface ExecutorSession {
  readonly kind: "authenticated-capacity-executor";
}
interface PrivateSession {
  role: CapacityExecutorRole;
  expected: ReturnType<typeof inspectAssemblerIdentityExpectation>;
  directory: string;
  identity: CapacityExecutorIdentity;
  observed: number;
}
const sessions = new WeakMap<ExecutorSession, PrivateSession>();
const audience = "portcove-capacity-executor";

async function observe(
  role: CapacityExecutorRole,
  expected: ReturnType<typeof inspectAssemblerIdentityExpectation>,
  directory: string,
): Promise<CapacityExecutorIdentity> {
  if (expected.audience !== audience)
    throw new Error("capacity executor audience differs from its fixed role");
  const token = await requestAssemblerToken(audience);
  const actual = await verifyCapacityExecutorJobIdentity(role, token, expected, {
    transport: { cwd: directory },
  });
  if (actual.evidence_scope !== "github.com")
    throw new Error("capacity executor requires actual provider identity");
  return {
    controller_revision: actual.workflow_revision,
    execution_ref: actual.execution_ref,
    workflow: actual.workflow,
    run_id: actual.run_id,
    run_attempt: actual.run_attempt,
    job_id: actual.job_id,
    check_run_id: actual.check_run_id,
    actor_id: actual.actor_id,
    role: actual.role,
  };
}

/** Direct current-job authentication. No imported report, token, test transport
 * or caller-supplied identity can create a session. This does not prove fresh
 * admission/protections or grant permission to execute a provider effect. */
export async function authenticateCapacityExecutor(
  role: CapacityExecutorRole,
  rawExpected: unknown,
  directory: string,
): Promise<ExecutorSession> {
  const expected = inspectAssemblerIdentityExpectation(structuredClone(rawExpected));
  const identity = await observe(role, expected, directory);
  const session: ExecutorSession = Object.freeze({ kind: "authenticated-capacity-executor" });
  sessions.set(session, { role, expected, directory, identity, observed: performance.now() });
  return session;
}

export function capacityExecutorIdentity(session: ExecutorSession): CapacityExecutorIdentity {
  const value = sessions.get(session);
  if (!value || performance.now() - value.observed > 60_000)
    throw new Error("actual fresh executor session unavailable");
  return structuredClone(value.identity);
}

/** Reauthenticate the same exact job before effect/readback; a completed,
 * changed or replaced job cannot inherit the public nonce or checkpoint. */
export async function refreshCapacityExecutor(session: ExecutorSession) {
  const value = sessions.get(session);
  if (!value) throw new Error("imported executor sessions cannot execute or recover");
  const actual = await observe(value.role, value.expected, value.directory);
  if (capacityDigest(actual) !== capacityDigest(value.identity))
    throw new Error("capacity executor identity changed during the attempt");
  value.observed = performance.now();
  return structuredClone(value.identity);
}
