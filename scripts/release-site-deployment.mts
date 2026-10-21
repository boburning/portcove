import { createHash } from "node:crypto";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  assembleAuthenticatedApplicationSite,
  isSafeSitePath,
  readComposedSite,
  composeSiteFiles,
  composeCatalogSiteFiles,
  readComposedCatalogSite,
} from "./release-site-composer.mts";
import {
  readPublicApplicationSite,
  readPublicApplicationSiteMarker,
  requirePublishedCompleteSite,
  materializePublishedCompleteSite,
  materializePublishedCatalogCompleteSite,
} from "./release-site-readback.mts";
import { createGitHubRunner, GitHubApiClient, sanitizeOperationError } from "./github-api.mts";
import { readGitHubArtifactArchive } from "./github-binary.mts";
import { inspectBoundedZip } from "./bounded-zip.mts";
import { crc32, inflateRawSync } from "node:zlib";
import { isRecord } from "./runtime-values.mts";
import { capacityDigest } from "./release-capacity.mts";
import { recoverReleaseOpportunity } from "./release-coordinator-state.mts";
import {
  recordPublishedApplicationSiteMetadata,
  recordPublishedCatalogMetadata,
} from "./release-capacity-operation.mts";
import {
  currentApplicationSitePins,
  currentPublishedSite,
  assertCatalogPublicationBaseline,
  inspectCatalogTufPublicationFacts,
} from "./release-catalog-metadata-contract.mts";
import {
  inspectCatalogCapacitySubject,
  inspectCatalogPublicationDescriptor,
  inspectCatalogInitialization,
  inspectCatalogSitePublicationExpectation,
} from "./release-catalog-publication-contract.mts";
import { publishCoordinatorCheckpoint } from "./release-coordinator-remote.mts";
import {
  capacityExecutorIdentity,
  executeOwnedCapacityEffect,
  refreshCapacityExecutor,
  recoverOwnedPublishedMetadata,
  recoverOwnedPublishedCatalogMetadata,
} from "./release-capacity-executor.mts";
import type { authenticateCapacityExecutor } from "./release-capacity-executor.mts";
import { createPagesProviderTransport, isTerminalPagesFailure } from "./release-pages-provider.mts";
import {
  requireAuthenticatedReleaseControlSource,
  requireAuthenticatedCatalogControlSource,
} from "./release-live-control-admission.mts";
import type { AuthenticatedReleaseControlSource } from "./release-live-control-admission.mts";
import { performance } from "node:perf_hooks";
import { withCoordinatorDeadline } from "./release-coordinator-deadline.mts";
import {
  assertMetadataRenewalPublication,
  assertMetadataBootstrapPublication,
} from "./release-metadata-contract.mts";
import {
  inspectMetadataSigningBinding,
  inspectMetadataSigningReservation,
} from "./release-metadata-signing-contract.mts";
import {
  requireControllerPublicationAuthorities,
  requireControllerCatalogPublicationAuthorities,
} from "./release-authority-configuration.mts";
import {
  readConfiguredBootstrapSite,
  readConfiguredCatalogBootstrapSite,
} from "./release-bootstrap-public-inputs.mts";
import { requireReceivedPublicationResult } from "./release-publication-result-artifact.mts";
import { verifiedControllerToolPaths } from "./release-controller-tool-admission.mts";
import { candidateProgressIdentity } from "./release-candidate-progress-contract.mts";
import { readControllerToolFile } from "./release-controller-tools.mts";
import {
  requireActualTufPublication,
  requireRetainedActualTufPublication,
} from "./release-tuf-publication.mts";

const hash = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
function remaining(deadline: number | undefined, maximum: number) {
  if (deadline !== undefined && !Number.isFinite(deadline))
    throw new Error("site deployment phase deadline exhausted; preserve actual effects");
  const value =
    deadline === undefined ? maximum : Math.floor(Math.min(maximum, deadline - performance.now()));
  if (value < 1)
    throw new Error("site deployment phase deadline exhausted; preserve actual effects");
  return value;
}
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
  readonly kind: "prepared-application-site-deployment" | "prepared-catalog-site-deployment";
}
type Composed = Awaited<ReturnType<typeof assembleAuthenticatedApplicationSite>>;
interface PrivateDeployment {
  new_release_tuf?: object;
  bootstrap?: { tuf: object; descriptor_sha256: string; readback_sha256?: string };
  verifier?: { path: string; sha256: string };
  release_binding?: { result: object; tools: object; report_sha256: string };
  deadline?: number;
  generation: Composed["generation"];
  publication?: Composed["publication"];
  catalog?: {
    assembly: object;
    subject: ReturnType<typeof inspectCatalogPublicationDescriptor>;
    facts: ReturnType<typeof inspectCatalogTufPublicationFacts>;
    prior: ReturnType<typeof currentPublishedSite>;
    initialization?: NonNullable<ReturnType<typeof inspectCatalogInitialization>>;
    bootstrap_readback_sha256?: string;
  };
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
  remaining(prepared.deadline, 15000);
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
  const api =
    options.api ??
    new GitHubApiClient((args, input) =>
      createGitHubRunner({
        cwd: prepared.directory,
        timeoutMs: remaining(prepared.deadline, 15000),
        maxBuffer: 128 * 1024,
      })([...args, "--hostname", "github.com"], input),
    );
  const endpoint = `repos/boburning/portcove/actions/artifacts/${expected.artifact_id}`;
  const identity = () => {
    remaining(prepared.deadline, 15000);
    const response = api.request("GET", endpoint);
    remaining(prepared.deadline, 15000);
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
      timeoutMs: remaining(prepared.deadline, 120000),
    });
    await writeFile(path.join(attempt, "uploaded.zip"), bytes, { flag: "wx", mode: 0o600 });
    remaining(prepared.deadline, 15000);
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
  return retainPreparedSiteDeployment(composed, request);
}

