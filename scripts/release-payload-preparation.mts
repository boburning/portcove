/** Read-only controller integration. Acquires existing authority observations;
 * it cannot create admission, sign, allocate or publish. */
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { mkdir, open, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { isDeepStrictEqual } from "node:util";
import { crc32, inflateRawSync } from "node:zlib";
import { acquireReleaseAdmission } from "./acquire-release-admission.mts";
import { requireReservedAggregate } from "./production-aggregate-steps.mts";
import { readRemoteCoordinatorSnapshot } from "./release-coordinator-recovery.mts";
import { verifyUploadedAggregate } from "./trusted-aggregate-attestation.mts";
import { inspectTrustedAssemblyInput } from "./trusted-release-assembly.mts";
import { artifactName } from "./release-package-policy.mts";
import { inspectBoundedZip } from "./bounded-zip.mts";
import { assertOwnedUnlinkedPath } from "./release-path-safety.mts";
import { inspectPayloadSigningRequest } from "./release-payload-signing.mts";
import { orderedJsonValue } from "./json-values.mts";
import { isRecord } from "./runtime-values.mts";
import {
  requestAssemblerToken,
  verifyPayloadSignerJobIdentity,
} from "./assembler-job-identity.mts";

const hash = (bytes: Buffer | string) => createHash("sha256").update(bytes).digest("hex");
const sha256 = /^[a-f0-9]{64}$/;
const project = fileURLToPath(new URL("..", import.meta.url));
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
  const aggregate = value.aggregate;
  if (
    Object.keys(aggregate).sort().join(",") !==
      "artifact_id,bundle_artifact_id,bundle_sha256,controller_ref,controller_revision,run_attempt,run_id,sha256" ||
    typeof aggregate.controller_revision !== "string" ||
    !/^[a-f0-9]{40}$/.test(aggregate.controller_revision) ||
    typeof aggregate.controller_ref !== "string" ||
    !/^refs\/tags\/portcove-production-controller-[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(
      aggregate.controller_ref,
    ) ||
    typeof aggregate.run_id !== "string" ||
    !/^[1-9][0-9]{0,15}$/.test(aggregate.run_id) ||
    typeof aggregate.sha256 !== "string" ||
    !sha256.test(aggregate.sha256) ||
    typeof aggregate.bundle_sha256 !== "string" ||
    !sha256.test(aggregate.bundle_sha256) ||
    typeof aggregate.artifact_id !== "number" ||
    !Number.isSafeInteger(aggregate.artifact_id) ||
    aggregate.artifact_id < 1 ||
    typeof aggregate.bundle_artifact_id !== "number" ||
    !Number.isSafeInteger(aggregate.bundle_artifact_id) ||
    aggregate.bundle_artifact_id < 1 ||
    typeof aggregate.run_attempt !== "number" ||
    !Number.isSafeInteger(aggregate.run_attempt) ||
    aggregate.run_attempt < 1
  )
    throw new Error("fixed payload aggregate identity is incomplete");
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
    admission?: Parameters<typeof acquireReleaseAdmission>[2];
    aggregate?: Parameters<typeof verifyUploadedAggregate>[2];
  } = {},
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
    const admission = await acquireReleaseAdmission(
      directory,
      config.admission_configuration,
      options.admission,
    );
    const admissionBytes = JSON.stringify(admission);
    if (Buffer.byteLength(admissionBytes) > 2 * 1024 ** 2)
      throw new Error("admission observation exceeds its public evidence bound");
    await writeFile(path.join(directory, "admission-observation.json"), `${admissionBytes}\n`, {
      flag: "wx",
      mode: 0o600,
    });
    if (!admission.checkpoint || admission.evidence_scope !== "github.com")
      throw new Error("payload preparation requires actual complete admission observations");
    const { accepted } = await inspectTrustedAssemblyInput(admission.assembly);
    phase = "existing-reservation-before";
    const coordinator = { schema_version: 1, namespace: config.admission_configuration.namespace };
    const descriptor = JSON.stringify({
      schema_version: 1,
      checkpoint: admission.checkpoint,
      coordinator,
      assembly: accepted,
      archives: admission.archives,
      evidence: {},
    });
    const readReservation = () =>
      readRemoteCoordinatorSnapshot(directory, coordinator, { transport: { cwd: directory } });
    const retainReservation = async (name: string) => {
      await requireReservedAggregate(descriptor, await readReservation());
      await writeFile(
        path.join(directory, name),
        `${JSON.stringify({ checkpoint: admission.checkpoint, source_commit: accepted.source_commit, source_tree: accepted.source_tree, version: accepted.version, run_id: accepted.run_id, run_attempt: accepted.run_attempt, scope: "existing reservation association only" })}\n`,
        { flag: "wx", mode: 0o600 },
      );
    };
    await retainReservation("reservation-before.json");
    phase = "verify-uploaded-aggregate";
    const verification = await verifyUploadedAggregate(
      directory,
      {
        ...config.aggregate,
        candidate: accepted,
        candidate_artifact_ids: admission.archives.map((archive) => archive.artifact_id),
      },
      options.aggregate,
    );
    if (verification.evidence_scope !== "github.com")
      throw new Error("injected aggregate evidence cannot prepare a production signing request");
    await writeFile(
      path.join(directory, "aggregate-verification.json"),
      `${JSON.stringify(verification)}\n`,
      { flag: "wx", mode: 0o600 },
    );
    phase = "public-key";
    const publicPath = await assertOwnedUnlinkedPath(
      config.projectRoot,
      config.publicKey,
      "independent payload public key",
    );
    const keyBytes = await readBounded(publicPath, 16 * 1024);
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
        reservation_checkpoint: admission.checkpoint,
        qualification_inventory_sha256: hash(JSON.stringify(orderedJsonValue(admission.contexts))),
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
    // The current admission contract intentionally has no positive signing
    // disposition. Do not turn the acquired facts or a supplied digest into one.
    const result = {
      schema_version: 1,
      decision: "hold",
      directory,
      checkpoint: admission.checkpoint,
      holds: [...admission.holds, "payload-signing-positive-admission-not-connected"].sort(),
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

/** Future held caller: preparation is mandatory before identity/key access.
 * Current literal admission holds have no production signing continuation. */
export async function runPayloadSigningController(
  config: unknown,
  signerExpected: Parameters<typeof verifyPayloadSignerJobIdentity>[1],
) {
  const prepared = await prepareControllerPayloadSigning(config);
  if (prepared.holds.length) return prepared;
  const token = await requestAssemblerToken("portcove-payload-signing");
  await verifyPayloadSignerJobIdentity(token, signerExpected, {
    transport: { cwd: prepared.directory },
  });
  throw new Error("positive payload signing controls remain unconnected; no key accessed");
}

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
      !isDeepStrictEqual(Object.keys(raw).sort(), ["configuration", "signer_identity"])
    )
      throw new Error("fixed payload caller configuration differs");
    await runPayloadSigningController(
      { ...raw.configuration, projectRoot: project },
      raw.signer_identity,
    );
    process.exitCode = 2;
  } catch {
    console.error(
      "held payload signing controller refused; retain bounded public preparation evidence",
    );
    process.exitCode = 2;
  }
}
