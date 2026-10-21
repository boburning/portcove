/** Fixed public context handoff. Hashes and ZIP parsing alone establish no
 * eligibility: only the existing controller attestation/provider join may admit
 * a transferred context, and each role still needs its own fresh controls. */
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import path from "node:path";
import { crc32, inflateRawSync } from "node:zlib";
import { performance } from "node:perf_hooks";
import { setTimeout as delay } from "node:timers/promises";
import { spawnSync } from "node:child_process";
import { inspectBoundedZip } from "./bounded-zip.mts";
import { releaseCanonicalDigest as digest } from "./release-canonical.mts";
import {
  requireReleaseSigningContext,
  readReleaseSigningContextFiles,
  readBoundedReleaseContextFiles,
} from "./release-signing-context.mts";
import { assertOwnedUnlinkedPath } from "./release-path-safety.mts";
import { isRecord } from "./runtime-values.mts";
import { createGitHubRunner, GitHubApiClient } from "./github-api.mts";
import type { GitHubRestReader } from "./github-api.mts";
import { readGitHubArtifactArchive } from "./github-binary.mts";
import {
  inspectAssemblerIdentityExpectation,
  requestAssemblerToken,
  verifyPayloadSignerJobIdentity,
} from "./assembler-job-identity.mts";
import { verifyControllerArtifactStatement } from "./github-controller-attestation.mts";
import { productionControllerWorkflow } from "./production-controller-admission.mts";
import { readControllerToolFile } from "./release-controller-tools.mts";

const hash = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
export const signingContextPredicateType =
  "https://portcove.dev/attestations/release-signing-context/v1";
export const signingContextArchiveLimits = Object.freeze({
  compressedBytes: 128 * 1024 ** 2,
  expandedBytes: 128 * 1024 ** 2,
  files: 2,
  nameBytes: 64,
});
type Files = Map<string, Buffer>;
const compare = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
const identities = (files: Files) =>
  [...files]
    .sort(([a], [b]) => compare(a, b))
    .map(([name, bytes]) => ({ path: name, bytes: bytes.length, sha256: hash(bytes) }));
function exact(value: unknown, keys: string): asserts value is Record<string, unknown> {
  if (!isRecord(value) || Object.keys(value).sort().join(",") !== keys)
    throw new Error("signing context manifest schema differs");
}
function sha(value: unknown): asserts value is string {
  if (typeof value !== "string" || !/^[a-f0-9]{64}$/u.test(value))
    throw new Error("signing context digest differs");
}
function safe(name: string) {
  return (
    name.length <= 512 &&
    name.split("/").length <= 18 &&
    name.split("/").every((part) => /^[A-Za-z0-9][A-Za-z0-9._+-]*$/u.test(part))
  );
}
function publicContextPath(name: string) {
  return (
    [
      "context.json",
      "trusted-root.json",
      "offline-targets.json",
      "payload.json",
      "records/reconstruction-manifest.json",
      "prior/repository-manifest.json",
    ].includes(name) ||
    /^(?:records\/(?:releases|channels)\/|prior\/(?:metadata|targets)\/).+\.json$/u.test(name)
  );
}

