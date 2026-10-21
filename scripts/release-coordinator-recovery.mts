import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdtemp } from "node:fs/promises";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { createGitHubRunner, GitHubApiClient, sanitizeOperationError } from "./github-api.mts";
import type { GitHubRestReader } from "./github-api.mts";
import { CoordinatorRemoteError } from "./release-coordinator-errors.mts";
import type { CoordinatorGitObject } from "./release-coordinator-state.mts";
import { isRecord } from "./runtime-values.mts";
import { readOnlyReleaseChildEnvironment } from "./release-readonly-child-environment.mts";
import {
  withCoordinatorDeadline,
  coordinatorCommandTimeout,
  checkCoordinatorDeadline,
} from "./release-coordinator-deadline.mts";

const repository = "boburning/portcove";
const maximumResponseBytes = 256 * 1024;
const maximumObjectBytes = 128 * 1024;
const duration = 120_000;
type Spawn = NonNullable<NonNullable<Parameters<typeof createGitHubRunner>[0]>["spawn"]>;

function oid(value: unknown): asserts value is string {
  if (typeof value !== "string" || !/^[a-f0-9]{40}$/u.test(value))
    throw new Error("recovery requires exact Git object identities");
}

export function inspectRemoteGitObject(
  kind: CoordinatorGitObject["kind"],
  expected: string,
  bytes: Buffer,
) {
  oid(expected);
  if (
    bytes.length < 1 ||
    bytes.length > maximumObjectBytes ||
    createHash("sha1").update(`${kind} ${bytes.length}\0`).update(bytes).digest("hex") !== expected
  )
    throw new Error(
      "remote Git object bytes are unsupported, oversized or differ from their identity",
    );
  return { kind, oid: expected, bytes } satisfies CoordinatorGitObject;
}

function utf8(value: unknown, maximum = maximumObjectBytes): string {
  if (
    typeof value !== "string" ||
    Buffer.byteLength(value) > maximum ||
    Buffer.from(value, "utf8").toString("utf8") !== value ||
    value.includes("\0")
  )
    throw new Error("unsupported remote Git text");
  return value;
}

function person(value: unknown) {
  if (!isRecord(value)) throw new Error("incomplete Git actor");
  const name = utf8(value.name, 256);
  const email = utf8(value.email, 256);
  const date = value.date;
  if (
    !name ||
    !email ||
    /[\r\n<>]/u.test(name + email) ||
    typeof date !== "string" ||
    !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/u.test(date) ||
    !Number.isSafeInteger(Date.parse(date) / 1000) ||
    new Date(date).toISOString() !== date.replace("Z", ".000Z")
  )
    throw new Error("unsupported Git actor or UTC timestamp");
  return `${name} <${email}> ${Date.parse(date) / 1000} +0000`;
}

/** REST fields alone omit arbitrary headers. Only an exact raw-object hash
 * proves that reconstruction is complete. Unsupported forms remain Unknown.
 * A signature is reconstructed for byte identity, never treated as authority.
 */
