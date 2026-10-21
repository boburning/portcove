import { requireActualCandidatePhaseAdvance } from "./release-candidate-progress.mts";
import { materializePublicationUpdaterRoots } from "./release-publication-inputs.mts";
import { inspectTrustedAssemblyInput } from "./trusted-release-assembly.mts";
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { open, mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { performance } from "node:perf_hooks";
import { isRecord } from "./runtime-values.mts";
import {
  requireRetainedPublishCandidate,
  candidateHasRetainedPromotion,
} from "./release-candidate-progress-contract.mts";
import { capacityDigest, inspectCapacityOperation } from "./release-capacity.mts";
import { CoordinatorRemoteError } from "./release-coordinator-errors.mts";
import {
  requireReservedAggregate,
  inspectAggregateDescriptor,
  requireReservedPublicationCompletion,
} from "./production-aggregate-steps.mts";
import {
  verifyAdmittedUploadedAggregate as verifyUploadedAggregate,
  stageAggregatePackages,
} from "./trusted-aggregate-attestation.mts";
import { artifactName } from "./release-package-policy.mts";
import { classifyApplicationVersion } from "../apps/desktop/scripts/release-version-policy.mts";
import { assertOwnedUnlinkedPath } from "./release-path-safety.mts";
import { releaseSbomName } from "./finalize-release-assets.mts";
import {
  materializeReleaseQualificationSource,
  finalizeQualifiedReleaseCandidate,
} from "./release-candidate-qualification.mts";
import { parseReleaseChecksumManifest } from "./reconcile-release-assets.mts";
import { prepareReleasePublicBuildInputs } from "./release-public-build-inputs.mts";
import { verifyUpdaterInventory } from "./updater-artifact-inventory.mts";
import { GitHubApiClient, GitHubApiError, createGitHubRunner } from "./github-api.mts";
import type { GitHubRestReader } from "./github-api.mts";
import {
  requireActualReleaseAdmissionContext,
  requireActualPublicationControllerContext,
} from "./acquire-release-admission.mts";
import {
  capacityExecutorIdentity,
  executeOwnedCapacityEffect,
  refreshCapacityExecutor,
} from "./release-capacity-executor.mts";
import type { authenticateCapacityExecutor } from "./release-capacity-executor.mts";
import { recoverReleaseOpportunity } from "./release-coordinator-state.mts";
import {
  readRemoteCoordinatorSnapshot,
  hydrateRetainedCoordinatorOperation,
} from "./release-coordinator-recovery.mts";
import { inspectCompactCapacityOperations } from "./release-capacity.mts";
import { requireNativeReleaseQualificationPair } from "./release-native-admission.mts";
import { requireVerifiedReleaseSbomDocument } from "./release-acceptance-evidence.mts";
import { inspectCoordinatorRemoteNamespace } from "./release-coordinator-remote.mts";
import { requireAuthenticatedReleaseControlSource } from "./release-live-control-admission.mts";
import type { AuthenticatedReleaseControlSource } from "./release-live-control-admission.mts";
import {
  withCoordinatorDeadline,
  coordinatorCommandTimeout,
  checkCoordinatorDeadline,
} from "./release-coordinator-deadline.mts";
import { verifiedControllerToolPaths } from "./release-controller-tool-admission.mts";
import { readControllerToolFile } from "./release-controller-tools.mts";

const repository = "boburning/portcove";
const base = `repos/${repository}`;
const sha = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
function publicationRemaining(deadline: number | undefined, maximum = 15000) {
  if (deadline !== undefined && !Number.isFinite(deadline))
    throw new Error("immutable publication phase deadline exhausted");
  const timeout =
    deadline === undefined ? maximum : Math.floor(Math.min(maximum, deadline - performance.now()));
  if (timeout < 1) throw new Error("immutable publication phase deadline exhausted");
  return timeout;
}
const run = promisify(execFile);
const prepared = new WeakMap<
  object,
  { session: PreparedReleasePublication; descriptor: string; checkpoint: string }
>();
const active = new WeakSet<object>();
const completionOnlySessions = new WeakSet<object>();
const publicationAdmissions = new WeakMap<object, object>();
const ownedCompletions = new WeakMap<
  object,
  {
    session: PreparedReleasePublication;
    admission: object;
    checkpoint: string;
    operation: NonNullable<ReturnType<typeof inspectCapacityOperation>>;
    readback: ReturnType<typeof verifyPreparedImmutableRelease>;
    candidate: Record<string, unknown>;
    namespace: string;
    executor: ReturnType<typeof capacityExecutorIdentity>;
    executor_receipt: Awaited<ReturnType<typeof authenticateCapacityExecutor>>;
    controls: AuthenticatedReleaseControlSource;
    deadline?: number;
  }
>();
const project = fileURLToPath(new URL("..", import.meta.url));
export interface ReleaseAsset {
  filename: string;
  bytes: number;
  sha256: string;
}
export interface ReleasePublicationIdentity {
  version: string;
  source_commit: string;
  assets: ReleaseAsset[];
}
export type ImmutableReleaseEffect = { destination: string; tag: string } & (
  | {
      kind: "create-draft";
      method: "POST";
      endpoint: string;
      body: {
        tag_name: string;
        target_commitish: string;
        name: string;
        draft: true;
        prerelease: boolean;
        make_latest: "false";
      };
    }
  | {
      kind: "upload-asset";
      method: "POST";
      endpoint: string;
      release_id: number;
      asset: ReleaseAsset;
    }
  | {
      kind: "publish-draft";
      method: "PATCH";
      endpoint: string;
      release_id: number;
      asset_set_sha256: string;
      body: { draft: false; make_latest: "false" };
    }
);
function expectedIdentity(raw: ReleasePublicationIdentity) {
  const input = structuredClone(raw);
  const version = classifyApplicationVersion(input.version).version;
  if (
    !/^[a-f0-9]{40}$/u.test(input.source_commit) ||
    !Array.isArray(input.assets) ||
    input.assets.length < 1 ||
    input.assets.length > 32 ||
    new Set(input.assets.map((a) => a.filename.toLowerCase())).size !== input.assets.length ||
    input.assets.some(
      (a) =>
        !/^[A-Za-z0-9][A-Za-z0-9._+-]{0,200}$/u.test(a.filename) ||
        !Number.isSafeInteger(a.bytes) ||
        a.bytes < 1 ||
        a.bytes > 512 * 1024 * 1024 ||
        !/^[a-f0-9]{64}$/u.test(a.sha256),
    ) ||
    input.assets.reduce((n, a) => n + a.bytes, 0) > 2 * 1024 * 1024 * 1024
  )
    throw new Error("immutable release requires the complete bounded fixed asset inventory");
  return {
    ...input,
    version,
    assets: input.assets.sort((a, b) => a.filename.localeCompare(b.filename)),
  };
}
function release(
  raw: unknown,
  wanted: Pick<ReturnType<typeof expectedIdentity>, "version" | "source_commit">,
) {
  const version = classifyApplicationVersion(wanted.version);
  if (
    !isRecord(raw) ||
    !Number.isSafeInteger(raw.id) ||
    Number(raw.id) < 1 ||
    raw.tag_name !== `v${wanted.version}` ||
    raw.target_commitish !== wanted.source_commit ||
    raw.prerelease !== version.github_prerelease ||
    typeof raw.draft !== "boolean" ||
    typeof raw.immutable !== "boolean" ||
    raw.url !== `https://api.github.com/${base}/releases/${String(raw.id)}` ||
    !(
      raw.html_url === `https://github.com/${repository}/releases/tag/v${wanted.version}` ||
      (raw.draft === true &&
        typeof raw.html_url === "string" &&
        new RegExp(
          `^https://github\\.com/${repository}/releases/tag/untagged-[A-Za-z0-9_-]+$`,
          "u",
        ).test(raw.html_url))
    ) ||
    raw.upload_url !==
      `https://uploads.github.com/${base}/releases/${String(raw.id)}/assets{?name,label}`
  )
    throw new Error("release provider identity differs from the existing reserved candidate");
  return { id: Number(raw.id), draft: raw.draft, immutable: raw.immutable };
}
function assets(
  raw: unknown,
  expected: ReleaseAsset[],
  releaseId: number,
  version: string,
  draft = false,
) {
  if (!Array.isArray(raw) || raw.length > expected.length)
    throw new Error("release asset inventory is incomplete or contains unexpected content");
  const ids = new Set<number>(),
    names = new Set<string>();
  return raw
    .map((a: unknown) => {
      if (
        !isRecord(a) ||
        !Number.isSafeInteger(a.id) ||
        Number(a.id) < 1 ||
        typeof a.name !== "string" ||
        ids.has(Number(a.id)) ||
        names.has(a.name.toLowerCase())
      )
        throw new Error("release asset inventory duplicates or omits identity");
      const expectedAsset = expected.find((entry) => entry.filename === a.name);
      if (
        !expectedAsset ||
        a.state !== "uploaded" ||
        a.size !== expectedAsset.bytes ||
        a.digest !== `sha256:${expectedAsset.sha256}` ||
        a.url !== `https://api.github.com/${base}/releases/assets/${String(a.id)}` ||
        !(
          a.browser_download_url ===
            `https://github.com/${repository}/releases/download/v${version}/${expectedAsset.filename}` ||
          (draft &&
            typeof a.browser_download_url === "string" &&
            a.browser_download_url.startsWith(
              `https://github.com/${repository}/releases/download/untagged-`,
            ) &&
            a.browser_download_url.endsWith(`/${expectedAsset.filename}`) &&
            a.browser_download_url
              .slice(`https://github.com/${repository}/releases/download/`.length)
              .split("/").length === 2)
        )
      )
        throw new Error(
          "release asset bytes/state/public identity differ; preserve partial effects",
        );
      ids.add(Number(a.id));
      names.add(a.name.toLowerCase());
      return {
        id: Number(a.id),
        release_id: releaseId,
        ...expectedAsset,
        download_url: a.browser_download_url,
      };
    })
    .sort((a, b) => a.filename.localeCompare(b.filename));
}

/** Data-only transition proposal. This does not authenticate its inputs, supply
 * capacity/exclusivity/semantic acceptance, or authorize a write. The executable
 * adapter below additionally requires its private prepared session and delegates
 * every single effect to the existing caller-owned pending-intent executor. */
export function proposeImmutableReleaseTransition(
  rawExpected: ReleasePublicationIdentity,
  rawRelease: unknown,
  rawAssets: unknown,
) {
  const wanted = expectedIdentity(rawExpected);
  if (rawRelease === null) {
    if (!Array.isArray(rawAssets) || rawAssets.length)
      throw new Error("absent release cannot own assets");
    return {
      decision: "effect" as const,
      effect: {
        kind: "create-draft" as const,
        tag: `v${wanted.version}`,
        destination: `github-release:${repository}:v${wanted.version}:create-draft`,
        method: "POST" as const,
        endpoint: `${base}/releases`,
        body: {
          tag_name: `v${wanted.version}`,
          target_commitish: wanted.source_commit,
          name: `v${wanted.version}`,
          draft: true as const,
          prerelease: classifyApplicationVersion(wanted.version).github_prerelease,
          make_latest: "false" as const,
        },
      },
    };
  }
  const observed = release(rawRelease, wanted);
  const existing = assets(rawAssets, wanted.assets, observed.id, wanted.version, observed.draft);
  const missing = wanted.assets.filter((a) => !existing.some((r) => r.filename === a.filename));
  if (!observed.draft) {
    if (!observed.immutable || missing.length)
      throw new Error("published release is not observed immutable with complete assets");
    return {
      decision: "complete" as const,
      release_id: observed.id,
      immutable: true as const,
      assets: existing,
      authority: "none",
    };
  }
  if (observed.immutable)
    throw new Error(
      "provider draft/immutable state contradicts the supported publication contract",
    );
  if (missing.length) {
    const asset = missing[0]!;
    return {
      decision: "effect" as const,
      effect: {
        kind: "upload-asset" as const,
        tag: `v${wanted.version}`,
        destination: `github-release:${repository}:v${wanted.version}:upload:${asset.filename}`,
        method: "POST" as const,
        endpoint: `https://uploads.github.com/${base}/releases/${observed.id}/assets?name=${encodeURIComponent(asset.filename)}`,
        release_id: observed.id,
        asset,
      },
    };
  }
  return {
    decision: "effect" as const,
    effect: {
      kind: "publish-draft" as const,
      tag: `v${wanted.version}`,
      destination: `github-release:${repository}:v${wanted.version}:publish`,
      asset_set_sha256: capacityDigest(wanted.assets),
      method: "PATCH" as const,
      endpoint: `${base}/releases/${observed.id}`,
      release_id: observed.id,
      body: { draft: false as const, make_latest: "false" as const },
    },
  };
}

async function boundedBytes(filename: string, maximum: number, qualifiedTool = false) {
  const handle = await open(
    filename,
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
  );
  try {
    const before = await handle.stat();
    if (
      !before.isFile() ||
      (!qualifiedTool && before.nlink !== 1) ||
      before.size < 1 ||
      before.size > maximum
    )
      throw new Error("publication input is not a bounded single-link file");
    const buffer = Buffer.alloc(before.size + 1);
    let length = 0;
    while (length < buffer.length) {
      const result = await handle.read(buffer, length, buffer.length - length, null);
      if (!result.bytesRead) break;
      length += result.bytesRead;
    }
    const after = await handle.stat();
    if (
      length !== before.size ||
      ["size", "dev", "ino", "nlink", "mtimeMs", "ctimeMs"].some(
        (key) => before[key as keyof typeof before] !== after[key as keyof typeof after],
      )
    )
      throw new Error("publication input changed during bounded read");
    return buffer.subarray(0, length);
  } finally {
    await handle.close();
  }
}
/** Actual reservation/aggregate/public-input/signature/finalization preparation.
 * No injected verification backend or accepted Boolean. The signed aggregate
 * proves its own scope only. Independent native/semantic/SBOM authorization and
 * fresh capacity/protection/exclusive executor remain the caller's live gates. */
export async function prepareImmutableReleasePublication(
  request: {
    private_root: string;
    qualification_parent: string;
    descriptor: string;
    aggregate: Parameters<typeof verifyUploadedAggregate>[1];
    public_configuration_root: string;
    updater_roots: { platform: "windows-x86_64" | "linux-x86_64"; directory: string }[];
    sbom: string;
    verifier: string;
    verifier_sha256: string;
  },
  recover: () => Promise<unknown>,
  qualificationReadToken: string,
  controller?: {
    tools: object;
    context: object;
    facts: unknown;
    source_repository: string;
    deadline: number;
    admission?: object;
  },
) {
  const completionContext = controller?.admission;
  const readbackOnly =
    completionContext !== undefined &&
    requireActualPublicationControllerContext(completionContext).mode === "completion-only";
  const requireReservation = (descriptor: string, state: unknown) =>
    readbackOnly
      ? requireReservedPublicationCompletion(descriptor, state, completionContext)
      : requireReservedAggregate(descriptor, state);
  request = structuredClone(request);
  if (
    !path.isAbsolute(request.private_root) ||
    !path.isAbsolute(request.qualification_parent) ||
    !/^[a-f0-9]{64}$/u.test(request.verifier_sha256)
  )
    throw new Error("publication preparation requires owned storage and exact verifier identity");
  await assertOwnedUnlinkedPath(project, request.private_root, "publication private root");
  const directory = await mkdtemp(path.join(request.private_root, "immutable-release-"));
  let phase = "reservation-before";
  try {
    const before = await recover();
    const retainedPromotion =
      isRecord(before) &&
      isRecord(before.input) &&
      candidateHasRetainedPromotion(before.input.active_candidate);
    const { descriptor, accepted } = await requireReservation(request.descriptor, before);
    if (
      accepted.release_profile !== "initial-beta-win-linux" ||
      !accepted.public_build_inputs ||
      capacityDigest(request.aggregate.candidate) !== capacityDigest(descriptor.assembly) ||
      !Array.isArray(descriptor.archives) ||
      capacityDigest(request.aggregate.candidate_artifact_ids) !==
        capacityDigest(
          descriptor.archives.map((a: unknown) => {
            if (!isRecord(a)) throw new Error("reservation artifact identity unavailable");
            return a.artifact_id;
          }),
        )
    )
      throw new Error("publication aggregate must match the exact reserved beta descriptor");
    phase = "actual-uploaded-aggregate-verification";
    const aggregate = await verifyUploadedAggregate(directory, request.aggregate);
    phase = "verified-aggregate-package-materialization";
    // Consume the archive retained by the actual provider/Sigstore verifier.
    // A separate caller-selected package directory is neither necessary nor a
    // custody proof. Every output remains inert until the maintained finalizer.
    const packageRoot = path.join(directory, "packages");
    await stageAggregatePackages(
      packageRoot,
      await boundedBytes(
        path.join(aggregate.acquisition_directory, "input", "aggregate.zip"),
        512 * 1024 * 1024,
      ),
      accepted,
      request.aggregate.sha256,
    );
    phase = "fixed-public-inputs";
    const pin = accepted.public_build_inputs;
    const publicInputs = await prepareReleasePublicBuildInputs({
      configurationRoot: request.public_configuration_root,
      outputRoot: directory,
      observedRevision: pin.configuration_revision,
      expectedRevision: pin.configuration_revision,
      expectedManifestSha256: pin.manifest_sha256,
    });
    phase = "keyless-signature-verifier";
    const executable = await boundedBytes(request.verifier, 128 * 1024 * 1024, true);
    if (sha(executable) !== request.verifier_sha256)
      throw new Error("qualified payload verifier differs");
    const verifier = path.join(directory, process.platform === "win32" ? "verify.exe" : "verify");
    await writeFile(verifier, executable, { mode: 0o700, flag: "wx" });
    const key = path.join(publicInputs.output, "updater-public.key");
    if (controller && request.updater_roots.length)
      throw new Error("actual publication context cannot mix supplied signer roots");
    const updaterRoots = [
      ...(controller
        ? await materializePublicationUpdaterRoots(
            controller.context,
            controller.facts,
            packageRoot,
            directory,
            await boundedBytes(key, 16384),
            controller.deadline,
          )
        : request.updater_roots),
    ].sort((a, b) => a.platform.localeCompare(b.platform));
    if (
      updaterRoots.length !== 2 ||
      updaterRoots[0]?.platform !== "linux-x86_64" ||
      updaterRoots[1]?.platform !== "windows-x86_64"
    )
      throw new Error("both selected updater signer outputs are required");
    const signatures: { filename: string; bytes: Buffer }[] = [];
    for (const root of updaterRoots) {
      await assertOwnedUnlinkedPath(request.private_root, root.directory, "signed updater output");
      const inventory = await verifyUpdaterInventory({
        projectRoot: project,
        label: root.platform,
        input: root.directory,
        publicKey: key,
        version: accepted.version,
        revision: accepted.source_commit,
        verifySignature: async (_verifier, artifact, signature, publicKey, identity) => {
          const { stdout } = await run(
            verifier,
            ["verify", artifact, signature, publicKey, identity.sha256, String(identity.bytes)],
            {
              cwd: directory,
              timeout: coordinatorCommandTimeout(120000),
              maxBuffer: 64 * 1024,
              windowsHide: true,
              env: {
                PATH:
                  process.platform === "win32"
                    ? `${process.env.SystemRoot}/System32`
                    : "/usr/bin:/bin",
                SystemRoot: process.env.SystemRoot,
                HOME: directory,
                TEMP: directory,
                TMP: directory,
                TMPDIR: directory,
              },
            },
          );
          checkCoordinatorDeadline();
          const result: unknown = JSON.parse(stdout);
          if (
            !isRecord(result) ||
            result.schema_version !== 1 ||
            result.signature_verified !== true ||
            result.sha256 !== identity.sha256 ||
            result.bytes !== identity.bytes ||
            typeof result.public_key_sha256 !== "string" ||
            !/^[a-f0-9]{64}$/u.test(result.public_key_sha256)
          )
            throw new Error("actual payload verifier returned another identity");
          return result.public_key_sha256;
        },
      });
      for (const pkg of inventory.packages) {
        const frozen = accepted.files.find(
          (file) => file.platform_label === root.platform && file.filename === pkg.filename,
        );
        if (!frozen || frozen.bytes !== pkg.bytes || frozen.sha256 !== pkg.sha256)
          throw new Error("signed updater package differs from the verified reserved aggregate");
      }
      const signatureBytes = await boundedBytes(
        path.join(root.directory, inventory.updater.signature.filename),
        64 * 1024,
      );
      if (
        signatureBytes.length !== inventory.updater.signature.bytes ||
        sha(signatureBytes) !== inventory.updater.signature.sha256
      )
        throw new Error("verified updater signature changed before finalization");
      signatures.push({
        filename: inventory.updater.signature.filename,
        bytes: signatureBytes,
      });
    }
    phase = "finalized-package-and-SBOM-inventory";
    // Policy comes from the fixed checkout. The temporary project root is owned
    // storage for the maintained finalizer/inventory helpers, never candidate code.
    const { policy } = await inspectTrustedAssemblyInput(accepted);
    const assetsRoot = path.join(directory, "assets");
    await mkdir(assetsRoot);
    const packages = [];
    for (const definition of policy.packages) {
      const filename = artifactName(definition, accepted.version);
      const frozen = accepted.files.find((file) => file.filename === filename)!;
      await assertOwnedUnlinkedPath(
        request.private_root,
        path.join(packageRoot, filename),
        "release package",
      );
      const bytes = await boundedBytes(path.join(packageRoot, filename), 512 * 1024 * 1024);
      if (bytes.length !== frozen.bytes || sha(bytes) !== frozen.sha256)
        throw new Error("final package differs from verified aggregate");
      await writeFile(path.join(assetsRoot, filename), bytes, { flag: "wx", mode: 0o600 });
      packages.push({ filename, bytes: bytes.length, sha256: sha(bytes) });
    }
    await assertOwnedUnlinkedPath(request.private_root, request.sbom, "final public SBOM");
    await writeFile(
      path.join(assetsRoot, releaseSbomName),
      await boundedBytes(request.sbom, 16 * 1024 * 1024),
      { flag: "wx", mode: 0o600 },
    );
    const inventoryFile = path.join(directory, "inventory.json");
    await writeFile(
      inventoryFile,
      JSON.stringify({
        schema_version: 1,
        repository,
        version: accepted.version,
        tag: `v${accepted.version}`,
        checksum_manifest: policy.checksum_manifest,
        packages,
        workflow_producers: updaterRoots.map((p) => ({
          platform_label: p.platform,
          revision: accepted.source_commit,
        })),
      }),
      { flag: "wx", mode: 0o600 },
    );
    await writeFile(
      path.join(assetsRoot, policy.checksum_manifest),
      packages.map((p) => `${p.sha256}  ${p.filename}\n`).join(""),
      { flag: "wx", mode: 0o600 },
    );
    phase = "exact-prepared-source-qualification";
    const qualification = await materializeReleaseQualificationSource(
      controller?.source_repository ?? project,
      request.qualification_parent,
      accepted.source_commit,
      accepted.source_tree,
    );
    const fixedTools = controller ? await verifiedControllerToolPaths(controller.tools) : null;
    const finalizerEntry = fixedTools
      ? path.join(fixedTools.root, "scripts/release-publication-controller.bundle.mjs")
      : null;
    const finalized = finalizeQualifiedReleaseCandidate(
      {
        qualification_root: qualification.root,
        prepared_commit: accepted.source_commit,
        version: accepted.version,
        assets: assetsRoot,
        inventory: inventoryFile,
        sbom_subjects: path.join(directory, "sbom-subjects.txt"),
      },
      qualificationReadToken,
      fixedTools && finalizerEntry
        ? {
            node: fixedTools.node,
            entry: finalizerEntry,
            sha256: sha(await readControllerToolFile(finalizerEntry, 32 * 1024 ** 2)),
          }
        : undefined,
    );
    for (const stream of ["stdout", "stderr"] as const)
      await writeFile(
        path.join(directory, `source-qualification.${stream}.log`),
        finalized[stream] ?? "",
        { flag: "wx", mode: 0o600 },
      );
    if (finalized.error || finalized.status !== 0 || finalized.signal)
      throw new Error("maintained exact-source Linux/SBOM finalization refused");
    const files = [...packages];
    const sbomBytes = await boundedBytes(path.join(assetsRoot, releaseSbomName), 16 * 1024 * 1024);
    files.push({ filename: releaseSbomName, bytes: sbomBytes.length, sha256: sha(sbomBytes) });
    for (const signature of signatures) {
      await writeFile(path.join(assetsRoot, signature.filename), signature.bytes, {
        flag: "wx",
        mode: 0o600,
      });
      files.push({
        filename: signature.filename,
        bytes: signature.bytes.length,
        sha256: sha(signature.bytes),
      });
    }
    files.sort((a, b) => a.filename.localeCompare(b.filename));
    const manifest = Buffer.from(files.map((f) => `${f.sha256}  ${f.filename}\n`).join(""));
    parseReleaseChecksumManifest(manifest.toString("utf8"), "final signed release");
    await writeFile(path.join(assetsRoot, policy.checksum_manifest), manifest);
    files.push({
      filename: policy.checksum_manifest,
      bytes: manifest.length,
      sha256: sha(manifest),
    });
    phase = "reservation-after";
    await requireReservation(request.descriptor, await recover());
    const session = Object.freeze({
      identity: expectedIdentity({
        version: accepted.version,
        source_commit: accepted.source_commit,
        assets: files,
      }),
      directory,
      assetsRoot,
      descriptor: request.descriptor,
      aggregate,
      public_inputs: publicInputs.receipt,
      verifier_sha256: request.verifier_sha256,
      qualification,
      payload_signatures: "actual keyless verification against pinned public key",
      signer_job_provenance: "not-evaluated; caller must bind actual immutable signer outputs",
      checkpoint: descriptor.checkpoint,
      authority: "none",
      release_authorization: "not-evaluated",
    });
    if (sha(await boundedBytes(verifier, 128 * 1024 * 1024)) !== request.verifier_sha256)
      throw new Error("payload verification executable changed");
    prepared.set(session, {
      session: structuredClone(session),
      descriptor: session.descriptor,
      checkpoint: session.checkpoint,
    });
    if (readbackOnly || retainedPromotion) {
      completionOnlySessions.add(session);
    }
    if (completionContext !== undefined) {
      publicationAdmissions.set(session, completionContext);
    }
    return session;
  } catch {
    const evidence = { directory, phase, authority: "none", automatic_retry: false };
    await writeFile(path.join(directory, "preparation-refusal.json"), JSON.stringify(evidence), {
      flag: "wx",
      mode: 0o600,
    }).catch(() => {});
    throw new CoordinatorRemoteError(
      "immutable release preparation refused; retain owned inputs",
      evidence,
    );
  }
}
export type PreparedReleasePublication = Awaited<
  ReturnType<typeof prepareImmutableReleasePublication>
>;

/** The actual phase writer is the only way to move an already prepared session
 * from its original admitted building checkpoint to publishing. An updated hash
 * or copied phase receipt cannot rebind this session or its admission lineage. */
export async function rebindPreparedImmutableReleaseAfterPhase(
  session: PreparedReleasePublication,
  phaseReceipt: object,
  deadline?: number,
) {
  const work = async () => {
    publicationRemaining(deadline);
    const state = prepared.get(session);
    if (!state || active.has(session))
      throw new Error("actual idle immutable preparation required");
    const phase = await requireActualCandidatePhaseAdvance(phaseReceipt, "publishing");
    const context = requireActualReleaseAdmissionContext(
      phase.original_context,
      "release-publication",
    );
    const descriptor = inspectAggregateDescriptor(state.descriptor);
    const priorContext = publicationAdmissions.get(session);
    if (
      (priorContext && priorContext !== phase.original_context) ||
      state.checkpoint !== phase.previous_checkpoint ||
      context.checkpoint !== phase.previous_checkpoint ||
      state.session.identity.source_commit !== phase.candidate.prepared_commit ||
      state.session.identity.version !== phase.candidate.version ||
      capacityDigest(descriptor.assembly) !== capacityDigest(context.facts.assembly) ||
      capacityDigest(descriptor.archives) !== capacityDigest(context.facts.archives) ||
      phase.repository !== context.coordinator_repository
    )
      throw new Error("phase handoff differs from original immutable preparation/admission");
    const nextDescriptor = JSON.stringify({ ...descriptor, checkpoint: phase.checkpoint });
    const current = await recoverReleaseOpportunity(phase.repository, phase.checkpoint);
    await requireReservedAggregate(nextDescriptor, current);
    if (capacityDigest(current.input.active_candidate) !== capacityDigest(phase.candidate))
      throw new Error("phase handoff candidate changed before immutable session binding");
    await requireActualCandidatePhaseAdvance(phaseReceipt, "publishing");
    publicationRemaining(deadline);
    state.descriptor = nextDescriptor;
    state.checkpoint = phase.checkpoint;
    publicationAdmissions.set(session, phase.original_context);
    return Object.freeze({
      checkpoint: phase.checkpoint,
      previous_checkpoint: phase.previous_checkpoint,
      scope: "same-process publishing phase handoff only",
      authority: "none",
    });
  };
  return deadline === undefined ? work() : withCoordinatorDeadline(deadline, work);
}

/** Read-only feed prerequisite. Obtain the expected complete asset inventory from
 * the actual private preparation, not a caller's release receipt. This performs
 * no publication and does not clear the independent acceptance gates. */
export function verifyPreparedImmutableRelease(
  session: PreparedReleasePublication,
  candidate: unknown,
  deadline?: number,
) {
  const privateValue = prepared.get(session);
  if (!privateValue || !isRecord(candidate))
    throw new Error("actual immutable Release preparation and current candidate required");
  const identity = privateValue.session.identity;
  if (
    candidate.prepared_commit !== identity.source_commit ||
    candidate.version !== identity.version
  )
    throw new Error("immutable Release preparation differs from the current reservation");
  const remaining = () => {
    if (deadline !== undefined && !Number.isFinite(deadline))
      throw new Error("immutable Release readback phase deadline exhausted");
    const timeoutMs =
      deadline === undefined ? 15000 : Math.floor(Math.min(15000, deadline - performance.now()));
    if (timeoutMs < 1) throw new Error("immutable Release readback phase deadline exhausted");
    return timeoutMs;
  };
  remaining();
  const api = new GitHubApiClient((args, body) => {
    const result = createGitHubRunner({
      cwd: privateValue.session.directory,
      timeoutMs: remaining(),
      maxBuffer: 2 * 1024 * 1024,
    })([...args, "--hostname", "github.com"], body);
    remaining();
    return result;
  });
  const actual = readImmutableReleaseState(api, identity);
  const transition = proposeImmutableReleaseTransition(identity, actual.release, actual.assets);
  if (transition.decision !== "complete")
    throw new Error("feed publication requires the complete observed immutable Release");
  return {
    ...transition,
    source_commit: identity.source_commit,
    version: identity.version,
    evidence_scope: "github.com" as const,
    evidence_sha256: capacityDigest(actual),
  };
}

/** Complete release inventory includes drafts; a published-only tag lookup can
 * hide a retained draft after an ambiguous create. Embedded assets are ignored. */
export function readImmutableReleaseState(
  api: GitHubRestReader,
  identity: ReleasePublicationIdentity,
) {
  const wanted = expectedIdentity(identity);
  return readImmutableReleaseCustodyState(api, {
    version: wanted.version,
    source_commit: wanted.source_commit,
    asset_names: wanted.assets.map((asset) => asset.filename),
  });
}

/** Raw GET custody only. A complete-byte identity remains mandatory for all
 * transition/effect and publication consumers. No placeholder lengths/hashes
 * are manufactured when an authenticated context omits a document length. */
export function readImmutableReleaseCustodyState(
  api: GitHubRestReader,
  rawIdentity: { version: string; source_commit: string; asset_names: readonly string[] },
) {
  const wanted = structuredClone(rawIdentity);
  if (
    Object.keys(wanted).sort().join(",") !== "asset_names,source_commit,version" ||
    !/^[a-f0-9]{40}$/u.test(wanted.source_commit) ||
    !Array.isArray(wanted.asset_names) ||
    wanted.asset_names.length < 1 ||
    wanted.asset_names.length > 32 ||
    wanted.asset_names.some(
      (name) => typeof name !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._+-]{0,200}$/u.test(name),
    ) ||
    new Set(wanted.asset_names.map((name: string) => name.toLowerCase())).size !==
      wanted.asset_names.length
  )
    throw new Error("bounded immutable Release custody identity required");
  wanted.version = classifyApplicationVersion(wanted.version).version;
  const all: Record<string, unknown>[] = [];
  for (let page = 1; page <= 16; page++) {
    const response = api.request("GET", `${base}/releases?per_page=100&page=${page}`);
    if (response.status !== 200 || !Array.isArray(response.body) || response.body.length > 100)
      throw new Error("release inventory unavailable");
    for (const item of response.body as unknown[]) {
      if (
        !isRecord(item) ||
        !Number.isSafeInteger(item.id) ||
        Number(item.id) < 1 ||
        all.some((r) => r.id === item.id)
      )
        throw new Error("release inventory duplicates or omits provider identity");
      all.push(item);
    }
    if (response.body.length < 100) break;
    if (page === 16) throw new Error("release inventory pagination bound exhausted");
  }
  const found = all.filter((r) => r.tag_name === `v${wanted.version}`);
  if (found.length > 1) throw new Error("reserved tag has multiple release identities");
  let tag: ReturnType<GitHubRestReader["request"]>;
  try {
    tag = api.request("GET", `${base}/git/ref/tags/${encodeURIComponent(`v${wanted.version}`)}`);
  } catch (error) {
    // The real gh runner throws on HTTP errors. Only the exact tag GET's
    // collected 404 is absence; authentication/refusal/timeout remains unknown.
    // Complete authenticated Release inventory above is still mandatory.
    if (!(error instanceof GitHubApiError) || error.status !== 404) throw error;
    tag = { status: 404, body: null, headers: new Map() };
  }
  let tagCommit: string | null = null;
  if (tag.status !== 404) {
    if (
      tag.status !== 200 ||
      !isRecord(tag.body) ||
      tag.body.ref !== `refs/tags/v${wanted.version}`
    )
      throw new Error("release tag readback unavailable");
    let target: unknown = tag.body.object;
    for (let depth = 0; depth < 4; depth++) {
      if (
        !isRecord(target) ||
        typeof target.sha !== "string" ||
        !/^[a-f0-9]{40}$/u.test(target.sha)
      )
        throw new Error("release tag target incomplete");
      if (target.type === "commit") {
        tagCommit = target.sha;
        break;
      }
      if (target.type !== "tag") throw new Error("release tag target is not a commit");
      const annotated = api.request("GET", `${base}/git/tags/${target.sha}`);
      if (
        annotated.status !== 200 ||
        !isRecord(annotated.body) ||
        annotated.body.sha !== target.sha
      )
        throw new Error("annotated release tag readback unavailable");
      target = annotated.body.object;
    }
    if (tagCommit !== wanted.source_commit)
      throw new Error("existing version tag differs; never move it");
  }
  const raw = found[0];
  if (!raw) return { release: null, assets: [], tag_commit: tagCommit };
  const current = release(raw, wanted);
  if (!current.draft && tagCommit !== wanted.source_commit)
    throw new Error("published release lacks the exact actual version tag");
  const collected: unknown[] = [];
  for (let page = 1; page <= 2; page++) {
    const result = api.request(
      "GET",
      `${base}/releases/${current.id}/assets?per_page=100&page=${page}`,
    );
    if (result.status !== 200 || !Array.isArray(result.body) || result.body.length > 100)
      throw new Error("complete release asset readback unavailable");
    collected.push(...(result.body as unknown[]));
    if (collected.length > wanted.asset_names.length)
      throw new Error("unexpected release assets; preserve and reconcile");
    if (result.body.length < 100) {
      const detail = api.request("GET", `${base}/releases/${current.id}`);
      if (
        detail.status !== 200 ||
        capacityDigest(release(detail.body, wanted)) !== capacityDigest(current)
      )
        throw new Error("release identity changed during asset readback");
      return { release: raw, assets: collected, tag_commit: tagCommit };
    }
  }
  throw new Error("release asset readback exceeds bounded inventory");
}

