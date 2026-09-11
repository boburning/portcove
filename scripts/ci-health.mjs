import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { parseArgs, promisify } from "node:util";
import { pathToFileURL } from "node:url";

const execute = promisify(execFile);

function secondsBetween(start, end) {
  const seconds = (Date.parse(end) - Date.parse(start)) / 1000;
  return Number.isFinite(seconds) && seconds >= 0 ? seconds : null;
}

export function summarizeAttempt(run, jobs) {
  // created_at belongs to the original run, even when inspecting a later attempt.
  const start = run.run_attempt === 1 ? run.created_at : run.run_started_at;
  const measuredJobs = jobs.map((job) => ({
    name: job.name,
    conclusion: job.conclusion,
    url: job.html_url,
    seconds:
      job.status === "completed" && job.conclusion !== "skipped"
        ? secondsBetween(job.started_at, job.completed_at)
        : null,
    steps: (job.steps ?? [])
      .filter((step) => step.status === "completed")
      .map((step) => ({
        name: step.name,
        seconds: secondsBetween(step.started_at, step.completed_at),
      }))
      .filter((step) => step.seconds !== null)
      .sort((a, b) => b.seconds - a.seconds)
      .slice(0, 3),
  }));
  return {
    runId: run.id,
    attempt: run.run_attempt,
    sha: run.head_sha,
    event: run.event,
    branch: run.head_branch,
    status: run.status,
    conclusion: run.conclusion,
    url: `${run.html_url}/attempts/${run.run_attempt}`,
    seconds: run.status === "completed" ? secondsBetween(start, run.updated_at) : null,
    jobs: measuredJobs,
    failedJobs: measuredJobs
      .filter((job) => job.conclusion === "failure" || job.conclusion === "timed_out")
      .map((job) => job.name),
  };
}

function distribution(values) {
  const sorted = values.filter((value) => value !== null).sort((a, b) => a - b);
  const percentile = (fraction) => sorted[Math.ceil(sorted.length * fraction) - 1] ?? null;
  return {
    count: sorted.length,
    p50Seconds: percentile(0.5),
    // Avoid presenting an unstable tail estimate as a useful long-term metric.
    p95Seconds: sorted.length >= 20 ? percentile(0.95) : null,
    maxSeconds: sorted.at(-1) ?? null,
  };
}

export function summarizeHistory(attempts) {
  const successful = attempts.filter(
    (attempt) => attempt.status === "completed" && attempt.conclusion === "success",
  );
  const recoveries = attempts
    .filter(
      (attempt) =>
        attempt.status === "completed" &&
        (["failure", "timed_out"].includes(attempt.conclusion) || attempt.failedJobs.length > 0),
    )
    .flatMap((failed) => {
      const passed = successful
        .filter(
          (candidate) =>
            candidate.runId === failed.runId &&
            candidate.sha === failed.sha &&
            candidate.attempt > failed.attempt,
        )
        .sort((a, b) => a.attempt - b.attempt)[0];
      return passed
        ? [
            {
              runId: failed.runId,
              sha: failed.sha,
              failedAttempt: failed.attempt,
              passedAttempt: passed.attempt,
              failedJobs: failed.failedJobs,
              url: failed.url,
            },
          ]
        : [];
    });
  const jobSamples = new Map();
  for (const attempt of successful.filter((attempt) => attempt.attempt === 1)) {
    for (const job of attempt.jobs) {
      if (job.seconds === null) continue;
      const samples = jobSamples.get(job.name) ?? [];
      samples.push(job.seconds);
      jobSamples.set(job.name, samples);
    }
  }
  return {
    runs: new Set(attempts.map((attempt) => attempt.runId)).size,
    commits: new Set(attempts.map((attempt) => attempt.sha)).size,
    attempts: attempts.length,
    outcomes: Object.fromEntries(
      [
        ...new Set(
          attempts.map((attempt) =>
            attempt.status === "completed" ? attempt.conclusion : attempt.status,
          ),
        ),
      ].map((outcome) => [
        outcome,
        attempts.filter(
          (attempt) =>
            (attempt.status === "completed" ? attempt.conclusion : attempt.status) === outcome,
        ).length,
      ]),
    ),
    successfulFirstAttempts: distribution(
      successful.filter((attempt) => attempt.attempt === 1).map((attempt) => attempt.seconds),
    ),
    successfulReruns: distribution(
      successful.filter((attempt) => attempt.attempt > 1).map((attempt) => attempt.seconds),
    ),
    missingCompletedTimings: attempts.filter(
      (attempt) => attempt.status === "completed" && attempt.seconds === null,
    ).length,
    slowestJobs: [...jobSamples]
      .map(([name, values]) => ({ name, ...distribution(values) }))
      .sort((a, b) => b.p50Seconds - a.p50Seconds)
      .slice(0, 8),
    rerunRecoveries: recoveries,
  };
}

