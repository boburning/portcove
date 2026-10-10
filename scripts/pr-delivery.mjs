import { readFile } from "node:fs/promises";
import { mkdirSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { renderBoundedSummary, summarizeReport } from "./report-summary.mjs";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  GitHubApiClient,
  createGitHubRunner,
  githubOperationEnvelope,
  sanitizeOperationError,
} from "./github-api.mjs";
import {
  classifyRenovateSnapshot,
  fastLaneSummary,
  inspectCurrentBase,
  parseRenovateUpdates,
  runMetadataValidation,
  renovateSecurityIntent,
} from "./renovate-fast-lane.mjs";

const scriptPath = fileURLToPath(import.meta.url);
const projectRoot = fileURLToPath(new URL("..", import.meta.url));
const repository = "boburning/portcove";

export function baselineTimingWindow(workflow, jobs, contexts) {
  const start = Date.parse(workflow.run_started_at);
  const created = Date.parse(workflow.created_at);
  const completed = contexts
    .map((context) => jobs.find((job) => job.name === context.context)?.completed_at)
    .map(Date.parse);
  const valid =
    Number.isFinite(start) &&
    Number.isFinite(created) &&
    start >= created &&
    completed.length > 0 &&
    completed.every((end) => Number.isFinite(end) && end >= start);
  return {
    queue_ms:
      Number.isFinite(start) && Number.isFinite(created) && start >= created
        ? start - created
        : null,
    baseline_elapsed_ms: valid ? Math.max(...completed) - start : null,
    measurement: valid ? "observed" : "unavailable",
    boundary: "workflow start to last required context completion",
  };
}

function deliveryOutcomeError(status, message, evidence = {}, cause = null) {
  const error = new Error(message, cause ? { cause } : undefined);
  error.code = `pr_delivery_${status}`;
  error.operationStatus = status;
  error.operationEvidence = evidence;
  return error;
}

function exactKeys(value, expected, label) {
  const actual = Object.keys(value ?? {}).sort();
  const wanted = [...expected].sort();
  if (JSON.stringify(actual) !== JSON.stringify(wanted))
    throw new Error(`${label} must contain exactly: ${wanted.join(", ")}`);
}

export function requiredContextsFromConfigs(ruleset, coverage) {
  const rule = ruleset.rules?.find((candidate) => candidate.type === "required_status_checks");
  const contexts = rule?.parameters?.required_status_checks?.map((entry) => entry.context);
  if (
    !Array.isArray(contexts) ||
    !contexts.length ||
    contexts.some((context) => typeof context !== "string" || !context) ||
    new Set(contexts).size !== contexts.length
  ) {
    throw new Error("repository ruleset required checks are incomplete");
  }
  const coverageContexts = coverage?.protected_contexts;
  if (
    !Array.isArray(coverageContexts) ||
    JSON.stringify([...contexts].sort()) !== JSON.stringify([...coverageContexts].sort())
  ) {
    throw new Error("repository ruleset and qualification protected contexts differ");
  }
  return contexts;
}

export function parsePullRequestReference(value) {
  const numeric = /^(\d+)$/u.exec(String(value));
  if (numeric && Number(numeric[1]) > 0) return Number(numeric[1]);
  const url = /^https:\/\/github\.com\/([^/]+\/[^/]+)\/pull\/(\d+)\/?$/u.exec(String(value));
  if (!url || url[1].toLowerCase() !== repository.toLowerCase() || Number(url[2]) < 1)
    throw new Error(`invalid ${repository} pull request reference: ${value}`);
  return Number(url[2]);
}

export class PullRequestDeliveryClient {
  constructor(api = new GitHubApiClient(createGitHubRunner({ cwd: projectRoot }))) {
    this.api = typeof api === "function" ? new GitHubApiClient(api) : api;
  }

  request(method, endpoint, body = null) {
    return this.api.request(method, endpoint, body);
  }

  openRenovatePulls() {
    return this.api
      .paginateRest(`repos/${repository}/pulls?state=open&per_page=100`, {
        select: (body) => body,
        identity: (pull) => (Number.isSafeInteger(pull?.number) ? String(pull.number) : null),
        label: "open pull requests",
      })
      .filter((pull) => ["renovate[bot]", "app/renovate"].includes(pull.user?.login));
  }

