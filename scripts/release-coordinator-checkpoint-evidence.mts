/** Durable transport for an existing controller attestation. These byte/object
 * checks are not signature verification, current authorization, or job identity.
 * The owning caller must authenticate the fixed job and verify the bundle with
 * the existing controller verifier before giving this evidence authority. */
import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import type { exportCoordinatorCheckpoint } from "./release-coordinator-state.mts";
import { inspectCoordinatorRemoteNamespace } from "./release-coordinator-namespace.mts";
import { productionControllerWorkflow } from "./production-controller-admission.mts";
import { isRecord } from "./runtime-values.mts";
import type { CoordinatorRemoteApi } from "./release-coordinator-remote.mts";
import { performance } from "node:perf_hooks";
import { inspectNativeCheckpointCustody } from "./release-native-checkpoint-custody.mts";

type Checkpoint = Awaited<ReturnType<typeof exportCoordinatorCheckpoint>>;
export type CoordinatorRefUpdate = {
  name: string;
  beforeOid: string;
  afterOid: string;
  force: false;
};
export interface CoordinatorCheckpointEvidence {
  subject: Buffer;
  bundle: Buffer;
}
export const coordinatorCheckpointPredicateType =
  "https://portcove.dev/attestations/coordinator-checkpoint/v1";
export const nativeCoordinatorCheckpointPredicateType =
  "https://portcove.dev/attestations/coordinator-checkpoint/v2";
export const coordinatorCheckpointSubjectLimit = 1024 * 1024;
const zero = "0".repeat(40);
const subjectName = "portcove-coordinator-checkpoint-transition";
const hash = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
const objectId = (kind: string, bytes: Buffer) =>
  createHash("sha1").update(`${kind} ${bytes.length}\0`).update(bytes).digest("hex");

export function coordinatorCheckpointUpdates(checkpoint: Checkpoint, scope: string) {
  if (checkpoint.previous === null)
    throw new Error("remote coordinator advancement requires an initialized previous checkpoint");
  const result: CoordinatorRefUpdate[] = [
    {
      name: `refs/heads/${scope}-coordinator-state`,
      beforeOid: checkpoint.previous,
      afterOid: checkpoint.checkpoint,
      force: false,
    },
  ];
  for (const receipt of checkpoint.receipts) {
    const version = "refs/portcove/prepared-versions/";
    const source = "refs/portcove/prepared-commits/";
    const name = receipt.local_ref.startsWith(version)
      ? `refs/tags/${scope}-prepared/${receipt.local_ref.slice(version.length)}`
      : receipt.local_ref.startsWith(source)
        ? `refs/tags/${scope}-prepared-source/${receipt.local_ref.slice(source.length)}`
        : null;
    if (
      !name ||
      receipt.oid === zero ||
      (receipt.before_oid !== zero && receipt.before_oid !== receipt.oid)
    )
      throw new Error("remote preparation receipt differs from its validated allocation");
    result.push({ name, beforeOid: receipt.before_oid, afterOid: receipt.oid, force: false });
  }
  if (
    ![1, 3].includes(result.length) ||
    new Set(result.map((ref) => ref.name)).size !== result.length
  )
    throw new Error("remote coordinator requires one complete duplicate-free receipt set");
  return result;
}