/** Fixed REST operation, invoked ONLY inside the caller's admitted existing
 * executor/pending-intent callback. No journal, retry, token discovery or CLI. */
export async function performImmutableReleaseEffect(
  effect: ImmutableReleaseEffect,
  assetBytes: Buffer | null,
  token: string,
  fetcher: typeof fetch = fetch,
  deadline?: number,
) {
  publicationRemaining(deadline);
  if (!token || token.length > 16384)
    throw new Error("isolated publication credential unavailable");
  const upload = effect.kind === "upload-asset";
  const version = classifyApplicationVersion(effect.tag.slice(1)).version;
  if (
    effect.tag !== `v${version}` ||
    effect.destination !==
      (effect.kind === "create-draft"
        ? `github-release:${repository}:${effect.tag}:create-draft`
        : effect.kind === "upload-asset"
          ? `github-release:${repository}:${effect.tag}:upload:${effect.asset.filename}`
          : `github-release:${repository}:${effect.tag}:publish`)
  )
    throw new Error("release effect destination differs from the exact fixed operation");
  if (
    effect.kind === "create-draft" &&
    (Object.keys(effect.body).sort().join(",") !==
      "draft,make_latest,name,prerelease,tag_name,target_commitish" ||
      !/^[a-f0-9]{40}$/u.test(effect.body.target_commitish) ||
      effect.body.tag_name !== effect.tag ||
      effect.body.tag_name !==
        `v${classifyApplicationVersion(effect.body.tag_name.slice(1)).version}` ||
      effect.body.name !== effect.body.tag_name ||
      effect.body.make_latest !== "false" ||
      effect.body.prerelease !==
        classifyApplicationVersion(effect.body.tag_name.slice(1)).github_prerelease)
  )
    throw new Error("draft creation body differs from fixed release semantics");
  if (
    effect.kind === "publish-draft" &&
    (!/^[a-f0-9]{64}$/u.test(effect.asset_set_sha256) ||
      !Number.isSafeInteger(effect.release_id) ||
      effect.release_id < 1 ||
      Object.keys(effect.body).sort().join(",") !== "draft,make_latest" ||
      effect.body.make_latest !== "false")
  )
    throw new Error(
      "publication cannot rename a tag, replace assets or change other release fields",
    );
  const endpoint = upload ? effect.endpoint : `https://api.github.com/${effect.endpoint}`;
  if (
    upload
      ? effect.method !== "POST" ||
        !Number.isSafeInteger(effect.release_id) ||
        effect.release_id < 1 ||
        endpoint !==
          `https://uploads.github.com/${base}/releases/${effect.release_id}/assets?name=${encodeURIComponent(effect.asset.filename)}` ||
        !assetBytes ||
        assetBytes.length !== effect.asset.bytes ||
        sha(assetBytes) !== effect.asset.sha256
      : !(
          (effect.kind === "create-draft" &&
            effect.endpoint === `${base}/releases` &&
            effect.method === "POST" &&
            effect.body.draft === true) ||
          (effect.kind === "publish-draft" &&
            effect.endpoint === `${base}/releases/${effect.release_id}` &&
            effect.method === "PATCH" &&
            effect.body.draft === false)
        )
  )
    throw new Error("release operation escaped the fixed create/upload/publish boundary");
  const response = await fetcher(endpoint, {
    method: effect.method,
    redirect: "error",
    credentials: "omit",
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2026-03-10",
      "Content-Type": upload ? "application/octet-stream" : "application/json",
    },
    body: upload ? new Uint8Array(assetBytes!) : JSON.stringify(effect.body),
    signal: AbortSignal.timeout(publicationRemaining(deadline, 120000)),
  });
  // A non-success response can still have caused a partial remote effect.
  await response.body?.cancel();
  publicationRemaining(deadline);
  if (response.status !== (effect.kind === "publish-draft" ? 200 : 201))
    throw new Error("release write response requires exact readback/recovery");
  return { status: response.status }; // never trust the mutation response as settlement
}

