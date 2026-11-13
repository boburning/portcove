/** Existing GitHub/Sigstore verifier + fixed historical job custody. This does
 * not appoint a trust anchor, accept a history seed, prove current protections
 * or authorize an effect. The caller supplies independently ratified inputs. */
import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { lstat, mkdtemp, realpath, writeFile } from "node:fs/promises";
import path from "node:path";
import { performance } from "node:perf_hooks";
import {
  coordinatorCheckpointEvidenceSubject,
  coordinatorCheckpointPredicateType,
  nativeCoordinatorCheckpointPredicateType,
  coordinatorCheckpointSubjectLimit,
  inspectCoordinatorCheckpointEvidence,
} from "./release-coordinator-checkpoint-evidence.mts";
import type { CoordinatorCheckpointEvidence } from "./release-coordinator-checkpoint-evidence.mts";
import type { exportCoordinatorCheckpoint } from "./release-coordinator-state.mts";
import type { CapacityExecutorRole } from "./assembler-job-identity.mts";
import {
  parseControllerWitnessedTime,
  verifyControllerArtifactVerification,
} from "./github-controller-attestation.mts";
import { verifyHistoricalCheckpointJob } from "./release-checkpoint-job-identity.mts";
import { readControllerToolFile } from "./release-controller-tools.mts";
import { readOnlyReleaseChildEnvironment } from "./release-readonly-child-environment.mts";
import { inspectCoordinatorRemoteNamespace } from "./release-coordinator-namespace.mts";
import { isRecord } from "./runtime-values.mts";
import { readCoordinatorCheckpointEvidence } from "./release-coordinator-checkpoint-evidence.mts";
import type { CoordinatorCheckpointApi } from "./release-coordinator-remote.mts";
import {
  capacityExecutorJobProfile,
  capacityExecutorRolesForPurpose,
} from "./assembler-job-identity.mts";
import { inspectFixedJobJournalAuthorities } from "./release-authority-configuration.mts";
import { releaseCanonicalDigest } from "./release-canonical.mts";
import { assessBoundedCapacity, retainedRenewalCapacityRebind } from "./release-capacity.mts";
import { inspectReleaseReviewWithdrawal } from "./release-review-withdrawal.mts";

// The original immutable r45 child survives its interrupted publication. A
// fixed catalog recovery and its exact application handoff own it.
export const retainedCatalogBootstrapClaim = {
  previous: "bf507a891f66cc28cca8ebcab81828f3c029dce0",
  child: "565eb5b3ccf58d6f0654e99b8d3e0214987cd003",
  tree: "73cb00ea80fc6823e982c3047ff0a538bba2ab1e",
  clock: "2026-11-08T08:17:49.067Z",
  original_source: "befb9b41ced06c478a201e24fcea6a0aa950b859",
  original_ref: "portcove-production-controller-catalog-20261108r45",
  original_run: "42461860356",
  original_job: 128673642719,
  successor_ref: "refs/tags/portcove-production-controller-catalog-20261108r51",
  successor_revision: "525a89cb56a5001cc544fb1a25d1c36101d7d815",
  successor_workflow_sha256: "e8233a09bbd838f2ea551dabbe85592bfcd9776db1bd301fb6be2d502d4bcba0",
  application_ref: "refs/tags/portcove-production-controller-windows-20261108r52",
} as const;

/** r65 claimed these exact forward-adoption bytes before checkpoint signing stopped. */
export const retainedCatalogForwardAdoptionClaim = {
  previous: "da80188916dfc40f5d46c1eb4123bc00b9d68a8b",
  child: "69b7ebea4a3e6bf624cdb80de5ed83d921a5289e",
  tree: "569a58df71802fa5df13b5cbbe1a4836cb3a1961",
  state_sha256: "0205080c70da3c411c95627c36683f13c16bc648ffbc7bc19209437b3f3a97da",
  clock: "2026-11-10T06:30:35.317Z",
  original_source: "f8d2429864d2d7da14ed5f47aed143641ae2d86d",
  original_ref: "portcove-production-controller-20261110r65",
  original_run: "42767924166",
  original_job: 129671436946,
  successor_ref: "refs/tags/portcove-production-controller-20261110r66",
} as const;

/** The native metadata adoption already claimed this child. Only its
 * separately appointed successor may finish this one signed transition. */
export const retainedCatalogNativeAdoptionClaim = {
  previous: "006439a83c66cc3c1fa3fa142d7e4a6ed27f8553",
  child: "d23b4f108b03ecd81c1696a407c740ca24e5d705",
  tree: "925f93173c6ab2b5572068e99e96722c8986a0cf",
  state_sha256: "85bba0bb4540ddee8c287dfeee2a62261c09542aa00c823f01cb50f9113e31f8",
  clock: "2026-11-11T17:44:17.587Z",
  original_source: "a2814fe75262c10bfe7f9511d98df79e8ae0c001",
  original_ref: "portcove-production-controller-catalog-adoption-20261111",
  original_run: "43069742240",
  original_job: 130697078365,
  successor_ref: "refs/tags/portcove-production-controller-catalog-adoption-settle-20261111",
} as const;

