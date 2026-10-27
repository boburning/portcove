import { fileIdentity } from "./development-evidence.mts";
import { randomUUID } from "node:crypto";
import { mkdir, lstat, rm, appendFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { GitHubRestReader } from "./github-api.mts";
import type { ObserveOptions } from "./upstream-observer.mts";
import type { CatalogObserverCheckpoint } from "./catalog-upstream-observer.mts";
import { GitHubApiClient, GitHubApiError, createGitHubRunner } from "./github-api.mts";
import { isRecord } from "./runtime-values.mts";
import { advanceCatalogObservations } from "./catalog-upstream-observer.mts";
import {
  atomicJson,
  boundedJson,
  projectObservation,
  withCheckpointLock,
  validateObserverCheckpoint,
} from "./observe-configured-upstream.mts";
import {
  observationHash,
  ObservationFailure,
  validateObserverConfig,
} from "./upstream-observer.mts";
import type { ObserverConfig } from "./upstream-observer.mts";
import { observedHealthRepositoryIdentity } from "./upstream-health-monitor.mts";
import { assertOwnedUnlinkedPath } from "./release-path-safety.mts";

const defaultRoot = fileURLToPath(new URL("../", import.meta.url));

export async function retireObserverConfigurations(
  root: string,
  statePath: string,
  checkpoint: CatalogObserverCheckpoint,
  deadline: number,
  now = Date.now,
) {
  const cleanupDeferred: string[] = [];
  const directory = (config: ObserverConfig) =>
    path.join(root, "work/upstream-observer", observationHash(config));
  for (const progress of Object.values(checkpoint.sources)) {
    for (const retired of [...progress.retired_configs]) {
      if (now() >= deadline) break;
      const digest = observationHash(retired);
      if (
        [progress.current_config, progress.last_complete_config].some(
          (config) => config && observationHash(config) === digest,
        )
      )
        continue;
      const checkpointFile = path.join(directory(retired), "checkpoint.json");
      try {
        await withCheckpointLock(checkpointFile, async () => {
          validateObserverCheckpoint(
            await boundedJson(checkpointFile, 32 * 1024 * 1024, true),
            retired,
          );
          const files: string[] = [];
          for (const name of ["checkpoint.json", "report.json", "observation.json"]) {
            const filename = await assertOwnedUnlinkedPath(
              path.join(root, "work"),
              path.join(directory(retired), name),
              "retired observation cache",
            );
            const document = await boundedJson(filename, 32 * 1024 * 1024, true);
            if (document === null) continue;
            const metadata = await lstat(filename);
            if (
              !metadata.isFile() ||
              metadata.nlink !== 1 ||
              !isRecord(document) ||
              document.config_sha256 !== digest
            )
              throw new Error("Retired cache ownership changed; preserve it");
            files.push(filename);
          }
          for (const filename of files) await rm(filename);
        });
        progress.retired_configs = progress.retired_configs.filter(
          (config) => observationHash(config) !== digest,
        );
        await atomicJson(statePath, checkpoint);
      } catch {
        cleanupDeferred.push(digest);
      }
    }
  }
  return cleanupDeferred;
}

export async function runCatalogUpstreams(
  args: string[],
  runtime: {
    root?: string;
    now?: () => number;
    observer?: Pick<ObserveOptions, "fetch" | "sleep" | "signal">;
    project?: typeof projectObservation;
    api?: GitHubRestReader;
    log?: (value: string) => void;
  } = {},
) {
  const root = runtime.root ?? defaultRoot;
  const now = runtime.now ?? Date.now;
  if (args.length !== 2 || args[0] !== "--cli" || !args[1])
    throw new Error("usage: observe-catalog-upstreams.mts --cli REVIEWED_EXECUTABLE");
  const cli = path.resolve(args[1]);
  const config = validateObserverConfig(
    await boundedJson(path.join(root, "release/upstream-observer.json"), 16384),
  );
  const catalog = await boundedJson(
    path.join(root, "crates/portcove-core/catalog/catalog.json"),
    4 * 1024 * 1024,
  );
  const directory = (config: ObserverConfig) =>
    path.join(root, "work/upstream-observer", observationHash(config));
  const statePath = path.join(root, "work/upstream-observer/catalog/checkpoint.json");
  await mkdir(path.dirname(statePath), { recursive: true });
  const api =
    runtime.api ??
    new GitHubApiClient(
      createGitHubRunner({
        cwd: root,
        maxBuffer: config.budget.response_bytes + 16384,
        timeoutMs: 15000,
      }),
    );
  let health: unknown = null;
  try {
    health = await boundedJson(
      path.join(root, "work/upstream-health/checkpoint.json"),
      16 * 1024 * 1024,
      true,
    );
    observedHealthRepositoryIdentity(health, "validation-only");
  } catch {
    console.error(
      "Optional health metadata reuse unavailable; preserving that input and requiring fresh primary-provider identity.",
    );
    health = null;
  }
  const operationDeadline = now() + config.budget.duration_ms;
  const summaryByteLimit = config.budget.response_bytes;
  const handoffByteLimit = config.budget.total_bytes - summaryByteLimit;
  const handoffDirectory = path.join(root, "work/upstream-observer-handoff", randomUUID());
  const artifactSizes = new Map<string, number>();
  let artifactBytes = 0;
  return await withCheckpointLock(statePath, async () => {
    const result = await advanceCatalogObservations(
      catalog,
      await boundedJson(statePath, 32 * 1024 * 1024, true),
      {
        config,
        now,
        ...runtime.observer,
        policyIdentity: (await fileIdentity(cli, { signal: AbortSignal.timeout(30000) })).sha256,
        ...(process.env.GITHUB_TOKEN ? { token: process.env.GITHUB_TOKEN } : {}),
        withSourceLock: (sourceConfig, operation) =>
          withCheckpointLock(path.join(directory(sourceConfig), "checkpoint.json"), operation),
        load: (sourceConfig) =>
          boundedJson(
            path.join(directory(sourceConfig), "checkpoint.json"),
            32 * 1024 * 1024,
            true,
          ),
        save: (sourceConfig, checkpoint) =>
          atomicJson(path.join(directory(sourceConfig), "checkpoint.json"), checkpoint),
        commit: (checkpoint) => atomicJson(statePath, checkpoint),
        repositoryId: async (source, transport) => {
          const equivalent = observedHealthRepositoryIdentity(health, source.repository);
          if (equivalent !== null) return equivalent;
          transport.admitRequest();
          try {
            const response = api.request("GET", `/repos/${source.repository}`);
            transport.observeResponse(
              new Response(null, { headers: Object.fromEntries(response.headers) }),
            );
            transport.consumeResponseBytes(response.bodyBytes ?? null);
            if (
              response.bodyBytes === undefined ||
              response.bodyBytes > config.budget.response_bytes
            )
              throw new ObservationFailure(
                "budget",
                "Repository identity metadata exceeds its bounded response envelope",
              );
            if (
              response.status !== 200 ||
              !isRecord(response.body) ||
              !Number.isSafeInteger(response.body.id) ||
              Number(response.body.id) <= 0 ||
              response.body.full_name !== source.repository ||
              typeof response.body.archived !== "boolean"
            )
              throw new ObservationFailure(
                "repository-identity",
                "Primary provider metadata did not establish the exact declared repository",
              );
            return Number(response.body.id);
          } catch (error) {
            if (error instanceof GitHubApiError)
              transport.consumeResponseBytes(error.responseBytes);
            if (error instanceof GitHubApiError && error.code === "rate_limited")
              throw new ObservationFailure(
                "rate-limit",
                "Repository identity lookup is provider-deferred",
                error.rateLimit?.resetAt ?? null,
              );
            throw error;
          }
        },
        project: (portId, repositoryId, observation) =>
          (runtime.project ?? projectObservation)(
            cli,
            {
              ...config,
              port_id: portId,
              repository_id: repositoryId,
              repository: observation.facts.repository.full_name,
            },
            path.dirname(statePath),
            observation,
          ),
        export: async (source, sourceConfig, observation, policies) => {
          const legacy =
            sourceConfig.format === 1 &&
            sourceConfig.port_id === config.port_id &&
            sourceConfig.repository === config.repository;
          const filename = path.join(handoffDirectory, `${observationHash(sourceConfig)}.json`);
          const report = {
            ...observation.report,
            execution: {
              kind: process.env.GITHUB_EVENT_NAME ?? "local",
              source_commit: process.env.GITHUB_SHA ?? null,
              run_id: process.env.GITHUB_RUN_ID ?? null,
              run_attempt: process.env.GITHUB_RUN_ATTEMPT ?? null,
            },
            source_port_ids: source.ports.map((port) => port.id),
            catalog_policies: policies,
            unassessed_current_port_ids: observation.report.exception
              ? source.ports.map((port) => port.id)
              : [],
            catalog_policies_scope: observation.report.exception
              ? "last-complete-historical-fallback; current state unknown"
              : "complete-current-Core-projections",
          };
          if (legacy)
            await atomicJson(path.join(directory(sourceConfig), "report.json"), {
              ...observation.report,
              execution: report.execution,
            });
          const bytes = Buffer.byteLength(JSON.stringify(report));
          if (bytes > handoffByteLimit)
            throw new ObservationFailure(
              "handoff-size",
              "A single source handoff exceeds the physical response envelope; retain its complete provider/Core checkpoint. A reviewed framed handoff capability is required before this scope can be exported.",
            );
          if (artifactBytes - (artifactSizes.get(filename) ?? 0) + bytes > handoffByteLimit)
            throw new ObservationFailure(
              "budget",
              "Catalog handoff byte envelope exhausted; retain source and Core checkpoints for the next automatic batch",
            );
          await atomicJson(filename, report);
          artifactBytes += bytes - (artifactSizes.get(filename) ?? 0);
          artifactSizes.set(filename, bytes);
        },
      },
    );
    await atomicJson(statePath, result.checkpoint);
    const cleanupDeferred = await retireObserverConfigurations(
      root,
      statePath,
      result.checkpoint,
      operationDeadline,
      now,
    );
    let summary: unknown = {
      ...result.report,
      artifact_bytes: artifactBytes,
      artifact_byte_limit: config.budget.total_bytes,
      cleanup_deferred_configurations: cleanupDeferred,
    };
    if (Buffer.byteLength(JSON.stringify(summary)) > summaryByteLimit)
      summary = {
        format: 1,
        authority: "catalog-upstream-observation-only",
        generated_at: result.report.generated_at,
        coverage:
          "partial diagnostic export; complete operation scope remains in the runtime checkpoint and reviewed catalog",
        checkpoint_sha256: observationHash(result.checkpoint),
        total_sources: result.report.total_sources,
        attempted_sources: result.report.attempted_source_keys.length,
        completed_sources: result.report.completed_source_keys.length,
        pending_sources: result.report.pending_source_keys.length,
        held_ports: result.report.held.length,
        failure_events: result.report.failures.length,
        requests: result.report.requests,
        artifact_bytes: artifactBytes,
        artifact_byte_limit: config.budget.total_bytes,
        global_eligibility: "not-assessed",
        protected_publication: "not-authorized",
      };
    await atomicJson(path.join(handoffDirectory, "summary.json"), summary);
    (runtime.log ?? console.log)(JSON.stringify(summary));
    return { ...result, summary, handoff_directory: handoffDirectory };
  });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const result = await runCatalogUpstreams(process.argv.slice(2));
    if (process.env.GITHUB_OUTPUT) {
      if (/[\r\n]/u.test(result.handoff_directory)) throw new Error("Invalid artifact output path");
      await appendFile(
        process.env.GITHUB_OUTPUT,
        `catalog_handoff_directory=${result.handoff_directory}\n`,
      );
    }
    if (result.notify_exception) process.exitCode = 1;
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