  pull(number) {
    const body = this.request("GET", `repos/${repository}/pulls/${number}`).body;
    if (!body?.head?.sha || !body?.base?.sha || body.number !== number)
      throw new Error(`pull request #${number} response is incomplete`);
    return body;
  }

  paginatedConnection(endpoint, key, identity) {
    return this.api.paginateRest(endpoint, {
      select: (body) => body?.[key],
      identity,
      totalCount: (body) => body?.total_count,
      label: key,
    });
  }

  checkRuns(sha) {
    return this.paginatedConnection(
      `repos/${repository}/commits/${sha}/check-runs?filter=latest&per_page=100`,
      "check_runs",
      (run) => (Number.isSafeInteger(run?.id) ? String(run.id) : null),
    );
  }

  commitStatuses(sha) {
    return this.paginatedConnection(
      `repos/${repository}/commits/${sha}/status?per_page=100`,
      "statuses",
      (status) => (Number.isSafeInteger(status?.id) ? String(status.id) : null),
    );
  }

  pullFiles(number) {
    return this.api.paginateRest(`repos/${repository}/pulls/${number}/files?per_page=100`, {
      select: (body) => body,
      identity: (file) => (typeof file?.filename === "string" ? file.filename : null),
      label: "pull request files",
    });
  }

  pullCommits(number) {
    return this.api.paginateRest(`repos/${repository}/pulls/${number}/commits?per_page=100`, {
      select: (body) => body,
      identity: (commit) =>
        typeof commit?.sha === "string" && /^[0-9a-f]{40}$/u.test(commit.sha) ? commit.sha : null,
      label: "pull request commits",
    });
  }

  branch(name) {
    const body = this.request(
      "GET",
      `repos/${repository}/branches/${encodeURIComponent(name)}`,
    ).body;
    if (!/^[0-9a-f]{40}$/u.test(body?.commit?.sha ?? ""))
      throw new Error(`branch ${name} response is incomplete`);
    return body;
  }

  workflowRun(id) {
    const body = this.request("GET", `repos/${repository}/actions/runs/${id}`).body;
    if (body?.id !== id || body?.repository?.full_name?.toLowerCase() !== repository)
      throw new Error(`workflow run ${id} identity is incomplete or differs`);
    return body;
  }

  sourceWorkflowRuns(sha) {
    const runs = this.paginatedConnection(
      `repos/${repository}/actions/runs?head_sha=${sha}&per_page=100`,
      "workflow_runs",
      (run) => (Number.isSafeInteger(run?.id) ? String(run.id) : null),
    );
    if (runs.some((run) => run.head_sha !== sha || !Number.isSafeInteger(run.run_attempt)))
      throw new Error("source workflow run inventory differs from the exact queue head");
    return runs;
  }

  workflowJobs(run, attempt) {
    return this.paginatedConnection(
      `repos/${repository}/actions/runs/${run}/attempts/${attempt}/jobs?per_page=100`,
      "jobs",
      (job) => (Number.isSafeInteger(job?.id) ? String(job.id) : null),
    );
  }

  requiredCheckState(number, head, requiredContexts) {
    const pull = this.pull(number);
    if (pull.head.sha !== head)
      throw new Error(`pull request #${number} head changed: ${pull.head.sha} != ${head}`);
    const contexts = requiredCheckContexts(
      this.checkRuns(head),
      this.commitStatuses(head),
      requiredContexts,
    );
    return { pull, head, contexts };
  }

  renovateSnapshot(number, head, requiredContexts) {
    const pull = this.pull(number);
    const checkRuns = this.checkRuns(head);
    const statuses = this.commitStatuses(head);
    const commits = this.pullCommits(number);
    const files = this.pullFiles(number);
    if (!Number.isSafeInteger(pull.commits) || commits.length !== pull.commits)
      throw new Error(
        `pull request commit inventory is incomplete: expected ${pull.commits ?? "unknown"}, observed ${commits.length}`,
      );
    if (!Number.isSafeInteger(pull.changed_files) || files.length !== pull.changed_files)
      throw new Error(
        `pull request file inventory is incomplete: expected ${pull.changed_files ?? "unknown"}, observed ${files.length}`,
      );
    return {
      pull,
      commits,
      files,
      checkRuns,
      statuses,
      contexts: requiredCheckContexts(checkRuns, statuses, requiredContexts),
      target: this.branch(pull.base.ref),
    };
  }