/** The fixed controller already verified all five attested envelopes and ran
 * the keyless Rust assembler. Reuse that actual private result, preserving the
 * independently acquired entire previous site, including its catalog. */
async function requireInitialSiteContext(receipt: object, deadline: number) {
  remaining(deadline, 15000);
  const actual = await requireRetainedActualTufPublication(receipt, deadline),
    manifest = actual.context.manifest;
  if (manifest.kind !== "metadata-signing-context")
    throw new Error("initial site requires actual metadata context");
  const metadata = inspectMetadataSigningBinding(
    manifest.facts,
    manifest.binding,
    manifest.previous_site_pins,
  );
  if (metadata.facts.mode !== "bootstrap")
    throw new Error("initial site cannot reinterpret a routine context");
  const authorities = await requireControllerPublicationAuthorities("site-publication"),
    descriptor = metadata.facts.descriptor;
  if (
    authorities.schema_version !== 2 ||
    !authorities.publication.public_source.initial_site_preimage ||
    metadata.facts.namespace !== authorities.namespace ||
    metadata.facts.setup_plan_sha256 !== authorities.publication.setup_plan_sha256 ||
    metadata.facts.public_source_commit !== authorities.publication.public_source.commit ||
    descriptor.initial_site_preimage_sha256 !==
      authorities.publication.initial_site_preimage_sha256 ||
    descriptor.root_sha256 !== authorities.publication.public_source.root.sha256 ||
    descriptor.offline_targets_sha256 !==
      authorities.publication.public_source.offline_targets.sha256 ||
    descriptor.payload_key_registry_sha256 !==
      authorities.publication.public_source.payload_key_registry.sha256
  )
    throw new Error("initial site differs from protected setup/public anchors");
  assertMetadataBootstrapPublication(descriptor, actual.publication);
  remaining(deadline, 15000);
  return { actual, metadata, root_sha256: authorities.publication.public_source.root.sha256 };
}

/** Explicit initial setup only; actual coordinator/Tough proof supplies the
 * empty feed. No nonexistent prior repository or published marker is invented. */
export async function prepareInitialSiteDeploymentFromActualTufPublication(
  publicationReceipt: object,
  outputParent: string,
  deadline: number,
) {
  await requireActualTufPublication(publicationReceipt, deadline);
  const { actual, metadata, root_sha256 } = await requireInitialSiteContext(
    publicationReceipt,
    deadline,
  );
  const composed = await composeSiteFiles({
    previous: null,
    expected_previous_generation: null,
    application: actual.repository,
    application_root_sha256: root_sha256,
    output_parent: outputParent,
    deadline,
  });
  const prepared = await retainPreparedSiteDeployment(
    { ...composed, publication: actual.publication },
    {
      output_parent: outputParent,
      trusted_root_sha256: root_sha256,
      verifier: actual.tools.rust,
      verifier_sha256: hash(await readControllerToolFile(actual.tools.rust)),
      previous_site: null,
      expected_previous_generation: null,
      deadline,
    },
  );
  if (!prepared.changed) throw new Error("initial site cannot be an unchanged prior");
  sessions.get(prepared.session)!.bootstrap = {
    tuf: publicationReceipt,
    descriptor_sha256: capacityDigest(metadata.facts.descriptor),
  };
  remaining(deadline, 15000);
  return prepared;
}

export async function prepareSiteDeploymentFromActualTufPublication(
  publicationReceipt: object,
  priorSiteReceipt: object,
  outputParent: string,
  deadline: number,
) {
  remaining(deadline, 15000);
  const actual = await requireActualTufPublication(publicationReceipt, deadline);
  const previous = await requirePublishedCompleteSite(priorSiteReceipt);
  const pins = actual.context.manifest.previous_site_pins;
  if (
    !isRecord(pins) ||
    capacityDigest(pins) !== capacityDigest(previous.pins) ||
    actual.publication.root_sha256 !== previous.pins.root_sha256
  )
    throw new Error("actual signed context differs from independently retained prior whole site");
  const composed = await composeSiteFiles({
    previous: previous.directory,
    expected_previous_generation: previous.pins.site_generation_sha256,
    application: actual.repository,
    application_root_sha256: actual.publication.root_sha256,
    output_parent: outputParent,
    deadline,
  });
  await requireActualTufPublication(publicationReceipt, deadline);
  await requirePublishedCompleteSite(priorSiteReceipt);
  remaining(deadline, 15000);
  const prepared = await retainPreparedSiteDeployment(
    { ...composed, publication: actual.publication },
    {
      output_parent: outputParent,
      trusted_root_sha256: actual.publication.root_sha256,
      verifier: actual.tools.rust,
      verifier_sha256: hash(await readControllerToolFile(actual.tools.rust)),
      previous_site: previous.directory,
      expected_previous_generation: previous.pins.site_generation_sha256,
      deadline,
    },
  );
  if (prepared.changed && actual.context.manifest.kind === "release-signing-context")
    sessions.get(prepared.session)!.new_release_tuf = publicationReceipt;
  return prepared;
}

