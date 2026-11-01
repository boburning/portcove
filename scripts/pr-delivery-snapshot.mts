import { open, lstat } from "node:fs/promises";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { isRecord } from "./runtime-values.mts";
import { checkClosureIntent } from "./closure-intent.mts";
import { commandFailure } from "./report-summary.mts";
import type {
  DeliveryCheckRun,
  DeliveryJob,
  DeliveryPull,
  DeliveryStatus,
  RequiredContext,
  WatchContext,
} from "./pr-delivery.mts";

const repository = "boburning/portcove";
const collectionBudgetMs = 60_000;
const maximumSnapshotBytes = 16 * 1024 * 1024;
const sha = (value: unknown): value is string =>
  typeof value === "string" && /^[0-9a-f]{40}$/u.test(value);
const record = (value: unknown, label: string): Record<string, unknown> => {
  if (!isRecord(value)) throw new Error(`${label} is unavailable`);
  return value;
};
const same = (left: unknown, right: unknown) => JSON.stringify(left) === JSON.stringify(right);

export interface DeliveryMergeMessage {
  title: string;
  body: string;
}
export interface DeliveryClosingObservation {
  head: string;
  title: string;
  body: string;
  relationships: string[];
}

export function validateMergeMessage(value: unknown): DeliveryMergeMessage {
  if (
    !isRecord(value) ||
    typeof value.title !== "string" ||
    !value.title.trim() ||
    /[\r\n]/u.test(value.title) ||
    typeof value.body !== "string"
  )
    throw new Error("An explicit squash message with title and body is required");
  return { title: value.title, body: value.body };
}

export function validateMergeReadiness(
  number: number,
  head: string,
  pull: DeliveryPull,
  contexts: readonly WatchContext[],
) {
  if (pull.number !== number || pull.head.sha !== head)
    throw new Error(`pull request #${number} head or identity changed`);
  if (pull.state !== "open" || pull.merged !== false)
    throw new Error(`pull request #${number} is not open and unmerged`);
  if (pull.draft) throw new Error(`pull request #${number} is still a draft`);
  if (pull.mergeable !== true)
    throw new Error(
      pull.mergeable === false
        ? `pull request #${number} has merge conflicts`
        : `pull request #${number} mergeability is not determined`,
    );
  const incomplete = contexts.filter((context) => context.outcome !== "success");
  if (!contexts.length || incomplete.length)
    throw new Error(
      `required checks are not successful: ${incomplete.map((context) => `${context.context}=${context.conclusion}`).join(", ")}`,
    );
}

export function validateMergeCandidate({
  number,
  head,
  pull,
  contexts,
  closing,
  commits,
  closureIntent,
  mergeMessage,
}: {
  number: number;
  head: string;
  pull: DeliveryPull;
  contexts: readonly WatchContext[];
  closing: DeliveryClosingObservation;
  commits: readonly { sha: string; commit?: { message?: string } }[];
  closureIntent: unknown;
  mergeMessage: unknown;
}) {
  validateMergeReadiness(number, head, pull, contexts);
  const message = validateMergeMessage(mergeMessage);
  if (closing.head !== head || closing.body !== pull.body || closing.title !== pull.title)
    throw new Error("PR body or closing relationships changed; refresh delivery review");
  if (
    !Number.isSafeInteger(pull.commits) ||
    commits.length !== pull.commits ||
    commits.at(-1)?.sha !== head ||
    new Set(commits.map((commit) => commit.sha)).size !== commits.length ||
    commits.some(
      (commit) => !/^[0-9a-f]{40}$/u.test(commit.sha) || typeof commit.commit?.message !== "string",
    )
  )
    throw new Error("Candidate commit message inventory is incomplete");
  const targets = checkClosureIntent(closureIntent, {
    repository,
    texts: [
      closing.body,
      ...commits.map((commit) => {
        if (typeof commit.commit?.message !== "string")
          throw new Error("Candidate commit message inventory is incomplete");
        return commit.commit.message;
      }),
      message.title,
      message.body,
    ],
    relationships: closing.relationships,
  });
  return { message, targets };
}

