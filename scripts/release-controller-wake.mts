import { applicationMetadataMaintenancePriority } from "./release-metadata-contract.mts";
import { constants } from "node:fs";
import { createHash } from "node:crypto";
import { open, writeFile, appendFile } from "node:fs/promises";
import { crc32, inflateRawSync } from "node:zlib";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { GitHubApiClient, createGitHubRunner } from "./github-api.mts";
import type { IncludedResponse } from "./github-api.mts";
import { isRecord, errorMessage } from "./runtime-values.mts";
import { inspectControllerExecutionPurpose } from "./release-control-phases.mts";
import { productionControllerWorkflow } from "./production-controller-admission.mts";
import { inspectBoundedZip } from "./bounded-zip.mts";
import { readGitHubArtifactArchive } from "./github-binary.mts";
import { releaseCanonicalDigest as digest } from "./release-canonical.mts";

const repository = "boburning/portcove";
const prefix = `repos/${repository}`;
const workflow = ".github/workflows/application-update-wake.yml";
export const jobTokenDispatchActor = "41898282";
export const jobTokenDispatchTransport = "github-actions-job-v1";
const hash = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
type Api = { request(method: string, endpoint: string, body?: unknown): IncludedResponse };

/** Provider run identity only. Neither the Actions actor nor this readback is a
 * semantic result, a coordinator reservation, or permission to execute. */
export function inspectJobTokenDispatchRun(
  raw: unknown,
  expected: {
    run_id: string;
    revision: string;
    workflow: string;
    display_title: string;
  },
) {
  if (
    ![productionControllerWorkflow, ".github/workflows/job-token-dispatch-fixture.yml"].includes(
      expected.workflow,
    ) ||
    !/^[a-f0-9]{40}$/u.test(expected.revision) ||
    !/^[1-9][0-9]{0,15}$/u.test(expected.run_id) ||
    !isRecord(raw) ||
    String(raw.id) !== expected.run_id ||
    !Number.isSafeInteger(raw.id) ||
    raw.head_sha !== expected.revision ||
    raw.path !== expected.workflow ||
    raw.event !== "workflow_dispatch" ||
    raw.run_attempt !== 1 ||
    raw.display_title !== expected.display_title ||
    !isRecord(raw.actor) ||
    String(raw.actor.id) !== jobTokenDispatchActor ||
    !isRecord(raw.triggering_actor) ||
    String(raw.triggering_actor.id) !== jobTokenDispatchActor ||
    !isRecord(raw.repository) ||
    raw.repository.id !== 1354613114 ||
    raw.repository.full_name !== repository ||
    !isRecord(raw.head_repository) ||
    raw.head_repository.id !== 1354613114
  )
    throw new Error("job-token dispatch run, source or actual Actions actor differs");
  return { run_id: expected.run_id, revision: expected.revision, actor_id: jobTokenDispatchActor };
}

function providerGet(api: Api, endpoint: string) {
  const response = api.request("GET", endpoint);
  if (response.status !== 200) throw new Error("wake provider readback unavailable");
  return response.body;
}
function sourceBytes(raw: unknown, filename: string) {
  if (
    !isRecord(raw) ||
    raw.type !== "file" ||
    raw.path !== filename ||
    raw.encoding !== "base64" ||
    typeof raw.content !== "string" ||
    raw.content.length > 90000 ||
    typeof raw.size !== "number" ||
    raw.size < 1 ||
    raw.size > 65536 ||
    typeof raw.sha !== "string"
  )
    throw new Error("wake workflow source unavailable");
  const encoded = raw.content.replace(/\n/gu, ""),
    bytes = Buffer.from(encoded, "base64");
  if (
    bytes.toString("base64") !== encoded ||
    bytes.length !== raw.size ||
    createHash("sha1").update(`blob ${bytes.length}\0`).update(bytes).digest("hex") !== raw.sha
  )
    throw new Error("wake workflow source identity differs");
  return bytes;
}
function dispatchIntent(
  config: ReturnType<typeof inspectControllerWakeConfiguration>,
  wakeRun: string,
  wakeRevision: string,
) {
  return {
    schema_version: 1,
    controller: config,
    endpoint: `${prefix}/actions/workflows/application-update-production.yml/dispatches`,
    body: {
      ref: config.execution_ref.slice("refs/tags/".length),
      inputs: {
        wake_run_id: wakeRun,
        ...(config.schema_version >= 3 ? { publication_purpose: config.publication_purpose } : {}),
      },
      return_run_details: true,
    },
    wake_run_id: wakeRun,
    wake_revision: wakeRevision,
  };
}

/** Correlation is routing only. Acceptance still belongs to the fixed
 * controller's independent admission and existing reservation machinery. */
export function inspectWakeControllerRun(
  raw: unknown,
  config: ReturnType<typeof inspectControllerWakeConfiguration>,
  wakeRun: string,
  expectedRun: string,
) {
  if (config.schema_version === 4)
    inspectJobTokenDispatchRun(raw, {
      run_id: expectedRun,
      revision: config.revision,
      workflow: productionControllerWorkflow,
      display_title: `Portcove ${config.publication_purpose === "catalog-publication" ? "catalog publication" : "application release"} wake ${wakeRun}`,
    });
  if (
    !isRecord(raw) ||
    !Number.isSafeInteger(raw.id) ||
    Number(raw.id) < 1 ||
    String(raw.id) !== expectedRun ||
    raw.head_sha !== config.revision ||
    raw.path !== productionControllerWorkflow ||
    raw.event !== "workflow_dispatch" ||
    raw.run_attempt !== 1 ||
    raw.display_title !==
      `Portcove ${config.schema_version >= 3 && config.publication_purpose === "catalog-publication" ? "catalog publication" : "application release"} wake ${wakeRun}` ||
    !isRecord(raw.actor) ||
    String(raw.actor.id) !== config.dispatch_actor_id ||
    !isRecord(raw.triggering_actor) ||
    String(raw.triggering_actor.id) !== config.dispatch_actor_id ||
    !isRecord(raw.repository) ||
    raw.repository.id !== 1354613114 ||
    raw.repository.full_name !== repository ||
    !isRecord(raw.head_repository) ||
    raw.head_repository.id !== 1354613114
  )
    throw new Error("wake controller correlation, source or appointed dispatch actor differs");
  return {
    id: Number(raw.id),
    source: config.revision,
    wake_run_id: wakeRun,
    actor_id: config.dispatch_actor_id,
  };
}

