import { createHash } from "node:crypto";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  assembleAuthenticatedApplicationSite,
  isSafeSitePath,
  readComposedSite,
} from "./release-site-composer.mts";
import {
  readPublicApplicationSite,
  readPublicApplicationSiteMarker,
} from "./release-site-readback.mts";
import { createGitHubRunner, GitHubApiClient, sanitizeOperationError } from "./github-api.mts";
import { readGitHubArtifactArchive } from "./github-binary.mts";
import { inspectBoundedZip } from "./bounded-zip.mts";
import { crc32, inflateRawSync } from "node:zlib";
import { isRecord } from "./runtime-values.mts";
import { capacityDigest } from "./release-capacity.mts";
import { recoverReleaseOpportunity } from "./release-coordinator-state.mts";
import { recordPublishedMetadata } from "./release-capacity-operation.mts";
import { publishCoordinatorCheckpoint } from "./release-coordinator-remote.mts";
import {
  capacityExecutorIdentity,
  executeOwnedCapacityEffect,
  refreshCapacityExecutor,
  recoverOwnedPublishedMetadata,
} from "./release-capacity-executor.mts";
import type { authenticateCapacityExecutor } from "./release-capacity-executor.mts";
import { createPagesProviderTransport } from "./release-pages-provider.mts";
import { requireAuthenticatedReleaseControlSource } from "./release-live-control-admission.mts";
import type { AuthenticatedReleaseControlSource } from "./release-live-control-admission.mts";
import { performance } from "node:perf_hooks";
import { verifyPreparedImmutableRelease } from "./release-immutable-publication.mts";
import type { PreparedReleasePublication } from "./release-immutable-publication.mts";

const hash = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
const block = 512;
function octal(header: Buffer, start: number, length: number, value: number) {
  const text = value.toString(8).padStart(length - 1, "0");
  if (!Number.isSafeInteger(value) || value < 0 || text.length >= length)
    throw new Error("site tar numeric field exceeds its fixed bound");
  header.write(text, start, length - 1, "ascii");
}
function header(name: string, size: number, type: "0" | "x") {
  if (Buffer.byteLength(name) > 100) throw new Error("site tar header name exceeds bound");
  const output = Buffer.alloc(block);
  output.write(name, 0, 100, "ascii");
  octal(output, 100, 8, 0o644);
  octal(output, 108, 8, 0);
  octal(output, 116, 8, 0);
  octal(output, 124, 12, size);
  octal(output, 136, 12, 0);
  output.fill(0x20, 148, 156);
  output.write(type, 156, 1, "ascii");
  output.write("ustar\0", 257, 6, "ascii");
  output.write("00", 263, 2, "ascii");
  const sum = output.reduce((total, value) => total + value, 0);
  output.write(sum.toString(8).padStart(6, "0"), 148, 6, "ascii");
  output[154] = 0;
  output[155] = 0x20;
  return output;
}
function paxPath(name: string) {
  const body = ` path=${name}\n`;
  let size = body.length + 1;
  while (`${size}${body}`.length !== size) size = `${size}${body}`.length;
  return Buffer.from(`${size}${body}`, "ascii");
}

/** Deterministic format serialization, not admission. Every entry is a regular
 * file; there are no links, owners, executable bits, device nodes or host paths.
 * PAX is used only for a bounded ASCII long path and applies to one next file. */
export function serializeSiteTar(files: ReadonlyMap<string, Buffer>) {
  if (files.size > 6001) throw new Error("site tar entry count exceeds bound");
  const chunks: Buffer[] = [];
  let total = 1024;
  let payloadBytes = 0;
  const append = (name: string, bytes: Buffer, type: "0" | "x") => {
    const padding = (block - (bytes.length % block)) % block;
    total += block + bytes.length + padding;
    if (total > 512 * 1024 ** 2) throw new Error("site tar archive exceeds bound");
    chunks.push(header(name, bytes.length, type), bytes, Buffer.alloc(padding));
  };
  let index = 0;
  for (const [name, raw] of [...files].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
    if (!isSafeSitePath(name) || !Buffer.isBuffer(raw) || raw.length > 64 * 1024 ** 2)
      throw new Error("site tar file path/bytes differ from composition contract");
    payloadBytes += raw.length;
    if (payloadBytes > 256 * 1024 ** 2) throw new Error("site tar content exceeds site bound");
    const bytes = Buffer.from(raw);
    if (name.length > 100) {
      append(`PaxHeaders/${index}`, paxPath(name), "x");
      append(`files/${index}`, bytes, "0");
    } else append(name, bytes, "0");
    index++;
  }
  chunks.push(Buffer.alloc(1024));
  return Buffer.concat(chunks, total);
}

