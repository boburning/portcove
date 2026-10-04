import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptPath = fileURLToPath(import.meta.url);
class HealthFailure extends Error {
  constructor(reason) {
    super(reason);
    this.reason = reason;
  }
}
const limits = Object.freeze({
  requests: 128,
  duration_ms: 180_000,
  request_ms: 15_000,
  response_bytes: 1024 * 1024,
  total_bytes: 16 * 1024 * 1024,
});
const resume = {
  "inaccessible-or-missing":
    "Recheck original access/location; a 404 does not establish deletion or succession.",
  authentication:
    "Correct existing authentication before rechecking; do not infer upstream disappearance.",
  forbidden: "Investigate access or provider throttling before rechecking.",
  "rate-limit":
    "Wait until the provider retry time, or at least one minute if unknown, before rechecking.",
  "provider-error": "Recheck after the provider recovers; artifact health is unassessed.",
  transport: "Recheck provider transport; this attempt did not establish reachability.",
  timeout: "Recheck within the fixed time budget; this attempt did not establish reachability.",
  "invalid-metadata":
    "Obtain bounded valid repository metadata before treating the endpoint as reachable.",
  "identity-mismatch": "Review the observed location mismatch; do not transfer upstream authority.",
  budget: "Start a separate bounded collection; retain this incomplete coverage report.",
  "provider-status": "Investigate the observed HTTP status before rechecking.",
};

function inventory(catalog) {
  const records = new Map();
  const excluded = [];
  const ids = new Set();
  if (!Array.isArray(catalog?.ports)) throw new Error("Catalog ports must be an array");
  for (const port of catalog.ports) {
    if (
      typeof port.id !== "string" ||
      !/^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(port.id) ||
      ids.has(port.id)
    )
      throw new Error("Catalog requires unique stable port IDs");
    ids.add(port.id);
    const releaseProvider = port.release?.provider ?? "github";
    if (releaseProvider === "direct-manifest") {
      excluded.push(port.id);
      continue;
    }
    // Existing user-prepared entries declare a GitHub upstream repository;
    // this check observes that location, never their externally prepared files.
    const provider = releaseProvider === "user-prepared" ? "github" : releaseProvider;
    const repository = port.release?.repository;
    const pattern =
      provider === "github"
        ? /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u
        : /^[A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.-]+)+$/u;
    if (
      !["github", "gitlab"].includes(provider) ||
      typeof repository !== "string" ||
      repository.length > 200 ||
      !pattern.test(repository) ||
      repository.split("/").some((part) => part === "." || part === "..")
    )
      throw new Error("Unsupported hosted catalog repository");
    const key = `${provider}:${provider === "github" ? repository.toLowerCase() : repository}`;
    if (!records.has(key))
      records.set(key, { provider, repository, port_ids: [], release_providers: [] });
    records.get(key).port_ids.push(port.id);
    if (!records.get(key).release_providers.includes(releaseProvider))
      records.get(key).release_providers.push(releaseProvider);
  }
  return { records: [...records.values()], excluded };
}

function retryAt(headers, now) {
  const retry = headers.get("retry-after");
  const delay =
    retry && /^\d+$/u.test(retry) ? now + Number(retry) * 1000 : Date.parse(retry ?? "");
  const reset = headers.get("x-ratelimit-reset");
  const resetTime = reset && /^\d+$/u.test(reset) ? Number(reset) * 1000 : NaN;
  const candidates = [delay, resetTime].filter(
    (value) => Number.isFinite(value) && value <= 8.64e15,
  );
  return candidates.length ? new Date(Math.max(now + 60_000, ...candidates)).toISOString() : null;
}

function statusReason(response) {
  if (
    response.status === 429 ||
    (response.status === 403 &&
      (response.headers.has("retry-after") ||
        response.headers.get("x-ratelimit-remaining") === "0"))
  )
    return "rate-limit";
  if (response.status === 404) return "inaccessible-or-missing";
  if (response.status === 401) return "authentication";
  if (response.status === 403) return "forbidden";
  if (response.status >= 500) return "provider-error";
  return "provider-status";
}

async function cancelBody(response) {
  try {
    await response?.body?.cancel();
  } catch {
    /* A failed stream cannot supply metadata. */
  }
}

async function metadata(response, budget, now, deadline) {
  if (!(response.headers.get("content-type") ?? "").includes("application/json") || !response.body)
    throw new HealthFailure("invalid-metadata");
  const chunks = [];
  let bytes = 0;
  for await (const chunk of response.body) {
    bytes += chunk.length;
    budget.response_bytes += chunk.length;
    if (
      bytes > limits.response_bytes ||
      budget.response_bytes > limits.total_bytes ||
      now() >= deadline
    )
      throw new HealthFailure("budget");
    chunks.push(chunk);
  }
  try {
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks)));
  } catch {
    throw new HealthFailure("invalid-metadata");
  }
}

