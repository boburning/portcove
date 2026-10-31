import {
  inspectPublicBuildConfiguration,
  inspectPublicBuildInputBinding,
  maximumArchiveBytes,
} from "./release-public-build-binding-contract.mts";
export {
  inspectPublicBuildConfiguration,
  inspectPublicBuildInputBinding,
} from "./release-public-build-binding-contract.mts";
import { nativePlatformsForReleaseProfile } from "./release-package-policy.mts";
import { createHash } from "node:crypto";
import { crc32, inflateRawSync } from "node:zlib";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import { inspectBoundedZip } from "./bounded-zip.mts";
import { readGitHubArtifactArchive } from "./github-binary.mts";
import { releaseBuildArtifactName } from "./release-package-policy.mts";
import {
  prepareReleasePublicBuildInputs,
  readBoundedPublicBuildInputFile,
} from "./release-public-build-inputs.mts";
import type { collectReleaseRunEvidence } from "./release-run-evidence.mts";
import { CoordinatorRemoteError } from "./release-coordinator-errors.mts";

type Evidence = ReturnType<typeof collectReleaseRunEvidence>;
const maximumExpandedBytes = 512 * 1024;
const members = new Map([
  ["root.json", 256 * 1024],
  ["bundle.json", 16 * 1024],
  ["updater-public.key", 16 * 1024],
  ["packaging.json", 16 * 1024],
  ["tauri.release-public.conf.json", 64 * 1024],
  ["build-inputs.json", 16 * 1024],
]);
const verifiedPublicInputs = new WeakMap<
  object,
  {
    snapshot: string;
    release_profile: "initial-beta-win-linux" | "initial-beta-windows-x86_64-v1";
    directory: string;
    artifacts: { platform: string; bytes: number; sha256: string }[];
  }
>();
function decodePublicBuildInputArchive(archive: Buffer, structuralPassed?: () => void) {
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
  structuralPassed?.();
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
  return decoded;
}

/** Reacquire actual public root/key/config bytes from the privately authenticated
 * opaque archives, never trust mutable extracted files or a serialized recipe. */
export async function readVerifiedReleasePublicBuildInputFiles(receipt: object) {
  await requireVerifiedReleasePublicBuildInputs(receipt);
  const retained = verifiedPublicInputs.get(receipt);
  if (!retained) throw new Error("actual public input custody missing");
  let common: Map<string, Buffer> | undefined;
  for (const artifact of retained.artifacts) {
    const archive = await readBoundedPublicBuildInputFile(
      retained.directory,
      `${artifact.platform}.zip`,
      artifact.bytes,
    );
    if (archive.length !== artifact.bytes || digest(archive) !== artifact.sha256)
      throw new Error("actual public input archive changed during readback");
    const decoded = decodePublicBuildInputArchive(archive);
    const selected = new Map(
      ["root.json", "bundle.json", "updater-public.key", "packaging.json"].map((name) => [
        name,
        Buffer.from(decoded.get(name)!),
      ]),
    );
    if (common && [...selected].some(([name, bytes]) => !bytes.equals(common!.get(name)!)))
      throw new Error("actual public input roots/configuration differ across platforms");
    common = selected;
  }
  if (
    !common ||
    retained.artifacts.length !== nativePlatformsForReleaseProfile(retained.release_profile).length
  )
    throw new Error("actual complete public input matrix missing");
  return common;
}
/** Later acceptance consumers must retain the actual default-provider result,
 * not import a serialized public recipe or a fixture's successful parser result. */
export async function requireVerifiedReleasePublicBuildInputs(receipt: object) {
  const retained = verifiedPublicInputs.get(receipt);
  if (!retained || digest(Buffer.from(JSON.stringify(receipt))) !== retained.snapshot)
    throw new Error("actual same-process public build input verification required");
  for (const artifact of retained.artifacts) {
    const bytes = await readBoundedPublicBuildInputFile(
      retained.directory,
      `${artifact.platform}.zip`,
      artifact.bytes,
    );
    if (bytes.length !== artifact.bytes || digest(bytes) !== artifact.sha256)
      throw new Error("retained public build input archive changed before use");
  }
}
const digest = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");

export function releasePublicBuildArtifactName(platform: string, runId: string, attempt: number) {
  return releaseBuildArtifactName(platform, runId, attempt).replace(
    "release-build-",
    "release-public-build-inputs-",
  );
}

export type PublicBuildInputBinding = ReturnType<typeof inspectPublicBuildInputBinding>;

export function selectPublicBuildInputBinding(rawConfiguration: unknown, evidence: Evidence) {
  const configuration = inspectPublicBuildConfiguration(rawConfiguration);
  const labels = [
    ...nativePlatformsForReleaseProfile(configuration.release_profile ?? "initial-beta-win-linux"),
  ].sort();
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
    const compilerInputs = [];
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
      // Every structural entry and represented size passed before any inflate or
      // extraction write. ZIP64, links, extra members and extensions are refused.
      const decoded = decodePublicBuildInputArchive(archive, () => {
        phase = "bounded-members";
      });
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
      compilerInputs.push({
        platform: item.platform,
        members: [...decoded.entries()]
          .map(([filename, bytes]) => ({ filename, bytes: bytes.length, sha256: digest(bytes) }))
          .sort((a, b) => a.filename.localeCompare(b.filename)),
      });
    }
    const result = {
      directory,
      binding,
      receipts,
      compiler_inputs: compilerInputs,
      evidence_scope: options.download ? "injected-provider" : "github.com",
      scope:
        "public configuration bytes and archive provenance only; no compiler-content or execution claim",
      authority: "none",
    };
    if (!options.download)
      verifiedPublicInputs.set(result, {
        snapshot: digest(Buffer.from(JSON.stringify(result))),
        release_profile: binding.release_profile ?? "initial-beta-win-linux",
        directory,
        artifacts: binding.artifacts.map(({ platform, bytes, sha256 }) => ({
          platform,
          bytes,
          sha256,
        })),
      });
    return result;
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
