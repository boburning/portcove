import { createHash } from "node:crypto";
import { crc32, inflateRawSync } from "node:zlib";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import { inspectBoundedZip } from "./bounded-zip.mts";
import { readGitHubArtifactArchive } from "./github-binary.mts";
import { releaseBuildArtifactName } from "./release-package-policy.mts";
import { isRecord } from "./runtime-values.mts";
import {
  inspectPublicBuildInputIdentity,
  prepareReleasePublicBuildInputs,
} from "./release-public-build-inputs.mts";
import type { collectReleaseRunEvidence } from "./release-run-evidence.mts";
import { CoordinatorRemoteError } from "./release-coordinator-errors.mts";

type Evidence = ReturnType<typeof collectReleaseRunEvidence>;
const labels = ["linux-x86_64", "windows-x86_64"];
const maximumArchiveBytes = 1024 * 1024;
const maximumExpandedBytes = 512 * 1024;
const members = new Map([
  ["root.json", 256 * 1024],
  ["bundle.json", 16 * 1024],
  ["updater-public.key", 16 * 1024],
  ["packaging.json", 16 * 1024],
  ["tauri.release-public.conf.json", 64 * 1024],
  ["build-inputs.json", 16 * 1024],
]);
const digest = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");

export function releasePublicBuildArtifactName(platform: string, runId: string, attempt: number) {
  return releaseBuildArtifactName(platform, runId, attempt).replace(
    "release-build-",
    "release-public-build-inputs-",
  );
}

export function inspectPublicBuildConfiguration(raw: unknown) {
  if (
    !isRecord(raw) ||
    Object.keys(raw).sort().join(",") !== "configuration_revision,manifest_sha256"
  )
    throw new Error("public build configuration requires independent exact identities");
  inspectPublicBuildInputIdentity(raw.configuration_revision, raw.manifest_sha256);
  return {
    configuration_revision: String(raw.configuration_revision),
    manifest_sha256: String(raw.manifest_sha256),
  };
}

export function inspectPublicBuildInputBinding(raw: unknown) {
  if (
    !isRecord(raw) ||
    Object.keys(raw).sort().join(",") !== "artifacts,configuration_revision,manifest_sha256"
  )
    throw new Error("public build input binding schema differs");
  const configuration = inspectPublicBuildConfiguration({
    configuration_revision: raw.configuration_revision,
    manifest_sha256: raw.manifest_sha256,
  });
  if (!Array.isArray(raw.artifacts) || raw.artifacts.length !== labels.length)
    throw new Error("public build inputs require the complete selected platform matrix");
  const artifacts = raw.artifacts
    .map((item) => {
      if (
        !isRecord(item) ||
        Object.keys(item).sort().join(",") !== "artifact_id,bytes,platform,sha256" ||
        typeof item.platform !== "string" ||
        !labels.includes(item.platform) ||
        typeof item.artifact_id !== "number" ||
        !Number.isSafeInteger(item.artifact_id) ||
        item.artifact_id < 1 ||
        typeof item.bytes !== "number" ||
        !Number.isSafeInteger(item.bytes) ||
        item.bytes < 22 ||
        item.bytes > maximumArchiveBytes ||
        typeof item.sha256 !== "string" ||
        !/^[a-f0-9]{64}$/u.test(item.sha256)
      )
        throw new Error("public build artifact identity exceeds its bounds");
      return {
        platform: item.platform,
        artifact_id: item.artifact_id,
        bytes: item.bytes,
        sha256: item.sha256,
      };
    })
    .sort((a, b) => a.platform.localeCompare(b.platform));
  if (
    new Set(artifacts.map((item) => item.platform)).size !== labels.length ||
    new Set(artifacts.map((item) => item.artifact_id)).size !== labels.length
  )
    throw new Error("public build artifact matrix is duplicated");
  return { ...configuration, artifacts };
}
export type PublicBuildInputBinding = ReturnType<typeof inspectPublicBuildInputBinding>;

export function selectPublicBuildInputBinding(rawConfiguration: unknown, evidence: Evidence) {
  const configuration = inspectPublicBuildConfiguration(rawConfiguration);
  return inspectPublicBuildInputBinding({
    ...configuration,
    artifacts: labels.map((platform) => {
      const matches = evidence.artifacts.filter(
        (item) =>
          item.name ===
          releasePublicBuildArtifactName(platform, String(evidence.run.id), evidence.run.attempt),
      );
      const item = matches[0];
      if (matches.length !== 1 || !item || item.expired || !item.archive_sha256)
        throw new Error("complete immutable public build input archive is unavailable");
      return { platform, artifact_id: item.id, bytes: item.bytes, sha256: item.archive_sha256 };
    }),
  });
}

export function requirePublicBuildInputProviderBinding(
  binding: PublicBuildInputBinding,
  evidence: Evidence,
) {
  for (const item of binding.artifacts) {
    const name = releasePublicBuildArtifactName(
      item.platform,
      String(evidence.run.id),
      evidence.run.attempt,
    );
    const matches = evidence.artifacts.filter(
      (actual) => actual.id === item.artifact_id || actual.name === name,
    );
    const actual = matches[0];
    if (
      matches.length !== 1 ||
      !actual ||
      actual.id !== item.artifact_id ||
      actual.name !== name ||
      actual.expired ||
      actual.bytes !== item.bytes ||
      actual.archive_sha256 !== item.sha256
    )
      throw new Error("public build input identity differs from complete provider inventory");
  }
}

