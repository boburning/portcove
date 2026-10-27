import {
  acceptedObservationPosition,
  acceptedObservationAdvanced,
  catalogProgressPosition,
  catalogPositionAdvanced,
  continueCatalogBatches,
} from "./catalog-observer-continuation.mts";
import { fileIdentity, readBoundedEvidenceFile } from "./development-evidence.mts";
import { randomUUID, createHash } from "node:crypto";
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
  projectProviderObservation,
  inspectCatalogDefinitions,
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
    projectProvider?: typeof projectProviderObservation;
    providerFetch?: typeof fetch;
    inspectCatalog?: typeof inspectCatalogDefinitions;
    api?: GitHubRestReader;
    log?: (value: string) => void;
    deadline?: number;
    excludedSources?: ReadonlySet<string>;
    handoff?: { directory: string; sizes: Map<string, number>; bytes: number };
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
  const operationDeadline = Math.min(
    now() + config.budget.duration_ms,
    runtime.deadline ?? Infinity,
  );
  if (!Number.isFinite(operationDeadline) || operationDeadline <= now())
    throw new ObservationFailure("budget", "Observer opportunity deadline unavailable");
  const catalogInput = await readBoundedEvidenceFile(
    path.join(root, "crates/portcove-core/catalog/catalog.json"),
    4 * 1024 * 1024,
  );
  const catalog: unknown = JSON.parse(catalogInput.bytes.toString("utf8"));
  const directory = (config: ObserverConfig) =>
    path.join(root, "work/upstream-observer", observationHash(config));
  const statePath = path.join(root, "work/upstream-observer/catalog/checkpoint.json");
  await mkdir(path.dirname(statePath), { recursive: true });
  const api =
    runtime.api ??
    new GitHubApiClient((args, input) =>
      createGitHubRunner({
        cwd: root,
        maxBuffer: config.budget.response_bytes + 16384,
        timeoutMs: Math.max(1, Math.min(15000, Math.floor(operationDeadline - now()))),
      })(args, input),
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
  const summaryByteLimit = config.budget.response_bytes;
  const handoffByteLimit = config.budget.total_bytes - summaryByteLimit;
  const handoff = runtime.handoff ?? {
    directory: path.join(root, "work/upstream-observer-handoff", randomUUID()),
    sizes: new Map<string, number>(),
    bytes: 0,
  };
  const handoffDirectory = handoff.directory,
    artifactSizes = handoff.sizes;
  let artifactBytes = handoff.bytes,
    handoffExhausted = false,
    acceptedProgress = false;
  const sourcePositions = new Map<string, ReturnType<typeof acceptedObservationPosition>>();
  return await withCheckpointLock(statePath, async () => {
    const coreEntry = await lstat(cli, { bigint: true });
    const assertCoreEntry = async () => {
      const current = await lstat(cli, { bigint: true });
      if (
        !coreEntry.isFile() ||
        !current.isFile() ||
        current.isSymbolicLink() ||
        (["dev", "ino", "size", "mtimeNs", "ctimeNs"] as const).some(
          (key) => current[key] !== coreEntry[key],
        )
      )
        throw new ObservationFailure(
          "core-identity",
          "Core executable identity changed; retain checkpoints and rebind the next invocation",
        );
    };
    const coreIdentity = await fileIdentity(cli, {
      signal: AbortSignal.timeout(Math.max(1, Math.min(30000, operationDeadline - now()))),
    });
    await assertCoreEntry();
    const definitionHashes = await (runtime.inspectCatalog ?? inspectCatalogDefinitions)(
      cli,
      path.dirname(statePath),
      catalogInput.bytes,
      { deadline: operationDeadline, now },
    );
    await assertCoreEntry();
    const prior = await boundedJson(statePath, 32 * 1024 * 1024, true);
    const beforePosition = catalogProgressPosition(prior);
    const result = await advanceCatalogObservations(catalog, prior, {
      config,
      now,
      deadline: operationDeadline,
      ...(runtime.excludedSources ? { excludedSources: runtime.excludedSources } : {}),
      ...runtime.observer,
      policyIdentity: coreIdentity.sha256,
      definitionHash: (portId) => definitionHashes.get(portId) ?? "",
      ...(process.env.GITHUB_TOKEN ? { token: process.env.GITHUB_TOKEN } : {}),
      withSourceLock: (sourceConfig, operation) =>
        withCheckpointLock(path.join(directory(sourceConfig), "checkpoint.json"), operation),
      load: async (sourceConfig) => {
        const value = await boundedJson(
          path.join(directory(sourceConfig), "checkpoint.json"),
          32 * 1024 * 1024,
          true,
        );
        sourcePositions.set(observationHash(sourceConfig), acceptedObservationPosition(value));
        return value;
      },
      save: async (sourceConfig, checkpoint) => {
        const key = observationHash(sourceConfig),
          before = sourcePositions.get(key);
        await atomicJson(path.join(directory(sourceConfig), "checkpoint.json"), checkpoint);
        if (acceptedObservationAdvanced(before, acceptedObservationPosition(checkpoint)))
          acceptedProgress = true;
        sourcePositions.set(key, acceptedObservationPosition(checkpoint));
      },
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
          if (response.bodyBytes === undefined || response.bodyBytes > config.budget.response_bytes)
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
          if (error instanceof GitHubApiError) transport.consumeResponseBytes(error.responseBytes);
          if (error instanceof GitHubApiError && error.code === "rate_limited")
            throw new ObservationFailure(
              "rate-limit",
              "Repository identity lookup is provider-deferred",
              error.rateLimit?.resetAt ?? null,
            );
          if (error instanceof GitHubApiError)
            throw new ObservationFailure(
              error.status === 404
                ? "repository-unavailable"
                : error.status === 401 || error.status === 403
                  ? "authentication-or-access"
                  : "provider-transport",
              error.status === null
                ? "Primary repository identity transport is unavailable; retry a bounded fresh lookup without changing the retained source."
                : `Primary repository identity returned HTTP ${error.status}; preserve the declared source and reconcile its current primary-provider availability.`,
            );
          throw error;
        }
      },
      ...(runtime.providerFetch ? { providerFetch: runtime.providerFetch } : {}),
      projectProvider: async (portId, observation) => {
        await assertCoreEntry();
        const report = await (runtime.projectProvider ?? projectProviderObservation)(
          cli,
          portId,
          path.dirname(statePath),
          observation,
          { deadline: operationDeadline, now },
        );
        await assertCoreEntry();
        return report;
      },
      exportProvider: async (source, observations, policies) => {
        const filename = path.join(handoffDirectory, `${source.key}.json`);
        const report = {
          format: 2,
          authority: "provider-observation-only",
          provider: source.provider,
          execution: {
            kind: process.env.GITHUB_EVENT_NAME ?? "local",
            source_commit: process.env.GITHUB_SHA ?? null,
            run_id: process.env.GITHUB_RUN_ID ?? null,
            run_attempt: process.env.GITHUB_RUN_ATTEMPT ?? null,
          },
          source_port_ids: source.ports.map((p) => p.id),
          observations,
          catalog_policies: policies,
          catalog_policies_scope: "complete-current-Core-projections",
          unassessed_current_port_ids: [],
          artifact_bytes_verified: false,
          catalog_admission_assessed: false,
          player_update_eligibility_assessed: false,
          protected_publication: "not-authorized",
        };
        const bytes = Buffer.byteLength(JSON.stringify(report));
        if (bytes > handoffByteLimit)
          throw new ObservationFailure(
            "handoff-size",
            "Provider source handoff exceeds the physical byte envelope; complete checkpoint retained",
          );
        if (artifactBytes - (artifactSizes.get(filename) ?? 0) + bytes > handoffByteLimit) {
          handoffExhausted = true;
          throw new ObservationFailure(
            "budget",
            "Provider handoff envelope exhausted; completed source retained for continuation",
          );
        }
        await atomicJson(filename, report);
        artifactBytes += bytes - (artifactSizes.get(filename) ?? 0);
        artifactSizes.set(filename, bytes);
        handoff.bytes = artifactBytes;
      },
      project: async (portId, repositoryId, observation) => {
        await assertCoreEntry();
        const policy = await (runtime.project ?? projectObservation)(
          cli,
          {
            ...config,
            port_id: portId,
            repository_id: repositoryId,
            repository: observation.facts.repository.full_name,
          },
          path.dirname(statePath),
          observation,
          { deadline: operationDeadline, now },
        );
        await assertCoreEntry();
        return policy;
      },
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
        if (artifactBytes - (artifactSizes.get(filename) ?? 0) + bytes > handoffByteLimit) {
          handoffExhausted = true;
          throw new ObservationFailure(
            "budget",
            "Catalog handoff byte envelope exhausted; retain source and Core checkpoints for the next automatic batch",
          );
        }
        await atomicJson(filename, report);
        artifactBytes += bytes - (artifactSizes.get(filename) ?? 0);
        artifactSizes.set(filename, bytes);
        handoff.bytes = artifactBytes;
      },
    });
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
    return {
      ...result,
      summary,
      handoff_directory: handoffDirectory,
      handoff_exhausted: handoffExhausted,
      made_progress:
        acceptedProgress ||
        catalogPositionAdvanced(beforePosition, catalogProgressPosition(result.checkpoint)),
    };
  });
}

