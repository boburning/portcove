import { mkdir, mkdtemp } from "node:fs/promises";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { readGitHubArtifactArchive } from "./github-binary.mts";
import { stageReleaseArtifact } from "./release-artifact-archive.mts";
import { releaseBuildArtifactName } from "./release-package-policy.mts";
import { collectReleaseRunEvidence } from "./release-run-evidence.mts";
import type { ReleaseEvidenceOptions, ReleaseEvidenceRequest } from "./release-run-evidence.mts";
import {
  assembleTrustedRelease,
  inspectTrustedAssemblyInput,
} from "./trusted-release-assembly.mts";
import { isRecord } from "./runtime-values.mts";
import { createGitHubRunner, GitHubApiClient } from "./github-api.mts";

/** Non-signing integration: independently accepted exact artifact inputs become
 * a NEW full-policy aggregate in fresh private storage. Run/artifact evidence
 * remains run-level; this never invents original producer jobs or authority.
 * The trusted workflow must separately authenticate its own identity and bind
 * its newly uploaded immutable artifact through attestation.
 */
export async function assembleReleaseArtifacts(
  privateRoot: string,
  rawAssembly: unknown,
  rawArchives: unknown,
  evidenceRequest: ReleaseEvidenceRequest,
  options: {
    evidence?: ReleaseEvidenceOptions;
    download?: typeof readGitHubArtifactArchive;
  } = {},
) {
  // Freeze caller-owned expectations before any async filesystem/policy read.
  rawAssembly = structuredClone(rawAssembly);
  rawArchives = structuredClone(rawArchives);
  evidenceRequest = structuredClone(evidenceRequest);
  const started = performance.now();
  const active = () => {
    if (performance.now() - started >= 15 * 60 * 1000)
      throw new Error("artifact assembly deadline exhausted");
  };
  const { accepted, labels } = await inspectTrustedAssemblyInput(rawAssembly);
  if (
    evidenceRequest.repository_id !== 1354613114 ||
    String(evidenceRequest.run_id) !== accepted.run_id ||
    evidenceRequest.attempt !== accepted.run_attempt ||
    evidenceRequest.revision !== accepted.source_commit ||
    evidenceRequest.tree !== accepted.source_tree
  )
    throw new Error("assembly and run evidence identities differ");
  if (!Array.isArray(rawArchives) || rawArchives.length !== labels.length)
    throw new Error("complete bounded artifact matrix is required");
  const archives = rawArchives.map((raw) => {
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
      raw.bytes < 22 ||
      raw.bytes > 512 * 1024 * 1024 ||
      typeof raw.sha256 !== "string" ||
      !/^[a-f0-9]{64}$/u.test(raw.sha256)
    )
      throw new Error("artifact input identity exceeds its bounds");
    return {
      platform: raw.platform,
      artifact_id: raw.artifact_id,
      bytes: raw.bytes,
      sha256: raw.sha256,
    };
  });
  if (
    new Set(archives.map((a) => a.platform)).size !== labels.length ||
    new Set(archives.map((a) => a.artifact_id)).size !== labels.length ||
    archives.reduce((sum, a) => sum + a.bytes, 0) > 2 * 1024 * 1024 * 1024
  )
    throw new Error("artifact matrix is duplicated or exceeds total bytes");
  const runner = createGitHubRunner({ cwd: privateRoot, maxBuffer: 2 * 1024 * 1024 });
  const evidenceOptions = options.evidence ?? {
    api: new GitHubApiClient((args, input) => {
      if (args[0] !== "api") throw new Error("artifact evidence is API-only");
      return runner(["api", "--hostname", "github.com", ...args.slice(1)], input);
    }),
  };
  const before = collectReleaseRunEvidence(evidenceRequest, evidenceOptions);
  const check = (evidence: typeof before) => {
    for (const archive of archives) {
      const matched = evidence.artifacts.filter((a) => a.id === archive.artifact_id);
      const actual = matched[0];
      if (
        matched.length !== 1 ||
        !actual ||
        actual.expired ||
        actual.name !==
          releaseBuildArtifactName(
            archive.platform,
            String(evidenceRequest.run_id),
            evidenceRequest.attempt,
          ) ||
        actual.bytes !== archive.bytes ||
        actual.archive_sha256 !== archive.sha256
      )
        throw new Error("accepted artifact identity differs from complete provider inventory");
    }
  };
  check(before);
  active();
  const directory = await mkdtemp(path.join(path.resolve(privateRoot), "artifact-assembly-"));
  try {
    const inputs = path.join(directory, "inputs");
    await mkdir(inputs);
    for (const archive of archives) {
      active();
      const bytes = (options.download ?? readGitHubArtifactArchive)(
        `repos/boburning/portcove/actions/artifacts/${archive.artifact_id}/zip`,
        {
          cwd: directory,
          maxBytes: archive.bytes,
          timeoutMs: Math.min(
            120000,
            Math.max(1, Math.floor(15 * 60 * 1000 - (performance.now() - started))),
          ),
        },
      );
      active();
      await stageReleaseArtifact(
        inputs,
        bytes,
        accepted,
        archive.platform,
        {
          bytes: archive.bytes,
          sha256: archive.sha256,
        },
        { exactProducerAttempt: true },
      );
    }
    const after = collectReleaseRunEvidence(evidenceRequest, evidenceOptions);
    check(after);
    if (
      JSON.stringify(before.run) !== JSON.stringify(after.run) ||
      archives.some(
        (a) =>
          JSON.stringify(before.artifacts.find((entry) => entry.id === a.artifact_id)) !==
          JSON.stringify(after.artifacts.find((entry) => entry.id === a.artifact_id)),
      )
    )
      throw new Error("selected artifact or run changed during collection");
    active();
    const aggregate = await assembleTrustedRelease(directory, inputs, accepted);
    active();
    return {
      schema_version: 1,
      directory,
      aggregate,
      archives,
      before_api_evidence: before,
      after_api_evidence: after,
      evidence_scope: options.download || options.evidence ? "injected-provider" : "github.com",
      authenticated_assembler: null,
      original_compiler: null,
      authority: "none",
    };
  } catch (cause) {
    throw new Error(`artifact assembly refused; retain owned directory ${directory}`, { cause });
  }
}
