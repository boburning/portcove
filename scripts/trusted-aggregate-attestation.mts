import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import path from "node:path";
import { crc32, inflateRawSync } from "node:zlib";
import { inspectBoundedZip } from "./bounded-zip.mts";
import {
  inspectAssemblerIdentityExpectation,
  verifyAssemblerJobIdentity,
} from "./assembler-job-identity.mts";
import type { AssemblerIdentityExpectation } from "./assembler-job-identity.mts";
import { inspectTrustedAssemblyInput } from "./trusted-release-assembly.mts";
import { artifactName } from "./release-package-policy.mts";
import { readGitHubArtifactArchive } from "./github-binary.mts";
import { createGitHubRunner, parseIncludedResponse } from "./github-api.mts";
import { productionControllerWorkflow } from "./production-controller-admission.mts";
import { isRecord } from "./runtime-values.mts";

export const aggregatePredicateType = "https://portcove.dev/attestations/package-aggregate/v1";
const repository = "boburning/portcove";
const maximumArchiveBytes = 512 * 1024 * 1024;
const hash = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
type IdentityOptions = Parameters<typeof verifyAssemblerJobIdentity>[2];
type Spawn = NonNullable<NonNullable<Parameters<typeof createGitHubRunner>[0]>["spawn"]>;

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
  const canonical = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(canonical);
    if (isRecord(value))
      return Object.fromEntries(
        Object.keys(value)
          .sort()
          .map((key) => [key, canonical(value[key])]),
      );
    return value;
  };
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
  }
}