export async function collectHistory(request, { repository, branch, event, limit, since }) {
  const root = `repos/${repository}/actions`;
  const query = new URLSearchParams({ branch, event, per_page: String(limit) });
  const listing = await request(`${root}/workflows/ci.yml/runs?${query}`);
  if (!Array.isArray(listing.workflow_runs)) throw new Error("Missing workflow run inventory");
  const runs = since
    ? listing.workflow_runs.filter((run) => {
        if (!Number.isFinite(Date.parse(run.created_at)))
          throw new Error("Missing run creation time");
        return Date.parse(run.created_at) >= Date.parse(since);
      })
    : listing.workflow_runs;
  const references = runs.flatMap((run) => {
    if (!Number.isInteger(run.run_attempt) || run.run_attempt < 1)
      throw new Error("Missing attempt count");
    return Array.from({ length: run.run_attempt }, (_, index) => ({
      id: run.id,
      attempt: index + 1,
    }));
  });
  const attempts = [];
  // Bound API concurrency; every historical attempt is read, including failures
  // which the latest successful rerun hides in GitHub's run listing.
  for (let offset = 0; offset < references.length; offset += 4) {
    attempts.push(
      ...(await Promise.all(
        references.slice(offset, offset + 4).map(async (reference) => {
          const route = `${root}/runs/${reference.id}/attempts/${reference.attempt}`;
          const run = await request(route);
          const pages = await request(`${route}/jobs?per_page=100`, true);
          if (!Array.isArray(pages) || !pages.every((page) => Array.isArray(page.jobs))) {
            throw new Error(`Missing jobs for ${reference.id}/${reference.attempt}`);
          }
          const jobs = pages.flatMap((page) => page.jobs);
          if (jobs.length !== pages[0]?.total_count)
            throw new Error(`Incomplete jobs for ${reference.id}/${reference.attempt}`);
          if (run.id !== reference.id || run.run_attempt !== reference.attempt)
            throw new Error("Attempt identity mismatch");
          return summarizeAttempt(run, jobs);
        }),
      )),
    );
  }
  return {
    repository,
    branch,
    event,
    since: since ?? null,
    requestedRuns: limit,
    generatedAt: new Date().toISOString(),
    summary: summarizeHistory(attempts),
    attempts,
  };
}

const duration = (seconds) =>
  seconds === null
    ? "unavailable"
    : `${Math.floor(Math.round(seconds) / 60)}m${String(Math.round(seconds) % 60).padStart(2, "0")}s`;
const cell = (value) => String(value).replaceAll("|", "\\|").replaceAll(/\r?\n/g, " ");

