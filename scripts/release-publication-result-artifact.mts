/** The existing fixed-controller attestation/provider handoff for the owned
 * immutable publisher. This transfers settled-result provenance, never a live
 * reservation, site deployment permission or completed public updater journey. */
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import path from "node:path";
import { crc32, inflateRawSync } from "node:zlib";
import { performance } from "node:perf_hooks";
import { setTimeout as delay } from "node:timers/promises";
import { inspectBoundedZip } from "./bounded-zip.mts";
import { GitHubApiClient, createGitHubRunner } from "./github-api.mts";
import type { GitHubRestReader } from "./github-api.mts";
import { readGitHubArtifactArchive } from "./github-binary.mts";
import { verifyControllerArtifactStatement } from "./github-controller-attestation.mts";
import { productionControllerWorkflow } from "./production-controller-admission.mts";
import {
  requireOwnedPublicationResult,
  inspectPublicationRecordAssociation,
} from "./release-publication-result.mts";
import {
  requireReceivedSigningContext,
  requireRetainedSigningContext,
} from "./release-signing-context-artifact.mts";
import { readBoundedReleaseContextFiles } from "./release-signing-context.mts";
import { readControllerToolFile } from "./release-controller-tools.mts";
import { releaseCanonicalDigest as digest } from "./release-canonical.mts";
import { isRecord } from "./runtime-values.mts";
import {
  readImmutableReleaseState,
  proposeImmutableReleaseTransition,
} from "./release-immutable-publication.mts";
import { immutableReleaseProgressDigest } from "./release-candidate-progress-contract.mts";

export const publicationResultPredicateType =
  "https://portcove.dev/attestations/immutable-release-result/v1";
const repository = "repos/boburning/portcove/";
const hash = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
const reportName = "immutable-release-result.json";
const bundleName = "immutable-release-result-attestation.json";
const reportLimit = 65536;
/** Deadline arithmetic only, never permission to create or resume a session. */
export function intersectPublicationResultDeadline(retained: number, proposed?: number) {
  if (!Number.isFinite(retained) || (proposed !== undefined && !Number.isFinite(proposed)))
    throw new Error("publication result phase deadline invalid");
  return Math.min(retained, proposed ?? retained);
}
function remaining(deadline: number, maximum = 15000) {
  const value = Math.floor(deadline - performance.now());
  if (!Number.isFinite(deadline) || value < 1)
    throw new Error("publication result deadline exhausted");
  return Math.min(value, maximum);
}
function exact(raw: unknown, keys: string): asserts raw is Record<string, unknown> {
  if (!isRecord(raw) || Object.keys(raw).sort().join(",") !== keys)
    throw new Error("publication result exact identity shape differs");
}
function hex(raw: unknown, length = 64): asserts raw is string {
  if (typeof raw !== "string" || !new RegExp(`^[a-f0-9]{${length}}$`, "u").test(raw))
    throw new Error("publication result digest differs");
}
type Controller = {
  controller_revision: string;
  source_tree: string;
  controller_ref: string;
  run_id: string;
  run_attempt: number;
};
type Artifact = { id: number; sha256: string };
/** An upload locator carries identity only; it grants no receipt or publication authority. */
export function inspectPublicationResultUpload(uploaded: unknown): Artifact {
  exact(uploaded, "id,sha256");
  hex(uploaded.sha256);
  if (!Number.isSafeInteger(uploaded.id) || Number(uploaded.id) < 1)
    throw new Error("result upload numeric identity missing");
  return { id: Number(uploaded.id), sha256: uploaded.sha256 };
}