/** The failed v13 adoption reserved this exact unsigned child before signing. */
export const retainedCatalogV13AdoptionClaim = {
  previous: "d23b4f108b03ecd81c1696a407c740ca24e5d705",
  child: "7b7388fe8eeb04fe11f4afd336f4ddb0359ef1b4",
  tree: "25833904b3e147808bb25fb9b7568d9ed94290e6",
  state_sha256: "ad063814109d9b7da32334afe02530a403e11afcf0bc49f33fd04ef0e1d4628b",
  clock: "2026-11-13T06:56:26.026Z",
  original_source: "eb1e59a29c70ab1548eb2ffb6c126d9252fb9dd1",
  original_ref: "portcove-production-controller-catalog-adoption-v13-proof",
  original_run: "43381386061",
  original_job: 131741624813,
  successor_ref: "refs/tags/portcove-production-controller-catalog-adoption-v13-settle",
} as const;

/** The r52 application claim already exists, so r53 may only settle these bytes. */
export const retainedApplicationReviewClaim = {
  previous: "565eb5b3ccf58d6f0654e99b8d3e0214987cd003",
  child: "6d35ca0be7c768bfafefd39a1579510a46c6758e",
  tree: "ac64c5f11fb4cbd2991a6db752f8df6af2e09cc9",
  state_sha256: "b8f514eff99d94e6e03a46e387985d65b3b18007e244196abe3c52eb71ace6cc",
  request_id: "b59b5c190f4933ff6f26ef05b0f5fd137b9da2e0e5114d2499a678f2a918b7be",
  clock: "2026-11-08T19:30:08.487Z",
  source: "fd4b1a1c5bf3a4253ee06a357df04bb1f203cb2f",
  source_tree: "4abba6dd2da333c86254415f48290ff1cba7bbad",
  baseline: "27328c8a1b30bf92868bcf3cde313f2720c8fd1e",
  delta: "881c28c309a2c5cade49adfee87202fffc4e858b31d529733d088622d32c8b46",
  qualification_run: 42407004590,
  original_source: "e2354d745264054a961773aaff0fe20d203e842c",
  original_ref: "refs/tags/portcove-production-controller-windows-20261108r52",
  original_run: "42514436313",
  original_job: 128836705670,
  successor_ref: "refs/tags/portcove-production-controller-windows-20261108r53",
  successor_revision: "8d2573bf510d8c79db9bcc13d05cd927299d6625",
  successor_workflow_sha256: "1a3c919b259130af66b9e813bc3737c9670bdbcf1a2499b730d43debd5a8d57e",
  successor_run: "42521028980",
  successor_job: "128856935921",
} as const;

export function isRetainedApplicationReviewClaimScope(
  previous: string,
  child: string,
  executionRef: string,
  runAttempt: number,
) {
  const expected = retainedApplicationReviewClaim;
  return (
    previous === expected.previous &&
    child === expected.child &&
    executionRef === expected.successor_ref &&
    runAttempt === 1
  );
}

export function matchesRetainedCatalogBootstrapHandoff(
  checkpoint: { checkpoint: string; previous: string | null },
  producer: Record<string, unknown>,
  source: { revision: string; execution_ref: string },
) {
  return (
    checkpoint.checkpoint === retainedCatalogBootstrapClaim.child &&
    checkpoint.previous === retainedCatalogBootstrapClaim.previous &&
    producer.controller_revision === retainedCatalogBootstrapClaim.successor_revision &&
    producer.controller_ref === retainedCatalogBootstrapClaim.successor_ref &&
    producer.workflow_sha256 === retainedCatalogBootstrapClaim.successor_workflow_sha256 &&
    (source.execution_ref === retainedCatalogBootstrapClaim.application_ref ||
      source.execution_ref === retainedApplicationReviewClaim.successor_ref)
  );
}

/** The authenticated withdrawal appointment selects one historical input.
 * The normal provider job and Sigstore checks still authenticate its producer. */
export function matchesRetainedReviewWithdrawalHandoff(
  checkpoint: { checkpoint: string; previous: string | null },
  producer: Record<string, unknown>,
  rawWithdrawal: unknown,
) {
  const withdrawal = inspectReleaseReviewWithdrawal(rawWithdrawal);
  const retained = retainedApplicationReviewClaim;
  return (
    withdrawal !== null &&
    withdrawal.request_checkpoint === retained.child &&
    withdrawal.request_id === retained.request_id &&
    withdrawal.source_commit === retained.source &&
    withdrawal.source_tree === retained.source_tree &&
    checkpoint.checkpoint === retained.child &&
    checkpoint.previous === retained.previous &&
    producer.controller_revision === retained.successor_revision &&
    producer.controller_ref === retained.successor_ref &&
    producer.workflow_sha256 === retained.successor_workflow_sha256 &&
    producer.run_id === retained.successor_run &&
    producer.job_id === retained.successor_job
  );
}

/** The separately appointed withdrawal may authenticate the exact signed v13
 * adoption. The provider job, signature and current mutation controls still apply. */
