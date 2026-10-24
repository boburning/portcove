/** The existing controller attestation verifier binds a completed role's public
 * output. This is component custody; current role controls/journal admission
 * remain the caller's responsibility before its next key or provider effect. */
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, writeFile, readdir } from "node:fs/promises";
import path from "node:path";
import { crc32, inflateRawSync } from "node:zlib";
import { performance } from "node:perf_hooks";
import { inspectBoundedZip } from "./bounded-zip.mts";
import { GitHubApiClient, createGitHubRunner } from "./github-api.mts";
import type { GitHubRestReader } from "./github-api.mts";
import { readGitHubArtifactArchive } from "./github-binary.mts";
import { verifyControllerArtifactStatement } from "./github-controller-attestation.mts";
import { inspectCapacityExecutorIdentity } from "./release-capacity.mts";
import { releaseCanonicalDigest as digest } from "./release-canonical.mts";
import { releaseControlPhaseProfile, type TufSigningRole } from "./release-control-phases.mts";
import {
  readSigningOutputArtifact,
  inspectSigningOutputArchive,
} from "./release-signing-handoff.mts";
import { inspectTufSigningRole } from "./release-tuf-signing.mts";
import { inspectCatalogSigningRole, catalogRoleName } from "./release-catalog-signing-contract.mts";
import type { CatalogSigningRole } from "./release-catalog-signing-contract.mts";
import { readControllerToolFile } from "./release-controller-tools.mts";
import {
  requireReceivedSigningContext,
  requireRetainedSigningContext,
  requireReceivedCatalogSigningContext,
  requireRetainedCatalogSigningContext,
} from "./release-signing-context-artifact.mts";
import { isRecord } from "./runtime-values.mts";
import { assertOwnedUnlinkedPath } from "./release-path-safety.mts";

const base = "repos/boburning/portcove",
  hash = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