interface DeploymentSession {
  readonly kind: "prepared-application-site-deployment";
}
type Composed = Awaited<ReturnType<typeof assembleAuthenticatedApplicationSite>>;
interface PrivateDeployment {
  generation: Composed["generation"];
  publication: Composed["publication"];
  previous_generation: Composed["generation"] | null;
  prior_public_readback?: { generation: string; evidence_sha256: string };
  archive_sha256: string;
  archive_bytes: number;
  directory: string;
  upload?: {
    artifact_id: number;
    archive_sha256: string;
    evidence_scope: string;
    run_id: number;
    run_attempt: number;
    controller_revision: string;
  };
}
const sessions = new WeakMap<DeploymentSession, PrivateDeployment>();

/** Opaque artifact content verification: no untrusted tar parser or extraction
 * is needed. The only ZIP member must equal the deterministic tar created from
 * actual authenticated composition byte-for-byte. This grants no job authority. */
export function inspectSiteArtifactArchive(
  archive: Buffer,
  expected: { bytes: number; sha256: string },
) {
  if (
    !Number.isSafeInteger(expected.bytes) ||
    expected.bytes < 1024 ||
    expected.bytes > 512 * 1024 ** 2 ||
    !/^[a-f0-9]{64}$/u.test(expected.sha256)
  )
    throw new Error("site archive expected identity unavailable");
  const { entries } = inspectBoundedZip(archive, {
    compressedBytes: 512 * 1024 ** 2,
    expandedBytes: expected.bytes,
    files: 1,
    nameBytes: 32,
    allowedPaths: new Set(["artifact.tar"]),
  });
  const entry = entries[0];
  if (entries.length !== 1 || !entry || entry.bytes !== expected.bytes)
    throw new Error("site upload archive inventory differs");
  const compressed = archive.subarray(entry.data, entry.dataEnd);
  const bytes =
    entry.method === 0
      ? compressed
      : inflateRawSync(compressed, { maxOutputLength: expected.bytes });
  if (
    bytes.length !== expected.bytes ||
    crc32(bytes) !== entry.crc ||
    hash(bytes) !== expected.sha256
  )
    throw new Error("uploaded site tar differs from actual prepared composition");
  return { bytes: bytes.length, sha256: hash(bytes), authority: "none" };
}

interface SiteUploadExpected {
  artifact_id: number;
  run_id: number;
  run_attempt: number;
  controller_revision: string;
}

/** Actual opaque upload association. Provider artifact metadata binds source/run
 * and immutable ID/digest, not its producing job/attempt. The admitted fixed
 * workflow's exclusive upload route and current authenticated executor must
 * establish that additional boundary before any deployment effect. */