export function validateMergedCommit(actual: unknown, sha: string, message: DeliveryMergeMessage) {
  const expected = message.body ? `${message.title}\n\n${message.body}` : message.title;
  if (
    !isRecord(actual) ||
    actual.sha !== sha ||
    (typeof actual.message === "string" ? actual.message.replace(/\n$/u, "") : undefined) !==
      expected.replace(/\n$/u, "")
  )
    throw new Error("Actual merged commit message differs from the checked squash message");
}

interface WorkflowBinding {
  head: string;
  run: number;
  attempt: number;
}

function workflowJobInventory(
  jobs: readonly DeliveryJob[],
  { head, run, attempt }: WorkflowBinding,
) {
  if (
    !sha(head) ||
    !Number.isSafeInteger(run) ||
    run < 1 ||
    !Number.isSafeInteger(attempt) ||
    attempt < 1
  )
    throw new Error("watch run/attempt/source binding is invalid");
  const checks = new Map<number, DeliveryJob>();
  const latestJobs = new Map<string, DeliveryJob>();
  const executions = new Set<string>();
  const identities = new Set<number>();
  for (const job of jobs) {
    providerState(
      { name: job.name, status: job.status, conclusion: job.conclusion },
      "workflow job",
    );
    const match =
      /^https:\/\/api\.github\.com\/repos\/boburning\/portcove\/check-runs\/([1-9]\d*)$/u.exec(
        job.check_run_url ?? "",
      );
    const checkId = Number(match?.[1]);
    if (
      !Number.isSafeInteger(job.id) ||
      job.id < 1 ||
      identities.has(job.id) ||
      job.run_id !== run ||
      !Number.isSafeInteger(job.run_attempt) ||
      job.run_attempt < 1 ||
      job.run_attempt > attempt ||
      job.head_sha !== head ||
      !Number.isSafeInteger(checkId) ||
      checks.has(checkId) ||
      executions.has(`${job.name}:${job.run_attempt}`)
    )
      throw new Error(
        "watch job inventory has invalid or duplicate run/attempt/source/check identity",
      );
    identities.add(job.id);
    checks.set(checkId, job);
    executions.add(`${job.name}:${job.run_attempt}`);
    if ((latestJobs.get(job.name)?.run_attempt ?? 0) < job.run_attempt)
      latestJobs.set(job.name, job);
  }
  return { checks, latestJobs };
}

export function assertSuccessfulWorkflowJobs(
  jobs: readonly DeliveryJob[],
  contexts: readonly WatchContext[],
  binding: WorkflowBinding,
) {
  const { checks, latestJobs } = workflowJobInventory(jobs, binding);
  for (const context of contexts) {
    const job = context.check_run_id === undefined ? undefined : checks.get(context.check_run_id);
    if (
      context.source !== "check-run" ||
      !job ||
      latestJobs.get(context.context) !== job ||
      job.name !== context.context ||
      job.status !== "completed" ||
      job.conclusion !== "success"
    )
      throw new Error(
        `required check ${context.context} is not a successful job of the identified run attempt`,
      );
  }
  return checks;
}