// Repository-only facts cannot stand in for the configured release observer's
// pinned repository identity, complete release/asset pages or Core projection.
export async function collectRepositoryHealth(
  catalog,
  { fetch: fetcher = fetch, now = Date.now, githubToken, gitlabToken } = {},
) {
  const { records, excluded } = inventory(catalog);
  const started = now();
  const deadline = started + limits.duration_ms;
  const consumed = { requests: 0, response_bytes: 0 };
  const deferred = new Map();
  const observations = [];
  for (const record of records) {
    const result = {
      ...record,
      attempted: false,
      status: "unknown",
      reason: null,
      http_status: null,
      archived: null,
      observed_repository_id: null,
      retry_at: null,
      resume_condition: null,
    };
    const fail = (reason) => {
      result.reason = reason;
      result.resume_condition = resume[reason];
    };
    observations.push(result);
    if (deferred.has(record.provider)) {
      fail("rate-limit");
      result.retry_at = deferred.get(record.provider);
      continue;
    }
    if (
      now() >= deadline ||
      consumed.requests >= limits.requests ||
      consumed.response_bytes >= limits.total_bytes
    ) {
      fail("budget");
      continue;
    }
    const github = record.provider === "github";
    const url = github
      ? `https://api.github.com/repos/${record.repository}`
      : `https://gitlab.com/api/v4/projects/${encodeURIComponent(record.repository)}`;
    const headers = { "User-Agent": "Portcove-catalog-audit" };
    if (github) {
      headers.Accept = "application/vnd.github+json";
      headers["X-GitHub-Api-Version"] = "2022-11-28";
      if (githubToken) headers.Authorization = `Bearer ${githubToken}`;
    } else if (gitlabToken) headers["PRIVATE-TOKEN"] = gitlabToken;
    const signal = AbortSignal.timeout(Math.min(limits.request_ms, deadline - now()));
    consumed.requests++;
    result.attempted = true;
    let response;
    try {
      response = await fetcher(url, { headers, redirect: "error", signal });
      result.http_status = response.status;
      if (response.status !== 200) {
        fail(statusReason(response));
        if (result.reason === "rate-limit") {
          result.retry_at = retryAt(response.headers, now());
          deferred.set(record.provider, result.retry_at);
        }
        continue;
      }
      let facts;
      try {
        facts = await metadata(response, consumed, now, deadline);
      } catch (error) {
        fail(
          error instanceof HealthFailure ? error.reason : signal.aborted ? "timeout" : "transport",
        );
        continue;
      }
      if (
        !facts ||
        !Number.isSafeInteger(facts.id) ||
        facts.id <= 0 ||
        typeof facts.archived !== "boolean" ||
        typeof (github ? facts.full_name : facts.path_with_namespace) !== "string"
      ) {
        fail("invalid-metadata");
        continue;
      }
      const observed = github ? facts.full_name.toLowerCase() : facts.path_with_namespace;
      if (observed !== (github ? record.repository.toLowerCase() : record.repository)) {
        fail("identity-mismatch");
        continue;
      }
      result.status = "reachable";
      result.archived = facts.archived;
      result.observed_repository_id = facts.id;
    } catch {
      fail(signal.aborted ? "timeout" : "transport");
    } finally {
      await cancelBody(response);
    }
  }
  const reachable = observations.filter((record) => record.status === "reachable").length;
  return {
    format_version: 1,
    authority: "repository-health-only",
    started_at: new Date(started).toISOString(),
    completed_at: new Date(now()).toISOString(),
    collection_method: "single repository metadata request per hosted identity; no retries",
    outcome: reachable === records.length ? "complete" : "incomplete",
    coverage: {
      ports: catalog.ports.length,
      hosted_ports: catalog.ports.length - excluded.length,
      direct_manifest_port_ids: excluded,
      repositories: records.length,
      attempted_repositories: consumed.requests,
      reachable_repositories: reachable,
      unknown_repositories: records.length - reachable,
    },
    unassessed: [
      "upstream-continuity",
      "accepted-artifact-availability",
      "preservation",
      "distribution-authority",
      "operation-holds",
      "qualification",
    ],
    limits,
    consumed,
    observations,
  };
}

export function renderRepositoryHealth(report) {
  const { coverage } = report;
  const lines = [
    `Repository reachability: ${coverage.reachable_repositories}/${coverage.repositories} reachable; ${coverage.unknown_repositories} unknown; ${coverage.attempted_repositories} attempted.`,
    `Coverage: ${coverage.hosted_ports}/${coverage.ports} ports; ${coverage.direct_manifest_port_ids.length} direct-manifest ports not assessed.`,
    `Observed ${report.started_at} through ${report.completed_at}.`,
  ];
  for (const record of report.observations) {
    lines.push(
      `${record.provider}:${record.repository} [${record.port_ids.join(", ")}]: ${record.status === "reachable" ? `reachable${record.archived ? " (archived)" : ""}` : `unknown (${record.reason}${record.http_status === null ? "; not established" : `; HTTP ${record.http_status}`})`}`,
    );
    if (record.resume_condition)
      lines.push(
        `  Resume: ${record.resume_condition}${record.retry_at ? ` Retry at ${record.retry_at}.` : ""}`,
      );
  }
  lines.push(`Unassessed: ${report.unassessed.join(", ")}.`);
  return lines.join("\n");
}

async function main() {
  if (process.argv.slice(2).some((arg) => arg !== "--json"))
    throw new Error("Usage: check-catalog-repositories.mjs [--json]");
  const catalogPath = new URL("../crates/portcove-core/catalog/catalog.json", import.meta.url);
  const report = await collectRepositoryHealth(JSON.parse(await readFile(catalogPath, "utf8")), {
    githubToken: process.env.GITHUB_TOKEN,
    gitlabToken: process.env.GITLAB_TOKEN,
  });
  console.log(
    process.argv.includes("--json")
      ? JSON.stringify(report, null, 2)
      : renderRepositoryHealth(report),
  );
  process.exitCode = report.outcome === "complete" ? 0 : 1;
}

if (process.argv[1] && path.resolve(process.argv[1]) === scriptPath) {
  main().catch(() => {
    console.error("Repository health collection failed before a complete report.");
    process.exitCode = 1;
  });
}
