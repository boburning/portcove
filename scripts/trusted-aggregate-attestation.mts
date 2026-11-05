import { inspectAggregateOriginalUpload } from "./release-aggregate-contract.mts";
import { inspectNativeCheckpointLocator } from "./release-native-custody-locator.mts";
import { verifyControllerArtifactStatement } from "./github-controller-attestation.mts";
import { orderedJsonValue as canonical } from "./json-values.mts";
import { createHash } from "node:crypto";
import { lstat, mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { writeFileSync } from "node:fs";
import path from "node:path";
import { crc32, inflateRawSync } from "node:zlib";
import { inspectBoundedZip } from "./bounded-zip.mts";
import {
  inspectAssemblerIdentityExpectation,
  verifyAssemblerJobIdentity,
  verifyAdmittedAssemblerJobIdentity,
} from "./assembler-job-identity.mts";
import type { AssemblerIdentityExpectation } from "./assembler-job-identity.mts";
import { inspectTrustedAssemblyInput } from "./trusted-release-assembly.mts";
import { artifactName } from "./release-package-policy.mts";
import type { GitHubRequestPolicy } from "./github-client.mts";
import { downloadGitHubArtifactArchiveFile } from "./github-artifact-download.mts";
import type { SigningArchiveDownload } from "./release-signing-handoff.mts";
import { coordinatorCommandDeadline } from "./release-coordinator-deadline.mts";
import { assertTrustedDirectNode } from "./release-direct-node-transport.mts";
import {
  fixedReleaseReaderToken,
  readOnlyReleaseChildEnvironment,
} from "./release-readonly-child-environment.mts";
import type { RetainedGitHubSpawn } from "./github-cli.mts";
import { productionControllerWorkflow } from "./production-controller-admission.mts";
import { isRecord } from "./runtime-values.mts";
import { performance } from "node:perf_hooks";
import { CoordinatorRemoteError } from "./release-coordinator-errors.mts";
import {
  collectReleaseRunEvidence,
  inspectReleaseEvidenceRequest,
} from "./release-run-evidence.mts";
import type { ReleaseEvidenceRequest, ReleaseEvidenceOptions } from "./release-run-evidence.mts";
import {
  requireStablePublicBuildInputEvidence,
  verifyReleasePublicBuildInputs,
} from "./release-public-build-provenance.mts";

const publicInputScope =
  "verified public configuration bytes and archive provenance only; no compiler-content or execution claim";

export const aggregatePredicateType = "https://portcove.dev/attestations/package-aggregate/v1";
const repository = "boburning/portcove";
const maximumArchiveBytes = 512 * 1024 * 1024;
const hash = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
type IdentityOptions = Parameters<typeof verifyAssemblerJobIdentity>[2];

function positive(value: unknown): asserts value is number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1)
    throw new Error("aggregate binding requires a positive numeric identity");
}
function digest(value: unknown): asserts value is string {
  if (typeof value !== "string" || !/^[a-f0-9]{64}$/u.test(value))
    throw new Error("aggregate binding requires an exact SHA-256");
}
function timestamp(value: unknown): asserts value is string {
  if (
    typeof value !== "string" ||
    !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/u.test(value) ||
    !Number.isFinite(Date.parse(value)) ||
    new Date(value).toISOString().replace(".000Z", "Z") !== value
  )
    throw new Error("aggregate provider timestamp is invalid");
}
function same(left: unknown, right: unknown): boolean {
  return JSON.stringify(canonical(left)) === JSON.stringify(canonical(right));
}

async function expectedMembers(rawRequest: unknown) {
  const { accepted, policy, labels } = await inspectTrustedAssemblyInput(rawRequest);
  const packages = policy.packages
    .map((entry) => {
      const filename = artifactName(entry, accepted.version);
      const file = accepted.files.find(
        (file) => file.platform_label === entry.platform_label && file.filename === filename,
      )!;
      return { filename, bytes: file.bytes, sha256: file.sha256 };
    })
    .sort((a, b) => a.filename.localeCompare(b.filename));
  const checksums = Buffer.from(
    packages.map((file) => `${file.sha256}  ${file.filename}\n`).join(""),
  );
  return {
    accepted,
    platformCount: labels.length,
    files: [
      ...packages,
      { filename: policy.checksum_manifest, bytes: checksums.length, sha256: hash(checksums) },
    ].sort((a, b) => a.filename.localeCompare(b.filename)),
  };
}

