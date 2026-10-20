import {
  prepareFrozenSemanticProposalInputs,
  prepareFrozenSemanticInputs,
} from "./release-semantic-inputs.mts";
import {
  runSemanticProposalRuntime,
  runSemanticRuntime,
  requireDirectSemanticProposalCapture,
  requireDirectSemanticRefusalCapture,
  requireDirectSemanticDispositionCapture,
  verifyDirectSemanticCapture,
  prepareCapturedSemanticDisposition,
} from "./release-semantic-runtime.mts";
import type { LinuxSemanticRuntimeConfiguration } from "./release-semantic-runtime.mts";
import {
  publishSemanticCapture,
  publishSemanticDispositionCapture,
} from "./release-semantic-broker.mts";
import {
  authenticateCapturedSemanticIssuer,
  authenticateCapturedSemanticDisposition,
} from "./release-semantic-issuer.mts";
import type { SemanticIssuerCustody } from "./release-semantic-issuer.mts";
import type { GitHubRestReader } from "./github-api.mts";
import { inspectReleaseReviewRequest } from "./release-review-request.mts";
import { capacityDigest } from "./release-capacity.mts";

/** One existing-journal request, using the appointed runtime in both stages.
 * The fixed local executor owns source acquisition, serial execution, the
 * actual provisioning guard and durable restart reconciliation. This function
 * cannot accept a report, invocation transcript, outcome or injected reviewer.
 * No full-review failure is converted into acceptance or blindly re-posted. */
export async function reviewFrozenCoordinatorRequest(
  api: GitHubRestReader,
  sourceRepository: string,
  rawRequest: unknown,
  rawConfiguration: {
    namespace: string;
    runtime: LinuxSemanticRuntimeConfiguration;
    issuer: SemanticIssuerCustody;
    requireCurrentRequestAndProvisioning: () => Promise<void>;
    retainOriginalCheckRequest: (value: {
      root: string;
      proposed_request: unknown;
    }) => Promise<void>;
  },
) {
  const request = inspectReleaseReviewRequest(structuredClone(rawRequest));
  if (!request) throw new Error("semantic pipeline requires the exact coordinator request");
  const configuration = {
    namespace: rawConfiguration.namespace,
    runtime: {
      ...rawConfiguration.runtime,
      tools_sha256: { ...rawConfiguration.runtime.tools_sha256 },
    },
    issuer: structuredClone(rawConfiguration.issuer),
    guard: rawConfiguration.requireCurrentRequestAndProvisioning,
    retain: rawConfiguration.retainOriginalCheckRequest,
  };
  if (typeof configuration.guard !== "function" || typeof configuration.retain !== "function")
    throw new Error("semantic pipeline provisioning/current-request guard unavailable");
  const namespace = { schema_version: 1 as const, namespace: configuration.namespace };
  await configuration.guard();
  const proposalBundle = prepareFrozenSemanticProposalInputs(
    api,
    sourceRepository,
    request,
    namespace,
  );
  const proposalCapture = await runSemanticProposalRuntime(proposalBundle, configuration.runtime);
  const proposal = await requireDirectSemanticProposalCapture(proposalCapture);
  await configuration.guard();
  const publishDisposition = async (capture: unknown) => {
    const direct = await requireDirectSemanticDispositionCapture(capture);
    await configuration.retain({ root: direct.root, proposed_request: direct.proposed_request });
    return publishSemanticDispositionCapture(capture, configuration.issuer.issuer, {
      requireProvisioningGrant: configuration.guard,
      authenticateIssuer: () =>
        authenticateCapturedSemanticDisposition(capture, configuration.issuer),
    });
  };
  if (proposal.review.outcome === "refused") {
    const capture = await prepareCapturedSemanticDisposition({
      kind: "classification-proposal",
      capture: proposalCapture,
    });
    return {
      stage: "classification-proposal",
      outcome: "refused",
      check: await publishDisposition(capture),
    };
  }
  // The proposed fields are inert evidence from the same actual runtime. The
  // full reviewer receives the independently rebuilt source/baseline/delta and
  // must explicitly accept the exact complete opportunity on its own merits.
  const opportunity = proposal.review.opportunity;
  const bundle = prepareFrozenSemanticInputs(
    api,
    sourceRepository,
    opportunity,
    {
      classification: {
        scope: "unaccepted-classification-proposal",
        proposal_bundle_sha256: proposal.bundle_sha256,
        proposal_invocation_sha256: capacityDigest(proposal.invocation),
        events_sha256: proposal.events_sha256,
        session_ref: proposal.review.session,
        report: proposal.review.report,
        proposed_classification: opportunity.classification,
      },
      compatibility: {
        scope: "semantic-compatibility-assessment-required; native-qualification-separate",
        proposed_compatibility: opportunity.classification.compatibility,
      },
    },
    namespace,
  );
  await configuration.guard();
  let accepted: Awaited<ReturnType<typeof runSemanticRuntime>>;
  try {
    accepted = await runSemanticRuntime(bundle, configuration.runtime);
  } catch (error) {
    // This accepts only an actual settled structured negative runtime result.
    // Startup/auth/parse/teardown failures have no such private provenance and
    // stop here without releasing an issuer credential or publishing a Check.
    try {
      await requireDirectSemanticRefusalCapture(error);
    } catch {
      throw error;
    }
    const capture = await prepareCapturedSemanticDisposition({
      kind: "complete-opportunity",
      error,
      request,
    });
    await configuration.guard();
    return {
      stage: "complete-opportunity",
      outcome: capture.wire.disposition,
      check: await publishDisposition(capture),
    };
  }
  await configuration.guard();
  const actual = await verifyDirectSemanticCapture(accepted);
  await configuration.retain({
    root: actual.root,
    proposed_request: actual.handoff.proposed_request,
  });
  const check = await publishSemanticCapture(accepted, configuration.issuer.issuer, {
    requireProvisioningGrant: configuration.guard,
    authenticateIssuer: () => authenticateCapturedSemanticIssuer(accepted, configuration.issuer),
  });
  return { stage: "complete-opportunity", outcome: "accepted", check };
}