export function inspectRemoteCommitObject(value: unknown, expected: string, exactBytes?: Buffer) {
  if (!isRecord(value) || value.sha !== expected || !isRecord(value.tree))
    throw new Error("remote commit identity differs");
  oid(value.tree.sha);
  if (!Array.isArray(value.parents) || value.parents.length > 16)
    throw new Error("remote commit parent count exceeds its bound");
  const parents = value.parents.map((entry: unknown) => {
    if (!isRecord(entry)) throw new Error("incomplete remote parent");
    oid(entry.sha);
    return entry.sha;
  });
  const message = utf8(value.message, 64 * 1024);
  const header = `tree ${value.tree.sha}\n${parents.map((parent) => `parent ${parent}\n`).join("")}author ${person(value.author)}\ncommitter ${person(value.committer)}`;
  const unsigned = `${header}\n\n${message}`;
  const verification = value.verification;
  if (exactBytes !== undefined) {
    const checked = inspectRemoteGitObject("commit", expected, exactBytes);
    const text = exactBytes.toString("utf8");
    const boundary = text.indexOf("\n\n");
    const lines = text.slice(0, boundary).split("\n");
    const leading = [`tree ${value.tree.sha}`, ...parents.map((parent) => `parent ${parent}`)];
    const actor = (line: string | undefined, role: string, raw: unknown) => {
      const prefix = `${role} ${person(raw).slice(0, -6)} `;
      return (
        typeof line === "string" &&
        line.startsWith(prefix) &&
        /^[+-](?:0[0-9]|1[0-4])[0-5][0-9]$/u.test(line.slice(prefix.length))
      );
    };
    const extra = lines.slice(leading.length + 2);
    const rawMessage = text.slice(boundary + 2);
    if (
      !Buffer.from(text).equals(exactBytes) ||
      text.includes("\0") ||
      boundary < 0 ||
      text.slice(0, boundary).includes("\r") ||
      // REST omits the single terminal LF on observed unsigned commits. Never
      // rewrite raw history: its exact Git hash selects the retained bytes.
      (rawMessage !== message && rawMessage !== `${message}\n`) ||
      leading.some((line, index) => lines[index] !== line) ||
      !actor(lines[leading.length], "author", value.author) ||
      !actor(lines[leading.length + 1], "committer", value.committer) ||
      (extra.length > 0 &&
        (!extra[0]!.startsWith("gpgsig ") || extra.slice(1).some((line) => !line.startsWith(" "))))
    )
      throw new Error(
        `exact Git commit ${expected} bytes disagree with provider metadata or supported headers`,
      );
    return { object: checked, tree: value.tree.sha, parents };
  }
  let raw = unsigned;
  if (isRecord(verification) && (verification.payload != null || verification.signature != null)) {
    const payload = utf8(verification.payload, 96 * 1024);
    const signature = utf8(verification.signature, 16 * 1024);
    const boundary = payload.indexOf("\n\n");
    const lines = payload.slice(0, boundary).split("\n");
    const leading = [`tree ${value.tree.sha}`, ...parents.map((parent) => `parent ${parent}`)];
    const actorMatches = (line: string | undefined, role: string, actor: unknown) => {
      // REST dates are normalized to UTC; the signed payload preserves Git's
      // original offset. Epoch seconds and actor identity must still match.
      const prefix = `${role} ${person(actor).slice(0, -6)} `;
      return (
        typeof line === "string" &&
        line.startsWith(prefix) &&
        /^[+-](?:0[0-9]|1[0-4])[0-5][0-9]$/u.test(line.slice(prefix.length))
      );
    };
    if (
      boundary < 0 ||
      lines.length !== leading.length + 2 ||
      leading.some((line, index) => lines[index] !== line) ||
      !actorMatches(lines[leading.length], "author", value.author) ||
      !actorMatches(lines[leading.length + 1], "committer", value.committer) ||
      payload.slice(boundary + 2) !== message ||
      !signature ||
      signature.includes("\r")
    )
      throw new Error("unsupported signed Git commit payload");
    // GitHub may expose a terminal signature newline that corresponds to an
    // empty continuation line. Support only these two bounded encodings; the
    // exact raw-object hash, never the verification boolean, chooses one.
    for (const form of new Set([signature.replace(/\n$/u, ""), signature])) {
      raw = `${payload.slice(0, boundary)}\ngpgsig ${form.replaceAll("\n", "\n ")}\n\n${message}`;
      try {
        return {
          object: inspectRemoteGitObject("commit", expected, Buffer.from(raw)),
          tree: value.tree.sha,
          parents,
        };
      } catch {
        // No mutation or transport occurs here. An unmatched encoding remains
        // unsupported; do not drop headers or trust a provider's valid marker.
      }
    }
    throw new Error("remote signed Git commit bytes are unsupported or differ from their identity");
  }
  return {
    object: inspectRemoteGitObject("commit", expected, Buffer.from(raw)),
    tree: value.tree.sha,
    parents,
  };
}