/** Data validation only; the caller must recover this exact remote checkpoint. */
export function inspectImmutableReleaseSettlement(
  raw: unknown,
  expected: {
    checkpoint: string;
    operation_id: string;
    before_checkpoint: string;
    candidate: unknown;
    destination: string;
    remote_identity: string;
    evidence_sha256: string;
  },
) {
  if (
    !isRecord(raw) ||
    raw.checkpoint !== expected.checkpoint ||
    !isRecord(raw.input) ||
    !isRecord(raw.input.controller) ||
    !isRecord(raw.input.controller.capacity_attempt) ||
    !isRecord(expected.candidate)
  )
    throw new Error("exact settled checkpoint missing");
  const operation = inspectCapacityOperation(raw.input.controller.capacity_attempt.operation);
  const candidate = Object.fromEntries(
    ["prepared_commit", "source_commit", "version", "transient_retries", "substantive_repairs"].map(
      (key) => [
        key,
        expected.candidate && isRecord(expected.candidate) ? expected.candidate[key] : undefined,
      ],
    ),
  );
  if (
    !operation ||
    operation.id !== expected.operation_id ||
    operation.kind !== "upload" ||
    operation.destination !== expected.destination ||
    operation.before_checkpoint !== expected.before_checkpoint ||
    capacityDigest(operation.candidate) !== capacityDigest(candidate) ||
    operation.outcome !== "recovered" ||
    !isRecord(operation.recovery) ||
    operation.recovery.resolution !== "effect-completed" ||
    operation.recovery.evidence_sha256 !== expected.evidence_sha256 ||
    operation.completed_effects.length !== 1 ||
    operation.completed_effects[0]?.remote_identity !== expected.remote_identity ||
    operation.completed_effects[0]?.evidence_sha256 !== expected.evidence_sha256
  )
    throw new Error("executor settlement differs from the actual recovered capacity intent");
  return operation;
}