export function matchesRetainedV13ReviewWithdrawalHandoff(
  checkpoint: { checkpoint: string; previous: string | null },
  producer: Record<string, unknown>,
  source: { execution_ref: string; workflow_sha256: string },
  rawWithdrawal: unknown,
  purpose: "application" | "catalog-publication" | undefined,
) {
  const withdrawal = inspectReleaseReviewWithdrawal(rawWithdrawal);
  const adoption = retainedCatalogV13AdoptionClaim;
  const workflow = "ae780affa5cff58dd88250b3575d6948ed6608a47b3175492cf56fff3a5d90fb";
  return (
    purpose === "application" &&
    [
      "refs/tags/portcove-production-controller-windows-20261113-withdraw-29f33f57",
      "refs/tags/portcove-production-controller-windows-20261113-withdraw-29f33f57-r2",
      "refs/tags/portcove-production-controller-windows-20261113-withdraw-29f33f57-r3",
    ].includes(source.execution_ref) &&
    source.workflow_sha256 === workflow &&
    withdrawal !== null &&
    withdrawal.request_checkpoint === adoption.child &&
    withdrawal.request_id === "87a32458456f8b24bfe545a89a98c93a2315af9e9e15f37e0c1e4b821f480176" &&
    withdrawal.source_commit === "29f33f577dd08888daa308f6534e1ba2e0d10eaf" &&
    withdrawal.source_tree === "e5f44b9f1c2b541fb2c932d6d203198c33ca2d57" &&
    withdrawal.technical_stop_sha256 ===
      "73704d29b23be7aeffcddf2776ce1598dbf3a1d2c76efac0e11fbc10d36d4be0" &&
    checkpoint.checkpoint === adoption.child &&
    checkpoint.previous === adoption.previous &&
    producer.controller_revision === "dc5aee2e8cb67c92e36f1507a09b2a2b6a391372" &&
    producer.controller_ref === adoption.successor_ref &&
    producer.workflow_sha256 === workflow &&
    producer.run_id === "43388566615" &&
    producer.run_attempt === 1 &&
    producer.job_id === "131764663738" &&
    producer.check_run_id === "131764663738"
  );
}

/** Only catalog-purpose admission can carry the settled fd4 withdrawal into
 * forward adoption. It still has to verify the original coordinator signature. */
export function matchesRetainedCatalogAdoptionWithdrawal(
  checkpoint: { checkpoint: string; previous: string | null },
  producer: Record<string, unknown>,
  purpose: "application" | "catalog-publication" | undefined,
) {
  return (
    purpose === "catalog-publication" &&
    checkpoint.checkpoint === "da80188916dfc40f5d46c1eb4123bc00b9d68a8b" &&
    checkpoint.previous === retainedApplicationReviewClaim.child &&
    producer.controller_revision === "5a572c20064f5c7bfc9fadb86996b9f1bef7c812" &&
    producer.controller_ref === "refs/tags/portcove-production-controller-20261110r63" &&
    producer.workflow_sha256 ===
      "9a126152d549d913b57689404ca51bf755d88e2b0aa3d76631c4bb7e487ea136" &&
    producer.run_id === "42755307254" &&
    producer.job_id === "129631097635"
  );
}

export const retainedChameleonReviewClaim = {
  previous: "9d687629c60fc85c9a150a38eaf1dd8081934a87",
  child: "21a0966d794b1e35c25a5f302db7593052e7cc9c",
  tree: "6e54642ea8c272a78d2c746f9197cd4e18f9df0a",
  state_sha256: "4f16e23205f32c0d04340d61b8a13502b6b5d98a6261e920a05023b55960385d",
  request_id: "be18be3b8a760b4805281924444926d85f5c5c3f3489ed437b125884b0ced140",
  source: "2e0699dc8b6bc4cc6d28b6648d2ad79d0517d2f8",
  source_tree: "b4cb930ee6fcbd1c6693a17b895dc8076513f3f2",
  clock: "2026-11-13T15:09:18.154Z",
  original_revision: "3551454a53fee6bf898f8d0f00fd798384f1b0ea",
  original_ref: "refs/tags/portcove-production-controller-catalog-chameleon-canary",
  original_run: "43448527355",
  original_job: 131966991529,
  recovery_ref: "refs/tags/portcove-production-controller-catalog-chameleon-review-settle",
} as const;

export function selectRetainedChameleonReviewClaim(
  executionRef: string,
  runAttempt: number,
  checkpoint: string,
) {
  const claim = retainedChameleonReviewClaim;
  if (executionRef !== claim.recovery_ref) return undefined;
  if (runAttempt !== 1 || checkpoint !== claim.previous)
    throw new Error(
      "Chameleon review recovery requires the original predecessor and first attempt",
    );
  return claim;
}

/** The Chameleon coordinator may authenticate the exact stopped application
 * request's signed withdrawal as its idle predecessor. */
export function matchesRetainedChameleonWithdrawalHandoff(
  checkpoint: { checkpoint: string; previous: string | null },
  producer: Record<string, unknown>,
  source: { execution_ref: string; workflow_sha256: string },
  purpose: "application" | "catalog-publication" | undefined,
) {
  const workflow = "ae780affa5cff58dd88250b3575d6948ed6608a47b3175492cf56fff3a5d90fb";
  return (
    purpose === "catalog-publication" &&
    [retainedChameleonReviewClaim.original_ref, retainedChameleonReviewClaim.recovery_ref].some(
      (ref) => ref === source.execution_ref,
    ) &&
    source.workflow_sha256 === workflow &&
    checkpoint.checkpoint === retainedChameleonReviewClaim.previous &&
    checkpoint.previous === retainedCatalogV13AdoptionClaim.child &&
    producer.controller_revision === "4cd5a0d9f9e3f3184bb680a298489a9db5dc18ba" &&
    producer.controller_ref ===
      "refs/tags/portcove-production-controller-windows-20261113-withdraw-29f33f57-r3" &&
    producer.workflow_sha256 === workflow &&
    producer.run_id === "43441976472" &&
    producer.run_attempt === 1 &&
    producer.job_id === "131944380144" &&
    producer.check_run_id === "131944380144"
  );
}