async function verifyWakeIntentUpload(
  api: Api,
  environment: NodeJS.ProcessEnv,
  intent: unknown,
  options: {
    artifact: { id: number; sha256: string };
    download?: typeof readGitHubArtifactArchive;
    directory: string;
    deadline?: number;
    approved_configurations?: readonly ReturnType<typeof inspectControllerWakeConfiguration>[];
  },
) {
  const item = structuredClone(options.artifact);
  if (
    Object.keys(item).sort().join(",") !== "id,sha256" ||
    !Number.isSafeInteger(item.id) ||
    item.id < 1 ||
    !/^[a-f0-9]{64}$/u.test(item.sha256)
  )
    throw new Error("wake original immutable intent artifact missing");
  const read = () => {
    const raw = providerGet(api, `${prefix}/actions/artifacts/${item.id}`);
    if (
      !isRecord(raw) ||
      raw.id !== item.id ||
      raw.name !== `controller-wake-intent-${environment.GITHUB_RUN_ID}-1` ||
      raw.digest !== `sha256:${item.sha256}` ||
      raw.expired !== false ||
      typeof raw.size_in_bytes !== "number" ||
      !Number.isSafeInteger(raw.size_in_bytes) ||
      raw.size_in_bytes < 22 ||
      raw.size_in_bytes > 1024 ** 2 ||
      !isRecord(raw.workflow_run) ||
      String(raw.workflow_run.id) !== environment.GITHUB_RUN_ID ||
      raw.workflow_run.repository_id !== 1354613114 ||
      raw.workflow_run.head_repository_id !== 1354613114 ||
      raw.workflow_run.head_sha !== environment.GITHUB_SHA
    )
      throw new Error("wake intent artifact provider identity differs");
    return { id: item.id, bytes: raw.size_in_bytes, sha256: item.sha256 };
  };
  const before = read();
  const timeoutMs = Math.floor(
    Math.min(10000, options.deadline === undefined ? 10000 : options.deadline - performance.now()),
  );
  if (!Number.isFinite(timeoutMs) || timeoutMs < 1)
    throw new Error("wake artifact phase deadline exhausted");
  const archive = (options.download ?? readGitHubArtifactArchive)(
    `${prefix}/actions/artifacts/${item.id}/zip`,
    { cwd: options.directory, maxBytes: before.bytes, timeoutMs },
  );
  if (archive.length !== before.bytes || hash(archive) !== before.sha256)
    throw new Error("wake intent opaque archive differs");
  const entries = inspectBoundedZip(archive, {
    compressedBytes: 1024 ** 2,
    expandedBytes: 65536,
    files: 1,
    nameBytes: 64,
    allowedPaths: new Set(["controller-wake-intent.json"]),
  }).entries;
  const entry = entries[0];
  if (entries.length !== 1 || !entry || entry.bytes < 1)
    throw new Error("wake intent fixed inventory differs");
  const compressed = archive.subarray(entry.data, entry.dataEnd),
    bytes =
      entry.method === 0
        ? Buffer.from(compressed)
        : inflateRawSync(compressed, { maxOutputLength: entry.bytes });
  const matchedConfiguration = options.approved_configurations?.find((config) =>
    bytes.equals(
      Buffer.from(
        JSON.stringify(
          dispatchIntent(config, environment.GITHUB_RUN_ID!, environment.GITHUB_SHA!),
        ) + "\n",
      ),
    ),
  );
  if (
    bytes.length !== entry.bytes ||
    crc32(bytes) !== entry.crc ||
    !(options.approved_configurations
      ? matchedConfiguration !== undefined
      : bytes.equals(Buffer.from(JSON.stringify(intent) + "\n"))) ||
    digest(before) !== digest(read())
  )
    throw new Error("wake original durable intent changed");
  return matchedConfiguration;
}

/** Read-only bounded recovery before another dispatch. A previous successful
 * fixed wake is the inductive boundary: it checked its predecessors first.
 * Missing/expired history, failed responses and zero run matches are Unknown.
 * Only a provider-observed skipped fixed dispatch step proves no POST occurred. */