async function retainPreparedSiteDeployment(
  composed: Composed,
  request: Pick<
    Parameters<typeof assembleAuthenticatedApplicationSite>[0],
    | "output_parent"
    | "trusted_root_sha256"
    | "verifier"
    | "verifier_sha256"
    | "previous_site"
    | "expected_previous_generation"
    | "deadline"
  >,
) {
  if (!composed.changed) return { changed: false as const, generation: composed.generation };
  const { files } = await readComposedSite(
    composed.output,
    composed.generation.generation,
    request.trusted_root_sha256,
    request.deadline,
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
          request.deadline,
        );
  remaining(request.deadline, 15000);
  sessions.set(session, {
    verifier: { path: request.verifier, sha256: request.verifier_sha256 },
    ...(request.deadline === undefined ? {} : { deadline: request.deadline }),
    ...retained,
    publication: structuredClone(composed.publication),
    previous_generation: prior ? structuredClone(prior.generation) : null,
  });
  return { changed: true as const, session, archive: archivePath, ...receipt, authority: "none" };
}

/** Catalog composition consumes the actual keyless four-role receipt. Neither
 * caller-supplied files nor a self-consistent catalog marker can create this
 * session. The current journal supplies both components and the global cursor. */
export async function prepareCatalogSiteDeploymentFromActualRepository(
  assembly: object,
  raw: { repository: string; checkpoint: string; output_parent: string; deadline: number },
) {
  const request = structuredClone(raw);
  remaining(request.deadline, 15000);
  const { requireActualCatalogRepository } = await import("./release-catalog-signing.mts");
  const actual = await requireActualCatalogRepository(assembly, request.deadline);
  const deadline = Math.min(request.deadline, actual.deadline);
  const authorities = await withCoordinatorDeadline(deadline, () =>
    requireControllerCatalogPublicationAuthorities("site-publication"),
  );
  remaining(deadline, 15000);
  const recovered = await recoverReleaseOpportunity(request.repository, request.checkpoint);
  const subject = inspectCatalogPublicationDescriptor(recovered.input.catalog_publication);
  const descriptor = assertCatalogPublicationBaseline(actual.descriptor, recovered.input);
  const facts = inspectCatalogTufPublicationFacts(actual.report.facts);
  if (
    !facts ||
    capacityDigest(subject) !== capacityDigest(descriptor) ||
    descriptor.publisher_configuration_sha256 !== authorities.configuration_sha256 ||
    facts.root_sha256 !== authorities.catalog.public_source.root.sha256 ||
    facts.offline_targets_sha256 !== authorities.catalog.public_source.offline_targets.sha256
  )
    throw new Error(
      "catalog site differs from actual assembly, configured anchors or journal subject",
    );
  const prior = currentPublishedSite(recovered.input);
  const initialization = prior
    ? undefined
    : inspectCatalogInitialization(recovered.input.catalog_initialization);
  if (
    !prior &&
    (!initialization ||
      initialization.publisher_configuration_sha256 !== authorities.configuration_sha256 ||
      initialization.source_commit !== authorities.catalog.public_source.commit ||
      initialization.root_sha256 !== facts.root_sha256 ||
      initialization.setup_plan_sha256 !== authorities.catalog.setup_plan_sha256 ||
      initialization.initial_site_preimage_sha256 !==
        authorities.catalog.public_source.initial_site_preimage?.sha256)
  )
    throw new Error("catalog initial journal does not match explicit protected setup preimage");
  const previous = prior
    ? prior.components.catalog
      ? await materializePublishedCatalogCompleteSite(
          {
            ...prior.components.catalog,
            site_generation_sha256: prior.generation_sha256,
          },
          request.output_parent,
          deadline,
        )
      : prior.components.application
        ? await materializePublishedCompleteSite(
            {
              ...prior.components.application,
              site_generation_sha256: prior.generation_sha256,
            },
            request.output_parent,
            deadline,
          )
        : null
    : null;
  if (prior && !previous) throw new Error("current whole site has no appointed component");
  const composed = await composeCatalogSiteFiles({
    previous: previous?.directory ?? null,
    expected_previous_generation: prior?.generation_sha256 ?? null,
    catalog: actual.repository,
    catalog_root_sha256: facts.root_sha256,
    output_parent: request.output_parent,
    deadline,
  });
  if (!composed.changed)
    throw new Error("unchanged catalog composition cannot start a Pages effect");
  const checked = await readComposedCatalogSite(
    composed.output,
    composed.generation.generation,
    facts.root_sha256,
    deadline,
  );
  const catalogFiles = checked.generation.files
    .filter((file) => file.path.startsWith("catalog/"))
    .map((file) => ({ ...file, path: file.path.slice("catalog/".length) }));
  if (capacityDigest(catalogFiles) !== facts.repository_sha256)
    throw new Error("catalog composition differs from actual Tough repository inventory");
  const archive = serializeSiteTar(checked.files);
  const directory = await mkdtemp(path.join(request.output_parent, "catalog-site-deployment-"));
  await mkdir(path.join(directory, "upload"), { mode: 0o700 });
  const archivePath = path.join(directory, "upload", "artifact.tar");
  await writeFile(archivePath, archive, { flag: "wx", mode: 0o600 });
  const generation = structuredClone(checked.generation);
  for (const file of generation.files) Object.freeze(file);
  Object.freeze(generation.files);
  Object.freeze(generation);
  const session: DeploymentSession = Object.freeze({ kind: "prepared-catalog-site-deployment" });
  sessions.set(session, {
    catalog: { assembly, subject, facts, prior, ...(initialization ? { initialization } : {}) },
    deadline,
    generation,
    previous_generation: previous ? structuredClone(previous.generation) : null,
    archive_bytes: archive.length,
    archive_sha256: hash(archive),
    directory,
  });
  await verifyPriorPublicSite(session);
  await requireActualCatalogRepository(assembly, deadline);
  remaining(deadline, 15000);
  await writeFile(
    path.join(directory, "preparation.json"),
    JSON.stringify({
      descriptor_sha256: capacityDigest(subject),
      generation,
      archive_sha256: hash(archive),
      archive_bytes: archive.length,
      authority: "none",
    }),
    { flag: "wx", mode: 0o600 },
  );
  return {
    changed: true as const,
    session,
    archive: archivePath,
    directory,
    generation,
    archive_sha256: hash(archive),
    archive_bytes: archive.length,
    authority: "none",
  };
}