/** Carry the exact r66 adoption into the next separately admitted app or catalog operation. */
export function matchesRetainedCatalogForwardAdoptionHandoff(
  checkpoint: { checkpoint: string; previous: string | null },
  producer: Record<string, unknown>,
  source: { execution_ref: string },
  purpose: "application" | "catalog-publication" | undefined,
) {
  const claim = retainedCatalogForwardAdoptionClaim;
  return (
    (purpose === "application" || purpose === "catalog-publication") &&
    (source.execution_ref === "refs/tags/portcove-production-controller-20261110r67" ||
      source.execution_ref === "refs/tags/portcove-production-controller-20261110r68") &&
    checkpoint.checkpoint === claim.child &&
    checkpoint.previous === claim.previous &&
    producer.controller_revision === "d6918c546f8080bf3cb033ddb065ce9a65a4d7f2" &&
    producer.controller_ref === claim.successor_ref &&
    producer.workflow_sha256 ===
      "9a126152d549d913b57689404ca51bf755d88e2b0aa3d76631c4bb7e487ea136" &&
    producer.run_id === "42774078033" &&
    producer.run_attempt === 1 &&
    producer.job_id === "129690072424" &&
    producer.check_run_id === "129690072424"
  );
}

export const retainedApplicationRenewalClaim = Object.freeze({
  previous: "86407ae8bca924200aba304340f33076e635b6e7",
  child: retainedRenewalCapacityRebind.checkpoint,
  tree: "6824a452be1e2123d9f1a1de2a692bb209e044e8",
  state_sha256: "262870e5dc1d19c79bb88a7e746b51914f06b48c8fa29eaefba2ca7522831c68",
  original_source: "0315e250604a993a381dd0b088c1239ff96bbcc1",
  original_ref: "refs/tags/portcove-production-controller-20261110r69",
  original_run: "42816631314",
  original_job: 129835641718,
  successor_ref: "refs/tags/portcove-production-controller-20261110r70",
  settled_successor_ref: "refs/tags/portcove-production-controller-20261110r71",
  latency_successor_ref: "refs/tags/portcove-production-controller-20261110r72",
  native_split_successor_ref: "refs/tags/portcove-production-controller-20261110r73",
  capacity_rebind_successor_ref: retainedRenewalCapacityRebind.execution_ref,
  native_split_workflow_sha256: "ae780affa5cff58dd88250b3575d6948ed6608a47b3175492cf56fff3a5d90fb",
});

export function isRetainedApplicationRenewalClaimScope(
  previous: string,
  child: string,
  executionRef: string,
  runAttempt: number,
) {
  const pin = retainedApplicationRenewalClaim;
  return (
    previous === pin.previous &&
    child === pin.child &&
    executionRef === pin.successor_ref &&
    runAttempt === 1
  );
}

export function isSettledApplicationRenewalRecoveryRef(executionRef: string) {
  const pin = retainedApplicationRenewalClaim;
  return (
    executionRef === pin.settled_successor_ref ||
    executionRef === pin.latency_successor_ref ||
    executionRef === pin.native_split_successor_ref ||
    executionRef === pin.capacity_rebind_successor_ref
  );
}

// The original fixed transport retained a slot before exposing any upload
// route. Its reviewed terminal diagnostics account for all 40 slots and
// contain only three control events. This is evidence of non-attempt for this
// one operation, rather than an inference from a missing context artifact.
export const retainedApplicationContextUpload = Object.freeze({
  checkpoint: "b839c0ce8991d5abd0fe19bc91d173970b3acae6",
  previous: "ef9b0664069a9c2dff4a9cf18ce86b3d964a4ac8",
  successor_ref: "refs/tags/portcove-production-controller-20261110r77",
  workflow_sha256: "ae780affa5cff58dd88250b3575d6948ed6608a47b3175492cf56fff3a5d90fb",
  operation_id: "f7468b3daade44b98d7dde0af13f6cc81bbdc03d8b9c838ff8336e0a3a73e542",
  revision: "79b3d82f1e10af254edb5271953bd9d84b50ef57",
  ref: "refs/tags/portcove-production-controller-20261110r76",
  run_id: "42948613381",
  job_id: 130289454617,
  diagnostics_id: 13825020555,
  diagnostics_bytes: 11033,
  diagnostics_sha256: "9cf48b2f3a32d217b1ea15b4a26d0c0e0b667ff8aab267c37cd0871601460c76",
});