/** Hydrate only a raw operation receipt explicitly named by the current
 * journal's compact summary. No refs, history traversal or provider mutation. */
export async function hydrateRetainedCoordinatorOperation(
  repository: string,
  proof: unknown,
  options: { api?: GitHubRestReader } = {},
) {
  if (!isRecord(proof) || Object.keys(proof).sort().join(",") !== "checkpoint,id,operation_sha256")
    throw new Error("retained operation proof schema differs");
  oid(proof.checkpoint);
  if (
    typeof proof.id !== "string" ||
    !/^[a-f0-9]{64}$/u.test(proof.id) ||
    typeof proof.operation_sha256 !== "string" ||
    !/^[a-f0-9]{64}$/u.test(proof.operation_sha256)
  )
    throw new Error("retained operation proof identity differs");
  await hydrateRetainedCoordinatorCheckpoint(repository, proof.checkpoint, options);
  const { readRetainedCapacityOperation } = await import("./release-coordinator-state.mts");
  return readRetainedCapacityOperation(repository, proof);
}

/** Exactly three inert Git objects from an explicitly authenticated historical
 * checkpoint. No refs, ancestry walk, lazy fetch or current-state authority. */
export async function hydrateRetainedCoordinatorCheckpoint(
  repository: string,
  checkpoint: unknown,
  options: { api?: GitHubRestReader } = {},
) {
  oid(checkpoint);
  const api =
    options.api ??
    new GitHubApiClient((args, input) =>
      createGitHubRunner({
        cwd: repository,
        maxBuffer: 256 * 1024,
        timeoutMs: coordinatorCommandTimeout(15000),
      })([...args, "--hostname", "github.com"], input),
    );
  const get = (suffix: string) => {
    const result = api.request("GET", `repos/boburning/portcove/${suffix}`);
    if (result.status !== 200) throw new Error("retained operation unavailable");
    return result.body;
  };
  const commit = inspectRemoteCommitObject(get(`git/commits/${checkpoint}`), checkpoint);
  const raw = get(`git/trees/${commit.tree}`);
  if (
    !isRecord(raw) ||
    raw.sha !== commit.tree ||
    raw.truncated !== false ||
    !Array.isArray(raw.tree) ||
    raw.tree.length !== 1
  )
    throw new Error("retained checkpoint tree differs");
  const entry: unknown = raw.tree[0];
  if (
    !isRecord(entry) ||
    entry.path !== "state.json" ||
    entry.mode !== "100644" ||
    entry.type !== "blob"
  )
    throw new Error("retained checkpoint member differs");
  oid(entry.sha);
  const tree = inspectRemoteGitObject(
    "tree",
    commit.tree,
    Buffer.concat([Buffer.from("100644 state.json\0"), Buffer.from(entry.sha, "hex")]),
  );
  const blobRaw = get(`git/blobs/${entry.sha}`);
  if (
    !isRecord(blobRaw) ||
    blobRaw.sha !== entry.sha ||
    blobRaw.encoding !== "base64" ||
    typeof blobRaw.size !== "number" ||
    !Number.isSafeInteger(blobRaw.size) ||
    blobRaw.size < 1 ||
    blobRaw.size > 65536 ||
    typeof blobRaw.content !== "string" ||
    blobRaw.content.length > 90 * 1024
  )
    throw new Error("retained checkpoint payload exceeds bound");
  const bytes = Buffer.from(blobRaw.content, "base64");
  if (bytes.length !== blobRaw.size) throw new Error("retained checkpoint payload differs");
  const blob = inspectRemoteGitObject("blob", entry.sha, bytes);
  const env = {
    PATH: process.env.PATH,
    SystemRoot: process.env.SystemRoot,
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: process.platform === "win32" ? "NUL" : "/dev/null",
    GIT_NO_LAZY_FETCH: "1",
    GIT_NO_REPLACE_OBJECTS: "1",
    GIT_CONFIG_COUNT: "1",
    GIT_CONFIG_KEY_0: "core.hooksPath",
    GIT_CONFIG_VALUE_0: process.platform === "win32" ? "NUL" : "/dev/null",
  };
  for (const object of [commit.object, tree, blob]) {
    const id = execFileSync("git", ["hash-object", "-w", "-t", object.kind, "--stdin"], {
      cwd: repository,
      env,
      input: object.bytes,
      encoding: "utf8",
      timeout: coordinatorCommandTimeout(),
      maxBuffer: 128 * 1024,
      windowsHide: true,
    }).trim();
    checkCoordinatorDeadline();
    if (id !== object.oid) throw new Error("retained checkpoint import differs");
  }
  const { readRetainedCoordinatorCheckpoint } = await import("./release-coordinator-state.mts");
  return readRetainedCoordinatorCheckpoint(repository, checkpoint);
}

