import { capacityDigest } from "./release-capacity.mts";
import { inspectCoordinatorRemoteNamespace } from "./release-coordinator-remote.mts";
import { CoordinatorRemoteError } from "./release-coordinator-errors.mts";
import { classifyApplicationVersion } from "../apps/desktop/scripts/release-version-policy.mts";
import { isRecord } from "./runtime-values.mts";
import { performance } from "node:perf_hooks";

const repository = "boburning/portcove";
const repositoryId = 1354613114;
const origin = "https://api.github.com";
const maximumBytes = 2 * 1024 * 1024;

function positive(value: unknown): asserts value is number {
  if (!Number.isSafeInteger(value) || Number(value) < 1)
    throw new Error("dispatch provider identity must be a positive safe integer");
}

/** One exact prepared-tag dispatch. The fixed admitted coordinator must invoke
 * this INSIDE its existing remotely durable exclusive pending operation. This
 * transport authenticates no source, job, capacity or publication authority.
 * An ambiguous POST is never repeated here. */
type Candidate = {
  version: string;
  prepared_commit: string;
  remote_configuration: unknown;
  dispatch_actor_id: string;
};
export async function dispatchPreparedReleaseCandidate(
  raw: Candidate,
  credential: string,
  beforeDispatch: () => Promise<void>,
  transport: typeof fetch = fetch,
) {
  return observePreparedReleaseCandidate(raw, credential, beforeDispatch, transport, null);
}
/** Exact GET-only continuation of an already retained provider identity. This
 * cannot discover an unknown run, resolve ambiguity by guessing, or re-POST. */
export async function readPreparedReleaseCandidate(
  raw: Candidate,
  runId: number,
  credential: string,
  transport: typeof fetch = fetch,
) {
  positive(runId);
  return observePreparedReleaseCandidate(raw, credential, async () => {}, transport, runId);
}
/** GET-only lost-ack recovery. A complete, bracketed exact-head inventory must
 * identify exactly one first-attempt run from the fixed principal/tag. Missing
 * or multiple matches stay Unknown; absence never permits another POST. */
