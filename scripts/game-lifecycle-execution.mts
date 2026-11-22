import { createHash } from "node:crypto";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import {
  gameLifecycleChecks,
  inspectGameLifecyclePreparation,
  verifyGameLifecyclePhaseFiles,
  verifyGameLifecyclePredicate,
} from "./game-lifecycle-receipt.mts";
import type { ExpectedGameLifecycle } from "./game-lifecycle-receipt.mts";
import { isRecord } from "./runtime-values.mts";

const digest = (value: Buffer) => createHash("sha256").update(value).digest("hex");
const encode = (value: unknown) => Buffer.from(`${JSON.stringify(value)}\n`, "utf8");
type Check = (typeof gameLifecycleChecks)[number];
type Job = Pick<ExpectedGameLifecycle, "run_id" | "run_attempt" | "job_id" | "platform">;

interface BoundGameLifecycleWork {
  /** Exact stdout of the fixed Core preparation command after independent admission. */
  preparation: Buffer;
  executable_sha256: string;
  source_variant: { game_id: string; variant_id: string; representation_id: string };
  output: string;
  /** Unprivileged worker invokes each normal phase and emits bounded redacted evidence. */
  phases: Record<Check, () => Promise<unknown>>;
}

/**
 * Use this only on materialized, independently admitted inputs. It owns
 * ordered checks and immutable evidence from one unprivileged native job.
 */
export async function executeGameLifecycle(
  job: Job,
  work: BoundGameLifecycleWork | undefined,
  now = () => Math.floor(Date.now() / 1000),
) {
  if (!work) return { outcome: "no-eligible-input", authority: "none" } as const;
  const preparation = inspectGameLifecyclePreparation(work.preparation);
  if (
    preparation.platform !== job.platform ||
    !path.isAbsolute(work.output) ||
    !/^[a-f0-9]{64}$/u.test(work.executable_sha256)
  )
    throw new Error("Verified Core preparation has no exact compatible Windows pair");
  const started = now();
  if (preparation.selected_at > started) throw new Error("Core selection clock is in the future");
  const checkPlan = encode({
    schema: 1,
    rule_version: preparation.rule_version,
    checks: gameLifecycleChecks,
  });
  const write = async (name: string, content: Buffer) => {
    if (content.length > 128 * 1024 && name !== "successor-preparation.json")
      throw new Error("Lifecycle evidence exceeds the maximum phase size");
    await writeFile(path.join(work.output, name), content, { flag: "wx", mode: 0o600 });
  };
  const bindings = {
    ...job,
    preparation_sha256: digest(work.preparation),
    executable_sha256: work.executable_sha256,
    check_plan_sha256: digest(checkPlan),
  };
  await write("successor-preparation.json", work.preparation);
  await write("check-plan.json", checkPlan);
  const checks: Partial<Record<Check, { outcome: "passed"; evidence_sha256: string }>> = {};
  for (const check of gameLifecycleChecks) {
    let observation;
    try {
      observation = await work.phases[check]();
      if (!isRecord(observation) || observation.outcome !== "passed")
        throw new Error("Mandatory phase did not pass");
      const bytes = encode({ ...observation, check });
      await write(`${check}.json`, bytes);
      checks[check] = { outcome: "passed", evidence_sha256: digest(bytes) };
    } catch (error) {
      // Scope and phase only. Keep captured local diagnostics separately.
      await write("terminal.json", encode({ check, outcome: "failed", authority: "none" }));
      throw error;
    }
  }
  const completed = now();
  const statement = {
    schema: 1,
    ...bindings,
    started_at: started,
    completed_at: completed,
    source_variant: work.source_variant,
    checks,
  };
  const receipt = verifyGameLifecyclePredicate(statement, {
    ...bindings,
    selected_at: preparation.selected_at,
    now: completed,
  });
  await verifyGameLifecyclePhaseFiles(work.output, preparation, receipt, bindings);
  await write("predicate.json", encode(statement));
  return { outcome: "ready-for-independent-attestation", authority: "none" } as const;
}