async function recheckCatalogDeployment(prepared: PrivateDeployment) {
  const catalog = prepared.catalog;
  if (!catalog || prepared.deadline === undefined)
    throw new Error("actual catalog site session required");
  const actual = await (
    await import("./release-catalog-signing.mts")
  ).requireActualCatalogRepository(catalog.assembly, prepared.deadline);
  if (
    capacityDigest(actual.descriptor) !== capacityDigest(catalog.subject) ||
    capacityDigest(actual.report.facts) !== capacityDigest(catalog.facts)
  )
    throw new Error("actual catalog repository or descriptor changed");
  remaining(prepared.deadline, 15000);
  return catalog;
}

/** GET-only recovery reconstructs the exact ALREADY public generation. It
 * never composes another marker, uploads or repeats the original Pages POST. */
export async function prepareCatalogSiteHandoffFromActualRepository(
  assembly: object,
  raw: { repository: string; checkpoint: string; output_parent: string; deadline: number },
) {
  const request = structuredClone(raw);
  remaining(request.deadline, 15000);
  const actual = await (
    await import("./release-catalog-signing.mts")
  ).requireActualCatalogRepository(assembly, request.deadline);
  const deadline = Math.min(request.deadline, actual.deadline);
  const authorities = await withCoordinatorDeadline(deadline, () =>
    requireControllerCatalogPublicationAuthorities("coordinator"),
  );
  const state = await recoverReleaseOpportunity(request.repository, request.checkpoint);
  const subject = inspectCatalogPublicationDescriptor(state.input.catalog_publication);
  assertCatalogPublicationBaseline(subject, state.input);
  const facts = inspectCatalogTufPublicationFacts(actual.report.facts);
  const controller = state.input.controller;
  const attempt =
    isRecord(controller) && isRecord(controller.capacity_attempt)
      ? controller.capacity_attempt
      : null;
  const operation = attempt && isRecord(attempt.operation) ? attempt.operation : null;
  if (
    !facts ||
    !operation ||
    capacityDigest(actual.descriptor) !== capacityDigest(subject) ||
    subject.publisher_configuration_sha256 !== authorities.configuration_sha256 ||
    facts.root_sha256 !== authorities.catalog.public_source.root.sha256 ||
    facts.offline_targets_sha256 !== authorities.catalog.public_source.offline_targets.sha256 ||
    capacityDigest(inspectCatalogCapacitySubject(operation.catalog_publication).descriptor) !==
      capacityDigest(subject) ||
    operation.destination !== "github-pages:boburning/portcove:complete-site" ||
    operation.kind !== "upload" ||
    operation.outcome !== "recovered" ||
    !isRecord(operation.recovery) ||
    operation.recovery.resolution !== "effect-completed"
  )
    throw new Error("exact settled catalog Pages subject required for GET-only recovery");
  const expected = inspectCatalogSitePublicationExpectation(operation.catalog_site_expectation);
  const prior = currentPublishedSite(state.input);
  if (
    expected.catalog_root_sha256 !== facts.root_sha256 ||
    expected.catalog_repository_sha256 !== facts.repository_sha256 ||
    expected.prior_site_generation_sha256 !== (prior?.generation_sha256 ?? null) ||
    expected.application_root_sha256 !== (prior?.components.application?.root_sha256 ?? null)
  )
    throw new Error("catalog recovery differs from authenticated assembly or original prior");
  const current = await materializePublishedCatalogCompleteSite(
    {
      root_sha256: facts.root_sha256,
      repository_sha256: facts.repository_sha256,
      site_generation_sha256: String(expected.site_generation_sha256),
    },
    request.output_parent,
    deadline,
  );
  if (
    current.generation.previous_generation !== expected.prior_site_generation_sha256 ||
    current.generation.application_root_sha256 !== expected.application_root_sha256 ||
    capacityDigest(
      current.generation.files
        .filter((file) => file.path.startsWith("application/"))
        .map((file) => ({ ...file, path: file.path.slice("application/".length) })),
    ) !== (prior?.components.application?.repository_sha256 ?? capacityDigest([]))
  )
    throw new Error(
      "public catalog recovery changed preserved application bytes or marker ancestry",
    );
  const session: DeploymentSession = Object.freeze({ kind: "prepared-catalog-site-deployment" });
  sessions.set(session, {
    catalog: { assembly, subject, facts, prior },
    deadline,
    generation: structuredClone(current.generation),
    previous_generation: null,
    archive_sha256: String(expected.archive_sha256),
    archive_bytes: 0,
    directory: current.directory,
  });
  await recheckCatalogDeployment(sessions.get(session)!);
  return session;
}

