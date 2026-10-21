import { validatePublicationReportRepairTransition } from "./release-report-repair-contract.mts";
import { readOnlyReleaseChildEnvironment } from "./release-readonly-child-environment.mts";
import {
  validateCapacityTransition,
  verifyRetainedCapacityOperation,
  capacityDigest,
} from "./release-capacity.mts";
import { execFileSync, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import path from "node:path";
import {
  coordinatorCommandTimeout,
  checkCoordinatorDeadline,
} from "./release-coordinator-deadline.mts";
import { planReleaseOpportunity } from "./release-coordinator.mts";
import { isRecord } from "./runtime-values.mts";
import { validateCandidateStageTransition } from "./release-candidate-progress-contract.mts";
import { validateReleaseReviewRequestTransition } from "./release-review-request.mts";
import { parseVersionClassification } from "../apps/desktop/scripts/release-version-policy.mts";

// One coordinating Git repository, shared by its linked worktrees. This is not
// a remote allocator, an authority verifier, or permission to execute a plan.
export const coordinatorStateRef = "refs/portcove/release-coordinator-state";
const zero = "0".repeat(40);
const maximumBytes = 64 * 1024;

function identity(value: unknown): asserts value is string {
  if (typeof value !== "string" || !/^[a-f0-9]{40}$/u.test(value))
    throw new Error("coordinator checkpoint requires an exact Git identity");
}

function canonical(value: unknown): string {
  function sorted(entry: unknown): unknown {
    if (Array.isArray(entry)) return entry.map(sorted);
    if (isRecord(entry))
      return Object.fromEntries(
        Object.keys(entry)
          .sort()
          .map((key) => [key, sorted(entry[key])]),
      );
    return entry;
  }
  return JSON.stringify(sorted(value));
}

function gitRepository(repository: string) {
  const env = {
    ...Object.fromEntries(
      Object.entries(readOnlyReleaseChildEnvironment() ?? process.env).filter(
        ([key]) => !key.startsWith("GIT_"),
      ),
    ),
    GIT_NO_REPLACE_OBJECTS: "1",
    GIT_NO_LAZY_FETCH: "1",
    GIT_AUTHOR_NAME: "Portcove release coordinator",
    GIT_AUTHOR_EMAIL: "coordinator@portcove.invalid",
    GIT_COMMITTER_NAME: "Portcove release coordinator",
    GIT_COMMITTER_EMAIL: "coordinator@portcove.invalid",
    GIT_AUTHOR_DATE: "2000-01-01T00:00:00Z",
    GIT_COMMITTER_DATE: "2000-01-01T00:00:00Z",
  };
  const base = [
    "-C",
    path.resolve(repository),
    "-c",
    `core.hooksPath=${process.platform === "win32" ? "NUL" : "/dev/null"}`,
    "-c",
    "core.fsmonitor=false",
    "-c",
    "core.createObject=link",
    "-c",
    "commit.gpgSign=false",
    "-c",
    "core.filesRefLockTimeout=1000",
  ];
  const read = (args: readonly string[], input?: string | Uint8Array, preserveBytes = false) => {
    const bytes = execFileSync("git", [...base, ...args], {
      input,
      timeout: coordinatorCommandTimeout(),
      maxBuffer: maximumBytes * 2,
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"],
      env,
    });
    checkCoordinatorDeadline();
    const text = bytes.toString("utf8");
    if (!Buffer.from(text, "utf8").equals(bytes))
      throw new Error("coordinator Git output is not UTF-8");
    return preserveBytes ? text : text.trimEnd();
  };
  const transaction = (commands: string[]) =>
    new Promise<void>((resolve, reject) => {
      const child = spawn("git", [...base, "update-ref", "--no-deref", "--stdin"], {
        env,
        windowsHide: true,
        timeout: coordinatorCommandTimeout(),
        stdio: ["pipe", "pipe", "pipe"],
      });
      let output = "";
      let diagnostic = "";
      let failure: unknown;
      let prepared = false;
      child.on("error", (error) => {
        failure = error;
      });
      child.stdin.on("error", (error) => {
        failure ??= error;
      });
      child.stderr.on("data", (data: Buffer) => {
        diagnostic += data.toString("utf8");
        if (Buffer.byteLength(diagnostic) > maximumBytes) {
          failure = new Error("Git transaction output exceeds byte bound");
          child.kill();
        }
      });
      child.stdout.on("data", (data: Buffer) => {
        output += data.toString("utf8");
        if (Buffer.byteLength(output) > maximumBytes) {
          failure = new Error("Git transaction output exceeds byte bound");
          child.kill();
          return;
        }
        if (prepared || !output.includes("prepare: ok\n")) return;
        prepared = true;
        try {
          // Git now holds every state/preparation ref lock. Checking before
          // prepare would allow aliases to appear between inspection and CAS.
          const refs = commands.map((command) => command.split(" ")[1]!);
          for (const ref of refs) {
            let symbolic = true;
            try {
              // Unlike for-each-ref, this also observes dangling symbolic refs.
              read(["symbolic-ref", "--quiet", "--no-recurse", ref]);
            } catch (error) {
              if (!isRecord(error) || error.status !== 1) throw error;
              symbolic = false;
            }
            if (symbolic)
              throw new Error(
                "symbolic coordinator/preparation refs are refused under the transaction locks",
              );
          }
          checkCoordinatorDeadline();
          child.stdin.end("commit\n");
        } catch (error) {
          failure = error;
          child.stdin.end("abort\n");
        }
      });
      child.on("close", (code) => {
        if (failure) reject(failure);
        else if (code !== 0 || !output.includes("commit: ok\n"))
          reject(new Error(`Git coordinator transaction refused: ${diagnostic.slice(0, 2048)}`));
        else {
          try {
            checkCoordinatorDeadline();
            resolve();
          } catch (error) {
            reject(error);
          }
        }
      });
      child.stdin.write(`start\n${commands.join("\n")}\nprepare\n`);
    });
  return Object.assign(read, { transaction });
}
type Git = ReturnType<typeof gitRepository>;

function checkedInput(input: unknown) {
  const bytes = canonical(input);
  if (Buffer.byteLength(bytes) > maximumBytes)
    throw new Error("coordinator checkpoint exceeds byte bound");
  // Use the existing planner's complete schema, identities and recovery limits.
  const plan = planReleaseOpportunity(input);
  if (!isRecord(input)) throw new Error("coordinator input must be an object");
  const opportunity = input.opportunity;
  if (
    isRecord(opportunity) &&
    isRecord(opportunity.classification) &&
    opportunity.classification.migration_notes !== undefined &&
    typeof opportunity.classification.migration_notes !== "string"
  )
    throw new Error("coordinator checkpoint migration notes must be a string");
  return { input, plan };
}

function readCheckpoint(git: Git, commit: string) {
  identity(commit);
  if (git(["cat-file", "-t", commit]) !== "commit") throw new Error("checkpoint is not a commit");
  const header = git(["cat-file", "commit", commit]);
  const parents =
    header
      .split("\n\n", 1)[0]
      ?.split("\n")
      .filter((line) => line.startsWith("parent ")) ?? [];
  const entries = git(["ls-tree", commit]);
  if (!/^100644 blob [a-f0-9]{40}\tstate\.json$/u.test(entries))
    throw new Error("checkpoint must contain only an inert state.json blob");
  const size = Number(git(["cat-file", "-s", `${commit}:state.json`]));
  if (!Number.isSafeInteger(size) || size < 1 || size > maximumBytes)
    throw new Error("stored coordinator checkpoint exceeds byte bound");
  const raw = git(["cat-file", "blob", `${commit}:state.json`], undefined, true);
  const state: unknown = JSON.parse(raw);
  if (
    !isRecord(state) ||
    Object.keys(state).sort().join(",") !== "input,previous,schema_version" ||
    state.schema_version !== 1
  )
    throw new Error("invalid coordinator checkpoint schema");
  if (state.previous !== null) identity(state.previous);
  const expectedParents = state.previous === null ? [] : [`parent ${state.previous}`];
  if (canonical(parents) !== canonical(expectedParents) || canonical(state) !== raw)
    throw new Error("coordinator checkpoint history or canonical bytes disagree");
  const checked = checkedInput(state.input);
  if (
    state.previous === null &&
    (checked.input.review_request != null || checked.input.review_disposition != null)
  )
    throw new Error("initial coordinator cannot invent a frozen review request");
  return { previous: state.previous, ...checked };
}

/** Inspect one explicitly authenticated historical checkpoint without moving or
 * verifying the current ref. Inert state only; no recovery/admission authority. */
export function readRetainedCoordinatorCheckpoint(repository: string, checkpoint: string) {
  identity(checkpoint);
  return {
    checkpoint,
    ...readCheckpoint(gitRepository(repository), checkpoint),
    authority: "none" as const,
  };
}

/** Resolve public raw receipts referenced by a compact summary in this same
 * immutable journal. No ref mutation, ancestry walk, candidate execution or
 * lazy fetch occurs; sparse callers must explicitly hydrate this exact object.
 */
export function readRetainedCapacityOperation(repository: string, proof: unknown) {
  if (!isRecord(proof) || Object.keys(proof).sort().join(",") !== "checkpoint,id,operation_sha256")
    throw new Error("retained operation proof schema differs");
  identity(proof.checkpoint);
  if (
    typeof proof.id !== "string" ||
    !/^[a-f0-9]{64}$/u.test(proof.id) ||
    typeof proof.operation_sha256 !== "string" ||
    !/^[a-f0-9]{64}$/u.test(proof.operation_sha256)
  )
    throw new Error("retained operation proof identity invalid");
  const checkpoint = readCheckpoint(gitRepository(repository), proof.checkpoint);
  const controller = checkpoint.input.controller;
  const capacity =
    isRecord(controller) && isRecord(controller.capacity_attempt)
      ? controller.capacity_attempt
      : null;
  if (!capacity) throw new Error("original checkpoint has no raw capacity receipt");
  const retained: unknown[] = Array.isArray(capacity.prior_operations)
    ? capacity.prior_operations
    : [];
  const candidates: unknown[] = [capacity.operation, ...retained];
  const raw = candidates.find(
    (entry) =>
      isRecord(entry) &&
      !Object.hasOwn(entry, "summary_schema_version") &&
      entry.id === proof.id &&
      capacityDigest(entry) === proof.operation_sha256,
  );
  if (!raw) throw new Error("original checkpoint does not contain exact raw capacity operation");
  return structuredClone(
    verifyRetainedCapacityOperation(raw, {
      id: proof.id,
      operation_sha256: proof.operation_sha256,
    }),
  );
}

function active(input: Record<string, unknown>): Record<string, unknown> | null {
  return isRecord(input.active_candidate) ? input.active_candidate : null;
}

function transition(
  previous: ReturnType<typeof readCheckpoint>,
  next: Record<string, unknown>,
  checkpoint: string,
) {
  validateCapacityTransition(previous.input, next, checkpoint);
  validateReleaseReviewRequestTransition(previous.input, next, checkpoint);
  const old = active(previous.input);
  const candidate = active(next);
  validateCandidateStageTransition(old, candidate, checkpoint);
  const capacity =
    isRecord(previous.input.controller) && isRecord(previous.input.controller.capacity_attempt)
      ? previous.input.controller.capacity_attempt
      : null;
  validatePublicationReportRepairTransition(
    old,
    candidate,
    checkpoint,
    capacity?.operation,
    capacity?.prior_operations,
  );
  const controller = next.controller;
  if ((old || candidate) && canonical(controller) !== canonical(previous.input.controller)) {
    // Pause/capacity may change, but execution policy identity cannot drift.
    const before = previous.input.controller;
    if (
      !isRecord(before) ||
      !isRecord(controller) ||
      before.workflow !== controller.workflow ||
      before.revision !== controller.revision
    )
      throw new Error("active coordinator controller identity changed");
  }
  if (!old && candidate) {
    if (previous.plan.action !== "prepare" || !("proposal" in previous.plan))
      throw new Error("new active candidate requires the preceding preparation plan");
    const proposal = previous.plan.proposal;
    if (
      candidate.source_commit !== proposal.source_commit ||
      candidate.source_tree !== previous.plan.authority.opportunity_tree ||
      candidate.version !== proposal.version ||
      candidate.phase !== "prepared" ||
      candidate.transient_retries !== 0 ||
      candidate.substantive_repairs !== 0 ||
      candidate.release_run != null
    )
      throw new Error("active candidate does not match the frozen preparation plan");
    const opportunity = previous.input.opportunity;
    if (!isRecord(opportunity)) throw new Error("missing preparation opportunity");
    if (
      Object.hasOwn(candidate, "frozen_opportunity") &&
      canonical(candidate.frozen_opportunity) !== canonical(opportunity)
    )
      throw new Error("frozen opportunity differs from the preceding preparation input");
    const classification = parseVersionClassification(opportunity.classification);
    const intent = JSON.stringify({
      proposal,
      compatibility: classification.compatibility,
      migration_notes: classification.migration_notes ?? "",
    });
    if (createHash("sha256").update(intent).digest("hex") !== candidate.intent_sha256)
      throw new Error("prepared intent differs from the preceding reviewed classification");
  }
  if (!old) return;
  if (!candidate) {
    const publication = next.publication;
    if (
      old.phase !== "promoting" ||
      !isRecord(publication) ||
      !Array.isArray(publication.published_versions) ||
      !publication.published_versions.includes(old.version) ||
      !Array.isArray(publication.published_sources) ||
      !publication.published_sources.includes(old.source_commit)
    )
      throw new Error("cannot discard an active reservation without matching published identity");
    return;
  }
  if (canonical(old.frozen_opportunity) !== canonical(candidate.frozen_opportunity))
    throw new Error("active frozen opportunity cannot be added, removed or changed");
  for (const field of [
    "source_commit",
    "source_tree",
    "prepared_commit",
    "prepared_tree",
    "version",
    "intent_sha256",
  ])
    if (old[field] !== candidate[field]) throw new Error(`active reservation ${field} changed`);
  for (const field of ["transient_retries", "substantive_repairs"]) {
    const before = old[field];
    const after = candidate[field];
    if (
      typeof before !== "number" ||
      typeof after !== "number" ||
      after < before ||
      after > before + 1
    )
      throw new Error("coordinator recovery counters regressed or skipped");
  }
  const retriesChanged = old.transient_retries !== candidate.transient_retries;
  const repairsChanged = old.substantive_repairs !== candidate.substantive_repairs;
  if (
    old.phase === "failed" &&
    candidate.phase === "failed" &&
    canonical(old) !== canonical(candidate)
  )
    throw new Error(
      "failed reservation cannot be reclassified or edited without starting recovery",
    );
  if (retriesChanged || repairsChanged) {
    if (
      old.phase !== "failed" ||
      (retriesChanged && (repairsChanged || previous.plan.action !== "retry-active")) ||
      (repairsChanged && previous.plan.action !== "dispatch-repair")
    )
      throw new Error("coordinator recovery increment lacks its preceding recovery plan");
  } else if (
    canonical(old.release_run ?? null) !== canonical(candidate.release_run ?? null) &&
    old.release_run != null
  ) {
    throw new Error("release run changed without a planned recovery increment");
  }
  const phases = ["prepared", "qualifying", "building", "publishing", "promoting"];
  if (candidate.phase === "failed") return;
  if (old.phase === "failed") {
    if (!retriesChanged && !repairsChanged && candidate.phase !== "failed")
      throw new Error("failed candidate requires a planned recovery increment");
    if (candidate.phase !== "prepared" || candidate.release_run != null)
      throw new Error(
        "planned recovery must restart the frozen candidate at prepared without a run",
      );
  } else {
    const before = phases.indexOf(String(old.phase));
    const after = phases.indexOf(String(candidate.phase));
    if (after < before || after > before + 1)
      throw new Error("coordinator phase regressed or skipped");
  }
}

/** Reuse the raw preparation receipt contract for remote inventory. The caller
 * must first authenticate each Git object's raw identity; this grants no trust. */
export function inspectPreparationCommitBytes(
  sourceBytes: string,
  preparedBytes: string,
  candidate: Record<string, unknown>,
) {
  const {
    source_commit: source,
    source_tree: sourceTree,
    prepared_commit: prepared,
    prepared_tree: preparedTree,
    version,
    intent_sha256: intent,
  } = candidate;
  identity(source);
  identity(prepared);
  if (Buffer.byteLength(sourceBytes) > 128 * 1024 || Buffer.byteLength(preparedBytes) > 128 * 1024)
    throw new Error("preparation commit exceeds its byte bound");
  const sourceHeader = sourceBytes.split("\n\n", 1)[0]?.split("\n") ?? [];
  const boundary = preparedBytes.indexOf("\n\n");
  const preparedHeader = preparedBytes.slice(0, boundary).split("\n");
  if (
    boundary < 0 ||
    preparedHeader.filter((line) => line.startsWith("parent ")).join("\n") !== `parent ${source}`
  )
    throw new Error("preparation requires the raw source as its sole parent");
  if (
    sourceHeader.filter((line) => line.startsWith("tree ")).join("\n") !==
      `tree ${String(sourceTree)}` ||
    preparedHeader.filter((line) => line.startsWith("tree ")).join("\n") !==
      `tree ${String(preparedTree)}`
  )
    throw new Error("reserved source or prepared tree disagrees with Git objects");
  const message = preparedBytes.slice(boundary + 2).trimEnd();
  const prefix = `Prepare application ${String(version)}\n\nPortcove-Preparation-SHA256: ${String(intent)}\n`;
  const payload = message.slice(prefix.length);
  if (!message.startsWith(prefix) || createHash("sha256").update(payload).digest("hex") !== intent)
    throw new Error("prepared commit does not bind the reservation intent");
  if (typeof version !== "string" || !/^[0-9A-Za-z.+-]+$/u.test(version))
    throw new Error("unsafe reservation version");
  return payload;
}

function preparationVerifies(git: Git, input: Record<string, unknown>) {
  const candidate = active(input);
  if (!candidate) return [];
  const { source_commit: source, prepared_commit: prepared, version } = candidate;
  identity(source);
  identity(prepared);
  if (
    git(["cat-file", "-t", source]) !== "commit" ||
    git(["cat-file", "-t", prepared]) !== "commit"
  )
    throw new Error("preparation requires exact commits with the source as its sole parent");
  inspectPreparationCommitBytes(
    git(["cat-file", "commit", source], undefined, true),
    git(["cat-file", "commit", prepared], undefined, true),
    candidate,
  );
  if (typeof version !== "string") throw new Error("unsafe reservation version");
  return [
    `verify refs/portcove/prepared-versions/v${version} ${prepared}`,
    `verify refs/portcove/prepared-commits/${source} ${prepared}`,
  ];
}

/** Persist one caller-authenticated planner snapshot; no action is executed.
 * expectedPrevious is null ONLY for explicit first initialization. A missing
 * prior ref after initialization is a conflict, never a new allocation.
 */
export async function checkpointReleaseOpportunity(
  repository: string,
  expectedPrevious: string | null,
  rawInput: unknown,
) {
  if (expectedPrevious !== null) identity(expectedPrevious);
  const { input, plan } = checkedInput(rawInput);
  const git = gitRepository(repository);
  const previous = expectedPrevious === null ? null : readCheckpoint(git, expectedPrevious);
  if (previous) transition(previous, input, expectedPrevious!);
  else if (active(input))
    throw new Error("first coordinator checkpoint cannot invent an active reservation");
  else if (input.review_request != null || input.review_disposition != null)
    throw new Error("first coordinator checkpoint cannot invent a frozen review request");
  const verifies = preparationVerifies(git, input);
  // Clearing a completed active candidate still verifies its exact allocation.
  if (previous && !active(input)) verifies.push(...preparationVerifies(git, previous.input));
  const raw = canonical({ schema_version: 1, previous: expectedPrevious, input });
  if (Buffer.byteLength(raw) > maximumBytes)
    throw new Error("coordinator checkpoint exceeds byte bound");
  const blob = git(["hash-object", "-w", "--stdin"], raw);
  const tree = git(["mktree"], `100644 blob ${blob}\tstate.json\n`);
  const commit = git(
    ["commit-tree", tree, ...(expectedPrevious ? ["-p", expectedPrevious] : [])],
    "Portcove release coordinator checkpoint\n",
  );
  identity(commit);
  try {
    await git.transaction([
      `update ${coordinatorStateRef} ${commit} ${expectedPrevious ?? zero}`,
      ...verifies,
    ]);
  } catch (writeError) {
    try {
      // Lost-response/concurrent-identical retry is accepted only while the
      // complete state AND prepared receipt pair still match under the locks.
      await git.transaction([`verify ${coordinatorStateRef} ${commit}`, ...verifies]);
    } catch (verifyError) {
      throw new Error("coordinator checkpoint conflict, incomplete allocation, or locked state", {
        cause: new AggregateError([writeError, verifyError]),
      });
    }
  }
  return { checkpoint: commit, previous: expectedPrevious, plan };
}

/** Recover the explicit expected checkpoint, refusing a lost or changed ref. */
export async function recoverReleaseOpportunity(repository: string, expected: string) {
  identity(expected);
  const git = gitRepository(repository);
  const state = readCheckpoint(git, expected);
  const verifies = preparationVerifies(git, state.input);
  await git.transaction([`verify ${coordinatorStateRef} ${expected}`, ...verifies]);
  return { checkpoint: expected, ...state };
}

function objectIdentity(kind: "blob" | "tree" | "commit", bytes: Uint8Array) {
  return createHash("sha1").update(`${kind} ${bytes.byteLength}\0`).update(bytes).digest("hex");
}

/** Export only the existing journal's exact inert objects. The caller must own
 * this bare coordinator; bare status alone is not ownership or authorization.
 * This performs no network request, allocation, checkout or code execution.
 */
function inspectCheckpoint(git: Git, expected: string) {
  if (git(["rev-parse", "--is-bare-repository"]) !== "true")
    throw new Error("remote checkpoint export requires a caller-owned bare coordinator");
  const state = { checkpoint: expected, ...readCheckpoint(git, expected) };
  const previous = state.previous === null ? null : readCheckpoint(git, state.previous);
  if (previous) transition(previous, state.input, state.previous!);
  else if (active(state.input)) throw new Error("initial checkpoint cannot invent a reservation");

  const selected = active(state.input) ? state.input : previous?.input;
  const candidate = selected ? active(selected) : null;
  const verifies = selected ? preparationVerifies(git, selected) : [];
  // Completion still retains both allocation receipts. Verify the complete
  // local preimage before exporting any immutable object identities.
  const receipts = verifies.map((command) => {
    const [, name, oid] = command.split(" ");
    identity(oid);
    if (!name) throw new Error("missing preparation receipt name");
    return { local_ref: name, oid, before_oid: previous && active(previous.input) ? oid : zero };
  });

  const blob = git(["rev-parse", `${expected}:state.json`]);
  const tree = git(["rev-parse", `${expected}^{tree}`]);
  identity(blob);
  identity(tree);
  const contents = git(["cat-file", "blob", `${expected}:state.json`], undefined, true);
  const treeBytes = Buffer.concat([
    Buffer.from("100644 state.json\0", "utf8"),
    Buffer.from(blob, "hex"),
  ]);
  const parents = state.previous === null ? [] : [state.previous];
  const actor = {
    name: "Portcove release coordinator",
    email: "coordinator@portcove.invalid",
    date: "2000-01-01T00:00:00Z",
  };
  const message = "Portcove release coordinator checkpoint\n";
  const canonicalCommit = `tree ${tree}\n${parents.map((oid) => `parent ${oid}\n`).join("")}author ${actor.name} <${actor.email}> 946684800 +0000\ncommitter ${actor.name} <${actor.email}> 946684800 +0000\n\n${message}`;
  if (
    git(["cat-file", "commit", expected], undefined, true) !== canonicalCommit ||
    objectIdentity("blob", Buffer.from(contents, "utf8")) !== blob ||
    objectIdentity("tree", treeBytes) !== tree ||
    objectIdentity("commit", Buffer.from(canonicalCommit, "utf8")) !== expected
  )
    throw new Error("checkpoint object bytes or fixed metadata disagree with their identities");

  const requiredCommits: { oid: string; tree: string; parent?: string }[] = [];
  if (candidate) {
    const source = candidate.source_commit;
    const sourceTree = candidate.source_tree;
    const prepared = candidate.prepared_commit;
    const preparedTree = candidate.prepared_tree;
    identity(source);
    identity(sourceTree);
    identity(prepared);
    identity(preparedTree);
    requiredCommits.push(
      { oid: source, tree: sourceTree },
      { oid: prepared, tree: preparedTree, parent: source },
    );
  }
  return {
    verifies,
    schema_version: 1 as const,
    checkpoint: expected,
    previous: state.previous,
    blob: { oid: blob, contents },
    tree: { oid: tree, entries: [{ path: "state.json", mode: "100644", type: "blob", sha: blob }] },
    commit: { oid: expected, tree, parents, message, author: actor, committer: actor },
    receipts,
    required_commits: requiredCommits,
  };
}

export async function exportCoordinatorCheckpoint(repository: string, expected: string) {
  const git = gitRepository(repository);
  const { verifies, ...checkpoint } = inspectCheckpoint(git, expected);
  await git.transaction([`verify ${coordinatorStateRef} ${expected}`, ...verifies]);
  return checkpoint;
}

export interface CoordinatorGitObject {
  kind: "blob" | "tree" | "commit";
  oid: string;
  bytes: Uint8Array;
}

/** Restore only verified inert objects into a caller-owned fresh bare repository.
 * No transport, checkout, authority grant or preparation execution is performed.
 * Missing application blobs/history remain missing; lazy fetching is disabled.
 */
export async function importCoordinatorCheckpoint(
  repository: string,
  expected: string,
  objects: unknown,
) {
  identity(expected);
  if (!Array.isArray(objects) || objects.length < 3 || objects.length > 16)
    throw new Error("checkpoint import object count exceeds its bound");
  const identities = new Set<string>();
  const validated: CoordinatorGitObject[] = [];
  let total = 0;
  for (const object of objects) {
    if (
      !isRecord(object) ||
      Object.keys(object).sort().join(",") !== "bytes,kind,oid" ||
      (object.kind !== "blob" && object.kind !== "tree" && object.kind !== "commit") ||
      !(object.bytes instanceof Uint8Array) ||
      object.bytes.byteLength < 1 ||
      object.bytes.byteLength > maximumBytes * 2
    )
      throw new Error("checkpoint import object type or bytes exceed its bound");
    identity(object.oid);
    total += object.bytes.byteLength;
    if (
      total > 1024 * 1024 ||
      identities.has(object.oid) ||
      objectIdentity(object.kind, object.bytes) !== object.oid
    )
      throw new Error("checkpoint import object identity, duplicate or total byte bound differs");
    identities.add(object.oid);
    validated.push({ kind: object.kind, oid: object.oid, bytes: object.bytes });
  }
  const git = gitRepository(repository);
  if (
    git(["rev-parse", "--is-bare-repository"]) !== "true" ||
    git(["for-each-ref", "--format=%(refname)"]) !== ""
  )
    throw new Error("checkpoint import requires a caller-owned fresh bare repository");
  for (const kind of ["blob", "tree", "commit"] as const) {
    for (const object of validated.filter((value) => value.kind === kind)) {
      if (git(["hash-object", "-w", "-t", kind, "--stdin"], object.bytes) !== object.oid)
        throw new Error("imported checkpoint object identity differs");
    }
  }
  const checkpoint = inspectCheckpoint(git, expected);
  const creates = checkpoint.verifies.map((command) => {
    const [, name, oid] = command.split(" ");
    if (!name || !oid) throw new Error("incomplete restored preparation receipt");
    return `update ${name} ${oid} ${zero}`;
  });
  await git.transaction([`update ${coordinatorStateRef} ${expected} ${zero}`, ...creates]);
  return recoverReleaseOpportunity(repository, expected);
}
