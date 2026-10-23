/** Two-stage transport in the EXISTING coordinator journal. No CLI, credential
 * discovery, history ratification or activation. The trusted owning controller
 * must authenticate its actual session, ratified predecessor/setup and current
 * controls in refresh; a callback/public ref cannot appoint that authority. */
import { createHash } from "node:crypto";
import { performance } from "node:perf_hooks";
import { exportCoordinatorCheckpoint } from "./release-coordinator-state.mts";
import { inspectCoordinatorRemoteNamespace } from "./release-coordinator-namespace.mts";
import {
  coordinatorCheckpointUpdates,
  inspectCoordinatorCheckpointEvidence,
} from "./release-coordinator-checkpoint-evidence.mts";
import type { CoordinatorRefUpdate } from "./release-coordinator-checkpoint-evidence.mts";
import {
  requireAuthenticatedCheckpointEvidence,
  authenticateCoordinatorCheckpointEvidence,
} from "./release-coordinator-checkpoint-authentication.mts";
import type {
  AuthenticatedCheckpointEvidence,
  CheckpointProducerExpectation,
} from "./release-coordinator-checkpoint-authentication.mts";
import { signCoordinatorCheckpointEvidence } from "./release-coordinator-checkpoint-signing.mts";
import type { CapacityExecutorRole } from "./assembler-job-identity.mts";
import type { CoordinatorRemoteApi } from "./release-coordinator-remote.mts";
import { CoordinatorRemoteError } from "./release-coordinator-errors.mts";
import { sanitizeOperationError } from "./github-api.mts";
import { isRecord } from "./runtime-values.mts";
import { withCoordinatorDeadline } from "./release-coordinator-deadline.mts";

type Checkpoint = Awaited<ReturnType<typeof exportCoordinatorCheckpoint>>;
type Stage = "claim" | "fulcio" | "rekor" | "commit";
const repository = "boburning/portcove",
  repositoryId = 1354613114,
  zero = "0".repeat(40);

/** The sole production composition uses the existing signer AND verifier. The
 * transport helper below accepts a producer only as a trusted code seam; it
 * never accepts raw/imported evidence as authenticated proof. */
export async function signAndPublishCoordinatorCheckpoint(
  directory: string,
  localRepository: string,
  expected: string,
  configuration: unknown,
  expectedProducer: { role: CapacityExecutorRole; producer: CheckpointProducerExpectation },
  deadline: number,
  options: { api: CoordinatorRemoteApi; refresh: (stage: Stage) => Promise<void> },
) {
  const producer = structuredClone(expectedProducer);
  return publishCoordinatorSigningExchange(localRepository, expected, configuration, deadline, {
    ...options,
    async produce(checkpoint, frozen, beforePost) {
      const signed = await signCoordinatorCheckpointEvidence(
        directory,
        checkpoint,
        frozen,
        producer,
        deadline,
        { beforePost },
      );
      return authenticateCoordinatorCheckpointEvidence(
        directory,
        checkpoint,
        frozen,
        signed.evidence,
        producer,
        deadline,
      );
    },
  });
}