export async function reconcilePreviousWakes(
  config: ReturnType<typeof inspectControllerWakeConfiguration>,
  environment: NodeJS.ProcessEnv,
  api: Api,
  record: (phase: string, evidence: unknown) => Promise<void>,
  options: {
    download?: typeof readGitHubArtifactArchive;
    directory?: string;
    deadline?: number;
    approved_configurations?: readonly ReturnType<typeof inspectControllerWakeConfiguration>[];
  } = {},
) {
  const current = providerGet(api, `${prefix}/actions/runs/${environment.GITHUB_RUN_ID}`);
  if (
    !isRecord(current) ||
    String(current.id) !== environment.GITHUB_RUN_ID ||
    current.head_sha !== environment.GITHUB_SHA ||
    current.path !== workflow ||
    current.head_branch !== "main" ||
    !["push", "schedule"].includes(String(current.event)) ||
    current.run_attempt !== 1 ||
    !Number.isSafeInteger(current.run_number) ||
    typeof current.created_at !== "string" ||
    !Number.isFinite(Date.parse(current.created_at))
  )
    throw new Error("wake current automatic run identity unavailable");
  const end = Date.parse(current.created_at),
    activation = Date.parse(config.activation_started_at);
  if (activation > end) throw new Error("wake activation starts after current run");
  const start = Math.max(activation, end - 7 * 86400000),
    lower = new Date(start).toISOString();
  const route = `${prefix}/actions/workflows/application-update-wake.yml/runs?branch=main&created=${encodeURIComponent(`${lower}..${current.created_at}`)}&per_page=100`;
  const collect = (endpoint: string) => {
    const all: Record<string, unknown>[] = [];
    let total: number | undefined;
    for (let page = 1; page <= 10; page++) {
      const body = providerGet(api, `${endpoint}&page=${page}`);
      if (
        !isRecord(body) ||
        typeof body.total_count !== "number" ||
        !Number.isSafeInteger(body.total_count) ||
        body.total_count < 0 ||
        body.total_count >= 1000 ||
        !Array.isArray(body.workflow_runs) ||
        body.workflow_runs.length > 100 ||
        (total !== undefined && total !== body.total_count)
      )
        throw new Error("wake readback inventory incomplete, changed or search-saturated");
      total = body.total_count;
      for (const run of body.workflow_runs as unknown[]) {
        if (
          !isRecord(run) ||
          !Number.isSafeInteger(run.id) ||
          Number(run.id) < 1 ||
          !Number.isSafeInteger(run.run_number) ||
          Number(run.run_number) < 1 ||
          typeof run.created_at !== "string" ||
          !Number.isFinite(Date.parse(run.created_at)) ||
          all.some((item) => item.id === run.id)
        )
          throw new Error("wake run inventory identity duplicated or missing");
        all.push(run);
      }
      if (all.length === total) return all;
      if (body.workflow_runs.length < 100 || all.length > total)
        throw new Error("wake run inventory truncated");
    }
    throw new Error("wake readback pagination budget exhausted");
  };
  const runs = collect(route);
  if (!runs.some((run) => run.id === current.id && run.run_number === current.run_number))
    throw new Error("wake inventory omitted its known current run");
  const previous = runs
    .filter((run) => Number(run.run_number) < Number(current.run_number))
    .sort((a, b) => Number(b.run_number) - Number(a.run_number));
  for (const run of previous) {
    if (
      run.path !== workflow ||
      run.head_branch !== "main" ||
      !["push", "schedule"].includes(String(run.event)) ||
      run.run_attempt !== 1 ||
      run.status !== "completed" ||
      typeof run.head_sha !== "string" ||
      !/^[a-f0-9]{40}$/u.test(run.head_sha)
    )
      throw new Error("prior wake is not positively terminal in the selected automatic boundary");
    if (
      hash(
        sourceBytes(
          providerGet(api, `${prefix}/contents/${workflow}?ref=${run.head_sha}`),
          workflow,
        ),
      ) !== config.wake_workflow_sha256
    )
      throw new Error("prior wake source differs; reconcile activation history");
    if (run.conclusion === "success") {
      const artifacts = providerGet(
        api,
        `${prefix}/actions/runs/${String(run.id)}/artifacts?per_page=100`,
      );
      if (
        !isRecord(artifacts) ||
        typeof artifacts.total_count !== "number" ||
        !Number.isSafeInteger(artifacts.total_count) ||
        artifacts.total_count < 1 ||
        artifacts.total_count > 100 ||
        !Array.isArray(artifacts.artifacts) ||
        artifacts.artifacts.length !== artifacts.total_count
      )
        throw new Error("prior wake intent artifact coverage unavailable");
      const artifactIds = new Set<number>();
      for (const item of artifacts.artifacts as unknown[]) {
        if (
          !isRecord(item) ||
          typeof item.id !== "number" ||
          !Number.isSafeInteger(item.id) ||
          item.id < 1 ||
          typeof item.name !== "string" ||
          artifactIds.has(item.id)
        )
          throw new Error("prior wake artifact inventory identity missing or duplicated");
        artifactIds.add(item.id);
      }
      const matches = artifacts.artifacts.filter(
        (raw: unknown) =>
          isRecord(raw) && raw.name === `controller-wake-intent-${String(run.id)}-1`,
      );
      if (
        matches.length !== 1 ||
        !isRecord(matches[0]) ||
        typeof matches[0].id !== "number" ||
        !Number.isSafeInteger(matches[0].id) ||
        matches[0].id < 1 ||
        typeof matches[0].digest !== "string" ||
        !/^sha256:[a-f0-9]{64}$/u.test(matches[0].digest)
      )
        throw new Error("prior wake exact immutable intent unavailable");
      const originalConfiguration = await verifyWakeIntentUpload(
        api,
        { ...environment, GITHUB_RUN_ID: String(run.id), GITHUB_SHA: run.head_sha },
        dispatchIntent(config, String(run.id), run.head_sha),
        {
          artifact: { id: matches[0].id, sha256: matches[0].digest.slice(7) },
          directory: options.directory ?? process.cwd(),
          ...(options.approved_configurations === undefined
            ? {}
            : { approved_configurations: options.approved_configurations }),
          ...(options.download ? { download: options.download } : {}),
          ...(options.deadline === undefined ? {} : { deadline: options.deadline }),
        },
      );
      await record("prior-wake-boundary-observed", {
        wake_run_id: run.id,
        intent_artifact_id: matches[0].id,
        configuration_sha256: digest(originalConfiguration ?? config),
        publication_purpose: originalConfiguration?.publication_purpose ?? "application",
        scope: "dispatch scheduling only",
      });
      return;
    }
    const jobs = providerGet(
      api,
      `${prefix}/actions/runs/${String(run.id)}/attempts/1/jobs?per_page=100`,
    );
    if (
      !isRecord(jobs) ||
      jobs.total_count !== 1 ||
      !Array.isArray(jobs.jobs) ||
      jobs.jobs.length !== 1 ||
      !isRecord(jobs.jobs[0]) ||
      jobs.jobs[0].name !== "Wake fixed application controller" ||
      String(jobs.jobs[0].run_id) !== String(run.id) ||
      jobs.jobs[0].run_attempt !== 1 ||
      jobs.jobs[0].head_sha !== run.head_sha ||
      jobs.jobs[0].status !== "completed" ||
      !Array.isArray(jobs.jobs[0].steps)
    )
      throw new Error("prior wake fixed job readback unavailable");
    const steps = jobs.jobs[0].steps.filter(
      (step: unknown) =>
        isRecord(step) && step.name === "Dispatch retained immutable controller intent",
    );
    if (steps.length !== 1 || !isRecord(steps[0]) || steps[0].status !== "completed")
      throw new Error("prior wake dispatch step identity unavailable");
    if (steps[0].conclusion === "skipped") {
      await record("prior-wake-no-dispatch-observed", {
        wake_run_id: run.id,
        provider_step: steps[0],
      });
      continue;
    }
    if (typeof run.created_at !== "string" || !Number.isFinite(Date.parse(run.created_at)))
      throw new Error("prior wake creation identity unavailable");
    const production = collect(
      `${prefix}/actions/workflows/application-update-production.yml/runs?event=workflow_dispatch&head_sha=${config.revision}&created=${encodeURIComponent(`>=${run.created_at}`)}&per_page=100`,
    );
    const approved = options.approved_configurations ?? [config];
    const matches = production.filter((item) =>
      approved.some(
        (config) =>
          item.display_title ===
          `Portcove ${config.schema_version >= 3 && config.publication_purpose === "catalog-publication" ? "catalog publication" : "application release"} wake ${String(run.id)}`,
      ),
    );
    if (matches.length !== 1)
      throw new Error("prior wake dispatch remains missing or ambiguous; no later POST");
    const observed = inspectWakeControllerRun(
      providerGet(api, `${prefix}/actions/runs/${String(matches[0]!.id)}`),
      approved.find(
        (config) =>
          matches[0]!.display_title ===
          `Portcove ${config.schema_version >= 3 && config.publication_purpose === "catalog-publication" ? "catalog publication" : "application release"} wake ${String(run.id)}`,
      )!,
      String(run.id),
      String(matches[0]!.id),
    );
    await record("prior-wake-dispatch-readback", observed);
  }
  if (start > activation)
    throw new Error("wake history expired before a successful recovery boundary; no dispatch");
  if (digest(runs) !== digest(collect(route)))
    throw new Error("wake history changed during reconciliation");
}

