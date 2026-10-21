/** Fixed installed task/unit entrypoint. No request JSON, credential argument or
 * imported accepted result can appoint a candidate or a native invocation. */
import path from "node:path";
import { fileURLToPath } from "node:url";
import { establishActualNativeParent } from "./release-native-parent.mts";
import { acquireActualNativeStageCandidate } from "./release-native-candidate.mts";
import { claimActualNativeInvocation } from "./release-native-attempt.mts";
import { captureActualWindowsNativeInvocation } from "./release-native-windows-capture.mts";
import {
  prepareActualNativeStageReport,
  retainActualFailedNativeStage,
} from "./release-native-pre-sign-report.mts";
import { publishActualNativeStageReport } from "./release-native-check-broker.mts";

export async function runInstalledNativeWorker(configuration: string, configurationSha256: string) {
  const parent = await establishActualNativeParent(configuration, configurationSha256);
  if (process.platform !== "win32")
    throw new Error(
      "separate-account Linux backend is not connected; no native invocation claimed",
    );
  const candidate = await acquireActualNativeStageCandidate(parent);
  const claim = await claimActualNativeInvocation(candidate);
  if (claim.decision === "readback-only")
    return {
      decision: "hold",
      reason: "retained native invocation reconciled; no repeated launch",
      claim,
      authority: "none",
    };
  const capture = await captureActualWindowsNativeInvocation(claim);
  let report;
  try {
    report = await prepareActualNativeStageReport(capture);
  } catch (error) {
    const failure = error instanceof Error ? error.message : "native stage report refused";
    // If serialization itself cannot establish original identity/settlement,
    // preserve that refusal and every raw file; never supply older evidence.
    const retained = await retainActualFailedNativeStage(capture, failure);
    return { decision: "hold", reason: failure, capture, retained, authority: "none" };
  }
  const handoff = await publishActualNativeStageReport(report);
  return {
    decision: "hold",
    reason:
      "native stage Check handoff retained; independent hosted acceptance and pending ordinary public proof remain required",
    capture,
    report,
    handoff,
    authority: "none",
  };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [configuration, sha, ...rest] = process.argv.slice(2);
  if (!configuration || !sha || rest.length || !/^[a-f0-9]{64}$/u.test(sha))
    throw new Error("fixed native worker requires installed descriptor path and SHA only");
  const result = await runInstalledNativeWorker(configuration, sha);
  console.log(JSON.stringify(result, null, 2));
  process.exitCode = 1;
}