function verifyMembers(
  archive: Buffer,
  files: { filename: string; bytes: number; sha256: string }[],
  consume?: (file: { filename: string; bytes: number; sha256: string }, bytes: Buffer) => void,
) {
  const { entries } = inspectBoundedZip(archive, {
    compressedBytes: maximumArchiveBytes,
    expandedBytes: files.reduce((sum, file) => sum + file.bytes, 0),
    files: files.length,
    nameBytes: 256,
    allowedPaths: new Set(files.map((file) => file.filename)),
  });
  if (entries.length !== files.length)
    throw new Error("aggregate archive member inventory differs");
  // Validate every declaration before inflating even the first entry.
  for (const entry of entries) {
    const expected = files.find((file) => file.filename === entry.name);
    if (!expected || expected.bytes !== entry.bytes)
      throw new Error("aggregate archive member length differs");
  }
  for (const entry of entries) {
    const expected = files.find((file) => file.filename === entry.name)!;
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
      throw new Error("aggregate archive member bytes differ from independently accepted inputs");
    consume?.(expected, bytes);
  }
}

/** Data-only staging for the fixed finalizer. The existing aggregate verifier
 * must establish provider provenance separately. No member is executed, no
 * receipt supplies release authority, and a later failure retains partial files. */
export async function stageAggregatePackages(
  directory: string,
  rawArchive: Buffer,
  rawAssembly: unknown,
  expectedArchiveSha256: string,
) {
  digest(expectedArchiveSha256);
  if (
    !path.isAbsolute(directory) ||
    !Buffer.isBuffer(rawArchive) ||
    rawArchive.length < 22 ||
    rawArchive.length > maximumArchiveBytes
  )
    throw new Error("aggregate package staging requires bounded bytes and private storage");
  const archive = Buffer.from(rawArchive);
  if (hash(archive) !== expectedArchiveSha256)
    throw new Error("aggregate package staging archive differs");
  const { files } = await expectedMembers(rawAssembly);
  if (files.some((file) => path.basename(file.filename) !== file.filename))
    throw new Error("aggregate package staging path is not a filename");
  const parent = path.dirname(directory);
  const parentInfo = await lstat(parent);
  if (
    !parentInfo.isDirectory() ||
    parentInfo.isSymbolicLink() ||
    (await realpath(parent)) !== path.resolve(parent)
  )
    throw new Error("aggregate staging parent is linked or unavailable");
  await mkdir(directory, { mode: 0o700 });
  try {
    verifyMembers(archive, files, (file, bytes) => {
      // One bounded decoded member at a time; no all-members buffer or generic
      // archive extractor. wx preserves both prior and partially written state.
      writeFileSync(path.join(directory, file.filename), bytes, { flag: "wx", mode: 0o600 });
    });
    return {
      directory,
      files,
      archive_sha256: expectedArchiveSha256,
      authority: "none",
      scope: "aggregate package bytes only; independent acceptance still required",
    };
  } catch {
    throw new CoordinatorRemoteError(
      "aggregate package materialization refused; retain partial state",
      {
        directory,
        authority: "none",
        automatic_retry: false,
      },
    );
  }
}

function artifact(
  raw: unknown,
  id: number,
  sha256: string,
  expected: Pick<AssemblerIdentityExpectation, "run_id" | "run_attempt" | "controller_revision">,
  name = `trusted-release-final-${expected.run_id}-${expected.run_attempt}`,
  maximumBytes = maximumArchiveBytes,
) {
  if (
    !isRecord(raw) ||
    raw.id !== id ||
    raw.name !== name ||
    raw.expired !== false ||
    raw.digest !== `sha256:${sha256}` ||
    typeof raw.size_in_bytes !== "number" ||
    !Number.isSafeInteger(raw.size_in_bytes) ||
    raw.size_in_bytes < 22 ||
    raw.size_in_bytes > maximumBytes ||
    !isRecord(raw.workflow_run) ||
    String(raw.workflow_run.id) !== expected.run_id ||
    raw.workflow_run.repository_id !== 1354613114 ||
    raw.workflow_run.head_repository_id !== 1354613114 ||
    raw.workflow_run.head_sha !== expected.controller_revision
  )
    throw new Error("new aggregate artifact provider identity differs");
  timestamp(raw.created_at);
  if (raw.expires_at !== null) timestamp(raw.expires_at);
  return {
    id,
    name: raw.name,
    bytes: raw.size_in_bytes,
    sha256,
    created_at: raw.created_at,
    expires_at: raw.expires_at,
  };
}