export async function recoverPublishedCatalogSiteHandoff(
  session: DeploymentSession,
  executor: Awaited<ReturnType<typeof authenticateCapacityExecutor>>,
  raw: { repository: string; checkpoint: string; remote_configuration: unknown },
) {
  const prepared = sessions.get(session);
  if (!prepared?.catalog || prepared.upload || prepared.archive_bytes !== 0)
    throw new Error("actual GET-only catalog site recovery session required");
  return recoverOwnedPublishedCatalogMetadata(executor, raw, async (operation) => {
    const catalog = await recheckCatalogDeployment(prepared);
    const expected = inspectCatalogSitePublicationExpectation(operation.catalog_site_expectation);
    const effect: unknown = Array.isArray(operation.completed_effects)
      ? operation.completed_effects[0]
      : null;
    if (
      !isRecord(effect) ||
      typeof operation.id !== "string" ||
      effect.remote_identity !==
        `github-pages:boburning/portcove:${prepared.generation.generation}` ||
      expected.site_generation_sha256 !== prepared.generation.generation ||
      capacityDigest(inspectCatalogCapacitySubject(operation.catalog_publication).descriptor) !==
        capacityDigest(catalog.subject)
    )
      throw new Error("catalog handoff differs from original exact Pages settlement");
    const readback = await readBackSiteDeployment(session);
    await recheckCatalogDeployment(prepared);
    const directory = await mkdtemp(path.join(prepared.directory, "catalog-handoff-readback-"));
    await writeFile(
      path.join(directory, "readback.json"),
      JSON.stringify({
        operation_id: operation.id,
        original_effect: effect,
        public_readback: readback,
        provider_mutations: 0,
        authority: "none",
      }),
      { flag: "wx", mode: 0o600 },
    );
    const publication = {
      evidence_sha256: effect.evidence_sha256,
      remote_identity: effect.remote_identity,
    };
    return {
      metadata: {
        ...catalog.facts,
        source_commit: catalog.subject.source_commit,
        source_tree: catalog.subject.source_tree,
        operation_id: operation.id,
        publication: { ...publication, site_generation_sha256: prepared.generation.generation },
      },
      site: {
        schema_version: 1,
        generation_sha256: prepared.generation.generation,
        components: {
          application: catalog.prior?.components.application ?? null,
          catalog: {
            root_sha256: catalog.facts.root_sha256,
            repository_sha256: catalog.facts.repository_sha256,
          },
        },
        operation_id: operation.id,
        publication,
      },
    };
  });
}

/** Bind actual keyless composition to the authenticated publisher's exact
 * record set and the current fixed tool artifact. Valid TUF signatures alone
 * cannot select different release records or appoint a different verifier. */
export async function bindSiteDeploymentToPublicationResult(
  session: DeploymentSession,
  resultReceipt: object,
  toolsReceipt: object,
) {
  const prepared = sessions.get(session);
  if (!prepared?.publication || !prepared.verifier || prepared.catalog)
    throw new Error("actual authenticated site composition required for application binding");
  remaining(prepared.deadline, 15000);
  const result = await requireReceivedPublicationResult(resultReceipt, prepared.deadline);
  const tools = await verifiedControllerToolPaths(toolsReceipt);
  const controller = result.record.controller;
  if (
    !isRecord(controller) ||
    controller.revision !== tools.identity.controller_revision ||
    controller.source_tree !== tools.identity.source_tree ||
    controller.ref !== tools.identity.controller_ref ||
    prepared.verifier.path !== tools.rust ||
    prepared.verifier.sha256 !== hash(await readControllerToolFile(tools.rust)) ||
    !isRecord(result.record.context.binding) ||
    prepared.publication.records_sha256 !== result.record.context.binding.records_sha256
  )
    throw new Error(
      "site composition differs from actual fixed tool or published exact record set",
    );
  if (
    prepared.release_binding &&
    (prepared.release_binding.result !== resultReceipt ||
      prepared.release_binding.tools !== toolsReceipt)
  )
    throw new Error("site cannot switch its publisher binding");
  prepared.release_binding = {
    result: resultReceipt,
    tools: toolsReceipt,
    report_sha256: result.report_sha256,
  };
  remaining(prepared.deadline, 15000);
  return {
    records_sha256: prepared.publication.records_sha256,
    report_sha256: result.report_sha256,
    authority: "none" as const,
  };
}

/** Public readback is necessary after provider completion. This alone cannot
 * settle a remote pending intent or establish who deployed an artifact. */
export async function readBackSiteDeployment(session: DeploymentSession) {
  const prepared = sessions.get(session);
  if (!prepared) throw new Error("imported deployment sessions cannot establish public completion");
  return readPublicApplicationSite(prepared.generation, prepared.deadline);
}

/** Heavy acquisition precedes the fresh observer handshake. This receipt is
 * private continuation state; a later marker bracket cannot create it. */
