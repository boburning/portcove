/** Selected source-bound pre-sign reader. The transferred proof is inert until
 * the actual receiver verifies it; no locator may appoint source or authority. */
import { createHash } from "node:crypto";
import { performance } from "node:perf_hooks";
import { isDeepStrictEqual } from "node:util";
import {
  inspectSelectedPublicationAuthorityConfiguration,
  requireControllerApplicationJobAuthorities,
} from "./release-authority-configuration.mts";
import { readProductionControllerWorkflowBytes } from "./production-controller-admission.mts";
import { inspectTrustedAssemblyInput } from "./trusted-release-assembly.mts";
import { artifactName } from "./release-package-policy.mts";
import { inspectNativeQualificationCandidate } from "./release-native-qualification-contract.mts";
import {
  hostedNativeProofLimits,
  inspectHostedNativeProducer,
} from "./release-hosted-native-proof-contract.mts";
import type { HostedNativeProofFiles } from "./release-hosted-native-proof-contract.mts";
import { collectHostedNativeReleaseQualification } from "./release-hosted-native-acceptance.mts";
import { requireNativeReleaseQualificationPair } from "./release-native-admission.mts";
import { coordinatorCommandTimeout } from "./release-coordinator-deadline.mts";
import { isRecord } from "./runtime-values.mts";

/** Independent exact package opportunity only; no runtime or issuer acceptance. */
export async function deriveHostedNativePayloadOpportunities(
  rawAuthorities: unknown,
  rawAssembly: unknown,
  rawArchives: unknown,
) {
  const configuration = inspectSelectedPublicationAuthorityConfiguration(rawAuthorities);
  if (configuration.purpose !== "application")
    throw new Error("application native source required");
  const archives: unknown = structuredClone(rawArchives);
  const { accepted, policy, labels } = await inspectTrustedAssemblyInput(
    structuredClone(rawAssembly),
  );
  if (
    accepted.release_profile !== "initial-beta-win-linux" ||
    !isDeepStrictEqual([...labels].sort(), ["linux-x86_64", "windows-x86_64"]) ||
    !Array.isArray(archives) ||
    archives.length !== 2
  )
    throw new Error("selected hosted native reader requires the complete fixed platform pair");
  const seen = new Set<number>();
  return labels.map((platform) => {
    if (platform !== "windows-x86_64" && platform !== "linux-x86_64")
      throw new Error("native platform differs");
    const matches = archives.filter(
      (archive: unknown) => isRecord(archive) && archive.platform === platform,
    );
    if (matches.length !== 1 || !isRecord(matches[0]))
      throw new Error("native exact archive absent or ambiguous");
    const archive = matches[0];
    const entry = policy.packages.find(
      (item) =>
        item.platform_label === platform &&
        item.interface === "desktop" &&
        (item.format === "nsis" || item.format === "appimage"),
    );
    if (!entry) throw new Error("native updater package absent");
    const filename = artifactName(entry, accepted.version);
    const files = accepted.files.filter(
      (file) => file.platform_label === platform && file.filename === filename,
    );
    if (files.length !== 1) throw new Error("native exact updater bytes absent or ambiguous");
    const file = files[0]!;
    const candidate = inspectNativeQualificationCandidate({
      source_commit: accepted.source_commit,
      source_tree: accepted.source_tree,
      run_id: accepted.run_id,
      run_attempt: accepted.run_attempt,
      artifact_id: archive.artifact_id,
      package: { filename, bytes: file.bytes, sha256: file.sha256 },
    });
    if (seen.has(candidate.artifact_id)) throw new Error("native platform artifact duplicated");
    seen.add(candidate.artifact_id);
    return {
      platform_label: platform,
      stage: "payload-signing" as const,
      candidate,
      journey: null,
    };
  });
}