export async function verifyUploadedSiteArchive(
  session: DeploymentSession,
  rawExpected: SiteUploadExpected,
  options: {
    api?: Pick<GitHubApiClient, "request">;
    download?: typeof readGitHubArtifactArchive;
  } = {},
) {
  const prepared = sessions.get(session);
  if (!prepared) throw new Error("actual prepared site session unavailable");
  const expected = structuredClone(rawExpected);
  if (
    Object.keys(expected).sort().join(",") !==
      "artifact_id,controller_revision,run_attempt,run_id" ||
    ![expected.artifact_id, expected.run_id, expected.run_attempt].every(
      (value) => Number.isSafeInteger(value) && value > 0,
    ) ||
    !/^[a-f0-9]{40}$/u.test(expected.controller_revision)
  )
    throw new Error("site artifact provider identity unavailable");
  const runner = createGitHubRunner({
    cwd: prepared.directory,
    timeoutMs: 15_000,
    maxBuffer: 128 * 1024,
  });
  const api =
    options.api ??
    new GitHubApiClient((args, input) => runner([...args, "--hostname", "github.com"], input));
  const endpoint = `repos/boburning/portcove/actions/artifacts/${expected.artifact_id}`;
  const identity = () => {
    const response = api.request("GET", endpoint);
    if (response.status !== 200) throw new Error("site artifact provider readback unavailable");
    const value = response.body;
    if (
      !isRecord(value) ||
      value.id !== expected.artifact_id ||
      value.name !== `application-update-site-${expected.run_id}-${expected.run_attempt}` ||
      value.expired !== false ||
      typeof value.digest !== "string" ||
      !/^sha256:[a-f0-9]{64}$/u.test(value.digest) ||
      typeof value.size_in_bytes !== "number" ||
      !Number.isSafeInteger(value.size_in_bytes) ||
      value.size_in_bytes < 22 ||
      value.size_in_bytes > 512 * 1024 ** 2 ||
      !isRecord(value.workflow_run) ||
      value.workflow_run.id !== expected.run_id ||
      value.workflow_run.repository_id !== 1354613114 ||
      value.workflow_run.head_repository_id !== 1354613114 ||
      value.workflow_run.head_sha !== expected.controller_revision
    )
      throw new Error("site artifact metadata differs from the fixed upload route");
    return {
      id: expected.artifact_id,
      name: value.name,
      bytes: value.size_in_bytes,
      sha256: value.digest.slice(7),
    };
  };
  const before = identity();
  const attempt = await mkdtemp(path.join(prepared.directory, "upload-readback-"));
  await writeFile(path.join(attempt, "provider-before.json"), JSON.stringify(before), {
    flag: "wx",
    mode: 0o600,
  });
  try {
    const bytes = (options.download ?? readGitHubArtifactArchive)(`${endpoint}/zip`, {
      cwd: prepared.directory,
      maxBytes: before.bytes,
      timeoutMs: 120_000,
    });
    await writeFile(path.join(attempt, "uploaded.zip"), bytes, { flag: "wx", mode: 0o600 });
    if (bytes.length !== before.bytes || hash(bytes) !== before.sha256)
      throw new Error("site artifact provider archive bytes differ");
    inspectSiteArtifactArchive(bytes, {
      bytes: prepared.archive_bytes,
      sha256: prepared.archive_sha256,
    });
    if (JSON.stringify(before) !== JSON.stringify(identity()))
      throw new Error("site artifact changed during independent download");
    const upload = {
      artifact_id: before.id,
      archive_sha256: before.sha256,
      evidence_scope: options.api || options.download ? "injected-provider" : "github.com",
      run_id: expected.run_id,
      run_attempt: expected.run_attempt,
      controller_revision: expected.controller_revision,
    };
    if (prepared.upload && JSON.stringify(prepared.upload) !== JSON.stringify(upload))
      throw new Error("prepared site cannot switch its uploaded artifact identity");
    prepared.upload = upload;
    const receipt = {
      ...upload,
      generation: prepared.generation.generation,
      tar_sha256: prepared.archive_sha256,
      authority: "none",
      provider_scope:
        "immutable artifact/source/run association; job/attempt requires the fixed exclusive route",
    };
    await writeFile(path.join(attempt, "verification.json"), JSON.stringify(receipt), {
      flag: "wx",
      mode: 0o600,
    });
    return receipt;
  } catch (error) {
    await writeFile(
      path.join(attempt, "failure.json"),
      JSON.stringify({
        stage: "site-upload-readback",
        outcome: "refused",
        error: sanitizeOperationError(error),
        authority: "none",
      }),
      { flag: "wx", mode: 0o600 },
    );
    throw new Error(`uploaded site readback refused; retain ${attempt}`);
  }
}

/** Runs the actual public-only Rust/Tough assembly before materializing the
 * Pages archive. A self-authored marker or serialized success cannot enter this
 * session. Independent controls/executor/provider upload are separate gates. */
