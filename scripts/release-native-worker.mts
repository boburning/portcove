/** Fixed installed task/unit entrypoint. No request JSON, credential argument or
 * imported accepted result can appoint a candidate or a native invocation. */
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  establishActualNativeParent,
  requireActualNativeParent,
} from "./release-native-parent.mts";
import {
  acquireActualNativeStageCandidate,
  readActualNativeWorkerDispatch,
} from "./release-native-candidate.mts";
import {
  claimActualNativeInvocation,
  readActualPublicJourneyProgress,
  claimActualPublicJourneyInvocation,
  recordActualWindowsPublicSettlement,
  recordActualLinuxPublicSettlement,
  readActualPublicJourneyParentPhase,
} from "./release-native-attempt.mts";
import {
  captureActualWindowsNativeInvocation,
  captureActualWindowsPublicJourney,
  requireActualWindowsPublicCapture,
} from "./release-native-windows-capture.mts";
import {
  acquireActualPublicJourneyPair,
  acquireActualPublicJourneyContinuationPair,
  materializeActualPublicJourneyPackage,
} from "./release-native-public-pair.mts";
import {
  captureActualLinuxPublicJourney,
  requireActualLinuxPublicCapture,
} from "./release-native-linux-public-capture.mts";
import { collectActualPublicWindowsCompilerIdentity } from "./release-native-public-compiler.mts";
import {
  prepareActualNativeStageReport,
  retainActualFailedNativeStage,
} from "./release-native-pre-sign-report.mts";
import { publishActualNativeStageReport } from "./release-native-check-broker.mts";
import { captureActualWslNativeInvocation } from "./release-native-wsl-capture.mts";
import {
  prepareActualLinuxNativeStageReport,
  retainActualFailedLinuxNativeStage,
} from "./release-native-linux-report.mts";

export async function runInstalledNativeWorker(configuration: string, configurationSha256: string) {
  const parent = await establishActualNativeParent(configuration, configurationSha256);
  if (process.platform !== "win32")
    throw new Error(
      "separate-account Linux backend is not connected; no native invocation claimed",
    );
  const linux =
    (await requireActualNativeParent(parent)).descriptor.platform_label === "linux-x86_64";
  if ((await readActualNativeWorkerDispatch(parent)) === "public") {
    const phase = await readActualPublicJourneyParentPhase(parent);
    if (phase.phase === "completed")
      return {
        decision: "hold",
        reason: "original public cohort already settled; no repeated launch or new acceptance",
        phase,
        authority: "none",
      };
    let pair: object;
    if (phase.phase === "await-published-v2") {
      if (!phase.historical_cohort_receipt)
        throw new Error("actual retained public cohort routing receipt missing");
      pair = await acquireActualPublicJourneyContinuationPair(
        parent,
        phase.historical_cohort_receipt,
      );
    } else pair = await acquireActualPublicJourneyPair(parent);
    const progress = await readActualPublicJourneyProgress(pair);
    if (
      progress.phase !== "initial-v0-v1" &&
      progress.phase !== "park-v0-with-v1" &&
      !(linux && progress.phase === "continue-with-v2")
    )
      return {
        decision: "hold",
        reason:
          "selected public phase has no connected Windows continuation; no invocation claimed",
        progress,
        authority: "none",
      };
    const prior_package = await materializeActualPublicJourneyPackage(pair, "prior");
    const candidate_package = await materializeActualPublicJourneyPackage(pair, "candidate");
    const parked_package =
      progress.phase === "continue-with-v2"
        ? await materializeActualPublicJourneyPackage(pair, "parked")
        : undefined;
    const compiler = linux
      ? undefined
      : {
          prior: await collectActualPublicWindowsCompilerIdentity(pair, "prior"),
          candidate: await collectActualPublicWindowsCompilerIdentity(pair, "candidate"),
        };
    const claim = await claimActualPublicJourneyInvocation(progress, {
      pair,
      prior_package,
      candidate_package,
      ...(parked_package ? { parked_package } : {}),
      ...(compiler ? { compiler } : {}),
    });
    const capture = linux
      ? await captureActualLinuxPublicJourney(claim)
      : await captureActualWindowsPublicJourney(claim);
    if (linux) await requireActualLinuxPublicCapture(capture);
    else await requireActualWindowsPublicCapture(capture);
    const settlement = linux
      ? await recordActualLinuxPublicSettlement(capture)
      : await recordActualWindowsPublicSettlement(capture);
    return {
      decision: "hold",
      reason:
        "public capture and technical settlement retained; independent full public acceptance remains pending",
      capture,
      settlement,
      authority: "none",
    };
  }
  const candidate = await acquireActualNativeStageCandidate(parent);
  const claim = await claimActualNativeInvocation(candidate);
  if (claim.decision === "readback-only")
    return {
      decision: "hold",
      reason: "retained native invocation reconciled; no repeated launch",
      claim,
      authority: "none",
    };
  const capture = linux
    ? await captureActualWslNativeInvocation(claim)
    : await captureActualWindowsNativeInvocation(claim);
  let report;
  try {
    report = linux
      ? await prepareActualLinuxNativeStageReport(capture)
      : await prepareActualNativeStageReport(capture);
  } catch (error) {
    const failure = error instanceof Error ? error.message : "native stage report refused";
    // If serialization itself cannot establish original identity/settlement,
    // preserve that refusal and every raw file; never supply older evidence.
    const retained = linux
      ? await retainActualFailedLinuxNativeStage(capture, failure)
      : await retainActualFailedNativeStage(capture, failure);
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