/** Separately ratified routing only. No candidate, semantic, signing or release
 * policy is accepted from the default-branch wake-up. */
export function inspectControllerWakeConfiguration(value: unknown) {
  if (
    !isRecord(value) ||
    typeof value.schema_version !== "number" ||
    ![2, 3, 4].includes(value.schema_version) ||
    Object.keys(value).sort().join(",") !==
      (value.schema_version === 4
        ? "activation_started_at,dispatch_actor_id,dispatch_transport,execution_ref,namespace,publication_purpose,revision,schema_version,wake_workflow_sha256,workflow_sha256"
        : value.schema_version === 3
          ? "activation_started_at,dispatch_actor_id,execution_ref,namespace,publication_purpose,revision,schema_version,wake_workflow_sha256,workflow_sha256"
          : "activation_started_at,dispatch_actor_id,execution_ref,revision,schema_version,wake_workflow_sha256,workflow_sha256") ||
    typeof value.execution_ref !== "string" ||
    !/^refs\/tags\/portcove-production-controller-[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u.test(
      value.execution_ref,
    ) ||
    typeof value.revision !== "string" ||
    !/^[a-f0-9]{40}$/u.test(value.revision) ||
    typeof value.workflow_sha256 !== "string" ||
    !/^[a-f0-9]{64}$/u.test(value.workflow_sha256) ||
    typeof value.wake_workflow_sha256 !== "string" ||
    !/^[a-f0-9]{64}$/u.test(value.wake_workflow_sha256) ||
    typeof value.dispatch_actor_id !== "string" ||
    !/^[1-9][0-9]{0,15}$/u.test(value.dispatch_actor_id) ||
    typeof value.activation_started_at !== "string" ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/u.test(value.activation_started_at) ||
    !Number.isFinite(Date.parse(value.activation_started_at))
  )
    throw new Error("ratified wake-up controller tuple unavailable");
  if (
    Number(value.schema_version) >= 3 &&
    (typeof value.namespace !== "string" ||
      !/^portcove-[a-z0-9]+(?:-[a-z0-9]+){0,5}$/u.test(value.namespace) ||
      value.namespace.length > 64)
  )
    throw new Error("fixed shared wake namespace required");
  if (
    value.schema_version === 4 &&
    (value.dispatch_transport !== jobTokenDispatchTransport ||
      value.dispatch_actor_id !== jobTokenDispatchActor)
  )
    throw new Error("fixed job-token dispatch transport and observed Actions actor required");
  const purpose =
    Number(value.schema_version) >= 3
      ? inspectControllerExecutionPurpose(value.publication_purpose)
      : "application";
  return {
    schema_version: value.schema_version === 4 ? 4 : value.schema_version === 3 ? 3 : 2,
    ...(Number(value.schema_version) >= 3
      ? { publication_purpose: purpose, namespace: String(value.namespace) }
      : {}),
    ...(value.schema_version === 4 ? { dispatch_transport: jobTokenDispatchTransport } : {}),
    execution_ref: value.execution_ref,
    revision: value.revision,
    workflow_sha256: value.workflow_sha256,
    wake_workflow_sha256: value.wake_workflow_sha256,
    dispatch_actor_id: value.dispatch_actor_id,
    activation_started_at: value.activation_started_at,
  };
}

/** Operating route for the approved two-App setup. Legacy tuples remain readable
 * for original-intent recovery, but cannot acquire a new credential or dispatch. */
export function requireJobTokenWakeConfiguration(raw: unknown) {
  const value = inspectControllerWakeConfiguration(raw);
  if (value.schema_version !== 4 || value.dispatch_transport !== jobTokenDispatchTransport)
    throw new Error("current wake requires the explicitly ratified job-token configuration");
  return value;
}

/** A wake-up schedules the existing fixed controller; it cannot accept a
 * candidate or advance its coordinator. One invocation sends at most one POST.
 * An acknowledgement proves dispatch acceptance only, never run/publication.
 * Caller must retain intent/ambiguous outcome through the existing job receipt. */
export async function wakeRatifiedController(
  raw: unknown,
  environment: NodeJS.ProcessEnv,
  api: Api,
  record: (phase: string, evidence: unknown) => Promise<void>,
  options:
    | {
        mode: "prepare";
        deadline?: number;
        approved_configurations?: readonly ReturnType<typeof inspectControllerWakeConfiguration>[];
      }
    | {
        mode: "dispatch";
        artifact: { id: number; sha256: string };
        download?: typeof readGitHubArtifactArchive;
        directory: string;
        deadline?: number;
        approved_configurations?: readonly ReturnType<typeof inspectControllerWakeConfiguration>[];
      },
) {
  let deadline = Math.min(performance.now() + 55000, options.deadline ?? Infinity);
  const active = () => {
    if (!Number.isFinite(deadline) || performance.now() >= deadline)
      throw new Error("wake phase deadline exhausted; retain actual effects");
  };
  const request = api.request.bind(api);
  api = {
    request(method, endpoint, body) {
      active();
      const response = request(method, endpoint, body);
      if (method !== "POST") active();
      return response;
    },
  };
  const config = inspectControllerWakeConfiguration(raw);
  if (
    environment.GITHUB_ACTIONS !== "true" ||
    environment.GITHUB_SERVER_URL !== "https://github.com" ||
    environment.GITHUB_API_URL !== "https://api.github.com" ||
    environment.GITHUB_REPOSITORY !== repository ||
    environment.GITHUB_REPOSITORY_ID !== "1354613114" ||
    !["push", "schedule"].includes(environment.GITHUB_EVENT_NAME ?? "") ||
    environment.GITHUB_REF !== "refs/heads/main" ||
    environment.GITHUB_REF_TYPE !== "branch" ||
    environment.GITHUB_REF_PROTECTED !== "true" ||
    !/^[a-f0-9]{40}$/u.test(environment.GITHUB_SHA ?? "") ||
    environment.GITHUB_WORKFLOW_SHA !== environment.GITHUB_SHA ||
    environment.GITHUB_WORKFLOW_REF !== `${repository}/${workflow}@refs/heads/main` ||
    environment.GITHUB_RUN_ATTEMPT !== "1" ||
    environment.GITHUB_JOB !== "wake" ||
    environment.RUNNER_ENVIRONMENT !== "github-hosted" ||
    !/^[1-9][0-9]{0,15}$/u.test(environment.GITHUB_RUN_ID ?? "")
  )
    throw new Error("wake-up is outside its fixed automatic default-branch boundary");
  let requests = 0;
  const started = performance.now();
  const get = (route: string) => {
    if (++requests > 12 || performance.now() - started > 55000)
      throw new Error("wake-up collection bound exhausted");
    const response = api.request("GET", `${prefix}/${route}`.replace(/\/$/u, ""));
    if (response.status !== 200 || performance.now() - started > 55000)
      throw new Error("wake-up provider read unavailable or late");
    return response.body;
  };
  const identity = get("");
  if (
    !isRecord(identity) ||
    identity.id !== 1354613114 ||
    identity.full_name !== repository ||
    identity.default_branch !== "main" ||
    identity.private !== false
  )
    throw new Error("wake-up fixed public repository identity differs");
  if (config.schema_version === 4) {
    const jobs = get(`actions/runs/${environment.GITHUB_RUN_ID}/attempts/1/jobs?per_page=100`);
    const job = isRecord(jobs) && Array.isArray(jobs.jobs) ? (jobs.jobs[0] as unknown) : null;
    if (
      !isRecord(jobs) ||
      jobs.total_count !== 1 ||
      !Array.isArray(jobs.jobs) ||
      jobs.jobs.length !== 1 ||
      !isRecord(job) ||
      !Number.isSafeInteger(job.id) ||
      Number(job.id) < 1 ||
      job.name !== "Wake fixed application controller" ||
      String(job.run_id) !== environment.GITHUB_RUN_ID ||
      job.run_attempt !== 1 ||
      job.head_sha !== environment.GITHUB_SHA ||
      job.status !== "in_progress" ||
      typeof job.started_at !== "string" ||
      !Number.isFinite(Date.parse(job.started_at)) ||
      Date.now() < Date.parse(job.started_at) ||
      Date.now() >= Date.parse(job.started_at) + 55000
    )
      throw new Error("job-token wake requires its exact live hosted job and original budget");
    deadline = Math.min(
      deadline,
      performance.now() + Date.parse(job.started_at) + 55000 - Date.now(),
    );
  }
  const readRefs = () => {
    const current = get("git/ref/heads/main");
    const controller = get(`git/ref/${config.execution_ref.slice(5)}`);
    if (
      !isRecord(current) ||
      current.ref !== "refs/heads/main" ||
      !isRecord(current.object) ||
      current.object.type !== "commit" ||
      current.object.sha !== environment.GITHUB_SHA ||
      !isRecord(controller) ||
      controller.ref !== config.execution_ref ||
      !isRecord(controller.object) ||
      controller.object.type !== "commit" ||
      controller.object.sha !== config.revision
    )
      throw new Error("wake-up source/controller ref changed or unsupported");
  };
  readRefs();
  const source = get(`contents/${productionControllerWorkflow}?ref=${config.revision}`);
  if (
    !isRecord(source) ||
    source.type !== "file" ||
    source.path !== productionControllerWorkflow ||
    source.encoding !== "base64" ||
    typeof source.content !== "string" ||
    source.content.length > 90000 ||
    typeof source.size !== "number" ||
    source.size < 1 ||
    source.size > 65536 ||
    typeof source.sha !== "string" ||
    !/^[a-f0-9]{40}$/u.test(source.sha)
  )
    throw new Error("wake-up controller source unavailable or oversized");
  const encoded = source.content.replace(/\n/gu, "");
  const bytes = Buffer.from(encoded, "base64");
  if (
    bytes.toString("base64") !== encoded ||
    bytes.length !== source.size ||
    hash(bytes) !== config.workflow_sha256 ||
    createHash("sha1").update(`blob ${bytes.length}\0`).update(bytes).digest("hex") !== source.sha
  )
    throw new Error("wake-up controller source digest differs");
  if (
    hash(sourceBytes(get(`contents/${workflow}?ref=${environment.GITHUB_SHA}`), workflow)) !==
    config.wake_workflow_sha256
  )
    throw new Error("automatic wake workflow bytes differ from selected setup");
  readRefs();
  const intent = dispatchIntent(config, environment.GITHUB_RUN_ID!, environment.GITHUB_SHA!);
  const { endpoint, body } = intent;
  await record("dispatch-intent", intent);
  if (options.mode === "prepare")
    return { authority: "none", decision: "intent-prepared-only" as const, intent };
  const { approved_configurations, ...currentIntentOptions } = options;
  void approved_configurations; // The current upload must match ONLY its selected intent.
  await verifyWakeIntentUpload(api, environment, intent, {
    ...currentIntentOptions,
    deadline,
  });
  await reconcilePreviousWakes(config, environment, api, record, { ...options, deadline });
  readRefs();
  if (performance.now() - started > 55000)
    throw new Error("wake-up deadline elapsed before dispatch; no POST");
  // No retry and no replacement destination after an ambiguous provider effect.
  let response: IncludedResponse;
  try {
    response = api.request("POST", endpoint, body);
  } catch {
    await record("dispatch-ambiguous-no-retry", { response: "unavailable" });
    throw new Error("wake-up dispatch requires controller-run readback; no retry");
  }
  if (
    response.status !== 200 ||
    !isRecord(response.body) ||
    !Number.isSafeInteger(response.body.workflow_run_id) ||
    Number(response.body.workflow_run_id) < 1 ||
    response.body.run_url !==
      `https://api.github.com/${prefix}/actions/runs/${String(response.body.workflow_run_id)}` ||
    response.body.html_url !==
      `https://github.com/${repository}/actions/runs/${String(response.body.workflow_run_id)}`
  ) {
    await record("dispatch-not-confirmed-no-retry", { status: response.status ?? null });
    throw new Error("wake-up dispatch was not confirmed; retain original attempt");
  }
  const runId = String(response.body.workflow_run_id);
  await record("dispatch-provider-acknowledged-only", {
    controller_run_id: runId,
    endpoint: response.body.run_url,
  });
  const observed = api.request("GET", `${prefix}/actions/runs/${runId}`);
  if (observed.status !== 200)
    throw new Error("acknowledged controller run readback unavailable; retain original ID");
  inspectWakeControllerRun(observed.body, config, environment.GITHUB_RUN_ID!, runId);
  const result = {
    authority: "none",
    decision: "dispatch-acknowledged-only" as const,
    controller: config,
    wake_run_id: environment.GITHUB_RUN_ID,
    controller_run_id: runId,
    qualification:
      "No candidate, protected run, provider enforcement, capacity or publication acceptance",
  };
  await record("dispatch-acknowledged", result);
  active();
  return result;
}

/** Fixed scheduling only: data here never authenticates a candidate or effect. */
/** Workflow variables map an unconfigured purpose to the empty string. Only
 * absent/empty is inert; malformed configured JSON must still refuse. */
export function readControllerWakeChoicesFromEnvironment(env: NodeJS.ProcessEnv = process.env) {
  const parsed = (value: string | undefined): unknown =>
    value === undefined || value === "" ? null : JSON.parse(value);
  return inspectControllerWakeChoices(
    parsed(env.PORTCOVE_CONTROLLER_WAKE),
    parsed(env.PORTCOVE_CATALOG_CONTROLLER_WAKE),
  );
}

export function inspectControllerWakeChoices(application: unknown, catalog: unknown) {
  const configs = [application, catalog]
    .filter((value) => value != null)
    .map(inspectControllerWakeConfiguration);
  if (configs.length < 1) throw new Error("no configured automatic controller purpose");
  if (
    application != null &&
    configs[0]!.schema_version >= 3 &&
    configs[0]!.publication_purpose !== "application"
  )
    throw new Error("application wake purpose differs");
  if (
    catalog != null &&
    !(
      configs.at(-1)!.schema_version >= 3 &&
      configs.at(-1)!.publication_purpose === "catalog-publication"
    )
  )
    throw new Error("catalog wake purpose differs");
  if (configs.length === 2) {
    const [a, b] = configs;
    if (
      a!.schema_version < 3 ||
      b!.schema_version < 3 ||
      a!.schema_version !== b!.schema_version ||
      (a!.schema_version === 4 && a!.dispatch_actor_id !== b!.dispatch_actor_id) ||
      a!.namespace !== b!.namespace ||
      a!.revision !== b!.revision ||
      a!.execution_ref !== b!.execution_ref ||
      a!.workflow_sha256 !== b!.workflow_sha256 ||
      a!.wake_workflow_sha256 !== b!.wake_workflow_sha256 ||
      a!.activation_started_at !== b!.activation_started_at
    )
      throw new Error("automatic purposes require one shared controller/journal/history boundary");
  }
  return configs;
}
export function selectControllerWakePurpose(
  configs: ReturnType<typeof inspectControllerWakeChoices>,
  runNumber: unknown,
  priority: unknown = null,
) {
  if (typeof runNumber !== "number" || !Number.isSafeInteger(runNumber) || runNumber < 1)
    throw new Error("actual automatic run number required");
  if (priority !== null) {
    const purpose = inspectControllerExecutionPurpose(priority);
    const selected = configs.find(
      (config) => (config.publication_purpose ?? "application") === purpose,
    );
    if (!selected) throw new Error("pending journal purpose is not configured");
    return selected;
  }
  return configs[(runNumber - 1) % configs.length]!;
}
export function readWakePurposePriority(api: Api, namespace: string) {
  const endpoint = `${prefix}/git/ref/heads/${namespace}-coordinator-state`;
  const before = providerGet(api, endpoint);
  if (
    !isRecord(before) ||
    before.ref !== `refs/heads/${namespace}-coordinator-state` ||
    !isRecord(before.object) ||
    before.object.type !== "commit" ||
    typeof before.object.sha !== "string" ||
    !/^[a-f0-9]{40}$/u.test(before.object.sha)
  )
    throw new Error("wake journal routing ref unavailable");
  const raw = providerGet(api, `${prefix}/contents/state.json?ref=${before.object.sha}`);
  const bytes = sourceBytes(raw, "state.json");
  const state: unknown = JSON.parse(bytes.toString("utf8"));
  if (
    digest(before) !== digest(providerGet(api, endpoint)) ||
    !isRecord(state) ||
    state.schema_version !== 1 ||
    !isRecord(state.input)
  )
    throw new Error("wake journal routing snapshot changed");
  if (
    Object.keys(state).sort().join(",") !== "input,previous,schema_version" ||
    (state.previous !== null &&
      (typeof state.previous !== "string" || !/^[a-f0-9]{40}$/u.test(state.previous)))
  )
    throw new Error("wake routing checkpoint schema malformed");
  const input = state.input;
  if (
    !Object.hasOwn(input, "active_candidate") ||
    (input.active_candidate !== null && !isRecord(input.active_candidate)) ||
    !isRecord(input.controller) ||
    !isRecord(input.controller.capacity_attempt) ||
    !Object.hasOwn(input.controller.capacity_attempt, "operation") ||
    (input.controller.capacity_attempt.operation !== null &&
      !isRecord(input.controller.capacity_attempt.operation))
  )
    throw new Error("wake routing reservation/capacity unavailable");
  for (const key of ["review_request", "catalog_review_request", "catalog_publication"])
    if (input[key] != null && !isRecord(input[key]))
      throw new Error("wake routing subject malformed");
  if (input.active_candidate != null || input.review_request != null) return "application";
  const controller = isRecord(input.controller) ? input.controller : null;
  const capacity =
    controller && isRecord(controller.capacity_attempt) ? controller.capacity_attempt : null;
  const operation = capacity && isRecord(capacity.operation) ? capacity.operation : null;
  if (
    operation &&
    !["pending", "succeeded", "recovered", "capacity-refused", "ambiguous"].includes(
      String(operation.outcome),
    )
  )
    throw new Error("wake routing outcome unknown");
  if (operation && !["succeeded", "recovered"].includes(String(operation.outcome)))
    return operation.catalog_publication != null ? "catalog-publication" : "application";
  if (input.catalog_publication != null) return "catalog-publication";
  if (applicationMetadataMaintenancePriority(input, new Date().toISOString())) return "application";
  if (input.catalog_review_request != null) return "catalog-publication";
  return null;
}
async function main() {
  const mode = process.argv[2];
  if (process.argv.length !== 3 || (mode !== "--prepare" && mode !== "--dispatch"))
    throw new Error("choose fixed wake prepare or dispatch; no candidate arguments");
  if (process.env.NODE_OPTIONS || process.env.NODE_PATH)
    throw new Error("wake refuses injected Node startup configuration");
  const temp = process.env.RUNNER_TEMP;
  if (!temp || !path.isAbsolute(temp)) throw new Error("private runner temporary root unavailable");
  const receipt = await open(
    path.join(temp, `portcove-controller-wake-${mode.slice(2)}.jsonl`),
    "wx",
    0o600,
  );
  try {
    let deadline = performance.now() + 10000;
    const api = new GitHubApiClient((args, input) => {
      const timeoutMs = Math.floor(Math.min(10000, deadline - performance.now()));
      if (!Number.isFinite(timeoutMs) || timeoutMs < 1)
        throw new Error("wake job budget exhausted");
      return createGitHubRunner({ timeoutMs, maxBuffer: 2 * 1024 ** 2 })(
        [...args, "--hostname", "github.com", "--header", "X-GitHub-Api-Version:2026-03-10"],
        input,
      );
    });
    const jobs = providerGet(
      api,
      `${prefix}/actions/runs/${process.env.GITHUB_RUN_ID}/attempts/1/jobs?per_page=100`,
    );
    if (
      !isRecord(jobs) ||
      jobs.total_count !== 1 ||
      !Array.isArray(jobs.jobs) ||
      jobs.jobs.length !== 1 ||
      !isRecord(jobs.jobs[0]) ||
      jobs.jobs[0].name !== "Wake fixed application controller" ||
      String(jobs.jobs[0].run_id) !== process.env.GITHUB_RUN_ID ||
      jobs.jobs[0].run_attempt !== 1 ||
      jobs.jobs[0].head_sha !== process.env.GITHUB_SHA ||
      jobs.jobs[0].status !== "in_progress" ||
      typeof jobs.jobs[0].started_at !== "string"
    )
      throw new Error("actual wake job start unavailable; no renewed budget");
    const remaining = Date.parse(jobs.jobs[0].started_at) + 55000 - Date.now();
    if (!Number.isFinite(remaining) || remaining <= 0 || remaining > 55000)
      throw new Error("actual wake job original budget exhausted or future-dated");
    deadline = performance.now() + remaining;
    const choices = readControllerWakeChoicesFromEnvironment();
    const selectedFile = path.join(temp, "controller-wake-selected.json");
    let selected: ReturnType<typeof inspectControllerWakeConfiguration>;
    if (mode === "--prepare") {
      const current = providerGet(api, `${prefix}/actions/runs/${process.env.GITHUB_RUN_ID}`);
      if (!isRecord(current) || String(current.id) !== process.env.GITHUB_RUN_ID)
        throw new Error("actual wake run number unavailable");
      const priority =
        choices.length === 2 ? readWakePurposePriority(api, choices[0]!.namespace!) : null;
      selected = selectControllerWakePurpose(choices, current.run_number, priority);
      requireJobTokenWakeConfiguration(selected);
      await writeFile(selectedFile, JSON.stringify(selected), { flag: "wx", mode: 0o600 });
      if (!process.env.GITHUB_OUTPUT) throw new Error("wake selection output unavailable");
      await appendFile(
        process.env.GITHUB_OUTPUT,
        `dispatch_transport=${jobTokenDispatchTransport}\npublication_purpose=${selected.publication_purpose ?? "application"}\n`,
      );
    } else {
      const handle = await open(
        selectedFile,
        constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
      );
      let bytes: Buffer;
      try {
        const before = await handle.stat();
        if (!before.isFile() || before.nlink !== 1 || before.size < 1 || before.size > 65536)
          throw new Error("retained wake selection invalid");
        const buffer = Buffer.alloc(before.size + 1);
        let length = 0;
        for (;;) {
          const part = await handle.read(buffer, length, buffer.length - length, null);
          if (!part.bytesRead) break;
          length += part.bytesRead;
          if (length === buffer.length) break;
        }
        const after = await handle.stat();
        if (
          length !== before.size ||
          after.size !== before.size ||
          after.mtimeMs !== before.mtimeMs ||
          after.ctimeMs !== before.ctimeMs
        )
          throw new Error("retained wake selection changed");
        bytes = buffer.subarray(0, length);
      } finally {
        await handle.close();
      }
      selected = requireJobTokenWakeConfiguration(JSON.parse(bytes.toString("utf8")));
      if (!choices.some((config) => digest(config) === digest(selected)))
        throw new Error("retained selected wake configuration changed");
    }
    const result = await wakeRatifiedController(
      selected,
      process.env,
      api,
      async (phase, evidence) => {
        await receipt.writeFile(JSON.stringify({ schema_version: 1, phase, evidence }) + "\n");
        await receipt.sync();
      },
      mode === "--prepare"
        ? { mode: "prepare", deadline, approved_configurations: choices }
        : {
            mode: "dispatch",
            deadline,
            approved_configurations: choices,
            directory: temp,
            artifact: {
              id: Number(process.env.PORTCOVE_WAKE_INTENT_ARTIFACT_ID),
              sha256: process.env.PORTCOVE_WAKE_INTENT_ARTIFACT_SHA256 ?? "",
            },
          },
    );
    if (result.decision === "intent-prepared-only") {
      const intent = await open(path.join(temp, "controller-wake-intent.json"), "wx", 0o600);
      try {
        await intent.writeFile(JSON.stringify(result.intent) + "\n");
        await intent.sync();
      } finally {
        await intent.close();
      }
    }
    console.log(JSON.stringify(result));
  } finally {
    await receipt.close();
  }
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  main().catch((error) => {
    console.error(errorMessage(error));
    process.exitCode = 1;
  });
