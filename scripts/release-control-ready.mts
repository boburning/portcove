import { mkdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  admitProductionProtectionObserver,
  readProductionControllerWorkflowBytes,
} from "./production-controller-admission.mts";
import { waitForControlArtifact, inspectControlRound } from "./release-control-handshake.mts";
import { inspectReleaseControlPhase } from "./release-control-phases.mts";

async function main() {
  if (
    process.argv.length < 2 ||
    process.argv.length > 4 ||
    !process.env.RUNNER_TEMP ||
    !path.isAbsolute(process.env.RUNNER_TEMP)
  )
    throw new Error("fixed isolated readiness operation requires private runner root");
  const phase = inspectReleaseControlPhase(process.argv[2]);
  const round =
    process.argv[3] === undefined
      ? undefined
      : inspectControlRound({ index: Number(process.argv[3]) }, false);
  const admitted = admitProductionProtectionObserver(
    process.env.PORTCOVE_CONTROLLER_ADMISSION,
    process.env,
    await readProductionControllerWorkflowBytes(),
    phase,
  );
  const root = path.join(
    process.env.RUNNER_TEMP,
    `release-control-ready-${phase}${round ? `-r${round.index}` : ""}`,
  );
  await mkdir(root, { mode: 0o700 }); // existing state refuses; never repeat on retained state
  await waitForControlArtifact(root, "ready", {
    phase,
    controller_revision: admitted.revision,
    controller_ref: admitted.execution_ref,
    run_id: String(admitted.run_id),
    run_attempt: admitted.run_attempt,
    ...(round ? { round } : {}),
  });
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  main().catch(() => {
    console.error("fixed reader readiness refused; retain exact attempt; no App token requested");
    process.exitCode = 2;
  });