export function requiredCheckContexts(
  checkRuns: DeliveryCheckRun[],
  statuses: (Omit<DeliveryStatus, "id"> & { id?: number })[],
  requiredContexts: string[],
  binding?: WorkflowBinding & { jobs: readonly DeliveryJob[] },
): RequiredContext[] {
  const candidates = new Map<string, RequiredContext["observations"]>(
    requiredContexts.map((context) => [context, []]),
  );
  for (const run of checkRuns) {
    if (!candidates.has(run.name)) continue;
    const outcome =
      run.status === "completed"
        ? run.conclusion === "success"
          ? "success"
          : "failure"
        : "pending";
    candidates.get(run.name)?.push({
      source: "check-run",
      check_run_id: run.id,
      outcome,
      conclusion: run.conclusion ?? run.status,
      url: run.html_url ?? null,
    });
  }
  for (const status of statuses) {
    if (!candidates.has(status.context)) continue;
    const outcome =
      status.state === "success" ? "success" : status.state === "pending" ? "pending" : "failure";
    candidates.get(status.context)?.push({
      source: "commit-status",
      outcome,
      conclusion: status.state,
      description: status.description ?? null,
      url: status.target_url ?? null,
    });
  }
  // Only an explicitly bound, complete job inventory can disambiguate executions.
  // Keep every observation; unbound routes deliberately retain name ambiguity.
  const lineage = binding ? workflowJobInventory(binding.jobs, binding) : undefined;
  if (binding)
    for (const check of checkRuns) {
      providerState(
        { name: check.name, status: check.status, conclusion: check.conclusion },
        "check run",
      );
      if (check.head_sha !== binding.head)
        throw new Error("Check source differs from expected head");
    }
  const contexts = requiredContexts.map((context): RequiredContext => {
    const matches = candidates.get(context) ?? [];
    if (lineage && binding) {
      const seen = new Set<number>();
      for (const observation of matches) {
        const id = observation.check_run_id;
        const job = id === undefined ? undefined : lineage.checks.get(id);
        const raw = checkRuns.find((check) => check.id === id);
        if (
          observation.source !== "check-run" ||
          id === undefined ||
          seen.has(id) ||
          !job ||
          job.name !== context ||
          raw?.head_sha !== binding.head
        )
          throw new Error(`required check ${context} has unjoined or conflicting observations`);
        seen.add(id);
        const outcome =
          job.status === "completed"
            ? job.conclusion === "success"
              ? "success"
              : "failure"
            : "pending";
        if (
          observation.outcome !== outcome ||
          observation.conclusion !== (job.conclusion ?? job.status)
        )
          throw new Error(`required check ${context} disagrees with its workflow job`);
      }
      for (const [id, job] of lineage.checks)
        if (job.name === context && !seen.has(id))
          throw new Error(`required check ${context} job has no check observation`);
      const latest = lineage.latestJobs.get(context);
      const selected =
        latest &&
        matches.find((observation) => lineage.checks.get(observation.check_run_id!) === latest);
      if (selected) return { context, ...selected, observations: matches };
    }
    if (matches.length > 1)
      return { context, outcome: "failure", conclusion: "ambiguous", observations: matches };
    if (!matches.length)
      return { context, outcome: "pending", conclusion: "missing", observations: [] };
    const observation = matches[0];
    if (!observation) throw new Error("Required check observation disappeared");
    return { context, ...observation, observations: matches };
  });
  return contexts;
}

export interface MergeSnapshotExpectation {
  number: number;
  head: string;
  target: string;
  tree: string;
  contexts: string[];
  closureIntent: unknown;
  mergeMessage: unknown;
  run?: number;
  attempt?: number;
  now?: () => number;
}

function utc(value: unknown, label: string) {
  if (
    typeof value !== "string" ||
    !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{3})?Z$/u.test(value) ||
    !Number.isFinite(Date.parse(value)) ||
    new Date(value).toISOString().replace(".000Z", "Z") !== value.replace(".000Z", "Z")
  )
    throw new Error(`${label} must be an absolute UTC calendar time`);
  return Date.parse(value);
}

function envelope(value: unknown, phase: string, expected: MergeSnapshotExpectation) {
  const snapshot = record(value, "delivery snapshot");
  if (
    snapshot.format_version !== 1 ||
    snapshot.phase !== phase ||
    snapshot.repository !== repository
  )
    throw new Error("Delivery snapshot version, phase or repository differs");
  if (
    !Number.isSafeInteger(expected.number) ||
    expected.number < 1 ||
    !sha(expected.head) ||
    !sha(expected.target) ||
    !sha(expected.tree) ||
    !expected.contexts.length ||
    new Set(expected.contexts).size !== expected.contexts.length
  )
    throw new Error("Independent expected source, target, tree and contexts are required");
  const collection = record(snapshot.collection, "collection timing");
  const started = utc(collection.started_at, "collection start");
  const completed = utc(collection.completed_at, "collection completion");
  const now = (expected.now ?? Date.now)();
  if (
    !Number.isFinite(now) ||
    started > completed ||
    completed > now ||
    now - started > collectionBudgetMs
  )
    throw new Error(
      "Delivery snapshot is stale, from the future, or exceeds the 60-second collection budget",
    );
  return { snapshot, started, completed };
}