export type PublicationResultArtifactExpected = Controller & {
  artifact: Artifact;
  bundle: Artifact;
  report_sha256: string;
};
function expectedInput(raw: PublicationResultArtifactExpected) {
  const value = structuredClone(raw);
  exact(
    value,
    "artifact,bundle,controller_ref,controller_revision,report_sha256,run_attempt,run_id,source_tree",
  );
  hex(value.controller_revision, 40);
  hex(value.source_tree, 40);
  hex(value.report_sha256);
  if (
    typeof value.controller_ref !== "string" ||
    !/^refs\/tags\/portcove-production-controller-[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u.test(
      value.controller_ref,
    ) ||
    typeof value.run_id !== "string" ||
    !/^[1-9][0-9]{0,15}$/u.test(value.run_id) ||
    value.run_attempt !== 1
  )
    throw new Error("publication result fixed controller identity differs");
  for (const item of [value.artifact, value.bundle]) {
    exact(item, "id,sha256");
    hex(item.sha256);
    if (!Number.isSafeInteger(item.id) || item.id < 1)
      throw new Error("publication result artifact ID differs");
  }
  if (value.artifact.id === value.bundle.id)
    throw new Error("separate result attestation required");
  return value;
}

/** Fixed single-member ZIP parser; bounded bytes and CRC establish integrity only. */
export function inspectPublicationResultArchive(raw: Buffer, bundle = false) {
  const name = bundle ? bundleName : reportName,
    limit = bundle ? 2 * 1024 ** 2 : reportLimit;
  const archive = Buffer.from(raw);
  const entries = inspectBoundedZip(archive, {
    compressedBytes: bundle ? 4 * 1024 ** 2 : 1024 ** 2,
    expandedBytes: limit,
    files: 1,
    nameBytes: 64,
    allowedPaths: new Set([name]),
  }).entries;
  const entry = entries[0];
  if (entries.length !== 1 || !entry || entry.bytes < 1 || entry.bytes > limit)
    throw new Error("publication result archive inventory differs");
  const compressed = archive.subarray(entry.data, entry.dataEnd);
  const bytes =
    entry.method === 0
      ? Buffer.from(compressed)
      : inflateRawSync(compressed, { maxOutputLength: entry.bytes });
  if (
    bytes.length !== entry.bytes ||
    crc32(bytes) !== entry.crc ||
    !Buffer.from(bytes.toString("utf8")).equals(bytes)
  )
    throw new Error("publication result member byte identity differs");
  return bytes;
}

function reportInput(bytes: Buffer, controller: Controller) {
  if (
    bytes.length < 1 ||
    bytes.length > reportLimit ||
    !Buffer.from(bytes.toString("utf8")).equals(bytes)
  )
    throw new Error("bounded publication result required");
  const raw: unknown = JSON.parse(bytes.toString("utf8"));
  exact(
    raw,
    "authority,candidate,context,controller,immutable_identity_sha256,kind,namespace,native,pending_obligations,producer,producer_sbom_sha256,release,repository_id,schema_version,scope,settlement",
  );
  if (
    raw.schema_version !== 1 ||
    raw.kind !== "owned-immutable-application-release" ||
    raw.repository_id !== 1354613114 ||
    raw.authority !== "none" ||
    raw.scope !== "settled-immutable-release-only" ||
    digest(raw.controller) !==
      digest({
        revision: controller.controller_revision,
        source_tree: controller.source_tree,
        ref: controller.controller_ref,
        run_id: controller.run_id,
        run_attempt: controller.run_attempt,
      }) ||
    digest(raw.pending_obligations) !==
      digest([
        "authenticated-feed-deployment",
        "independent-public-byte-readback",
        "ordinary-public-updater-journey",
        "durable-candidate-completion",
      ])
  )
    throw new Error("publication result controller or evidence scope differs");
  exact(raw.producer, "check_run_id,job_id");
  if (
    !Number.isSafeInteger(raw.producer.job_id) ||
    Number(raw.producer.job_id) < 1 ||
    typeof raw.producer.check_run_id !== "string" ||
    !/^[1-9][0-9]{0,15}$/u.test(raw.producer.check_run_id)
  )
    throw new Error("publication result numeric producer identity differs");
  exact(raw.context, "binding,facts_sha256,manifest_sha256");
  hex(raw.context.facts_sha256);
  hex(raw.context.manifest_sha256);
  hex(raw.immutable_identity_sha256);
  hex(raw.producer_sbom_sha256);
  if (
    !isRecord(raw.release) ||
    !Array.isArray(raw.release.assets) ||
    raw.release.immutable !== true ||
    !isRecord(raw.candidate) ||
    !isRecord(raw.settlement) ||
    typeof raw.namespace !== "string"
  )
    throw new Error("publication result settlement identity missing");
  return raw as typeof raw & {
    producer: { job_id: number; check_run_id: string };
    context: Record<string, unknown>;
    release: Record<string, unknown> & {
      assets: { filename: string; bytes: number; sha256: string }[];
    };
  };
}
function predicate(
  record: ReturnType<typeof reportInput>,
  reportSha: string,
  artifact: { id: number; bytes: number; sha256: string },
) {
  return {
    schema_version: 1,
    role: "immutable-release-result",
    controller: record.controller,
    producer: record.producer,
    artifact,
    report_sha256: reportSha,
    context: record.context,
    settlement_sha256: digest(record.settlement),
    immutable_identity_sha256: record.immutable_identity_sha256,
    scope: "settled-immutable-release-only",
    authority: "none",
  };
}
function provider(api: GitHubRestReader, controller: Controller, deadline: () => number) {
  let reads = 0;
  const get = (suffix: string) => {
    remaining(deadline());
    if (++reads > 48) throw new Error("publication result readback budget exhausted");
    const response = api.request("GET", repository + suffix);
    remaining(deadline());
    if (response.status !== 200) throw new Error("publication result provider unavailable");
    return response.body;
  };
  const artifact = (item: Artifact, bundle: boolean) => {
    const raw = get(`actions/artifacts/${item.id}`);
    if (
      !isRecord(raw) ||
      raw.id !== item.id ||
      raw.digest !== `sha256:${item.sha256}` ||
      raw.expired !== false ||
      raw.name !==
        `trusted-immutable-release-result${bundle ? "-attestation" : ""}-${controller.run_id}-${controller.run_attempt}` ||
      typeof raw.size_in_bytes !== "number" ||
      !Number.isSafeInteger(raw.size_in_bytes) ||
      raw.size_in_bytes < 22 ||
      raw.size_in_bytes > (bundle ? 4 * 1024 ** 2 : 1024 ** 2) ||
      !isRecord(raw.workflow_run) ||
      String(raw.workflow_run.id) !== controller.run_id ||
      raw.workflow_run.repository_id !== 1354613114 ||
      raw.workflow_run.head_repository_id !== 1354613114 ||
      raw.workflow_run.head_sha !== controller.controller_revision
    )
      throw new Error("publication result immutable artifact provider differs");
    return { id: item.id, bytes: raw.size_in_bytes, sha256: item.sha256 };
  };
  return { get, artifact };
}

/** Called only after the existing owned upload/readback. No supplied identity
 * or injected provider can substitute for the actual private publisher receipt. */
export async function preparePublicationResultPredicate(
  receipt: object,
  uploaded: Artifact,
  deadline: number,
) {
  remaining(deadline);
  const actual = await requireOwnedPublicationResult(receipt);
  const raw = actual.record.controller;
  if (!isRecord(raw)) throw new Error("actual publisher controller missing");
  const controller = {
    controller_revision: String(raw.revision),
    source_tree: String(raw.source_tree),
    controller_ref: String(raw.ref),
    run_id: String(raw.run_id),
    run_attempt: Number(raw.run_attempt),
  };
  exact(uploaded, "id,sha256");
  hex(uploaded.sha256);
  if (!Number.isSafeInteger(uploaded.id) || uploaded.id < 1)
    throw new Error("uploaded result ID differs");
  const api = new GitHubApiClient((args, input) =>
    createGitHubRunner({
      cwd: actual.directory,
      timeoutMs: remaining(deadline),
      maxBuffer: 128 * 1024,
    })([...args, "--hostname", "github.com"], input),
  );
  const source = provider(api, controller, () => deadline),
    before = source.artifact(uploaded, false);
  const archive = readGitHubArtifactArchive(`${repository}actions/artifacts/${before.id}/zip`, {
    cwd: actual.directory,
    maxBytes: before.bytes,
    timeoutMs: remaining(deadline, 30000),
  });
  remaining(deadline);
  if (archive.length !== before.bytes || hash(archive) !== before.sha256)
    throw new Error("uploaded result ZIP differs");
  const bytes = inspectPublicationResultArchive(archive);
  if (hash(bytes) !== actual.report_sha256)
    throw new Error("uploaded result differs from owned report");
  const record = reportInput(bytes, controller);
  await requireOwnedPublicationResult(receipt);
  if (digest(before) !== digest(source.artifact(uploaded, false)))
    throw new Error("uploaded result custody changed");
  const value = predicate(record, actual.report_sha256, before);
  const destination = path.join(actual.directory, "immutable-release-result-predicate.json");
  await writeFile(destination, JSON.stringify(value), { flag: "wx", mode: 0o600 });
  remaining(deadline);
  return {
    predicate: value,
    predicate_path: destination,
    report: actual.report,
    report_sha256: actual.report_sha256,
    authority: "none" as const,
  };
}

type Received = {
  directory: string;
  bytes: Buffer;
  record: ReturnType<typeof reportInput>;
  context: object;
  refresh: () => void;
  deadline: number;
  tighten: (deadline: number) => void;
  evidence: { name: string; bytes: Buffer }[];
};
const received = new WeakMap<object, Received>();
async function contextAssociation(
  record: ReturnType<typeof reportInput>,
  contextReceipt: object,
  deadline: number,
  provenance: "fresh" | "retained" = "fresh",
) {
  const context = await (
    provenance === "fresh" ? requireReceivedSigningContext : requireRetainedSigningContext
  )(contextReceipt, deadline);
  const bytes = await readControllerToolFile(
    path.join(context.directory, "signing-context-manifest.json"),
    1024 ** 2,
  );
  if (
    hash(bytes) !== record.context.manifest_sha256 ||
    context.manifest.facts_sha256 !== record.context.facts_sha256 ||
    digest(context.manifest.binding) !== digest(record.context.binding)
  )
    throw new Error("publication result differs from authenticated full record context");
  await inspectPublicationRecordAssociation(
    context.manifest,
    context.manifest.facts,
    record.release.assets,
    await readBoundedReleaseContextFiles(path.dirname(context.context)),
  );
  return context;
}

/** Bounded report/context association for GET-only upload recovery. This does
 * not verify an attestation, mint received custody, or authorize publication. */
export async function inspectPublicationResultReadback(
  bytes: Buffer,
  controller: Controller,
  contextReceipt: object,
  deadline: number,
) {
  remaining(deadline);
  const record = reportInput(bytes, controller);
  const context = await contextAssociation(record, contextReceipt, deadline, "retained");
  remaining(deadline);
  return { record, context, report_sha256: hash(bytes), authority: "none" as const };
}

/** Verify exact result bytes through the existing GitHub/Sigstore verifier and
 * terminal fixed producer. Failed workflow siblings cannot erase a successful
 * producer's immutable result; recovery authorization remains a separate gate. */
export async function receivePublicationResultArtifact(
  parent: string,
  rawExpected: PublicationResultArtifactExpected,
  contextReceipt: object,
  deadline: number,
  options: {
    api?: GitHubRestReader;
    download?: typeof readGitHubArtifactArchive;
    spawn?: NonNullable<Parameters<typeof createGitHubRunner>[0]>["spawn"];
  } = {},
) {
  const expected = expectedInput(rawExpected);
  remaining(deadline);
  const injected =
    options.api !== undefined || options.download !== undefined || options.spawn !== undefined;
  const directory = await mkdtemp(path.join(parent, "immutable-result-receiver-"));
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
    const api =
      options.api ??
      new GitHubApiClient((args, input) =>
        createGitHubRunner({
          cwd: directory,
          timeoutMs: remaining(deadline),
          maxBuffer: 2 * 1024 ** 2,
          spawn: (command, argv, settings) =>
            spawnSync(command, argv, { ...settings, env: environment }),
        })([...args, "--hostname", "github.com"], input),
      );
    const source = provider(api, expected, () => deadline);
    const run = (raw: unknown) => {
      if (
        !isRecord(raw) ||
        String(raw.id) !== expected.run_id ||
        raw.run_attempt !== expected.run_attempt ||
        raw.head_sha !== expected.controller_revision ||
        raw.path !== productionControllerWorkflow ||
        raw.event !== "workflow_dispatch" ||
        !["in_progress", "completed"].includes(String(raw.status)) ||
        !isRecord(raw.repository) ||
        raw.repository.id !== 1354613114 ||
        raw.repository.full_name !== "boburning/portcove" ||
        !isRecord(raw.head_repository) ||
        raw.head_repository.id !== 1354613114
      )
        throw new Error("publication result producing controller run differs");
      return { id: raw.id, attempt: raw.run_attempt, source: raw.head_sha };
    };
    const snapshot = () => {
      const commit = source.get(`git/commits/${expected.controller_revision}`);
      if (
        !isRecord(commit) ||
        commit.sha !== expected.controller_revision ||
        !isRecord(commit.tree) ||
        commit.tree.sha !== expected.source_tree
      )
        throw new Error("publication result controller tree differs");
      return {
        source: { commit: commit.sha, tree: commit.tree.sha },
        run: run(source.get(`actions/runs/${expected.run_id}`)),
        attempt: run(
          source.get(`actions/runs/${expected.run_id}/attempts/${expected.run_attempt}`),
        ),
        artifact: source.artifact(expected.artifact, false),
        bundle: source.artifact(expected.bundle, true),
      };
    };
    const before = snapshot();
    const download = options.download ?? readGitHubArtifactArchive;
    const acquire = (item: { id: number; bytes: number; sha256: string }) => {
      const archive = download(`${repository}actions/artifacts/${item.id}/zip`, {
        cwd: directory,
        maxBytes: item.bytes,
        timeoutMs: remaining(deadline, 30000),
        spawn: (command, argv, settings) =>
          spawnSync(command, argv, { ...settings, env: environment }),
      });
      remaining(deadline);
      if (archive.length !== item.bytes || hash(archive) !== item.sha256)
        throw new Error("publication result opaque archive differs");
      return archive;
    };
    phase = "bounded-archives";
    const archive = acquire(before.artifact),
      bundleArchive = acquire(before.bundle);
    const bytes = inspectPublicationResultArchive(archive),
      bundle = inspectPublicationResultArchive(bundleArchive, true);
    if (hash(bytes) !== expected.report_sha256)
      throw new Error("publication result report digest differs");
    const record = reportInput(bytes, expected);
    const report = path.join(directory, reportName),
      bundlePath = path.join(directory, "attestation.json");
    await writeFile(report, bytes, { flag: "wx", mode: 0o600 });
    await writeFile(bundlePath, bundle, { flag: "wx", mode: 0o600 });
    phase = "pinned-attestation-and-producer";
    const statement = verifyControllerArtifactStatement(
      directory,
      report,
      bundlePath,
      expected,
      publicationResultPredicateType,
      { ...(options.spawn ? { spawn: options.spawn } : {}), environment, deadline },
    );
    if (
      statement._type !== "https://in-toto.io/Statement/v1" ||
      statement.predicateType !== publicationResultPredicateType ||
      digest(statement.subject) !==
        digest([
          { name: "immutable-release-result", digest: { sha256: expected.report_sha256 } },
        ]) ||
      digest(statement.predicate) !==
        digest(predicate(record, expected.report_sha256, before.artifact))
    )
      throw new Error("publication result signed association differs");
    const readJob = () => {
      const job = source.get(`actions/jobs/${record.producer.job_id}`);
      if (
        !isRecord(job) ||
        job.id !== record.producer.job_id ||
        String(job.run_id) !== expected.run_id ||
        job.run_attempt !== expected.run_attempt ||
        job.head_sha !== expected.controller_revision ||
        job.name !== "Publish immutable application release" ||
        job.status !== "completed" ||
        job.conclusion !== "success" ||
        job.check_run_url !==
          `https://api.github.com/${repository}check-runs/${record.producer.check_run_id}`
      )
        throw new Error("publication result completed fixed publisher differs");
      return job;
    };
    const job = readJob();
    const refresh = () => {
      if (digest(snapshot()) !== digest(before) || digest(readJob()) !== digest(job))
        throw new Error("publication result provider custody changed");
    };
    await contextAssociation(record, contextReceipt, deadline);
    refresh();
    remaining(deadline);
    const evidence = [
      { name: reportName, bytes },
      { name: "attestation.json", bytes: bundle },
      { name: "result.zip", bytes: archive },
      { name: "bundle.zip", bytes: bundleArchive },
      { name: "provider.json", bytes: Buffer.from(JSON.stringify({ before, job })) },
      { name: "verified-statement.json", bytes: Buffer.from(JSON.stringify(statement)) },
    ];
    for (const item of evidence.slice(2))
      await writeFile(path.join(directory, item.name), item.bytes, { flag: "wx", mode: 0o600 });
    const receipt = Object.freeze({
      kind: "attested-owned-immutable-release-result",
      evidence_scope: injected ? "injected-provider" : "github.com",
      authority: "none",
    });
    if (!injected)
      received.set(receipt, {
        directory,
        bytes,
        record,
        context: contextReceipt,
        refresh,
        deadline,
        tighten: (next) => {
          deadline = intersectPublicationResultDeadline(deadline, next);
        },
        evidence,
      });
    return receipt;
  } catch {
    await writeFile(
      path.join(directory, "refusal.json"),
      JSON.stringify({ phase, automatic_retry: false, authority: "none" }),
      { flag: "wx", mode: 0o600 },
    ).catch(() => {});
    throw new Error(`publication result acquisition refused; retain ${directory}`);
  }
}

