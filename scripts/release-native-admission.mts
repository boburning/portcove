import { nativePlatformsForReleaseProfile } from "./release-package-policy.mts";
import { isInitialBetaReleaseProfile } from "./release-package-policy.mts";
import { isDeepStrictEqual } from "node:util";
import { performance } from "node:perf_hooks";
import { coordinatorCommandTimeout } from "./release-coordinator-deadline.mts";
import path from "node:path";
import { discoverNativeQualificationLocators } from "./release-native-check-discovery.mts";
import { artifactName } from "./release-package-policy.mts";
import { inspectTrustedAssemblyInput } from "./trusted-release-assembly.mts";
import { inspectNativeReleaseQualification } from "./release-native-qualification-contract.mts";
import type { NativeQualificationStage } from "./release-native-qualification-contract.mts";
import {
  verifiedNativeReleaseQualification,
  inspectNativeQualificationExpectation,
  inspectNativeQualificationTemplate,
  collectNativeReleaseQualification,
} from "./release-native-acceptance.mts";
import { isRecord } from "./runtime-values.mts";
import {
  inspectReleaseAuthorityConfiguration,
  requireControllerApplicationJobAuthorities,
} from "./release-authority-configuration.mts";

/** Pure reconstruction of expected inputs, not a source of native authority.
 * Dynamic locators cannot choose an issuer, host, source, compatibility or stage. */
export async function deriveNativeQualificationTemplates(
  rawAuthorities: unknown,
  rawAssembly: unknown,
  rawArchives: unknown,
) {
  const authorities = inspectReleaseAuthorityConfiguration(rawAuthorities);
  const archives: unknown = structuredClone(rawArchives);
  const { accepted, policy, labels } = await inspectTrustedAssemblyInput(
    structuredClone(rawAssembly),
  );
  if (
    accepted.release_profile !== "initial-beta-win-linux" ||
    labels.length !== 2 ||
    !Array.isArray(archives) ||
    archives.length !== 2
  )
    throw new Error("fixed native templates require the exact selected package pair");
  return Object.freeze(
    labels.map((platform) => {
      if (platform !== "windows-x86_64" && platform !== "linux-x86_64")
        throw new Error("fixed native template platform differs");
      const fixed = authorities.native[platform];
      const archive: unknown = archives.find(
        (item: unknown) => isRecord(item) && item.platform === platform,
      );
      if (!isRecord(archive)) throw new Error("native exact immutable platform archive missing");
      const entry = policy.packages.find(
        (item) =>
          item.platform_label === platform &&
          item.interface === "desktop" &&
          (item.format === "nsis" || item.format === "appimage"),
      );
      if (!entry) throw new Error("native selected updater package missing");
      const filename = artifactName(entry, accepted.version);
      const file = accepted.files.find(
        (item) => item.platform_label === platform && item.filename === filename,
      );
      if (!file) throw new Error("native actual updater bytes missing");
      return inspectNativeQualificationTemplate({
        schema_version: 1,
        native_app_id: authorities.apps.native_qualification.app_id,
        semantic_app_id: authorities.apps.semantic.app_id,
        classification_app_id: authorities.apps.classification.app_id,
        stage: "payload-signing",
        platform_label: platform,
        candidate: {
          source_commit: accepted.source_commit,
          source_tree: accepted.source_tree,
          run_id: accepted.run_id,
          run_attempt: accepted.run_attempt,
          artifact_id: archive.artifact_id,
          package: { filename, bytes: file.bytes, sha256: file.sha256 },
        },
        producer: fixed.producer,
        host: fixed.host,
        compatibility: fixed.compatibility,
        journey: null,
      });
    }),
  );
}

/** Locator binding is integrity-only; actual collection must reauthenticate each Check. */
export function bindNativeQualificationLocators(
  rawLocators: unknown,
  rawTemplates: readonly unknown[],
) {
  const locators: unknown = structuredClone(rawLocators);
  const templates = rawTemplates.map(inspectNativeQualificationTemplate);
  if (
    !Array.isArray(locators) ||
    locators.length !== 2 ||
    templates.length !== 2 ||
    new Set(templates.map((item) => item.platform_label)).size !== 2
  )
    throw new Error("fixed native locators require the exact selected package pair");
  const expected = locators.map((raw: unknown) => {
    if (
      !isRecord(raw) ||
      Object.keys(raw).sort().join(",") !== "check_id,invocation_id,platform_label"
    )
      throw new Error("native dynamic locator cannot supply authority or an unknown tuple");
    const template = templates.find((item) => item.platform_label === raw.platform_label);
    if (!template) throw new Error("native locator platform differs");
    return inspectNativeQualificationExpectation({
      ...template,
      check_id: raw.check_id,
      producer: { ...template.producer, invocation_id: raw.invocation_id },
    });
  });
  if (
    new Set(expected.map((item) => item.platform_label)).size !== 2 ||
    new Set(expected.map((item) => item.check_id)).size !== 2
  )
    throw new Error("native locator platform or Check duplicated");
  return Object.freeze(expected);
}