/** Bounded inert parser. Its return never authenticates source or eligibility. */
export function inspectSigningContextArchive(raw: Buffer) {
  if (
    !Buffer.isBuffer(raw) ||
    raw.length < 22 ||
    raw.length > signingContextArchiveLimits.compressedBytes
  )
    throw new Error("signing context compressed bound exceeded");
  const archive = Buffer.from(raw);
  const entries = inspectBoundedZip(archive, {
    ...signingContextArchiveLimits,
    allowedPaths: new Set(["signing-context-manifest.json", "signing-context-bytes.bin"]),
  }).entries;
  const files: Files = new Map();
  for (const entry of entries) {
    if (
      entry.bytes < 1 ||
      entry.bytes > (entry.name === "signing-context-manifest.json" ? 1024 * 1024 : 127 * 1024 ** 2)
    )
      throw new Error("signing context member path or bound differs");
    const compressed = archive.subarray(entry.data, entry.dataEnd);
    const bytes =
      entry.method === 0
        ? Buffer.from(compressed)
        : inflateRawSync(compressed, { maxOutputLength: entry.bytes });
    if (bytes.length !== entry.bytes || crc32(bytes) !== entry.crc)
      throw new Error("signing context member bytes differ");
    files.set(entry.name, bytes);
  }
  const manifestBytes = files.get("signing-context-manifest.json");
  if (!manifestBytes || !Buffer.from(manifestBytes.toString("utf8")).equals(manifestBytes))
    throw new Error("signing context manifest absent or not UTF-8");
  const manifest: unknown = JSON.parse(manifestBytes.toString("utf8"));
  exact(
    manifest,
    "authority,binding,control_facts,controller,facts,facts_sha256,files,kind,previous_site_pins,schema_version",
  );
  exact(manifest.previous_site_pins, "repository_sha256,root_sha256,site_generation_sha256");
  for (const value of Object.values(manifest.previous_site_pins)) sha(value);
  if (
    manifest.schema_version !== 1 ||
    manifest.kind !== "release-signing-context" ||
    manifest.authority !== "none" ||
    !Array.isArray(manifest.files) ||
    manifest.files.length < 1 ||
    manifest.files.length > 2208
  )
    throw new Error("signing context manifest identity differs");
  sha(manifest.facts_sha256);
  if (digest(manifest.facts) !== manifest.facts_sha256)
    throw new Error("signing context facts differ");
  exact(manifest.controller, "controller_ref,controller_revision,run_attempt,run_id,source_tree");
  if (
    typeof manifest.controller.controller_revision !== "string" ||
    !/^[a-f0-9]{40}$/u.test(manifest.controller.controller_revision) ||
    typeof manifest.controller.source_tree !== "string" ||
    !/^[a-f0-9]{40}$/u.test(manifest.controller.source_tree) ||
    typeof manifest.controller.controller_ref !== "string" ||
    !/^refs\/tags\/portcove-production-controller-[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u.test(
      manifest.controller.controller_ref,
    ) ||
    typeof manifest.controller.run_id !== "string" ||
    !/^[1-9][0-9]{0,15}$/u.test(manifest.controller.run_id) ||
    manifest.controller.run_attempt !== 1
  )
    throw new Error("signing context controller identity differs");
  exact(
    manifest.binding,
    "aggregate_sha256,native_checks,pending_obligations,records_sha256,run_attempt,run_id,sbom_sha256,signatures_sha256,source_commit,source_tree,version",
  );
  for (const name of ["aggregate_sha256", "records_sha256", "sbom_sha256", "signatures_sha256"])
    sha(manifest.binding[name]);
  if (files.size !== 2) throw new Error("signing context complete opaque inventory differs");
  const packed = files.get("signing-context-bytes.bin");
  if (!packed) throw new Error("signing context bytes missing");
  const contextFiles: Files = new Map();
  let offset = 0,
    previous = "";
  for (const item of manifest.files as unknown[]) {
    exact(item, "bytes,path,sha256");
    if (
      typeof item.path !== "string" ||
      !safe(item.path) ||
      !publicContextPath(item.path) ||
      item.path <= previous ||
      typeof item.bytes !== "number" ||
      !Number.isSafeInteger(item.bytes) ||
      item.bytes < 1 ||
      item.bytes > 1024 * 1024 ||
      offset + item.bytes > packed.length
    )
      throw new Error("signing context represented file bound or order differs");
    sha(item.sha256);
    const bytes = packed.subarray(offset, offset + item.bytes);
    if (hash(bytes) !== item.sha256)
      throw new Error("signing context represented file bytes differ");
    contextFiles.set(item.path, Buffer.from(bytes));
    previous = item.path;
    offset += item.bytes;
  }
  if (offset !== packed.length) throw new Error("signing context has unrepresented bytes");
  if (digest(identities(contextFiles)) !== digest(manifest.files))
    throw new Error("signing context complete inventory differs");
  if (
    !contextFiles.has("context.json") ||
    !contextFiles.has("trusted-root.json") ||
    !contextFiles.has("offline-targets.json") ||
    !contextFiles.has("payload.json") ||
    !contextFiles.has("records/reconstruction-manifest.json") ||
    !contextFiles.has("prior/repository-manifest.json")
  )
    throw new Error("signing context mandatory public inputs missing");
  const records: Files = new Map(
    [...contextFiles]
      .filter(
        ([name]) => name.startsWith("records/") && name !== "records/reconstruction-manifest.json",
      )
      .map(([name, bytes]) => [name.slice(8), bytes]),
  );
  if (digest(identities(records)) !== manifest.binding.records_sha256)
    throw new Error("signing context frozen record set differs");
  return {
    manifest,
    manifest_sha256: hash(manifestBytes),
    files: contextFiles,
    manifest_bytes: Buffer.from(manifestBytes),
    authority: "none" as const,
  };
}

const prepared = new WeakMap<
  object,
  {
    context: object;
    directory: string;
    manifest: Record<string, unknown>;
    manifest_sha256: string;
    files: { path: string; bytes: number; sha256: string }[];
  }
>();

/** Only actual private factory receipts can populate this reviewed upload tree. */
export async function prepareSigningContextArtifact(contextReceipt: object, parent: string) {
  const context = await requireReleaseSigningContext(contextReceipt);
  if (!context.previous_site)
    throw new Error("actual complete published site custody required for context handoff");
  const files = await readReleaseSigningContextFiles(contextReceipt);
  const tools = context.tools.identity;
  const manifest = {
    schema_version: 1,
    kind: "release-signing-context",
    controller: {
      controller_revision: tools.controller_revision,
      source_tree: tools.source_tree,
      controller_ref: tools.controller_ref,
      run_id: tools.run_id,
      run_attempt: tools.run_attempt,
    },
    binding: context.binding,
    facts: context.facts,
    control_facts: context.control_facts,
    previous_site_pins: context.previous_site.pins,
    facts_sha256: digest(context.facts),
    files: identities(files),
    authority: "none",
  };
  const manifestBytes = Buffer.from(JSON.stringify(manifest));
  if (manifestBytes.length > 1024 * 1024) throw new Error("signing context manifest exceeds bound");
  const directory = await mkdtemp(path.join(parent, "signing-context-artifact-"));
  try {
    const total = [...files.values()].reduce((sum, bytes) => sum + bytes.length, 0);
    if (total < 1 || total > 127 * 1024 ** 2)
      throw new Error("signing context packed bytes exceed bound");
    const packed = Buffer.concat(
      [...files].sort(([a], [b]) => compare(a, b)).map(([, bytes]) => bytes),
      total,
    );
    await writeFile(path.join(directory, "signing-context-bytes.bin"), packed, {
      flag: "wx",
      mode: 0o600,
    });
    await writeFile(path.join(directory, "signing-context-manifest.json"), manifestBytes, {
      flag: "wx",
      mode: 0o600,
    });
    await requireReleaseSigningContext(contextReceipt);
    const receipt = Object.freeze({
      kind: "actual-signing-context-upload",
      name: `trusted-payload-signing-context-${tools.run_id}-${tools.run_attempt}`,
      directory,
      manifest_sha256: hash(manifestBytes),
      authority: "none",
    });
    prepared.set(receipt, {
      context: contextReceipt,
      directory,
      manifest,
      manifest_sha256: receipt.manifest_sha256,
      files: identities(files),
    });
    return receipt;
  } catch {
    throw new Error(`signing context artifact preparation refused; retain ${directory}`);
  }
}

/** Captures a fixed phase budget once; never renew it after waits or reads. */
export function signingContextRemaining(deadline: number, maximum: number) {
  const remaining = Math.ceil(deadline - performance.now());
  if (!Number.isFinite(deadline) || remaining < 1 || remaining > 600000)
    throw new Error("signing context total phase deadline exhausted");
  return Math.min(maximum, remaining);
}

/** The fixed upload step is released only by a caller already inside the
 * existing durable pending effect. Locators alone never establish custody. */
export async function handoffSigningContextArtifact(
  receipt: object,
  rawIdentity: unknown,
  rawPending: { checkpoint: string; operation_id: string },
  deadline: number,
) {
  signingContextRemaining(deadline, 15000);
  const owned = prepared.get(receipt);
  if (!owned) throw new Error("actual private signing context upload required");
  const pending = structuredClone(rawPending);
  exact(pending, "checkpoint,operation_id");
  if (!/^[a-f0-9]{40}$/u.test(pending.checkpoint))
    throw new Error("context pending checkpoint differs");
  sha(pending.operation_id);
  const actual = await requireReleaseSigningContext(owned.context);
  const name = `trusted-payload-signing-context-${actual.tools.identity.run_id}-${actual.tools.identity.run_attempt}`;
  await writeFile(
    path.join(owned.directory, "context-ready.json"),
    JSON.stringify({
      name,
      pending,
      manifest_sha256: owned.manifest_sha256,
      files: ["signing-context-manifest.json", "signing-context-bytes.bin"],
      authority: "none",
    }),
    { flag: "wx", mode: 0o600 },
  );
  let phase = "await-fixed-context-upload";
  try {
    let uploaded: unknown;
    while (uploaded === undefined) {
      signingContextRemaining(deadline, 15000);
      try {
        uploaded = JSON.parse(
          (
            await readControllerToolFile(path.join(owned.directory, "context-uploaded.json"), 4096)
          ).toString("utf8"),
        );
      } catch (error) {
        if (!isRecord(error) || error.code !== "ENOENT")
          throw new Error("context upload locator malformed");
        await delay(Math.min(100, signingContextRemaining(deadline, 100)));
      }
    }
    exact(uploaded, "artifact_id,sha256");
    if (
      typeof uploaded.artifact_id !== "number" ||
      !Number.isSafeInteger(uploaded.artifact_id) ||
      uploaded.artifact_id < 1
    )
      throw new Error("context upload numeric artifact unavailable");
    sha(uploaded.sha256);
    phase = "verify-original-context-upload";
    const predicate = await prepareSigningContextPredicate(
      receipt,
      { artifact_id: uploaded.artifact_id, sha256: uploaded.sha256 },
      rawIdentity,
      deadline,
    );
    return Object.freeze({
      artifact_id: uploaded.artifact_id,
      sha256: uploaded.sha256,
      predicate_sha256: digest(predicate.predicate),
      manifest_sha256: owned.manifest_sha256,
      directory: owned.directory,
      attestation: "pending" as const,
      authority: "none" as const,
    });
  } catch {
    await writeFile(
      path.join(owned.directory, "context-handoff-refusal.json"),
      JSON.stringify({
        phase,
        directory: owned.directory,
        pending,
        authority: "none",
        automatic_retry: false,
      }),
      { flag: "wx", mode: 0o600 },
    ).catch(() => {});
    throw new Error(`actual context handoff refused; retain ${owned.directory}`);
  }
}

/** Only the fixed payload producer may describe the actual uploaded context.
 * The returned predicate is still unsigned data until actions/attest signs it. */
export async function prepareSigningContextPredicate(
  receipt: object,
  rawUploaded: { artifact_id: number; sha256: string },
  rawIdentity: unknown,
  deadline: number,
) {
  signingContextRemaining(deadline, 15000);
  const owned = prepared.get(receipt);
  if (!owned) throw new Error("actual private signing context upload required");
  const uploaded = structuredClone(rawUploaded),
    expectedIdentity = inspectAssemblerIdentityExpectation(structuredClone(rawIdentity));
  exact(uploaded, "artifact_id,sha256");
  sha(uploaded.sha256);
  if (!Number.isSafeInteger(uploaded.artifact_id) || uploaded.artifact_id < 1)
    throw new Error("exact numeric uploaded context artifact required");
  const actual = await requireReleaseSigningContext(owned.context),
    controller = actual.tools.identity;
  if (
    expectedIdentity.audience !== "portcove-payload-signing" ||
    expectedIdentity.controller_revision !== controller.controller_revision ||
    expectedIdentity.controller_ref !== controller.controller_ref ||
    expectedIdentity.run_id !== controller.run_id ||
    expectedIdentity.run_attempt !== controller.run_attempt
  )
    throw new Error("context producer identity differs from fixed controller tools");
  const api = new GitHubApiClient((args, input) =>
    createGitHubRunner({
      cwd: owned.directory,
      timeoutMs: signingContextRemaining(deadline, 15000),
      maxBuffer: 128 * 1024,
    })([...args, "--hostname", "github.com"], input),
  );
  const read = () => {
    signingContextRemaining(deadline, 15000);
    const response = api.request(
      "GET",
      `repos/boburning/portcove/actions/artifacts/${uploaded.artifact_id}`,
    );
    signingContextRemaining(deadline, 15000);
    const raw = response.body;
    if (
      response.status !== 200 ||
      !isRecord(raw) ||
      raw.id !== uploaded.artifact_id ||
      raw.name !==
        `trusted-payload-signing-context-${controller.run_id}-${controller.run_attempt}` ||
      raw.digest !== `sha256:${uploaded.sha256}` ||
      raw.expired !== false ||
      typeof raw.size_in_bytes !== "number" ||
      !Number.isSafeInteger(raw.size_in_bytes) ||
      raw.size_in_bytes < 22 ||
      raw.size_in_bytes > signingContextArchiveLimits.compressedBytes ||
      !isRecord(raw.workflow_run) ||
      raw.workflow_run.id !== Number(controller.run_id) ||
      raw.workflow_run.repository_id !== 1354613114 ||
      raw.workflow_run.head_repository_id !== 1354613114 ||
      raw.workflow_run.head_sha !== controller.controller_revision
    )
      throw new Error("context uploaded artifact identity differs");
    return { id: raw.id, bytes: raw.size_in_bytes, sha256: uploaded.sha256 };
  };
  const before = read();
  const archive = readGitHubArtifactArchive(
    `repos/boburning/portcove/actions/artifacts/${before.id}/zip`,
    {
      cwd: owned.directory,
      maxBytes: before.bytes,
      timeoutMs: signingContextRemaining(deadline, 30000),
    },
  );
  signingContextRemaining(deadline, 15000);
  if (archive.length !== before.bytes || hash(archive) !== before.sha256)
    throw new Error("context uploaded archive bytes differ");
  const inspected = inspectSigningContextArchive(archive);
  if (
    inspected.manifest_sha256 !== owned.manifest_sha256 ||
    digest(inspected.manifest) !== digest(owned.manifest) ||
    digest(identities(inspected.files)) !== digest(owned.files)
  )
    throw new Error("context uploaded inventory differs from actual private preparation");
  const token = await requestAssemblerToken(
    expectedIdentity.audience,
    process.env,
    (url, settings) =>
      fetch(url, {
        ...settings,
        signal: AbortSignal.timeout(signingContextRemaining(deadline, 15000)),
      }),
  );
  const identity = await verifyPayloadSignerJobIdentity(token, expectedIdentity, {
    transport: { cwd: owned.directory, deadline },
  });
  signingContextRemaining(deadline, 15000);
  await requireReleaseSigningContext(owned.context);
  if (
    identity.evidence_scope !== "github.com" ||
    Date.now() >= Date.parse(identity.expires_at) ||
    digest(before) !== digest(read())
  )
    throw new Error("context producer or uploaded custody changed");
  const predicate = {
    schema_version: 1,
    role: "release-signing-context",
    controller: inspected.manifest.controller,
    producer: {
      run_id: controller.run_id,
      run_attempt: controller.run_attempt,
      job_id: identity.job_id,
      check_run_id: identity.check_run_id,
    },
    artifact: before,
    manifest_sha256: owned.manifest_sha256,
    binding: inspected.manifest.binding,
    facts_sha256: inspected.manifest.facts_sha256,
    stage: "payload-signing",
    publication_admission: "not-established",
    authority: "none",
  };
  const bytes = Buffer.from(JSON.stringify(predicate));
  if (bytes.length > 65536) throw new Error("context attestation predicate exceeds bound");
  await writeFile(path.join(owned.directory, "signing-context-predicate.json"), bytes, {
    flag: "wx",
    mode: 0o600,
  });
  await writeFile(path.join(owned.directory, "uploaded-context.zip"), archive, {
    flag: "wx",
    mode: 0o600,
  });
  signingContextRemaining(deadline, 15000);
  return {
    predicate,
    manifest_sha256: owned.manifest_sha256,
    directory: owned.directory,
    authority: "none" as const,
  };
}

export interface SigningContextArtifactExpected {
  controller_revision: string;
  source_tree: string;
  controller_ref: string;
  run_id: string;
  run_attempt: number;
  artifact: { id: number; sha256: string };
  bundle: { id: number; sha256: string };
  manifest_sha256: string;
  binding_sha256: string;
  facts_sha256: string;
}
function expectedInput(raw: SigningContextArtifactExpected) {
  const expected = structuredClone(raw);
  exact(
    expected,
    "artifact,binding_sha256,bundle,controller_ref,controller_revision,facts_sha256,manifest_sha256,run_attempt,run_id,source_tree",
  );
  if (
    !/^[a-f0-9]{40}$/u.test(expected.controller_revision) ||
    !/^[a-f0-9]{40}$/u.test(expected.source_tree) ||
    !/^refs\/tags\/portcove-production-controller-[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u.test(
      expected.controller_ref,
    ) ||
    !/^[1-9][0-9]{0,15}$/u.test(expected.run_id) ||
    expected.run_attempt !== 1
  )
    throw new Error("fixed context controller expectation differs");
  for (const item of [expected.artifact, expected.bundle]) {
    exact(item, "id,sha256");
    sha(item.sha256);
    if (!Number.isSafeInteger(item.id) || item.id < 1)
      throw new Error("context artifact immutable numeric identity differs");
  }
  for (const value of [expected.manifest_sha256, expected.binding_sha256, expected.facts_sha256])
    sha(value);
  if (expected.artifact.id === expected.bundle.id)
    throw new Error("separate context attestation artifact required");
  return expected;
}
type Received = {
  directory: string;
  context: string;
  manifest: ReturnType<typeof inspectSigningContextArchive>["manifest"];
  files: { path: string; bytes: number; sha256: string }[];
  public_evidence: { path: string; bytes: number; sha256: string }[];
  active: () => void;
  refresh: () => void;
  tighten: (deadline: number) => void;
};
const received = new WeakMap<object, Received>();

/** Actual fixed-controller attestation + complete byte custody. This transfers
 * pre-sign context provenance only, never an imported release-admitted brand. */
export async function receiveSigningContextArtifact(
  parent: string,
  rawExpected: SigningContextArtifactExpected,
  deadline: number,
  options: {
    api?: GitHubRestReader;
    download?: typeof readGitHubArtifactArchive;
    spawn?: NonNullable<Parameters<typeof createGitHubRunner>[0]>["spawn"];
  } = {},
) {
  const expected = expectedInput(rawExpected);
  signingContextRemaining(deadline, 15000);
  const injected =
    options.api !== undefined || options.download !== undefined || options.spawn !== undefined;
  const apiOption = options.api ? { request: options.api.request.bind(options.api) } : undefined,
    download = options.download ?? readGitHubArtifactArchive,
    verifierSpawn = options.spawn;
  const directory = await mkdtemp(path.join(parent, "signing-context-receiver-"));
  let phase = "provider-before";
  try {
    const home = path.join(directory, "reader-home");
    await mkdir(home, { mode: 0o700 });
    const environment = {
      PATH: process.env.PATH,
      SystemRoot: process.env.SystemRoot,
      HOME: home,
      USERPROFILE: home,
      TEMP: home,
      TMP: home,
      GH_TOKEN: process.env.GH_TOKEN,
      GH_HOST: "github.com",
      GH_PROMPT_DISABLED: "1",
    };
    let requests = 0;
    const api =
      apiOption ??
      new GitHubApiClient((args, input) =>
        createGitHubRunner({
          cwd: directory,
          timeoutMs: signingContextRemaining(deadline, 15000),
          maxBuffer: 2 * 1024 * 1024,
          spawn: (command, argv, settings) =>
            spawnSync(command, argv, { ...settings, env: environment }),
        })([...args, "--hostname", "github.com"], input),
      );
    const get = (suffix: string) => {
      signingContextRemaining(deadline, 15000);
      if (++requests > 48) throw new Error("context complete provider readback budget exceeded");
      const response = api.request("GET", `repos/boburning/portcove/${suffix}`);
      signingContextRemaining(deadline, 15000);
      if (response.status !== 200) throw new Error("context provider response unavailable");
      return response.body;
    };
    const controller = {
      controller_revision: expected.controller_revision,
      source_tree: expected.source_tree,
      controller_ref: expected.controller_ref,
      run_id: expected.run_id,
      run_attempt: expected.run_attempt,
    };
    const run = (raw: unknown) => {
      if (
        !isRecord(raw) ||
        String(raw.id) !== expected.run_id ||
        raw.run_attempt !== expected.run_attempt ||
        raw.head_sha !== expected.controller_revision ||
        raw.path !== productionControllerWorkflow ||
        raw.event !== "workflow_dispatch" ||
        !["in_progress", "completed"].includes(String(raw.status)) ||
        (raw.status === "in_progress"
          ? raw.conclusion !== null
          : ![
              "success",
              "failure",
              "cancelled",
              "timed_out",
              "action_required",
              "neutral",
              "skipped",
              "stale",
              "startup_failure",
            ].includes(String(raw.conclusion))) ||
        !isRecord(raw.repository) ||
        raw.repository.id !== 1354613114 ||
        raw.repository.full_name !== "boburning/portcove" ||
        !isRecord(raw.head_repository) ||
        raw.head_repository.id !== 1354613114
      )
        throw new Error("context controller run/source/attempt differs");
      return { id: raw.id, attempt: raw.run_attempt, source: raw.head_sha };
    };
    const artifact = (item: { id: number; sha256: string }, bundle: boolean) => {
      const raw = get(`actions/artifacts/${item.id}`);
      if (
        !isRecord(raw) ||
        raw.id !== item.id ||
        raw.name !==
          `trusted-payload-signing-context${bundle ? "-attestation" : ""}-${expected.run_id}-${expected.run_attempt}` ||
        raw.expired !== false ||
        raw.digest !== `sha256:${item.sha256}` ||
        typeof raw.size_in_bytes !== "number" ||
        !Number.isSafeInteger(raw.size_in_bytes) ||
        raw.size_in_bytes < 22 ||
        raw.size_in_bytes >
          (bundle ? 4 * 1024 ** 2 : signingContextArchiveLimits.compressedBytes) ||
        !isRecord(raw.workflow_run) ||
        String(raw.workflow_run.id) !== expected.run_id ||
        raw.workflow_run.repository_id !== 1354613114 ||
        raw.workflow_run.head_repository_id !== 1354613114 ||
        raw.workflow_run.head_sha !== expected.controller_revision
      )
        throw new Error("context artifact provider identity differs");
      return { id: item.id, bytes: raw.size_in_bytes, sha256: item.sha256 };
    };
    const snapshot = () => {
      const source = get(`git/commits/${expected.controller_revision}`);
      if (
        !isRecord(source) ||
        source.sha !== expected.controller_revision ||
        !isRecord(source.tree) ||
        source.tree.sha !== expected.source_tree
      )
        throw new Error("context controller source tree differs");
      return {
        source: { commit: source.sha, tree: source.tree.sha },
        run: run(get(`actions/runs/${expected.run_id}`)),
        attempt: run(get(`actions/runs/${expected.run_id}/attempts/${expected.run_attempt}`)),
        artifact: artifact(expected.artifact, false),
        bundle: artifact(expected.bundle, true),
      };
    };
    const before = snapshot();
    await writeFile(path.join(directory, "provider-before.json"), JSON.stringify(before), {
      flag: "wx",
      mode: 0o600,
    });
    const acquire = (item: { id: number; bytes: number; sha256: string }) => {
      const bytes = download(`repos/boburning/portcove/actions/artifacts/${item.id}/zip`, {
        cwd: directory,
        maxBytes: item.bytes,
        timeoutMs: signingContextRemaining(deadline, 30000),
        spawn: (command, argv, settings) =>
          spawnSync(command, argv, { ...settings, env: environment }),
      });
      signingContextRemaining(deadline, 15000);
      if (bytes.length !== item.bytes || hash(bytes) !== item.sha256)
        throw new Error("context opaque archive byte identity differs");
      return Buffer.from(bytes);
    };
    phase = "opaque-download";
    const archive = acquire(before.artifact),
      bundleArchive = acquire(before.bundle);
    await writeFile(path.join(directory, "context.zip"), archive, { flag: "wx", mode: 0o600 });
    await writeFile(path.join(directory, "bundle.zip"), bundleArchive, { flag: "wx", mode: 0o600 });
    const inspected = inspectSigningContextArchive(archive);
    if (
      inspected.manifest_sha256 !== expected.manifest_sha256 ||
      digest(inspected.manifest.binding) !== expected.binding_sha256 ||
      inspected.manifest.facts_sha256 !== expected.facts_sha256 ||
      digest(inspected.manifest.controller) !== digest(controller)
    )
      throw new Error("context expected source/candidate/record binding differs");
    const bundleEntries = inspectBoundedZip(bundleArchive, {
      compressedBytes: 4 * 1024 ** 2,
      expandedBytes: 2 * 1024 ** 2,
      files: 1,
      nameBytes: 64,
      allowedPaths: new Set(["signing-context-attestation.json"]),
    }).entries;
    const entry = bundleEntries[0];
    if (!entry || bundleEntries.length !== 1 || entry.bytes < 1)
      throw new Error("context attestation bundle inventory differs");
    const compressed = bundleArchive.subarray(entry.data, entry.dataEnd),
      bundleBytes =
        entry.method === 0
          ? Buffer.from(compressed)
          : inflateRawSync(compressed, { maxOutputLength: entry.bytes });
    if (bundleBytes.length !== entry.bytes || crc32(bundleBytes) !== entry.crc)
      throw new Error("context attestation bundle bytes differ");
    const manifestPath = path.join(directory, "signing-context-manifest.json"),
      bundlePath = path.join(directory, "attestation.json");
    await writeFile(manifestPath, inspected.manifest_bytes, { flag: "wx", mode: 0o600 });
    await writeFile(bundlePath, bundleBytes, { flag: "wx", mode: 0o600 });
    phase = "existing-pinned-attestation-verifier";
    const statement = verifyControllerArtifactStatement(
      directory,
      manifestPath,
      bundlePath,
      expected,
      signingContextPredicateType,
      { ...(verifierSpawn ? { spawn: verifierSpawn } : {}), environment, deadline },
    );
    if (
      statement._type !== "https://in-toto.io/Statement/v1" ||
      statement.predicateType !== signingContextPredicateType ||
      digest(statement.subject) !==
        digest([
          {
            name: "release-signing-context-manifest",
            digest: { sha256: inspected.manifest_sha256 },
          },
        ]) ||
      !isRecord(statement.predicate) ||
      !isRecord(statement.predicate.producer)
    )
      throw new Error("context verified subject or producer absent");
    const producer = statement.predicate.producer;
    if (
      typeof producer.job_id !== "number" ||
      !Number.isSafeInteger(producer.job_id) ||
      producer.job_id < 1 ||
      typeof producer.check_run_id !== "string" ||
      !/^[1-9][0-9]{0,15}$/u.test(producer.check_run_id)
    )
      throw new Error("context signed numeric producer identity differs");
    const wanted = {
      schema_version: 1,
      role: "release-signing-context",
      controller,
      producer: {
        run_id: expected.run_id,
        run_attempt: expected.run_attempt,
        job_id: producer.job_id,
        check_run_id: producer.check_run_id,
      },
      artifact: before.artifact,
      manifest_sha256: inspected.manifest_sha256,
      binding: inspected.manifest.binding,
      facts_sha256: expected.facts_sha256,
      stage: "payload-signing",
      publication_admission: "not-established",
      authority: "none",
    };
    if (digest(statement.predicate) !== digest(wanted))
      throw new Error("context signed predicate association differs");
    const readJob = () => {
      const job = get(`actions/jobs/${String(producer.job_id)}`);
      if (
        !isRecord(job) ||
        job.id !== producer.job_id ||
        String(job.run_id) !== expected.run_id ||
        job.run_attempt !== expected.run_attempt ||
        job.head_sha !== expected.controller_revision ||
        job.name !== "Sign admitted updater payloads" ||
        job.status !== "completed" ||
        job.conclusion !== "success" ||
        job.check_run_url !==
          `https://api.github.com/repos/boburning/portcove/check-runs/${String(producer.check_run_id)}`
      )
        throw new Error("context completed payload producer identity differs");
      return job;
    };
    const job = readJob();
    const refresh = () => {
      const current = snapshot(),
        currentJob = readJob();
      if (digest(current) !== digest(before) || digest(currentJob) !== digest(job))
        throw new Error("context provider custody changed");
      return { ...current, producer: currentJob };
    };
    const after = refresh();
    const statementBytes = Buffer.from(JSON.stringify(statement)),
      providerBytes = Buffer.from(JSON.stringify(after));
    await writeFile(path.join(directory, "verified-statement.json"), statementBytes, {
      flag: "wx",
      mode: 0o600,
    });
    await writeFile(path.join(directory, "provider-after.json"), providerBytes, {
      flag: "wx",
      mode: 0o600,
    });
    const publicEvidence = new Map([
      ["context.zip", archive],
      ["bundle.zip", bundleArchive],
      ["signing-context-manifest.json", inspected.manifest_bytes],
      ["attestation.json", bundleBytes],
      ["verified-statement.json", statementBytes],
      ["provider-before.json", Buffer.from(JSON.stringify(before))],
      ["provider-after.json", providerBytes],
    ]);
    phase = "materialize-authenticated-public-context";
    const context = path.join(directory, "context");
    await mkdir(context, { mode: 0o700 });
    for (const [name, bytes] of inspected.files) {
      signingContextRemaining(deadline, 15000);
      const destination = await assertOwnedUnlinkedPath(
        context,
        path.join(context, name),
        "authenticated public signing context",
      );
      await mkdir(path.dirname(destination), { recursive: true, mode: 0o700 });
      await writeFile(destination, bytes, { flag: "wx", mode: 0o600 });
    }
    signingContextRemaining(deadline, 15000);
    const receipt = Object.freeze({
      kind: "attested-pre-sign-release-context",
      directory,
      manifest_sha256: inspected.manifest_sha256,
      evidence_scope: injected ? "injected-provider" : "github.com",
      publication_admission: "not-established",
      authority: "none",
    });
    if (!injected)
      received.set(receipt, {
        directory,
        context,
        manifest: inspected.manifest,
        files: identities(inspected.files),
        public_evidence: identities(publicEvidence),
        active: () => {
          signingContextRemaining(deadline, 15000);
        },
        refresh,
        tighten: (phaseDeadline) => {
          signingContextRemaining(phaseDeadline, 15000);
          deadline = Math.min(deadline, phaseDeadline);
        },
      });
    return receipt;
  } catch {
    await writeFile(
      path.join(directory, "refusal.json"),
      JSON.stringify({ phase, directory, authority: "none", automatic_retry: false }),
      { flag: "wx", mode: 0o600 },
    ).catch(() => {});
    throw new Error(`signing context acquisition refused; retain ${directory}`);
  }
}

async function readReceivedSigningContext(
  receipt: object,
  phaseDeadline: number | undefined,
  provider: "fresh" | "retained",
) {
  const actual = received.get(receipt);
  if (!actual) throw new Error("actual authenticated signing context receiver required");
  if (phaseDeadline !== undefined) actual.tighten(phaseDeadline);
  actual.active();
  for (const file of actual.public_evidence) {
    const destination = await assertOwnedUnlinkedPath(
      actual.directory,
      path.join(actual.directory, file.path),
      "retained signing context proof",
    );
    const bytes = await readControllerToolFile(destination, file.bytes);
    if (bytes.length !== file.bytes || hash(bytes) !== file.sha256)
      throw new Error("authenticated signing context proof changed");
    actual.active();
  }
  // Refuse new/mutated materialization before the fixed Rust tool consumes it.
  if (
    digest(identities(await readBoundedReleaseContextFiles(actual.context))) !==
    digest(actual.files)
  )
    throw new Error("authenticated signing context retained inventory changed");
  if (provider === "fresh") actual.refresh();
  return Object.freeze({
    directory: actual.directory,
    context: path.join(actual.context, "context.json"),
    manifest: structuredClone(actual.manifest),
    publication_admission: "not-established",
    provenance:
      provider === "fresh"
        ? ("fresh-provider-readback" as const)
        : ("original-verified-snapshot" as const),
    authority: "none",
  });
}
export function requireReceivedSigningContext(receipt: object, phaseDeadline?: number) {
  return readReceivedSigningContext(receipt, phaseDeadline, "fresh");
}
/** Historical immutable provenance only. All originally authenticated statement,
 * certificate/provider proof and complete context bytes are rehashed; no new
 * provider observation, current eligibility or protected authority is implied. */
export function requireRetainedSigningContext(receipt: object, phaseDeadline?: number) {
  return readReceivedSigningContext(receipt, phaseDeadline, "retained");
}
