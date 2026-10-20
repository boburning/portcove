import { verifyControllerArtifactStatement } from "./github-controller-attestation.mts";
import { orderedJsonValue as canonical } from "./json-values.mts";
import { createHash } from "node:crypto";
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
    evidenceRequest?: ReleaseEvidenceRequest;
    evidence?: ReleaseEvidenceOptions;
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
  let publicBefore: ReturnType<typeof collectReleaseRunEvidence> | null = null;
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
    publicBefore = collectReleaseRunEvidence(publicRequest, options.evidence);
    publicVerification = await verifyReleasePublicBuildInputs(
      options.cwd,
      accepted.public_build_inputs,
      publicBefore,
      { download: options.download },
    );
  }
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
  if (accepted.public_build_inputs && publicBefore && publicRequest)
    requireStablePublicBuildInputEvidence(
      accepted.public_build_inputs,
      publicBefore,
      collectReleaseRunEvidence(publicRequest, options.evidence),
    );
  if (Date.now() >= Date.parse(identity.expires_at))
    throw new Error("assembler identity expired before binding completed");
  const evidence_scope =
    options.spawn ||
    options.download ||
    identity.evidence_scope !== "github.com" ||
    (accepted.public_build_inputs &&
      (options.evidence || publicVerification?.evidence_scope !== "github.com"))
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
  options: { spawn?: Spawn; download?: typeof readGitHubArtifactArchive } = {},
) {
  const expected = structuredClone(rawExpected);
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
  const started = performance.now();
  let phase = "provider-before";
  let requests = 0;
  try {
    const runner = createGitHubRunner({
      cwd: directory,
      ...(options.spawn ? { spawn: options.spawn } : {}),
      maxBuffer: 128 * 1024,
      timeoutMs: 15000,
    });
    const budget = () => {
      if (performance.now() - started > 10 * 60 * 1000)
        throw new Error("aggregate verification deadline exhausted");
    };
    const get = (route: string) => {
      budget();
      if (++requests > 8) throw new Error("aggregate verification API read bound exhausted");
      const response = parseIncludedResponse(
        runner([
          "api",
          `repos/${repository}/${route}`,
          "--include",
          "--method",
          "GET",
          "--hostname",
          "github.com",
        ]),
      );
      if (response.status !== 200) throw new Error("aggregate verification provider unavailable");
      budget();
      return response.body;
    };
    const run = (route: string) => {
      const raw = get(route);
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
    const snapshot = () => ({
      run: run(`actions/runs/${expected.run_id}`),
      attempt: run(`actions/runs/${expected.run_id}/attempts/${expected.run_attempt}`),
      aggregate: artifact(
        get(`actions/artifacts/${expected.artifact_id}`),
        expected.artifact_id,
        expected.sha256,
        expected,
      ),
      bundle: artifact(
        get(`actions/artifacts/${expected.bundle_artifact_id}`),
        expected.bundle_artifact_id,
        expected.bundle_sha256,
        expected,
        `trusted-release-attestation-${expected.run_id}-${expected.run_attempt}`,
        1024 * 1024,
      ),
    });
    const before = snapshot();
    phase = "opaque-download";
    const download = (id: number, item: { bytes: number; sha256: string }) => {
      budget();
      const received = (options.download ?? readGitHubArtifactArchive)(
        `repos/${repository}/actions/artifacts/${id}/zip`,
        { cwd: directory, maxBytes: item.bytes, timeoutMs: 120000 },
      );
      if (!Buffer.isBuffer(received) || received.length !== item.bytes)
        throw new Error("aggregate verification archive length differs");
      const archive = Buffer.from(received);
      if (hash(archive) !== item.sha256)
        throw new Error("aggregate verification archive digest differs");
      budget();
      return archive;
    };
    const archive = download(expected.artifact_id, before.aggregate);
    const bundleArchive = download(expected.bundle_artifact_id, before.bundle);
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
      options,
    );
    phase = "provider-after";
    if (!same(before, snapshot()))
      throw new Error("aggregate verification provider identities changed");
    budget();
    return {
      ...verification,
      acquisition_directory: directory,
      bundle_artifact_id: expected.bundle_artifact_id,
      bundle_sha256: expected.bundle_sha256,
      evidence_scope: options.spawn || options.download ? "injected-provider" : "github.com",
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