function pull(value: unknown, expected: MergeSnapshotExpectation): DeliveryPull {
  const item = record(value, "pull request");
  const head = record(item.head, "pull source"),
    base = record(item.base, "pull base");
  if (
    item.number !== expected.number ||
    head.sha !== expected.head ||
    !sha(base.sha) ||
    typeof base.ref !== "string" ||
    !base.ref ||
    record(base.repo, "pull base repository").full_name !== repository ||
    typeof item.title !== "string" ||
    typeof item.body !== "string" ||
    !Number.isSafeInteger(item.commits) ||
    Number(item.commits) < 1 ||
    typeof item.draft !== "boolean" ||
    typeof item.merged !== "boolean" ||
    typeof item.state !== "string" ||
    !["open", "closed"].includes(item.state) ||
    !(item.mergeable === true || item.mergeable === false || item.mergeable === null) ||
    !(item.merge_commit_sha === null || sha(item.merge_commit_sha))
  )
    throw new Error("Pull request snapshot is incomplete or differs from the expected identity");
  return item as unknown as DeliveryPull;
}

function pullBinding(value: DeliveryPull) {
  return [
    value.number,
    value.head.sha,
    value.base.ref,
    value.state,
    value.draft,
    value.merged,
    value.mergeable,
    value.merge_commit_sha,
    value.title,
    value.body,
    value.commits,
  ];
}

function branch(value: unknown, ref: string, expectedSha: string) {
  const item = record(value, "target branch");
  if (item.name !== ref || record(item.commit, "target commit").sha !== expectedSha)
    throw new Error("Current target branch changed or differs from the expected target");
}

function inventory(value: unknown, key: string): Record<string, unknown>[] {
  const collection = record(value, key);
  const items: unknown = collection[key];
  if (
    !Number.isSafeInteger(collection.total_count) ||
    Number(collection.total_count) < 0 ||
    !Array.isArray(items) ||
    collection.total_count !== items.length
  )
    throw new Error(`${key} inventory is incomplete`);
  const ids = new Set<number>();
  return items.map((value: unknown) => {
    const item = record(value, key);
    if (!Number.isSafeInteger(item.id) || Number(item.id) < 1 || ids.has(Number(item.id)))
      throw new Error(`${key} inventory has invalid or duplicate identity`);
    ids.add(Number(item.id));
    return item;
  });
}

function closing(
  value: unknown,
  candidate: DeliveryPull,
  interval: { started: number; completed: number },
): DeliveryClosingObservation {
  if (typeof candidate.title !== "string" || typeof candidate.body !== "string")
    throw new Error("PR title or body is unavailable");
  const item = record(value, "closing inventory");
  const observed = utc(item.observed_at, "closing observation");
  if (
    item.complete !== true ||
    item.number !== candidate.number ||
    item.head !== candidate.head.sha ||
    item.title !== candidate.title ||
    item.body !== candidate.body ||
    typeof item.method !== "string" ||
    !["graphql", "direct-ui-with-bracketing-rest"].includes(item.method) ||
    observed < interval.started ||
    observed > interval.completed ||
    !Array.isArray(item.relationships) ||
    !Number.isSafeInteger(item.total_count) ||
    item.total_count !== item.relationships.length ||
    item.relationships.some(
      (target: unknown) =>
        typeof target !== "string" || !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+#[1-9]\d*$/u.test(target),
    )
  )
    throw new Error("Complete fresh closing inventory is not bound to the candidate");
  const relationships = (item.relationships as string[])
    .map((target) => target.toLowerCase())
    .sort();
  if (new Set(relationships).size !== relationships.length)
    throw new Error("Closing inventory contains duplicate relationships");
  return { head: candidate.head.sha, title: candidate.title, body: candidate.body, relationships };
}

function providerState(value: Record<string, unknown>, label: string) {
  const statuses = ["queued", "requested", "waiting", "pending", "in_progress", "completed"];
  const conclusions = [
    "success",
    "failure",
    "neutral",
    "cancelled",
    "skipped",
    "timed_out",
    "action_required",
    "stale",
    "startup_failure",
  ];
  if (
    typeof value.name !== "string" ||
    !value.name ||
    typeof value.status !== "string" ||
    !statuses.includes(value.status) ||
    (value.status === "completed"
      ? typeof value.conclusion !== "string" || !conclusions.includes(value.conclusion)
      : value.conclusion !== null)
  )
    throw new Error(`${label} identity, state or completion is incomplete or contradictory`);
}

