import { spawnSync } from "node:child_process";
import { lstatSync, mkdtempSync, realpathSync } from "node:fs";
import path from "node:path";
import { createGitHubRunner, GitHubApiClient } from "./github-api.mts";
import type { CoordinatorRemoteApi } from "./release-coordinator-remote.mts";
import { performance } from "node:perf_hooks";
import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { isRecord } from "./runtime-values.mts";
import { inspectCoordinatorRemoteNamespace } from "./release-coordinator-namespace.mts";
import { coordinatorCheckpointUpdates } from "./release-coordinator-checkpoint-evidence.mts";
import type { exportCoordinatorCheckpoint } from "./release-coordinator-state.mts";

/** Credential transport only. The existing remote verifier owns repository,
 * namespace, object and CAS checks; this API grants no caller/job authority.
 * Journal credentials are never borrowed from the provider GH_TOKEN/config. */
export function createCoordinatorJournalApi(
  directory: string,
  deadline?: number,
): CoordinatorRemoteApi {
  if (deadline !== undefined && !Number.isFinite(deadline))
    throw new Error("journal role phase deadline must be finite");
  const remaining = () => {
    const timeout =
      deadline === undefined ? 15000 : Math.floor(Math.min(15000, deadline - performance.now()));
    if (!Number.isFinite(timeout) || timeout < 1)
      throw new Error("journal role phase deadline exhausted");
    return timeout;
  };
  remaining();
  const token = process.env.PORTCOVE_COORDINATOR_JOURNAL_TOKEN;
  return isolatedJournalClient(directory, token, remaining, remaining);
}

/** Transport preparation for the selected fixed-job path. This grants no job,
 * history, protection or setup authority; the owning private executor must
 * establish those before calling the existing signing exchange. Never falls
 * back to a dedicated App credential or ambient gh configuration. */
export function createCheckpointJobTokenApi(
  directory: string,
  checkpoint: Awaited<ReturnType<typeof exportCoordinatorCheckpoint>>,
  configuration: unknown,
  deadline: number,
): CoordinatorRemoteApi {
  const started = performance.now();
  if (!Number.isFinite(deadline) || deadline <= started || deadline - started > 120000)
    throw new Error("job journal requires the original bounded deadline");
  const token = process.env.GH_TOKEN;
  if (
    typeof token !== "string" ||
    token.length < 1 ||
    token.length > 16384 ||
    Array.from(token).some((c) => c.charCodeAt(0) <= 32 || c.charCodeAt(0) === 127)
  )
    throw new Error("fixed-job journal credential unavailable");
  const scope = inspectCoordinatorRemoteNamespace(configuration);
  // Freeze the validated export: caller mutations cannot change allowed refs
  // or the two independently required source/prepared commit reads.
  const frozen = structuredClone(checkpoint);
  const updates = coordinatorCheckpointUpdates(frozen, scope);
  const zero = "0".repeat(40);
  const claim = {
    name: `refs/tags/${scope}-checkpoint-intent/${frozen.previous!}`,
    beforeOid: zero,
    afterOid: frozen.checkpoint,
    force: false,
  };
  const proofRef = `refs/tags/${scope}-checkpoint-proof/${frozen.checkpoint}`;
  const names = [...updates.map((ref) => ref.name), claim.name, proofRef];
  const declarations = names.map((_, i) => `$r${i}:String!`).join(",");
  const fields = names
    .map((_, i) => `r${i}:ref(qualifiedName:$r${i}){name prefix target{__typename oid}}`)
    .join(" ");
  const initialQuery = `query(${declarations}){repository(owner:"boburning",name:"portcove"){__typename id databaseId nameWithOwner ${fields}}}`;
  const nextQuery = `query($id:ID!,${declarations}){node(id:$id){__typename ... on Repository{id databaseId nameWithOwner ${fields}}}}`;
  const mutation = "mutation($input:UpdateRefsInput!){updateRefs(input:$input){clientMutationId}}";
  const refs = Object.fromEntries(names.map((name, i) => [`r${i}`, name]));
  let nodeId: string | null = null,
    requests = 0,
    casAttempted = false;
  let requestCollecting = false;
  const remaining = () => {
    const end = deadline + (requestCollecting && casAttempted ? 30000 : 0);
    const timeout = Math.floor(Math.min(15000, end - performance.now()));
    if (timeout < 1) throw new Error("job journal original deadline exhausted");
    return timeout;
  };
  const admit = (collecting: boolean) => {
    requestCollecting = collecting;
    remaining();
    if (++requests > 16) throw new Error("job journal request bound exhausted");
  };
  // Do not discard a late acknowledgment. The exchange records it, refuses
  // execution after its original deadline and decides whether readback resolves
  // the effect. Only its exact tuple query may use collection time.
  const api = isolatedJournalClient(directory, token, remaining);
  return {
    request(method, endpoint, body) {
      const read =
        method === "GET" &&
        body === undefined &&
        frozen.required_commits.some(
          (value) => endpoint === `repos/boburning/portcove/git/commits/${value.oid}`,
        );
      const write =
        method === "POST" &&
        /^repos\/boburning\/portcove\/git\/(?:blobs|trees|commits)$/u.test(endpoint);
      if (!read && !write) throw new Error("job journal route outside exact checkpoint exchange");
      if (write) {
        const encoded = JSON.stringify(body);
        if (typeof encoded !== "string" || Buffer.byteLength(encoded) > 2 * 1024 * 1024)
          throw new Error("job journal object request exceeds bounded encoding");
      }
      admit(false);
      return api.request(method, endpoint, body);
    },
    graphql(query, variables) {
      const initial =
        query === initialQuery && nodeId === null && isDeepStrictEqual(variables, refs);
      const snapshot =
        query === nextQuery &&
        nodeId !== null &&
        isDeepStrictEqual(variables, { id: nodeId, ...refs });
      if (initial || snapshot) {
        admit(snapshot);
        const result = api.graphql(query, variables);
        const node = isRecord(result.data) ? result.data[initial ? "repository" : "node"] : null;
        if (
          !isRecord(node) ||
          node.__typename !== "Repository" ||
          node.databaseId !== 1354613114 ||
          node.nameWithOwner !== "boburning/portcove" ||
          typeof node.id !== "string" ||
          node.id.length < 1 ||
          node.id.length > 128 ||
          (nodeId !== null && node.id !== nodeId)
        )
          throw new Error("job journal repository identity differs");
        nodeId = node.id;
        return result;
      }
      if (
        query !== mutation ||
        nodeId === null ||
        Object.keys(variables).join(",") !== "input" ||
        !isRecord(variables.input)
      )
        throw new Error("job journal GraphQL outside exact checkpoint exchange");
      const input = variables.input;
      if (
        Object.keys(input).sort().join(",") !== "clientMutationId,refUpdates,repositoryId" ||
        input.repositoryId !== nodeId ||
        !Array.isArray(input.refUpdates)
      )
        throw new Error("job journal mutation boundary differs");
      const claimUpdates = [{ ...updates[0]!, afterOid: frozen.previous! }, claim];
      const proof: unknown = input.refUpdates[updates.length];
      const finalUpdates =
        isRecord(proof) &&
        typeof proof.afterOid === "string" &&
        /^[a-f0-9]{40}$/u.test(proof.afterOid) &&
        proof.afterOid !== zero
          ? [
              ...updates,
              { name: proofRef, beforeOid: zero, afterOid: proof.afterOid, force: false },
              { ...claim, beforeOid: frozen.checkpoint },
            ]
          : null;
      if (
        (!isDeepStrictEqual(input.refUpdates, claimUpdates) &&
          !isDeepStrictEqual(input.refUpdates, finalUpdates)) ||
        input.clientMutationId !==
          createHash("sha256")
            .update(JSON.stringify({ nodeId, refs: input.refUpdates }))
            .digest("hex")
      )
        throw new Error(
          "job journal CAS must preserve exact state, preparation, intent and proof tuple",
        );
      admit(false);
      casAttempted = true;
      return api.graphql(query, variables);
    },
  };
}