export async function verifyPriorPublicSite(session: DeploymentSession) {
  const prepared = sessions.get(session);
  if (prepared?.catalog && prepared.previous_generation === null) {
    const catalog = await recheckCatalogDeployment(prepared);
    if (catalog.prior !== null)
      throw new Error("existing site cannot use catalog bootstrap absence");
    const deadline = prepared.deadline!;
    const api = new GitHubApiClient((args, body) =>
      createGitHubRunner({
        cwd: prepared.directory,
        timeoutMs: remaining(deadline, 15000),
        maxBuffer: 512 * 1024,
      })([...args, "--hostname", "github.com"], body),
    );
    const readback = await readConfiguredCatalogBootstrapSite(
      api,
      new Date().toISOString(),
      deadline,
    );
    if (
      readback.configuration_sha256 !== catalog.subject.publisher_configuration_sha256 ||
      readback.root_sha256 !== catalog.facts.root_sha256 ||
      !catalog.initialization ||
      readback.source.source_tree !== catalog.initialization.source_tree ||
      readback.setup_plan_sha256 !== catalog.initialization.setup_plan_sha256 ||
      readback.historical_preimage_sha256 !== catalog.initialization.initial_site_preimage_sha256
    )
      throw new Error("catalog bootstrap configuration changed");
    catalog.bootstrap_readback_sha256 = capacityDigest(readback);
    await writeFile(
      path.join(prepared.directory, `initial-catalog-readback-${performance.now()}.json`),
      JSON.stringify(readback),
      { flag: "wx", mode: 0o600 },
    );
    remaining(deadline, 15000);
    return readback;
  }
  if (prepared?.bootstrap) {
    const deadline = prepared.deadline ?? -1;
    const { metadata } = await requireInitialSiteContext(prepared.bootstrap.tuf, deadline);
    if (capacityDigest(metadata.facts.descriptor) !== prepared.bootstrap.descriptor_sha256)
      throw new Error("initial site setup descriptor changed");
    const api = new GitHubApiClient((args, body) => {
      remaining(deadline, 15000);
      const result = createGitHubRunner({
        cwd: prepared.directory,
        timeoutMs: remaining(deadline, 15000),
        maxBuffer: 512 * 1024,
      })([...args, "--hostname", "github.com"], body);
      remaining(deadline, 15000);
      return result;
    });
    const readback = await readConfiguredBootstrapSite(api, deadline);
    prepared.bootstrap.readback_sha256 = capacityDigest(readback);
    await writeFile(
      path.join(prepared.directory, `initial-public-readback-${performance.now()}.json`),
      JSON.stringify(readback),
      { flag: "wx", mode: 0o600 },
    );
    remaining(deadline, 15000);
    return readback;
  }
  if (!prepared?.previous_generation)
    throw new Error("actual prepared prior site session required");
  const readback = await readPublicApplicationSite(prepared.previous_generation, prepared.deadline);
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
    metadata_bootstrap?: unknown;
    catalog_publication?: unknown;
    recovery?: "transient" | "substantive-repair";
  },
  refreshControls?: () => Promise<AuthenticatedReleaseControlSource>,
) {
  const prepared = sessions.get(session);
  if (!prepared || !prepared.upload || prepared.upload.evidence_scope !== "github.com")
    throw new Error("actual authenticated composition and provider upload session required");
  remaining(prepared.deadline, 15000);
  const requireControls = prepared.catalog
    ? requireAuthenticatedCatalogControlSource
    : requireAuthenticatedReleaseControlSource;
  requireControls(controls, "site-publication");
  let currentControls = controls;
  const renewControls = async () => {
    if (!refreshControls) return;
    const next = await refreshControls();
    requireControls(next, "site-publication");
    if (next.evidence_scope !== "github.com")
      throw new Error("site continuation requires actual refreshed provider controls");
    currentControls = next;
  };
  if (controls.evidence_scope !== "github.com" || (!prepared.catalog && !prepared.publication))
    throw new Error("actual provider controls and authenticated TUF publication facts required");
  const input = structuredClone(raw);
  const catalog = prepared.catalog ? await recheckCatalogDeployment(prepared) : null;
  const bootstrap = catalog
      ? prepared.previous_generation === null
      : input.metadata_bootstrap !== undefined,
    maintenance = catalog !== null || bootstrap || input.metadata_renewal !== undefined;
  if (catalog) {
    if (
      input.metadata_bootstrap !== undefined ||
      input.metadata_renewal !== undefined ||
      prepared.release_binding ||
      prepared.publication ||
      capacityDigest(inspectCatalogPublicationDescriptor(input.catalog_publication)) !==
        capacityDigest(catalog.subject)
    )
      throw new Error("catalog site requires its exact separate catalog subject only");
  } else if (input.catalog_publication !== undefined)
    throw new Error("application site cannot publish a catalog subject");
  if (bootstrap && input.metadata_renewal !== undefined)
    throw new Error("site requires exactly one metadata subject");
  if (catalog) {
    // Actual keyless assembly, protected catalog appointments and the current
    // journal subject were independently bound by the catalog session factory.
  } else if (bootstrap) {
    if (!prepared.bootstrap || prepared.release_binding || prepared.previous_generation !== null)
      throw new Error("initial site requires actual initial preparation only");
    const proof = await requireInitialSiteContext(prepared.bootstrap.tuf, prepared.deadline ?? -1);
    if (capacityDigest(input.metadata_bootstrap) !== prepared.bootstrap.descriptor_sha256)
      throw new Error("initial site descriptor differs from actual signed context");
    input.metadata_bootstrap = assertMetadataBootstrapPublication(
      proof.metadata.facts.descriptor,
      prepared.publication!,
    );
  } else if (input.metadata_renewal !== undefined) {
    if (prepared.release_binding)
      throw new Error("site requires one exact maintenance or release subject");
    input.metadata_renewal = assertMetadataRenewalPublication(
      input.metadata_renewal,
      prepared.publication!,
    );
  } else if (!prepared.release_binding)
    throw new Error(
      "new release site requires actual attested publisher and exact record-set binding",
    );
  const executorIdentity = capacityExecutorIdentity(executor);
  if (
    executorIdentity.role !== "site-publication" ||
    Number(executorIdentity.run_id) !== prepared.upload.run_id ||
    executorIdentity.run_attempt !== prepared.upload.run_attempt ||
    executorIdentity.controller_revision !== prepared.upload.controller_revision
  )
    throw new Error("site artifact is not associated with the actual fixed same-attempt executor");
  const checkpoint = await recoverReleaseOpportunity(input.repository, input.checkpoint);
  if (catalog) {
    assertCatalogPublicationBaseline(catalog.subject, checkpoint.input);
    if (
      capacityDigest(inspectCatalogPublicationDescriptor(checkpoint.input.catalog_publication)) !==
        capacityDigest(catalog.subject) ||
      capacityDigest(currentPublishedSite(checkpoint.input)) !== capacityDigest(catalog.prior) ||
      (bootstrap
        ? !catalog.bootstrap_readback_sha256
        : prepared.prior_public_readback?.generation !== catalog.prior?.generation_sha256) ||
      prepared.generation.previous_generation !== (catalog.prior?.generation_sha256 ?? null)
    )
      throw new Error("catalog site current journal, prior readback or initial absence differs");
  } else if (bootstrap) {
    const proof = await requireInitialSiteContext(prepared.bootstrap!.tuf, prepared.deadline ?? -1);
    inspectMetadataSigningReservation(
      proof.actual.context.manifest.facts,
      proof.actual.context.manifest.binding,
      null,
      checkpoint,
    );
    if (prepared.generation.previous_generation !== null || !prepared.bootstrap!.readback_sha256)
      throw new Error("initial site requires independent configured/public preflight");
  } else if (
    !prepared.previous_generation ||
    currentApplicationSitePins(checkpoint.input).site_generation_sha256 !==
      prepared.previous_generation.generation ||
    prepared.generation.previous_generation !== prepared.previous_generation.generation ||
    prepared.prior_public_readback?.generation !== prepared.previous_generation.generation
  )
    throw new Error("actual independent prior site generation/initial seed is required");
  const candidate = checkpoint.input.active_candidate;
  const frozen = isRecord(candidate) ? candidate.frozen_opportunity : null;
  if (!maintenance && !isRecord(frozen))
    throw new Error("release site requires the existing complete frozen opportunity");
  let riskExpiresAt: number | undefined;
  const readRelease = async () => {
    if (maintenance) return null;
    if (riskExpiresAt !== undefined && Date.now() >= riskExpiresAt)
      throw new Error("new-candidate feed risk authorization expired before publication");
    const binding = prepared.release_binding;
    if (
      !binding ||
      !isRecord(candidate) ||
      candidate.phase !== "promoting" ||
      !isRecord(input.remote_configuration)
    )
      throw new Error(
        "feed publication requires actual promoting reservation and publisher binding",
      );
    const result = await requireReceivedPublicationResult(binding.result, prepared.deadline);
    const tools = await verifiedControllerToolPaths(binding.tools);
    const context = result.context;
    const record = result.record;
    const controller = record.controller;
    const facts = context.manifest.facts;
    if (
      !isRecord(record.candidate) ||
      !isRecord(controller) ||
      !isRecord(facts) ||
      result.report_sha256 !== binding.report_sha256 ||
      record.namespace !== input.remote_configuration.namespace ||
      candidateProgressIdentity(candidate) !== candidateProgressIdentity(record.candidate) ||
      capacityDigest([
        candidate.release_run,
        candidate.transient_retries,
        candidate.substantive_repairs,
      ]) !==
        capacityDigest([
          record.candidate.release_run,
          record.candidate.transient_retries,
          record.candidate.substantive_repairs,
        ]) ||
      capacityDigest(facts.opportunity) !== capacityDigest(frozen) ||
      controller.revision !== executorIdentity.controller_revision ||
      controller.ref !== executorIdentity.execution_ref ||
      tools.identity.run_id !== executorIdentity.run_id ||
      tools.identity.run_attempt !== executorIdentity.run_attempt
    )
      throw new Error(
        "current feed reservation, frozen opportunity or fixed executor differs from published result",
      );
    remaining(prepared.deadline, 15000);
    return result.release;
  };
  if (!maintenance) {
    if (!prepared.new_release_tuf || !prepared.release_binding || prepared.deadline === undefined)
      throw new Error("new-candidate feed requires actual TUF/result risk custody");
    const risk = await (
      await import("./linux-beta-risk-706-controller.mts")
    ).authorizeActualSiteLinuxRisk706(
      prepared.new_release_tuf,
      prepared.release_binding.result,
      currentControls,
      input.checkpoint,
      prepared.deadline,
    );
    riskExpiresAt = risk.expires_at === null ? undefined : Date.parse(risk.expires_at);
    if (riskExpiresAt !== undefined && !Number.isFinite(riskExpiresAt))
      throw new Error("new-candidate feed risk expiry unavailable");
  }
  await readRelease();
  const api = new GitHubApiClient((args, body) =>
    createGitHubRunner({
      cwd: prepared.directory,
      timeoutMs: remaining(prepared.deadline, 15000),
      maxBuffer: 2 * 1024 * 1024,
    })([...args, "--hostname", "github.com"], body),
  );
  const readBoundary = async () => {
    remaining(prepared.deadline, 15000);
    requireControls(currentControls, "site-publication");
    if (catalog) await recheckCatalogDeployment(prepared);
    const facts = !maintenance
      ? currentControls.read(api, frozen)
      : currentControls.readMaintenance(api);
    remaining(prepared.deadline, 15000);
    if (
      facts.pause.publication_paused !== false ||
      facts.resource_policy_matches_controller !== true ||
      !isRecord(facts.capacity_source.capacity)
    )
      throw new Error("fresh actual publication controls hold the site attempt");
    return structuredClone(facts.capacity_source.capacity.boundary);
  };
  const provider = createPagesProviderTransport(prepared.directory, {}, prepared.deadline);
  if (provider.evidence_scope !== "github.com")
    throw new Error("actual Pages provider transport required");
  const result = await executeOwnedCapacityEffect(
    executor,
    {
      ...input,
      request: {
        kind: "upload",
        destination: "github-pages:boburning/portcove:complete-site",
        ...(catalog
          ? {
              catalog_site_expectation: {
                artifact_id: prepared.upload.artifact_id,
                archive_sha256: prepared.archive_sha256,
                site_generation_sha256: prepared.generation.generation,
                prior_site_generation_sha256: prepared.previous_generation?.generation ?? null,
                application_root_sha256: catalog.prior?.components.application?.root_sha256 ?? null,
                catalog_root_sha256: catalog.facts.root_sha256,
                catalog_repository_sha256: catalog.facts.repository_sha256,
              },
            }
          : {
              site_expectation: {
                artifact_id: prepared.upload.artifact_id,
                archive_sha256: prepared.archive_sha256,
                site_generation_sha256: prepared.generation.generation,
                prior_site_generation_sha256: prepared.previous_generation?.generation ?? null,
                root_sha256: prepared.publication!.root_sha256,
                repository_sha256: prepared.publication!.repository_sha256,
              },
            }),
      },
    },
    readBoundary,
    async (pending) => {
      // A complete independent prior readback and freshly guarded controls occur
      // before the sole POST. No provider CAS guarantee is inferred from them.
      if (bootstrap) await verifyPriorPublicSite(session);
      else await readPublicApplicationSiteMarker(prepared.previous_generation!, prepared.deadline);
      await readBoundary();
      const immutableRelease = await readRelease();
      const attempt = await mkdtemp(path.join(prepared.directory, "pages-attempt-"));
      const write = async (name: string, value: unknown) =>
        writeFile(path.join(attempt, name), JSON.stringify(value), { flag: "wx", mode: 0o600 });
      await write("pending.json", {
        ...pending,
        generation: prepared.generation.generation,
        previous_generation: prepared.previous_generation?.generation ?? null,
        artifact_id: prepared.upload!.artifact_id,
        immutable_release: immutableRelease,
      });
      try {
        if (riskExpiresAt !== undefined && Date.now() >= riskExpiresAt)
          throw new Error("new-candidate feed risk authorization expired before sole Pages POST");
        const accepted = await provider.create(
          {
            artifact_id: prepared.upload!.artifact_id,
            controller_revision: executorIdentity.controller_revision,
            generation: prepared.generation.generation,
          },
          async () => {
            await refreshCapacityExecutor(executor);
            await readBoundary();
            if (bootstrap) await verifyPriorPublicSite(session);
          },
        );
        await write("acknowledgement.json", accepted);
        const deadline = Math.min(performance.now() + 150_000, prepared.deadline ?? Infinity);
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
          if (isTerminalPagesFailure(status.status))
            throw new Error("Pages provider stopped the affected attempt; retain all effects");
          await new Promise((resolve) => setTimeout(resolve, remaining(deadline, 5000)));
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
        // Public/provider observation can consume the original control window.
        // Refresh before returning to the existing durable settlement writer.
        await renewControls();
        await readBoundary();
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
  await renewControls();
  await readBoundary();
  await publishCoordinatorCheckpoint(
    input.repository,
    result.checkpoint,
    input.remote_configuration,
    { api },
  );
  remaining(prepared.deadline, 15000);
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
  const publication = {
    remote_identity: effect.remote_identity,
    evidence_sha256: result.evidence_sha256,
    site_generation_sha256: prepared.generation.generation,
  };
  const advanced = catalog
    ? await recordPublishedCatalogMetadata(
        input.repository,
        result.checkpoint,
        {
          ...catalog.facts,
          source_commit: catalog.subject.source_commit,
          source_tree: catalog.subject.source_tree,
          operation_id: result.operation_id,
          publication,
        },
        {
          schema_version: 1,
          generation_sha256: prepared.generation.generation,
          components: {
            application: catalog.prior?.components.application ?? null,
            catalog: {
              root_sha256: catalog.facts.root_sha256,
              repository_sha256: catalog.facts.repository_sha256,
            },
          },
          operation_id: result.operation_id,
          publication: {
            evidence_sha256: result.evidence_sha256,
            remote_identity: effect.remote_identity,
          },
        },
        { remote: { configuration: input.remote_configuration, api } },
      )
    : await recordPublishedApplicationSiteMetadata(
        input.repository,
        result.checkpoint,
        {
          ...prepared.publication!,
          operation_id: result.operation_id,
          publication,
        },
        { remote: { configuration: input.remote_configuration, api } },
      );
  remaining(prepared.deadline, 15000);
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
  remaining(prepared.deadline, 15000);
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
