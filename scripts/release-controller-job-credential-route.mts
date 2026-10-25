/** Emit routing only after full source admission using existing reader/OIDC
 * credentials. This step never releases a legacy App private key or signing
 * key and does not attenuate the job token's provider permissions. */
import { appendFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { requireControllerJobCredentialRoute } from "./release-authority-configuration.mts";
import { errorMessage } from "./runtime-values.mts";
import { waitForOriginalPayloadNativeProof } from "./release-native-presign-readiness.mts";

export async function writeControllerJobCredentialRoute(phase: unknown) {
  const output = process.env.GITHUB_OUTPUT;
  if (!output || !path.isAbsolute(output))
    throw new Error("actual runner credential-routing output required");
  const captured = await requireControllerJobCredentialRoute(phase);
  await waitForOriginalPayloadNativeProof(captured);
  captured.recheck();
  await appendFile(output, `credential_transport=${captured.route.credential_transport}\n`);
  captured.recheck();
  return captured.route;
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv.length !== 3) {
    console.error("usage: release-controller-job-credential-route.mts FIXED_PHASE");
    process.exitCode = 1;
  } else
    writeControllerJobCredentialRoute(process.argv[2]).then(
      (route) => console.log(JSON.stringify(route)),
      (error) => {
        console.error(errorMessage(error));
        process.exitCode = 1;
      },
    );
}
