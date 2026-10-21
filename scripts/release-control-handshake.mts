import { createHash } from "node:crypto";
import { performance } from "node:perf_hooks";
import { crc32, inflateRawSync } from "node:zlib";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { inspectBoundedZip } from "./bounded-zip.mts";
import { readGitHubArtifactArchive } from "./github-binary.mts";
import { GitHubApiClient, createGitHubRunner } from "./github-api.mts";
import type { GitHubRestReader } from "./github-api.mts";
import { isRecord } from "./runtime-values.mts";
import { productionControllerWorkflow } from "./production-controller-admission.mts";
import {
  inspectReleaseControlPhase,
  releaseControlPhaseProfile,
} from "./release-control-phases.mts";
import type { ReleaseControlPhase } from "./release-control-phases.mts";

const base = "repos/boburning/portcove";
const maximum = 128 * 1024;
const digest = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
const proofs = new WeakSet<object>();
function immutable<T>(value: T, depth = 0): T {
  if (depth > 32) throw new Error("control artifact nesting bound exceeded");
  if (value !== null && typeof value === "object") {
    for (const child of Object.values(value)) immutable(child, depth + 1);
    Object.freeze(value);
  }
  return value;
}
type Role = "ready" | "observation";
export interface ControlAttempt {
  phase?: ReleaseControlPhase;
  controller_revision: string;
  controller_ref: string;
  run_id: string;
  run_attempt: number;
  round?: { index: number; nonce?: string };
}
export function inspectControlRound(raw: unknown, requireNonce = true) {
  if (
    !isRecord(raw) ||
    !["index", "index,nonce"].includes(Object.keys(raw).sort().join(",")) ||
    (requireNonce && !Object.hasOwn(raw, "nonce")) ||
    !Number.isSafeInteger(raw.index) ||
    Number(raw.index) < 1 ||
    Number(raw.index) > 14 ||
    (raw.nonce === undefined
      ? requireNonce
      : typeof raw.nonce !== "string" || !/^[a-f0-9]{64}$/u.test(raw.nonce))
  )
    throw new Error("fixed control round requires bounded ordinal and exact nonce");
  return {
    index: Number(raw.index),
    ...(typeof raw.nonce === "string" ? { nonce: raw.nonce } : {}),
  };
}
function attempt(raw: ControlAttempt) {
  const phase = inspectReleaseControlPhase(raw.phase);
  if (
    !/^[a-f0-9]{40}$/u.test(raw.controller_revision) ||
    !/^refs\/tags\/portcove-production-controller-[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u.test(
      raw.controller_ref,
    ) ||
    !/^[1-9][0-9]{0,15}$/u.test(raw.run_id) ||
    raw.run_attempt !== 1
  )
    throw new Error("control handshake requires the exact first controller attempt");
  return {
    phase,
    controller_revision: raw.controller_revision,
    controller_ref: raw.controller_ref,
    run_id: raw.run_id,
    run_attempt: raw.run_attempt,
    ...(raw.round === undefined ? {} : { round: inspectControlRound(raw.round, false) }),
  };
}
export function controlHandshakeArtifactName(role: Role, raw: ControlAttempt) {
  if (role !== "ready" && role !== "observation")
    throw new Error("fixed control artifact role required");
  const input = attempt(raw);
  return `trusted-release-control-${input.phase}-${role}-${input.run_id}-${input.run_attempt}${input.round ? `-r${input.round.index}` : ""}`;
}
/** Token-free identity declaration. Authentication comes from the fixed reviewed
 * upload route AND current provider job/artifact readback, not this JSON alone. */
export function prepareControlReadiness(
  identity: unknown,
  factsSha256: string,
  rawPhase: unknown = "admission",
  round?: { index: number; nonce: string },
) {
  const phase = inspectReleaseControlPhase(rawPhase);
  if (
    !isRecord(identity) ||
    identity.kind !== "oidc-job-identity-only" ||
    identity.workflow !== productionControllerWorkflow ||
    !/^[a-f0-9]{64}$/u.test(factsSha256)
  )
    throw new Error("verified reader identity and private prepared facts required");
  return {
    schema_version: 1,
    phase,
    producer: {
      workflow: identity.workflow,
      controller_revision: identity.workflow_revision,
      controller_ref: identity.execution_ref,
      run_id: identity.run_id,
      run_attempt: identity.run_attempt,
      job_id: identity.job_id,
      check_run_id: identity.check_run_id,
    },
    facts_sha256: factsSha256,
    ...(round === undefined ? {} : { round: inspectControlRound(round) }),
  };
}
/** A proof cannot be recreated from JSON or caller booleans. */
export function requireObservedControlArtifact(
  raw: unknown,
  role: Role,
  phase: unknown = "admission",
) {
  if (
    !raw ||
    typeof raw !== "object" ||
    !proofs.has(raw) ||
    (raw as { role?: unknown }).role !== role ||
    (raw as { phase?: unknown }).phase !== inspectReleaseControlPhase(phase)
  )
    throw new Error("control artifact requires runtime provider collection");
}

/** Bounded GET-only polling. Artifact v4 is immediately readable before job
 * completion. REST authenticates run/source/ID/digest, NOT producer job/attempt;
 * that association requires the exclusive upload route in the ratified fixed
 * workflow plus the independently read live producer identity. No arbitrary
 * candidate job in that workflow may upload either reserved artifact name. */
export async function waitForControlArtifact(
  privateRoot: string,
  role: Role,
  raw: ControlAttempt,
  options: {
    api?: GitHubRestReader;
    transport?: Pick<NonNullable<Parameters<typeof createGitHubRunner>[0]>, "spawn">;
    download?: typeof readGitHubArtifactArchive;
    now?: () => number;
    sleep?: (milliseconds: number) => Promise<void>;
    /** Caller may only tighten the existing finite wait, never extend it. */
    deadline?: number;
    phaseDeadline?: number;
  } = {},
) {
  const input = attempt(raw);
  if (role === "observation" && input.round) inspectControlRound(input.round);
  const phaseProfile = releaseControlPhaseProfile(input.phase);
  const now = options.now ?? Date.now;
  const start = now();
  if (
    options.deadline !== undefined &&
    (!Number.isSafeInteger(options.deadline) ||
      options.deadline <= start ||
      options.deadline > start + 240000)
  )
    throw new Error("control handshake deadline must tighten the existing finite wait");
  let requests = 0;
  // Waiting precedes observation. The separate 60-second protection freshness
  // guard still applies after the actual report arrives.
  const limit =
    options.deadline === undefined ? 240000 : Math.min(240000, options.deadline - start);
  const phaseDeadline = options.phaseDeadline;
  const remaining = (maximum = 240000) => {
    const phase = phaseDeadline === undefined ? Infinity : phaseDeadline - performance.now();
    const left = Math.floor(Math.min(limit - (now() - start), phase, maximum));
    if (
      !Number.isFinite(left) ||
      left < 1 ||
      (phaseDeadline !== undefined && (!Number.isFinite(phaseDeadline) || phase > 600000))
    )
      throw new Error("control handshake phase deadline exhausted");
    return left;
  };
  remaining();
  const api =
    options.api ??
    new GitHubApiClient((args, input) => {
      const result = createGitHubRunner({
        ...options.transport,
        cwd: privateRoot,
        maxBuffer: 512 * 1024,
        timeoutMs: remaining(5000),
      })([...args, "--hostname", "github.com"], input);
      remaining();
      return result;
    });
  const get = (endpoint: string) => {
    remaining();
    if (++requests > 256 || now() - start >= limit)
      throw new Error("control handshake request or deadline bound exhausted");
    const response = api.request("GET", `${base}/${endpoint}`);
    remaining();
    if (
      response.status !== 200 ||
      now() - start >= limit ||
      Buffer.byteLength(JSON.stringify(response.body)) > 512 * 1024
    )
      throw new Error("control handshake provider read unavailable or oversized");
    return response.body;
  };
  const jobs = () => {
    const found: Record<string, unknown>[] = [];
    let total: unknown = null;
    for (let page = 1; page <= 4; page++) {
      const body = get(
        `actions/runs/${input.run_id}/attempts/${input.run_attempt}/jobs?per_page=100&page=${page}`,
      );
      if (
        !isRecord(body) ||
        !Array.isArray(body.jobs) ||
        body.jobs.length > 100 ||
        !Number.isSafeInteger(body.total_count) ||
        Number(body.total_count) < 0 ||
        Number(body.total_count) > 400
      )
        throw new Error("control producer job inventory incomplete");
      total ??= body.total_count;
      if (total !== body.total_count) throw new Error("control producer inventory changed");
      for (const job of body.jobs) {
        if (
          !isRecord(job) ||
          !Number.isSafeInteger(job.id) ||
          Number(job.id) < 1 ||
          found.some((j) => j.id === job.id)
        )
          throw new Error("control producer job inventory duplicates identity");
        found.push(job);
      }
      if (found.length === body.total_count) return found;
      if (!body.jobs.length || found.length > Number(body.total_count)) break;
    }
    throw new Error("control producer job inventory omitted records");
  };
  const inventory = () => {
    const found: Record<string, unknown>[] = [];
    let total: unknown = null;
    for (let page = 1; page <= 4; page++) {
      const body = get(`actions/runs/${input.run_id}/artifacts?per_page=100&page=${page}`);
      if (
        !isRecord(body) ||
        !Array.isArray(body.artifacts) ||
        body.artifacts.length > 100 ||
        !Number.isSafeInteger(body.total_count) ||
        Number(body.total_count) < 0 ||
        Number(body.total_count) > 400
      )
        throw new Error("control artifact inventory incomplete");
      total ??= body.total_count;
      if (total !== body.total_count) throw new Error("control artifact inventory changed");
      for (const artifact of body.artifacts) {
        if (
          !isRecord(artifact) ||
          !Number.isSafeInteger(artifact.id) ||
          Number(artifact.id) < 1 ||
          found.some((a) => a.id === artifact.id)
        )
          throw new Error("control artifact duplicates identity");
        found.push(artifact);
      }
      if (found.length === body.total_count) return found;
      if (!body.artifacts.length || found.length > Number(body.total_count)) break;
    }
    throw new Error("control artifact inventory omitted records");
  };
  const name = controlHandshakeArtifactName(role, input);
  let polls = 0;
  try {
    while (++polls <= 81) {
      const matches = inventory().filter((a) => a.name === name);
      if (matches.length > 1) throw new Error("control artifact name ambiguous");
      const producer = jobs().filter(
        (j) =>
          j.name === (role === "ready" ? phaseProfile.reader_name : phaseProfile.observer_name),
      );
      if (producer.length > 1) throw new Error("control producer job ambiguous");
      const job = producer[0];
      const artifact = matches[0];
      if (
        job &&
        (job.run_id !== Number(input.run_id) ||
          job.run_attempt !== input.run_attempt ||
          job.head_sha !== input.controller_revision ||
          !(
            (job.status === "in_progress" && job.conclusion === null) ||
            (!artifact && job.status === "queued" && job.conclusion === null) ||
            (role === "observation" && job.status === "completed" && job.conclusion === "success")
          ))
      )
        throw new Error("control producer job failed, ended or differs");
      if (artifact) {
        if (
          !job ||
          !isRecord(artifact.workflow_run) ||
          artifact.workflow_run.id !== Number(input.run_id) ||
          artifact.workflow_run.repository_id !== 1354613114 ||
          artifact.workflow_run.head_repository_id !== 1354613114 ||
          artifact.workflow_run.head_sha !== input.controller_revision ||
          artifact.expired !== false ||
          !Number.isSafeInteger(artifact.size_in_bytes) ||
          Number(artifact.size_in_bytes) < 22 ||
          Number(artifact.size_in_bytes) > maximum ||
          typeof artifact.digest !== "string" ||
          !/^sha256:[a-f0-9]{64}$/u.test(artifact.digest)
        )
          throw new Error("control artifact provider identity differs");
        const zip = (options.download ?? readGitHubArtifactArchive)(
          `${base}/actions/artifacts/${String(artifact.id)}/zip`,
          {
            cwd: privateRoot,
            maxBytes: Number(artifact.size_in_bytes),
            timeoutMs: remaining(5000),
          },
        );
        remaining();
        await writeFile(path.join(privateRoot, `control-${role}.zip`), zip, {
          flag: "wx",
          mode: 0o600,
        });
        if (zip.length !== artifact.size_in_bytes || `sha256:${digest(zip)}` !== artifact.digest)
          throw new Error("control artifact archive changed");
        const member = `${role}-${input.phase}.json`;
        const parsed = inspectBoundedZip(zip, {
          compressedBytes: maximum,
          expandedBytes: maximum,
          files: 1,
          nameBytes: 64,
          allowedPaths: new Set([member]),
        });
        const entry = parsed.entries[0];
        if (parsed.entries.length !== 1 || !entry || entry.bytes < 2)
          throw new Error("control artifact member differs");
        const compressed = zip.subarray(entry.data, entry.dataEnd);
        const bytes =
          entry.method === 0
            ? Buffer.from(compressed)
            : inflateRawSync(compressed, { maxOutputLength: entry.bytes });
        if (bytes.length !== entry.bytes || crc32(bytes) !== entry.crc)
          throw new Error("control artifact bytes differ");
        const body: unknown = JSON.parse(bytes.toString("utf8"));
        if (
          !isRecord(body) ||
          body.schema_version !== 1 ||
          body.phase !== input.phase ||
          !isRecord(body.producer)
        )
          throw new Error("control artifact payload unavailable");
        if (input.round) {
          const observed = inspectControlRound(body.round);
          if (
            observed.index !== input.round.index ||
            (input.round.nonce !== undefined && observed.nonce !== input.round.nonce)
          )
            throw new Error("control artifact round/nonce differs from private continuation");
        } else if (Object.hasOwn(body, "round"))
          throw new Error("unexpected control round on legacy continuation");
        const p = body.producer;
        if (
          Object.keys(p).sort().join(",") !==
            "check_run_id,controller_ref,controller_revision,job_id,run_attempt,run_id,workflow" ||
          typeof p.check_run_id !== "string" ||
          !/^[1-9][0-9]{0,15}$/u.test(p.check_run_id) ||
          p.workflow !== productionControllerWorkflow ||
          p.controller_revision !== input.controller_revision ||
          p.controller_ref !== input.controller_ref ||
          p.run_id !== input.run_id ||
          p.run_attempt !== input.run_attempt ||
          p.job_id !== job.id ||
          String(p.check_run_id) === "" ||
          job.check_run_url !==
            `https://api.github.com/repos/boburning/portcove/check-runs/${p.check_run_id}`
        )
          throw new Error("control artifact producer differs from fixed live job");
        if (
          role === "ready" &&
          (Object.keys(body).sort().join(",") !==
            (input.round
              ? "facts_sha256,phase,producer,round,schema_version"
              : "facts_sha256,phase,producer,schema_version") ||
            typeof body.facts_sha256 !== "string" ||
            !/^[a-f0-9]{64}$/u.test(body.facts_sha256))
        )
          throw new Error("reader prepared facts identity unavailable");
        const after = inventory().filter((a) => a.name === name);
        if (after.length !== 1 || JSON.stringify(after[0]) !== JSON.stringify(artifact))
          throw new Error("control artifact changed during collection");
        const finalJob = get(`actions/jobs/${String(job.id)}`);
        if (
          !isRecord(finalJob) ||
          ["id", "run_id", "run_attempt", "head_sha", "name", "check_run_url"].some(
            (key) => finalJob[key] !== job[key],
          ) ||
          !(
            (finalJob.status === "in_progress" && finalJob.conclusion === null) ||
            (role === "observation" &&
              finalJob.status === "completed" &&
              finalJob.conclusion === "success")
          )
        )
          throw new Error("control producer changed during collection");
        const proof = immutable({
          role,
          phase: input.phase,
          body,
          artifact: structuredClone(artifact),
          job: structuredClone(job),
          evidence_scope:
            options.api || options.transport || options.download || options.now || options.sleep
              ? "injected-provider"
              : "github.com",
          association: "fixed-reviewed-workflow-exclusive-upload-route-and-provider-job-readback",
          authority: "none",
          api_requests: requests,
        });
        proofs.add(proof);
        await writeFile(
          path.join(privateRoot, `control-${role}-readback.json`),
          JSON.stringify(proof),
          { flag: "wx", mode: 0o600 },
        );
        remaining();
        return proof;
      }
      await (options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms))))(
        remaining(3000),
      );
    }
    throw new Error("control handshake poll count exhausted");
  } catch {
    await writeFile(
      path.join(privateRoot, `control-${role}-refusal.json`),
      JSON.stringify({
        role,
        attempt: input,
        polls,
        api_requests: requests,
        elapsed_ms: now() - start,
        authority: "none",
        automatic_retry: false,
      }),
      { flag: "wx", mode: 0o600 },
    ).catch(() => {});
    throw new Error(`control ${role} handoff refused; retain exact attempt; no automatic retry`);
  }
}
export type ObservedControlArtifact = Awaited<ReturnType<typeof waitForControlArtifact>>;