  merge(number, head, requiredContexts) {
    const state = this.requiredCheckState(number, head, requiredContexts);
    if (state.pull.draft) throw new Error(`pull request #${number} is still a draft`);
    if (state.pull.mergeable !== true)
      throw new Error(
        state.pull.mergeable === false
          ? `pull request #${number} has merge conflicts`
          : `pull request #${number} mergeability is not determined`,
      );
    const incomplete = state.contexts.filter((context) => context.outcome !== "success");
    if (incomplete.length)
      throw new Error(
        `required checks are not successful: ${incomplete
          .map((context) => `${context.context}=${context.conclusion}`)
          .join(", ")}`,
      );
    let result = null;
    let requestError = null;
    try {
      result = this.request("PUT", `repos/${repository}/pulls/${number}/merge`, {
        merge_method: "squash",
        sha: head,
      }).body;
    } catch (error) {
      requestError = error;
    }
    let readback;
    try {
      readback = this.pull(number);
    } catch (error) {
      throw deliveryOutcomeError(
        "unknown",
        `merge outcome is unknown after ${requestError?.message ?? "an unexpected response"}; ` +
          `remote readback failed: ${error.message}`,
        { pull_request: number, head },
        error,
      );
    }
    if (
      requestError &&
      readback.merged === true &&
      readback.state === "closed" &&
      readback.head.sha === head &&
      typeof readback.merge_commit_sha === "string"
    ) {
      result = {
        merged: true,
        sha: readback.merge_commit_sha,
        message: `merge command reported an error but remote readback confirmed completion: ${requestError.message}`,
      };
    }
    if (
      result?.merged !== true ||
      typeof result.sha !== "string" ||
      readback.merged !== true ||
      readback.state !== "closed" ||
      readback.head.sha !== head ||
      readback.merge_commit_sha !== result.sha
    ) {
      throw deliveryOutcomeError(
        "unknown",
        `merge response is ambiguous${requestError ? ` after ${requestError.message}` : ""}; ` +
          `remote readback: merged=${readback.merged}, ` +
          `state=${readback.state}, head=${readback.head.sha}, merge=${readback.merge_commit_sha}`,
        {
          pull_request: number,
          head,
          remote: {
            merged: readback.merged,
            state: readback.state,
            head: readback.head.sha,
            merge_commit_sha: readback.merge_commit_sha,
          },
        },
        requestError,
      );
    }
    return { result, readback, contexts: state.contexts };
  }
}