export async function discoverPreparedReleaseCandidate(
  raw: Candidate,
  credential: string,
  transport: typeof fetch = fetch,
) {
  return observePreparedReleaseCandidate(raw, credential, async () => {}, transport, 0);
}
async function observePreparedReleaseCandidate(
  raw: Candidate,
  credential: string,
  beforeDispatch: () => Promise<void>,
  transport: typeof fetch,
  existingRunId: number | null,
) {
  const input = structuredClone(raw);
  if (
    Object.keys(input).sort().join(",") !==
      "dispatch_actor_id,prepared_commit,remote_configuration,version" ||
    !/^[a-f0-9]{40}$/u.test(input.prepared_commit) ||
    !/^[1-9][0-9]*$/u.test(input.dispatch_actor_id) ||
    typeof beforeDispatch !== "function" ||
    typeof credential !== "string" ||
    !credential ||
    credential.length > 16384 ||
    /\s/u.test(credential)
  )
    throw new Error("prepared dispatch requires exact identities and dedicated credential");
  const namespace = inspectCoordinatorRemoteNamespace(input.remote_configuration);
  const version = classifyApplicationVersion(input.version).version;
  const ref = `refs/tags/${namespace}-prepared/v${version}`;
  const workflowEndpoint = `/repos/${repository}/actions/workflows/release.yml`;
  const start = performance.now();
  let requests = 0;
  const request = async (method: "GET" | "POST", endpoint: string, body?: unknown) => {
    if (++requests > 16 || performance.now() - start > 120000)
      throw new Error("prepared dispatch request or duration bound exceeded");
    const response = await transport(`${origin}${endpoint}`, {
      method,
      redirect: "error",
      signal: AbortSignal.timeout(15000),
      headers: {
        authorization: `Bearer ${credential}`,
        accept: "application/vnd.github+json",
        "content-type": "application/json",
        "x-github-api-version": "2026-03-10",
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    if (response.status !== 200) throw new Error("prepared dispatch response status unsupported");
    if (!response.body) throw new Error("prepared dispatch response body absent");
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let bytes = 0;
    try {
      for (;;) {
        const next = await reader.read();
        if (next.done) break;
        const chunk: unknown = next.value;
        if (!(chunk instanceof Uint8Array)) throw new Error("prepared dispatch body chunk invalid");
        bytes += chunk.byteLength;
        if (bytes > maximumBytes) throw new Error("prepared dispatch response exceeds byte bound");
        chunks.push(chunk);
      }
    } finally {
      await reader.cancel();
    }
    const rawBody = Buffer.concat(chunks);
    const text = rawBody.toString("utf8");
    if (!Buffer.from(text).equals(rawBody)) throw new Error("prepared dispatch body is not UTF-8");
    const value: unknown = JSON.parse(text);
    if (performance.now() - start > 120000) throw new Error("prepared dispatch readback expired");
    if (!isRecord(value)) throw new Error("prepared dispatch record absent");
    return value;
  };
  // Resolve the fixed workflow before the irreversible request. No caller
  // workflow ID, URL, arbitrary ref, command or input map is accepted.
  let attempted = false;
  let runId: number | null = null;
  try {
    const workflow = await request("GET", workflowEndpoint);
    positive(workflow.id);
    if (workflow.path !== ".github/workflows/release.yml" || workflow.state !== "active")
      throw new Error("fixed release workflow is unavailable");
    if (existingRunId === null) {
      await beforeDispatch();
      attempted = true;
      const acknowledgment = await request("POST", `${workflowEndpoint}/dispatches`, {
        ref: ref.slice("refs/tags/".length),
        inputs: { release_profile: "initial-beta-win-linux" },
      });
      positive(acknowledgment.workflow_run_id);
      runId = acknowledgment.workflow_run_id;
      if (
        acknowledgment.run_url !== `${origin}/repos/${repository}/actions/runs/${runId}` ||
        acknowledgment.html_url !== `https://github.com/${repository}/actions/runs/${runId}`
      )
        throw new Error("dispatch acknowledgment does not identify its exact fixed repository run");
    } else if (existingRunId > 0) runId = existingRunId;
    else {
      const route = `${workflowEndpoint}/runs?event=workflow_dispatch&head_sha=${input.prepared_commit}&per_page=100&page=`;
      const identities: { id: number; actor: string; branch: string; attempt: number }[] = [];
      let total: number | null = null;
      let first: string | null = null;
      const pageIdentity = (record: Record<string, unknown>) => {
        if (
          !Array.isArray(record.workflow_runs) ||
          record.workflow_runs.length > 100 ||
          !Number.isSafeInteger(record.total_count) ||
          Number(record.total_count) < 0 ||
          Number(record.total_count) >= 1000
        )
          throw new Error("dispatch recovery inventory incomplete or exceeds count bound");
        const rows = record.workflow_runs.map((raw: unknown) => {
          if (!isRecord(raw)) throw new Error("dispatch recovery run record absent");
          positive(raw.id);
          positive(raw.run_attempt);
          if (
            raw.workflow_id !== workflow.id ||
            raw.path !== ".github/workflows/release.yml" ||
            raw.event !== "workflow_dispatch" ||
            raw.head_sha !== input.prepared_commit ||
            !isRecord(raw.repository) ||
            raw.repository.id !== repositoryId ||
            raw.repository.full_name !== repository ||
            !isRecord(raw.actor) ||
            typeof raw.head_branch !== "string"
          )
            throw new Error("dispatch recovery inventory changed its fixed source scope");
          positive(raw.actor.id);
          return {
            id: raw.id,
            actor: String(raw.actor.id),
            branch: raw.head_branch,
            attempt: raw.run_attempt,
          };
        });
        return { total: Number(record.total_count), rows };
      };
      for (let page = 1; page <= 10; page++) {
        const record = pageIdentity(await request("GET", `${route}${page}`));
        if (total === null) {
          total = record.total;
          first = capacityDigest(record);
        }
        if (record.total !== total) throw new Error("dispatch recovery total drifted");
        identities.push(...record.rows);
        if (
          identities.length > total ||
          new Set(identities.map((row) => row.id)).size !== identities.length
        )
          throw new Error("dispatch recovery inventory duplicates or exceeds total");
        if (identities.length === total) break;
        if (record.rows.length !== 100)
          throw new Error("dispatch recovery inventory omitted a page");
      }
      if (
        identities.length !== total ||
        capacityDigest(pageIdentity(await request("GET", `${route}1`))) !== first
      )
        throw new Error("dispatch recovery inventory incomplete or changed during pagination");
      const matches = identities.filter(
        (row) =>
          row.actor === input.dispatch_actor_id &&
          row.branch === ref.slice("refs/tags/".length) &&
          row.attempt === 1,
      );
      if (matches.length !== 1)
        throw new Error("lost dispatch acknowledgment remains absent or ambiguous");
      runId = matches[0]!.id;
    }
    const run = await request("GET", `/repos/${repository}/actions/runs/${runId}`);
    if (
      run.id !== runId ||
      run.workflow_id !== workflow.id ||
      run.path !== ".github/workflows/release.yml" ||
      run.event !== "workflow_dispatch" ||
      run.run_attempt !== 1 ||
      run.head_sha !== input.prepared_commit ||
      run.head_branch !== ref.slice("refs/tags/".length) ||
      !isRecord(run.repository) ||
      run.repository.id !== repositoryId ||
      run.repository.full_name !== repository ||
      !isRecord(run.actor) ||
      String(run.actor.id) !== input.dispatch_actor_id ||
      !isRecord(run.triggering_actor) ||
      String(run.triggering_actor.id) !== input.dispatch_actor_id ||
      !["queued", "in_progress", "completed", "waiting", "pending", "requested"].includes(
        String(run.status),
      )
    )
      throw new Error("dispatched run differs from exact prepared candidate and principal");
    const evidence = {
      schema_version: 1,
      repository_id: repositoryId,
      workflow_id: workflow.id,
      workflow: ".github/workflows/release.yml",
      release_profile: "initial-beta-win-linux",
      ref,
      prepared_commit: input.prepared_commit,
      actor_id: input.dispatch_actor_id,
      run_id: runId,
      run_attempt: 1,
    };
    return {
      remote_identity: `github-actions:${repository}:run:${runId}:attempt:1`,
      evidence_sha256: capacityDigest(evidence),
      evidence,
      authority: "none" as const,
    };
  } catch {
    // Never print transport exceptions: they can contain credential-bearing
    // request details. Preserve only the bounded public operation identities.
    throw new CoordinatorRemoteError(
      "prepared dispatch refused or ambiguous; read back before another effect",
      {
        ref,
        prepared_commit: input.prepared_commit,
        mutation_attempted: attempted,
        acknowledged_run_id: runId,
        automatic_retry: false,
        authority: "none",
      },
    );
  }
}
