import { applicationReleaseProfile } from "./release-authority-configuration-contract.mts";
import { nativePlatformsForReleaseProfile } from "./release-package-policy.mts";
import { isInitialBetaReleaseProfile } from "./release-package-policy.mts";
/** Selected source-bound pre-sign reader. The transferred proof is inert until
 * the actual receiver verifies it; no locator may appoint source or authority. */
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { performance } from "node:perf_hooks";
import { isDeepStrictEqual } from "node:util";
import {
  inspectSelectedPublicationAuthorityConfiguration,
  requireControllerApplicationJobAuthorities,
} from "./release-authority-configuration.mts";
import { readProductionControllerWorkflowBytes } from "./production-controller-admission.mts";
import { inspectTrustedAssemblyInput } from "./trusted-release-assembly.mts";
import { artifactName } from "./release-package-policy.mts";
import {
  inspectNativeQualificationCandidate,
  inspectNativeQualificationJourney,
} from "./release-native-qualification-contract.mts";
import {
  hostedNativeProofLimits,
  inspectHostedNativeProducer,
} from "./release-hosted-native-proof-contract.mts";
import type { HostedNativeProofFiles } from "./release-hosted-native-proof-contract.mts";
import { collectHostedNativeReleaseQualification } from "./release-hosted-native-acceptance.mts";
import { requireNativeReleaseQualificationPair } from "./release-native-admission.mts";
import { coordinatorCommandTimeout } from "./release-coordinator-deadline.mts";
import { isRecord } from "./runtime-values.mts";
import { createGitHubRunner, GitHubApiClient } from "./github-api.mts";
import { readOnlyReleaseChildEnvironment } from "./release-readonly-child-environment.mts";
import { readHostedNativeProofArtifact } from "./release-hosted-native-artifact.mts";

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
    accepted.release_profile !== applicationReleaseProfile(configuration) ||
    !isInitialBetaReleaseProfile(accepted.release_profile) ||
    !isDeepStrictEqual(
      [...labels].sort(),
      [...nativePlatformsForReleaseProfile(accepted.release_profile)].sort(),
    ) ||
    !Array.isArray(archives) ||
    archives.length !== labels.length
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

/** Exact package and independently derived signed-repository journey data.
 * This parser grants no TUF/context, producer or native authority. */
export async function deriveHostedNativePublicationOpportunities(
  rawAuthorities: unknown,
  rawAssembly: unknown,
  rawArchives: unknown,
  rawJourneys: unknown,
) {
  const opportunities = await deriveHostedNativePayloadOpportunities(
    rawAuthorities,
    rawAssembly,
    rawArchives,
  );
  const journeys: unknown = structuredClone(rawJourneys);
  if (
    !Array.isArray(journeys) ||
    journeys.length !== opportunities.length ||
    journeys.some(
      (value: unknown) =>
        !isRecord(value) ||
        Object.keys(value).sort().join(",") !== "journey,platform_label" ||
        !["windows-x86_64", "linux-x86_64"].includes(String(value.platform_label)),
    ) ||
    new Set(journeys.map((value: unknown) => (isRecord(value) ? value.platform_label : null)))
      .size !== opportunities.length
  )
    throw new Error("exact independently derived native publication journey pair required");
  return opportunities.map((opportunity) => {
    const value: unknown = journeys.find(
      (entry: unknown) => isRecord(entry) && entry.platform_label === opportunity.platform_label,
    );
    if (!isRecord(value)) throw new Error("native publication journey platform differs");
    return {
      ...opportunity,
      stage: "release-publication" as const,
      journey: inspectNativeQualificationJourney(
        value.journey,
        "release-publication",
        opportunity.candidate,
        true,
      ),
    };
  });
}