function producerIdentity(raw: unknown) {
  const keys =
    "actor_id,check_run_id,configuration_sha256,controller_ref,controller_revision,job_id,run_attempt,run_id,setup_sha256,workflow_sha256";
  if (
    !isRecord(raw) ||
    Object.keys(raw).sort().join(",") !== keys ||
    typeof raw.controller_revision !== "string" ||
    !/^[a-f0-9]{40}$/u.test(raw.controller_revision) ||
    typeof raw.controller_ref !== "string" ||
    !/^refs\/tags\/portcove-production-controller-[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u.test(
      raw.controller_ref,
    ) ||
    ![raw.configuration_sha256, raw.setup_sha256, raw.workflow_sha256].every(
      (value) => typeof value === "string" && /^[a-f0-9]{64}$/u.test(value),
    ) ||
    ![raw.actor_id, raw.check_run_id, raw.job_id, raw.run_id].every(
      (value) =>
        typeof value === "string" &&
        /^[1-9][0-9]{0,15}$/u.test(value) &&
        Number.isSafeInteger(Number(value)),
    ) ||
    typeof raw.run_attempt !== "number" ||
    !Number.isSafeInteger(raw.run_attempt) ||
    raw.run_attempt < 1
  )
    throw new Error("checkpoint evidence producer binding is incomplete or differs");
  // Fixed key order is the subject encoding, not caller JSON insertion order.
  return Object.fromEntries(keys.split(",").map((key) => [key, raw[key]]));
}

/** Prepare inert bytes BEFORE signing. No proof-container OID appears in its
 * own subject; the deterministic create-only proof ref name is bound instead. */
export function coordinatorCheckpointEvidenceSubject(
  checkpoint: Checkpoint,
  configuration: unknown,
  producer: unknown,
  nativeCustody?: unknown,
) {
  const identity = producerIdentity(producer);
  const native = inspectNativeCheckpointCustody(checkpoint, configuration, identity, nativeCustody);
  const scope = inspectCoordinatorRemoteNamespace(configuration);
  const updates = coordinatorCheckpointUpdates(checkpoint, scope).sort((a, b) =>
    a.name < b.name ? -1 : a.name > b.name ? 1 : 0,
  );
  return Buffer.from(
    JSON.stringify({
      schema_version: native ? 2 : 1,
      purpose: "coordinator-checkpoint-transition",
      repository: "boburning/portcove",
      repository_id: 1354613114,
      workflow: productionControllerWorkflow,
      namespace: scope,
      checkpoint: checkpoint.checkpoint,
      previous: checkpoint.previous,
      state_sha256: hash(Buffer.from(checkpoint.blob.contents)),
      updates,
      proof_ref: `refs/tags/${scope}-checkpoint-proof/${checkpoint.checkpoint}`,
      proof_ref_before: zero,
      producer: identity,
      ...(native ? { native_custody: native.value } : {}),
    }),
  );
}

/** One canonical statement for the producer and existing retained-proof reader.
 * Preparing these inert bytes grants no signing or transition authority. */
export function prepareCoordinatorCheckpointSigningInput(
  checkpoint: Checkpoint,
  configuration: unknown,
  producer: unknown,
  nativeCustody?: unknown,
) {
  const subject = coordinatorCheckpointEvidenceSubject(
    checkpoint,
    configuration,
    producer,
    nativeCustody,
  );
  if (
    subject.length > (nativeCustody === undefined ? 16 * 1024 : coordinatorCheckpointSubjectLimit)
  )
    throw new Error("checkpoint transition subject exceeds its version bound");
  const statement = {
    _type: "https://in-toto.io/Statement/v1",
    subject: [{ name: subjectName, digest: { sha256: hash(subject) } }],
    predicateType:
      nativeCustody === undefined
        ? coordinatorCheckpointPredicateType
        : nativeCoordinatorCheckpointPredicateType,
    predicate: {
      schema_version: nativeCustody === undefined ? 1 : 2,
      transition_sha256: hash(subject),
      producer: producerIdentity(producer),
    },
  };
  return { subject, statement };
}

/** Reconstruct bounded immutable Git objects for the supplied original bundle.
 * A matching envelope remains unverified until cryptographic/provider checks.
 * This function never signs, retries, fetches, executes, or grants authority. */
export function inspectCoordinatorCheckpointEvidence(
  checkpoint: Checkpoint,
  configuration: unknown,
  evidence: CoordinatorCheckpointEvidence,
) {
  if (
    !Buffer.isBuffer(evidence.subject) ||
    evidence.subject.length < 1 ||
    evidence.subject.length > coordinatorCheckpointSubjectLimit ||
    !Buffer.isBuffer(evidence.bundle) ||
    evidence.bundle.length < 1 ||
    evidence.bundle.length > 64 * 1024
  )
    throw new Error("checkpoint evidence exceeds its byte bounds");
  const subject: unknown = JSON.parse(evidence.subject.toString("utf8"));
  const native =
    isRecord(subject) && subject.schema_version === 2 ? subject.native_custody : undefined;
  if (
    !isRecord(subject) ||
    !evidence.subject.equals(
      coordinatorCheckpointEvidenceSubject(checkpoint, configuration, subject.producer, native),
    )
  )
    throw new Error("checkpoint evidence subject differs from the exact transition");
  const bundle: unknown = JSON.parse(evidence.bundle.toString("utf8"));
  const envelope = isRecord(bundle) ? bundle.dsseEnvelope : null;
  if (
    !isRecord(envelope) ||
    envelope.payloadType !== "application/vnd.in-toto+json" ||
    typeof envelope.payload !== "string" ||
    envelope.payload.length > 32 * 1024 ||
    !Array.isArray(envelope.signatures) ||
    envelope.signatures.length !== 1
  )
    throw new Error("checkpoint evidence has no bounded single DSSE envelope");
  const payload = Buffer.from(envelope.payload, "base64");
  if (payload.toString("base64") !== envelope.payload)
    throw new Error("checkpoint evidence payload is not canonical base64");
  const statement: unknown = JSON.parse(payload.toString("utf8"));
  const expectedStatement = prepareCoordinatorCheckpointSigningInput(
    checkpoint,
    configuration,
    subject.producer,
    native,
  ).statement;
  if (!isDeepStrictEqual(statement, expectedStatement))
    throw new Error("checkpoint evidence envelope differs from the exact transition subject");
  const files = [
    { path: "bundle.sigstore.json", bytes: Buffer.from(evidence.bundle) },
    { path: "transition.json", bytes: Buffer.from(evidence.subject) },
  ];
  const blobs = files.map((file) => ({
    kind: "blobs" as const,
    oid: objectId("blob", file.bytes),
    body: { content: file.bytes.toString("base64"), encoding: "base64" },
  }));
  const entries = files.map((file, index) => ({
    path: file.path,
    mode: "100644",
    type: "blob",
    sha: blobs[index]!.oid,
  }));
  const treeBytes = Buffer.concat(
    entries.flatMap((entry) => [
      Buffer.from(`100644 ${entry.path}\0`),
      Buffer.from(entry.sha, "hex"),
    ]),
  );
  const tree = {
    kind: "trees" as const,
    oid: objectId("tree", treeBytes),
    body: { tree: entries },
  };
  const actor = {
    name: "Portcove release coordinator",
    email: "coordinator@portcove.invalid",
    date: "2000-01-01T00:00:00Z",
  };
  const message = `Portcove checkpoint evidence v${native === undefined ? 1 : 2}`;
  const commitBytes = Buffer.from(
    `tree ${tree.oid}\nparent ${checkpoint.checkpoint}\nauthor ${actor.name} <${actor.email}> 946684800 +0000\ncommitter ${actor.name} <${actor.email}> 946684800 +0000\n\n${message}`,
  );
  const commit = {
    kind: "commits" as const,
    oid: objectId("commit", commitBytes),
    body: {
      tree: tree.oid,
      parents: [checkpoint.checkpoint],
      message,
      author: actor,
      committer: actor,
    },
  };
  return {
    objects: [...blobs, tree, commit],
    update: {
      name: String(subject.proof_ref),
      beforeOid: zero,
      afterOid: commit.oid,
      force: false as const,
    },
    subject_sha256: hash(evidence.subject),
    bundle_sha256: hash(evidence.bundle),
    authority: "none" as const,
    signature_verification: "not-performed" as const,
  };
}

/** Read the exact retained proof, including a second matching ref observation.
 * No history traversal, artifact retention dependency, default credentials or
 * signature authority. The caller passes an independently selected checkpoint
 * and must authenticate these returned bytes before recovery/admission use. */
export function readCoordinatorCheckpointEvidence(
  checkpoint: Checkpoint,
  configuration: unknown,
  api: CoordinatorRemoteApi,
  deadline: number,
) {
  const scope = inspectCoordinatorRemoteNamespace(configuration);
  const started = performance.now();
  if (!Number.isFinite(deadline) || deadline <= started || deadline - started > 120_000)
    throw new Error("checkpoint evidence requires an original bounded read deadline");
  let requests = 0;
  const active = () => {
    if (performance.now() >= deadline || requests > 6)
      throw new Error("checkpoint evidence read deadline or request bound exhausted");
  };
  const name = `refs/tags/${scope}-checkpoint-proof/${checkpoint.checkpoint}`;
  const snapshot = () => {
    active();
    requests++;
    const response = api.graphql(
      'query($name:String!){repository(owner:"boburning",name:"portcove"){databaseId nameWithOwner ref(qualifiedName:$name){name prefix target{__typename oid}}}}',
      { name },
    );
    active();
    const repository = isRecord(response.data) ? response.data.repository : null;
    const ref = isRecord(repository) ? repository.ref : null;
    const target = isRecord(ref) ? ref.target : null;
    if (
      !isRecord(repository) ||
      repository.databaseId !== 1354613114 ||
      repository.nameWithOwner !== "boburning/portcove" ||
      !isRecord(ref) ||
      `${String(ref.prefix)}${String(ref.name)}` !== name ||
      !isRecord(target) ||
      target.__typename !== "Commit" ||
      typeof target.oid !== "string" ||
      !/^[a-f0-9]{40}$/u.test(target.oid) ||
      target.oid === zero
    )
      throw new Error("checkpoint evidence proof ref is missing or differs");
    return target.oid;
  };
  const get = (kind: string, oid: string) => {
    active();
    requests++;
    const response = api.request("GET", `repos/boburning/portcove/git/${kind}/${oid}`);
    active();
    if (response.status !== 200 || !isRecord(response.body) || response.body.sha !== oid)
      throw new Error("checkpoint evidence object is unavailable or differs");
    return response.body;
  };
  const proof = snapshot();
  const commit = get("commits", proof);
  if (
    !isRecord(commit.tree) ||
    typeof commit.tree.sha !== "string" ||
    !/^[a-f0-9]{40}$/u.test(commit.tree.sha)
  )
    throw new Error("checkpoint evidence commit tree differs");
  const tree = get("trees", commit.tree.sha);
  if (tree.truncated !== false || !Array.isArray(tree.tree) || tree.tree.length !== 2)
    throw new Error("checkpoint evidence tree is incomplete");
  const files: Buffer[] = [];
  for (const [index, filename] of ["bundle.sigstore.json", "transition.json"].entries()) {
    const entry: unknown = tree.tree[index];
    if (
      !isRecord(entry) ||
      entry.path !== filename ||
      entry.mode !== "100644" ||
      entry.type !== "blob" ||
      typeof entry.sha !== "string" ||
      !/^[a-f0-9]{40}$/u.test(entry.sha)
    )
      throw new Error("checkpoint evidence tree entry differs");
    const blob = get("blobs", entry.sha);
    if (
      blob.encoding !== "base64" ||
      typeof blob.content !== "string" ||
      blob.content.length > (index === 0 ? 96 * 1024 : 1500 * 1024) ||
      typeof blob.size !== "number" ||
      blob.size < 1 ||
      blob.size > (index === 0 ? 64 * 1024 : coordinatorCheckpointSubjectLimit)
    )
      throw new Error("checkpoint evidence blob exceeds its bound");
    // GitHub's blob response may wrap base64 with LF; no other whitespace is accepted.
    const encoded = blob.content.replaceAll("\n", "");
    const bytes = Buffer.from(encoded, "base64");
    if (
      bytes.toString("base64") !== encoded ||
      bytes.length !== blob.size ||
      objectId("blob", bytes) !== entry.sha
    )
      throw new Error("checkpoint evidence blob bytes differ");
    files.push(bytes);
  }
  const evidence = { bundle: files[0]!, subject: files[1]! };
  const checked = inspectCoordinatorCheckpointEvidence(checkpoint, configuration, evidence);
  if (
    checked.update.afterOid !== proof ||
    checked.objects[2]!.oid !== tree.sha ||
    snapshot() !== proof
  )
    throw new Error("checkpoint evidence objects or ref changed during readback");
  return {
    ...evidence,
    ...checked,
    checkpoint: checkpoint.checkpoint,
    proof_commit: proof,
    requests,
  };
}
