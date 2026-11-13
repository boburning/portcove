import { createHash } from "node:crypto";
import { performance } from "node:perf_hooks";
import { crc32, inflateRawSync } from "node:zlib";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { inspectBoundedZip } from "./bounded-zip.mts";
import { setTimeout as delay } from "node:timers/promises";
import { coordinatorCommandDeadline } from "./release-coordinator-deadline.mts";
import {
  fixedReleaseReaderToken,
  readOnlyReleaseChildEnvironment,
} from "./release-readonly-child-environment.mts";
import { assertTrustedDirectNode } from "./release-direct-node-transport.mts";
import type { GitHubRequestPolicy } from "./github-client.mts";
import { GitHubApiError } from "./github-operation.mts";
import { isRecord } from "./runtime-values.mts";
import { readCompleteRunArtifactInventoryAsync } from "./release-run-artifact-inventory.mts";
import { productionControllerWorkflow } from "./production-controller-admission.mts";
import {
  inspectReleaseControlPhase,
  releaseControlPhaseProfile,
  protectionObserverJobNames,
} from "./release-control-phases.mts";
import type { ReleaseControlPhase } from "./release-control-phases.mts";

const base = "repos/boburning/portcove";
export const controlArtifactMaximumBytes = 128 * 1024;
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
    read?: (endpoint: string) => Promise<{ status: number; body: unknown }>;
    download?: (artifact: { id: number; bytes: number }, deadline: number) => Promise<Buffer>;
    fetch?: typeof globalThis.fetch;
    now?: () => number;
    sleep?: (milliseconds: number) => Promise<void>;
    /** Caller may only tighten the existing finite wait, never extend it. */
    deadline?: number;
    phaseDeadline?: number;
    onRefusal?: (receipt: {
      stage: string;
      polls: number;
      api_requests: number;
      elapsed_ms: number;
    }) => void;
  } = {},
) {
  options = { ...options };
  const input = attempt(raw);
  if (role === "observation" && input.round) inspectControlRound(input.round);
  const phaseProfile = releaseControlPhaseProfile(input.phase);
  const now = options.now ?? Date.now;
  const start = now();
  const monotonicStart = performance.now();
  const elapsed = () => (options.now ? now() - start : performance.now() - monotonicStart);
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
  const enclosingDeadline = Math.min(
    phaseDeadline ?? Infinity,
    coordinatorCommandDeadline() ?? Infinity,
  );
  const deadline = Math.min(monotonicStart + limit, enclosingDeadline);
  const remaining = (maximum = 240000) => {
    const phase = phaseDeadline === undefined ? Infinity : phaseDeadline - performance.now();
    const left = Math.floor(
      Math.min(limit - elapsed(), enclosingDeadline - performance.now(), maximum),
    );
    if (
      !Number.isFinite(left) ||
      left < 1 ||
      (phaseDeadline !== undefined && (!Number.isFinite(phaseDeadline) || phase > 600000))
    )
      throw new Error("control handshake phase deadline exhausted");
    return left;
  };
  remaining();
  const fetcher = options.fetch ?? globalThis.fetch;
  const scoped = readOnlyReleaseChildEnvironment() !== undefined;
  const fetch: typeof globalThis.fetch = (input, init) => {
    if (scoped) assertTrustedDirectNode("control artifact reader");
    return fetcher(input, init);
  };
  const charge = () => {
    remaining();
    if (requests >= 256) throw new Error("control handshake request or deadline bound exhausted");
    requests++;
  };
  const reserve = () => {
    charge();
    return {
      consumeBytes() {},
      settle(observation: { dispatched: boolean }) {
        if (!observation.dispatched) requests--;
      },
    };
  };
  let read = options.read;
  const get = async (endpoint: string) => {
    remaining();
    if (options.read) charge();
    if (!read) throw new Error("control handshake reader unavailable");
    const response = await read(`${base}/${endpoint}`);
    remaining();
    if (response.status !== 200 || Buffer.byteLength(JSON.stringify(response.body)) > 512 * 1024)
      throw new Error("control handshake provider read unavailable or oversized");
    return response.body;
  };
  const jobs = async () => {
    const found: Record<string, unknown>[] = [];
    let total: unknown = null;
    for (let page = 1; page <= 4; page++) {
      const body = await get(
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
  const inventory = async () =>
    (
      await readCompleteRunArtifactInventoryAsync((page) =>
        get(`actions/runs/${input.run_id}/artifacts?per_page=100&page=${page}`),
      )
    ).artifacts;
  const coordinatorRefresh = role === "ready" && input.phase === "coordinator" && input.round;
  let recoveredInventoryRead = false;
  const maximumUnavailableTransfers = 3;
  let pendingTransfer: { id: number; digest: string; unavailable: number } | undefined;
  const waitForPoll = async () => {
    const wait = remaining(3000);
    if (options.sleep) await options.sleep(wait);
    else await delay(wait, undefined, { signal: AbortSignal.timeout(remaining()) });
  };
  const name = controlHandshakeArtifactName(role, input);
  const providerTimeout = input.phase === "coordinator" ? 15000 : 5000;
  let polls = 0;
  let stage = "provider-setup";
  try {
    const token = !read || !options.download ? fixedReleaseReaderToken() : "";
    if (!read) {
      const { createGitHubClient } = await import("./github-client.mts");
      const client = await createGitHubClient({
        credential: { kind: "explicit", token },
        deadline,
        requestTimeoutMs: providerTimeout,
        maxBytes: 512 * 1024,
        fetch,
        reserve,
        allowRequest(method, url) {
          remaining();
          return method === "GET" && url.pathname.startsWith(`/${base}/actions/`);
        },
      });
      read = async (endpoint) => {
        const policy: GitHubRequestPolicy = { replay: "once", attempts: 0 };
        try {
          const response = await client.request(`GET /${endpoint}`, {
            request: { portcove: policy },
          });
          return { status: response.status, body: response.data as unknown };
        } finally {
          await policy.admissionSettled;
        }
      };
    }
    while (++polls <= 81) {
      stage = "artifact-inventory";
      let rows: Awaited<ReturnType<typeof inventory>>;
      try {
        rows = await inventory();
      } catch (error) {
        if (
          !coordinatorRefresh ||
          recoveredInventoryRead ||
          !(error instanceof GitHubApiError) ||
          !(
            error.code === "deadline_exceeded" ||
            [408, 500, 502, 503, 504].includes(error.status ?? 0)
          )
        )
          throw error;
        // A new bounded inventory read still requires the complete producer and
        // artifact joins. A failed request never counts as an empty inventory.
        recoveredInventoryRead = true;
        await waitForPoll();
        continue;
      }
      const matches = rows.filter((a) => a.name === name);
      if (matches.length > 1) throw new Error("control artifact name ambiguous");
      stage = "producer-inventory";
      const allJobs = await jobs();
      const names =
        role === "ready" ? [phaseProfile.reader_name] : protectionObserverJobNames(input.phase);
      // Prefer the legacy phase-specific job if present. Old workflows also
      // contain an admission job bearing the shared name; it is not that phase.
      const selectedName = names.find((name) => allJobs.some((job) => job.name === name));
      const producer = allJobs.filter((job) => job.name === selectedName);
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
      if (!artifact && pendingTransfer)
        throw new Error("control artifact disappeared while its archive was unavailable");
      if (artifact) {
        stage = "artifact-identity";
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
          Number(artifact.size_in_bytes) > controlArtifactMaximumBytes ||
          typeof artifact.digest !== "string" ||
          !/^sha256:[a-f0-9]{64}$/u.test(artifact.digest)
        )
          throw new Error("control artifact provider identity differs");
        stage = "artifact-transfer";
        const transferDeadline = Math.min(deadline, performance.now() + remaining(providerTimeout));
        const item = { id: Number(artifact.id), bytes: Number(artifact.size_in_bytes) };
        if (
          pendingTransfer &&
          (pendingTransfer.id !== item.id || pendingTransfer.digest !== artifact.digest)
        )
          throw new Error("control artifact changed while its archive was unavailable");
        let zip: Buffer;
        try {
          zip = options.download
            ? await options.download(item, transferDeadline)
            : await (
                await import("./github-artifact-download.mts")
              ).downloadGitHubArtifactArchive(`${base}/actions/artifacts/${item.id}/zip`, {
                credential: { kind: "explicit", token },
                deadline: transferDeadline,
                maxBytes: item.bytes,
                fetch,
                lookup: { reserve },
              });
        } catch (error) {
          // A just-listed coordinator control artifact can briefly 404 on its
          // archive. Re-list and re-join the same artifact identity, boundedly.
          if (
            input.phase !== "coordinator" ||
            !(error instanceof GitHubApiError) ||
            error.status !== 404 ||
            (pendingTransfer?.unavailable ?? 0) >= maximumUnavailableTransfers
          )
            throw error;
          pendingTransfer = {
            id: item.id,
            digest: artifact.digest,
            unavailable: (pendingTransfer?.unavailable ?? 0) + 1,
          };
          stage = "poll-wait";
          await waitForPoll();
          continue;
        }
        stage = "artifact-validation";
        remaining();
        await writeFile(path.join(privateRoot, `control-${role}.zip`), zip, {
          flag: "wx",
          mode: 0o600,
        });
        if (zip.length !== artifact.size_in_bytes || `sha256:${digest(zip)}` !== artifact.digest)
          throw new Error("control artifact archive changed");
        const member = `${role}-${input.phase}.json`;
        const parsed = inspectBoundedZip(zip, {
          compressedBytes: controlArtifactMaximumBytes,
          expandedBytes: controlArtifactMaximumBytes,
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
        stage = "artifact-post-read";
        const after = (await inventory()).filter((a) => a.name === name);
        if (after.length !== 1 || JSON.stringify(after[0]) !== JSON.stringify(artifact))
          throw new Error("control artifact changed during collection");
        stage = "producer-post-read";
        const finalJob = await get(`actions/jobs/${String(job.id)}`);
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
            options.read || options.fetch || options.download || options.now || options.sleep
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
      stage = "poll-wait";
      await waitForPoll();
    }
    throw new Error("control handshake poll count exhausted");
  } catch (error) {
    const receipt = {
      stage,
      polls,
      api_requests: requests,
      elapsed_ms: Math.floor(elapsed()),
      ...(error instanceof GitHubApiError && error.status !== null
        ? { provider_status: error.status }
        : {}),
    };
    options.onRefusal?.(receipt);
    await writeFile(
      path.join(privateRoot, `control-${role}-refusal.json`),
      JSON.stringify({
        role,
        attempt: input,
        ...receipt,
        authority: "none",
        automatic_retry: false,
      }),
      { flag: "wx", mode: 0o600 },
    ).catch(() => {});
    throw new Error(`control ${role} handoff refused; retain exact attempt; no automatic retry`);
  }
}
export type ObservedControlArtifact = Awaited<ReturnType<typeof waitForControlArtifact>>;