function fingerprint(value: DeliveryClosingObservation) {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function bracketed(
  snapshot: Record<string, unknown>,
  expected: MergeSnapshotExpectation,
  interval: { started: number; completed: number },
) {
  const before = pull(snapshot.pull_before, expected),
    after = pull(snapshot.pull_after, expected);
  if (!same(pullBinding(before), pullBinding(after)))
    throw new Error("PR source, state, body, or preview changed during collection");
  const first = closing(snapshot.closing_before, before, interval);
  const last = closing(snapshot.closing_after, after, interval);
  if (!same(first, last)) throw new Error("Closing inventory changed during collection");
  if (
    utc(record(snapshot.closing_before, "closing inventory").observed_at, "closing observation") >
    utc(record(snapshot.closing_after, "closing inventory").observed_at, "closing observation")
  )
    throw new Error("Closing observations are out of order");
  return { pull: after, closing: last };
}

function composition(
  value: unknown,
  expected: MergeSnapshotExpectation,
  commitSha: string,
  merged: boolean,
) {
  const commit = record(value, "Git commit composition");
  const parents: unknown = commit.parents;
  const expectedParents = merged ? [expected.target] : [expected.target, expected.head];
  if (
    commit.sha !== commitSha ||
    record(commit.tree, "Git commit tree").sha !== expected.tree ||
    !Array.isArray(parents) ||
    !same(
      parents.map((parent: unknown) => record(parent, "Git commit parent").sha),
      expectedParents,
    )
  )
    throw new Error("Git commit composition differs from expected source, target, or tree");
}

function localComposition(
  value: unknown,
  previewSha: string,
  expected: MergeSnapshotExpectation,
  checkout: string,
  remainingMs: number,
) {
  if (!path.isAbsolute(checkout)) throw new Error("Local composition checkout must be absolute");
  const preview = record(value, "Git commit composition");
  const parents = preview.parents;
  const previewTree = record(preview.tree, "Git commit tree").sha;
  if (
    preview.sha !== previewSha ||
    !sha(previewTree) ||
    !Array.isArray(parents) ||
    parents.length !== 2 ||
    !sha(record(parents[0], "preview target").sha) ||
    record(parents[1], "preview source").sha !== expected.head
  )
    throw new Error("Historical preview source, target or tree is incomplete");
  const previewTarget = record(parents[0], "preview target").sha as string;
  const deadline = Date.now() + remainingMs;
  const directory = mkdtempSync(path.join(os.tmpdir(), "portcove-merge-composition-"));
  try {
    const empty = path.join(directory, "empty"),
      bare = path.join(directory, "objects.git");
    mkdirSync(empty);
    const config = path.join(directory, "empty-config");
    writeFileSync(config, "");
    // Copy no ambient Git overrides, repository configuration, attributes,
    // replacement refs, grafts or promisor setup into the object-only verifier.
    const env = {
      PATH: process.env.PATH,
      SystemRoot: process.env.SystemRoot,
      WINDIR: process.env.WINDIR,
      PATHEXT: process.env.PATHEXT,
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_SYSTEM: config,
      GIT_CONFIG_GLOBAL: config,
      GIT_ATTR_NOSYSTEM: "1",
      GIT_CONFIG_COUNT: "3",
      GIT_CONFIG_KEY_0: "core.hooksPath",
      GIT_CONFIG_VALUE_0: empty,
      GIT_CONFIG_KEY_1: "core.attributesFile",
      GIT_CONFIG_VALUE_1: config,
      GIT_CONFIG_KEY_2: "core.fsmonitor",
      GIT_CONFIG_VALUE_2: "false",
      GIT_NO_REPLACE_OBJECTS: "1",
      GIT_NO_LAZY_FETCH: "1",
      GIT_ALLOW_PROTOCOL: "",
      GIT_TERMINAL_PROMPT: "0",
    };
    const git = (cwd: string, args: string[]) => {
      const remaining = deadline - Date.now();
      if (remaining <= 0)
        throw new Error("Local composition exhausted the snapshot collection budget");
      const result = spawnSync("git", ["--no-replace-objects", ...args], {
        cwd,
        env,
        encoding: "buffer",
        shell: false,
        windowsHide: true,
        timeout: Math.min(15_000, remaining),
        maxBuffer: 1024 * 1024,
      });
      if (
        result.error ||
        result.status !== 0 ||
        !Buffer.isBuffer(result.stdout) ||
        Date.now() > deadline
      )
        throw commandFailure(
          `Local composition Git ${args[0]} failed; missing objects, conflicts or an expired budget require reconciliation`,
          result,
          path.join(checkout, "work", "pr-delivery"),
        );
      return result.stdout;
    };
    const text = (cwd: string, args: string[]) => git(cwd, args).toString("utf8").trim();
    const checkHead = () => {
      if (text(checkout, ["rev-parse", "--verify", "HEAD"]) !== expected.head)
        throw new Error("Local composition checkout head differs from the reviewed source");
    };
    checkHead();
    if (text(checkout, ["rev-parse", "--is-shallow-repository"]) !== "false")
      throw new Error("Local composition requires complete stored history");
    const objects = text(checkout, [
      "rev-parse",
      "--path-format=absolute",
      "--git-path",
      "objects",
    ]);
    if (!path.isAbsolute(objects) || /[\r\n\0]/u.test(objects))
      throw new Error("Local composition object directory is invalid");
    git(directory, ["init", "--bare", "--template", empty, bare]);
    writeFileSync(
      path.join(bare, "objects", "info", "alternates"),
      objects.replaceAll("\\", "/") + "\n",
    );
    const commit = (id: string) => {
      const bytes = git(bare, ["cat-file", "commit", id]);
      if (createHash("sha1").update(`commit ${bytes.length}\0`).update(bytes).digest("hex") !== id)
        throw new Error("Local composition raw commit identity differs");
      const header = bytes.toString("utf8").split("\n\n")[0] ?? "";
      const tree = /^tree ([a-f0-9]{40})$/mu.exec(header)?.[1];
      const parents = [...header.matchAll(/^parent ([a-f0-9]{40})$/gmu)].map((match) => match[1]);
      if (!sha(tree)) throw new Error("Local composition commit tree is invalid");
      return { tree, parents };
    };
    const actualPreview = commit(previewSha);
    if (
      actualPreview.tree !== previewTree ||
      !same(actualPreview.parents, [previewTarget, expected.head])
    )
      throw new Error("Local preview object differs from the provider observation");
    commit(expected.head);
    commit(expected.target);
    git(bare, ["merge-base", "--is-ancestor", previewTarget, expected.target]);
    if (text(bare, ["merge-tree", "--write-tree", previewTarget, expected.head]) !== previewTree)
      throw new Error("Historical provider preview differs from the independently computed tree");
    if (
      text(bare, ["merge-tree", "--write-tree", expected.target, expected.head]) !== expected.tree
    )
      throw new Error("Current local composition differs from the independently reviewed tree");
    checkHead();
    return {
      method: "local-git-merge-tree",
      preview_target: previewTarget,
      preview_tree: previewTree,
    };
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

export function prepareMergeSnapshot(
  value: unknown,
  expected: MergeSnapshotExpectation,
  localCheckout?: string,
) {
  const { snapshot, ...interval } = envelope(value, "prepare-merge", expected);
  const observed = bracketed(snapshot, expected, interval);
  const ref = observed.pull.base.ref!;
  branch(snapshot.target_before, ref, expected.target);
  branch(snapshot.target_after, ref, expected.target);
  if (!sha(observed.pull.merge_commit_sha)) throw new Error("Merge preview is unavailable");
  let verifiedComposition;
  if (localCheckout !== undefined) {
    verifiedComposition = localComposition(
      snapshot.preview,
      observed.pull.merge_commit_sha,
      expected,
      localCheckout,
      collectionBudgetMs - ((expected.now ?? Date.now)() - interval.started),
    );
  } else {
    composition(snapshot.preview, expected, observed.pull.merge_commit_sha, false);
    verifiedComposition = {
      method: "provider-preview",
      preview_target: expected.target,
      preview_tree: expected.tree,
    };
  }
  if (
    !Number.isSafeInteger(expected.run) ||
    Number(expected.run) < 1 ||
    !Number.isSafeInteger(expected.attempt) ||
    Number(expected.attempt) < 1
  )
    throw new Error("The independent workflow run and attempt are required");
  for (const input of [snapshot.run_before, snapshot.run_after]) {
    const run = record(input, "workflow run");
    if (
      run.id !== expected.run ||
      run.run_attempt !== expected.attempt ||
      run.head_sha !== expected.head ||
      run.status !== "completed" ||
      run.conclusion !== "success" ||
      record(run.repository, "workflow repository").full_name !== repository
    )
      throw new Error("Workflow source, attempt or successful outcome differs during collection");
  }
  const checks = inventory(snapshot.checks, "check_runs");
  const statuses = inventory(snapshot.statuses, "statuses");
  const jobs = inventory(snapshot.jobs, "jobs");
  if (record(snapshot.statuses, "combined status").sha !== expected.head)
    throw new Error("Combined status source differs from expected head");
  for (const check of checks) providerState(check, "check run");
  for (const job of jobs) providerState(job, "workflow job");
  if (
    checks.some(
      (check) =>
        check.head_sha !== expected.head ||
        typeof check.name !== "string" ||
        typeof check.status !== "string" ||
        !(typeof check.conclusion === "string" || check.conclusion === null),
    ) ||
    statuses.some(
      (status) =>
        typeof status.context !== "string" ||
        !status.context ||
        typeof status.state !== "string" ||
        !["success", "pending", "failure", "error"].includes(status.state),
    ) ||
    jobs.some((job) => typeof job.name !== "string" || typeof job.status !== "string")
  )
    throw new Error("Check/job/status identity or state is incomplete");
  const contexts = requiredCheckContexts(
    checks as unknown as DeliveryCheckRun[],
    statuses as unknown as DeliveryStatus[],
    expected.contexts,
    {
      head: expected.head,
      run: expected.run!,
      attempt: expected.attempt!,
      jobs: jobs as unknown as DeliveryJob[],
    },
  );
  assertSuccessfulWorkflowJobs(jobs as unknown as DeliveryJob[], contexts, {
    head: expected.head,
    run: expected.run!,
    attempt: expected.attempt!,
  });
  if (!Array.isArray(snapshot.commits))
    throw new Error("Candidate commit inventory is unavailable");
  const commits = snapshot.commits.map((value: unknown) => {
    const commit = record(value, "candidate commit"),
      metadata = record(commit.commit, "candidate commit metadata");
    if (!sha(commit.sha) || typeof metadata.message !== "string")
      throw new Error("Candidate commit/message identity is incomplete");
    return { sha: commit.sha, commit: { message: metadata.message } };
  });
  const candidate = validateMergeCandidate({
    number: expected.number,
    head: expected.head,
    pull: observed.pull,
    contexts,
    closing: observed.closing,
    commits,
    closureIntent: expected.closureIntent,
    mergeMessage: expected.mergeMessage,
  });
  envelope(value, "prepare-merge", expected);
  return {
    format_version: 1,
    phase: "prepare-merge",
    observation: "complete",
    repository,
    pull_request: expected.number,
    head: expected.head,
    target: expected.target,
    tree: expected.tree,
    target_ref: ref,
    preview: observed.pull.merge_commit_sha,
    composition: verifiedComposition,
    run: expected.run,
    attempt: expected.attempt,
    closing_fingerprint: fingerprint(observed.closing),
    closure_targets: candidate.targets,
    merge_request: {
      repository_full_name: repository,
      pr_number: expected.number,
      expected_head_sha: expected.head,
      merge_method: "squash",
      commit_title: candidate.message.title,
      commit_message: candidate.message.body,
    },
    boundary:
      "Validated supplied observations only. Preview composition does not establish the CI checkout or review provenance. The caller must establish authentic complete collection, independent review, acceptance, current repository rules and authorization; invoke the live expected-head merge promptly, then verify actual parent/tree/message and closure readback. No mutation, approval, retry or future freshness is supplied.",
  };
}

export function verifyMergeSnapshotReadback(value: unknown, expected: MergeSnapshotExpectation) {
  const { snapshot, ...interval } = envelope(value, "merge-readback", expected);
  const observed = bracketed(snapshot, expected, interval);
  const merged = observed.pull.merge_commit_sha;
  if (observed.pull.state !== "closed" || observed.pull.merged !== true || !sha(merged))
    throw new Error("Merge outcome is unconfirmed; reconcile remote state before any retry");
  const prepared = record(snapshot.prepared, "prepared observation");
  if (
    prepared.format_version !== 1 ||
    prepared.phase !== "prepare-merge" ||
    prepared.observation !== "complete" ||
    prepared.repository !== repository ||
    prepared.pull_request !== expected.number ||
    prepared.head !== expected.head ||
    prepared.target !== expected.target ||
    prepared.tree !== expected.tree ||
    prepared.target_ref !== observed.pull.base.ref ||
    prepared.closing_fingerprint !== fingerprint(observed.closing)
  )
    throw new Error("Merge occurred; prepared identity or closure readback differs; do not retry");
  composition(snapshot.actual_commit, expected, merged, true);
  const message = validateMergeMessage(expected.mergeMessage);
  if (
    !Array.isArray(prepared.closure_targets) ||
    prepared.closure_targets.some((target: unknown) => typeof target !== "string")
  )
    throw new Error("Merge occurred; prepared closure intent is unavailable; do not retry");
  const targets = checkClosureIntent(expected.closureIntent, {
    repository,
    texts: [observed.closing.body, message.title, message.body],
    relationships: [...(prepared.closure_targets as string[]), ...observed.closing.relationships],
  });
  if (!same(targets, prepared.closure_targets))
    throw new Error("Merge occurred; closure targets differ from preparation; do not retry");
  const request = record(prepared.merge_request, "prepared merge request");
  if (
    request.expected_head_sha !== expected.head ||
    request.repository_full_name !== repository ||
    request.pr_number !== expected.number ||
    request.merge_method !== "squash" ||
    request.commit_title !== message.title ||
    request.commit_message !== message.body
  )
    throw new Error("Merge occurred; checked merge request differs; do not retry");
  validateMergedCommit(snapshot.actual_commit, merged, message);
  branch(snapshot.target_before, observed.pull.base.ref!, merged);
  branch(snapshot.target_after, observed.pull.base.ref!, merged);
  return {
    format_version: 1,
    phase: "merge-readback",
    observation: "complete",
    repository,
    pull_request: expected.number,
    head: expected.head,
    target: expected.target,
    tree: expected.tree,
    merge_commit_sha: merged,
    closing_fingerprint: fingerprint(observed.closing),
    closure_targets: targets,
    boundary:
      "Supplied remote observations match the prepared source, squash parent, tree, message and closures. Reconcile the owning issue/Project; this does not establish collection authenticity or independent acceptance. Never retry a confirmed merge.",
  };
}

export async function readDeliverySnapshot(file: string) {
  if (!path.isAbsolute(file)) throw new Error("Snapshot input must be an absolute path");
  const before = await lstat(file);
  if (!before.isFile() || before.size > maximumSnapshotBytes)
    throw new Error("Snapshot input must be a regular file up to 16 MiB");
  const handle = await open(file, "r");
  try {
    const stat = await handle.stat();
    if (
      !stat.isFile() ||
      stat.dev !== before.dev ||
      stat.ino !== before.ino ||
      stat.size > maximumSnapshotBytes
    )
      throw new Error("Snapshot input changed before reading");
    const bytes = Buffer.alloc(maximumSnapshotBytes + 1);
    let size = 0;
    while (size < bytes.length) {
      const result = await handle.read(bytes, size, bytes.length - size, null);
      if (!result.bytesRead) break;
      size += result.bytesRead;
    }
    if (size > maximumSnapshotBytes) throw new Error("Snapshot input exceeds 16 MiB");
    const after = await handle.stat();
    if (
      after.size !== size ||
      stat.size !== after.size ||
      stat.mtimeMs !== after.mtimeMs ||
      stat.ctimeMs !== after.ctimeMs
    )
      throw new Error("Snapshot input changed while reading");
    return JSON.parse(
      new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(0, size)),
    ) as unknown;
  } finally {
    await handle.close();
  }
}
