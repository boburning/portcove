import { createHash } from "node:crypto";
import { performance } from "node:perf_hooks";
import type { IncludedResponse } from "./github-api.mts";
import { sanitizeOperationError } from "./github-api.mts";
import { exportCoordinatorCheckpoint } from "./release-coordinator-state.mts";
import { isRecord } from "./runtime-values.mts";
import { CoordinatorRemoteError } from "./release-coordinator-errors.mts";
export { CoordinatorRemoteError } from "./release-coordinator-errors.mts";

export interface CoordinatorRemoteApi {
  request(method: string, endpoint: string, body?: unknown): IncludedResponse;
  graphql(query: string, variables: Readonly<Record<string, unknown>>): { data: unknown };
}
type Export = Awaited<ReturnType<typeof exportCoordinatorCheckpoint>>;
type RefChange = { name: string; beforeOid: string; afterOid: string; force: false };
const repository = "boburning/portcove";
const repositoryId = 1354613114;
const zero = "0".repeat(40);
const maximumRequests = 16;
const executionMilliseconds = 120_000;
const collectionMilliseconds = 30_000;

function namespace(configuration: unknown): string {
  if (
    !isRecord(configuration) ||
    Object.keys(configuration).sort().join(",") !== "namespace,schema_version" ||
    configuration.schema_version !== 1 ||
    typeof configuration.namespace !== "string" ||
    !/^portcove-[a-z0-9]+(?:-[a-z0-9]+){0,5}$/u.test(configuration.namespace) ||
    configuration.namespace.length > 64
  )
    throw new Error("remote coordinator requires separately ratified destination configuration");
  return configuration.namespace;
}
export { namespace as inspectCoordinatorRemoteNamespace };

function changes(checkpoint: Export, scope: string): RefChange[] {
  if (checkpoint.previous === null)
    throw new Error("remote coordinator advancement requires an initialized previous checkpoint");
  const result: RefChange[] = [
    {
      name: `refs/heads/${scope}-coordinator-state`,
      beforeOid: checkpoint.previous,
      afterOid: checkpoint.checkpoint,
      force: false,
    },
  ];
  for (const receipt of checkpoint.receipts) {
    const version = "refs/portcove/prepared-versions/";
    const source = "refs/portcove/prepared-commits/";
    const name = receipt.local_ref.startsWith(version)
      ? `refs/tags/${scope}-prepared/${receipt.local_ref.slice(version.length)}`
      : receipt.local_ref.startsWith(source)
        ? `refs/tags/${scope}-prepared-source/${receipt.local_ref.slice(source.length)}`
        : null;
    if (
      !name ||
      receipt.oid === zero ||
      (receipt.before_oid !== zero && receipt.before_oid !== receipt.oid)
    )
      throw new Error("remote preparation receipt differs from its validated allocation");
    result.push({ name, beforeOid: receipt.before_oid, afterOid: receipt.oid, force: false });
  }
  if (
    ![1, 3].includes(result.length) ||
    new Set(result.map((ref) => ref.name)).size !== result.length
  )
    throw new Error("remote coordinator requires one complete duplicate-free receipt set");
  return result;
}

/** Persist a caller-authenticated journal, not an execution authorization.
 * Production callers must independently establish fixed controller identity,
 * protected principal/ref policy, fresh facts and ownership of the bare path.
 * There is no CLI, default destination, credential discovery or activation.
 */