// The earlier run's terminal Actions result remains failed. Its exact signed
// zero-effect settlement is the current predecessor for qualified review.
export const retainedApplicationContextSettlement = Object.freeze({
  checkpoint: "e6160a6b2c8b7784ef83e1f0c36bec0804acf2e3",
  previous: retainedApplicationContextUpload.checkpoint,
  successor_ref: "refs/tags/portcove-production-controller-20261111r80",
  workflow_sha256: retainedApplicationContextUpload.workflow_sha256,
  revision: "fd45c587cd21fbd3ab125aaa9e1096577bbb5351",
  ref: retainedApplicationContextUpload.successor_ref,
  run_id: "42959512182",
  job_id: 130324385057,
});

/** Resume the settled signed renewal descriptor before any context upload or feed write. */
export function matchesRetainedApplicationRenewalHandoff(
  checkpoint: { checkpoint: string; previous: string | null },
  producer: Record<string, unknown>,
  source: { execution_ref: string; workflow_sha256?: string },
  purpose: "application" | "catalog-publication" | undefined,
) {
  const pin = retainedApplicationRenewalClaim;
  if (purpose !== "application") return false;
  const context =
    source.execution_ref === retainedApplicationContextSettlement.successor_ref
      ? retainedApplicationContextSettlement
      : retainedApplicationContextUpload;
  if (source.execution_ref === context.successor_ref) {
    return (
      source.workflow_sha256 === context.workflow_sha256 &&
      checkpoint.checkpoint === context.checkpoint &&
      checkpoint.previous === context.previous &&
      producer.controller_revision === context.revision &&
      producer.controller_ref === context.ref &&
      producer.workflow_sha256 === context.workflow_sha256 &&
      producer.run_id === context.run_id &&
      producer.run_attempt === 1 &&
      producer.job_id === String(context.job_id) &&
      producer.check_run_id === String(context.job_id)
    );
  }
  if (
    isSettledApplicationRenewalRecoveryRef(source.execution_ref) &&
    ((source.execution_ref !== pin.native_split_successor_ref &&
      source.execution_ref !== pin.capacity_rebind_successor_ref) ||
      source.workflow_sha256 === pin.native_split_workflow_sha256)
  ) {
    return (
      checkpoint.checkpoint === pin.child &&
      checkpoint.previous === pin.previous &&
      producer.controller_revision === "b03b3ed7e9e661a57328489583cedcafef4c7004" &&
      producer.controller_ref === pin.successor_ref &&
      producer.workflow_sha256 ===
        "9a126152d549d913b57689404ca51bf755d88e2b0aa3d76631c4bb7e487ea136" &&
      producer.run_id === "42827180124" &&
      producer.run_attempt === 1 &&
      producer.job_id === "129885597891" &&
      producer.check_run_id === "129885597891"
    );
  }
  return (
    (source.execution_ref === pin.original_ref || source.execution_ref === pin.successor_ref) &&
    checkpoint.checkpoint === pin.previous &&
    checkpoint.previous === retainedCatalogForwardAdoptionClaim.child &&
    producer.controller_revision === "9c5e7f0e33282115235fffa19d073e5cb084ffa0" &&
    producer.controller_ref === "refs/tags/portcove-production-controller-20261110r68" &&
    producer.workflow_sha256 ===
      "9a126152d549d913b57689404ca51bf755d88e2b0aa3d76631c4bb7e487ea136" &&
    producer.run_id === "42786277008" &&
    producer.run_attempt === 1 &&
    producer.job_id === "129733085853" &&
    producer.check_run_id === "129733085853"
  );
}

/** The catalog coordinator can authenticate this exact signed application
 * predecessor for readback. Its own appointment still gates every operation. */
export function matchesRetainedNativeAdoptionPredecessor(
  checkpoint: { checkpoint: string; previous: string | null },
  producer: Record<string, unknown>,
  source: { workflow_sha256: string },
  purpose: "application" | "catalog-publication" | undefined,
) {
  const settled = retainedCatalogNativeAdoptionClaim;
  if (checkpoint.checkpoint === settled.child) {
    return (
      purpose === "catalog-publication" &&
      source.workflow_sha256 === retainedApplicationContextSettlement.workflow_sha256 &&
      checkpoint.previous === settled.previous &&
      producer.controller_revision === "d7f5e10b7644e9d2b8c8823c39c6175a9b3efdb3" &&
      producer.controller_ref === settled.successor_ref &&
      producer.workflow_sha256 === source.workflow_sha256 &&
      producer.run_id === "43127719974" &&
      producer.run_attempt === 1 &&
      producer.job_id === "130886155058" &&
      producer.check_run_id === "130886155058"
    );
  }
  return (
    purpose === "catalog-publication" &&
    source.workflow_sha256 === retainedApplicationContextSettlement.workflow_sha256 &&
    checkpoint.checkpoint === "006439a83c66cc3c1fa3fa142d7e4a6ed27f8553" &&
    checkpoint.previous === retainedApplicationContextSettlement.checkpoint &&
    producer.controller_revision === "ddf7e1ff74ced4ae988b089bf2ba9951d4de9964" &&
    producer.controller_ref === retainedApplicationContextSettlement.successor_ref &&
    producer.workflow_sha256 === retainedApplicationContextSettlement.workflow_sha256 &&
    producer.run_id === "43061111295" &&
    producer.run_attempt === 1 &&
    producer.job_id === "130666640318" &&
    producer.check_run_id === "130666640318"
  );
}

