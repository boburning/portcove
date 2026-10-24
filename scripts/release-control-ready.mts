import { mkdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  admitProductionProtectionObserver,
  admitProductionCatalogProtectionObserver,
  readProductionControllerWorkflowBytes,
} from "./production-controller-admission.mts";
import { waitForControlArtifact, inspectControlRound } from "./release-control-handshake.mts";
import {
  inspectControllerExecutionPurpose,
  inspectReleaseControlPhase,
} from "./release-control-phases.mts";
import { requireProtectionObserverSourceConfiguration } from "./release-authority-configuration-contract.mts";

async function main() {
  const environment = { ...process.env };
  if (
    process.argv.length < 2 ||
    process.argv.length > 4 ||
    !environment.RUNNER_TEMP ||
    !path.isAbsolute(environment.RUNNER_TEMP)
  )
    throw new Error("fixed isolated readiness operation requires private runner root");
  const phase = inspectReleaseControlPhase(process.argv[2]);
  const round =
    process.argv[3] === undefined
      ? undefined
      : inspectControlRound({ index: Number(process.argv[3]) }, false);
  const purpose = inspectControllerExecutionPurpose(environment.PORTCOVE_EXECUTION_PURPOSE);
  const admitted = (
    purpose === "catalog-publication"
      ? admitProductionCatalogProtectionObserver
      : admitProductionProtectionObserver
  )(
    purpose === "catalog-publication"
      ? environment.PORTCOVE_CATALOG_CONTROLLER_ADMISSION
      : environment.PORTCOVE_CONTROLLER_ADMISSION,
    environment,
    await readProductionControllerWorkflowBytes(),
    phase,
  );
  const raw =
    purpose === "application"
      ? environment.PORTCOVE_RELEASE_AUTHORITIES
      : environment.PORTCOVE_CATALOG_AUTHORITIES;
  if (!raw || Buffer.byteLength(raw) > 32768)
    throw new Error("complete observer source configuration unavailable");
  const roles = requireProtectionObserverSourceConfiguration(
    JSON.parse(raw),
    admitted,
    phase,
    purpose,
  );
  if (
    environment.PORTCOVE_EXPECTED_PROTECTION_APP_ID !== String(roles.protection_app_id) ||
    environment.PORTCOVE_EXPECTED_INSTALLATION_ID !== String(roles.protection_installation_id)
  )
    throw new Error("appointed observer mint target differs from the source-bound configuration");
  const root = path.join(
    environment.RUNNER_TEMP,
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
