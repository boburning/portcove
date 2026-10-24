import { appendFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { errorMessage } from "./runtime-values.mts";
import { inspectControllerExecutionPurpose } from "./release-control-phases.mts";
import { requireControllerInputRoleConfiguration } from "./release-authority-configuration-contract.mts";
import {
  admitProductionController,
  admitProductionCatalogController,
  readProductionControllerWorkflowBytes,
} from "./production-controller-admission.mts";
function refuse(reason: string): never {
  throw new Error(`production controller admission refused: ${reason}`);
}
async function main() {
  if (process.argv.length !== 2) refuse("no candidate or policy path arguments are accepted");
  const environment = { ...process.env };
  const purpose = inspectControllerExecutionPurpose(environment.PORTCOVE_EXECUTION_PURPOSE);
  const admitted = (
    purpose === "catalog-publication" ? admitProductionCatalogController : admitProductionController
  )(
    purpose === "catalog-publication"
      ? environment.PORTCOVE_CATALOG_CONTROLLER_ADMISSION
      : environment.PORTCOVE_CONTROLLER_ADMISSION,
    environment,
    await readProductionControllerWorkflowBytes(),
  );
  let outputs = `publication_purpose=${purpose}\n`;
  if (admitted.mode !== "admission-only") {
    const raw =
      purpose === "application"
        ? environment.PORTCOVE_RELEASE_AUTHORITIES
        : environment.PORTCOVE_CATALOG_AUTHORITIES;
    if (!raw || Buffer.byteLength(raw) > 32768)
      refuse("complete protected input role configuration unavailable");
    const roles = requireControllerInputRoleConfiguration(JSON.parse(raw), admitted, purpose);
    outputs += `classification_transport=${roles.classification_transport}\nprotection_app_id=${roles.protection_app_id}\nprotection_installation_id=${roles.protection_installation_id}\n`;
  }
  if (environment.GITHUB_OUTPUT) await appendFile(environment.GITHUB_OUTPUT, outputs);
  console.log(JSON.stringify(admitted));
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(errorMessage(error));
    process.exitCode = 1;
  });
}