export async function advanceImmutableReleasePublication(
  session: PreparedReleasePublication,
  options: {
    recover: (checkpoint?: string) => Promise<unknown>;
    // The existing executor owns durable intent, fresh controls, spending boundary,
    // operation allowance and exclusive write/readback ownership. A document saying
    // enabled:true is not an authenticated immutability-setting observation.
    effect: (
      effect: ImmutableReleaseEffect & { effect_request_sha256: string },
      operation: () => Promise<{ remote_identity: string; evidence_sha256: string }>,
    ) => Promise<{ checkpoint: string; operation_id: string; evidence_sha256: string }>;
    api?: GitHubRestReader;
    token: string;
    fetch?: typeof fetch;
    deadline?: number;
  },
) {
  const sessionKey = session;
  publicationRemaining(options.deadline);
  const state = prepared.get(sessionKey);
  if (!state || active.has(sessionKey) || completionOnlySessions.has(sessionKey))
    throw new Error("actual release preparation is required; imported receipts cannot execute");
  session = state.session;
  active.add(sessionKey);
  try {
    const api =
      options.api ??
      new GitHubApiClient((args, input) => {
        const result = createGitHubRunner({
          cwd: session.directory,
          maxBuffer: 512 * 1024,
          timeoutMs: publicationRemaining(options.deadline),
        })([...args, "--hostname", "github.com"], input);
        publicationRemaining(options.deadline);
        return result;
      });
    const reservedState = await options.recover(state.checkpoint);
    publicationRemaining(options.deadline);
    await requireReservedAggregate(state.descriptor, reservedState);
    if (!isRecord(reservedState) || !isRecord(reservedState.input))
      throw new Error("reserved input missing");
    const candidate = reservedState.input.active_candidate;
    const before = readImmutableReleaseState(api, session.identity);
    publicationRemaining(options.deadline);
    const next = proposeImmutableReleaseTransition(session.identity, before.release, before.assets);
    if (next.decision === "complete")
      return {
        ...next,
        evidence_scope: options.api || options.fetch ? "injected-provider" : "github.com",
      };
    const effect = {
      ...structuredClone(next.effect),
      effect_request_sha256: capacityDigest({ checkpoint: state.checkpoint, effect: next.effect }),
    };
    if (effect.kind === "upload-asset") Object.freeze(effect.asset);
    else Object.freeze(effect.body);
    Object.freeze(effect);
    const body =
      effect.kind === "upload-asset"
        ? await boundedBytes(
            path.join(session.assetsRoot, effect.asset.filename),
            effect.asset.bytes,
          )
        : null;
    let started = false;
    const invocationCheckpoint = state.checkpoint;
    let knownSettlementCheckpoint: string | null = null;
    try {
      let evidenceSha256: string | null = null;
      let remoteIdentity: string | null = null;
      let observed: ReturnType<typeof readImmutableReleaseState> | null = null;
      const settlement = await options.effect(effect, async () => {
        if (started) throw new Error("a release effect may execute only once");
        publicationRemaining(options.deadline);
        started = true;
        await performImmutableReleaseEffect(
          effect,
          body,
          options.token,
          options.fetch,
          options.deadline,
        );
        const after = readImmutableReleaseState(api, session.identity);
        publicationRemaining(options.deadline);
        const nextAfter = proposeImmutableReleaseTransition(
          session.identity,
          after.release,
          after.assets,
        );
        if (!isRecord(after.release)) throw new Error("release effect readback is absent");
        if (effect.kind !== "create-draft" && after.release.id !== effect.release_id)
          throw new Error("release effect readback changed the exact provider release ID");
        const beforeAssets = assets(
          before.assets,
          session.identity.assets,
          Number(after.release.id),
          session.identity.version,
          isRecord(before.release) && before.release.draft === true,
        );
        const afterAssets = assets(
          after.assets,
          session.identity.assets,
          Number(after.release.id),
          session.identity.version,
          after.release.draft === true,
        );
        if (
          beforeAssets.some(
            (old) =>
              !afterAssets.some(
                (fresh) =>
                  fresh.id === old.id &&
                  fresh.filename === old.filename &&
                  fresh.bytes === old.bytes &&
                  fresh.sha256 === old.sha256,
              ),
          )
        )
          throw new Error("existing release asset identities changed");
        if (
          (effect.kind === "create-draft" &&
            (after.release.draft !== true || afterAssets.length !== 0)) ||
          (effect.kind === "upload-asset" &&
            !afterAssets.some((a) => a.filename === effect.asset.filename)) ||
          (effect.kind === "publish-draft" && nextAfter.decision !== "complete")
        )
          throw new Error("release effect is not confirmed by exact readback");
        const providerEvidence = {
          effect,
          identity: session.identity,
          release: release(after.release, expectedIdentity(session.identity)),
          assets: afterAssets,
          tag_commit: after.tag_commit,
        };
        evidenceSha256 = capacityDigest(providerEvidence);
        await writeFile(
          path.join(session.directory, `release-readback-${effect.effect_request_sha256}.json`),
          JSON.stringify(providerEvidence),
          { flag: "wx", mode: 0o600 },
        );
        observed = after;
        remoteIdentity =
          effect.kind === "upload-asset"
            ? `github-release:${repository}:release:${String(after.release.id)}:asset:${afterAssets.find((a) => a.filename === effect.asset.filename)!.id}:${effect.asset.sha256}`
            : `github-release:${repository}:release:${String(after.release.id)}:${effect.kind === "publish-draft" ? "immutable" : "draft"}:${capacityDigest(afterAssets)}`;
        return { remote_identity: remoteIdentity, evidence_sha256: evidenceSha256 };
      });
      if (
        !started ||
        !observed ||
        !evidenceSha256 ||
        !/^[a-f0-9]{64}$/u.test(settlement.operation_id) ||
        settlement.evidence_sha256 !== evidenceSha256 ||
        !/^[a-f0-9]{40}$/u.test(settlement.checkpoint)
      )
        throw new Error("executor did not return the exact confirmed settlement receipt");
      knownSettlementCheckpoint = settlement.checkpoint;
      const nextDescriptor = JSON.stringify({
        ...inspectAggregateDescriptor(state.descriptor),
        checkpoint: settlement.checkpoint,
      });
      const settledState = await options.recover(settlement.checkpoint);
      inspectImmutableReleaseSettlement(settledState, {
        checkpoint: settlement.checkpoint,
        operation_id: settlement.operation_id,
        before_checkpoint: state.checkpoint,
        candidate,
        destination: effect.destination,
        remote_identity: remoteIdentity!,
        evidence_sha256: evidenceSha256,
      });
      await requireReservedAggregate(nextDescriptor, settledState);
      state.descriptor = nextDescriptor;
      state.checkpoint = settlement.checkpoint;
      publicationRemaining(options.deadline);
      return {
        decision: "effect-observed" as const,
        effect,
        observed,
        settlement,
        authority: "none",
        automatic_continue: false,
        evidence_scope: options.api || options.fetch ? "injected-provider" : "github.com",
      };
    } catch {
      // No second operation. Caller persists this ambiguity in its existing intent
      // and must explicitly recover/read back before constructing another session.
      prepared.delete(sessionKey);
      throw new CoordinatorRemoteError(
        "release effect ambiguous or refused; use existing recovery before any later effect",
        {
          directory: session.directory,
          before_checkpoint: invocationCheckpoint,
          known_settled_checkpoint: knownSettlementCheckpoint,
          effect,
          outcome: started ? "ambiguous" : "refused-before-effect",
          automatic_retry: false,
          authority: "none",
        },
      );
    }
  } finally {
    active.delete(sessionKey);
  }
}