/** Use only a positively bounded caller opportunity; retain the same per-operation config. */
export async function runCatalogOpportunity(
  args: string[],
  runtime: NonNullable<Parameters<typeof runCatalogUpstreams>[1]> & { deadline: number },
) {
  const root = runtime.root ?? defaultRoot,
    now = runtime.now ?? Date.now;
  if (args.length !== 2 || args[0] !== "--cli" || !args[1])
    throw new Error("An exact reviewed Core inspector is required");
  const fixedArgs = [...args],
    cli = path.resolve(args[1]);
  if (
    !Number.isFinite(runtime.deadline) ||
    runtime.deadline <= now() ||
    runtime.deadline - now() > 9 * 60000
  )
    throw new ObservationFailure(
      "budget",
      "Hosted observation opportunity is unavailable or exceeds its existing job boundary",
    );
  const inputs = async () => {
    const values = await Promise.all([
      readBoundedEvidenceFile(path.join(root, "release/upstream-observer.json"), 16384),
      readBoundedEvidenceFile(
        path.join(root, "crates/portcove-core/catalog/catalog.json"),
        4 * 1024 * 1024,
      ),
    ]);
    return createHash("sha256").update(values[0].bytes).update(values[1].bytes).digest("hex");
  };
  const identity = await inputs(),
    entry = await lstat(cli, { bigint: true });
  const assertInputs = async () => {
    const current = await lstat(cli, { bigint: true });
    if (
      !entry.isFile() ||
      entry.isSymbolicLink() ||
      !current.isFile() ||
      current.isSymbolicLink() ||
      (["dev", "ino", "size", "mtimeNs", "ctimeNs"] as const).some(
        (key) => entry[key] !== current[key],
      ) ||
      (await inputs()) !== identity
    )
      throw new ObservationFailure(
        "operation-input-changed",
        "Catalog, configuration or Core object changed between bounded batches; preserved progress cannot authorize another scope",
      );
  };
  const config = validateObserverConfig(
    await boundedJson(path.join(root, "release/upstream-observer.json"), 16384),
  );
  const handoff = {
    directory: path.join(root, "work/upstream-observer-handoff", randomUUID()),
    sizes: new Map<string, number>(),
    bytes: 0,
  };
  await mkdir(handoff.directory, { recursive: true });
  if (process.env.GITHUB_OUTPUT) {
    if (/[\r\n]/u.test(handoff.directory)) throw new Error("Invalid handoff output path");
    await appendFile(process.env.GITHUB_OUTPUT, `catalog_handoff_directory=${handoff.directory}\n`);
  }
  try {
    const result = await continueCatalogBatches(
      async (excluded) => {
        await assertInputs();
        const batch = await runCatalogUpstreams(fixedArgs, {
          ...runtime,
          handoff,
          excludedSources: excluded,
          log: () => {},
        });
        await assertInputs();
        return batch;
      },
      {
        deadline: runtime.deadline,
        now,
        ...(runtime.observer?.signal ? { signal: runtime.observer.signal } : {}),
        onBatch: (batch) => {
          (runtime.log ?? console.log)(
            JSON.stringify({
              format: 1,
              kind: "catalog-observation-batch",
              requests: batch.report.requests,
              response_bytes: batch.report.response_bytes_charged,
              completed: batch.report.completed_source_keys.length,
              pending: batch.report.pending_source_keys.length,
              made_progress: batch.made_progress,
              handoff_exhausted: batch.handoff_exhausted,
            }),
          );
        },
      },
    );
    let summary: unknown = {
      ...result.report,
      bounded_batches: result.batches,
      artifact_bytes: handoff.bytes,
      artifact_byte_limit: config.budget.total_bytes,
    };
    if (Buffer.byteLength(JSON.stringify(summary)) > config.budget.response_bytes)
      summary = {
        format: 1,
        authority: "catalog-upstream-observation-only",
        coverage:
          "partial diagnostic export; full obligations remain in current checkpoint and catalog",
        checkpoint_sha256: observationHash(result.checkpoint),
        bounded_batches: result.batches,
        total_sources: result.report.total_sources,
        pending_sources: result.report.pending_source_keys.length,
        failure_events: result.report.failures.length,
        requests: result.report.requests,
        response_bytes: result.report.response_bytes_charged,
        artifact_bytes: handoff.bytes,
        global_eligibility: "not-assessed",
        protected_publication: "not-authorized",
      };
    await atomicJson(path.join(handoff.directory, "summary.json"), summary);
    (runtime.log ?? console.log)(JSON.stringify(summary));
    return { ...result, summary };
  } catch (error) {
    // Keep completed source files even if a later batch cannot start or finish.
    const summary = {
      format: 1,
      authority: "catalog-upstream-observation-only",
      coverage: "partial; operation failed and prior source files/checkpoints remain evidence only",
      failure: error instanceof Error ? error.message.slice(0, 2048) : "Unknown operation failure",
      artifact_bytes: handoff.bytes,
      global_eligibility: "not-assessed",
      protected_publication: "not-authorized",
    };
    await atomicJson(path.join(handoff.directory, "summary.json"), summary);
    throw error;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const deadline = process.env.PORTCOVE_OBSERVER_OPPORTUNITY_DEADLINE_UTC;
    const result =
      deadline === undefined
        ? await runCatalogUpstreams(process.argv.slice(2))
        : await runCatalogOpportunity(process.argv.slice(2), { deadline: Date.parse(deadline) });
    if (process.env.GITHUB_OUTPUT && deadline === undefined) {
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
