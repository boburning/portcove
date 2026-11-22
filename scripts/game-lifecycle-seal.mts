import { createHash } from "node:crypto";
import path from "node:path";
import { createReleaseCustodyProvider } from "./release-custody-provider.mts";
import { readBoundedPublicBuildInputFile } from "./release-public-build-inputs.mts";
import {
  inspectGameLifecyclePreparation,
  verifyGameLifecyclePhaseFiles,
  verifyGameLifecycleJob,
  verifyGameLifecyclePredicate,
} from "./game-lifecycle-receipt.mts";
import { isRecord } from "./runtime-values.mts";

const digest = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");

/** Final attestation job only. The directory must be the fixed artifact
 * downloaded from the named required native job in this same attempt. */
export async function sealGameLifecycle(
  directory: string,
  identity: { run_id: string; run_attempt: number; source_commit: string; job_id: string },
) {
  if (
    !/^[1-9][0-9]{0,15}$/u.test(identity.run_id) ||
    !/^[1-9][0-9]{0,15}$/u.test(identity.job_id) ||
    !Number.isSafeInteger(identity.run_attempt) ||
    identity.run_attempt < 1 ||
    !/^[a-f0-9]{40}$/u.test(identity.source_commit)
  )
    throw new Error("Game lifecycle original job identity is unavailable");
  const read = (name: string, limit = 128 * 1024) =>
    readBoundedPublicBuildInputFile(directory, name, limit);
  const preparedBytes = await read("successor-preparation.json", 256 * 1024);
  const prepared = inspectGameLifecyclePreparation(preparedBytes);
  const predicate: unknown = JSON.parse((await read("predicate.json", 8192)).toString("utf8"));
  const plan = await read("check-plan.json", 8192);
  if (!isRecord(predicate) || typeof predicate.executable_sha256 !== "string")
    throw new Error("Attestation requires the original bound executable");
  const expected = {
    ...identity,
    platform: prepared.platform,
    selected_at: prepared.selected_at,
    now: Math.floor(Date.now() / 1000),
    preparation_sha256: digest(preparedBytes),
    check_plan_sha256: digest(plan),
    executable_sha256: predicate.executable_sha256,
  };
  const receipt = verifyGameLifecyclePredicate(predicate, expected);
  await verifyGameLifecyclePhaseFiles(directory, prepared, receipt, expected);
  const token = process.env.GH_TOKEN;
  if (!token) throw new Error("Game lifecycle attestation requires an original-job reader");
  const provider = await createReleaseCustodyProvider({
    token,
    deadline: performance.now() + 30000,
  });
  const attempt = await provider.attempt(identity.run_id, identity.run_attempt);
  const job = await provider.job(Number(identity.job_id));
  const execution = verifyGameLifecycleJob(attempt, job, expected, "attesting");
  if (
    expected.selected_at < execution.started ||
    receipt.started_at < execution.started ||
    receipt.completed_at > execution.completed
  )
    throw new Error("Game lifecycle receipt falls outside the original native execution");
  return {
    authority: "none",
    predicate: path.join(directory, "predicate.json"),
    subject: path.join(directory, "successor-preparation.json"),
  };
}
