import {
  inspectAggregateOriginalUpload,
  inspectControllerAggregateLocator,
} from "./release-aggregate-locator.mts";
export { inspectControllerAggregateLocator } from "./release-aggregate-locator.mts";
/** Read-only controller integration. Acquires existing authority observations;
 * it cannot create admission, sign, allocate or publish. */
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { mkdir, open, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { isDeepStrictEqual } from "node:util";
import { crc32, inflateRawSync } from "node:zlib";
import {
  acquireReleaseAdmissionWithControlHandshake,
  requireActualReleaseAdmissionContext,
} from "./acquire-release-admission.mts";
import { inspectReleaseCompilerSourceClosure } from "./release-compiler-source-closure.mts";
import { collectConfiguredNativeReleaseQualificationPair } from "./release-native-admission.mts";
import { requireControllerReleaseAuthorities } from "./release-authority-configuration.mts";
import { requireNativeReleaseQualificationPair } from "./release-native-admission.mts";
import { requireVerifiedReleaseSbomDocument } from "./release-acceptance-evidence.mts";
import {
  authenticateCapacityExecutor,
  capacityExecutorIdentity,
  executeOwnedCapacityEffect,
} from "./release-capacity-executor.mts";
import { handoffSigningOutput } from "./release-signing-handoff.mts";
import { performance } from "node:perf_hooks";
import { requireReservedAggregate } from "./production-aggregate-steps.mts";
import { readRemoteCoordinatorSnapshot } from "./release-coordinator-recovery.mts";
import {
  verifyAdmittedUploadedAggregate,
  verifyUploadedAggregate,
} from "./trusted-aggregate-attestation.mts";
import { inspectTrustedAssemblyInput } from "./trusted-release-assembly.mts";
import { artifactName } from "./release-package-policy.mts";
import { inspectBoundedZip } from "./bounded-zip.mts";
import { assertOwnedUnlinkedPath } from "./release-path-safety.mts";
import { inspectPayloadSigningRequest, signReleasePayload } from "./release-payload-signing.mts";
import {
  receiveControllerTools,
  verifiedControllerToolPaths,
} from "./release-controller-tool-admission.mts";
import type { ControllerToolArtifactExpected } from "./release-controller-tool-admission.mts";
import { receiveIsolatedRoleKey } from "./release-role-key-channel.mts";
import { authenticateReleaseControlRound } from "./release-live-control-admission.mts";
import { createGitHubRunner, GitHubApiClient } from "./github-api.mts";
import { releaseControlRefQuery } from "./release-control-inputs.mts";
import { orderedJsonValue } from "./json-values.mts";
import { isRecord } from "./runtime-values.mts";
import {
  requestAssemblerToken,
  inspectAssemblerIdentityExpectation,
  verifyPayloadSignerJobIdentity,
} from "./assembler-job-identity.mts";

const hash = (bytes: Buffer | string) => createHash("sha256").update(bytes).digest("hex");
const sha256 = /^[a-f0-9]{64}$/;
const project = fileURLToPath(new URL("..", import.meta.url));
// A fixed payload job starts a fresh process before receiving trusted tools.
// The receiver must not silently add time outside the role's total deadline.
const payloadPhaseStarted = performance.now();
let payloadPhaseDeadline = payloadPhaseStarted + 570000;
export function payloadSigningPhaseDeadline() {
  return payloadPhaseDeadline;
}
/** The dependency-free launcher may only preserve/tighten the original budget,
 * including its first verified tool acquisition before this bundle loads. */
export function tightenPayloadSigningPhaseDeadline(deadline: number) {
  if (!Number.isFinite(deadline) || deadline <= performance.now())
    throw new Error("payload role total phase deadline exhausted");
  payloadPhaseDeadline = Math.min(payloadPhaseDeadline, deadline);
}
type AggregateExpected = Omit<
  Parameters<typeof verifyUploadedAggregate>[1],
  "candidate" | "candidate_artifact_ids"
>;
interface PreparationConfig {
  projectRoot: string;
  output: string;
  admission_configuration: Record<string, unknown> & { namespace: string };
  aggregate: AggregateExpected;
  publicKey: string;
  public_key_sha256: string;
}

export function inspectPayloadPreparationConfiguration(raw: unknown): PreparationConfig {
  const value: unknown = structuredClone(raw);
  if (
    !isRecord(value) ||
    Object.keys(value).sort().join(",") !==
      "admission_configuration,aggregate,output,projectRoot,publicKey,public_key_sha256" ||
    typeof value.projectRoot !== "string" ||
    typeof value.output !== "string" ||
    typeof value.publicKey !== "string" ||
    typeof value.public_key_sha256 !== "string" ||
    !sha256.test(value.public_key_sha256) ||
    !isRecord(value.admission_configuration) ||
    typeof value.admission_configuration.namespace !== "string" ||
    !isRecord(value.aggregate)
  )
    throw new Error("fixed controller payload preparation configuration is incomplete");
  const aggregate = inspectControllerAggregateLocator(value.aggregate);
  return {
    projectRoot: value.projectRoot,
    output: value.output,
    publicKey: value.publicKey,
    public_key_sha256: value.public_key_sha256,
    admission_configuration: {
      ...value.admission_configuration,
      namespace: value.admission_configuration.namespace,
    },
    aggregate: {
      controller_revision: aggregate.controller_revision,
      controller_ref: aggregate.controller_ref,
      run_id: aggregate.run_id,
      run_attempt: aggregate.run_attempt,
      artifact_id: aggregate.artifact_id,
      sha256: aggregate.sha256,
      bundle_artifact_id: aggregate.bundle_artifact_id,
      bundle_sha256: aggregate.bundle_sha256,
      ...(aggregate.original_upload ? { original_upload: aggregate.original_upload } : {}),
    },
  };
}

async function readBounded(filename: string, maximum: number) {
  const handle = await open(
    filename,
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
  );
  try {
    const before = await handle.stat();
    if (!before.isFile() || before.nlink !== 1 || before.size < 1 || before.size > maximum)
      throw new Error("public preparation input exceeds regular-file limits");
    const chunks: Buffer[] = [];
    let size = 0;
    for (;;) {
      const buffer = Buffer.alloc(Math.min(64 * 1024, maximum - size + 1));
      const { bytesRead } = await handle.read(buffer);
      if (!bytesRead) break;
      size += bytesRead;
      if (size > maximum) throw new Error("public preparation input exceeds byte bound");
      chunks.push(buffer.subarray(0, bytesRead));
    }
    const after = await handle.stat();
    if (
      size !== before.size ||
      before.size !== after.size ||
      before.mtimeMs !== after.mtimeMs ||
      before.ctimeMs !== after.ctimeMs
    )
      throw new Error("public preparation input changed during acquisition");
    return Buffer.concat(chunks);
  } finally {
    await handle.close();
  }
}

/** Materialization only, not an authority interface. The controller invokes it
 * only after the existing verifier authenticates the complete aggregate. */
export async function stageAggregateSigningInputs(
  directory: string,
  rawArchive: Buffer,
  rawAssembly: unknown,
  rawBinding: {
    aggregate_archive_sha256: string;
    reservation_checkpoint: string;
    qualification_inventory_sha256: string;
    public_key_sha256: string;
    producer: { run_id: string; run_attempt: number; job_id: string; artifact_id: string };
  },
) {
  if (!Buffer.isBuffer(rawArchive) || rawArchive.length < 22 || rawArchive.length > 512 * 1024 ** 2)
    throw new Error("aggregate payload archive exceeds byte bounds");
  const archive = Buffer.from(rawArchive);
  const binding = structuredClone(rawBinding);
  if (
    Object.keys(binding).sort().join(",") !==
    "aggregate_archive_sha256,producer,public_key_sha256,qualification_inventory_sha256,reservation_checkpoint"
  )
    throw new Error("aggregate payload binding has unexpected fields");
  if (archive.length > 512 * 1024 ** 2 || hash(archive) !== binding.aggregate_archive_sha256)
    throw new Error("verified aggregate archive binding differs");
  const { accepted, policy } = await inspectTrustedAssemblyInput(rawAssembly);
  if (accepted.schema_version === 1 || accepted.release_profile !== "initial-beta-win-linux")
    throw new Error("payload preparation requires the exact initial beta profile");
  const files = policy.packages
    .map((entry) => {
      const filename = artifactName(entry, accepted.version);
      const member = accepted.files.find(
        (file) => file.filename === filename && file.platform_label === entry.platform_label,
      );
      if (!member) throw new Error("aggregate package inventory is incomplete");
      return member;
    })
    .sort((a, b) => a.filename.localeCompare(b.filename));
  const checksum = Buffer.from(files.map((file) => `${file.sha256}  ${file.filename}\n`).join(""));
  const expected = [
    ...files,
    { filename: policy.checksum_manifest, bytes: checksum.length, sha256: hash(checksum) },
  ];
  const { entries } = inspectBoundedZip(archive, {
    compressedBytes: 512 * 1024 ** 2,
    expandedBytes: expected.reduce((sum, file) => sum + file.bytes, 0),
    files: expected.length,
    nameBytes: 256,
    allowedPaths: new Set(expected.map((file) => file.filename)),
  });
  if (entries.length !== expected.length)
    throw new Error("aggregate complete member inventory differs");
  for (const entry of entries)
    if (expected.find((file) => file.filename === entry.name)?.bytes !== entry.bytes)
      throw new Error("aggregate member length differs");
  // Validate all members before creating output. Only two opaque packages are
  // retained; no archive member is executed and no arbitrary extraction occurs.
  const payloads: {
    filename: string;
    bytes: Buffer;
    request: ReturnType<typeof inspectPayloadSigningRequest>;
  }[] = [];
  for (const entry of entries) {
    const compressed = archive.subarray(entry.data, entry.dataEnd);
    const bytes =
      entry.method === 0
        ? compressed
        : inflateRawSync(compressed, { maxOutputLength: entry.bytes });
    const member = expected.find((file) => file.filename === entry.name)!;
    if (
      bytes.length !== member.bytes ||
      crc32(bytes) !== entry.crc ||
      hash(bytes) !== member.sha256
    )
      throw new Error("aggregate package bytes differ from accepted inventory");
    const updater = policy.packages.find(
      (file) =>
        artifactName(file, accepted.version) === entry.name &&
        ["nsis", "appimage"].includes(file.format),
    );
    if (updater) {
      const request = inspectPayloadSigningRequest({
        schema_version: 1,
        repository: "boburning/portcove",
        source_commit: accepted.source_commit,
        version: accepted.version,
        platform_label: updater.platform_label,
        filename: entry.name,
        bytes: member.bytes,
        sha256: member.sha256,
        ...binding,
      });
      payloads.push({ filename: entry.name, bytes, request });
    }
  }
  if (payloads.length !== 2) throw new Error("both beta updater payloads are required");
  await mkdir(directory, { mode: 0o700 });
  for (const payload of payloads)
    await writeFile(path.join(directory, payload.filename), payload.bytes, {
      flag: "wx",
      mode: 0o600,
    });
  return payloads
    .map(({ request }) => request)
    .sort((a, b) => a.filename.localeCompare(b.filename));
}

/** No injected admission/verifier receipt can enter this boundary. Existing
 * provider-reader options remain fixture-scoped by their owning collectors. */
export async function prepareControllerPayloadSigning(
  rawConfig: unknown,
  options: {
    aggregate?: Parameters<typeof verifyUploadedAggregate>[2];
  } = {},
) {
  return preparePayloadSigning(rawConfig, options);
}

type PositiveContext = Parameters<
  NonNullable<Parameters<typeof acquireReleaseAdmissionWithControlHandshake>[4]>
>[0];
type PreparedPayloads = {
  requests: ReturnType<typeof inspectPayloadSigningRequest>[];
  verification: Awaited<ReturnType<typeof verifyUploadedAggregate>>;
};
type PrivateSignatures = {
  context: PositiveContext;
  prepared: PreparedPayloads;
  tools: object;
  directory: string;
  signatures: Awaited<ReturnType<typeof signReleasePayload>>[];
  settlement: Awaited<ReturnType<typeof executeOwnedCapacityEffect>>;
  handoff: Awaited<ReturnType<typeof handoffSigningOutput>>;
  control_round: number;
};
const actualSignatures = new WeakMap<object, PrivateSignatures>();
export async function nextPreparedPayloadControlRound(receipt: object) {
  await requirePreparedPayloadSignatures(receipt);
  const actual = actualSignatures.get(receipt)!;
  if (actual.control_round >= 12) throw new Error("fixed payload control rounds exhausted");
  return ++actual.control_round;
}

/** Genuine local crypto, immutable output readback and existing journal
 * settlement. Cross-job attestation and post-sign qualification remain required;
 * this cannot authorize publishing. */
export async function requirePreparedPayloadSignatures(raw: object) {
  const retained = actualSignatures.get(raw);
  if (!retained) throw new Error("actual same-process payload signatures required");
  const context = requireActualReleaseAdmissionContext(retained.context, "payload-signing");
  const tools = await verifiedControllerToolPaths(retained.tools);
  const native = await requireNativeReleaseQualificationPair(
    context.native_qualifications,
    context.facts.assembly,
    context.facts.archives,
    "payload-signing",
  );
  const sbom = await requireVerifiedReleaseSbomDocument(context.sbom_receipt);
  const signatures = [];
  for (const item of retained.signatures) {
    const file = path.join(
      retained.directory,
      `signature-${item.request.platform_label}`,
      item.signature.filename,
    );
    const bytes = await readBounded(file, 16 * 1024);
    if (bytes.length !== item.signature.bytes || hash(bytes) !== item.signature.sha256)
      throw new Error("actual retained payload signature changed");
    signatures.push(Object.freeze({ ...structuredClone(item), path: file }));
  }
  const publicKeyPath = path.join(retained.directory, "public.key");
  const publicKey = await readBounded(publicKeyPath, 16 * 1024);
  // Request pins the decoded Tauri public key, whereas the retained file uses
  // the existing outer base64 encoding consumed by the actual Rust verifier.
  if (
    hash(Buffer.from(publicKey.toString("utf8").trim(), "base64")) !==
    retained.prepared.requests[0]!.public_key_sha256
  )
    throw new Error("actual retained public payload key changed");
  return Object.freeze({
    context,
    tools,
    native,
    sbom,
    signatures: Object.freeze(signatures),
    public_key: Object.freeze({
      path: publicKeyPath,
      bytes: publicKey.length,
      sha256: hash(publicKey),
    }),
    aggregate: Object.freeze(structuredClone(retained.prepared.verification)),
    pending_obligations: context.pending_obligations,
    settlement: Object.freeze(structuredClone(retained.settlement)),
    handoff: Object.freeze(structuredClone(retained.handoff)),
    scope:
      "actual signature custody and settled immutable output; cross-job attestation/post-sign qualification still required",
    authority: "none" as const,
  });
}
async function preparePayloadSigning(
  rawConfig: unknown,
  options: NonNullable<Parameters<typeof prepareControllerPayloadSigning>[1]>,
  onAdmitted?: (
    context: PositiveContext,
    prepared: PreparedPayloads,
    directory: string,
  ) => Promise<void>,
  prerequisites?: {
    compiler: NonNullable<Parameters<typeof acquireReleaseAdmissionWithControlHandshake>[5]>;
    establishNative: NonNullable<Parameters<typeof acquireReleaseAdmissionWithControlHandshake>[6]>;
  },
) {
  for (const key of [
    "TAURI_SIGNING_PRIVATE_KEY",
    "TAURI_SIGNING_PRIVATE_KEY_PATH",
    "TAURI_SIGNING_PRIVATE_KEY_PASSWORD",
    "TAURI_PRIVATE_KEY",
    "TAURI_PRIVATE_KEY_PATH",
    "TAURI_PRIVATE_KEY_PASSWORD",
  ])
    if (process.env[key] !== undefined)
      throw new Error("payload request preparation must run before role-key access");
  const config = inspectPayloadPreparationConfiguration(rawConfig);
  const directory = await assertOwnedUnlinkedPath(
    config.projectRoot,
    config.output,
    "payload preparation output",
  );
  await mkdir(directory, { mode: 0o700 });
  let phase = "fresh-independent-admission";
  try {
    let prepared: PreparedPayloads | undefined;
    const admission = await acquireReleaseAdmissionWithControlHandshake(
      directory,
      config.admission_configuration,
      "payload",
      async (facts, factsSha256) => {
        if (!facts.checkpoint) throw new Error("complete reservation facts are required");
        const { accepted } = await inspectTrustedAssemblyInput(facts.assembly);
        phase = "existing-reservation-before";
        const coordinator = {
          schema_version: 1,
          namespace: config.admission_configuration.namespace,
        };
        const descriptor = JSON.stringify({
          schema_version: 1,
          checkpoint: facts.checkpoint,
          coordinator,
          assembly: accepted,
          archives: facts.archives,
          evidence: {},
        });
        const readReservation = () =>
          readRemoteCoordinatorSnapshot(directory, coordinator, { transport: { cwd: directory } });
        const retainReservation = async (name: string) => {
          await requireReservedAggregate(descriptor, await readReservation());
          await writeFile(
            path.join(directory, name),
            `${JSON.stringify({ checkpoint: facts.checkpoint, source_commit: accepted.source_commit, source_tree: accepted.source_tree, version: accepted.version, run_id: accepted.run_id, run_attempt: accepted.run_attempt, scope: "existing reservation association only" })}\n`,
            { flag: "wx", mode: 0o600 },
          );
        };
        await retainReservation("reservation-before.json");
        phase = "verify-uploaded-aggregate";
        const verification = await (
          options.aggregate ? verifyUploadedAggregate : verifyAdmittedUploadedAggregate
        )(
          directory,
          {
            ...config.aggregate,
            candidate: accepted,
            candidate_artifact_ids: facts.archives.map((archive) => archive.artifact_id),
          },
          options.aggregate,
        );
        if (verification.evidence_scope !== "github.com")
          throw new Error(
            "injected aggregate evidence cannot prepare a production signing request",
          );
        await writeFile(
          path.join(directory, "aggregate-verification.json"),
          `${JSON.stringify(verification)}\n`,
          { flag: "wx", mode: 0o600 },
        );
        phase = "public-key";
        const publicInputs = facts.public_build_inputs;
        if (
          !isRecord(publicInputs) ||
          publicInputs.evidence_scope !== "github.com" ||
          typeof publicInputs.directory !== "string"
        )
          throw new Error("actual admitted public build input bytes are required for signing");
        const keyBytes = await readBounded(
          path.join(publicInputs.directory, "windows-x86_64", "input", "updater-public.key"),
          16 * 1024,
        );
        if (
          !keyBytes.equals(
            await readBounded(
              path.join(publicInputs.directory, "linux-x86_64", "input", "updater-public.key"),
              16 * 1024,
            ),
          )
        )
          throw new Error("admitted public payload keys differ across the package matrix");
        const outer = keyBytes.toString("utf8").trim();
        const key = Buffer.from(outer, "base64");
        const lines = key.toString("utf8").trimEnd().split("\n");
        if (
          key.toString("base64") !== outer ||
          hash(key) !== config.public_key_sha256 ||
          lines.length !== 2 ||
          !lines[0]?.startsWith("untrusted comment:") ||
          Buffer.from(lines[1] ?? "", "base64").length !== 42 ||
          Buffer.from(lines[1] ?? "", "base64")
            .subarray(0, 2)
            .toString("ascii") !== "Ed" ||
          Buffer.from(lines[1] ?? "", "base64").toString("base64") !== lines[1]
        )
          throw new Error("independent public key bytes differ");
        await writeFile(path.join(directory, "public.key"), keyBytes, { flag: "wx", mode: 0o600 });
        phase = "materialize-verified-payloads";
        const archive = await readBounded(
          path.join(verification.acquisition_directory, "input", "aggregate.zip"),
          512 * 1024 ** 2,
        );
        const requests = await stageAggregateSigningInputs(
          path.join(directory, "payloads"),
          archive,
          accepted,
          {
            aggregate_archive_sha256: verification.sha256,
            reservation_checkpoint: facts.checkpoint,
            qualification_inventory_sha256: hash(JSON.stringify(orderedJsonValue(facts.contexts))),
            public_key_sha256: config.public_key_sha256,
            producer: {
              run_id: config.aggregate.run_id,
              run_attempt: config.aggregate.run_attempt,
              job_id: String(verification.assembler.job_id),
              artifact_id: String(verification.artifact_id),
            },
          },
        );
        phase = "existing-reservation-after";
        await retainReservation("reservation-after.json");
        prepared = { requests, verification };
        return hash(
          JSON.stringify({
            facts_sha256: factsSha256,
            requests,
            aggregate_artifact_id: verification.artifact_id,
            aggregate_archive_sha256: verification.sha256,
          }),
        );
      },
      async (context) => {
        if (!prepared || context.checkpoint !== prepared.requests[0]?.reservation_checkpoint)
          throw new Error("private admitted payloads differ from the current reservation");
        await onAdmitted?.(context, prepared, directory);
      },
      prerequisites?.compiler,
      prerequisites?.establishNative,
    );
    const admissionBytes = JSON.stringify(admission);
    if (Buffer.byteLength(admissionBytes) > 2 * 1024 ** 2)
      throw new Error("admission observation exceeds its public evidence bound");
    await writeFile(path.join(directory, "admission-observation.json"), `${admissionBytes}\n`, {
      flag: "wx",
      mode: 0o600,
    });
    if (!prepared || !admission.checkpoint || admission.evidence_scope !== "github.com")
      throw new Error("payload preparation requires actual complete late-control observations");
    const { requests, verification } = prepared;
    const result = {
      schema_version: 1,
      decision: "hold",
      directory,
      checkpoint: admission.checkpoint,
      control_phase: "payload",
      holds: [...admission.holds].sort(),
      diagnostic_requests: requests,
      aggregate_artifact_id: verification.artifact_id,
      aggregate_archive_sha256: verification.sha256,
      qualification_inventory_sha256: requests[0]!.qualification_inventory_sha256,
      original_compiler: null,
      authority: "none",
    };
    await writeFile(
      path.join(directory, "payload-preparation.json"),
      `${JSON.stringify(result, null, 2)}\n`,
      { flag: "wx", mode: 0o600 },
    );
    return result;
  } catch {
    await writeFile(
      path.join(directory, "payload-preparation-failure.json"),
      `${JSON.stringify({ schema_version: 1, phase, decision: "refused", directory, authority: "none" })}\n`,
      { flag: "wx", mode: 0o600 },
    );
    throw new Error(`payload preparation refused; retain owned directory ${directory}`);
  }
}

/** Actual positive continuation is private to this one acquisition process.
 * Current independent holds stop it before signer identity or key delivery. */
export async function runPayloadSigningController(
  config: unknown,
  signerExpected: Parameters<typeof verifyPayloadSignerJobIdentity>[1],
  toolsReceipt: object,
  nativeLocators?: unknown,
) {
  const capturedNativeLocators: unknown = structuredClone(nativeLocators);
  // Includes acquisition, controls, signing and immutable output handoff, with
  // thirty seconds reserved for key-channel/process and runner cleanup.
  const deadline = payloadSigningPhaseDeadline();
  const withinBudget = () => {
    if (performance.now() >= deadline)
      throw new Error("payload role total phase deadline exhausted");
  };
  const identityExpected = inspectAssemblerIdentityExpectation(structuredClone(signerExpected));
  const tools = await verifiedControllerToolPaths(toolsReceipt);
  if (
    identityExpected.controller_revision !== tools.identity.controller_revision ||
    identityExpected.controller_ref !== tools.identity.controller_ref ||
    identityExpected.run_id !== tools.identity.run_id ||
    identityExpected.run_attempt !== tools.identity.run_attempt
  )
    throw new Error("payload signer and verified fixed tools differ");
  const selected = inspectPayloadPreparationConfiguration(config);
  const authorities = await requireControllerReleaseAuthorities("payload");
  if (authorities.namespace !== selected.admission_configuration.namespace)
    throw new Error("payload authority and actual coordinator namespace differ");
  if (
    selected.projectRoot !== tools.root ||
    selected.aggregate.controller_revision !== tools.identity.controller_revision ||
    selected.aggregate.controller_ref !== tools.identity.controller_ref ||
    selected.aggregate.run_id !== tools.identity.run_id ||
    selected.aggregate.run_attempt !== tools.identity.run_attempt
  )
    throw new Error("payload preparation and verified controller custody differ");
  const closure = inspectReleaseCompilerSourceClosure(
    JSON.parse((await readBounded(tools.compiler_source_closure, 64 * 1024)).toString("utf8")),
  );
  if (closure.source_commit !== tools.identity.controller_revision)
    throw new Error("compiler closure differs from authenticated fixed controller source");
  if (!Array.isArray(capturedNativeLocators) || capturedNativeLocators.length !== 2)
    throw new Error("fixed controller requires exactly two native invocation locators");
  const pinned = {
    node: { path: tools.node, sha256: hash(await readBounded(tools.node, 128 * 1024 ** 2)) },
    tauriAddon: {
      path: tools.tauriAddon,
      sha256: hash(await readBounded(tools.tauriAddon, 128 * 1024 ** 2)),
    },
    verifier: { path: tools.rust, sha256: hash(await readBounded(tools.rust, 128 * 1024 ** 2)) },
  };
  let signatures: Awaited<ReturnType<typeof signReleasePayload>>[] | undefined;
  let completed: Omit<PrivateSignatures, "signatures"> | undefined;
  const observation = await preparePayloadSigning(
    selected,
    {},
    async (context, prepared, directory) => {
      requireActualReleaseAdmissionContext(context, "payload-signing");
      const token = await requestAssemblerToken(
        "portcove-payload-signing",
        process.env,
        fetch,
        deadline,
      );
      const identity = await verifyPayloadSignerJobIdentity(token, identityExpected, {
        transport: { cwd: directory, deadline },
      });
      if (identity.evidence_scope !== "github.com")
        throw new Error("actual payload signer required");
      const admitted = context.admission.controls;
      if (!admitted) throw new Error("actual admitted control snapshot required");
      const executor = await authenticateCapacityExecutor(
        "payload-signing",
        {
          ...identityExpected,
          audience: "portcove-capacity-executor",
        },
        directory,
        deadline,
      );
      const actualExecutor = capacityExecutorIdentity(executor);
      if (
        actualExecutor.job_id !== identity.job_id ||
        actualExecutor.check_run_id !== identity.check_run_id
      )
        throw new Error("payload signer and capacity executor are different actual jobs");
      let currentCheckpoint = context.checkpoint;
      let round = 0;
      const factsDigest = hash(
        JSON.stringify(
          orderedJsonValue({
            checkpoint: context.checkpoint,
            requests: prepared.requests,
            aggregate_artifact_id: prepared.verification.artifact_id,
            aggregate_archive_sha256: prepared.verification.sha256,
          }),
        ),
      );
      const freshControls = async () => {
        withinBudget();
        await verifiedControllerToolPaths(toolsReceipt);
        const source = await authenticateReleaseControlRound(
          path.join(directory, `payload-controls-r${++round}`),
          factsDigest,
          "payload",
          round,
          { deadline },
        );
        const api = new GitHubApiClient((args, input) => {
          withinBudget();
          const response = createGitHubRunner({
            cwd: directory,
            maxBuffer: 2 * 1024 ** 2,
            timeoutMs: Math.max(1, Math.floor(Math.min(15000, deadline - performance.now()))),
          })([...args, "--hostname", "github.com"], input);
          withinBudget();
          return response;
        });
        let requests = 0;
        const bound = () => {
          if (++requests > 32) throw new Error("payload control read bound exhausted");
        };
        const current = source.read(
          {
            request(method, endpoint, body) {
              bound();
              if (
                method !== "GET" ||
                body !== undefined ||
                !endpoint.startsWith("repos/boburning/portcove/")
              )
                throw new Error("payload controls permit only fixed repository reads");
              return api.request(method, endpoint);
            },
            graphql(query, variables) {
              bound();
              if (query !== releaseControlRefQuery)
                throw new Error("payload control query differs");
              return api.graphql(query, variables);
            },
          },
          context.facts.opportunity,
        );
        if (
          current.pause.publication_paused ||
          !current.resource_policy_matches_controller ||
          !isDeepStrictEqual(current.classification, admitted.classification) ||
          !isDeepStrictEqual(current.pause, admitted.pause) ||
          !isDeepStrictEqual(current.capacity, admitted.capacity)
        )
          throw new Error("current payload controls differ from actual admission");
        withinBudget();
        return current;
      };
      const guard = async () => {
        await freshControls();
        await requireNativeReleaseQualificationPair(
          context.native_qualifications,
          context.facts.assembly,
          context.facts.archives,
          "payload-signing",
        );
        await requireVerifiedReleaseSbomDocument(context.sbom_receipt);
        const coordinator = { schema_version: 1, namespace: authorities.namespace };
        const snapshot = await readRemoteCoordinatorSnapshot(directory, coordinator, {
          transport: { cwd: directory, deadline },
        });
        await requireReservedAggregate(
          JSON.stringify({
            schema_version: 1,
            checkpoint: currentCheckpoint,
            coordinator,
            assembly: context.facts.assembly,
            archives: context.facts.archives,
            evidence: {},
          }),
          snapshot,
        );
        withinBudget();
      };
      await guard();
      const temporary = process.env.RUNNER_TEMP;
      if (!temporary || !path.isAbsolute(temporary))
        throw new Error("private runner key channel root unavailable");
      let handoff: Awaited<ReturnType<typeof handoffSigningOutput>> | undefined;
      const settlement = await executeOwnedCapacityEffect(
        executor,
        {
          repository: context.coordinator_repository,
          checkpoint: context.checkpoint,
          remote_configuration: { schema_version: 1, namespace: authorities.namespace },
          request: {
            kind: "upload",
            destination: `github-actions:boburning/portcove:${prepared.requests[0]!.version}:payload-signatures`,
          },
        },
        async () => (await freshControls()).capacity_source.capacity.boundary,
        async (pending) => {
          currentCheckpoint = pending.checkpoint;
          await guard();
          signatures = await receiveIsolatedRoleKey(
            path.join(temporary, "payload-role-key"),
            "payload",
            Date.now() + 30000,
            async (key, password) => {
              const results = [];
              for (const request of prepared.requests) {
                results.push(
                  await signReleasePayload(
                    {
                      projectRoot: tools.root,
                      request,
                      payload: path.join(directory, "payloads", request.filename),
                      publicKey: path.join(directory, "public.key"),
                      output: path.join(directory, `signature-${request.platform_label}`),
                      tools: pinned,
                    },
                    { beforeSign: guard, keyMaterial: async () => ({ key, password }), deadline },
                  ),
                );
              }
              await guard();
              return results;
            },
          );
          if (!signatures) throw new Error("actual payload signatures missing");
          const { path: _privateSbomPath, ...publicSbom } =
            await requireVerifiedReleaseSbomDocument(context.sbom_receipt);
          const inputBinding = Buffer.from(
            JSON.stringify({
              schema_version: 1,
              requests: prepared.requests,
              assembly: context.facts.assembly,
              aggregate: {
                artifact_id: prepared.verification.artifact_id,
                archive_sha256: prepared.verification.sha256,
              },
              native: context.facts.native_evidence,
              compiler_evidence_sha256: hash(
                JSON.stringify(orderedJsonValue(context.facts.compiler_evidence)),
              ),
              sbom: publicSbom,
              pending_obligations: context.pending_obligations,
            }),
          );
          if (inputBinding.length > 64 * 1024)
            throw new Error("payload signature input binding exceeds bound");
          const bindingFile = path.join(directory, "payload-signing-inputs.json");
          await writeFile(bindingFile, inputBinding, { flag: "wx", mode: 0o600 });
          handoff = await handoffSigningOutput(
            path.join(directory, "signature-handoff"),
            {
              producer: actualExecutor,
              pending,
              input_binding_sha256: hash(inputBinding),
              files: [
                ...signatures.map((item) => ({
                  ...item.signature,
                  path: path.join(
                    directory,
                    `signature-${item.request.platform_label}`,
                    item.signature.filename,
                  ),
                })),
                {
                  filename: "payload-signing-inputs.json",
                  path: bindingFile,
                  bytes: inputBinding.length,
                  sha256: hash(inputBinding),
                },
              ],
            },
            deadline,
          );
          await guard();
          return {
            remote_identity: `github-actions:boburning/portcove:artifact:${String(handoff.artifact.id)}`,
            evidence_sha256: hash(JSON.stringify(orderedJsonValue(handoff))),
          };
        },
      );
      if (!handoff) throw new Error("actual immutable payload output custody missing");
      currentCheckpoint = settlement.checkpoint;
      completed = {
        context,
        prepared,
        tools: toolsReceipt,
        directory,
        settlement,
        handoff,
        control_round: round,
      };
    },
    {
      compiler: {
        controller_tools: toolsReceipt,
        controller_source: {
          source_commit: closure.source_commit,
          source_tree: closure.source_tree,
        },
      },
      establishNative: (facts) =>
        collectConfiguredNativeReleaseQualificationPair(
          selected.output,
          capturedNativeLocators,
          facts.assembly,
          facts.archives,
        ),
    },
  );
  const result = signatures
    ? { ...observation, decision: "signed", signatures, authority: "none" }
    : observation;
  if (signatures && completed) actualSignatures.set(result, { ...completed, signatures });
  return result;
}

async function settleDirectCli() {
  if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    try {
      if (process.argv.length !== 3)
        throw new Error("choose the fixed trusted preparation configuration");
      const raw: unknown = JSON.parse(
        (await readBounded(process.argv[2]!, 64 * 1024)).toString("utf8"),
      );
      if (
        !isRecord(raw) ||
        !isRecord(raw.configuration) ||
        !isRecord(raw.tools) ||
        !isRecord(raw.tools.artifact) ||
        !isRecord(raw.tools.bundle) ||
        !isDeepStrictEqual(Object.keys(raw.tools).sort(), ["artifact", "bundle"]) ||
        !isDeepStrictEqual(Object.keys(raw).sort(), [
          "configuration",
          "native_locators",
          "signer_identity",
          "tools",
        ])
      )
        throw new Error("fixed payload caller configuration differs");
      const receipt = await receiveControllerTools(
        project,
        raw.tools.artifact as unknown as ControllerToolArtifactExpected,
        raw.tools.bundle as unknown as { artifact_id: number; sha256: string },
      );
      const tools = await verifiedControllerToolPaths(receipt);
      const selected = inspectPayloadPreparationConfiguration({
        ...raw.configuration,
        projectRoot: project,
        output: path.join(project, "work", "payload-preparation"),
      });
      await mkdir(path.join(tools.root, "work"), { mode: 0o700 });
      const result = await runPayloadSigningController(
        {
          ...selected,
          projectRoot: tools.root,
          output: path.join(tools.root, "work", "payload-preparation"),
          publicKey: path.join(tools.root, "work", "admitted-public.key"),
        },
        raw.signer_identity,
        receipt,
        raw.native_locators,
      );
      process.exitCode = result.decision === "signed" ? 0 : 2;
    } catch {
      console.error(
        "held payload signing controller refused; retain bounded public preparation evidence",
      );
      process.exitCode = 2;
    } finally {
      if (process.env.RUNNER_TEMP)
        await writeFile(
          path.join(process.env.RUNNER_TEMP, "payload-preparation-process-ended.json"),
          JSON.stringify({ exit_code: process.exitCode ?? 0, authority: "none" }),
          { flag: "wx", mode: 0o600 },
        ).catch(() => {
          process.exitCode = 2;
        });
    }
  }
}
void settleDirectCli().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