/** Read the minimum raw recovery closure without Git writes, planner imports,
 * source checkout or a complete allocation inventory. The admitted caller
 * supplies separately ratified namespace configuration and a fixed transport.
 */
export async function readRemoteCoordinatorSnapshot(
  _parentDirectory: string,
  configuration: unknown,
  options: { transport?: { cwd: string; spawn?: Spawn; deadline?: number } } = {},
) {
  if (
    !isRecord(configuration) ||
    Object.keys(configuration).sort().join(",") !== "namespace,schema_version" ||
    configuration.schema_version !== 1 ||
    typeof configuration.namespace !== "string" ||
    !/^portcove-[a-z0-9]+(?:-[a-z0-9]+){0,5}$/u.test(configuration.namespace) ||
    configuration.namespace.length > 64
  )
    throw new Error("recovery requires separately ratified destination configuration");
  if (!options.transport) throw new Error("remote recovery transport is unconfigured");
  const deadline = options.transport.deadline;
  if (deadline !== undefined && (!Number.isFinite(deadline) || deadline <= performance.now()))
    throw new Error("remote recovery phase deadline exhausted");
  const remaining = () => {
    const timeoutMs =
      deadline === undefined ? 15000 : Math.floor(Math.min(15000, deadline - performance.now()));
    if (timeoutMs < 1) throw new Error("remote recovery phase deadline exhausted");
    return timeoutMs;
  };
  const transport = options.transport;
  const api = new GitHubApiClient((args, input) =>
    createGitHubRunner({ ...transport, maxBuffer: maximumResponseBytes, timeoutMs: remaining() })(
      [...args, "--hostname", "github.com"],
      input,
    ),
  );
  const started = performance.now();
  let requests = 0;
  const get = (endpoint: string) => {
    if (++requests > 20 || performance.now() - started > duration)
      throw new Error("remote recovery request or duration bound exhausted");
    const response = api.request("GET", `repos/${repository}${endpoint}`);
    if (
      response.status !== 200 ||
      performance.now() - started > duration ||
      (deadline !== undefined && performance.now() >= deadline)
    )
      throw new Error("remote recovery response unavailable or late");
    return response.body;
  };
  const identity = get("");
  if (
    !isRecord(identity) ||
    identity.id !== 1354613114 ||
    identity.full_name !== repository ||
    typeof identity.node_id !== "string" ||
    !identity.node_id ||
    identity.node_id.length > 128
  )
    throw new Error("remote recovery repository identity differs");
  const scope = configuration.namespace;
  const stateRef = `refs/heads/${scope}-coordinator-state`;
  const readRef = (ref: string) => {
    if (++requests > 20 || performance.now() - started > duration)
      throw new Error("remote recovery request or duration bound exhausted");
    const response = api.graphql(
      "query($id:ID!,$ref:String!){node(id:$id){__typename ... on Repository{id databaseId nameWithOwner ref(qualifiedName:$ref){name prefix target{__typename oid}}}}}",
      { id: identity.node_id, ref },
    );
    const node = isRecord(response.data) ? response.data.node : null;
    if (
      performance.now() - started > duration ||
      !isRecord(node) ||
      node.__typename !== "Repository" ||
      node.id !== identity.node_id ||
      node.databaseId !== 1354613114 ||
      node.nameWithOwner !== repository
    )
      throw new Error("remote recovery ref repository identity differs");
    const value = node.ref;
    if (
      !isRecord(value) ||
      `${String(value.prefix)}${String(value.name)}` !== ref ||
      !isRecord(value.target) ||
      value.target.__typename !== "Commit"
    )
      throw new Error("remote recovery ref is missing, incomplete or not a commit");
    oid(value.target.oid);
    return value.target.oid;
  };
  const expected = readRef(stateRef);
  const objects = new Map<string, CoordinatorGitObject>();
  const add = (object: CoordinatorGitObject) => {
    const old = objects.get(object.oid);
    if (old && (old.kind !== object.kind || !Buffer.from(old.bytes).equals(object.bytes)))
      throw new Error("remote recovery object collision");
    objects.set(object.oid, object);
  };
  const commit = (id: string) => {
    const result = inspectRemoteCommitObject(get(`/git/commits/${id}`), id);
    add(result.object);
    return result;
  };
  const checkpoint = (id: string) => {
    const result = commit(id);
    const tree = get(`/git/trees/${result.tree}`);
    if (
      !isRecord(tree) ||
      tree.sha !== result.tree ||
      tree.truncated !== false ||
      !Array.isArray(tree.tree) ||
      tree.tree.length !== 1
    )
      throw new Error("checkpoint requires one complete inert tree");
    const entry: unknown = tree.tree[0];
    if (
      !isRecord(entry) ||
      entry.path !== "state.json" ||
      entry.mode !== "100644" ||
      entry.type !== "blob"
    )
      throw new Error("checkpoint tree is not inert state.json");
    oid(entry.sha);
    add(
      inspectRemoteGitObject(
        "tree",
        result.tree,
        Buffer.concat([Buffer.from("100644 state.json\0"), Buffer.from(entry.sha, "hex")]),
      ),
    );
    const blob = get(`/git/blobs/${entry.sha}`);
    if (
      !isRecord(blob) ||
      blob.sha !== entry.sha ||
      blob.encoding !== "base64" ||
      !Number.isSafeInteger(blob.size) ||
      typeof blob.size !== "number" ||
      blob.size < 1 ||
      blob.size > 64 * 1024
    )
      throw new Error("checkpoint blob is unavailable or oversized");
    const encoded = utf8(blob.content).replaceAll("\n", "");
    const bytes = Buffer.from(encoded, "base64");
    if (
      bytes.toString("base64") !== encoded ||
      bytes.length !== blob.size ||
      Buffer.from(bytes.toString("utf8")).compare(bytes) !== 0
    )
      throw new Error("checkpoint blob encoding differs");
    add(inspectRemoteGitObject("blob", entry.sha, bytes));
    const input: unknown = JSON.parse(bytes.toString("utf8"));
    if (!isRecord(input) || !isRecord(input.input)) throw new Error("incomplete checkpoint");
    const previous = input.previous;
    if (previous !== null) oid(previous);
    // Both checkpoint commits use the journal's fixed canonical metadata.
    const fixed = `tree ${result.tree}\n${previous === null ? "" : `parent ${previous}\n`}author Portcove release coordinator <coordinator@portcove.invalid> 946684800 +0000\ncommitter Portcove release coordinator <coordinator@portcove.invalid> 946684800 +0000\n\nPortcove release coordinator checkpoint\n`;
    if (!Buffer.from(fixed).equals(result.object.bytes))
      throw new Error("checkpoint fixed metadata differs");
    return { previous, input: input.input };
  };
  const current = checkpoint(expected);
  const previous = current.previous === null ? null : checkpoint(current.previous);
  const candidate = current.input.active_candidate ?? previous?.input.active_candidate;
  const refs = [stateRef];
  const expectedRefs = [expected];
  if (candidate != null) {
    if (
      !isRecord(candidate) ||
      typeof candidate.version !== "string" ||
      !/^[0-9A-Za-z.+-]+$/u.test(candidate.version)
    )
      throw new Error("incomplete remote reservation");
    oid(candidate.source_commit);
    oid(candidate.prepared_commit);
    commit(candidate.source_commit);
    commit(candidate.prepared_commit);
    refs.push(
      `refs/tags/${scope}-prepared/v${candidate.version}`,
      `refs/tags/${scope}-prepared-source/${candidate.source_commit}`,
    );
    expectedRefs.push(candidate.prepared_commit, candidate.prepared_commit);
  }
  // Bracket the complete state and paired receipts. Incomplete or changed
  // observations create no local repository and never admit recovered state.
  for (let observation = 0; observation < 2; observation++) {
    if (refs.some((ref, index) => readRef(ref) !== expectedRefs[index]))
      throw new Error("remote recovery snapshot changed or receipt pair differs");
  }
  return {
    checkpoint: expected,
    input: current.input,
    previous: current.previous,
    objects: [...objects.values()],
    requests,
    readiness: "raw-snapshot-only" as const,
    qualification:
      "Raw Git identity and ref association only; no planner or preparation acceptance",
  };
}