export async function deriveNativeQualificationExpectations(
  rawAuthorities: unknown,
  rawLocators: unknown,
  rawAssembly: unknown,
  rawArchives: unknown,
  stage: NativeQualificationStage,
) {
  if (stage !== "payload-signing")
    throw new Error("fixed native locators require exact pre-sign stage");
  return bindNativeQualificationLocators(
    rawLocators,
    await deriveNativeQualificationTemplates(rawAuthorities, rawAssembly, rawArchives),
  );
}

/** Actual fixed hosted entry. The independently ratified global authority
 * factory is mandatory; raw caller configuration cannot replace it. */
export async function collectConfiguredNativeReleaseQualificationPair(
  outputParent: string,
  locators: unknown,
  assembly: unknown,
  archives: unknown,
  phase: "admission" | "payload" = "payload",
) {
  if (phase !== "admission" && phase !== "payload")
    throw new Error("fixed pre-sign native reader phase required");
  const deadline = performance.now() + coordinatorCommandTimeout(120000);
  const capturedLocators: unknown = structuredClone(locators),
    capturedAssembly: unknown = structuredClone(assembly),
    capturedArchives: unknown = structuredClone(archives);
  const view = await requireControllerApplicationJobAuthorities(phase);
  if (view.configuration.schema_version === 4) {
    const { collectConfiguredHostedNativePayloadPair } =
      await import("./release-hosted-native-admission.mts");
    return collectConfiguredHostedNativePayloadPair(
      outputParent,
      capturedLocators,
      capturedAssembly,
      capturedArchives,
      phase,
      deadline,
    );
  }
  if (!path.isAbsolute(outputParent))
    throw new Error("native evidence output parent must be absolute");
  const templates = await deriveNativeQualificationTemplates(
    view.configuration,
    capturedAssembly,
    capturedArchives,
  );
  const selectedLocators =
    capturedLocators === null
      ? discoverNativeQualificationLocators(templates, deadline)
      : capturedLocators;
  const expected = bindNativeQualificationLocators(selectedLocators, templates);
  return collectNativeReleaseQualificationPair(
    outputParent,
    expected,
    capturedAssembly,
    capturedArchives,
    "payload-signing",
    deadline,
  );
}

/** The fixed controller supplies independently ratified issuer/host/harness
 * expectations, never authority inferred from the returned Check. The actual
 * acquisition then binds those reports to its own package/source/run facts. */
export async function collectNativeReleaseQualificationPair(
  outputParent: string,
  rawExpected: unknown,
  rawAssembly: unknown,
  rawArchives: unknown,
  stage: NativeQualificationStage,
  deadline?: number,
) {
  if (!Array.isArray(rawExpected) || rawExpected.length !== 2)
    throw new Error("fixed caller must supply exactly two independent native expectations");
  const expected = rawExpected.map(inspectNativeQualificationExpectation);
  const assembly = structuredClone(rawAssembly),
    archives = structuredClone(rawArchives);
  if (
    expected.some((item) => item.stage !== stage) ||
    new Set(expected.map((item) => item.platform_label)).size !== 2 ||
    new Set(expected.map((item) => item.check_id)).size !== 2
  )
    throw new Error("independent native stage/platform/Check pair differs");
  const receipts = [];
  for (const item of expected)
    receipts.push(
      await collectNativeReleaseQualification(
        outputParent,
        item,
        deadline === undefined ? {} : { deadline },
      ),
    );
  await requireNativeReleaseQualificationPair(receipts, assembly, archives, stage);
  return Object.freeze(receipts);
}

/** Exact association only. Raw reports remain metadata, including when this
 * inspector succeeds. Only the actual receipt getter below authenticates them. */