function transfers(raw: unknown) {
  if (!Array.isArray(raw) || raw.length !== 2)
    throw new Error("two original native proof transfers required");
  const captured = raw.map((value: unknown) => {
    if (
      !isRecord(value) ||
      Object.keys(value).sort().join(",") !== "files,locator" ||
      !isRecord(value.locator) ||
      Object.keys(value.locator).sort().join(",") !==
        "check_run_id,job_id,platform_label,run_attempt,run_id" ||
      !isRecord(value.files) ||
      Object.keys(value.files).sort().join(",") !== "bundle,capture,report,subject"
    )
      throw new Error("native transfer locator cannot appoint an authority or unknown input");
    const locator = structuredClone(value.locator);
    const files = {} as HostedNativeProofFiles;
    for (const key of ["subject", "report", "capture", "bundle"] as const) {
      const bytes = value.files[key];
      if (
        !Buffer.isBuffer(bytes) ||
        bytes.length < 1 ||
        bytes.length > hostedNativeProofLimits[key]
      )
        throw new Error("native transfer file exceeds fixed bound");
      files[key] = Buffer.from(bytes);
    }
    return { locator, files };
  });
  if (
    new Set(captured.map((entry) => entry.locator.platform_label)).size !== 2 ||
    captured.some(
      (entry) => !["windows-x86_64", "linux-x86_64"].includes(String(entry.locator.platform_label)),
    )
  )
    throw new Error("native transfer platform pair differs");
  return captured;
}

/** Actual source factory, not an injected-provider or raw configuration entry.
 * Dynamic native run/job IDs locate a proof; current source, grant, actor,
 * configuration, setup and workflow are independently admitted before use. */
export async function collectConfiguredHostedNativePayloadPair(
  outputParent: string,
  rawTransfers: unknown,
  rawAssembly: unknown,
  rawArchives: unknown,
  phase: "admission" | "payload" = "payload",
) {
  if (phase !== "admission" && phase !== "payload")
    throw new Error("fixed payload native reader phase required");
  const deadline = performance.now() + coordinatorCommandTimeout(120000);
  const captured = transfers(rawTransfers),
    assembly: unknown = structuredClone(rawAssembly),
    archives: unknown = structuredClone(rawArchives);
  const active = () => {
    if (performance.now() >= deadline)
      throw new Error("configured native original deadline exhausted");
  };
  const view = await requireControllerApplicationJobAuthorities(phase);
  active();
  const configuration = inspectSelectedPublicationAuthorityConfiguration(view.configuration);
  if (configuration.purpose !== "application")
    throw new Error("selected native application source required");
  const opportunities = await deriveHostedNativePayloadOpportunities(
    configuration,
    assembly,
    archives,
  );
  active();
  const workflow = await readProductionControllerWorkflowBytes();
  active();
  const workflowDigest = createHash("sha256").update(workflow).digest("hex");
  const receipts = [];
  for (const opportunity of opportunities) {
    const transfer = captured.find(
      (entry) => entry.locator.platform_label === opportunity.platform_label,
    )!;
    const producer = inspectHostedNativeProducer(
      {
        controller_revision: view.source.controller_revision,
        controller_ref: view.source.controller_ref,
        actor_id: view.source.actor_id,
        configuration_sha256: view.configuration_sha256,
        grant_sha256: view.source.grant_sha256,
        setup_sha256: configuration.journal.setup_plan_sha256,
        workflow_sha256: workflowDigest,
        run_id: transfer.locator.run_id,
        run_attempt: transfer.locator.run_attempt,
        job_id: transfer.locator.job_id,
        check_run_id: transfer.locator.check_run_id,
      },
      opportunity.platform_label,
    );
    receipts.push(
      await collectHostedNativeReleaseQualification(
        outputParent,
        configuration,
        { ...opportunity, producer },
        transfer.files,
        deadline,
      ),
    );
    active();
  }
  // Existing association reads the actual assembly/archive facts, rather than
  // inferring candidate eligibility from a signed native report.
  await requireNativeReleaseQualificationPair(receipts, assembly, archives, "payload-signing");
  active();
  const rechecked = await requireControllerApplicationJobAuthorities(phase);
  active();
  if (
    !isDeepStrictEqual(rechecked.source, view.source) ||
    rechecked.configuration_sha256 !== view.configuration_sha256
  )
    throw new Error("native source changed before private handoff");
  return Object.freeze(receipts);
}