export const tufRolePredicateType = "https://portcove.dev/attestations/tuf-role-output/v1";
export const catalogRolePredicateType = "https://portcove.dev/attestations/catalog-role-output/v1";
type Artifact = { id: number; sha256: string };
export interface TufRoleArtifactExpected {
  role: TufSigningRole;
  controller: {
    controller_revision: string;
    source_tree: string;
    controller_ref: string;
    run_id: string;
    run_attempt: number;
  };
  artifact: Artifact;
  bundle: Artifact;
  context_manifest_sha256: string;
  context_binding_sha256: string;
  context_facts_sha256: string;
}
export type CatalogRoleArtifactExpected = Omit<TufRoleArtifactExpected, "role"> & {
  purpose: "catalog";
  role: CatalogSigningRole;
};
function exact(raw: unknown, keys: string): asserts raw is Record<string, unknown> {
  if (!isRecord(raw) || Object.keys(raw).sort().join(",") !== keys)
    throw new Error("TUF role custody exact schema differs");
}
function sha(raw: unknown): asserts raw is string {
  if (typeof raw !== "string" || !/^[a-f0-9]{64}$/u.test(raw))
    throw new Error("TUF role digest differs");
}
export function inspectTufRoleArtifactExpected(raw: unknown): TufRoleArtifactExpected {
  return inspectRoleArtifactExpected(raw, "application") as TufRoleArtifactExpected;
}
export function inspectCatalogRoleArtifactExpected(raw: unknown): CatalogRoleArtifactExpected {
  return inspectRoleArtifactExpected(raw, "catalog") as CatalogRoleArtifactExpected;
}
function inspectRoleArtifactExpected(raw: unknown, purpose: "application" | "catalog") {
  const value: unknown = structuredClone(raw);
  exact(
    value,
    purpose === "catalog"
      ? "artifact,bundle,context_binding_sha256,context_facts_sha256,context_manifest_sha256,controller,purpose,role"
      : "artifact,bundle,context_binding_sha256,context_facts_sha256,context_manifest_sha256,controller,role",
  );
  if (purpose === "catalog") {
    if (value.purpose !== "catalog") throw new Error("explicit catalog role custody required");
    inspectCatalogSigningRole(value.role);
  } else inspectTufSigningRole(value.role);
  for (const name of ["context_binding_sha256", "context_facts_sha256", "context_manifest_sha256"])
    sha(value[name]);
  for (const item of [value.artifact, value.bundle]) {
    exact(item, "id,sha256");
    if (typeof item.id !== "number" || !Number.isSafeInteger(item.id) || item.id < 1)
      throw new Error("TUF role immutable artifact ID differs");
    sha(item.sha256);
  }
  exact(value.artifact, "id,sha256");
  exact(value.bundle, "id,sha256");
  if (value.artifact.id === value.bundle.id)
    throw new Error("TUF role output/bundle IDs must differ");
  exact(value.controller, "controller_ref,controller_revision,run_attempt,run_id,source_tree");
  if (
    !/^[a-f0-9]{40}$/u.test(String(value.controller.controller_revision)) ||
    !/^[a-f0-9]{40}$/u.test(String(value.controller.source_tree)) ||
    !/^refs\/tags\/portcove-production-controller-[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u.test(
      String(value.controller.controller_ref),
    ) ||
    !/^[1-9][0-9]{0,15}$/u.test(String(value.controller.run_id)) ||
    value.controller.run_attempt !== 1
  )
    throw new Error("TUF role fixed producing source/run differs");
  return value as unknown as TufRoleArtifactExpected | CatalogRoleArtifactExpected;
}
function unpack(raw: Buffer, allowed: ReadonlySet<string>, maximum = 2 * 1024 * 1024) {
  if (raw.length > maximum) throw new Error("TUF role opaque ZIP exceeds bound");
  const files = new Map<string, Buffer>();
  for (const entry of inspectBoundedZip(raw, {
    compressedBytes: maximum,
    expandedBytes: maximum,
    files: allowed.size,
    nameBytes: 64,
    allowedPaths: allowed,
  }).entries) {
    if (
      entry.bytes < 1 ||
      entry.bytes > (entry.name === "signing-output-manifest.json" ? 65536 : 1024 * 1024)
    )
      throw new Error("TUF role member bound differs");
    const compressed = raw.subarray(entry.data, entry.dataEnd),
      bytes =
        entry.method === 0
          ? Buffer.from(compressed)
          : inflateRawSync(compressed, { maxOutputLength: entry.bytes });
    if (bytes.length !== entry.bytes || crc32(bytes) !== entry.crc)
      throw new Error("TUF role member CRC differs");
    files.set(entry.name, bytes);
  }
  if (files.size !== allowed.size) throw new Error("TUF role complete inventory missing");
  return files;
}

/** Read-only public verification. Injected boundaries can never populate the
 * actual outer receiver's private map. No POST/retry/candidate execution. */
const refreshReaders = new WeakMap<object, (phaseDeadline?: number) => void>();
type RoleReaderOptions = {
  api?: GitHubRestReader;
  download?: typeof readGitHubArtifactArchive;
  spawn?: NonNullable<Parameters<typeof createGitHubRunner>[0]>["spawn"];
  archiveSpawn?: NonNullable<Parameters<typeof readGitHubArtifactArchive>[1]>["spawn"];
};
export async function readAttestedTufRoleArtifact(
  parent: string,
  raw: unknown,
  deadline: number,
  options: RoleReaderOptions = {},
) {
  return readAttestedRoleArtifact(
    parent,
    inspectTufRoleArtifactExpected(raw),
    deadline,
    options,
    "application",
  );
}
export async function readAttestedCatalogRoleArtifact(
  parent: string,
  raw: unknown,
  deadline: number,
  options: RoleReaderOptions = {},
) {
  return readAttestedRoleArtifact(
    parent,
    inspectCatalogRoleArtifactExpected(raw),
    deadline,
    options,
    "catalog",
  );
}
async function readAttestedRoleArtifact<
  Expected extends TufRoleArtifactExpected | CatalogRoleArtifactExpected,
>(
  parent: string,
  expected: Expected,
  deadline: number,
  options: RoleReaderOptions,
  purpose: "application" | "catalog",
) {
  const wireRole = purpose === "catalog" ? catalogRoleName(expected.role) : expected.role,
    producerRole = `${purpose === "catalog" ? "catalog" : "tuf"}-${expected.role}`,
    predicateType = purpose === "catalog" ? catalogRolePredicateType : tufRolePredicateType,
    injected = !!(options.api || options.download || options.spawn || options.archiveSpawn),
    selected = { ...options };
  const remaining = (max = 15000) => {
    const left = Math.floor(deadline - performance.now());
    if (!Number.isFinite(deadline) || left < 1 || left > 600000)
      throw new Error("TUF role receiver deadline exhausted");
    return Math.min(max, left);
  };
  remaining();
  if (!path.isAbsolute(parent)) throw new Error("TUF role output parent must be absolute");
  const directory = await mkdtemp(path.join(parent, "tuf-role-custody-"));
  let phase = "provider-before";
  const environment = Object.fromEntries(
    Object.entries(process.env).filter(([name]) =>
      ["PATH", "Path", "SystemRoot", "WINDIR", "GH_TOKEN"].includes(name),
    ),
  );
  Object.assign(environment, {
    HOME: directory,
    USERPROFILE: directory,
    XDG_CONFIG_HOME: directory,
    GH_CONFIG_DIR: directory,
    GH_HOST: "github.com",
    GH_PROMPT_DISABLED: "1",
  });
  const api =
    selected.api ??
    new GitHubApiClient((args, input) =>
      createGitHubRunner({
        cwd: directory,
        timeoutMs: remaining(),
        maxBuffer: 128 * 1024,
        spawn: (command, argv, settings) =>
          (selected.spawn ?? spawnSync)(command, argv, { ...settings, env: environment }),
      })([...args, "--hostname", "github.com"], input),
    );
  const get = (route: string) => {
    remaining();
    const result = api.request("GET", `${base}/${route}`);
    remaining();
    if (result.status !== 200) throw new Error("TUF role provider unavailable");
    return result.body;
  };
  const artifact = (item: Artifact, bundle: boolean) => {
    const value = get(`actions/artifacts/${item.id}`);
    const name = `trusted-${producerRole}-${bundle ? "attestation" : "output"}-${expected.controller.run_id}-1`;
    if (
      !isRecord(value) ||
      value.id !== item.id ||
      value.name !== name ||
      value.expired !== false ||
      value.digest !== `sha256:${item.sha256}` ||
      typeof value.size_in_bytes !== "number" ||
      !Number.isSafeInteger(value.size_in_bytes) ||
      value.size_in_bytes < 22 ||
      value.size_in_bytes > 2 * 1024 * 1024 ||
      !isRecord(value.workflow_run) ||
      String(value.workflow_run.id) !== expected.controller.run_id ||
      value.workflow_run.repository_id !== 1354613114 ||
      value.workflow_run.head_repository_id !== 1354613114 ||
      value.workflow_run.head_sha !== expected.controller.controller_revision
    )
      throw new Error("TUF role artifact association differs");
    return { id: item.id, bytes: value.size_in_bytes, sha256: item.sha256, name };
  };
  const download = (item: { id: number; bytes: number; sha256: string }) => {
    remaining();
    const bytes = (selected.download ?? readGitHubArtifactArchive)(
      `${base}/actions/artifacts/${item.id}/zip`,
      {
        cwd: directory,
        maxBytes: item.bytes,
        timeoutMs: remaining(30000),
        spawn: (command, argv, settings) =>
          (selected.archiveSpawn ?? spawnSync)(command, argv, { ...settings, env: environment }),
      },
    );
    remaining();
    if (bytes.length !== item.bytes || hash(bytes) !== item.sha256)
      throw new Error("TUF role opaque archive differs");
    return bytes;
  };
  try {
    const before = {
      artifact: artifact(expected.artifact, false),
      bundle: artifact(expected.bundle, true),
    };
    await writeFile(path.join(directory, "provider-before.json"), JSON.stringify(before), {
      flag: "wx",
      mode: 0o600,
    });
    phase = "opaque-inputs";
    const archive = download(before.artifact),
      bundleArchive = download(before.bundle);
    await writeFile(path.join(directory, "original-output.zip"), archive, {
      flag: "wx",
      mode: 0o600,
    });
    await writeFile(path.join(directory, "attestation.zip"), bundleArchive, {
      flag: "wx",
      mode: 0o600,
    });
    const rawFiles = unpack(archive, new Set([`${wireRole}.json`, "signing-output-manifest.json"]));
    const manifestBytes = rawFiles.get("signing-output-manifest.json")!;
    if (!Buffer.from(manifestBytes.toString("utf8")).equals(manifestBytes))
      throw new Error("TUF role manifest UTF-8 differs");
    const manifest: unknown = JSON.parse(manifestBytes.toString("utf8"));
    exact(manifest, "authority,files,input_binding_sha256,pending,producer,schema_version");
    exact(manifest.pending, "checkpoint,operation_id");
    const producer = inspectCapacityExecutorIdentity(manifest.producer);
    if (
      manifest.schema_version !== 1 ||
      manifest.authority !== "none" ||
      manifest.input_binding_sha256 !== expected.context_binding_sha256 ||
      producer.role !== producerRole ||
      producer.controller_revision !== expected.controller.controller_revision ||
      producer.execution_ref !== expected.controller.controller_ref ||
      producer.run_id !== expected.controller.run_id ||
      producer.run_attempt !== 1 ||
      typeof manifest.pending.checkpoint !== "string" ||
      !/^[a-f0-9]{40}$/u.test(manifest.pending.checkpoint)
    )
      throw new Error("TUF role signed output manifest differs");
    sha(manifest.pending.operation_id);
    if (!Array.isArray(manifest.files) || manifest.files.length !== 1)
      throw new Error("TUF role envelope inventory differs");
    const item: unknown = manifest.files[0];
    exact(item, "bytes,filename,sha256");
    const envelope = rawFiles.get(`${wireRole}.json`)!;
    if (
      item.filename !== `${wireRole}.json` ||
      item.bytes !== envelope.length ||
      item.sha256 !== hash(envelope)
    )
      throw new Error("TUF role exact envelope differs");
    const files = [
      { filename: `${wireRole}.json`, bytes: envelope.length, sha256: hash(envelope) },
      {
        filename: "signing-output-manifest.json",
        bytes: manifestBytes.length,
        sha256: hash(manifestBytes),
      },
    ];
    inspectSigningOutputArchive(archive, files);
    const bundle = unpack(bundleArchive, new Set(["role-attestation.json"])).get(
      "role-attestation.json",
    )!;
    const manifestPath = path.join(directory, "signing-output-manifest.json"),
      bundlePath = path.join(directory, "role-attestation.json");
    await writeFile(manifestPath, manifestBytes, { flag: "wx", mode: 0o600 });
    await writeFile(bundlePath, bundle, { flag: "wx", mode: 0o600 });
    phase = "existing-attestation-verifier";
    const statement = verifyControllerArtifactStatement(
      directory,
      manifestPath,
      bundlePath,
      expected.controller,
      predicateType,
      {
        deadline,
        environment,
        ...(selected.spawn
          ? {
              spawn: (command, argv, settings) =>
                selected.spawn!(command, argv, { ...settings, env: environment }),
            }
          : {}),
      },
    );
    const predicate = {
      schema_version: 1,
      role: producerRole,
      controller: expected.controller,
      producer,
      artifact: before.artifact,
      manifest_sha256: hash(manifestBytes),
      context_manifest_sha256: expected.context_manifest_sha256,
      context_binding_sha256: expected.context_binding_sha256,
      context_facts_sha256: expected.context_facts_sha256,
      envelope: files[0],
      pending: manifest.pending,
      publication_admission: "not-established",
      authority: "none",
    };
    if (
      statement._type !== "https://in-toto.io/Statement/v1" ||
      statement.predicateType !== predicateType ||
      digest(statement.subject) !==
        digest([
          {
            name:
              purpose === "catalog" ? "catalog-role-output-manifest" : "tuf-role-output-manifest",
            digest: { sha256: hash(manifestBytes) },
          },
        ]) ||
      digest(statement.predicate) !== digest(predicate)
    )
      throw new Error("TUF role attested predicate/context differs");
    await writeFile(path.join(directory, "verified-statement.json"), JSON.stringify(statement), {
      flag: "wx",
      mode: 0o600,
    });
    phase = "completed-provider-byte-readback";
    await mkdir(path.join(directory, "output"), { mode: 0o700 });
    for (const [name, bytes] of rawFiles)
      await writeFile(path.join(directory, "output", name), bytes, { flag: "wx", mode: 0o600 });
    const custody = await readSigningOutputArtifact(
      directory,
      {
        producer,
        artifact_id: expected.artifact.id,
        archive_sha256: expected.artifact.sha256,
        name: before.artifact.name,
        files,
      },
      {
        deadline,
        producerState: "completed",
        ...(selected.api ? { api: selected.api } : {}),
        ...(selected.download ? { download: selected.download } : {}),
        ...(selected.spawn ? { spawn: selected.spawn } : {}),
        ...(selected.archiveSpawn ? { archiveSpawn: selected.archiveSpawn } : {}),
      },
    );
    const readJob = () => {
      const job = get(`actions/jobs/${Number(producer.job_id)}`);
      if (
        !isRecord(job) ||
        job.id !== producer.job_id ||
        String(job.run_id) !== expected.controller.run_id ||
        job.run_attempt !== 1 ||
        job.head_sha !== expected.controller.controller_revision ||
        job.check_run_url !==
          `https://api.github.com/repos/boburning/portcove/check-runs/${String(producer.check_run_id)}` ||
        job.status !== "completed" ||
        job.conclusion !== "success" ||
        job.name !== releaseControlPhaseProfile(producerRole).reader_name
      )
        throw new Error("TUF role fixed completed job role differs");
      return job;
    };
    const job = readJob();
    const after = {
      artifact: artifact(expected.artifact, false),
      bundle: artifact(expected.bundle, true),
    };
    if (digest(after) !== digest(before)) throw new Error("TUF role provider drifted");
    await writeFile(path.join(directory, "provider-after.json"), JSON.stringify(after), {
      flag: "wx",
      mode: 0o600,
    });
    remaining();
    const result = Object.freeze({
      directory,
      expected,
      envelope: { ...files[0]!, path: path.join(directory, "output", `${wireRole}.json`) },
      custody,
      predicate,
      evidence_scope: injected ? "injected-provider" : "github.com",
      authority: "none",
    });
    refreshReaders.set(result, (phaseDeadline) => {
      if (phaseDeadline !== undefined) {
        if (!Number.isFinite(phaseDeadline) || phaseDeadline <= performance.now())
          throw new Error("TUF role receiver deadline exhausted");
        deadline = Math.min(deadline, phaseDeadline);
      }
      remaining();
      const fresh = {
        artifact: artifact(expected.artifact, false),
        bundle: artifact(expected.bundle, true),
      };
      if (digest(fresh) !== digest(before) || digest(readJob()) !== digest(job))
        throw new Error("TUF role provider custody changed before use");
    });
    return result;
  } catch {
    await writeFile(
      path.join(directory, "refusal.json"),
      JSON.stringify({ phase, authority: "none" }),
      { flag: "wx", mode: 0o600 },
    );
    throw new Error(`TUF role custody refused; retain ${directory}`);
  }
}

const received = new WeakMap<
  object,
  {
    context: object;
    data: Awaited<ReturnType<typeof readAttestedRoleArtifact>>;
    purpose: "application" | "catalog";
    files: { path: string; bytes: number; sha256: string }[];
    deadline: number;
  }
>();
/** Refreshes provider custody only. This cannot mint a received-role brand. A
 * tighter deadline permanently bounds this data session's live transports. */
export function recheckTufRoleArtifactCustody(data: object, phaseDeadline?: number) {
  const refresh = refreshReaders.get(data);
  if (!refresh) throw new Error("known TUF role custody session required");
  refresh(phaseDeadline);
}
async function assertRoleProofInventory(directory: string, files: readonly { path: string }[]) {
  const rootNames = [
    ...new Set(files.map((file) => path.relative(directory, file.path).split(path.sep)[0]!)),
  ].sort();
  const actual = await readdir(directory, { withFileTypes: true });
  if (
    digest(actual.map((entry) => entry.name).sort()) !== digest(rootNames) ||
    actual.some(
      (entry) =>
        entry.isSymbolicLink() ||
        (entry.name === "output" ? !entry.isDirectory() : !entry.isFile()),
    )
  )
    throw new Error("TUF role retained proof inventory changed");
  const outputs = files
    .filter((file) => path.dirname(file.path) === path.join(directory, "output"))
    .map((file) => path.basename(file.path))
    .sort();
  if (digest((await readdir(path.join(directory, "output"))).sort()) !== digest(outputs))
    throw new Error("TUF role retained output inventory changed");
}
export async function receiveTufRoleArtifact(
  contextReceipt: object,
  parent: string,
  raw: unknown,
  deadline: number,
) {
  return receiveRoleArtifact(contextReceipt, parent, raw, deadline, "application");
}
export async function receiveCatalogRoleArtifact(
  contextReceipt: object,
  parent: string,
  raw: unknown,
  deadline: number,
) {
  return receiveRoleArtifact(contextReceipt, parent, raw, deadline, "catalog");
}
async function receiveRoleArtifact(
  contextReceipt: object,
  parent: string,
  raw: unknown,
  deadline: number,
  purpose: "application" | "catalog",
) {
  const requireContext =
    purpose === "catalog" ? requireReceivedCatalogSigningContext : requireReceivedSigningContext;
  const context = await requireContext(contextReceipt, deadline),
    expected =
      purpose === "catalog"
        ? inspectCatalogRoleArtifactExpected(raw)
        : inspectTufRoleArtifactExpected(raw),
    wireRole = purpose === "catalog" ? catalogRoleName(expected.role) : expected.role;
  exact(
    context.manifest.controller,
    "controller_ref,controller_revision,run_attempt,run_id,source_tree",
  );
  const controller = context.manifest.controller;
  if (
    controller.controller_revision !== expected.controller.controller_revision ||
    controller.source_tree !== expected.controller.source_tree ||
    controller.controller_ref !== expected.controller.controller_ref ||
    digest(context.manifest.binding) !== expected.context_binding_sha256 ||
    context.manifest.facts_sha256 !== expected.context_facts_sha256 ||
    hash(
      await readControllerToolFile(
        path.join(context.directory, "signing-context-manifest.json"),
        1024 * 1024,
      ),
    ) !== expected.context_manifest_sha256
  )
    throw new Error("TUF role differs from actual authenticated context");
  const data = await readAttestedRoleArtifact(parent, expected, deadline, {}, purpose);
  if (data.evidence_scope !== "github.com") throw new Error("actual TUF role custody required");
  await requireContext(contextReceipt, deadline);
  const files = [];
  for (const name of [
    "provider-before.json",
    "provider-after.json",
    "original-output.zip",
    "attestation.zip",
    "signing-output-manifest.json",
    "role-attestation.json",
    "verified-statement.json",
    "signing-output-readback.json",
    "signing-output-provider-before.json",
    "signing-output-provider-after.json",
    "signing-output.zip",
    "output/signing-output-manifest.json",
    `output/${wireRole}.json`,
  ]) {
    const file = path.join(data.directory, name),
      bytes = await readControllerToolFile(file, 2 * 1024 * 1024);
    files.push({ path: file, bytes: bytes.length, sha256: hash(bytes) });
  }
  await assertRoleProofInventory(data.directory, files);
  const receipt = Object.freeze({
    kind: purpose === "catalog" ? "attested-catalog-role-output" : "attested-TUF-role-output",
    role: expected.role,
    authority: "none",
  });
  received.set(receipt, { context: contextReceipt, data, files, deadline, purpose });
  return receipt;
}
async function readReceivedTufRoleArtifact(
  receipt: object,
  phaseDeadline: number | undefined,
  provider: "fresh" | "retained",
  purpose: "application" | "catalog" = "application",
) {
  const actual = received.get(receipt);
  if (actual && actual.purpose !== purpose)
    throw new Error("role artifact component purpose differs");
  if (actual && phaseDeadline !== undefined) {
    if (!Number.isFinite(phaseDeadline) || phaseDeadline <= performance.now())
      throw new Error("TUF role phase deadline exhausted");
    actual.deadline = Math.min(actual.deadline, phaseDeadline);
  }
  if (!actual || performance.now() >= actual.deadline)
    throw new Error("actual current TUF role custody required");
  await (
    purpose === "catalog"
      ? provider === "fresh"
        ? requireReceivedCatalogSigningContext
        : requireRetainedCatalogSigningContext
      : provider === "fresh"
        ? requireReceivedSigningContext
        : requireRetainedSigningContext
  )(actual.context, actual.deadline);
  await assertRoleProofInventory(actual.data.directory, actual.files);
  for (const file of actual.files) {
    await assertOwnedUnlinkedPath(actual.data.directory, file.path, "TUF role retained evidence");
    const bytes = await readControllerToolFile(file.path, file.bytes);
    if (bytes.length !== file.bytes || hash(bytes) !== file.sha256)
      throw new Error("TUF role retained proof changed");
  }
  if (provider === "fresh") recheckTufRoleArtifactCustody(actual.data, actual.deadline);
  if (performance.now() >= actual.deadline) throw new Error("TUF role phase deadline exhausted");
  return Object.freeze({
    role: actual.data.expected.role,
    envelope: { ...actual.data.envelope },
    expected: structuredClone(actual.data.expected),
    provenance:
      provider === "fresh"
        ? ("fresh-provider-readback" as const)
        : ("original-verified-snapshot" as const),
    authority: "none",
  });
}
export function requireReceivedTufRoleArtifact(receipt: object, phaseDeadline?: number) {
  return readReceivedTufRoleArtifact(receipt, phaseDeadline, "fresh");
}
/** Rehashes the original authenticated completed-role proof and output without
 * pretending to observe the provider again. No imported report can enter it. */
export function requireRetainedTufRoleArtifact(receipt: object, phaseDeadline?: number) {
  return readReceivedTufRoleArtifact(receipt, phaseDeadline, "retained");
}
export function requireReceivedCatalogRoleArtifact(receipt: object, phaseDeadline?: number) {
  return readReceivedTufRoleArtifact(receipt, phaseDeadline, "fresh", "catalog");
}
export function requireRetainedCatalogRoleArtifact(receipt: object, phaseDeadline?: number) {
  return readReceivedTufRoleArtifact(receipt, phaseDeadline, "retained", "catalog");
}

/** Data-only original proof snapshot, never a received-role brand or lifetime
 * renewal. The actual default receiver must still be live at this handoff. */
export async function snapshotReceivedTufRoleEvidence(receipt: object, deadline: number) {
  await requireReceivedTufRoleArtifact(receipt, deadline);
  const actual = received.get(receipt)!;
  if (performance.now() >= actual.deadline) throw new Error("original role phase exhausted");
  return {
    root: actual.data.directory,
    files: actual.files.map((file) => ({
      ...file,
      path: path.relative(actual.data.directory, file.path),
    })),
  };
}