export function requireStablePublicBuildInputEvidence(
  rawBinding: unknown,
  before: Evidence,
  after: Evidence,
) {
  const binding = inspectPublicBuildInputBinding(rawBinding);
  requirePublicBuildInputProviderBinding(binding, before);
  requirePublicBuildInputProviderBinding(binding, after);
  if (
    !isDeepStrictEqual(before.run, after.run) ||
    binding.artifacts.some(
      (item) =>
        !isDeepStrictEqual(
          before.artifacts.find((a) => a.id === item.artifact_id),
          after.artifacts.find((a) => a.id === item.artifact_id),
        ),
    )
  )
    throw new Error("public build input provider evidence changed during collection");
}

/** Verify PUBLIC configuration provenance only. No compiler/package-content,
 * semantic acceptance, signing, publication or execution claim is established.
 * The caller obtains evidence using the existing source/tree/workflow collector
 * and brackets this call with fresh provider readback. */
export async function verifyReleasePublicBuildInputs(
  privateRoot: string,
  rawBinding: unknown,
  evidence: Evidence,
  options: { download?: typeof readGitHubArtifactArchive | undefined } = {},
) {
  const binding = inspectPublicBuildInputBinding(structuredClone(rawBinding));
  evidence = structuredClone(evidence);
  requirePublicBuildInputProviderBinding(binding, evidence);
  const directory = await mkdtemp(path.join(path.resolve(privateRoot), "public-build-provenance-"));
  let phase = "download";
  try {
    const receipts = [];
    for (const item of binding.artifacts) {
      const received = (options.download ?? readGitHubArtifactArchive)(
        `repos/boburning/portcove/actions/artifacts/${item.artifact_id}/zip`,
        { cwd: directory, maxBytes: item.bytes, timeoutMs: 120000 },
      );
      if (
        !Buffer.isBuffer(received) ||
        received.length !== item.bytes ||
        digest(received) !== item.sha256
      )
        throw new Error("public build archive length or digest differs");
      const archive = Buffer.from(received);
      await writeFile(path.join(directory, `${item.platform}.zip`), archive, {
        flag: "wx",
        mode: 0o600,
      });
      phase = "raw-zip-preflight";
      const { entries } = inspectBoundedZip(archive, {
        compressedBytes: maximumArchiveBytes,
        expandedBytes: maximumExpandedBytes,
        files: members.size,
        nameBytes: 64,
        allowedPaths: new Set(members.keys()),
      });
      if (
        entries.length !== members.size ||
        entries.some((entry) => entry.bytes < 1 || entry.bytes > members.get(entry.name)!)
      )
        throw new Error("public build archive member inventory or bound differs");
      // Every structural entry and represented size passed before any inflate or
      // extraction write. ZIP64, links, extra members and extensions are refused.
      phase = "bounded-members";
      const decoded = new Map<string, Buffer>();
      for (const entry of entries) {
        const compressed = archive.subarray(entry.data, entry.dataEnd);
        const bytes =
          entry.method === 0
            ? Buffer.from(compressed)
            : inflateRawSync(compressed, { maxOutputLength: entry.bytes });
        if (bytes.length !== entry.bytes || crc32(bytes) !== entry.crc)
          throw new Error("public build archive member bytes differ");
        decoded.set(entry.name, bytes);
      }
      const configurationRoot = path.join(directory, item.platform, "input");
      await mkdir(configurationRoot, { recursive: true });
      for (const name of ["root.json", "bundle.json", "updater-public.key", "packaging.json"])
        await writeFile(path.join(configurationRoot, name), decoded.get(name)!, {
          flag: "wx",
          mode: 0o600,
        });
      phase = "ratified-public-inputs";
      // Reconstruct the expected public recipe/receipt from independently pinned
      // bytes. This is not an observation of the compiler's checkout or process.
      const prepared = await prepareReleasePublicBuildInputs({
        configurationRoot,
        outputRoot: path.join(directory, item.platform, "verified"),
        observedRevision: binding.configuration_revision,
        expectedRevision: binding.configuration_revision,
        expectedManifestSha256: binding.manifest_sha256,
      });
      const generated = await readFile(
        prepared.environment.PORTCOVE_RELEASE_PUBLIC_TAURI_CONFIGURATION,
      );
      if (
        !generated.equals(decoded.get("tauri.release-public.conf.json")!) ||
        !isDeepStrictEqual(
          JSON.parse(decoded.get("build-inputs.json")!.toString("utf8")),
          prepared.receipt,
        )
      )
        throw new Error("public build generated configuration or receipt differs");
      receipts.push({ platform: item.platform, ...prepared.receipt });
    }
    return {
      directory,
      binding,
      receipts,
      evidence_scope: options.download ? "injected-provider" : "github.com",
      scope:
        "public configuration bytes and archive provenance only; no compiler-content or execution claim",
      authority: "none",
    };
  } catch {
    const retained = { directory, phase, binding, authority: "none" };
    await writeFile(path.join(directory, "failure.json"), JSON.stringify(retained), {
      flag: "wx",
      mode: 0o600,
    }).catch(() => {});
    throw new CoordinatorRemoteError(
      "public build input provenance refused; retain owned evidence",
      retained,
    );
  }
}