export async function prepareSiteDeployment(
  request: Parameters<typeof assembleAuthenticatedApplicationSite>[0],
) {
  request = structuredClone(request);
  const composed = await assembleAuthenticatedApplicationSite(request);
  if (!composed.changed) return { changed: false as const, generation: composed.generation };
  const { files } = await readComposedSite(
    composed.output,
    composed.generation.generation,
    request.trusted_root_sha256,
  );
  const archive = serializeSiteTar(files);
  const directory = await mkdtemp(path.join(request.output_parent, "site-deployment-"));
  await mkdir(path.join(directory, "upload"), { mode: 0o700 });
  const archivePath = path.join(directory, "upload", "artifact.tar");
  await writeFile(archivePath, archive, { flag: "wx", mode: 0o600 });
  const receipt = {
    generation: composed.generation,
    archive_sha256: hash(archive),
    archive_bytes: archive.length,
    directory,
  };
  await writeFile(
    path.join(directory, "preparation.json"),
    JSON.stringify({
      ...receipt,
      authority: "none",
      stage: "actual-TUF-composition-to-Pages-archive",
    }),
    { flag: "wx", mode: 0o600 },
  );
  const session: DeploymentSession = Object.freeze({
    kind: "prepared-application-site-deployment",
  });
  const retained = structuredClone(receipt);
  for (const generation of [retained.generation, receipt.generation]) {
    for (const file of generation.files) Object.freeze(file);
    Object.freeze(generation.files);
    Object.freeze(generation);
  }
  const prior =
    request.previous_site === null
      ? null
      : await readComposedSite(
          request.previous_site,
          request.expected_previous_generation!,
          request.trusted_root_sha256,
        );
  sessions.set(session, {
    ...retained,
    publication: structuredClone(composed.publication),
    previous_generation: prior ? structuredClone(prior.generation) : null,
  });
  return { changed: true as const, session, archive: archivePath, ...receipt, authority: "none" };
}

/** Public readback is necessary after provider completion. This alone cannot
 * settle a remote pending intent or establish who deployed an artifact. */
export async function readBackSiteDeployment(session: DeploymentSession) {
  const prepared = sessions.get(session);
  if (!prepared) throw new Error("imported deployment sessions cannot establish public completion");
  return readPublicApplicationSite(prepared.generation);
}

/** Heavy acquisition precedes the fresh observer handshake. This receipt is
 * private continuation state; a later marker bracket cannot create it. */
export async function verifyPriorPublicSite(session: DeploymentSession) {
  const prepared = sessions.get(session);
  if (!prepared?.previous_generation)
    throw new Error("actual prepared prior site session required");
  const readback = await readPublicApplicationSite(prepared.previous_generation);
  prepared.prior_public_readback = {
    generation: readback.generation,
    evidence_sha256: readback.evidence_sha256,
  };
  await writeFile(
    path.join(prepared.directory, "prior-public-readback.json"),
    JSON.stringify(readback),
    { flag: "wx", mode: 0o600 },
  );
  return structuredClone(readback);
}

/** Connected routine publisher. Initial publication/seed is deliberately a
 * separate consolidated-setup operation; this routine path requires an actual
 * authenticated published generation in the existing journal. It never calls
 * a signing process, installs dependencies or receives a role private key. */