export function renderReport(report) {
  const { summary } = report;
  const lines = [
    `# CI health: ${cell(report.repository)} / ${cell(report.branch)} / ${cell(report.event)}`,
    "",
    `${summary.runs} runs, ${summary.attempts} attempts, ${summary.commits} commits. Generated ${report.generatedAt}.`,
    `Sample: latest ${report.requestedRuns} runs${report.since ? ` created since ${report.since}` : " (no date cutoff)"}. Workflow changes within this sample can make aggregate comparisons misleading.`,
    "",
    "Durations include setup, execution, queueing and aggregation. Cache state is unclassified; first attempts are not necessarily cold and reruns are not necessarily warm.",
    "",
    "| Successful cohort | Samples | p50 | p95 (20+ samples) | Maximum |",
    "|---|---:|---:|---:|---:|",
  ];
  for (const [label, stats] of [
    ["First attempts", summary.successfulFirstAttempts],
    ["Reruns", summary.successfulReruns],
  ]) {
    lines.push(
      `| ${label} | ${stats.count} | ${duration(stats.p50Seconds)} | ${duration(stats.p95Seconds)} | ${duration(stats.maxSeconds)} |`,
    );
  }
  lines.push(
    "",
    `Attempt outcomes: ${
      Object.entries(summary.outcomes)
        .map(([name, count]) => `${name}=${count}`)
        .join(", ") || "none"
    }.`,
    `Completed attempts with missing timing: ${summary.missingCompletedTimings}. Cancelled, failed and incomplete attempts are not included in successful-duration percentiles.`,
    "",
    "## Slow jobs in successful first attempts",
    "",
    "| Job | Samples | p50 | Maximum |",
    "|---|---:|---:|---:|",
  );
  for (const job of summary.slowestJobs)
    lines.push(
      `| ${cell(job.name)} | ${job.count} | ${duration(job.p50Seconds)} | ${duration(job.maxSeconds)} |`,
    );
  lines.push(
    "",
    "## Rerun recoveries",
    "",
    "These are investigation leads, not a measured flake rate. The commit is unchanged, but runners, caches and external services can differ.",
  );
  if (!summary.rerunRecoveries.length)
    lines.push(
      "",
      "No failed-then-passing rerun observed in this sample. This does not establish absence of flakes.",
    );
  for (const recovery of summary.rerunRecoveries)
    lines.push(
      "",
      `- [Run ${recovery.runId}, attempt ${recovery.failedAttempt}](${recovery.url}) reported failures; attempt ${recovery.passedAttempt} passed. Failed jobs: ${recovery.failedJobs.map(cell).join(", ") || "unavailable"}.`,
    );
  lines.push(
    "",
    "## Attempts",
    "",
    "| Run / attempt | Commit | Result | Elapsed |",
    "|---|---|---|---:|",
  );
  for (const attempt of report.attempts)
    lines.push(
      `| [${attempt.runId}/${attempt.attempt}](${attempt.url}) | ${cell(attempt.sha?.slice(0, 8))} | ${cell(attempt.conclusion ?? attempt.status)} | ${duration(attempt.seconds)} |`,
    );
  return `${lines.join("\n")}\n`;
}

async function main() {
  const { values } = parseArgs({
    options: {
      branch: { type: "string", default: "main" },
      event: { type: "string", default: "push" },
      runs: { type: "string", default: "20" },
      since: { type: "string" },
      json: { type: "boolean", default: false },
      help: { type: "boolean", default: false },
    },
  });
  if (values.help) {
    console.log(
      "Usage: node scripts/ci-health.mjs [--branch main] [--event push] [--runs 20] [--since ISO-date] [--json]\nRead-only GitHub CLI access is required. All attempts of the selected runs are inspected.",
    );
    return;
  }
  const limit = Number(values.runs);
  if (!Number.isInteger(limit) || limit < 1 || limit > 100)
    throw new Error("--runs must be between 1 and 100");
  if (values.since && !Number.isFinite(Date.parse(values.since)))
    throw new Error("--since must be a valid ISO date");
  const { repository } = JSON.parse(
    await readFile(new URL("../.github/roadmap.json", import.meta.url), "utf8"),
  );
  const request = async (route, paginate = false) => {
    const args = ["api", "--method", "GET", route];
    if (paginate) args.push("--paginate", "--slurp");
    const { stdout } = await execute("gh", args, {
      encoding: "utf8",
      windowsHide: true,
      timeout: 30_000,
      maxBuffer: 20 * 1024 * 1024,
    });
    return JSON.parse(stdout);
  };
  const report = await collectHistory(request, {
    repository,
    branch: values.branch,
    event: values.event,
    limit,
    since: values.since ? new Date(values.since).toISOString() : undefined,
  });
  console.log(values.json ? JSON.stringify(report, null, 2) : renderReport(report));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
