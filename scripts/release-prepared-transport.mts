import { performance } from "node:perf_hooks";
import { exportPreparedReleaseVersion } from "../apps/desktop/scripts/prepare-release-version.mts";
import { exportCoordinatorCheckpoint } from "./release-coordinator-state.mts";
import { inspectRemoteCommitObject } from "./release-coordinator-recovery.mts";
import {
  inspectCoordinatorRemoteNamespace,
  publishCoordinatorCheckpoint,
} from "./release-coordinator-remote.mts";
import type { CoordinatorCheckpointApi } from "./release-coordinator-remote.mts";
import { CoordinatorRemoteError } from "./release-coordinator-errors.mts";
import { sanitizeOperationError } from "./github-api.mts";
import { isRecord } from "./runtime-values.mts";

const base = "repos/boburning/portcove";

/** Inactive object custody plus the existing journal CAS. The admitted caller
 * owns the bare repository, transport, protected principal and ref configuration.
 * Source objects must already exist remotely. No checkout/code execution, ref
 * writer, credentials, allocator, initialization or execution grant is added. */
export async function publishPreparedCoordinatorCheckpoint(
  repository: string,
  expected: string,
  configuration: unknown,
  options: {
    api?: CoordinatorCheckpointApi;
    publishCheckpoint?: (checkpoint: string) => Promise<unknown>;
  } = {},
) {
  const config = structuredClone(configuration);
  inspectCoordinatorRemoteNamespace(config);
  if (!options.api) throw new Error("prepared application transport is unconfigured");
  const api = {
    request: options.api.request.bind(options.api),
    graphql: options.api.graphql.bind(options.api),
  };
  const checkpoint = await exportCoordinatorCheckpoint(repository, expected);
  if (!checkpoint.previous) throw new Error("prepared transport cannot initialize a coordinator");
  const state: unknown = JSON.parse(checkpoint.blob.contents);
  const candidate = isRecord(state) && isRecord(state.input) ? state.input.active_candidate : null;
  if (!isRecord(candidate))
    throw new Error("prepared transport requires an existing active reservation");
  const string = (key: string) => {
    const value = candidate[key];
    if (typeof value !== "string") throw new Error("prepared reservation identity incomplete");
    return value;
  };
  const prepared = exportPreparedReleaseVersion(repository, {
    source_commit: string("source_commit"),
    source_tree: string("source_tree"),
    prepared_commit: string("prepared_commit"),
    prepared_tree: string("prepared_tree"),
    intent_sha256: string("intent_sha256"),
    version: string("version"),
  });
  const observations: { kind: string; oid: string; mutation_error: unknown }[] = [];
  try {
    await publishPreparedGitObjects(prepared, api, observations, expected);
    // Revalidate current local state and both immutable receipts before the
    // existing transport performs its own remote preimage/atomic CAS/readback.
    await exportCoordinatorCheckpoint(repository, expected);
    const published = options.publishCheckpoint
      ? await options.publishCheckpoint(expected)
      : await publishCoordinatorCheckpoint(repository, expected, config, { api });
    return {
      checkpoint: expected,
      prepared_commit: prepared.prepared_commit,
      prepared_tree: prepared.prepared_tree,
      objects: observations,
      published,
      authority: "none",
    };
  } catch (error) {
    throw new CoordinatorRemoteError(
      "prepared application custody stopped; retain exact local allocation and reconcile",
      {
        checkpoint: expected,
        prepared_commit: prepared.prepared_commit,
        prepared_tree: prepared.prepared_tree,
        objects: observations,
        cause:
          error instanceof CoordinatorRemoteError ? error.evidence : sanitizeOperationError(error),
        retry: "forbidden",
        authority: "none",
      },
    );
  }
}

/** Bounded inert Git-object transport shared by native Releases and the retained
 * coordinator. It never creates a ref, release, journal, or execution grant. */