async function acquireAggregateArchive(
  cwd: string,
  endpoint: string,
  options: Parameters<typeof downloadGitHubArtifactArchiveFile>[2],
) {
  const scratch = await mkdtemp(path.join(cwd, "aggregate-upload-readback-"));
  try {
    const filename = path.join(scratch, "uploaded.zip");
    await downloadGitHubArtifactArchiveFile(endpoint, filename, options);
    if (performance.now() >= options.deadline)
      throw new Error("aggregate archive deadline exhausted");
    const { readControllerToolFile } = await import("./release-controller-tools.mts");
    return await readControllerToolFile(filename, options.maxBytes);
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
}

/** Invoked only by reviewed fixed controller code after real assembly/upload.
 * Independently authenticate input authority before calling. This verifies the
 * actual uploaded opaque archive's members, then invokes fresh signed own-job
 * verification itself. A supplied identity receipt cannot replace that call.
 * The result is input to existing actions/attest, never a signature or grant.
 */
const admittedPreparations = new WeakSet<object>();
const recoveredPreparations = new WeakMap<
  object,
  ReturnType<typeof inspectAggregateOriginalUpload>
>();
export function prepareRecoveredAdmittedAggregateAttestation(
  original: unknown,
  ...args: Parameters<typeof prepareAggregateAttestation>
) {
  recoveredPreparations.set(args[5], inspectAggregateOriginalUpload(structuredClone(original)));
  admittedPreparations.add(args[5]);
  return prepareAggregateAttestation(...args);
}
export function prepareAdmittedAggregateAttestation(
  ...args: Parameters<typeof prepareAggregateAttestation>
) {
  admittedPreparations.add(args[5]);
  return prepareAggregateAttestation(...args);
}
export async function prepareAggregateAttestation(
  token: string,
  rawExpected: AssemblerIdentityExpectation,
  rawRequest: unknown,
  rawCandidateArtifactIds: readonly number[],
  rawUpload: { artifact_id: number; sha256: string },
  options: {
    cwd: string;
    identity?: IdentityOptions;
    readArtifact?: (id: number) => Promise<unknown>;
    download?: SigningArchiveDownload;
    evidenceRequest?: ReleaseEvidenceRequest;
    evidence?: ReleaseEvidenceOptions;
    deadline?: number;
    native_custody?: ReturnType<typeof inspectNativeCheckpointLocator>;
  },
) {
  const { cwd, download, readArtifact, identity: identityOptions, evidence } = options;
  const admitted = admittedPreparations.has(options);
  const original = recoveredPreparations.get(options);
  const nativeCustody =
    options.native_custody === undefined
      ? undefined
      : inspectNativeCheckpointLocator(structuredClone(options.native_custody));
  if (nativeCustody && !admitted)
    throw new Error("native custody requires the fixed admitted aggregate producer");
  if (nativeCustody && original && nativeCustody.checkpoint !== original.before_checkpoint)
    throw new Error("native custody differs from original aggregate operation");
  const deadline = Math.min(
    performance.now() + 120000,
    options.deadline ?? Infinity,
    coordinatorCommandDeadline() ?? Infinity,
  );
  const remaining = (cap: number) => {
    const left = deadline - performance.now();
    if (!Number.isFinite(left) || left <= 0)
      throw new Error("aggregate binding deadline exhausted");
    return Math.max(1, Math.min(cap, Math.floor(left)));
  };
  remaining(1);
  const expected = inspectAssemblerIdentityExpectation(rawExpected);
  const request = structuredClone(rawRequest);
  const ids = [...rawCandidateArtifactIds];
  const upload = structuredClone(rawUpload);
  positive(upload.artifact_id);
  digest(upload.sha256);
  if (
    ids.length < 1 ||
    ids.length > 16 ||
    new Set(ids).size !== ids.length ||
    ids.includes(upload.artifact_id)
  )
    throw new Error("aggregate must be a new artifact distinct from all bounded candidate IDs");
  ids.forEach(positive);
  const readerToken =
    readArtifact && download && identityOptions ? undefined : fixedReleaseReaderToken();
  const credential = { kind: "explicit" as const, token: readerToken ?? "" };
  const scoped = readOnlyReleaseChildEnvironment() !== undefined;
  const scopedFetch: typeof globalThis.fetch = (input, init) => {
    assertTrustedDirectNode("aggregate sender");
    return globalThis.fetch(input, init);
  };
  const { accepted, files, platformCount } = await expectedMembers(request);
  if (ids.length !== platformCount)
    throw new Error("aggregate candidate artifact matrix is incomplete");
  if (accepted.run_id === expected.run_id)
    throw new Error("candidate run cannot impersonate its trusted assembler run");
  const publicBuildCredential =
    accepted.public_build_inputs && !download ? (evidence?.credential ?? credential) : undefined;
  const evidenceOptions = {
    ...evidence,
    ...(publicBuildCredential ? { credential: publicBuildCredential } : {}),
    deadline: Math.min(deadline, evidence?.deadline ?? Infinity),
  };
  const { reserve } = evidenceOptions;
  let publicBefore: Awaited<ReturnType<typeof collectReleaseRunEvidence>> | null = null;
  let publicRequest: ReleaseEvidenceRequest | null = null;
  let publicVerification: Awaited<ReturnType<typeof verifyReleasePublicBuildInputs>> | null = null;
  if (accepted.public_build_inputs) {
    if (
      accepted.public_build_inputs.artifacts.some(
        (item) => ids.includes(item.artifact_id) || item.artifact_id === upload.artifact_id,
      )
    )
      throw new Error(
        "public input archives must be distinct from packages and the trusted aggregate",
      );
    publicRequest = inspectReleaseEvidenceRequest(options.evidenceRequest);
    if (
      String(publicRequest.run_id) !== accepted.run_id ||
      publicRequest.attempt !== accepted.run_attempt ||
      publicRequest.revision !== accepted.source_commit ||
      publicRequest.tree !== accepted.source_tree ||
      publicRequest.repository_id !== 1354613114
    )
      throw new Error("public input source and independently expected Release evidence differ");
    publicBefore = await collectReleaseRunEvidence(publicRequest, evidenceOptions);
    publicVerification = await verifyReleasePublicBuildInputs(
      cwd,
      accepted.public_build_inputs,
      publicBefore,
      {
        download,
        credential: publicBuildCredential,
        deadline,
        lookup: () => ({
          deadline: evidenceOptions.deadline,
          ...(reserve ? { reserve } : {}),
        }),
      },
    );
  }
  const endpoint = `repos/${repository}/actions/artifacts/${upload.artifact_id}`;
  let read = readArtifact;
  if (!read) {
    const { createGitHubClient } = await import("./github-client.mts");
    const api = await createGitHubClient({
      credential,
      deadline,
      maxBytes: 128 * 1024,
      allowRequest: (method, url) =>
        method === "GET" && url.pathname === `/${endpoint}` && !url.search,
      ...(scoped ? { fetch: scopedFetch } : {}),
      ...(reserve ? { reserve } : {}),
    });
    read = async () => {
      const policy: GitHubRequestPolicy = { replay: "once", attempts: 0 };
      try {
        const response = await api.request(`GET /${endpoint}`, { request: { portcove: policy } });
        if (response.status !== 200) throw new Error("new aggregate artifact unavailable");
        return response.data as unknown;
      } finally {
        await policy.admissionSettled;
      }
    };
  }
  const getArtifact = read;
  const get = async () => {
    remaining(1);
    const data = await getArtifact(upload.artifact_id);
    remaining(1);
    return artifact(data, upload.artifact_id, upload.sha256, original ?? expected);
  };
  const before = await get();
  let downloaded: Buffer;
  if (download) {
    downloaded = await download(`${endpoint}/zip`, {
      cwd,
      maxBytes: before.bytes,
      timeoutMs: remaining(120000),
    });
  } else {
    downloaded = await acquireAggregateArchive(cwd, `${endpoint}/zip`, {
      credential,
      deadline,
      maxBytes: before.bytes,
      ...(scoped ? { fetch: scopedFetch } : {}),
      ...(reserve ? { lookup: { reserve } } : {}),
    });
  }
  remaining(1);
  if (!Buffer.isBuffer(downloaded) || downloaded.length !== before.bytes)
    throw new Error("uploaded aggregate archive digest differs");
  const archive = Buffer.from(downloaded);
  if (hash(archive) !== upload.sha256) throw new Error("uploaded aggregate archive digest differs");
  verifyMembers(archive, files);
  remaining(1);
  if (scoped && !identityOptions) assertTrustedDirectNode("aggregate sender identity");
  const identity = await (
    admitted ? verifyAdmittedAssemblerJobIdentity : verifyAssemblerJobIdentity
  )(token, expected, identityOptions ?? { transport: { sdkToken: credential.token, deadline } });
  if (original && original.run_id === expected.run_id && original.job_id === identity.job_id)
    throw new Error(
      "aggregate current custodian cannot impersonate its original terminal producer",
    );
  if (!same(await get(), before)) throw new Error("new aggregate artifact changed during binding");
  if (accepted.public_build_inputs && publicBefore && publicRequest)
    requireStablePublicBuildInputEvidence(
      accepted.public_build_inputs,
      publicBefore,
      await collectReleaseRunEvidence(publicRequest, evidenceOptions),
    );
  if (Date.now() >= Date.parse(identity.expires_at))
    throw new Error("assembler identity expired before binding completed");
  const evidence_scope =
    readArtifact ||
    download ||
    identity.evidence_scope !== "github.com" ||
    (accepted.public_build_inputs &&
      (evidence || publicVerification?.evidence_scope !== "github.com"))
      ? "injected-provider"
      : "github.com";
  remaining(1);
  const predicate = {
    schema_version: 1,
    ...(admitted
      ? { producer_profile: original ? "admitted-aggregate-recovery-v1" : "admitted-aggregate-v1" }
      : {}),
    ...(original ? { original_upload: original } : {}),
    ...(nativeCustody ? { native_custody: nativeCustody } : {}),
    role: "package-aggregate-assembler",
    evidence_scope,
    repository,
    repository_id: 1354613114,
    controller: {
      revision: expected.controller_revision,
      ref: expected.controller_ref,
      workflow: productionControllerWorkflow,
    },
    assembler: {
      run_id: expected.run_id,
      run_attempt: expected.run_attempt,
      job_id: identity.job_id,
      check_run_id: identity.check_run_id,
    },
    artifact: before,
    candidate: accepted,
    candidate_artifact_ids: ids,
    ...(accepted.public_build_inputs
      ? {
          public_build_inputs: accepted.public_build_inputs,
          public_build_inputs_scope: publicInputScope,
        }
      : {}),
    output_files: files,
    original_compiler: null,
    release_authorization: "not-evaluated",
    sbom_finalization: "not-evaluated",
  };
  if (Buffer.byteLength(JSON.stringify(predicate)) > 64 * 1024)
    throw new Error("aggregate predicate exceeds its bound");
  return {
    predicate_type: aggregatePredicateType,
    subject_name: before.name,
    subject_digest: `sha256:${before.sha256}`,
    predicate,
    authority: "none",
  };
}

/** Verify an existing Sigstore bundle with gh, then check its verified statement
 * and signed controller/run certificate against independent admission facts.
 * The attester's certificate does not identify the assembler's numeric job;
 * that association is the fixed trusted workflow's verified predicate claim.
 */
export async function verifyAggregateAttestation(
  privateRoot: string,
  rawArchive: Buffer,
  rawBundle: Buffer,
  rawExpected: {
    controller_revision: string;
    controller_ref: string;
    run_id: string;
    run_attempt: number;
    artifact_id: number;
    sha256: string;
    bytes: number;
    candidate: unknown;
    candidate_artifact_ids: number[];
    producer_profile?: "admitted-aggregate-v1" | "admitted-aggregate-recovery-v1";
    original_upload?: ReturnType<typeof inspectAggregateOriginalUpload>;
    native_custody?: ReturnType<typeof inspectNativeCheckpointLocator>;
  },
  options: NonNullable<Parameters<typeof verifyControllerArtifactStatement>[5]> = {},
) {
  const expected = structuredClone(rawExpected);
  const nativeCustody =
    expected.native_custody === undefined
      ? undefined
      : inspectNativeCheckpointLocator(expected.native_custody);
  const original =
    expected.original_upload === undefined
      ? undefined
      : inspectAggregateOriginalUpload(expected.original_upload);
  if ((expected.producer_profile === "admitted-aggregate-recovery-v1") !== !!original)
    throw new Error("aggregate recovery requires exact original upload association");
  if (
    nativeCustody &&
    (!expected.producer_profile ||
      (original && nativeCustody.checkpoint !== original.before_checkpoint))
  )
    throw new Error("native custody differs from fixed aggregate lineage");
  if (
    !Buffer.isBuffer(rawArchive) ||
    rawArchive.length < 22 ||
    rawArchive.length > maximumArchiveBytes ||
    !Buffer.isBuffer(rawBundle) ||
    rawBundle.length < 1 ||
    rawBundle.length > 512 * 1024
  )
    throw new Error("aggregate archive or bundle exceeds its byte bound");
  const archive = Buffer.from(rawArchive);
  const bundle = Buffer.from(rawBundle);
  digest(expected.sha256);
  positive(expected.artifact_id);
  positive(expected.run_attempt);
  positive(Number(expected.run_id));
  if (
    !Array.isArray(expected.candidate_artifact_ids) ||
    expected.candidate_artifact_ids.length < 1 ||
    expected.candidate_artifact_ids.length > 16 ||
    new Set(expected.candidate_artifact_ids).size !== expected.candidate_artifact_ids.length ||
    expected.candidate_artifact_ids.includes(expected.artifact_id)
  )
    throw new Error("aggregate expected candidate identities are incomplete");
  expected.candidate_artifact_ids.forEach(positive);
  if (
    !/^[a-f0-9]{40}$/u.test(expected.controller_revision) ||
    !/^refs\/tags\/portcove-production-controller-[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u.test(
      expected.controller_ref,
    ) ||
    !/^[1-9][0-9]{0,15}$/u.test(expected.run_id) ||
    archive.length !== expected.bytes ||
    hash(archive) !== expected.sha256
  )
    throw new Error("aggregate independently expected identity differs");
  const { accepted, files, platformCount } = await expectedMembers(expected.candidate);
  if (expected.candidate_artifact_ids.length !== platformCount)
    throw new Error("aggregate expected candidate artifact matrix is incomplete");
  if (accepted.run_id === expected.run_id)
    throw new Error("candidate run cannot impersonate trusted controller");
  if (
    accepted.public_build_inputs?.artifacts.some(
      (item) =>
        expected.candidate_artifact_ids.includes(item.artifact_id) ||
        item.artifact_id === expected.artifact_id,
    )
  )
    throw new Error("public input archive identities overlap packages or the aggregate");
  verifyMembers(archive, files);
  const directory = await mkdtemp(path.join(path.resolve(privateRoot), "aggregate-attestation-"));
  try {
    await mkdir(path.join(directory, "input"));
    const filename = path.join(directory, "input", "aggregate.zip");
    const bundlePath = path.join(directory, "input", "attestation.json");
    await writeFile(filename, archive, { flag: "wx", mode: 0o600 });
    await writeFile(bundlePath, bundle, { flag: "wx", mode: 0o600 });
    const statement = verifyControllerArtifactStatement(
      directory,
      filename,
      bundlePath,
      expected,
      aggregatePredicateType,
      options,
    );
    const name = `trusted-release-final-${original?.run_id ?? expected.run_id}-${original?.run_attempt ?? expected.run_attempt}`;
    if (
      statement._type !== "https://in-toto.io/Statement/v1" ||
      statement.predicateType !== aggregatePredicateType ||
      !same(statement.subject, [{ name, digest: { sha256: expected.sha256 } }]) ||
      !isRecord(statement.predicate)
    )
      throw new Error("aggregate verified subject or predicate type differs");
    const predicate = statement.predicate;
    if (!isRecord(predicate.assembler) || !isRecord(predicate.artifact))
      throw new Error("aggregate binding is incomplete");
    timestamp(predicate.artifact.created_at);
    if (predicate.artifact.expires_at !== null) timestamp(predicate.artifact.expires_at);
    positive(predicate.assembler.job_id);
    if (
      typeof predicate.assembler.check_run_id !== "string" ||
      !/^[1-9][0-9]{0,15}$/u.test(predicate.assembler.check_run_id)
    )
      throw new Error("aggregate signed check-run identity is invalid");
    const expectedPredicate = {
      schema_version: 1,
      ...(expected.producer_profile ? { producer_profile: expected.producer_profile } : {}),
      ...(original ? { original_upload: original } : {}),
      ...(nativeCustody ? { native_custody: nativeCustody } : {}),
      role: "package-aggregate-assembler",
      evidence_scope: "github.com",
      repository,
      repository_id: 1354613114,
      controller: {
        revision: expected.controller_revision,
        ref: expected.controller_ref,
        workflow: productionControllerWorkflow,
      },
      assembler: {
        run_id: expected.run_id,
        run_attempt: expected.run_attempt,
        job_id: predicate.assembler.job_id,
        check_run_id: predicate.assembler.check_run_id,
      },
      artifact: {
        id: expected.artifact_id,
        name,
        bytes: expected.bytes,
        sha256: expected.sha256,
        created_at: predicate.artifact.created_at,
        expires_at: predicate.artifact.expires_at,
      },
      candidate: accepted,
      candidate_artifact_ids: expected.candidate_artifact_ids,
      ...(accepted.public_build_inputs
        ? {
            public_build_inputs: accepted.public_build_inputs,
            public_build_inputs_scope: publicInputScope,
          }
        : {}),
      output_files: files,
      original_compiler: null,
      release_authorization: "not-evaluated",
      sbom_finalization: "not-evaluated",
    };
    if (!same(predicate, expectedPredicate))
      throw new Error("aggregate predicate association differs from independently admitted facts");
    return {
      schema_version: 1,
      directory,
      artifact_id: expected.artifact_id,
      sha256: expected.sha256,
      assembler: predicate.assembler,
      ...(nativeCustody ? { native_custody: nativeCustody } : {}),
      evidence_scope: options.spawn ? "injected-provider" : "github.com",
      original_compiler: null,
      release_authorization: "not-evaluated",
      sbom_finalization: "not-evaluated",
      authority: "none",
    };
  } catch (cause) {
    throw new Error(`aggregate attestation refused; retain owned directory ${directory}`, {
      cause,
    });
  }
}

/** Read-only downstream consumer of the fixed controller's actual upload IDs.
 * Expectations come from its admitted descriptor and trusted job outputs, never
 * from parsing an unverified bundle. This proves the aggregate association only;
 * original compilation and independent release eligibility remain separate.
 */
export async function verifyUploadedAggregate(
  privateRoot: string,
  rawExpected: Omit<Parameters<typeof verifyAggregateAttestation>[3], "bytes"> & {
    bundle_artifact_id: number;
    bundle_sha256: string;
  },
  options: {
    spawn?: RetainedGitHubSpawn;
    download?: SigningArchiveDownload;
    readMetadata?: (route: string) => Promise<unknown>;
  } = {},
) {
  const { spawn, download: injectedDownload, readMetadata } = options;
  const scopedEnvironment = readOnlyReleaseChildEnvironment();
  const token = (scopedEnvironment ?? process.env).GH_TOKEN ?? "";
  const expected = structuredClone(rawExpected);
  const original =
    expected.original_upload === undefined
      ? undefined
      : inspectAggregateOriginalUpload(expected.original_upload);
  if ((expected.producer_profile === "admitted-aggregate-recovery-v1") !== !!original)
    throw new Error("aggregate recovered receiver requires exact original upload");
  positive(expected.artifact_id);
  positive(expected.bundle_artifact_id);
  digest(expected.sha256);
  digest(expected.bundle_sha256);
  positive(expected.run_attempt);
  positive(Number(expected.run_id));
  if (
    !/^[a-f0-9]{40}$/u.test(expected.controller_revision) ||
    !/^refs\/tags\/portcove-production-controller-[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u.test(
      expected.controller_ref,
    ) ||
    !/^[1-9][0-9]{0,15}$/u.test(expected.run_id) ||
    expected.artifact_id === expected.bundle_artifact_id ||
    !Array.isArray(expected.candidate_artifact_ids) ||
    expected.candidate_artifact_ids.includes(expected.bundle_artifact_id)
  )
    throw new Error("aggregate verification requires distinct exact trusted upload identities");
  const { accepted, platformCount } = await expectedMembers(expected.candidate);
  if (
    accepted.public_build_inputs?.artifacts.some(
      (item) => item.artifact_id === expected.bundle_artifact_id,
    )
  )
    throw new Error("public input archive cannot impersonate the trusted attestation bundle");
  if (
    expected.candidate_artifact_ids.length !== platformCount ||
    new Set(expected.candidate_artifact_ids).size !== platformCount ||
    expected.candidate_artifact_ids.includes(expected.artifact_id) ||
    accepted.run_id === expected.run_id
  )
    throw new Error("aggregate verification candidate identities differ");
  expected.candidate_artifact_ids.forEach(positive);
  const directory = await mkdtemp(path.join(path.resolve(privateRoot), "aggregate-verification-"));
  const deadline = Math.min(
    performance.now() + 10 * 60 * 1000,
    coordinatorCommandDeadline() ?? Infinity,
  );
  let phase = "provider-before";
  let requests = 0;
  try {
    const budget = () => {
      if (performance.now() >= deadline)
        throw new Error("aggregate verification deadline exhausted");
    };
    budget();
    const credential = { kind: "explicit" as const, token };
    const scopedFetch: typeof globalThis.fetch = (input, init) => {
      assertTrustedDirectNode("aggregate receiver");
      return globalThis.fetch(input, init);
    };
    const base = `/repos/${repository}/`;
    const runRoute = `actions/runs/${expected.run_id}`;
    const attemptRoute = `${runRoute}/attempts/${expected.run_attempt}`;
    const aggregateRoute = `actions/artifacts/${expected.artifact_id}`;
    const bundleRoute = `actions/artifacts/${expected.bundle_artifact_id}`;
    const routes = new Set(
      [runRoute, attemptRoute, aggregateRoute, bundleRoute].map((route) => base + route),
    );
    let read = readMetadata;
    if (!read) {
      const { createGitHubClient } = await import("./github-client.mts");
      const client = await createGitHubClient({
        credential,
        deadline,
        maxBytes: 128 * 1024,
        allowRequest: (method, url) => method === "GET" && !url.search && routes.has(url.pathname),
        ...(scopedEnvironment ? { fetch: scopedFetch } : {}),
      });
      read = async (route) => {
        const response = await client.request(`GET ${base}${route}`, {
          request: { portcove: { replay: "once", attempts: 0 } },
        });
        if (response.status !== 200) throw new Error("aggregate verification provider unavailable");
        return response.data as unknown;
      };
    }
    const readExact = read;
    const get = async (route: string) => {
      budget();
      if (++requests > 8) throw new Error("aggregate verification API read bound exhausted");
      const body = await readExact(route);
      budget();
      return body;
    };
    const run = async (route: string) => {
      const raw = await get(route);
      if (
        !isRecord(raw) ||
        raw.id !== Number(expected.run_id) ||
        raw.run_attempt !== expected.run_attempt ||
        raw.head_sha !== expected.controller_revision ||
        raw.path !== productionControllerWorkflow ||
        raw.event !== "workflow_dispatch" ||
        !isRecord(raw.repository) ||
        raw.repository.id !== 1354613114 ||
        raw.repository.full_name !== repository ||
        !isRecord(raw.head_repository) ||
        raw.head_repository.id !== 1354613114 ||
        !["in_progress", "completed"].includes(String(raw.status)) ||
        (raw.conclusion !== null && raw.conclusion !== "success")
      )
        throw new Error("aggregate controller run/attempt/source differs");
      // This job runs inside its still-active controller. A completed-Release
      // collector would create a completion cycle and is deliberately not used.
      return {
        id: raw.id,
        attempt: raw.run_attempt,
        source: raw.head_sha,
        status: raw.status,
        conclusion: raw.conclusion,
      };
    };
    const snapshot = async () => ({
      run: await run(runRoute),
      attempt: await run(attemptRoute),
      aggregate: artifact(
        await get(aggregateRoute),
        expected.artifact_id,
        expected.sha256,
        original ?? expected,
      ),
      bundle: artifact(
        await get(bundleRoute),
        expected.bundle_artifact_id,
        expected.bundle_sha256,
        expected,
        `trusted-release-attestation-${expected.run_id}-${expected.run_attempt}`,
        1024 * 1024,
      ),
    });
    const before = await snapshot();
    phase = "opaque-download";
    const download = async (id: number, item: { bytes: number; sha256: string }) => {
      budget();
      const transferDeadline = Math.min(deadline, performance.now() + 120000);
      const timeoutMs = Math.floor(transferDeadline - performance.now());
      if (timeoutMs < 1) throw new Error("aggregate verification archive deadline exhausted");
      const endpoint = `repos/${repository}/actions/artifacts/${id}/zip`;
      const received = injectedDownload
        ? await injectedDownload(endpoint, { cwd: directory, maxBytes: item.bytes, timeoutMs })
        : await acquireAggregateArchive(directory, endpoint, {
            credential,
            deadline: transferDeadline,
            maxBytes: item.bytes,
            ...(scopedEnvironment ? { fetch: scopedFetch } : {}),
          });
      if (performance.now() >= transferDeadline)
        throw new Error("aggregate verification archive deadline exhausted");
      if (!Buffer.isBuffer(received) || received.length !== item.bytes)
        throw new Error("aggregate verification archive length differs");
      const archive = Buffer.from(received);
      if (hash(archive) !== item.sha256)
        throw new Error("aggregate verification archive digest differs");
      budget();
      return archive;
    };
    const archive = await download(expected.artifact_id, before.aggregate);
    const bundleArchive = await download(expected.bundle_artifact_id, before.bundle);
    phase = "retain-opaque-inputs";
    await mkdir(path.join(directory, "input"));
    await writeFile(path.join(directory, "input", "aggregate.zip"), archive, {
      flag: "wx",
      mode: 0o600,
    });
    await writeFile(path.join(directory, "input", "bundle.zip"), bundleArchive, {
      flag: "wx",
      mode: 0o600,
    });
    budget();
    phase = "bundle-preflight";
    const { entries } = inspectBoundedZip(bundleArchive, {
      compressedBytes: 1024 * 1024,
      expandedBytes: 512 * 1024,
      files: 1,
      nameBytes: 64,
      allowedPaths: new Set(["aggregate-attestation.json"]),
    });
    const entry = entries[0];
    if (entries.length !== 1 || !entry || entry.bytes < 1)
      throw new Error("aggregate verification bundle inventory differs");
    const compressed = bundleArchive.subarray(entry.data, entry.dataEnd);
    const bundle =
      entry.method === 0
        ? Buffer.from(compressed)
        : inflateRawSync(compressed, { maxOutputLength: entry.bytes });
    if (bundle.length !== entry.bytes || crc32(bundle) !== entry.crc)
      throw new Error("aggregate verification bundle bytes differ");
    phase = "pinned-attestation-verifier";
    const verification = await verifyAggregateAttestation(
      directory,
      archive,
      bundle,
      { ...expected, bytes: before.aggregate.bytes },
      {
        ...(spawn ? { spawn } : {}),
        ...(scopedEnvironment ? { environment: scopedEnvironment } : {}),
        deadline,
      },
    );
    phase = "provider-after";
    if (!same(before, await snapshot()))
      throw new Error("aggregate verification provider identities changed");
    budget();
    return {
      ...verification,
      acquisition_directory: directory,
      bundle_artifact_id: expected.bundle_artifact_id,
      bundle_sha256: expected.bundle_sha256,
      evidence_scope:
        spawn || injectedDownload || readMetadata ? "injected-provider" : "github.com",
      api_requests: requests,
    };
  } catch {
    const evidence = {
      directory,
      phase,
      artifact_id: expected.artifact_id,
      sha256: expected.sha256,
      bundle_artifact_id: expected.bundle_artifact_id,
      bundle_sha256: expected.bundle_sha256,
      controller_revision: expected.controller_revision,
      run_id: expected.run_id,
      run_attempt: expected.run_attempt,
      api_requests: requests,
      authority: "none",
    };
    try {
      await writeFile(path.join(directory, "verification-failure.json"), JSON.stringify(evidence), {
        flag: "wx",
        mode: 0o600,
      });
    } catch {
      // Return the owned location even when storage itself failed.
    }
    throw new CoordinatorRemoteError(
      "aggregate uploaded verification refused; retain owned evidence",
      evidence,
    );
  }
}

/** Exact opaque member bytes only; no provenance or publication authority. */
export async function verifyAggregateUploadBytes(archive: Buffer, assembly: unknown) {
  const { files } = await expectedMembers(assembly);
  verifyMembers(archive, files);
  return files;
}

/** Maintained complete-pipeline receiver fixes the admitted producer contract. */
export function verifyAdmittedUploadedAggregate(
  ...args: Parameters<typeof verifyUploadedAggregate>
) {
  return verifyUploadedAggregate(
    args[0],
    {
      ...args[1],
      producer_profile: args[1].original_upload
        ? "admitted-aggregate-recovery-v1"
        : "admitted-aggregate-v1",
    },
    args[2],
  );
}
