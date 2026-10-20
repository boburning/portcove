import { mkdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  admitProductionProtectionObserver,
  readProductionControllerWorkflowBytes,
} from "./production-controller-admission.mts";
import { waitForControlArtifact } from "./release-control-handshake.mts";

async function main() {
  if (
    process.argv.length !== 2 ||
    !process.env.RUNNER_TEMP ||
    !path.isAbsolute(process.env.RUNNER_TEMP)
  )
    throw new Error("fixed isolated readiness operation requires private runner root");
  const admitted = admitProductionProtectionObserver(
    process.env.PORTCOVE_CONTROLLER_ADMISSION,
    process.env,
    await readProductionControllerWorkflowBytes(),
  );
  const root = path.join(process.env.RUNNER_TEMP, "release-control-ready");
  await mkdir(root, { mode: 0o700 }); // existing state refuses; never repeat on retained state
  await waitForControlArtifact(root, "ready", {
    controller_revision: admitted.revision,
    controller_ref: admitted.execution_ref,
    run_id: String(admitted.run_id),
    run_attempt: admitted.run_attempt,
  });
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  main().catch(() => {
    console.error("fixed reader readiness refused; retain exact attempt; no App token requested");
    process.exitCode = 2;
  });