export async function inspectNativeQualificationAssociation(
  rawReports: unknown,
  rawAssembly: unknown,
  rawArchives: unknown,
  stage: NativeQualificationStage,
) {
  if (
    (stage !== "payload-signing" && stage !== "release-publication") ||
    !Array.isArray(rawReports) ||
    ![1, 2].includes(rawReports.length) ||
    !Array.isArray(rawArchives) ||
    ![1, 2].includes(rawArchives.length)
  )
    throw new Error("native qualification requires the exact selected two-platform pair");
  const reports = rawReports.map(inspectNativeReleaseQualification);
  const capturedArchives: unknown[] = structuredClone(rawArchives);
  const { accepted, policy, labels } = await inspectTrustedAssemblyInput(
    structuredClone(rawAssembly),
  );
  if (
    !isInitialBetaReleaseProfile(accepted.release_profile) ||
    !isDeepStrictEqual(
      [...labels].sort(),
      [...nativePlatformsForReleaseProfile(accepted.release_profile)].sort(),
    ) ||
    reports.length !== labels.length ||
    capturedArchives.length !== labels.length
  )
    throw new Error("native pair cannot qualify the unchanged full package profile");
  const archives = capturedArchives.map((raw: unknown) => {
    if (
      !isRecord(raw) ||
      Object.keys(raw).sort().join(",") !== "artifact_id,bytes,platform,sha256" ||
      typeof raw.platform !== "string" ||
      !labels.some((label) => label === raw.platform) ||
      typeof raw.artifact_id !== "number" ||
      !Number.isSafeInteger(raw.artifact_id) ||
      raw.artifact_id < 1 ||
      typeof raw.bytes !== "number" ||
      !Number.isSafeInteger(raw.bytes) ||
      raw.bytes < 1 ||
      typeof raw.sha256 !== "string" ||
      !/^[a-f0-9]{64}$/u.test(raw.sha256)
    )
      throw new Error("native expected archive identity is incomplete");
    return { platform: raw.platform, artifact_id: raw.artifact_id };
  });
  if (
    new Set(archives.map((a) => a.platform)).size !== labels.length ||
    new Set(archives.map((a) => a.artifact_id)).size !== labels.length ||
    new Set(reports.map((r) => r.platform_label)).size !== labels.length
  )
    throw new Error("native platform/archive identity is duplicated");
  for (const report of reports) {
    const entry = policy.packages.find(
      (p) =>
        p.platform_label === report.platform_label &&
        p.interface === "desktop" &&
        (p.format === "nsis" || p.format === "appimage"),
    );
    if (!entry) throw new Error("native updater package is not in the selected policy");
    const filename = artifactName(entry, accepted.version);
    const file = accepted.files.find(
      (f) => f.platform_label === report.platform_label && f.filename === filename,
    );
    const archive = archives.find((a) => a.platform === report.platform_label);
    if (
      !file ||
      !archive ||
      report.stage !== stage ||
      !isDeepStrictEqual(report.candidate, {
        source_commit: accepted.source_commit,
        source_tree: accepted.source_tree,
        run_id: accepted.run_id,
        run_attempt: accepted.run_attempt,
        artifact_id: archive.artifact_id,
        package: { filename, bytes: file.bytes, sha256: file.sha256 },
      })
    )
      throw new Error(
        "native stage/package/source/run/attempt/artifact differs from actual acquisition",
      );
  }
  return {
    reports,
    authority: "none" as const,
    scope: "exact association only; no native authentication",
  };
}

/** Preserves the actual same-process native receipt brands separately from the
 * caller's public assembly facts. Imported/injected reports cannot enter here. */
export async function requireNativeReleaseQualificationPair(
  receipts: readonly object[],
  rawAssembly: unknown,
  rawArchives: unknown,
  stage: NativeQualificationStage,
) {
  const expected = nativePlatformsForReleaseProfile(
    (await inspectTrustedAssemblyInput(rawAssembly)).accepted.release_profile,
  );
  const validReceipts = (raw: unknown): raw is readonly object[] =>
    Array.isArray(raw) &&
    raw.length === expected.length &&
    raw.every((value: unknown) => typeof value === "object" && value !== null);
  if (!validReceipts(receipts))
    throw new Error("two actual native qualification receipts are required");
  const captured = [...receipts],
    assembly = structuredClone(rawAssembly),
    archives = structuredClone(rawArchives);
  const reports = [];
  for (const receipt of captured) reports.push(await verifiedNativeReleaseQualification(receipt));
  await inspectNativeQualificationAssociation(
    reports.map(({ check: _check, hosted_job: _hosted, evidence_ids: _ids, ...base }) => base),
    assembly,
    archives,
    stage,
  );
  return Object.freeze(reports);
}