export async function publishPreparedSiteDeployment(
  session: DeploymentSession,
  executor: Awaited<ReturnType<typeof authenticateCapacityExecutor>>,
  controls: AuthenticatedReleaseControlSource,
  raw: {
    repository: string;
    checkpoint: string;
    remote_configuration: unknown;
    metadata_renewal?: unknown;
    recovery?: "transient" | "substantive-repair";
  },
  releaseSession?: PreparedReleasePublication,
) {
  const prepared = sessions.get(session);
  if (!prepared || !prepared.upload || prepared.upload.evidence_scope !== "github.com")
    throw new Error("actual authenticated composition and provider upload session required");
  requireAuthenticatedReleaseControlSource(controls, "site-publication");
  if (controls.evidence_scope !== "github.com" || !prepared.publication)
    throw new Error("actual provider controls and authenticated TUF publication facts required");
  const input = structuredClone(raw);
  const executorIdentity = capacityExecutorIdentity(executor);
  if (
    executorIdentity.role !== "site-publication" ||
    Number(executorIdentity.run_id) !== prepared.upload.run_id ||
    executorIdentity.run_attempt !== prepared.upload.run_attempt ||
    executorIdentity.controller_revision !== prepared.upload.controller_revision
  )
    throw new Error("site artifact is not associated with the actual fixed same-attempt executor");
  const checkpoint = await recoverReleaseOpportunity(input.repository, input.checkpoint);
  const published = checkpoint.input.published_metadata;
  const publication =
    isRecord(published) && isRecord(published.publication) ? published.publication : null;
  if (
    !publication ||
    !prepared.previous_generation ||
    publication.site_generation_sha256 !== prepared.previous_generation.generation ||
    prepared.generation.previous_generation !== prepared.previous_generation.generation ||
    prepared.prior_public_readback?.generation !== prepared.previous_generation.generation
  )
    throw new Error("actual independent prior site generation/initial seed is required");
  const candidate = checkpoint.input.active_candidate;
  const frozen = isRecord(candidate) ? candidate.frozen_opportunity : null;
  if (input.metadata_renewal === undefined && !isRecord(frozen))
    throw new Error("release site requires the existing complete frozen opportunity");
  const readRelease = () => {
    if (input.metadata_renewal !== undefined) return null;
    if (!releaseSession)
      throw new Error("actual immutable Release preparation required before feed publication");
    return verifyPreparedImmutableRelease(releaseSession, candidate);
  };
  readRelease();
  const runner = createGitHubRunner({
    cwd: prepared.directory,
    timeoutMs: 15_000,
    maxBuffer: 2 * 1024 * 1024,
  });
  const api = new GitHubApiClient((args, body) =>
    runner([...args, "--hostname", "github.com"], body),
  );
  const readBoundary = async () => {
    requireAuthenticatedReleaseControlSource(controls, "site-publication");
    const facts =
      input.metadata_renewal === undefined
        ? controls.read(api, frozen)
        : controls.readMaintenance(api);
    if (
      facts.pause.publication_paused !== false ||
      facts.resource_policy_matches_controller !== true ||
      !isRecord(facts.capacity_source.capacity)
    )
      throw new Error("fresh actual publication controls hold the site attempt");
    return structuredClone(facts.capacity_source.capacity.boundary);
  };
  const provider = createPagesProviderTransport(prepared.directory);
  if (provider.evidence_scope !== "github.com")
    throw new Error("actual Pages provider transport required");
  const result = await executeOwnedCapacityEffect(
    executor,
    {
      ...input,
      request: { kind: "upload", destination: "github-pages:boburning/portcove:complete-site" },
    },
    readBoundary,
    async (pending) => {
      // A complete independent prior readback and freshly guarded controls occur
      // before the sole POST. No provider CAS guarantee is inferred from them.
      await readPublicApplicationSiteMarker(prepared.previous_generation!);
      await readBoundary();
      const immutableRelease = readRelease();
      const attempt = await mkdtemp(path.join(prepared.directory, "pages-attempt-"));
      const write = async (name: string, value: unknown) =>
        writeFile(path.join(attempt, name), JSON.stringify(value), { flag: "wx", mode: 0o600 });
      await write("pending.json", {
        ...pending,
        generation: prepared.generation.generation,
        previous_generation: prepared.previous_generation!.generation,
        artifact_id: prepared.upload!.artifact_id,
        immutable_release: immutableRelease,
      });
      try {
        const accepted = await provider.create({
          artifact_id: prepared.upload!.artifact_id,
          controller_revision: executorIdentity.controller_revision,
          generation: prepared.generation.generation,
        });
        await write("acknowledgement.json", accepted);
        const deadline = performance.now() + 150_000;
        let status: ReturnType<typeof provider.observe> | null = null;
        for (let count = 0; count < 30; count++) {
          if (performance.now() >= deadline)
            throw new Error("Pages observation deadline exhausted; retain pending intent");
          status = provider.observe({
            id: accepted.id,
            artifact_id: accepted.artifact_id,
            controller_revision: accepted.controller_revision,
            generation: accepted.generation,
          });
          await write(`status-${count}.json`, status);
          if (performance.now() >= deadline)
            throw new Error("Pages observation arrived after deadline; retain pending intent");
          if (status.status === "succeed") break;
          if (["cancelled", "failed", "deployment_failed"].includes(status.status))
            throw new Error("Pages provider stopped the affected attempt; retain all effects");
          await new Promise((resolve) => setTimeout(resolve, 5000));
        }
        if (status?.status !== "succeed")
          throw new Error("Pages acknowledgement has no completed result; retain pending intent");
        const publicReadback = await readBackSiteDeployment(session);
        const evidence = {
          ...pending,
          provider: accepted,
          status,
          public_readback: publicReadback,
          site_generation_sha256: prepared.generation.generation,
          authority: "none",
        };
        await write("public-readback.json", evidence);
        return {
          remote_identity: `github-pages:boburning/portcove:${accepted.id}`,
          evidence_sha256: capacityDigest(evidence),
        };
      } catch {
        await write("failure.json", {
          ...pending,
          outcome: "ambiguous-or-partial",
          retry: "forbidden",
          authority: "none",
        });
        throw new Error(`site publication stopped; preserve and reconcile ${attempt}`);
      }
    },
  );
  // Provider completion and journal settlement are already retained. A later
  // state-handoff failure cannot authorize another deployment; the coordinator
  // must recover this exact published generation through readback.
  await refreshCapacityExecutor(executor);
  await publishCoordinatorCheckpoint(
    input.repository,
    result.checkpoint,
    input.remote_configuration,
    { api },
  );
  const settled = await recoverReleaseOpportunity(input.repository, result.checkpoint);
  const controller = settled.input.controller;
  const capacity =
    isRecord(controller) && isRecord(controller.capacity_attempt)
      ? controller.capacity_attempt
      : null;
  const operation = capacity && isRecord(capacity.operation) ? capacity.operation : null;
  const effects =
    operation && Array.isArray(operation.completed_effects) ? operation.completed_effects : [];
  const effect: unknown = effects[0];
  if (
    !operation ||
    operation.id !== result.operation_id ||
    operation.outcome !== "recovered" ||
    effects.length !== 1 ||
    !isRecord(effect) ||
    effect.evidence_sha256 !== result.evidence_sha256 ||
    typeof effect.remote_identity !== "string"
  )
    throw new Error("published site settlement identity differs; preserve original effects");
  const advanced = await recordPublishedMetadata(
    input.repository,
    result.checkpoint,
    {
      ...prepared.publication,
      operation_id: result.operation_id,
      publication: {
        remote_identity: effect.remote_identity,
        evidence_sha256: result.evidence_sha256,
        site_generation_sha256: prepared.generation.generation,
      },
    },
    { remote: { configuration: input.remote_configuration, api } },
  );
  if (!("durable_checkpoint" in advanced) || advanced.durable_checkpoint !== advanced.checkpoint)
    throw new Error("published metadata handoff remains unresolved; do not deploy again");
  return {
    ...result,
    checkpoint: advanced.checkpoint,
    site_generation_sha256: prepared.generation.generation,
  };
}