export function requiredCheckContexts(checkRuns, statuses, requiredContexts) {
  const candidates = new Map(requiredContexts.map((context) => [context, []]));
  for (const run of checkRuns) {
    if (!candidates.has(run.name)) continue;
    const outcome =
      run.status === "completed"
        ? run.conclusion === "success"
          ? "success"
          : "failure"
        : "pending";
    candidates.get(run.name).push({
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
    candidates.get(status.context).push({
      source: "commit-status",
      outcome,
      conclusion: status.state,
      description: status.description ?? null,
      url: status.target_url ?? null,
    });
  }
  const contexts = requiredContexts.map((context) => {
    const matches = candidates.get(context);
    if (matches.length > 1)
      return { context, outcome: "failure", conclusion: "ambiguous", observations: matches };
    if (!matches.length)
      return { context, outcome: "pending", conclusion: "missing", observations: [] };
    return { context, ...matches[0], observations: matches };
  });
  return contexts;
}

export function renovateCheckEnvelope({ number, head, result, snapshot }) {
  const summary = `Pull request #${number} exact head ${head}: ${fastLaneSummary(result)}.`;
  return githubOperationEnvelope({
    operation: "pr-delivery.renovate-check",
    status: "succeeded",
    summary,
    evidence: {
      pull_request: number,
      head,
      verdict: result.verdict,
      reason: result.reason,
      commits_observed: snapshot.commits.length,
      files_observed: snapshot.files.length,
      ...result.evidence,
    },
  });
}

// This read-only client bounds both each gh subprocess and all pages/reads in
// one observation. Merge and other GitHub consumers keep their existing runner.
export function createWatchClient({ now = Date.now, spawn = spawnSync } = {}) {
  let collectionDeadline = 0;
  const api = new GitHubApiClient(
    createGitHubRunner({
      cwd: projectRoot,
      spawn: (command, args, options) => {
        const remaining = collectionDeadline - now();
        if (remaining <= 0) throw new Error("watch read collection exceeded its 60-second budget");
        return spawn(command, args, {
          ...options,
          timeout: Math.min(15_000, remaining),
          killSignal: "SIGKILL",
        });
      },
    }),
  );
  const client = new PullRequestDeliveryClient(api);
  client.beginObservation = () => {
    collectionDeadline = now() + 60_000;
  };
  return client;
}

export async function watchRequiredChecks(
  client,
  {
    number,
    head,
    requiredContexts,
    run,
    attempt,
    deadline,
    sleep,
    now = Date.now,
    observe = () => {},
  },
) {
  if (!Number.isSafeInteger(run) || run < 1 || !Number.isSafeInteger(attempt) || attempt < 1)
    throw new Error("watch requires a positive run and attempt");
  if (
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/u.test(deadline ?? "") ||
    !Number.isFinite(Date.parse(deadline))
  )
    throw new Error("watch requires an absolute UTC --deadline; retain it when resuming");
  const deadlineMs = Date.parse(deadline);
  if (new Date(deadlineMs).toISOString().replace(".000Z", "Z") !== deadline.replace(".000Z", "Z"))
    throw new Error("watch --deadline must be a valid UTC calendar time");
  const pause =
    sleep ?? ((milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)));
  let observed = null;
  let state = null;
  const evidence = () => ({
    pull_request: number,
    head,
    run,
    attempt,
    deadline,
    workflow: observed && {
      id: observed.id,
      head_sha: observed.head_sha,
      run_attempt: observed.run_attempt,
      url: observed.html_url,
      status: observed.status,
      conclusion: observed.conclusion,
      created_at: observed.created_at,
      run_started_at: observed.run_started_at,
    },
    contexts: state?.contexts ?? [],
    next_action:
      "Inspect this run's jobs, logs and available artifacts; preserve the candidate and failure before choosing a repair. Do not redispatch automatically.",
  });
  for (;;) {
    try {
      client.beginObservation?.();
      observed = client.workflowRun(run);
      state = client.requiredCheckState(number, head, requiredContexts);
      try {
        observe({ format: 1, kind: "delivery-observation", ...evidence() });
      } catch {
        /* Diagnostics cannot change monitoring. */
      }
    } catch (error) {
      throw deliveryOutcomeError(
        "failed",
        `watch monitoring failed: ${sanitizeOperationError(error).message}`,
        evidence(),
        error,
      );
    }
    if (observed.head_sha !== head || observed.run_attempt !== attempt)
      throw deliveryOutcomeError(
        "failed",
        "watch run/source/attempt changed; reconcile the identified run before resuming",
        evidence(),
      );
    if (
      !["queued", "requested", "waiting", "pending", "in_progress", "completed"].includes(
        observed.status,
      )
    )
      throw deliveryOutcomeError(
        "failed",
        "watch workflow status is missing or unknown",
        evidence(),
      );
    if (
      !Number.isFinite(Date.parse(observed.created_at)) ||
      deadlineMs <= Date.parse(observed.created_at)
    )
      throw deliveryOutcomeError(
        "failed",
        "watch run creation time or deadline is invalid",
        evidence(),
      );
    const failures = state.contexts.filter((context) => context.outcome === "failure");
    if (failures.length)
      throw deliveryOutcomeError(
        "failed",
        `required checks failed: ${failures
          .map((context) => `${context.context}=${context.conclusion}`)
          .join(", ")}`,
        evidence(),
      );
    if (observed.status === "completed") {
      if (observed.conclusion !== "success")
        throw deliveryOutcomeError(
          "failed",
          `identified workflow run completed with ${observed.conclusion ?? "no conclusion"}`,
          evidence(),
        );
      if (state.contexts.every((context) => context.outcome === "success")) {
        let jobs;
        try {
          jobs = client.workflowJobs(run, attempt);
          try {
            observe({ format: 1, kind: "delivery-jobs", ...evidence(), jobs });
          } catch {
            /* Diagnostics cannot change monitoring. */
          }
        } catch (error) {
          throw deliveryOutcomeError(
            "failed",
            `watch job readback failed: ${sanitizeOperationError(error).message}`,
            evidence(),
            error,
          );
        }
        const checks = new Map();
        for (const job of jobs) {
          const match =
            /^https:\/\/api\.github\.com\/repos\/boburning\/portcove\/check-runs\/([1-9]\d*)$/u.exec(
              job.check_run_url ?? "",
            );
          const checkId = Number(match?.[1]);
          if (
            job.run_id !== run ||
            job.run_attempt !== attempt ||
            job.head_sha !== head ||
            !Number.isSafeInteger(checkId) ||
            checks.has(checkId)
          )
            throw deliveryOutcomeError(
              "failed",
              "watch job inventory has invalid or duplicate run/attempt/source/check identity",
              evidence(),
            );
          checks.set(checkId, job);
        }
        for (const context of state.contexts) {
          const job = checks.get(context.check_run_id);
          if (
            context.source !== "check-run" ||
            !job ||
            job.name !== context.context ||
            job.status !== "completed" ||
            job.conclusion !== "success"
          )
            throw deliveryOutcomeError(
              "failed",
              `required check ${context.context} is not a successful job of the identified run attempt`,
              evidence(),
            );
        }
        try {
          observed = client.workflowRun(run);
        } catch (error) {
          throw deliveryOutcomeError(
            "failed",
            `watch final run readback failed: ${sanitizeOperationError(error).message}`,
            evidence(),
            error,
          );
        }
        if (
          observed.head_sha !== head ||
          observed.run_attempt !== attempt ||
          observed.status !== "completed" ||
          observed.conclusion !== "success"
        )
          throw deliveryOutcomeError(
            "failed",
            "watch run changed during job collection",
            evidence(),
          );
        return {
          ...state,
          watch: {
            ...evidence(),
            timings: baselineTimingWindow(
              observed,
              state.contexts.map((context) => checks.get(context.check_run_id)),
              state.contexts,
            ),
            next_action:
              "Complete outstanding acceptance and independent review, then use the existing exact-head guarded merge.",
          },
        };
      }
      throw deliveryOutcomeError(
        "failed",
        "identified workflow succeeded but required exact-head gates remain missing or pending",
        evidence(),
      );
    }
    if (now() >= deadlineMs)
      throw deliveryOutcomeError(
        "failed",
        `watch deadline expired (run ${run}, attempt ${attempt}, ${observed.status}); timed out waiting for required checks: ${state.contexts
          .filter((context) => context.outcome !== "success")
          .map((context) => `${context.context}=${context.conclusion}`)
          .join(", ")}`,
        evidence(),
      );
    await pause(Math.min(180_000, Math.max(0, deadlineMs - now())));
  }
}

export function inspectRenovateQueue(client, config, contexts, inspectBase = inspectCurrentBase) {
  const target = client.branch("main").commit.sha;
  const candidates = client.openRenovatePulls().map((listed) => {
    const head = listed.head?.sha;
    if (!/^[0-9a-f]{40}$/u.test(head ?? "")) throw new Error("queue candidate lacks exact head");
    const snapshot = client.renovateSnapshot(listed.number, head, contexts);
    if (snapshot.pull.head.sha !== head || snapshot.target.commit.sha !== target)
      throw new Error("queue head or target changed; refresh once before selection");
    const updates = parseRenovateUpdates(snapshot.pull.body);
    const baseEvidence = inspectBase({
      projectRoot,
      number: listed.number,
      expectedHead: head,
      currentTarget: target,
      interactionTerms: updates.flatMap(({ packageName }) => [
        packageName,
        packageName.replaceAll("-", "_"),
      ]),
    });
    if (baseEvidence.changedHead) throw new Error("queue candidate changed during base inspection");
    const result = classifyRenovateSnapshot({
      ...snapshot,
      config,
      expectedHead: head,
      baseEvidence,
    });
    const security = renovateSecurityIntent(snapshot.pull);
    const failures = snapshot.contexts.filter(({ outcome }) => outcome === "failure");
    const pending = snapshot.contexts.filter(({ outcome }) => outcome !== "success");
    const age = snapshot.statuses.filter(({ context }) => context === "renovate/stability-days");
    const agePending = !security && age.some(({ state }) => state === "pending");
    const actionable =
      !snapshot.pull.draft &&
      snapshot.pull.mergeable === true &&
      !pending.length &&
      !agePending &&
      !["reject", "waiting"].includes(result.verdict);
    return {
      number: listed.number,
      head,
      target,
      title: snapshot.pull.title,
      url: snapshot.pull.html_url,
      owners: (snapshot.pull.assignees ?? []).map(({ login }) => login),
      path: security
        ? "urgent-remediation-assessment"
        : result.verdict === "metadata-required"
          ? "routine-fast-lane-candidate"
          : "controlled-maintenance",
      verdict: result.verdict,
      reason: result.reason,
      actionable,
      release_age: age,
      checks: snapshot.contexts,
      runs: client
        .sourceWorkflowRuns(head)
        .map(({ id, run_attempt, name, status, conclusion, run_started_at, html_url }) => ({
          id,
          attempt: run_attempt,
          name,
          status,
          conclusion,
          started_at: run_started_at,
          url: html_url,
        })),
      next_action: snapshot.pull.draft
        ? "Resume the current owner's draft using the configured operational board and fixed lane checkpoint."
        : failures.length
          ? "Inspect the first failed exact-head job and retained evidence; repair causally before rerunning."
          : pending.length
            ? "Collect the identified source-head run with its original attempt and absolute deadline; do not start duplicate validation."
            : snapshot.pull.mergeable !== true
              ? "Resolve actual conflicts or unknown mergeability with the current owner."
              : agePending
                ? "Wait for the existing release-age status; missing timestamps need a specific reviewed resolution, never a global cooldown waiver."
                : ["reject", "waiting"].includes(result.verdict)
                  ? "Resolve the reported classifier condition before selection."
                  : result.verdict === "metadata-required"
                    ? `Confirm the accepted assignment on the configured operational board, then just renovate-check --pr ${listed.number} --head ${head}; final delivering-agent review and guarded merge follow only merge-ready.`
                    : "Confirm the accepted assignment on the configured operational board, inspect advisory/graph/features and select the existing local/hosted/behavior plan; independent review and guarded merge remain.",
    };
  });
  candidates.sort(
    (a, b) =>
      Number(b.path === "urgent-remediation-assessment") -
        Number(a.path === "urgent-remediation-assessment") ||
      Number(b.actionable) - Number(a.actionable) ||
      Number(b.path === "routine-fast-lane-candidate") -
        Number(a.path === "routine-fast-lane-candidate") ||
      a.number - b.number,
  );
  return {
    target,
    candidates,
    selected: candidates.find(({ actionable }) => actionable)?.number ?? null,
    selection_boundary:
      "Recommendation only. Accepted coordinator assignments and reserved scopes on the configured operational board govern ownership; this command neither approves, rebases, retries nor merges. Refresh after each delivered candidate.",
  };
}

export function parseArguments(argv) {
  const command = argv[0];
  const options = {};
  for (let index = 1; index < argv.length; index += 1) {
    const name = argv[index];
    if (Object.hasOwn(options, name)) throw new Error(`duplicate option: ${name}`);
    if (name === "--json" || name === "--queue") {
      options[name] = true;
      continue;
    }
    const value = argv[index + 1];
    if (!name?.startsWith("--") || !value || value.startsWith("--"))
      throw new Error(`invalid argument near ${name ?? "end of command"}`);
    options[name] = value;
    index += 1;
  }
  return { command, options };
}

async function requiredContexts() {
  const [ruleset, coverage] = await Promise.all([
    readFile(path.join(projectRoot, ".github", "repository-ruleset.json"), "utf8").then(JSON.parse),
    readFile(path.join(projectRoot, ".github", "qualification-coverage.json"), "utf8").then(
      JSON.parse,
    ),
  ]);
  return requiredContextsFromConfigs(ruleset, coverage);
}

async function main(argv) {
  const { command, options } = parseArguments(argv);
  if (["help", "--help"].includes(command)) {
    console.log(
      "usage:\n" +
        "  node scripts/pr-delivery.mjs watch --pr <number-or-url> --head <sha> --run <id> --attempt <number> --deadline <UTC-time> [--json]\n" +
        "  node scripts/pr-delivery.mjs renovate-check --queue [--json]\n" +
        "  node scripts/pr-delivery.mjs renovate-check --pr <number-or-url> --head <sha> [--json]\n" +
        "  node scripts/pr-delivery.mjs merge --pr <number-or-url> --head <sha> [--json]",
    );
    return;
  }
  if (command === "renovate-check" && options["--queue"]) {
    exactKeys(options, ["--queue", ...(options["--json"] ? ["--json"] : [])], "queue options");
    const config = JSON.parse(await readFile(path.join(projectRoot, "renovate.json"), "utf8"));
    const queue = inspectRenovateQueue(
      new PullRequestDeliveryClient(),
      config,
      await requiredContexts(),
    );
    const summary = `Renovate queue: ${queue.candidates.length} complete candidates; recommended selection ${queue.selected ?? "none"}.`;
    console.log(
      options["--json"]
        ? JSON.stringify(
            githubOperationEnvelope({
              operation: "pr-delivery.renovate-queue",
              status: "succeeded",
              summary,
              evidence: queue,
            }),
          )
        : [
            summary,
            ...queue.candidates.map(
              (c) => `#${c.number} ${c.head}: ${c.path}; ${c.reason}. ${c.next_action}`,
            ),
            queue.selection_boundary,
          ].join("\n"),
    );
    return;
  }
  exactKeys(
    options,
    command === "watch"
      ? [
          "--head",
          "--pr",
          "--run",
          "--attempt",
          "--deadline",
          ...(options["--json"] ? ["--json"] : []),
        ]
      : ["--head", "--pr", ...(options["--json"] ? ["--json"] : [])],
    `${command} options`,
  );
  const number = parsePullRequestReference(options["--pr"]);
  const head = options["--head"];
  if (!/^[0-9a-f]{40}$/u.test(head ?? "")) throw new Error("--head must be a 40-character SHA");
  const contexts = await requiredContexts();
  const client = command === "watch" ? createWatchClient() : new PullRequestDeliveryClient();
  if (command === "renovate-check") {
    const config = JSON.parse(await readFile(path.join(projectRoot, "renovate.json"), "utf8"));
    const snapshot = client.renovateSnapshot(number, head, contexts);
    let baseEvidence;
    if (snapshot.pull.head.sha !== head) {
      baseEvidence = {
        changedHead: snapshot.pull.head.sha,
        currentTarget: snapshot.target.commit.sha,
        currentMergeBase: null,
        targetPaths: [],
        targetDependencyPaths: [],
      };
    } else {
      const [update] = parseRenovateUpdates(snapshot.pull.body);
      const packageName = update?.packageName;
      baseEvidence = inspectCurrentBase({
        projectRoot,
        number,
        expectedHead: head,
        currentTarget: snapshot.target.commit.sha,
        interactionTerms: packageName ? [packageName, packageName.replaceAll("-", "_")] : [],
      });
    }
    let result = classifyRenovateSnapshot({
      ...snapshot,
      config,
      expectedHead: head,
      baseEvidence,
    });
    if (baseEvidence.changedHead)
      result = {
        verdict: "reject",
        reason: `pull request head changed to ${baseEvidence.changedHead}`,
        evidence: { expected_head: head, observed_head: baseEvidence.changedHead },
      };
    if (result.verdict === "metadata-required") {
      try {
        const metadata = await runMetadataValidation({
          projectRoot,
          base: result.evidence.original_base,
          head,
          manager: result.evidence.manager,
          packageName: result.evidence.package,
          currentVersion: result.evidence.current_version,
          newVersion: result.evidence.new_version,
          paths: result.evidence.paths,
        });
        result = {
          ...result,
          verdict: "merge-ready",
          reason:
            "remote gates and exact-head metadata validation passed; concise final review remains",
          evidence: { ...result.evidence, metadata },
        };
      } catch (error) {
        result = {
          ...result,
          verdict: "manual-review-required",
          reason: `metadata validation failed: ${sanitizeOperationError(error).message}`,
        };
      }
    }
    const output = renovateCheckEnvelope({ number, head, result, snapshot });
    if (options["--json"]) console.log(JSON.stringify(output));
    else console.log(output.summary);
    if (result.verdict !== "merge-ready") process.exitCode = 2;
    return;
  }
  if (command === "watch") {
    const directory = path.join(projectRoot, "work/pr-delivery");
    const references = [];
    const retain = (observation) => {
      try {
        mkdirSync(directory, { recursive: true });
        const file = path.join(directory, `${randomUUID()}.json`);
        writeFileSync(file, JSON.stringify(observation), { flag: "wx" });
        references.push(file);
      } catch {
        console.error(
          "pr-delivery: observation retention unavailable; monitoring remains authoritative",
        );
      }
    };
    const state = await watchRequiredChecks(client, {
      number,
      head,
      requiredContexts: contexts,
      run: Number(options["--run"]),
      attempt: Number(options["--attempt"]),
      deadline: options["--deadline"],
      observe: retain,
    });
    retain({ format: 1, kind: "delivery-result", ...state.watch });
    const summary = `Pull request #${number} exact head ${head} passed required checks: ${state.contexts
      .map((context) => context.context)
      .join(", ")}.`;
    if (options["--json"]) {
      console.log(
        JSON.stringify(
          githubOperationEnvelope({
            operation: "pr-delivery.watch",
            status: "succeeded",
            summary,
            evidence: {
              pull_request: number,
              head,
              watch: state.watch,
              contexts: state.contexts.map(({ context, conclusion }) => ({
                context,
                conclusion,
              })),
            },
          }),
        ),
      );
    } else {
      console.log(
        summarizeReport(
          "watch",
          { summary, status: "succeeded", evidence: { head, watch: state.watch } },
          references.at(-1) ?? "retention unavailable",
        ).text,
      );
    }
    return;
  }
  if (command === "merge") {
    const merged = client.merge(number, head, contexts);
    const summary =
      `Merged pull request #${number} at exact head ${head} as ${merged.result.sha}; ` +
      "remote readback confirmed.";
    if (options["--json"]) {
      console.log(
        JSON.stringify(
          githubOperationEnvelope({
            operation: "pr-delivery.merge",
            status: "succeeded",
            summary,
            evidence: {
              pull_request: number,
              head,
              merge_commit_sha: merged.result.sha,
              contexts: merged.contexts.map(({ context, conclusion }) => ({
                context,
                conclusion,
              })),
              remote_readback: true,
            },
          }),
        ),
      );
    } else {
      console.log(summary);
    }
    return;
  }
  throw new Error(`unknown command: ${command}`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === scriptPath) {
  try {
    await main(process.argv.slice(2));
  } catch (error) {
    const safeError = sanitizeOperationError(error);
    if (process.argv.slice(3).includes("--json")) {
      console.log(
        JSON.stringify(
          githubOperationEnvelope({
            operation: `pr-delivery.${process.argv[2] ?? "unknown"}`,
            status: error.operationStatus ?? "failed",
            summary: safeError.message,
            evidence: error.operationEvidence ?? {},
            error,
          }),
        ),
      );
    }
    let reference = null;
    try {
      const directory = path.join(projectRoot, "work/pr-delivery");
      mkdirSync(directory, { recursive: true });
      reference = path.join(directory, `${randomUUID()}.json`);
      writeFileSync(
        reference,
        JSON.stringify({ error: safeError, evidence: error.operationEvidence ?? {} }),
        { flag: "wx" },
      );
    } catch {
      /* Preserve the original operation failure. */
    }
    console.error(
      renderBoundedSummary("pr-delivery failed", [safeError.message], { reference }).text,
    );
    process.exitCode = 1;
  }
}