/** Authenticate one independently selected current head, not an ancestry walk.
 * Selected setup pins authorize only the exact empty seed. Every later head
 * must carry the existing signature plus actual fixed historical job binding.
 * This does not establish current ref ownership/protections or effect outcome. */
export async function authenticateFixedJobCoordinatorHistory(
  directory: string,
  rawCheckpoint: Awaited<ReturnType<typeof exportCoordinatorCheckpoint>>,
  rawAuthorities: unknown,
  rawSource: { revision: string; execution_ref: string; workflow_sha256: string; actor_id: string },
  deadline: number,
  api: CoordinatorCheckpointApi,
  withdrawal?: ReturnType<typeof inspectReleaseReviewWithdrawal>,
  purpose?: "application" | "catalog-publication",
) {
  const checkpoint = structuredClone(rawCheckpoint);
  const authorities = inspectFixedJobJournalAuthorities(rawAuthorities);
  const source = structuredClone(rawSource);
  const configuration = { schema_version: 1, namespace: authorities.namespace };
  const active = () => {
    if (
      !Number.isFinite(deadline) ||
      deadline <= performance.now() ||
      deadline - performance.now() > 120000
    )
      throw new Error("selected history requires the original bounded deadline");
  };
  active();
  if (checkpoint.checkpoint === authorities.journal_seed.checkpoint) {
    const state: unknown = JSON.parse(checkpoint.blob.contents);
    const input = isRecord(state) && isRecord(state.input) ? state.input : null;
    const controller = input && isRecord(input.controller) ? input.controller : null;
    const capacity =
      controller && isRecord(controller.capacity_attempt) ? controller.capacity_attempt : null;
    if (
      checkpoint.previous !== null ||
      !input ||
      input.schema_version !== 2 ||
      input.active_candidate != null ||
      !capacity ||
      capacity.schema_version !== 2 ||
      (capacity &&
        (capacity.operation != null ||
          (Array.isArray(capacity.prior_operations) && capacity.prior_operations.length !== 0))) ||
      checkpoint.receipts.length !== 0 ||
      hash(Buffer.from(checkpoint.blob.contents)) !== authorities.journal_seed.state_sha256
    )
      throw new Error(
        "selected seed bytes/history/effects differ from independently ratified empty seed",
      );
    // Validate the existing contract without turning a supplied ratification or
    // a successful history read into positive capacity/current admission.
    assessBoundedCapacity(capacity);
    return {
      kind: "ratified-initial-seed" as const,
      checkpoint: checkpoint.checkpoint,
      authority: "none" as const,
    };
  }
  if (checkpoint.previous === null) throw new Error("unratified initial journal head");
  const evidence = await readCoordinatorCheckpointEvidence(
    checkpoint,
    configuration,
    api,
    deadline,
  );
  const subject: unknown = JSON.parse(evidence.subject.toString("utf8"));
  const producer = isRecord(subject) && isRecord(subject.producer) ? subject.producer : null;
  const retainedHandoff =
    producer !== null &&
    (matchesRetainedCatalogBootstrapHandoff(checkpoint, producer, source) ||
      matchesRetainedReviewWithdrawalHandoff(checkpoint, producer, withdrawal) ||
      matchesRetainedV13ReviewWithdrawalHandoff(
        checkpoint,
        producer,
        source,
        withdrawal,
        purpose,
      ) ||
      matchesRetainedCatalogAdoptionWithdrawal(checkpoint, producer, purpose) ||
      matchesRetainedChameleonWithdrawalHandoff(checkpoint, producer, source, purpose) ||
      matchesRetainedCatalogForwardAdoptionHandoff(checkpoint, producer, source, purpose) ||
      matchesRetainedApplicationRenewalHandoff(checkpoint, producer, source, purpose) ||
      matchesRetainedNativeAdoptionPredecessor(checkpoint, producer, source, purpose));
  if (
    !producer ||
    (!retainedHandoff &&
      (producer.controller_revision !== source.revision ||
        producer.controller_ref !== source.execution_ref ||
        producer.workflow_sha256 !== source.workflow_sha256)) ||
    producer.actor_id !== source.actor_id ||
    producer.configuration_sha256 !== releaseCanonicalDigest(authorities) ||
    producer.setup_sha256 !== authorities.setup_plan_sha256 ||
    producer.run_attempt !== 1
  )
    throw new Error(
      "retained checkpoint source/setup/configuration differs from selected authority",
    );
  active();
  const response = await api.request(
    "GET",
    `repos/boburning/portcove/actions/jobs/${String(producer.job_id)}`,
  );
  active();
  const job = response.body;
  // Application/catalog share this same journal and site cursor. Authenticate
  // past custody across both fixed job sets; current operating authority stays
  // separately bound to its app/catalog policy in the private executor.
  const roles = [
    ...new Set([
      ...capacityExecutorRolesForPurpose("application"),
      ...capacityExecutorRolesForPurpose("catalog-publication"),
    ]),
  ].filter((role) => isRecord(job) && job.name === capacityExecutorJobProfile(role).job);
  if (
    response.status !== 200 ||
    roles.length !== 1 ||
    (retainedHandoff && roles[0] !== "coordinator")
  )
    throw new Error("retained checkpoint has no unique allowed historical job role");
  // The lookup selects a closed role, never accepts it. The existing verifier
  // independently reads the exact original attempt/job/check and signature.
  const selected = {
    role: roles[0]!,
    producer: {
      controller_revision: String(producer.controller_revision),
      controller_ref: String(producer.controller_ref),
      workflow_sha256: String(producer.workflow_sha256),
      actor_id: String(producer.actor_id),
      configuration_sha256: String(producer.configuration_sha256),
      setup_sha256: String(producer.setup_sha256),
      job_id: String(producer.job_id),
      check_run_id: String(producer.check_run_id),
      run_id: String(producer.run_id),
      run_attempt: Number(producer.run_attempt),
    },
  };
  const authenticated = await authenticateCoordinatorCheckpointEvidence(
    directory,
    checkpoint,
    configuration,
    evidence,
    selected,
    deadline,
  );
  requireAuthenticatedCheckpointEvidence(authenticated, checkpoint.checkpoint, configuration);
  active();
  return {
    kind: "authenticated-retained-checkpoint" as const,
    checkpoint: checkpoint.checkpoint,
    authenticated,
    authority: "none" as const,
  };
}