async function publishPreparedGitObjects(
  prepared: ReturnType<typeof exportPreparedReleaseVersion>,
  api: Pick<CoordinatorCheckpointApi, "request">,
  observations: { kind: string; oid: string; mutation_error: unknown }[],
  expected: string | null,
) {
  const started = performance.now();
  let requests = 0;
  const request = async (
    method: "GET" | "POST",
    endpoint: string,
    body?: unknown,
    collecting = false,
  ) => {
    if (++requests > 32 || performance.now() - started > (collecting ? 150000 : 120000))
      throw new Error("prepared object request or duration bound exceeded");
    const result = await api.request(
      method,
      endpoint ? `${base}/${endpoint}` : base,
      body === undefined ? undefined : structuredClone(body),
    );
    if (performance.now() - started > (collecting ? 150000 : 120000))
      throw new Error("prepared object response was late");
    return result;
  };
  const inspectCommit = (value: unknown) =>
    inspectRemoteCommitObject(value, prepared.prepared_commit, Buffer.from(prepared.raw_commit));
  const post = async (
    kind: "blobs" | "trees" | "commits",
    body: unknown,
    oid: string,
    validate: (value: unknown) => void,
  ) => {
    let mutationError: unknown = null;
    try {
      const reply = await request("POST", `git/${kind}`, body);
      if (reply.status !== 201) throw new Error("prepared object creation unavailable");
      if (!isRecord(reply.body) || reply.body.sha !== oid)
        throw new CoordinatorRemoteError("prepared object OID differs", {
          expected: oid,
          observed: isRecord(reply.body) ? reply.body.sha : null,
        });
    } catch (error) {
      if (error instanceof CoordinatorRemoteError) throw error;
      mutationError = sanitizeOperationError(error);
      try {
        const readback = await request("GET", `git/${kind}/${oid}`, undefined, true);
        if (readback.status !== 200) throw new Error("prepared object readback unavailable");
        validate(readback.body);
      } catch (readbackError) {
        throw new CoordinatorRemoteError(
          "prepared object outcome unknown; no automatic retry or ref write",
          {
            checkpoint: expected,
            kind,
            oid,
            observations,
            mutation_error: mutationError,
            readback_error: sanitizeOperationError(readbackError),
          },
        );
      }
    }
    observations.push({ kind, oid, mutation_error: mutationError });
  };
  const identity = await request("GET", "");
  if (
    identity.status !== 200 ||
    !isRecord(identity.body) ||
    identity.body.id !== 1354613114 ||
    identity.body.full_name !== "boburning/portcove"
  )
    throw new Error("prepared transport repository identity differs");
  const source = await request("GET", `git/commits/${prepared.source_commit}`);
  if (
    source.status !== 200 ||
    !isRecord(source.body) ||
    source.body.sha !== prepared.source_commit ||
    !isRecord(source.body.tree) ||
    source.body.tree.sha !== prepared.source_tree
  )
    throw new Error("exact source commit/tree must already exist remotely");
  const existing = await request("GET", `git/commits/${prepared.prepared_commit}`);
  if (existing.status === 200) inspectCommit(existing.body);
  else {
    if (existing.status !== 404) throw new Error("prepared commit availability unknown");
    for (const blob of prepared.blobs)
      await post("blobs", { encoding: "base64", content: blob.contents }, blob.oid, (value) => {
        if (
          !isRecord(value) ||
          value.sha !== blob.oid ||
          value.encoding !== "base64" ||
          typeof value.content !== "string" ||
          value.content.replaceAll("\n", "") !== blob.contents
        )
          throw new Error("prepared blob readback differs");
      });
    await post(
      "trees",
      {
        base_tree: prepared.source_tree,
        tree: prepared.blobs.map((blob) => ({
          path: blob.path,
          mode: "100644",
          type: "blob",
          sha: blob.oid,
        })),
      },
      prepared.prepared_tree,
      (value) => {
        if (!isRecord(value) || value.sha !== prepared.prepared_tree)
          throw new Error("prepared tree readback differs");
      },
    );
    await post("commits", prepared.commit, prepared.prepared_commit, inspectCommit);
    const readback = await request("GET", `git/commits/${prepared.prepared_commit}`);
    if (readback.status !== 200) throw new Error("prepared commit fresh readback unavailable");
    inspectCommit(readback.body);
  }
}

/** The fixed native source job supplies its fresh authority checks. Export
 * authenticates the existing mechanical transform from inert local objects; no
 * checkout, hooks, allocator, ref mutation or coordinator initialization occurs. */
export async function publishPreparedReleaseObjects(
  repository: string,
  candidate: Parameters<typeof exportPreparedReleaseVersion>[1],
  options: { api: Pick<CoordinatorCheckpointApi, "request">; beforeWrite: () => Promise<void> },
) {
  await options.beforeWrite();
  const prepared = exportPreparedReleaseVersion(repository, candidate);
  const observations: { kind: string; oid: string; mutation_error: unknown }[] = [];
  try {
    await publishPreparedGitObjects(prepared, options.api, observations, null);
    return {
      prepared_commit: prepared.prepared_commit,
      prepared_tree: prepared.prepared_tree,
      objects: observations,
      authority: "none" as const,
    };
  } catch (error) {
    throw new CoordinatorRemoteError(
      "prepared native release objects stopped; retain exact allocation and reconcile",
      {
        prepared_commit: prepared.prepared_commit,
        prepared_tree: prepared.prepared_tree,
        objects: observations,
        retry: "forbidden",
        authority: "none",
        cause:
          error instanceof CoordinatorRemoteError ? error.evidence : sanitizeOperationError(error),
      },
    );
  }
}