/** Re-read an already settled publication after a lost journal handoff. This
 * path has no Pages POST or upload and cannot create an initial metadata seed.
 * Reconstruct the same signed public component with the pinned verifier first. */
export async function recoverPublishedSiteHandoff(
  session: DeploymentSession,
  executor: Awaited<ReturnType<typeof authenticateCapacityExecutor>>,
  raw: { repository: string; checkpoint: string; remote_configuration: unknown },
) {
  const prepared = sessions.get(session);
  if (!prepared?.publication)
    throw new Error("actual authenticated public component required for site handoff recovery");
  return recoverOwnedPublishedMetadata(executor, raw, async (operation) => {
    const effects = operation.completed_effects;
    const effect: unknown = Array.isArray(effects) ? effects[0] : null;
    if (
      !isRecord(effect) ||
      typeof effect.remote_identity !== "string" ||
      !/^github-pages:boburning\/portcove:[A-Za-z0-9_-]{1,128}$/u.test(effect.remote_identity)
    )
      throw new Error("settled effect is not the exact retained Pages publication");
    const publicReadback = await readBackSiteDeployment(session);
    const attempt = await mkdtemp(path.join(prepared.directory, "published-handoff-readback-"));
    await writeFile(
      path.join(attempt, "readback.json"),
      JSON.stringify({
        operation_id: operation.id,
        original_effect: effect,
        public_readback: publicReadback,
        authority: "none",
        provider_mutations: 0,
      }),
      { flag: "wx", mode: 0o600 },
    );
    return {
      ...prepared.publication,
      operation_id: operation.id,
      publication: {
        remote_identity: effect.remote_identity,
        evidence_sha256: effect.evidence_sha256,
        site_generation_sha256: prepared.generation.generation,
      },
    };
  });
}