/** Full unprivileged recovery validates the snapshot with the existing planner
 * and preparation contracts. Snapshot readers need no installed dependencies. */
export async function recoverRemoteCoordinator(
  parentDirectory: string,
  configuration: unknown,
  options: Parameters<typeof readRemoteCoordinatorSnapshot>[2] = {},
) {
  const captured = {
    ...options,
    ...(options.transport ? { transport: { ...options.transport } } : {}),
  };
  const work = () => recoverRemoteCoordinatorWithinScope(parentDirectory, configuration, captured);
  return captured.transport?.deadline === undefined
    ? work()
    : withCoordinatorDeadline(captured.transport.deadline, work);
}

async function recoverRemoteCoordinatorWithinScope(
  parentDirectory: string,
  configuration: unknown,
  options: Parameters<typeof readRemoteCoordinatorSnapshot>[2] = {},
) {
  const snapshot = await readRemoteCoordinatorSnapshot(parentDirectory, configuration, options);
  const localRepository = await mkdtemp(
    path.join(path.resolve(parentDirectory), "coordinator-recovery-"),
  );
  let phase = "initialize-bare";
  try {
    const env = Object.fromEntries(
      Object.entries(readOnlyReleaseChildEnvironment() ?? process.env).filter(
        ([key]) => !key.startsWith("GIT_"),
      ),
    );
    execFileSync(
      "git",
      [
        "-c",
        `core.hooksPath=${process.platform === "win32" ? "NUL" : "/dev/null"}`,
        "init",
        "--bare",
        "--template=",
        "--quiet",
        localRepository,
      ],
      {
        env,
        timeout: coordinatorCommandTimeout(),
        maxBuffer: 128 * 1024,
        windowsHide: true,
      },
    );
    checkCoordinatorDeadline();
    phase = "validate-and-import";
    const { importCoordinatorCheckpoint } = await import("./release-coordinator-state.mts");
    const state = await importCoordinatorCheckpoint(
      localRepository,
      snapshot.checkpoint,
      snapshot.objects,
    );
    checkCoordinatorDeadline();
    return {
      ...state,
      repository: localRepository,
      readiness: "recovery-only" as const,
      complete_allocation_history: false as const,
      application_checkout_available: false as const,
      requests: snapshot.requests,
    };
  } catch (error) {
    throw new CoordinatorRemoteError("recovery failed; retain the owned partial repository", {
      repository: localRepository,
      checkpoint: snapshot.checkpoint,
      phase,
      requests: snapshot.requests,
      error: sanitizeOperationError(error),
    });
  }
}