function artifact(
  raw: unknown,
  id: number,
  sha256: string,
  expected: AssemblerIdentityExpectation,
) {
  if (
    !isRecord(raw) ||
    raw.id !== id ||
    raw.name !== `trusted-release-final-${expected.run_id}-${expected.run_attempt}` ||
    raw.expired !== false ||
    raw.digest !== `sha256:${sha256}` ||
    typeof raw.size_in_bytes !== "number" ||
    !Number.isSafeInteger(raw.size_in_bytes) ||
    raw.size_in_bytes < 22 ||
    raw.size_in_bytes > maximumArchiveBytes ||
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

/** Invoked only by reviewed fixed controller code after real assembly/upload.
 * Independently authenticate input authority before calling. This verifies the
 * actual uploaded opaque archive's members, then invokes fresh signed own-job
 * verification itself. A supplied identity receipt cannot replace that call.
 * The result is input to existing actions/attest, never a signature or grant.
 */
export async function prepareAggregateAttestation(
  token: string,
  rawExpected: AssemblerIdentityExpectation,
  rawRequest: unknown,
  rawCandidateArtifactIds: readonly number[],
  rawUpload: { artifact_id: number; sha256: string },
  options: {
    cwd: string;
    identity?: IdentityOptions;
    spawn?: Spawn;
    download?: typeof readGitHubArtifactArchive;
  },
) {
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
  const { accepted, files, platformCount } = await expectedMembers(request);
  if (ids.length !== platformCount)
    throw new Error("aggregate candidate artifact matrix is incomplete");
  if (accepted.run_id === expected.run_id)
    throw new Error("candidate run cannot impersonate its trusted assembler run");
  const runner = createGitHubRunner({
    cwd: options.cwd,
    ...(options.spawn ? { spawn: options.spawn } : {}),
    maxBuffer: 128 * 1024,
    timeoutMs: 15000,
  });
  const get = () => {
    const response = parseIncludedResponse(
      runner([
        "api",
        `repos/${repository}/actions/artifacts/${upload.artifact_id}`,
        "--include",
        "--method",
        "GET",
        "--hostname",
        "github.com",
      ]),
    );
    if (response.status !== 200) throw new Error("new aggregate artifact unavailable");
    return artifact(response.body, upload.artifact_id, upload.sha256, expected);
  };
  const before = get();
  const downloaded = (options.download ?? readGitHubArtifactArchive)(
    `repos/${repository}/actions/artifacts/${upload.artifact_id}/zip`,
    { cwd: options.cwd, maxBytes: before.bytes, timeoutMs: 120000 },
  );
  if (!Buffer.isBuffer(downloaded) || downloaded.length !== before.bytes)
    throw new Error("uploaded aggregate archive digest differs");
  const archive = Buffer.from(downloaded);
  if (hash(archive) !== upload.sha256) throw new Error("uploaded aggregate archive digest differs");
  verifyMembers(archive, files);
  const identity = await verifyAssemblerJobIdentity(
    token,
    expected,
    options.identity ?? { transport: { cwd: options.cwd } },
  );
  if (!same(get(), before)) throw new Error("new aggregate artifact changed during binding");
  if (Date.now() >= Date.parse(identity.expires_at))
    throw new Error("assembler identity expired before binding completed");
  const evidence_scope =
    options.spawn || options.download || identity.evidence_scope !== "github.com"
      ? "injected-provider"
      : "github.com";
  const predicate = {
    schema_version: 1,
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
  },
  options: { spawn?: Spawn } = {},
) {
  const expected = structuredClone(rawExpected);
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
  verifyMembers(archive, files);
  const directory = await mkdtemp(path.join(path.resolve(privateRoot), "aggregate-attestation-"));
  try {
    await mkdir(path.join(directory, "input"));
    const filename = path.join(directory, "input", "aggregate.zip");
    const bundlePath = path.join(directory, "input", "attestation.json");
    await writeFile(filename, archive, { flag: "wx", mode: 0o600 });
    await writeFile(bundlePath, bundle, { flag: "wx", mode: 0o600 });
    const runner = createGitHubRunner({
      cwd: directory,
      spawn:
        options.spawn ??
        ((command, args, settings) =>
          spawnSync(command, args, {
            ...settings,
            env: { ...process.env, GH_HOST: "github.com" },
          })),
      maxBuffer: 1024 * 1024,
      timeoutMs: 30000,
    });
    const raw: unknown = JSON.parse(
      runner([
        "attestation",
        "verify",
        filename,
        "--bundle",
        bundlePath,
        "--repo",
        repository,
        "--signer-workflow",
        `${repository}/${productionControllerWorkflow}`,
        "--signer-digest",
        expected.controller_revision,
        "--source-digest",
        expected.controller_revision,
        "--source-ref",
        expected.controller_ref,
        "--cert-oidc-issuer",
        "https://token.actions.githubusercontent.com",
        "--deny-self-hosted-runners",
        "--predicate-type",
        aggregatePredicateType,
        "--format",
        "json",
      ]),
    );
    if (
      !Array.isArray(raw) ||
      raw.length !== 1 ||
      !isRecord(raw[0]) ||
      !isRecord(raw[0].verificationResult)
    )
      throw new Error("aggregate bundle verification is missing or ambiguous");
    const result = raw[0].verificationResult;
    if (
      !isRecord(result.signature) ||
      !isRecord(result.signature.certificate) ||
      !Array.isArray(result.verifiedTimestamps) ||
      result.verifiedTimestamps.length < 1 ||
      !isRecord(result.statement)
    )
      throw new Error("aggregate verified certificate, timestamp or statement is absent");
    const certificate = result.signature.certificate;
    const workflowUri = `https://github.com/${repository}/${productionControllerWorkflow}@${expected.controller_ref}`;
    if (
      certificate.issuer !== "https://token.actions.githubusercontent.com" ||
      certificate.sourceRepositoryIdentifier !== "1354613114" ||
      certificate.sourceRepositoryURI !== `https://github.com/${repository}` ||
      certificate.buildSignerURI !== workflowUri ||
      certificate.buildSignerDigest !== expected.controller_revision ||
      certificate.sourceRepositoryDigest !== expected.controller_revision ||
      certificate.sourceRepositoryRef !== expected.controller_ref ||
      certificate.runnerEnvironment !== "github-hosted" ||
      certificate.runInvocationURI !==
        `https://github.com/${repository}/actions/runs/${expected.run_id}/attempts/${expected.run_attempt}`
    )
      throw new Error("aggregate attester certificate identity differs");
    const statement = result.statement;
    const name = `trusted-release-final-${expected.run_id}-${expected.run_attempt}`;
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