/** One next logical Release effect under actual publication-stage admission.
 * A signing-stage context, verified aggregate, supplied token or copied receipt
 * cannot authorize this path. A fixed caller obtains a fresh control round for
 * each distinct next effect; this function never retries a refused effect. */
export async function advanceOwnedImmutableReleasePublication(
  session: PreparedReleasePublication,
  executor: Awaited<ReturnType<typeof authenticateCapacityExecutor>>,
  admissionContext: object,
  controls: AuthenticatedReleaseControlSource,
  raw: { repository: string; remote_configuration: unknown },
  deadline?: number,
) {
  publicationRemaining(deadline);
  const admission = requireActualReleaseAdmissionContext(admissionContext, "release-publication");
  const state = prepared.get(session);
  if (!state) throw new Error("actual privately prepared Release publication required");
  const input = structuredClone(raw);
  if (
    Object.keys(input).sort().join(",") !== "remote_configuration,repository" ||
    !path.isAbsolute(input.repository) ||
    !isRecord(admission.facts.configuration) ||
    inspectCoordinatorRemoteNamespace(input.remote_configuration) !==
      admission.facts.configuration.namespace
  )
    throw new Error("publication destination differs from actual admitted namespace");
  const descriptor = inspectAggregateDescriptor(state.descriptor);
  const priorContext = publicationAdmissions.get(session);
  if (
    (priorContext && priorContext !== admissionContext) ||
    (!priorContext && state.checkpoint !== admission.checkpoint) ||
    capacityDigest(descriptor.assembly) !== capacityDigest(admission.facts.assembly) ||
    capacityDigest(descriptor.archives) !== capacityDigest(admission.facts.archives)
  )
    throw new Error("publication preparation differs from its actual accepted candidate");
  requireAuthenticatedReleaseControlSource(controls, "release-publication");
  if (controls.evidence_scope !== "github.com")
    throw new Error("actual publication controls required");
  const identity = capacityExecutorIdentity(executor);
  const original = admission.admission.controls;
  if (
    identity.role !== "release-publication" ||
    !original ||
    identity.controller_revision !== original.reader.controller_revision ||
    identity.execution_ref !== original.reader.controller_ref ||
    identity.run_id !== String(original.reader.run_id) ||
    identity.run_attempt !== original.reader.run_attempt ||
    identity.job_id !== original.reader.job_id ||
    String(identity.check_run_id) !== String(original.reader.check_run_id)
  )
    throw new Error("publication executor is not the actual admitted reader job");
  const token = process.env.PORTCOVE_RELEASE_PUBLICATION_TOKEN;
  if (!token || token.length > 16384 || /\s/u.test(token))
    throw new Error("dedicated Release publication credential unavailable");
  const api = new GitHubApiClient((args, body) => {
    const result = createGitHubRunner({
      cwd: state.session.directory,
      timeoutMs: publicationRemaining(deadline),
      maxBuffer: 2 * 1024 * 1024,
    })([...args, "--hostname", "github.com"], body);
    publicationRemaining(deadline);
    return result;
  });
  const readBoundary = async () => {
    publicationRemaining(deadline);
    requireAuthenticatedReleaseControlSource(controls, "release-publication");
    const current = controls.read(api, admission.facts.opportunity);
    publicationRemaining(deadline);
    if (
      current.reader.job_id !== identity.job_id ||
      current.reader.controller_revision !== identity.controller_revision ||
      current.reader.controller_ref !== identity.execution_ref ||
      String(current.reader.run_id) !== identity.run_id ||
      current.reader.run_attempt !== identity.run_attempt ||
      current.pause.publication_paused ||
      !current.resource_policy_matches_controller ||
      current.protection.release_immutability?.enabled !== true ||
      capacityDigest(current.classification) !== capacityDigest(original.classification) ||
      capacityDigest(current.pause) !== capacityDigest(original.pause) ||
      capacityDigest(current.capacity) !== capacityDigest(original.capacity) ||
      !isRecord(current.capacity_source.capacity)
    )
      throw new Error("fresh admitted publication controls changed or remain held");
    return structuredClone(current.capacity_source.capacity.boundary);
  };
  await readBoundary();
  publicationAdmissions.set(session, admissionContext);
  return advanceImmutableReleasePublication(session, {
    ...(deadline === undefined ? {} : { deadline }),
    recover: (checkpoint) =>
      recoverReleaseOpportunity(input.repository, checkpoint ?? state.checkpoint),
    token,
    effect: (effect, operation) =>
      executeOwnedCapacityEffect(
        executor,
        {
          repository: input.repository,
          checkpoint: state.checkpoint,
          remote_configuration: input.remote_configuration,
          request: { kind: "upload", destination: effect.destination },
        },
        readBoundary,
        async () => {
          await refreshCapacityExecutor(executor);
          await readBoundary();
          return operation();
        },
      ),
  });
}