export async function publishCoordinatorSigningExchange(
  localRepository: string,
  expected: string,
  rawConfiguration: unknown,
  deadline: number,
  options: {
    api: CoordinatorRemoteApi;
    refresh: (stage: Stage) => Promise<void>;
    produce: (
      checkpoint: Checkpoint,
      configuration: unknown,
      beforePost: (stage: "fulcio" | "rekor") => Promise<void>,
    ) => Promise<AuthenticatedCheckpointEvidence>;
  },
) {
  const configuration: unknown = structuredClone(rawConfiguration),
    scope = inspectCoordinatorRemoteNamespace(configuration),
    { api: transport, refresh, produce } = options;
  const api = {
    request: transport.request.bind(transport),
    graphql: transport.graphql.bind(transport),
  };
  if (
    !Number.isFinite(deadline) ||
    deadline <= performance.now() ||
    deadline - performance.now() > 120000
  )
    throw new Error("signing exchange requires the original bounded deadline");
  const active = (collecting = false) => {
    if (performance.now() >= deadline + (collecting ? 30000 : 0))
      throw new Error("signing exchange original deadline exhausted");
  };
  const checkpoint = await withCoordinatorDeadline(deadline, () =>
    exportCoordinatorCheckpoint(localRepository, expected),
  );
  active();
  const updates = coordinatorCheckpointUpdates(checkpoint, scope);
  const claim: CoordinatorRefUpdate = {
    name: `refs/tags/${scope}-checkpoint-intent/${checkpoint.previous!}`,
    beforeOid: zero,
    afterOid: expected,
    force: false,
  };
  const proofRef = `refs/tags/${scope}-checkpoint-proof/${expected}`;
  const names = [...updates.map((ref) => ref.name), claim.name, proofRef];
  let requests = 0,
    nodeId = "",
    phase = "preimage",
    attempted = false;
  const objects: {
    kind: string;
    expected: string;
    observed: string | null;
    status: number | null;
  }[] = [];
  const budget = (collecting = false) => {
    active(collecting);
    if (++requests > 16) throw new Error("signing exchange request bound exhausted");
  };
  const snapshot = (initial = false, collecting = false) => {
    budget(collecting);
    const declarations = names.map((_, i) => `$r${i}:String!`).join(",");
    const fields = names
      .map((_, i) => `r${i}:ref(qualifiedName:$r${i}){name prefix target{__typename oid}}`)
      .join(" ");
    const refs = Object.fromEntries(names.map((name, i) => [`r${i}`, name]));
    const result = api.graphql(
      initial
        ? `query(${declarations}){repository(owner:"boburning",name:"portcove"){__typename id databaseId nameWithOwner ${fields}}}`
        : `query($id:ID!,${declarations}){node(id:$id){__typename ... on Repository{id databaseId nameWithOwner ${fields}}}}`,
      initial ? refs : { id: nodeId, ...refs },
    );
    active(collecting);
    const node = isRecord(result.data) ? result.data[initial ? "repository" : "node"] : null;
    if (
      !isRecord(node) ||
      node.__typename !== "Repository" ||
      node.databaseId !== repositoryId ||
      node.nameWithOwner !== repository ||
      typeof node.id !== "string" ||
      node.id.length < 1 ||
      node.id.length > 128 ||
      (!initial && node.id !== nodeId)
    )
      throw new Error("signing exchange repository identity differs");
    if (initial) nodeId = node.id;
    return names.map((name, i) => {
      if (!Object.hasOwn(node, `r${i}`))
        throw new Error("signing exchange ref inventory incomplete");
      const ref = node[`r${i}`];
      if (ref === null) return zero;
      if (
        !isRecord(ref) ||
        `${String(ref.prefix)}${String(ref.name)}` !== name ||
        !isRecord(ref.target) ||
        ref.target.__typename !== "Commit" ||
        typeof ref.target.oid !== "string" ||
        !/^[a-f0-9]{40}$/u.test(ref.target.oid) ||
        ref.target.oid === zero
      )
        throw new Error("signing exchange ref identity or object type differs");
      return ref.target.oid;
    });
  };
  const preimage = [...updates.map((ref) => ref.beforeOid), zero, zero];
  const owned = [...updates.map((ref) => ref.beforeOid), expected, zero];
  const matches = (a: readonly string[], b: readonly string[]) =>
    a.length === b.length && a.every((value, i) => value === b[i]);
  const requireSnapshot = (expectedRefs: readonly string[], initial = false) => {
    const observed = snapshot(initial);
    if (!matches(observed, expectedRefs))
      throw new CoordinatorRemoteError(
        "signing exchange preimage/owned intent changed; explicit recovery required",
        { checkpoint: expected, names, expected: expectedRefs, observed },
      );
  };
  const rest = (method: "GET" | "POST", endpoint: string, body?: unknown) => {
    budget();
    const result = api.request(method, endpoint, body);
    active();
    if (result.status !== (method === "GET" ? 200 : 201))
      throw new Error("signing exchange object request refused");
    return result.body;
  };
  const upload = (kind: string, body: unknown, oid: string) => {
    const object: (typeof objects)[number] = { kind, expected: oid, observed: null, status: null };
    // Retain the attempted object before transport; a failed response never
    // means no effect. Preserve even a late positive acknowledgment separately
    // from accepting that response inside the original execution deadline.
    objects.push(object);
    budget();
    const response = api.request("POST", `repos/${repository}/git/${kind}`, body);
    object.status = response.status ?? null;
    const value = response.body;
    object.observed =
      isRecord(value) && typeof value.sha === "string" && value.sha.length <= 64 ? value.sha : null;
    active();
    if (response.status !== 201 || object.observed !== oid)
      throw new Error("signing exchange object response refused or identity differs");
  };
  const cas = (refs: CoordinatorRefUpdate[]) => {
    budget();
    const id = createHash("sha256").update(JSON.stringify({ nodeId, refs })).digest("hex");
    const result = api.graphql(
      "mutation($input:UpdateRefsInput!){updateRefs(input:$input){clientMutationId}}",
      { input: { repositoryId: nodeId, clientMutationId: id, refUpdates: refs } },
    );
    active();
    const payload = isRecord(result.data) ? result.data.updateRefs : null;
    if (!isRecord(payload) || payload.clientMutationId !== id)
      throw new Error("signing exchange CAS acknowledgment differs or is ambiguous");
  };
  try {
    requireSnapshot(preimage, true);
    for (const required of checkpoint.required_commits) {
      const value = rest("GET", `repos/${repository}/git/commits/${required.oid}`);
      if (
        !isRecord(value) ||
        value.sha !== required.oid ||
        !isRecord(value.tree) ||
        value.tree.sha !== required.tree ||
        (required.parent !== undefined &&
          (!Array.isArray(value.parents) ||
            value.parents.length !== 1 ||
            !isRecord(value.parents[0]) ||
            value.parents[0].sha !== required.parent))
      )
        throw new Error("signing exchange source/prepared commit differs");
    }
    phase = "checkpoint-objects";
    await refresh("claim");
    active();
    upload(
      "blobs",
      { content: Buffer.from(checkpoint.blob.contents).toString("base64"), encoding: "base64" },
      checkpoint.blob.oid,
    );
    upload("trees", { tree: checkpoint.tree.entries }, checkpoint.tree.oid);
    const { oid: _oid, ...commit } = checkpoint.commit;
    upload("commits", commit, checkpoint.commit.oid);
    phase = "claim";
    await refresh("claim");
    active();
    attempted = true;
    // One slot per independently ratified predecessor, shared by competing
    // proposed checkpoints. The authoritative state head is NOT advanced.
    try {
      cas([{ ...updates[0]!, afterOid: checkpoint.previous! }, claim]);
    } catch (error) {
      let observed: string[] | null = null;
      try {
        observed = snapshot(false, true);
      } catch {
        /* original ambiguity retained */
      }
      throw new CoordinatorRemoteError(
        "signing intent claim acknowledgment ambiguous; do not sign or retry",
        { checkpoint: expected, names, observed, error: sanitizeOperationError(error) },
      );
    }
    let nextPost = 0,
      busy = false,
      stopped = false;
    let pendingGate: Promise<void> | undefined;
    const beforePost = (stage: "fulcio" | "rekor") => {
      if (busy || stopped || stage !== ["fulcio", "rekor"][nextPost]) {
        stopped = true;
        const rejected = Promise.reject<void>(
          new Error("signing intent post sequence stopped or differs"),
        );
        void rejected.catch(() => {});
        return rejected;
      }
      busy = true;
      const pending = (async () => {
        try {
          requireSnapshot(owned);
          await refresh(stage);
          active();
          if (stopped) throw new Error("signing producer returned before its gate settled");
          nextPost++;
        } catch (error) {
          stopped = true;
          throw error;
        } finally {
          busy = false;
        }
      })();
      pendingGate = pending;
      void pending.catch(() => {
        /* producer and enclosing drain retain failure */
      });
      return pending;
    };
    phase = "signing";
    let receipt: AuthenticatedCheckpointEvidence;
    try {
      receipt = await produce(
        structuredClone(checkpoint),
        structuredClone(configuration),
        beforePost,
      );
    } finally {
      stopped = true;
      await pendingGate?.catch(() => {});
    }
    if (nextPost !== 2 || busy) throw new Error("signing exchange provider sequence incomplete");
    active();
    const proof = () =>
      inspectCoordinatorCheckpointEvidence(
        checkpoint,
        configuration,
        requireAuthenticatedCheckpointEvidence(receipt, expected, configuration),
      );
    const evidence = proof();
    phase = "proof-objects";
    for (const object of evidence.objects) {
      proof();
      upload(object.kind, object.body, object.oid);
    }
    phase = "commit";
    requireSnapshot(owned);
    await refresh("commit");
    active();
    proof();
    let mutationError: ReturnType<typeof sanitizeOperationError> | null = null;
    try {
      cas([...updates, evidence.update, { ...claim, beforeOid: expected }]);
    } catch (error) {
      mutationError = sanitizeOperationError(error);
    }
    const observed = snapshot(false, true);
    const after = [...updates.map((ref) => ref.afterOid), expected, evidence.update.afterOid];
    if (!matches(observed, after))
      throw new CoordinatorRemoteError(
        "signed checkpoint outcome unresolved; explicit readback/recovery required",
        { checkpoint: expected, names, observed, expected: after, mutationError },
      );
    return {
      checkpoint: expected,
      changed: true,
      recovered: mutationError !== null,
      requests,
      updates: [...updates, evidence.update, { ...claim, beforeOid: expected }],
      observed,
      authority: "none" as const,
    };
  } catch (error) {
    throw new CoordinatorRemoteError(
      "coordinator signing exchange stopped; retain intent/objects and recover explicitly",
      {
        checkpoint: expected,
        phase,
        attempted_claim: attempted,
        names,
        objects,
        requests,
        automatic_retry: false,
        error:
          error instanceof CoordinatorRemoteError ? error.evidence : sanitizeOperationError(error),
      },
    );
  }
}
