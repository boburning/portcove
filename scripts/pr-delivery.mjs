import { readFile } from "node:fs/promises";
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
} from "./renovate-fast-lane.mjs";

const scriptPath = fileURLToPath(import.meta.url);
const projectRoot = fileURLToPath(new URL("..", import.meta.url));
const repository = "boburning/portcove";

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

export async function watchRequiredChecks(
  client,
  { number, head, requiredContexts, timeoutSeconds = 3600, intervalSeconds = 30, sleep },
) {
  const pause =
    sleep ?? ((milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)));
  const deadline = Date.now() + timeoutSeconds * 1000;
  for (;;) {
    const state = client.requiredCheckState(number, head, requiredContexts);
    const failures = state.contexts.filter((context) => context.outcome === "failure");
    if (failures.length)
      throw new Error(
        `required checks failed: ${failures
          .map((context) => `${context.context}=${context.conclusion}`)
          .join(", ")}`,
      );
    if (state.contexts.every((context) => context.outcome === "success")) return state;
    if (Date.now() >= deadline)
      throw new Error(
        `timed out waiting for required checks: ${state.contexts
          .filter((context) => context.outcome !== "success")
          .map((context) => `${context.context}=${context.conclusion}`)
          .join(", ")}`,
      );
    await pause(intervalSeconds * 1000);
  }
}

export function parseArguments(argv) {
  const command = argv[0];
  const options = {};
  for (let index = 1; index < argv.length; index += 1) {
    const name = argv[index];
    if (name === "--json") {
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
        "  node scripts/pr-delivery.mjs watch --pr <number-or-url> --head <sha> [--timeout-seconds <seconds>] [--json]\n" +
        "  node scripts/pr-delivery.mjs renovate-check --pr <number-or-url> --head <sha> [--json]\n" +
        "  node scripts/pr-delivery.mjs merge --pr <number-or-url> --head <sha> [--json]",
    );
    return;
  }
  exactKeys(
    options,
    command === "watch"
      ? [
          "--head",
          "--pr",
          ...(options["--timeout-seconds"] ? ["--timeout-seconds"] : []),
          ...(options["--json"] ? ["--json"] : []),
        ]
      : ["--head", "--pr", ...(options["--json"] ? ["--json"] : [])],
    `${command} options`,
  );
  const number = parsePullRequestReference(options["--pr"]);
  const head = options["--head"];
  if (!/^[0-9a-f]{40}$/u.test(head ?? "")) throw new Error("--head must be a 40-character SHA");
  const contexts = await requiredContexts();
  const client = new PullRequestDeliveryClient();
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
          head,
          manager: result.evidence.manager,
          packageName: result.evidence.package,
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
    const timeoutSeconds = Number(options["--timeout-seconds"] ?? 3600);
    if (!Number.isSafeInteger(timeoutSeconds) || timeoutSeconds < 1)
      throw new Error("--timeout-seconds must be a positive integer");
    const state = await watchRequiredChecks(client, {
      number,
      head,
      requiredContexts: contexts,
      timeoutSeconds,
    });
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
              contexts: state.contexts.map(({ context, conclusion }) => ({
                context,
                conclusion,
              })),
            },
          }),
        ),
      );
    } else {
      console.log(summary);
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
    console.error(`pr-delivery: ${safeError.message}`);
    process.exitCode = 1;
  }
}