/** Actual publisher continuation, never an imported success or release-presence
 * shortcut. The existing actual admission/executor and the original settled
 * publish operation must all agree before this observation can enter custody.
 * This performs GET/readback only; an unresolved publish must first use the
 * existing exclusive capacity recovery process. */
export async function observeOwnedImmutableReleaseCompletion(
  session: PreparedReleasePublication,
  executor: Awaited<ReturnType<typeof authenticateCapacityExecutor>>,
  admissionContext: object,
  controls: AuthenticatedReleaseControlSource,
  deadline?: number,
) {
  publicationRemaining(deadline);
  const state = prepared.get(session);
  const observationContext = requireActualPublicationControllerContext(admissionContext);
  const admission = observationContext.context;
  if (!state || publicationAdmissions.get(session) !== admissionContext)
    throw new Error("actual owned publisher continuation required before completion");
  const identity = await refreshCapacityExecutor(executor);
  const reader = admission.admission.controls?.reader;
  if (
    !reader ||
    identity.role !== "release-publication" ||
    identity.job_id !== reader.job_id ||
    String(identity.check_run_id) !== String(reader.check_run_id) ||
    identity.controller_revision !== reader.controller_revision ||
    identity.execution_ref !== reader.controller_ref ||
    identity.run_id !== String(reader.run_id) ||
    identity.run_attempt !== reader.run_attempt ||
    !isRecord(admission.facts.configuration) ||
    typeof admission.facts.configuration.namespace !== "string"
  )
    throw new Error("completion requires the actual admitted fixed publisher job");
  await requireNativeReleaseQualificationPair(
    admission.native_qualifications,
    admission.facts.assembly,
    admission.facts.archives,
    "release-publication",
  );
  await requireVerifiedReleaseSbomDocument(admission.sbom_receipt);
  requireAuthenticatedReleaseControlSource(controls, "release-publication");
  const api = new GitHubApiClient((args, input) => {
    const result = createGitHubRunner({
      cwd: state.session.directory,
      timeoutMs: publicationRemaining(deadline),
      maxBuffer: 2 * 1024 * 1024,
    })([...args, "--hostname", "github.com"], input);
    publicationRemaining(deadline);
    return result;
  });
  const fresh = () => {
    const current = controls.read(api, admission.facts.opportunity);
    const original = admission.admission.controls!;
    if (
      current.reader.job_id !== identity.job_id ||
      current.reader.controller_revision !== identity.controller_revision ||
      current.reader.controller_ref !== identity.execution_ref ||
      String(current.reader.run_id) !== identity.run_id ||
      current.reader.run_attempt !== identity.run_attempt ||
      current.pause.publication_paused ||
      !current.resource_policy_matches_controller ||
      current.protection.release_immutability?.enabled !== true ||
      capacityDigest(current.classification) !== capacityDigest(original.classification) ||
      capacityDigest(current.pause) !== capacityDigest(original.pause) ||
      capacityDigest(current.capacity) !== capacityDigest(original.capacity)
    )
      throw new Error("owned publication completion controls changed or remain held");
    publicationRemaining(deadline);
  };
  fresh();
  const namespace = admission.facts.configuration.namespace;
  const snapshot = await readRemoteCoordinatorSnapshot(
    state.session.directory,
    { schema_version: 1, namespace },
    {
      transport: { cwd: state.session.directory, ...(deadline === undefined ? {} : { deadline }) },
    },
  );
  if (snapshot.checkpoint !== state.checkpoint)
    throw new Error(
      "immutable publisher settlement checkpoint changed; reconcile before completion",
    );
  if (observationContext.mode === "completion-only")
    await requireReservedPublicationCompletion(state.descriptor, snapshot, admissionContext);
  else await requireReservedAggregate(state.descriptor, snapshot);
  const candidate = snapshot.input.active_candidate;
  const controller = snapshot.input.controller;
  let operation =
    isRecord(controller) && isRecord(controller.capacity_attempt)
      ? inspectCapacityOperation(controller.capacity_attempt.operation)
      : null;
  const retainedPromotion = candidateHasRetainedPromotion(candidate);
  if (observationContext.mode === "completion-only" || retainedPromotion) {
    if (operation && !["succeeded", "recovered"].includes(operation.outcome))
      throw new Error(
        "latest publisher effect unresolved; recover exact effect before readback continuation",
      );
    const destination = `github-release:${repository}:v${state.session.identity.version}:publish`;
    if (operation?.destination !== destination) {
      const capacity =
        isRecord(controller) && isRecord(controller.capacity_attempt)
          ? controller.capacity_attempt
          : null;
      const groups =
        capacity?.schema_version === 2
          ? inspectCompactCapacityOperations(capacity.prior_operations)
          : [];
      const matching = groups.filter(
        (group) =>
          group.completed &&
          group.kind === "upload" &&
          group.destination_sha256 === capacityDigest(destination) &&
          group.subject.kind === "candidate" &&
          isRecord(candidate) &&
          group.subject.identity === candidate.prepared_commit,
      );
      if (matching.length !== 1)
        throw new Error("original settled publisher receipt missing or ambiguous");
      const attempts = [];
      for (const proof of matching[0]!.attempts) {
        const raw = await hydrateRetainedCoordinatorOperation(
          admission.coordinator_repository,
          proof,
        );
        if (
          raw?.outcome === "recovered" &&
          isRecord(raw.recovery) &&
          raw.recovery.resolution === "effect-completed"
        )
          attempts.push(raw);
      }
      if (attempts.length !== 1) throw new Error("original immutable publish settlement ambiguous");
      operation = attempts[0]!;
    }
  }
  const readback = verifyPreparedImmutableRelease(session, candidate, deadline);
  const effect = operation?.completed_effects[0];
  const original = operation?.executor_identity;
  if (
    !isRecord(candidate) ||
    !operation ||
    operation.kind !== "upload" ||
    operation.destination !==
      `github-release:${repository}:v${state.session.identity.version}:publish` ||
    operation.outcome !== "recovered" ||
    !isRecord(operation.recovery) ||
    operation.recovery.resolution !== "effect-completed" ||
    operation.completed_effects.length !== 1 ||
    !effect ||
    effect.evidence_sha256 !== operation.recovery.evidence_sha256 ||
    effect.remote_identity !==
      `github-release:${repository}:release:${readback.release_id}:immutable:${capacityDigest(readback.assets)}` ||
    !original ||
    original.role !== "release-publication" ||
    original.controller_revision !== identity.controller_revision ||
    original.execution_ref !== identity.execution_ref ||
    original.workflow !== identity.workflow ||
    original.actor_id !== identity.actor_id ||
    original.run_attempt !== 1
  )
    throw new Error("immutable Release lacks its exact settled owned publish operation");
  requireRetainedPublishCandidate(candidate, operation, readback);
  if (original.job_id !== identity.job_id || original.run_id !== identity.run_id) {
    const response = api.request("GET", `${base}/actions/jobs/${String(original.job_id)}`);
    const job = response.body;
    publicationRemaining(deadline);
    if (
      response.status !== 200 ||
      !isRecord(job) ||
      job.id !== original.job_id ||
      String(job.run_id) !== original.run_id ||
      job.run_attempt !== original.run_attempt ||
      job.head_sha !== original.controller_revision ||
      job.name !== "Publish immutable application release" ||
      job.status !== "completed" ||
      job.check_run_url !==
        `https://api.github.com/${base}/check-runs/${String(original.check_run_id)}`
    )
      throw new Error("original publisher is not positively terminal; preserve prior effect");
  }
  const after = await readRemoteCoordinatorSnapshot(
    state.session.directory,
    { schema_version: 1, namespace },
    {
      transport: { cwd: state.session.directory, ...(deadline === undefined ? {} : { deadline }) },
    },
  );
  if (after.checkpoint !== snapshot.checkpoint)
    throw new Error("publisher settlement changed during independent completion readback");
  fresh();
  publicationRemaining(deadline);
  const receipt = Object.freeze({
    kind: "actual-owned-immutable-release-completion",
    authority: "none",
  });
  ownedCompletions.set(receipt, {
    session,
    admission: admissionContext,
    checkpoint: snapshot.checkpoint,
    operation: structuredClone(operation),
    readback: structuredClone(readback),
    candidate: structuredClone(candidate),
    namespace,
    executor: identity,
    executor_receipt: executor,
    controls,
    ...(deadline === undefined ? {} : { deadline }),
  });
  return receipt;
}