export async function requireReceivedPublicationResult(receipt: object, phaseDeadline?: number) {
  const actual = received.get(receipt);
  if (!actual) throw new Error("actual authenticated immutable publication result required");
  actual.deadline = intersectPublicationResultDeadline(actual.deadline, phaseDeadline);
  actual.tighten(actual.deadline);
  remaining(actual.deadline);
  for (const item of actual.evidence) {
    const bytes = await readControllerToolFile(
      path.join(actual.directory, item.name),
      item.bytes.length,
    );
    if (!bytes.equals(item.bytes)) throw new Error("retained publication result evidence changed");
    remaining(actual.deadline);
  }
  // Context signatures/source are historical immutable provenance. Rehash the
  // original proof, then independently refresh this publisher and live Release.
  const context = await contextAssociation(
    actual.record,
    actual.context,
    actual.deadline,
    "retained",
  );
  actual.refresh();
  // An authenticated historical report is not current provider enforcement.
  // Reuse the existing complete draft-inclusive Release/tag/asset readback.
  const identity = {
    version: String(actual.record.release.version),
    source_commit: String(actual.record.release.source_commit),
    assets: actual.record.release.assets.map(({ filename, bytes, sha256 }) => ({
      filename,
      bytes,
      sha256,
    })),
  };
  const api = new GitHubApiClient((args, input) => {
    const output = createGitHubRunner({
      cwd: actual.directory,
      timeoutMs: remaining(actual.deadline),
      maxBuffer: 2 * 1024 ** 2,
    })([...args, "--hostname", "github.com"], input);
    remaining(actual.deadline);
    return output;
  });
  const observed = readImmutableReleaseState(api, identity);
  const transition = proposeImmutableReleaseTransition(identity, observed.release, observed.assets);
  if (transition.decision !== "complete")
    throw new Error("attested immutable Release is no longer complete");
  const release = {
    ...transition,
    version: identity.version,
    source_commit: identity.source_commit,
  };
  if (immutableReleaseProgressDigest(release) !== actual.record.immutable_identity_sha256)
    throw new Error("attested immutable Release provider identity changed");
  remaining(actual.deadline);
  return {
    directory: actual.directory,
    record: structuredClone(actual.record),
    report_sha256: hash(actual.bytes),
    context_receipt: actual.context,
    context,
    release,
    authority: "none" as const,
    scope:
      "authenticated settled immutable publication; current site eligibility and public journey remain separate",
  };
}