function isolatedJournalClient(
  directory: string,
  token: unknown,
  remaining: () => number,
  afterCall?: () => number,
): CoordinatorRemoteApi {
  if (
    typeof token !== "string" ||
    token.length < 1 ||
    token.length > 16384 ||
    Array.from(token).some(
      (character) => character.charCodeAt(0) <= 32 || character.charCodeAt(0) === 127,
    )
  )
    throw new Error("dedicated coordinator journal credential unavailable");
  if (
    !path.isAbsolute(directory) ||
    !lstatSync(directory).isDirectory() ||
    lstatSync(directory).isSymbolicLink() ||
    realpathSync(directory) !== path.resolve(directory)
  )
    throw new Error("journal transport requires a private owned directory");
  const home = mkdtempSync(path.join(directory, "journal-api-"));
  const environment: NodeJS.ProcessEnv = {};
  for (const key of [
    "PATH",
    "Path",
    "SystemRoot",
    "SYSTEMROOT",
    "WINDIR",
    "windir",
    "COMSPEC",
    "PATHEXT",
  ])
    if (process.env[key] !== undefined) environment[key] = process.env[key];
  Object.assign(environment, {
    GH_TOKEN: token,
    GH_HOST: "github.com",
    GH_CONFIG_DIR: home,
    HOME: home,
    USERPROFILE: home,
    XDG_CONFIG_HOME: home,
    APPDATA: home,
    LOCALAPPDATA: home,
    GH_PROMPT_DISABLED: "1",
    GH_NO_UPDATE_NOTIFIER: "1",
    GH_NO_EXTENSION_UPDATE_NOTIFIER: "1",
    NO_COLOR: "1",
  });
  const redact = (value: string) => value.replaceAll(token, "[redacted]");
  const runner = createGitHubRunner({
    cwd: directory,
    timeoutMs: 15000,
    maxBuffer: 2 * 1024 * 1024,
    spawn(command, args, options) {
      const result = spawnSync(command, args, {
        ...options,
        timeout: remaining(),
        env: environment,
      });
      const error = result.error
        ? Object.assign(new Error("journal subprocess failed"), {
            code:
              "code" in result.error && result.error.code === "ETIMEDOUT"
                ? "ETIMEDOUT"
                : "JOURNAL_PROCESS_FAILED",
          })
        : null;
      return {
        status: result.status,
        stdout: redact(String(result.stdout ?? "")),
        stderr: redact(String(result.stderr ?? "")),
        error,
      };
    },
  });
  const api = new GitHubApiClient((args, body) => {
    remaining();
    const result = runner([...args, "--hostname", "github.com"], body);
    afterCall?.();
    return result;
  });
  return {
    request(method, endpoint, body) {
      if (
        !/^repos\/boburning\/portcove(?:\/git\/(?:blobs|trees|commits)(?:\/[a-f0-9]{40})?)?$/u.test(
          endpoint,
        ) ||
        !["GET", "POST"].includes(method) ||
        (method === "POST" &&
          !/^repos\/boburning\/portcove\/git\/(?:blobs|trees|commits)$/u.test(endpoint))
      )
        throw new Error("journal transport route is outside the fixed repository/object endpoints");
      return api.request(method, endpoint, body);
    },
    graphql(query, variables) {
      return api.graphql(query, variables);
    },
  };
}