/** Retained settled-publication custody, not current admission or a phase lease.
 * Consumers still need their actual job identity, current controls/reservation
 * and exact attested record-set binding before any later external effect. */
export async function requireOwnedImmutableReleaseCompletion(receipt: object) {
  const retained = ownedCompletions.get(receipt);
  if (!retained) throw new Error("actual owned immutable Release completion custody required");
  publicationRemaining(retained.deadline);
  const admission = requireActualPublicationControllerContext(retained.admission).context;
  const executor = await refreshCapacityExecutor(retained.executor_receipt);
  if (capacityDigest(executor) !== capacityDigest(retained.executor))
    throw new Error("owned completion executor changed");
  await requireNativeReleaseQualificationPair(
    admission.native_qualifications,
    admission.facts.assembly,
    admission.facts.archives,
    "release-publication",
  );
  await requireVerifiedReleaseSbomDocument(admission.sbom_receipt);
  const readback = verifyPreparedImmutableRelease(
    retained.session,
    retained.candidate,
    retained.deadline,
  );
  if (
    readback.release_id !== retained.readback.release_id ||
    capacityDigest(readback.assets) !== capacityDigest(retained.readback.assets)
  )
    throw new Error("owned immutable Release identity changed after completion custody");
  return Object.freeze({
    checkpoint: retained.checkpoint,
    original_context: retained.admission,
    repository: admission.coordinator_repository,
    namespace: retained.namespace,
    candidate: structuredClone(retained.candidate),
    operation: structuredClone(retained.operation),
    release: readback,
    executor: structuredClone(retained.executor),
    admission,
    controls: retained.controls,
    executor_receipt: retained.executor_receipt,
    authority: "none" as const,
    scope: "actual settled immutable publication; later eligibility remains separate",
  });
}