/** Same-process bridge to the fixed Actions upload step, entered only inside
 * the existing owned executor's durable pending callback. Locators are data;
 * provider readback and actual private report custody establish their identity. */
export async function handoffPublicationResultArtifact(
  receipt: object,
  rawPending: { checkpoint: string; operation_id: string },
  deadline: number,
) {
  remaining(deadline);
  const actual = await requireOwnedPublicationResult(receipt);
  const pending = structuredClone(rawPending);
  exact(pending, "checkpoint,operation_id");
  hex(pending.checkpoint, 40);
  hex(pending.operation_id);
  const controller = actual.record.controller;
  if (!isRecord(controller)) throw new Error("actual result controller missing");
  await writeFile(
    path.join(actual.directory, "result-ready.json"),
    JSON.stringify({
      name: `trusted-immutable-release-result-${String(controller.run_id)}-${String(controller.run_attempt)}`,
      pending,
      report_sha256: actual.report_sha256,
      files: [reportName],
      authority: "none",
    }),
    { flag: "wx", mode: 0o600 },
  );
  if (process.env.RUNNER_TEMP && process.env.PORTCOVE_JOB_OPERATION) {
    const { retainControllerUpload } = await import("./release-controller-transport.mts");
    await retainControllerUpload(
      process.env.RUNNER_TEMP,
      "release-publication",
      "result",
      actual.directory,
    );
  }
  try {
    let uploaded: unknown;
    while (uploaded === undefined) {
      remaining(deadline);
      try {
        uploaded = JSON.parse(
          (
            await readControllerToolFile(path.join(actual.directory, "result-uploaded.json"), 4096)
          ).toString("utf8"),
        );
      } catch (error) {
        if (!isRecord(error) || error.code !== "ENOENT")
          throw new Error("result upload locator malformed");
        await delay(remaining(deadline, 100));
      }
    }
    const identity = inspectPublicationResultUpload(uploaded);
    const result = await preparePublicationResultPredicate(receipt, identity, deadline);
    return {
      artifact_id: identity.id,
      sha256: identity.sha256,
      report_sha256: actual.report_sha256,
      predicate_sha256: digest(result.predicate),
      directory: actual.directory,
      attestation: "pending" as const,
      authority: "none" as const,
    };
  } catch {
    await writeFile(
      path.join(actual.directory, "result-handoff-refusal.json"),
      JSON.stringify({ pending, automatic_retry: false, authority: "none" }),
      { flag: "wx", mode: 0o600 },
    ).catch(() => {});
    throw new Error(`publication result handoff refused; retain ${actual.directory}`);
  }
}