export async function publishCoordinatorCheckpoint(
  localRepository: string,
  expected: string,
  configuration: unknown,
  options: { api?: CoordinatorRemoteApi } = {},
) {
  const scope = namespace(configuration);
  const api = options.api;
  if (!api) throw new Error("remote coordinator transport is unconfigured");
  const checkpoint = await exportCoordinatorCheckpoint(localRepository, expected);
  const updates = changes(checkpoint, scope);
  const started = performance.now();
  let requests = 0;
  const budget = (collecting = false) => {
    if (
      ++requests > maximumRequests ||
      performance.now() - started >
        executionMilliseconds + (collecting ? collectionMilliseconds : 0)
    )
      throw new Error("remote coordinator request or duration bound exhausted");
  };
  const rest = (method: "GET" | "POST", endpoint: string, body?: unknown) => {
    budget();
    const response = api.request(method, endpoint, body);
    if (
      response.status !== (method === "GET" ? 200 : 201) ||
      performance.now() - started > executionMilliseconds
    )
      throw new Error("remote coordinator object request was unavailable or late");
    return response.body;
  };
  const identity = rest("GET", `repos/${repository}`);
  if (
    !isRecord(identity) ||
    identity.id !== repositoryId ||
    identity.full_name !== repository ||
    typeof identity.node_id !== "string" ||
    identity.node_id.length < 1 ||
    identity.node_id.length > 128
  )
    throw new Error("remote coordinator repository identity differs");
  const nodeId = identity.node_id;
  const snapshot = (collecting = false) => {
    budget(collecting);
    const declarations = updates.map((_, index) => `$r${index}:String!`).join(",");
    const fields = updates
      .map(
        (_, index) => `r${index}:ref(qualifiedName:$r${index}){name prefix target{__typename oid}}`,
      )
      .join(" ");
    const variables = Object.fromEntries(updates.map((ref, index) => [`r${index}`, ref.name]));
    const response = api.graphql(
      `query($id:ID!,${declarations}){node(id:$id){__typename ... on Repository{id databaseId nameWithOwner ${fields}}}}`,
      { id: nodeId, ...variables },
    );
    if (
      performance.now() - started >
      executionMilliseconds + (collecting ? collectionMilliseconds : 0)
    )
      throw new Error("remote coordinator readback exceeded its duration bound");
    const node = isRecord(response.data) ? response.data.node : null;
    if (
      !isRecord(node) ||
      node.__typename !== "Repository" ||
      node.id !== nodeId ||
      node.databaseId !== repositoryId ||
      node.nameWithOwner !== repository
    )
      throw new Error("remote coordinator ref repository identity differs");
    return updates.map((ref, index) => {
      const key = `r${index}`;
      if (!Object.hasOwn(node, key)) throw new Error("remote ref response is incomplete");
      const value = node[key];
      if (value === null) return zero;
      if (
        !isRecord(value) ||
        `${String(value.prefix)}${String(value.name)}` !== ref.name ||
        !isRecord(value.target) ||
        value.target.__typename !== "Commit" ||
        typeof value.target.oid !== "string" ||
        !/^[a-f0-9]{40}$/u.test(value.target.oid) ||
        value.target.oid === zero
      )
        throw new Error("remote coordinator ref identity or object type differs");
      return value.target.oid;
    });
  };
  const matches = (observed: readonly string[], field: "beforeOid" | "afterOid") =>
    observed.length === updates.length &&
    updates.every((ref, index) => observed[index] === ref[field]);
  const before = snapshot();
  if (!matches(before, "beforeOid") && !matches(before, "afterOid"))
    throw new CoordinatorRemoteError(
      "remote coordinator preimage conflicts; retain the local candidate",
      { checkpoint: expected, updates, before },
    );

  // These application commits are not inert checkpoint objects. Require their
  // exact remote availability; never transport or execute candidate code here.
  for (const required of checkpoint.required_commits) {
    const commit = rest("GET", `repos/${repository}/git/commits/${required.oid}`);
    if (
      !isRecord(commit) ||
      commit.sha !== required.oid ||
      !isRecord(commit.tree) ||
      commit.tree.sha !== required.tree ||
      (required.parent !== undefined &&
        (!Array.isArray(commit.parents) ||
          commit.parents.length !== 1 ||
          !isRecord(commit.parents[0]) ||
          commit.parents[0].sha !== required.parent))
    )
      throw new Error("prepared/source application objects are unavailable or differ remotely");
  }
  if (matches(before, "afterOid"))
    return { checkpoint: expected, changed: false, recovered: false, updates, observed: before };

  const objects: { kind: string; expected: string; observed: string | null }[] = [];
  const upload = (kind: string, body: unknown, oid: string) => {
    let result: unknown;
    try {
      result = rest("POST", `repos/${repository}/git/${kind}`, body);
    } catch (error) {
      throw new CoordinatorRemoteError(
        "checkpoint object outcome is unknown; no ref mutation attempted",
        {
          checkpoint: expected,
          updates,
          before,
          objects,
          object: kind,
          expected: oid,
          error: sanitizeOperationError(error),
        },
      );
    }
    const observed =
      isRecord(result) && typeof result.sha === "string" && result.sha.length <= 64
        ? result.sha
        : null;
    objects.push({ kind, expected: oid, observed });
    if (observed !== oid)
      throw new CoordinatorRemoteError(
        "remote checkpoint object identity differs; no ref mutation attempted",
        { checkpoint: expected, updates, before, objects },
      );
  };
  upload(
    "blobs",
    {
      content: Buffer.from(checkpoint.blob.contents, "utf8").toString("base64"),
      encoding: "base64",
    },
    checkpoint.blob.oid,
  );
  upload("trees", { tree: checkpoint.tree.entries }, checkpoint.tree.oid);
  const { oid: _oid, ...commit } = checkpoint.commit;
  upload("commits", commit, checkpoint.commit.oid);
  const mutationId = createHash("sha256").update(JSON.stringify({ nodeId, updates })).digest("hex");
  let mutationError: ReturnType<typeof sanitizeOperationError> | null = null;
  budget();
  try {
    const response = api.graphql(
      "mutation($input:UpdateRefsInput!){updateRefs(input:$input){clientMutationId}}",
      { input: { repositoryId: nodeId, clientMutationId: mutationId, refUpdates: updates } },
    );
    const payload = isRecord(response.data) ? response.data.updateRefs : null;
    if (!isRecord(payload) || payload.clientMutationId !== mutationId)
      throw new Error("remote coordinator CAS acknowledgment differs");
  } catch (error) {
    // A failed/partial response does not establish that mutation did not happen.
    mutationError = sanitizeOperationError(error);
  }
  let after: string[];
  try {
    after = snapshot(true);
  } catch (error) {
    throw new CoordinatorRemoteError(
      "remote coordinator outcome is unknown; do not retry automatically",
      {
        checkpoint: expected,
        updates,
        before,
        mutationError,
        readbackError: sanitizeOperationError(error),
      },
    );
  }
  if (!matches(after, "afterOid"))
    throw new CoordinatorRemoteError(
      "remote coordinator outcome differs; retain all evidence without retry",
      {
        checkpoint: expected,
        updates,
        before,
        after,
        mutationError,
        observation: matches(after, "beforeOid") ? "observed-before" : "unknown-or-concurrent",
      },
    );
  return {
    checkpoint: expected,
    changed: true,
    recovered: mutationError !== null,
    updates,
    observed: after,
  };
}