type Checkpoint = Awaited<ReturnType<typeof exportCoordinatorCheckpoint>>;
export interface CheckpointProducerExpectation {
  actor_id: string;
  check_run_id: string;
  configuration_sha256: string;
  controller_ref: string;
  controller_revision: string;
  job_id: string;
  run_attempt: number;
  run_id: string;
  setup_sha256: string;
  workflow_sha256: string;
}
export interface AuthenticatedCheckpointEvidence {
  readonly kind: "authenticated-checkpoint-evidence";
  readonly evidence_scope: "github.com" | "injected-provider";
  readonly capture_directory: string;
  readonly authority: "none";
}
const receipts = new WeakMap<
  AuthenticatedCheckpointEvidence,
  {
    checkpoint: string;
    namespace: string;
    evidence: CoordinatorCheckpointEvidence;
    deadline: number;
    scope: "github.com" | "injected-provider";
  }
>();
const hash = (value: Buffer) => createHash("sha256").update(value).digest("hex");

export async function authenticateCoordinatorCheckpointEvidence(
  directory: string,
  rawCheckpoint: Checkpoint,
  rawConfiguration: unknown,
  rawEvidence: CoordinatorCheckpointEvidence,
  rawExpected: { role: CapacityExecutorRole; producer: CheckpointProducerExpectation },
  deadline: number,
  options: {
    attestation?: NonNullable<Parameters<typeof verifyControllerArtifactVerification>[5]>;
    job?: Pick<Parameters<typeof verifyHistoricalCheckpointJob>[3], "provider">;
  } = {},
): Promise<AuthenticatedCheckpointEvidence> {
  // Copy bounded bytes and all independently selected metadata synchronously.
  // No caller-retained buffer/object can change the binding across an await.
  if (
    !Buffer.isBuffer(rawEvidence.subject) ||
    rawEvidence.subject.length < 1 ||
    rawEvidence.subject.length > coordinatorCheckpointSubjectLimit ||
    !Buffer.isBuffer(rawEvidence.bundle) ||
    rawEvidence.bundle.length < 1 ||
    rawEvidence.bundle.length > 65536
  )
    throw new Error("checkpoint authentication evidence exceeds byte bounds");
  const evidence = {
    subject: Buffer.from(rawEvidence.subject),
    bundle: Buffer.from(rawEvidence.bundle),
  };
  const checkpoint = structuredClone(rawCheckpoint);
  const configuration: unknown = structuredClone(rawConfiguration);
  const expected = structuredClone(rawExpected);
  const attestationOptions =
    options.attestation === undefined
      ? undefined
      : {
          ...options.attestation,
          ...(options.attestation.environment
            ? { environment: { ...options.attestation.environment } }
            : {}),
        };
  const jobOptions = options.job === undefined ? undefined : { ...options.job };
  const scope =
    attestationOptions !== undefined || jobOptions !== undefined
      ? "injected-provider"
      : "github.com";
  const active = () => {
    if (!Number.isFinite(deadline) || performance.now() >= deadline)
      throw new Error("checkpoint authentication original deadline exhausted");
  };
  active();
  if (deadline - performance.now() > 120000)
    throw new Error("checkpoint authentication requires an original bounded deadline");
  const parsedSubject: unknown = JSON.parse(evidence.subject.toString("utf8"));
  const native =
    isRecord(parsedSubject) && parsedSubject.schema_version === 2
      ? parsedSubject.native_custody
      : undefined;
  const selected = coordinatorCheckpointEvidenceSubject(
    checkpoint,
    configuration,
    expected.producer,
    native,
  );
  if (!Buffer.isBuffer(evidence.subject) || !evidence.subject.equals(selected))
    throw new Error("checkpoint evidence differs from independently expected producer/inputs");
  inspectCoordinatorCheckpointEvidence(checkpoint, configuration, evidence);
  const readerEnvironment = readOnlyReleaseChildEnvironment();
  const environment = attestationOptions?.environment ?? readerEnvironment;
  if (!environment)
    throw new Error("checkpoint verification requires isolated read-only child credentials");
  if (
    !path.isAbsolute(directory) ||
    (await realpath(directory)) !== path.resolve(directory) ||
    !(await lstat(directory)).isDirectory()
  )
    throw new Error("checkpoint authentication requires an owned canonical capture parent");
  active();
  const capture = await mkdtemp(path.join(directory, "checkpoint-verification-"));
  let phase = "capture";
  try {
    const subjectPath = path.join(capture, "transition.json");
    const bundlePath = path.join(capture, "bundle.sigstore.json");
    const original = {
      subject: Buffer.from(evidence.subject),
      bundle: Buffer.from(evidence.bundle),
    };
    await writeFile(subjectPath, original.subject, { flag: "wx", mode: 0o600 });
    await writeFile(bundlePath, original.bundle, { flag: "wx", mode: 0o600 });
    active();
    phase = "signature";
    const verified = verifyControllerArtifactVerification(
      capture,
      subjectPath,
      bundlePath,
      expected.producer,
      native === undefined
        ? coordinatorCheckpointPredicateType
        : nativeCoordinatorCheckpointPredicateType,
      { ...attestationOptions, environment, deadline },
    );
    // Reuse the exact transport statement binding after the real verifier. It
    // must verify THIS subject/bundle, not another valid controller statement.
    const raw: unknown = JSON.parse(original.bundle.toString());
    if (
      !isRecord(raw) ||
      !isRecord(raw.dsseEnvelope) ||
      typeof raw.dsseEnvelope.payload !== "string"
    )
      throw new Error("checkpoint verified envelope missing");
    const statement: unknown = JSON.parse(
      Buffer.from(raw.dsseEnvelope.payload, "base64").toString(),
    );
    if (!isDeepStrictEqual(verified.statement, statement))
      throw new Error("checkpoint verifier returned a different statement");
    if (verified.verifiedTimestamps.length > 8)
      throw new Error("checkpoint witnessed timestamp bound exceeded");
    const times = verified.verifiedTimestamps.map(parseControllerWitnessedTime);
    phase = "historical-job";
    const producer = expected.producer;
    const job = await verifyHistoricalCheckpointJob(
      expected.role,
      {
        controller_revision: producer.controller_revision,
        controller_ref: producer.controller_ref,
        actor_id: producer.actor_id,
        run_id: producer.run_id,
        run_attempt: producer.run_attempt,
        job_id: Number(producer.job_id),
        check_run_id: producer.check_run_id,
      },
      times[0]!,
      { token: readerEnvironment?.GH_TOKEN ?? "", deadline, ...jobOptions },
    );
    if (
      times.some((time) => time < job.witnessed_interval.start || time > job.witnessed_interval.end)
    )
      throw new Error("checkpoint witnessed times differ from original job interval");
    phase = "capture-readback";
    if (
      !(
        await readControllerToolFile(
          subjectPath,
          native === undefined ? 16384 : coordinatorCheckpointSubjectLimit,
        )
      ).equals(original.subject) ||
      !(await readControllerToolFile(bundlePath, 65536)).equals(original.bundle)
    )
      throw new Error("checkpoint verification input custody changed");
    active();
    const receipt: AuthenticatedCheckpointEvidence = Object.freeze({
      kind: "authenticated-checkpoint-evidence",
      evidence_scope: scope,
      capture_directory: capture,
      authority: "none",
    });
    await writeFile(
      path.join(capture, "verification.json"),
      JSON.stringify({
        checkpoint: checkpoint.checkpoint,
        role: expected.role,
        producer,
        subject_sha256: hash(original.subject),
        bundle_sha256: hash(original.bundle),
        verified_timestamps: times,
        job,
        evidence_scope: scope,
        authority: "none",
      }),
      { flag: "wx", mode: 0o600 },
    );
    active();
    receipts.set(receipt, {
      checkpoint: checkpoint.checkpoint,
      namespace: inspectCoordinatorRemoteNamespace(configuration),
      evidence: original,
      deadline,
      scope,
    });
    return receipt;
  } catch (error) {
    // Original bytes and bounded error stay private. Do not print a verifier's
    // diagnostics, which may include network/provider or credential material.
    await writeFile(
      path.join(capture, "failure.txt"),
      Buffer.from(String(error)).subarray(0, 4096),
      { flag: "wx", mode: 0o600 },
    );
    throw new Error(
      `checkpoint authentication refused during ${phase}; capture retained at ${capture}`,
    );
  }
}

/** Same-process provenance receipt only. Current controls/history-anchor checks
 * remain the owning controller's responsibility before any journal mutation. */
export function requireAuthenticatedCheckpointEvidence(
  receipt: AuthenticatedCheckpointEvidence,
  checkpoint: string,
  configuration: unknown,
) {
  const retained = receipts.get(receipt);
  if (
    !retained ||
    retained.scope !== "github.com" ||
    retained.checkpoint !== checkpoint ||
    retained.namespace !== inspectCoordinatorRemoteNamespace(configuration) ||
    performance.now() >= retained.deadline
  )
    throw new Error("actual current authenticated checkpoint evidence required");
  return {
    subject: Buffer.from(retained.evidence.subject),
    bundle: Buffer.from(retained.evidence.bundle),
  };
}