function transfers(raw: unknown) {
  if (!Array.isArray(raw) || ![1, 2].includes(raw.length))
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
    new Set(captured.map((entry) => entry.locator.platform_label)).size !== captured.length ||
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
  originalDeadline?: number,
) {
  if (phase !== "admission" && phase !== "payload")
    throw new Error("fixed payload native reader phase required");
  return collectConfiguredHostedNativePair(
    outputParent,
    rawTransfers,
    rawAssembly,
    rawArchives,
    "payload-signing",
    phase,
    originalDeadline ?? performance.now() + coordinatorCommandTimeout(120000),
    null,
  );
}

/** The owning post-sign caller must separately verify actual TUF/context and
 * current reservation before and after this exact signed-proof collection. */
export function collectConfiguredHostedNativePublicationPair(
  outputParent: string,
  rawTransfers: unknown,
  rawAssembly: unknown,
  rawArchives: unknown,
  rawJourneys: unknown,
  originalDeadline: number,
) {
  return collectConfiguredHostedNativePair(
    outputParent,
    rawTransfers,
    rawAssembly,
    rawArchives,
    "release-publication",
    "release-publication",
    originalDeadline,
    rawJourneys,
  );
}

async function collectConfiguredHostedNativePair(
  outputParent: string,
  rawTransfers: unknown,
  rawAssembly: unknown,
  rawArchives: unknown,
  stage: "payload-signing" | "release-publication",
  phase: "admission" | "payload" | "release-publication",
  deadline: number,
  rawJourneys: unknown,
) {
  if (!Number.isFinite(deadline) || deadline - performance.now() > 120000)
    throw new Error("configured native bounded original deadline required");
  const supplied = rawTransfers === null ? null : transfers(rawTransfers),
    assembly: unknown = structuredClone(rawAssembly),
    archives: unknown = structuredClone(rawArchives),
    journeys: unknown = structuredClone(rawJourneys);
  const active = () => {
    if (performance.now() >= deadline)
      throw new Error("configured native original deadline exhausted");
  };
  active();
  const view = await requireControllerApplicationJobAuthorities(phase);
  active();
  const configuration = inspectSelectedPublicationAuthorityConfiguration(view.configuration);
  if (configuration.purpose !== "application")
    throw new Error("selected native application source required");
  const expectedPlatforms = nativePlatformsForReleaseProfile(
    applicationReleaseProfile(configuration),
  );
  if (
    supplied &&
    (supplied.length !== expectedPlatforms.length ||
      supplied.some(
        (entry) => !expectedPlatforms.some((platform) => platform === entry.locator.platform_label),
      ))
  )
    throw new Error("native transfer platform differs from ratified release profile");
  const opportunities =
    stage === "payload-signing"
      ? await deriveHostedNativePayloadOpportunities(configuration, assembly, archives)
      : await deriveHostedNativePublicationOpportunities(
          configuration,
          assembly,
          archives,
          journeys,
        );
  active();
  const workflow = await readProductionControllerWorkflowBytes();
  active();
  const workflowDigest = createHash("sha256").update(workflow).digest("hex");
  const captured =
    supplied ??
    (() => {
      const runId = view.source.run_id;
      if (typeof runId !== "string")
        throw new Error("native artifact discovery requires the original source run");
      const environment = readOnlyReleaseChildEnvironment();
      if (!environment)
        throw new Error("native artifact discovery requires isolated reader credentials");
      const api = new GitHubApiClient((args, input) => {
        active();
        const result = createGitHubRunner({
          cwd: outputParent,
          timeoutMs: Math.max(1, Math.floor(Math.min(30000, deadline - performance.now()))),
          maxBuffer: 2 * 1024 * 1024,
          spawn: (command, values, settings) =>
            spawnSync(command, values, { ...settings, env: environment }),
        })([...args, "--hostname", "github.com"], input);
        active();
        return result;
      });
      return opportunities.map((opportunity) =>
        readHostedNativeProofArtifact(
          api,
          {
            controller_revision: view.source.controller_revision,
            run_id: runId,
            run_attempt: view.source.run_attempt,
            platform_label: opportunity.platform_label,
            stage: opportunity.stage,
          },
          outputParent,
          deadline,
        ),
      );
    })();
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
  await requireNativeReleaseQualificationPair(receipts, assembly, archives, stage);
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
